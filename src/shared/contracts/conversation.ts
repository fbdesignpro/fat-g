// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The conversation (docs/planning/_archive/M18.md, Design 1, 5, 8, 9; C1–C6, C17; M19.md, Design 4; C15, C27,
// C44; M20a.md, Design 1, 6; C3, C28, C31; M21.md, Design 1; C4, C36): what fat-g keeps of a chat, in terms no provider owns. Adapters turn their CLI's events into the agent events, main
// keeps the conversation in its store (src/main/conversations/) and the Main window reads pages of
// it over the chat channels. The Pet gets none of it.
//
// Renderer-safe: types, the limits, and the pure helpers main and the page must agree on.
//
//   conversation ── its id is its session's id (C31)
//     turn ── a stored place; the provider's end and the session's end, kept apart (C54)
//       item ── a stored place in its turn; a message or a notice, as text blocks, or an
//                activity or an interaction, each with a body of its own (activity.ts,
//                interaction.ts); the session's own, or a worker's
//
// Order is the stored places, never a text, a time or a list's position (C2, C49). Every time is
// milliseconds since the epoch, named for who gave it; a duration is named `…Ms`; null is unknown,
// and a provider's time is never filled in from the local clock (C4).
import { z } from 'zod';
import { catalogId } from './catalog';
import { normalizeText } from './names';
import { type ActivityBody, activityUnits } from './activity';
import { type AgentQuestion, MAX_MESSAGE_TEXT, type MessagePhase, NOTICE_KINDS } from './agent-events';
import type { AttachmentView } from './attachments';
import type { DeliveryView } from './composer';
import { type InteractionBody, interactionUnits } from './interaction';
import type { PlanFields } from './plans';
import type { RecordsRefusalCause } from './projects';
import type { ProviderDescriptor } from './provider';
import type { TurnOutcome } from './sessions';

// ── Items (C1–C3, C10) ────────────────────────────────────────────────────────────────────────

/** What M18 produces (C10), from M20a an activity (M20a, C3), and from M21 an interaction: a question the session asks (M21, C4). */
export const ITEM_KINDS = ['message', 'notice', 'activity', 'interaction'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * Kinds the page never draws as items (C3, C12, S7). `attachment` is a turn's use of an image (M23,
 * C5): the store writes one for each image of a message and folds it into that message's
 * `attachments` as it reads, so no page holds one as an item of its own. `branch` is a kind alone,
 * M24's to define: nothing writes one and the page draws none. A kind string this build does not
 * know reads as the first of these, so no row is ever taken for a kind that is drawn. `interaction`
 * was one until M21 gave it its body (M21, C4).
 */
export const RESERVED_ITEM_KINDS = ['attachment', 'branch'] as const;
export type ReservedItemKind = (typeof RESERVED_ITEM_KINDS)[number];

export function isItemKind(value: unknown): value is ItemKind | ReservedItemKind {
  return typeof value === 'string' && ([...ITEM_KINDS, ...RESERVED_ITEM_KINDS] as readonly string[]).includes(value);
}

/**
 * fat-g's answer to a command of the provider's own that it did not send (M20b, C35, C56; decision
 * 0023): the turn's message, in fat-g's words. One kind for each command a provider's facet lists.
 */
export const COMMAND_NOTICE_KINDS = ['command-clear', 'command-model', 'command-fast'] as const;
export type CommandNoticeKind = (typeof COMMAND_NOTICE_KINDS)[number];

/**
 * `session-unsaved` is main's own (M15, C108); `turn-not-shown` stands where history left a turn out (M15, C102).
 * `plan-mode-left` says once that a thread an earlier run left in the CLI's plan mode cannot be
 * returned from it (M22b, C55): main's own. A plan turn opens with no notice.
 */
export const CHAT_NOTICE_KINDS = [...NOTICE_KINDS, 'session-unsaved', 'turn-not-shown', 'plan-mode-left', ...COMMAND_NOTICE_KINDS] as const;
export type ChatNoticeKind = (typeof CHAT_NOTICE_KINDS)[number];

