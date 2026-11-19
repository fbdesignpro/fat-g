// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The chat (docs/planning/_archive/M15.md, Design 12–14; C51–C55, C96; M18.md, Design 5, 10; M19.md, Design 5;
// C24–C27; M20a.md, Design 7; C32; M20b.md, Design 5; C30, C73; M21.md, Design 5; C31, C35, C73;
// M22.md, Design 3, 9, 10; C46, C88, C89): a session's conversation, which main keeps in its conversation store and the Main window reads a page at a
// time over the chat channels and one push. Message content never enters the app state or a log,
// and the Pet gets none of it.
//
// Renderer-safe: types, schemas, the page's rule for taking an answer or a push, and fat-g's words
// for every line that is not the conversation's own.
import { z } from 'zod';
import { MAX_AGENT_ID, MAX_MESSAGE_TEXT, type RefusedBound, type StartStep } from './agent-events';
import { type AsideCapability, type AsideMarker, AsideSourceSchema, type AsideView } from './aside';
import { CHAT_NOTICE_KINDS, type ChatNoticeKind, type ConversationItem, type ConversationTurn, ItemIdSchema } from './conversation';
import { AnswerEntriesSchema, APPROVAL_CHOICES, type SessionGrant } from './interaction';
import { type ChatMode, ModeIdSchema, type ModeReason, modeReasonWords } from './permissions';
import type { SendBlock } from './sessions';
import { type ChatComposer, DraftRevisionSchema, SkillSelectionSchema } from './composer';
import { MAX_IMAGES } from './attachments';
import type { ResolvedAvatar } from './avatars';

export { CHAT_NOTICE_KINDS, type ChatNoticeKind };

// ── History, and what the store could not do (M18, C18, C19, C51) ─────────────────────────────

/**
 * Where the check of a session's earlier conversation stands (M18, C51). `unsupported`: its provider
 * has no history to read, and nothing is asked. `not-checked` until its first selection in this run.
 * `failed` leaves Send usable, with Try again.
 */
export const HISTORY_STATES = ['unsupported', 'not-checked', 'checking', 'checked', 'failed'] as const;
export type HistoryState = (typeof HISTORY_STATES)[number];

export interface ChatHistory {
  readonly state: HistoryState;
  /** A check ended before the conversation's start: older messages could not be read (M15, C95). */
  readonly olderUnread: boolean;
  /** The store does not hold the conversation's start, and no check has reached it (M18, C18). */
  readonly earlierMissing: boolean;
}

/** `failing`: something of this session could not be saved in this run (M18, C19). `refused`: the store itself is (C33). */
export type ChatStorage = 'ok' | 'failing' | 'refused';

// ── Requests and answers (M15, C54; M18, C20, C60) ────────────────────────────────────────────

const sessionId = z.guid();

export const ChatSessionRequestSchema = z.strictObject({ sessionId });
/**
 * The newest page, or — for a page that reads again — the window it holds (M18, C60): from its
 * oldest held item on, keeping the newest when the page holds them and the oldest when it had let
 * them go.
 */
export const ChatReadRequestSchema = z.union([z.strictObject({ sessionId }), z.strictObject({ sessionId, from: ItemIdSchema, keep: z.enum(['newest', 'oldest']) })]);
/** The page before the item `before` names (M18, C20): a cursor that an import does not move. */
export const ChatPageRequestSchema = z.strictObject({ sessionId, before: ItemIdSchema });
export const ChatSendRequestSchema = z.strictObject({
  sessionId,
  prompt: z.string().max(MAX_MESSAGE_TEXT),
  /** A plan turn (M22b, C1): a mode of this prompt alone, never of the chat. */
  mode: z.literal('plan').optional(),
  /**
   * The draft this prompt is (M23, C21, C86): its revision, past every update the page handed over, and
   * its images by their uses' ids, which main checks against the draft before it takes any. Left out,
   * the prompt is its text alone and no draft is consumed.
   */
  revision: DraftRevisionSchema.optional(),
  attachments: z.array(ItemIdSchema).max(MAX_IMAGES).optional(),
  /** A skill chosen from the menu (M23, C64, C87): main resolves it against its CLI's list. */
  skill: SkillSelectionSchema.optional(),
  /**
   * Plan as pressed in the composer (M23, C87): kept with the draft whatever this turn is, so it stays
   * pressed where the chat takes no plan turn. The turn is a plan turn by `mode` alone. Left out, it is `mode`'s.
   */
  plan: z.boolean().optional(),
  /** Sent into the running turn (M23, C36): main chooses and checks the route. */
  when: z.literal('now').optional(),
}).refine((request) => request.prompt.trim() !== '' || (request.attachments?.length ?? 0) > 0, 'nothing to send');
/**
 * A worker's conversation (M20a, C32): its newest window, or — `before` — the page before the item
 * that cursor names, as the chat's page request has it. `workerId` is the id its worker item holds.
 */
export const ChatWorkerReadRequestSchema = z.strictObject({
  sessionId,
  workerId: z.string().min(1).max(MAX_AGENT_ID).refine((value) => !/\p{Cc}/u.test(value), 'control character'),
  before: ItemIdSchema.optional(),
});
const question = z.string().min(1).max(MAX_MESSAGE_TEXT).refine((value) => value.trim() !== '', 'only whitespace');
/** An aside's id (M20b, C73): the page makes it for a new aside's tab, and every ask carries it. */
const asideId = z.guid();
/**
 * A question beside a session (M20b, C73): the text typed — a free question, or a follow-up — or
 * the selection Explain this was pressed on (C45), around which main writes the question itself.
 */
