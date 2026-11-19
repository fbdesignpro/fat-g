// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One Claude chat session (decisions 0020, 0027; docs/planning/_archive/M16.md, Design 4; C10, C18, C21–C23,
// C25–C30, C62, C64, C68, C69, C83, C86–C90): a conversation on a process of its own, behind the
// session facet. Nothing is launched until the first prompt. Every outcome is an event; nothing is
// sent twice, and no process is started again by itself.
//
//   unopened ─► launching ─► open ─► [effort] ─► [speed] ─► prompt written ─► started ─► init ─► turn ─► open …
//                spawn        initialize                     user frame        lifecycle   checked
//                             reply, check 1                                   frame       check 2
//
// Whenever the process ends, by itself or because this module ended it, the session is over:
// `closed` resolves with whether its tree is confirmed gone, and the next prompt is another
// session's, which resumes the conversation in a new process — where a model had answered in it
// (C87). A session with no answer has no reference, and its next prompt starts anew.
//
// Whose end a turn's end is (C76; M18, C59). The CLI's own — a `result`, or the closing frame that
// stands in for a lost one — is reported. Every end this module makes itself is not: a start
// cancelled or failed, either check, a Stop not confirmed, the process gone, a close. Claude has no
// history to read back, so what an end says here is what the saved chat keeps.
//
// The line between a failed start and a lost turn is the prompt's write (C29): before it, a process
// that ends is a failed start, with its step; after it, the turn ended with the process.
//
// A question beside the conversation (decision 0025; docs/planning/_archive/M20b.md, Design 3; C12–C18, C70).
// An aside's question is a `side_question` control request on this same process, with the aside's
// earlier exchanges, and its reply is the whole answer. It is no turn of the session's: it is sent
// while a turn runs or while none does, any number at once, each matched by its request's id, and
// its frames never reach the mapper, so the turn's bounds stay the prompt's own frames (C17).
//
//   ask ─► [launch, if no process] ─► side_question ─► started ─► reply ─► one message, the end
//                                      by request id     progress   whole answer, or none
//
// Its Stop takes the request back and nothing else: the CLI answers a cancel at once with an error,
// which is that aside's end (C15). A Stop the CLI does not answer ends the aside here, and the
// process is left as it is, since the session's turns and its other asides run on it (C70). So is
// a question that has no reply in ten minutes (C16). The process ending ends every open aside.
//
// A question the model asks the user (decision 0026; docs/planning/_archive/M21.md, Design 3; C11, C14,
// C17–C22, C59, C60, C65, C67, C70, C75). The CLI asks to use its question tool and holds its
// turn, or its worker, for the reply. The request is held here as it came, under its owner, and
// said as an event; the answer main hands back is encoded from that request and written as the one
// `allow` the wire has.
//
//   request ─► not placeable, or more than a card draws whole ─► denied on the wire, the notice, no event
//           ─► an id already held ─► counted; the same reply when the first's comes
//           ─► held, then `question-raised`
//
//   held ── answer ──────────────────► the `allow` written ─► its tool result: `confirmed`
//                                       the line refused, or the process gone: `dropped`, and the
//                                       process is ended
//        ── answer with none ────────► denied on the wire, with the notice: main could not place it
//        ── the CLI takes it back ───► `withdrawn` — or nothing after a Stop, whose own cancel it is
//        ── its owner's end ─────────► let go, no event: the turn's end for the session's own, the
//                                       worker's for a worker's, which outlives the turn it began in
//        ── the process's end ───────► `dropped` for each still unanswered, before any end made for
//                                       the loss; an answered one is let go
//
// An owner's end says nothing of a hold because main's registry sweeps at that end, and settles the
// card as withdrawn by its turn. A loss is said first, so that no end made for it withdraws what the
// loss dropped. An answer is final once its line went: only a line the process did not take is
// dropped, whatever became of the process meanwhile.
//
// The session's mode (decision 0027; docs/planning/_archive/M22.md, Design 3, 6; C2, C5, C7, C45, C46, C74,
// C90). The process is launched under the mode its start names, and what the CLI reports is held to
// that mode at three places: the reply to the launch, before any prompt; each turn's `init`; and a
// status frame that names a mode. A change between the three modes the CLI changes on a live
// process is one request, sent with nothing running, and confirmed by its reply:
//
//   setMode ─► the target recorded ─► the request ─► its reply names the target: the mode in force
//                                                   ─► anything else: not confirmed, the mode as it was
//
//   a status frame   names the mode in force, or the target while a change waits: the change
//                    reported — it can come beside the reply, or before it is read (C90)
//                    names any other word: a policy fat-g did not ask for, and the process is ended
//
// Every other change is main's to make, by closing this session and starting another.
//
// A request to act (docs/planning/_archive/M22.md, Design 4–6; C6, C8, C9, C11–C13, C21, C68, C69, C76, C91).
// Under the reading mode every one is denied, as before there were modes. Under any other the
// request is held as a question is, under its owner, and said as an event with its card's view; the
// decision main hands back is encoded from the request as it came.
//
//   request ─► not placeable, a field its action stands on missing, or more than a card shows
//              whole ─► denied on the wire, the notice — naming the size, where that is why — no event
//           ─► an id already held, the same request ─► counted; the same reply when the first's comes
//           ─► an id already held, another request ─► denied on the wire, the hold let go: `changed`
//           ─► held, then `approval-raised`
//
//   held ── approve ─────────────────► `allow` with the input as it came ─► its tool result: `confirmed`
//        ── approve for the session ─► the same, with the CLI's own rule at the session's scope
//        ── deny ────────────────────► `deny` in the user's name ─► its result: `confirmed`, and the
//                                       action's activity ends declined
//        ── decide with none ────────► denied on the wire, with the notice: main could not place it
//        ── taken back, its owner's end, the process's end: as a question's
//        ── a close of the session ──► `dropped` for each still undecided, before the ends the close
//                                       makes: the process goes with it, and that is no withdrawal
//
// The hold path is one for both kinds, so a question delivered again with another payload is
// refused the same way (C91).
//
// A plan turn (decision 0029; docs/planning/_archive/M22b.md, Design 4; C7–C12, C51, C61, C70, C77). A prompt
// sent as one is preceded by the CLI's own plan mode, set on the live process and confirmed; the model
// writes its plan file — in the CLI's configuration folder, which fat-g never reads — and asks for the
// user's decision with the plan's tool, whose request carries the plan's text:
//
//   plan turn ─► set the plan word ─► its reply names it ─► the prompt ─► … ─► the plan's request
//   request ─► outside a plan turn, or after its Execute ─► refused as any unknown request
//           ─► no plan in it ─► denied in fat-g's words, with the notice, no event
//           ─► held, then `plan-raised`
//   held ── feedback ─► `deny` with the user's words ─► the model revises: the next request
//        ── Execute ──► the chat's mode armed, then `allow` as it came ─► the CLI's status frame
//                       names the chat's mode, which is in force from then: the turn goes on under it
//        ── Cancel ───► `deny` with fat-g's words and `interrupt`: the turn ends, read as stopped
//
// At the turn's end a process still in plan mode — after a Cancel, a Stop, or a plan never decided —
// is set back to the chat's mode by the same change, before the end is said, so the next prompt
// waits for it; only out of plan mode may it name the process's own launch word. A reply that names
// another word is a policy fat-g did not ask for, and the process is ended.
//
// A line over the limit (docs/planning/_archive/M22.md, Design 8; C67, C71). Nothing of it is read but what
// its first bytes say: whether it is a request, and its id. A request with an id is denied by that
// id, with a notice naming the line's size, and the turn goes on. One that is or may be a request
// and names no id cannot be answered, so everything that would wait on it is stopped — the turn and
// its workers by the session's Stop, each aside by its own — with a notice. Any other line is
// skipped and counted.
//
// How full the context window is (decision 0033). At a turn's start while no reading is held, and
// after each turn the CLI ended, the CLI is asked — `get_context_usage`, its summary detail — and
// nothing waits on the reply; between two replies, the usage of each call of the session's own is
// the count. A process launched for an aside alone is never asked; one that refused is not asked
// again. A reading is said only where it changed, and goes to the summary alone.
import { type AgentEvent, cutTo, MAX_NOTICE_DETAIL, type StartStep, type TurnFailure } from '@shared/contracts/agent-events';
import { type ContextCalls, type ContextReading, sameContext } from '@shared/contracts/sessions';
import type { SteerState } from '@shared/contracts/composer';
import { type ApprovalChoice, type ApprovalOverBound, ApprovalRequestSchema, boundQuestions, canShow, type GivenAnswer, type RawQuestion } from '@shared/contracts/interaction';
import type { ProviderContext } from '@shared/provider-kit/context';
import { FRAME_DROP_REASONS, type FrameDropReason } from '@shared/provider-kit/logger';
import type { PeekedLine } from '@shared/provider-kit/ndjson';
import { type CleanupResult, type Executable, ProcessFailure } from '@shared/provider-kit/process';
import type { AsideRequest, ModeChange, PlanAnswer, ProviderCommand, ProviderSession, SessionStart, SteerOutcome, SteerRequest, TurnRequest } from '@shared/provider-kit/sessions';
import { type ActionRequest, frameKind, MCP_TOOL_PREFIX, type PlanRequest, type QuestionRequest, type RequestPayload, samePayload, takeCancel, type TakenRequest, takeModeReply, takeProgress, takeReply, takeRequest, takeCommands, takeInterruptReply, takeSideReply, takeStatus, TOOL_REQUEST } from './chat-frames';
import { chatArguments, type ChatConnection, ChatLaunchFailure, type ChatTimers, type ChatTimings, launchChat, REAL_TIMERS } from './chat-launch';
import { approvalDecided, approvalReleased, beginChatTurn, type ChatMapperTurn, endFailure, expireWaitingFrames, failChatWorkers, heldMessages, mapChatFrame, MAX_STEERED, newChatMapper, placeApproval, type PlacedRequest, placePlan, placeQuestion, planDecided, planReleased, questionAnswered, questionReleased, steerChatMessage } from './chat-mapper';
import { claudeMode, type ClaudeMode, claudeTransition, PLAN_MODES, PLAN_TOOL, PLAN_WORD, planVariant, reportsMode } from './chat-modes';
import { approvalView } from './chat-tools';
import { type ActionInput, CHAT_WIRE_LIMITS, type ChatAnswer, readOffer, type SessionGrant } from './chat-wire';
import { FAST_TIER } from './models';
import { overageReason, servedSpeed } from './chat-speed';
import { takeAssistantUsage, takeContextReply } from './chat-context';