export interface TextBlock {
  readonly type: 'text';
  /** The conversation's own text, as it was sent; for a notice, fat-g's words. */
  readonly text: string;
  /** Cut to its bound (C17): the page draws the marker. */
  readonly cut: boolean;
}

/**
 * Whether a message is all there (M19, C15). `streaming`: it is being written, in the turn in flight
 * in this run. `partial`: it never finished — its turn ended, or fat-g did, while it was open — and
 * what was received of it is kept as it is. An item read from history, one written whole and every
 * notice are `complete`. No message is `streaming` after a restart.
 */
export const ITEM_STATES = ['complete', 'streaming', 'partial'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** Recorded live by fat-g, or read from the provider's own history (C50). */
export const ITEM_ORIGINS = ['local', 'provider'] as const;
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];

export interface ConversationItem {
  /** fat-g's, stable; a prompt's is the client id it was sent with (C2, C53). */
  readonly id: string;
  readonly conversationId: string;
  readonly turnId: string;
  /** Stored places (C2, C49): the turn's in its conversation, the item's in its turn. */
  readonly order: { readonly turn: number; readonly item: number };
  readonly kind: ItemKind | ReservedItemKind;
  readonly origin: ItemOrigin;
  /** The provider's id for it, once known (M15, C56). */
  readonly providerItemId: string | null;
  /**
   * Whose item it is (M20a, C20, C28): null for the session's own, else the worker's id. A worker's
   * items are kept in the turn that started it and are in no page of the session's: they are read
   * by the worker channel.
   */
  readonly workerId: string | null;
  /** An activity's body (M20a, C3); null for every other kind. */
  readonly activity: ActivityBody | null;
  /** An interaction's body (M21, C4): a question the session asks, its answers and its outcome; null for every other kind. */
  readonly interaction: InteractionBody | null;
  /** A message's; null for a notice, an activity, an interaction and a reserved kind. */
  readonly role: 'user' | 'assistant' | null;
  readonly phase: MessagePhase | null;
  /**
   * The model that wrote a message, where its provider said another answered than the session's
   * (M20b, C25, C28): a catalog key. Null for every other item, and for a message that names none.
   */
  readonly model: string | null;
  /** Whether it is all there (M19, C15). */
  readonly state: ItemState;
  readonly blocks: readonly TextBlock[];
  readonly questions: readonly AgentQuestion[];
  readonly notice: ChatNoticeKind | null;
  /** The CLI's own words, kept with the notice (C34). */
  readonly detail: string | null;
  /**
   * A prompt fat-g composed for a plan (M22b, C69): the plan and the version it names, and whether it
   * plans that version's next or carries it out. Left out, or null, for every other item.
   */
  readonly plan?: PlanFields | null;
  /**
   * A message's images (M23, C5, C26; returned-image previews), in their order: each by its use, with what the store
   * holds of its image. Left out, or empty, for every other item.
   */
  readonly attachments?: readonly AttachmentView[];
  /**
   * A message sent into a running turn (M23, C38–C44): what became of it so far. Left out, or null,
   * for every other item, a prompt that started its own turn among them.
   */
  readonly delivery?: DeliveryView | null;
  /** This user message was accepted from the session's queue. */
  readonly fromQueue?: boolean;
  readonly time: {
    /** When main took it. Null for what was read from history. */
    readonly receivedAt: number | null;
    /** When the provider says it was made: for history, when its turn started. */
    readonly providerAt: number | null;
  };
}

/** An item's text as one string: its blocks, in order. */
export function itemText(item: Pick<ConversationItem, 'blocks'>): string {
  return item.blocks.map((block) => block.text).join('\n');
}

export function itemCut(item: Pick<ConversationItem, 'blocks'>): boolean {
  return item.blocks.some((block) => block.cut);
}

// ── Turns (C1, C4, C16, C19, C54) ─────────────────────────────────────────────────────────────

/**
 * `running`: the turn in flight. `ended`: the provider said it was over. Without the provider's end
 * and with no live turn (C16, C59): `unacknowledged` when the provider never confirmed that it took
 * the prompt, else `unfinished`. Neither says the message was not delivered: fat-g cannot know.
 */