export const ChatAskRequestSchema = z.union([
  z.strictObject({ sessionId, asideId, text: question }),
  z.strictObject({ sessionId, asideId, source: AsideSourceSchema }),
]);
/** An aside's conversation (M20b, C73): its newest page, or — `before` — the page before the item that cursor names. */
export const ChatAsideReadRequestSchema = z.strictObject({ sessionId, asideId, before: ItemIdSchema.optional() });
/** One aside of a session: what its Stop and its Remove name. */
export const ChatAsideRequestSchema = z.strictObject({ sessionId, asideId });
/**
 * An answer to a question's card (M21, C31): the session, the card's item — the page holds no
 * request id (C35) — and one entry for each of its questions: the question's place, the places of
 * its chosen options and its text, a secret's among them. An entry that says nothing leaves its
 * question unanswered, which an async card allows for all but one (C45).
 */
export const ChatAnswerRequestSchema = z.strictObject({ sessionId, itemId: ItemIdSchema, answers: AnswerEntriesSchema });
/** An async card folded away (M21, C9, C31): the CLI is told nothing. */
export const ChatDismissRequestSchema = z.strictObject({ sessionId, itemId: ItemIdSchema });
/**
 * A chat's mode, changed from its header (M22, C2, C88): the session and the id of one of its
 * provider's modes. Whether the id is one, whether the account can use it and how the change is
 * made are worked out in main.
 */
export const ChatSetModeRequestSchema = z.strictObject({ sessionId, mode: ModeIdSchema });
/**
 * A decision on an approval's card (M22, C13, C88): the session, the card's item — the page holds
 * no request id — and a choice. Main takes only one the request's own view lists: the page cannot
 * invent a choice, a scope or a tool's input.
 */
export const ChatDecideRequestSchema = z.strictObject({ sessionId, itemId: ItemIdSchema, choice: z.enum(APPROVAL_CHOICES) });
export type ChatAnswerRequest = z.infer<typeof ChatAnswerRequestSchema>;
export type ChatDismissRequest = z.infer<typeof ChatDismissRequestSchema>;
export type ChatSetModeRequest = z.infer<typeof ChatSetModeRequestSchema>;
export type ChatDecideRequest = z.infer<typeof ChatDecideRequestSchema>;
export type ChatAskRequest = z.infer<typeof ChatAskRequestSchema>;
export type ChatAsideReadRequest = z.infer<typeof ChatAsideReadRequestSchema>;
export type ChatAsideRequest = z.infer<typeof ChatAsideRequestSchema>;
export type ChatSessionRequest = z.infer<typeof ChatSessionRequestSchema>;
export type ChatWorkerReadRequest = z.infer<typeof ChatWorkerReadRequestSchema>;
export type ChatReadRequest = z.infer<typeof ChatReadRequestSchema>;
export type ChatPageRequest = z.infer<typeof ChatPageRequestSchema>;
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>;

/** Main-resolved, transient presentation. Its revision is independent of transcript revisions. */
export interface ChatPresentation {
  readonly revision: number;
  readonly models: Readonly<Record<string, ResolvedAvatar | null>>;
  readonly workers: Readonly<Record<string, { readonly model: string; readonly assumed: boolean }>>;
}

export interface ChatRead {
  readonly presentation?: ChatPresentation;
  readonly status: 'read';
  readonly sessionId: string;
  readonly revision: number;
  /** Oldest first: the newest page, or the window asked for (C60). */
  readonly items: readonly ConversationItem[];
  /** The items end with the conversation's newest. */
  readonly latest: boolean;
  /** The turns those items belong to. */
  readonly turns: readonly ConversationTurn[];
  /** A cursor: the id of the oldest item sent, when the store holds older ones. */
  readonly older: string | null;
  readonly history: ChatHistory;
  readonly storage: ChatStorage;
  /**
   * The session's asides, oldest first, as markers (M20b, C30): where each came from and whether a
   * turn of it runs, and none of its text. What the chat and a file's tab draw their markers and
   * highlights from, and what restores saved tabs.
   */
  readonly asides: readonly AsideMarker[];
  /**
   * Whether a question can be asked beside this session now, and how its provider answers one
   * (M20b, C10, C24, C48): `none` where the provider answers none, or holds no conversation of the
   * session yet. With `none` the page draws no Explain this and no side question.
   */
  readonly asking: AsideCapability;
  /**
   * The session's workers' questions that wait for an answer now (M21, C73, C76): each pending item
   * by its worker and its id. A worker's items are in none of the session's pages, so this is what
   * its row in the chat reads "waits for your answer" from; it stands while any item of the worker's
   * is listed. An item answered and not yet confirmed is not pending, and is not listed. A worker's
   * approvals that wait for a decision are listed the same way (M22, C36).
   */
  readonly waiting: readonly WaitingQuestion[];
  /**
   * The chat's saved mode and where it came from (M22, C1, C40): what its header reads. Null for a
   * provider that declares no mode, and where the store holds none for the chat yet.
   */
  readonly mode: ChatMode | null;
  /**
   * The session grants fat-g sent (M22, C57, C92), oldest first: each a decision whose reply was
   * delivered, with whether the CLI confirmed it and whether its process is still the session's.
   * fat-g's record of what it sent, and no reading of the CLI's own rules, which it lists none of.
   */
  readonly grants: readonly SessionGrant[];
  /**
   * The composer's state beside the conversation (M23, C57, C86): the session's draft, its queued
   * messages and whether Send now is offered. Left out by a read that holds none, which reads empty.
   */
  readonly composer?: ChatComposer;
}