export interface ChatSessionOptions {
  readonly context: ProviderContext;
  /** The executable the instance's detection found, or undefined before it has. */
  readonly executable: () => Executable | undefined;
  /** Test and smoke launch prefix, as the usage session takes it. */
  readonly argsPrefix: readonly string[];
  readonly timings: ChatTimings;
  readonly start: SessionStart;
  /** A conversation to resume, or null for a session not yet started. */
  readonly reference: string | null;
  readonly timers?: ChatTimers;
}

/** Counts and kinds only (C55): what was dropped, by reason, what was not read, and what was refused, by subtype. */
export interface ChatSessionCounts {
  readonly dropped: Record<FrameDropReason, number>;
  /** Frames of kinds the adapter does not read: never parsed (C32). */
  unread: number;
  /** Requests of the CLI's, each refused, under a subtype of the closed list or `other` (C22). */
  readonly refused: Record<string, number>;
  /** Times the CLI said it was trying a side question again (M20b, C14). */
  retried: number;
  /**
   * Questions (M21), by what happened and never by anything asked: a request delivered again under
   * an id already held (C11); an answer, or a refusal, of main's that named a request no longer
   * held; and a tool result that carried the error flag after an answer (C19).
   */
  readonly questions: { repeated: number; unheld: number; failed: number };
  /**
   * Requests to act (M22), by what happened and never by anything asked: one delivered again, the
   * same, under an id already held (C11); and a decision, or a refusal, of main's that named a
   * request no longer held.
   */
  readonly approvals: { repeated: number; unheld: number };
  /** Plans handed over (M22b), by what happened: one delivered again, the same, under an id already held; and a decision of main's that named a request no longer held. */
  readonly plans: { repeated: number; unheld: number };
  /** Requests of either kind delivered again under an id already held with another payload, each refused (M22, C91). */
  changed: number;
  /** Status frames that named the mode in force, or the target of a change that waited (M22, C90). */
  modesReported: number;
  /** Context readings (decision 0033): requests written, replies read, and those refused, late, lost or unreadable. */
  readonly context: { asked: number; read: number; failed: number };
}

/** What a request over the line limit is counted under, among the refused (M22, C67): never a name the CLI chose. */
export const OVERSIZED_REQUEST = 'oversized-request';

export interface ClaudeChatSession extends ProviderSession {
  readonly counts: ChatSessionCounts;
  /** Always there: Claude's sessions take a question as a request, as the descriptor's `questions` says (M21, C30). */
  answer(requestId: string, answers: readonly GivenAnswer[] | null): void;
  /** Always there: Claude's descriptor says `declines` (M100b, C31, C33). */
  decline(requestId: string): void;
  /** Always there: Claude's descriptor declares modes that act (M22, C13). Under the reading mode no request is ever raised, so none is decided. */
  decide(requestId: string, choice: ApprovalChoice | null): Promise<boolean>;
  /** Always there: three of Claude's modes change on a live process (M22, C5). */
  setMode(mode: string): Promise<ModeChange>;
  /** Always there: Claude's descriptor declares plan turns, whose plans its requests hold (M22b, C10, C11). */
  decidePlan(requestId: string, answer: PlanAnswer | null): Promise<boolean>;
  /** Always there (M23, C36, C43, C88): a message written while a turn runs, where a Stop can drop it. */
  steerState(): SteerState;
  steer(request: SteerRequest): Promise<SteerOutcome>;
  /** Always there (M23, C60, C61): what this process's CLI lists of its commands, null until it has said. */
  commands(): readonly ProviderCommand[] | null;
}

interface Turn {
  readonly request: TurnRequest;
  /** Cancels the start, while the prompt has not been written (C28). */
  readonly abort: AbortController;
  /** A Stop was pressed. */
  stop: boolean;
  /** The prompt was handed to the process: from here on the CLI may have it (C29). */
  written: boolean;
  /** The turn as the mapper holds it, from the prompt's write. */
  mapped: ChatMapperTurn | null;
  /**
   * A plan turn's course (M22b, C7, C8): `planning` once plan mode is confirmed, `executed` once its
   * Execute's `allow` is written — after which it plans no longer. `none` for a turn that is no plan turn.
   */
  plan: 'none' | 'planning' | 'executed';
  startedTimer: unknown;
  stopTimer: unknown;
  running: Promise<void>;
}

/** One question of an aside, from its ask to its one end (M20b, C13). */
interface Aside {
  readonly request: AsideRequest;
  /** The id its request was sent as: what its reply, its progress and its cancel name. Null until it is written. */
  requestId: string | null;
  /** Its turn's start has been said. */
  started: boolean;
  /** Its Stop was pressed. */
  stopped: boolean;
  /** Its end has been said: nothing more of it is. */
  done: boolean;
  stopTimer: unknown;
  /** Gives the wait up, so a reply that still comes finds no one waiting (C15, C16). */
  readonly abort: AbortController;
}

/** How a request of the CLI's is answered, on the line it came on: the promise is the write's (M21, C66). */
type Reply = (what: ChatAnswer) => Promise<boolean>;

/**
 * A request the CLI holds its owner for (M21, C59, C65; M22, C8, C91): the request as it came, in
 * memory alone, from the event that raises it until its answer is confirmed, the CLI takes it back,
 * main refuses it, it comes again as another, or its owner or its process ends.
 */
interface HoldBase {
  readonly requestId: string;
  /** The tool use the request names: where the card stands, and what the result names. */
  readonly toolUseId: string;
  /** The request's tool, input, tool use and worker, as they came (M22, C91): what a delivery under the same id is compared with. */
  readonly payload: RequestPayload | null;
  /** Whose it is (C65): the turn every event of it names, and its worker where it is one's. */
  readonly owner: PlacedRequest;
  readonly reply: Reply;
  /** How often it was delivered again while it waited (C11): each delivery gets the same reply. */
  repeats: number;
  /** The reply fat-g wrote for it, once it has: an answered hold, which a loss lets go with no word (C70). */
  sent: ChatAnswer | null;
}

/** A question the model asked the user (M21). */
interface QuestionHold extends HoldBase {
  readonly kind: 'question';
  /** The tool's own name, as the request gave it: what its `allow` is typed to. */
  readonly tool: QuestionRequest['tool'];
  /** The request's `input` and its questions, as they came: what an answer is encoded from, never the texts cut for the card (C59). */
  readonly input: QuestionRequest['input'];
  readonly questions: readonly RawQuestion[];
}

/** A request to act (M22, C8, C13). */
interface ApprovalHold extends HoldBase {
  readonly kind: 'approval';
  /** The tool the request named. */
  readonly tool: string;
  /** The request's `input`, as it came: what an `allow` sends back, never the view made for the card. */
  readonly input: ActionInput;
  /** The CLI's own rule for the session, where the request offered one (C68): what Approve for this session sends, and null where the card offers no such choice. */
  readonly grant: SessionGrant | null;
}

/** A plan handed over for the user's decision (M22b, C10, C11). */
interface PlanHold extends HoldBase {
  readonly kind: 'plan';
  /** The request's `input`, as it came: what Execute's `allow` sends back unchanged. */
  readonly input: ActionInput;
}

type Hold = QuestionHold | ApprovalHold | PlanHold;

/** What became of a held request, as its kind's event (M21, C20; M22, C8, C91). */
const resolved = (hold: Hold, reason: 'withdrawn' | 'dropped' | 'changed'): AgentEvent => ({ type: hold.kind === 'question' ? 'question-resolved' : hold.kind === 'plan' ? 'plan-resolved' : 'approval-resolved', requestId: hold.requestId, reason });

/**
 * The answers as the CLI takes them (M21, C17, C18, C59): each question's whole text to one string
 * — each chosen option's whole label, by its place, then the typed text, joined by a comma and a
 * space. Null for answers that are not one for each question, or that choose an option the request
 * does not hold: nothing is guessed.
 */
function encodeAnswers(questions: readonly RawQuestion[], answers: readonly GivenAnswer[]): Record<string, string> | null {
  if (answers.length !== questions.length) return null;
  const entries: [string, string][] = [];
  for (const [index, question] of questions.entries()) {
    const answer = answers[index];
    if (answer === undefined) return null;
    const parts: string[] = [];
    for (const place of answer.options) {
      const option = question.options[place];
      if (option === undefined) return null;
      parts.push(option.label);
    }
    if (answer.text !== null && answer.text !== '') parts.push(answer.text);
    entries.push([question.text, parts.join(', ')]);
  }
  // A key of its own whatever a question's text is.
  return Object.fromEntries(entries);
}

/** Whose launch it is, for the one notice a launch may bring: a turn of the session's, or an aside's. */
interface LaunchOwner { readonly turnId: string; readonly asideId?: string }

type StartFailureKind = 'start-failed' | 'not-read-only' | 'policy-mismatch' | 'session-not-reopened';

/**
 * A start that failed after the prompt was accepted (M15, C87): its step, and what the chat is told.
 * `detail`: for a start that reported another policy than the mode's (M22, C46), the word it reported.
 */
class StartFailure extends Error {
  constructor(readonly step: StartStep, readonly kind: StartFailureKind = 'start-failed', readonly detail: string | null = null) { super(kind); }
}

/** A word of the CLI's, as a notice's detail carries it. */
const detailOf = (word: string | null): { detail?: string } => (word === null ? {} : { detail: cutTo(word, MAX_NOTICE_DETAIL).text });

/** The notice a failed start brings (M15, C87; M22, C46): its step where the start itself failed, and what the CLI reported where that was another policy. */
function startNotice(failure: StartFailure, owner: LaunchOwner): AgentEvent {
  return { type: 'notice', kind: failure.kind, turnId: owner.turnId, ...(owner.asideId === undefined ? {} : { asideId: owner.asideId }), ...(failure.kind === 'start-failed' ? { step: failure.step } : {}), ...(failure.kind === 'policy-mismatch' ? detailOf(failure.detail) : {}) };
}

