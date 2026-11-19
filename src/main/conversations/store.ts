// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The conversation store (docs/planning/_archive/M18.md, Design 2–6, 8, 9; M19.md, Design 4; M20a.md,
// Design 6; decisions 0019, 0024): fat-g's own copy of what was said and done in the sessions it
// ran, kept until the user removes it (C11).
// A message that is being written is kept as far as it got (M19, C14–C17): inserted at its first
// text as incomplete, its text written again as it grows, and completed by its whole message in one
// transaction — or left as it is by an end, a quit or a crash.
//
// What a session does between its messages is kept the same way (M20a, C28, C29): an activity is a
// row from its start, with its body under a key of its own, and ended by an update of that body's
// named keys. A worker's items say whose they are in a column, and are in no page of the session's.
// A page and a window are counted in entries, a turn's consecutive activities being one (C31).
//
// A question the session asks is an item of its own (M21, C32, C33; decision 0026): a row of kind
// `interaction` from its raising, its body under a key of its own, and changed at each outcome by an
// update of that body's named keys, written under the outcome it expects, so no settled outcome is
// written over (C77). An async question's is written in the transaction that writes its message,
// and an async answer's in the one that records its prompt, with the pass of the other open cards.
// The store knows no request that lives: a stored `pending` reads `dropped` (C61).
//
// An action a session asks leave for is an item of that same kind (M22, C77; decision 0027): its
// body says `kind: 'approval'` and holds the request with its detail cut as an activity's is (C48),
// and a decision, its delivery, the CLI's confirmation and the grant sent with it are each an update
// of named keys under the outcome it expects. A conversation's row holds its chat's mode and where
// it came from, and a turn's the mode it ran under, written with its prompt (C25, C83).
//
// A question asked beside a session is a conversation of its own (M20b, C28, C32; decision 0025):
// its row names its session's as its parent, with what it was asked about and its title, and its
// turns and items are rows as any conversation's. It goes with its parent: a removal that marks a
// conversation marks its asides, and deletes them with it.
//
// Main process only, Electron-free, and it names no provider: the folder, the clock and the file system arrive as
// options, and what is written is what the agent events' schemas let through (C9).
//
// Every write is one synchronous transaction (C44): it is on disk when its call returns (C56), or
// it throws and nothing of it is there. A write that throws is a storage failure, and is the
// caller's to tell (C19); nothing here retries, repairs or rebuilds (C39).
//
// Unknown fields are kept (C38): no `SELECT *` feeds a write, no row is replaced, and a row changes
// by `UPDATE` of named columns. A table or a column this build does not know is never touched. An
// explicit removal is the one thing that deletes rows (C30), and it deletes them whole.
//
// A store this build cannot read is refused and left exactly as it is, until the user chooses Start
// fresh, which moves its files aside together (C33, C40) — with its images' folder, as one
// generation (M23, C84).
//
// What was not sent yet is kept here too (M23, C5, C31, C47; decision 0030): each session's draft,
// its queued messages, and every use of an image — a draft's, a queued message's, or a sent message's
// as an item of kind `attachment` in its turn. Ownership of an image moves in the transaction of the
// operation that moves it (composer-rows.ts), and an image whose last use goes loses its row in that
// same transaction and its file after the commit (C6). A compatible store's open sweeps its images'
// folder of what no row names; a refused store authorizes no sweep (C84).
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import { TurnSpeedSchema, type TurnSpeed } from '@shared/contracts/conversation';
import { type ActivityBody, type ActivityEnd, type ActivityStart, endedBody, isEnded, readActivity, restartedBody, startedBody } from '@shared/contracts/activity';
import { type AgentQuestion, cutTo, type HistoryActivity, type HistoryMessage, MAX_MESSAGE_TEXT, MAX_NOTICE_DETAIL, MESSAGE_PHASES, type MessagePhase } from '@shared/contracts/agent-events';
import { type AsideSource, type AsideSourceRef, AsideSourceSchema, MAX_ASIDE_TITLE, NEW_ASIDE_TITLE, sourceRef } from '@shared/contracts/aside';
import { type ApprovalOutcome, type ApprovalRequest, fromMessageQuestions, type InteractionAnswer, type InteractionBody, type InteractionMode, type InteractionOutcome, type InteractionQuestion, type PlanBody, raisedApproval, raisedBody, readInteraction, type WithdrawnBy } from '@shared/contracts/interaction';
import { type PlanFields, type PlanOutcome, readPlanFields, readPlanPrompt } from '@shared/contracts/plans';
import { type ChatMode, isModeId, isModeSource, type ModeSource } from '@shared/contracts/permissions';
import {
  CHAT_NOTICE_KINDS,
  type ChatNoticeKind,
  type ConversationItem,
  type ConversationsStatus,
  type ConversationTurn,
  isItemKind,
  ITEM_KINDS,
  type ItemOrigin,
  itemUnits,
  MAX_PAGE_UNITS,
  MAX_WINDOW_UNITS,
  PAGE_ENTRIES,
  RESERVED_ITEM_KINDS,
  sameEntry,
  type TextBlock,
  WINDOW_ENTRIES,
} from '@shared/contracts/conversation';
import { catalogId } from '@shared/contracts/catalog';
import { type ListedWorker, MAX_LINE_INPUT, REPORTED_OUTCOMES, type ReportedOutcome, TURN_OUTCOMES, type TurnOutcome } from '@shared/contracts/sessions';
import type { StartFreshResult } from '@shared/contracts/stored-file';
import { ATTACHMENTS_FOLDER, MAX_IMAGES, MAX_MESSAGE_IMAGE_BYTES, type AttachmentMediaType } from '@shared/contracts/attachments';
import { returnedImageMessageId } from '@shared/contracts/returned-images';
import { DELIVERY_STATES, type DeliveryView, type PromptIntent } from '@shared/contracts/composer';
import { type BlobFiles, blobHashOfPath, createBlobFiles } from '../attachments/files';
import { errorKind } from '../storage/error-kind';
import { composerRows, ComposerRowsFailure, type GivenInput, type StagedUse, type StoredBlob, type StoredDraft, type StoredQueued } from './composer-rows';
import { createStoreFiles, type StoreFiles } from './files';
import { CONVERSATIONS_VERSION } from './format';
import { type Held, type HeldTurn, orderEntries, type TurnPlan } from './merge';
import { openStore, type Synchronous } from './open';
import { SEARCH_FROM, type SearchChange, type SearchMessage, type SearchMessageReader } from './search';

// ── What the store holds ──────────────────────────────────────────────────────────────────────

export interface StoredConversation {
  readonly id: string;
  /** The provider's session reference, with the folder and the configuration folder it started in (C28). */
  readonly reference: string | null;
  readonly folder: string | null;
  readonly configFolder: string | null;
  /** The store has the conversation's start (C18). */
  readonly startHeld: boolean;
  /** A history check walked back to the start (C51). */
  readonly reachedStart: boolean;
  /** An explicit removal has begun (C63). */
  readonly removing: boolean;
  readonly createdAt: number;
  /** The session's conversation an aside belongs to (M20b, C28); null for a session's own. */
  readonly parentId: string | null;
  /** The chat's mode and where it came from (M22, C25, C40); null where the row holds none, as an aside's does. */
  readonly mode: ChatMode | null;
}

/** Where a plan the chat took part in was implemented, once that plan is deleted (decision 0029): the session that carried it out, and when. */
export interface PlanNote {
  readonly sessionId: string;
  readonly at: number;
}

/** An aside as the store holds it (M20b, C28, C29): its conversation's row, with what it was asked about. */
export interface StoredAside {
  readonly id: string;
  readonly parentId: string;
  readonly title: string;
  /** Null for a question typed freely. */
  readonly source: AsideSource | null;
  readonly createdAt: number;
  readonly removing: boolean;
}

/** An aside as a session's read lists it (M20b, C30): where it came from, and none of its text. */
export interface StoredAsideMarker {
  readonly id: string;
  readonly title: string;
  readonly source: AsideSourceRef | null;
  readonly createdAt: number;
}

export interface StoredTurn {
  readonly speed?: TurnSpeed | null;
  readonly id: string;
  readonly conversationId: string;
  readonly place: number;
  readonly origin: ItemOrigin;
  readonly providerTurnId: string | null;
  readonly acceptedAt: number | null;
  /** The provider confirmed that it took the prompt (C15). */
  readonly providerTook: boolean;
  readonly providerStartedAt: number | null;
  readonly providerEndedAt: number | null;
  readonly endReceivedAt: number | null;
  /** The provider's end (C54): null until the provider itself said the turn was over. */
  readonly providerOutcome: ReportedOutcome | null;
  readonly providerDurationMs: number | null;
  /** fat-g's own measure of a turn it ran, written with the provider's end (M19, C44). */
  readonly elapsedMs: number | null;
  /** The session's end (C54): when it stopped running for the turn, or a quit stopped it. */
  readonly sessionEndedAt: number | null;
  readonly sessionOutcome: TurnOutcome | null;
  readonly reached: boolean;
  readonly gap: boolean;
  /** fat-g answered the prompt itself, and sent it to no provider (M20b, C35). */
  readonly own: boolean;
  /** The id of the mode the turn ran under (M22, C83): the chat's, when its prompt was accepted. */
  readonly mode: string | null;
  /** It was a plan turn (M22b, C1, C55, C71): its mode is the chat's still. */
  readonly plan: boolean;
}

/** A stored turn as the page is shown it. `live`: it is the turn in flight. */
export function turnView(turn: StoredTurn, live: boolean): ConversationTurn {
  // A turn fat-g answered itself ended when it was answered (M20b, C35): no provider was to confirm it, or to end it.
  const state = live ? 'running' : turn.providerOutcome !== null || turn.own ? 'ended' : turn.providerTook ? 'unfinished' : 'unacknowledged';
  return {
    id: turn.id,
    place: turn.place,
    origin: turn.origin,
    state,
    // The provider's, else the session's; none is invented (C16, C54).
    outcome: turn.providerOutcome ?? turn.sessionOutcome,
    gap: turn.gap,
    mode: turn.mode,
    ...(turn.speed === undefined ? {} : { speed: turn.speed }),
    time: { acceptedAt: turn.acceptedAt, providerStartedAt: turn.providerStartedAt, providerEndedAt: turn.providerEndedAt, endReceivedAt: turn.endReceivedAt, providerDurationMs: turn.providerDurationMs, elapsedMs: turn.elapsedMs },
  };
}

/** A new item's content. Its place is the store's to give. */
export interface NewItem {
  readonly id: string;
  readonly kind: 'message' | 'notice';
  readonly origin: ItemOrigin;
  readonly providerItemId: string | null;
  readonly role: 'user' | 'assistant' | null;
  readonly phase: MessagePhase | null;
  readonly text: string;
  readonly cut: boolean;
  readonly questions: readonly AgentQuestion[];
  readonly notice: ChatNoticeKind | null;
  readonly detail: string | null;
  readonly receivedAt: number | null;
  readonly providerAt: number | null;
  /** False for a message whose whole text has not arrived (M19, C15). Left out, the item is complete. */
  readonly complete?: boolean;
  /** Whose it is, for a worker's message (M20a, C20). Left out or null, the session's own. */
  readonly workerId?: string | null;
  /** The model that wrote a message, where its provider named one (M20b, C25, C28). Left out or null, none is kept. */
  readonly model?: string | null;
  /** A prompt fat-g composed for a plan (M22b, C69): the plan and the version it names. Left out or null, none. */
  readonly plan?: PlanFields | null;
  /** A user's message sent into a running turn (M23, C38): what became of it so far. Left out or null, none. */
  readonly delivery?: DeliveryView | null;
  readonly fromQueue?: boolean;
}

/** A new activity's content (M20a, C29): its place is the store's to give, and its body is made of what its start said. */
export interface NewActivity {
  readonly id: string;
  readonly origin: ItemOrigin;
  /** The provider's id for it: what its end, and a second start, name it by. */
  readonly providerItemId: string;
  /** Whose it is: null for the session's own. */
  readonly workerId: string | null;
  readonly start: ActivityStart;
  readonly receivedAt: number | null;
  readonly providerAt: number | null;
}

/** An activity as the store finds it again: by the provider's id for it, in its turn, for its owner. */
export interface ActivityKey {
  readonly providerItemId: string;
  readonly workerId: string | null;
}

/** A new interaction's content (M21, C33): its place is the store's to give, and its body is made of what its raising said. */
export interface NewInteraction {
  readonly id: string;
  readonly origin: ItemOrigin;
  /** The provider's id of what carried the question (C6): where the card stands, and once for it. */
  readonly providerItemId: string;
  /** Whose it is: null for the session's own. */
  readonly workerId: string | null;
  readonly mode: InteractionMode;
  readonly questions: readonly InteractionQuestion[];
  readonly cut: boolean;
  readonly receivedAt: number | null;
  readonly providerAt: number | null;
}

/**
 * A new approval's content (M22, C77): an item of the same kind, its body made of the request as
 * its adapter read it — kept with its detail cut as an activity's is (C48) — and pending. Its place
 * is the store's to give. One action can ask twice, so nothing of it stands once: the registry
 * tells a repeated request by its own key.
 */
export interface NewApproval {
  readonly id: string;
  readonly origin: ItemOrigin;
  /** The provider's id of what carried the request, which the action's own activity shares (C14). */
  readonly providerItemId: string;
  readonly workerId: string | null;
  readonly request: ApprovalRequest;
  readonly receivedAt: number | null;
  readonly providerAt: number | null;
}

/**
 * A plan's line (M22b, C17): an item of kind `interaction` whose body is the plan's — which plan,
 * which version, how it came and the decision — and none of its text, which the plan store holds.
 * `providerItemId`: the provider's id of what carried it — a request's tool use, a plan's own item —
 * or null for a line brought into the chat (C64).
 */
export interface NewPlan {
  readonly id: string;
  readonly providerItemId: string | null;
  readonly body: PlanBody;
  readonly receivedAt: number;
}

/** A plan's line that waits for its decision (M22b, C56, C58, C73): its chat, its item, its plan and version, and whether a request holds it. */
export interface PendingPlanRow {
  readonly conversationId: string;
  readonly itemId: string;
  readonly planId: string;
  readonly version: number;
  readonly request: boolean;
}

/**
 * What a turn plans (M22b, C19, C71, C78): whether it is a plan turn, the plan fields its prompt
 * names, and its newest plan line with that line's plan, version and outcome.
 */
export interface TurnPlanState {
  readonly plan: boolean;
  readonly fields: PlanFields | null;
  /** Its prompt's text as it is kept: what a new plan's title is drawn from where its text has no heading (C19). */
  readonly prompt: string | null;
  readonly newest: { readonly itemId: string; readonly planId: string; readonly version: number; readonly outcome: PlanOutcome } | null;
}

/** A turn's answer, and the card it asks on (M22e, C43, C49): `answer` null where the turn holds no `final` message of the session's own. */
export interface TurnAnswer {
  readonly answer: { readonly itemId: string; readonly text: string; readonly cut: boolean } | null;
  /** The session's own question card the turn holds, still `open`. */
  readonly card: string | null;
}

/** What a decision keeps of the session grant it sent (M22, C57, C81): `live` is never stored. */
export interface StoredGrant {
  readonly covers: string;
  readonly processKey: string;
}

/**
 * What an outcome writes of an interaction's body (M21, C33): the keys named, and no other. Left
 * out, the outcome stays. `decidedAt`, `delivered` and `grant` are an approval's (M22, C12, C57).
 */
export interface InteractionChange {
  readonly outcome?: InteractionOutcome | ApprovalOutcome | PlanOutcome;
  readonly answers?: readonly (InteractionAnswer | null)[];
  readonly settledAt?: number;
  readonly confirmedAt?: number;
  readonly answeredBy?: string;
  readonly withdrawnBy?: WithdrawnBy;
  readonly decidedAt?: number;
  readonly delivered?: boolean;
  readonly grant?: StoredGrant;
}

/** A session grant as the store answers it for a session's list (M22, C57, C92): of a decision whose reply was delivered. */
export interface StoredGrantRow {
  readonly itemId: string;
  readonly covers: string;
  readonly processKey: string;
  readonly decidedAt: number | null;
  readonly confirmedAt: number | null;
}

/** An item with its turn, as a write answers it. */
export interface StoredItem {
  readonly item: ConversationItem;
  readonly turn: StoredTurn;
}

/** Where an item goes that is not written yet (M19, C14): its turn, and the places it will be stored at. */
export interface ReservedPlace {
  readonly turnId: string;
  readonly order: { readonly turn: number; readonly item: number };
}

export interface PageRows {
  /** Oldest first. */
  readonly items: readonly ConversationItem[];
  /** The turns those items belong to, in stored order. */
  readonly turns: readonly StoredTurn[];
  /** The store holds items before the first of these. */
  readonly older: boolean;
  /** These end with the conversation's newest. */
  readonly latest: boolean;
}