export const TURN_STATES = ['running', 'ended', 'unfinished', 'unacknowledged'] as const;
export type TurnState = (typeof TURN_STATES)[number];

/** The speed requested for a turn, snapshotted from its model's catalog at dispatch. */
export const TurnSpeedSchema = z.object({
  id: z.string().refine((value) => catalogId(value) !== null, 'not a catalog id'),
  name: z.string().refine((value) => value !== '' && normalizeText(value, 128) === value, 'not a clean tier name'),
});
export type TurnSpeed = z.infer<typeof TurnSpeedSchema>;

export interface ConversationTurn {
  /** Requested tier; null for standard, absent where no request was recorded (e.g. imported history). */
  readonly speed?: TurnSpeed | null;
  /** The runtime's, or made at import. */
  readonly id: string;
  readonly place: number;
  readonly origin: ItemOrigin;
  readonly state: TurnState;
  /** The provider's, else the session's (C54). Null when neither is known: none is invented. */
  readonly outcome: TurnOutcome | null;
  /** Something of it could not be saved (C19). */
  readonly gap: boolean;
  /**
   * The id of the mode the turn ran under (M22, C25, C83): the chat's saved mode when its prompt was
   * accepted. Null for an imported turn, an aside's, and one of a provider that declares no mode.
   */
  readonly mode: string | null;
  readonly time: {
    readonly acceptedAt: number | null;
    readonly providerStartedAt: number | null;
    readonly providerEndedAt: number | null;
    /** When main took the provider's end. */
    readonly endReceivedAt: number | null;
    readonly providerDurationMs: number | null;
    /**
     * How long a turn fat-g ran took, from the prompt's acceptance to the provider's end as main took
     * it, excluding waits for its own blocking decisions, on a monotonic clock (M19, C43, C44):
     * a duration of its own beside the provider's. Null for an imported turn, and until the
     * provider's end is known.
     */
    readonly elapsedMs: number | null;
  };
}

/**
 * What the Elapsed line shows under a turn (M19, C43): fat-g's own measure for a turn it ran, the
 * provider's duration for an imported one, and nothing — null — for a turn that runs, is unfinished
 * or was never confirmed, or an imported one whose provider gave no duration.
 */
export function turnElapsedMs(turn: Pick<ConversationTurn, 'state' | 'origin' | 'time'>): number | null {
  if (turn.state !== 'ended') return null;
  return turn.origin === 'local' ? turn.time.elapsedMs : turn.time.providerDurationMs;
}

/**
 * A worker's identity and lifetime (C5): its own, beside its turn and not inside it, since a worker
 * can outlive the turn that started it (M14, C114). M18 stores no worker (C10): what the store keeps
 * of a worker's lifetime is its turn's two ends.
 */
export interface ConversationWorker {
  readonly id: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly outcome: 'completed' | 'failed' | null;
}

// ── Limits (C17, C58) ─────────────────────────────────────────────────────────────────────────

export { MAX_MESSAGE_TEXT };
/**
 * A page of local history (C20), in entries (M20a, C31): an entry is a message, a notice, or the
 * consecutive activities of a turn between two of those — what the chat draws as one group. A page
 * and a window are cut at an entry's boundary, never inside a group.
 */
export const PAGE_ENTRIES = 100;
/** A page ends early before its text passes this, with one entry at least. UTF-16 units. */
export const MAX_PAGE_UNITS = 1_000_000;
/** What the page holds at most, and what main answers for a window (C58, C60), in entries. */
export const WINDOW_ENTRIES = 500;
export const MAX_WINDOW_UNITS = 5_000_000;
/** What could not be saved is kept in memory for the run, this many per session at most (C19). */
export const MAX_UNSAVED_ITEMS = 200;

type Sized = Pick<ConversationItem, 'blocks' | 'questions' | 'detail' | 'activity' | 'interaction'>;
type Entered = Sized & Pick<ConversationItem, 'kind' | 'turnId'>;

