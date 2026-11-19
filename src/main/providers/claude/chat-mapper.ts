// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Frames to events (docs/planning/_archive/M16.md, Design 5; C31–C41, C70, C75–C77, C83, C87; M20a.md,
// Design 4, 5; C17, C18, C20, C22, C23; M22.md, Design 6; C7, C11, C12, C76): a function of the session's mapping state and one frame.
// It keeps no clock and sends nothing: what needs a timer, an answer or the end of the process
// comes back as an effect, for the session to act on.
//
// Whose frame (C31, C40). Claude names no turn, so each prompt carries an id, and the CLI's
// `command_lifecycle` frames that name it bound its turn:
//
//   prompt written ─► queued ─► started ─► init ─► assistant … ─► result ─► completed | cancelled
//                               └──────────── the prompt's turn ──────────┘   the closing frame
//
//   init with no `started` before it ─► … ─► result      a turn the CLI started by itself
//
// A frame of a turn the CLI started, or one that arrives with no turn in flight, is dropped and
// counted. A worker's frames are apart: they are mapped whenever they come, since a worker belongs
// to its session and not to a turn.
//
// A text is not held (C35, C70): each is reported when it arrives, as commentary, and the turn's
// completed end names the last one as its answer (C74). A user's Stop hook runs between the final
// text and the turn's `result`, so nothing of the turn's can wait for that frame.
//
// A text as it is written (docs/planning/_archive/M19.md, Design 3; C10–C13, C60). A reply's `stream_event`
// frames come before and around its `assistant` frames, which stay the authority:
//
//   message_start ─► content_block_start(i) ─► delta … ─► assistant (block i) ─► content_block_stop(i)
//                    └ the next block of the reply, the same way ─► … ─► message_delta ─► message_stop
//
// A text block is one message from its start, under `<reply id>#<index>`: it opens empty, each
// `text_delta` of its index appends, and the `assistant` frame that carries the block completes it.
// While it is written it says no phase (C79): Claude does not say which text is the answer until
// the turn ends, so a text that is still coming is neither commentary nor answer yet, and the chat
// draws it as it draws an answer. Its frame gives it the phase every whole text of Claude's has,
// commentary, and the turn's completed end names the answer (C74).
//
// A text the Stop cut (C80). The CLI answers an interrupt with the frame that holds what it had
// written. That frame does not complete the message: the text is brought up to what the frame
// holds, and the turn's interrupted end leaves it as it was received, unfinished — as an answer of
// any provider's is when its turn is stopped. It keeps no phase: what it would have been is never
// known. Where the turn completes after all, the Stop having come too late, the frame completes
// the message just before that end.
// A reply's frames come one block each, in the blocks' order, so the k-th frame of a reply is the
// k-th block its events opened. A text frame whose reply or block no event opened — the CLI's own
// replies send none — is a whole message under its frame's `uuid`, as before. The session's
// reference is reported at its first reply from a model, at that reply's start (C60), and at the
// first frame from a model where no such start came.
//
// What a session does between its messages (M20a, C17, C18). A `tool_use` block of the session's
// own frame opens an activity, by the tool's name, under the tool use's own id; the `tool_result`
// block of the `user` frame that names it ends it, its content the output and its error flag its
// failure. A result that names no open item is dropped and counted. A `thinking` block is an item
// opened at its `content_block_start`, under `<reply id>#<index>` as a text is, and completed by
// the frame that carries it; one whose start never came is made whole by its frame, with no
// duration of fat-g's. The tool-input, thinking and signature deltas stay unread.
//
// A worker's frames (C20, C22). A frame that names a parent tool use belongs to the worker that
// tool use started, which `task_started` pairs with it: its texts are the worker's messages, its
// tool uses and their results the worker's activities, each event naming the worker and the turn
// that started it. A worker's frame that comes before its pairing is held for it, and one that no
// pairing claims in time is dropped and counted. A worker's message is never the session's: it
// sets no commentary, no answer and no action line.
//
// The worker item (C23) is the `Agent` tool use. Until a `task_started` pairs a worker with it, it
// is an attempted launch, which an error result fails as any tool's does. Once paired, its result
// ends nothing of it: it ends when its worker does, with the notification's summary as its output
// and the CLI's own duration. A worker that ran in the foreground sends none of its text in its
// frames, so that summary, its final text, is also its last message where it sent no text of its
// own (M106, C45), just before its item ends.
//
// A question (docs/planning/_archive/M21.md, Design 3; C19, C21, C62, C63, C72). A `tool_use` block named
// `AskUserQuestion` opens no activity, in the session's frames and in a worker's alike: the card
// stands for it. The question is kept under its owner by its tool use — on the turn's state for the
// session's own, on the worker for a worker's — from that block, and the session completes it with
// the request that carries the same questions, which names its worker where it has one. Its
// `tool_result` is read for its error flag alone, on the path it comes by: the session's own needs
// its turn in flight, and a worker's comes by the worker's path, with or without a turn, so a
// worker's answer is confirmed after its parent's `result` as well. It ends no activity; where the
// request was answered it is the CLI's word that it took the answer, error or not, and after the
// CLI took the request back, or fat-g refused it, it says nothing more.
//
// A request to act (docs/planning/_archive/M22.md, Design 6; C11, C12, C76). A `tool_use` block of any other
// tool opens its activity as before, and under a mode that acts the CLI then asks leave for it, by a
// request that names the same tool use — or names it first, where it is a worker's (K2). The request
// is kept under its owner by that tool use, as a question is, and its `tool_result` is read twice:
// as the CLI's word that it took the decision, error or not, and as the activity's end — which is
// `declined`, and no failure, for an action the user denied. An action a rule of the user's own
// configuration refuses comes with no request: its `permission_denied` frame ends the activity as
// declined, and the error result that follows it says nothing more.
//
// The mode (M22, C5, C7). Each `init` is held to the mode the process runs under, which the session
// sets here: its word, and its tools.
import { type ActivityType, cutParts, type DeclinedBy } from '@shared/contracts/activity';
import { type AgentEvent, cutLine, cutTo, MAX_AGENT_ID, MAX_MESSAGE_TEXT, type TurnFailure } from '@shared/contracts/agent-events';
import type { ActionKind } from '@shared/contracts/sessions';
import { LiveActions, type LiveAction, sameLiveAction } from '@shared/provider-kit/live-actions';
import type { FrameDropReason } from '@shared/provider-kit/logger';
import { type AssistantBlock, errorDetail, frameKind, type StreamEvent, takeAssistant, takeDenied, takeInit, takeLifecycle, takeResult, takeStream, takeTask, takeUser, type TaskFrame } from './chat-frames';
import { type ClaudeMode, READING_MODE, reportsMode, reportsTools } from './chat-modes';
import type { TakenTool, TakenToolResult } from './chat-tools';

export interface ChatMapperTurn {
  readonly actions: LiveActions;
  lastAction: LiveAction;
  /** The runtime's id (M15, C86), which every event of the turn names. */
  readonly runtimeId: string;
  /** The id the prompt was written with, which the CLI's `command_lifecycle` frames name (C31). */
  readonly promptId: string;
  /** Its `started` frame has come: Claude took the prompt (C75). */
  started: boolean;
  /** Its `init` has come: the frames of a model can follow. */
  inited: boolean;
  /** Its end has been mapped, or made by the session. */
  ended: boolean;
  /** The frame that closes it has come (C31). */
  closed: boolean;
  /** A Stop was sent: an error `result` is then the interrupt's own end (C36). The session sets it. */
  stopped: boolean;
  kind: ActionKind | null;
  file: string | null;
  /** The turn's latest commentary, as a label's input (C38). */
  commentary: string | null;
  /** The item id of the turn's last text: its answer, if the turn completes (C35, C74). */
  lastText: string | null;
  /** The text of a frame marked `error`, cut: a failed turn's detail (C37). */
  detail: string | null;
  /** Texts whose frames came after the Stop (C80): not completed, unless the turn completes after all. */
  readonly held: { readonly itemId: string; readonly text: string; readonly cut: boolean }[];
  /** The session's own tool uses whose result has not come, by their id, each with its type (M20a, C17). */
  readonly tools: Map<string, ActivityType>;
  /** The session's own questions whose result has not come, by their tool use (M21, C19, C72). */
  readonly questions: Map<string, ChatMapperQuestion>;
  /** The session's own requests to act whose result has not come, by their tool use (M22, C11, C12). */
  readonly approvals: Map<string, ChatMapperApproval>;
  /** The session's own tool uses a rule's denial has ended (M22, C76): the result that follows each is passed over. */
  readonly passed: Set<string>;
  /** The session's own plans handed over, whose result has not come, by their tool use (M22b, C10, C11). */
  readonly plans: Map<string, ChatMapperPlan>;
}

