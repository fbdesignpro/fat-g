// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A listed session's chat, over the conversation store (docs/planning/_archive/M18.md, Design 4 and 5;
// C14–C20, C44, C58–C60; M19.md, Design 4 and 5; C14–C19, C21, C23–C27, C64; M20a.md, Design 6, 7;
// C20, C29, C30, C32, C34, C35): what the runtime
// writes of a turn goes through here to disk, and what the page reads comes back from disk a page at
// a time. It has no file of its own and reaches none: the store is handed in as an interface.
//
// Per session it keeps, in memory and for the run: a revision, raised by one with every change and
// carried by every answer and push, which is how the page orders them (M15, C96); the state of the
// history check; the turn in flight; the messages being written; and what could not be saved.
//
// A message being written (M19, C14). Its first delta opens it: its id, its time and its place in
// its turn are fixed then, and it is pushed as an item, empty. At its first text it is written to
// the store as incomplete, and written again at most every two seconds while it grows (C16). The
// text it gathers is pushed to the page at most every 50 ms (C25); a read answers what has been
// pushed, and leaves what is gathered since for the next push, so no text is told twice (C26). The
// whole message completes it, in one write and one push, and is the authority for its text (C4,
// C17). A turn that ends with a message open leaves it as far as it got (C18).
//
//   delta ─► opened ─► [text] ─► written ─► … ─► whole message ─► complete
//             pushed     gathered: 50 ms         │
//                        written again: 2 s      └► the turn ends first ─► partial, as it is
//
// Past its bound a message takes no more (C6, C64): it is cut, and pushed at once with its flag,
// which every later write of it carries.
//
// A write that fails (M18, C19; M19, C21): at acceptance the prompt is refused, and nothing is sent.
// During a turn the item is kept here for the run, 200 a session at most, and pushed as usual; a
// read lays what is kept here over what the store answers, by id, so stale text on disk never
// replaces it and nothing shows twice. The turn's gap is written by the next write that succeeds,
// and until then the answers say it themselves. No failed write is queued: a message's later writes
// are each attempted on their own, with its latest text. Nothing is said to be saved that is not.
//
// What a session does between its messages (M20a, C29). An activity is written at its start and
// pushed at once, as a message's opening is, and its end is an update of that row and one push. The
// store knows nothing that runs: an activity reads `running` only while it is held open here, and
// what an end leaves of the open ones is written then —
//
//   the provider's end of a turn   the session's own: unfinished, with what they have; a checklist
//                                  completed; a worker item whose worker still runs, and a worker's
//                                  own items, stay open until that worker ends
//   an end the adapter made,       every open one of the session, a worker's included: unfinished
//   a lost process, a quit
//
// A completion that comes after its turn's end still ends its item. A duration is the provider's
// where it gives one, else the span between main's receipt of the start and of the end, on a
// monotonic clock (C35).
//
// A worker's items (C20, C32) are written under its id, in the turn that started it, whether or not
// that turn has ended, and are in no answer of the session's own: `readWorker` answers them, and a
// push for one names its worker.
//
// A question asked beside a session (M20b, C28, C31, C34; decision 0025). An aside is a conversation
// of its own, with an entry of its own here, keyed by the aside's id and naming its session: its
// question is accepted as a prompt is, and its answers, its activities and its turn's ends are
// written through the same paths. What differs is who is told. An aside's pushes go out under its
// session's id and revision and name the aside, so the session's list takes them for their revision
// alone and the aside's tab applies them; and a session's read lists its asides as markers, with
// whether a turn of each runs, and none of their text.
//
// A question the session asks (M21, C33–C35, C61, C76; decision 0026). A blocking one is written
// when it is raised and pushed at once, and each outcome is an update of that row and one push, a
// held item replaced by id; an async one is written in the transaction that writes its message, and
// its answer in the one that records its prompt. Nothing of a question is kept here: the request
// registry holds what lives, and is asked — a stored `pending` reads `dropped` from the store, and
// reads `pending` again only while the registry holds its request pending; an item answered and
// not yet confirmed is overlaid by nothing. The ends leave the items to the registry's sweep.
//
// An action the session asks leave for (M22, C12, C48, C57, C77, C79, C81, C92; decision 0027) is
// written and pushed the same way, and two things are laid over it at each read and push, neither
// kept here: while the registry holds its request pending, the request whole in place of the store's
// cut copy, so the live card shows the action as it is; and on a grant, whether the process it was
// sent to is still the session's — which only the runtime knows, and which no stored grant is after
// a restart. A read lists the session's grants from the store: those whose reply was delivered.
// The chat's mode and each turn's are the store's too, read as they are.
//
// A plan's line (M22b, C10, C14, C17, C64; decision 0029) is written and pushed as a card is, its
// text never: the plan store holds that, and the plan service (plans.ts) writes both. A line a
// request holds reads `pending` only while the registry holds that request, as an approval does; a
// line of a turn fat-g starts for its decision, or one brought into the chat, is `pending` as stored.
// A decision that starts a turn is written in that turn's prompt's own transaction.
//
// Nothing here is logged but counts and kinds (C23; M20a, C34): never a text, a path or a command line.
import { type ActivityBody, type ActivityDuration, type ActivityEnd, type ActivityStart, type ActivityType, ACTIVITY_TYPES, endedBody, restartedBody, startedBody } from '@shared/contracts/activity';
import { cutTo, MAX_MESSAGE_TEXT, type MessagePhase } from '@shared/contracts/agent-events';
import { type AsideMarker, type AsideSource, samePlace } from '@shared/contracts/aside';
import { type ChatAsideReadResult, type ChatHistory, type ChatPageResult, type ChatPush, type ChatRead, type ChatWorkerReadResult, type HistoryState, PARTIAL_PUSH_MS, PROGRESS_WRITE_MS, type WaitingQuestion } from '@shared/contracts/chat';
import { compareItems, type ConversationItem, type ConversationTurn, fitWindow, itemText, MAX_UNSAVED_ITEMS } from '@shared/contracts/conversation';
import { type ApprovalDecision, type ApprovalRequest, fromMessageQuestions, heldByRequest, type InteractionAnswer, type InteractionBody, type InteractionQuestion, type PlanBody, type SessionGrant, type WithdrawnBy } from '@shared/contracts/interaction';
import type { PlanOutcome } from '@shared/contracts/plans';
import type { ChatMode } from '@shared/contracts/permissions';
import type { ChatComposer, DeliveryView } from '@shared/contracts/composer';
import type { ReportedOutcome, TurnOutcome } from '@shared/contracts/sessions';
import type { AsideExchange } from '@shared/provider-kit/sessions';
import { type AcceptedPrompt, type AcceptedSteer, type ConversationStore, type InteractionChange, type NewInteraction, type NewItem, type ReservedPlace, StorageFailure, type StoredGrant, type StoredItem, turnView } from '../conversations/store';
import { errorKind } from '../storage/error-kind';
import type { ChatPresentationProjector } from '../avatars/chat-presentation';

export type ChatStoreAccess = Pick<
  ConversationStore,
  | 'status' | 'acceptPrompt' | 'providerTook' | 'setReference' | 'setProviderItemId' | 'addItem' | 'reserveItem' | 'saveProgress' | 'completeItem'
  | 'providerEnded' | 'sessionEnded' | 'markGap' | 'conversation' | 'turn' | 'newestPage' | 'pageBefore' | 'window'
  | 'addActivity' | 'endActivity' | 'settleActivities' | 'workerItems' | 'workerItem' | 'workers' | 'asides' | 'aside'
  | 'addInteraction' | 'setInteraction' | 'settlePending' | 'passGonePast' | 'item' | 'createConversation' | 'setMode' | 'grants'
  | 'addPlan' | 'bringPlan' | 'setPlanFeedback' | 'acceptSteer' | 'setDelivery' | 'moveToTurn'
>;

/**
 * What the chat asks of the request registry (M21, C61, C73, C76): whether an item's request is
 * pending on this run, and the session's workers' pending items. An answered request is neither.
 * And a pending approval's request, whole (M22, C79): what its live card shows.
 */
export interface PendingRequests {
  pending(sessionId: string, itemId: string): boolean;
  waiting(sessionId: string): readonly WaitingQuestion[];
  view?(sessionId: string, itemId: string): ApprovalRequest | null;
}

/** An approval at its raising (M22, C77): where it stands, whose it is, and the request as its adapter read it, whole. */
export interface RaisedApproval {
  readonly turnId: string;
  readonly workerId: string | null;
  /** The provider's id of what carried it, which the action's own activity shares (C14). */
  readonly providerItemId: string;
  readonly request: ApprovalRequest;
}

/** The three outcomes a decision writes: what a later write of that decision finds it under. */
const DECIDED = ['approved', 'approved-session', 'denied'] as const;
/** And a plan's decision's three (M22b, C11): what the CLI's word for its request finds it under. */
const PLAN_DECIDED = ['feedback', 'executed', 'cancelled'] as const;

/** A blocking question at its raising (M21, C33): where it stands, whose it is, and its questions as the card draws them. */
export interface RaisedQuestion {
  readonly turnId: string;
  readonly workerId: string | null;
  /** The provider's id of what carried it (C6). */
  readonly providerItemId: string;
  readonly questions: readonly InteractionQuestion[];
  readonly cut: boolean;
}

export interface ChatTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Why a delta was not taken (M19, C6, C23): a kind, counted, and never what it held. */
export const DELTA_DROPS = [
  /** Its message had reached its bound. */
  'bound',
  /** Its turn is not the one in flight. */
  'turn-ended',
  /** Its message is complete. */
  'complete',
  /** Its message could not be opened: no turn holds it, or too many are open. */
  'unopened',
] as const;
export type DeltaDrop = (typeof DELTA_DROPS)[number];

/** How many messages a session may have open at once, its workers' among them: a provider writes one at a time. */
export const MAX_OPEN_MESSAGES = 16;

/** Why an activity's event was not taken (M20a, C34): a kind, counted, and never what it held. */
export const ACTIVITY_DROPS = [
  /** A start of the session's own for a turn that is not the one in flight. */
  'turn-ended',
  /** Its turn is none of the conversation's. */
  'no-turn',
  /** An end for an item no start opened. */
  'unopened',
] as const;
export type ActivityDrop = (typeof ACTIVITY_DROPS)[number];

/** How many activities a session may have open at once. One past it is kept all the same, and reads unfinished until its end. */
export const MAX_OPEN_ACTIVITIES = 1024;

/** What the diagnostics may read of the activity (M20a, C34): how many of each type, how many were cut, and how many events were not taken, by kind. */
export interface ActivityCounts {
  readonly started: Readonly<Record<ActivityType, number>>;
  readonly cut: number;
  readonly dropped: Readonly<Record<ActivityDrop, number>>;
}

/** An activity's start, as the chat takes it: the provider's id for it, whose it is, and what the start said. */
export interface StartedActivity {
  readonly itemId: string;
  readonly workerId: string | null;
  readonly start: ActivityStart;
  readonly providerAt: number | null;
}

/** An activity's end: `durationMs` is the provider's own, or null where it gave none. */
export interface EndedActivity {
  readonly itemId: string;
  readonly workerId: string | null;
  readonly end: Omit<ActivityEnd, 'duration'>;
  readonly providerAt: number | null;
  readonly durationMs: number | null;
  /** Its start frame never came (C7): no duration of main's own is measured for it. Left out, one is. */
  readonly untimed?: boolean;
}

