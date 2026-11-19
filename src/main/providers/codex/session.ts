// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One Codex session (docs/planning/_archive/M15.md, Design 6–8; C17, C20–C29, C34, C87, C89, C90, C100,
// C110, C116, C130–C133): a thread on an app-server of its own, behind the session facet. Nothing
// is launched until the first prompt. Every outcome is an event; nothing is sent twice, and no turn
// is started again.
//
//   unopened ─► launching ─► opening ─► sending ─► turn ─► ready ─► (next prompt) sending …
//                process      thread/start   turn/start   named
//                handshake    or resume      sent
//
// Whenever the process ends, by itself or because this module ended it, the session is over:
// `closed` resolves with whether its tree is confirmed gone, and the next prompt is another
// session's, which resumes the thread in a new process (C24).
//
// An answer is told as it is written (docs/planning/_archive/M19.md, Design 2; C7, C8): the handshake keeps
// the agent message's delta, and the mapper opens, grows and completes each message. An answer
// that was interrupted gets no whole message: what its deltas brought is the only copy.
//
// Two things are said for the conversation store (docs/planning/_archive/M18.md, Design 1, 4; C47, C59): a
// turn's start names Codex's own id for the turn, and a turn's end says whether Codex reported it.
// Only the end mapped from `turn/completed` is Codex's; every end this module makes itself — the
// end lost, the process gone, a Stop not confirmed, a start that failed or was cancelled, a close —
// is not.
//
// A question beside the thread (decision 0025; docs/planning/_archive/M20b.md, Design 4; C12, C19–C23, C69,
// C70). An aside has a side thread of its own on this same app-server: `thread/fork` of the
// session's thread through its newest ended turn, ephemeral and read-only as its parent is, told
// to act on nothing. Its reply is checked as a start's is before any turn. Each question is a
// `turn/start` on that side thread, whose frames come on this connection and are the aside's alone.
//
//   ask ─► [launch and thread, if none] ─► fork, if the aside has no side thread ─► turn/start ─► its turn
//                                           checked as a start's                    named
//
// A follow-up goes to the side thread while it lives. One this process does not have — the first,
// or the first after the process ended, since an ephemeral thread cannot be resumed — is forked
// anew, and its question then carries the aside's earlier exchanges (C22).
//
// Its Stop holds the aside alone (C70): `turn/interrupt` on the side thread's turn, once that turn
// is named and started, on a clock of its own. Before that nothing more is sent, and what comes is
// dropped; an interrupt that is not confirmed ends the aside here. The process is never ended for
// an aside, and the session's own Stop interrupts no side thread.
//
// A question asked as a request (decision 0026; docs/planning/_archive/M21.md, Design 4; C11, C14, C23, C27,
// C59, C60, C65–C67, C70, C75). `item/tool/requestUserInput` is the one request answered when its
// answer comes, and not at once. It is held as it came, in memory alone, under its owner — the
// session's turn, or the worker whose thread asked — and told as `question-raised`. Its reply is
// the user's answer and grants nothing: every approval is declined, and every other request
// refused, as before.
//
//   request ─► no one's, or one fat-g cannot show ─► "method not found", counted, with the notice
//           ─► held ─► an answer ─────────────────► its reply written; `confirmed` at Codex's word
//                   ─► main refuses it ───────────► "method not found", counted, with the notice
//                   ─► Codex's word, unanswered ──► `withdrawn`: Codex took it back
//                   ─► its owner's end ───────────► let go, with no event: main sweeps at that end
//                   ─► the process's end ─────────► `dropped`, said before any end made here
//
// A reply the process did not take is said `dropped`, whatever has happened meanwhile, and ends the
// process: Codex would wait on a reply that never comes. Nothing else says so of an answered
// request, which the process's end lets go.
//
// What the session may do (decision 0027; docs/planning/_archive/M22.md, Design 3, 4, 7, 8; C4, C7, C13, C21,
// C64, C67–C71, C76, C84, C91). Its process runs under one mode, from its start to its end
// (modes.ts): the start and the resume name the mode's sandbox, approval policy and — where the
// policy asks someone — reviewer, the reply is held to all three before any prompt, and each
// `turn/start` of the session's thread names again what that reply reported, and never another. A
// reply that reports another is a start that failed, with what it reported; one that is as asked is
// told as `in-force`. A mode is never changed on a live thread: main closes this session and resumes
// in a fresh process. An aside's fork and its turns are as they were (C84).
//
// The two requests for leave — a command, a file change — are held as a question is, under every
// mode but Read only, which declines each at once as before:
//
//   request ─► no one's, or one fat-g cannot show whole ─► "method not found", counted, with the
//           │                                              notice — naming the size, where a bound is why
//           ─► held ─► a decision ───────────────────► `accept`, `acceptForSession` or `decline`
//                   │                                  written; `confirmed` at Codex's word
//                   ─► main refuses it ──────────────► "method not found", counted, with the notice
//                   ─► the same id, another payload ─► refused, the hold let go: `changed` (C91)
//                   ─► Codex's word, undecided ──────► `withdrawn`
//                   ─► its owner's end ──────────────► let go, with no event
//                   ─► the process's end, a close ───► `dropped`, said before any end made here
//
// A file change's request names no file: the session keeps each `fileChange` item's changes as they
// came, by the item's id, from its start to its end, and shows the request from that. A request
// under an id that is held is compared with the hold, whole, before it is counted as a repeat: a
// question's too, since the hold is one for both kinds.
//
// A line over the limit (C67, C71) is read for its kind and its request id and nothing else
// (session-process.ts). A request so read is refused by its id, and the turn goes on. One that is or
// may be a request, with no id to answer, would leave Codex waiting on something this session
// cannot name: everything running here is stopped, each by its own Stop.
//
// How full the context window is (decision 0033): each thread's token report, read beside the
// mapper for the session's own thread alone — a sub-agent's and a side thread's are their own
// contexts — and said where it changed. It goes to the summary alone.
import type { AgentEvent, RefusedBound, StartStep, TurnFailure } from '@shared/contracts/agent-events';
import { ASIDE_INSTRUCTIONS, withEarlier } from '@shared/contracts/aside';
import type { SteerState } from '@shared/contracts/composer';
import { type ApprovalChoice, boundQuestions, canShow, type GivenAnswer, NO_ANSWER } from '@shared/contracts/interaction';
import { type ContextReading, sameContext } from '@shared/contracts/sessions';
import type { ProviderContext } from '@shared/provider-kit/context';
import { FRAME_DROP_REASONS, type FrameDropReason } from '@shared/provider-kit/logger';
import type { PeekedLine } from '@shared/provider-kit/ndjson';
import { ProcessFailure, type CleanupResult, type Executable } from '@shared/provider-kit/process';
import { METHOD_NOT_FOUND, type OpenConnection, type RequestId, type RequestReply } from '@shared/provider-kit/rpc';
import type { AsideRequest, ProviderSession, SessionStart, SteerOutcome, SteerRequest, TurnRequest } from '@shared/provider-kit/sessions';
import { buildApproval, buildMcpApproval, decisionOf, elicitationOf } from './approvals';
import { APPROVAL_REQUESTS, MCP_ELICITATION, MISSING_THREAD_CODE, QUESTION_REQUEST, refusedMethod, sendRequest, STALE_STEER_CODE } from './methods';
import { checkPolicy, type CodexModeId, modeOfStart, type PolicyCheck, type ReportedPolicy, startPolicy, type TurnPolicy } from './modes';
import { openSessionProcess, type SessionTimings } from './session-process';
import { isMcpApproval, type RawChange, type RawMcpCall, rawQuestions, type TakenMcpApproval, type TakenQuestionRequest, takeApprovalRequest, takeFileChange, takeItemId, takeMcpCall, takeQuestionRequest, takeRequestId, takeStartReply, takeSteerReply, takeThreadId, takeTokenUsage, takeTurnStartReply } from './session-schemas';
import { expireWorker, failWorkers, mapFrame, MAPPED_METHODS, type MappedMethod, type MapperAside, type MapperState, newAside, newTurn, REVIEW_METHODS, TOKEN_USAGE } from './turn-mapper';
import type { PromptAttachment } from '@shared/provider-kit/sessions';

/**
 * A prompt's input as `turn/start` takes it (M23, C21, C24; K1): the text item, where there is text,
 * and one `localImage` item per image naming the path main handed over — a file in fat-g's own images'
 * folder, which the app-server reads itself. Nothing of the image's bytes is sent from here.
 */

/**
 * The `serviceTier` a start or a turn sends (decision 0018): the tier's id, or `default` — Codex's name
 * for standard speed — where the session asks for none. A null would keep whatever tier the thread had.
 */
export const serviceTierOf = (speed: string | null): string => speed ?? 'default';

export function promptInput(text: string, attachments: readonly Pick<PromptAttachment, 'path'>[]): unknown[] {
  return [
    ...(text === '' && attachments.length > 0 ? [] : [{ type: 'text', text, text_elements: [] }]),
    ...attachments.map((attachment) => ({ type: 'localImage', path: attachment.path })),
  ];
}