/** A plan handed over by its tool (M22b, C10, C11), from its `tool_use` block or its request to its `tool_result`. */
export interface ChatMapperPlan {
  /** The request that carries it, from its placing on. Null before it, and once the CLI took it back or fat-g refused it. */
  requestId: string | null;
  /** fat-g wrote the user's decision for it: its result is then the CLI's word that it took it (C11). */
  decided: boolean;
}

/** A question asked through the question tool (M21, C19, C72), from its `tool_use` block to its `tool_result`. */
export interface ChatMapperQuestion {
  /** The request that carries it, from that request on. Null before it, and once the CLI took it back or fat-g refused it. */
  requestId: string | null;
  /** fat-g wrote an answer for it: its result is then the CLI's word that it took the answer (C62). */
  answered: boolean;
  /** The answer fat-g wrote was the user's Skip (M100b, C31): the result's error flag is then the decline's own, and no failure. */
  declined: boolean;
}

/** A request to act (M22, C11, C12, C76), from the request that names its tool use to that tool use's `tool_result`. */
export interface ChatMapperApproval {
  /** The request, from its placing on. Null once the CLI took it back or fat-g refused it: its result then says nothing of it. */
  requestId: string | null;
  /** fat-g wrote the user's decision for it: its result is then the CLI's word that it took it (C12), and — for a denial — the activity's declined end (C76). */
  decided: 'allowed' | 'denied' | null;
}

/** A reply while its `stream_event` frames come (M19, C11): the session's own, or a worker's. */
export interface ChatMapperReply {
  readonly id: string;
  /** The indexes of the blocks its events opened, in the order they opened: the k-th `assistant` frame of the reply carries the k-th. */
  readonly opened: number[];
  /** How many `assistant` frames of the reply have come. */
  frames: number;
  /** Its text blocks, by index: the message each is, whether its frame has come, and how much of its text the deltas have brought. */
  readonly texts: Map<number, { readonly itemId: string; completed: boolean; written: number }>;
  /** Its thinking blocks whose frame has not come, by index: the item each is (M20a, C17). */
  readonly thinking: Map<number, string>;
}

/** An `Agent` tool use no worker is paired with yet (M20a, C23; M106, C14, C20). */
export interface ChatMapperLaunch {
  readonly turnId: string;
  readonly name: string;
  readonly summary: string;
  readonly model: string | null;
  readonly agentType: string | null;
}

/** An open worker (M20a, C20, C22). */
export interface ChatMapperWorker {
  readonly actions: LiveActions;
  lastAction: LiveAction;
  /** The runtime's id of the turn that started it, which every event of its items names. Null where no turn of fat-g's was in flight: nothing of it can be kept. */
  readonly startedIn: string | null;
  /** The `Agent` tool use that started it, which is the worker item (C23). Null where none is known. */
  readonly toolUseId: string | null;
  /** Its tool uses whose result has not come. */
  readonly tools: Set<string>;
  /** Its questions whose result has not come, by their tool use (M21, C72): kept here, so that its own result path finds them whatever the session's turn. */
  readonly questions: Map<string, ChatMapperQuestion>;
  /** Its requests to act whose result has not come, by their tool use (M22, C11): kept here for the same reason. */
  readonly approvals: Map<string, ChatMapperApproval>;
  /** Its tool uses a rule's denial has ended (M22, C76). */
  readonly passed: Set<string>;
  /** A reply of its own being written, should the CLI send its events (C22). */
  reply: ChatMapperReply | null;
  /** Its item's name and line, as its launch gave them (M106, C14): what a later start of the item says again. Null where no launch is known. */
  readonly item: { readonly name: string; readonly summary: string } | null;
  /** The model it is known to run on (M106, C14): its launch's alias, then the id its own frames name; null for none. */
  model: string | null;
  /** It sent a text of its own (M106, C45): its report is then no message of its. */
  said: boolean;
}

export interface ChatMapperState {
  /** The folder the session runs in: what `session-started` carries. */
  readonly folder: string;
  /** The mode the process runs under (M22, C5, C7): what each `init` is held to. The session's to set: the launch's, then what a confirmed change made it. */
  mode: ClaudeMode;
  turn: ChatMapperTurn | null;
  /** The reply being written, from its `message_start` to its `message_stop`, the next reply's start or the turn's end. */
  reply: ChatMapperReply | null;
  /** The prompt id of an ended turn whose closing frame is still to come, once another turn has taken its place. */
  closing: string | null;
  /** A turn the CLI started by itself is in flight: its frames are dropped until its `result` (C31, C40). */
  selfTurn: boolean;
  /** The session id the latest `init` of a prompt's turn named. */
  sessionId: string | null;
  /** The record holds the reference, or it has been reported: it is reported once (C87). */
  referenced: boolean;
  /** Open workers, by their task id (C39). */
  readonly workers: Map<string, ChatMapperWorker>;
  /** Which worker each `Agent` tool use started (M20a, C22), from `task_started`: whose a frame that names a parent is. Kept past the worker's end, so that its later frames are known for a worker's. */
  readonly paired: Map<string, string>;
  /**
   * `Agent` tool uses of the turn in flight that no worker is paired with yet (C23): an attempted
   * launch, with the name and the line its start gave, and the model and agent definition its input
   * asked for (M106, C14, C20).
   */
  readonly launches: Map<string, ChatMapperLaunch>;
  /** A worker's frames that came before its pairing (C22), in the order they came. */
  readonly waiting: { readonly parent: string; readonly frame: unknown }[];
  /** Workers a `task_updated` ended, whose notification may still bring a report and a duration for their item (C22). */
  readonly ended: Map<string, { readonly turnId: string; readonly itemId: string; readonly said: boolean }>;
  /** Tool uses a rule's denial named before their own frame came (M22, C76), each with whether a rule was its reason: the result that names one ends it declined. */
  readonly denied: Map<string, boolean>;
  /** This process's `init` said a Stop can drop the messages it holds (M23, C43). */
  cancelsQueued: boolean;
  /** Its latest `init`'s three lists of command names (M23, C60): null until one came. */
  listed: { readonly commandNames: readonly string[] | null; readonly skillNames: readonly string[] | null; readonly terminalNames: readonly string[] | null } | null;
  /**
   * Messages written while a turn ran (M23, C42, C43), by the id each was written with, with the turn
   * it was handed into: until the CLI's lifecycle says what became of each — folded into that turn,
   * run as its next, or dropped by a Stop.
   */
  readonly steered: Map<string, ChatMapperSteered>;
}

/** A message written while a turn ran (M23, C42): the turn it was handed into, and whether that turn took it. */
export interface ChatMapperSteered {
  readonly turnId: string;
  folded: boolean;
}

export type ChatMapperEffect =
  /** The CLI took the prompt: the deadline from its write is met (C88). */
  | { readonly type: 'started' }
  /** An `init` named another permission mode than the one in force, or a built-in tool the mode's launch did not offer (C21, C83; M22, C5). */
  | { readonly type: 'overruled' }
  /**
   * The turn's end, as the CLI gave it (C36, C41, C76): by its `result`, or — `lost` — by the closing
   * frame that stood in for a `result` that never came. `answerItemId` on a completed end alone.
   */
  | { readonly type: 'turn-ended'; readonly outcome: 'completed' | 'interrupted' | 'failed'; readonly answerItemId: string | null; readonly lost: boolean; readonly detail: string | null }
  /** A worker's frame came before its pairing, and is held for it (M20a, C22): the session gives it its time. */
  | { readonly type: 'worker-frame-held'; readonly parent: string }
  /** The pairing came: the frames held for it were mapped, and their time is no longer counted. */
  | { readonly type: 'worker-frames-claimed'; readonly parent: string }
  /**
   * The tool result of a question whose request is known came (M21, C19): that request is over, and
   * the session holds it no longer. `failed`: the result's error flag after an answer, which fails
   * nothing of the card and is counted.
   */
  | { readonly type: 'question-closed'; readonly requestId: string; readonly failed: boolean }
  /** The tool result of an action whose request is known came (M22, C12): that request is over, and the session holds it no longer. */
  | { readonly type: 'approval-closed'; readonly requestId: string }
  /** The tool result of a plan whose request is known came (M22b, C10): that request is over, and the session holds it no longer. */
  | { readonly type: 'plan-closed'; readonly requestId: string }
  /** A held message ran as the CLI's next turn (M23, C42): that turn is the session's from here. */
  | { readonly type: 'held-started'; readonly turn: ChatMapperTurn };

export interface ChatMapped {
  readonly events: readonly AgentEvent[];
  readonly effects: readonly ChatMapperEffect[];
  readonly drop: FrameDropReason | null;
  /** A frame of a kind the adapter does not read: never parsed, and counted apart (C32). */
  readonly unread: boolean;
}