export interface AcceptedPrompt {
  readonly speed?: TurnSpeed | null;
  readonly conversationId: string;
  readonly turnId: string;
  /** The client id the prompt is sent with (C2, C53). */
  readonly itemId: string;
  readonly text: string;
  readonly at: number;
  /** The record says the session had already started: a conversation made now does not hold its start (C18). */
  readonly started: boolean;
  /**
   * The conversation is an aside's (M20b, C28): where it is new, its row is made in this same
   * transaction with its parent, its source and its title, so no aside exists without a question.
   */
  readonly aside?: { readonly parentId: string; readonly source: AsideSource | null; readonly title: string };
  /** fat-g answers the prompt itself, and sends it to no provider (M20b, C35): the turn says so. */
  readonly own?: boolean;
  /**
   * The prompt answers an async question's card (M21, C26, C77): the item, and its answers as they
   * are kept. In the prompt's own transaction the item is checked — the conversation's, `async` and
   * still `open`, else nothing is written and the write fails as `not-open` — and set `answered`,
   * with the id of the turn the prompt starts.
   */
  readonly answering?: { readonly itemId: string; readonly answers: readonly (InteractionAnswer | null)[] };
  /**
   * The chat's mode as main resolves it now (M22, C40, C83): written to the conversation's row only
   * where that holds none yet — a chat whose snapshot could not be made when it was created — and
   * never over a saved one. The turn's own mode is the row's, read in this same transaction.
   */
  readonly mode?: ChatMode | null;
  /** A plan turn (M22b, C1, C71): the turn says so, beside the chat's mode it runs under. */
  readonly plan?: boolean;
  /** A prompt fat-g composed for a plan (M22b, C69): the plan and the version it names, kept on its item. */
  readonly fields?: PlanFields | null;
  /**
   * The decision this prompt carries out (M22b, C12, C15, C65): in the prompt's own transaction the
   * line is checked — the conversation's, a plan's, and still `pending`, else nothing is written and
   * the write fails as `not-pending` — and set to the outcome, with when it was decided.
   */
  readonly deciding?: { readonly itemId: string; readonly outcome: 'feedback' | 'executed' };
  /**
   * The input the prompt is (M23, C21, C56, C86): the session's draft, checked against the images and
   * the revision the page gave and emptied, or a queued message, taken whole from the queue. Its
   * images become the prompt's, as items of the turn after its message, in this same transaction;
   * where the draft's images are not those named, nothing is written and the write fails as
   * `draft-changed`, and a queued message no longer there fails it as `not-queued`. Left out, the
   * prompt has no image and no input is consumed.
   */
  readonly from?: { readonly draft: GivenInput } | { readonly queued: string };
}

/**
 * A message sent into the running turn (M23, C38, C45, C46): written at that turn's next place, after
 * what the model had done by then, its images after it, its input consumed, its delivery `sent`.
 * `answering`: the async card it answers, set `answered` in the same transaction, as a prompt's is.
 */
export interface AcceptedSteer {
  readonly conversationId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly text: string;
  readonly at: number;
  readonly from?: { readonly draft: GivenInput } | { readonly queued: string };
  readonly answering?: { readonly itemId: string; readonly answers: readonly (InteractionAnswer | null)[] };
  /** A command fat-g answers itself (M20b, C35; M23, C41): written with no delivery, since nothing is sent for it. */
  readonly own?: boolean;
}

export type { GivenInput, StagedUse, StoredBlob, StoredDraft, StoredQueued };

/** A write the store could not make. `kind` is what a log may say: never a text or a path. */
export class StorageFailure extends Error {
  constructor(readonly kind: string) {
    super(`conversation store: ${kind}`);
    this.name = 'StorageFailure';
  }
}

export interface ConversationStore extends SearchMessageReader {
  status(): ConversationsStatus;
  /** Told after the status, or the set of conversations and their marks, changed. Returns the function that stops it. */
  subscribe(listener: () => void): () => void;

  // ── A turn, as it happens (Design 4). Each throws when it could not be written. ──
  /**
   * The conversation if it is new, the turn at the next place, and the user's item, in one
   * transaction (C15, C44) — and in it every `open` interaction of the conversation is passed, a
   * later message having been sent (M21, C41): `passed` names them. A prompt that answers a card
   * sets that one `answered` instead (`answering`), and throws `StorageFailure('not-open')`, with
   * nothing written, where the card is no longer open (C77).
   */
  acceptPrompt(prompt: AcceptedPrompt): StoredItem & { readonly passed: readonly string[] };
  /**
   * A message sent into the running turn (M23, C38, C46), in one transaction: the turn must be the
   * conversation's and have no end of the provider's, else nothing is written and the write fails as
   * `turn-over`. Its input is consumed and its card answered as a prompt's are. No card is passed:
   * the turn the cards belong to goes on.
   */
  acceptSteer(steer: AcceptedSteer): StoredItem;
  /** A message's delivery (M23, C38–C44): false where the item is no user message of the conversation. */
  setDelivery(conversationId: string, itemId: string, delivery: DeliveryView): boolean;
  /**
   * A message handed into a turn, moved to the turn it became (M23, C39, C42): a turn of that id at the
   * conversation's next place, accepted now, with the message and its images moved into it, in one
   * transaction. A turn already holding the id answers it as it is.
   */
  moveToTurn(conversationId: string, itemId: string, turnId: string, at: number, speed?: TurnSpeed | null): StoredItem;
  /**
   * The provider took the prompt, and named the turn (C47). In the same transaction the interaction
   * that prompt answered — `answered`, its `answeredBy` naming the turn, with no mark yet — takes
   * its mark (M21, C68): its id is answered, or null where the turn answered none.
   */
  providerTook(conversationId: string, turnId: string, providerTurnId: string | null): string | null;
  /** Once: a reference the conversation already has is never replaced (C28). */
  setReference(conversationId: string, reference: string, folder: string, configFolder: string | null): void;
  /** The provider's id for a stored item, once known (M15, C56). False when the item is not held or has one. */
  setProviderItemId(conversationId: string, itemId: string, providerItemId: string): boolean;
  /**
   * One item at the end of a turn — the turn named, or the conversation's newest (a notice with no
   * turn still has one). Null when the turn already holds the provider's item (C20). Throws
   * `StorageFailure('no-turn')` when there is no turn to hold it.
   *
   * `asking` (M21, C33): the question the message carries, as an item of its own directly after it,
   * in the same transaction, so that neither is stored without the other. `interaction` is that
   * item, or null where none was asked or the turn already holds one for the message.
   */
  addItem(conversationId: string, turnId: string | null, item: NewItem, asking?: NewInteraction): (StoredItem & { readonly interaction: ConversationItem | null }) | null;
  /** A returned image uses the existing message/attachment/blob representation, atomically. */
  saveReturnedImage(conversationId: string, place: ReservedPlace, item: NewItem, image?: StoredBlob): 'stored' | 'duplicate' | 'limit';
  /**
   * The next place in a turn — the turn named, or the conversation's newest — kept for an item that
   * is not written yet (M19, C14): a message that has opened and has no text. Nothing is written.
   * Every later item of the turn takes a later place, whether or not the reserved one is ever
   * stored, so the order messages began in is kept. Held in memory, for the run. Throws
   * `StorageFailure('no-turn')` when there is no turn to hold it.
   */
  reserveItem(conversationId: string, turnId: string | null): ReservedPlace;
  /**
   * The text so far of a message still being written, with its cut flag (M19, C16, C64): an update
   * of those two keys of its body, in one transaction — or, where no row exists yet, the item's
   * insert at its reserved place, as incomplete. A row that is complete is left as it is.
   */
  saveProgress(conversationId: string, place: ReservedPlace, item: NewItem): void;
  /**
   * The whole message, for one that was opened (M19, C17): in one transaction its text replaces what
   * was written, with its cut flag, its phase and its questions, and it is complete — an update of
   * its body's named keys, never a delete and an insert — or, where no row exists because every
   * earlier write failed, the item's insert at its reserved place. `asking`: as `addItem` has it.
   */
  completeItem(conversationId: string, place: ReservedPlace, item: NewItem, asking?: NewInteraction): StoredItem & { readonly interaction: ConversationItem | null };
  /**
   * The provider's end (C54): once. `answerItemId` (M16, C74): the provider's id of the message that
   * is the turn's answer, from a provider that labels no phase as its messages arrive. That item's
   * phase is set to `final` in the same transaction, by an update of that one key of its body: fat-g
   * killed at any point leaves both writes or neither. `elapsedMs` (M19, C44): fat-g's own measure of
   * the turn, stored with the end.
   */
  providerEnded(conversationId: string, turnId: string, outcome: ReportedOutcome, at: number, answerItemId?: string | null, elapsedMs?: number | null): void;
  /** The session's end (C54). False when the store has no such turn: nothing changes. */
  sessionEnded(conversationId: string, turnId: string, at: number, outcome: TurnOutcome): boolean;

  // ── What a session does (M20a, Design 6). Each throws when it could not be written. ──
  /**
   * An activity at its start, at the end of the turn named or of the newest, in one transaction as
   * any item is (C29) — or, for a provider item id the turn already holds as that owner's activity,
   * its body's named keys replaced by what this start says, which is a checklist's each update and
   * how a worker item learns its worker (C59). `opened` says which. Throws
   * `StorageFailure('no-turn')` when there is no turn to hold it.
   */
  addActivity(conversationId: string, turnId: string | null, activity: NewActivity): { readonly item: ConversationItem; readonly turn: StoredTurn; readonly opened: boolean };
  /**
   * An activity's end (C29): an update of its body's named keys, never a delete and an insert, so
   * whatever else the body holds stays (M18, C38). One that is already ended takes what this end
   * says too: a completion that comes after its turn's end still ends it (C6). Null when the turn
   * holds no such activity.
   */
  endActivity(conversationId: string, turnId: string, key: ActivityKey, end: ActivityEnd): { readonly item: ConversationItem; readonly turn: StoredTurn } | null;
  /**
   * What an end leaves of the activities that were still open (C29), each by its id: `unfinished`
   * with what it has, or — a checklist — `completed`. One transaction; an item that has ended
   * meanwhile is left as it is. Answers how many changed.
   */
  settleActivities(conversationId: string, items: readonly { readonly id: string; readonly status: 'unfinished' | 'completed' }[]): number;
  /** Something of the turn could not be saved (C19). */
  markGap(conversationId: string, turnId: string): void;

  // ── What a session asks (M21, Design 5). Each throws when it could not be written. ──
  /**
   * A question at its raising (C33), at the end of the turn named or of the newest, in one
   * transaction as any item is. Null when the turn already holds an interaction of that owner under
   * the provider's id: a question stands once (C6). Throws `StorageFailure('no-turn')` when there is
   * no turn to hold it.
   */
  addInteraction(conversationId: string, turnId: string | null, interaction: NewInteraction | NewApproval): StoredItem | null;
  /**
   * An outcome (C33, C77): an update of the body's named keys, and only where the stored outcome is
   * `from` — `pending` for a blocking item's, `open` for an async one's, `answered` for the mark and
   * for an answer its process could not take — so no settled outcome is written over. Whatever else
   * the body holds stays (M18, C38). Null when no row changed.
   */
  setInteraction(conversationId: string, itemId: string, from: Outcome | readonly Outcome[], change: InteractionChange): StoredItem | null;
  /**
   * A plan's feedback its request takes (the maintainer): the line's change where its
   * outcome is `pending`, and the feedback as it is sent, a message of the user's at the end of the
   * line's turn naming the line's version to revise, in one transaction. Null when the line was not pending.
   */
  setPlanFeedback(conversationId: string, itemId: string, change: InteractionChange, prompt: { readonly id: string; readonly text: string; readonly at: number }): { readonly line: StoredItem; readonly prompt: StoredItem } | null;
  /** The same change to several items, each still `pending`, in one transaction (C33): an end's sweep. Answers those that changed. */
  settlePending(conversationId: string, itemIds: readonly string[], change: InteractionChange): readonly StoredItem[];
  /**
   * The async cards the model went on past, at its turn's end (decision 0026, item 11): every `open`
   * question card of the session's own in the turn after which the session's own model wrote a
   * message with text, or a plan's line, in that turn. Each is `passed`, in one transaction. A card
   * that is the turn's last word stays open: the model ended its turn on it. Answers those that changed.
   */
  passGonePast(conversationId: string, turnId: string, at: number): readonly StoredItem[];
  /** One item with its turn, as a page would answer it. Null for an id the conversation does not hold. */
  item(conversationId: string, itemId: string): StoredItem | null;

  // ── Plans (M22b, Design 3). Each throws when it could not be written. ──
  /**
   * A plan's line at the end of the turn named (C10, C14, C17), in one transaction as any item is.
   * Throws `StorageFailure('no-turn')` when there is no turn to hold it.
   */
  addPlan(conversationId: string, turnId: string, plan: NewPlan): StoredItem;
  /**
   * A plan brought into the chat (C64, C76): in one transaction its conversation's row where it is
   * new — `started` as a prompt's acceptance has it — a turn of fat-g's own at the next place, ended
   * at once and sent to no provider, and the plan's line in it.
   */
  bringPlan(conversationId: string, at: { readonly turnId: string; readonly at: number; readonly started: boolean }, plan: NewPlan): StoredItem;
  /** Every plan's line that waits for its decision (C56, C58, C73), as the store holds it: a request's among them, which only its registry can say is live. */
  pendingPlans(): readonly PendingPlanRow[];
  /** The chats whose line on this plan waits (C73). */
  planWaiters(planId: string): readonly PendingPlanRow[];
  /** A plan turn of fat-g's ran in this conversation (C55). */
  plannedBefore(conversationId: string): boolean;
  /** What a turn plans (C19, C71, C78). Null for a turn the store does not hold. */
  turnPlan(conversationId: string, turnId: string): TurnPlanState | null;
  /**
   * A turn's answer as a review reads it (M22e, C43, C49): the turn's last message of the session's
   * own — no worker's — whose role is `assistant` and whose phase is `final`, by fat-g's item id, with
   * its text as kept; and the session's own question card the turn still holds open, where it holds
   * one. Null for a turn the store does not hold.
   */
  turnAnswer(conversationId: string, turnId: string): TurnAnswer | null;
  /** At launch (C59, C74): every line an earlier run left `writing` is `unfinished`, since its plan was never completed. Answers how many. */
  unfinishPlans(at: number): number;
  /** Where a plan the chat took part in was implemented (decision 0029); null for none, or a row the store does not hold. */
  planNote(conversationId: string): PlanNote | null;
  /** Writes it, or — null — clears it. A conversation the store does not hold is left without one. */
  setPlanNote(conversationId: string, note: PlanNote | null): void;

  // ── Reads ──
  conversation(id: string): StoredConversation | null;
  turn(conversationId: string, turnId: string): StoredTurn | null;
  /** The newest turn fat-g ran itself (C29). */
  lastLocalTurn(conversationId: string): StoredTurn | null;
  /**
   * The provider's own id of the newest turn whose end the provider reported, whatever its outcome
   * (M20b, C19): never a turn in flight, nor one whose end was lost. Null while no turn has one.
   */
  lastReportedTurn(conversationId: string): string | null;
  /** A conversation's asides, oldest first, as its read lists them (M20b, C30): one a removal has marked is left out. */
  asides(parentId: string): readonly StoredAsideMarker[];
  /** One aside, with what it was asked about (M20b, C29, C31). Null for an id that is no aside's. */
  aside(id: string): StoredAside | null;
  newestPage(conversationId: string): PageRows;
  /** The page before the item `before`; null for a cursor the store does not have (C20). */
  pageBefore(conversationId: string, before: string): PageRows | null;
  /** From the item `from` on, within the window's bounds (C60); null when the store does not have it. */
  window(conversationId: string, from: string, keep: 'newest' | 'oldest'): PageRows | null;
  /**
   * A worker's items (M20a, C32), which are in none of the reads above: its newest window, or —
   * `before` — the page before that item, each bounded as the session's are. Null for a cursor the
   * store does not have among that worker's items.
   */
  workerItems(conversationId: string, workerId: string, before?: string): PageRows | null;
  /** The session's own item that started the worker (C23): the one whose body names it. Null when the store holds none. */
  workerItem(conversationId: string, workerId: string): ConversationItem | null;
  /**
   * The sub-agents a session started, newest first, at most `limit` (M106, C26): its own worker items
   * that name their worker, each as the list at launch shows it — its line, how it ended, its model and
   * agent definition, and its start and end by one rule (`listedWorker`).
   */
  workers(conversationId: string, limit: number): readonly ListedWorker[];