/** A worker's request that waits for the user (M21, C73; M22, C36): the worker, the card's item, and whether it is a question or an approval. */
export interface WaitingQuestion {
  readonly workerId: string;
  readonly itemId: string;
  readonly kind: 'question' | 'approval';
}

export interface ChatPage {
  readonly presentation?: ChatPresentation;
  readonly status: 'page';
  readonly sessionId: string;
  readonly revision: number;
  /** Oldest first: the items before the cursor. */
  readonly items: readonly ConversationItem[];
  readonly turns: readonly ConversationTurn[];
  readonly older: string | null;
}

/**
 * A worker's items (M20a, C32): what it said and did, oldest first, bounded as the chat's window and
 * pages are, with the turns they belong to and the cursor to what is older. `worker` is the item of
 * the session's own that started it, with its label, its status, its duration and its report; null
 * where the store holds none.
 */
export interface ChatWorkerRead {
  readonly presentation?: ChatPresentation;
  readonly status: 'read';
  readonly sessionId: string;
  readonly workerId: string;
  readonly revision: number;
  readonly worker: ConversationItem | null;
  readonly items: readonly ConversationItem[];
  readonly turns: readonly ConversationTurn[];
  readonly older: string | null;
}

/**
 * An aside's conversation (M20b, C73): its questions, its answers and what its provider's side
 * thread did, oldest first, bounded as a page is, with the aside itself — its title, and its source
 * with the excerpt, which no other answer carries.
 */
export interface ChatAsideRead {
  readonly presentation?: ChatPresentation;
  readonly status: 'read';
  readonly sessionId: string;
  readonly asideId: string;
  /** The session's revision: an aside's pushes are counted with its session's. */
  readonly revision: number;
  readonly aside: AsideView;
  readonly items: readonly ConversationItem[];
  readonly turns: readonly ConversationTurn[];
  readonly older: string | null;
}

/** Why a question beside a session was not taken (M20b, C73), besides the entry's own reason. */
export const ASK_REFUSALS = [
  'unknown-session',
  /** The id names an aside of another session. */
  'unknown-aside',
  /** The session's provider answers no aside (C24). */
  'unsupported',
  /** The provider holds no conversation of the session yet (C10). */
  'no-conversation',
  /** A turn of that aside runs: one question at a time. */
  'aside-running',
  /** The session is being removed, or fat-g is quitting. */
  'busy',
  /** Its earlier process could not be confirmed stopped (M15, C116). */
  'unconfirmed',
  /** The question could not be recorded, so nothing was sent: the draft stays. */
  'storage-failed',
  /** A change of the chat's mode is under way (M22, C90). */
  'changing-mode',
  /** The account's sandbox is being set up (M22, C62). */
  'setting-up',
] as const;
export type AskRefusal = (typeof ASK_REFUSALS)[number];

/** Why a prompt was not taken, besides the entry's own reason (Design 13). */
export const SEND_REFUSALS = [
  'unknown-session',
  /** A turn runs, or its workers still do (C29, C99). */
  'running',
  /** The session is being removed or completed (C109), or fat-g is quitting (C118). */
  'busy',
  /** Its earlier process could not be confirmed stopped (C116). */
  'unconfirmed',
  /** Its earlier conversation is still being checked (C122; M18, C52). */
  'history-loading',
  /** The prompt could not be recorded, so nothing was sent (M18, C19): the draft stays. */
  'storage-failed',
  /** A change of the chat's mode is under way (M22, C90): the prompt is taken once it is written or refused. */
  'changing-mode',
  /** The account's sandbox is being set up (M22, C62): nothing of that account is sent meanwhile. */
  'setting-up',
  /** A plan's decision waits in the chat (M22b, C56): the panel stands in the composer's place until it is taken. */
  'plan-pending',
  /** A plan turn the chat cannot take (M22b, C2, C5, C13, C70): its provider, its mode or its account's CLI takes none. */
  'plans-unavailable',
  /** The images named are not the draft's (M23, C86): the page reads again, and nothing was sent. */
  'draft-changed',
  /** An image of the message is no longer available, or its file changed (M23, C8): nothing was sent, and the draft stays. */
  'attachment-missing',
  /**
   * The message cannot be sent into the running turn (M23, C35, C43, C88): Plan is pressed, a skill
   * was chosen, or its CLI takes no message during a turn — Queue stands alone. A message that can go
   * in later is held instead, until it can.
   */
  'not-steerable',
  /** A Send now that waits for the turn is held in the queue, and the queue holds ten already (C47). */
  'queue-full',
  /** The skill chosen for the message is no longer listed by its CLI (M23, C87): nothing was sent, and nothing in its place. */
  'skill-unavailable',
  /** A queued message's session is on the shelf: the message waits, and Unshelve lets it go on. A prompt typed there is taken, and takes the session off the shelf. */
  'shelved',
] as const;
export type SendRefusal = (typeof SEND_REFUSALS)[number];

/**
 * Why an answer was not taken (M21, C31), besides the entry's own reason and — for an async card,
 * whose answer is a prompt — the send's own, `running` among them. `too-long` is this list's alone:
 * an async answer's prompt is assembled in main, and never meets the send channel's schema (C26).
 */