/** How many of a worker's frames wait for its pairing at once: one past it is dropped and counted. */
export const MAX_WAITING_FRAMES = 64;
/** How many ended workers, and pairings of ended workers, are remembered. */
const MAX_REMEMBERED = 256;

const NOTHING: ChatMapped = { events: [], effects: [], drop: null, unread: false };
const UNREAD: ChatMapped = { events: [], effects: [], drop: null, unread: true };
const dropped = (reason: FrameDropReason): ChatMapped => ({ events: [], effects: [], drop: reason, unread: false });
const events = (list: readonly AgentEvent[], effects: readonly ChatMapperEffect[] = []): ChatMapped => ({ events: list, effects, drop: null, unread: false });

/** `mode`: the mode the session's process is launched under; left out, the reading mode. */
export function newChatMapper(folder: string, referenced: boolean, mode: ClaudeMode = READING_MODE): ChatMapperState {
  return { folder, mode, turn: null, reply: null, closing: null, selfTurn: false, sessionId: null, referenced, workers: new Map(), paired: new Map(), launches: new Map(), waiting: [], ended: new Map(), denied: new Map(), cancelsQueued: false, listed: null, steered: new Map() };
}

/** How many messages written during turns are held at once (M23, C42): one past it is not written. */
export const MAX_STEERED = 16;

/** A message was written while the turn ran (M23, C42): its lifecycle frames are this message's from here. */
export function steerChatMessage(state: ChatMapperState, messageId: string, turnId: string): void {
  state.steered.set(messageId, { turnId, folded: false });
}

/** The messages the CLI still holds (M23, C43): written, and neither taken nor dropped yet. */
export function heldMessages(state: ChatMapperState): string[] {
  return [...state.steered].filter(([, held]) => !held.folded).map(([messageId]) => messageId);
}

/** A message's own id for the turn it runs as, where it runs as the CLI's next turn (M23, C42): unique as the message's is. */
export const heldTurnId = (messageId: string): string => `${messageId}:turn`;

/** A prompt was written: its turn is the one in flight. The turn before it may still be owed its closing frame. */
export function beginChatTurn(state: ChatMapperState, runtimeId: string, promptId: string): ChatMapperTurn {
  const previous = state.turn;
  state.closing = previous !== null && previous.ended && !previous.closed ? previous.promptId : null;
  const turn: ChatMapperTurn = { runtimeId, promptId, actions: new LiveActions(), lastAction: { kind: 'thinking' }, started: false, inited: false, ended: false, closed: false, stopped: false, kind: null, file: null, commentary: null, lastText: null, detail: null, held: [], tools: new Map(), questions: new Map(), approvals: new Map(), passed: new Set(), plans: new Map() };
  state.turn = turn;
  // No reply of the turn before reaches into this one, and no launch it attempted.
  state.reply = null;
  state.launches.clear();
  return turn;
}

/** Whose item an event is: a worker's names it, and the session's own names none. */
const owned = (workerId: string | null): { workerId?: string } => (workerId === null ? {} : { workerId });

/** A tool's use, as an activity's start (M20a, C17, C59). */
function toolStarted(turnId: string, tool: TakenTool, workerId: string | null): AgentEvent {
  const { start } = tool;
  return {
    type: 'activity-started', turnId, itemId: tool.itemId, ...owned(workerId), activityType: tool.activityType, name: start.name, summary: start.summary,
    ...(typeof start.input === 'string' ? { input: start.input } : {}),
    ...(start.files === undefined || start.files.length === 0 ? {} : { files: [...start.files] }),
    ...(start.changes === undefined || start.changes.length === 0 ? {} : { changes: [...start.changes] }),
    ...(start.steps === undefined || start.steps.length === 0 ? {} : { steps: [...start.steps] }),
    ...(tool.cut === null ? {} : { cut: tool.cut }),
  };
}

/** Why an action is declined, and no failure (M22, C76): `by` is who refused it leave, where that is known. */
interface Declined { readonly by: DeclinedBy | null }

const declinedBy = (declined: Declined): { declinedBy?: DeclinedBy } => (declined.by === null ? {} : { declinedBy: declined.by });

/**
 * A tool's result, as its activity's end (C18): its content the output, its error flag its failure.
 * `declined` (M22, C76): the action was refused leave and never ran, which is a status of its own.
 */
function toolEnded(turnId: string, result: TakenToolResult, workerId: string | null, declined: Declined | null = null): AgentEvent {
  return {
    type: 'activity-ended', turnId, itemId: result.toolUseId, ...owned(workerId), status: declined !== null ? 'declined' : result.failed ? 'failed' : 'completed',
    ...(declined === null ? {} : declinedBy(declined)),
    ...(result.output === null ? {} : { output: result.output }),
    ...(result.cut === null ? {} : { cut: result.cut }),
  };
}

/** The worker item's end (C22, C23): its worker's, with the notification's summary as its output and the CLI's duration, where a notification gives them. */
function workerItemEnded(turnId: string, itemId: string, outcome: 'completed' | 'failed', notification: TaskFrame | null): AgentEvent {
  const report = notification?.summary == null ? null : cutParts({ output: notification.summary });
  return {
    type: 'activity-ended', turnId, itemId, status: outcome,
    ...(typeof report?.parts.output === 'string' ? { output: report.parts.output } : {}),
    ...(report == null || report.cut === null ? {} : { cut: report.cut }),
    ...(notification == null || notification.durationMs === null ? {} : { durationMs: notification.durationMs }),
  };
}

/**
 * A worker's report as its last message (M106, C45): a worker that ran in the foreground sends none
 * of its text in its frames, and its notification's summary is its final text, which the `Agent`
 * tool's result holds too. Commentary, as its texts are; none where it sent a text of its own.
 */
function reportOf(taskId: string, turnId: string, said: boolean, notification: TaskFrame | null): AgentEvent[] {
  const itemId = `${taskId}#report`;
  if (said || notification === null || notification.summary === null || notification.summary.trim() === '' || itemId.length > MAX_AGENT_ID) return [];
  const report = cutTo(notification.summary, MAX_MESSAGE_TEXT);
  return [{ type: 'message', turnId, role: 'assistant', itemId, phase: 'commentary', text: report.text, ...(report.cut ? { cut: true } : {}), workerId: taskId }];
}

/** A worker's end, for its item and for the list: its report, then the item (C23), then the list. */
function workerEnded(taskId: string, worker: ChatMapperWorker, outcome: 'completed' | 'failed', notification: TaskFrame | null): AgentEvent[] {
  worker.actions.clear();
  const ended: AgentEvent = { type: 'worker-ended', workerId: taskId, outcome };
  return worker.toolUseId === null || worker.startedIn === null ? [ended] : [...reportOf(taskId, worker.startedIn, worker.said, notification), workerItemEnded(worker.startedIn, worker.toolUseId, outcome, notification), ended];
}

/** Every open worker ended as failed (M15, C90): a Stop, a lost process, a forced Stop. Their later frames find no open worker. */
export function failChatWorkers(state: ChatMapperState): AgentEvent[] {
  const workers = [...state.workers];
  state.workers.clear();
  state.waiting.length = 0;
  return workers.flatMap(([taskId, worker]) => workerEnded(taskId, worker, 'failed', null));
}

/**
 * The frames held for a pairing that never came (M20a, C22): they are let go. Answers how many, for
 * the session to count as dropped.
 */
export function expireWaitingFrames(state: ChatMapperState, parent: string): number {
  const before = state.waiting.length;
  const kept = state.waiting.filter((held) => held.parent !== parent);
  state.waiting.length = 0;
  state.waiting.push(...kept);
  return before - kept.length;
}

/** Why a failed end failed, for the log's count: the CLI's own failure, or an end fat-g never read. */
export function endFailure(effect: Extract<ChatMapperEffect, { type: 'turn-ended' }>): TurnFailure | undefined {
  if (effect.outcome !== 'failed') return undefined;
  return effect.lost ? 'end-lost' : 'turn-failed';
}

function action(turn: ChatMapperTurn): AgentEvent | null {
  const current = turn.actions.current();
  turn.kind = current.kind;
  turn.file = current.file ?? null;
  const next = { ...current, ...(current.kind === 'thinking' || turn.commentary === null ? {} : { line: turn.commentary }) };
  if (sameLiveAction(turn.lastAction, next)) return null;
  turn.lastAction = next;
  return { type: 'action-changed', turnId: turn.runtimeId, ...next };
}

function workerAction(workerId: string, worker: ChatMapperWorker): AgentEvent[] {
  const current = worker.actions.current();
  if (sameLiveAction(worker.lastAction, current)) return [];
  worker.lastAction = current;
  return [{ type: 'worker-progressed', workerId, ...current }];
}

function endReply(actions: LiveActions, reply: ChatMapperReply | null): void {
  for (const text of reply?.texts.values() ?? []) actions.end(text.itemId);
}