/** How many frames wait for the `turn/start` reply to name the turn (C110). */
export const MAX_HELD_FRAMES = 256;
/** How many open `fileChange` items' changes are kept for a request to name (M22, C9): the newest. One a request names and the session no longer holds is refused. */
export const MAX_HELD_CHANGES = 16;
/** How many open `mcpToolCall` items are kept (decision 0018). Overflow makes the incoming call's thread unplaceable until its owner ends: no live call is evicted to guess from those left. */
export const MAX_HELD_CALLS = 16;

export interface SessionTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface CodexSessionOptions {
  readonly context: ProviderContext;
  /** A chosen skill, by its selector, as the facet's last listing holds it (M23, C64, C87): null for one no longer listed. */
  readonly skillOf?: (selector: string) => { readonly name: string; readonly path: string } | null;
  /** The executable the instance's detection found, or undefined before it has. */
  readonly executable: () => Executable | undefined;
  readonly argsPrefix: readonly string[];
  readonly applicationVersion: string;
  readonly timings: SessionTimings;
  readonly start: SessionStart;
  /** A thread to resume, or null for a session not yet started. */
  readonly reference: string | null;
  readonly timers?: SessionTimers;
  /**
   * Told of each start and resume reply as it is held to the session's mode (M22, C4, C65): what it
   * reported, and whether that is the mode's. The account's availability is read from these.
   */
  readonly onChecked?: (mode: CodexModeId, reported: ReportedPolicy, check: PolicyCheck) => void;
  /**
   * Whether this account's CLI refused what a plan turn needs, in this run (M22b, C13, C80): its
   * handshake then leaves the experimental API out, and no turn names a collaboration mode.
   */
  readonly plansRefused?: () => boolean;
  /** Told that the CLI refused it — the handshake that asks for the experimental API, or a turn that names a collaboration mode. */
  readonly onPlansRefused?: () => void;
}

/** Counts and kinds only (C75): what was dropped, by reason, and what was refused, by method. */
export interface SessionCounts {
  readonly dropped: Record<FrameDropReason, number>;
  /** Notifications of methods the adapter does not map: never parsed (C37). */
  unmapped: number;
  readonly refused: Record<string, number>;
  /**
   * Questions asked as requests (M21, C34), by what happened and never by what was asked: a second
   * delivery of one that is held; an answer, or Codex's word that a request is over, that named
   * none held; and a reply the process did not take.
   */
  readonly questions: { repeated: number; unheld: number; unwritten: number };
  /** Requests for leave (M22, C26), counted as questions are: a second delivery of one that is held, a decision that named none held, and a reply the process did not take. */
  readonly approvals: { repeated: number; unheld: number; unwritten: number };
  /** Requests that came again under a held id with another payload, of either kind (M22, C91). */
  changed: number;
  /** Lines over the limit that were or may have been a request (M22, C67, C71): refused by the id read from them, or — with none — answered by stopping everything that ran. */
  readonly oversized: { refused: number; stopped: number };
  /** The frames of Codex's own reviewer (M22, C96): counted, and mapped to nothing. */
  reviews: number;
  /** Token reports (decision 0033): those read as the thread's context, and those skipped — another thread's, a sub-agent's or a side thread's, or one that could not be read. */
  readonly context: { read: number; skipped: number };
}

export interface CodexSession extends ProviderSession {
  readonly counts: SessionCounts;
  /** Codex's sessions take an answer (M21, C30): its descriptor says `questions: 'both'`. */
  answer(requestId: string, answers: readonly GivenAnswer[] | null): void;
  /** And a skip (M22b, C53): its descriptor says `declines`. */
  decline(requestId: string): void;
  /** And a decision (M22, C13): its descriptor declares modes that ask. */
  decide(requestId: string, choice: ApprovalChoice | null): Promise<boolean>;
  /** And a question beside the session (M20b, C24): its descriptor declares asides. */
  ask(aside: AsideRequest): void;
  stopAside(asideId: string): void;
  /** And a message into the running turn (M23, C36): `turn/steer`. */
  steerState(): SteerState;
  steer(request: SteerRequest): Promise<SteerOutcome>;
}

interface Turn {
  readonly request: TurnRequest;
  /** Cancels the start, while nothing of the turn has been sent (C27). */
  readonly abort: AbortController;
  /** A Stop was pressed. */
  stop: boolean;
  interrupted: boolean;
  stopTimer: unknown;
  lostEndTimer: unknown;
  running: Promise<void>;
}

interface HeldFrame { readonly method: MappedMethod; readonly params: unknown }
/** What waits for the session's `turn/start` reply to name the turn (C110): a frame, or a request — a question's (M21), or one for leave (M22) — that came with them. */
type Waiting = HeldFrame | { readonly asked: RequestId; readonly method: string; readonly params: unknown };

/** Whose a held request is (M21, C65): the session's turn, by the runtime's id for it, or a worker, with the turn that started it. */
type HoldOwner = { readonly turnId: string; readonly workerId?: string };

/** A request, held as it came until it is answered or abandoned (M21, C59, C65; M22, C10, C91): a question's, or one for leave. */
type Hold = {
  /** The request's own id, as it came: what its reply names. The hold's key is that id, lossless (C10). */
  readonly id: RequestId;
  readonly method: string;
  /** As it came, whole: what a second delivery under its id is compared with (C91). */
  readonly params: unknown;
  readonly owner: HoldOwner;
  /** Its reply has been written, or is being: Codex's word then confirms it (C63), and the process's end lets it go (C70). */
  answered: boolean;
} & (
  /** As it came: the answer is encoded from this, never from what the card draws (C59). */
  | { readonly kind: 'question'; readonly raw: TakenQuestionRequest }
  /**
   * The choices its view listed, and the item it asks for: no other choice is ever written (C69).
   * `answer`: Codex's decision for a command or a file change, the elicitation's words for an MCP tool.
   */
  | { readonly kind: 'approval'; readonly choices: readonly ApprovalChoice[]; readonly itemId: string; readonly answer: 'decision' | 'elicitation' }
);

/** What became of a request that was looked at: held for its reply, or to be refused — for a size, where `over` names one (C9, C48). */
type Taken = 'held' | { readonly over: { readonly bound: RefusedBound; readonly size: number } | null };
const NOT_HELD: Taken = { over: null };

/** Whether two values of a frame are the same (C91): by what they hold, whatever order their keys came in. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  const [left, right] = [a as Record<string, unknown>, b as Record<string, unknown>];
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** What a request fat-g does not take is told (C48): the method is none it has, which is no cancellation. */
const NOT_TAKEN: RequestReply = { error: METHOD_NOT_FOUND };

/**
 * An answer as Codex takes it (M21, C23, C59): each question's own id to its `answers`, the whole
 * label of each chosen option by its place in the request as it came, and the typed text after
 * them as a string of its own.
 */
function encodeAnswers(request: TakenQuestionRequest, answers: readonly GivenAnswer[]): Record<string, { answers: string[] }> {
  return Object.fromEntries(request.questions.map((question, place) => {
    const given = answers[place];
    const labels = (given?.options ?? []).flatMap((option) => { const label = question.options[option]?.label; return label === undefined ? [] : [label]; });
    const text = given?.text ?? null;
    return [question.id, { answers: text === null || text === '' ? labels : [...labels, text] }];
  }));
}

/** One question of an aside, from its ask to its one end (M20b, C20). */
interface AsideTurn {
  readonly request: AsideRequest;
  /** Its Stop was pressed. */
  stop: boolean;
  /** Its end has been said: nothing more of it is. */
  done: boolean;
  stopTimer: unknown;
  /** The side thread's mapping for this turn, from its `turn/start` being sent. */
  mapped: MapperAside | null;
  /** Its side thread's frames, held from `turn/start` being sent until its reply names the turn (C110). */
  held: HeldFrame[] | null;
}

/** An aside, as this process holds it (M20b, C19, C22). */
interface Aside {
  /** Its side thread, once forked; null before, and again once a turn of it was stopped or given up without Codex's word. */
  threadId: string | null;
  turn: AsideTurn | null;
}

/** A start that failed after the prompt was accepted (C87): its step, and what the chat is told. `detail` (M22, C46): with `policy-mismatch`, what the reply reported. */
class StartFailure extends Error {
  constructor(readonly step: StartStep, readonly kind: 'start-failed' | 'not-read-only' | 'session-not-reopened' | 'policy-mismatch' = 'start-failed', readonly detail: string | null = null) { super(kind); }
}

/** The notice of a start that failed (C87; M22, C46): its step where the start itself failed, and what the reply reported where the policy is why. */
function failureNotice(failure: StartFailure, turnId: string, asideId?: string): AgentEvent {
  return { type: 'notice', kind: failure.kind, turnId, ...(asideId === undefined ? {} : { asideId }), ...(failure.kind === 'start-failed' ? { step: failure.step } : {}), ...(failure.detail === null ? {} : { detail: failure.detail }) };
}