export const ANSWER_REFUSALS = [
  'unknown-session',
  /** The session's conversation holds no question of this id. */
  'unknown-item',
  /** It was answered, withdrawn, dropped, dismissed or passed meanwhile, or was raised on an earlier process (C13, C77). */
  'not-pending',
  /** A card with no question answered (C45; M100b, C30): one left blank beside others goes as "No answer". */
  'incomplete',
  /** The answer does not fit its questions (C78): the card never sends one. */
  'mismatch',
  /** An async card's answers would pass a prompt's bound (C26): nothing was written or sent. */
  'too-long',
  /** The session is being removed, or fat-g is quitting. */
  'busy',
  /** The answer could not be recorded, so nothing was sent: what was entered stays. */
  'storage-failed',
] as const;
export type AnswerRefusal = (typeof ANSWER_REFUSALS)[number];

/** Why a card was not skipped (M21, C31; M100b, C32, C35). */
export const DISMISS_REFUSALS = [
  'unknown-session',
  'unknown-item',
  /** It is settled already, it was raised on an earlier process, or it is a blocking card its provider cannot decline. */
  'not-open',
  /** The session is being removed, or fat-g is quitting: a blocking card is not declined meanwhile. */
  'busy',
  /** The dismissal could not be recorded. */
  'storage-failed',
] as const;
export type DismissRefusal = (typeof DISMISS_REFUSALS)[number];

/** Why a chat's mode was not changed (M22, C2, C43, C88–C90), besides the gate's own reason for the session. */
export const SET_MODE_REFUSALS = [
  'unknown-session',
  /** The session's provider declares no mode. */
  'unsupported',
  /** Its provider lists no mode of this id. */
  'unknown-mode',
  /** The account cannot use the mode asked for (C43). Never said of the mode it would replace (C89). */
  'mode-unavailable',
  /** It is the chat's saved mode already. */
  'same',
  /** A turn, a worker, a pending request or an aside runs on the session (C2). */
  'running',
  /** Another change of its mode is under way (C90). */
  'changing-mode',
  /** The account's sandbox is being set up (C62). */
  'setting-up',
  /** The session is being removed, or fat-g is quitting. */
  'busy',
  /** Its earlier process could not be confirmed stopped (M15, C116). */
  'unconfirmed',
  /** The CLI did not confirm the change (C46): the chat's saved mode is as it was, and Send is blocked. */
  'not-confirmed',
  /** The choice could not be saved. */
  'storage-failed',
  /** A plan's decision waits in the chat (M22b, C58): its mode is held until the decision is taken. */
  'plan-pending',
] as const;
export type SetModeRefusal = (typeof SET_MODE_REFUSALS)[number];

/** Why a decision was not taken (M22, C13, C88). */
export const DECIDE_REFUSALS = [
  'unknown-session',
  /** The session's conversation holds no approval of this id. */
  'unknown-item',
  /** It was decided, withdrawn or dropped meanwhile, or was raised on an earlier process (C13). */
  'not-pending',
  /** The request's view lists no such choice (C88): the card never sends one. */
  'not-offered',
  /** A change of the chat's mode is under way (C90). */
  'changing-mode',
  /** The account's sandbox is being set up (C62). */
  'setting-up',
  /** The session is being removed, or fat-g is quitting. */
  'busy',
  /** The decision could not be recorded, so nothing was sent (C49). */
  'storage-failed',
] as const;
export type DecideRefusal = (typeof DECIDE_REFUSALS)[number];

export type ChatRefused<Reason extends string> = { readonly status: 'refused'; readonly reason: Reason };
export type ChatReadResult = ChatRead | ChatRefused<'unknown-session'>;
export type ChatPageResult = ChatPage | ChatRefused<'unknown-session' | 'unknown-cursor'>;
export type ChatWorkerReadResult = ChatWorkerRead | ChatRefused<'unknown-session' | 'unknown-worker' | 'unknown-cursor'>;
export type ChatSendResult = { readonly status: 'accepted' } | ChatRefused<SendRefusal | SendBlock>;
/** `asideId`: the aside to open — the one sent, or the one the same selection already has (M20b, C50, C73). */
export type ChatAskResult = { readonly status: 'accepted'; readonly asideId: string } | ChatRefused<AskRefusal | SendBlock>;
export type ChatAnswerResult = { readonly status: 'answered' } | ChatRefused<AnswerRefusal | SendRefusal | SendBlock>;
export type ChatDismissResult = { readonly status: 'dismissed' } | ChatRefused<DismissRefusal>;
/** `detail`: with `not-confirmed`, what the CLI said instead, in its own words, where it said anything. */
export type ChatSetModeResult = { readonly status: 'set' } | (ChatRefused<SetModeRefusal | SendBlock> & { readonly detail?: string | null });
export type ChatDecideResult = { readonly status: 'decided' } | ChatRefused<DecideRefusal>;
export type ChatAsideReadResult = ChatAsideRead | ChatRefused<'unknown-session' | 'unknown-aside' | 'unknown-cursor'>;
export type ChatAsideStopResult = { readonly status: 'stopping' } | ChatRefused<'unknown-session' | 'unknown-aside' | 'not-running'>;
export type ChatAsideRemoveResult = { readonly status: 'removed' } | ChatRefused<'unknown-session' | 'unknown-aside' | 'busy' | 'conversations-refused' | 'storage-failed'>;
export type ChatStopResult = { readonly status: 'stopping' } | ChatRefused<'unknown-session' | 'not-running'>;
/** `waiting`: the session runs, and the check starts once it is idle (C122). `unsupported`: its provider has no history. */
export type ChatLoadHistoryResult = { readonly status: 'loading' } | { readonly status: 'waiting' } | ChatRefused<'unknown-session' | 'unsupported' | SendBlock>;