function startTool(actions: LiveActions, block: Extract<AssistantBlock, { type: 'tool' }>): void {
  if (block.tool === null) return;
  actions.start(block.tool.itemId, { kind: block.kind, ...(block.file === null ? {} : { file: block.file }),
    ...(block.kind === 'waiting' ? { wait: { reason: 'subagents' } } : {}),
  });
}

/** The prompt's turn, while its frames can still come: started, and not ended. */
function inFlight(state: ChatMapperState): ChatMapperTurn | null {
  const { turn } = state;
  return turn !== null && turn.started && !turn.ended && !state.selfTurn ? turn : null;
}

/** One of a map's oldest entries is let go once it holds too many: what is remembered of ended workers is bounded. */
function remember<V>(map: Map<string, V>, key: string, value: V, keep: (key: string, value: V) => boolean = () => false): void {
  map.set(key, value);
  if (map.size <= MAX_REMEMBERED) return;
  for (const [held, entry] of map) {
    if (map.size <= MAX_REMEMBERED) return;
    if (!keep(held, entry)) map.delete(held);
  }
}

function mapLifecycle(state: ChatMapperState, frame: unknown): ChatMapped {
  const taken = takeLifecycle(frame);
  if (taken === null) return dropped('invalid');
  const { turn } = state;
  const closes = taken.state === 'completed' || taken.state === 'cancelled';
  if (turn !== null && taken.promptId === turn.promptId) {
    if (taken.state === 'started') {
      if (turn.started || turn.ended) return NOTHING;
      turn.started = true;
      // The prompt's own turn begins: whatever the CLI ran by itself before it is over.
      state.selfTurn = false;
      // No id of the provider's for the turn: Claude names none (C75).
      return events([{ type: 'turn-started', turnId: turn.runtimeId }], [{ type: 'started' }]);
    }
    if (!closes) return NOTHING;
    if (turn.closed) return NOTHING;
    turn.closed = true;
    // The expected frame: it follows the turn's `result` within a millisecond.
    if (turn.ended) return NOTHING;
    // No `result` came before it — lost to the line limit, say: the frame is the CLI's own word that
    // the turn is over, and the turn ends as it reads (C41).
    turn.ended = true;
    turn.actions.clear();
    state.reply = null;
    const outcome = taken.state === 'completed' ? 'completed' : turn.stopped ? 'interrupted' : 'failed';
    return events(settleHeld(turn, outcome), [{ type: 'turn-ended', outcome, answerItemId: outcome === 'completed' ? turn.lastText : null, lost: true, detail: null }]);
  }
  if (state.closing !== null && taken.promptId === state.closing) {
    if (closes) state.closing = null;
    return NOTHING;
  }
  // A message written while a turn ran (M23, C42, C43): `queued` at once, then taken into that turn at
  // a tool boundary, or run as the CLI's next turn once that turn has ended, or dropped by a Stop.
  const held = state.steered.get(taken.promptId);
  if (held !== undefined) {
    if (taken.state === 'started') {
      if (turn !== null && turn.runtimeId === held.turnId && turn.started && !turn.ended) {
        held.folded = true;
        return events([{ type: 'delivery', messageId: taken.promptId, state: 'taken' }]);
      }
      state.steered.delete(taken.promptId);
      const next = beginChatTurn(state, heldTurnId(taken.promptId), taken.promptId);
      next.started = true;
      state.selfTurn = false;
      return events([{ type: 'held-turn-started', turnId: next.runtimeId, messageId: taken.promptId }], [{ type: 'started' }, { type: 'held-started', turn: next }]);
    }
    if (taken.state === 'cancelled') {
      state.steered.delete(taken.promptId);
      return held.folded ? NOTHING : events([{ type: 'delivery', messageId: taken.promptId, state: 'cancelled' }]);
    }
    if (taken.state === 'completed') state.steered.delete(taken.promptId);
    return NOTHING;
  }
  return dropped('other-turn');
}

function mapInit(state: ChatMapperState, frame: unknown): ChatMapped {
  const taken = takeInit(frame);
  if (taken === null) return dropped('invalid');
  const { turn } = state;
  // The CLI runs one turn at a time: an `init` between a prompt's `started` and its end is that
  // turn's, and one that no `started` precedes opens a turn the CLI started by itself (C31).
  const own = turn !== null && turn.started && !turn.ended;
  if (!own) state.selfTurn = true;
  // Whether a Stop can drop a message the CLI holds, as this process's `init` says (M23, C43); and its commands' names (C60).
  state.cancelsQueued = taken.cancelsQueued;
  state.listed = { commandNames: taken.commandNames, skillNames: taken.skillNames, terminalNames: taken.terminalNames };
  // The check is made on every `init` the process sends, a turn the CLI started by itself included (C83):
  // against the mode in force and that mode's own tools (M22, C5).
  if (!reportsMode(state.mode, taken.mode) || !reportsTools(state.mode, taken.tools)) return { events: [], effects: [{ type: 'overruled' }], drop: own ? null : 'other-turn', unread: false };
  if (!own) return dropped('other-turn');
  turn.inited = true;
  state.sessionId = taken.sessionId ?? state.sessionId;
  // The model in force, by the resolved id the CLI names (C33). Nothing else of `init` leaves here.
  return events(taken.model === null ? [] : [{ type: 'in-force', turnId: turn.runtimeId, model: taken.model }]);
}

/** The session's reference, reported once: at its first reply from a model (C60, C87). */
function reference(state: ChatMapperState): AgentEvent[] {
  if (state.referenced || state.sessionId === null) return [];
  state.referenced = true;
  return [{ type: 'session-started', reference: state.sessionId, folder: state.folder }];
}

const newReply = (id: string): ChatMapperReply => ({ id, opened: [], frames: 0, texts: new Map(), thinking: new Map() });

/** A thinking item's start (M20a, C17): opened at its block's start, with nothing of it yet. */
const thinkingStarted = (turnId: string, itemId: string, workerId: string | null): AgentEvent => ({ type: 'activity-started', turnId, itemId, ...owned(workerId), activityType: 'thinking', name: 'thinking', summary: '' });

/**
 * A block of a reply begins (M19, C11; M20a, C17): a text opens its message, empty and with no
 * phase said (C79), and a thinking opens its item. Null for a block that is neither, one of a reply
 * whose start never came, and one already opened.
 */
function blockStarted(reply: ChatMapperReply | null, event: Extract<StreamEvent, { kind: 'block' }>, turnId: string, workerId: string | null): { readonly event: AgentEvent; readonly text: boolean } | null {
  // A block of a reply whose start never came: its frame will be a whole message (C11).
  if (reply === null || reply.opened.includes(event.index)) return null;
  reply.opened.push(event.index);
  if (!event.text && !event.thinking) return null;
  const itemId = `${reply.id}#${event.index}`;
  // An id that could not be one is no item's: the block's frame is then whole under its own.
  if (itemId.length > MAX_AGENT_ID) return null;
  if (event.thinking) {
    reply.thinking.set(event.index, itemId);
    return { event: thinkingStarted(turnId, itemId, workerId), text: false };
  }
  reply.texts.set(event.index, { itemId, completed: false, written: 0 });
  return { event: { type: 'message-delta', turnId, itemId, phase: null, text: '', ...owned(workerId) }, text: true };
}

/** More of a text block's text (M19, C10): the message it is, or why it is none. */
function textDelta(reply: ChatMapperReply | null, event: Extract<StreamEvent, { kind: 'text' }>): { readonly itemId: string } | FrameDropReason | null {
  const text = reply?.texts.get(event.index);
  if (text === undefined) return 'unopened-item';
  if (text.completed) return 'completed-item';
  if (event.text === '') return null;
  text.written += event.text.length;
  return { itemId: text.itemId };
}