const defaultTimers: SessionTimers = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function createCodexSession(options: CodexSessionOptions): CodexSession {
  const { context, timings } = options;
  const timers = options.timers ?? defaultTimers;
  const listeners = new Set<(event: AgentEvent) => void>();
  const counts: SessionCounts = {
    dropped: Object.fromEntries(FRAME_DROP_REASONS.map((reason) => [reason, 0])) as Record<FrameDropReason, number>, unmapped: 0, refused: {},
    questions: { repeated: 0, unheld: 0, unwritten: 0 }, approvals: { repeated: 0, unheld: 0, unwritten: 0 }, changed: 0, oversized: { refused: 0, stopped: 0 }, reviews: 0, context: { read: 0, skipped: 0 },
  };
  /** The mode this process runs under, from its start to its end (M22, C2, C64). */
  const mode = modeOfStart(options.start.mode);
  /** What the thread's start or resume reply reported, once held to the mode: what each turn names again (C7). */
  let policy: TurnPolicy | null = null;
  const mapper: MapperState = { threadId: '', turn: null, workers: new Map(), asides: new Map(), denied: new Set() };
  const workerTimers = new Map<string, unknown>();
  /** The asides this process has answered, or is answering, by main's id for each (M20b, C19). */
  const asides = new Map<string, Aside>();
  /** The requests that wait for an answer, a decision or Codex's word, by the request's lossless id, as an event names it (M21, C59, C65; M22, C10). */
  const holds = new Map<string, Hold>();
  /** The open `fileChange` items' changes as they came, by item id, each with its thread (M22, C9): what a request that names the item is shown from. */
  const changes = new Map<string, { readonly threadId: string; readonly changes: readonly RawChange[] }>();
  /**
   * The open `mcpToolCall` items as they started, by item id (decision 0018): Codex's leave to run one
   * names its server and arguments, never the item. `asked` once a request was placed on it.
   */
  const calls = new Map<string, RawMcpCall & { asked: boolean }>();
  /** Active threads whose calls exceeded the bound: none can be placed from an incomplete set. Cleared with their owner. */
  const incompleteCalls = new Set<string>();
  /** The one opening of this session's process and thread, whoever asked for it first: a turn, or an aside (M20b, C10). */
  let opening: Promise<OpenConnection> | null = null;
  /** Cancels an opening an aside asked for, when the session is closed. A Stop of an aside's never cancels it (C70). */
  const closing = new AbortController();

  let connection: OpenConnection | null = null;
  /** The thread, once this process has started or resumed it. */
  let threadOpen = false;
  /** This process's handshake asked for the experimental API, and got it (M22b, C13, C80). */
  let experimental = false;
  let reference = options.reference;
  /** The record holds the reference already, or will from the first turn's start (C130). */
  let referenceReported = options.reference !== null;
  let current: Turn | null = null;
  /** Told when a turn ends (M23, C39): what a steer Codex refused waits on, to know whether its turn was over. */
  const turnEnds = new Set<() => void>();
  /** Frames held from `turn/start` being sent until its reply names the turn (C110). */
  let held: Waiting[] | null = null;
  let refusedNoticed = false;
  /** The last context reading said (decision 0033), null until one is. */
  let reading: ContextReading | null = null;
  let over = false;
  let ending: Promise<CleanupResult> | null = null;
  let resolveClosed: (result: CleanupResult) => void = () => undefined;
  const closed = new Promise<CleanupResult>((resolve) => { resolveClosed = resolve; });

  /** A hold goes with its owner (M21, C65): let go with no reply and no event, main's sweep at that end settling its card. */
  function abandon(owned: (owner: HoldOwner) => boolean): void {
    for (const [requestId, hold] of [...holds]) if (owned(hold.owner)) holds.delete(requestId);
  }

  /** MCP calls and any overflow go with their owner, even when no item/completed came. */
  function forgetCalls(threadId: string): void {
    for (const [itemId, call] of calls) if (call.threadId === threadId) calls.delete(itemId);
    incompleteCalls.delete(threadId);
  }

  /** The content kept of a thread's open items goes with what ran on it (M22, C9): its turn, or the worker. */
  function forget(threadId: string): void {
    for (const [itemId, item] of [...changes]) if (item.threadId === threadId) changes.delete(itemId);
    forgetCalls(threadId);
  }

  function emit(event: AgentEvent): void {
    // A worker's end, however it came — its frames, its clock, a Stop, a loss — takes what the worker still asked.
    if (event.type === 'worker-ended') { abandon((owner) => owner.workerId === event.workerId); forget(event.workerId); }
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* a listener's failure is its own */ }
    }
  }
  const emitAll = (events: readonly AgentEvent[]): void => { for (const event of events) emit(event); };

  function drop(reason: FrameDropReason): void {
    counts.dropped[reason] += 1;
    context.logger.record({ type: 'frame-dropped', reason });
  }

  function clearWorkerTimers(): void {
    for (const handle of workerTimers.values()) timers.clear(handle);
    workerTimers.clear();
  }

  function clearTurnTimers(turn: Turn): void {
    timers.clear(turn.stopTimer); turn.stopTimer = undefined;
    timers.clear(turn.lostEndTimer); turn.lostEndTimer = undefined;
  }

  /**
   * The turn's one end. `before` goes out first: the workers that end with it, and its notice.
   * `reported` is whose end it is (M18, C59): true for the one Codex gave with `turn/completed`,
   * false for one made here because that word never came.
   */
  function finish(turn: Turn, before: readonly AgentEvent[], outcome: 'completed' | 'interrupted' | 'failed', reported: boolean, failure?: TurnFailure): boolean {
    if (current !== turn) return false;
    current = null;
    held = null;
    clearTurnTimers(turn);
    if (mapper.turn?.runtimeId === turn.request.turnId) { mapper.turn.ended = true; mapper.turn.actions.clear(); }
    for (const told of [...turnEnds]) told();
    // What the turn itself still asked goes with it, whatever its end (M21, C65): a worker's stays while the worker runs.
    abandon((owner) => owner.workerId === undefined && owner.turnId === turn.request.turnId);
    forget(mapper.threadId);
    emitAll(before);
    emit({ type: 'turn-ended', turnId: turn.request.turnId, outcome, reported, ...(failure === undefined ? {} : { failure }) });
    return true;
  }

  /** Every open worker ended as failed (C90). */
  function endWorkers(): AgentEvent[] {
    clearWorkerTimers();
    return failWorkers(mapper);
  }

  /** Ends the session's process. The session is over: `closed` resolves once the tree has been looked at. */
  function endProcess(): Promise<CleanupResult> {
    ending ??= (async () => {
      over = true;
      clearWorkerTimers();
      const result = connection === null ? { ok: true } : await connection.close();
      resolveClosed(result);
      return result;
    })();
    return ending;
  }

  // ── Asides (M20b, C12, C19–C23, C70) ──────────────────────────────────────────────────────
  /** An aside's one end. `before` goes out first: its notice. `reported`: Codex's own `turn/completed` of the side thread. */
  function finishAside(asideId: string, turn: AsideTurn, before: readonly AgentEvent[], outcome: 'completed' | 'interrupted' | 'failed', reported: boolean, failure?: TurnFailure): boolean {
    if (turn.done) return false;
    turn.done = true;
    timers.clear(turn.stopTimer); turn.stopTimer = undefined;
    turn.held = null;
    // Whatever still comes of that turn is dropped, and counted (C70).
    if (turn.mapped !== null) turn.mapped.ended = true;
    const aside = asides.get(asideId);
    if (aside?.turn === turn) aside.turn = null;
    emitAll(before);
    emit({ type: 'turn-ended', turnId: turn.request.turnId, asideId, outcome, reported, ...(failure === undefined ? {} : { failure }) });
    return true;
  }

  /**
   * The aside's side thread is given up (C70): a turn of it was stopped, or ended here, without
   * Codex's word, so what it is doing is not known. Its later frames are dropped, and the aside's
   * next question forks anew.
   */
  function giveUpThread(asideId: string): void {
    const aside = asides.get(asideId);
    if (aside !== undefined) aside.threadId = null;
  }

  /** Every open aside ends with the process (C34, C70): interrupted where its Stop was pressed or the session was closed, else lost. An end of the session's own. */
  function endAsides(closed: boolean): void {
    for (const [asideId, aside] of [...asides]) {
      const { turn } = aside;
      if (turn !== null) {
        if (turn.stop || closed) finishAside(asideId, turn, [], 'interrupted', false);
        else finishAside(asideId, turn, [{ type: 'notice', kind: 'connection-lost', turnId: turn.request.turnId, asideId }], 'failed', false, 'connection-lost');
      }
    }
    // The side threads went with the process: none can be asked again (C22).
    asides.clear();
  }

  // ── Requests from the CLI: nothing is granted that the user did not (C34, C106; M22, C59) ──
  /** `over` (M22, C9, C48): the bound the request was past, where a size is why. Such a refusal names it each time; any other is said once a turn (C34). */
  function refused(method: string, over: { readonly bound: RefusedBound; readonly size: number } | null = null): void {
    const name = refusedMethod(method);
    counts.refused[name] = (counts.refused[name] ?? 0) + 1;
    context.logger.record({ type: 'request-refused', method: name });
    const named = current === null ? {} : { turnId: current.request.turnId };
    if (over !== null) { emit({ type: 'notice', kind: 'request-refused', ...named, bound: over.bound, size: over.size }); return; }
    if (refusedNoticed) return;
    refusedNoticed = true;
    emit({ type: 'notice', kind: 'request-refused', ...named });
  }

  // ── A request held until its answer comes: a question (M21, C23, C59, C65), or leave for an action (M22, C8, C13) ──
  /**
   * The process cannot be told something it waits for (C14, C66), so it is ended, and its loss ends
   * what ran on it: the turn, with its notice, where one runs; and the workers left after one here,
   * since nothing else would say so of them (C100).
   */
  function lose(): void {
    if (over) return;
    if (current === null && mapper.workers.size > 0) emitAll([...endWorkers(), { type: 'notice', kind: 'workers-lost' }]);
    void endProcess();
  }

  /**
   * A reply given later, through the connection (C66), whose promise is the write's. One the
   * process did not take — it refused the line, or had ended — is said `dropped`, whatever has
   * become of the request and of the process meanwhile: main, which keeps an answered request to
   * its handle's close, then knows the answer never reached Codex (C14, C75). The promise says which
   * (M22, C12, C92): true once the write went, false where the process did not take it. It never rejects.
   */
  function write(requestId: string, hold: Hold, reply: RequestReply): Promise<boolean> {
    const written = connection === null ? Promise.reject(new ProcessFailure('transport-closed')) : connection.reply(hold.id, reply);
    return written.then(() => true, () => {
      (hold.kind === 'question' ? counts.questions : counts.approvals).unwritten += 1;
      if (holds.get(requestId) === hold) holds.delete(requestId);
      emit({ type: hold.kind === 'question' ? 'question-resolved' : 'approval-resolved', requestId, reason: 'dropped' });
      lose();
      return false;
    });
  }

  /**
   * Whose a request is, where it is anyone's (C11, C65). A worker's thread that is still open: that
   * worker's, whatever the session's turn, since a worker runs on after its turn (M20a, K3). The
   * session's own thread: its turn's, where the request names the turn in flight. Any other is no
   * one's: the session's own while no turn is current, another turn's, a side thread's.
   */
  function ownerOf(request: { readonly threadId: string; readonly turnId: string }): HoldOwner | null {
    const worker = mapper.workers.get(request.threadId);
    if (worker !== undefined) return { turnId: worker.startedIn, workerId: request.threadId };
    const turn = mapper.turn;
    if (request.threadId !== mapper.threadId || current === null || turn === null || turn.ended || turn.runtimeId !== current.request.turnId || request.turnId !== turn.cliId) return null;
    return { turnId: turn.runtimeId };
  }

  /** MCP correlation requires a known, live turn, including on a worker: late or unowned frames cannot seed its cache. */
  function ownsMcpTurn(call: { readonly threadId: string; readonly turnId: string }): boolean {
    const worker = mapper.workers.get(call.threadId);
    if (worker !== undefined) return worker.turnId === call.turnId && worker.turnEnd === null && worker.closing === null;
    return ownerOf(call) !== null;
  }

  /** One request, as it is decided: held for its owner's reply, or to be refused. */
  function take(method: string, params: unknown, id: RequestId | null): Taken {
    const requestId = takeRequestId(id);
    if (over || id === null || requestId === null) return NOT_HELD;
    const existing = holds.get(requestId);
    if (existing !== undefined) {
      // A second delivery under a held id is compared with the hold before anything else (M22, C91).
      // The same request again (C11, C65): counted, and answered by the one reply its id names.
      if (existing.method === method && sameValue(existing.params, params)) { (existing.kind === 'question' ? counts.questions : counts.approvals).repeated += 1; return 'held'; }
      // Another payload: refused under that id, and the first is let go — its card is withdrawn as
      // changed, and nothing of the second is shown, stored or kept.
      holds.delete(requestId);
      counts.changed += 1;
      emit({ type: existing.kind === 'question' ? 'question-resolved' : 'approval-resolved', requestId, reason: 'changed' });
      return NOT_HELD;
    }
    if (method === QUESTION_REQUEST) {
      const request = takeQuestionRequest(params);
      if (request === null) return NOT_HELD;
      const owner = ownerOf(request);
      const raw = rawQuestions(request);
      // No one's, or one fat-g cannot show whole, a question nothing could answer among them (C60, C78).
      if (owner === null || !canShow(raw)) return NOT_HELD;
      // Held before it is told: main may refuse it from inside this very event (C11, C30).
      holds.set(requestId, { kind: 'question', id, method, params, raw: request, owner, answered: false });
      const bound = boundQuestions(raw);
      emit({ type: 'question-raised', turnId: owner.turnId, ...(owner.workerId === undefined ? {} : { workerId: owner.workerId }), requestId, sourceId: request.itemId, questions: bound.questions, cut: bound.cut });
      return 'held';
    }
    // Leave for an action (M22, C8): a command's request holds the action; a file change's names the
    // item that does; an MCP tool's names neither, and is placed on the call it asks for (decision 0018).
    const request = takeApprovalRequest(method, params);
    if (request === null) return NOT_HELD;
    const owner = ownerOf(request);
    if (owner === null) return NOT_HELD;
    let itemId: string;
    let built: ReturnType<typeof buildApproval>;
    if (request.kind === 'mcp-tool') {
      const call = placeCall(request);
      if (call === null) return NOT_HELD;
      itemId = call.itemId;
      built = buildMcpApproval(request, call);
    } else {
      itemId = request.itemId;
      const item = changes.get(itemId);
      built = buildApproval(request, item !== undefined && item.threadId === request.threadId ? item.changes : undefined);
    }
    // One fat-g cannot show whole is refused, never shown cut (C9, C48).
    if (!built.ok) return { over: built.over };
    holds.set(requestId, { kind: 'approval', id, method, params, owner, answered: false, choices: built.request.choices, itemId, answer: request.kind === 'mcp-tool' ? 'elicitation' : 'decision' });
    emit({ type: 'approval-raised', turnId: owner.turnId, ...(owner.workerId === undefined ? {} : { workerId: owner.workerId }), requestId, sourceId: itemId, request: built.request });
    return 'held';
  }

  /**
   * The call Codex's leave to run an MCP tool is for (decision 0018): the open call of its thread and
   * turn with its server and arguments that nothing was asked for yet, the oldest where several are alike. Null
   * where there is none, or where such calls name different tools: the request cannot be placed, and
   * is refused. The tool's name is in the request's sentence alone, which is never read.
   */
  function placeCall(request: TakenMcpApproval): RawMcpCall | null {
    if (incompleteCalls.has(request.threadId) || !ownsMcpTurn(request)) return null;
    const alike = [...calls.values()].filter((call) => !call.asked && call.threadId === request.threadId && call.turnId === request.turnId && call.server === request.server && sameValue(call.arguments, request.params));
    const [first] = alike;
    if (first === undefined || alike.some((call) => call.tool !== first.tool)) return null;
    first.asked = true;
    return first;
  }

  /**
   * A request that is held when its answer comes, and not at once (M21, C23; M22, C8): null where
   * it is held and its reply comes later, else its refusal, written at once — refused as every
   * request fat-g does not answer is (C11, C48), counted under its method, with the notice, and no event.
   */
  function asked(method: string, params: unknown, id: RequestId | null): RequestReply | null {
    // While the session's `turn/start` waits for its reply, whose a request is cannot be said: it
    // waits with the frames, in the order it came, and is decided once the turn is named (C110).
    if (held !== null && id !== null && !over) {
      if (held.length >= MAX_HELD_FRAMES) { drop('held-overflow'); refused(method); return NOT_TAKEN; }
      held.push({ asked: id, method, params });
      return null;
    }
    const taken = take(method, params, id);
    if (taken === 'held') return null;
    refused(method, taken.over);
    return NOT_TAKEN;
  }

  /** Codex says a request of its own is over (C23, C27, C63). */
  function requestResolved(requestId: string): void {
    const hold = holds.get(requestId);
    // None held: a request that was declined at once, one whose owner has ended, or one refused.
    if (hold === undefined) { counts.questions.unheld += 1; return; }
    holds.delete(requestId);
    // After its reply, Codex's word that it took the answer or the decision; with none written, Codex
    // took the request back while its owner runs, and nothing is written for it.
    emit({ type: hold.kind === 'question' ? 'question-resolved' : 'approval-resolved', requestId, reason: hold.answered ? 'confirmed' : 'withdrawn' });
  }

  /**
   * The changes of a `fileChange` item, kept as they came from its start to its end (M22, C9, C48):
   * its request for leave names no file. And an `mcpToolCall` item's server, tool and arguments, for the
   * leave to run it, which names no item (decision 0018). Under Read only nothing asks, and nothing is kept.
   */
  function noteItem(method: MappedMethod, params: unknown): void {
    if (mode === 'read-only') return;
    if (method === 'item/started') {
      const item = takeFileChange(params);
      if (item !== null) {
        // The newest are kept: an item is asked for as it starts.
        if (!changes.has(item.itemId) && changes.size >= MAX_HELD_CHANGES) { const [oldest] = changes.keys(); if (oldest !== undefined) changes.delete(oldest); }
        changes.set(item.itemId, { threadId: item.threadId, changes: item.changes });
        return;
      }
      const call = takeMcpCall(params);
      if (call === null || !ownsMcpTurn(call) || incompleteCalls.has(call.threadId) || calls.has(call.itemId)) return;
      if (calls.size >= MAX_HELD_CALLS) {
        // The request names no item or tool field. Dropping one call could make another tool look
        // like the only match, so this thread cannot place another request until its owner ends.
        forgetCalls(call.threadId);
        incompleteCalls.add(call.threadId);
        return;
      }
      calls.set(call.itemId, { ...call, asked: false });
    } else if (method === 'item/completed' && (changes.size > 0 || calls.size > 0)) {
      const itemId = takeItemId(params);
      if (itemId !== null) changes.delete(itemId);
      const call = takeMcpCall(params);
      const kept = call === null ? undefined : calls.get(call.itemId);
      if (call !== null && kept?.threadId === call.threadId && kept.turnId === call.turnId) calls.delete(call.itemId);
    }
  }

  // ── Frames ────────────────────────────────────────────────────────────────────────────────
  function interrupts(): void {
    const turn = mapper.turn;
    if (connection === null || turn === null) return;
    const send = (threadId: string, turnId: string): void => { void sendRequest('session', connection as OpenConnection, 'turn/interrupt', { threadId, turnId }, { timeoutMs: timings.stopMs }).catch(() => { /* left to the Stop's own clock (C131) */ }); };
    send(mapper.threadId, turn.cliId);
    // An interrupt leaves a worker's own turn running: each open worker's turn gets its own (C132).
    for (const [workerId, worker] of mapper.workers) if (worker.turnId !== null) send(workerId, worker.turnId);
  }

  function handle(method: MappedMethod, params: unknown): void {
    noteItem(method, params);
    const mapped = mapFrame(mapper, method, params);
    if (mapped.drop !== null) drop(mapped.drop);
    emitAll(mapped.events);
    for (const effect of mapped.effects) {
      const turn = current;
      switch (effect.type) {
        case 'turn-started':
          // Codex keeps a thread from its first turn's start and no sooner, so the reference is reported here (C130).
          if (!referenceReported && reference !== null) { referenceReported = true; emit({ type: 'session-started', reference, folder: options.start.folder }); }
          // The turn can be interrupted from now on, and not before (C131).
          if (turn?.stop && !turn.interrupted) { turn.interrupted = true; interrupts(); }
          break;
        case 'turn-ended':
          if (turn === null) break;
          // Codex's own `turn/completed`: the one end that is reported (M18, C59).
          if (effect.status === 'failed') finish(turn, [{ type: 'notice', kind: 'turn-failed', turnId: turn.request.turnId, ...(effect.detail === null ? {} : { detail: effect.detail }) }], 'failed', true, 'turn-failed');
          // A turn that ends by Stop takes its open workers with it (C90).
          else finish(turn, turn.stop || effect.status === 'interrupted' ? endWorkers() : [], effect.status, true);
          break;
        case 'aside-turn-ended': {
          // The side thread's own `turn/completed`: the one end of an aside that is reported (C20).
          const owner = [...asides].find(([, aside]) => aside.threadId === effect.threadId);
          const asideTurn = owner?.[1].turn ?? null;
          if (owner === undefined || asideTurn === null) break;
          const [asideId] = owner;
          if (effect.status === 'failed') finishAside(asideId, asideTurn, [{ type: 'notice', kind: 'turn-failed', turnId: asideTurn.request.turnId, asideId, ...(effect.detail === null ? {} : { detail: effect.detail }) }], 'failed', true, 'turn-failed');
          else finishAside(asideId, asideTurn, [], effect.status, true);
          break;
        }
        case 'inactive':
          // The turn's end may never arrive: an answer over the line limit takes it with it (C89).
          if (turn === null || mapper.turn === null || mapper.turn.ended || mapper.turn.runtimeId !== turn.request.turnId || turn.lostEndTimer !== undefined) break;
          turn.lostEndTimer = timers.set(() => {
            turn.lostEndTimer = undefined;
            if (turn.stop) finish(turn, endWorkers(), 'interrupted', false);
            else finish(turn, [...endWorkers(), { type: 'notice', kind: 'output-lost', turnId: turn.request.turnId }], 'failed', false, 'end-lost');
          }, timings.lostEndMs);
          break;
        case 'active':
          if (turn !== null && turn.lostEndTimer !== undefined) { timers.clear(turn.lostEndTimer); turn.lostEndTimer = undefined; }
          break;
        case 'worker-hold': {
          const { workerId } = effect;
          if (workerTimers.has(workerId)) break;
          workerTimers.set(workerId, timers.set(() => { workerTimers.delete(workerId); emitAll(expireWorker(mapper, workerId)); }, timings.workerSettleMs));
          break;
        }
        case 'worker-settled':
          timers.clear(workerTimers.get(effect.workerId));
          workerTimers.delete(effect.workerId);
          break;
        case 'request-resolved':
          requestResolved(effect.requestId);
          break;
      }
    }
  }

  function onFrame(method: MappedMethod, params: unknown): void {
    if (over) return;
    // A side thread's frame is its aside's (M20b, C20): held while that aside's own `turn/start`
    // waits for its reply, and else mapped at once, whatever the session's own turn is doing.
    const threadId = mapper.asides.size === 0 ? null : takeThreadId(params);
    if (threadId !== null && mapper.asides.has(threadId)) {
      const waiting = [...asides.values()].find((aside) => aside.threadId === threadId)?.turn ?? null;
      if (waiting !== null && waiting.held !== null) {
        if (waiting.held.length >= MAX_HELD_FRAMES) drop('held-overflow'); else waiting.held.push({ method, params });
        return;
      }
      handle(method, params);
      return;
    }
    if (held !== null) {
      // Whatever thread it names, in the order it came: whose it is is decided once the turn is named (C110).
      if (held.length >= MAX_HELD_FRAMES) drop('held-overflow'); else held.push({ method, params });
      return;
    }
    // Before the first `turn/start` no frame of the thread is mapped.
    if (mapper.turn === null) { counts.unmapped += 1; return; }
    handle(method, params);
  }

  /**
   * A token report (decision 0033): the session's own thread's is its context reading, said where it
   * changed; a sub-agent's, a side thread's, or one that names no window is skipped and counted.
   */
  function tokensReported(params: unknown): void {
    const taken = takeTokenUsage(params);
    if (over || taken === null || mapper.threadId === '' || taken.threadId !== mapper.threadId) { counts.context.skipped += 1; return; }
    counts.context.read += 1;
    if (sameContext(reading ?? undefined, taken.reading)) return;
    reading = taken.reading;
    emit({ type: 'context', reading: taken.reading });
  }

  function attach(opened: OpenConnection): void {
    connection = opened;
    for (const method of MAPPED_METHODS) opened.onNotification(method, (params) => onFrame(method, params));
    // Codex's own reviewer at work (M22, C96): counted, never parsed, and nothing is made of it.
    for (const method of REVIEW_METHODS) opened.onNotification(method, () => { counts.reviews += 1; });
    // How full the thread's context is (decision 0033): read beside the mapper, for this thread alone.
    opened.onNotification(TOKEN_USAGE, tokensReported);
    for (const method of APPROVAL_REQUESTS) {
      opened.onRequest(method, (params, id) => {
        // Under Read only nothing is asked and nothing is granted (C6, C45): declined at once, as T7's was.
        if (mode === 'read-only') { refused(method); return { result: { decision: 'decline' } }; }
        // Under every other mode it is held for the user's decision (C8), Berserk's included: a request that comes is a card.
        return asked(method, params, id);
      });
    }
    // Codex's leave to run an MCP tool (decision 0018): held for the user's decision as the two above
    // are, and declined at once under Read only, where Codex asks none. Any other elicitation — an MCP
    // server's own form or address — is refused, with the notice, as one with no handler is.
    opened.onRequest(MCP_ELICITATION, (params, id) => {
      if (mode === 'read-only' && isMcpApproval(params)) { refused(MCP_ELICITATION); return { result: elicitationOf('deny') }; }
      // Compare an existing hold before classifying the new payload: even a server form under the
      // same id must withdraw the old approval as changed. A new server form is refused by take.
      return asked(MCP_ELICITATION, params, id);
    });
    // A question (M21, C23), answered when its answer comes. It grants nothing.
    opened.onRequest(QUESTION_REQUEST, (params, id) => asked(QUESTION_REQUEST, params, id));
    void opened.done.then((result) => processEnded(result));
  }

  // ── A line over the limit (M22, Design 8; C67, C71) ───────────────────────────────────────
  function onOversized(line: PeekedLine): void {
    counts.dropped.oversized += 1;
    // A notification, a reply, a request of no kind Codex waits on: skipped and counted, as before.
    if (over || line.request === 'no') return;
    if (line.request === 'yes' && line.id !== null && connection !== null) {
      // A request, and its id was read: refused by that id, with the line's size, and the turn goes on.
      counts.oversized.refused += 1;
      context.logger.record({ type: 'request-refused', method: refusedMethod('') });
      const requestId = takeRequestId(line.id.value);
      const hold = requestId === null ? undefined : holds.get(requestId);
      // One held under that id came again, as a line too long to compare: another payload (C91).
      if (requestId !== null && hold !== undefined) { holds.delete(requestId); counts.changed += 1; emit({ type: hold.kind === 'question' ? 'question-resolved' : 'approval-resolved', requestId, reason: 'changed' }); }
      emit({ type: 'notice', kind: 'request-refused', ...(current === null ? {} : { turnId: current.request.turnId }), bound: 'line', size: line.size });
      void connection.reply(line.id.value, NOT_TAKEN).catch(() => { counts.approvals.unwritten += 1; lose(); });
      return;
    }
    // It is, or may be, a request, and names no id a reply could carry: Codex may wait on it for
    // ever, and whose it is cannot be said. Everything this process runs is stopped, each by its own
    // verified path (C71): the session's turn and its workers, and each aside by its own Stop. With
    // nothing running it is a line skipped, as any other.
    const sessionRuns = current !== null || mapper.workers.size > 0;
    const asidesRunning = [...asides].flatMap(([asideId, aside]) => (aside.turn !== null && !aside.turn.done && !aside.turn.stop ? [{ asideId, turnId: aside.turn.request.turnId }] : []));
    if (!sessionRuns && asidesRunning.length === 0) return;
    counts.oversized.stopped += 1;
    if (sessionRuns) {
      emit({ type: 'notice', kind: 'line-too-long', ...(current === null ? {} : { turnId: current.request.turnId }), size: line.size });
      stopSession();
    }
    for (const { asideId, turnId } of asidesRunning) {
      emit({ type: 'notice', kind: 'line-too-long', turnId, asideId, size: line.size });
      stopAside(asideId);
    }
  }

  /** The process is gone, by itself or because the session ended it (C17, C100). */
  function processEnded(result: CleanupResult): void {
    // First (M21, C67, C70): what was still asked on it is said dropped, before any end made here,
    // so that no such end withdraws what the loss dropped. An answered request is let go with no
    // event, its reply gone or still queued: one the stop rejects is said by its own write.
    const unanswered = [...holds].flatMap(([requestId, hold]) => (hold.answered ? [] : [{ requestId, kind: hold.kind }]));
    holds.clear();
    changes.clear();
    calls.clear();
    incompleteCalls.clear();
    mapper.denied.clear();
    for (const { requestId, kind } of unanswered) emit({ type: kind === 'question' ? 'question-resolved' : 'approval-resolved', requestId, reason: 'dropped' });
    const turn = current;
    if (turn !== null && mapper.turn?.runtimeId === turn.request.turnId && !mapper.turn.ended) {
      // Its turn was running: the open workers first, then the turn (C17, C90).
      if (turn.stop) finish(turn, endWorkers(), 'interrupted', false);
      else finish(turn, [...endWorkers(), { type: 'notice', kind: 'connection-lost', turnId: turn.request.turnId }], 'failed', false, 'connection-lost');
    } else if (turn === null && !over && mapper.workers.size > 0) {
      // No turn, workers open: it reads as a Stop of them does, with its own notice (C100).
      emitAll([...endWorkers(), { type: 'notice', kind: 'workers-lost' }]);
    }
    // The asides ran on it too (M20b, C34, C70): each ends here, before whoever listens hears of the close.
    endAsides(false);
    if (ending !== null) return;
    over = true;
    clearWorkerTimers();
    ending = Promise.resolve(result);
    // A turn still starting fails its step where it waits (C87), its request rejected: `closed`
    // follows that turn's end, so whoever listens hears of the turn first.
    if (turn !== null && current === turn) void turn.running.finally(() => resolveClosed(result));
    else resolveClosed(result);
  }

  // ── A turn ────────────────────────────────────────────────────────────────────────────────
  const asStartFailure = (step: StartStep, error: unknown): StartFailure => (error instanceof StartFailure ? error : new StartFailure(step));

  /**
   * The session's process and its thread, opened: the launch with its handshake, then the thread's
   * start or resume, checked. `stopped` says whether whoever asked has given up, between the two.
   */
  async function open(signal: AbortSignal, stopped: () => boolean): Promise<OpenConnection> {
    if (connection === null) {
      const executable = options.executable();
      if (executable === undefined) throw new StartFailure('launch');
      let opened: OpenConnection;
      const launching = (plain: boolean): Promise<OpenConnection> => openSessionProcess({
        context, executable, argsPrefix: options.argsPrefix, applicationVersion: options.applicationVersion, launchMs: timings.launchMs, signal, plain,
        onOversized,
        unhandled: (kind, method) => { if (kind === 'request') refused(method); else counts.unmapped += 1; },
      });
      // Best effort (M22b, C13, C80): the experimental API a plan turn needs, unless this CLI refused it.
      // A refusal of the handshake that asks for it opens the process again with the plain one, and the
      // account plans nothing from then: nothing else of the session changes.
      experimental = options.plansRefused?.() !== true;
      try {
        opened = await launching(!experimental);
      } catch (error) {
        if (!experimental || !(error instanceof ProcessFailure) || error.code !== 'rpc-error' || signal.aborted) throw asStartFailure('launch', error);
        options.onPlansRefused?.();
        experimental = false;
        try { opened = await launching(true); } catch (again) { throw asStartFailure('launch', again); }
      }
      attach(opened);
    }
    const rpc = connection as OpenConnection;
    if (stopped() || over) throw new StartFailure('launch');
    if (!threadOpen) {
      const resume = reference !== null;
      const step: StartStep = resume ? 'reopen' : 'open';
      // The folder is `cwd` inside the request, and nothing else of the project goes anywhere (C23, C26).
      // With it, the mode's sandbox, approval policy and — where the policy asks someone — reviewer (M22, C7, C70).
      // And the record's speed tier, or `default` for standard speed: a `service_tier` of the user's own
      // configuration decides it no more than the model or the effort (decision 0018). Codex reads a null
      // tier on a turn as the thread's own, so standard speed is always said by name.
      const base = { cwd: options.start.folder, ...startPolicy(mode), serviceTier: serviceTierOf(options.start.speed) };
      let reply: unknown;
      try {
        reply = resume
          ? await sendRequest('session', rpc, 'thread/resume', { threadId: reference, ...base, excludeTurns: true }, { timeoutMs: timings.openMs, signal })
          : await sendRequest('session', rpc, 'thread/start', { ...base, model: options.start.model }, { timeoutMs: timings.openMs, signal });
      } catch (error) {
        // The code alone, and no text of the CLI's (C129): it may be another refusal's too.
        if (resume && error instanceof ProcessFailure && error.code === 'rpc-error' && error.numericCode === MISSING_THREAD_CODE) throw new StartFailure(step, 'session-not-reopened');
        throw asStartFailure(step, error);
      }
      const taken = takeStartReply(reply);
      if (taken === null) throw new StartFailure(step);
      // Before any prompt: the reply is where the user's configuration would show (C21), and the
      // only word of which sandbox, policy and reviewer the thread has (M22, C7).
      const check = checkPolicy(mode, taken.policy);
      try { options.onChecked?.(mode, taken.policy, check); } catch { /* the account's reading is its own */ }
      // Read only's is the restricted start it always was; any other names what the reply reported instead (C46).
      if (!check.ok) throw mode === 'read-only' ? new StartFailure(step, 'not-read-only') : new StartFailure(step, 'policy-mismatch', check.reported);
      policy = check.turn;
      threadOpen = true;
      mapper.threadId = taken.threadId;
      reference ??= taken.threadId;
      // The mode is in force on this process from here (C2): confirmed by the reply, before anything is sent.
      emit({ type: 'in-force', mode });
      // A faster tier the thread did not take (decision 0018; models research §6): Codex drops a tier the
      // model does not list, its reply naming none. Its turns say nothing of their speed, so this is all
      // fat-g can know of it.
      const asked = options.start.speed;
      if (asked !== null) emit({ type: 'in-force', served: taken.serviceTier === asked ? 'fast' : 'standard', servedReason: taken.serviceTier === asked ? null : 'not-offered' });
    }
    return rpc;
  }

  /** The process and the thread, open: as they are, or by the one opening whoever waits for them shares (M20b, C10). They are opened once. */
  function ready(signal: AbortSignal, stopped: () => boolean): Promise<OpenConnection> {
    if (connection !== null && threadOpen) return Promise.resolve(connection);
    opening ??= open(signal, stopped);
    return opening;
  }

  async function run(turn: Turn): Promise<void> {
    const { request } = turn;
    const { signal } = turn.abort;
    try {
      if (connection === null || !threadOpen) await ready(signal, () => turn.stop);
      const rpc = connection as OpenConnection;
      if (turn.stop || over) throw new StartFailure('send');
      // A plan turn names Codex's plan mode, and every turn after one on this thread its default (M22b,
      // C13, C55), with the record's model, the turn's effort and null instructions — the built-in ones.
      // Neither is named where the CLI refused what it needs: a plan turn is then not sent.
      if (request.plan === true && !experimental) throw new StartFailure('send');
      const collaboration = !experimental ? null : request.plan === true ? 'plan' : request.plannedBefore === true ? 'default' : null;
      // A chosen skill (M23, C64, C87): resolved against what Codex listed last, and sent as an input of its own beside the text. One no longer listed, or listed under another name, is never sent as something else.
      const skill = request.skill === undefined ? null : options.skillOf?.(request.skill.selector) ?? null;
      if (request.skill !== undefined && (skill === null || skill.name !== request.skill.name)) throw new StartFailure('send');
      held = [];
      let reply: unknown;
      try {
        reply = await sendRequest('session', rpc, 'turn/start', {
          threadId: mapper.threadId,
          input: [...promptInput(request.prompt, request.attachments ?? []), ...(skill === null ? [] : [{ type: 'skill', name: skill.name, path: skill.path }])],
          // The record's model, and this turn's effort and speed tier, in every turn: the user's own configuration decides none (C22; decision 0018).
          model: options.start.model,
          ...(request.effort === null ? {} : { effort: request.effort }),
          serviceTier: serviceTierOf(request.speed),
          clientUserMessageId: request.messageId,
          // What the thread's own reply reported, named again and never another (M22, C7, C64): a
          // policy named on a turn stays with its thread, and no frame would report the change.
          ...policy,
          ...(collaboration === null ? {} : { collaborationMode: { mode: collaboration, settings: { model: options.start.model, reasoning_effort: request.effort, developer_instructions: null } } }),
        }, { timeoutMs: timings.sendMs });
      } catch (error) {
        // A CLI that refuses the field (C80): it plans nothing from here, for this account.
        if (collaboration !== null && error instanceof ProcessFailure && error.code === 'rpc-error') options.onPlansRefused?.();
        throw asStartFailure('send', error);
      }
      const cliId = takeTurnStartReply(reply);
      if (cliId === null) throw new StartFailure('send');
      if (current !== turn) return;
      mapper.turn = newTurn(request.turnId, cliId);
      refusedNoticed = false;
      // With Codex's own id for the turn: what its history names the turn by (M18, C47).
      emit({ type: 'turn-started', turnId: request.turnId, providerTurnId: cliId });
      const queue: readonly Waiting[] = held;
      held = null;
      // Each as if it had just arrived: the announcement of a worker before that worker's own frames.
      for (const frame of queue) {
        if (over) break;
        if (!('asked' in frame)) { handle(frame.method, frame.params); continue; }
        // A request that came with them (M21; M22): placed now that the turn is named, or refused, late but as any is.
        const taken = take(frame.method, frame.params, frame.asked);
        if (taken === 'held') continue;
        refused(frame.method, taken.over);
        const unwritten = frame.method === QUESTION_REQUEST ? counts.questions : counts.approvals;
        void rpc.reply(frame.asked, NOT_TAKEN).catch(() => { unwritten.unwritten += 1; lose(); });
      }
      // The turn takes a message from here on, which its `turn-started` came too early to say.
      if (!over && current === turn) emit({ type: 'steer-changed' });
    } catch (error) {
      held = null;
      if (current !== turn) return;
      const failure = error instanceof StartFailure ? error : new StartFailure('launch');
      // Nothing more is sent, and the process is closed (C27, C87).
      if (turn.stop) finish(turn, endWorkers(), 'interrupted', false);
      else finish(turn, [...endWorkers(), failureNotice(failure, request.turnId)], 'failed', false, failure.kind);
      await endProcess();
    }
  }

  /** `turn/interrupt` to a side thread's turn, and to nothing else (M20b, C12, C70). */
  function interruptAside(threadId: string, turnId: string): void {
    if (connection === null) return;
    void sendRequest('session', connection, 'turn/interrupt', { threadId, turnId }, { timeoutMs: timings.stopMs }).catch(() => { /* left to the aside's own clock (C70) */ });
  }

  /**
   * One question of an aside (M20b, C19, C20): the process and the thread, if they are not open;
   * the side thread, if the aside has none here; then its turn. Every outcome is an event that
   * names the aside.
   */
  async function runAside(asideId: string, aside: Aside, turn: AsideTurn): Promise<void> {
    const { request } = turn;
    const { turnId } = request;
    /** As a turn's failed start: its step said, nothing more sent. The process is closed only where it never opened (M15, C87). */
    const fail = (failure: StartFailure): void => {
      if (turn.stop) finishAside(asideId, turn, [], 'interrupted', false);
      else finishAside(asideId, turn, [failureNotice(failure, turnId, asideId)], 'failed', false, failure.kind);
    };
    let rpc: OpenConnection;
    try {
      rpc = connection !== null && threadOpen ? connection : await ready(closing.signal, () => false);
    } catch (error) {
      if (turn.done) return;
      fail(error instanceof StartFailure ? error : new StartFailure('launch'));
      await endProcess();
      return;
    }
    if (turn.done) return;
    // Stopped while the process was starting: nothing is sent for it (C70).
    if (turn.stop || over) { finishAside(asideId, turn, [], 'interrupted', false); return; }
    let fresh = false;
    if (aside.threadId === null) {
      let reply: unknown;
      try {
        // These fields, and no other the schema offers (C19): never `config`, never `baseInstructions`.
        reply = await sendRequest('session', rpc, 'thread/fork', {
          threadId: mapper.threadId,
          // Through the newest turn whose end Codex reported; with none, the side thread holds nothing of the turn in flight (C69).
          ...(request.throughTurn === null ? {} : { lastTurnId: request.throughTurn }),
          ephemeral: true,
          excludeTurns: true,
          cwd: options.start.folder,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          developerInstructions: ASIDE_INSTRUCTIONS,
          model: options.start.model,
          // The chat's speed tier, or null for standard speed, as its turns ask (decision 0018).
          serviceTier: serviceTierOf(request.speed),
        }, { timeoutMs: timings.openMs });
      } catch {
        if (turn.done) return;
        // Refused, late, or dropped for its size (C19): the aside's question is not answered, and the session goes on.
        fail(new StartFailure('open'));
        return;
      }
      if (turn.done) return;
      const taken = takeStartReply(reply);
      if (taken === null) { fail(new StartFailure('open')); return; }
      // Checked as a start's is, before any turn (C19): a side thread that is not read-only is sent
      // nothing. Whatever the session's mode, a side thread is read-only and asks no one (M22, C84).
      if (!checkPolicy('read-only', taken.policy).ok) { fail(new StartFailure('open', 'not-read-only')); return; }
      aside.threadId = taken.threadId;
      fresh = true;
    }
    // Stopped before its turn was sent: nothing more is sent (C70). A side thread just forked has run nothing, and stays.
    if (turn.stop || over) { finishAside(asideId, turn, [], 'interrupted', false); return; }
    const threadId = aside.threadId;
    const mapped = newAside(asideId, turnId);
    turn.mapped = mapped;
    mapper.asides.set(threadId, mapped);
    turn.held = [];
    let reply: unknown;
    try {
      reply = await sendRequest('session', rpc, 'turn/start', {
        threadId,
        // A side thread that holds nothing of the aside is given its earlier exchanges with the question (C22).
        input: [{ type: 'text', text: fresh ? withEarlier(request.history, request.text) : request.text, text_elements: [] }],
        model: options.start.model,
        ...(request.effort === null ? {} : { effort: request.effort }),
        serviceTier: serviceTierOf(request.speed),
        clientUserMessageId: request.messageId,
      }, { timeoutMs: timings.sendMs });
    } catch {
      if (turn.done) return;
      giveUpThread(asideId);
      fail(new StartFailure('send'));
      return;
    }
    const cliId = takeTurnStartReply(reply);
    if (turn.done) return;
    if (cliId === null) { giveUpThread(asideId); fail(new StartFailure('send')); return; }
    mapped.cliId = cliId;
    emit({ type: 'turn-started', turnId, providerTurnId: cliId, asideId });
    const queue: readonly HeldFrame[] = turn.held ?? [];
    turn.held = null;
    for (const frame of queue) { if (over || turn.done) break; handle(frame.method, frame.params); }
  }

  function stopAside(asideId: string): void {
    const aside = asides.get(asideId);
    const turn = aside?.turn ?? null;
    if (aside === undefined || turn === null || turn.done || turn.stop) return;
    turn.stop = true;
    const { mapped } = turn;
    if (mapped === null || mapped.cliId === null || !mapped.started || aside.threadId === null) {
      // Before the fork's reply, or before its turn is named and started: nothing more is sent, and
      // what comes is dropped (C70). Where a turn was sent, what the side thread does from here is
      // not known, so the aside's next question forks anew.
      if (mapped !== null) giveUpThread(asideId);
      finishAside(asideId, turn, [], 'interrupted', false);
      return;
    }
    interruptAside(aside.threadId, mapped.cliId);
    // One clock from the press, the aside's own: an interrupt Codex has not confirmed by then ends
    // the aside's turn here. The process is never ended for it (C70).
    turn.stopTimer = timers.set(() => {
      turn.stopTimer = undefined;
      if (turn.done) return;
      giveUpThread(asideId);
      finishAside(asideId, turn, [{ type: 'notice', kind: 'stop-unconfirmed', turnId: turn.request.turnId, asideId }], 'interrupted', false);
    }, timings.stopMs);
  }

  /** Whether the session's own turn takes a message now (M23, C35): named by its `turn/start` reply, not ended, not being stopped. Codex takes one on every turn. */
  function steerState(): SteerState {
    const turn = current;
    return !over && connection !== null && turn !== null && !turn.stop && held === null && mapper.turn?.runtimeId === turn.request.turnId && !mapper.turn.ended ? 'open' : 'wait';
  }

  /** Whether the turn named ends within the Stop's time (C39): at once where it has. */
  function endsSoon(named: NonNullable<MapperState['turn']>): Promise<boolean> {
    if (named.ended) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const told = (): void => { if (!named.ended) return; turnEnds.delete(told); timers.clear(timer); resolve(true); };
      const timer = timers.set(() => { turnEnds.delete(told); resolve(named.ended); }, timings.stopMs);
      turnEnds.add(told);
    });
  }

  /**
   * A message into the running turn (M23, C36, C38–C40): `turn/steer` naming the turn Codex gave, with
   * the message's id and its input as `turn/start` takes it. Taken where the reply names that turn; a
   * refusal with Codex's stale-turn code is the turn's end only where that end is known — then or by
   * the Stop's time — and any other is "not sent" with the code alone; no reply is "not confirmed".
   */
  async function steer(request: SteerRequest): Promise<SteerOutcome> {
    const named = mapper.turn;
    const rpc = connection;
    // Its turn is over before anything was written: the message is the next prompt's (C40).
    if (steerState() !== 'open' || named === null || rpc === null || named.runtimeId !== request.turnId) return { kind: 'turn-over' };
    let reply: unknown;
    try {
      reply = await sendRequest('session', rpc, 'turn/steer', {
        threadId: mapper.threadId,
        expectedTurnId: named.cliId,
        clientUserMessageId: request.messageId,
        input: promptInput(request.prompt, request.attachments ?? []),
      }, { timeoutMs: timings.sendMs });
    } catch (error) {
      if (error instanceof ProcessFailure && error.code === 'rpc-error') {
        if (error.numericCode === STALE_STEER_CODE && await endsSoon(named)) return { kind: 'turn-over' };
        // The code alone, and no text of the CLI's (C129): it may be another refusal's too.
        return { kind: 'refused', detail: error.numericCode === undefined ? null : `code ${error.numericCode}` };
      }
      return { kind: 'unknown' };
    }
    return takeSteerReply(reply) === named.cliId ? { kind: 'taken' } : { kind: 'unknown' };
  }

  function stopSession(): void {
    const turn = current;
    if (turn === null) {
      // No turn, workers open: nothing is left to interrupt, so the process is ended at once (C100).
      if (over || mapper.workers.size === 0) return;
      emitAll([...endWorkers(), { type: 'notice', kind: 'workers-stopped' }]);
      void endProcess();
      return;
    }
    if (turn.stop) return;
    turn.stop = true;
    // Before `turn/start` has been sent the start is cancelled: nothing more is sent (C27).
    if (held === null && mapper.turn?.runtimeId !== turn.request.turnId) { turn.abort.abort(); return; }
    if (mapper.turn?.runtimeId === turn.request.turnId && mapper.turn.started && !turn.interrupted) { turn.interrupted = true; interrupts(); }
    // One clock from the press: a Stop Codex has not confirmed by then ends the process (C28).
    turn.stopTimer = timers.set(() => {
      turn.stopTimer = undefined;
      if (finish(turn, [...endWorkers(), { type: 'notice', kind: 'stop-unconfirmed', turnId: turn.request.turnId }], 'interrupted', false)) void endProcess();
    }, timings.stopMs);
  }

  return {
    counts,
    closed,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    send(request) {
      if (over || current !== null) return;
      const turn: Turn = { request, abort: new AbortController(), stop: false, interrupted: false, stopTimer: undefined, lostEndTimer: undefined, running: Promise.resolve() };
      current = turn;
      turn.running = run(turn);
    },
    ask(request) {
      if (over) return;
      const aside = asides.get(request.asideId) ?? { threadId: null, turn: null };
      // One question of an aside at a time: main refuses a second, and so does this.
      if (aside.turn !== null) return;
      asides.set(request.asideId, aside);
      const turn: AsideTurn = { request, stop: false, done: false, stopTimer: undefined, mapped: null, held: null };
      aside.turn = turn;
      void runAside(request.asideId, aside, turn);
    },
    answer(requestId, answers) {
      const hold = holds.get(requestId);
      // One it no longer holds, or has answered: its owner ended, Codex took it back, or the process
      // is gone. Counted, and nothing is written (C13). A request for leave takes a decision, and no answer.
      if (hold === undefined || hold.kind !== 'question' || hold.answered) { counts.questions.unheld += 1; return; }
      if (answers === null) {
        // Main cannot place it, or could not keep its card (C11, C33): refused as one fat-g cannot show is.
        holds.delete(requestId);
        refused(QUESTION_REQUEST);
        void write(requestId, hold, NOT_TAKEN);
        return;
      }
      // Marked before its write settles: from here Codex's word confirms it, and no end says it dropped but its own write's (C70).
      hold.answered = true;
      void write(requestId, hold, { result: { answers: encodeAnswers(hold.raw, answers) } });
    },
    decline(requestId) {
      const hold = holds.get(requestId);
      // One it no longer holds, or has answered: counted, and nothing is written (C13).
      if (hold === undefined || hold.kind !== 'question' || hold.answered) { counts.questions.unheld += 1; return; }
      // Skip (M22b, C53): "No answer" under each question's id, as a question left blank is sent (M100b, C30); K2 saw Codex take it and the turn go on.
      hold.answered = true;
      void write(requestId, hold, { result: { answers: Object.fromEntries(hold.raw.questions.map((question) => [question.id, { answers: [NO_ANSWER] }])) } });
    },
    decide(requestId, choice) {
      const hold = holds.get(requestId);
      // One it no longer holds, or has decided: its owner ended, Codex took it back, it changed under
      // its id, or the process is gone. Counted, and nothing is written (C13): no write went.
      if (hold === undefined || hold.kind !== 'approval' || hold.answered) { counts.approvals.unheld += 1; return Promise.resolve(false); }
      if (choice === null || !hold.choices.includes(choice)) {
        // Main cannot place it, or could not keep its card (C11) — or names a choice its view never
        // listed, which is never written (C69, C88): refused as one fat-g cannot show is.
        holds.delete(requestId);
        refused(hold.method);
        return write(requestId, hold, NOT_TAKEN);
      }
      // Marked before its write settles, as an answer is (C70).
      hold.answered = true;
      // The user's own Deny (C76): the item's end, declined, then says who declined it.
      if (choice === 'deny') mapper.denied.add(hold.itemId);
      // Codex's own decision for the choice, and nothing the request offered beside it (C22, C69); for
      // an MCP tool, the elicitation's answer, never its `always` (decision 0018).
      return write(requestId, hold, { result: hold.answer === 'elicitation' ? elicitationOf(choice) : decisionOf(choice) });
    },
    stopAside,
    steerState,
    steer,
    stop: stopSession,
    async close() {
      const turn = current;
      // An opening an aside waits for is cancelled, and every open aside ends with the session (M20b, C34).
      closing.abort();
      // Leave that was asked and is still undecided is lost with the process this close ends (M22,
      // C11, C12): said dropped before the end made here, so that a loss never reads as a withdrawal.
      // A question's hold goes with its turn, as before: main drops before it closes (M21, C67).
      for (const [requestId, hold] of [...holds]) {
        if (hold.kind !== 'approval' || hold.answered) continue;
        holds.delete(requestId);
        emit({ type: 'approval-resolved', requestId, reason: 'dropped' });
      }
      endAsides(true);
      if (turn !== null) {
        turn.stop = true;
        turn.abort.abort();
        finish(turn, endWorkers(), 'interrupted', false);
        over = true;
        // A launch under way has a process to close: wait for it to be known.
        if (connection === null) await turn.running.catch(() => undefined);
      } else if (!over && mapper.workers.size > 0) emitAll(endWorkers());
      // An opening an aside asked for has a process to close too: wait for it to be known.
      if (connection === null && opening !== null) { over = true; await opening.catch(() => undefined); }
      return endProcess();
    },
    recheck: () => (connection === null ? Promise.resolve({ ok: true }) : connection.recheck()),
  };
}