export interface ChatServiceOptions {
  /** A newly saved nonblocking question in the live turn, never a history read. */
  readonly onQuestion?: (sessionId: string, itemId: string) => void;
  readonly store: ChatStoreAccess;
  readonly presentation?: ChatPresentationProjector;
  /** Counts and kinds only (C24): never a text, a detail or a name. */
  readonly log?: Pick<Console, 'warn'>;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly timers?: ChatTimers;
  /** A clock that only goes forward, in milliseconds (M20a, C35): what an activity's own duration is measured on. */
  readonly monotonic?: () => number;
  /** The partial push's interval (M19, C25), and the progress write's (C16). */
  readonly pushMs?: number;
  readonly progressMs?: number;
  /** The request registry's word on what waits (M21, C61). Without it nothing reads pending. */
  readonly requests?: PendingRequests;
  /**
   * The key of a session's live process, or null where it has none (M22, C81): the runtime's word,
   * by which a grant reads live. Without it every grant reads ended.
   */
  readonly processKey?: (sessionId: string) => string | null;
}

export interface ChatService {
  /** Makes the session's entry if it has none: `history` is its state then. */
  ensure(sessionId: string, history: HistoryState): void;
  has(sessionId: string): boolean;
  /** The session is no longer listed: its entry goes. What the store holds stays until a removal deletes it (C30). */
  drop(sessionId: string): void;
  /** Told of every change, as the push it is (M15, C55). */
  subscribe(listener: (push: ChatPush) => void): () => void;

  /**
   * The newest page, or the window the page holds (C60). `started`: the record says the provider's
   * session exists, so a conversation the store does not have is missing its earlier part (C18).
   * Whether the session can be asked beside is the runtime's to say: this answers `none` (M20b, C48).
   */
  read(sessionId: string, window: { readonly from: string; readonly keep: 'newest' | 'oldest' } | null, started: boolean): ChatRead | null;
  page(sessionId: string, before: string): ChatPageResult | null;
  /** A worker's items (M20a, C32): its newest window, or the page before a cursor. Null for a session with no entry. */
  readWorker(sessionId: string, workerId: string, before?: string): ChatWorkerReadResult | null;

  // ── Asides (M20b, C28, C31, C34) ──
  /**
   * Makes an aside's entry if it has none: `sessionId` is the session it is asked beside. Every
   * write of the aside's conversation then goes by the aside's id, as a session's goes by its own.
   */
  ensureAside(asideId: string, sessionId: string): void;
  /** An aside's conversation (C31): its newest page, or the page before a cursor, with the aside itself. Null for a session with no entry. */
  readAside(sessionId: string, asideId: string, before?: string): ChatAsideReadResult | null;
  /** The session's aside that was asked about this same selection — the same source, lines and text (C50) — or null. */
  findAside(sessionId: string, source: AsideSource): string | null;
  /** An aside's earlier exchanges, oldest first (C13, C22): each question as it was sent, with the answer it got. One with no answer is left out. */
  exchanges(asideId: string): readonly AsideExchange[];

  history(sessionId: string): HistoryState | null;
  setHistory(sessionId: string, state: HistoryState, olderUnread?: boolean): void;
  /** Something other than a new item at the end changed: an import, a turn's state, an item's id. */
  changed(sessionId: string): void;
  /** The composer's state changed by main's doing (M23, C57, C86): pushed whole, under the session's next revision. */
  pushComposer(sessionId: string, composer: ChatComposer): void;
  /** A write of the session's draft or queue failed (M23, C34): its chat reads `failing` for the run, as after any failed write. */
  markFailing(sessionId: string): void;

  // ── A turn, written through (Design 4) ──
  /**
   * The accepted prompt's record (C15, C44). False when it could not be written: nothing may be
   * sent. `aside` (M20b, C28): the conversation is an aside's, made with this question where it is
   * new. `own` (M20b, C35): fat-g answers the prompt itself.
   */
  accept(sessionId: string, prompt: { readonly turnId: string; readonly itemId: string; readonly text: string; readonly at: number; readonly started: boolean } & Pick<AcceptedPrompt, 'aside' | 'own' | 'mode' | 'plan' | 'fields' | 'speed'>): boolean;
  /**
   * A prompt that is an input of the composer's (M23, C21, C56, C86): accepted as any is, and in the
   * same transaction the draft or the queued message consumed, its images the prompt's. `draft-changed`:
   * the images named are not the draft's; `not-queued`: the queued message is gone. Nothing was written.
   */
  acceptInput(sessionId: string, prompt: { readonly turnId: string; readonly itemId: string; readonly text: string; readonly at: number; readonly started: boolean } & Required<Pick<AcceptedPrompt, 'from'>> & Pick<AcceptedPrompt, 'own' | 'mode' | 'plan' | 'fields' | 'speed'>): 'accepted' | 'draft-changed' | 'not-queued' | 'storage-failed';
  /**
   * A prompt that carries out a plan's decision (M22b, C12, C15, C65): accepted as any is, and in
   * the same transaction its line checked — still `pending` — and decided. `not-pending`: the line
   * was decided, withdrawn or removed meanwhile, and nothing was written.
   */
  acceptDecision(sessionId: string, prompt: { readonly turnId: string; readonly itemId: string; readonly text: string; readonly at: number; readonly started: boolean } & Required<Pick<AcceptedPrompt, 'deciding'>> & Pick<AcceptedPrompt, 'mode' | 'plan' | 'fields' | 'speed'>): 'accepted' | 'not-pending' | 'storage-failed';
  /**
   * A prompt that answers an async question's card (M21, C26, C77): the prompt's record, the card's
   * `answered` with its answers and the turn the prompt starts, and the `passed` of every other open
   * card, in one transaction. `not-pending`: the card was dismissed or passed meanwhile — nothing was
   * written, and nothing may be sent. `storage-failed`: it could not be written.
   */
  acceptAnswer(sessionId: string, prompt: { readonly turnId: string; readonly itemId: string; readonly text: string; readonly at: number; readonly started: boolean } & Required<Pick<AcceptedPrompt, 'answering'>> & Pick<AcceptedPrompt, 'mode' | 'plan' | 'fields' | 'speed'>): 'accepted' | 'not-pending' | 'storage-failed';
  /**
   * A message sent into the running turn (M23, C38, C45, C46): written at that turn's next place with
   * its delivery `sent`, its input consumed and its card answered in one transaction, then pushed.
   * `turn-over`: the turn has its provider's end; `draft-changed`, `not-queued`, `not-pending` as a
   * prompt's. Nothing was written for any refusal.
   */
  acceptSteer(sessionId: string, steer: Omit<AcceptedSteer, 'conversationId'>): 'accepted' | 'turn-over' | 'draft-changed' | 'not-queued' | 'not-pending' | 'storage-failed';
  /** A message's delivery (M23, C38–C44), written and pushed: false where it could not be written. */
  setDelivery(sessionId: string, itemId: string, delivery: DeliveryView): boolean;
  /**
   * A message handed into a turn, moved to the turn it became (M23, C39, C42): that turn is the live
   * one from here, and the page reads the chat again. False where it could not be written.
   */
  movedToTurn(sessionId: string, itemId: string, turnId: string, at: number, speed?: AcceptedPrompt['speed']): boolean;
  /**
   * A new session's conversation, with the chat's mode as the hierarchy gives it then (M22, C40):
   * the snapshot. False where it could not be written — the mode is then snapshotted with the
   * session's first prompt.
   */
  created(sessionId: string, at: number, mode: ChatMode | null): boolean;
  /** The chat's saved mode, as the store holds it (M22, C40); null where it holds none, or cannot say. */
  mode(sessionId: string): ChatMode | null;
  /**
   * The chat's mode, chosen in the chat (M22, C40, C75): written, and told as a change. False where
   * the write failed: nothing changed.
   */
  setMode(sessionId: string, mode: string, started: boolean): boolean;
  /** How many of the session's grants were sent to the process of this key (M22, C81): what its end ends. */
  grantsOn(sessionId: string, processKey: string): number;
  took(sessionId: string, turnId: string, providerTurnId: string | null): void;
  reference(sessionId: string, reference: string, folder: string, configFolder: string | null): void;
  /** The provider's echo of the user's own message: it adds none, and gives the stored one its id (M15, C56). */
  echo(sessionId: string, itemId: string, providerItemId: string): void;
  /**
   * More of a message as it is written (M19, C3, C14): `itemId` is the provider's id for it. The
   * first one for an id opens its message; one for a turn that is not in flight, for a message that
   * is complete or past its bound, is dropped and counted (C6). `workerId`: whose message it is,
   * when it is a worker's (M20a, C20) — taken whether or not its turn is still in flight.
   */
  delta(sessionId: string, turnId: string, delta: { readonly itemId: string; readonly phase: MessagePhase | null; readonly text: string; readonly workerId?: string | null }): void;
  /**
   * One item, at the end of the turn named, or of the newest. A message whose deltas opened it is
   * completed by it, where it stands (M19, C4, C17): its id, its place and its time are the ones its
   * opening fixed. `card` (M21, C33): the session's provider asks questions in its messages, so a
   * message of the session's own that carries questions gets its card, an item written with it in
   * one transaction and pushed after it. A whole assistant message with no text and no questions
   * makes no item (M21, C56, C69): one its deltas opened is closed unwritten, as a message its
   * turn's end left without text is.
   */
  add(sessionId: string, turnId: string | null, item: NewItem, card?: boolean): void;