/** A reply as it is written (M19, C10–C12): its start, a block's start, and a text block's text. */
function mapStream(state: ChatMapperState, frame: unknown): ChatMapped {
  const taken = takeStream(frame);
  if (taken === null) return dropped('invalid');
  if (taken.parent !== null) return mapWorkerFrame(state, taken.parent, frame);
  const { event } = taken;
  // What is not read is passed over, and is no drop (C10).
  if (event.kind === 'other') return NOTHING;
  if (event.kind === 'reply-end') {
    const turn = inFlight(state);
    if (turn !== null) endReply(turn.actions, state.reply);
    state.reply = null;
    const resumed = turn === null ? null : action(turn);
    return resumed === null ? NOTHING : events([resumed]);
  }
  const turn = inFlight(state);
  if (turn === null) return dropped('other-turn');
  if (event.kind === 'reply') {
    // Another reply begins: the one before it is forgotten, whatever became of it.
    endReply(turn.actions, state.reply);
    state.reply = event.replyId === null ? null : newReply(event.replyId);
    // A model answers: the conversation can be resumed by the id its `init` named, from here on and
    // before any of its text (C60). The CLI's own replies send no such start.
    const resumed = action(turn);
    return events([...(event.fromModel ? reference(state) : []), ...(resumed === null ? [] : [resumed])]);
  }
  if (event.kind === 'block') {
    const opened = blockStarted(state.reply, event, turn.runtimeId, null);
    if (opened === null) return NOTHING;
    if (!opened.text) return events([opened.event]);
    if (opened.event.type === 'message-delta') turn.actions.start(opened.event.itemId, { kind: 'writing', message: true });
    const relabel = action(turn);
    return events([opened.event, ...(relabel === null ? [] : [relabel])]);
  }
  if (event.kind === 'block-end') {
    const text = state.reply?.texts.get(event.index);
    if (text === undefined) return NOTHING;
    turn.actions.end(text.itemId);
    const resumed = action(turn);
    return resumed === null ? NOTHING : events([resumed]);
  }
  const text = textDelta(state.reply, event);
  if (text === null) return NOTHING;
  if (typeof text === 'string') return dropped(text);
  // The turn's last text from its first words on, and not from its frame (C13, C70): a completed end
  // names it as the answer (C74) though the frame that would complete it never came.
  turn.lastText = text.itemId;
  return events([{ type: 'message-delta', turnId: turn.runtimeId, itemId: text.itemId, phase: null, text: event.text }]);
}

/** Which block of its reply a frame is (M19, C11): the next one its events opened. Null for a frame of no reply being written. */
function frameIndex(reply: ChatMapperReply | null, replyId: string | null): number | null {
  if (reply === null || replyId !== reply.id) return null;
  const index = reply.opened[reply.frames];
  reply.frames += 1;
  return index ?? null;
}

/**
 * The message a text frame is (M19, C11): the one its block opened, where the frame is the next of
 * a reply whose events opened that block as a text; its own `uuid` otherwise (M16, C77).
 */
function frameItem(reply: ChatMapperReply | null, index: number | null, uuid: string | null, texts: number, blocks: number): { readonly itemId: string | null; /** How much of it the deltas brought: null for a text no block opened. */ readonly written: number | null } {
  // One block a frame, and that block the text that was opened: anything else is not what was opened.
  const opened = reply === null || index === null || texts !== 1 || blocks !== 1 ? undefined : reply.texts.get(index);
  if (opened === undefined || opened.completed) return { itemId: uuid, written: null };
  opened.completed = true;
  return { itemId: opened.itemId, written: opened.written };
}

/**
 * A frame's thinking block, as its item (M20a, C9, C17): the one its block's start opened, which
 * this completes with its text where it has one; or, where no start came, an item made whole here,
 * for which no duration of fat-g's is measured. The text is the provider's, and never anything
 * fat-g wrote: the installed CLI sends it empty.
 */
function thinkingEvents(reply: ChatMapperReply | null, index: number | null, uuid: string | null, block: Extract<AssistantBlock, { type: 'thinking' }>, alone: boolean, turnId: string, workerId: string | null): AgentEvent[] {
  const said = block.text === null ? {} : { thinking: block.text };
  const opened = reply === null || index === null || !alone ? undefined : reply.thinking.get(index);
  if (opened !== undefined && reply !== null && index !== null) {
    reply.thinking.delete(index);
    return [{ type: 'activity-ended', turnId, itemId: opened, ...owned(workerId), status: 'completed', ...said }];
  }
  const itemId = uuid === null ? null : `${uuid}#thinking`;
  if (itemId === null || itemId.length > MAX_AGENT_ID) return [];
  return [thinkingStarted(turnId, itemId, workerId), { type: 'activity-ended', turnId, itemId, ...owned(workerId), status: 'completed', ...said, untimed: true }];
}

/** A whole text of Claude's: commentary, as every one is until its turn's end names the answer (C74). */
function whole(turn: ChatMapperTurn, itemId: string, text: string, cut: boolean): AgentEvent {
  return { type: 'message', turnId: turn.runtimeId, role: 'assistant', itemId, phase: 'commentary', text, ...(cut ? { cut: true } : {}) };
}

/** At a turn's end, the texts its Stop left unfinished (C80): completed after all where the turn completed, and left as they are otherwise. */
function settleHeld(turn: ChatMapperTurn, outcome: 'completed' | 'interrupted' | 'failed'): AgentEvent[] {
  const held = turn.held.splice(0);
  return outcome === 'completed' ? held.map((text) => whole(turn, text.itemId, text.text, text.cut)) : [];
}

function mapAssistant(state: ChatMapperState, frame: unknown): ChatMapped {
  const taken = takeAssistant(frame);
  if (taken === null) return dropped('invalid');
  // A worker's frame is no message, and no action, of the session's (C34): it is the worker's own (M20a, C22).
  if (taken.parent !== null) return mapWorkerFrame(state, taken.parent, frame);
  const turn = inFlight(state);
  if (turn === null) return dropped('other-turn');
  const list: AgentEvent[] = [];
  // The session's first frame from a model, where no reply's start came before it: the conversation
  // is one Claude answered in, and can be resumed by the id its `init` named (C87). Before that
  // frame's own events.
  if (taken.fromModel) list.push(...reference(state));
  if (taken.error) {
    turn.detail = errorDetail(taken.blocks) ?? turn.detail;
    return events(list);
  }
  const texts = taken.blocks.flatMap((block) => (block.type === 'text' ? [block] : []));
  // Which block of its reply the frame is, counted whatever the block: a thinking or a tool's frame is one too.
  const index = frameIndex(state.reply, taken.replyId);
  const { itemId, written } = frameItem(state.reply, index, taken.uuid, texts.length, taken.blocks.length);
  if (texts.length > 0) {
    // One message a frame: the one its block opened as it was written, which this completes (M19,
    // C11), or under the frame's own id, the frames of one reply sharing a message id (C77).
    if (itemId === null) return { events: list, effects: [], drop: 'invalid', unread: false };
    const text = texts.map((block) => block.text).join('\n\n');
    const cut = texts.some((block) => block.cut);
    if (turn.stopped) {
      // The frame the CLI sends with what it had written when the Stop came (C80): it does not complete
      // the message. Opened here where no block opened it, and brought up to the frame's text.
      if (written === null) list.push({ type: 'message-delta', turnId: turn.runtimeId, itemId, phase: null, text: '' });
      const rest = text.slice(written ?? 0);
      if (rest !== '') list.push({ type: 'message-delta', turnId: turn.runtimeId, itemId, phase: null, text: rest });
      turn.held.push({ itemId, text, cut });
    } else {
      list.push(whole(turn, itemId, text, cut));
    }
    turn.lastText = itemId;
    turn.actions.end(itemId);
    turn.kind = 'writing';
    turn.file = null;
    // The turn's latest commentary is the action's label from here on (C38): its first line, cut.
    const line = cutLine(text);
    turn.commentary = line === '' ? turn.commentary : line;
  }
  for (const block of taken.blocks) {
    if (block.type === 'thinking') {
      turn.kind = 'thinking';
      turn.file = null;
      list.push(...thinkingEvents(state.reply, index, taken.uuid, block, taken.blocks.length === 1, turn.runtimeId, null));
    } else if (block.type === 'tool') {
      turn.kind = block.kind;
      turn.file = block.file;
      // The question tool's use opens no activity (M21, C19): it is kept for the request that follows it.
      if (block.tool !== null && block.tool.question) askQuestion(turn.questions, block.tool.itemId);
      // Nor does a plan's (M22b, C23): its line stands for it, from the request that follows.
      else if (block.tool !== null && block.tool.plan) { if (!turn.plans.has(block.tool.itemId)) turn.plans.set(block.tool.itemId, { requestId: null, decided: false }); }
      // Any other tool's use is an activity from here to its result (M20a, C17): once.
      else if (block.tool !== null && !turn.tools.has(block.tool.itemId) && !turn.actions.ended(block.tool.itemId)) {
        turn.tools.set(block.tool.itemId, block.tool.activityType);
        startTool(turn.actions, block);
        // An `Agent` tool use is an attempted launch until a worker is paired with it (C23).
        if (block.tool.activityType === 'worker') state.launches.set(block.tool.itemId, { turnId: turn.runtimeId, name: block.tool.start.name, summary: block.tool.start.summary, model: block.tool.model, agentType: block.tool.agentType });
        list.push(toolStarted(turn.runtimeId, block.tool, null));
      }
    }
  }
  const relabel = taken.blocks.length === 0 ? null : action(turn);
  if (relabel !== null) list.push(relabel);
  return events(list);
}

/** A question's use (M21, C19): kept under its owner by its tool use, once, and no activity. */
function askQuestion(questions: Map<string, ChatMapperQuestion>, toolUseId: string): void {
  if (!questions.has(toolUseId)) questions.set(toolUseId, { requestId: null, answered: false, declined: false });
}