// ── The push, and the page's rule (M15, C55, C96; M18, C20) ───────────────────────────────────

/** More text of a message that is being written (M19, C24): which item, how long its text was before, in UTF-16 units, and what to append. */
export interface ChatPartial {
  readonly itemId: string;
  readonly before: number;
  readonly append: string;
}

/**
 * One item of the selected session's conversation, with its turn as it then is — a new one at the
 * end, or a held one as it now is, which replaces it by id (M18, C60; M19, C26): a message at its
 * opening, at its bound and at its completion. Or more text of a message being written (M19, C24).
 * Or word that something else changed: an import, a turn's state, an item's id.
 *
 * An item push and a partial push for a worker's item name the worker (M20a, C32): the list takes
 * such a push for its revision and nothing else, and the worker's tab, when it is the one shown,
 * applies it as the list applies its own.
 *
 * An aside's pushes name the aside (M20b, C73), under its session's id and revision: an item or a
 * partial of its conversation, or word that something of it changed. The list and every other tab
 * take such a push for its revision alone, and the aside's tab, when it is the one shown, applies it.
 */
export type ChatPush = (
  | { readonly sessionId: string; readonly revision: number; readonly item: ConversationItem; readonly turn: ConversationTurn; readonly workerId?: string; readonly asideId?: string }
  | { readonly sessionId: string; readonly revision: number; readonly partial: ChatPartial; readonly workerId?: string; readonly asideId?: string }
  | { readonly sessionId: string; readonly revision: number; readonly changed: true; readonly asideId?: string }
  /**
   * The composer's state, as main now holds it (M23, C57, C86): pushed when main changed it — an image
   * staged or removed, a message queued, released or edited, Send now offered or withdrawn. It moves
   * the revision as any push does; no window's items change for it.
   */
  | { readonly sessionId: string; readonly revision: number; readonly composer: ChatComposer; readonly asideId?: undefined }
  /** Presentation changes never advance or participate in transcript sequencing. */
  | { readonly sessionId: string; readonly revision: number; readonly presentationOnly: true; readonly presentation: ChatPresentation; readonly asideId?: string; readonly workerId?: string }
) & { readonly presentation?: ChatPresentation };

/** How often main pushes a session's gathered text at most (M19, C25; K3). */
export const PARTIAL_PUSH_MS = 50;
/** How often an open message's text so far is written again at most (M19, C16; K4). */
export const PROGRESS_WRITE_MS = 2_000;

/**
 * What the page shows: which session, and at which revision. Null until its first read has answered.
 * `workerId`: whose items the window holds (M20a, C32) — a worker's, in its tab; left out or null
 * for the chat's list, which holds the session's own. `asideId` (M20b, C73): the aside whose
 * conversation the window holds, in its tab; left out or null for every other window.
 */
export interface HeldChat {
  readonly sessionId: string | null;
  readonly revision: number | null;
  readonly workerId?: string | null;
  readonly asideId?: string | null;
}

export type ChatIncoming = { readonly kind: 'read'; readonly sessionId: string; readonly revision: number } | { readonly kind: 'push'; readonly push: ChatPush };

/**
 * What the page does with a read's answer or a push (C96). The selection reaches the page in the
 * app state and a push at once, so the two can cross, and revisions are per session, so two
 * sessions' can match: naming the session in both is what makes a crossing harmless.
 *
 * - `drop`: it names another session, or is not newer than what is held.
 * - `take`: a read's answer, which replaces the window.
 * - `append`: an item push exactly one above: the item goes in, in place of a held one of its id.
 * - `append-text`: a partial push exactly one above (M19, C24). The revision is taken; the text is
 *   appended only by a window that holds the conversation's newest, to a held item whose text is
 *   exactly as long as the push says it was (`appendText`), and such a window reads again otherwise.
 * - `pass`: an item or a partial push exactly one above that is another's (M20a, C32) — a worker's,
 *   for the list; the session's own or another worker's, for a worker's tab. The revision is taken,
 *   and nothing of the window changes: no update of a worker's makes the list read again. So is
 *   every push that names an aside the window does not hold (M20b, C73), a change of it included.
 * - `read`: a gap, or something else changed: read the held window again (M18, C60).
 */
export function takeChat(held: HeldChat, incoming: ChatIncoming): 'drop' | 'take' | 'append' | 'append-text' | 'pass' | 'read' {
  const sessionId = incoming.kind === 'read' ? incoming.sessionId : incoming.push.sessionId;
  if (held.sessionId === null || sessionId !== held.sessionId) return 'drop';
  if (incoming.kind === 'read') return held.revision !== null && incoming.revision < held.revision ? 'drop' : 'take';
  if ('presentationOnly' in incoming.push) return 'drop';
  // Before the first answer the list is unknown: the read under way will bring what this push holds.
  if (held.revision === null) return 'drop';
  const { push } = incoming;
  if (push.revision <= held.revision) return 'drop';
  if (push.revision !== held.revision + 1) return 'read';
  const aside = push.asideId ?? null;
  // An aside's own change is its tab's to read, and no other window's (M20b, C73).
  if ('changed' in push) return aside !== null && aside !== (held.asideId ?? null) ? 'pass' : 'read';
  // The composer's state is no item of any window's (M23, C86): its revision is taken, and the composer takes it.
  if ('composer' in push) return 'pass';
  if ((push.workerId ?? null) !== (held.workerId ?? null) || aside !== (held.asideId ?? null)) return 'pass';
  return 'item' in push ? 'append' : 'append-text';
}