  // ── What a session asks (M21, C33–C35) ──
  /**
   * A blocking question is raised (C33): written in a transaction of its own, and pushed pending.
   * Its item's id, or null where it could not be kept — a card that cannot be kept cannot be shown —
   * or where its turn already holds one for the same source. `kept` is told the item's id once it is
   * written and before it is pushed: the registry makes its entry there, so that a read made from
   * inside the push already finds the request pending (C76).
   */
  raise(sessionId: string, question: RaisedQuestion, kept?: (itemId: string) => void): string | null;
  /**
   * An approval is raised (M22, C77, C79): written in a transaction of its own with its detail cut,
   * and pushed pending with the request whole. Its item's id, or null where it could not be kept.
   * `kept` as `raise` has it: the registry's entry is made there, and the push lays its view over.
   */
  raiseApproval(sessionId: string, approval: RaisedApproval, kept?: (itemId: string) => void): string | null;
  /**
   * A plan's line at the end of its turn (M22b, C10, C14, C17): written and pushed at once, as a
   * card is, `kept` told its id between the two (M21, C76). Null where it could not be written.
   */
  addPlan(sessionId: string, turnId: string, plan: { readonly providerItemId: string | null; readonly body: PlanBody }, kept?: (itemId: string) => void): string | null;
  /**
   * A plan's line, its named keys written where its outcome is one of `from` (C12, C56, C74), and
   * pushed. Null where it is not, false where the write failed.
   */
  setPlan(sessionId: string, itemId: string, from: PlanOutcome | readonly PlanOutcome[], change: InteractionChange): boolean | null;
  /**
   * A feedback a plan's request takes (the maintainer): the line's change where it is
   * `pending`, and the feedback as sent, the user's message after it, in one write, and both pushed.
   * Null where the line is not pending, false where the write failed.
   */
  setPlanFeedback(sessionId: string, itemId: string, change: InteractionChange, text: string): boolean | null;
  /** A plan brought into the chat (C64, C76): its line in a turn of fat-g's own at the chat's end, and the push. Null where it could not be written. */
  bringPlan(sessionId: string, at: { readonly turnId: string; readonly at: number; readonly started: boolean }, body: PlanBody): string | null;
  /**
   * A decision (M22, C12, C49): the outcome, when, and the grant sent with it, in one durable write
   * before anything is sent, and pushed. `not-pending`: its row was no longer pending.
   */
  decide(sessionId: string, itemId: string, outcome: ApprovalDecision, grant: StoredGrant | null): 'decided' | 'not-pending' | 'storage-failed';
  /** Whether a decision's reply reached the process (M22, C12, C92): written on the decided item, and pushed. */
  delivered(sessionId: string, itemId: string, went: boolean): void;
  /**
   * A blocking question's answer (C33): written in one durable transaction, before anything is
   * sent, and pushed. `not-pending`: its row was no longer pending, and nothing changed (C77).
   */
  answer(sessionId: string, itemId: string, answers: readonly (InteractionAnswer | null)[]): 'answered' | 'not-pending' | 'storage-failed';
  /** An async card skipped (C9; M100b, C32): the CLI is told nothing. */
  dismiss(sessionId: string, itemId: string): 'dismissed' | 'unknown-item' | 'not-open' | 'storage-failed';
  /**
   * A blocking question skipped (M100b, C31): it reads `dismissed`, written in one durable
   * transaction before the decline is sent, and pushed. `not-pending` as for an answer.
   */
  decline(sessionId: string, itemId: string): 'declined' | 'not-pending' | 'storage-failed';
  /** The CLI confirmed it took the answer (C62): the item's mark, and one push. */
  confirm(sessionId: string, itemId: string): void;
  /** An end's sweep (C12, C33): these items, each still pending, take the outcome, in one write, each pushed. */
  settle(sessionId: string, itemIds: readonly string[], outcome: 'withdrawn' | 'dropped', withdrawnBy?: WithdrawnBy): void;
  /** An answer, or a decline (M100b, C31), its process could not take (C14): the item goes from answered or skipped to dropped, with its push. */
  notTaken(sessionId: string, itemId: string): void;
  /** An interaction item of the session's conversation, as a read would answer it; null for any other id. */
  interaction(sessionId: string, itemId: string): ConversationItem | null;
  /**
   * Something the session, or a worker of it, does began (M20a, C29, C59): written and pushed at
   * once. One for an item that is open replaces what its start said, and opens nothing. The
   * session's own begins in the turn in flight alone; a worker's whenever it comes (C20).
   */
  activityStarted(sessionId: string, turnId: string, activity: StartedActivity): void;
  /**
   * It ended (M20a, C29): an update of its row, and one push. One for an item whose turn has ended
   * still ends it (C6). The end of the item that started a worker ends what was still open of that
   * worker, as unfinished.
   */
  activityEnded(sessionId: string, turnId: string, activity: EndedActivity): void;
  /**
   * The session's process is gone (M20a, C29): every activity still open, a worker's included, is
   * left unfinished with what it has, and every message still open as far as it got.
   */
  lost(sessionId: string): void;
  /**
   * The turn is over. `reported`: the provider's own end, which is stored as such (C54); null for an
   * end the adapter made, which is the session's alone and leaves the turn unfinished (C59).
   * `answerItemId` (M16, C74): the provider's id of the message that is the turn's answer, when the
   * end names one. Its phase is settled in the write that stores the end, and in the copy kept here
   * of an item that could not be saved. `elapsedMs` (M19, C44): the turn's measured time, stored
   * with the end. A message still open is written as far as it got, and stays incomplete (M19, C18).
   * What it leaves of the activities still open is in the header (M20a, C29).
   */
  ended(sessionId: string, turnId: string, reported: { readonly outcome: ReportedOutcome; readonly at: number; readonly answerItemId?: string | null; readonly elapsedMs?: number | null } | null): void;
  /**
   * The turn is over and the items its end came with are in (decision 0026, item 11): its async
   * cards that the model went on past are passed, each pushed as it now is. One that is the turn's
   * last word stays open.
   */
  passGonePast(sessionId: string, turnId: string): void;
  /** The session's end (C45, C54), for a session with a chat or without: the store is told either way. */
  sessionEnded(sessionId: string, turnId: string, at: number, outcome: TurnOutcome): void;
  /**
   * Every open message's text so far is written now (M19, C19): what the quit asks before the store
   * is closed. The messages stay open; a turn that then ends leaves them as any end does. Every open
   * activity is written unfinished (M20a, C29), and stays open here, so that an end which still
   * comes ends it.
   */
  saveOpen(): void;
  /** Deltas not taken, by kind (M19, C23): what the diagnostics may read. */
  dropped(): Readonly<Record<DeltaDrop, number>>;
  /** Activities, by type, with those cut and the events not taken, by kind (M20a, C34). */
  activityCounts(): ActivityCounts;
  /** Every timer is cleared, and nothing more is written or pushed by one. */
  dispose(): void;
}

/** A message being written (M19, C14). */
interface OpenMessage {
  /** fat-g's id for the item and when main took its opening: fixed then. */
  readonly id: string;
  readonly turnId: string;
  readonly providerItemId: string;
  /** Whose it is: null for the session's own (M20a, C20). */
  readonly workerId: string | null;
  readonly receivedAt: number;
  /** Its turn's place and its own, kept for it at its opening; null while the store could not say. */
  place: ReservedPlace | null;
  /** Where it sorts while it has no place. */
  readonly seq: number;
  phase: MessagePhase | null;
  /** Everything received of it, to its bound. */
  text: string;
  /** How much of that the page has been pushed: what a read answers (C26). */
  published: number;
  /** It reached its bound (C6, C64). */
  cut: boolean;
  /** The store has a row of it. */
  stored: boolean;
  /** Its text, or its flag, is not as the store has it. */
  dirty: boolean;
  progressTimer: unknown;
}

/** An activity whose end has not come (M20a, C29): what makes it read `running`. */
interface OpenActivity {
  readonly key: string;
  /** fat-g's id for the item. */
  readonly id: string;
  readonly turnId: string;
  readonly providerItemId: string;
  /** Whose it is: null for the session's own. */
  readonly workerId: string | null;
  type: ActivityType;
  /** A worker item's worker, once one is paired with it (C23). */
  paired: string | null;
  /** The monotonic clock's reading when main took its start (C35). */
  readonly startedAt: number;
  /** The item as it is kept here, for one the store did not take (M18, C19); null for one it holds. */
  unsaved: ConversationItem | null;
}

interface Entry {
  /** The session an aside's conversation is asked beside (M20b, C28): its pushes go out under that session's id and revision. Null for a session's own. */
  readonly parent: string | null;
  revision: number;
  history: HistoryState;
  olderUnread: boolean;
  /** The turn in flight: it reads `running`. */
  live: string | null;
  /** The messages being written, by the provider's id for each (M19, C14). */
  open: Map<string, OpenMessage>;
  /** The provider's ids of the live turn's messages that are complete, or could not be opened: their deltas are dropped (C6). */
  done: Map<string, DeltaDrop>;
  /** The activities whose end has not come, by turn, owner and the provider's id (M20a, C29), and the same by fat-g's id. */
  activities: Map<string, OpenActivity>;
  activityIds: Map<string, OpenActivity>;
  /** The gathered text is pushed when this fires (C25). */
  pushTimer: unknown;
  /** What could not be saved, oldest first (C19): laid over what the store answers, by id (M19, C21). */
  unsaved: ConversationItem[];
  unsavedSeq: number;
  /** Turns of which something was lost, whose gap the store does not hold yet. */
  gaps: Set<string>;
  /** Something of this session could not be saved in this run. */
  failing: boolean;
}

/** A turn the store could not be read for: what is known without it. */
const unreadTurn = (id: string, live: boolean): ConversationTurn => ({
  id, place: Number.MAX_SAFE_INTEGER, origin: 'local', state: live ? 'running' : 'unfinished', outcome: null, gap: true, mode: null,
  time: { acceptedAt: null, providerStartedAt: null, providerEndedAt: null, endReceivedAt: null, providerDurationMs: null, elapsedMs: null },
});

const defaultTimers: ChatTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

const activityKey = (turnId: string, workerId: string | null, providerItemId: string): string => `${workerId ?? ''}\u0000${turnId}\u0000${providerItemId}`;
/** What an end leaves of an open activity (C29): a checklist, which no frame ends, is completed; any other is unfinished. */
const leftAs = (type: ActivityType): 'completed' | 'unfinished' => (type === 'checklist' ? 'completed' : 'unfinished');