/**
 * A question's tool result (M21, C19, C62, C63), or null for a result that is no question's. It is
 * read for its error flag alone and ends no activity. Where its request was answered it is the
 * CLI's word that it took the answer, error or not; where the CLI took the request back, or fat-g
 * refused it, it says nothing more.
 */
function questionResult(questions: Map<string, ChatMapperQuestion>, result: TakenToolResult): { readonly events: AgentEvent[]; readonly effects: ChatMapperEffect[] } | null {
  const question = questions.get(result.toolUseId);
  if (question === undefined) return null;
  questions.delete(result.toolUseId);
  if (question.requestId === null) return { events: [], effects: [] };
  return {
    events: question.answered ? [{ type: 'question-resolved', requestId: question.requestId, reason: 'confirmed' }] : [],
    // A declined question's result is an error by design (M100b, K1): the CLI took the decline.
    effects: [{ type: 'question-closed', requestId: question.requestId, failed: question.answered && !question.declined && result.failed }],
  };
}

/**
 * A plan's tool result (M22b, C10, C11), or null for one that is no plan's: where fat-g wrote the
 * user's decision it is the CLI's word that it took it, whatever its error flag; where the CLI took the
 * request back, or fat-g refused it, it says nothing more.
 */
function planResult(plans: Map<string, ChatMapperPlan>, result: TakenToolResult): { readonly events: AgentEvent[]; readonly effects: ChatMapperEffect[] } | null {
  const plan = plans.get(result.toolUseId);
  if (plan === undefined) return null;
  plans.delete(result.toolUseId);
  if (plan.requestId === null) return { events: [], effects: [] };
  return { events: plan.decided ? [{ type: 'plan-resolved', requestId: plan.requestId, reason: 'confirmed' }] : [], effects: [{ type: 'plan-closed', requestId: plan.requestId }] };
}

/**
 * The result of a tool use leave was asked for (M22, C12, C76), or null for a result of no such use.
 * Where fat-g wrote the user's decision it is the CLI's word that it took it, error or not; and for
 * a denial, `declined` says so of the action's own activity. The result goes on to end that
 * activity, which this does not.
 */
function approvalResult(approvals: Map<string, ChatMapperApproval>, result: TakenToolResult): { readonly events: AgentEvent[]; readonly effects: ChatMapperEffect[]; readonly declined: Declined | null } | null {
  const approval = approvals.get(result.toolUseId);
  if (approval === undefined) return null;
  approvals.delete(result.toolUseId);
  if (approval.requestId === null) return { events: [], effects: [], declined: null };
  return {
    events: approval.decided === null ? [] : [{ type: 'approval-resolved', requestId: approval.requestId, reason: 'confirmed' }],
    effects: [{ type: 'approval-closed', requestId: approval.requestId }],
    declined: approval.decided === 'denied' ? { by: 'user' } : null,
  };
}

/** Why the action a result ends was declined (M22, C76), or null for one that was not: the user's denial, or a rule's that was told before the tool use was known. */
function declinedResult(state: ChatMapperState, approved: { readonly declined: Declined | null } | null, toolUseId: string): Declined | null {
  const rule = state.denied.get(toolUseId);
  state.denied.delete(toolUseId);
  if (approved !== null && approved.declined !== null) return approved.declined;
  return rule === undefined ? null : { by: rule ? 'rule' : null };
}

/** The session's own tool results (M20a, C18): each ends the tool use it names. */
function mapResults(state: ChatMapperState, results: readonly TakenToolResult[]): ChatMapped {
  const turn = inFlight(state);
  if (turn === null) return dropped('other-turn');
  const list: AgentEvent[] = [];
  const effects: ChatMapperEffect[] = [];
  let unopened = false;
  for (const result of results) {
    // The session's own question (M21, C72): its result comes here, and needs the turn in flight.
    const asked = questionResult(turn.questions, result);
    if (asked !== null) { list.push(...asked.events); effects.push(...asked.effects); continue; }
    // A plan (M22b, C10, C11): its result ends no activity, an error one included — a feedback's is by design.
    const planned = planResult(turn.plans, result);
    if (planned !== null) { list.push(...planned.events); effects.push(...planned.effects); continue; }
    // A request to act (M22, C12): the result says the CLI took the decision, and then ends the action's own activity.
    const approved = approvalResult(turn.approvals, result);
    if (approved !== null) { list.push(...approved.events); effects.push(...approved.effects); }
    // A rule's denial ended it already (C76): its result is passed over.
    if (turn.passed.delete(result.toolUseId)) continue;
    const declined = declinedResult(state, approved, result.toolUseId);
    const type = turn.tools.get(result.toolUseId);
    // A result that names no open item (Risk 6): dropped, and counted once for its frame.
    if (type === undefined) { unopened = true; continue; }
    turn.tools.delete(result.toolUseId);
    turn.actions.end(result.toolUseId);
    // Once a worker is paired with it, a worker item's result ends nothing of it: its worker's end does (C23).
    if (type === 'worker' && state.paired.has(result.toolUseId)) continue;
    state.launches.delete(result.toolUseId);
    list.push(toolEnded(turn.runtimeId, result, null, declined));
  }
  const resumed = action(turn);
  if (resumed !== null) list.push(resumed);
  return { events: list, effects, drop: unopened ? 'unopened-item' : null, unread: false };
}

function mapUser(state: ChatMapperState, frame: unknown): ChatMapped {
  const taken = takeUser(frame);
  // A frame with no tool result — a prompt's echo, an interrupt's mark, a worker's instruction — is not read, as before (C18, C32).
  if (taken === null || taken.results.length === 0) return UNREAD;
  return taken.parent === null ? mapResults(state, taken.results) : mapWorkerFrame(state, taken.parent, frame);
}

/**
 * A worker's frame (M20a, C20, C22): whose it is by the parent tool use it names, which
 * `task_started` paired with a worker. One that comes before its pairing is held for it; one of a
 * worker that has ended changes nothing.
 */
function mapWorkerFrame(state: ChatMapperState, parent: string, frame: unknown): ChatMapped {
  const taskId = state.paired.get(parent);
  if (taskId === undefined) {
    if (parent === '' || state.waiting.length >= MAX_WAITING_FRAMES) return dropped('other-worker');
    state.waiting.push({ parent, frame });
    return { events: [], effects: [{ type: 'worker-frame-held', parent }], drop: null, unread: false };
  }
  const worker = state.workers.get(taskId);
  if (worker === undefined || worker.startedIn === null) return NOTHING;
  const turnId = worker.startedIn;
  const kind = frameKind(frame);
  if (kind === 'tool-results') {
    const list: AgentEvent[] = [];
    const effects: ChatMapperEffect[] = [];
    let unopened = false;
    for (const result of takeUser(frame)?.results ?? []) {
      // The worker's own question (M21, C72): its result comes by this path, with or without a turn of the session's.
      const asked = questionResult(worker.questions, result);
      if (asked !== null) { list.push(...asked.events); effects.push(...asked.effects); continue; }
      // The worker's own request to act (M22, C11, C12), by the same path.
      const approved = approvalResult(worker.approvals, result);
      if (approved !== null) { list.push(...approved.events); effects.push(...approved.effects); }
      if (worker.passed.delete(result.toolUseId)) continue;
      const declined = declinedResult(state, approved, result.toolUseId);
      if (worker.tools.delete(result.toolUseId)) {
        worker.actions.end(result.toolUseId);
        list.push(toolEnded(turnId, result, taskId, declined));
      } else unopened = true;
    }
    if (list.length > 0) list.push(...workerAction(taskId, worker));
    return { events: list, effects, drop: unopened ? 'unopened-item' : null, unread: false };
  }
  if (kind === 'stream') {
    // K2 saw no stream event of a worker's; one that came is the worker's own text, as it is written (C22).
    const event = takeStream(frame)?.event;
    if (event === undefined || event.kind === 'other') return NOTHING;
    if (event.kind === 'reply-end') { endReply(worker.actions, worker.reply); worker.reply = null; return events(workerAction(taskId, worker)); }
    if (event.kind === 'reply') { endReply(worker.actions, worker.reply); worker.reply = event.replyId === null ? null : newReply(event.replyId); return events(workerAction(taskId, worker)); }
    if (event.kind === 'block') {
      const opened = blockStarted(worker.reply, event, turnId, taskId);
      if (opened?.text === true) worker.said = true;
      if (opened?.text && opened.event.type === 'message-delta') worker.actions.start(opened.event.itemId, { kind: 'writing', message: true });
      return opened === null ? NOTHING : events([opened.event, ...workerAction(taskId, worker)]);
    }
    if (event.kind === 'block-end') {
      const text = worker.reply?.texts.get(event.index);
      if (text === undefined) return NOTHING;
      worker.actions.end(text.itemId);
      return events(workerAction(taskId, worker));
    }
    const text = textDelta(worker.reply, event);
    if (text === null) return NOTHING;
    if (typeof text === 'string') return dropped(text);
    worker.said = true;
    return events([{ type: 'message-delta', turnId, itemId: text.itemId, phase: null, text: event.text, workerId: taskId }]);
  }
  const taken = takeAssistant(frame);
  if (taken === null) return dropped('invalid');
  // A frame the CLI marked as an error is no message of the worker's: its end says how it ended.
  if (taken.error) return NOTHING;
  const list: AgentEvent[] = [];
  // The model its frame names resolves the alias its launch asked for (M106, C14; K1): once, for the
  // list, and for its item by a second start of it, before anything else the frame says.
  if (taken.model !== null && taken.model !== worker.model) {
    worker.model = taken.model;
    list.push({ type: 'worker-model', workerId: taskId, model: taken.model });
    if (worker.toolUseId !== null && worker.item !== null) list.push({ type: 'activity-started', turnId, itemId: worker.toolUseId, activityType: 'worker', name: worker.item.name, summary: worker.item.summary, pairedWorkerId: taskId, model: taken.model });
  }
  const texts = taken.blocks.flatMap((block) => (block.type === 'text' ? [block] : []));
  const index = frameIndex(worker.reply, taken.replyId);
  const { itemId } = frameItem(worker.reply, index, taken.uuid, texts.length, taken.blocks.length);
  // The worker's own message (C22): commentary, as every whole text of Claude's is, and never the turn's answer.
  if (texts.length > 0 && itemId !== null) {
    worker.said = true;
    worker.actions.end(itemId);
    list.push({ type: 'message', turnId, role: 'assistant', itemId, phase: 'commentary', text: texts.map((block) => block.text).join('\n\n'), ...(texts.some((block) => block.cut) ? { cut: true } : {}), workerId: taskId });
  }
  for (const block of taken.blocks) {
    if (block.type === 'thinking') list.push(...thinkingEvents(worker.reply, index, taken.uuid, block, taken.blocks.length === 1, turnId, taskId));
    // In a worker's frames too, the question tool's use opens no activity (M21, C72).
    else if (block.type === 'tool' && block.tool !== null && block.tool.question) askQuestion(worker.questions, block.tool.itemId);
    else if (block.type === 'tool' && block.tool !== null && !worker.tools.has(block.tool.itemId) && !worker.actions.ended(block.tool.itemId)) {
      worker.tools.add(block.tool.itemId);
      startTool(worker.actions, block);
      list.push(toolStarted(turnId, block.tool, taskId));
    }
  }
  if (list.length > 0) list.push(...workerAction(taskId, worker));
  return events(list);
}