/**
 * A partial push applied to the item it names (M19, C24): the item with the text appended, or null
 * when it is not that item or its text is not as long as the push says it was — the window is then
 * read again. A message's text is one block.
 */
export function appendText(item: ConversationItem, partial: ChatPartial): ConversationItem | null {
  const [block, ...rest] = item.blocks;
  if (item.id !== partial.itemId || block === undefined || rest.length > 0 || block.text.length !== partial.before) return null;
  return { ...item, blocks: [{ ...block, text: block.text + partial.append }] };
}

// ── fat-g's words (Design 7, 9, 14) ───────────────────────────────────────────────────────────
// A notice's text is made by main from its kind; nothing here is the CLI's. `provider` is the
// provider's display name.

const STEP_WORDS: Readonly<Record<StartStep, string>> = {
  launch: 'could not be started',
  open: 'did not start the conversation',
  reopen: 'did not reopen the conversation',
  send: 'did not take the message',
};

/**
 * What a notice's words name beside its kind (M22, C7, C9, C46, C48, C67, C71). `mode`: fat-g's
 * label for the chat's mode, where the notice is about the policy a start was asked for. `bound`
 * and `size`: on a refusal for a size, which bound the request was past and by how much; `size`
 * alone, a line's bytes.
 */
export interface NoticeExtra {
  readonly mode?: string | null;
  /** The chat's mode is its provider's reading mode (M22, C45): every request to act is refused under it. */
  readonly reading?: boolean | null;
  readonly bound?: RefusedBound | null;
  readonly size?: number | null;
}

/** A size in bytes as mebibytes, to one decimal: "6.2 MiB". */
export function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const grouped = (count: number): string => count.toLocaleString('en-US');

/** A request refused for its size (M22, C9, C48, C67): which bound, and how much it was. */
function refusedForSize(provider: string, bound: RefusedBound, size: number): string {
  switch (bound) {
    case 'line':
      return `${provider} sent a request in a line of ${mebibytes(size)}, more than fat-g reads. It was refused; work continues.`;
    case 'detail':
      return `${provider} asked leave for an action of ${grouped(size)} characters, more than fat-g shows whole. It was refused, never shown cut.`;
    case 'targets':
      return `${provider} asked leave for an action that names ${grouped(size)} files, more than fat-g lists. It was refused.`;
    case 'choices':
      return `${provider} asked leave for an action with ${grouped(size)} choices, more than fat-g offers. It was refused.`;
    case 'path':
      return `${provider} asked leave for an action that names a path of ${grouped(size)} characters, more than fat-g takes. It was refused.`;
  }
}

export function noticeWords(kind: ChatNoticeKind, provider: string, step?: StartStep, extra: NoticeExtra = {}): string {
  const mode = extra.mode ?? null;
  switch (kind) {
    case 'start-failed':
      return `${provider} ${STEP_WORDS[step ?? 'launch']}. Nothing was sent after that; you can send again.`;
    case 'not-read-only':
      // "Restricted", for every provider (M16, C63): what a start is held to is its provider's own.
      // Under a mode it names the mode fat-g asked for (M22, C46): a session that may act is not restricted.
      if (mode !== null) return `${provider} did not start under ${mode}, so nothing was sent. Its own configuration may ask for another policy than fat-g asked for.`;
      return `${provider} did not accept the restricted start, so nothing was sent. Its own configuration may ask for more access than fat-g allows.`;
    case 'start-overruled':
      // Found after the prompt was written (M16, C62): it never says that nothing was sent, and it
      // names both causes, which fat-g cannot tell apart.
      return `${provider} started with other tools or permissions than ${mode === null ? 'fat-g asked for' : `${mode} asks for`}. Your message had already been sent, so fat-g stopped the session. A configuration that overrules fat-g’s start can cause this, and so can a version of ${provider} that reports names fat-g does not know.`;
    case 'policy-mismatch':
      // What the CLI reported is kept with the notice, in its own words (M22, C46).
      return `${provider} reported another policy than ${mode ?? 'this chat’s mode'}; nothing was sent. Choose a mode this account runs, or check ${provider}’s own configuration.`;
    case 'line-too-long':
      return `${provider} sent a line too long for fat-g to read${extra.size == null ? '' : ` (${mebibytes(extra.size)})`}. It may have been a request fat-g could not answer, so everything running here was stopped.`;
    case 'session-not-reopened':
      // The saved chat is the one copy fat-g can still show (M16, C68).
      return `${provider} could not reopen this conversation. It may have been deleted in ${provider}, or something else may have gone wrong. The chat fat-g saved stays readable. You can send again, or remove this session.`;
    case 'turn-failed':
      return `${provider} reported an error, and the reply ended.`;
    case 'connection-lost':
      return `${provider} stopped answering. The reply was ended.`;
    case 'output-lost':
      return `${provider}'s last output could not be read. The reply was ended.`;
    case 'stop-unconfirmed':
      return `${provider} did not confirm the stop, so its process was ended.`;
    case 'workers-stopped':
      return 'The workers still running were stopped.';
    case 'workers-lost':
      return `${provider} ended while workers were still running.`;
    case 'request-refused':
      if (extra.bound != null && extra.size != null) return refusedForSize(provider, extra.bound, extra.size);
      // Under a reading mode the mode is why (M22, C45): said by its name, with what would let the request ask.
      if (extra.reading === true && mode !== null) return `${provider} asked to act, and this chat is ${mode}: the request was refused. Change the chat’s mode to be asked instead.`;
      return `${provider} asked for something fat-g does not grant in this version. It was refused.`;
    case 'folder-not-passed':
      // It names no folder (M16, C20): a path is the user's, and a notice is saved with the chat.
      return `One of this project’s folders could not be passed to ${provider}: its path holds a character fat-g cannot pass safely. The session runs without it.`;
    case 'no-answer':
      // Never a text shown as the model's (M20b, C39).
      return 'No answer was given.';
    case 'command-clear':
      // What fat-g did, and the way in fat-g: nothing of what the command would have done (M20b, C56).
      return `fat-g did not send /clear to ${provider}. A session in fat-g keeps one conversation: for another, start a new session, or pick one from fat-g’s list.`;
    case 'command-model':
      return `fat-g did not send /model to ${provider}. A session’s model is fixed when the session is created: for another model, start a new session.`;
    case 'command-fast':
      // fat-g asks for the speed with each turn (decision 0016): the way to it in fat-g, as /model's says.
      return `fat-g did not send /fast to ${provider}. fat-g asks for a session’s speed itself: choose Fast with the effort, and it applies from the next reply.`;
    case 'session-unsaved':
      // It says nothing of a restart (M18, C46): the conversation store keeps what resumes it.
      return 'This session could not be saved to fat-g’s list. The conversation goes on.';
    case 'turn-not-shown':
      return 'A reply here was too large to show.';
    case 'plan-mode-left':
      // Once, on a thread an earlier run left in the CLI's plan mode and fat-g cannot return (M22b, C55).
      return `This chat may still be in ${provider}’s plan mode, which fat-g cannot leave with this version of ${provider}. A new chat is not in it. A plan waiting here stays as it is.`;
    case 'plan-missing':
      return `${provider} asked for a decision on a plan, and no plan reached fat-g. The request was refused, and no plan was kept.`;
    case 'plan-too-large':
      return `${provider} sent a plan too large for fat-g to receive${extra.size == null ? '' : ` (${mebibytes(extra.size)})`}. No plan was kept.`;
  }
}