  // ── History (Design 6) ──
  /** Makes the conversation's row if it has none, for a session the record says had started (C33). */
  ensure(conversationId: string, at: number): void;
  /**
   * A new session's conversation, made with the session (M22, C40): its row, with the chat's mode
   * and where it came from — the snapshot a later change of a default never touches. It holds the
   * conversation's start, since nothing was said before it. A conversation that exists is left as
   * it is. Null for a provider that declares no mode: the row is made all the same.
   */
  createConversation(conversationId: string, at: number, mode: ChatMode | null): void;
  /**
   * The chat's mode, chosen in the chat (M22, C40, C75): written to its row with the source `chat`,
   * and nothing else. A conversation the store does not hold yet is made for it — `started`: the
   * record says the session had started, so the row does not hold its start (C18).
   */
  setMode(conversationId: string, mode: string, at: number, started: boolean): void;
  /** A draft has no turn, child conversation, provider reference or queued message. */
  draftOnly(conversationId: string): boolean;
  /** Rebind a draft's permission choice without changing any of its text or images. */
  setDraftMode(conversationId: string, mode: ChatMode | null, at: number): void;
  /**
   * The session grants fat-g sent in a conversation (M22, C57, C92), oldest first: the approvals
   * decided for the session whose reply was delivered, a worker's among them. One written and not
   * delivered, or whose delivery was never known, is not among them.
   */
  grants(conversationId: string): readonly StoredGrantRow[];
  held(conversationId: string): Held;
  /**
   * One page of the merge, in one transaction: `plans` newest first. A new turn goes directly before
   * `anchor`, the nearest newer turn both sides hold, or last (C49). Answers the anchor for the next
   * older page, and whether anything was written.
   *
   * `cards` (M21, C28, C41): the provider asks questions in its messages. A message the merge adds,
   * or completes from a partial one, that carries questions then gets an interaction item directly
   * after it, in the same transaction — `passed` where any turn stands after its own in the stored
   * order, a local one the provider never acknowledged among them, and `open` otherwise; none where
   * its turn already holds one for the message. A turn the merge adds passes every `open`
   * interaction of an earlier place. An item that exists keeps its outcome.
   */
  mergePage(conversationId: string, plans: readonly TurnPlan[], anchor: string | null, notShownText: string, cards?: boolean): { readonly anchor: string | null; readonly changed: boolean };
  /** A check's marks, once, at its end (C61). */
  markReached(conversationId: string, providerTurnIds: readonly string[], reachedStart: boolean): void;

  // ── Removal (Design 9). A conversation's asides go with it (M20b, C32, C71). ──
  /** Marks these conversations, and every aside of each. */
  markRemoving(ids: readonly string[]): void;
  /** Lifts the marks of these conversations, and of every aside of each. */
  liftRemoving(ids: readonly string[]): void;
  /** Deletes the marked conversations among `ids`, whole, each with its asides, then folds the log in and empties it (C62). */
  deleteRemoving(ids: readonly string[]): void;
  /** The conversations a removal has marked: an aside is named only where its parent is not marked, as one removed alone. */
  removing(): readonly string[];

  // ── The composer (M23, Design 1, 2, 5, 7). Each write throws when it could not be made: a
  //    `StorageFailure` of the operation's own kind — `too-many`, `too-large`, `full`, `empty`,
  //    `draft-changed`, `unknown-entry`, `unknown-attachment` — with nothing of it written. ──
  /** An image the store names (C5), by its hash; null for one it names not. */
  blob(hash: string): StoredBlob | null;
  /** A session's draft (C31): null while it has none. */
  draft(sessionId: string): StoredDraft | null;
  /** A session's queued messages, oldest first (C47). */
  queue(sessionId: string): readonly StoredQueued[];
  /**
   * The draft's text and intent at a revision above the one held (C31, C86), its conversation's row
   * made with it where there is none — `started` as an acceptance has it. False where the revision is
   * late: nothing changed.
   */
  saveDraft(sessionId: string, revision: number, value: { readonly text: string; readonly intent: PromptIntent }, at: number, started: boolean): boolean;
  /** An image put last in the draft (C14), within its bounds (C2): answers its saved name, numbered for a paste. */
  stageDraft(sessionId: string, blob: StoredBlob, use: { readonly id: string; readonly name: string | null }, at: number, started: boolean): string;
  /** A use taken out of the draft (C16): false for one the draft does not hold. Its image goes with its last use (C6). */
  removeDraftAttachment(sessionId: string, useId: string, at: number): boolean;
  /** The draft emptied at a revision (C32), its images released. */
  clearDraft(sessionId: string, revision: number, at: number): void;
  /**
   * Queue next (C47, C48): the draft as given appended, its images with it, the draft emptied. With
   * `index`, put among the entries at that place instead — a held Send now, ahead of what was queued.
   */
  enqueue(sessionId: string, entryId: string, given: GivenInput, at: number, started: boolean, index?: number): void;
  /** Edit (C50): the entry's input into the draft, the draft as given into the entry's place, or the slot gone for an empty draft. */
  editQueued(sessionId: string, entryId: string, given: GivenInput, at: number): void;
  /** A queued message removed (C50), its images released: false for one the session's queue does not hold. */
  unqueue(sessionId: string, entryId: string): boolean;
  /** The session's queue in the order named, which names each of its entries once (C51, C86). */
  reorderQueue(sessionId: string, ids: readonly string[]): void;
  /** Every queued message of the session removed (C82), their images released. */
  dropQueue(sessionId: string): void;
  /** The sessions with a draft that holds something, or a queued message (C83): ids alone. */
  withContent(): readonly string[];
  /** The sessions with a queued message (C52). */
  queued(): readonly string[];
  /** The active images' folder, counted and measured (C12); null where it could not be. */
  attachmentsSize(): { readonly count: number; readonly bytes: number } | null;

  // ── Detached conversations, and sizes (Design 8) ──
  /** Every conversation, an aside's among them, each with its parent (M20b, C71). */
  conversations(): readonly { readonly id: string; readonly removing: boolean; readonly createdAt: number; readonly parentId: string | null }[];
  /** The text of the conversation's first prompt, or null. */
  firstPrompt(conversationId: string): string | null;
  /**
   * Whether the conversation holds a prompt of the user's with text, in a turn a provider was sent
   * (M23, C28): what tells the first prompt that names a session after prompts of images alone.
   */
  hasTextPrompt(conversationId: string): boolean;
  /** The size of these conversations' content, their asides' with them, in UTF-16 units. */
  textUnits(ids: readonly string[]): number;
  readonly files: Pick<StoreFiles, 'totalSize' | 'setAside' | 'removeSetAside'>;

  // ── Lifecycle ──
  /** Synchronous, and safe to call twice. After it every write is a storage failure. */
  close(): void;
  /** For a refused store only: its files are moved aside together, and a new store is opened (C33, C40). */
  startFresh(): Promise<StartFreshResult>;
}

export interface ConversationStoreOptions {
  readonly dir: string;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** The format this build reads and writes; tests raise it to see an older store refused. */
  readonly version?: number;
  /** Left out in the app, where every commit waits for the disk (C56). A test that writes thousands of rows says `OFF`. */
  readonly synchronous?: Synchronous;
  readonly log?: Pick<Console, 'info' | 'warn' | 'error'>;
  readonly files?: StoreFiles;
  /** The active images' folder (M23): left out, `attachments/` of `dir`. */
  readonly blobs?: BlobFiles;
  /**
   * Called inside each transaction, before its commit, with the transaction's name: a test throws
   * from it to make the write fail, or stops in it to be killed there.
   */
  readonly hook?: (point: string) => void;
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const flag = (value: unknown): boolean => value === 1;
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null => (typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null);
/** A mode's id as a row holds it (M22, C25): anything that is no id reads as none. */
const modeId = (value: unknown): string | null => (isModeId(value) ? value : null);
/** A chat's mode as its row holds it: both columns, or none. A source this build does not know reads as the chat's own. */
const chatMode = (mode: unknown, source: unknown): ChatMode | null => { const id = modeId(mode); return id === null ? null : { id, source: isModeSource(source) ? source : 'chat' }; };

const TURN_COLUMNS = 'id, conversationId, place, origin, providerTurnId, acceptedAt, providerTook, providerStartedAt, providerEndedAt, endReceivedAt, providerOutcome, providerDurationMs, elapsedMs, sessionEndedAt, sessionOutcome, reached, gap, own, mode, plan, extra';
const TURN_COLUMNS_OF_T = TURN_COLUMNS.split(', ').map((column) => `t.${column} AS ${column}`).join(', ');
const ITEM_COLUMNS = 'i.id AS id, i.conversationId AS conversationId, i.turnId AS turnId, i.place AS itemPlace, i.kind AS kind, i.origin AS origin, i.providerItemId AS providerItemId, i.workerId AS workerId, i.receivedAt AS receivedAt, i.providerAt AS providerAt, i.body AS body, t.place AS turnPlace';
/** The turn first, so SQLite walks the turns by place and each turn's items by place: no sort (C17). */
const ITEMS_FROM = 'FROM turn t CROSS JOIN item i ON i.turnId = t.id';
/**
 * The session's own items: what its pages and its window hold (M20a, C31). A sent message's use of an
 * image is in none of them as an item: it is folded into its message (M23, C26).
 */
const OWN = "i.workerId IS NULL AND i.kind <> 'attachment'";
/** How many of a conversation's newest turns are looked in for the item that started a worker which has no item of its own yet. */
const WORKER_ITEM_TURNS = 8;
/** The session's own worker items that name their worker (M106, C26): a scan of its items no index serves, run once a launch. */
const WORKER_ITEMS = "i.conversationId = ? AND i.kind = 'activity' AND i.workerId IS NULL AND json_extract(i.body, '$.activity.type') = 'worker' AND json_extract(i.body, '$.activity.workerId') IS NOT NULL";

/**
 * A worker item as the list at launch shows its sub-agent (M106, C26), or null for one that names no
 * worker an event could, or has no time at all. The store writes no end for a worker item, so its
 * times follow one rule: it started when it was received, else when the provider says, else when its
 * turn was accepted; it ended its duration later, else — left unfinished by a quit, or never settled —
 * when its turn ended for the session or the provider, else never. It completed, or else it failed
 * (M14, C75). A model is kept where it is a catalog id.
 */
function listedWorker(row: Row): ListedWorker | null {
  const activity = readBody(row['body']).activity;
  const workerId = activity?.workerId ?? null;
  if (activity === null || workerId === null || workerId === '' || workerId.length > 256 || /\p{Cc}/u.test(workerId)) return null;
  const startedAt = integer(row['receivedAt']) ?? integer(row['providerAt']) ?? integer(row['acceptedAt']);
  if (startedAt === null || startedAt < 0) return null;
  const finishedAt = activity.duration !== null ? startedAt + activity.duration.ms : integer(row['sessionEndedAt']) ?? integer(row['endReceivedAt']);
  return {
    workerId,
    label: cutTo(activity.summary, MAX_LINE_INPUT).text,
    status: activity.status === 'completed' ? 'completed' : 'failed',
    model: activity.model === null ? null : catalogId(activity.model),
    agentType: activity.agentType === null ? null : cutTo(activity.agentType, MAX_LINE_INPUT).text,
    startedAt,
    finishedAt: finishedAt === null ? null : Math.max(startedAt, finishedAt),
  };
}

function readTurnSpeed(raw: unknown): { speed?: TurnSpeed | null } {
  try {
    const extra = JSON.parse(String(raw)) as Record<string, unknown> | null;
    if (extra?.['speed'] === null) return { speed: null };
    const result = TurnSpeedSchema.safeParse(extra?.['speed']);
    return result.success ? { speed: result.data } : {};
  } catch { return {}; }
}

function toTurn(row: Row): StoredTurn {
  return {
    id: String(row['id']),
    conversationId: String(row['conversationId']),
    place: integer(row['place']) ?? 0,
    origin: row['origin'] === 'provider' ? 'provider' : 'local',
    providerTurnId: text(row['providerTurnId']),
    acceptedAt: integer(row['acceptedAt']),
    providerTook: flag(row['providerTook']),
    providerStartedAt: integer(row['providerStartedAt']),
    providerEndedAt: integer(row['providerEndedAt']),
    endReceivedAt: integer(row['endReceivedAt']),
    providerOutcome: oneOf(REPORTED_OUTCOMES, row['providerOutcome']),
    providerDurationMs: integer(row['providerDurationMs']),
    elapsedMs: integer(row['elapsedMs']),
    sessionEndedAt: integer(row['sessionEndedAt']),
    sessionOutcome: oneOf(TURN_OUTCOMES, row['sessionOutcome']),
    reached: flag(row['reached']),
    gap: flag(row['gap']),
    own: flag(row['own']),
    mode: modeId(row['mode']),
    plan: flag(row['plan']),
    ...readTurnSpeed(row['extra']),
  };
}

interface Body {
  readonly role: 'user' | 'assistant' | null;
  readonly phase: MessagePhase | null;
  readonly blocks: readonly TextBlock[];
  readonly questions: readonly AgentQuestion[];
  readonly notice: ChatNoticeKind | null;
  readonly detail: string | null;
  /** False for a message whose whole text never arrived (M19, C15). A body without the key is complete. */
  readonly complete: boolean;
  /** An activity's own fields (M20a, C28); null for every other kind. */
  readonly activity: ActivityBody | null;
  /** An interaction's own fields (M21, C32); null for every other kind. */
  readonly interaction: InteractionBody | null;
  /** The model that wrote a message, where its provider named one (M20b, C28). A body without the key names none. */
  readonly model: string | null;
  /** A prompt's plan fields (M22b, C69). A body without the key names none. */
  readonly plan: PlanFields | null;
  /** What became of a message sent into a running turn (M23, C38). A body without the key was no such message. */
  readonly delivery: DeliveryView | null;
  readonly fromQueue?: boolean;
}

const EMPTY_BODY: Body = { role: null, phase: null, blocks: [], questions: [], notice: null, detail: null, complete: true, activity: null, interaction: null, model: null, plan: null, delivery: null };

/** A delivery as a body holds it (M23, C38): a state this build knows, and the CLI's word, bounded; anything else reads as none. */
function readDelivery(value: unknown): DeliveryView | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Row;
  const state = oneOf(DELIVERY_STATES, entry['state']);
  return state === null ? null : { state, detail: typeof entry['detail'] === 'string' ? cutTo(entry['detail'], MAX_NOTICE_DETAIL).text : null };
}

/** A model's key as an event may carry it (agent-events.ts): anything else in a body reads as none. */
const modelKey = (value: unknown): string | null => (typeof value === 'string' && value.length >= 1 && value.length <= 128 && !/\p{Cc}/u.test(value) ? value : null);

/** What this build reads of a body: the keys it knows, each checked. Anything else in it is left where it is. */
function readBody(raw: unknown): Body {
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw)) as unknown; } catch { return EMPTY_BODY; }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_BODY;
  const body = parsed as Row;
  const blocks = Array.isArray(body['blocks']) ? body['blocks'].flatMap((block: unknown): TextBlock[] => {
    const entry = block as Row | null;
    return typeof entry === 'object' && entry !== null && entry['type'] === 'text' && typeof entry['text'] === 'string' ? [{ type: 'text', text: entry['text'], cut: entry['cut'] === true }] : [];
  }) : [];
  const questions = Array.isArray(body['questions']) ? body['questions'].flatMap((question: unknown): AgentQuestion[] => {
    const entry = question as Row | null;
    if (typeof entry !== 'object' || entry === null || typeof entry['title'] !== 'string') return [];
    return [{ title: entry['title'], options: Array.isArray(entry['options']) ? entry['options'].filter((option): option is string => typeof option === 'string') : [] }];
  }) : [];
  return {
    role: body['role'] === 'user' || body['role'] === 'assistant' ? body['role'] : null,
    phase: oneOf(MESSAGE_PHASES, body['phase']),
    blocks,
    questions,
    notice: oneOf(CHAT_NOTICE_KINDS, body['notice']),
    detail: text(body['detail']),
    complete: body['complete'] !== false,
    activity: readActivity(body['activity']),
    interaction: readInteraction(body['interaction']),
    model: modelKey(body['model']),
    plan: readPlanFields(body['plan']),
    delivery: readDelivery(body['delivery']),
    ...(body['fromQueue'] === true ? { fromQueue: true } : {}),
  };
}

/** An aside's source as its row holds it: checked against its schema, and null for anything else. */
function readSource(raw: unknown): AsideSource | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = AsideSourceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const titleOf = (raw: unknown): string => (typeof raw === 'string' && raw !== '' ? cutTo(raw, MAX_ASIDE_TITLE).text : NEW_ASIDE_TITLE);

/**
 * The store knows nothing that runs (M20a, C29): an activity whose end is not stored reads
 * `unfinished`, as a message whose whole text is not stored reads partial, and whoever holds it open
 * says that it is running. So a store left by a crash claims nothing it cannot know.
 */
const asStored = (activity: ActivityBody | null): ActivityBody | null => (activity !== null && activity.status === 'running' ? { ...activity, status: 'unfinished' } : activity);

/**
 * Nor any request that lives (M21, C61): a blocking question whose outcome is not stored reads
 * `dropped`, and whoever holds its request pending says that it is. So a card an earlier run left
 * pending — after a kill or a crash, where no end ran — comes back inert, and is never answered.
 */
const asStoredInteraction = (interaction: InteractionBody | null): InteractionBody | null => (interaction !== null && interaction.outcome === 'pending' && (interaction.kind !== 'plan' || interaction.request) ? { ...interaction, outcome: 'dropped' } : interaction);
// A plan's line with no request behind it is the store's to say (M22b, C27, C56): a plan item's, and
// a brought one's, wait across a restart. A request's reads `dropped`, as any request's does.
// An approval's stored `pending` reads `dropped` by the same rule (M22, C49, C79), and its grant
// reads ended as `readApproval` gives it: nothing restored can be decided, and none is live.