function mapResult(state: ChatMapperState, frame: unknown): ChatMapped {
  // The `result` of a turn the CLI started by itself ends that turn, and nothing of fat-g's.
  if (state.selfTurn) { state.selfTurn = false; return dropped('other-turn'); }
  const turn = inFlight(state);
  if (turn === null) return dropped('other-turn');
  turn.ended = true;
  turn.actions.clear();
  state.reply = null;
  const { isError } = takeResult(frame);
  const outcome = !isError ? 'completed' : turn.stopped ? 'interrupted' : 'failed';
  return events(settleHeld(turn, outcome), [{ type: 'turn-ended', outcome, answerItemId: outcome === 'completed' ? turn.lastText : null, lost: false, detail: outcome === 'failed' ? turn.detail : null }]);
}

/** `task_started` (C39; M20a, C22, C23): the worker opens, and is paired with the `Agent` tool use that started it. */
function startWorker(state: ChatMapperState, taken: TaskFrame): ChatMapped {
  const { taskId, toolUseId } = taken;
  if (state.workers.has(taskId)) return NOTHING;
  const launch = toolUseId === null ? undefined : state.launches.get(toolUseId);
  const turn = inFlight(state);
  // In the turn that launched it; else the turn in flight, for a worker whose tool use is not known.
  // The model its tool use asked for, an alias, until its own frames name the id (M106, C14); the
  // agent definition `task_started` names, else the one its input did (C20).
  const model = launch?.model ?? null;
  const agentType = taken.agentType ?? launch?.agentType ?? null;
  const named = { ...(model === null ? {} : { model }), ...(agentType === null ? {} : { agentType }) };
  const worker: ChatMapperWorker = { actions: new LiveActions(), lastAction: { kind: 'thinking' }, startedIn: launch?.turnId ?? turn?.runtimeId ?? null, toolUseId: launch === undefined ? null : toolUseId, tools: new Set(), questions: new Map(), approvals: new Map(), passed: new Set(), reply: null, item: launch === undefined ? null : { name: launch.name, summary: launch.summary }, model, said: false };
  state.workers.set(taskId, worker);
  const list: AgentEvent[] = [{ type: 'worker-started', workerId: taskId, ...(taken.description === null ? {} : { description: taken.description }), ...named }];
  if (toolUseId === null) return events(list);
  remember(state.paired, toolUseId, taskId, (_parent, paired) => state.workers.has(paired));
  if (turn !== null) {
    if (taken.background === true) turn.actions.end(toolUseId);
    else turn.actions.link(toolUseId, taskId);
  }
  if (launch !== undefined) {
    state.launches.delete(toolUseId);
    // The worker item learns its worker (C23): a second start for the tool use, which opens nothing.
    list.push({ type: 'activity-started', turnId: launch.turnId, itemId: toolUseId, activityType: 'worker', name: launch.name, summary: launch.summary, pairedWorkerId: taskId, ...named });
  }
  const resumed = turn === null ? null : action(turn);
  if (resumed !== null) list.push(resumed);
  // What came for it before it was known is its own now, in the order it came.
  const waiting = state.waiting.filter((held) => held.parent === toolUseId);
  if (waiting.length === 0) return events(list);
  expireWaitingFrames(state, toolUseId);
  const effects: ChatMapperEffect[] = [{ type: 'worker-frames-claimed', parent: toolUseId }];
  let drop: FrameDropReason | null = null;
  for (const held of waiting) {
    const mapped = mapWorkerFrame(state, toolUseId, held.frame);
    list.push(...mapped.events);
    drop ??= mapped.drop;
  }
  return { events: list, effects, drop, unread: false };
}

function mapTask(state: ChatMapperState, kind: 'task-started' | 'task-progress' | 'task-updated' | 'task-notification', frame: unknown): ChatMapped {
  const taken = takeTask(kind, frame);
  if (taken === null) return dropped('invalid');
  const { taskId } = taken;
  if (kind === 'task-started') return startWorker(state, taken);
  const worker = state.workers.get(taskId);
  if (worker === undefined) {
    // A worker that has ended, or that never opened here: its later frames change nothing (M14,
    // C115) — but the notification that follows the frame which ended it still brings its report
    // and its duration, for its item (M20a, C22), and the report as its message (M106, C45).
    const closed = kind === 'task-notification' ? state.ended.get(taskId) : undefined;
    if (closed === undefined || taken.ended === null) return NOTHING;
    state.ended.delete(taskId);
    return events([...reportOf(taskId, closed.turnId, closed.said, taken), workerItemEnded(closed.turnId, closed.itemId, taken.ended, taken)]);
  }
  if (kind === 'task-progress') return events(workerAction(taskId, worker));
  if (taken.ended === null) return NOTHING;
  // It ends once, at the first of its two closing frames (C39).
  state.workers.delete(taskId);
  const notified = kind === 'task-notification';
  if (!notified && worker.toolUseId !== null && worker.startedIn !== null) remember(state.ended, taskId, { turnId: worker.startedIn, itemId: worker.toolUseId, said: worker.said });
  const list = workerEnded(taskId, worker, taken.ended, notified ? taken : null);
  const turn = inFlight(state);
  if (turn !== null) {
    turn.actions.endTarget(taskId);
    const resumed = action(turn);
    if (resumed !== null) list.push(resumed);
  }
  return events(list);
}

/**
 * A rule of the user's own configuration refused a tool's use (M22, C76): no request was made, and
 * fat-g was not asked. The activity of the tool use it names ends as declined, by a rule where the
 * frame says so, and the error result that follows is passed over. A frame that comes before its
 * tool use is known — a worker's can (K2) — is kept for that result, which then ends it the same.
 */