/**
 * A notice of an aside's, in fat-g's words (M20b, C39, C70). An aside's turn ends alone: its
 * session and the process they share go on, so the words that say a process was ended, or that a
 * turn of the session's was, are not an aside's. Every other kind reads as it does in the chat.
 */
export function asideNoticeWords(kind: ChatNoticeKind, provider: string, step?: StartStep, extra: NoticeExtra = {}): string {
  return ASIDE_NOTICES[kind]?.(provider, step, extra) ?? noticeWords(kind, provider, step, extra);
}

/** The kinds whose words are an aside's own. */
const ASIDE_NOTICES: Partial<Record<ChatNoticeKind, (provider: string, step: StartStep | undefined, extra: NoticeExtra) => string>> = {
  'start-failed': (provider, step) => `${provider} ${STEP_WORDS[step ?? 'launch']}, so this question was not answered. You can ask again.`,
  'not-read-only': (provider, _step, extra) => (extra.mode == null ? `${provider} did not accept the restricted start for this question, so nothing was sent.` : `${provider} did not start under ${extra.mode} for this question, so nothing was sent.`),
  'policy-mismatch': (provider, _step, extra) => `${provider} reported another policy than ${extra.mode ?? 'this chat’s mode'}, so this question was not sent.`,
  'line-too-long': (provider, _step, extra) => `${provider} sent a line too long for fat-g to read${extra.size == null ? '' : ` (${mebibytes(extra.size)})`}. It may have been a request fat-g could not answer, so this question was stopped.`,
  'turn-failed': (provider) => `${provider} reported an error, and this question was not answered.`,
  'connection-lost': (provider) => `${provider} stopped answering, and this question was ended.`,
  'stop-unconfirmed': (provider) => `${provider} did not confirm the stop. This question was ended here; the session goes on.`,
};

/** Said before M14's own confirmation when Remove is offered for a session that did not reopen (C129). */
export function removeUnsure(provider: string): string {
  return `fat-g cannot tell for sure that this conversation is gone. Removing the session takes it off fat-g’s list and deletes the chat fat-g saved: nothing in ${provider} is deleted.`;
}

/** What the Remove confirmations add (M18, C21, C23): the saved chat goes too, and nothing of the provider's. */
export const REMOVE_CHAT_TEXT = {
  session: (provider: string): string => `The chat fat-g saved for this session is deleted too. Its conversation stays in ${provider}’s own history, which fat-g does not touch.`,
  project: 'The chats fat-g saved for its sessions are deleted too. Nothing in the providers’ own histories is touched.',
  orphans: 'The chats fat-g saved for them are deleted too.',
} as const;