/** An item's size, in UTF-16 units of its text: what the page and window bounds count. An activity's is its whole body's (M20a, C31), an interaction's its questions' and its answers' texts (M21, C36). */
export function itemUnits(item: Sized): number {
  const blocks = item.blocks.reduce((sum, block) => sum + block.text.length, 0);
  const questions = item.questions.reduce((sum, question) => sum + question.title.length + question.options.reduce((inner, option) => inner + option.length, 0), 0);
  return blocks + questions + (item.detail?.length ?? 0) + (item.activity === null ? 0 : activityUnits(item.activity)) + (item.interaction === null ? 0 : interactionUnits(item.interaction));
}

/**
 * Whether `item` goes on with the entry `previous` is in (M20a, C31, C36): both are activities, of
 * one turn. A message, a notice, an interaction and an item of any other kind is an entry by itself.
 */
export function sameEntry(previous: Pick<ConversationItem, 'kind' | 'turnId'> | undefined, item: Pick<ConversationItem, 'kind' | 'turnId'>): boolean {
  return previous !== undefined && previous.kind === 'activity' && item.kind === 'activity' && previous.turnId === item.turnId;
}

/** `items`, in stored order, as entries: each a message, a notice, or the consecutive activities of a turn. */
export function entriesOf<T extends Pick<ConversationItem, 'kind' | 'turnId'>>(items: readonly T[]): T[][] {
  const entries: T[][] = [];
  for (const item of items) {
    const last = entries.at(-1);
    if (last !== undefined && sameEntry(last.at(-1), item)) last.push(item);
    else entries.push([item]);
  }
  return entries;
}

/**
 * `items`, oldest first, cut to a count of entries and a size: the newest are kept, or the oldest,
 * and one entry at least; an entry is kept whole or not at all. `cut` says whether any was let go.
 */
export function boundItems<T extends Entered>(items: readonly T[], keep: 'newest' | 'oldest', maxEntries: number, maxUnits: number): { readonly items: readonly T[]; readonly cut: boolean } {
  const entries = entriesOf(items);
  if (keep === 'newest') entries.reverse();
  const kept: T[][] = [];
  let units = 0;
  for (const entry of entries) {
    const size = entry.reduce((sum, item) => sum + itemUnits(item), 0);
    if (kept.length > 0 && (kept.length >= maxEntries || units + size > maxUnits)) break;
    kept.push(entry);
    units += size;
  }
  if (keep === 'newest') kept.reverse();
  const flat = kept.flat();
  return { items: flat.length === items.length ? items : flat, cut: flat.length < items.length };
}

/** The window's two bounds (C58): one function, for the page as it appends or adds a page and for main as it answers a window. */
export function fitWindow<T extends Entered>(items: readonly T[], keep: 'newest' | 'oldest'): { readonly items: readonly T[]; readonly cut: boolean } {
  return boundItems(items, keep, WINDOW_ENTRIES, MAX_WINDOW_UNITS);
}

/** By the stored places (C2): what the page sorts by, whatever order its answers and pushes came in. */
export function compareItems(a: Pick<ConversationItem, 'order'>, b: Pick<ConversationItem, 'order'>): number {
  return a.order.turn - b.order.turn || a.order.item - b.order.item;
}

// ── Capabilities (C6) ─────────────────────────────────────────────────────────────────────────

/** What a chat can ask of a provider besides running a session. M18 has one; later milestones add theirs. */
export const CHAT_CAPABILITIES = ['history'] as const;
export type ChatCapability = (typeof CHAT_CAPABILITIES)[number];

/**
 * `supported` and `unsupported` are the descriptor's, for good. `unavailable` is a session's, at a
 * moment: supported, and it cannot be done now. It is said in the chat's history state.
 */
export const CAPABILITY_STATES = ['supported', 'unsupported', 'unavailable'] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/** Whether a provider has a chat capability: `unsupported` for every name its descriptor does not declare (C6). */
export function chatCapability(descriptor: { readonly capabilities: Partial<ProviderDescriptor['capabilities']> }, name: string): 'supported' | 'unsupported' {
  if (!(CHAT_CAPABILITIES as readonly string[]).includes(name)) return 'unsupported';
  return (descriptor.capabilities as Readonly<Record<string, unknown>>)[name] === true ? 'supported' : 'unsupported';
}

