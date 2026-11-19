// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The session runtime (docs/planning/_archive/M15.md, Design 9, 11, 12; C30–C32, C47, C85, C86, C99, C104,
// C108, C109, C116–C118, C122; M18.md, Design 4, 6, 7; M16.md, Design 6; M20a.md, Design 5, 7): what makes a prompt a turn. It holds, per
// session, the provider's session if one is open, the turn in flight, the idle clock, a reference
// the record does not hold, and a session whose end could not be confirmed.
//
// And what makes a question beside a session an aside's turn (docs/planning/_archive/M20b.md, Design 5; C10,
// C34, C35, C50, C73; decision 0025). An ask goes through the same reason and the same start as a
// prompt, with no turn of the session's: it waits for none, a turn waits for none of it, and the
// idle clock waits for both. Its events name the aside, and go to the aside's conversation alone.
//
//   chat:ask  ─► the reason ─► refused, or: the same selection again ─► its aside's id, nothing sent
//                             else accepted in one step: the question recorded, or the ask refused
//             ─► start or resume, if no session is open ─► session.ask
//
// A prompt that is a command fat-g answers itself (decision 0023) is a turn of the session's that
// no provider is sent: accepted, answered with fat-g's notice and ended in one step.
//
//   chat:send ─► the reason (gate.ts) ─► refused, or accepted in one step, nothing awaited:
//                 turn id made · the prompt recorded, or the Send refused · turn-started ·
//                 in-force (effort) · name, if first
//               ─► the instance's facet ─► start or resume, if no session is open ─► session.send
//   event     ─► schema ─► bridge ─► the session service ─► the summary and the record
//                                 └► the chat service ─► the conversation store ─► the push
//
// A session becomes listed, at launch or when the records are read again: its record and the
// conversation store are reconciled before its history is checked and before it takes a prompt
// (M18, C55), which is why every path to a session goes through `live`.
//
// And what makes a question the session asks a card that can be answered (docs/planning/_archive/M21.md,
// Design 2, 5; C10–C15, C26, C31, C67, C75, C77; decision 0026). The two question events go to the
// request registry with the generation of the process they came on, and to no bridge; the ends go
// to its sweeps; and before anything the runtime ends itself — a quit's Stop, an idle or a
// removal's close — and first thing when a session's handle closes, what still waited is dropped,
// so that no end made for a loss withdraws what the loss dropped.
//
//   chat:answer ─► a blocking card: the registry, behind `busy` alone ─► the item, then session.answer
//               ─► an async card: a prompt in fat-g's words, through the send's own checks, its
//                  acceptance one transaction with the card's answer and the pass of the others
//
// And what makes a session run under a mode, and an action it asks leave for a card that can be
// decided (docs/planning/_archive/M22.md, Design 2–5, 9; C1, C2, C12, C40, C43, C46, C49, C75, C81, C86,
// C88–C90; decision 0027). A chat's mode is the conversation store's: read once a run, snapshotted
// when the session is made, and handed to the adapter at every open, with a key of that process's
// own. The adapter says which mode its process confirmed, and that is all the summary shows.
//
//   chat:setMode ─► every reason but the mode's own two ─► refused, or: the session busy under the
//                   change until it is written or refused
//                ─► idle: the live process's own change, confirmed by the CLI, then the row
//                ─► restart: the row at once, the live process closed with its grants, nothing
//                   launched — the next start opens under the saved mode, and its check confirms it
//   chat:decide  ─► the registry, behind `busy` and a change alone ─► the item, then session.decide
//
// A start that reports another policy than the chat's mode fails its turn and blocks Send, until a
// mode the account runs is chosen; so does a chat whose saved mode its account cannot use. Neither
// stops the change that remedies it, nor a decision on a card its live process raised (C89).
//
// And what makes a prompt a plan turn, and a plan's decision what the user takes (docs/planning/
// M22b.md, Design 6; C1–C3, C5, C10–C13, C15, C27, C55, C56, C58, C64, C65, C71–C73; decision 0029).
// A plan turn is a prompt's own mode: the chat's mode is never changed for it, and the toggle that
// asks for it is refused where the provider's descriptor does not list that mode or its account's
// CLI refused what a plan turn needs. While a plan's decision waits, nothing but that decision is
// taken: a prompt and a change of mode are refused.
//
//   chat:send {plan}  ─► the send's own checks ─► plans-unavailable, plan-pending, or a plan turn:
//                        its prompt kept with the turn's flag, its notice, the request's `plan`
//   plans:decide      ─► a request's line: the registry, behind `busy` and a change alone
//                     ─► any other: Cancel written; feedback and Execute a turn, through the send's
//                        own checks, the line decided in its prompt's own transaction
//   plans:bring       ─► the send's own checks, then the line in a turn of fat-g's own
//
// Every turn after a plan turn on a thread names `plannedBefore`, from the store's record of each
// turn's flag (C55), so that the adapter can take the thread out of the CLI's plan mode.
//
// Since a plan's workflow is shared by its chats (decision 0029), what waits on it is the workflow
// coordinator's word: a chat's own prompt is admitted by it, the turns that carry an operation on
// are told to it as they are accepted and end, and so are a session's idling, its loss, its removal
// and its being shelved or marked Done. A change of mode is taken while the chat's plan is ready,
// the request it holds on the plan retired first. The coordinator sends through this runtime.
//
// Electron-free, and no provider is named here: a session is reached only through the facet the
// registry hands in. It starts no process and writes no file: the adapter does the first, and the
// session service and the conversation store, each handed in, the second.
import { type AgentEvent, AgentEventSchema, MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { type AsideCapability, type AsideSource, asideTitle, seedQuestion, sourcePhrase } from '@shared/contracts/aside';
import {
  asideNoticeWords,
  blockWords,
  type ChatAnswerResult,
  type ChatAsideReadResult,
  type ChatAsideRemoveResult,
  type ChatAsideStopResult,
  type ChatAskRequest,
  type ChatAskResult,
  type ChatDecideResult,
  type ChatDismissResult,
  type ChatLoadHistoryResult,
  type ChatPageResult,
  type ChatReadResult,
  type ChatSendResult,
  type ChatSetModeResult,
  type ChatStopResult,
  type ChatWorkerReadResult,
  type HistoryState,
  type NoticeExtra,
  noticeWords,
} from '@shared/contracts/chat';
import { findModel, type CatalogState } from '@shared/contracts/catalog';
import type { CommandNoticeKind } from '@shared/contracts/conversation';
import { type InstanceRef, sameInstance } from '@shared/contracts/instances';
import { type AnswerEntry, answerPrompt, type ApprovalChoice, approvalOf, asksAsync, fits, type InteractionAnswer, keptAnswers, placeAnswers, planOf, type QuestionCapability, questionOf } from '@shared/contracts/interaction';
import { planChatName, type PlanBringRequest, type PlanBringResult, type PlanCapability, type PlanDecideResult, type PlanFields, type PlanOutcome, planTurnBlocked } from '@shared/contracts/plans';
import { type ChatMode, readingMode as readingModeOf, setupHolds } from '@shared/contracts/permissions';
import { MAX_FINISHED_AGENTS, type PlanWait, type RunningDoing, type SendBlock, type TurnOutcome } from '@shared/contracts/sessions';
import type { PlanAnswer, PromptAttachment, ProviderCommand, ProviderSession, SessionFacet, SteerOutcome } from '@shared/provider-kit/sessions';
import type { AttachmentDescriptor, AttachmentStageResult } from '@shared/contracts/attachments';
import { type ChatCommandsResult, type ChatComposer, type ChatDraftRequest, type ChatDraftResult, type ChatEditQueuedRequest, type ChatQueueRequest, type ChatQueueResult, COMMAND_GROUPS, type CommandRow, EMPTY_COMPOSER, MENU_WORDS, type PromptIntent, type QueueView, type SteerState } from '@shared/contracts/composer';
import type { BlobFiles } from '../attachments/files';
import { type ConversationStore, type NewItem, StorageFailure } from '../conversations/store';
import { errorKind } from '../storage/error-kind';
import { type ComposerService, type ComposerStore, createComposerService } from './composer';
import type { ContentPresence } from './content';
import { createQueueDrain, type QueuedInput } from './queue';
import type { SessionRecord } from '../records/format';
import type { RecordsStore } from '../records/store';
import { bridge, type Bridged, firstPromptName } from './bridge';
import type { ChatService } from './chat-service';
import { blocksHistory, type Gate } from './gate';
import { checkHistory } from './history-check';
import type { ReturnedImages } from './returned-images';
import type { Permissions } from './permissions';
import type { PlanService } from './plans';
import type { WorkflowCoordinator } from './workflow';
import { reconcile, type StoreFacts } from './reconcile';
import type { Removal } from './removal';
import { type Answerable, createRequestRegistry, type RequestRegistry } from './requests';
import type { Secretary } from './secretary/service';
import type { SessionService } from './service';
import type { ModelPreset } from '@shared/contracts/presets';
import type { SessionRefusal, SessionSaved } from '@shared/contracts/sessions';
import { saveDraftPreset } from './draft-preset';

/** A session's process is closed this long after it stopped running (C85). */
export const IDLE_CLOSE_MS = 5 * 60_000;
/** How long the quit waits, in all, for the Stops to be confirmed (C117). */
export const QUIT_STOP_MS = 5_000;

export interface RuntimeTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SessionRuntimeOptions {
  /** Catalog wording snapshotted with each requested speed tier, never read from history. */
  readonly catalog?: () => CatalogState | undefined;
  /** Best-effort history only, after a provider-bound prompt is accepted. No content leaves here. */
  readonly modelUsed?: (preset: ModelPreset) => void;
  readonly sessions: Pick<SessionService, 'apply' | 'record' | 'workerLabel' | 'isRunning' | 'owns' | 'hold' | 'holdNow' | 'isLeaving' | 'snapshot' | 'reconcile' | 'noteUserAction'> & Partial<Pick<SessionService, 'availabilityChanged' | 'runningTurn'>>;
  readonly records: Pick<RecordsStore, 'subscribe' | 'getView' | 'isRefused' | 'removeSession'> & Partial<Pick<RecordsStore, 'setDraftPreset'>>;
  /** The facet of an instance's current runtime, or undefined while it has none. */
  readonly facet: (ref: InstanceRef) => SessionFacet | undefined;
  /** A provider's own name, for fat-g's words. */
  readonly providerName: (providerId: string) => string;
  /** Whether a provider keeps a conversation fat-g can read back: its descriptor's word (M18, C6). */
  readonly hasHistory: (providerId: string) => boolean;
  /**
   * Whether a provider's sessions take a project's other roots: its descriptor's word (M16, C61).
   * Without it, or for a provider that does not, a session is handed an empty list.
   */
  readonly takesOtherFolders?: (providerId: string) => boolean;
  /**
   * Whether a provider answers a question asked beside a session, and how: its descriptor's word
   * (M20b, C24). Without it, or for a provider that says `none`, no ask is taken.
   */
  readonly asides?: (providerId: string) => AsideCapability;
  /**
   * Whether a provider's sessions ask questions, and how: its descriptor's word (M21, C30). Without
   * it, or for a provider that says `none`, a message's questions make no card.
   */
  readonly questions?: (providerId: string) => QuestionCapability;
  /** The request registry (M21, C10): what holds every live request. Left out, the runtime makes its own. */
  readonly requests?: RequestRegistry;
  /**
   * Which mode a chat has, and whether its account can use it (M22, C1, C43): the hierarchy, over
   * the descriptors, the two defaults and each account's facet. Without it no session has a mode:
   * each is opened with none, and nothing of a mode blocks or is offered.
   */
  readonly permissions?: Permissions;
  /** The configuration folder an instance has now (M14b, C61): kept with a reference in the conversation store too (M18, C28). */
  readonly configFolder?: (ref: InstanceRef) => string | null;
  readonly gate: Gate;
  readonly chat: ChatService;
  readonly returnedImages?: ReturnedImages;
  /** The conversation store, as the runtime needs it: to reconcile, and for the history check's writes. */
  readonly store: Pick<ConversationStore, 'status' | 'conversation' | 'turn' | 'lastLocalTurn' | 'ensure' | 'held' | 'mergePage' | 'markReached' | 'aside' | 'lastReportedTurn'> & Partial<Pick<ConversationStore, 'plannedBefore' | 'turnPlan' | 'hasTextPrompt' | 'workers'>>;
  /**
   * Plans (M22b; decision 0029): the plan service, and what a provider's descriptor says of its plan
   * turns. Without either, no plan turn is taken and no plan's decision either.
   */
  readonly plans?: PlanService;
  readonly planCapability?: (providerId: string) => PlanCapability | null;
  /** The removals a crash cut short (M18, C63): finished before their sessions are reconciled. And an aside's own removal (M20b, C32). */
  readonly removal: Pick<Removal, 'finish' | 'pending' | 'detached'>;
  readonly now?: () => number;
  /**
   * A clock that only goes forward, in milliseconds (M19, C44): what a turn's elapsed time is
   * measured on, so that a change of the system clock during a turn does not change it.
   */
  readonly monotonic?: () => number;
  readonly newId?: () => string;
  readonly timers?: RuntimeTimers;
  readonly idleMs?: number;
  /** Counts and kinds only (C75): never a prompt, a message, a label, a reference, a path or a notice's detail. */
  readonly log?: Pick<Console, 'info' | 'warn'>;
  /**
   * The secretary (M26; decision 0028): asked for a session's title at its first accepted prompt,
   * told when a session goes or the user names it, and let go of at the quit. Without it a session
   * keeps the name its first prompt gave it.
   */
  readonly secretary?: Pick<Secretary, 'title' | 'forget' | 'dispose'>;
  /**
   * The composer (M23; decision 0030): the store's draft and queue rows and the images' folder. Left
   * out, no image is staged and no draft is kept: a read answers an empty composer.
   */
  readonly composer?: {
    readonly store: ComposerStore & Pick<ConversationStore, 'queue' | 'queued' | 'enqueue' | 'editQueued' | 'unqueue' | 'reorderQueue' | 'dropQueue'>;
    readonly blobs: Pick<BlobFiles, 'write' | 'remove' | 'holds' | 'read' | 'pathOf'>;
    /** Whether each session's draft or queue holds something (C83), read again after each change: the session list's presence. */
    readonly presence?: Pick<ContentPresence, 'refresh'>;
  };
  /**
   * Plan review (M22e; decision 0029): told of each turn's end once its answer is written, of each
   * prompt's acceptance and of a card's dismissal — what continues or ends a turn that asked (C49) —
   * of a process's loss, and of a session's removal. Late bound: the review service sends through
   * this runtime.
   */
  readonly reviews?: () => ReviewHooks | undefined;
  /**
   * The plans' shared workflow (decision 0029): what admits a chat's own prompt while a plan holds it,
   * and what is told of each turn that may carry an operation on. Without it, a plan's line waiting
   * in the chat is what holds it.
   */
  readonly workflow?: Pick<WorkflowCoordinator, 'admit' | 'readyIn' | 'retireForMode' | 'accepted' | 'turnEnded' | 'idle' | 'cardSettled' | 'lost' | 'forget' | 'closed' | 'settleForRemoval'>;
}

/** What the runtime tells the review service (M22e, C25, C43, C49): ids and outcomes, never a text. */
export interface ReviewHooks {
  /** A turn ended, its answer's text and phase written (C43). */
  turnEnded(sessionId: string, turnId: string, outcome: TurnOutcome): void;
  /** A prompt was accepted: `answered`, the async card it answers, where it answers one (C49). Every other open card of the chat was passed by it. */
  accepted(sessionId: string, turnId: string, answered: string | null): void;
  /** An async card was dismissed (C49). */
  dismissed(sessionId: string, itemId: string): void;
  /** The session's process ended: a turn it still ran is over with it. */
  lost(sessionId: string): void;
  /** The session is no longer listed. */
  forget(sessionId: string): void;
  /** A running turn of the session's, as a review's or an integration's (M22e): what a refusal because it runs says; null for any other. */
  doing(sessionId: string, turnId: string): 'review' | 'integration' | null;
}

/**
 * A prompt fat-g composed (M22e, C2, C24, C25, C31): its text, the turn and item ids its caller
 * allotted so that a record can name them before anything is sent, whether it is a plan turn, the
 * plan fields its item keeps, and whether it names the session — a reviewer's first prompt does not,
 * its name being the review's (C26).
 */
export interface ComposedPrompt {
  readonly prompt: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly plan: boolean;
  readonly fields: PlanFields | null;
  readonly names: boolean;
}

/** A finding's question beside its reviewer's session (M22e, C34, C54): a source of kind `message`, and fat-g's words for it. */
export interface FindingAsk {
  readonly sessionId: string;
  readonly asideId: string;
  readonly source: AsideSource;
  readonly question: string;
}

/** A Send's draft (M23, C86): the revision past every update the page handed over, its images by their uses' ids, and its intent. */
export interface SendInput {
  readonly revision: number;
  readonly attachmentIds: readonly string[];
  readonly intent: PromptIntent;
}

export interface SessionRuntime {
  setDraftPreset(id: string, preset: ModelPreset): Promise<SessionSaved | SessionRefusal>;
  /** The newest page, or the window the page holds (M18, C60). */
  read(sessionId: string, window?: { readonly from: string; readonly keep: 'newest' | 'oldest' }): ChatReadResult;
  /** An image staged into a session's draft (M23, C14): its descriptor, or why not. */
  stage(sessionId: string, bytes: Uint8Array, name?: string): Promise<AttachmentStageResult>;
  /** A change of a session's draft (M23, C86): its text and intent, an image taken out, a clear, or a write now. */
  draft(request: ChatDraftRequest): ChatDraftResult;
  /** Every draft main holds and has not written, written now (M23, C31): the quit's, before the store closes. */
  flushDrafts(): void;
  /** Queue next (M23, C47, C48): the draft appended to the session's queue; or the queue put in the order named (C51, C86). */
  queue(request: ChatQueueRequest): Promise<ChatQueueResult>;
  /** A queued message removed (M23, C50): never the one being sent. */
  unqueue(sessionId: string, entryId: string): ChatQueueResult;
  /** Edit (M23, C50, C87): the entry's input into the draft, and the draft as given into its place. */
  editQueued(request: ChatEditQueuedRequest): Promise<ChatQueueResult>;
  /** Resume a paused queue after its remedy (M23, C89). */
  resumeQueue(sessionId: string): ChatQueueResult;
  /** The menu's rows for the session (M23, C58–C64, C86): fat-g's own, then its CLI's commands, then its skills. */
  commands(sessionId: string): Promise<ChatCommandsResult>;
  /** The page before a cursor (M18, C20). */
  page(sessionId: string, before: string): ChatPageResult;
  /** A worker's items (M20a, C32): its newest window, or the page before a cursor. */
  readWorker(sessionId: string, workerId: string, before?: string): ChatWorkerReadResult;
  /**
   * `plan`: the prompt is a plan turn (M22b, C1). `input`: it is the session's draft (M23, C21, C86) —
   * its revision, its images by their uses' ids and its intent — consumed in the prompt's own transaction.
   * `now`: sent into the running turn (M23, C36), or — where that turn ended first — as the next prompt.
   */
  send(sessionId: string, prompt: string, options?: { readonly plan?: boolean; readonly input?: SendInput; readonly now?: boolean }): Promise<ChatSendResult>;
  /**
   * A plan's decision (M22b, C11, C12, C15, C65, C72): for a line a request holds, to the registry,
   * the line written before the CLI is told; for any other, Cancel written, and feedback and Execute
   * a turn of the session's, sent as any prompt is, the line decided in its prompt's own transaction.
   */
  decidePlan(sessionId: string, itemId: string, decision: 'feedback' | 'execute' | 'cancel', text?: string, turnId?: string): Promise<PlanDecideResult>;
  /**
   * A prompt fat-g composed (M22e, C2, C11, C31): through every check a typed prompt meets and the
   * one step, accepted under the caller's turn id. Never one of the CLI's own commands.
   */
  sendComposed(sessionId: string, composed: ComposedPrompt): Promise<ChatSendResult>;
  /**
   * The chat's plan line that waits now (M22b, C56; M22e, C9, C50): its item, plan and version, the
   * turn it stands in, and whether a request holds it; null where none waits.
   */
  planLine(sessionId: string): { readonly itemId: string; readonly turnId: string; readonly planId: string; readonly version: number; readonly request: boolean } | null;
  /**
   * Why a chat — a listed one, or a new one of a project on an account — takes no plan turn now, in
   * its provider's words (M22b, C5, C13; M22e, C9, C50); null where it takes one.
   */
  planTurnWords(owner: Pick<SessionRecord, 'id' | 'projectId' | 'providerId' | 'instanceId'>, fresh?: boolean): string | null;
  /** The provider's reading mode where the account can use it (M22e, C2), else why not. */
  readingMode(owner: Pick<SessionRecord, 'providerId' | 'instanceId'>): { readonly mode: string } | { readonly refused: 'not-connected' | 'mode-unavailable' };
  /** A review's triage panel stands in the chat, or no longer does (M22e): PLAN REVIEW, as a plan's PLAN READY, and the entry says so. */
  reviewWaiting(sessionId: string, waiting: boolean): void;
  /**
   * What a running session is doing (M22e; the maintainer's V6 review), for a refusal because it
   * runs: a review's or an integration's turn, as the review service knows it; else its plan fields
   * — a plan carried out, a plan revised from feedback, a plan turn; its workers alone; any turn.
   */
  doing(sessionId: string): RunningDoing;
  /** A plan brought into the chat (M22b, C64, C76): through the send's own checks, its line in a turn of fat-g's own. */
  bringPlan(sessionId: string, request: Omit<PlanBringRequest, 'sessionId'>): Promise<PlanBringResult>;
  /** Whether a plan's decision waits in the chat (M22b, C56, C58): a request's while its registry holds it, any other's as the store holds it. */
  planPending(sessionId: string): boolean;
  /** Cancels every decision waiting on these plans, one written before the next (M22b, C73): what a removal does first. Answers how many. */
  settlePlans(planIds: readonly string[]): Promise<number>;
  /**
   * A plan's request the chat holds, closed as Cancel closes it — the CLI told, the turn it holds
   * ending — its line written `outcome` first (decision 0029). False where the chat holds none on its process.
   */
  retire(sessionId: string, itemId: string, outcome: PlanOutcome): boolean;
  /** Resolves once the session runs nothing: no turn, no worker. At once where it runs nothing now. */
  untilIdle(sessionId: string): Promise<void>;
  /** Plan released in the chat's saved draft (decision 0029). */
  releasePlan(sessionId: string): void;
  /** PLAN READY raised or let go of in the chat (decision 0029). */
  planReady(sessionId: string, waiting: boolean, flash?: false): void;
  /** What the chat waits on while another holds its plan, or null (decision 0029; the maintainer). */
  planWait(sessionId: string, wait: PlanWait | null): void;
  /** The chat's mode is its provider's reading mode, under which no plan is carried out (M22b, C81). */
  readsOnly(sessionId: string): boolean;
  /**
   * The answer to a question's card (M21, C31): for a blocking card, to the request the registry
   * holds, the item written before the CLI is told; for an async one, a prompt of the session's in
   * fat-g's words, sent as any prompt is, its record one transaction with the card's answer.
   */
  answer(sessionId: string, itemId: string, entries: readonly AnswerEntry[]): Promise<ChatAnswerResult>;
  /**
   * A card skipped (M21, C9; M100b, C31, C32): an async one with the CLI told nothing; a blocking one
   * declined to the request the registry holds, the item written before the CLI is told.
   */
  dismiss(sessionId: string, itemId: string): ChatDismissResult;
  /** What waits for an answer now (M21, C61, C73, C76): what the chat service's reads ask. And a pending approval's request, whole (M22, C79). */
  readonly requests: Pick<RequestRegistry, 'pending' | 'waiting' | 'view'>;
  /**
   * Changes a chat's mode (M22, C2, C75, C89, C90): on the live process where its adapter can and
   * nothing runs, else saved at once with the process closed, the next start confirming it. Never
   * refused for the mode it replaces.
   */
  setMode(sessionId: string, mode: string): Promise<ChatSetModeResult>;
  /**
   * A decision on an approval's card (M22, C13, C88): to the request the registry holds, the item
   * written before the CLI is told, and only for a choice the request's own view lists.
   */
  decide(sessionId: string, itemId: string, choice: ApprovalChoice): ChatDecideResult;
  /** The chat's mode and where it came from (M22, C1): its saved one, or what the hierarchy gives it now. What its entry shows. */
  chatMode(record: SessionRecord): ChatMode | null;
  /** What the chat's mode blocks a prompt for, or null (M22, C43, C46): the gate's last two reasons. */
  modeBlock(record: SessionRecord): Extract<SendBlock, 'mode-unconfirmed' | 'mode-unavailable'> | null;
  /** Whether a change of the session's mode is under way (M22, C90). */
  changingMode(sessionId: string): boolean;
  /** The quit has begun (C118): no prompt is taken from here on. */
  quitting(): boolean;
  /** The key of the session's live process, or null where it has none (M22, C81): by which a grant reads live. */
  processKey(sessionId: string): string | null;
  stop(sessionId: string): ChatStopResult;
  /**
   * A question beside a session (M20b, C73): the text typed, or the selection Explain this was
   * pressed on, around which the question is written here. Answers the id of the aside to open —
   * the one sent, or the one the same selection already has, in which case nothing is sent (C50).
   */
  ask(request: ChatAskRequest | FindingAsk): Promise<ChatAskResult>;
  /** An aside's conversation (M20b, C73): its newest page, or the page before a cursor. */
  readAside(sessionId: string, asideId: string, before?: string): ChatAsideReadResult;
  /** Stops an aside's turn, and nothing else of its session (M20b, C12, C70). */
  stopAside(sessionId: string, asideId: string): ChatAsideStopResult;
  /** Removes an aside, with everything the store holds of it (M20b, C32, C42): a turn of it that runs is stopped first. */
  removeAside(sessionId: string, asideId: string): ChatAsideRemoveResult;
  loadHistory(sessionId: string): ChatLoadHistoryResult;
  /** The reference this run keeps for a session whose record does not hold it, with its folder (C108; M18, C28). */
  kept(sessionId: string): { readonly reference: string; readonly folder: string } | undefined;
  /** The session service's word that a reference's write did not land (C108). */
  referenceUnsaved(sessionId: string): void;
  /**
   * Whether a session of this instance runs on a process of its own (Design 10; C18, C99): in a turn,
   * or on its workers alone. What Settings' actions that end a runtime ask. A session that runs with
   * no process — the demo source's — is not one: no action can end what it does not have.
   */
  runningOn(ref: InstanceRef): boolean;
  /** The selection changed, or something a check depends on did: the selected session's history is checked if it is not (C93, C121; M18, C51). */
  selectionChanged(): void;
  /**
   * Reconciles every listed session that has not been in this run (M18, C55), finishing first the
   * removals a crash cut short (C63). The runtime does it itself when it is made and whenever the
   * records change; main asks for it after a Start fresh of the conversation store, `force`d, so that
   * every session is reconciled again against the new store — its sub-agents listed from it (M106, C26).
   */
  reconcile(force?: boolean): void;
  /**
   * The quit (C117, C118): Stop to every running session, and no prompt taken from here on. Resolves
   * once each has ended, or after five seconds in all.
   */
  stopAll(waitMs?: number): Promise<void>;
  dispose(): void;
}

interface Live {
  /** Effort used by the latest dispatched turn, including messages steered into that turn. */
  effort: string | null;
  /** The speed tier used by the latest dispatched turn, as the effort is (decision 0016). */
  speed: string | null;
  handle: ProviderSession | null;
  /**
   * Which of the session's processes `handle` is (M21, C10, C13): raised at each open. A request is
   * keyed by the generation it came on, so none raised on an earlier process is ever answered.
   */
  generation: number;
  detach: (() => void) | null;
  /**
   * The turn in flight: its id, and the id of the user's message, until the provider's echo has
   * named it. `acceptedAt`: the monotonic clock's reading when its prompt was accepted (M19, C44).
   */
  turn: { readonly id: string; readonly messageId: string; echoed: boolean; readonly acceptedAt: number } | null;
  idleTimer: unknown;
  /** A reference the record does not hold: this run's, or the conversation store's (M18, C28). */
  kept: { readonly reference: string; readonly folder: string } | null;
  unsavedSaid: boolean;
  /** A session whose end could not be confirmed: it takes no prompt until a look finds it gone (C116). */
  unconfirmed: ProviderSession | null;
  running: boolean;
  /** An effort was reported as in force for the turn: taken back when the session stops running (C103). */
  reported: boolean;
  historyRead: AbortController | null;
  /** A check was asked for while the session ran: it starts once it is idle (C122). */
  historyWanted: boolean;
  completed: boolean;
  shelved: boolean;
  /** Its record and the conversation store were reconciled in this run (M18, C55). */
  reconciled: boolean;
  /** The other folders handed over when the open session was opened (M16, C61): what a Send compares (C72). */
  handed: readonly string[];
  /** That a folder could not be handed over was said in this run (M16, C20). */
  folderSaid: boolean;
  /** Its idle process is being closed: a Send waits for this, so no prompt goes to a session that is ending (C85). */
  closing: Promise<void> | null;
  /**
   * The asides whose turn runs, by aside (M20b, C34): the turn's id, and the monotonic clock's
   * reading when its question was accepted. A turn of the session's blocks none, and none blocks it.
   */
  readonly asides: Map<string, { readonly turnId: string; readonly acceptedAt: number }>;
  /** A turn runs, or its workers do, or an aside does: what the idle clock waits for (M20b, C10). */
  busy: boolean;
  /**
   * The chat's saved mode, as the conversation store holds it (M22, C40): read once a run, and kept
   * with each change. Null where the store holds none: the hierarchy then says what the chat has.
   */
  mode: ChatMode | null;
  /** The store has been asked for it in this run. */
  modeRead: boolean;
  /** The key of the process `handle` is (M22, C81), made at each open; null with no handle. */
  processKey: string | null;
  /** The mode the live process confirmed (M22, C2, C75): null until its start's check, and after its end. */
  inForce: string | null;
  /** The last start, or the last change, did not confirm the chat's mode (M22, C46): Send is blocked until a change is taken. */
  modeUnconfirmed: boolean;
  /** A change of the chat's mode is under way (M22, C90): nothing else of the session is taken meanwhile. */
  changing: boolean;
  /** That this thread may be left in the CLI's plan mode was said in this run (M22b, C55). */
  planModeSaid: boolean;
  /**
   * Messages handed into a running turn that its CLI holds (M23, C42, C43), by the chat's id, with the
   * turn each was handed into: until the CLI says what became of each, the session is not idle.
   */
  readonly steered: Map<string, string>;
  /** A message a turn's end refused (M23, C39): sent as the next prompt once that end is in. Its images stay in memory until then. */
  promoting: Promoted | null;
  /** That message is being sent as the next prompt: nothing queued goes before it. */
  promotingSent: boolean;
  /** Whether a message could go into its running turn, as the page was last told: it is told when that changes. */
  steer: SteerState;
  /** What its last process's CLI listed of its commands in this run (M23, C61): kept when that process ends, in memory alone. */
  commands: readonly ProviderCommand[] | null;
}

/** A message sent now that its turn's end refused (M23, C39): the same message, sent as the next prompt. */
interface Promoted {
  readonly messageId: string;
  readonly prompt: string;
  readonly images: readonly PromptAttachment[];
}

/** The turn failures that say a start did not run under the mode it was asked (M22, C46): each leaves Send blocked. */
const POLICY_FAILURES: ReadonlySet<string> = new Set(['policy-mismatch', 'not-read-only', 'start-overruled']);

/** A file's path as a question names it (M20b, C51): from the session's folder where it is inside it, and else whole. */
export function pathFrom(folder: string, file: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith('\\\\');
  const separator = windows ? '\\' : '/';
  const base = folder.endsWith(separator) ? folder : `${folder}${separator}`;
  const inside = windows ? file.toLowerCase().startsWith(base.toLowerCase()) : file.startsWith(base);
  return inside && file.length > base.length ? file.slice(base.length).split(separator).join('/') : file;
}

const defaultTimers: RuntimeTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
const refOf = (record: SessionRecord): InstanceRef => ({ providerId: record.providerId, instanceId: record.instanceId });

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  const speedOf = (record: SessionRecord) => record.speed === null ? null : { id: record.speed, name: findModel(options.catalog?.(), record, record.model).speedTiers.find((tier) => tier.id === record.speed)?.name ?? record.speed };
  const { sessions, chat, gate, store, removal, permissions } = options;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const timers = options.timers ?? defaultTimers;
  const idleMs = options.idleMs ?? IDLE_CLOSE_MS;
  const log = options.log ?? console;
  const lives = new Map<string, Live>();
  /** A saved mode was read since the entries were last told (M22): they are told once, after the pass that read them. */
  let modesRead = false;
  const watched = new WeakSet<SessionFacet>();
  const counts = new Map<string, number>();
  function noteModelUse(preset: ModelPreset): void {
    try {
      options.modelUsed?.({ providerId: preset.providerId, instanceId: preset.instanceId, model: preset.model, effort: preset.effort, speed: preset.speed });
    } catch {
      log.warn('[sessions] recent model use could not be saved');
    }
  }
  let quitting = false;
  let quitWaiter: (() => void) | null = null;
  /** What waits for a session to run nothing (decision 0029): resolved once it does, or once it is gone. */
  const idleWaiters = new Map<string, (() => void)[]>();
  function wokeIdle(id: string): void {
    const waiting = idleWaiters.get(id);
    if (waiting === undefined) return;
    idleWaiters.delete(id);
    for (const done of waiting) done();
  }

  /** The first, the tenth, the hundredth (C75). */
  function count(what: string): void {
    const total = (counts.get(what) ?? 0) + 1;
    counts.set(what, total);
    if (/^10*$/.test(String(total))) log.info(`[sessions] ${what}, ${total} so far`);
  }

  /** Every live request of every session (M21, C10): what it says of one is a count, through here (C34). */
  const requests = options.requests ?? createRequestRegistry({ sessions, chat, count, ...(options.plans === undefined ? {} : { plans: options.plans }), now, monotonic });

  /** The provider's session exists, by the record or by a reference kept beside it. */
  const referenceOf = (record: SessionRecord, entry: Live): string | null => entry.kept?.reference ?? record.reference;

  // ── The composer (M23, Design 2, 5; C14, C31–C34, C86) ────────────────────────────────────
  /** A session's draft and its images, in main: made where the store's composer rows are handed in. */
  const composer: ComposerService | null = options.composer === undefined ? null : createComposerService({
    store: options.composer.store,
    blobs: options.composer.blobs,
    listed: (id) => sessions.record(id) !== undefined,
    // Nothing new is staged into a session that is leaving, nor while fat-g quits.
    leaving: (id) => quitting || sessions.isLeaving(id) || removal.pending(id),
    started: (id) => {
      const record = sessions.record(id);
      return record !== undefined && referenceOf(record, live(record)) !== null;
    },
    changed: (id) => { pushComposer(id); },
    failing: (id) => { chat.markFailing(id); },
    written: () => { contentChanged(); },
    now,
    newId,
    timers,
    log,
  });

  /** Whether a draft or a queue holds something changed (C83): the session list is told where any session's presence did. */
  function contentChanged(): void {
    if (options.composer?.presence?.refresh() === true) sessions.availabilityChanged?.();
  }

  /** A session's queue as the page is shown it (C48): the store's entries, oldest first. */
  function queueView(sessionId: string): QueueView {
    if (options.composer === undefined || store.status().kind !== 'ok') return { entries: [], paused: null };
    const sending = drain.sending(sessionId);
    try {
      const listed = options.composer.store.queue(sessionId);
      // A held Send now that is no longer queued — sent, removed, edited, or gone with its queue — is held no more.
      const held = drain.held(sessionId);
      for (const id of [...held]) if (!listed.some((entry) => entry.id === id)) drain.unhold(sessionId, id);
      const entries = listed.map((entry) => ({ id: entry.id, text: entry.text, intent: entry.intent, attachments: entry.attachments, queuedAt: entry.queuedAt, sending: entry.id === sending, now: held.has(entry.id) }));
      // A pause stands while there is something queued: a queue emptied — removed, dropped, started fresh — is paused no more.
      if (entries.length === 0) drain.forget(sessionId);
      return { entries, paused: entries.length === 0 ? null : drain.paused(sessionId) };
    } catch {
      return { entries: [], paused: null };
    }
  }

  // ── The queue (M23, C47, C48, C50–C52, C54–C57, C82, C89) ─────────────────────────────────
  /**
   * The refusals main is already settling by itself (C89): each a wait, which its state's own event
   * ends. A held Send now the turn could not take after all waits for the next opportunity.
   */
  const QUEUE_WAITS: ReadonlySet<string> = new Set(['running', 'history-loading', 'changing-mode', 'setting-up', 'plan-pending', 'shelved', 'not-steerable']);

  const drain = createQueueDrain({
    first(id, among) {
      if (options.composer === undefined || store.status().kind !== 'ok') return null;
      try {
        const entries = options.composer.store.queue(id);
        const entry = among === undefined ? entries[0] : entries.find((queued) => among.has(queued.id));
        return entry === undefined ? null : { id: entry.id, text: entry.text, intent: entry.intent, attachmentIds: entry.attachments.map((attachment) => attachment.id) };
      } catch {
        return null;
      }
    },
    idle(id) {
      const record = sessions.record(id);
      // A shelved session's queue waits: Unshelve wakes it.
      if (quitting || record === undefined || record.shelvedAt !== null || sessions.isLeaving(id) || removal.pending(id) || sessions.isRunning(id)) return false;
      const entry = lives.get(id);
      return entry === undefined || (entry.steered.size === 0 && entry.promoting === null && !entry.promotingSent);
    },
    steerable: (id) => steerStateOf(id) === 'open',
    async send(id, entry) {
      const sent = await sendGiven(id, { prompt: entry.text, ...(entry.intent.plan ? { plan: true } : {}), queued: entry });
      return sent.status === 'sent' ? sent : { status: 'refused', reason: sent.reason };
    },
    async steer(id, entry) {
      const sent = await steerGiven(id, { prompt: entry.text, queued: entry });
      return sent.status === 'sent' ? sent : { status: 'refused', reason: sent.reason };
    },
    waits(id, reason) {
      if (QUEUE_WAITS.has(reason)) return true;
      const record = sessions.record(id);
      if (record === undefined) return false;
      // The instance still being detected, or not listed yet at the launch: the registry's change wakes it (C89).
      if (reason === 'not-connected' || reason === 'provider-unavailable' || reason === 'instance-unavailable') return gate.detecting?.(record) === true;
      // The account's modes still being read: the change of its modes wakes it (C89).
      if (reason === 'mode-unavailable') {
        const mode = chatModeOf(record, lives.get(id));
        return mode !== null && permissions?.availability(refOf(record), mode.id).reason === 'pending';
      }
      return false;
    },
    changed: (id) => { pushComposer(id); },
    log,
  });

  /** Every session with a queued message, its first entry woken (C52, C89): at a restart, and at each change a wait may end on. */
  function wakeQueues(): void {
    if (options.composer === undefined || store.status().kind !== 'ok') return;
    let ids: readonly string[];
    try { ids = options.composer.store.queued(); } catch { return; }
    for (const id of ids) {
      const record = sessions.record(id);
      // Never an unlisted conversation's queue, merely because its rows exist (C52).
      if (record === undefined) continue;
      live(record);
      drain.wake(id);
    }
  }

  /** A reorder keeps every held Send now ahead of what was queued, as they stand, after the entry being sent. */
  function heldFirst(sessionId: string, ids: readonly string[], sending: string | null): boolean {
    const held = drain.held(sessionId);
    if (held.size === 0) return true;
    const rest = sending === null ? ids : ids.slice(1);
    const leading = rest.findIndex((id) => !held.has(id));
    return rest.slice(leading === -1 ? rest.length : leading).every((id) => !held.has(id));
  }

  /** A write of the session's queue (C47–C51): its refusal in the queue's words, and the page told of what it now holds. */
  function queueWrite(sessionId: string, work: () => void): ChatQueueResult {
    try {
      work();
    } catch (error) {
      if (error instanceof StorageFailure) {
        if (error.kind === 'full' || error.kind === 'empty' || error.kind === 'draft-changed' || error.kind === 'unknown-entry') return { status: 'refused', reason: error.kind };
      }
      count(`queue not written (${errorKind(error)})`);
      chat.markFailing(sessionId);
      return { status: 'refused', reason: 'storage-failed' };
    }
    pushComposer(sessionId);
    return { status: 'saved' };
  }

  /** The session's queue dropped (C82): an explicit completion's, its draft and conversation kept. */
  function dropQueueOf(sessionId: string): void {
    const held = options.composer;
    drain.forget(sessionId);
    if (held === undefined || store.status().kind !== 'ok') return;
    try {
      held.store.dropQueue(sessionId);
    } catch (error) {
      count(`queue not dropped (${errorKind(error)})`);
      return;
    }
    pushComposer(sessionId);
  }

  // ── Commands and skills (M23, C58–C64, C86, C87) ──────────────────────────────────────────
  /** What the session's CLI lists now: its live process's list, kept for the run; and its instance's for the session's folder. */
  async function listedCommands(record: SessionRecord, entry: Live, facet: SessionFacet): Promise<readonly ProviderCommand[] | null> {
    const fromProcess = entry.handle?.commands?.() ?? null;
    if (fromProcess !== null) entry.commands = fromProcess;
    if (facet.commands === undefined) return entry.commands;
    const folder = gate.folder(record);
    if (folder === null) return entry.commands;
    const fromFolder = await facet.commands(folder, new AbortController().signal).catch(() => null);
    if (fromFolder === null) return entry.commands;
    return [...(entry.commands ?? []), ...fromFolder];
  }

  /** Whether a chosen skill's selector is listed by its CLI now (C87). */
  async function skillListed(record: SessionRecord, selector: string): Promise<boolean> {
    const facet = options.facet(refOf(record));
    if (facet === undefined) return false;
    const listed = await listedCommands(record, live(record), facet);
    return (listed ?? []).filter((row) => row.selector === selector).length === 1;
  }

  /** The images of a queued message (C8, C21, C56), read whole and checked against their hashes. */
  async function prepareQueued(sessionId: string, queued: QueuedInput): Promise<readonly PromptAttachment[] | 'storage-failed' | 'attachment-missing'> {
    const held = options.composer;
    if (held === undefined) return 'attachment-missing';
    let attachments: readonly AttachmentDescriptor[];
    try { attachments = held.store.queue(sessionId).find((entry) => entry.id === queued.id)?.attachments ?? []; } catch { return 'storage-failed'; }
    if (attachments.length !== queued.attachmentIds.length || attachments.some((attachment, index) => attachment.id !== queued.attachmentIds[index])) return 'storage-failed';
    const read = await Promise.all(attachments.map(async (attachment) => ({ attachment, bytes: await held.blobs.read(attachment.hash, attachment.mediaType, attachment.bytes) })));
    if (read.some((entry) => entry.bytes === null)) { count('queued message refused (image missing)'); return 'attachment-missing'; }
    return read.map(({ attachment, bytes }) => ({ mediaType: attachment.mediaType, path: held.blobs.pathOf(attachment.hash, attachment.mediaType), bytes: bytes as Uint8Array }));
  }

  /** The composer's state beside a session's conversation (C57, C86): what a read carries and a push sends. */
  function composerView(sessionId: string): ChatComposer {
    if (composer === null) return EMPTY_COMPOSER;
    const entry = lives.get(sessionId);
    const steer = steerStateOf(sessionId, entry);
    // What the page is told now: a later change is pushed against this.
    if (entry !== undefined) entry.steer = steer;
    return { draft: composer.draft(sessionId), queue: queueView(sessionId), steer };
  }

  /** What main changed of a session's composer, pushed to the page that shows it. */
  function pushComposer(sessionId: string): void {
    if (composer === null || sessions.record(sessionId) === undefined) return;
    chat.pushComposer(sessionId, composerView(sessionId));
    contentChanged();
  }

  /** The draft was taken at this revision (C86): stagings under way attach to nothing, and the page is told it is empty. */
  function consumed(sessionId: string, revision: number): void {
    composer?.consumed(sessionId, revision);
    pushComposer(sessionId);
  }

  /**
   * The draft's images a Send names (C8, C21, C86): each one the draft still holds, in its order, read
   * whole from fat-g's folder and checked against its hash. `draft-changed` where the ids are not the
   * draft's; `attachment-missing` where a file is gone or changed. Waits for stagings under way first.
   */
  async function prepareImages(sessionId: string, ids: readonly string[]): Promise<readonly PromptAttachment[] | 'draft-changed' | 'attachment-missing'> {
    const held = options.composer;
    if (held === undefined || composer === null) return 'attachment-missing';
    await composer.settled(sessionId);
    let attachments: ReturnType<ComposerService['draft']>['attachments'];
    try { attachments = held.store.draft(sessionId)?.attachments ?? []; } catch { return 'attachment-missing'; }
    if (attachments.length !== ids.length || attachments.some((attachment, index) => attachment.id !== ids[index])) return 'draft-changed';
    const read = await Promise.all(attachments.map(async (attachment) => ({ attachment, bytes: await held.blobs.read(attachment.hash, attachment.mediaType, attachment.bytes) })));
    if (read.some((entry) => entry.bytes === null)) { count('send refused (image missing)'); return 'attachment-missing'; }
    return read.map(({ attachment, bytes }) => ({ mediaType: attachment.mediaType, path: held.blobs.pathOf(attachment.hash, attachment.mediaType), bytes: bytes as Uint8Array }));
  }

  /**
   * Whether no ordinary prompt with text came before (C28): a session's first turn, or one whose store
   * holds its start and no prompt of the user's with text in a turn a provider was sent.
   */
  function firstText(record: SessionRecord): boolean {
    if (record.lastTurn === null) return true;
    try {
      return store.conversation(record.id)?.startHeld === true && store.hasTextPrompt?.(record.id) === false;
    } catch {
      return false;
    }
  }

  /** Where a session's history check stands when it is first met in this run (M18, C51). */
  function historyAtFirst(record: SessionRecord, entry: Live): HistoryState {
    if (!options.hasHistory(record.providerId)) return 'unsupported';
    // A session not yet started has nothing earlier to check (C93).
    return referenceOf(record, entry) === null ? 'checked' : 'not-checked';
  }

  /**
   * What the record lacks and the conversation store holds, and the reverse (M18, Design 7): once
   * per session per run, while both can be read. It seeds the kept reference, so the session is not
   * taken for one that never started.
   */
  function reconcileOne(record: SessionRecord, entry: Live): void {
    if (entry.reconciled || options.records.isRefused() || store.status().kind !== 'ok' || removal.pending(record.id)) return;
    let facts: StoreFacts;
    try {
      const conversation = store.conversation(record.id);
      // A removal a crash cut short is finished first (C63).
      if (conversation?.removing === true) return;
      facts = {
        conversation,
        lastLocal: conversation === null ? null : store.lastLocalTurn(record.id),
        recordTurn: conversation === null || record.lastTurn === null ? null : store.turn(record.id, record.lastTurn.turnId),
      };
    } catch {
      count('reconciliation not made (storage)');
      return;
    }
    entry.reconciled = true;
    const change = reconcile(record, facts);
    // Kept as a reference the record could not store is kept: the next prompt resumes by it,
    // whether or not the record's write lands (C28).
    if (change.reference !== null) entry.kept = { reference: change.reference.reference, folder: change.reference.folder };
    if (change.reference !== null || change.lastTurn !== null) {
      sessions.reconcile(record.id, { ...(change.reference === null ? {} : { reference: change.reference }), ...(change.lastTurn === null ? {} : { lastTurn: change.lastTurn }) });
      count('reconciled from the conversation store');
    }
    if (change.storeEnd !== null) chat.sessionEnded(record.id, change.storeEnd.turnId, change.storeEnd.at, change.storeEnd.outcome);
    // A plan the chat made whose line still waits reads PLAN READY at a launch too, as it did at its
    // turn's end (M22b, C27; the maintainer's word). A brought one raises nothing, as in a run.
    let waiting: ReturnType<PlanService['waiting']> = null;
    try { waiting = options.plans?.waiting(record.id) ?? null; } catch { count('waiting plan not read (storage)'); }
    if (waiting?.came === 'made') sessions.apply({ type: 'plan-waiting', sessionId: record.id, waiting: true });
    // Its finished sub-agents, as the store holds them, are its list at launch (M106, C26): after the
    // record's own reconciliation, which may rebuild its summary from the record. A session that runs
    // in this run keeps its own, the summary discarding this.
    let workers: ReturnType<NonNullable<typeof store.workers>> | null = null;
    try { workers = store.workers?.(record.id, MAX_FINISHED_AGENTS) ?? null; } catch { count('sub-agents not listed (storage)'); }
    if (workers !== null) sessions.apply({ type: 'workers-listed', sessionId: record.id, workers });
  }

  /** Whatever a session's entry reads of its mode has changed (M22): its mode, its block, a change under way. */
  const entryChanged = (): void => { sessions.availabilityChanged?.(); };

  /**
   * The chat's saved mode, read from the conversation store once a run (M22, C40) — and, for a
   * session that has no conversation yet and has never started, the conversation made with it,
   * holding its mode as the hierarchy gives it now: the snapshot, which a later change of a default
   * never touches. One that cannot be written is made with the session's first prompt instead.
   */
  function readMode(record: SessionRecord, entry: Live): void {
    if (entry.modeRead || permissions === undefined || permissions.capability(record.providerId) === null) return;
    if (options.records.isRefused() || store.status().kind !== 'ok' || removal.pending(record.id)) return;
    let conversation: ReturnType<typeof store.conversation>;
    try { conversation = store.conversation(record.id); } catch { count('mode not read (storage)'); return; }
    // A removal a crash cut short is finished first (M18, C63).
    if (conversation?.removing === true) return;
    entry.modeRead = true;
    entry.mode = conversation?.mode ?? null;
    if (conversation === null && referenceOf(record, entry) === null && record.lastTurn === null) {
      const resolved = permissions.resolve(record, null);
      if (resolved !== null && chat.created(record.id, record.createdAt, resolved)) { entry.mode = resolved; count('mode snapshotted'); }
    }
    if (entry.mode !== null) modesRead = true;
  }

  /** The chat's mode (M22, C1): its saved one, else what the hierarchy gives it at this moment. Null for a provider that declares none. */
  const chatModeOf = (record: SessionRecord, entry: Live | undefined): ChatMode | null => permissions?.resolve(record, entry?.mode ?? null) ?? null;

  /** Whether the chat's mode is its provider's reading mode (M22b, C81): one under which no plan can be carried out. */
  function readsOnly(record: SessionRecord, entry: Live | undefined): boolean {
    const mode = chatModeOf(record, entry);
    return mode !== null && permissions?.listed(record.providerId, mode.id)?.reading === true;
  }

  /** fat-g's name for the chat's mode, for a notice's words (M22, C46); null where it has none. */
  function modeLabel(record: SessionRecord, entry: Live | undefined): string | null {
    const mode = chatModeOf(record, entry);
    return mode === null ? null : permissions?.listed(record.providerId, mode.id)?.label ?? mode.id;
  }

  /** What a notice may say of the chat's mode (M22, C45, C46): fat-g's name for it, and whether it is its provider's reading mode. */
  function modeWords(record: SessionRecord, entry: Live | undefined): Pick<NoticeExtra, 'mode' | 'reading'> {
    const mode = chatModeOf(record, entry);
    return { mode: modeLabel(record, entry), reading: mode === null ? null : permissions?.listed(record.providerId, mode.id)?.reading ?? null };
  }

  /** What the chat's mode blocks a prompt for (M22, C43, C46): its last start did not confirm it, or its account cannot use it. */
  function modeBlockOf(record: SessionRecord, entry: Live | undefined): 'mode-unconfirmed' | 'mode-unavailable' | null {
    const mode = chatModeOf(record, entry);
    if (permissions === undefined || mode === null) return null;
    if (entry?.modeUnconfirmed === true) return 'mode-unconfirmed';
    return permissions.availability(refOf(record), mode.id).available ? null : 'mode-unavailable';
  }

  /** A process confirmed the mode it runs under (M22, C2, C75): the summary's — and, where it is the chat's, the end of the block a failed start left. */
  function confirmed(id: string, entry: Live, record: SessionRecord, mode: string): void {
    entry.inForce = mode;
    sessions.apply({ type: 'in-force', sessionId: id, mode });
    if (entry.modeUnconfirmed && chatModeOf(record, entry)?.id === mode) { entry.modeUnconfirmed = false; entryChanged(); }
  }

  /** A start reported another policy than the chat's mode (M22, C46): Send is blocked until a mode the account runs is chosen. */
  function unconfirm(entry: Live, record: SessionRecord): void {
    if (permissions === undefined || permissions.capability(record.providerId) === null || entry.modeUnconfirmed) return;
    entry.modeUnconfirmed = true;
    count('mode not confirmed');
    entryChanged();
  }

  function live(record: SessionRecord): Live {
    let entry = lives.get(record.id);
    if (entry === undefined) {
      entry = { effort: record.effort, speed: record.speed, handle: null, generation: 0, detach: null, turn: null, idleTimer: undefined, kept: null, unsavedSaid: false, unconfirmed: null, running: false, reported: false, historyRead: null, historyWanted: false, completed: record.completedAt !== null, shelved: record.shelvedAt !== null, reconciled: false, handed: [], folderSaid: false, closing: null, asides: new Map(), busy: false, mode: null, modeRead: false, processKey: null, inForce: null, modeUnconfirmed: false, changing: false, planModeSaid: false, steered: new Map(), promoting: null, promotingSent: false, steer: 'wait', commands: null };
      lives.set(record.id, entry);
    }
    // Before its history is checked or read, and before it takes a prompt (C55).
    reconcileOne(record, entry);
    // After the reconciliation, which seeds the kept reference: a session that started is given no new conversation here.
    readMode(record, entry);
    chat.ensure(record.id, historyAtFirst(record, entry));
    return entry;
  }

  function reconcileListed(force = false): void {
    if (options.records.isRefused() || store.status().kind !== 'ok') return;
    const listed = options.records.getView().sessions;
    // A new store (M106, C26): what each session was reconciled against is gone, and its list with it.
    if (force) for (const entry of lives.values()) entry.reconciled = false;
    const ids = new Set(listed.map((record) => record.id));
    // The session's record first, where it is still listed, then the rows (C63). One whose record's
    // write fails stays listed with its chat, and is reconciled then.
    removal.finish((id) => ids.has(id), (id) => options.records.removeSession(id).then((answer) => answer.status === 'saved'), () => { reconcileListed(); });
    for (const record of listed) live(record);
    // Each entry shows its chat's saved mode from here on (M22, C40).
    if (modesRead) { modesRead = false; entryChanged(); }
    // And whether its draft or queue holds something, as the store now says (M23, C83): a Start fresh empties both.
    contentChanged();
    // And every listed session's queue, selected or not, with no press (C52).
    wakeQueues();
  }

  /** A turn runs, or its workers do, or an aside of it does (M20b, C10), or its CLI holds a message handed into a turn (M23, C42). */
  const busy = (id: string, entry: Live): boolean => sessions.isRunning(id) || entry.asides.size > 0 || entry.steered.size > 0;
  const anyRunning = (): boolean => [...lives].some(([id, entry]) => entry.handle !== null && busy(id, entry));

  /**
   * Follows the session from running to not: the report is taken back, a check that waited begins.
   * And from busy to not — its turn, its workers and its asides all over — which is when the idle
   * clock starts.
   */
  function settle(id: string, entry: Live): void {
    const running = sessions.isRunning(id);
    if (entry.running && !running) {
      if (entry.reported) { entry.reported = false; sessions.apply({ type: 'in-force', sessionId: id, withdrawn: true }); }
      if (entry.historyWanted) { entry.historyWanted = false; check(id); }
    }
    const idled = entry.running && !running;
    entry.running = running;
    if (!running) wokeIdle(id);
    // Its turn and its workers are over: an implementation it carried may be done (decision 0029).
    if (idled) options.workflow?.idle(id);
    // A message a turn's end refused goes as the next prompt once that end is in (M23, C39).
    if (!running && entry.promoting !== null) void promote(id);
    const occupied = running || entry.asides.size > 0 || entry.steered.size > 0;
    if (entry.busy && !occupied) {
      timers.clear(entry.idleTimer);
      // Five minutes after its last turn, the last of that turn's workers and the last of its asides ended (C85; M20b, C10).
      entry.idleTimer = entry.handle === null ? undefined : timers.set(() => { entry.idleTimer = undefined; if (!busy(id, entry)) closeIdle(id, entry); }, idleMs);
    }
    entry.busy = occupied;
    if (quitWaiter !== null && !anyRunning()) { const done = quitWaiter; quitWaiter = null; done(); }
    noteSendNow(id, entry);
    // The turn, its workers and what its CLI held are over: the queue's next goes (C48, C82). And a
    // Send now held for the turn goes as soon as the turn takes a message.
    if ((!running && entry.steered.size === 0) || (entry.steer === 'open' && drain.held(id).size > 0)) drain.wake(id);
  }

  // ── Send now (M23, C35–C46) ────────────────────────────────────────────────────────────
  /**
   * Whether a message can be sent into the session's running turn (C35, C43, C88): `open` for its own
   * turn, on its live process, which says so; `unsupported` where that process never takes one, or
   * its provider has no way to; `wait` otherwise — no turn, workers alone, a change of mode under way,
   * a message its turn's end refused waiting to go as the next prompt, or the provider's own wait.
   */
  function steerStateOf(id: string, entry: Live | undefined = lives.get(id)): SteerState {
    if (entry === undefined || entry.handle === null) return 'wait';
    const { handle } = entry;
    if (handle.steer === undefined || handle.steerState === undefined) return 'unsupported';
    let state: SteerState;
    try { state = handle.steerState(); } catch { return 'wait'; }
    if (state === 'unsupported') return state;
    if (entry.turn === null || !sessions.isRunning(id) || entry.promoting !== null || entry.promotingSent || entry.changing) return 'wait';
    return state;
  }

  /** Whether a message can go into the turn changed: the page that shows the session is told. */
  function noteSendNow(id: string, entry: Live): void {
    const state = steerStateOf(id, entry);
    if (state === entry.steer) return;
    entry.steer = state;
    pushComposer(id);
  }

  /**
   * What became of a steer (C38–C40): its delivery written. A message its CLI holds is kept until the
   * CLI says what became of it; one a turn's end refused goes as the next prompt, once that end is in.
   */
  function steered(id: string, handle: ProviderSession, turnId: string, held: Promoted, outcome: SteerOutcome): void {
    const entry = lives.get(id);
    if (entry === undefined || sessions.record(id) === undefined) return;
    const { messageId } = held;
    count(`message sent now (${outcome.kind})`);
    // Held from before the adapter was called, so that a word of its CLI that comes before this answer is taken.
    const holding = entry.steered.get(messageId) === turnId;
    if (outcome.kind !== 'handed') entry.steered.delete(messageId);
    switch (outcome.kind) {
      case 'taken':
        chat.setDelivery(id, messageId, { state: 'taken', detail: null });
        settle(id, entry);
        return;
      case 'handed':
        // Its process went meanwhile: no word of it will come (C44). Its CLI's word already came: nothing is left to hold.
        if (entry.handle !== handle && holding) { entry.steered.delete(messageId); chat.setDelivery(id, messageId, { state: 'not-confirmed', detail: null }); }
        settle(id, entry);
        return;
      case 'turn-over':
        entry.promoting = held;
        if (!sessions.isRunning(id)) void promote(id);
        settle(id, entry);
        return;
      case 'refused':
        chat.setDelivery(id, messageId, { state: 'not-sent', detail: outcome.detail });
        settle(id, entry);
        return;
      case 'unknown':
        chat.setDelivery(id, messageId, { state: 'not-confirmed', detail: null });
        settle(id, entry);
    }
  }

  /**
   * The message a turn's end refused (C39), sent once as the next prompt through every check of the
   * send's. A refusal leaves it "Not sent", and nothing is queued in its place (C40, C46).
   */
  async function promote(id: string): Promise<void> {
    const entry = lives.get(id);
    const held = entry?.promoting ?? null;
    if (entry === undefined || held === null) return;
    entry.promoting = null;
    // Nothing queued goes before it, a held Send now included, while it is being sent.
    entry.promotingSent = true;
    const sent = await sendGiven(id, { promoted: held }).catch((): Sent => ({ status: 'refused', reason: 'storage-failed' }));
    entry.promotingSent = false;
    if (sent.status !== 'sent') {
      chat.setDelivery(id, held.messageId, { state: 'not-sent', detail: null });
      count(`message sent now not sent as the next prompt (${sent.status === 'card' ? sent.reason : sent.reason})`);
    }
    // The queue's next goes, as it would have at the turn's end: into the turn this one started, or after it.
    if (lives.get(id) === entry) settle(id, entry);
  }

  /**
   * A message sent into the running turn (C36, C38, C41, C46): the send's checks, but for `running`,
   * which a steerable turn of this process replaces; recorded in that turn, its draft consumed — or
   * its queue entry taken, for a held Send now — in one step with nothing awaited, and only then
   * handed to the adapter. A turn that ended before that step leaves the message to the ordinary
   * send. Plan pressed, or a skill chosen, is never sent now (C64, C88). A typed message the turn
   * cannot take this instant is held, and goes at the first opportunity: the press is never lost.
   */
  async function steerGiven(sessionId: string, given: Steering): Promise<Sent> {
    if (quitting) return { status: 'refused', reason: 'busy' };
    const first = sessions.record(sessionId);
    if (first === undefined) return { status: 'refused', reason: 'unknown-session' };
    const input = 'queued' in given || 'itemId' in given ? null : given.input ?? null;
    const queued = 'queued' in given ? given.queued : null;
    // Presses keep their order: one that comes while a Send now is held goes behind it.
    const behind = input !== null && drain.held(sessionId).size > 0;
    // Its turn ended before anything was written: the ordinary path, with all its checks (C40).
    if (!behind && !sessions.isRunning(sessionId) && (lives.get(sessionId)?.steered.size ?? 0) === 0) return sendGiven(sessionId, given);
    // Plan pressed, or a skill chosen, is never sent now (C64, C88): Queue stands alone.
    if (('plan' in given && given.plan === true) || input?.intent.plan === true || (input?.intent.skill ?? null) !== null) return { status: 'refused', reason: 'not-steerable' };
    const state = steerStateOf(sessionId);
    if (state === 'unsupported') return { status: 'refused', reason: 'not-steerable' };
    if (input !== null && 'prompt' in given && (behind || state !== 'open')) return holdNow(sessionId, given.prompt, input);
    if (state !== 'open') return { status: 'refused', reason: 'not-steerable' };
    const hold = await sessions.hold(sessionId);
    const held = sessions.record(sessionId);
    if (held === undefined) return { status: 'refused', reason: 'unknown-session' };
    const block = gate.block(held, hold);
    if (block !== null) return { status: 'refused', reason: block };
    let images: readonly PromptAttachment[] = [];
    if (input !== null && input.attachmentIds.length > 0) {
      const prepared = await prepareImages(sessionId, input.attachmentIds);
      if (typeof prepared === 'string') return { status: 'refused', reason: prepared };
      images = prepared;
    }
    if (queued !== null && queued.attachmentIds.length > 0) {
      const prepared = await prepareQueued(sessionId, queued);
      if (typeof prepared === 'string') return { status: 'refused', reason: prepared };
      images = prepared;
    }

    // One step, with nothing awaited inside it (C46): a steer is written only while the turn is the
    // running one, and the message is recorded in it before the adapter is called.
    const record = sessions.record(sessionId);
    if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
    if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
    const entry = live(record);
    if (!sessions.isRunning(sessionId) && entry.steered.size === 0) return sendGiven(sessionId, given);
    const { turn, handle } = entry;
    if (turn === null || handle === null || handle.steer === undefined || steerStateOf(sessionId, entry) !== 'open') {
      // The turn stopped taking messages meanwhile: a typed one is held for the next opportunity.
      if (input !== null && 'prompt' in given && steerStateOf(sessionId, entry) !== 'unsupported') return holdNow(sessionId, given.prompt, input);
      return { status: 'refused', reason: 'not-steerable' };
    }
    if (planPendingOf(sessionId)) return { status: 'refused', reason: 'plan-pending' };
    const modeBlock = modeBlockOf(record, entry);
    if (modeBlock !== null) return { status: 'refused', reason: modeBlock };
    const facet = options.facet(refOf(record));
    if (facet === undefined) return { status: 'refused', reason: 'not-connected' };
    const answered = 'itemId' in given ? answering(sessionId, given.itemId, given.entries) : null;
    if (typeof answered === 'string') return { status: 'card', reason: answered };
    const prompt = 'prompt' in given ? given.prompt : answered?.prompt ?? '';
    // A command fat-g answers itself (C41, C62; decision 0023): its message and the notice in the
    // running turn, nothing sent, no turn started or ended, and the turn's clock untouched.
    const command: CommandNoticeKind | null = answered === null ? facet.intercepts?.(prompt) ?? null : null;
    const messageId = newId();
    const took = chat.acceptSteer(sessionId, {
      turnId: turn.id, itemId: messageId, text: prompt, at: now(),
      ...(input === null ? {} : { from: { draft: { revision: input.revision, text: prompt, intent: input.intent, attachmentIds: input.attachmentIds } } }),
      ...(queued === null ? {} : { from: { queued: queued.id } }),
      ...(answered === null ? {} : { answering: { itemId: answered.itemId, answers: answered.answers } }),
      ...(command === null ? {} : { own: true }),
    });
    if (took === 'not-pending') return { status: 'card', reason: 'not-pending' };
    if (took === 'draft-changed') return { status: 'refused', reason: 'draft-changed' };
    if (took === 'turn-over') {
      if (input !== null && 'prompt' in given) return holdNow(sessionId, given.prompt, input);
      return { status: 'refused', reason: 'not-steerable' };
    }
    if (took !== 'accepted') return { status: 'refused', reason: 'storage-failed' };
    if (input !== null) consumed(sessionId, input.revision);
    if (queued !== null) pushComposer(sessionId);
    if (command !== null) {
      chat.add(sessionId, turn.id, noticeItem(command, record.providerId));
      count(`command answered during a turn (${command})`);
      return { status: 'sent' };
    }
    noteModelUse({ ...record, effort: entry.effort, speed: entry.speed });
    if (answered !== null) count('question answered (sent now)');
    const sending: Promoted = { messageId, prompt, images };
    // Held before the adapter is called (C42): the session is not idle while its CLI may hold it.
    entry.steered.set(messageId, turn.id);
    void handle.steer({ turnId: turn.id, messageId, prompt, ...(images.length === 0 ? {} : { attachments: images }) }).then(
      (outcome) => steered(sessionId, handle, turn.id, sending, outcome),
      () => steered(sessionId, handle, turn.id, sending, { kind: 'unknown' }),
    );
    return { status: 'sent' };
  }

  /**
   * A Send now the running turn cannot take this instant: held as a queue entry, ahead of what was
   * queued and behind the one being sent and any Send now held before it, its draft consumed as a
   * Queue's is. It goes at the first opportunity — into the turn once that takes a message, or as the
   * next prompt once the session is idle — and the queue's row says it waits for that.
   */
  async function holdNow(sessionId: string, prompt: string, input: SendInput): Promise<Sent> {
    const held = options.composer;
    if (held === undefined || composer === null) return { status: 'refused', reason: 'storage-failed' };
    // A message with an image still being kept waits for it (C18).
    await composer.settled(sessionId);
    const record = sessions.record(sessionId);
    if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
    if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
    if (store.status().kind !== 'ok') return { status: 'refused', reason: 'storage-failed' };
    const ahead = drain.held(sessionId);
    const sending = drain.sending(sessionId);
    let index = 0;
    try {
      const entries = held.store.queue(sessionId);
      while (index < entries.length && (entries[index]?.id === sending || ahead.has(entries[index]?.id ?? ''))) index += 1;
    } catch {
      return { status: 'refused', reason: 'storage-failed' };
    }
    const entryId = newId();
    const given = { revision: input.revision, text: prompt, intent: input.intent, attachmentIds: input.attachmentIds };
    // Held before the write, so that the row the write pushes says so.
    drain.hold(sessionId, entryId);
    const answer = queueWrite(sessionId, () => { held.store.enqueue(sessionId, entryId, given, now(), referenceOf(record, live(record)) !== null, index); });
    if (answer.status !== 'saved') {
      drain.unhold(sessionId, entryId);
      const reason = answer.reason === 'full' ? 'queue-full' : answer.reason === 'draft-changed' || answer.reason === 'empty' ? 'draft-changed' : 'storage-failed';
      return { status: 'refused', reason };
    }
    consumed(sessionId, input.revision);
    count('message sent now held');
    // The turn may take it already: it goes as soon as it can, through the same drain.
    drain.wake(sessionId);
    return { status: 'sent' };
  }

  /** The CLI's later word on a message it held (C42–C44): its delivery, or the turn it became. */
  function onDelivery(id: string, entry: Live, event: Extract<AgentEvent, { type: 'delivery' | 'held-turn-started' }>): void {
    const originatingTurn = entry.steered.get(event.messageId);
    if (originatingTurn === undefined) { count(`delivery event dropped (${event.type})`); return; }
    entry.steered.delete(event.messageId);
    if (event.type === 'delivery') {
      chat.setDelivery(id, event.messageId, { state: event.state, detail: null });
      settle(id, entry);
      return;
    }
    // It ran as the CLI's next turn (C42): moved there, the turn the session's own from here.
    if (!chat.movedToTurn(id, event.messageId, event.turnId, now(), store.turn(id, originatingTurn)?.speed)) count('held turn not written (storage)');
    chat.setDelivery(id, event.messageId, { state: 'taken', detail: null });
    sessions.apply({ type: 'turn-started', sessionId: id, turnId: event.turnId });
    chat.took(id, event.turnId, null);
    timers.clear(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.turn = { id: event.turnId, messageId: event.messageId, echoed: false, acceptedAt: monotonic() };
    entry.running = true;
    entry.busy = true;
    settle(id, entry);
  }

  /**
   * Closes the process of a session that stays listed and is not running: idle for its time, or
   * completed (C85). A close takes a moment — the tree is ended and looked at — and the session is
   * over from the first of it: a Send that comes meanwhile waits for the close, then resumes.
   */
  function closeIdle(id: string, entry: Live): void {
    const leaving = entry.handle;
    if (leaving === null || entry.closing !== null) return;
    // Before the close (M21, C67): what still waited is dropped, never withdrawn by an end made for it.
    requests.dropAll(id);
    const closing = leaving.close().then((answer) => answer, () => ({ ok: false })).then((result) => {
      onClosed(id, entry, leaving, result);
      if (entry.closing === closing) entry.closing = null;
    });
    entry.closing = closing;
  }

  /**
   * A turn's elapsed time (M19, C43, C44): from its prompt's acceptance to the provider's end as
   * main took it, excluding waits for the user's decisions, on the monotonic clock. Null for a
   * turn that is not the one in flight: nothing is measured from another clock.
   */
  function elapsedOf(id: string, entry: Live, turnId: string): number | null {
    if (entry.turn?.id !== turnId) return null;
    return Math.max(0, Math.round(monotonic() - entry.turn.acceptedAt - requests.waitedMs(id, turnId)));
  }

  /** A notice, in fat-g's words, with the CLI's own where the notice carries them (C34). */
  function noticeItem(kind: Parameters<typeof noticeWords>[0], providerId: string, step?: Parameters<typeof noticeWords>[2], detail: string | null = null, aside = false, extra: NoticeExtra = {}): NewItem {
    // An aside's turn ends alone (M20b, C39, C70): its notice says so, in words of its own.
    const words = (aside ? asideNoticeWords : noticeWords)(kind, options.providerName(providerId), step, extra);
    return { id: newId(), kind: 'notice', origin: 'local', providerItemId: null, role: null, phase: null, text: words, cut: false, questions: [], notice: kind, detail, receivedAt: now(), providerAt: null };
  }

  // ── Asides (M20b, C4, C33, C34) ───────────────────────────────────────────────────────────
  /**
   * An aside's turn is over, however: the provider's end where it gave one, and the session's end
   * beside it (M18, C54), as a turn's are kept — written here, since nothing of an aside goes
   * through the session service. Its session's read lists it as no longer running.
   */
  function endAside(id: string, entry: Live, asideId: string, reported: { readonly outcome: 'completed' | 'interrupted' | 'failed'; readonly answerItemId: string | null } | null, outcome: TurnOutcome): void {
    const open = entry.asides.get(asideId);
    if (open === undefined) return;
    entry.asides.delete(asideId);
    const at = now();
    chat.ended(asideId, open.turnId, reported === null ? null : { outcome: reported.outcome, at, answerItemId: reported.answerItemId, elapsedMs: Math.max(0, Math.round(monotonic() - open.acceptedAt)) });
    chat.sessionEnded(asideId, open.turnId, at, outcome);
    chat.changed(id);
  }

  /** Every open aside's turn ends, as the session's own does at a loss, a close and a quit (M20b, C34): its open message partial, its open activities unfinished. */
  function endAsides(id: string, entry: Live, outcome: TurnOutcome): void {
    for (const asideId of [...entry.asides.keys()]) endAside(id, entry, asideId, null, outcome);
  }

  /** An event that names an aside (M20b, C25): to the aside's conversation alone. Nothing of it reaches the session service (C4, C33). */
  function onAsideEvent(id: string, entry: Live, record: SessionRecord, asideId: string, bridged: Bridged): void {
    const open = entry.asides.get(asideId);
    // An aside this run holds no open turn of — removed, or ended here already: nothing of it is taken.
    if (open === undefined) { count('aside event dropped (no open turn)'); return; }
    if (bridged.taken !== null) chat.took(asideId, bridged.taken.turnId, bridged.taken.providerTurnId);
    for (const change of bridged.chat) {
      if (change.kind === 'assistant') {
        chat.add(asideId, change.turnId, { id: newId(), kind: 'message', origin: 'local', providerItemId: change.itemId, role: 'assistant', phase: change.phase, text: change.text, cut: change.cut, questions: change.questions, notice: null, detail: null, receivedAt: now(), providerAt: null, model: change.model });
      } else if (change.kind === 'delta') {
        chat.delta(asideId, change.turnId, { itemId: change.itemId, phase: change.phase, text: change.text });
      } else if (change.kind === 'activity-started') {
        chat.activityStarted(asideId, change.turnId, { itemId: change.itemId, workerId: null, start: change.start, providerAt: change.providerAt });
      } else if (change.kind === 'activity-ended') {
        chat.activityEnded(asideId, change.turnId, { itemId: change.itemId, workerId: null, end: change.end, providerAt: change.providerAt, durationMs: change.durationMs, untimed: change.untimed });
      } else if (change.kind === 'notice') {
        if (change.notice === 'folder-not-passed') {
          if (entry.folderSaid) continue;
          entry.folderSaid = true;
        }
        chat.add(asideId, change.turnId, noticeItem(change.notice, record.providerId, change.step ?? undefined, change.detail, true, { ...modeWords(record, entry), bound: change.bound, size: change.size }));
      }
      // Its provider's echo of the question names nothing fat-g keeps: the question was recorded when it was asked.
    }
    if (bridged.ended !== null && bridged.ended.turnId === open.turnId) {
      const { ended } = bridged;
      endAside(id, entry, asideId, ended.reported ? { outcome: ended.outcome, answerItemId: ended.answerItemId } : null, ended.outcome);
      count(`aside turn ended (${ended.outcome}${ended.failure === null ? '' : `, ${ended.failure}`})`);
    }
    settle(id, entry);
  }

  /** What the registry asks of a session's handle (M21, C30): its `answer`, where it has one. */
  const answerable = (handle: ProviderSession): Answerable => ({ answer: (requestId, answers) => handle.answer?.(requestId, answers), decide: (requestId, choice) => handle.decide?.(requestId, choice), decline: (requestId) => handle.decline?.(requestId), decidePlan: (requestId, answer) => handle.decidePlan?.(requestId, answer) });

  /**
   * Whether a plan holds the chat's own prompt (M22b, C56, C58): a request it holds on its plan, or
   * the workflow's word (decision 0029) — else, with no workflow, a line waiting in it.
   */
  const planPendingOf = (id: string, send: { readonly kind: 'typed'; readonly plan: boolean } | { readonly kind: 'answer' } = { kind: 'typed', plan: false }): boolean => {
    if (requests.plan(id) !== null) return true;
    if (options.workflow !== undefined) return options.workflow.admit(id, send) !== null;
    return (options.plans?.waiting(id) ?? null) !== null;
  };

  /** The plan's line no longer waits with no request holding it (M22b, C27): PLAN READY lets go, and the entry says so. */
  function planDecided(id: string): void {
    sessions.apply({ type: 'plan-waiting', sessionId: id, waiting: false });
    entryChanged();
  }

  function onEvent(id: string, entry: Live, raw: unknown, handle: ProviderSession, generation: number): void {
    const record = sessions.record(id);
    if (record === undefined) return;
    const parsed = AgentEventSchema.safeParse(raw);
    if (!parsed.success) { count('event refused (not an agent event)'); return; }
    if (parsed.data.type === 'image-returned') {
      if (entry.handle === handle) void options.returnedImages?.receive(id, parsed.data);
      return;
    }
    // A question asked as a request, and what became of one (M21, C10, C20): the registry's, with
    // the generation they came on, and none of the bridge's.
    if (parsed.data.type === 'question-raised') {
      requests.raise(id, generation, parsed.data, answerable(handle));
      return;
    }
    if (parsed.data.type === 'question-resolved') { requests.resolve(id, generation, parsed.data); return; }
    // An action asked leave for, and what became of its request (M22, C8, C10): the registry's too.
    if (parsed.data.type === 'approval-raised') {
      requests.raise(id, generation, parsed.data, answerable(handle));
      return;
    }
    if (parsed.data.type === 'approval-resolved') { requests.resolve(id, generation, parsed.data); return; }
    // A plan (M22b, C10, C14, C56): a request's to the registry, which has the plan service write its
    // version and its line; a plan being written to the plan service itself. None goes to a bridge.
    if (parsed.data.type === 'plan-raised') {
      requests.raise(id, generation, parsed.data, answerable(handle));
      entryChanged();
      return;
    }
    if (parsed.data.type === 'plan-resolved') { requests.resolve(id, generation, parsed.data); entryChanged(); return; }
    // What became of a message handed into a running turn (M23, C42–C44): the runtime's, from the process it was handed to.
    if (parsed.data.type === 'delivery' || parsed.data.type === 'held-turn-started') {
      if (entry.handle === handle) onDelivery(id, entry, parsed.data);
      return;
    }
    // Whether the turn takes a message changed, with nothing else said: the page is told, and a held Send now goes.
    if (parsed.data.type === 'steer-changed') {
      if (entry.handle === handle) settle(id, entry);
      return;
    }
    if (parsed.data.type === 'plan-delta') { options.plans?.delta(id, parsed.data); return; }
    if (parsed.data.type === 'plan-completed') {
      // A plan the session made waits for its decision (C27): PLAN READY at its turn's end.
      if (options.plans?.completed(id, parsed.data) === true) { sessions.apply({ type: 'plan-waiting', sessionId: id, waiting: true }); entryChanged(); }
      return;
    }
    // The mode this process confirmed (M22, C2): what the summary shows as in force, from the process that said so.
    if (parsed.data.type === 'in-force' && parsed.data.mode !== undefined && entry.handle === handle) confirmed(id, entry, record, parsed.data.mode);
    const bridged = bridge(id, parsed.data);
    // A start that did not run under the chat's mode blocks Send (M22, C46), whether a turn's or an aside's found it.
    if (bridged.ended !== null && bridged.ended.failure !== null && POLICY_FAILURES.has(bridged.ended.failure)) unconfirm(entry, record);
    if (bridged.asideId !== null) { onAsideEvent(id, entry, record, bridged.asideId, bridged); return; }
    if (bridged.reference !== null) {
      // Kept until the record holds it: the next prompt resumes by it whatever became of the write
      // (C108). And to the conversation store, with the folders it started in (M18, C28).
      entry.kept = bridged.reference;
      chat.reference(id, bridged.reference.reference, bridged.reference.folder, options.configFolder?.(refOf(record)) ?? null);
      count('session started');
    }
    if (bridged.taken !== null) chat.took(id, bridged.taken.turnId, bridged.taken.providerTurnId);
    // The provider's own end is stored as such, and before the session's, which the service writes
    // as it takes the event: fat-g killed between the two leaves a turn that ended in a session
    // that reads STOPPED. An end the adapter made is the session's alone (M18, C54, C59).
    // An end that names the turn's answer settles that message's phase in the same write (M16, C74).
    // And the turn's elapsed time, measured to here on the monotonic clock (M19, C44).
    if (bridged.ended !== null) {
      // The turn's end withdraws what the turn still asked (M21, C12), before the summary takes
      // the end: a running worker's question is left, and so is anything a loss dropped already.
      requests.turnEnded(id, bridged.ended.turnId);
      // And what it was still writing of a plan is unfinished (M22b, C59, C74).
      options.plans?.turnEnded(id, bridged.ended.turnId);
      chat.ended(id, bridged.ended.turnId, bridged.ended.reported ? { outcome: bridged.ended.outcome, at: now(), answerItemId: bridged.ended.answerItemId, elapsedMs: elapsedOf(id, entry, bridged.ended.turnId) } : null);
    }
    for (const event of bridged.session) {
      // A worker's end withdraws what the worker still asked (M21, C12, C65).
      if (event.type === 'worker-ended') requests.workerEnded(id, event.workerId);
      sessions.apply(event);
    }
    // A message of the session's own that carries questions gets its card, where its provider asks so (M21, C30, C33).
    const cards = asksAsync(options.questions?.(record.providerId) ?? 'none');
    for (const change of bridged.chat) {
      if (change.kind === 'assistant') {
        chat.add(id, change.turnId, { id: newId(), kind: 'message', origin: 'local', providerItemId: change.itemId, role: 'assistant', phase: change.phase, text: change.text, cut: change.cut, questions: change.questions, notice: null, detail: null, receivedAt: now(), providerAt: null, workerId: change.workerId, model: change.model }, cards && change.workerId === null);
      } else if (change.kind === 'delta') {
        // A message as it is written (M19, C3): the chat service holds it open until its whole message.
        chat.delta(id, change.turnId, { itemId: change.itemId, phase: change.phase, text: change.text, workerId: change.workerId });
      } else if (change.kind === 'activity-started') {
        // The item that started a worker reads as the agent list names that worker (M20a, C23): the
        // summary took the worker's start before this event, and its label is the one line both show.
        const paired = change.start.workerId ?? null;
        const label = paired === null ? null : sessions.workerLabel(id, paired);
        chat.activityStarted(id, change.turnId, { itemId: change.itemId, workerId: change.workerId, start: label === null ? change.start : { ...change.start, summary: label }, providerAt: change.providerAt });
      } else if (change.kind === 'activity-ended') {
        chat.activityEnded(id, change.turnId, { itemId: change.itemId, workerId: change.workerId, end: change.end, providerAt: change.providerAt, durationMs: change.durationMs, untimed: change.untimed });
      } else if (change.kind === 'echo') {
        // By the id the prompt was sent with, when the echo carries it; else as its turn's first (C56).
        const turn = entry.turn;
        const messageId = change.clientId !== null && turn?.messageId === change.clientId ? change.clientId : turn !== null && !turn.echoed ? turn.messageId : null;
        if (messageId !== null && turn !== null) { turn.echoed = true; chat.echo(id, messageId, change.itemId); }
      } else {
        // That a folder could not be handed over is said at each launch that leaves one out, and
        // shown once a run (M16, C20), as the session's own unsaved entry is.
        if (change.notice === 'folder-not-passed') {
          if (entry.folderSaid) continue;
          entry.folderSaid = true;
        }
        chat.add(id, change.turnId, noticeItem(change.notice, record.providerId, change.step ?? undefined, change.detail, false, { ...modeWords(record, entry), bound: change.bound, size: change.size }));
      }
    }
    if (bridged.ended !== null) {
      if (entry.turn?.id === bridged.ended.turnId) entry.turn = null;
      count(`turn ended (${bridged.ended.outcome}${bridged.ended.failure === null ? '' : `, ${bridged.ended.failure}`})`);
      // With this event's own items in, the async cards the model went on past are passed (decision
      // 0026, item 11), before a review or a plan reads whether the turn ended by asking.
      chat.passGonePast(id, bridged.ended.turnId);
      // Once the end has written the answer's phase, and this event's own items are in (M22e, C43).
      options.reviews?.()?.turnEnded(id, bridged.ended.turnId, bridged.ended.outcome);
      // And the plan's workflow, which a revision's or an implementation's end moves (decision 0029).
      options.workflow?.turnEnded(id, bridged.ended.turnId, bridged.ended.outcome);
    }
    settle(id, entry);
  }

  /** The provider's session ended, however: its handle goes, or is kept to look at again (C104, C116). */
  function onClosed(id: string, entry: Live, handle: ProviderSession, result: { readonly ok: boolean }): void {
    if (entry.handle !== handle) return;
    // First (M21, C67): what still waited on that process is dropped before any end made here. An
    // adapter says so itself for each request it held, before the ends it makes: this makes sure of it.
    requests.dropAll(id);
    entry.detach?.();
    entry.detach = null;
    entry.handle = null;
    entry.handed = [];
    // What it still held of messages handed into a turn is not known to have run (M23, C44).
    for (const messageId of entry.steered.keys()) chat.setDelivery(id, messageId, { state: 'not-confirmed', detail: null });
    entry.steered.clear();
    // No process of it confirms a mode any more (M22, C2), and every grant sent to this one ended with it (C81, C86).
    const key = entry.processKey;
    entry.processKey = null;
    if (entry.inForce !== null) { entry.inForce = null; sessions.apply({ type: 'in-force', sessionId: id, mode: null }); }
    timers.clear(entry.idleTimer);
    entry.idleTimer = undefined;
    // An adapter ends its turn and its workers before its session: this only makes sure of it.
    if (entry.turn !== null) {
      sessions.apply({ type: 'turn-ended', sessionId: id, turnId: entry.turn.id, outcome: 'failed' });
      chat.ended(id, entry.turn.id, null);
      entry.turn = null;
    }
    if (sessions.isRunning(id)) sessions.apply({ type: 'workers-reported', sessionId: id, workerIds: [] });
    // Nothing of it runs any more: what was still open of its work, a worker's included, is left unfinished (M20a, C29) — and of a plan it was writing (M22b, C59).
    chat.lost(id);
    options.plans?.lost(id);
    // A review's or an integration's turn it still ran is over with it (M22e, C25, C27), and an operation of a plan's (decision 0029).
    options.reviews?.()?.lost(id);
    options.workflow?.lost(id);
    // Its asides ran on it too (M20b, C34): an adapter ends them before its session, and this makes sure of it.
    endAsides(id, entry, 'failed');
    // Nothing of that handle comes after this (M21, C75): an answer whose mark never came is let go as it is.
    requests.closed(id, entry.generation);
    if (!result.ok) { entry.unconfirmed = handle; count('session end unconfirmed'); }
    // The session's list, and each card, read its grants ended from here on (M22, C57, C86).
    if (key !== null && chat.grantsOn(id, key) > 0) chat.changed(id);
    settle(id, entry);
  }

  function open(record: SessionRecord, entry: Live, facet: SessionFacet, folder: string): ProviderSession {
    const reference = referenceOf(record, entry);
    // The project's other eligible folders, worked out at this start or this resume, for a provider
    // whose sessions take them; an empty list for any other (M16, C61).
    const otherFolders = options.takesOtherFolders?.(record.providerId) === true ? gate.otherFolders(record) : [];
    // Under the chat's mode, with a key of this process's own (M22, C2, C81): the adapter names the
    // mode at its start and checks what its CLI reports before any prompt goes.
    const processKey = newId();
    const start = { folder, model: record.model, effort: record.effort, speed: record.speed, otherFolders, mode: chatModeOf(record, entry)?.id ?? null, processKey };
    const handle = reference === null ? facet.start(start) : facet.resume({ ...start, reference });
    entry.handle = handle;
    entry.processKey = processKey;
    entry.inForce = null;
    entry.generation += 1;
    const { generation } = entry;
    entry.handed = otherFolders;
    entry.detach = handle.subscribe((event) => onEvent(record.id, entry, event, handle, generation));
    void handle.closed.then((result) => onClosed(record.id, entry, handle, result), () => onClosed(record.id, entry, handle, { ok: false }));
    return handle;
  }

  function watch(facet: SessionFacet): void {
    if (watched.has(facet)) return;
    watched.add(facet);
    facet.history?.onAvailable(() => { selectionChanged(); });
  }

  // ── History (M15, C57, C93, C122; M18, C51, C52) ──────────────────────────────────────────
  /** Starts a check of the session's earlier conversation, if one is due and can be made. Answers what became of the ask. */
  function check(id: string): 'loading' | 'waiting' | 'none' | 'blocked' | 'unsupported' {
    const record = sessions.record(id);
    if (record === undefined) return 'none';
    const entry = live(record);
    const state = chat.history(id);
    if (state === 'unsupported') return 'unsupported';
    if (state === 'checking') return 'loading';
    if (state !== 'not-checked' && state !== 'failed') return 'none';
    // Not checked for a session held for its provider, its instance or its folder, nor while the
    // conversation store is refused: it stays as it is (C57; M18, C33).
    if (blocksHistory(gate.block(record, sessions.holdNow(id))) || removal.pending(id)) return 'blocked';
    const reference = referenceOf(record, entry);
    if (reference === null) { chat.setHistory(id, 'checked'); return 'none'; }
    // Never while a turn runs: it would bring that turn's own items, half-finished (C122).
    if (sessions.isRunning(id)) { entry.historyWanted = true; return 'waiting'; }
    const facet = options.facet(refOf(record));
    if (facet === undefined) { chat.setHistory(id, 'failed'); return 'none'; }
    const { history } = facet;
    // A provider with no history is asked nothing (C25).
    if (history === undefined) { chat.setHistory(id, 'unsupported'); return 'unsupported'; }
    watch(facet);
    try {
      // A session the record says had started gets its conversation here, if the store has none (C33).
      store.ensure(id, now());
    } catch {
      chat.setHistory(id, 'failed');
      count('history check failed (storage)');
      return 'none';
    }
    const controller = new AbortController();
    entry.historyRead = controller;
    chat.setHistory(id, 'checking');
    const notShown = noticeWords('turn-not-shown', options.providerName(record.providerId));
    void checkHistory((page, signal) => history.read(reference, page, signal), {
      async images(images) {
        for (const image of images) {
          if (controller.signal.aborted) return;
          const turn = store.held(id).byProviderTurnId(image.turnId);
          if (turn !== null) await options.returnedImages?.receive(id, { type: 'image-returned', turnId: turn.id, itemId: image.itemId, image: image.image });
        }
      },
      held: () => store.held(id),
      merge(plans, anchor) {
        // A message with questions that the check adds gets its card, where the provider asks so (M21, C28).
        const merged = store.mergePage(id, plans, anchor, notShown, asksAsync(options.questions?.(record.providerId) ?? 'none'));
        if (merged.changed) chat.changed(id);
        return merged.anchor;
      },
      mark: (providerTurnIds, reachedStart) => store.markReached(id, providerTurnIds, reachedStart),
    }, controller.signal).then((outcome) => {
      if (entry.historyRead !== controller) return;
      entry.historyRead = null;
      if (!chat.has(id)) return;
      if (outcome.state === 'checked') chat.setHistory(id, 'checked', outcome.olderUnread);
      else { chat.setHistory(id, 'failed'); count('history check failed'); }
      // A queued message waited on it (C89): a failed check refuses no Send.
      drain.wake(id);
    });
    return 'loading';
  }

  /** The session the Main page was last known to show: its draft is written when another is chosen (M23, C31). */
  let shown: string | null = null;
  function selectionChanged(): void {
    const { selectedId } = sessions.snapshot();
    if (shown !== null && shown !== selectedId) composer?.flush(shown);
    shown = selectedId;
    // The providers, their modes or a history's availability changed: a queue that waited on one may go (C89).
    wakeQueues();
    if (selectedId === null) return;
    const record = sessions.record(selectedId);
    if (record === undefined) return;
    live(record);
    check(selectedId);
  }

  // ── The records: a removal, a completion, a reference that landed, a session listed (C85, C104, C108; M18, C55) ──
  const stopFollowing = options.records.subscribe(() => {
    const listed = new Map(options.records.getView().sessions.map((record) => [record.id, record]));
    for (const [id, entry] of [...lives]) {
      const record = listed.get(id);
      if (record === undefined) {
        // Removed, by itself or with its project: it was idle, so its process is closed and what
        // this run held of it goes. Its saved chat is the removal's own to delete (M18, C30).
        entry.historyRead?.abort();
        timers.clear(entry.idleTimer);
        options.secretary?.forget(id);
        // What main held of its draft goes unwritten: its rows are its removal's (M23, C32). Its queue goes with them (C82).
        composer?.forget(id);
        drain.forget(id);
        // Before the close (M21, C67), and nothing of it is held after.
        requests.dropAll(id);
        entry.detach?.();
        void entry.handle?.close();
        lives.delete(id);
        chat.drop(id);
        requests.forget(id);
        options.plans?.forget(id);
        // A review it ran ends, and an integration sent to it (M22e, C2, C27): its reviews stay with their plan.
        options.reviews?.()?.forget(id);
        // It takes part in no plan's workflow any more, and what it held is settled (decision 0029).
        options.workflow?.forget(id);
        wokeIdle(id);
        continue;
      }
      if (record.reference !== null) entry.kept = null;
      // A name the user typed is final (M26): a title still asked for is nobody's.
      if (record.nameSource === 'user') options.secretary?.forget(id);
      // Completed: its process closes at once (C85), unless an aside of it still runs, which the idle
      // clock then waits for (M20b, C10). A turn reopens it, in the same write as its start.
      const completed = record.completedAt !== null;
      if (completed && !entry.completed && !busy(id, entry)) closeIdle(id, entry);
      // Done on a reviewer cancels its review, and on an implementation's chat gives the plan back to the chats left (decision 0029).
      if (completed && !entry.completed) options.workflow?.closed(id, 'done');
      // An explicit completion drops the queue and keeps the conversation and the draft (M23, C82).
      if (completed && !entry.completed) dropQueueOf(id);
      entry.completed = completed;
      // Shelved: its process closes as a completed one's does, and its queue and draft stay. What the
      // queue had in flight is let go, the entry kept, and its pause goes — the shelving's own write may
      // have caused it; one whose cause stands comes back at the next try. The queue waits, and Unshelve
      // — not a turn, which takes the session off the shelf by itself — wakes it.
      const shelved = record.shelvedAt !== null;
      if (shelved && !entry.shelved) {
        if (!busy(id, entry)) closeIdle(id, entry);
        options.workflow?.closed(id, 'shelved');
        drain.forget(id);
        pushComposer(id);
      }
      const unshelved = !shelved && entry.shelved;
      entry.shelved = shelved;
      if (unshelved) drain.wake(id);
    }
    // In this same step: no Send can come between a session being listed and its reconciliation (C55).
    reconcileListed();
  });

  // At launch, once the store is open and before any window (C55).
  reconcileListed();

  /** What a Send is given: a prompt as it was typed, or the answer to an async question's card, whose prompt is written here (M21, C26). */
  type Given =
    | { readonly prompt: string; readonly plan?: boolean; readonly input?: SendInput; /** A queued message (M23, C54, C56): taken whole from the queue in the prompt's own transaction. */ readonly queued?: QueuedInput }
    /** A message sent now that its turn's end refused (M23, C39): already recorded, moved to the turn it starts. */
    | { readonly promoted: Promoted }
    | { readonly itemId: string; readonly entries: readonly AnswerEntry[] }
    /**
     * A plan's decision that starts a turn (M22b, C15, C65): its prompt is composed here, in the send's
     * one step. `turnId`: one its caller allotted, an integration's (M22e, C24).
     */
    | { readonly decision: { readonly itemId: string; readonly kind: 'feedback' | 'execute'; readonly text: string | null; readonly turnId?: string } }
    /** A prompt fat-g composed (M22e, C2, C24, C31): under the caller's ids. */
    | { readonly composed: ComposedPrompt };

  /**
   * An async card's answer as the prompt it is sent as (M21, C26, C78), worked out in the send's one
   * step, after its waits: the card must still be open, the answer must fit its questions and say
   * something, and the prompt must be within a prompt's bound — else nothing is written or sent.
   */
  function answering(sessionId: string, itemId: string, entries: readonly AnswerEntry[]): { readonly itemId: string; readonly turnId: string; readonly prompt: string; readonly answers: readonly (InteractionAnswer | null)[] } | 'unknown-item' | 'not-pending' | 'mismatch' | 'incomplete' | 'too-long' {
    const item = chat.interaction(sessionId, itemId);
    const body = item === null ? null : questionOf(item);
    if (body === null) return 'unknown-item';
    if (body.mode !== 'async' || body.outcome !== 'open') return 'not-pending';
    const answers = placeAnswers(body.questions.length, entries);
    if (answers === null || !fits(body.questions, answers)) return 'mismatch';
    if (answers.every((answer) => answer === null)) return 'incomplete';
    const prompt = answerPrompt(body.questions, answers);
    // Sixteen answers of 10,000 units pass a prompt's bound, and this prompt meets no channel's schema (C26).
    if (prompt.length > MAX_MESSAGE_TEXT) return 'too-long';
    return { itemId, turnId: item?.turnId ?? '', prompt, answers: keptAnswers(body.questions, answers) };
  }

  /** What a turn planned (M22b, C71): its flag and its prompt's fields, which an async answer given in it carries on. */
  function plannedIn(sessionId: string, turnId: string): { readonly plan: boolean; readonly fields: PlanFields | null } | null {
    try {
      const state = store.turnPlan?.(sessionId, turnId) ?? null;
      return state === null ? null : { plan: state.plan, fields: state.fields };
    } catch { return null; }
  }

  /** What became of a Send. `card`: an answer's own refusal, which a prompt as it was typed never meets. */
  /** What Send now carries: a typed message, a held one from the queue, or an answer of an async card. */
  type Steering =
    | { readonly prompt: string; readonly plan?: boolean; readonly input?: SendInput }
    /** A Send now held in the queue: taken whole from it in the message's own transaction. */
    | { readonly prompt: string; readonly queued: QueuedInput }
    | { readonly itemId: string; readonly entries: readonly AnswerEntry[] };

  type Sent = { readonly status: 'sent' } | Extract<ChatSendResult, { status: 'refused' }> | { readonly status: 'card'; readonly reason: 'unknown-item' | 'not-pending' | 'mismatch' | 'incomplete' | 'too-long' };

  async function sendGiven(sessionId: string, given: Given): Promise<Sent> {
    if (quitting) return { status: 'refused', reason: 'busy' };
    if (sessions.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
    if (sessions.isRunning(sessionId) || (lives.get(sessionId)?.steered.size ?? 0) > 0) return { status: 'refused', reason: 'running' };
    // What a Send waits for, in order: the reason, with its folder comparison; then the look at an
    // end that was not confirmed (C109, C116).
    const hold = await sessions.hold(sessionId);
    const first = sessions.record(sessionId);
    if (first === undefined) return { status: 'refused', reason: 'unknown-session' };
    const block = gate.block(first, hold);
    if (block !== null) return { status: 'refused', reason: block };
    // Its idle process is being closed: the prompt waits for that close, whose answer is then read
    // as any end's is — confirmed, the session resumes; not confirmed, the Send is refused (C85, C116).
    await live(first).closing;
    const waiting = lives.get(sessionId)?.unconfirmed ?? null;
    if (waiting !== null) {
      const gone = await waiting.recheck().then((result) => result.ok, () => false);
      const entry = lives.get(sessionId);
      if (!gone) return { status: 'refused', reason: 'unconfirmed' };
      if (entry?.unconfirmed === waiting) entry.unconfirmed = null;
    }
    // A folder handed over when the session's process was opened is no longer one it may have: its
    // trust was withdrawn, it went missing, or it left the project. That process is closed before
    // the prompt is accepted, and the prompt resumes the session without it (M16, C72). A folder
    // that has become eligible waits for the next launch.
    const opened = lives.get(sessionId);
    if (opened !== undefined && opened.handle !== null && opened.handed.length > 0) {
      const eligible = new Set(gate.otherFolders(first));
      if (opened.handed.some((folder) => !eligible.has(folder))) {
        const leaving = opened.handle;
        requests.dropAll(sessionId);
        const result = await leaving.close().then((answer) => answer, () => ({ ok: false }));
        onClosed(sessionId, opened, leaving, result);
        count('session closed (a folder is no longer eligible)');
        // A close that is not confirmed refuses the Send, as any is (C116).
        if (!result.ok) return { status: 'refused', reason: 'unconfirmed' };
      }
    }

    // The draft's images (M23, C8, C21): each one the draft still names, read whole and checked against
    // its hash, before the one step — a missing or changed image leaves the draft unsent with its reason.
    const input = 'prompt' in given ? given.input ?? null : null;
    const promoted = 'promoted' in given ? given.promoted : null;
    const queued = 'prompt' in given ? given.queued ?? null : null;
    let images: readonly PromptAttachment[] = promoted?.images ?? [];
    if (input !== null && input.attachmentIds.length > 0) {
      const prepared = await prepareImages(sessionId, input.attachmentIds);
      if (typeof prepared === 'string') return { status: 'refused', reason: prepared };
      images = prepared;
    }
    if (queued !== null && queued.attachmentIds.length > 0) {
      const prepared = await prepareQueued(sessionId, queued);
      if (typeof prepared === 'string') return { status: 'refused', reason: prepared };
      images = prepared;
    }
    // A skill chosen from the menu (M23, C64, C87): resolved against its CLI's current list before
    // anything is consumed. One no longer listed sends nothing, and nothing is sent in its place.
    const chosen = input?.intent.skill ?? queued?.intent.skill ?? null;
    if (chosen !== null && !(await skillListed(first, chosen.selector))) return { status: 'refused', reason: 'skill-unavailable' };

    // One step, with nothing awaited inside it: the session is listed, not running, not leaving,
    // the quit has not begun, and its earlier conversation is not being checked (C86, C109, C118,
    // C122). The prompt's record is written inside it (M18, C44).
    const record = sessions.record(sessionId);
    if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
    if (sessions.isRunning(sessionId)) return { status: 'refused', reason: 'running' };
    // A preset changed while Send was checking images or a skill: repeat the Send on its new account.
    if (!sameInstance(first, record) || first.model !== record.model || first.effort !== record.effort) return { status: 'refused', reason: 'changing-mode' };
    if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
    // A queued message taken before its session was shelved waits for Unshelve: it starts no turn, which would unshelve it.
    if (queued !== null && record.shelvedAt !== null) return { status: 'refused', reason: 'shelved' };
    const entry = live(record);
    // A message its CLI still holds may yet start as its next turn (M23, C88): nothing else is taken meanwhile.
    if (entry.steered.size > 0) return { status: 'refused', reason: 'running' };
    if (entry.unconfirmed !== null) return { status: 'refused', reason: 'unconfirmed' };
    // Nothing else of a session is taken while its mode changes (M22, C90).
    if (entry.changing) return { status: 'refused', reason: 'changing-mode' };
    const history = chat.history(sessionId);
    if (history === 'not-checked' || history === 'checking') {
      if (history === 'not-checked') check(sessionId);
      if (chat.history(sessionId) === 'not-checked' || chat.history(sessionId) === 'checking') return { status: 'refused', reason: 'history-loading' };
    }
    const folder = gate.folder(record);
    const facet = options.facet(refOf(record));
    if (folder === null) return { status: 'refused', reason: 'folder-not-root' };
    if (facet === undefined) return { status: 'refused', reason: 'not-connected' };
    // Nor while its account's sandbox is set up (M22, C62): the setup holds the account.
    if (setupHolds(facet.sandbox?.state())) return { status: 'refused', reason: 'setting-up' };
    // The chat's mode, read again in this step and checked against its account (M22, C43): one that
    // cannot be used, or that its last start did not confirm, blocks the prompt, and nothing substitutes.
    const mode = chatModeOf(record, entry);
    const modeBlock = modeBlockOf(record, entry);
    if (modeBlock !== null) return { status: 'refused', reason: modeBlock };
    if (entry.handle !== null && entry.inForce !== null && mode !== null && entry.inForce !== mode.id) {
      // A process in force under another mode than the chat's is a defect (C90): it is closed, this
      // prompt is refused, and the next one starts under the chat's mode.
      count('session closed (in force under another mode)');
      closeIdle(sessionId, entry);
      return { status: 'refused', reason: 'mode-unconfirmed' };
    }
    watch(facet);

    // While a plan holds the chat, nothing of its own is taken but what the workflow admits (M22b, C56;
    // decision 0029): a decision, and a prompt fat-g composed for an operation already admitted, pass.
    const deciding = 'decision' in given ? given.decision : null;
    // A prompt fat-g composed (M22e, C2, C31): under its caller's ids, with its own flag and fields.
    const written = 'composed' in given ? given.composed : null;
    if (deciding === null && written === null && planPendingOf(sessionId, 'itemId' in given ? { kind: 'answer' } : { kind: 'typed', plan: 'prompt' in given && given.plan === true })) return { status: 'refused', reason: 'plan-pending' };

    // An answer's prompt is written here, after every wait (M21, C77): a card dismissed or passed
    // meanwhile is refused, and the store checks it once more inside the acceptance's transaction.
    const answered = 'itemId' in given ? answering(sessionId, given.itemId, given.entries) : null;
    if (typeof answered === 'string') return { status: 'card', reason: answered };
    // A decision's prompt is composed here too (M22b, C15, C65, C68): its line still waiting, and the
    // store checks it once more inside the acceptance's transaction.
    const composed = deciding === null ? null : options.plans?.compose(sessionId, deciding.itemId, deciding.kind, deciding.text) ?? 'unknown-item';
    if (composed === 'storage-failed') return { status: 'refused', reason: 'storage-failed' };
    if (typeof composed === 'string') return { status: 'card', reason: composed };
    // A plan turn (M22b, C1, C71): asked for, a decision's feedback, or an async answer given in a turn that planned.
    const carried = answered === null ? null : plannedIn(sessionId, answered.turnId);
    const planTurn = composed !== null ? composed.plan : 'prompt' in given ? given.plan === true : written !== null ? written.plan : carried?.plan === true;
    // Under a mode its provider lists, on an account whose CLI takes one (C2, C5, C13, C72): checked before anything is consumed.
    if (planTurn && planTurnBlocked(options.planCapability?.(record.providerId), mode?.id ?? null, facet.plans?.(), options.providerName(record.providerId)) !== null) return { status: 'refused', reason: 'plans-unavailable' };
    const fields = composed?.fields ?? written?.fields ?? (carried?.plan === true ? carried.fields : null);
    const prompt = 'prompt' in given ? given.prompt : promoted !== null ? promoted.prompt : written?.prompt ?? composed?.prompt ?? answered?.prompt ?? '';

    // A command of the provider's own that fat-g answers itself (M20b, C35, C55; decision 0023):
    // a turn of the session's that is never sent. Its prompt is the user's message, fat-g's notice
    // the turn's, and its end fat-g's own; no process is started for it, and no model is called.
    // An answer is fat-g's words and no command the user wrote: it is never one, nor is a prompt fat-g composed.
    const command: CommandNoticeKind | null = answered === null && composed === null && written === null && promoted === null ? facet.intercepts?.(prompt) ?? null : null;
    // The draft the prompt is, consumed in its own transaction (M23, C56, C86).
    const from = input !== null ? { draft: { revision: input.revision, text: prompt, intent: input.intent, attachmentIds: input.attachmentIds } } : queued !== null ? { queued: queued.id } : null;
    if (command !== null) {
      const ownTurn = newId();
      const base = { turnId: ownTurn, itemId: newId(), text: prompt, at: now(), started: referenceOf(record, entry) !== null, own: true, mode };
      const took = from === null ? (chat.accept(sessionId, base) ? 'accepted' : 'storage-failed') : chat.acceptInput(sessionId, { ...base, from });
      if (took !== 'accepted') return { status: 'refused', reason: took === 'draft-changed' ? 'draft-changed' : 'storage-failed' };
      if (input !== null) consumed(sessionId, input.revision);
      if (queued !== null) pushComposer(sessionId);
      sessions.apply({ type: 'turn-started', sessionId, turnId: ownTurn });
      // Its acceptance passed every open card of the chat (M21, C41), one a review's turn asked on among them (M22e, C49).
      options.reviews?.()?.accepted(sessionId, ownTurn, null);
      chat.add(sessionId, ownTurn, noticeItem(command, record.providerId));
      chat.ended(sessionId, ownTurn, null);
      // The session's end, which the service tells the conversation store as it takes it (M18, C54).
      sessions.apply({ type: 'turn-ended', sessionId, turnId: ownTurn, outcome: 'completed' });
      count(`command answered (${command})`);
      settle(sessionId, entry);
      return { status: 'sent' };
    }

    // A composed prompt's ids, and a decision's turn, are their caller's where it allotted them (M22e, C24).
    const turnId = written?.turnId ?? deciding?.turnId ?? newId();
    const messageId = written?.messageId ?? promoted?.messageId ?? newId();
    // On disk before it is sent (C15): a prompt that cannot be recorded is not dispatched, and its
    // draft stays (C19). The item's id is the client id the prompt is sent with (C53). An answer's
    // prompt, its card's `answered` and the pass of the other open cards are that one write (M21, C26).
    // The chat's mode goes with it (M22, C40, C83): written to the conversation where it holds none
    // yet, and to the turn as the mode it runs under.
    // A plan turn's flag goes with its turn, and a composed prompt's fields with its item (M22b, C1, C69, C71).
    const accepting = { turnId, itemId: messageId, speed: speedOf(record), text: prompt, at: now(), started: referenceOf(record, entry) !== null, mode, ...(planTurn ? { plan: true } : {}), ...(fields === null ? {} : { fields }) };
    // Whether this prompt names the session (M23, C28): the first ordinary prompt with text, read from
    // what the store holds before it is accepted — so earlier prompts of images alone name nothing.
    // A message sent now names nothing, as the next prompt neither (M23, C41).
    const naming = promoted === null && written?.names !== false && record.nameSource !== 'user' && prompt.trim() !== '' && firstText(record);
    const accepted = promoted !== null
      // Already recorded (C39): moved to the turn it starts, and said so under it.
      ? (chat.movedToTurn(sessionId, promoted.messageId, turnId, now(), speedOf(record)) && chat.setDelivery(sessionId, promoted.messageId, { state: 'next-prompt', detail: null }) ? 'accepted' : 'storage-failed')
      : composed !== null && deciding !== null
      ? chat.acceptDecision(sessionId, { ...accepting, deciding: { itemId: deciding.itemId, outcome: composed.outcome } })
      : answered !== null ? chat.acceptAnswer(sessionId, { ...accepting, answering: { itemId: answered.itemId, answers: answered.answers } })
        : from !== null ? chat.acceptInput(sessionId, { ...accepting, from })
          : (chat.accept(sessionId, accepting) ? 'accepted' : 'storage-failed');
    if (accepted === 'not-pending') return { status: 'card', reason: 'not-pending' };
    if (accepted === 'draft-changed') return { status: 'refused', reason: 'draft-changed' };
    if (accepted === 'storage-failed' || accepted === 'not-queued') return { status: 'refused', reason: 'storage-failed' };
    // The draft is taken (M23, C86): stagings under way attach to nothing, and the page is told.
    if (input !== null) consumed(sessionId, input.revision);
    // Or the queued message (C56): gone from the queue in the prompt's own transaction.
    if (queued !== null) pushComposer(sessionId);
    // The decision is taken (C12): its line waits no more.
    if (deciding !== null) { options.plans?.settled(sessionId, deciding.itemId); planDecided(sessionId); }
    // A chat whose snapshot could not be made when it was created has it now, as its row holds it.
    if (entry.mode === null && mode !== null) entry.mode = chat.mode(sessionId) ?? mode;
    sessions.apply({ type: 'turn-started', sessionId, turnId });
    // A thread a plan turn of fat-g's ran on is taken out of the CLI's plan mode by every later turn
    // (C55): the store's record of each turn's flag says which it is. Where plans are off for its
    // account, that cannot be done, and the chat says so once a run.
    let plannedBefore = false;
    try { plannedBefore = !planTurn && store.plannedBefore?.(sessionId) === true; } catch { count('planned before not read (storage)'); }
    if (plannedBefore && facet.plans?.().available === false && !entry.planModeSaid) {
      entry.planModeSaid = true;
      chat.add(sessionId, turnId, noticeItem('plan-mode-left', record.providerId));
    }
    // What the turn is sent with is in force for it, whatever the record becomes meanwhile (C45, C103).
    entry.effort = record.effort;
    entry.speed = record.speed;
    noteModelUse(record);
    sessions.apply({ type: 'in-force', sessionId, effort: record.effort });
    entry.reported = true;
    // The first accepted prompt names the session, once (C46), and the secretary is asked for a better
    // name from it (M26). A session named from its unsent draft already (M26, round 2) has a
    // `generated` name, which the title replaces when it lands; the first-prompt name fills an empty
    // one alone, and a name the user typed is final, so neither is asked for then.
    // A reviewer's first prompt names nothing and asks no secretary: its name is the review's (M22e, C26).
    if (naming) {
      if (record.name === null) sessions.apply({ type: 'name-reported', sessionId, name: firstPromptName(prompt), source: 'first-message' });
      options.secretary?.title(sessionId, record, prompt);
    }
    // A reference the record does not hold is asked for again at each acceptance (C108).
    if (entry.kept !== null && record.reference === null) sessions.apply({ type: 'reference-set', sessionId, reference: entry.kept.reference, folder: entry.kept.folder });
    timers.clear(entry.idleTimer);
    entry.idleTimer = undefined;
    entry.turn = { id: turnId, messageId, echoed: false, acceptedAt: monotonic() };
    entry.running = true;
    entry.busy = true;
    // Before anything is sent (M22e, C49): an async card's answer carries on a review's or an
    // integration's turn that asked on it, and any other prompt passed that card. And a plan's
    // operation the chat holds takes the turn as its own (decision 0029).
    options.reviews?.()?.accepted(sessionId, turnId, answered?.itemId ?? null);
    options.workflow?.accepted(sessionId, turnId, answered?.itemId ?? null);
    const handle = entry.handle ?? open(record, entry, facet, folder);
    // Its images go with it, in the one write the CLI takes (M23, C21); nothing of them is kept here after.
    handle.send({ turnId, prompt, effort: record.effort, speed: record.speed, messageId, ...(images.length === 0 ? {} : { attachments: images }), ...(planTurn ? { plan: true } : {}), ...(plannedBefore ? { plannedBefore: true } : {}), ...(chosen === null ? {} : { skill: { name: chosen.name, selector: chosen.selector } }) });
    if (answered !== null) count('question answered (prompt)');
    if (planTurn) count('plan turn sent');
    if (composed !== null) count(`plan decided (${composed.outcome})`);
    return { status: 'sent' };
  }

  /** A plan's decision (M22b, C11, C12, C15, C65, C72): see `decidePlan`. */
  async function decidePlanOf(sessionId: string, itemId: string, decision: 'feedback' | 'execute' | 'cancel', text?: string, turnId?: string): Promise<PlanDecideResult> {
    if (quitting) return { status: 'refused', reason: 'busy' };
    const record = sessions.record(sessionId);
    if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
    const entry = live(record);
    const item = chat.interaction(sessionId, itemId);
    const body = item === null ? null : planOf(item);
    if (body === null || options.plans === undefined) return { status: 'refused', reason: 'unknown-item' };
    // Execute under a mode that reads only carries out nothing (C81): refused before the decision is taken.
    if (decision === 'execute' && readsOnly(record, entry)) return { status: 'refused', reason: 'reads-only' };
    if (body.request) {
      // A request's line (C11, C12): behind `busy` and a change alone, as an approval's is; its
      // process is alive by its request's presence.
      if (sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      if (entry.changing) return { status: 'refused', reason: 'changing-mode' };
      const { handle } = entry;
      if (handle === null) return { status: 'refused', reason: 'not-pending' };
      const answer: PlanAnswer = decision === 'feedback' ? { kind: 'feedback', text: text ?? '' } : { kind: decision };
      const decided = requests.decidePlan(sessionId, entry.generation, itemId, answer, answerable(handle));
      entryChanged();
      return decided === 'decided' ? { status: 'decided' } : { status: 'refused', reason: decided };
    }
    if (decision === 'cancel') {
      // Nothing is sent (C15): the line says so, and waits no more.
      if (sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      const cancelled = options.plans.cancel(sessionId, itemId);
      if (cancelled !== 'cancelled') return { status: 'refused', reason: cancelled };
      planDecided(sessionId);
      return { status: 'decided' };
    }
    const sent = await sendGiven(sessionId, { decision: { itemId, kind: decision, text: text ?? null, ...(turnId === undefined ? {} : { turnId }) } });
    if (sent.status === 'sent') return { status: 'decided' };
    if (sent.status === 'card') return { status: 'refused', reason: sent.reason === 'unknown-item' || sent.reason === 'not-pending' ? sent.reason : 'storage-failed' };
    return sent;
  }

  return {
    async setDraftPreset(id, preset) {
      if (options.records.isRefused()) return { status: 'refused', reason: 'records-refused' };
      const record = sessions.record(id);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (store.status().kind !== 'ok') return { status: 'refused', reason: 'conversations-refused' };
      const entry = live(record);
      const mutable = store as typeof store & Partial<Pick<ConversationStore, 'draftOnly' | 'setDraftMode'>>;
      const setPreset = options.records.setDraftPreset;
      if (quitting || sessions.isLeaving(id) || removal.pending(id) || entry.changing || busy(id, entry) || entry.handle !== null || referenceOf(record, entry) !== null || record.lastTurn !== null || planPendingOf(id) || setPreset === undefined || mutable.draftOnly === undefined || mutable.setDraftMode === undefined) return { status: 'refused', reason: 'draft-locked' };
      entry.changing = true;
      entryChanged();
      try {
        return await saveDraftPreset({ record, preset, records: { setDraftPreset: setPreset },
          store: { conversation: store.conversation, draftOnly: mutable.draftOnly, setDraftMode: mutable.setDraftMode }, permissions,
          changed: (mode) => { entry.mode = mode; entry.modeRead = true; entry.commands = null; entry.inForce = null; },
        });
      } finally { entry.changing = false; entryChanged(); }
    },

    read(sessionId, window) {
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      const entry = live(record);
      const started = referenceOf(record, entry) !== null;
      const read = chat.read(sessionId, window ?? null, started);
      if (read === null) return { status: 'refused', reason: 'unknown-session' };
      // The composer beside it (M23, C57): its draft, its queue, and whether Send now is offered.
      const answer = read.storage === 'refused' ? read : { ...read, composer: composerView(sessionId) };
      // An aside needs a conversation the provider holds, and a provider that answers one (M20b, C10, C24, C48).
      return started && answer.storage !== 'refused' ? { ...answer, asking: options.asides?.(record.providerId) ?? 'none' } : answer;
    },

    stage(sessionId, bytes, name) {
      if (composer === null) return Promise.resolve({ status: 'refused', reason: 'conversations-refused' });
      const record = sessions.record(sessionId);
      if (record !== undefined) live(record);
      return composer.stage(sessionId, bytes, name);
    },

    draft(request) {
      if (composer === null) return { status: 'refused', reason: 'conversations-refused' };
      const record = sessions.record(request.sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      live(record);
      return composer.update(request);
    },

    flushDrafts() {
      composer?.flush();
    },

    async queue(request) {
      const held = options.composer;
      if (held === undefined || composer === null) return { status: 'refused', reason: 'conversations-refused' };
      const { sessionId } = request;
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      const entry = live(record);
      if (store.status().kind !== 'ok') return { status: 'refused', reason: 'conversations-refused' };
      if (request.op === 'reorder') {
        // The entry being sent stays first (C54), and a held Send now stays ahead of what was queued: a move of either is refused.
        const sending = drain.sending(sessionId);
        if (sending !== null && request.ids[0] !== sending) return { status: 'refused', reason: 'sending' };
        if (!heldFirst(sessionId, request.ids, sending)) return { status: 'refused', reason: 'sending' };
        return queueWrite(sessionId, () => { held.store.reorderQueue(sessionId, request.ids); });
      }
      // A message with an image still being kept waits for it (C18).
      await composer.settled(sessionId);
      if (sessions.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      const given = { revision: request.revision, text: request.prompt, intent: request.intent, attachmentIds: request.attachments };
      const answer = queueWrite(sessionId, () => { held.store.enqueue(sessionId, newId(), given, now(), referenceOf(record, entry) !== null); });
      if (answer.status !== 'saved') return answer;
      consumed(sessionId, request.revision);
      count('message queued');
      sessions.noteUserAction(sessionId);
      // The turn ended before the append: the queue goes at once, through the same drain (C48).
      drain.wake(sessionId);
      return answer;
    },

    unqueue(sessionId, entryId) {
      const held = options.composer;
      if (held === undefined) return { status: 'refused', reason: 'conversations-refused' };
      if (sessions.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (drain.sending(sessionId) === entryId) return { status: 'refused', reason: 'sending' };
      let removed = false;
      const answer = queueWrite(sessionId, () => { removed = held.store.unqueue(sessionId, entryId); });
      if (answer.status !== 'saved') return answer;
      return removed ? answer : { status: 'refused', reason: 'unknown-entry' };
    },

    async editQueued(request) {
      const held = options.composer;
      if (held === undefined || composer === null) return { status: 'refused', reason: 'conversations-refused' };
      const { sessionId, entryId } = request;
      if (sessions.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (drain.sending(sessionId) === entryId) return { status: 'refused', reason: 'sending' };
      await composer.settled(sessionId);
      if (drain.sending(sessionId) === entryId) return { status: 'refused', reason: 'sending' };
      const given = { revision: request.revision, text: request.prompt, intent: request.intent, attachmentIds: request.attachments };
      // An entry edited is a Send now no more: the draft that takes its place is queued as typed, behind those still held.
      const holding = drain.held(sessionId);
      const wasHeld = holding.has(entryId);
      drain.unhold(sessionId, entryId);
      const answer = queueWrite(sessionId, () => {
        held.store.editQueued(sessionId, entryId, given, now());
        if (!wasHeld) return;
        const ids = held.store.queue(sessionId).map((queued) => queued.id);
        if (ids.length > 0) held.store.reorderQueue(sessionId, [...ids.filter((id) => holding.has(id)), ...ids.filter((id) => !holding.has(id))]);
      });
      if (answer.status !== 'saved') {
        if (wasHeld) drain.hold(sessionId, entryId);
        return answer;
      }
      // The draft took the entry's input at a revision past the one given: nothing late writes over it (C50, C86).
      consumed(sessionId, request.revision);
      sessions.noteUserAction(sessionId);
      return answer;
    },

    async commands(sessionId) {
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      const entry = live(record);
      const facet = options.facet(refOf(record));
      // fat-g's own first, by the words of what it does in their place (C62); the CLI's rows of their names left out.
      const own: CommandRow[] = (facet?.interceptedCommands ?? []).map((command) => ({ name: command.name.replace(/^\//, ''), description: MENU_WORDS.own[command.kind], hint: null, group: 'fat-g', selector: null }));
      const ownNames = new Set(own.map((row) => row.name));
      const listed = facet === undefined ? null : await listedCommands(record, entry, facet);
      const theirs = (listed ?? []).filter((row) => !ownNames.has(row.name)).map((row): CommandRow => ({ name: row.name, description: row.description, hint: row.hint, group: row.group, selector: row.selector }));
      const rows = [...own, ...theirs].sort((a, b) => COMMAND_GROUPS.indexOf(a.group) - COMMAND_GROUPS.indexOf(b.group));
      // Before any process of the session has run, where the CLI lists its commands only then (C61).
      const note = listed === null && facet?.commandsOnceStarted === true ? MENU_WORDS.notStarted(options.providerName(record.providerId)) : null;
      return { status: 'read', rows, note };
    },

    resumeQueue(sessionId) {
      if (sessions.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (!drain.resume(sessionId)) return { status: 'refused', reason: 'not-paused' };
      sessions.noteUserAction(sessionId);
      return { status: 'saved' };
    },

    page(sessionId, before) {
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      live(record);
      return chat.page(sessionId, before) ?? { status: 'refused', reason: 'unknown-session' };
    },

    readWorker(sessionId, workerId, before) {
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      live(record);
      return chat.readWorker(sessionId, workerId, before) ?? { status: 'refused', reason: 'unknown-session' };
    },

    async send(sessionId, prompt, sending) {
      const given = { prompt, ...(sending?.plan === true ? { plan: true } : {}), ...(sending?.input === undefined ? {} : { input: sending.input }) };
      const sent = await (sending?.now === true ? steerGiven(sessionId, given) : sendGiven(sessionId, given));
      if (sent.status === 'sent') sessions.noteUserAction(sessionId);
      // A prompt as it was typed meets none of a card's refusals.
      return sent.status === 'sent' ? { status: 'accepted' } : sent.status === 'card' ? { status: 'refused', reason: 'storage-failed' } : sent;
    },

    async answer(sessionId, itemId, entries) {
      if (quitting) return { status: 'refused', reason: 'busy' };
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      const entry = live(record);
      const item = chat.interaction(sessionId, itemId);
      const question = item === null ? null : questionOf(item);
      if (question === null) return { status: 'refused', reason: 'unknown-item' };
      if (question.mode === 'async') {
        // A prompt of the session's (C26): through the send's own checks. While its turn runs, sent
        // into that turn where it can take it (M23, C45), the card answered in the message's own
        // transaction; where it cannot, refused as running, as before.
        const sent = sessions.isRunning(sessionId) ? await steerGiven(sessionId, { itemId, entries }) : await sendGiven(sessionId, { itemId, entries });
        if (sent.status === 'sent') sessions.noteUserAction(sessionId);
        if (sent.status === 'refused' && sent.reason === 'not-steerable') return { status: 'refused', reason: 'running' };
        return sent.status === 'sent' ? { status: 'answered' } : sent.status === 'card' ? { status: 'refused', reason: sent.reason } : sent;
      }
      // A blocking card (C13, C31): behind `busy` alone, its process being alive by its request's presence.
      if (sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      const answers = placeAnswers(question.questions.length, entries);
      if (answers === null) return { status: 'refused', reason: 'mismatch' };
      const { handle } = entry;
      if (handle === null) return { status: 'refused', reason: 'not-pending' };
      const answered = requests.answer(sessionId, entry.generation, itemId, answers, answerable(handle));
      if (answered === 'answered') sessions.noteUserAction(sessionId);
      return answered === 'answered' ? { status: 'answered' } : { status: 'refused', reason: answered };
    },

    dismiss(sessionId, itemId) {
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      const entry = live(record);
      const item = chat.interaction(sessionId, itemId);
      const question = item === null ? null : questionOf(item);
      if (question?.mode === 'blocking') {
        // A blocking card's Skip declines its request (M100b, C31, C35): behind `busy` as an answer
        // is, and only through a session that takes a decline, on the process the request came on.
        if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
        const { handle } = entry;
        if (handle?.decline === undefined) return { status: 'refused', reason: 'not-open' };
        const declined = requests.decline(sessionId, entry.generation, itemId, answerable(handle));
        if (declined === 'declined') sessions.noteUserAction(sessionId);
        return declined === 'declined' ? { status: 'dismissed' } : { status: 'refused', reason: declined === 'not-pending' ? 'not-open' : declined };
      }
      const dismissed = chat.dismiss(sessionId, itemId);
      if (dismissed !== 'dismissed') return { status: 'refused', reason: dismissed };
      // A review's or an integration's turn that asked on it ends with no answer (M22e, C49), and so may a plan's operation (decision 0029).
      options.reviews?.()?.dismissed(sessionId, itemId);
      options.workflow?.cardSettled(sessionId, itemId);
      count('question dismissed');
      sessions.noteUserAction(sessionId);
      return { status: 'dismissed' };
    },

    async setMode(sessionId, mode) {
      if (quitting) return { status: 'refused', reason: 'busy' };
      const listed = sessions.record(sessionId);
      if (listed === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (permissions === undefined || permissions.capability(listed.providerId) === null) return { status: 'refused', reason: 'unsupported' };
      // An id is checked against the chat's own provider's list, and never carried from another (C43).
      if (permissions.listed(listed.providerId, mode) === undefined) return { status: 'refused', reason: 'unknown-mode' };
      // The send's own reasons, but the two this change remedies (C89): a chat under either takes it.
      const hold = await sessions.hold(sessionId);
      const first = sessions.record(sessionId);
      if (first === undefined) return { status: 'refused', reason: 'unknown-session' };
      const block = gate.block(first, hold, false);
      if (block !== null) return { status: 'refused', reason: block };
      await live(first).closing;
      const waiting = lives.get(sessionId)?.unconfirmed ?? null;
      if (waiting !== null) {
        const gone = await waiting.recheck().then((result) => result.ok, () => false);
        if (!gone) return { status: 'refused', reason: 'unconfirmed' };
        const again = lives.get(sessionId);
        if (again?.unconfirmed === waiting) again.unconfirmed = null;
      }

      // A plan that is ready takes a change of mode by the user's word, the chat's request on it
      // retired first, its turn ended; its decision stays the chat's (decision 0029).
      const ready = options.workflow?.readyIn(sessionId) ?? null;
      if (ready !== null && requests.plan(sessionId) !== null) await options.workflow?.retireForMode(sessionId);

      // One step, with nothing awaited inside it, up to the change itself.
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      const entry = live(record);
      if (entry.unconfirmed !== null) return { status: 'refused', reason: 'unconfirmed' };
      if (entry.changing) return { status: 'refused', reason: 'changing-mode' };
      const facet = options.facet(refOf(record));
      if (facet === undefined) return { status: 'refused', reason: 'not-connected' };
      if (setupHolds(facet.sandbox?.state())) return { status: 'refused', reason: 'setting-up' };
      // Nor while a plan holds the chat (M22b, C58), but where it is ready (decision 0029).
      if (planPendingOf(sessionId) && (requests.plan(sessionId) !== null || (options.workflow?.readyIn(sessionId) ?? null) === null)) return { status: 'refused', reason: 'plan-pending' };
      // Never with a turn, a worker, a pending request or an aside running (C2).
      if (busy(sessionId, entry) || requests.any(sessionId)) return { status: 'refused', reason: 'running' };
      // The mode asked for, and never the one it replaces (C43, C89).
      if (!permissions.availability(refOf(record), mode).available) return { status: 'refused', reason: 'mode-unavailable' };
      // The chat's own choice already, and confirmed or not yet tried: nothing to change. One a start
      // did not confirm is taken again, which is how its block is lifted for another try.
      if (entry.mode !== null && entry.mode.id === mode && entry.mode.source === 'chat' && !entry.modeUnconfirmed) return { status: 'refused', reason: 'same' };
      const started = referenceOf(record, entry) !== null;
      const { handle } = entry;
      // On the live process where its adapter changes it there, from the mode that process confirmed;
      // every other change is the process closed, and the next start's check (C2, C74, C75).
      const idle = handle !== null && handle.setMode !== undefined && entry.inForce !== null && facet.transition?.(entry.inForce, mode) === 'idle';
      entry.changing = true;
      entryChanged();
      try {
        if (idle) {
          const change = await handle.setMode?.(mode).catch(() => ({ confirmed: false as const, detail: null })) ?? { confirmed: false as const, detail: null };
          if (!change.confirmed) {
            // Nothing is saved (C46): the chat's mode is as it was, and Send is blocked until a change is taken.
            entry.modeUnconfirmed = true;
            count('mode change not confirmed');
            return { status: 'refused', reason: 'not-confirmed', detail: change.detail };
          }
          if (!chat.setMode(sessionId, mode, started)) {
            // The process runs under a mode the chat could not save: it is closed, so that the next start is under the saved one.
            if (entry.handle === handle) closeIdle(sessionId, entry);
            return { status: 'refused', reason: 'storage-failed' };
          }
          entry.mode = { id: mode, source: 'chat' };
          entry.modeRead = true;
          entry.modeUnconfirmed = false;
          if (entry.handle === handle) confirmed(sessionId, entry, record, mode);
          count('mode changed (idle)');
          return { status: 'set' };
        }
        // Saved at once (C75): no choice is saved silently, since the header says it applies at the next prompt.
        if (!chat.setMode(sessionId, mode, started)) return { status: 'refused', reason: 'storage-failed' };
        entry.mode = { id: mode, source: 'chat' };
        entry.modeRead = true;
        entry.modeUnconfirmed = false;
        if (handle !== null && entry.handle === handle) {
          // Its grants end with it (C66, C86), and nothing is launched: the next start opens under the saved mode.
          requests.dropAll(sessionId);
          const result = await handle.close().then((answer) => answer, () => ({ ok: false }));
          onClosed(sessionId, entry, handle, result);
        }
        count('mode changed (restart)');
        return { status: 'set' };
      } finally {
        entry.changing = false;
        entryChanged();
      }
    },

    decide(sessionId, itemId, choice) {
      if (quitting) return { status: 'refused', reason: 'busy' };
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      const entry = live(record);
      const item = chat.interaction(sessionId, itemId);
      if (item === null || approvalOf(item) === null) return { status: 'refused', reason: 'unknown-item' };
      // Behind `busy` and a change alone (C13, C89): its process is alive by its request's presence,
      // and it is decided under the mode in force on that process, whatever blocks a prompt.
      if (sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      if (entry.changing) return { status: 'refused', reason: 'changing-mode' };
      if (setupHolds(options.facet(refOf(record))?.sandbox?.state())) return { status: 'refused', reason: 'setting-up' };
      const { handle, processKey } = entry;
      if (handle === null || processKey === null) return { status: 'refused', reason: 'not-pending' };
      const decided = requests.decide(sessionId, entry.generation, itemId, choice, answerable(handle), processKey);
      if (decided === 'decided') sessions.noteUserAction(sessionId);
      return decided === 'decided' ? { status: 'decided' } : { status: 'refused', reason: decided };
    },

    async decidePlan(sessionId, itemId, decision, text, turnId) {
      const answer = await decidePlanOf(sessionId, itemId, decision, text, turnId);
      if (answer.status === 'decided') sessions.noteUserAction(sessionId);
      return answer;
    },

    async sendComposed(sessionId, composed) {
      const sent = await sendGiven(sessionId, { composed });
      if (sent.status === 'sent') sessions.noteUserAction(sessionId);
      // A composed prompt meets none of a card's refusals.
      return sent.status === 'sent' ? { status: 'accepted' } : sent.status === 'card' ? { status: 'refused', reason: 'storage-failed' } : sent;
    },

    planLine(sessionId) {
      const record = sessions.record(sessionId);
      if (record === undefined) return null;
      live(record);
      const held = requests.plan(sessionId);
      const itemId = held ?? options.plans?.waiting(sessionId)?.itemId ?? null;
      if (itemId === null) return null;
      const item = chat.interaction(sessionId, itemId);
      const body = item === null ? null : planOf(item);
      return item === null || body === null ? null : { itemId, turnId: item.turnId, planId: body.planId, version: body.version, request: held !== null };
    },

    planTurnWords(owner, fresh = false) {
      const ref = refOf(owner as SessionRecord);
      const listed = fresh ? undefined : sessions.record(owner.id);
      const mode = listed === undefined ? permissions?.resolve(owner, null) ?? null : chatModeOf(listed, live(listed));
      const name = options.providerName(owner.providerId);
      const facet = options.facet(ref);
      if (facet === undefined) return blockWords('not-connected', name).text;
      return planTurnBlocked(options.planCapability?.(owner.providerId), mode?.id ?? null, facet.plans?.(), name);
    },

    readingMode(owner) {
      const capability = permissions?.capability(owner.providerId) ?? null;
      const reading = capability === null ? undefined : readingModeOf(capability);
      const ref = { providerId: owner.providerId, instanceId: owner.instanceId };
      if (options.facet(ref) === undefined) return { refused: 'not-connected' };
      if (reading === undefined || permissions === undefined || !permissions.availability(ref, reading.id).available) return { refused: 'mode-unavailable' };
      return { mode: reading.id };
    },

    reviewWaiting(sessionId, waiting) {
      if (sessions.record(sessionId) === undefined) return;
      sessions.apply({ type: 'review-waiting', sessionId, waiting });
      entryChanged();
    },

    doing(sessionId) {
      const running = sessions.runningTurn?.(sessionId) ?? null;
      if (running === null) return 'turn';
      if (running.workersOnly) return 'workers';
      const reviewing = options.reviews?.()?.doing(sessionId, running.turnId) ?? null;
      if (reviewing !== null) return reviewing;
      const planned = plannedIn(sessionId, running.turnId);
      if (planned?.fields?.intent === 'execute') return 'execution';
      if (planned?.fields?.intent === 'revise') return 'revision';
      return planned?.plan === true ? 'plan' : 'turn';
    },

    async bringPlan(sessionId, request) {
      if (quitting) return { status: 'refused', reason: 'busy' };
      if (sessions.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (sessions.isRunning(sessionId)) return { status: 'refused', reason: 'running' };
      // The send's own waits and reasons (C64): a chat that cannot take a prompt takes no plan.
      const hold = await sessions.hold(sessionId);
      const first = sessions.record(sessionId);
      if (first === undefined) return { status: 'refused', reason: 'unknown-session' };
      const block = gate.block(first, hold);
      if (block !== null) return { status: 'refused', reason: block };
      await live(first).closing;
      const waiting = lives.get(sessionId)?.unconfirmed ?? null;
      if (waiting !== null) {
        const gone = await waiting.recheck().then((result) => result.ok, () => false);
        if (!gone) return { status: 'refused', reason: 'unconfirmed' };
        const again = lives.get(sessionId);
        if (again?.unconfirmed === waiting) again.unconfirmed = null;
      }
      // One step, with nothing awaited inside it.
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (sessions.isRunning(sessionId)) return { status: 'refused', reason: 'running' };
      if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      const entry = live(record);
      if (entry.unconfirmed !== null) return { status: 'refused', reason: 'unconfirmed' };
      if (entry.changing) return { status: 'refused', reason: 'changing-mode' };
      const history = chat.history(sessionId);
      if (history === 'not-checked' || history === 'checking') return { status: 'refused', reason: 'history-loading' };
      // A chat takes part in one plan at a time: none it holds, nor one that holds it (decision 0029).
      if (planPendingOf(sessionId, { kind: 'typed', plan: true })) return { status: 'refused', reason: 'plan-pending' };
      const brought = options.plans?.bring(sessionId, request, { turnId: newId(), at: now(), started: referenceOf(record, entry) !== null }) ?? { status: 'refused' as const, reason: 'unknown-plan' as const };
      if (brought.status !== 'brought') return brought;
      // A chat with no name is named after the plan (decision 0029; the maintainer): a
      // `generated` name, as a reviewer's, which a name the user types replaces. Its PLAN READY is the workflow's.
      if (record.name === null) sessions.apply({ type: 'name-reported', sessionId, name: planChatName(brought.title), source: 'generated' });
      entryChanged();
      return { status: 'brought', itemId: brought.itemId };
    },

    planPending: (sessionId) => planPendingOf(sessionId),

    async settlePlans(planIds) {
      if (options.workflow !== undefined) return options.workflow.settleForRemoval(planIds);
      let settled = 0;
      for (const planId of planIds) {
        for (const waiter of options.plans?.waiters(planId) ?? []) {
          // Each written before the next (C73): a live request's through its process, any other's here.
          const decided = await decidePlanOf(waiter.sessionId, waiter.itemId, 'cancel');
          if (decided.status === 'decided') settled += 1;
        }
      }
      return settled;
    },

    retire(sessionId, itemId, outcome) {
      const entry = lives.get(sessionId);
      if (sessions.record(sessionId) === undefined || entry === undefined || entry.handle === null) return false;
      const decided = requests.decidePlan(sessionId, entry.generation, itemId, { kind: 'cancel' }, answerable(entry.handle), outcome);
      entryChanged();
      return decided === 'decided';
    },

    untilIdle(sessionId) {
      if (sessions.record(sessionId) === undefined || !sessions.isRunning(sessionId)) return Promise.resolve();
      return new Promise((resolve) => { idleWaiters.set(sessionId, [...(idleWaiters.get(sessionId) ?? []), resolve]); });
    },

    releasePlan(sessionId) {
      composer?.releasePlan(sessionId);
    },

    planReady(sessionId, waiting, flash) {
      if (sessions.record(sessionId) === undefined) return;
      sessions.apply({ type: 'plan-waiting', sessionId, waiting, ...(flash === false ? { flash } : {}) });
      entryChanged();
    },

    planWait(sessionId, wait) {
      if (sessions.record(sessionId) === undefined) return;
      sessions.apply({ type: 'plan-wait', sessionId, wait });
      entryChanged();
    },

    readsOnly(sessionId) {
      const record = sessions.record(sessionId);
      return record !== undefined && readsOnly(record, live(record));
    },

    chatMode: (record) => chatModeOf(record, lives.get(record.id)),

    modeBlock: (record) => modeBlockOf(record, lives.get(record.id)),

    changingMode: (sessionId) => lives.get(sessionId)?.changing === true,

    quitting: () => quitting,

    processKey: (sessionId) => lives.get(sessionId)?.processKey ?? null,

    stop(sessionId) {
      if (sessions.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
      const entry = lives.get(sessionId);
      if (!sessions.isRunning(sessionId) || entry === undefined || entry.handle === null) return { status: 'refused', reason: 'not-running' };
      // What a plan has brought so far is on the disk before the turn ends (M22b, C59).
      options.plans?.flush();
      entry.handle.stop();
      // The turn takes no message once stopped: a Send now pressed from here on is held for the next prompt.
      noteSendNow(sessionId, entry);
      sessions.noteUserAction(sessionId);
      return { status: 'stopping' };
    },

    async ask(request) {
      const { sessionId, asideId } = request;
      if (quitting) return { status: 'refused', reason: 'busy' };
      const listed = sessions.record(sessionId);
      if (listed === undefined) return { status: 'refused', reason: 'unknown-session' };
      // A provider that answers no aside is never asked one, and no new conversation stands in for it (C24).
      if ((options.asides?.(listed.providerId) ?? 'none') === 'none') return { status: 'refused', reason: 'unsupported' };
      // The same reason as a prompt's, with its folder comparison (C10; M15, C68).
      const hold = await sessions.hold(sessionId);
      const first = sessions.record(sessionId);
      if (first === undefined) return { status: 'refused', reason: 'unknown-session' };
      const block = gate.block(first, hold);
      if (block !== null) return { status: 'refused', reason: block };
      await live(first).closing;
      const waiting = lives.get(sessionId)?.unconfirmed ?? null;
      if (waiting !== null) {
        const gone = await waiting.recheck().then((result) => result.ok, () => false);
        if (!gone) return { status: 'refused', reason: 'unconfirmed' };
        const again = lives.get(sessionId);
        if (again?.unconfirmed === waiting) again.unconfirmed = null;
      }

      // One step, with nothing awaited inside it, as a prompt's acceptance is (M15, C86): the
      // question's record is written in it, before anything is sent (M18, C44).
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      const entry = live(record);
      if (entry.unconfirmed !== null) return { status: 'refused', reason: 'unconfirmed' };
      // Nothing else of a session is taken while its mode changes (M22, C90).
      if (entry.changing) return { status: 'refused', reason: 'changing-mode' };
      // An aside needs a conversation the provider holds (C10): a session with none yet takes no question.
      if (referenceOf(record, entry) === null) return { status: 'refused', reason: 'no-conversation' };
      const folder = gate.folder(record);
      const facet = options.facet(refOf(record));
      if (folder === null) return { status: 'refused', reason: 'folder-not-root' };
      if (facet === undefined) return { status: 'refused', reason: 'not-connected' };
      // Nor while its account's sandbox is set up (M22, C62), nor under a mode that blocks a prompt (C43, C46).
      if (setupHolds(facet.sandbox?.state())) return { status: 'refused', reason: 'setting-up' };
      const modeBlock = modeBlockOf(record, entry);
      if (modeBlock !== null) return { status: 'refused', reason: modeBlock };

      const source: AsideSource | null = 'source' in request ? request.source : null;
      let known: ReturnType<typeof store.aside>;
      try { known = store.aside(asideId); } catch { return { status: 'refused', reason: 'storage-failed' }; }
      if (known !== null && (known.parentId !== sessionId || known.removing)) return { status: 'refused', reason: 'unknown-aside' };
      if (source !== null) {
        // Explain this on an aside that exists reopens it: its first question is asked once.
        if (known !== null) return { status: 'accepted', asideId };
        // The same selection again reopens its aside, and starts no second (C50): nothing is sent.
        const same = chat.findAside(sessionId, source);
        if (same !== null) { count('ask answered (the same selection)'); return { status: 'accepted', asideId: same }; }
      }
      if (entry.asides.has(asideId)) return { status: 'refused', reason: 'aside-running' };

      // The question fat-g sends always carries the excerpt, and says where it came from (C8, C51) —
      // a finding's in fat-g's words for it (M22e, C34).
      const text = 'text' in request ? request.text : 'question' in request ? request.question : seedQuestion(sourcePhrase(request.source, request.source.path === null ? null : pathFrom(folder, request.source.path)), request.source.excerpt);
      chat.ensureAside(asideId, sessionId);
      // What the aside's earlier questions got, before this one is recorded (C13, C22).
      const history = known === null ? [] : chat.exchanges(asideId);
      const turnId = newId();
      const messageId = newId();
      const accepted = chat.accept(asideId, {
        turnId, itemId: messageId, speed: speedOf(record), text, at: now(), started: false,
        ...(known === null ? { aside: { parentId: sessionId, source, title: asideTitle(source, text) } } : {}),
      });
      if (!accepted) return { status: 'refused', reason: 'storage-failed' };
      timers.clear(entry.idleTimer);
      entry.idleTimer = undefined;
      entry.asides.set(asideId, { turnId, acceptedAt: monotonic() });
      entry.busy = true;
      // The session's read lists a new aside, and one whose turn now runs (C30).
      chat.changed(sessionId);
      let throughTurn: string | null = null;
      try { throughTurn = store.lastReportedTurn(sessionId); } catch { /* the side thread then holds nothing of the session's turns, and the excerpt is all it has (C69) */ }
      watch(facet);
      const handle = entry.handle ?? open(record, entry, facet, folder);
      if (handle.ask === undefined) {
        // Its descriptor says it answers asides, and its session does not: nothing is sent.
        endAside(sessionId, entry, asideId, null, 'failed');
        settle(sessionId, entry);
        return { status: 'refused', reason: 'unsupported' };
      }
      count(source === null ? 'ask accepted (question)' : `ask accepted (${source.kind})`);
      noteModelUse(record);
      handle.ask({ asideId, turnId, text, messageId, history, throughTurn, effort: record.effort, speed: record.speed });
      sessions.noteUserAction(sessionId);
      return { status: 'accepted', asideId };
    },

    readAside(sessionId, asideId, before) {
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      live(record);
      return chat.readAside(sessionId, asideId, before) ?? { status: 'refused', reason: 'unknown-session' };
    },

    stopAside(sessionId, asideId) {
      if (sessions.record(sessionId) === undefined) return { status: 'refused', reason: 'unknown-session' };
      const entry = lives.get(sessionId);
      if (entry === undefined || entry.handle === null || !entry.asides.has(asideId)) return { status: 'refused', reason: 'not-running' };
      // The aside's own Stop: never the session's interrupt, and never its process (C12, C70).
      entry.handle.stopAside?.(asideId);
      sessions.noteUserAction(sessionId);
      return { status: 'stopping' };
    },

    removeAside(sessionId, asideId) {
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      if (store.status().kind !== 'ok') return { status: 'refused', reason: 'conversations-refused' };
      let known: ReturnType<typeof store.aside>;
      try { known = store.aside(asideId); } catch { return { status: 'refused', reason: 'storage-failed' }; }
      if (known === null || known.parentId !== sessionId) return { status: 'refused', reason: 'unknown-aside' };
      if (quitting || sessions.isLeaving(sessionId) || removal.pending(sessionId)) return { status: 'refused', reason: 'busy' };
      const entry = live(record);
      // A turn of it that runs is stopped first (C42), and ended here: what still comes of it finds no aside.
      if (entry.asides.has(asideId)) {
        entry.handle?.stopAside?.(asideId);
        endAside(sessionId, entry, asideId, null, 'stopped');
      }
      try {
        // Its rows, whole, and the log emptied after them, as a session's removal leaves nothing (M18, C62).
        removal.detached([asideId]);
      } catch {
        count('aside not removed (storage)');
        return { status: 'refused', reason: 'storage-failed' };
      }
      chat.drop(asideId);
      chat.changed(sessionId);
      count('aside removed');
      settle(sessionId, entry);
      return { status: 'removed' };
    },

    loadHistory(sessionId) {
      const record = sessions.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      live(record);
      const outcome = check(sessionId);
      if (outcome === 'unsupported') return { status: 'refused', reason: 'unsupported' };
      if (outcome === 'blocked') {
        const block = gate.block(record, sessions.holdNow(sessionId));
        if (block !== null) return { status: 'refused', reason: block };
      }
      return { status: outcome === 'waiting' ? 'waiting' : 'loading' };
    },

    requests,

    kept: (sessionId) => lives.get(sessionId)?.kept ?? undefined,

    runningOn: (ref) => [...lives].some(([id, entry]) => {
      if (entry.handle === null || !busy(id, entry)) return false;
      const record = sessions.record(id);
      return record !== undefined && sameInstance({ providerId: record.providerId, instanceId: record.instanceId }, ref);
    }),

    referenceUnsaved(sessionId) {
      const record = sessions.record(sessionId);
      const entry = lives.get(sessionId);
      if (record === undefined || entry === undefined || entry.unsavedSaid) return;
      // Said once a run: the session's entry could not be saved, and the conversation goes on (M18, C46).
      entry.unsavedSaid = true;
      chat.add(sessionId, null, noticeItem('session-unsaved', record.providerId));
    },

    selectionChanged,

    reconcile: reconcileListed,

    stopAll(waitMs = QUIT_STOP_MS) {
      quitting = true;
      options.secretary?.dispose();
      for (const [id, entry] of lives) {
        // An aborted check marks nothing: the next one lists the same turns again (M18, C61).
        entry.historyRead?.abort();
        // What still waits for an answer is dropped before the Stop (M21, C67): a quit drops, and its Stop's end withdraws nothing.
        requests.dropAll(id);
        // A turn still starting is cancelled; the process of a session whose workers alone run is ended.
        if (entry.handle !== null && sessions.isRunning(id)) entry.handle.stop();
        // Each aside that runs is stopped by its own Stop (M20b, C34): one that ends in time keeps its provider's end.
        if (entry.handle !== null) for (const asideId of entry.asides.keys()) entry.handle.stopAside?.(asideId);
      }
      // What was received of each message still being written is on disk before anything is waited
      // for (M19, C19): a turn that ends in time leaves it as any end does, and one that does not is
      // written stopped with its text already there. And of each plan being written (M22b, C59).
      chat.saveOpen();
      options.plans?.flush();
      // And every draft main took and has not written (M23, C31).
      composer?.flush();
      /** An aside's turn that is still open ends as stopped, as the session service ends a session's (M18, C45; M20b, C34). */
      const stopAsides = (): void => { for (const [id, entry] of lives) endAsides(id, entry, 'stopped'); };
      if (!anyRunning()) { stopAsides(); return Promise.resolve(); }
      return new Promise((resolve) => {
        // And again once the wait is over, with what arrived meanwhile, before the ends are written.
        const done = (): void => { chat.saveOpen(); options.plans?.flush(); stopAsides(); resolve(); };
        const timer = timers.set(() => { quitWaiter = null; done(); }, waitMs);
        quitWaiter = () => { timers.clear(timer); done(); };
      });
    },

    dispose() {
      stopFollowing();
      composer?.dispose();
      chat.dispose();
      options.secretary?.dispose();
      for (const entry of lives.values()) {
        entry.historyRead?.abort();
        timers.clear(entry.idleTimer);
        entry.detach?.();
      }
    },
  };
}