function toItem(row: Row): ConversationItem {
  // A kind this build does not know reads as a reserved one, never as one that is drawn (M20a, C28).
  const kind = isItemKind(row['kind']) ? row['kind'] : RESERVED_ITEM_KINDS[0];
  // A reserved kind is kept and returned as a kind alone: nothing of it is drawn (C3, C12).
  const { complete, activity, interaction, model, plan, delivery, fromQueue, ...body } = (ITEM_KINDS as readonly string[]).includes(kind) ? readBody(row['body']) : EMPTY_BODY;
  const sentNow = kind === 'message' && body.role === 'user' ? delivery : null;
  return {
    id: String(row['id']),
    conversationId: String(row['conversationId']),
    turnId: String(row['turnId']),
    order: { turn: integer(row['turnPlace']) ?? 0, item: integer(row['itemPlace']) ?? 0 },
    kind,
    origin: row['origin'] === 'provider' ? 'provider' : 'local',
    providerItemId: text(row['providerItemId']),
    workerId: text(row['workerId']),
    activity: kind === 'activity' ? asStored(activity) : null,
    interaction: kind === 'interaction' ? asStoredInteraction(interaction) : null,
    ...body,
    model: kind === 'message' ? model : null,
    plan: kind === 'message' ? plan : null,
    // Only on a message sent into a running turn (M23, C38): every other body is as it was.
    ...(sentNow === null ? {} : { delivery: sentNow }),
    ...(kind === 'message' && body.role === 'user' && fromQueue === true ? { fromQueue: true } : {}),
    // The store knows no turn in flight: what is not complete reads partial, and whoever holds the
    // message open says that it is streaming (M19, C15).
    state: complete ? 'complete' : 'partial',
    time: { receivedAt: integer(row['receivedAt']), providerAt: integer(row['providerAt']) },
  };
}

/** The store cuts on the way in what an adapter did not (C17). */
function bodyOf(item: Pick<NewItem, 'role' | 'phase' | 'text' | 'cut' | 'questions' | 'notice' | 'detail' | 'complete' | 'model' | 'plan' | 'delivery' | 'fromQueue'>): string {
  const cut = cutTo(item.text, MAX_MESSAGE_TEXT);
  const model = modelKey(item.model);
  const body: Omit<Body, 'activity' | 'interaction' | 'model' | 'plan' | 'delivery'> & { model?: string; plan?: PlanFields; delivery?: DeliveryView } = {
    role: item.role,
    phase: item.phase,
    blocks: [{ type: 'text', text: cut.text, cut: item.cut || cut.cut }],
    questions: item.questions,
    notice: item.notice,
    detail: item.detail === null ? null : cutTo(item.detail, MAX_NOTICE_DETAIL).text,
    complete: item.complete !== false,
    // Only where one is named (M20b, C28): every other body is as it was.
    ...(model === null ? {} : { model }),
    // Only on a prompt composed for a plan (M22b, C69).
    ...(item.plan == null ? {} : { plan: item.plan }),
    // Only on a message sent into a running turn (M23, C38).
    ...(item.delivery == null ? {} : { delivery: item.delivery }),
    ...(item.role === 'user' && item.fromQueue === true ? { fromQueue: true } : {}),
  };
  return JSON.stringify(body);
}

/** What a stored outcome may be: a question's, an approval's or a plan's line's. */
type Outcome = InteractionOutcome | ApprovalOutcome | PlanOutcome;

/** A flag as `json_set` takes it: a JSON boolean, never a number. */
const jsonFlag = (value: boolean): string => (value ? 'true' : 'false');

/** The keys of an activity's body this build writes (M20a, C29): each is set by name, and any other the body holds is left where it is. */
const ACTIVITY_KEYS = ['type', 'name', 'summary', 'input', 'output', 'files', 'status', 'exitCode', 'changes', 'steps', 'thinking', 'workerId', 'duration', 'cut', 'declinedBy', 'model', 'agentType'] as const satisfies readonly (keyof ActivityBody)[];
const SET_ACTIVITY = `json_set(body, ${ACTIVITY_KEYS.map((key) => `'$.activity.${key}', json(?)`).join(', ')}, '$.complete', json(?))`;
const activityValues = (body: ActivityBody): string[] => [...ACTIVITY_KEYS.map((key) => JSON.stringify(body[key])), jsonFlag(isEnded(body.status))];
/** An activity's body as a new row holds it: its fields under their own key, and whether its end has come (C28). */
const activityJson = (body: ActivityBody): string => JSON.stringify({ activity: body, complete: isEnded(body.status) });

/** The keys of an interaction's body an outcome may write (M21, C33): each is set by name, and any other the body holds is left where it is. */
const INTERACTION_KEYS = ['outcome', 'answers', 'settledAt', 'confirmedAt', 'answeredBy', 'withdrawnBy', 'decidedAt', 'delivered', 'grant'] as const satisfies readonly (keyof InteractionChange)[];
/** An interaction's body as a new row holds it: its fields under their own key (C32). */
const interactionJson = (body: InteractionBody): string => JSON.stringify({ interaction: body });
const OUTCOME = "json_extract(body, '$.interaction.outcome')";

/** A provider's history activity as the two things an item is made of: what its start said, and its end (M20a, C19). */
function fromHistoryActivity(activity: HistoryActivity): { readonly start: ActivityStart; readonly end: ActivityEnd } {
  return {
    start: { type: activity.activityType, name: activity.name, summary: activity.summary, input: activity.input ?? null, files: activity.files ?? [], changes: activity.changes ?? [], steps: activity.steps ?? [], thinking: activity.thinking ?? null, cut: activity.cut ?? null },
    end: {
      status: activity.status,
      ...(activity.output === undefined ? {} : { output: activity.output }),
      ...(activity.exitCode === undefined ? {} : { exitCode: activity.exitCode }),
      ...(activity.declinedBy === undefined ? {} : { declinedBy: activity.declinedBy }),
      // The provider's own, a zero included (C7): none is measured for an item fat-g did not see run.
      ...(activity.durationMs === undefined ? {} : { duration: { ms: activity.durationMs, provenance: 'provider' as const } }),
    },
  };
}

const marks = (count: number): string => Array.from({ length: count }, () => '?').join(', ');

/** A waiting plan's line as a query answers it (M22b, C56): one whose body cannot be read is none. */
function pendingRow(row: Row): PendingPlanRow[] {
  const body = readBody(row['body']).interaction;
  return body === null || body.kind !== 'plan' ? [] : [{ conversationId: String(row['conversationId']), itemId: String(row['id']), planId: body.planId, version: body.version, request: body.request }];
}

// ── The store ─────────────────────────────────────────────────────────────────────────────────

type State = { readonly kind: 'open'; readonly db: DatabaseSync } | { readonly kind: 'refused'; readonly cause: Extract<ConversationsStatus, { kind: 'refused' }>['cause'] } | { readonly kind: 'closed' };