function mapDenied(state: ChatMapperState, frame: unknown): ChatMapped {
  const taken = takeDenied(frame);
  const { toolUseId } = taken;
  if (toolUseId === null) return dropped('invalid');
  const declined: Declined = { by: taken.rule ? 'rule' : null };
  const ended = (turnId: string, workerId: string | null): ChatMapped => events([{ type: 'activity-ended', turnId, itemId: toolUseId, ...owned(workerId), status: 'declined', ...declinedBy(declined) }]);
  const turn = inFlight(state);
  if (turn !== null && turn.tools.delete(toolUseId)) {
    turn.actions.end(toolUseId);
    turn.passed.add(toolUseId);
    state.launches.delete(toolUseId);
    const mapped = ended(turn.runtimeId, null);
    const resumed = action(turn);
    return resumed === null ? mapped : { ...mapped, events: [...mapped.events, resumed] };
  }
  for (const [taskId, worker] of state.workers) {
    if (worker.startedIn === null || !worker.tools.delete(toolUseId)) continue;
    worker.passed.add(toolUseId);
    worker.actions.end(toolUseId);
    const mapped = ended(worker.startedIn, taskId);
    return { ...mapped, events: [...mapped.events, ...workerAction(taskId, worker)] };
  }
  remember(state.denied, toolUseId, taken.rule);
  return NOTHING;
}

/** One frame. The state is changed in place; the answer is what the session then does. */
export function mapChatFrame(state: ChatMapperState, frame: unknown): ChatMapped {
  const kind = frameKind(frame);
  switch (kind) {
    case 'lifecycle': return mapLifecycle(state, frame);
    case 'init': return mapInit(state, frame);
    case 'assistant': return mapAssistant(state, frame);
    case 'stream': return mapStream(state, frame);
    case 'tool-results': return mapUser(state, frame);
    case 'result': return mapResult(state, frame);
    case 'task-started':
    case 'task-progress':
    case 'task-updated':
    case 'task-notification':
      return mapTask(state, kind, frame);
    case 'permission-denied': return mapDenied(state, frame);
    // A request is the session's to answer, and so is the progress of one of its own (M20b, C14),
    // the CLI's taking one back (M21, C20), the mode a status frame names (M22, C7) and a command list
    // (M23, C60); whatever else is not read at all (C32).
    case 'request':
    case 'cancel':
    case 'request-progress':
    case 'status':
    case 'commands':
    case 'unread':
      return UNREAD;
  }
}

// ── A question's request (M21, C11, C19, C21, C65, C72) ───────────────────────────────────────
// A request is the session's to answer, and no frame of the mapper's: the session asks here whose
// it is, and says what became of it, so that the result of its tool use reads as it should.

/** A question's request, by what places it: its own id, the tool use that carries its questions, and the worker it names. */
export interface AskedQuestion {
  readonly requestId: string;
  readonly toolUseId: string;
  readonly agentId: string | null;
}

/** Whose a placed question is: the turn every event of it names, and its worker where it is one's. */
export interface PlacedQuestion {
  readonly turnId: string;
  readonly workerId: string | null;
}

/** Whose a placed request is, a question's or one to act (M22, C11): both are placed by one rule. */
export type PlacedRequest = PlacedQuestion;

const questionsOf = (state: ChatMapperState, workerId: string | null): Map<string, ChatMapperQuestion> | undefined => (workerId === null ? state.turn?.questions : state.workers.get(workerId)?.questions);
const approvalsOf = (state: ChatMapperState, workerId: string | null): Map<string, ChatMapperApproval> | undefined => (workerId === null ? state.turn?.approvals : state.workers.get(workerId)?.approvals);

/**
 * Where a request belongs (C11, C21, C65; M22, C11), or null for one that cannot be placed, which
 * the session refuses on the wire.
 *
 *   it names a worker that is paired and open     that worker's, whatever the session's turn: a
 *                                                 worker runs on after the turn that started it
 *   it names a worker that was paired, and ended  none: nothing of an ended worker's is kept
 *   it names no worker, or one never paired       the session's own, where the prompt's turn is in
 *                                                 flight — started, and its `result` not come —
 *                                                 and none otherwise
 */
function ownerOf(state: ChatMapperState, agentId: string | null): PlacedRequest | null {
  const worker = agentId === null ? undefined : state.workers.get(agentId);
  if (agentId !== null && worker !== undefined && worker.toolUseId !== null && worker.startedIn !== null) return { turnId: worker.startedIn, workerId: agentId };
  if (agentId !== null && worker === undefined && [...state.paired.values()].includes(agentId)) return null;
  const turn = inFlight(state);
  return turn === null ? null : { turnId: turn.runtimeId, workerId: null };
}

/**
 * Where a question's request belongs (C11, C21, C65), by the rule above. A placed request completes
 * the question its tool use opened, or opens it where that block never came; a second request for
 * a tool use that already has one is none.
 */
export function placeQuestion(state: ChatMapperState, asked: AskedQuestion): PlacedQuestion | null {
  const placed = ownerOf(state, asked.agentId);
  if (placed === null) return null;
  const questions = questionsOf(state, placed.workerId);
  if (questions === undefined) return null;
  const known = questions.get(asked.toolUseId);
  if (known === undefined) questions.set(asked.toolUseId, { requestId: asked.requestId, answered: false, declined: false });
  else if (known.requestId !== null) return null;
  else known.requestId = asked.requestId;
  return placed;
}

/**
 * fat-g wrote an answer for a placed request (C62, C63) — or, `declined`, the user's Skip of it
 * (M100b, C31): its tool result is then the CLI's word that it took it.
 */
export function questionAnswered(state: ChatMapperState, placed: PlacedQuestion, toolUseId: string, declined = false): void {
  const question = questionsOf(state, placed.workerId)?.get(toolUseId);
  if (question === undefined || question.requestId === null) return;
  question.answered = true;
  question.declined = declined;
}

/** A placed request is over with no answer of fat-g's — the CLI took it back, or fat-g refused it (C20): its tool result says nothing more. */
export function questionReleased(state: ChatMapperState, placed: PlacedQuestion, toolUseId: string): void {
  const question = questionsOf(state, placed.workerId)?.get(toolUseId);
  if (question === undefined) return;
  question.requestId = null;
  question.answered = false;
  question.declined = false;
}

// ── A request to act (M22, C11, C12, C76) ─────────────────────────────────────────────────────
// Placed as a question's is, and kept by the tool use it asks leave for: that tool use's activity is
// opened by its own block, whenever that comes, and the request stands beside it.

/**
 * Where a request to act belongs (C11), or null for one that cannot be placed, which the session
 * refuses on the wire: by the rule a question is placed by. A second request for a tool use that
 * already has one is none.
 */
export function placeApproval(state: ChatMapperState, asked: AskedQuestion): PlacedRequest | null {
  const placed = ownerOf(state, asked.agentId);
  const approvals = placed === null ? undefined : approvalsOf(state, placed.workerId);
  if (placed === null || approvals === undefined || approvals.has(asked.toolUseId)) return null;
  approvals.set(asked.toolUseId, { requestId: asked.requestId, decided: null });
  return placed;
}

/**
 * A plan's request, placed under the session's turn in flight (M22b, C10): never a worker's, which
 * has no plan, and never after the turn's `result`. Null where it cannot be placed, or is held already.
 */
export function placePlan(state: ChatMapperState, toolUseId: string, requestId: string): PlacedRequest | null {
  const turn = inFlight(state);
  if (turn === null || turn.ended) return null;
  const held = turn.plans.get(toolUseId);
  if (held !== undefined && held.requestId !== null) return null;
  turn.plans.set(toolUseId, { requestId, decided: false });
  return { turnId: turn.runtimeId, workerId: null };
}

/** fat-g wrote the user's decision on a placed plan (M22b, C11): its result is then the CLI's word that it took it. */
export function planDecided(state: ChatMapperState, toolUseId: string): void {
  const plan = inFlight(state)?.plans.get(toolUseId);
  if (plan !== undefined && plan.requestId !== null) plan.decided = true;
}

/** A placed plan is over with no decision of the user's — the CLI took it back, or fat-g refused it: its result says nothing of it. */
export function planReleased(state: ChatMapperState, toolUseId: string): void {
  const plan = inFlight(state)?.plans.get(toolUseId);
  if (plan === undefined) return;
  plan.requestId = null;
  plan.decided = false;
}

/** fat-g wrote the user's decision for a placed request (C12, C76): its tool result is then the CLI's word that it took it, and a denied action's activity ends declined. */
export function approvalDecided(state: ChatMapperState, placed: PlacedRequest, toolUseId: string, denied: boolean): void {
  const approval = approvalsOf(state, placed.workerId)?.get(toolUseId);
  if (approval !== undefined && approval.requestId !== null) approval.decided = denied ? 'denied' : 'allowed';
}

/** A placed request is over with no decision of the user's — the CLI took it back, or fat-g refused it: its tool result says nothing of it, and ends its activity as the result reads. */
export function approvalReleased(state: ChatMapperState, placed: PlacedRequest, toolUseId: string): void {
  const approval = approvalsOf(state, placed.workerId)?.get(toolUseId);
  if (approval === undefined) return;
  approval.requestId = null;
  approval.decided = null;
}