/** The lines that are not messages (M15, C93, C95, C113, C116, C122; M18, C16, C18, C19, C58). */
export const CHAT_LINES = {
  /** The control at the head of the list (M18, C58). */
  showEarlier: 'Show earlier messages',
  /** Announced in place of the items an older page put in (M18, Design 5). */
  earlierLoaded: (count: number): string => `${count} earlier ${count === 1 ? 'message' : 'messages'} loaded.`,
  /** The page let go of its newest (M18, C58). */
  notLatest: 'Newer messages are not shown here.',
  /** The same, once something has arrived that the window does not show (M19, C46). */
  notLatestNew: 'New messages have arrived, and are not shown here.',
  showLatest: 'Show latest',
  /** The store does not hold the conversation's start (M18, C18). */
  earlierMissing: 'Earlier messages of this conversation are not saved in fat-g.',
  historyFailed: 'Earlier messages could not be loaded.',
  olderUnread: 'Older messages could not be read.',
  loading: 'Checking for earlier messages…',
  cut: 'This message was too long to show in full.',
  /** Under a message that never finished (M19, C18): what was received of it is all there is. */
  incomplete: 'This message is incomplete: fat-g did not receive the rest of it.',
  /** The control at the list's foot, while the reader is away from its end (M19, C46). */
  toEnd: 'Go to the latest',
  toEndNew: 'New below: go to the latest',
  /** The one short notice at a selected live turn's end (M19, C49). */
  answerFinished: 'The answer is finished.',
  answerStopped: 'The answer was stopped.',
  answerEnded: 'The reply ended.',
  /** Under a turn's last item, with its duration (M19, C43): never worded as thinking time. */
  elapsed: 'Elapsed',
  /** The title of the one time shown on an imported turn's first item (M19, C42): whose time it is. */
  providerTime: (provider: string): string => `When ${provider} says this reply started`,
  /** A message's Copy button, by name (M19, C38): it copies the message's text as its provider sent it. */
  copyMessage: 'Copy message',
  /**
   * An answer's message's (the maintainer): an answer is told in parts — between its
   * activity, and before its last word — and the button copies the one part it stands beside.
   */
  copyPart: 'Copy this part',
  /** At the foot of an answer, under its speaker's bar (the maintainer): every part of its text, in order. */
  copyAnswer: 'Copy entire message',
  /** At the foot of an answer: all user and assistant messages in this conversation. */
  copyConversation: 'Copy entire conversation',
  unconfirmed: (provider: string): string => `${provider}'s earlier process for this session could not be confirmed stopped. Send again, or restart fat-g.`,
  /** Under a turn the provider never confirmed it took (M18, C15, C16). It claims no more than that. */
  unacknowledged: (provider: string): string => `${provider} did not confirm that it received this message.`,
  /** Under a turn whose end the provider never gave (M18, C16, C59). */
  unfinished: 'fat-g did not receive the end of this reply.',
  /** Under a turn of which something could not be saved (M18, C19). */
  gap: 'Part of this reply could not be saved.',
  /** A Send refused because its record could not be written (M18, C19): the draft stays. */
  storageFailed: 'fat-g could not save your message, so nothing was sent. Try again.',
  /** A detached conversation takes no prompt (M18, C35). */
  readOnly: 'This chat has no session, so nothing can be sent. It can be read, copied and removed.',
} as const;

/** Where a reason's remedy is (C68): Settings, the project's dialog, the chat's mode control (M22, C46, C89), or nowhere. */
export type BlockRemedy = 'settings' | 'edit-project' | 'change-mode' | null;

/** What the two mode blocks name (M22, C46): fat-g's label for the chat's mode, and why its account cannot use it, where it cannot. */
export interface BlockedMode {
  readonly label: string;
  readonly reason: ModeReason | null;
}

/** Why a session cannot take a prompt, in words, with its remedy (C68, C105). `mode`: what the two mode blocks name. */
export function blockWords(block: SendBlock, provider: string, mode: BlockedMode | null = null): { readonly text: string; readonly remedy: BlockRemedy } {
  switch (block) {
    case 'mode-unconfirmed':
      return { text: `${provider} reported another policy than ${mode?.label ?? 'this chat’s mode'}; nothing was sent. Choose a mode this account runs.`, remedy: 'change-mode' };
    case 'mode-unavailable':
      return { text: mode === null || mode.reason === null ? 'This chat’s mode is not available to this account. Choose another.' : `${modeReasonWords(mode.reason, mode.label, provider)} Choose another mode.`, remedy: 'change-mode' };
    case 'records-refused':
      return { text: 'fat-g could not read its records, so nothing can be sent.', remedy: null };
    case 'conversations-refused':
      return { text: 'fat-g could not read its saved chats, so nothing can be sent.', remedy: null };
    case 'demo':
      return { text: 'Demo sessions are scripted: nothing is sent.', remedy: null };
    case 'provider-unavailable':
      return { text: `${provider} is switched off, or was not found.`, remedy: 'settings' };
    case 'no-sessions':
      return { text: `${provider} sessions are not available in this version.`, remedy: null };
    case 'instance-unavailable':
      return { text: 'This session’s account is switched off, or no longer set up.', remedy: 'settings' };
    case 'folder-moved':
      return { text: 'This session started in another configuration folder than its account has now.', remedy: null };
    case 'not-offered':
      return { text: `This project is no longer offered to ${provider}.`, remedy: 'edit-project' };
    case 'signed-out':
      return { text: `This account is signed out of ${provider}.`, remedy: 'settings' };
    case 'not-connected':
      return { text: `${provider} is not connected yet.`, remedy: 'settings' };
    case 'folder-not-root':
      return { text: 'The folder this session started in is no longer one of its project’s folders.', remedy: 'edit-project' };
    case 'folder-not-trusted':
      return { text: 'The project’s folder is not marked as trusted.', remedy: 'edit-project' };
    case 'folder-missing':
      return { text: 'The project’s folder cannot be found.', remedy: 'edit-project' };
    case 'model-not-listed':
      return { text: `${provider}’s CLI no longer lists this chat’s model, and fat-g does not switch a chat to another. If your CLI still runs it, catalog.json can add it back.`, remedy: null };
  }
}