// ── The store, as the Main window sees it (C23, C31–C33, C41) ─────────────────────────────────

/** The conversation store's file, in fat-g's data folder. SQLite keeps `-wal` and `-shm` beside it while it is open (C40). */
export const CONVERSATIONS_FILE = 'conversations.sqlite';

/** The causes are the records file's own four, so the notes share their words (C33, C36). */
export type ConversationsStatus = { readonly kind: 'ok' } | { readonly kind: 'refused'; readonly cause: RecordsRefusalCause };

/** The Main window's `AppStateSnapshot.conversations`: the store's status and a count, never a name (C24, C31). */
export interface ConversationsState {
  readonly status: ConversationsStatus;
  /** Conversations no listed session has (C31): zero while the store is refused. */
  readonly detached: number;
}

/** A detached conversation in the row's list (C31): named by its first prompt's first line. */
export interface DetachedConversation {
  readonly id: string;
  /** Null for one with no prompt to name it: shown by its date. */
  readonly name: string | null;
  readonly createdAt: number;
}

/** What the storage view shows (C23, C41). Sizes are bytes on disk, but the detached text's, in UTF-16 units. */
export interface ConversationsStorage {
  readonly status: ConversationsStatus;
  /** The store's files together: the main file and the two SQLite keeps beside it. Null when they could not be measured. */
  readonly bytes: number | null;
  readonly detached: { readonly count: number; readonly textUnits: number };
  /** Stores set aside by Start fresh (C41), by the main file's name, each with its sidecars' sizes added — and its images' folder's (M23, C84). */
  readonly setAside: readonly { readonly name: string; readonly bytes: number }[];
  /** The active images' folder (M23, C12): its files and their size; null when they could not be measured. */
  readonly attachments: { readonly count: number; readonly bytes: number } | null;
}

// ── The conversations channels (C23, C24, C32, C35, C41) ──────────────────────────────────────

/** An item's id, as a cursor: fat-g's own, a UUID or a prompt's client id. */
export const ItemIdSchema = z.string().min(1).max(128).refine((value) => !/\p{Cc}/u.test(value), 'control character');

/** A set-aside store's main file, as Start fresh names it: the only names a removal takes (C41). */
export const SET_ASIDE_STORE = /^conversations\.set-aside\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(?:-\d{1,2})?\.sqlite$/;

const conversationId = z.guid();
const MAX_REMOVED = 1000;

/** A page of a detached conversation (C35): the newest, or the one before `before`. */
export const DetachedReadRequestSchema = z.strictObject({ id: conversationId, before: ItemIdSchema.optional() });
export const DetachedRemoveRequestSchema = z.union([z.strictObject({ ids: z.array(conversationId).min(1).max(MAX_REMOVED) }), z.strictObject({ all: z.literal(true) })]);
export const SetAsideRemoveRequestSchema = z.union([z.strictObject({ names: z.array(z.string().max(128).regex(SET_ASIDE_STORE)).min(1).max(MAX_REMOVED) }), z.strictObject({ all: z.literal(true) })]);
export type DetachedReadRequest = z.infer<typeof DetachedReadRequestSchema>;
export type DetachedRemoveRequest = z.infer<typeof DetachedRemoveRequestSchema>;
export type SetAsideRemoveRequest = z.infer<typeof SetAsideRemoveRequestSchema>;

export const CONVERSATIONS_REFUSALS = [
  /** Detached conversations are not removed while records are refused (C32): one of them may be a listed session's. */
  'records-refused',
  'conversations-refused',
  /** The store, or the file system, did not do it: nothing else was changed. */
  'storage-failed',
  /** No detached conversation has this id: it has a session, or is gone. */
  'unknown-conversation',
  'unknown-cursor',
] as const;
export type ConversationsRefusal = { readonly status: 'refused'; readonly reason: (typeof CONVERSATIONS_REFUSALS)[number] };
export type ConversationsSaved = { readonly status: 'saved' };
/** How many stores went, and how many could not be removed: a failure leaves the rest as it is (C23). */
export type SetAsideRemoved = { readonly status: 'saved'; readonly removed: number; readonly failed: number };