export function createConversationStore(options: ConversationStoreOptions): ConversationStore {
  const { dir, now = Date.now, newId = () => crypto.randomUUID(), version = CONVERSATIONS_VERSION, log = console, hook } = options;
  const files = options.files ?? createStoreFiles(dir);
  const blobs = options.blobs ?? createBlobFiles(path.join(dir, ATTACHMENTS_FOLDER));
  const listeners = new Set<() => void>();
  const searchListeners = new Set<(change: SearchChange) => void>();
  let changedItems = new Set<string>();
  let changedConversations = new Set<string>();
  let statements = new Map<string, StatementSync>();
  let startingFresh: Promise<StartFreshResult> | null = null;
  /** The highest place kept in a turn for an item not written yet (M19, C14): for the run. */
  let reserved = new Map<string, number>();
  let state: State = open();

  /** A row an activity is found by, with its body as it is stored. */
  interface ActivityRow { readonly id: string; readonly body: ActivityBody }

  function open(): State {
    let size: number | null;
    try {
      files.ensureFolder();
      // A generation's move a crash cut short is finished before anything is opened (M23, C84): until
      // it is, no store is made and no images' folder is swept.
      if (files.settleMove() === 'failed') {
        log.warn('[conversations] a Start fresh could not be finished; the store is left as it is');
        return { kind: 'refused', cause: 'unreadable' };
      }
      size = files.mainSize();
    } catch (error) {
      log.warn(`[conversations] could not be opened (${errorKind(error)}); the store is left as it is`);
      return { kind: 'refused', cause: 'unreadable' };
    }
    const opened = openStore(files.file, size, version, options.synchronous);
    if (opened.kind === 'refused') {
      log.warn(`[conversations] refused: ${opened.cause}; the store is left as it is`);
      return opened;
    }
    // Counts only: never a text, a reference or a folder (C24).
    const count = integer((opened.db.prepare('SELECT count(*) AS n FROM conversation').get() as Row | undefined)?.['n']) ?? 0;
    log.info(`[conversations] ${opened.created ? 'made a new store' : `opened, ${count} ${count === 1 ? 'conversation' : 'conversations'}`}`);
    // The images no row names (M23, C6): what a crash left before its commit, a temporary file of a
    // write it cut short, and a file whose unlink did not finish. Only a store this build reads names
    // them, so only now (C84).
    const swept = blobs.sweep((hash, mediaType) => opened.db.prepare('SELECT 1 AS found FROM blob WHERE hash = ? AND mediaType = ?').get(hash, mediaType) !== undefined);
    if (swept > 0) log.info(`[conversations] removed ${swept} ${swept === 1 ? 'image' : 'images'} no conversation names`);
    return { kind: 'open', db: opened.db };
  }

  function tell(): void {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* a listener's failure is its own */ }
    }
  }

  function tellSearch(change: SearchChange): void {
    for (const listener of [...searchListeners]) {
      try { listener(change); } catch { /* Search can never prevent saving a conversation. */ }
    }
  }

  function searchMessage(row: Row): SearchMessage {
    const body = readBody(row['body']);
    return { id: String(row['id']), sessionId: String(row['conversationId']), role: body.role === 'user' ? 'user' : 'assistant', text: body.blocks.map((block) => block.text).join('\n') };
  }

  function database(): DatabaseSync {
    if (state.kind !== 'open') throw new StorageFailure(state.kind);
    return state.db;
  }

  function prepared(sql: string): StatementSync {
    let statement = statements.get(sql);
    if (statement === undefined) {
      statement = database().prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }
  const get = (sql: string, ...values: SQLInputValue[]): Row | undefined => { database(); return prepared(sql).get(...values); };
  const all = (sql: string, ...values: SQLInputValue[]): Row[] => { database(); return prepared(sql).all(...values); };
  const run = (sql: string, ...values: SQLInputValue[]): number => { database(); return Number(prepared(sql).run(...values).changes); };

  /**
   * The images a write in progress took a use from (M23, C6): before its commit, those no use names
   * any more lose their rows in it, and after the commit their files are unlinked.
   */
  let releasing = new Set<string>();

  /** One transaction: what `work` writes is there when this returns, or none of it is. */
  function transaction<T>(point: string, work: () => T): T {
    const db = database();
    db.exec('BEGIN IMMEDIATE');
    releasing = new Set();
    changedItems = new Set();
    changedConversations = new Set();
    let gone: readonly { readonly hash: string; readonly mediaType: AttachmentMediaType }[] = [];
    try {
      const result = work();
      if (releasing.size > 0) gone = composer.release(releasing);
      hook?.(point);
      db.exec('COMMIT');
      releasing = new Set();
      dropFiles(gone);
      if (changedItems.size > 0 || changedConversations.size > 0) tellSearch({ items: [...changedItems], conversations: [...changedConversations] });
      return result;
    } catch (error) {
      releasing = new Set();
      changedItems.clear();
      changedConversations.clear();
      try { db.exec('ROLLBACK'); } catch { /* nothing was begun, or the connection is gone */ }
      if (error instanceof ComposerRowsFailure) throw new StorageFailure(error.kind);
      throw error;
    }
  }

  /** The files of images whose rows a commit deleted (C6): one that will not go is the next open's sweep's. */
  function dropFiles(gone: readonly { readonly hash: string; readonly mediaType: AttachmentMediaType }[]): void {
    let failed = 0;
    for (const blob of gone) if (!blobs.remove(blob.hash, blob.mediaType)) failed += 1;
    if (failed > 0) log.warn(`[conversations] ${failed} ${failed === 1 ? 'image' : 'images'} could not be removed yet`);
  }

  /** What a write in progress took a use from: checked before its commit. */
  const release = (hashes: Iterable<string>): void => { for (const hash of hashes) releasing.add(hash); };

  const composer = composerRows({ get: (sql, ...values) => get(sql, ...values), all: (sql, ...values) => all(sql, ...values), run: (sql, ...values) => run(sql, ...values) });

  /**
   * A session's conversation row, made for its draft or its queue where there is none (M23, C83), so
   * that a removal marks and deletes them with it. `started`: as a prompt's acceptance has it (C18).
   * Answers whether it was made.
   */
  const ensureRow = (sessionId: string, at: number, started: boolean): boolean =>
    run('INSERT INTO conversation (id, startHeld, createdAt) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM conversation WHERE id = ?)', sessionId, started ? 0 : 1, at, sessionId) > 0;

  // ── Reads, shared ──
  const turnRow = (conversationId: string, turnId: string): StoredTurn | null => {
    const row = get(`SELECT ${TURN_COLUMNS} FROM turn WHERE id = ? AND conversationId = ?`, turnId, conversationId);
    return row === undefined ? null : toTurn(row);
  };
  const itemRow = (conversationId: string, itemId: string): ConversationItem | null => {
    const row = get(`SELECT ${ITEM_COLUMNS} FROM item i JOIN turn t ON t.id = i.turnId WHERE i.id = ? AND i.conversationId = ?`, itemId, conversationId);
    return row === undefined ? null : fold(conversationId, [toItem(row)])[0] ?? null;
  };

  /**
   * A message's images, folded into it as it is read (M23, C5, C26): by the message each use
   * names, never by a time or an adjacency. What is answered of an image is what its row holds; one
   * fat-g never held, or whose row is gone, reads as not available (C8, C25).
   */
  function fold(conversationId: string, items: readonly ConversationItem[]): ConversationItem[] {
    const turns = [...new Set(items.filter((item) => item.kind === 'message').map((item) => item.turnId))];
    if (turns.length === 0) return [...items];
    const found = composer.attachmentsOf(conversationId, turns);
    if (found.size === 0) return [...items];
    return items.map((item) => {
      const list = item.kind === 'message' ? found.get(item.id) : undefined;
      return list === undefined ? item : { ...item, attachments: list };
    });
  }
  const nextTurnPlace = (conversationId: string): number => (integer(get('SELECT max(place) AS place FROM turn WHERE conversationId = ?', conversationId)?.['place']) ?? 0) + 1;
  /** After every stored item of the turn, and after every place kept for one that is not written yet (M19, C14). */
  const nextItemPlace = (turnId: string): number => Math.max(integer(get('SELECT max(place) AS place FROM item WHERE turnId = ?', turnId)?.['place']) ?? 0, reserved.get(turnId) ?? 0) + 1;
  /** The turn an item with no turn of its own goes to: the one named, or the conversation's newest. */
  const targetTurn = (conversationId: string, turnId: string | null): StoredTurn => {
    const id = turnId ?? text(get('SELECT id FROM turn WHERE conversationId = ? ORDER BY place DESC LIMIT 1', conversationId)?.['id']);
    const turn = id === null ? null : turnRow(conversationId, id);
    if (turn === null) throw new StorageFailure('no-turn');
    return turn;
  };
  const hasItem = (conversationId: string, itemId: string): boolean => get('SELECT 1 AS found FROM item WHERE id = ? AND conversationId = ?', itemId, conversationId) !== undefined;

  /** The activity a turn holds for an owner under the provider's id, with its body as it is stored — `running` where its end has not come. */
  function activityRow(conversationId: string, turnId: string, key: ActivityKey): ActivityRow | null {
    const row = get("SELECT id, body FROM item WHERE conversationId = ? AND providerItemId = ? AND turnId = ? AND kind = 'activity' AND workerId IS ? LIMIT 1", conversationId, key.providerItemId, turnId, key.workerId);
    if (row === undefined) return null;
    const { activity } = readBody(row['body']);
    return activity === null ? null : { id: String(row['id']), body: activity };
  }
  const setActivity = (conversationId: string, itemId: string, body: ActivityBody): number =>
    run(`UPDATE item SET body = ${SET_ACTIVITY} WHERE id = ? AND conversationId = ?`, ...activityValues(body), itemId, conversationId);

  /**
   * Rows in the statement's order, taken as whole entries within a count and a size (M20a, C31): a
   * turn's consecutive activities are one entry, kept whole or not at all, and one entry at least
   * is kept. The statement is read no further than the entry after the last one kept.
   */
  function takeEntries(sql: string, values: readonly SQLInputValue[], maxEntries: number, maxUnits: number): ConversationItem[] {
    database();
    const kept: ConversationItem[] = [];
    let entries = 0;
    let units = 0;
    let entry: ConversationItem[] = [];
    let size = 0;
    /** The entry read so far is over: it is kept if it fits. False when it does not, and nothing more is read. */
    const close = (): boolean => {
      if (entry.length === 0) return true;
      if (entries > 0 && (entries >= maxEntries || units + size > maxUnits)) return false;
      kept.push(...entry);
      entries += 1;
      units += size;
      entry = [];
      size = 0;
      return true;
    };
    for (const row of prepared(sql).iterate(...values)) {
      const item = toItem(row);
      if (!sameEntry(entry.at(-1), item) && !close()) return kept;
      entry.push(item);
      size += itemUnits(item);
    }
    close();
    return kept;
  }

  function turnsOf(conversationId: string, items: readonly ConversationItem[]): StoredTurn[] {
    const ids = [...new Set(items.map((item) => item.turnId))];
    if (ids.length === 0) return [];
    // Not prepared once: the list's length varies.
    const rows = database().prepare(`SELECT ${TURN_COLUMNS} FROM turn WHERE conversationId = ? AND id IN (${marks(ids.length)}) ORDER BY place`).all(conversationId, ...ids) as Row[];
    return rows.map(toTurn);
  }

  // The session's own items alone: a worker's are in none of its pages (M20a, C31).
  const before = (conversationId: string, first: ConversationItem | undefined): boolean =>
    first !== undefined && get(`SELECT 1 AS found ${ITEMS_FROM} WHERE t.conversationId = ? AND t.place <= ? AND (t.place < ? OR i.place < ?) AND ${OWN} LIMIT 1`, conversationId, first.order.turn, first.order.turn, first.order.item) !== undefined;
  const after = (conversationId: string, last: ConversationItem | undefined): boolean =>
    last !== undefined && get(`SELECT 1 AS found ${ITEMS_FROM} WHERE t.conversationId = ? AND t.place >= ? AND (t.place > ? OR i.place > ?) AND ${OWN} LIMIT 1`, conversationId, last.order.turn, last.order.turn, last.order.item) !== undefined;

  function rows(conversationId: string, items: readonly ConversationItem[]): PageRows {
    return { items: fold(conversationId, items), turns: turnsOf(conversationId, items), older: before(conversationId, items[0]), latest: !after(conversationId, items.at(-1)) };
  }

  function insertItem(conversationId: string, turnId: string, place: number, item: NewItem): void {
    run(
      'INSERT INTO item (id, conversationId, turnId, place, kind, origin, providerItemId, receivedAt, providerAt, body, workerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      item.id, conversationId, turnId, place, item.kind, item.origin, item.providerItemId, item.receivedAt, item.providerAt, bodyOf(item), item.workerId ?? null,
    );
    if (item.kind === 'message' && item.workerId == null) changedItems.add(item.id);
  }

  function insertActivity(conversationId: string, turnId: string, place: number, activity: Omit<NewActivity, 'start'>, body: ActivityBody): void {
    run(
      "INSERT INTO item (id, conversationId, turnId, place, kind, origin, providerItemId, receivedAt, providerAt, body, workerId) VALUES (?, ?, ?, ?, 'activity', ?, ?, ?, ?, ?, ?)",
      activity.id, conversationId, turnId, place, activity.origin, activity.providerItemId, activity.receivedAt, activity.providerAt, activityJson(body), activity.workerId,
    );
  }

  function insertInteraction(conversationId: string, turnId: string, place: number, interaction: Pick<NewInteraction, 'id' | 'origin' | 'workerId' | 'receivedAt' | 'providerAt'> & { readonly providerItemId: string | null }, body: InteractionBody): void {
    run(
      "INSERT INTO item (id, conversationId, turnId, place, kind, origin, providerItemId, receivedAt, providerAt, body, workerId) VALUES (?, ?, ?, ?, 'interaction', ?, ?, ?, ?, ?, ?)",
      interaction.id, conversationId, turnId, place, interaction.origin, interaction.providerItemId, interaction.receivedAt, interaction.providerAt, interactionJson(body), interaction.workerId,
    );
  }

  /** Whether a turn holds an interaction of that owner under the provider's id (M21, C6): a question stands once. */
  const interactionHeld = (turnId: string, providerItemId: string, workerId: string | null): boolean =>
    get("SELECT 1 AS found FROM item WHERE turnId = ? AND providerItemId = ? AND workerId IS ? AND kind = 'interaction' LIMIT 1", turnId, providerItemId, workerId) !== undefined;

  /**
   * The question a message carries, as an item of its own after it (M21, C33). Live, it goes to the
   * end of its turn, after every place kept for an item not written yet (M19, C14): the next entry
   * after its message, unless something began meanwhile. `after`: read from history, it goes
   * directly after the message named, the items from there on moving up by one. Null where the turn
   * already holds one for the message.
   */
  function insertAsking(conversationId: string, turnId: string, asking: NewInteraction, after: string | null = null): string | null {
    if (interactionHeld(turnId, asking.providerItemId, asking.workerId)) return null;
    const at = after === null ? null : integer(get('SELECT place FROM item WHERE id = ? AND turnId = ?', after, turnId)?.['place']);
    if (at !== null) run('UPDATE item SET place = place + 1 WHERE turnId = ? AND place > ?', turnId, at);
    insertInteraction(conversationId, turnId, at === null ? nextItemPlace(turnId) : at + 1, asking, raisedBody(asking.mode, asking.questions, asking.cut));
    return asking.id;
  }

  /** An item with its turn, read back after its write. */
  function read(conversationId: string, itemId: string): StoredItem {
    const stored = storedItem(conversationId, itemId);
    if (stored === null) throw new StorageFailure('not-read-back');
    return stored;
  }

  /** An interaction's named keys, where its stored outcome is `from` (M21, C33, C77). Answers how many rows changed: one, or none. */
  function writeInteraction(conversationId: string, itemId: string, from: Outcome | readonly Outcome[], change: InteractionChange, unmarked = false): number {
    const keys = INTERACTION_KEYS.filter((key) => change[key] !== undefined);
    if (keys.length === 0) return 0;
    // One outcome, or — for what is written of a decision already taken, whichever it was (M22, C12) — any of several.
    const outcomes: readonly string[] = typeof from === 'string' ? [from] : from;
    if (outcomes.length === 0) return 0;
    return run(
      `UPDATE item SET body = json_set(body, ${keys.map((key) => `'$.interaction.${key}', json(?)`).join(', ')}) WHERE id = ? AND conversationId = ? AND kind = 'interaction' AND ${OUTCOME} IN (${marks(outcomes.length)})${unmarked ? " AND json_extract(body, '$.interaction.confirmedAt') IS NULL" : ''}`,
      ...keys.map((key) => JSON.stringify(change[key])), itemId, conversationId, ...outcomes,
    );
  }

  /** Every `open` interaction of the conversation is passed (M21, C41), but the one named. Answers their ids. */
  function passOpen(conversationId: string, at: number, except: string | null = null): string[] {
    const open = all(`SELECT id FROM item WHERE conversationId = ? AND kind = 'interaction' AND ${OUTCOME} = 'open'`, conversationId).map((row) => String(row['id'])).filter((id) => id !== except);
    return open.filter((id) => writeInteraction(conversationId, id, 'open', { outcome: 'passed', settledAt: at }) > 0);
  }

  /**
   * Every `open` async card of the session's own in the turn that the model went on past: a message
   * of the session's own with text, or a plan's line, stands after it in its turn (decision 0026,
   * item 11). Answers their ids. In the caller's transaction.
   */
  function passCardsGonePast(conversationId: string, turnId: string, at: number): string[] {
    const gonePast = all(
      `SELECT c.id AS id FROM item c WHERE c.conversationId = ? AND c.turnId = ? AND c.kind = 'interaction' AND c.workerId IS NULL
        AND json_extract(c.body, '$.interaction.kind') = 'question' AND json_extract(c.body, '$.interaction.mode') = 'async' AND json_extract(c.body, '$.interaction.outcome') = 'open'
        AND EXISTS (SELECT 1 FROM item l WHERE l.conversationId = c.conversationId AND l.turnId = c.turnId AND l.workerId IS NULL AND l.place > c.place
          AND ((l.kind = 'message' AND json_extract(l.body, '$.role') = 'assistant' AND coalesce(json_extract(l.body, '$.blocks[0].text'), '') <> '')
            OR (l.kind = 'interaction' AND json_extract(l.body, '$.interaction.kind') = 'plan')))`,
      conversationId, turnId,
    ).map((row) => String(row['id']));
    return gonePast.filter((id) => writeInteraction(conversationId, id, 'open', { outcome: 'passed', settledAt: at }) > 0);
  }

  /** An item with its turn, read back; null for an id the conversation does not hold. */
  function storedItem(conversationId: string, itemId: string): StoredItem | null {
    const item = itemRow(conversationId, itemId);
    const turn = item === null ? null : turnRow(conversationId, item.turnId);
    return item === null || turn === null ? null : { item, turn };
  }

  /**
   * The question a history message carries, as an item directly after it (M21, C28): `passed` where
   * any turn stands after its own in the stored order — a prompt passes a card at its acceptance —
   * and `open` otherwise. Its time is the message's. False where the turn already holds one.
   */
  function insertHistoryAsking(conversationId: string, turnId: string, messageId: string, message: HistoryMessage): boolean {
    const asked = fromMessageQuestions(message.questions ?? [], message.cut === true);
    if (asked.questions.length === 0) return false;
    const made = insertAsking(conversationId, turnId, { id: newId(), origin: 'provider', providerItemId: message.itemId, workerId: null, mode: 'async', questions: asked.questions, cut: asked.cut, receivedAt: null, providerAt: message.at }, messageId);
    if (made === null) return false;
    const later = get('SELECT 1 AS found FROM turn WHERE conversationId = ? AND place > (SELECT place FROM turn WHERE id = ?) LIMIT 1', conversationId, turnId) !== undefined;
    if (later) writeInteraction(conversationId, made, 'open', { outcome: 'passed', settledAt: now() });
    return true;
  }

  /** A history activity as a row of its turn, at `place`: whole, as the provider's history gives it (M20a, C19). */
  function insertHistoryActivity(conversationId: string, turnId: string, place: number, activity: HistoryActivity): void {
    const { start, end } = fromHistoryActivity(activity);
    insertActivity(conversationId, turnId, place, { id: newId(), origin: 'provider', providerItemId: activity.itemId, workerId: null, receivedAt: null, providerAt: activity.at }, endedBody(startedBody(start), end));
  }

  /** The image a provider's history names by a path (M23, C25): one fat-g holds under that path's hash, else none. */
  const heldImage = (file: string): string | null => {
    const named = blobHashOfPath(blobs.root, file);
    return named !== null && composer.knows(named.hash, named.mediaType) ? named.hash : null;
  };

  const fromHistory = (message: HistoryMessage): NewItem => ({
    id: newId(), kind: 'message', origin: 'provider', providerItemId: message.itemId, role: message.role, phase: message.phase, text: message.text, cut: message.cut === true,
    questions: message.questions ?? [], notice: null, detail: null, receivedAt: null, providerAt: message.at,
    // A prompt fat-g composed for a plan, which the store holds no item of (M22b, C69): its block names it.
    plan: message.role === 'user' ? readPlanPrompt(message.text, message.cut === true) : null,
  });
  const notShown = (words: string): NewItem => ({
    id: newId(), kind: 'notice', origin: 'provider', providerItemId: null, role: null, phase: null, text: words, cut: false, questions: [], notice: 'turn-not-shown', detail: null, receivedAt: null, providerAt: null,
  });

  function heldTurn(row: Row): HeldTurn {
    const turn = toTurn(row);
    // The session's own items: a worker's are no part of the session's history (M20a, C58).
    const items = all("SELECT id, kind, providerItemId, json_extract(body, '$.notice') AS notice, json_extract(body, '$.complete') AS complete, json_extract(body, '$.activity.type') AS activityType, json_extract(body, '$.activity.name') AS activityName FROM item WHERE turnId = ? AND workerId IS NULL AND kind <> 'attachment' ORDER BY place", turn.id);
    // A generation whose bytes were never retained is incomplete conversation content, even if
    // the CLI completed its tool. Ask history for that turn; never generate again to repair it.
    const retainedImages = new Set(items.filter((item) => item['kind'] === 'message' || item['kind'] === 'notice').map((item) => text(item['providerItemId'])));
    const missingImage = items.some((item) => {
      const source = text(item['providerItemId']);
      return item['activityName'] === 'imageGeneration' && source !== null && !retainedImages.has(returnedImageMessageId(source));
    });
    return {
      id: turn.id,
      providerTurnId: turn.providerTurnId,
      // One fat-g answered itself is in no provider's history, and is all there (M20b, C35).
      ended: turn.providerOutcome !== null || turn.own,
      gap: turn.gap || missingImage,
      reached: turn.reached,
      // JSON's false reads 0: only that is incomplete, as `readBody` has it. A checklist holds no
      // turn for a check: history returns none (M20a, C24).
      // Each with its kind (M21, C28): a question's card shares its message's id, and is never taken for it.
      items: items.map((item) => ({ id: String(item['id']), kind: String(item['kind']), providerItemId: text(item['providerItemId']), notice: text(item['notice']), complete: item['complete'] !== 0 || item['activityType'] === 'checklist' })),
    };
  }

  /** Folds the log into the main file and empties it, so nothing a removal deleted stays in it (C62). */
  function checkpoint(): void {
    try {
      hook?.('checkpoint');
      const answer = database().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Row | undefined;
      // A busy checkpoint did not finish: the next removal's, or the clean close, does its work.
      if (answer?.['busy'] !== 0) log.warn('[conversations] the log could not be emptied (busy)');
    } catch (error) {
      log.warn(`[conversations] the log could not be emptied (${errorKind(error)})`);
    }
  }

  return {
    status: () => (state.kind === 'refused' ? { kind: 'refused', cause: state.cause } : { kind: 'ok' }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    subscribeSearch(listener) {
      searchListeners.add(listener);
      return () => searchListeners.delete(listener);
    },

    searchMessages(after, sessionId) {
      database();
      const sql = `SELECT i.rowid AS cursor, i.id, i.conversationId, i.body ${SEARCH_FROM} AND i.rowid > ?${sessionId === undefined ? '' : ' AND i.conversationId = ?'} ORDER BY i.rowid LIMIT 64`;
      const messages: SearchMessage[] = [];
      let next: number | null = null;
      let units = 0;
      for (const row of prepared(sql).iterate(after, ...(sessionId === undefined ? [] : [sessionId]))) {
        const message = searchMessage(row);
        messages.push(message);
        next = Number(row['cursor']);
        units += message.text.length;
        if (units >= 256_000) break;
      }
      return { messages, next };
    },

    searchMessage(id) {
      const row = get(`SELECT i.id, i.conversationId, i.body ${SEARCH_FROM} AND i.id = ?`, id);
      return row === undefined ? null : searchMessage(row);
    },

    acceptPrompt(prompt) {
      const made = transaction('accept', () => {
        const { aside, answering, deciding } = prompt;
        if (deciding !== undefined) {
          // Checked here, inside the one transaction and after every wait of the send's (M22b, C12): a
          // decision taken meanwhile, or a plan removed, keeps its line's outcome, and nothing is written.
          const held = get(`SELECT json_extract(body, '$.interaction.kind') AS kind, ${OUTCOME} AS outcome FROM item WHERE id = ? AND conversationId = ? AND kind = 'interaction'`, deciding.itemId, prompt.conversationId);
          if (held === undefined || held['kind'] !== 'plan' || held['outcome'] !== 'pending') throw new StorageFailure('not-pending');
        }
        if (answering !== undefined) {
          // Checked here, inside the one transaction and after every wait of the send's (M21, C77):
          // a card dismissed or passed meanwhile keeps its outcome, and nothing is written for it.
          const held = get(`SELECT json_extract(body, '$.interaction.mode') AS mode, ${OUTCOME} AS outcome FROM item WHERE id = ? AND conversationId = ? AND kind = 'interaction'`, answering.itemId, prompt.conversationId);
          if (held === undefined || held['mode'] !== 'async' || held['outcome'] !== 'open') throw new StorageFailure('not-open');
        }
        const fresh = get('SELECT id FROM conversation WHERE id = ?', prompt.conversationId) === undefined;
        if (fresh && aside !== undefined) {
          // An aside's row, with its first question (M20b, C28): its parent, what it was asked about, and its title.
          run(
            'INSERT INTO conversation (id, startHeld, createdAt, parentId, source, title) VALUES (?, 1, ?, ?, ?, ?)',
            prompt.conversationId, prompt.at, aside.parentId, aside.source === null ? null : JSON.stringify(aside.source), cutTo(aside.title, MAX_ASIDE_TITLE).text,
          );
        } else if (fresh) run('INSERT INTO conversation (id, startHeld, createdAt) VALUES (?, ?, ?)', prompt.conversationId, prompt.started ? 0 : 1, prompt.at);
        // The chat's mode, where its row holds none yet (M22, C40): never over a saved one.
        if (aside === undefined && prompt.mode != null) run('UPDATE conversation SET mode = ?, modeSource = ? WHERE id = ? AND mode IS NULL', prompt.mode.id, prompt.mode.source, prompt.conversationId);
        // The turn runs under the chat's mode as its row now has it (C83): an aside's row has none.
        run(
          "INSERT INTO turn (id, conversationId, place, origin, acceptedAt, own, mode, plan) VALUES (?, ?, ?, 'local', ?, ?, (SELECT mode FROM conversation WHERE id = ?), ?)",
          prompt.turnId, prompt.conversationId, nextTurnPlace(prompt.conversationId), prompt.at, prompt.own === true ? 1 : 0, prompt.conversationId, prompt.plan === true ? 1 : 0,
        );
        if (prompt.speed !== undefined && prompt.own !== true) run("UPDATE turn SET extra = json_set(coalesce(extra, '{}'), '$.speed', json(?)) WHERE id = ?", JSON.stringify(prompt.speed === null ? null : TurnSpeedSchema.parse(prompt.speed)), prompt.turnId);
        insertItem(prompt.conversationId, prompt.turnId, 1, {
          id: prompt.itemId, kind: 'message', origin: 'local', providerItemId: null, role: 'user', phase: null, text: prompt.text, cut: false, questions: [], notice: null, detail: null, receivedAt: prompt.at, providerAt: null, plan: prompt.fields ?? null,
          fromQueue: prompt.from !== undefined && 'queued' in prompt.from,
        });
        // The input it is, consumed in this same transaction, and its images the prompt's (M23, C21, C56): never unnamed between the two.
        const { from } = prompt;
        if (from !== undefined) {
          const uses = 'draft' in from ? composer.consumeDraft(prompt.conversationId, from.draft, prompt.at) : composer.consumeQueued(prompt.conversationId, from.queued).uses;
          composer.insertItems(prompt.conversationId, prompt.turnId, prompt.itemId, 2, uses);
        }
        // The decision, with the turn that carries it out (M22b, C12, C15, C65): one transaction with the prompt's record.
        if (deciding !== undefined) writeInteraction(prompt.conversationId, deciding.itemId, 'pending', { outcome: deciding.outcome, decidedAt: prompt.at });
        // The answer, with the turn its prompt starts (M21, C26, C68), and the pass of every other
        // open card (C41): one transaction with the prompt's record.
        if (answering !== undefined) writeInteraction(prompt.conversationId, answering.itemId, 'open', { outcome: 'answered', answers: answering.answers, settledAt: prompt.at, answeredBy: prompt.turnId });
        return { fresh, passed: fresh ? [] : passOpen(prompt.conversationId, prompt.at, answering?.itemId ?? null) };
      });
      if (made.fresh) tell();
      const item = itemRow(prompt.conversationId, prompt.itemId);
      const turn = turnRow(prompt.conversationId, prompt.turnId);
      if (item === null || turn === null) throw new StorageFailure('not-read-back');
      return { item, turn, passed: made.passed };
    },

    acceptSteer(steer) {
      transaction('steer', () => {
        const turn = get('SELECT providerOutcome FROM turn WHERE id = ? AND conversationId = ?', steer.turnId, steer.conversationId);
        if (turn === undefined || turn['providerOutcome'] !== null) throw new StorageFailure('turn-over');
        const { answering, from } = steer;
        if (answering !== undefined) {
          // Checked here, as a prompt's answer is (M21, C77): a card dismissed or passed meanwhile keeps its outcome.
          const held = get(`SELECT json_extract(body, '$.interaction.mode') AS mode, ${OUTCOME} AS outcome FROM item WHERE id = ? AND conversationId = ? AND kind = 'interaction'`, answering.itemId, steer.conversationId);
          if (held === undefined || held['mode'] !== 'async' || held['outcome'] !== 'open') throw new StorageFailure('not-open');
        }
        const place = nextItemPlace(steer.turnId);
        insertItem(steer.conversationId, steer.turnId, place, {
          id: steer.itemId, kind: 'message', origin: 'local', providerItemId: null, role: 'user', phase: null, text: steer.text, cut: false, questions: [], notice: null, detail: null, receivedAt: steer.at, providerAt: null,
          ...(steer.own === true ? {} : { delivery: { state: 'sent', detail: null } }),
          fromQueue: from !== undefined && 'queued' in from,
        });
        if (from !== undefined) {
          const uses = 'draft' in from ? composer.consumeDraft(steer.conversationId, from.draft, steer.at) : composer.consumeQueued(steer.conversationId, from.queued).uses;
          composer.insertItems(steer.conversationId, steer.turnId, steer.itemId, place + 1, uses);
        }
        if (answering !== undefined) writeInteraction(steer.conversationId, answering.itemId, 'open', { outcome: 'answered', answers: answering.answers, settledAt: steer.at, answeredBy: steer.turnId });
      });
      const item = itemRow(steer.conversationId, steer.itemId);
      const turn = turnRow(steer.conversationId, steer.turnId);
      if (item === null || turn === null) throw new StorageFailure('not-read-back');
      return { item, turn };
    },

    setDelivery(conversationId, itemId, delivery) {
      return transaction('delivery', () => run(
        "UPDATE item SET body = json_set(body, '$.delivery', json(?)) WHERE id = ? AND conversationId = ? AND kind = 'message' AND json_extract(body, '$.role') = 'user'",
        JSON.stringify({ state: delivery.state, detail: delivery.detail === null ? null : cutTo(delivery.detail, MAX_NOTICE_DETAIL).text }), itemId, conversationId,
      )) > 0;
    },

    moveToTurn(conversationId, itemId, turnId, at, speed) {
      transaction('move', () => {
        const message = get("SELECT turnId FROM item WHERE id = ? AND conversationId = ? AND kind = 'message'", itemId, conversationId);
        if (message === undefined) throw new StorageFailure('not-read-back');
        if (String(message['turnId']) === turnId) return;
        if (get('SELECT 1 AS found FROM turn WHERE id = ?', turnId) === undefined) {
          run(
            "INSERT INTO turn (id, conversationId, place, origin, acceptedAt, own, mode, plan) VALUES (?, ?, ?, 'local', ?, 0, (SELECT mode FROM conversation WHERE id = ?), 0)",
            turnId, conversationId, nextTurnPlace(conversationId), at, conversationId,
          );
          if (speed !== undefined) run("UPDATE turn SET extra = json_set(coalesce(extra, '{}'), '$.speed', json(?)) WHERE id = ? AND conversationId = ?", JSON.stringify(speed === null ? null : TurnSpeedSchema.parse(speed)), turnId, conversationId);
        }
        // The message first, then its images in their order, as a prompt's stand in its turn.
        const images = all("SELECT id FROM item WHERE conversationId = ? AND kind = 'attachment' AND json_extract(body, '$.attachment.messageId') = ? ORDER BY place", conversationId, itemId);
        let place = nextItemPlace(turnId);
        run('UPDATE item SET turnId = ?, place = ? WHERE id = ?', turnId, place, itemId);
        for (const image of images) { place += 1; run('UPDATE item SET turnId = ?, place = ? WHERE id = ?', turnId, place, String(image['id'])); }
      });
      const item = itemRow(conversationId, itemId);
      const turn = turnRow(conversationId, turnId);
      if (item === null || turn === null) throw new StorageFailure('not-read-back');
      return { item, turn };
    },

    providerTook(conversationId, turnId, providerTurnId) {
      return transaction('took', () => {
        run('UPDATE turn SET providerTook = 1, providerTurnId = coalesce(providerTurnId, ?) WHERE id = ? AND conversationId = ?', providerTurnId, turnId, conversationId);
        // An async answer's mark is its answering turn's acknowledgement (M21, C68).
        const answered = text(get(`SELECT id FROM item WHERE conversationId = ? AND kind = 'interaction' AND json_extract(body, '$.interaction.answeredBy') = ? AND ${OUTCOME} = 'answered' AND json_extract(body, '$.interaction.confirmedAt') IS NULL LIMIT 1`, conversationId, turnId)?.['id']);
        return answered !== null && writeInteraction(conversationId, answered, 'answered', { confirmedAt: now() }, true) > 0 ? answered : null;
      });
    },

    setReference(conversationId, reference, folder, configFolder) {
      transaction('reference', () => run('UPDATE conversation SET reference = ?, folder = ?, configFolder = ? WHERE id = ? AND reference IS NULL', reference, folder, configFolder, conversationId));
    },

    setProviderItemId(conversationId, itemId, providerItemId) {
      return transaction('echo', () => run('UPDATE item SET providerItemId = ? WHERE id = ? AND conversationId = ? AND providerItemId IS NULL', providerItemId, itemId, conversationId)) > 0;
    },

    saveReturnedImage(conversationId, place, item, image) {
      return transaction('item', () => {
        targetTurn(conversationId, place.turnId);
        if (get('SELECT id FROM conversation WHERE id = ? AND removing = 0', conversationId) === undefined) throw new StorageFailure('no-turn');
        if (get('SELECT id FROM item WHERE conversationId = ? AND turnId = ? AND providerItemId = ? AND workerId IS ? AND kind IN (?, ?) LIMIT 1', conversationId, place.turnId, item.providerItemId, item.workerId ?? null, 'message', 'notice') !== undefined) return 'duplicate';
        if (image !== undefined) {
          const usage = get("SELECT count(*) AS count, coalesce(sum(b.bytes), 0) AS bytes FROM item a JOIN item m ON m.id = json_extract(a.body, '$.attachment.messageId') JOIN blob b ON b.hash = a.blob WHERE a.conversationId = ? AND a.turnId = ? AND a.kind = 'attachment' AND json_extract(m.body, '$.role') = 'assistant'", conversationId, place.turnId);
          if (Number(usage?.['count']) >= MAX_IMAGES || Number(usage?.['bytes']) + image.bytes > MAX_MESSAGE_IMAGE_BYTES) return 'limit';
          run('INSERT INTO blob (hash, mediaType, bytes, width, height, stagedAt) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM blob WHERE hash = ?)', image.hash, image.mediaType, image.bytes, image.width, image.height, image.stagedAt, image.hash);
        }
        insertItem(conversationId, place.turnId, place.order.item, item);
        if (image !== undefined) composer.insertItems(conversationId, place.turnId, item.id, place.order.item + 1, [{ id: newId(), hash: image.hash, name: 'Generated image' }]);
        return 'stored';
      });
    },

    addItem(conversationId, turnId, item, asking) {
      const target = transaction('item', () => {
        const { id } = targetTurn(conversationId, turnId);
        // Its owner's own: a worker's item under an id the session's also has is another item (M20a, C20).
        if (item.providerItemId !== null && get('SELECT 1 AS found FROM item WHERE turnId = ? AND providerItemId = ? AND workerId IS ? AND kind = ? LIMIT 1', id, item.providerItemId, item.workerId ?? null, item.kind) !== undefined) return null;
        insertItem(conversationId, id, nextItemPlace(id), item);
        // The question it carries, in this same transaction (M21, C33): neither is stored without the other.
        return { id, asked: asking === undefined ? null : insertAsking(conversationId, id, asking) };
      });
      if (target === null) return null;
      const stored = itemRow(conversationId, item.id);
      const turn = turnRow(conversationId, target.id);
      if (stored === null || turn === null) throw new StorageFailure('not-read-back');
      return { item: stored, turn, interaction: target.asked === null ? null : itemRow(conversationId, target.asked) };
    },

    addInteraction(conversationId, turnId, interaction) {
      const target = transaction('interaction', () => {
        const { id } = targetTurn(conversationId, turnId);
        if ('request' in interaction) {
          // An approval (M22, C77): one action can ask twice, so nothing of it stands once.
          insertInteraction(conversationId, id, nextItemPlace(id), interaction, raisedApproval(interaction.request));
          return id;
        }
        if (interactionHeld(id, interaction.providerItemId, interaction.workerId)) return null;
        insertInteraction(conversationId, id, nextItemPlace(id), interaction, raisedBody(interaction.mode, interaction.questions, interaction.cut));
        return id;
      });
      return target === null ? null : read(conversationId, interaction.id);
    },

    addPlan(conversationId, turnId, plan) {
      transaction('plan', () => {
        const { id } = targetTurn(conversationId, turnId);
        insertInteraction(conversationId, id, nextItemPlace(id), { id: plan.id, origin: 'local', providerItemId: plan.providerItemId, workerId: null, receivedAt: plan.receivedAt, providerAt: null }, plan.body);
      });
      return read(conversationId, plan.id);
    },

    bringPlan(conversationId, at, plan) {
      const made = transaction('bring', () => {
        const fresh = get('SELECT id FROM conversation WHERE id = ?', conversationId) === undefined;
        if (fresh) run('INSERT INTO conversation (id, startHeld, createdAt) VALUES (?, ?, ?)', conversationId, at.started ? 0 : 1, at.at);
        // A turn of fat-g's own (C76), as a command it answers is: no provider takes it or ends it.
        run(
          "INSERT INTO turn (id, conversationId, place, origin, acceptedAt, own, mode, sessionEndedAt, sessionOutcome) VALUES (?, ?, ?, 'local', ?, 1, (SELECT mode FROM conversation WHERE id = ?), ?, 'completed')",
          at.turnId, conversationId, nextTurnPlace(conversationId), at.at, conversationId, at.at,
        );
        insertInteraction(conversationId, at.turnId, 1, { id: plan.id, origin: 'local', providerItemId: plan.providerItemId, workerId: null, receivedAt: plan.receivedAt, providerAt: null }, plan.body);
        return fresh;
      });
      if (made) tell();
      return read(conversationId, plan.id);
    },

    pendingPlans() {
      return all(`SELECT conversationId, id, body FROM item WHERE kind = 'interaction' AND json_extract(body, '$.interaction.kind') = 'plan' AND ${OUTCOME} = 'pending'`).flatMap((row) => pendingRow(row));
    },

    planWaiters(planId) {
      return all(`SELECT conversationId, id, body FROM item WHERE kind = 'interaction' AND json_extract(body, '$.interaction.kind') = 'plan' AND json_extract(body, '$.interaction.planId') = ? AND ${OUTCOME} = 'pending'`, planId).flatMap((row) => pendingRow(row));
    },

    plannedBefore(conversationId) {
      return get('SELECT 1 AS found FROM turn WHERE conversationId = ? AND plan = 1 LIMIT 1', conversationId) !== undefined;
    },

    turnPlan(conversationId, turnId) {
      const turn = turnRow(conversationId, turnId);
      if (turn === null) return null;
      // Its prompt: the session's own first message of the user's in it.
      const prompt = get("SELECT body FROM item WHERE turnId = ? AND kind = 'message' AND workerId IS NULL AND json_extract(body, '$.role') = 'user' ORDER BY place LIMIT 1", turnId);
      const line = get("SELECT id, body FROM item WHERE turnId = ? AND kind = 'interaction' AND json_extract(body, '$.interaction.kind') = 'plan' ORDER BY place DESC LIMIT 1", turnId);
      const body = line === undefined ? null : readBody(line['body']).interaction;
      return {
        plan: turn.plan,
        fields: prompt === undefined ? null : readBody(prompt['body']).plan,
        prompt: prompt === undefined ? null : readBody(prompt['body']).blocks[0]?.text ?? null,
        newest: line === undefined || body === null || body.kind !== 'plan' ? null : { itemId: String(line['id']), planId: body.planId, version: body.version, outcome: body.outcome },
      };
    },

    turnAnswer(conversationId, turnId) {
      if (turnRow(conversationId, turnId) === null) return null;
      const message = get("SELECT id, body FROM item WHERE conversationId = ? AND turnId = ? AND kind = 'message' AND workerId IS NULL AND json_extract(body, '$.role') = 'assistant' AND json_extract(body, '$.phase') = 'final' ORDER BY place DESC LIMIT 1", conversationId, turnId);
      const card = get(`SELECT id FROM item WHERE conversationId = ? AND turnId = ? AND kind = 'interaction' AND workerId IS NULL AND json_extract(body, '$.interaction.kind') = 'question' AND ${OUTCOME} = 'open' ORDER BY place DESC LIMIT 1`, conversationId, turnId);
      const block = message === undefined ? undefined : readBody(message['body']).blocks[0];
      return {
        answer: message === undefined ? null : { itemId: String(message['id']), text: block?.text ?? '', cut: block?.cut === true },
        card: card === undefined ? null : String(card['id']),
      };
    },

    planNote(conversationId) {
      const raw = get('SELECT planNote FROM conversation WHERE id = ?', conversationId)?.['planNote'];
      if (typeof raw !== 'string') return null;
      try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== 'object' || value === null) return null;
        const { sessionId, at } = value as Record<string, unknown>;
        return typeof sessionId === 'string' && sessionId !== '' && typeof at === 'number' && Number.isSafeInteger(at) ? { sessionId, at } : null;
      } catch { return null; }
    },

    setPlanNote(conversationId, note) {
      transaction('plan-note', () => run('UPDATE conversation SET planNote = ? WHERE id = ? AND parentId IS NULL', note === null ? null : JSON.stringify({ sessionId: note.sessionId, at: note.at }), conversationId));
    },

    unfinishPlans(at) {
      return transaction('plans-unfinished', () => run(`UPDATE item SET body = json_set(body, '$.interaction.outcome', 'unfinished', '$.interaction.settledAt', ?) WHERE kind = 'interaction' AND json_extract(body, '$.interaction.kind') = 'plan' AND ${OUTCOME} = 'writing'`, at));
    },

    setInteraction(conversationId, itemId, from, change) {
      const changed = transaction('interaction-set', () => writeInteraction(conversationId, itemId, from, change));
      return changed === 0 ? null : read(conversationId, itemId);
    },

    setPlanFeedback(conversationId, itemId, change, prompt) {
      const changed = transaction('plan-feedback', () => {
        const line = get("SELECT turnId, json_extract(body, '$.interaction.planId') AS planId, json_extract(body, '$.interaction.version') AS version FROM item WHERE id = ? AND conversationId = ? AND kind = 'interaction' AND json_extract(body, '$.interaction.kind') = 'plan'", itemId, conversationId);
        if (line === undefined || writeInteraction(conversationId, itemId, 'pending', change) === 0) return false;
        // After the line, where the turn waits on it: a prompt of the user's, as fat-g sent it.
        const turnId = String(line['turnId']);
        insertItem(conversationId, turnId, nextItemPlace(turnId), {
          id: prompt.id, kind: 'message', origin: 'local', providerItemId: null, role: 'user', phase: null, text: prompt.text, cut: false, questions: [], notice: null, detail: null, receivedAt: prompt.at, providerAt: null,
          plan: { planId: String(line['planId']), version: Number(line['version']), intent: 'revise' },
        });
        return true;
      });
      return changed ? { line: read(conversationId, itemId), prompt: read(conversationId, prompt.id) } : null;
    },

    settlePending(conversationId, itemIds, change) {
      if (itemIds.length === 0) return [];
      const changed = transaction('interactions-settled', () => itemIds.filter((id) => writeInteraction(conversationId, id, 'pending', change) > 0));
      return changed.map((id) => read(conversationId, id));
    },

    passGonePast(conversationId, turnId, at) {
      const changed = transaction('interactions-passed', () => passCardsGonePast(conversationId, turnId, at));
      return changed.map((id) => read(conversationId, id));
    },

    item: storedItem,

    reserveItem(conversationId, turnId) {
      const turn = targetTurn(conversationId, turnId);
      const item = nextItemPlace(turn.id);
      reserved.set(turn.id, item);
      return { turnId: turn.id, order: { turn: turn.place, item } };
    },

    saveProgress(conversationId, place, item) {
      transaction('progress', () => {
        changedItems.add(item.id);
        if (!hasItem(conversationId, item.id)) { insertItem(conversationId, place.turnId, place.order.item, { ...item, complete: false }); return; }
        // The text and its cut flag together (C64): the flag is a key of its own beside the text.
        const cut = cutTo(item.text, MAX_MESSAGE_TEXT);
        run(
          "UPDATE item SET body = json_set(body, '$.blocks[0].text', ?, '$.blocks[0].cut', json(?)) WHERE id = ? AND conversationId = ? AND json_extract(body, '$.complete') = 0",
          cut.text, jsonFlag(item.cut || cut.cut), item.id, conversationId,
        );
      });
    },

    completeItem(conversationId, place, item, asking) {
      const asked = transaction('complete', () => {
        changedItems.add(item.id);
        if (!hasItem(conversationId, item.id)) insertItem(conversationId, place.turnId, place.order.item, { ...item, complete: true });
        else {
          // The body's named keys, and nothing else of the row (C17; M18, C38).
          const cut = cutTo(item.text, MAX_MESSAGE_TEXT);
          run(
            "UPDATE item SET body = json_set(body, '$.blocks[0].text', ?, '$.blocks[0].cut', json(?), '$.complete', json('true'), '$.phase', ?, '$.questions', json(?)) WHERE id = ? AND conversationId = ?",
            cut.text, jsonFlag(item.cut || cut.cut), item.phase, JSON.stringify(item.questions), item.id, conversationId,
          );
          // The model its whole message names, where it names one (M20b, C28): one more key, in the same transaction.
          const model = modelKey(item.model);
          if (model !== null) run("UPDATE item SET body = json_set(body, '$.model', ?) WHERE id = ? AND conversationId = ?", model, item.id, conversationId);
        }
        // The question it carries, in this same transaction (M21, C33).
        return asking === undefined ? null : insertAsking(conversationId, place.turnId, asking);
      });
      const stored = itemRow(conversationId, item.id);
      const turn = turnRow(conversationId, place.turnId);
      if (stored === null || turn === null) throw new StorageFailure('not-read-back');
      return { item: stored, turn, interaction: asked === null ? null : itemRow(conversationId, asked) };
    },

    providerEnded(conversationId, turnId, outcome, at, answerItemId = null, elapsedMs = null) {
      transaction('provider-end', () => {
        const ended = run('UPDATE turn SET providerOutcome = ?, endReceivedAt = ?, elapsedMs = ? WHERE id = ? AND conversationId = ? AND providerOutcome IS NULL', outcome, at, elapsedMs, turnId, conversationId);
        // The answer is settled with the end that names it, and by no other write (M16, C74): an
        // end the turn already had names nothing. One key of the body changes; the rest stays as it was written.
        if (ended > 0 && answerItemId !== null) {
          // The session's own message alone: a worker's is never the turn's answer (M20a, C20).
          run("UPDATE item SET body = json_set(body, '$.phase', 'final') WHERE conversationId = ? AND turnId = ? AND providerItemId = ? AND kind = 'message' AND workerId IS NULL AND json_extract(body, '$.role') = 'assistant'", conversationId, turnId, answerItemId);
        }
      });
    },

    sessionEnded(conversationId, turnId, at, outcome) {
      return transaction('session-end', () => run('UPDATE turn SET sessionEndedAt = ?, sessionOutcome = ? WHERE id = ? AND conversationId = ?', at, outcome, turnId, conversationId)) > 0;
    },

    markGap(conversationId, turnId) {
      transaction('gap', () => run('UPDATE turn SET gap = 1 WHERE id = ? AND conversationId = ?', turnId, conversationId));
    },

    addActivity(conversationId, turnId, activity) {
      const made = transaction('activity', () => {
        const { id } = targetTurn(conversationId, turnId);
        const held = activityRow(conversationId, id, activity);
        if (held !== null) {
          // A second start for an item the turn holds (C59): its named keys, and nothing else of the row.
          setActivity(conversationId, held.id, restartedBody(held.body, activity.start));
          return { turnId: id, itemId: held.id, opened: false };
        }
        insertActivity(conversationId, id, nextItemPlace(id), activity, startedBody(activity.start));
        return { turnId: id, itemId: activity.id, opened: true };
      });
      const item = itemRow(conversationId, made.itemId);
      const turn = turnRow(conversationId, made.turnId);
      if (item === null || turn === null) throw new StorageFailure('not-read-back');
      return { item, turn, opened: made.opened };
    },

    endActivity(conversationId, turnId, key, end) {
      const itemId = transaction('activity-end', () => {
        const held = activityRow(conversationId, turnId, key);
        if (held === null) return null;
        setActivity(conversationId, held.id, endedBody(held.body, end));
        return held.id;
      });
      if (itemId === null) return null;
      const item = itemRow(conversationId, itemId);
      const turn = turnRow(conversationId, turnId);
      if (item === null || turn === null) throw new StorageFailure('not-read-back');
      return { item, turn };
    },

    settleActivities(conversationId, items) {
      if (items.length === 0) return 0;
      return transaction('activities-settled', () => items.reduce((sum, item) => sum + run(
        // Its status alone, with what it has (C29); one that has ended meanwhile is left as it is.
        "UPDATE item SET body = json_set(body, '$.activity.status', ?, '$.complete', json(?)) WHERE id = ? AND conversationId = ? AND kind = 'activity' AND json_extract(body, '$.activity.status') = 'running'",
        item.status, jsonFlag(item.status === 'completed'), item.id, conversationId,
      ), 0));
    },

    conversation(id) {
      const row = get('SELECT id, reference, folder, configFolder, startHeld, reachedStart, removing, createdAt, parentId, mode, modeSource FROM conversation WHERE id = ?', id);
      if (row === undefined) return null;
      return {
        id: String(row['id']), reference: text(row['reference']), folder: text(row['folder']), configFolder: text(row['configFolder']),
        startHeld: flag(row['startHeld']), reachedStart: flag(row['reachedStart']), removing: flag(row['removing']), createdAt: integer(row['createdAt']) ?? 0,
        parentId: text(row['parentId']),
        mode: chatMode(row['mode'], row['modeSource']),
      };
    },

    lastReportedTurn(conversationId) {
      return text(get('SELECT providerTurnId FROM turn WHERE conversationId = ? AND providerOutcome IS NOT NULL AND providerTurnId IS NOT NULL ORDER BY place DESC LIMIT 1', conversationId)?.['providerTurnId']);
    },

    asides(parentId) {
      return all('SELECT id, title, source, createdAt FROM conversation WHERE parentId = ? AND removing = 0 ORDER BY createdAt, id', parentId).map((row) => {
        const source = readSource(row['source']);
        return { id: String(row['id']), title: titleOf(row['title']), source: source === null ? null : sourceRef(source), createdAt: integer(row['createdAt']) ?? 0 };
      });
    },

    aside(id) {
      const row = get('SELECT id, parentId, title, source, createdAt, removing FROM conversation WHERE id = ? AND parentId IS NOT NULL', id);
      if (row === undefined) return null;
      return { id: String(row['id']), parentId: String(row['parentId']), title: titleOf(row['title']), source: readSource(row['source']), createdAt: integer(row['createdAt']) ?? 0, removing: flag(row['removing']) };
    },

    turn: turnRow,

    lastLocalTurn(conversationId) {
      const row = get(`SELECT ${TURN_COLUMNS} FROM turn WHERE conversationId = ? AND origin = 'local' ORDER BY place DESC LIMIT 1`, conversationId);
      return row === undefined ? null : toTurn(row);
    },

    newestPage(conversationId) {
      const newest = takeEntries(`SELECT ${ITEM_COLUMNS} ${ITEMS_FROM} WHERE t.conversationId = ? AND ${OWN} ORDER BY t.place DESC, i.place DESC`, [conversationId], PAGE_ENTRIES, MAX_PAGE_UNITS).reverse();
      return rows(conversationId, newest);
    },

    pageBefore(conversationId, cursor) {
      const at = itemRow(conversationId, cursor);
      if (at === null || at.workerId !== null) return null;
      const page = takeEntries(
        `SELECT ${ITEM_COLUMNS} ${ITEMS_FROM} WHERE t.conversationId = ? AND t.place <= ? AND (t.place < ? OR i.place < ?) AND ${OWN} ORDER BY t.place DESC, i.place DESC`,
        [conversationId, at.order.turn, at.order.turn, at.order.item], PAGE_ENTRIES, MAX_PAGE_UNITS,
      ).reverse();
      return rows(conversationId, page);
    },

    window(conversationId, from, keep) {
      const at = itemRow(conversationId, from);
      if (at === null || at.workerId !== null) return null;
      const direction = keep === 'newest' ? 'DESC' : 'ASC';
      const held = takeEntries(
        `SELECT ${ITEM_COLUMNS} ${ITEMS_FROM} WHERE t.conversationId = ? AND t.place >= ? AND (t.place > ? OR i.place >= ?) AND ${OWN} ORDER BY t.place ${direction}, i.place ${direction}`,
        [conversationId, at.order.turn, at.order.turn, at.order.item], WINDOW_ENTRIES, MAX_WINDOW_UNITS,
      );
      if (keep === 'newest') held.reverse();
      return rows(conversationId, held);
    },

    workerItems(conversationId, workerId, cursor) {
      // By the worker's own index, newest first (C28, C32): its items are all in the turn that started it.
      const from = `FROM item i JOIN turn t ON t.id = i.turnId WHERE i.conversationId = ? AND i.workerId = ?`;
      let items: ConversationItem[];
      if (cursor === undefined) {
        items = takeEntries(`SELECT ${ITEM_COLUMNS} ${from} ORDER BY i.place DESC`, [conversationId, workerId], WINDOW_ENTRIES, MAX_WINDOW_UNITS).reverse();
      } else {
        const at = itemRow(conversationId, cursor);
        if (at === null || at.workerId !== workerId) return null;
        items = takeEntries(`SELECT ${ITEM_COLUMNS} ${from} AND i.place < ? ORDER BY i.place DESC`, [conversationId, workerId, at.order.item], PAGE_ENTRIES, MAX_PAGE_UNITS).reverse();
      }
      const first = items[0];
      const last = items.at(-1);
      return {
        items: fold(conversationId, items),
        turns: turnsOf(conversationId, items),
        older: first !== undefined && get('SELECT 1 AS found FROM item WHERE conversationId = ? AND workerId = ? AND place < ? LIMIT 1', conversationId, workerId, first.order.item) !== undefined,
        latest: last === undefined || get('SELECT 1 AS found FROM item WHERE conversationId = ? AND workerId = ? AND place > ? LIMIT 1', conversationId, workerId, last.order.item) === undefined,
      };
    },

    workerItem(conversationId, workerId) {
      // In the turn the worker's own items are in; for a worker that has none yet, in the newest turns.
      const own = text(get('SELECT turnId FROM item WHERE conversationId = ? AND workerId = ? LIMIT 1', conversationId, workerId)?.['turnId']);
      const turns = own !== null ? [own] : all('SELECT id FROM turn WHERE conversationId = ? ORDER BY place DESC LIMIT ?', conversationId, WORKER_ITEM_TURNS).map((row) => String(row['id']));
      for (const turnId of turns) {
        const row = get(
          `SELECT ${ITEM_COLUMNS} FROM item i JOIN turn t ON t.id = i.turnId WHERE i.turnId = ? AND i.conversationId = ? AND i.kind = 'activity' AND i.workerId IS NULL AND json_extract(i.body, '$.activity.workerId') = ? ORDER BY i.place DESC LIMIT 1`,
          turnId, conversationId, workerId,
        );
        if (row !== undefined) return toItem(row);
      }
      return null;
    },

    workers(conversationId, limit) {
      const found = all(
        `SELECT i.receivedAt AS receivedAt, i.providerAt AS providerAt, i.body AS body, t.acceptedAt AS acceptedAt, t.sessionEndedAt AS sessionEndedAt, t.endReceivedAt AS endReceivedAt FROM item i JOIN turn t ON t.id = i.turnId WHERE ${WORKER_ITEMS} ORDER BY t.place DESC, i.place DESC LIMIT ?`,
        conversationId, Math.max(0, limit),
      );
      return found.flatMap((row) => { const listed = listedWorker(row); return listed === null ? [] : [listed]; });
    },

    ensure(conversationId, at) {
      const made = transaction('ensure', () => run('INSERT INTO conversation (id, startHeld, createdAt) SELECT ?, 0, ? WHERE NOT EXISTS (SELECT 1 FROM conversation WHERE id = ?)', conversationId, at, conversationId)) > 0;
      if (made) tell();
    },

    createConversation(conversationId, at, mode) {
      const made = transaction('create', () => run(
        'INSERT INTO conversation (id, startHeld, createdAt, mode, modeSource) SELECT ?, 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM conversation WHERE id = ?)',
        conversationId, at, mode?.id ?? null, mode?.source ?? null, conversationId,
      )) > 0;
      if (made) tell();
    },

    draftOnly(conversationId) {
      return get(`SELECT (EXISTS (SELECT 1 FROM conversation WHERE id = ? AND (reference IS NOT NULL OR parentId IS NOT NULL OR removing != 0))
        OR EXISTS (SELECT 1 FROM turn WHERE conversationId = ?)
        OR EXISTS (SELECT 1 FROM conversation WHERE parentId = ?)
        OR EXISTS (SELECT 1 FROM queue WHERE sessionId = ?)) AS occupied`, conversationId, conversationId, conversationId, conversationId)?.['occupied'] === 0;
    },

    setDraftMode(conversationId, mode, at) {
      transaction('draft-mode', () => {
        run('INSERT INTO conversation (id, startHeld, createdAt) SELECT ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM conversation WHERE id = ?)', conversationId, at, conversationId);
        if (run('UPDATE conversation SET mode = ?, modeSource = ? WHERE id = ? AND parentId IS NULL AND reference IS NULL AND NOT EXISTS (SELECT 1 FROM turn WHERE conversationId = ?)', mode?.id ?? null, mode?.source ?? null, conversationId, conversationId) === 0) throw new StorageFailure('no-conversation');
      });
    },

    setMode(conversationId, mode, at, started) {
      const source: ModeSource = 'chat';
      const made = transaction('mode', () => {
        const fresh = run('INSERT INTO conversation (id, startHeld, createdAt) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM conversation WHERE id = ?)', conversationId, started ? 0 : 1, at, conversationId) > 0;
        // A session's own conversation alone: an aside's row never holds a mode (C6).
        if (run('UPDATE conversation SET mode = ?, modeSource = ? WHERE id = ? AND parentId IS NULL', mode, source, conversationId) === 0) throw new StorageFailure('no-conversation');
        return fresh;
      });
      if (made) tell();
    },

    grants(conversationId) {
      const at = (key: string): string => `json_extract(i.body, '$.interaction.${key}')`;
      return all(
        `SELECT i.id AS id, ${at('grant.covers')} AS covers, ${at('grant.processKey')} AS processKey, ${at('decidedAt')} AS decidedAt, ${at('confirmedAt')} AS confirmedAt
           ${ITEMS_FROM} WHERE t.conversationId = ? AND i.kind = 'interaction' AND ${at('kind')} = 'approval' AND ${at('outcome')} = 'approved-session' AND ${at('delivered')} = 1 AND ${at('grant.covers')} IS NOT NULL
           ORDER BY t.place, i.place`,
        conversationId,
      ).flatMap((row): StoredGrantRow[] => {
        const covers = text(row['covers']);
        const processKey = text(row['processKey']);
        return covers === null || processKey === null ? [] : [{ itemId: String(row['id']), covers, processKey, decidedAt: integer(row['decidedAt']), confirmedAt: integer(row['confirmedAt']) }];
      });
    },

    held(conversationId) {
      return {
        byProviderTurnId(providerTurnId) {
          const row = get(`SELECT ${TURN_COLUMNS} FROM turn WHERE conversationId = ? AND providerTurnId = ? ORDER BY place LIMIT 1`, conversationId, providerTurnId);
          return row === undefined ? null : heldTurn(row);
        },
        byItemId(itemId) {
          const row = get(`SELECT ${TURN_COLUMNS_OF_T} FROM item i JOIN turn t ON t.id = i.turnId WHERE i.id = ? AND i.conversationId = ?`, itemId, conversationId);
          return row === undefined ? null : heldTurn(row);
        },
      };
    },

    mergePage(conversationId, plans, anchor, notShownText, cards = false) {
      return transaction('merge', () => {
        let next = anchor;
        let changed = false;
        /** A history message at `place` of its turn, and after it the question it carries (M21, C28). Answers the next free place. */
        const placeMessage = (turnId: string, place: number, message: HistoryMessage): number => {
          const item = fromHistory(message);
          insertItem(conversationId, turnId, place, item);
          // A user's images the provider's history names, each after its message (M23, C25): by the
          // hash a path of fat-g's carries, and as not available for any other path, which is never read.
          const images = message.role === 'user' ? message.images ?? [] : [];
          const next = images.length === 0 ? place + 1 : composer.insertItems(conversationId, turnId, item.id, place + 1, images.map((image) => ({ id: newId(), hash: heldImage(image.path), name: null })));
          return cards && message.role === 'assistant' && insertHistoryAsking(conversationId, turnId, item.id, message) ? next + 1 : next;
        };
        for (const plan of plans) {
          if (plan.kind === 'held') { next = plan.turnId; continue; }
          if (plan.kind === 'new') {
            // Directly before the nearest newer turn both sides hold, or last (C49): the turns from
            // there on move up by one, in one statement.
            const anchorPlace = next === null ? null : turnRow(conversationId, next)?.place ?? null;
            const place = anchorPlace ?? nextTurnPlace(conversationId);
            if (anchorPlace !== null) run('UPDATE turn SET place = place + 1 WHERE conversationId = ? AND place >= ?', conversationId, anchorPlace);
            const id = newId();
            const { turn } = plan;
            run(
              "INSERT INTO turn (id, conversationId, place, origin, providerTurnId, providerTook, providerStartedAt, providerEndedAt, providerOutcome, providerDurationMs) VALUES (?, ?, ?, 'provider', ?, 1, ?, ?, ?, ?)",
              id, conversationId, place, turn.turnId, turn.startedAt, turn.endedAt, turn.outcome, turn.durationMs,
            );
            if (plan.notShown) insertItem(conversationId, id, 1, notShown(notShownText));
            else {
              // The turn's messages and activities, in the provider's order (M20a, C19).
              let itemPlace = 1;
              for (const entry of orderEntries(plan.messages, plan.activities ?? [])) {
                if (entry.kind === 'message') itemPlace = placeMessage(id, itemPlace, entry.message);
                else { insertHistoryActivity(conversationId, id, itemPlace, entry.activity); itemPlace += 1; }
              }
            }
            // A turn now stands after every open card of an earlier place (M21, C41): the model has moved on.
            if (cards) {
              const at = now();
              for (const row of all(`SELECT i.id AS id FROM item i JOIN turn t ON t.id = i.turnId WHERE i.conversationId = ? AND i.kind = 'interaction' AND json_extract(i.body, '$.interaction.outcome') = 'open' AND t.place < ?`, conversationId, place)) writeInteraction(conversationId, String(row['id']), 'open', { outcome: 'passed', settledAt: at });
              // And an ended turn's own cards that its model went on past (decision 0026, item 11).
              if (turn.outcome !== null) passCardsGonePast(conversationId, id, at);
            }
            next = id;
            changed = true;
            continue;
          }
          const { turnId } = plan;
          if (plan.providerTurnId !== null) changed = run('UPDATE turn SET providerTurnId = ?, providerTook = 1 WHERE id = ? AND conversationId = ? AND providerTurnId IS NULL', plan.providerTurnId, turnId, conversationId) > 0 || changed;
          if (plan.end !== null) {
            // The provider's own outcome and times, for a turn that had none (C59): never the local clock's.
            changed = run(
              'UPDATE turn SET providerOutcome = ?, providerStartedAt = coalesce(providerStartedAt, ?), providerEndedAt = coalesce(providerEndedAt, ?), providerDurationMs = coalesce(providerDurationMs, ?), providerTook = 1 WHERE id = ? AND conversationId = ? AND providerOutcome IS NULL',
              plan.end.outcome, plan.end.startedAt, plan.end.endedAt, plan.end.durationMs, turnId, conversationId,
            ) > 0 || changed;
          }
          for (const item of plan.items) {
            if (item.kind === 'name') {
              changed = run('UPDATE item SET providerItemId = ? WHERE id = ? AND conversationId = ? AND providerItemId IS NULL', item.providerItemId, item.itemId, conversationId) > 0 || changed;
              continue;
            }
            if (item.kind === 'complete') {
              changedItems.add(item.itemId);
              // The provider's own text for a message held as far as it got (M19, C68): its body's
              // named keys, the row's id, place and time kept. One that is complete is left alone,
              // so a second merge changes nothing.
              const { message } = item;
              const cut = cutTo(message.text, MAX_MESSAGE_TEXT);
              changed = run(
                "UPDATE item SET body = json_set(body, '$.blocks[0].text', ?, '$.blocks[0].cut', json(?), '$.complete', json('true'), '$.phase', ?, '$.questions', json(?)) WHERE id = ? AND conversationId = ? AND json_extract(body, '$.complete') = 0",
                cut.text, jsonFlag(message.cut === true || cut.cut), message.phase, JSON.stringify(message.questions ?? []), item.itemId, conversationId,
              ) > 0 || changed;
              // The question it carries, which its partial text never held (M21, C28): once for the message.
              if (cards && message.role === 'assistant') changed = insertHistoryAsking(conversationId, turnId, item.itemId, message) || changed;
              continue;
            }
            if (item.kind === 'complete-activity') {
              // The provider's own end for an activity whose end never came here (M20a, C58): its
              // body's named keys, the row's id, place and time kept, and whatever else the body
              // holds. One that is complete is left alone, so a second merge changes nothing.
              const held = get("SELECT body FROM item WHERE id = ? AND conversationId = ? AND kind = 'activity' AND json_extract(body, '$.complete') = 0", item.itemId, conversationId);
              const body = held === undefined ? null : readBody(held['body']).activity;
              if (body !== null) changed = setActivity(conversationId, item.itemId, endedBody(body, fromHistoryActivity(item.activity).end)) > 0 || changed;
              continue;
            }
            const beforePlace = item.before === null ? null : integer(get('SELECT place FROM item WHERE id = ? AND turnId = ?', item.before, turnId)?.['place']);
            const place = beforePlace ?? nextItemPlace(turnId);
            // A message takes its images' places after it (M23, C25).
            const width = item.kind === 'add' && item.message.role === 'user' ? 1 + (item.message.images?.length ?? 0) : 1;
            if (beforePlace !== null) run('UPDATE item SET place = place + ? WHERE turnId = ? AND place >= ?', width, turnId, beforePlace);
            if (item.kind === 'add') placeMessage(turnId, place, item.message);
            else insertHistoryActivity(conversationId, turnId, place, item.activity);
            changed = true;
          }
          if (plan.notShown) { insertItem(conversationId, turnId, nextItemPlace(turnId), notShown(notShownText)); changed = true; }
          if (plan.clearGap) changed = run('UPDATE turn SET gap = 0 WHERE id = ? AND conversationId = ?', turnId, conversationId) > 0 || changed;
          // A turn the provider says ended: its cards its model went on past, whatever this merge brought into it (decision 0026, item 11).
          if (cards && turnRow(conversationId, turnId)?.providerOutcome != null) changed = passCardsGonePast(conversationId, turnId, now()).length > 0 || changed;
          next = turnId;
        }
        return { anchor: next, changed };
      });
    },

    markReached(conversationId, providerTurnIds, reachedStart) {
      transaction('reached', () => {
        for (const providerTurnId of providerTurnIds) run('UPDATE turn SET reached = 1 WHERE conversationId = ? AND providerTurnId = ?', conversationId, providerTurnId);
        if (reachedStart) run('UPDATE conversation SET reachedStart = 1 WHERE id = ?', conversationId);
      });
    },

    markRemoving(ids) {
      // A conversation's asides are marked with it (M20b, C32): nothing of it is shown again, and a crash finishes both.
      const marked = transaction('mark', () => ids.reduce((sum, id) => { changedConversations.add(id); return sum + run('UPDATE conversation SET removing = 1 WHERE id = ? OR parentId = ?', id, id); }, 0));
      if (marked > 0) tell();
    },

    liftRemoving(ids) {
      const lifted = transaction('lift', () => ids.reduce((sum, id) => { changedConversations.add(id); return sum + run('UPDATE conversation SET removing = 0 WHERE id = ? OR parentId = ?', id, id); }, 0));
      if (lifted > 0) tell();
    },

    deleteRemoving(ids) {
      const deleted = transaction('delete', () => {
        /**
         * A conversation, whole: its items, its turns, and itself — and its draft and its queue, whose
         * images, and its items', go with their last use (M23, C6; 0019, item 11).
         */
        const erase = (conversationId: string): number => {
          changedConversations.add(conversationId);
          release(composer.itemBlobs(conversationId));
          release(composer.eraseComposer(conversationId));
          run('DELETE FROM item WHERE conversationId = ?', conversationId);
          run('DELETE FROM turn WHERE conversationId = ?', conversationId);
          return run('DELETE FROM conversation WHERE id = ?', conversationId);
        };
        let count = 0;
        for (const id of ids) {
          const marked = get('SELECT 1 AS found FROM conversation WHERE id = ? AND removing = 1', id) !== undefined;
          // Its asides first, whole (M20b, C32, C71): none outlives its parent. Where the conversation
          // itself is marked, every one of them; and where it has no row of its own — a session asked
          // beside, and never prompted, since the store was made — those its removal marked.
          for (const aside of all(marked ? 'SELECT id FROM conversation WHERE parentId = ?' : 'SELECT id FROM conversation WHERE parentId = ? AND removing = 1', id).map((row) => String(row['id']))) count += erase(aside);
          if (marked) count += erase(id);
        }
        return count;
      });
      if (deleted === 0) return;
      checkpoint();
      // A count, never an id.
      log.info(`[conversations] removed ${deleted} ${deleted === 1 ? 'conversation' : 'conversations'}`);
      tell();
    },

    // An aside marked with its parent is its parent's to finish (M20b, C32): it is named only where it was removed alone.
    removing: () => all('SELECT c.id AS id FROM conversation c WHERE c.removing = 1 AND (c.parentId IS NULL OR NOT EXISTS (SELECT 1 FROM conversation p WHERE p.id = c.parentId AND p.removing = 1))').map((row) => String(row['id'])),

    blob: (hash) => composer.blob(hash),

    draft: (sessionId) => composer.draft(sessionId),

    queue: (sessionId) => composer.queue(sessionId),

    saveDraft(sessionId, revision, value, at, started) {
      const made = transaction('draft', () => ({ fresh: ensureRow(sessionId, at, started), saved: composer.setDraft(sessionId, revision, value, at) }));
      if (made.fresh) tell();
      return made.saved;
    },

    stageDraft(sessionId, blob, use, at, started) {
      const made = transaction('stage', () => {
        const fresh = ensureRow(sessionId, at, started);
        const name = composer.stage(sessionId, blob, use, at);
        return { fresh, name };
      });
      if (made.fresh) tell();
      return made.name;
    },

    removeDraftAttachment(sessionId, useId, at) {
      return transaction('draft-remove', () => {
        const hash = composer.removeDraftUse(sessionId, useId);
        if (hash === null) return false;
        release([hash]);
        run('UPDATE draft SET changedAt = ? WHERE sessionId = ?', at, sessionId);
        return true;
      });
    },

    clearDraft(sessionId, revision, at) {
      transaction('draft-clear', () => release(composer.clearDraft(sessionId, revision, at)));
    },

    enqueue(sessionId, entryId, given, at, started, index) {
      const fresh = transaction('queue', () => {
        const made = ensureRow(sessionId, at, started);
        composer.enqueue(sessionId, entryId, given, at, index);
        return made;
      });
      if (fresh) tell();
    },

    editQueued(sessionId, entryId, given, at) {
      transaction('queue-edit', () => composer.edit(sessionId, entryId, given, at));
    },

    unqueue(sessionId, entryId) {
      try {
        transaction('unqueue', () => release(composer.unqueue(sessionId, entryId)));
        return true;
      } catch (error) {
        if (error instanceof StorageFailure && error.kind === 'unknown-entry') return false;
        throw error;
      }
    },

    reorderQueue(sessionId, ids) {
      transaction('queue-order', () => composer.reorder(sessionId, ids));
    },

    dropQueue(sessionId) {
      transaction('queue-drop', () => release(composer.dropQueue(sessionId)));
    },

    withContent: () => composer.withContent(),

    queued: () => composer.queued(),

    attachmentsSize: () => blobs.measure(),

    conversations: () => all('SELECT id, removing, createdAt, parentId FROM conversation ORDER BY createdAt, id').map((row) => ({ id: String(row['id']), removing: flag(row['removing']), createdAt: integer(row['createdAt']) ?? 0, parentId: text(row['parentId']) })),

    firstPrompt(conversationId) {
      const row = get(`SELECT i.body AS body ${ITEMS_FROM} WHERE t.conversationId = ? AND json_extract(i.body, '$.role') = 'user' ORDER BY t.place, i.place LIMIT 1`, conversationId);
      const first = row === undefined ? undefined : readBody(row['body']).blocks[0];
      return first?.text ?? null;
    },

    hasTextPrompt(conversationId) {
      return get(`SELECT 1 AS found ${ITEMS_FROM} WHERE t.conversationId = ? AND t.own = 0 AND i.kind = 'message' AND i.workerId IS NULL AND json_extract(i.body, '$.role') = 'user' AND trim(coalesce(json_extract(i.body, '$.blocks[0].text'), '')) <> '' LIMIT 1`, conversationId) !== undefined;
    },

    // Every row's body, an activity's and a worker's item's among them, and those of its asides with their excerpts (M20b, C71).
    textUnits(ids) {
      return ids.reduce((sum, id) => sum
        + (integer(get('SELECT coalesce(sum(length(i.body)), 0) AS units FROM item i JOIN conversation c ON c.id = i.conversationId WHERE c.id = ? OR c.parentId = ?', id, id)?.['units']) ?? 0)
        + (integer(get('SELECT coalesce(sum(length(source)), 0) AS units FROM conversation WHERE parentId = ?', id)?.['units']) ?? 0), 0);
    },

    files,

    close() {
      tellSearch(null);
      if (state.kind !== 'open') {
        if (state.kind === 'refused') state = { kind: 'closed' };
        return;
      }
      const { db } = state;
      state = { kind: 'closed' };
      statements = new Map();
      reserved = new Map();
      try {
        db.close();
      } catch (error) {
        // Left as after a crash: the next launch opens it so (C45).
        log.warn(`[conversations] the store could not be closed (${errorKind(error)})`);
      }
    },

    startFresh() {
      // Two confirmations sent together move the files once.
      startingFresh ??= (async (): Promise<StartFreshResult> => {
        if (state.kind !== 'refused') return { status: 'refused', reason: 'not-refused' };
        // A refused store has no connection: nothing holds its files. Its images go aside with it, as one
        // generation, and none of them is swept (M23, C84).
        const keptAs = await files.moveAside(now());
        log.warn('[conversations] the refused store was moved aside with its images; starting with no saved chats');
        statements = new Map();
        reserved = new Map();
        state = open();
        tellSearch(null);
        tell();
        return { status: 'done', keptAs };
      })().finally(() => {
        startingFresh = null;
      });
      return startingFresh;
    },
  };
}