export function createClaudeChatSession(options: ChatSessionOptions): ClaudeChatSession {
  const { context, timings } = options;
  const timers = options.timers ?? REAL_TIMERS;
  const listeners = new Set<(event: AgentEvent) => void>();
  const counts: ChatSessionCounts = { dropped: Object.fromEntries(FRAME_DROP_REASONS.map((reason) => [reason, 0])) as Record<FrameDropReason, number>, unread: 0, refused: {}, retried: 0, questions: { repeated: 0, unheld: 0, failed: 0 }, approvals: { repeated: 0, unheld: 0 }, plans: { repeated: 0, unheld: 0 }, changed: 0, modesReported: 0, context: { asked: 0, read: 0, failed: 0 } };
  /** The mode the process runs under (M22, C5): the start's, then what a confirmed change made it. A start that names none runs under the reading mode. */
  let inForce: ClaudeMode = claudeMode(options.start.mode);
  /**
   * A change of mode that waits for its reply (M22, C90): its target, and whether a status frame has
   * named it meanwhile. `commit` (M22b, C7): the change has no reply — Execute's — and the frame that
   * names its target puts it in force.
   */
  let pending: { readonly to: ClaudeMode; named: boolean; readonly commit?: boolean } | null = null;
  /** The chat's mode on this process (M22b, C7): the start's, then a confirmed change's, and never the plan mode a turn runs under. */
  let chatMode: ClaudeMode = inForce;
  /** A plan turn's mode, being set back at its end (M22b, C7): the next prompt waits for it. */
  let restoring: Promise<void> | null = null;
  // A resumed session's record holds its reference already: none is reported again (C87).
  const mapper = newChatMapper(options.start.folder, options.reference !== null, inForce);

  let connection: ChatConnection | null = null;
  /** The one launch of this session's process, whoever asked for it first: a turn, or an aside (M20b, C10). */
  let launching: Promise<ChatConnection> | null = null;
  /** Cancels a launch an aside asked for, when the session is closed. A Stop of an aside's never cancels it (C70). */
  const closing = new AbortController();
  /** The asides whose question waits for its reply, by aside and by the request each was sent as (M20b, C13, C17). */
  const asides = new Map<string, Aside>();
  const asideRequests = new Map<string, Aside>();
  /** The requests the CLI waits on, each as it came, by its request's id (M21, C59, C65; M22, C8): questions and requests to act, on one path. */
  const holds = new Map<string, Hold>();
  /** The effort this process runs with: the launch's, then what the last change set (C27). */
  let effort = options.start.effort;
  /**
   * Whether this process runs in Claude's fast mode (decision 0020): off at its launch, then what the
   * last change set. A `fastMode` in the user's own settings does not turn it on: under fat-g's client
   * the CLI serves fast mode only where its flag settings ask for it (`sdk_opt_in_required` otherwise;
   * models research §6), which fat-g alone sends. A turn that asks for another speed says so first.
   */
  let fast = false;
  /** Why extra usage was refused, as the process's last rate-limit frame said; null where it was not. */
  let refusedOverage: string | null = null;
  let current: Turn | null = null;
  /** The last steer state a `steer-changed` event said, or the one the process starts with. */
  let steerSaid: SteerState = 'wait';
  /** What this process's CLI listed of its commands (M23, C60): its `initialize` reply's, then a push's, which replaces it. Null until it said. */
  let commandList: ProviderCommand[] | null = null;
  let refusedNoticed = false;
  /**
   * The context reading (decision 0033): the last one said, null until there is one. A request for
   * it is in flight; a turn ended meanwhile, and it is asked once more after; the CLI refused it, and
   * this process is asked no more. `counted`: the last count an assistant frame of the session's own
   * gave, and whether it came after the request in flight was written — it is then newer than the reply's.
   */
  let reading: ContextReading | null = null;
  const contextAsk = { inFlight: false, again: false, refused: false };
  let counted: { readonly used: number; readonly call: ContextCalls; afterAsk: boolean } | null = null;
  let over = false;
  let ending: Promise<CleanupResult> | null = null;
  /** The clocks of the workers' frames held for their pairing, by the tool use each names (M20a, C22). */
  const pairTimers = new Map<string, unknown>();
  /** A launch that failed has closed its own process: this is what became of that tree. */
  let launchCleanup: CleanupResult = { ok: true };
  let launchRecheck: (() => Promise<CleanupResult>) | null = null;
  let resolveClosed: (result: CleanupResult) => void = () => undefined;
  const closed = new Promise<CleanupResult>((resolve) => { resolveClosed = resolve; });

  /** The holds an owner's end takes with it (M21, C65). No event says so: main's registry sweeps at that end, and settles the cards. */
  function letGo(owned: (hold: Hold) => boolean): void {
    for (const hold of [...holds.values()]) if (owned(hold)) holds.delete(hold.requestId);
  }

  /** A held request is over with no answer of the user's: the mapper is told, so that its tool result says nothing of it. */
  function release(hold: Hold): void {
    if (hold.kind === 'question') questionReleased(mapper, hold.owner, hold.toolUseId);
    else if (hold.kind === 'plan') planReleased(mapper, hold.toolUseId);
    else approvalReleased(mapper, hold.owner, hold.toolUseId);
  }

  function emit(event: AgentEvent): void {
    // A hold goes with its owner, whichever of this module's ends says so (M21, C65): the session's
    // own at its turn's end, a worker's at the worker's — which a completed turn does not end.
    if (event.type === 'worker-ended') letGo((hold) => hold.owner.workerId === event.workerId);
    else if (event.type === 'turn-ended' && event.asideId === undefined) letGo((hold) => hold.owner.workerId === null && hold.owner.turnId === event.turnId);
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* a listener's failure is its own */ }
    }
  }
  const emitAll = (events: readonly AgentEvent[]): void => { for (const event of events) emit(event); };

  function drop(reason: FrameDropReason): void {
    counts.dropped[reason] += 1;
    context.logger.record({ type: 'frame-dropped', reason });
  }

  function clearTurnTimers(turn: Turn): void {
    timers.clear(turn.startedTimer); turn.startedTimer = undefined;
    timers.clear(turn.stopTimer); turn.stopTimer = undefined;
  }

  /**
   * The turn's one end. `before` goes out first: the workers that end with it, and its notice.
   * `reported` is whose end it is (C76): true for one the CLI gave, false for one made here.
   */
  function finish(turn: Turn, before: readonly AgentEvent[], outcome: 'completed' | 'interrupted' | 'failed', reported: boolean, failure?: TurnFailure, answerItemId: string | null = null): boolean {
    if (current !== turn) return false;
    current = null;
    clearTurnTimers(turn);
    if (turn.mapped !== null) { turn.mapped.ended = true; turn.mapped.actions.clear(); }
    emitAll(before);
    emit({ type: 'turn-ended', turnId: turn.request.turnId, outcome, reported, ...(failure === undefined ? {} : { failure }), ...(answerItemId === null ? {} : { answerItemId }) });
    return true;
  }

  /** Every open worker ended as failed (M15, C90). */
  const endWorkers = (): AgentEvent[] => failChatWorkers(mapper);

  function clearPairTimers(): void {
    for (const handle of pairTimers.values()) timers.clear(handle);
    pairTimers.clear();
  }

  /** Ends the session's process. The session is over: `closed` resolves once the tree has been looked at. */
  function endProcess(): Promise<CleanupResult> {
    ending ??= (async () => {
      over = true;
      clearPairTimers();
      const result = connection === null ? launchCleanup : await connection.close();
      resolveClosed(result);
      return result;
    })();
    return ending;
  }

  /** A start that failed: nothing more is sent, and the process is closed (C28; M15, C87). An end of the session's own. */
  function failStart(turn: Turn, failure: StartFailure): void {
    const { turnId } = turn.request;
    if (turn.stop) finish(turn, endWorkers(), 'interrupted', false);
    else finish(turn, [...endWorkers(), startNotice(failure, { turnId })], 'failed', false, failure.kind);
  }

  // ── Asides (M20b, C12–C18, C70) ───────────────────────────────────────────────────────────
  /** The aside's turn has started, as far as the CLI says: once, under the request's id. */
  function asideStarted(aside: Aside): void {
    if (aside.started || aside.done) return;
    aside.started = true;
    emit({ type: 'turn-started', turnId: aside.request.turnId, asideId: aside.request.asideId, ...(aside.requestId === null ? {} : { providerTurnId: aside.requestId }) });
  }

  /** An aside's one end. `before` goes out first: its notice. `reported`: the CLI's own word, a reply or a cancel's answer. */
  function finishAside(aside: Aside, before: readonly AgentEvent[], outcome: 'completed' | 'interrupted' | 'failed', reported: boolean, failure?: TurnFailure): boolean {
    if (aside.done) return false;
    aside.done = true;
    timers.clear(aside.stopTimer); aside.stopTimer = undefined;
    asides.delete(aside.request.asideId);
    if (aside.requestId !== null) asideRequests.delete(aside.requestId);
    emitAll(before);
    emit({ type: 'turn-ended', turnId: aside.request.turnId, asideId: aside.request.asideId, outcome, reported, ...(failure === undefined ? {} : { failure }) });
    return true;
  }

  const asideNotice = (aside: Aside, kind: 'turn-failed' | 'connection-lost' | 'stop-unconfirmed' | 'no-answer'): AgentEvent => ({ type: 'notice', kind, turnId: aside.request.turnId, asideId: aside.request.asideId });

  /** Every open aside ends with the process (C34, C70): interrupted where its Stop was pressed, else lost. An end of the session's own. */
  function endAsides(closed: boolean): void {
    for (const aside of [...asides.values()]) {
      // The wait is given up first: a reply still in the pipe finds no one.
      aside.abort.abort();
      if (aside.stopped || closed) finishAside(aside, [], 'interrupted', false);
      else finishAside(aside, [asideNotice(aside, 'connection-lost')], 'failed', false, 'connection-lost');
    }
  }

  /** How a side question is getting on (C14): `started` marks its aside as answering, a retry is counted, and neither carries text. */
  function progressed(frame: unknown): void {
    const taken = takeProgress(frame);
    const aside = taken === null ? undefined : asideRequests.get(taken.requestId);
    // For no request of this session's, or for one that has ended: not read.
    if (taken === null || aside === undefined || aside.done) { counts.unread += 1; return; }
    if (taken.status === 'started') asideStarted(aside);
    else if (taken.status === 'retry') counts.retried += 1;
  }

  // ── Requests from the CLI: nothing is granted but what the user grants on a card (C22, C64; M22, C8) ──
  /**
   * Refuses a request on the line it came on, once for each time it was delivered, and says so once
   * a turn — or, `over`, each time, naming the bound it was past and by how much (M22, C9, C48). The
   * promise is the first write's: whether the refusal's line went.
   */
  function refuse(taken: Pick<TakenRequest, 'requestId' | 'subtype' | 'tool'>, reply: Reply, deliveries = 1, over: ApprovalOverBound | null = null): Promise<boolean> {
    counts.refused[taken.subtype] = (counts.refused[taken.subtype] ?? 0) + 1;
    context.logger.record({ type: 'request-refused', method: taken.subtype });
    // A tool's use is denied in fat-g's fixed words; every other request gets the error reply.
    let written: Promise<boolean> = Promise.resolve(false);
    if (taken.requestId !== null) {
      const refusal: ChatAnswer = taken.tool ? { kind: 'deny', requestId: taken.requestId } : { kind: 'unsupported', requestId: taken.requestId };
      written = reply(refusal);
      for (let delivery = 1; delivery < deliveries; delivery += 1) void reply(refusal);
    }
    const turnId = current === null ? {} : { turnId: current.request.turnId };
    if (over !== null) { emit({ type: 'notice', kind: 'request-refused', ...turnId, bound: over.bound, size: over.size }); return written; }
    if (refusedNoticed) return written;
    refusedNoticed = true;
    emit({ type: 'notice', kind: 'request-refused', ...turnId });
    return written;
  }

  // ── A question: the one request that is answered, and it grants nothing (M21, C17) ────────
  /**
   * A question's request as a hold, or null for one that is refused on the wire (C11, C60): an id
   * an event cannot carry or an answer cannot echo, no tool use for the card to stand at, questions
   * that are none or more than a card draws whole, or no owner it can be placed under — the
   * session's own with no turn in flight, after its turn's `result`, or a worker that has ended.
   */
  function holdFor(asked: QuestionRequest, payload: RequestPayload | null, reply: Reply): QuestionHold | null {
    const { requestId, toolUseId, questions: raw } = asked;
    if (requestId === null || requestId.length > CHAT_WIRE_LIMITS.requestIdChars || toolUseId === null || raw === null || !canShow(raw)) return null;
    const owner = placeQuestion(mapper, { requestId, toolUseId, agentId: asked.agentId });
    return owner === null ? null : { kind: 'question', requestId, toolUseId, tool: asked.tool, input: asked.input, questions: raw, payload, owner, reply, repeats: 0, sent: null };
  }

  /** A question's request: held and said, or refused on the wire. */
  function ask(taken: TakenRequest, asked: QuestionRequest, reply: Reply): void {
    const hold = holdFor(asked, taken.payload, reply);
    if (hold === null) { void refuse(taken, reply); return; }
    // Held before it is said: main may refuse it from inside this very emission (C11).
    holds.set(hold.requestId, hold);
    // Bounded for the card (C7); the request itself stays here as it came (C59).
    const bound = boundQuestions(hold.questions);
    emit({ type: 'question-raised', turnId: hold.owner.turnId, ...(hold.owner.workerId === null ? {} : { workerId: hold.owner.workerId }), requestId: hold.requestId, sourceId: hold.toolUseId, questions: bound.questions, cut: bound.cut });
  }

  // ── A request to act: held for the user's decision, and never decided here (M22, C8, C13) ──
  /**
   * A request to act: held and said with its card's view, or refused on the wire (C9, C11, C48) —
   * an id an event cannot carry or a reply cannot echo, no tool use for the card to stand at, no
   * tool or input to show, a field its action stands on missing, more than a card shows whole, which
   * is said with its size, or no owner it can be placed under.
   */
  function askLeave(taken: TakenRequest, asked: ActionRequest, reply: Reply): void {
    const { requestId, toolUseId, tool, input } = asked;
    if (requestId === null || requestId.length > CHAT_WIRE_LIMITS.requestIdChars || toolUseId === null || tool === null || input === null) { void refuse(taken, reply); return; }
    // The CLI's own offers, each read for its kind (C8, C68): one kind is ever sent back, and only at the user's word.
    const view = approvalView(asked, asked.suggestions.map((suggestion) => readOffer(suggestion, tool)), MCP_TOOL_PREFIX);
    if (view.kind === 'refused') { void refuse(taken, reply, 1, view.over); return; }
    // What an event may carry, held to its own schema before anything is placed or said.
    const request = ApprovalRequestSchema.safeParse(view.request);
    if (!request.success) { void refuse(taken, reply); return; }
    const owner = placeApproval(mapper, { requestId, toolUseId, agentId: asked.agentId });
    if (owner === null) { void refuse(taken, reply); return; }
    // Held before it is said, as a question is; the request itself stays here as it came.
    holds.set(requestId, { kind: 'approval', requestId, toolUseId, tool, input, grant: view.grant, payload: taken.payload, owner, reply, repeats: 0, sent: null });
    emit({ type: 'approval-raised', turnId: owner.turnId, ...(owner.workerId === null ? {} : { workerId: owner.workerId }), requestId, sourceId: toolUseId, request: request.data });
  }

  // ── A plan: handed over for the user's decision, and never decided here (M22b, C8–C11) ───
  /**
   * The plan's request (C8–C10): held and said with its text, or refused — outside a plan turn, after
   * its Execute, with no id or tool use to answer and stand by, or past what the turn can place; and
   * one that carries no plan is denied in fat-g's words, with its notice, and makes no version (C9).
   */
  function planRequested(taken: TakenRequest, asked: PlanRequest, reply: Reply): void {
    const turn = current;
    const { requestId, toolUseId } = asked;
    if (turn === null || turn.plan !== 'planning' || !inForce.planning || requestId === null || requestId.length > CHAT_WIRE_LIMITS.requestIdChars || toolUseId === null) { void refuse(taken, reply); return; }
    if (asked.text === null || asked.input === null) {
      planReleased(mapper, toolUseId);
      counts.refused[TOOL_REQUEST] = (counts.refused[TOOL_REQUEST] ?? 0) + 1;
      void reply({ kind: 'deny', requestId, by: 'no-plan' });
      emit({ type: 'notice', kind: 'plan-missing', turnId: turn.request.turnId });
      return;
    }
    const owner = placePlan(mapper, toolUseId, requestId);
    if (owner === null) { void refuse(taken, reply); return; }
    // Held before it is said, as a question is; the request itself stays here as it came.
    holds.set(requestId, { kind: 'plan', requestId, toolUseId, input: asked.input, payload: taken.payload, owner, reply, repeats: 0, sent: null });
    emit({ type: 'plan-raised', turnId: owner.turnId, requestId, sourceId: toolUseId, text: asked.text });
  }

  /**
   * A held request that is over because another came under its id (C91), or because what came
   * under it could not be read at all (C67): denied on the wire for each delivery that still waits
   * and for this one, the hold let go and its card withdrawn as changed. Nothing of what came is kept.
   */
  function changed(held: Hold, reply: Reply): void {
    counts.changed += 1;
    holds.delete(held.requestId);
    release(held);
    emit(resolved(held, 'changed'));
    void refuse({ requestId: held.requestId, subtype: TOOL_REQUEST, tool: true }, reply, (held.sent === null ? 1 + held.repeats : 0) + 1);
  }

  function requested(frame: unknown, reply: Reply): void {
    const taken = takeRequest(frame);
    const held = taken.requestId === null ? undefined : holds.get(taken.requestId);
    if (held !== undefined) {
      // Delivered again under an id it holds: compared with the hold before anything else (C91).
      if (!samePayload(held.payload, taken.payload)) { changed(held, reply); return; }
      // The same request (C11): no second event, and the same reply when the first's comes — at once, where it has.
      counts[held.kind === 'question' ? 'questions' : held.kind === 'plan' ? 'plans' : 'approvals'].repeated += 1;
      if (held.sent === null) held.repeats += 1; else void reply(held.sent);
      return;
    }
    if (taken.question !== null) { ask(taken, taken.question, reply); return; }
    // The plan's tool (M22b, C8): its request is a plan's, under a plan turn alone.
    if (taken.plan !== null) { planRequested(taken, taken.plan, reply); return; }
    // Under the reading mode every request to act is refused, as before there were modes (C6, C45);
    // and a request that asks for no tool is refused under every mode (C48).
    if (taken.action === null || inForce.reading) { void refuse(taken, reply); return; }
    askLeave(taken, taken.action, reply);
  }

  /** The CLI takes a request of its own back (C20): a question's or one to act, by the id it was asked under. */
  function cancelled(frame: unknown): void {
    const taken = takeCancel(frame);
    const hold = taken === null ? undefined : holds.get(taken.requestId);
    // For no request this session holds: not read, as before.
    if (hold === undefined) { counts.unread += 1; return; }
    holds.delete(hold.requestId);
    release(hold);
    // The CLI took it back and went on. After a Stop the cancel is the Stop's own (C22): the turn's
    // end settles the card, which then reads that the turn ended.
    if (current?.stop !== true) emit(resolved(hold, 'withdrawn'));
  }

  /**
   * An answer the process did not take (C14, C66): said as dropped, whatever became of the process
   * meanwhile (C75), and the process is ended — the CLI would wait on a reply that never comes, and
   * the loss ends the turn with its notice. Nothing sends the answer again.
   */
  function notTaken(hold: Hold): void {
    if (holds.get(hold.requestId) === hold) holds.delete(hold.requestId);
    emit(resolved(hold, 'dropped'));
    void endProcess();
  }

  /**
   * Writes a held request's reply, once for each time the request was delivered (C11), and waits
   * for the write, whose promise says whether the line went (C66): true once it has, and false for
   * one the process did not take, which is then said and ends the process. It never rejects.
   */
  async function deliver(hold: Hold, sent: ChatAnswer): Promise<boolean> {
    let written: Promise<boolean>;
    // A reply the wire will not write is one the process did not take.
    try { written = hold.reply(sent); } catch { written = Promise.resolve(false); }
    for (let again = 0; again < hold.repeats; again += 1) void hold.reply(sent);
    if (await written.catch(() => false)) return true;
    notTaken(hold);
    return false;
  }

  // ── The mode the process reports (M22, C5, C7, C90) ───────────────────────────────────────
  /**
   * The process runs under another policy than the one fat-g asked for (C7): nothing more is sent
   * to it. A turn ends as failed with the notice, which carries the word the CLI reported; with no
   * turn, the notice stands alone.
   */
  function mismatch(word: string | null): void {
    const turn = current;
    if (turn !== null) finish(turn, [...endWorkers(), { type: 'notice', kind: 'policy-mismatch', turnId: turn.request.turnId, ...detailOf(word) }], 'failed', false, 'policy-mismatch');
    else emitAll([...endWorkers(), { type: 'notice', kind: 'policy-mismatch', ...detailOf(word) }]);
    void endProcess();
  }

  /** A status frame (C7, C90): read for the permission mode it names, where it names one. */
  function statusReported(frame: unknown): void {
    const taken = takeStatus(frame);
    // Most name none: what the process is doing, which is not read (C32).
    if (!taken.named) { counts.unread += 1; return; }
    // The mode in force: the change reported, after its reply was read.
    if (reportsMode(inForce, taken.mode)) { counts.modesReported += 1; return; }
    // The target of a change that waits (C90): the frame came beside the reply, or before it was
    // read — the transport decodes a whole chunk before the wait for a reply goes on. No mismatch.
    if (pending !== null && reportsMode(pending.to, taken.mode)) {
      pending.named = true;
      counts.modesReported += 1;
      // Execute's, which has no reply (M22b, C7): the CLI went back to the chat's mode by itself.
      if (pending.commit === true) { inForce = pending.to; mapper.mode = pending.to; pending = null; }
      return;
    }
    mismatch(taken.mode);
  }

  // ── A line over the limit (M22, C67, C71) ─────────────────────────────────────────────────
  function oversized(line: PeekedLine, reply: Reply): void {
    counts.dropped.oversized += 1;
    // Not a request, by its own first bytes: skipped and counted, as before (M20a, C16).
    if (over || line.request === 'no') return;
    const id = line.request === 'yes' && line.id !== null && line.id.kind === 'string' && line.id.value !== '' && line.id.value.length <= CHAT_WIRE_LIMITS.requestIdChars ? line.id.value : null;
    if (id !== null) {
      // A request, by an id fat-g can answer (C67): refused by that id, as a tool's use is — the one
      // request that grows with what it asks leave for — and the turn goes on. Its bound is never
      // judged, and nothing of it is an event.
      const held = holds.get(id);
      const turnId = current === null ? {} : { turnId: current.request.turnId };
      if (held !== undefined) changed(held, reply);
      else {
        counts.refused[OVERSIZED_REQUEST] = (counts.refused[OVERSIZED_REQUEST] ?? 0) + 1;
        context.logger.record({ type: 'request-refused', method: OVERSIZED_REQUEST });
        void reply({ kind: 'deny', requestId: id });
      }
      // A plan's request past the line (M22b, C61, C79): no version is made, and the notice says why.
      if (line.name === PLAN_TOOL && inForce.planning) emit({ type: 'notice', kind: 'plan-too-large', ...turnId, size: line.size });
      else emit({ type: 'notice', kind: 'request-refused', ...turnId, bound: 'line', size: line.size });
      return;
    }
    // It is, or may be, a request, and names no id fat-g could read (C71): nothing can answer it,
    // so whatever would wait on it is stopped, each by its own path, with the notice saying why.
    // With nothing running it is skipped and counted as any other line.
    const waiting = [...asides.values()].filter((aside) => !aside.done && !aside.stopped);
    if (current !== null || mapper.workers.size > 0) {
      emit({ type: 'notice', kind: 'line-too-long', ...(current === null ? {} : { turnId: current.request.turnId }), size: line.size });
      stopSession();
    }
    for (const aside of waiting) {
      emit({ type: 'notice', kind: 'line-too-long', turnId: aside.request.turnId, asideId: aside.request.asideId, size: line.size });
      stopAside(aside.request.asideId);
    }
  }

  // ── The context window (decision 0033) ────────────────────────────────────────────────────
  /** A reading said, where it says something new: it replaces the summary's. */
  function sayContext(next: ContextReading): void {
    if (over || sameContext(reading ?? undefined, next)) return;
    reading = next;
    emit({ type: 'context', reading: next });
  }

  /**
   * Asks the CLI how full the context is, waiting on nothing: at a turn's start while no reading is
   * held, and after each turn the CLI ended. One request at a time; a refusal of it ends the asking
   * on this process, and a request that is late, lost or unreadable changes nothing.
   */
  function askContext(chat: ChatConnection): void {
    if (over || contextAsk.refused) return;
    if (contextAsk.inFlight) { contextAsk.again = true; return; }
    contextAsk.inFlight = true;
    if (counted !== null) counted.afterAsk = false;
    counts.context.asked += 1;
    void chat.request({ kind: 'context' }, timings.contextMs).then((reply) => {
      const taken = takeContextReply(reply);
      if (taken === null) { counts.context.failed += 1; return; }
      counts.context.read += 1;
      // A count of the session's own calls that came after the request was written is the newer.
      sayContext(counted?.afterAsk === true ? { ...taken, used: counted.used, lastCall: counted.call } : { ...taken, ...(taken.lastCall === undefined && counted !== null ? { lastCall: counted.call } : {}) });
    }, (error: unknown) => {
      counts.context.failed += 1;
      if (error instanceof ProcessFailure && error.code === 'rpc-error') contextAsk.refused = true;
    }).finally(() => {
      contextAsk.inFlight = false;
      if (!contextAsk.again) return;
      contextAsk.again = false;
      askContext(chat);
    });
  }

  /** The count of a call of the session's own, during a turn: the window and the rest are the last reply's, and nothing is said before there is one. */
  function usageRead(frame: unknown): void {
    if (current === null) return;
    const usage = takeAssistantUsage(frame);
    if (usage === null) return;
    counted = { ...usage, afterAsk: contextAsk.inFlight };
    if (reading !== null) sayContext({ ...reading, used: usage.used, lastCall: usage.call });
  }

  // ── Frames ────────────────────────────────────────────────────────────────────────────────
  /**
   * A frame read, and then whether a message can go into the turn asked again: a status frame, an
   * `init` that names no model or a message's completion changes it with no event of its own.
   */
  function onFrame(frame: unknown, answer: Reply): void {
    readFrame(frame, answer);
    noteSteer();
  }

  function readFrame(frame: unknown, answer: Reply): void {
    if (over) return;
    const kind = frameKind(frame);
    if (kind === 'request') { requested(frame, answer); return; }
    if (kind === 'cancel') { cancelled(frame); return; }
    // The mode a status frame names is held to the session's own (M22, C7): the mapper has no part in it.
    if (kind === 'status') { statusReported(frame); return; }
    // The CLI's command list, whole (M23, C60): it replaces the one held. One that is no list changes nothing.
    if (kind === 'commands') {
      const pushed = takeCommands(frame);
      if (pushed === null) return;
      commandList = pushed;
      // The names an earlier init listed are the list it replaced; its skills and terminal names still group and leave out.
      if (mapper.listed !== null) mapper.listed = { ...mapper.listed, commandNames: null };
      return;
    }
    // A side question's own frame: read here, and never by the mapper, whose turn it is no part of (M20b, C17).
    if (kind === 'request-progress') { progressed(frame); return; }
    // The speed a turn ran at, where the process asked for fast mode (decision 0020): read beside the
    // mapper, whose frames these stay, and said before the turn's end is.
    const overage = overageReason(frame);
    if (overage !== undefined) refusedOverage = overage;
    const served = fast && current !== null ? servedSpeed(frame, refusedOverage) : null;
    if (served !== null && current !== null) emit({ type: 'in-force', turnId: current.request.turnId, served: served.served, servedReason: served.reason });
    // How full the context is, by the usage of the session's own calls (decision 0033): read beside the mapper too.
    usageRead(frame);
    const mapped = mapChatFrame(mapper, frame);
    if (mapped.unread) counts.unread += 1;
    if (mapped.drop !== null) drop(mapped.drop);
    emitAll(mapped.events);
    for (const effect of mapped.effects) {
      const turn = current;
      switch (effect.type) {
        case 'started':
          // The CLI's word that it took the prompt: the deadline from its write is met (C88).
          // Nothing times the wait for the `init`, which a hook of the user's can hold back.
          if (turn !== null) { timers.clear(turn.startedTimer); turn.startedTimer = undefined; }
          break;
        case 'overruled': {
          // The launch was overruled, by a configuration or by a name fat-g does not know: the
          // process is ended at once, whatever it was doing (C21, C62, C83).
          const notice = (turnId?: string): AgentEvent => ({ type: 'notice', kind: 'start-overruled', ...(turnId === undefined ? {} : { turnId }) });
          if (turn !== null && turn.written) finish(turn, [...endWorkers(), notice(turn.request.turnId)], 'failed', false, 'start-overruled');
          else emitAll([...endWorkers(), notice()]);
          void endProcess();
          return;
        }
        case 'turn-ended': {
          if (turn === null) break;
          const { turnId } = turn.request;
          // A turn that ends by Stop takes its open workers with it (M15, C90).
          const before: AgentEvent[] = turn.stop || effect.outcome === 'interrupted' ? endWorkers() : [];
          if (effect.lost) before.push({ type: 'notice', kind: 'output-lost', turnId });
          else if (effect.outcome === 'failed') before.push({ type: 'notice', kind: 'turn-failed', turnId, ...(effect.detail === null ? {} : { detail: effect.detail }) });
          // A plan turn's mode set back before its end is said (M22b, C7): the next prompt waits for it.
          restore();
          // The CLI's own end: the one kind that is reported (C76).
          finish(turn, before, effect.outcome, true, endFailure(effect), effect.answerItemId);
          // What the turn left in the context, a compaction's included, as the CLI counts it (decision 0033).
          if (connection !== null) askContext(connection);
          break;
        }
        case 'worker-frame-held': {
          // A worker's frame came before the frame that pairs it with its worker (M20a, C22): it is
          // held for that pairing, two seconds at most, and then dropped and counted.
          const { parent } = effect;
          if (pairTimers.has(parent)) break;
          pairTimers.set(parent, timers.set(() => {
            pairTimers.delete(parent);
            for (let lost = expireWaitingFrames(mapper, parent); lost > 0; lost -= 1) drop('other-worker');
          }, timings.pairMs));
          break;
        }
        case 'worker-frames-claimed':
          timers.clear(pairTimers.get(effect.parent));
          pairTimers.delete(effect.parent);
          break;
        case 'held-started':
          // A message written during a turn that ended first runs as the CLI's next turn (M23, C42):
          // this session's turn from here, its prompt already written, as a sent turn's is once taken.
          if (current !== null) break;
          current = { request: { turnId: effect.turn.runtimeId, prompt: '', effort, speed: fast ? FAST_TIER.id : null, messageId: effect.turn.promptId }, abort: new AbortController(), stop: false, written: true, mapped: effect.turn, plan: 'none', startedTimer: undefined, stopTimer: undefined, running: Promise.resolve() };
          break;
        case 'question-closed': {
          // A question's tool result came (M21, C19): its request is over, and is held no longer.
          // After an answer the mapper has said the CLI took it, and an error flag there fails
          // nothing of the card: it is counted.
          const hold = holds.get(effect.requestId);
          holds.delete(effect.requestId);
          if (effect.failed) counts.questions.failed += 1;
          // A result for a request nobody answered and the CLI never took back: it went on without
          // an answer all the same. After a Stop the turn's end settles the card, as a cancel's does.
          if (hold !== undefined && hold.sent === null && current?.stop !== true) emit(resolved(hold, 'withdrawn'));
          break;
        }
        case 'plan-closed': {
          // The plan's tool result came (M22b, C10): its request is over. With no decision the CLI went on without one.
          const hold = holds.get(effect.requestId);
          holds.delete(effect.requestId);
          if (hold !== undefined && hold.sent === null && current?.stop !== true) emit(resolved(hold, 'withdrawn'));
          break;
        }
        case 'approval-closed': {
          // The tool result of an action leave was asked for came (M22, C12): its request is over,
          // and is held no longer. After a decision the mapper has said the CLI took it; with none,
          // the CLI went on without one, as above.
          const hold = holds.get(effect.requestId);
          holds.delete(effect.requestId);
          if (hold !== undefined && hold.sent === null && current?.stop !== true) emit(resolved(hold, 'withdrawn'));
          break;
        }
      }
    }
  }

  /** The process is gone, by itself or because the session ended it (C29). */
  function processEnded(result: CleanupResult): void {
    // A message written during a turn that the CLI had not said it took or dropped is not known to have run (M23, C44).
    for (const messageId of heldMessages(mapper)) emit({ type: 'delivery', messageId, state: 'not-confirmed' });
    mapper.steered.clear();
    // First (M21, C67, C70; M22, C11): each request the process still held unanswered is said dropped, the
    // session's own and the workers', before the ends made below — which would otherwise reach main
    // first, and withdraw as "the turn ended" what the loss dropped. An answered one is let go with
    // no word, its line gone or still queued: a queued line the stop rejects is said by its own write.
    const lost = [...holds.values()].filter((hold) => hold.sent === null);
    holds.clear();
    for (const hold of lost) emit(resolved(hold, 'dropped'));
    const turn = current;
    if (turn !== null && turn.written) {
      // Its prompt was written: the open workers first, then the turn. A Stop was pressed: no notice.
      if (turn.stop) finish(turn, endWorkers(), 'interrupted', false);
      else finish(turn, [...endWorkers(), { type: 'notice', kind: 'connection-lost', turnId: turn.request.turnId }], 'failed', false, 'connection-lost');
    } else if (turn === null && !over && mapper.workers.size > 0) {
      // No turn, workers open: it reads as a Stop of them does, with its own notice.
      emitAll([...endWorkers(), { type: 'notice', kind: 'workers-lost' }]);
    }
    // The asides ran on it too (M20b, C34, C70): each ends here, before whoever listens hears of the close.
    endAsides(false);
    if (ending !== null) return;
    over = true;
    clearPairTimers();
    ending = Promise.resolve(result);
    // A turn still starting fails its step where it waits, its request rejected: `closed` follows
    // that turn's end, so whoever listens hears of the turn first.
    if (turn !== null && current === turn) void turn.running.finally(() => resolveClosed(result));
    else resolveClosed(result);
  }

  // ── A turn ────────────────────────────────────────────────────────────────────────────────
  async function launch(signal: AbortSignal, owner: LaunchOwner, executable: Executable): Promise<ChatConnection> {
    const step: StartStep = options.reference === null ? 'open' : 'reopen';
    const made = chatArguments(executable.kind, options.start, options.reference);
    let opened: ChatConnection;
    try {
      opened = await launchChat({
        processes: context.processes, logger: context.logger, executable, argsPrefix: options.argsPrefix, args: made.args, folder: options.start.folder, launchWord: inForce.native,
        launchMs: timings.launchMs, timers, signal, onFrame, onOversized: oversized,
      });
    } catch (error) {
      if (!(error instanceof ChatLaunchFailure) || error.stage === 'spawn') throw new StartFailure('launch');
      launchCleanup = error.cleanup;
      launchRecheck = error.recheck;
      // The sign of a session Claude no longer has (C26): that frame and nothing else. No text of
      // the CLI's is read, and the exit code decides nothing.
      throw new StartFailure(step, error.missing && options.reference !== null ? 'session-not-reopened' : 'start-failed');
    }
    connection = opened;
    // Its commands, as the reply lists them (M23, C60): held for this process, and in memory alone.
    commandList = takeCommands(opened.reply);
    void opened.done.then((result) => processEnded(result));
    // A folder a shim launch would refuse was left out: said at each launch that leaves one out (C20). It carries no path.
    if (made.leftOut > 0) emit({ type: 'notice', kind: 'folder-not-passed', turnId: owner.turnId, ...(owner.asideId === undefined ? {} : { asideId: owner.asideId }) });
    // Check 1, before any prompt (C21; M22, C5, C46): the reply is where an overruled launch would
    // first show. It is held to the mode the launch named: a reading session that reports another
    // is not restricted, and any other session reports another policy than its mode's.
    const reported = takeReply(opened.reply).mode;
    if (!reportsMode(inForce, reported)) throw inForce.reading ? new StartFailure(step, 'not-read-only') : new StartFailure(step, 'policy-mismatch', reported);
    // Confirmed (C2): the mode this process runs under, by fat-g's own id for it and never the CLI's word.
    emit({ type: 'in-force', mode: inForce.id });
    return opened;
  }

  /**
   * The session's process: the one that is open, or the one launch that opens it, shared by
   * whoever waits for it — a turn, and the asides asked meanwhile (M20b, C10). It is launched once.
   */
  function connect(signal: AbortSignal, owner: LaunchOwner): Promise<ChatConnection> {
    if (connection !== null) return Promise.resolve(connection);
    launching ??= (async () => {
      const executable = options.executable();
      if (executable === undefined) throw new StartFailure('launch');
      return launch(signal, owner, executable);
    })();
    return launching;
  }

  /**
   * Plan mode for one prompt (M22b, C5, C7): only under a mode that takes a plan turn, its target
   * recorded before the request is written — a status frame that names it meanwhile is the change
   * reported — and confirmed by the reply. A reply that names another word is a policy fat-g did not
   * ask for (C7): the start fails with it, as a launch's would.
   */
  async function enterPlan(chat: ChatConnection, turn: Turn): Promise<void> {
    if (!PLAN_MODES.includes(chatMode.id) || inForce !== chatMode) throw new StartFailure('send');
    const target = planVariant(chatMode);
    const change = { to: target, named: false };
    pending = change;
    let reported: string | null = null;
    let answered = false;
    try {
      reported = takeModeReply(await chat.request({ kind: 'set-mode', mode: PLAN_WORD }, timings.modeMs, turn.abort.signal)).mode;
      answered = true;
    } catch { /* refused, late, the start cancelled, or the process gone: not confirmed */ }
    if (pending === change) pending = null;
    if (turn.stop || over) throw new StartFailure('send');
    if (!answered) throw new StartFailure('send');
    if (!reportsMode(target, reported)) throw new StartFailure('send', 'policy-mismatch', reported);
    inForce = target;
    mapper.mode = target;
    turn.plan = 'planning';
  }

  /**
   * A plan turn's mode set back to the chat's (M22b, C7, C51), where the process is still in plan
   * mode — after a Cancel, a Stop, or a plan never decided — by the one change that may name the
   * process's own launch word. Its target recorded first, as every change's is; confirmed, the
   * chat's mode is in force; anything else is a policy fat-g did not ask for, and the process ends.
   */
  function restore(): void {
    const chat = connection;
    if (!inForce.planning || over || chat === null || restoring !== null) return;
    const target = chatMode;
    const change = { to: target, named: false };
    pending = change;
    restoring = (async () => {
      let reported: string | null = null;
      let answered = false;
      try {
        reported = takeModeReply(await chat.request({ kind: 'set-mode', mode: target.native, restoring: true }, timings.modeMs)).mode;
        answered = true;
      } catch { /* refused, late, or the process gone */ }
      if (pending === change) pending = null;
      restoring = null;
      if (over) return;
      if (answered && reportsMode(target, reported)) {
        inForce = target;
        mapper.mode = target;
        emit({ type: 'in-force', mode: target.id });
        return;
      }
      mismatch(reported);
    })();
  }

  async function run(turn: Turn): Promise<void> {
    const { request } = turn;
    try {
      let chat = connection;
      if (chat === null) chat = await connect(turn.abort.signal, { turnId: request.turnId });
      // A plan turn's mode, set back at its end, is in force before anything more is sent (M22b, C7).
      if (restoring !== null) await restoring;
      if (turn.stop || over) throw new StartFailure('send');
      // How full the context is before the turn adds to it (decision 0033), where no reading is held: nothing waits on it.
      if (reading === null) askContext(chat);
      // The effort (C27): a turn whose effort differs from what this process runs with says so first.
      if (request.effort !== null && request.effort !== effort) {
        try { await chat.request({ kind: 'effort', level: request.effort }, timings.effortMs, turn.abort.signal); } catch { throw new StartFailure('send'); }
        effort = request.effort;
      }
      // The speed (decision 0020): Claude's one tier is fast mode, which a process launches without.
      // A turn whose speed differs from the process's says so first, as its effort does.
      const wantsFast = request.speed === FAST_TIER.id;
      if (wantsFast !== fast) {
        if (turn.stop || over) throw new StartFailure('send');
        try { await chat.request({ kind: 'fast', on: wantsFast }, timings.effortMs, turn.abort.signal); } catch { throw new StartFailure('send'); }
        fast = wantsFast;
      }
      if (turn.stop || over) throw new StartFailure('send');
      // A plan turn (M22b, C1, C7): the CLI's plan mode on this process, confirmed, before its prompt.
      if (request.plan === true) await enterPlan(chat, turn);
      if (turn.stop || over) throw new StartFailure('send');
      // The prompt, under the id the runtime made for the user's message (C31): the CLI's
      // `command_lifecycle` frames name it, and they are what bounds the turn.
      turn.mapped = beginChatTurn(mapper, request.turnId, request.messageId);
      refusedNoticed = false;
      turn.written = true;
      // From the write: 30 seconds for the CLI to say that it took the prompt (C88).
      turn.startedTimer = timers.set(() => {
        turn.startedTimer = undefined;
        if (current !== turn) return;
        failStart(turn, new StartFailure('send'));
        void endProcess();
      }, timings.startedMs);
      // Its images in the same frame, as base64 image blocks (M23, C21): the bytes main read and checked.
      const images = (request.attachments ?? []).map((attachment) => ({ mediaType: attachment.mediaType, bytes: attachment.bytes }));
      try { await chat.prompt(request.messageId, request.prompt, images); } catch { throw new StartFailure('send'); }
    } catch (error) {
      if (current !== turn) return;
      failStart(turn, error instanceof StartFailure ? error : new StartFailure('launch'));
      await endProcess();
    }
  }

  /**
   * One question of an aside (M20b, C13): the process, if there is none; the request; then its
   * reply, which is the whole answer or none. Every outcome is an event that names the aside.
   */
  async function runAside(aside: Aside): Promise<void> {
    const { request } = aside;
    const { asideId, turnId } = request;
    let chat = connection;
    if (chat === null) {
      try {
        chat = await connect(closing.signal, { turnId, asideId });
      } catch (error) {
        if (aside.done) return;
        const failure = error instanceof StartFailure ? error : new StartFailure('launch');
        // As a turn's failed start: its step said, nothing more sent, and the process closed (M15, C87).
        if (aside.stopped) finishAside(aside, [], 'interrupted', false);
        else finishAside(aside, [startNotice(failure, { turnId, asideId })], 'failed', false, failure.kind);
        await endProcess();
        return;
      }
    }
    if (aside.done) return;
    // Stopped while the process was starting: nothing is written for it (C70).
    if (aside.stopped || over) { finishAside(aside, [], 'interrupted', false); return; }
    const begun = chat.begin({ kind: 'side-question', question: request.text, history: request.history }, timings.asideMs, aside.abort.signal);
    aside.requestId = begun.requestId;
    if (begun.requestId !== null) asideRequests.set(begun.requestId, aside);
    let value: unknown;
    try {
      value = await begun.reply;
    } catch (error) {
      if (aside.done) return;
      const code = error instanceof ProcessFailure ? error.code : 'transport-closed';
      if (code === 'rpc-error') {
        // The CLI's own word: its answer to a cancel, at once (C15), or a request it refused.
        if (aside.stopped) finishAside(aside, [], 'interrupted', true);
        else finishAside(aside, [asideNotice(aside, 'turn-failed')], 'failed', true, 'turn-failed');
      } else if (aside.stopped) finishAside(aside, [], 'interrupted', false);
      // No reply in ten minutes (C16), or the process gone: the aside's turn fails, and nothing is done to the process.
      else finishAside(aside, [asideNotice(aside, 'connection-lost')], 'failed', false, code === 'timeout' ? 'end-lost' : 'connection-lost');
      return;
    }
    if (aside.done) return;
    // An answer that comes after its Stop is dropped, and counted (C15).
    if (aside.stopped) { drop('ended-aside'); finishAside(aside, [], 'interrupted', false); return; }
    const reply = takeSideReply(value);
    asideStarted(aside);
    // None, or a placeholder no model wrote: never shown as an answer (C13, C39).
    if (reply.text === null) { finishAside(aside, [asideNotice(aside, 'no-answer')], 'failed', true, 'turn-failed'); return; }
    emit({
      type: 'message', turnId, asideId, role: 'assistant', itemId: `side-${begun.requestId ?? request.messageId}`, phase: 'final', text: reply.text,
      ...(reply.cut ? { cut: true } : {}),
      // The model that answered, where the reply says another did than the session's (C7, C13).
      ...(reply.model === null ? {} : { model: reply.model }),
    });
    finishAside(aside, [], 'completed', true);
  }

  /**
   * Whether a message can be written into the turn now (M23, C35, C43, C88): the session's own turn,
   * taken by the CLI and not ended or being stopped, on a process whose `init` said a Stop can drop a
   * held message, under the chat's own mode with no change of it waiting — never while a plan turn
   * plans or its mode is being set back, which a message then waits out. A process whose `init` said
   * a Stop cannot drop one never takes a message during a turn at all.
   */
  function steerState(): SteerState {
    if (over || connection === null) return 'wait';
    // `listed` is set by this process's first `init`: before it, nothing is known of the capability yet.
    if (mapper.listed !== null && !mapper.cancelsQueued) return 'unsupported';
    const turn = current;
    if (turn === null || !turn.written || turn.stop) return 'wait';
    if (turn.mapped === null || !turn.mapped.started || turn.mapped.ended) return 'wait';
    if (!mapper.cancelsQueued || mapper.steered.size >= MAX_STEERED) return 'wait';
    return inForce === chatMode && pending === null && restoring === null ? 'open' : 'wait';
  }

  /**
   * Says a change of the steer state that the runtime would otherwise learn of only at the next
   * event: to `open` or `unsupported`. A turn that stops taking messages is said already — by its
   * end, or by main's own Stop or steer — and nothing of a turn comes after its `turn-ended`.
   */
  function noteSteer(): void {
    if (over) return;
    const state = steerState();
    if (state === steerSaid) return;
    steerSaid = state;
    if (state !== 'wait') emit({ type: 'steer-changed' });
  }

  /**
   * A message written while the turn runs (M23, C36, C42): handed to the process as a prompt's frame,
   * under the message's own id, and held until the CLI's lifecycle says what became of it.
   */
  async function steer(request: SteerRequest): Promise<SteerOutcome> {
    const chat = connection;
    // Its turn ended before anything was written: the message is the next prompt's (C40).
    if (steerState() !== 'open' || chat === null || current?.request.turnId !== request.turnId) return { kind: 'turn-over' };
    steerChatMessage(mapper, request.messageId, request.turnId);
    const images = (request.attachments ?? []).map((attachment) => ({ mediaType: attachment.mediaType, bytes: attachment.bytes }));
    try {
      await chat.steer(request.messageId, request.prompt, images);
    } catch {
      // The line did not go, or the process is gone: nothing says whether any of it reached the CLI.
      mapper.steered.delete(request.messageId);
      return { kind: 'unknown' };
    }
    return { kind: 'handed' };
  }

  /**
   * What this process's CLI lists (M23, C60, C61): its `initialize` reply's rows, or a push's, with the
   * names its latest `init` lists and the reply did not; its skills under Skills; the names bound to a
   * terminal left out. Null until the CLI said anything of them.
   */
  function commands(): readonly ProviderCommand[] | null {
    const listed = mapper.listed;
    if (commandList === null && listed?.commandNames == null) return null;
    const terminal = new Set(listed?.terminalNames ?? []);
    const skills = new Set(listed?.skillNames ?? []);
    const rows: ProviderCommand[] = [...(commandList ?? [])];
    for (const name of listed?.commandNames ?? []) if (!rows.some((row) => row.name === name)) rows.push({ name, description: null, hint: null, group: 'commands', selector: null });
    return rows.filter((row) => !terminal.has(row.name)).map((row) => (skills.has(row.name) ? { ...row, group: 'skills' as const } : row));
  }

  /** `interrupt`, at once and once, and one clock from the press (C28). */
  function interrupt(turn: Turn): void {
    if (turn.mapped !== null) turn.mapped.stopped = true;
    // With messages the CLI still holds (M23, C43), the interrupt asks that they be dropped with the
    // turn: the reply names those it dropped, each said cancelled, and one it still holds could run
    // after the Stop, which no Stop may let happen — the process is ended. Otherwise its reply
    // confirms nothing: the turn's `result` does.
    const held = heldMessages(mapper);
    const cancelQueued = held.length > 0 && mapper.cancelsQueued;
    const asked = connection?.request({ kind: 'interrupt', ...(cancelQueued ? { cancelQueued: true } : {}) }, timings.stopMs);
    void asked?.then((reply) => {
      if (!cancelQueued) return;
      const { cancelled, stillQueued } = takeInterruptReply(reply);
      for (const messageId of cancelled) {
        if (mapper.steered.get(messageId)?.folded !== false) continue;
        mapper.steered.delete(messageId);
        emit({ type: 'delivery', messageId, state: 'cancelled' });
      }
      // One the CLI still holds, or one neither its reply nor its lifecycle said it dropped, could run after the Stop: the process is ended.
      if (stillQueued.length > 0 || heldMessages(mapper).length > 0) void endProcess();
    }, () => { if (cancelQueued && heldMessages(mapper).length > 0) void endProcess(); });
    turn.stopTimer = timers.set(() => {
      turn.stopTimer = undefined;
      // A Stop the CLI has not confirmed by then ends the process.
      if (finish(turn, [...endWorkers(), { type: 'notice', kind: 'stop-unconfirmed', turnId: turn.request.turnId }], 'interrupted', false)) void endProcess();
    }, timings.stopMs);
  }

  /** Stops the running turn, a turn still starting, or the workers left after one: the facet's Stop, and what a line no one can answer brings (M22, C71). */
  function stopSession(): void {
    const turn = current;
    if (turn === null) {
      // No turn, workers open: no `result` would confirm an interrupt (K11), so the process is ended at once.
      if (over || mapper.workers.size === 0) return;
      emitAll([...endWorkers(), { type: 'notice', kind: 'workers-stopped' }]);
      void endProcess();
      return;
    }
    if (turn.stop) return;
    turn.stop = true;
    // Before the prompt is written the start is cancelled: nothing more is written (C28).
    if (!turn.written) { turn.abort.abort(); return; }
    interrupt(turn);
  }

  /** Stops an aside's question and nothing else (M20b, C12, C70). */
  function stopAside(asideId: string): void {
    const aside = asides.get(asideId);
    if (aside === undefined || aside.done || aside.stopped) return;
    aside.stopped = true;
    // Before its request is written nothing is sent: it ends once the launch it waits for has answered (C70).
    if (aside.requestId === null) return;
    connection?.cancel(aside.requestId);
    // One clock from the press, the aside's own: a cancel the CLI has not answered by then ends the
    // aside here. The process is never ended for it (C70).
    aside.stopTimer = timers.set(() => {
      aside.stopTimer = undefined;
      if (!finishAside(aside, [asideNotice(aside, 'stop-unconfirmed')], 'interrupted', false)) return;
      aside.abort.abort();
    }, timings.stopMs);
  }

  /**
   * A change of mode on the live process (M22, C5, C74, C90). The gate is main's, and is looked at
   * again here: a process that is up, a change the CLI makes on one, no other change waiting, and
   * nothing running — no turn, worker, request or aside. Where it does not stand nothing is written.
   */
  async function setMode(id: string): Promise<ModeChange> {
    // A plan turn's mode, being set back at its end, is in force before a change is asked, as before a
    // prompt (M22b, C7): a change right after a plan's request was closed for it (decision 0029) waits it out.
    if (restoring !== null) await restoring;
    const chat = connection;
    const target = claudeMode(id);
    const idle = current === null && mapper.workers.size === 0 && holds.size === 0 && asides.size === 0;
    if (over || chat === null || target.id !== id || inForce.planning || restoring !== null || claudeTransition(inForce.id, id) !== 'idle' || pending !== null || !idle) return { confirmed: false, detail: null };
    // The target, before the request is written (C90): a status frame that names it meanwhile is the change reported.
    const change = { to: target, named: false };
    pending = change;
    let reported: string | null = null;
    let answered = false;
    try {
      reported = takeModeReply(await chat.request({ kind: 'set-mode', mode: target.native }, timings.modeMs)).mode;
      answered = true;
    } catch { /* refused, late, or the process gone: not confirmed */ }
    if (pending === change) pending = null;
    if (over) return { confirmed: false, detail: null };
    if (answered && reportsMode(target, reported)) {
      inForce = target;
      chatMode = target;
      mapper.mode = target;
      emit({ type: 'in-force', mode: target.id });
      return { confirmed: true };
    }
    // Not confirmed: the mode is as it was — unless a status frame had named the target, and the
    // process then runs under a mode its reply does not confirm, which is a mismatch (C90).
    if (change.named) mismatch(reported);
    return { confirmed: false, detail: reported === null ? null : cutTo(reported, MAX_NOTICE_DETAIL).text };
  }

  return {
    counts,
    closed,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    send(request) {
      // No prompt is written while a turn runs (C30): nothing waits in the CLI's own queue.
      if (over || current !== null) return;
      const turn: Turn = { request, abort: new AbortController(), stop: false, written: false, mapped: null, plan: 'none', startedTimer: undefined, stopTimer: undefined, running: Promise.resolve() };
      current = turn;
      turn.running = run(turn);
    },
    ask(request) {
      // One question of an aside at a time: main refuses a second, and so does this.
      if (over || asides.has(request.asideId)) return;
      const aside: Aside = { request, requestId: null, started: false, stopped: false, done: false, stopTimer: undefined, abort: new AbortController() };
      asides.set(request.asideId, aside);
      void runAside(aside);
    },
    stopAside,
    stop: stopSession,
    setMode,
    steerState,
    steer,
    commands,
    answer(requestId, answers) {
      const hold = holds.get(requestId);
      // Main may name a request this session no longer holds — let go with its owner, taken back by
      // the CLI, or answered already: counted, and nothing is written. A request to act is no question.
      if (hold === undefined || hold.kind !== 'question' || hold.sent !== null) { counts.questions.unheld += 1; return; }
      if (answers === null) {
        // Main cannot place it (C11, C30): refused as a request fat-g cannot show is, with its notice.
        holds.delete(requestId);
        questionReleased(mapper, hold.owner, hold.toolUseId);
        void refuse({ requestId, subtype: TOOL_REQUEST, tool: true }, hold.reply, 1 + hold.repeats);
        return;
      }
      // From the request as it came (C59): the whole question as the key, the whole label of an option by its place.
      const encoded = encodeAnswers(hold.questions, answers);
      // Answers that do not fit the request are never sent as something else: the process took none.
      if (encoded === null) { questionReleased(mapper, hold.owner, hold.toolUseId); notTaken(hold); return; }
      const sent: ChatAnswer = { kind: 'allow-question', requestId, tool: hold.tool, input: hold.input, answers: encoded };
      hold.sent = sent;
      questionAnswered(mapper, hold.owner, hold.toolUseId);
      void deliver(hold, sent);
    },
    decline(requestId) {
      const hold = holds.get(requestId);
      // As for an answer: a request no longer held, or replied to already, is counted and nothing is written.
      if (hold === undefined || hold.kind !== 'question' || hold.sent !== null) { counts.questions.unheld += 1; return; }
      // The user skipped it (M100b, C31): a `deny` in their name, in words of its own. K1 saw the CLI
      // make its tool result of it, and the turn go on; that result is its word that it took it.
      const sent: ChatAnswer = { kind: 'deny', requestId, by: 'user-skipped' };
      hold.sent = sent;
      questionAnswered(mapper, hold.owner, hold.toolUseId, true);
      void deliver(hold, sent);
    },
    async decide(requestId, choice) {
      const hold = holds.get(requestId);
      // Main may name a request this session no longer holds, as it may a question: counted, and nothing is written.
      if (hold === undefined || hold.kind !== 'approval' || hold.sent !== null) { counts.approvals.unheld += 1; return false; }
      if (choice === null) {
        // Main cannot place it (C11): refused as a request fat-g cannot show is, with its notice. A
        // refusal the process does not take leaves the CLI waiting, so it is said and ends the process.
        holds.delete(requestId);
        approvalReleased(mapper, hold.owner, hold.toolUseId);
        if (await refuse({ requestId, subtype: TOOL_REQUEST, tool: true }, hold.reply, 1 + hold.repeats).catch(() => false)) return true;
        notTaken(hold);
        return false;
      }
      // A grant the request made no offer of is never sent as leave given once (C68): the process took nothing.
      if (choice === 'approve-session' && hold.grant === null) { approvalReleased(mapper, hold.owner, hold.toolUseId); notTaken(hold); return false; }
      // From the request as it came (C13, C69): its own input, unchanged, and for a session grant
      // the CLI's own rule at the session's scope, alone. A denial says who denied.
      const sent: ChatAnswer = choice === 'deny'
        ? { kind: 'deny', requestId, by: 'user' }
        : { kind: 'allow-action', requestId, tool: hold.tool, input: hold.input, grant: choice === 'approve-session' ? hold.grant : null };
      hold.sent = sent;
      approvalDecided(mapper, hold.owner, hold.toolUseId, choice === 'deny');
      return deliver(hold, sent);
    },
    async decidePlan(requestId, answer) {
      const hold = holds.get(requestId);
      // Main may name a request this session no longer holds: counted, and nothing is written.
      if (hold === undefined || hold.kind !== 'plan' || hold.sent !== null) { counts.plans.unheld += 1; return false; }
      if (answer === null) {
        // Main cannot place it (C11): refused as a request fat-g cannot show is, with its notice.
        holds.delete(requestId);
        planReleased(mapper, hold.toolUseId);
        if (await refuse({ requestId, subtype: TOOL_REQUEST, tool: true }, hold.reply, 1 + hold.repeats).catch(() => false)) return true;
        notTaken(hold);
        return false;
      }
      const turn = current;
      let sent: ChatAnswer;
      if (answer.kind === 'feedback') sent = { kind: 'plan-feedback', requestId, text: answer.text };
      else if (answer.kind === 'cancel') {
        // The user's end of the turn (C77): read as stopped, as a Stop's is, with no notice of a failure.
        if (turn?.mapped != null) turn.mapped.stopped = true;
        sent = { kind: 'plan-cancel', requestId };
      } else {
        // Execute (C7, C8, C11): the chat's mode armed before the write, which the CLI's status frame
        // names within milliseconds of it; from here the turn plans no longer.
        pending = { to: chatMode, named: false, commit: true };
        if (turn !== null) turn.plan = 'executed';
        sent = { kind: 'allow-action', requestId, tool: PLAN_TOOL, input: hold.input, grant: null };
      }
      hold.sent = sent;
      planDecided(mapper, hold.toolUseId);
      return deliver(hold, sent);
    },
    async close() {
      const turn = current;
      // A launch an aside waits for is cancelled, and every open aside ends with the session (M20b, C34).
      closing.abort();
      endAsides(true);
      // A request to act that is still undecided goes with the process this close ends (M22, C11, C12):
      // said dropped first, so that the end made below is never read as its turn's withdrawal of it. A
      // decided one is let go with no word, as at a loss; a question is left to its owner's end, as M21 has it.
      for (const hold of [...holds.values()]) {
        if (hold.kind === 'question' || hold.sent !== null) continue;
        holds.delete(hold.requestId);
        emit(resolved(hold, 'dropped'));
      }
      if (turn !== null) {
        turn.stop = true;
        turn.abort.abort();
        finish(turn, endWorkers(), 'interrupted', false);
        over = true;
        // A launch under way has a process to close: wait for it to be known.
        if (connection === null) await turn.running.catch(() => undefined);
      } else if (!over && mapper.workers.size > 0) emitAll(endWorkers());
      // A launch an aside asked for has a process to close too: wait for it to be known.
      if (connection === null && launching !== null) { over = true; await launching.catch(() => undefined); }
      return endProcess();
    },
    recheck: () => (connection !== null ? connection.recheck() : launchRecheck?.() ?? Promise.resolve({ ok: true })),
  };
}