export function createChatService(options: ChatServiceOptions): ChatService {
  const { store, log = console } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const timers = options.timers ?? defaultTimers;
  const pushMs = options.pushMs ?? PARTIAL_PUSH_MS;
  const progressMs = options.progressMs ?? PROGRESS_WRITE_MS;
  const monotonic = options.monotonic ?? (() => performance.now());
  const { requests } = options;
  const entries = new Map<string, Entry>();
  const listeners = new Set<(push: ChatPush) => void>();
  const drops: Record<DeltaDrop, number> = { bound: 0, 'turn-ended': 0, complete: 0, unopened: 0 };
  const started = Object.fromEntries(ACTIVITY_TYPES.map((type) => [type, 0])) as Record<ActivityType, number>;
  const activityDrops: Record<ActivityDrop, number> = { 'turn-ended': 0, 'no-turn': 0, unopened: 0 };
  let cutActivities = 0;
  let failures = 0;

  function tell(push: ChatPush): void {
    const shown = 'item' in push ? { ...push, ...presentation(push.sessionId, [push.item]) } : push;
    for (const listener of [...listeners]) {
      try { listener(shown); } catch { /* a listener's failure is its own */ }
    }
  }
  const presentation = (sessionId: string, items: readonly ConversationItem[], worker?: { readonly id: string; readonly item: ConversationItem | null }) => {
    const value = options.presentation?.project(sessionId, items, worker);
    return value === undefined ? {} : { presentation: value };
  };
  const stopPresentation = options.presentation?.subscribe((sessionId, value) => {
    tell({ sessionId, revision: entries.get(sessionId)?.revision ?? 0, presentationOnly: true, presentation: value });
  });
  /**
   * Who a change of this entry is told as (M20b, C73): a session's own raises its revision; an
   * aside's raises its session's, and names the aside. Null for an aside whose session has no entry
   * any more: no window holds it.
   */
  function head(id: string, entry: Entry): { readonly sessionId: string; readonly revision: number; readonly asideId?: string } | null {
    if (entry.parent === null) { entry.revision += 1; return { sessionId: id, revision: entry.revision }; }
    const parent = entries.get(entry.parent);
    if (parent === undefined) return null;
    parent.revision += 1;
    return { sessionId: entry.parent, revision: parent.revision, asideId: id };
  }
  /** The revision a read of this entry answers with: its own, or its session's. */
  const revisionOf = (entry: Entry): number => (entry.parent === null ? entry.revision : entries.get(entry.parent)?.revision ?? 0);
  const changed = (sessionId: string, entry: Entry): void => {
    const to = head(sessionId, entry);
    if (to !== null) tell({ ...to, changed: true });
  };
  /** A worker's item names its worker (M20a, C32): the list takes its revision alone, and the worker's tab applies it. */
  const pushItem = (sessionId: string, entry: Entry, item: ConversationItem, turn: ConversationTurn): void => {
    const to = head(sessionId, entry);
    if (to !== null) tell({ ...to, item, turn, ...(item.workerId === null ? {} : { workerId: item.workerId }) });
  };

  /** The first, the tenth, the hundredth: by kind, never by what was being written. */
  function failed(error: unknown): void {
    failures += 1;
    if (/^10*$/.test(String(failures))) log.warn(`[chat] a write could not be saved (${errorKind(error)}), ${failures} so far`);
  }

  /** A delta not taken: counted by kind, and never what it held (C23). */
  function dropDelta(kind: DeltaDrop): void {
    drops[kind] += 1;
    if (/^10*$/.test(String(drops[kind]))) log.warn(`[chat] a delta was dropped (${kind}), ${drops[kind]} so far`);
  }

  /** An activity's event not taken: counted by kind, and never what it held (M20a, C34). */
  function dropActivity(kind: ActivityDrop): void {
    activityDrops[kind] += 1;
    if (/^10*$/.test(String(activityDrops[kind]))) log.warn(`[chat] an activity's event was dropped (${kind}), ${activityDrops[kind]} so far`);
  }

  /** An activity that was cut to its bounds: counted (M20a, C34). */
  function countCut(body: ActivityBody | null, before: ActivityBody | null = null): void {
    if (body === null || body.cut === null || before?.cut != null) return;
    cutActivities += 1;
    if (/^10*$/.test(String(cutActivities))) log.warn(`[chat] an activity was cut to its bounds, ${cutActivities} so far`);
  }

  /** A write succeeded: the gaps still owed are written now (C19). */
  function settleGaps(sessionId: string, entry: Entry): void {
    for (const turnId of [...entry.gaps]) {
      try { store.markGap(sessionId, turnId); entry.gaps.delete(turnId); } catch { return; }
    }
  }

  /** One write of a turn under way. False when it failed: the session is failing, and the turn has a gap. */
  function write(sessionId: string, entry: Entry, turnId: string | null, work: () => void): boolean {
    try {
      work();
    } catch (error) {
      failed(error);
      entry.failing = true;
      if (turnId !== null) entry.gaps.add(turnId);
      return false;
    }
    settleGaps(sessionId, entry);
    return true;
  }

  const view = (entry: Entry) => (turn: Parameters<typeof turnView>[0]): ConversationTurn => {
    const shown = turnView(turn, turn.id === entry.live);
    return entry.gaps.has(turn.id) ? { ...shown, gap: true } : shown;
  };

  /** The turn of an item the store did not take, as far as it can be read. */
  function turnOfUnsaved(sessionId: string, entry: Entry, turnId: string): ConversationTurn {
    try {
      const stored = store.turn(sessionId, turnId);
      if (stored !== null) return { ...turnView(stored, turnId === entry.live), gap: true };
    } catch { /* the store cannot be read either */ }
    return unreadTurn(turnId, turnId === entry.live);
  }

  /** A turn as it now is, for a push: with its gap where one is owed, and without the store where it cannot be read. */
  function turnNow(sessionId: string, entry: Entry, turnId: string): ConversationTurn {
    try {
      const stored = store.turn(sessionId, turnId);
      if (stored !== null) return view(entry)(stored);
    } catch { /* the store cannot be read either */ }
    return unreadTurn(turnId, turnId === entry.live);
  }

  /** What could not be saved is kept for the run: one of each id, the latest, and 200 a session at most (C19; M19, C21). */
  function hold(entry: Entry, item: ConversationItem): void {
    const at = entry.unsaved.findIndex((held) => held.id === item.id);
    if (at === -1) entry.unsaved.push(item); else entry.unsaved[at] = item;
    if (entry.unsaved.length > MAX_UNSAVED_ITEMS) entry.unsaved.splice(0, entry.unsaved.length - MAX_UNSAVED_ITEMS);
  }

  /** Kept, and pushed as usual. */
  function keep(sessionId: string, entry: Entry, item: ConversationItem): void {
    hold(entry, item);
    pushItem(sessionId, entry, item, turnOfUnsaved(sessionId, entry, item.turnId));
  }

  function keepUnsaved(sessionId: string, entry: Entry, turnId: string | null, item: NewItem): void {
    const owner = turnId ?? entry.live ?? '';
    // What the turn already holds by the provider's id is not added twice, here either (C20).
    if (item.providerItemId !== null && entry.unsaved.some((held) => held.turnId === owner && held.providerItemId === item.providerItemId)) return;
    const text = cutTo(item.text, MAX_MESSAGE_TEXT);
    entry.unsavedSeq += 1;
    keep(sessionId, entry, {
      id: item.id, conversationId: sessionId, turnId: owner, order: { turn: Number.MAX_SAFE_INTEGER, item: entry.unsavedSeq }, kind: item.kind, origin: item.origin,
      providerItemId: item.providerItemId, workerId: item.workerId ?? null, activity: null, interaction: null, role: item.role, phase: item.phase, model: item.model ?? null, state: item.complete === false ? 'partial' : 'complete', blocks: [{ type: 'text', text: text.text, cut: item.cut || text.cut }], questions: item.questions,
      notice: item.notice, detail: item.detail, time: { receivedAt: item.receivedAt, providerAt: item.providerAt },
    });
  }

  // ── Messages being written (M19, Design 4, 5) ─────────────────────────────────────────────

  /** An open message as the page is shown it: with `text`, which is what it has been pushed, or all of it. */
  function shown(sessionId: string, message: OpenMessage, state: ConversationItem['state'], text: string = message.text): ConversationItem {
    return {
      id: message.id, conversationId: sessionId, turnId: message.turnId, order: message.place?.order ?? { turn: Number.MAX_SAFE_INTEGER, item: message.seq }, kind: 'message', origin: 'local',
      providerItemId: message.providerItemId, workerId: message.workerId, activity: null, interaction: null, role: 'assistant', phase: message.phase, model: null, state, blocks: [{ type: 'text', text, cut: message.cut }], questions: [],
      notice: null, detail: null, time: { receivedAt: message.receivedAt, providerAt: null },
    };
  }

  /** An open message as the store takes it: as far as it got, and incomplete. */
  const written = (message: OpenMessage): NewItem => ({
    id: message.id, kind: 'message', origin: 'local', providerItemId: message.providerItemId, role: 'assistant', phase: message.phase, text: message.text, cut: message.cut,
    questions: [], notice: null, detail: null, receivedAt: message.receivedAt, providerAt: null, complete: false, workerId: message.workerId,
  });

  /** The place kept for it, asked for again where the store could not say at its opening. Throws as the store does. */
  function placeOf(sessionId: string, message: OpenMessage): ReservedPlace {
    message.place ??= store.reserveItem(sessionId, message.turnId);
    return message.place;
  }

  /**
   * The text so far, and its cut flag, to the store (C16, C64): the item's insert where it has no
   * row, at the place kept for it. Each write is attempted on its own, with the latest text (C21).
   */
  function saveProgress(sessionId: string, entry: Entry, message: OpenMessage): boolean {
    const saved = write(sessionId, entry, message.turnId, () => store.saveProgress(sessionId, placeOf(sessionId, message), written(message)));
    if (saved) { message.stored = true; message.dirty = false; }
    return saved;
  }

  function armProgress(sessionId: string, entry: Entry, message: OpenMessage): void {
    if (message.progressTimer !== undefined) return;
    message.progressTimer = timers.set(() => {
      message.progressTimer = undefined;
      if (entry.open.get(message.providerItemId) === message && message.dirty) saveProgress(sessionId, entry, message);
    }, progressMs);
  }

  /** One partial push, of what one message gathered (C24, C25). A second message with text waits for the next. */
  function pushGathered(sessionId: string, entry: Entry): void {
    entry.pushTimer = undefined;
    let pushed = false;
    for (const message of entry.open.values()) {
      if (message.published >= message.text.length) continue;
      if (pushed) { armPush(sessionId, entry); return; }
      const before = message.published;
      message.published = message.text.length;
      const to = head(sessionId, entry);
      if (to !== null) tell({ ...to, partial: { itemId: message.id, before, append: message.text.slice(before) }, ...(message.workerId === null ? {} : { workerId: message.workerId }) });
      pushed = true;
    }
  }

  function armPush(sessionId: string, entry: Entry): void {
    if (entry.pushTimer !== undefined) return;
    entry.pushTimer = timers.set(() => pushGathered(sessionId, entry), pushMs);
  }

  /** The message is no longer open: its timer goes, and a later delta for it is dropped as `after` says. */
  function close(entry: Entry, message: OpenMessage, after: DeltaDrop): void {
    timers.clear(message.progressTimer);
    message.progressTimer = undefined;
    entry.open.delete(message.providerItemId);
    entry.done.set(message.providerItemId, after);
  }

  /** The first delta for an id (C3, C14): its id, its time and its place are fixed, and it is pushed at once, empty. */
  function open(sessionId: string, entry: Entry, turnId: string, providerItemId: string, phase: MessagePhase | null, workerId: string | null): OpenMessage | null {
    if (entry.open.size >= MAX_OPEN_MESSAGES) return null;
    let place: ReservedPlace | null = null;
    try {
      place = store.reserveItem(sessionId, turnId);
    } catch (error) {
      // A message for a turn the conversation does not have is no part of it, as an item is.
      if (error instanceof StorageFailure && error.kind === 'no-turn') return null;
      // The store could not say: the message is held here, and its place asked for again at its first write.
      failed(error);
      entry.failing = true;
      entry.gaps.add(turnId);
    }
    entry.unsavedSeq += 1;
    const message: OpenMessage = { id: newId(), turnId, providerItemId, workerId, receivedAt: now(), place, seq: entry.unsavedSeq, phase, text: '', published: 0, cut: false, stored: false, dirty: false, progressTimer: undefined };
    entry.open.set(providerItemId, message);
    pushItem(sessionId, entry, shown(sessionId, message, 'streaming'), turnNow(sessionId, entry, turnId));
    return message;
  }

  /** The message as it now is, as an item, at once: at its bound (C64). What was gathered goes with it. */
  function pushWhole(sessionId: string, entry: Entry, message: OpenMessage): void {
    message.published = message.text.length;
    pushItem(sessionId, entry, shown(sessionId, message, 'streaming'), turnNow(sessionId, entry, message.turnId));
  }

  /**
   * The card of a question a message carries (M21, C33): for a whole message of the session's own —
   * no worker's, no aside's — that carries questions, where its provider asks in its messages.
   */
  function questionShown(sessionId: string, entry: Entry, item: ConversationItem | null): void {
    if (entry.parent === null && item?.origin === 'local' && item.interaction?.kind === 'question'
      && item.interaction.mode === 'async' && item.interaction.outcome === 'open') options.onQuestion?.(sessionId, item.id);
  }

  function askingOf(entry: Entry, item: NewItem, card: boolean): NewInteraction | undefined {
    if (!card || entry.parent !== null || item.kind !== 'message' || item.role !== 'assistant' || item.providerItemId === null || (item.workerId ?? null) !== null || item.questions.length === 0) return undefined;
    const asked = fromMessageQuestions(item.questions, item.cut);
    return { id: newId(), origin: 'local', providerItemId: item.providerItemId, workerId: null, mode: 'async', questions: asked.questions, cut: asked.cut, receivedAt: now(), providerAt: null };
  }

  /** A whole assistant message with no text and no questions: nothing to keep, and nothing to draw (M21, C56, C69). */
  const isEmptyWhole = (item: NewItem): boolean => item.kind === 'message' && item.role === 'assistant' && item.text === '' && item.questions.length === 0;

  /** The whole message (C4, C17): one write, one push, and the text the provider gave in place of what the deltas brought. */
  function complete(sessionId: string, entry: Entry, message: OpenMessage, whole: NewItem, card: boolean): void {
    close(entry, message, 'complete');
    const item: NewItem = { ...whole, id: message.id, receivedAt: message.receivedAt, complete: true };
    let stored: ReturnType<ChatStoreAccess['completeItem']>;
    try {
      stored = store.completeItem(sessionId, placeOf(sessionId, message), item, askingOf(entry, item, card));
    } catch (error) {
      failed(error);
      entry.failing = true;
      entry.gaps.add(message.turnId);
      // The whole text stays readable for the run, in place of whatever the store has of it (C21).
      const text = cutTo(whole.text, MAX_MESSAGE_TEXT);
      keep(sessionId, entry, { ...shown(sessionId, message, 'complete', text.text), phase: whole.phase, blocks: [{ type: 'text', text: text.text, cut: whole.cut || text.cut }], questions: whole.questions });
      return;
    }
    settleGaps(sessionId, entry);
    entry.unsaved = entry.unsaved.filter((held) => held.id !== message.id);
    pushItem(sessionId, entry, stored.item, view(entry)(stored.turn));
    if (stored.interaction !== null) {
      pushItem(sessionId, entry, stored.interaction, view(entry)(stored.turn));
      questionShown(sessionId, entry, stored.interaction);
    }
  }

  /**
   * Its turn ended while it was open (C18): what was received is written, with its cut flag, and
   * the message stays incomplete. Nothing is erased, and no text is invented: one with no text is
   * no message.
   */
  function leave(sessionId: string, entry: Entry, message: OpenMessage): void {
    close(entry, message, 'turn-ended');
    if (message.text === '') return;
    // Not saved: it stays readable for the run as it is, partial, and the push that follows the end shows it (C21).
    if ((message.dirty || !message.stored) && !saveProgress(sessionId, entry, message)) hold(entry, shown(sessionId, message, 'partial'));
  }

  // ── What a session does (M20a, Design 6, 7) ───────────────────────────────────────────────

  /** An activity held open here reads `running` (C29): the store, which knows nothing that runs, says unfinished. */
  const running = (item: ConversationItem): ConversationItem => (item.activity === null ? item : { ...item, state: 'streaming', activity: { ...item.activity, status: 'running' } });
  /**
   * A question whose request lives reads `pending` (M21, C61): the store, which knows no request,
   * says dropped. So does an approval's (M22, C79), with its request whole from the registry in
   * place of the store's cut copy: the live card shows the action as it is.
   */
  function waiting(sessionId: string, item: ConversationItem): ConversationItem {
    const body = item.interaction;
    if (body === null) return item;
    const pending: InteractionBody = body.kind === 'approval'
      ? { ...body, outcome: 'pending', settledAt: null, withdrawnBy: null, request: requests?.view?.(sessionId, item.id) ?? body.request }
      : { ...body, outcome: 'pending', settledAt: null, withdrawnBy: null };
    return { ...item, interaction: pending };
  }
  /** Only while the registry holds its request pending (C76): an answered one, kept there until its mark, changes no read. */
  const isWaiting = (sessionId: string, item: ConversationItem): boolean => item.kind === 'interaction' && item.interaction !== null && heldByRequest(item.interaction) && item.interaction.outcome === 'dropped' && requests?.pending(sessionId, item.id) === true;
  /** A grant reads live while the process it was sent to is the session's (M22, C81): an aside's entry answers for its session. */
  function withGrant(sessionId: string, entry: Entry, item: ConversationItem): ConversationItem {
    const body = item.interaction;
    if (body === null || body.kind !== 'approval' || body.grant === null) return item;
    const live = body.grant.processKey === (options.processKey?.(entry.parent ?? sessionId) ?? null);
    return live === body.grant.live ? item : { ...item, interaction: { ...body, grant: { ...body.grant, live } } };
  }
  const asHeld = (sessionId: string, entry: Entry, item: ConversationItem): ConversationItem => (item.kind === 'activity' ? (entry.activityIds.has(item.id) ? running(item) : item) : item.kind !== 'interaction' ? item : withGrant(sessionId, entry, isWaiting(sessionId, item) ? waiting(sessionId, item) : item));

  function track(entry: Entry, activity: OpenActivity): void {
    entry.activities.set(activity.key, activity);
    entry.activityIds.set(activity.id, activity);
  }

  function untrack(entry: Entry, activity: OpenActivity): void {
    entry.activities.delete(activity.key);
    entry.activityIds.delete(activity.id);
  }

  /**
   * What an end leaves of these open activities (C29): each unfinished with what it has, a
   * checklist completed. `stay`: they are still open here afterwards, as at a quit, where an end
   * that still comes ends them. Answers whether there was any.
   */
  function settle(sessionId: string, entry: Entry, list: readonly OpenActivity[], stay = false): boolean {
    if (list.length === 0) return false;
    const stored: { id: string; status: 'unfinished' | 'completed' }[] = [];
    for (const activity of list) {
      const status = leftAs(activity.type);
      if (!stay) untrack(entry, activity);
      if (activity.unsaved === null) { stored.push({ id: activity.id, status }); continue; }
      if (stay || activity.unsaved.activity === null) continue;
      // Kept here, as the store did not take it: it reads as the end leaves it, for the run.
      hold(entry, { ...activity.unsaved, state: status === 'completed' ? 'complete' : 'partial', activity: { ...activity.unsaved.activity, status } });
    }
    if (stored.length > 0) write(sessionId, entry, null, () => store.settleActivities(sessionId, stored));
    return true;
  }

  /** The worker has ended (C29): what was still open of it is left as it is — its messages as far as they got, its activities unfinished. */
  function closeWorker(sessionId: string, entry: Entry, workerId: string): void {
    const messages = [...entry.open.values()].filter((message) => message.workerId === workerId);
    for (const message of messages) leave(sessionId, entry, message);
    const left = settle(sessionId, entry, [...entry.activities.values()].filter((activity) => activity.workerId === workerId));
    if (left || messages.length > 0) changed(sessionId, entry);
  }

  /** Everything of the session that is open, its workers' included, is left as it is (C29): an end the adapter made, or a lost process. */
  function closeAll(sessionId: string, entry: Entry): boolean {
    const messages = [...entry.open.values()];
    for (const message of messages) leave(sessionId, entry, message);
    return settle(sessionId, entry, [...entry.activities.values()]) || messages.length > 0;
  }

  /**
   * What is held here laid over what the store answered, by id (C21, C26): a message being written
   * reads `streaming`, with the text the page has been pushed, an item that could not be saved
   * reads as it was kept, and an activity held open reads `running` (M20a, C29). `workerId`: whose
   * items these are — the session's own, or a worker's. `rest`: what is held here of that owner's
   * and is not among `items`.
   */
  function overlay(sessionId: string, entry: Entry, items: readonly ConversationItem[], workerId: string | null = null): { readonly items: readonly ConversationItem[]; readonly rest: readonly ConversationItem[] } {
    if (entry.unsaved.length === 0 && entry.open.size === 0 && entry.activities.size === 0) return { items: items.some((item) => item.kind === 'interaction') ? items.map((item) => asHeld(sessionId, entry, item)) : items, rest: [] };
    const held = new Map<string, ConversationItem>();
    for (const item of entry.unsaved) if (item.workerId === workerId) held.set(item.id, item);
    for (const message of entry.open.values()) if (message.workerId === workerId) held.set(message.id, shown(sessionId, message, 'streaming', message.text.slice(0, message.published)));
    const laid = items.map((item) => {
      const own = held.get(item.id);
      if (own === undefined) return asHeld(sessionId, entry, item);
      held.delete(item.id);
      // The store's places are the ones it gave: they stand.
      return { ...own, order: item.order };
    });
    return { items: laid, rest: [...held.values()] };
  }

  const newEntry = (history: HistoryState, parent: string | null): Entry => ({ parent, revision: 0, history, olderUnread: false, live: null, open: new Map(), done: new Map(), activities: new Map(), activityIds: new Map(), pushTimer: undefined, unsaved: [], unsavedSeq: 0, gaps: new Set(), failing: false });

  /** An aside's entry (M20b): made at its first question, or at its first read in this run. It has no history to check: none is read back for it. */
  function asideEntry(asideId: string, sessionId: string): Entry {
    let entry = entries.get(asideId);
    if (entry === undefined) {
      entry = newEntry('unsupported', sessionId);
      entries.set(asideId, entry);
    }
    return entry;
  }

  /** The session's asides as its read lists them (M20b, C30): the store's, each with whether a turn of it runs. None where the store cannot say. */
  function markers(sessionId: string): readonly AsideMarker[] {
    try {
      return store.asides(sessionId).map((aside) => ({ ...aside, running: (entries.get(aside.id)?.live ?? null) !== null }));
    } catch (error) {
      failed(error);
      return [];
    }
  }

  /** The session's grants as its read lists them (M22, C57, C92): the store's delivered ones, each live while its process is the session's. None where the store cannot say. */
  function grantsOf(sessionId: string): readonly SessionGrant[] {
    try {
      const key = options.processKey?.(sessionId) ?? null;
      return store.grants(sessionId).map((grant) => ({ itemId: grant.itemId, covers: grant.covers, decidedAt: grant.decidedAt, confirmed: grant.confirmedAt !== null, live: key !== null && grant.processKey === key }));
    } catch (error) {
      failed(error);
      return [];
    }
  }

  /** An interaction's write, pushed as its item now is. False when the store could not make it: counted, and the page reads again. */
  function pushStored(sessionId: string, entry: Entry, work: () => StoredItem | null): boolean | null {
    let stored: StoredItem | null;
    try {
      stored = work();
    } catch (error) {
      failed(error);
      entry.failing = true;
      return false;
    }
    if (stored === null) return null;
    settleGaps(sessionId, entry);
    pushItem(sessionId, entry, asHeld(sessionId, entry, stored.item), view(entry)(stored.turn));
    return true;
  }

  /** Whether an item holds a grant: its confirmation is then news for the session's list too (M22, C92). */
  function grantHeld(sessionId: string, itemId: string): boolean {
    try {
      const body = store.item(sessionId, itemId)?.item.interaction ?? null;
      return body !== null && body.kind === 'approval' && body.grant !== null;
    } catch {
      return false;
    }
  }

  function accepted(sessionId: string, entry: Entry, prompt: Omit<AcceptedPrompt, 'conversationId'>): 'accepted' | 'not-pending' | 'draft-changed' | 'not-queued' | 'storage-failed' {
    let made: ReturnType<ChatStoreAccess['acceptPrompt']>;
    try {
      made = store.acceptPrompt({ conversationId: sessionId, ...prompt });
    } catch (error) {
      // The card was settled meanwhile (M21, C77), or the plan's line decided (M22b, C12): nothing was written, and its outcome stands.
      if (error instanceof StorageFailure && (error.kind === 'not-open' || error.kind === 'not-pending')) return 'not-pending';
      // The draft is not the one named, or the queued message is gone (M23, C56, C86): nothing was written.
      if (error instanceof StorageFailure && (error.kind === 'draft-changed' || error.kind === 'not-queued')) return error.kind;
      // Nothing of the conversation is lost: the Send is refused, and the draft stays (C19).
      failed(error);
      return 'storage-failed';
    }
    entry.live = prompt.turnId;
    entry.done = new Map();
    settleGaps(sessionId, entry);
    const turn = turnView(made.turn, true);
    pushItem(sessionId, entry, made.item, turn);
    // The card it answered, and the cards it passed (M21, C26, C41): each as it now is, a held one replaced by id.
    // And the plan's line it decided (M22b, C12), as it now is.
    for (const id of [...(prompt.answering === undefined ? [] : [prompt.answering.itemId]), ...(prompt.deciding === undefined ? [] : [prompt.deciding.itemId]), ...made.passed]) pushStored(sessionId, entry, () => store.item(sessionId, id));
    return 'accepted';
  }

  function forget(id: string): void {
    const entry = entries.get(id);
    if (entry === undefined) return;
    timers.clear(entry.pushTimer);
    for (const message of entry.open.values()) timers.clear(message.progressTimer);
    entries.delete(id);
  }

  return {
    ensure(sessionId, history) {
      if (!entries.has(sessionId)) entries.set(sessionId, newEntry(history, null));
    },
    has: (sessionId) => entries.has(sessionId),
    drop(sessionId) {
      options.presentation?.forget(sessionId);
      // A session's asides' entries go with its own (M20b, C32): what the store holds stays until a removal deletes it.
      for (const [id, entry] of [...entries]) if (entry.parent === sessionId) forget(id);
      forget(sessionId);
    },
    ensureAside(asideId, sessionId) {
      asideEntry(asideId, sessionId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    read(sessionId, window, started) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return null;
      const keep = window?.keep ?? 'newest';
      const answer = (items: readonly ConversationItem[], turns: readonly ConversationTurn[], latest: boolean, older: boolean, earlierMissing: boolean, storage: ChatRead['storage']): ChatRead => {
        const history: ChatHistory = { state: entry.history, olderUnread: entry.olderUnread, earlierMissing };
        // Nothing of an aside is shown while the store is refused, or while its session's chat is not (M20b, C30).
        return { status: 'read', sessionId, revision: entry.revision, items, latest, turns, older: older ? items[0]?.id ?? null : null, history, storage, asides: listed ? markers(sessionId) : [], asking: 'none', waiting: listed ? requests?.waiting(sessionId) ?? [] : [], mode: listed ? chatMode : null, grants: listed ? grantsOf(sessionId) : [], ...presentation(sessionId, items) };
      };
      let listed = false;
      let chatMode: ChatMode | null = null;
      // Local history is unavailable, and nothing is sent, until the user starts fresh (C33).
      if (store.status().kind === 'refused') return answer([], [], true, false, false, 'refused');
      try {
        const conversation = store.conversation(sessionId);
        chatMode = conversation?.mode ?? null;
        const earlierMissing = conversation === null ? started : !conversation.startHeld && !conversation.reachedStart;
        const storage = entry.failing ? 'failing' : 'ok';
        // A removal that was cut short is finished before anything of it is shown again (C63).
        if (conversation?.removing === true) return answer([], [], true, false, false, storage);
        listed = true;
        // A `from` the store does not have is answered as a first read (C60).
        const rows = (window === null ? null : store.window(sessionId, window.from, window.keep)) ?? store.newestPage(sessionId);
        const turns = rows.turns.map(view(entry));
        const laid = overlay(sessionId, entry, rows.items);
        if (!rows.latest || laid.rest.length === 0) return answer(laid.items, turns, rows.latest, rows.older, earlierMissing, storage);
        // What the store does not have goes in by its place — after the stored tail, for what has none — within the same bounds.
        const fitted = fitWindow([...laid.items, ...laid.rest].sort(compareItems), keep);
        const held = new Set(turns.map((turn) => turn.id));
        const extra = [...new Set(fitted.items.map((item) => item.turnId))].filter((id) => !held.has(id)).map((id) => turnOfUnsaved(sessionId, entry, id));
        const shownTurns = [...turns, ...extra].filter((turn) => fitted.items.some((item) => item.turnId === turn.id));
        return answer(fitted.items, shownTurns, keep === 'newest' || !fitted.cut, rows.older || (keep === 'newest' && fitted.cut), earlierMissing, storage);
      } catch (error) {
        // The store could not be read: what this run kept in memory is all there is to show.
        failed(error);
        entry.failing = true;
        const items = fitWindow([...overlay(sessionId, entry, []).rest].sort(compareItems), 'newest').items;
        return answer(items, [...new Set(items.map((item) => item.turnId))].map((id) => unreadTurn(id, id === entry.live)), true, false, false, 'failing');
      }
    },

    page(sessionId, before) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return null;
      try {
        const rows = store.pageBefore(sessionId, before);
        if (rows === null) return { status: 'refused', reason: 'unknown-cursor' };
        const items = overlay(sessionId, entry, rows.items).items;
        return { status: 'page', sessionId, revision: revisionOf(entry), items, turns: rows.turns.map(view(entry)), older: rows.older ? rows.items[0]?.id ?? null : null, ...presentation(sessionId, items) };
      } catch (error) {
        failed(error);
        return { status: 'refused', reason: 'unknown-cursor' };
      }
    },

    readWorker(sessionId, workerId, before) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return null;
      // A store fat-g cannot read holds no worker it can show (M18, C33).
      if (store.status().kind === 'refused') return { status: 'refused', reason: 'unknown-worker' };
      try {
        const rows = store.workerItems(sessionId, workerId, before);
        if (rows === null) return { status: 'refused', reason: 'unknown-cursor' };
        const worker = store.workerItem(sessionId, workerId);
        const laid = overlay(sessionId, entry, rows.items, workerId);
        // What the store does not have goes after its newest; an older page holds none of it.
        const items = before === undefined && rows.latest && laid.rest.length > 0 ? fitWindow([...laid.items, ...laid.rest].sort(compareItems), 'newest').items : laid.items;
        if (worker === null && items.length === 0) return { status: 'refused', reason: 'unknown-worker' };
        const held = new Map(rows.turns.map((turn) => [turn.id, view(entry)(turn)]));
        const turns = [...new Set(items.map((item) => item.turnId))].map((id) => held.get(id) ?? turnOfUnsaved(sessionId, entry, id));
        const heldWorker = worker === null ? null : asHeld(sessionId, entry, worker);
        return { status: 'read', sessionId, workerId, revision: entry.revision, worker: heldWorker, items, turns, older: rows.older ? rows.items[0]?.id ?? null : null, ...presentation(sessionId, items, { id: workerId, item: heldWorker }) };
      } catch (error) {
        failed(error);
        return { status: 'refused', reason: 'unknown-worker' };
      }
    },

    readAside(sessionId, asideId, before) {
      const session = entries.get(sessionId);
      if (session === undefined) return null;
      // A store fat-g cannot read holds no aside it can show (M18, C33).
      if (store.status().kind === 'refused') return { status: 'refused', reason: 'unknown-aside' };
      try {
        const aside = store.aside(asideId);
        // Another session's, one being removed, or none: an aside is read under its own session alone.
        if (aside === null || aside.parentId !== sessionId || aside.removing) return { status: 'refused', reason: 'unknown-aside' };
        const entry = asideEntry(asideId, sessionId);
        const rows = before === undefined ? store.newestPage(asideId) : store.pageBefore(asideId, before);
        if (rows === null) return { status: 'refused', reason: 'unknown-cursor' };
        const laid = overlay(asideId, entry, rows.items);
        // What the store does not have goes after its newest; an older page holds none of it.
        const items = before === undefined && rows.latest && laid.rest.length > 0 ? fitWindow([...laid.items, ...laid.rest].sort(compareItems), 'newest').items : laid.items;
        const held = new Map(rows.turns.map((turn) => [turn.id, view(entry)(turn)]));
        const turns = [...new Set(items.map((item) => item.turnId))].map((id) => held.get(id) ?? turnOfUnsaved(asideId, entry, id));
        return {
          status: 'read', sessionId, asideId, revision: session.revision,
          aside: { id: aside.id, title: aside.title, source: aside.source, createdAt: aside.createdAt, running: entry.live !== null },
          items, turns, older: rows.older ? rows.items[0]?.id ?? null : null,
          ...presentation(sessionId, items),
        };
      } catch (error) {
        failed(error);
        return { status: 'refused', reason: 'unknown-aside' };
      }
    },

    findAside(sessionId, source) {
      try {
        for (const marker of store.asides(sessionId)) {
          // The place first, from the list; the text, which the list leaves out, from the aside itself (C50).
          if (marker.source === null || !samePlace(marker.source, source)) continue;
          if (store.aside(marker.id)?.source?.excerpt === source.excerpt) return marker.id;
        }
      } catch (error) {
        failed(error);
      }
      return null;
    },

    exchanges(asideId) {
      try {
        const pairs = new Map<string, { question: string | null; response: string | null }>();
        for (const item of store.newestPage(asideId).items) {
          if (item.kind !== 'message' || item.workerId !== null) continue;
          const pair = pairs.get(item.turnId) ?? { question: null, response: null };
          if (item.role === 'user') pair.question ??= itemText(item);
          // The turn's answer, whole: what was said on the way to it is none of the exchange.
          else if (item.role === 'assistant' && item.phase === 'final' && item.state === 'complete') pair.response = itemText(item);
          pairs.set(item.turnId, pair);
        }
        return [...pairs.values()].flatMap((pair) => (pair.question === null || pair.response === null ? [] : [{ question: pair.question, response: pair.response }]));
      } catch (error) {
        failed(error);
        return [];
      }
    },

    history: (sessionId) => entries.get(sessionId)?.history ?? null,

    setHistory(sessionId, state, olderUnread = false) {
      const entry = entries.get(sessionId);
      if (entry === undefined || (entry.history === state && entry.olderUnread === olderUnread)) return;
      entry.history = state;
      entry.olderUnread = olderUnread;
      changed(sessionId, entry);
    },

    pushComposer(sessionId, composer) {
      const entry = entries.get(sessionId);
      if (entry === undefined || entry.parent !== null) return;
      entry.revision += 1;
      tell({ sessionId, revision: entry.revision, composer });
    },

    markFailing(sessionId) {
      const entry = entries.get(sessionId);
      if (entry === undefined || entry.failing) return;
      entry.failing = true;
      changed(sessionId, entry);
    },

    changed(sessionId) {
      const entry = entries.get(sessionId);
      if (entry !== undefined) changed(sessionId, entry);
    },

    accept(sessionId, prompt) {
      const entry = entries.get(sessionId);
      return entry !== undefined && accepted(sessionId, entry, prompt) === 'accepted';
    },

    acceptAnswer(sessionId, prompt) {
      const entry = entries.get(sessionId);
      const made = entry === undefined ? 'storage-failed' : accepted(sessionId, entry, prompt);
      return made === 'draft-changed' || made === 'not-queued' ? 'storage-failed' : made;
    },

    acceptDecision(sessionId, prompt) {
      const entry = entries.get(sessionId);
      const made = entry === undefined ? 'storage-failed' : accepted(sessionId, entry, prompt);
      return made === 'draft-changed' || made === 'not-queued' ? 'storage-failed' : made;
    },

    acceptInput(sessionId, prompt) {
      const entry = entries.get(sessionId);
      const made = entry === undefined ? 'storage-failed' : accepted(sessionId, entry, prompt);
      return made === 'not-pending' ? 'storage-failed' : made;
    },

    acceptSteer(sessionId, steer) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return 'storage-failed';
      let made: StoredItem;
      try {
        made = store.acceptSteer({ conversationId: sessionId, ...steer });
      } catch (error) {
        if (error instanceof StorageFailure && error.kind === 'not-open') return 'not-pending';
        if (error instanceof StorageFailure && (error.kind === 'turn-over' || error.kind === 'draft-changed' || error.kind === 'not-queued')) return error.kind;
        failed(error);
        return 'storage-failed';
      }
      pushItem(sessionId, entry, made.item, view(entry)(made.turn));
      // The card it answered (M21, C26), as it now is.
      if (steer.answering !== undefined) pushStored(sessionId, entry, () => store.item(sessionId, steer.answering?.itemId ?? ''));
      return 'accepted';
    },

    setDelivery(sessionId, itemId, delivery) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return false;
      return pushStored(sessionId, entry, () => (store.setDelivery(sessionId, itemId, delivery) ? store.item(sessionId, itemId) : null)) === true;
    },

    movedToTurn(sessionId, itemId, turnId, at, speed) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return false;
      try {
        store.moveToTurn(sessionId, itemId, turnId, at, speed);
      } catch (error) {
        failed(error);
        return false;
      }
      entry.live = turnId;
      entry.done = new Map();
      settleGaps(sessionId, entry);
      // An item left its turn for another: the page reads the chat again.
      changed(sessionId, entry);
      return true;
    },

    took(sessionId, turnId, providerTurnId) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      // And, in the same write, the mark of the card that turn's prompt answered (M21, C68): the page reads again on it.
      write(sessionId, entry, turnId, () => { store.providerTook(sessionId, turnId, providerTurnId); });
      changed(sessionId, entry);
    },

    reference(sessionId, reference, folder, configFolder) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      write(sessionId, entry, null, () => store.setReference(sessionId, reference, folder, configFolder));
    },

    echo(sessionId, itemId, providerItemId) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      let named = false;
      write(sessionId, entry, entry.live, () => { named = store.setProviderItemId(sessionId, itemId, providerItemId); });
      if (named) changed(sessionId, entry);
    },

    delta(sessionId, turnId, delta) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      const workerId = delta.workerId ?? null;
      // A turn that has ended takes nothing more of the session's own (C6); a worker's message is
      // taken whenever it comes, in the turn that started the worker (M20a, C20).
      if (workerId === null && entry.live !== turnId) { dropDelta('turn-ended'); return; }
      let message = entry.open.get(delta.itemId) ?? null;
      if (message === null) {
        const after = entry.done.get(delta.itemId);
        if (after !== undefined) { dropDelta(after); return; }
        message = open(sessionId, entry, turnId, delta.itemId, delta.phase, workerId);
        if (message === null) { entry.done.set(delta.itemId, 'unopened'); dropDelta('unopened'); return; }
      }
      if (delta.text === '') return;
      if (message.cut) { dropDelta('bound'); return; }
      if (message.text.length + delta.text.length > MAX_MESSAGE_TEXT) {
        // The bound (C6, C64): what fits is taken, never half of a pair, and the message says it was
        // cut — pushed at once, as an item, so the page shows it while the message is still written.
        // The bound brings no write of its own: the next progress write, or the end's, stores the
        // flag with the text it belongs to.
        message.text = cutTo(message.text + delta.text, MAX_MESSAGE_TEXT).text;
        message.cut = true;
        message.dirty = true;
        dropDelta('bound');
        armProgress(sessionId, entry, message);
        pushWhole(sessionId, entry, message);
        return;
      }
      message.text += delta.text;
      message.dirty = true;
      // Its first text is written at once (C14); from then on at most every two seconds (C16).
      if (!message.stored && message.text.length === delta.text.length) saveProgress(sessionId, entry, message); else armProgress(sessionId, entry, message);
      armPush(sessionId, entry);
    },

    add(sessionId, turnId, item, card = false) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      const opened = item.kind === 'message' && item.providerItemId !== null ? entry.open.get(item.providerItemId) : undefined;
      if (opened !== undefined && opened.text === '' && isEmptyWhole(item)) {
        // Opened by its start and never given a text (M21, C69): let go unwritten, as a message its
        // turn's end left without text is, and told as a change, so the page lets go of its row.
        close(entry, opened, 'complete');
        changed(sessionId, entry);
        return;
      }
      if (opened !== undefined) { complete(sessionId, entry, opened, item, card); return; }
      // A whole message is complete: a delta that names it afterwards is dropped (C6).
      if (item.kind === 'message' && item.providerItemId !== null && (item.workerId != null || ((turnId ?? entry.live) === entry.live && entry.live !== null))) entry.done.set(item.providerItemId, 'complete');
      // No message at all (M21, C56).
      if (isEmptyWhole(item)) return;
      let stored: ReturnType<ChatStoreAccess['addItem']>;
      try {
        stored = store.addItem(sessionId, turnId, item, askingOf(entry, item, card));
      } catch (error) {
        // An item for a turn the conversation does not have is no part of it: dropped, and counted.
        if (error instanceof StorageFailure && error.kind === 'no-turn') { failed(error); return; }
        failed(error);
        entry.failing = true;
        const owner = turnId ?? entry.live;
        if (owner !== null) entry.gaps.add(owner);
        keepUnsaved(sessionId, entry, turnId, item);
        return;
      }
      settleGaps(sessionId, entry);
      // Null: the turn already holds it (C20).
      if (stored === null) return;
      pushItem(sessionId, entry, stored.item, view(entry)(stored.turn));
      if (stored.interaction !== null) {
        pushItem(sessionId, entry, stored.interaction, view(entry)(stored.turn));
        questionShown(sessionId, entry, stored.interaction);
      }
    },

    raise(sessionId, question, kept) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return null;
      const id = newId();
      let stored: StoredItem | null;
      try {
        stored = store.addInteraction(sessionId, question.turnId, { id, origin: 'local', providerItemId: question.providerItemId, workerId: question.workerId, mode: 'blocking', questions: question.questions, cut: question.cut, receivedAt: now(), providerAt: null });
      } catch (error) {
        // A card that cannot be kept cannot be shown (C33): the registry refuses its request.
        failed(error);
        if (!(error instanceof StorageFailure && error.kind === 'no-turn')) entry.failing = true;
        return null;
      }
      if (stored === null) return null;
      settleGaps(sessionId, entry);
      // Pending from here: the registry makes its entry now, before the push, and every read asks it.
      kept?.(id);
      pushItem(sessionId, entry, waiting(sessionId, stored.item), view(entry)(stored.turn));
      return id;
    },

    raiseApproval(sessionId, approval, kept) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return null;
      const id = newId();
      let stored: StoredItem | null;
      try {
        stored = store.addInteraction(sessionId, approval.turnId, { id, origin: 'local', providerItemId: approval.providerItemId, workerId: approval.workerId, request: approval.request, receivedAt: now(), providerAt: null });
      } catch (error) {
        // A card that cannot be kept cannot be shown (M21, C33): the registry refuses its request.
        failed(error);
        if (!(error instanceof StorageFailure && error.kind === 'no-turn')) entry.failing = true;
        return null;
      }
      if (stored === null) return null;
      settleGaps(sessionId, entry);
      // The registry's entry is made now, with the request whole (C79): the push below lays it over the cut copy just stored.
      kept?.(id);
      pushItem(sessionId, entry, waiting(sessionId, stored.item), view(entry)(stored.turn));
      return id;
    },

    addPlan(sessionId, turnId, plan, kept) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return null;
      const id = newId();
      let stored: StoredItem;
      try {
        stored = store.addPlan(sessionId, turnId, { id, providerItemId: plan.providerItemId, body: plan.body, receivedAt: now() });
      } catch (error) {
        // A line that cannot be kept cannot be shown (C17): the plan service refuses its request.
        failed(error);
        if (!(error instanceof StorageFailure && error.kind === 'no-turn')) entry.failing = true;
        return null;
      }
      settleGaps(sessionId, entry);
      // The registry's entry is made now, before the push (M21, C76): a read from inside it finds the request pending.
      kept?.(id);
      pushItem(sessionId, entry, asHeld(sessionId, entry, stored.item), view(entry)(stored.turn));
      return id;
    },

    setPlan(sessionId, itemId, from, change) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return false;
      return pushStored(sessionId, entry, () => store.setInteraction(sessionId, itemId, from, change));
    },

    setPlanFeedback(sessionId, itemId, change, text) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return false;
      let stored: { readonly line: StoredItem; readonly prompt: StoredItem } | null;
      try {
        stored = store.setPlanFeedback(sessionId, itemId, change, { id: newId(), text, at: now() });
      } catch (error) {
        failed(error);
        entry.failing = true;
        return false;
      }
      if (stored === null) return null;
      settleGaps(sessionId, entry);
      pushItem(sessionId, entry, asHeld(sessionId, entry, stored.line.item), view(entry)(stored.line.turn));
      pushItem(sessionId, entry, stored.prompt.item, view(entry)(stored.prompt.turn));
      return true;
    },

    bringPlan(sessionId, at, body) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return null;
      const id = newId();
      let stored: StoredItem;
      try {
        stored = store.bringPlan(sessionId, at, { id, providerItemId: null, body, receivedAt: at.at });
      } catch (error) {
        failed(error);
        return null;
      }
      settleGaps(sessionId, entry);
      pushItem(sessionId, entry, stored.item, view(entry)(stored.turn));
      return id;
    },

    decide(sessionId, itemId, outcome, grant) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return 'storage-failed';
      const written = pushStored(sessionId, entry, () => store.setInteraction(sessionId, itemId, 'pending', { outcome, decidedAt: now(), ...(grant === null ? {} : { grant }) }));
      return written === null ? 'not-pending' : written ? 'decided' : 'storage-failed';
    },

    delivered(sessionId, itemId, went) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      // The session's read lists a grant once its reply was delivered (C92): told as a change, where the write landed.
      if (pushStored(sessionId, entry, () => store.setInteraction(sessionId, itemId, DECIDED, { delivered: went })) === true) changed(sessionId, entry);
    },

    created(sessionId, at, mode) {
      try {
        store.createConversation(sessionId, at, mode);
        return true;
      } catch (error) {
        failed(error);
        return false;
      }
    },

    mode(sessionId) {
      try {
        return store.conversation(sessionId)?.mode ?? null;
      } catch (error) {
        failed(error);
        return null;
      }
    },

    setMode(sessionId, mode, started) {
      try {
        store.setMode(sessionId, mode, now(), started);
      } catch (error) {
        failed(error);
        return false;
      }
      const entry = entries.get(sessionId);
      if (entry !== undefined) changed(sessionId, entry);
      return true;
    },

    grantsOn(sessionId, processKey) {
      try {
        return store.grants(sessionId).filter((grant) => grant.processKey === processKey).length;
      } catch (error) {
        failed(error);
        return 0;
      }
    },

    answer(sessionId, itemId, answers) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return 'storage-failed';
      const written = pushStored(sessionId, entry, () => store.setInteraction(sessionId, itemId, 'pending', { outcome: 'answered', answers, settledAt: now() }));
      return written === null ? 'not-pending' : written ? 'answered' : 'storage-failed';
    },

    dismiss(sessionId, itemId) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return 'unknown-item';
      try {
        if (store.item(sessionId, itemId)?.item.kind !== 'interaction') return 'unknown-item';
      } catch (error) {
        failed(error);
        return 'storage-failed';
      }
      const written = pushStored(sessionId, entry, () => store.setInteraction(sessionId, itemId, 'open', { outcome: 'dismissed', settledAt: now() }));
      return written === null ? 'not-open' : written ? 'dismissed' : 'storage-failed';
    },

    decline(sessionId, itemId) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return 'storage-failed';
      const written = pushStored(sessionId, entry, () => store.setInteraction(sessionId, itemId, 'pending', { outcome: 'dismissed', settledAt: now() }));
      return written === null ? 'not-pending' : written ? 'declined' : 'storage-failed';
    },

    confirm(sessionId, itemId) {
      const entry = entries.get(sessionId);
      // A question's answer, or an approval's decision, whichever it was (M22, C12) — or a plan's (M22b, C11).
      if (entry !== undefined && pushStored(sessionId, entry, () => store.setInteraction(sessionId, itemId, ['answered', ...DECIDED, ...PLAN_DECIDED], { confirmedAt: now() })) === true && grantHeld(sessionId, itemId)) changed(sessionId, entry);
    },

    settle(sessionId, itemIds, outcome, withdrawnBy) {
      const entry = entries.get(sessionId);
      if (entry === undefined || itemIds.length === 0) return;
      let settled: readonly StoredItem[];
      try {
        settled = store.settlePending(sessionId, itemIds, { outcome, settledAt: now(), ...(withdrawnBy === undefined ? {} : { withdrawnBy }) });
      } catch (error) {
        // Unwritten, they read as the store has them once their requests are let go: the page reads again.
        failed(error);
        entry.failing = true;
        changed(sessionId, entry);
        return;
      }
      settleGaps(sessionId, entry);
      for (const stored of settled) pushItem(sessionId, entry, stored.item, view(entry)(stored.turn));
    },

    notTaken(sessionId, itemId) {
      const entry = entries.get(sessionId);
      if (entry !== undefined && pushStored(sessionId, entry, () => store.setInteraction(sessionId, itemId, ['answered', 'dismissed'], { outcome: 'dropped', settledAt: now() })) === false) changed(sessionId, entry);
    },

    interaction(sessionId, itemId) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return null;
      try {
        const stored = store.item(sessionId, itemId);
        return stored === null || stored.item.kind !== 'interaction' || stored.item.interaction === null ? null : asHeld(sessionId, entry, stored.item);
      } catch (error) {
        failed(error);
        return null;
      }
    },

    activityStarted(sessionId, turnId, activity) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      const { itemId: providerItemId, workerId, start, providerAt } = activity;
      const key = activityKey(turnId, workerId, providerItemId);
      let open = entry.activities.get(key) ?? null;
      // The session's own begins in the turn in flight alone; a worker's whenever it comes (C20).
      if (open === null && workerId === null && entry.live !== turnId) { dropActivity('turn-ended'); return; }
      if (open !== null && open.unsaved !== null && open.unsaved.activity !== null) {
        // Kept here, as the store did not take it: what this start says replaces what the first did (C59).
        open.type = start.type;
        open.paired = start.workerId ?? open.paired;
        open.unsaved = { ...open.unsaved, activity: { ...restartedBody(open.unsaved.activity, start), status: 'running' } };
        keep(sessionId, entry, open.unsaved);
        return;
      }
      let stored: ReturnType<ChatStoreAccess['addActivity']>;
      try {
        stored = store.addActivity(sessionId, turnId, { id: open?.id ?? newId(), origin: 'local', providerItemId, workerId, start, receivedAt: now(), providerAt });
      } catch (error) {
        failed(error);
        // An activity for a turn the conversation does not have is no part of it: dropped, and counted.
        if (error instanceof StorageFailure && error.kind === 'no-turn') { dropActivity('no-turn'); return; }
        entry.failing = true;
        entry.gaps.add(turnId);
        if (open !== null) return;
        // It stays readable for the run (M18, C19), and its end is taken here too.
        entry.unsavedSeq += 1;
        const item: ConversationItem = {
          id: newId(), conversationId: sessionId, turnId, order: { turn: Number.MAX_SAFE_INTEGER, item: entry.unsavedSeq }, kind: 'activity', origin: 'local', providerItemId, workerId,
          activity: startedBody(start), interaction: null, role: null, phase: null, model: null, state: 'streaming', blocks: [], questions: [], notice: null, detail: null, time: { receivedAt: now(), providerAt },
        };
        started[start.type] += 1;
        track(entry, { key, id: item.id, turnId, providerItemId, workerId, type: start.type, paired: start.workerId ?? null, startedAt: monotonic(), unsaved: item });
        keep(sessionId, entry, item);
        return;
      }
      settleGaps(sessionId, entry);
      if (open !== null) {
        open.type = start.type;
        open.paired = start.workerId ?? open.paired;
      } else if (stored.opened) {
        started[start.type] += 1;
        if (/^10*$/.test(String(started[start.type]))) log.warn(`[chat] activity (${start.type}), ${started[start.type]} so far`);
        countCut(stored.item.activity);
        // Past the cap it is kept all the same: it reads unfinished until its end, and its duration is the provider's or none.
        if (entry.activities.size < MAX_OPEN_ACTIVITIES) {
          open = { key, id: stored.item.id, turnId, providerItemId, workerId, type: start.type, paired: start.workerId ?? null, startedAt: monotonic(), unsaved: null };
          track(entry, open);
        }
      }
      pushItem(sessionId, entry, asHeld(sessionId, entry, stored.item), view(entry)(stored.turn));
    },

    activityEnded(sessionId, turnId, activity) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      const { itemId: providerItemId, workerId } = activity;
      const open = entry.activities.get(activityKey(turnId, workerId, providerItemId)) ?? null;
      // The provider's where it gives one, a zero included; else the span of main's own receipts (C7, C35).
      const duration: ActivityDuration | null = activity.durationMs !== null ? { ms: activity.durationMs, provenance: 'provider' } : open !== null && activity.untimed !== true ? { ms: Math.max(0, Math.round(monotonic() - open.startedAt)), provenance: 'local' } : null;
      const end: ActivityEnd = { ...activity.end, ...(duration === null ? {} : { duration }) };
      let ended: ConversationItem;
      if (open !== null && open.unsaved !== null && open.unsaved.activity !== null) {
        untrack(entry, open);
        ended = { ...open.unsaved, state: 'complete', activity: endedBody(open.unsaved.activity, end) };
        keep(sessionId, entry, ended);
      } else {
        let stored: ReturnType<ChatStoreAccess['endActivity']>;
        try {
          stored = store.endActivity(sessionId, turnId, { providerItemId, workerId }, end);
        } catch (error) {
          failed(error);
          entry.failing = true;
          entry.gaps.add(turnId);
          // What the store has of it stays as it was at its start, and reads unfinished.
          if (open !== null) { untrack(entry, open); changed(sessionId, entry); }
          return;
        }
        if (open !== null) untrack(entry, open);
        if (stored === null) { dropActivity('unopened'); return; }
        settleGaps(sessionId, entry);
        ended = stored.item;
        if (ended.activity?.cut != null && activity.end.cut != null) countCut(ended.activity);
        pushItem(sessionId, entry, ended, view(entry)(stored.turn));
      }
      // The item that started a worker has ended, so the worker has (C23): nothing of it stays open.
      if (ended.activity?.type === 'worker' && ended.activity.workerId !== null) closeWorker(sessionId, entry, ended.activity.workerId);
    },

    lost(sessionId) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      if (closeAll(sessionId, entry)) changed(sessionId, entry);
      if (entry.open.size === 0) { timers.clear(entry.pushTimer); entry.pushTimer = undefined; }
    },

    ended(sessionId, turnId, reported) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      if (reported === null) {
        // An end the adapter made (M18, C59): its workers ended with it, or its process did. Nothing of the session stays open (M20a, C29).
        closeAll(sessionId, entry);
      } else {
        // Before the end is written (C18): a message of the session's own still open is kept as far
        // as it got. A worker's stays open until its worker ends (M20a, C20), and so do the worker's
        // activities and the item that started it; every other open activity of the turn is left
        // unfinished, and its checklist completed (C29).
        for (const message of [...entry.open.values()]) if (message.turnId === turnId && message.workerId === null) leave(sessionId, entry, message);
        settle(sessionId, entry, [...entry.activities.values()].filter((activity) => activity.turnId === turnId && activity.workerId === null && !(activity.type === 'worker' && activity.paired !== null)));
      }
      if (entry.open.size === 0) { timers.clear(entry.pushTimer); entry.pushTimer = undefined; }
      if (reported !== null) {
        const answerItemId = reported.answerItemId ?? null;
        write(sessionId, entry, turnId, () => store.providerEnded(sessionId, turnId, reported.outcome, reported.at, answerItemId, reported.elapsedMs ?? null));
        // What could not be saved is shown from here for the run: it is settled here too (M18, C19).
        if (answerItemId !== null) entry.unsaved = entry.unsaved.map((item) => (item.turnId === turnId && item.providerItemId === answerItemId && item.role === 'assistant' ? { ...item, phase: 'final' } : item));
      }
      if (entry.live === turnId) entry.live = null;
      changed(sessionId, entry);
    },

    passGonePast(sessionId, turnId) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      let passed: readonly StoredItem[];
      try {
        passed = store.passGonePast(sessionId, turnId, now());
      } catch (error) {
        // Unwritten, they stay open as the store has them: the page reads again.
        failed(error);
        entry.failing = true;
        changed(sessionId, entry);
        return;
      }
      if (passed.length === 0) return;
      settleGaps(sessionId, entry);
      for (const stored of passed) pushItem(sessionId, entry, stored.item, view(entry)(stored.turn));
    },

    sessionEnded(sessionId, turnId, at, outcome) {
      const entry = entries.get(sessionId);
      let stored: boolean;
      try {
        // False for a turn the store does not have — the demo source's: nothing changes.
        stored = store.sessionEnded(sessionId, turnId, at, outcome);
      } catch (error) {
        // The record keeps the end, and the next launch writes it here (C29).
        failed(error);
        if (entry !== undefined) entry.failing = true;
        return;
      }
      if (entry === undefined || !stored) return;
      settleGaps(sessionId, entry);
      changed(sessionId, entry);
    },

    saveOpen() {
      for (const [sessionId, entry] of entries) {
        for (const message of entry.open.values()) if (message.text !== '' && (message.dirty || !message.stored)) saveProgress(sessionId, entry, message);
        // On disk as a quit leaves them (M20a, C29), and still open here: an end that comes in time ends them.
        settle(sessionId, entry, [...entry.activities.values()], true);
      }
    },

    dropped: () => ({ ...drops }),

    activityCounts: () => ({ started: { ...started }, cut: cutActivities, dropped: { ...activityDrops } }),

    dispose() {
      stopPresentation?.();
      for (const entry of entries.values()) {
        timers.clear(entry.pushTimer);
        entry.pushTimer = undefined;
        for (const message of entry.open.values()) { timers.clear(message.progressTimer); message.progressTimer = undefined; }
      }
    },
  };
}
