// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Frames to events (docs/planning/_archive/M15.md, Design 7; C11, C37–C44, C101, C132, C133; M19.md, Design 2;
// C7, C8; M20a.md, Design 3, 5; C14, C20, C21, C23, C24): a function of the session's mapping state and one frame. It keeps no clock and sends nothing: what needs a
// timer or a request comes back as an effect, for the session to act on.
//
// Whose frame (C37): the session's own thread, or an open worker's; any other is dropped and
// counted. Whose turn (C11): a frame of the session's thread names the turn the `turn/start` reply
// named, else it is dropped and counted. Both are decided when a frame is mapped, not when it came.
//
// A message as it is written (M19, C7, C8): an agent message's `item/started` opens it, with its id
// and its phase and no text; each `item/agentMessage/delta` that names that item appends; and its
// `item/completed` gives the whole text, as before. Whose a delta is, by its own fields: another
// thread's, another turn's, an item's that nothing opened and one's that is complete are dropped
// and counted. An interrupted answer gets no `item/completed`: it stays open, and its turn's end
// leaves it so.
//
// What a session does between its messages (M20a, C14). Every other item is an activity: its
// `item/started` opens it, by its type, and its `item/completed` ends it with its output, its exit
// code, its status and Codex's own duration. A completion that names a turn which has ended still
// ends an item that turn opened (C6), and nothing else of an ended turn changes anything. A
// completion whose start never came is dropped and counted.
//
// A worker belongs to its session (C20, C21). The frames of an open worker's thread give the
// worker's own activities and messages, each event naming the worker and the turn that started it,
// whether or not that turn has ended; its action stays what M15 made of it. A worker's message is
// never the session's: it sets no commentary, no answer and no action line. The item that announced
// the worker is the worker item (C23): it opens with the worker, and ends when the worker does.
//
// Codex announces a worker in two ways, by the model (K3). A `subAgentActivity` item names its
// thread from the start, and a closing one follows: the worker ends once that and its own turn's
// end have both come (C133). A `collabAgentToolCall` whose tool is `spawnAgent` names the thread
// only at its completion, and nothing closes it: its start opens the worker item with what the
// sub-agent is asked, its completion pairs it, and the worker ends at its own turn's end.
//
// An aside's side thread (M20b, C20, C21): an ephemeral fork of the session's thread, whose frames
// come on the session's own connection, named by its thread id. They are mapped as a worker
// thread's are — its messages with their deltas, and what it read as activities — under the
// aside's id and its own turn's, and no worker's: nothing of them is the session's, and a frame of
// the session's thread is untouched by them. A frame of a side thread whose turn has ended, or was
// stopped, is dropped and counted.
//
// The checklist (C24): each `turn/plan/updated` of the session's thread and turn in flight is a
// start for the turn's one checklist item, with the whole list as it then reads. The first opens
// it and each later one replaces its steps; no frame ends it, and its turn's end completes it. It
// comes only where the user's own configuration enables the tool, which nothing here switches on.
//
// A question asked as a request (docs/planning/_archive/M21.md, Design 4; C23, C56, C69). The request itself
// is no frame of these: the session answers it, and holds it. What is mapped is Codex's word that a
// request is over, `serverRequest/resolved`, read for the request it names and given back as an
// effect: whether that was an answer taken or a request withdrawn, only the session knows. The
// empty message a turn that asks in a message ends with is mapped as every message is — opened by
// its start, whole at its completion — and main lets go of a whole message that says nothing.
//
// An action that was refused leave (docs/planning/_archive/M22.md, Design 4, 7; C76, C96). Its item ends
// `declined`, Codex's own status and no failure; where the session wrote that decline at the user's
// Deny it says so here, by the item's id, and the end names the user as who declined it. A request
// for leave is no frame of these either: the session holds it, as it holds a question. Under Codex's
// own reviewer three more notifications come — a review's start, its end, and the reviewer's
// verdict in a sentence — which are counted by the session and mapped to nothing: the reviewed
// action's own item is the chat's record.
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { FrameDropReason } from '@shared/provider-kit/logger';
import type { ActionKind } from '@shared/contracts/sessions';
import { LiveActions, type LiveAction, sameLiveAction } from '@shared/provider-kit/live-actions';
import { cutLine } from '@shared/contracts/agent-events';
import type { MessagePhase } from '@shared/contracts/agent-events';
import { takeDeltaFrame, takeErrorFrame, takeItemFrame, type TakenActivity, type TakenItem, type TakenItemFrame, takePlanDeltaFrame, takePlanFrame, takeResolvedFrame, takeStatusFrame, takeTurnFrame } from './session-schemas';

/** The methods a session's connection subscribes to. Every other reaches the `unhandled` count, unparsed (C37, C38). */
export const MAPPED_METHODS = ['item/started', 'item/agentMessage/delta', 'item/plan/delta', 'item/completed', 'turn/started', 'turn/completed', 'turn/plan/updated', 'error', 'thread/status/changed', 'serverRequest/resolved'] as const;
export type MappedMethod = (typeof MAPPED_METHODS)[number];

/**
 * What Codex's own reviewer sends while it answers in the user's place (M22, C96; K4): counted, and
 * never parsed. No card, notice or item is made of one, and the reviewer's words go nowhere.
 */
export const REVIEW_METHODS = ['item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'guardianWarning'] as const;

/**
 * Each thread's token report (decision 0033): read by the session beside the mapper, which never
 * parses it, for its own thread's context reading. No method is sent for it.
 */
export const TOKEN_USAGE = 'thread/tokenUsage/updated';

/** The agent messages a thread's `item/started` frames opened, by item id (M19, C8): the phase each named, and whether its `item/completed` has come. */
type OpenMessages = Map<string, { readonly phase: MessagePhase; completed: boolean }>;

export interface MapperWorker {
  readonly actions: LiveActions;
  lastAction: LiveAction;
  /** The worker's own turn, once its `turn/started` named it: what its interrupt needs (C132). */
  turnId: string | null;
  /** Its closing item, and its own turn's end: each is held for the other (C133). */
  closing: 'completed' | 'interrupted' | null;
  turnEnd: 'completed' | 'interrupted' | 'failed' | null;
  /** A closing item is to come: false for a worker a spawn call started, which ends at its own turn's end (K3). */
  readonly closes: boolean;
  /** The runtime's id of the turn that started it (M20a, C20): what every event of its items names. */
  readonly startedIn: string;
  /** The id of the item that announced it, which is the worker item (M20a, C23). Null where the announcement had none. */
  readonly itemId: string | null;
  /** The activities of its thread that are open, by item id, and its messages (M20a, C21). */
  readonly activities: Set<string>;
  readonly messages: OpenMessages;
}

export interface MapperTurn {
  readonly actions: LiveActions;
  lastAction: LiveAction;
  /** The runtime's id (C86), which every event names. */
  readonly runtimeId: string;
  /** The CLI's id, from the `turn/start` reply. */
  readonly cliId: string;
  /** Its `turn/started` has come: the turn can be interrupted (C131). */
  started: boolean;
  /** Its end has been reported. It stays here as the last turn: a worker's closing item names it (C133). */
  ended: boolean;
  kind: ActionKind | null;
  file: string | null;
  /** The turn's latest commentary, as a label's input (C43). */
  commentary: string | null;
  /** A failed turn's own message, when an `error` frame carried it (C39). */
  detail: string | null;
  echoed: boolean;
  /** The agent messages an `item/started` of the turn opened, by item id (M19, C8): the phase it named, and whether its `item/completed` has come. */
  readonly messages: OpenMessages;
  /** The activities of the turn that are open, by item id (M20a, C14): what a completion ends, its turn ended or not. */
  readonly activities: Set<string>;
  /** The plans an `item/started` of the turn opened, by item id (M22b, C14), and whether its `item/completed` has come. */
  readonly plans: Map<string, { completed: boolean }>;
  /** The model each spawn call's `item/started` named, by item id (M106, C15): what its completion falls back to. */
  readonly spawnModels: Map<string, string>;
}

/** An aside's side thread, for one of its turns (M20b, C20): the session makes it anew at each question it sends there. */
export interface MapperAside {
  /** Main's id for the aside: what every event of it names. */
  readonly asideId: string;
  /** The runtime's id of the aside's turn in flight. */
  readonly turnId: string;
  /** The side thread's own id for that turn, once the `turn/start` reply has named it. */
  cliId: string | null;
  /** Its `turn/started` has come: the turn can be interrupted (C70). */
  started: boolean;
  /** Its turn has ended, or was stopped: every later frame of the thread is dropped and counted. */
  ended: boolean;
  /** A failed turn's own message, when an `error` frame carried it. */
  detail: string | null;
  readonly messages: OpenMessages;
  readonly activities: Set<string>;
}

export function newAside(asideId: string, turnId: string): MapperAside {
  return { asideId, turnId, cliId: null, started: false, ended: false, detail: null, messages: new Map(), activities: new Set() };
}

export interface MapperState {
  /** The session's own thread. */
  threadId: string;
  turn: MapperTurn | null;
  /** Open workers, by their thread (C44). */
  readonly workers: Map<string, MapperWorker>;
  /** The asides' side threads, by thread (M20b, C20): one that was stopped or given up stays, ended, so that its late frames are known for what they are. */
  readonly asides: Map<string, MapperAside>;
  /**
   * The items whose action the user denied from its card (M22, C76), by item id: the session adds
   * one as it writes that decline, and the item's end, declined, takes it out and names the user.
   */
  readonly denied: Set<string>;
}

export type MapperEffect =
  | { readonly type: 'turn-started' }
  | { readonly type: 'turn-ended'; readonly status: 'completed' | 'interrupted' | 'failed'; readonly detail: string | null }
  /** An aside's turn ended, as its side thread reports it (M20b, C20). */
  | { readonly type: 'aside-turn-ended'; readonly threadId: string; readonly status: 'completed' | 'interrupted' | 'failed'; readonly detail: string | null }
  /** The session's thread left `active`, or came back to it (C89). */
  | { readonly type: 'inactive' }
  | { readonly type: 'active' }
  /** One of a worker's two closing frames has come: hold it for the other (C133). */
  | { readonly type: 'worker-hold'; readonly workerId: string }
  | { readonly type: 'worker-settled'; readonly workerId: string }
  /** Codex says a request of its own is over (M21, C23): the request, as the session holds one. */
  | { readonly type: 'request-resolved'; readonly requestId: string };

export interface Mapped {
  readonly events: readonly AgentEvent[];
  readonly effects: readonly MapperEffect[];
  readonly drop: FrameDropReason | null;
}

const NOTHING: Mapped = { events: [], effects: [], drop: null };
const dropped = (reason: FrameDropReason): Mapped => ({ events: [], effects: [], drop: reason });
const mapped = (events: readonly AgentEvent[]): Mapped => ({ events, effects: [], drop: null });

export function newTurn(runtimeId: string, cliId: string): MapperTurn {
  return { runtimeId, cliId, actions: new LiveActions(), lastAction: { kind: 'thinking' }, started: false, ended: false, kind: null, file: null, commentary: null, detail: null, echoed: false, messages: new Map(), activities: new Set(), plans: new Map(), spawnModels: new Map() };
}

/** A worker as the mapper holds it from its announcement: `startedIn` is the runtime's id of the turn that started it. */
export function newWorker(startedIn: string, itemId: string | null = null, closes = true): MapperWorker {
  return { actions: new LiveActions(), lastAction: { kind: 'thinking' }, turnId: null, closing: null, turnEnd: null, closes, startedIn, itemId, activities: new Set(), messages: new Map() };
}

function action(turn: MapperTurn): AgentEvent | null {
  const current = turn.actions.current();
  turn.kind = current.kind;
  turn.file = current.file ?? null;
  const next = { ...current, ...(current.kind === 'thinking' || turn.commentary === null ? {} : { line: turn.commentary }) };
  if (sameLiveAction(turn.lastAction, next)) return null;
  turn.lastAction = next;
  return { type: 'action-changed', turnId: turn.runtimeId, ...next };
}

function workerAction(workerId: string, worker: MapperWorker): AgentEvent[] {
  const current = worker.actions.current();
  if (sameLiveAction(worker.lastAction, current)) return [];
  worker.lastAction = current;
  return [{ type: 'worker-progressed', workerId, ...current }];
}

function startAction(actions: LiveActions, item: Extract<TakenItem, { type: 'action' }>, id: string | undefined, state: MapperState): void {
  if (id === undefined) return;
  const targets = new Set(item.targets?.filter((target) => state.workers.has(target)));
  const known = targets.size > 0 && targets.size === new Set(item.targets).size;
  actions.start(id, { kind: item.kind, ...(item.file === null ? {} : { file: item.file }),
    ...(item.opens === undefined ? {} : { message: true }),
    ...(item.kind !== 'waiting' ? {} : { wait: { reason: targets.size > 0 ? 'subagents' : 'provider' } }),
    ...(known ? { targets } : {}),
  });
}

/** Whose item an event is: a worker's names it, and the session's own names none. */
const owned = (workerId: string | null): { workerId?: string } => (workerId === null ? {} : { workerId });

/**
 * An item's start, as an activity (M20a, C14, C59). `paired`: for a worker's own item, the worker it
 * started (C23), and `model` the model it runs on, where the announcement named one (M106, C15).
 * `asideId`: the aside whose side thread's item it is (M20b, C20).
 */
function activityStarted(turnId: string, activity: TakenActivity, at: number | null, workerId: string | null, paired: string | null = null, asideId: string | null = null, model: string | null = null): AgentEvent {
  const { start } = activity;
  return {
    type: 'activity-started', turnId, itemId: activity.itemId, ...owned(workerId), ...(asideId === null ? {} : { asideId }), ...(paired === null ? {} : { pairedWorkerId: paired }), ...(model === null ? {} : { model }), activityType: activity.activityType, name: start.name, summary: start.summary,
    ...(typeof start.input === 'string' ? { input: start.input } : {}),
    ...(start.files === undefined || start.files.length === 0 ? {} : { files: [...start.files] }),
    ...(start.changes === undefined || start.changes.length === 0 ? {} : { changes: [...start.changes] }),
    ...(typeof start.thinking === 'string' ? { thinking: start.thinking } : {}),
    ...(activity.startCut === null ? {} : { cut: activity.startCut }),
    ...(at === null ? {} : { providerAt: at }),
  };
}

/**
 * An item's end (M20a, C6, C14): failed on a failed status or a non-zero exit code; declined where
 * Codex says it was refused leave (M22, C76), by the user where `denied` holds its id; else
 * completed, whatever else a completed frame calls it. An MCP call the user denied Codex ends as
 * failed, in words of its own: `denied` says whose Deny it was, and it is declined (decision 0018).
 */
function activityEnded(turnId: string, activity: TakenActivity, at: number | null, workerId: string | null, asideId: string | null = null, denied: Set<string> | null = null): AgentEvent {
  const { end } = activity;
  // Taken out whatever the item's end reads: an id is one item's, and it has ended.
  const wasDenied = denied?.delete(activity.itemId) === true;
  const declined = activity.outcome === 'declined' || (wasDenied && activity.activityType === 'mcp' && activity.outcome === 'failed');
  const byUser = wasDenied && declined;
  return {
    type: 'activity-ended', turnId, itemId: activity.itemId, ...owned(workerId), ...(asideId === null ? {} : { asideId }), status: declined ? 'declined' : activity.outcome === 'failed' ? 'failed' : 'completed',
    ...(byUser ? { declinedBy: 'user' as const } : {}),
    ...(typeof end.output === 'string' ? { output: end.output } : {}),
    ...(activity.exitCode === null ? {} : { exitCode: activity.exitCode }),
    ...(end.files === undefined || end.files.length === 0 ? {} : { files: [...end.files] }),
    ...(end.changes === undefined || end.changes.length === 0 ? {} : { changes: [...end.changes] }),
    ...(typeof end.thinking === 'string' ? { thinking: end.thinking } : {}),
    ...(activity.endCut === null ? {} : { cut: activity.endCut }),
    ...(at === null ? {} : { providerAt: at }),
    ...(activity.durationMs === null ? {} : { durationMs: activity.durationMs }),
  };
}

/** A worker's end, for its item and for the list (C23): the item that announced it ends as its worker does, and is told first. */
function workerEnded(workerId: string, worker: MapperWorker, failed: boolean): AgentEvent[] {
  worker.actions.clear();
  const outcome = failed ? 'failed' : 'completed';
  const ended: AgentEvent = { type: 'worker-ended', workerId, outcome };
  return worker.itemId === null ? [ended] : [{ type: 'activity-ended', turnId: worker.startedIn, itemId: worker.itemId, status: outcome }, ended];
}

/** A worker's one end, settled (C101, C133): failed when either frame says so. */
function endWorker(state: MapperState, workerId: string): AgentEvent[] {
  const worker = state.workers.get(workerId);
  if (worker === undefined) return [];
  state.workers.delete(workerId);
  const events = workerEnded(workerId, worker, worker.closing === 'interrupted' || worker.turnEnd === 'failed' || worker.turnEnd === 'interrupted');
  const turn = state.turn;
  if (turn !== null && !turn.ended) {
    turn.actions.endTarget(workerId);
    const next = action(turn);
    if (next !== null) events.push(next);
  }
  for (const [id, owner] of state.workers) {
    if (owner.turnEnd !== null) continue;
    owner.actions.endTarget(workerId);
    events.push(...workerAction(id, owner));
  }
  return events;
}

/** The settle clock of a worker ran out: it ends by what the one frame said. */
export function expireWorker(state: MapperState, workerId: string): AgentEvent[] {
  return endWorker(state, workerId);
}

/** Every open worker ended as failed (C90): a Stop, a lost process, a lost end. Their later frames find no open worker. */
export function failWorkers(state: MapperState): AgentEvent[] {
  const workers = [...state.workers];
  state.workers.clear();
  return workers.flatMap(([workerId, worker]) => workerEnded(workerId, worker, true));
}

function closing(state: MapperState, workerId: string, kind: 'completed' | 'interrupted'): Mapped {
  const worker = state.workers.get(workerId);
  // Its second frame, or a worker that has ended: nothing more.
  if (worker === undefined || worker.closing !== null) return NOTHING;
  worker.closing = kind;
  if (worker.turnEnd !== null) return { events: endWorker(state, workerId), effects: [{ type: 'worker-settled', workerId }], drop: null };
  return { events: [], effects: [{ type: 'worker-hold', workerId }], drop: null };
}

/**
 * A frame of an open worker's thread (M20a, C21): its items are the worker's own activities and its
 * agent messages the worker's own messages, each naming the worker and the turn that started it.
 * Its action is what M15 made of it (C44), so the agent list is as it was.
 */
function mapWorkerItem(state: MapperState, workerId: string, worker: MapperWorker, frame: TakenItemFrame, started: boolean): Mapped {
  const { item, activity } = frame;
  const turnId = worker.startedIn;
  if (started && activity !== null && worker.actions.ended(activity.itemId)) return NOTHING;
  if (worker.turnId !== null && frame.turnId !== null && frame.turnId !== worker.turnId) return dropped('other-turn');
  if (started) {
    const events: AgentEvent[] = [];
    if (item?.type === 'action') {
      if (worker.turnEnd !== null) return NOTHING;
      startAction(worker.actions, item, activity?.itemId ?? item.opens?.id, state);
      events.push(...workerAction(workerId, worker));
      if (item.opens !== undefined && !worker.messages.has(item.opens.id)) {
        worker.messages.set(item.opens.id, { phase: item.opens.phase, completed: false });
        events.push({ type: 'message-delta', turnId, itemId: item.opens.id, phase: item.opens.phase, text: '', workerId });
      }
    }
    if (activity !== null && !worker.activities.has(activity.itemId)) {
      worker.activities.add(activity.itemId);
      events.push(activityStarted(turnId, activity, frame.at, workerId));
    }
    return mapped(events);
  }
  if (activity !== null) {
    if (!worker.activities.delete(activity.itemId)) return dropped('unopened-item');
    worker.actions.end(activity.itemId);
    return mapped([activityEnded(turnId, activity, frame.at, workerId, null, state.denied), ...(frame.image === undefined ? [] : [{ type: 'image-returned' as const, turnId, itemId: activity.itemId, workerId, image: frame.image }]), ...(worker.turnEnd === null ? workerAction(workerId, worker) : [])]);
  }
  // Its instruction is no message of the conversation; an announcement of a worker of its own is none of this session's list.
  if (item?.type !== 'agentMessage') return NOTHING;
  worker.messages.set(item.id, { phase: item.phase, completed: true });
  worker.actions.end(item.id);
  return mapped([{ type: 'message', turnId, role: 'assistant', itemId: item.id, phase: item.phase, text: item.text, ...(item.questions.length === 0 ? {} : { questions: [...item.questions] }), ...(item.cut ? { cut: true } : {}), workerId }, ...(worker.turnEnd === null ? workerAction(workerId, worker) : [])]);
}

/** Why a frame of an aside's side thread is not its turn's, or null: its turn has ended, or the frame names another. */
function notOf(aside: MapperAside, turnId: string | null): FrameDropReason | null {
  if (aside.ended) return 'ended-aside';
  return aside.cliId === null || turnId !== aside.cliId ? 'other-turn' : null;
}

/**
 * A frame of an aside's side thread (M20b, C20): its agent messages are the aside's answers, each
 * opened by its start, and every other item what the side thread did, as an activity. Its own echo
 * of the question is none of it: the question was recorded when it was asked.
 */
function mapAsideItem(aside: MapperAside, frame: TakenItemFrame, started: boolean): Mapped {
  const refused = notOf(aside, frame.turnId);
  if (refused !== null) return dropped(refused);
  const { item, activity } = frame;
  const { asideId, turnId } = aside;
  if (started) {
    const events: AgentEvent[] = [];
    if (activity !== null && !aside.activities.has(activity.itemId)) {
      aside.activities.add(activity.itemId);
      events.push(activityStarted(turnId, activity, frame.at, null, null, asideId));
    }
    if (item?.type === 'action' && item.opens !== undefined && !aside.messages.has(item.opens.id)) {
      aside.messages.set(item.opens.id, { phase: item.opens.phase, completed: false });
      events.push({ type: 'message-delta', turnId, itemId: item.opens.id, phase: item.opens.phase, text: '', asideId });
    }
    return mapped(events);
  }
  if (activity !== null) return aside.activities.delete(activity.itemId) ? mapped([activityEnded(turnId, activity, frame.at, null, asideId)]) : dropped('unopened-item');
  if (item?.type !== 'agentMessage') return NOTHING;
  aside.messages.set(item.id, { phase: item.phase, completed: true });
  return mapped([{ type: 'message', turnId, role: 'assistant', itemId: item.id, phase: item.phase, text: item.text, ...(item.questions.length === 0 ? {} : { questions: [...item.questions] }), ...(item.cut ? { cut: true } : {}), asideId }]);
}

/**
 * A collab tool call that starts a sub-agent (M20a, C23; K3): the worker's own item. Its start opens
 * the item, with what the sub-agent is asked; its completion names the thread it started, which is
 * the worker from there on, paired with the item by a second start (C59). The item then stays open
 * until its worker ends. A call that started none is a launch that failed, and ends as any tool's does.
 */
function mapSpawn(state: MapperState, turn: MapperTurn, frame: TakenItemFrame, spawn: Extract<TakenItem, { type: 'spawn' }>, started: boolean): Mapped {
  const { activity } = frame;
  if (activity === null) return NOTHING;
  if (turn.ended) {
    // After its turn's end it starts no worker of this session's: its completion ends its item, as any late one does (C6).
    return !started && turn.activities.delete(activity.itemId) ? mapped([activityEnded(turn.runtimeId, activity, frame.at, null, null, state.denied)]) : NOTHING;
  }
  if (started) {
    const events: AgentEvent[] = [];
    if (!turn.activities.has(activity.itemId)) {
      turn.activities.add(activity.itemId);
      events.push(activityStarted(turn.runtimeId, activity, frame.at, null));
    }
    // The model it asks for, should its completion name none (M106, C15).
    if (spawn.model !== null) turn.spawnModels.set(activity.itemId, spawn.model);
    // The action is what any collab call's is (M15, C42).
    turn.actions.start(activity.itemId, { kind: 'tool' });
    const event = action(turn);
    return mapped(event === null ? events : [...events, event]);
  }
  const opened = turn.activities.delete(activity.itemId);
  turn.actions.end(activity.itemId);
  const resumed = action(turn);
  const { workerId } = spawn;
  // The model it asked for, which its sub-agent's thread runs on (M106, C15; K2): its completion's, else its start's.
  const model = spawn.model ?? turn.spawnModels.get(activity.itemId) ?? null;
  turn.spawnModels.delete(activity.itemId);
  if (workerId === null || spawn.failed || workerId === state.threadId || state.workers.has(workerId)) {
    return opened ? mapped([activityEnded(turn.runtimeId, activity, frame.at, null, null, state.denied), ...(resumed === null ? [] : [resumed])]) : dropped('unopened-item');
  }
  state.workers.set(workerId, newWorker(turn.runtimeId, activity.itemId, false));
  // The second start names the worker; where no first came, it opens the item too.
  return mapped([{ type: 'worker-started', workerId, ...(model === null ? {} : { model }) }, activityStarted(turn.runtimeId, activity, opened ? null : frame.at, null, workerId, null, model), ...(resumed === null ? [] : [resumed])]);
}

function mapItem(state: MapperState, params: unknown, started: boolean): Mapped {
  const frame = takeItemFrame(params, started);
  if (frame === null) return dropped('invalid');
  const worker = state.workers.get(frame.threadId);
  if (worker !== undefined) return mapWorkerItem(state, frame.threadId, worker, frame, started);
  const aside = state.asides.get(frame.threadId);
  if (aside !== undefined) return mapAsideItem(aside, frame, started);
  if (frame.threadId !== state.threadId) return dropped('other-thread');
  const { turn } = state;
  if (turn === null || frame.turnId !== turn.cliId) return dropped('other-turn');
  const { item, activity } = frame;
  if (started && activity !== null && turn.actions.ended(activity.itemId)) return NOTHING;
  // A plan (M22b, C14): its start opens it, its deltas write it, its completion is the whole of it.
  if (item?.type === 'plan') return mapPlanItem(turn, item, started);
  if (item?.type === 'worker') {
    if (item.kind === 'completed' || item.kind === 'interrupted') return closing(state, item.workerId, item.kind);
    if (item.kind !== 'started' || turn.ended || state.workers.has(item.workerId) || item.workerId === state.threadId) return NOTHING;
    state.workers.set(item.workerId, newWorker(turn.runtimeId, item.itemId));
    // The model resolved at its creation, where its `started` kind names one (M106, C15; K2).
    const named = item.model === null ? {} : { model: item.model };
    const events: AgentEvent[] = [{ type: 'worker-started', workerId: item.workerId, ...named }];
    // The announcement is the worker item (C23): it opens with its worker, which is paired with it at
    // once, and ends when the worker does. Its line is the agent list's, which main puts in.
    if (item.itemId !== null) events.push({ type: 'activity-started', turnId: turn.runtimeId, itemId: item.itemId, activityType: 'worker', name: 'subAgentActivity', summary: '', pairedWorkerId: item.workerId, ...named, ...(frame.at === null ? {} : { providerAt: frame.at }) });
    return mapped(events);
  }
  if (item?.type === 'spawn') return mapSpawn(state, turn, frame, item, started);
  if (turn.ended) {
    // The turn has ended: T4's late item names it. A completion of an item the turn opened still
    // ends that item (M20a, C6); nothing else of an ended turn changes anything.
    if (!started && activity !== null && turn.activities.delete(activity.itemId)) return mapped([activityEnded(turn.runtimeId, activity, frame.at, null, null, state.denied)]);
    return NOTHING;
  }
  if (started) {
    const events: AgentEvent[] = [];
    if (activity !== null && !turn.activities.has(activity.itemId)) {
      turn.activities.add(activity.itemId);
      events.push(activityStarted(turn.runtimeId, activity, frame.at, null));
    }
    if (item?.type !== 'action') return mapped(events);
    startAction(turn.actions, item, activity?.itemId ?? item.opens?.id, state);
    const event = action(turn);
    if (event !== null) events.push(event);
    // An agent message's start opens its message, with its phase and no text (M19, C7): once.
    if (item.opens !== undefined && !turn.messages.has(item.opens.id)) {
      turn.messages.set(item.opens.id, { phase: item.opens.phase, completed: false });
      events.push({ type: 'message-delta', turnId: turn.runtimeId, itemId: item.opens.id, phase: item.opens.phase, text: '' });
    }
    return mapped(events);
  }
  if (activity !== null) {
    if (!turn.activities.delete(activity.itemId)) return dropped('unopened-item');
    turn.actions.end(activity.itemId);
    const resumed = action(turn);
    return mapped([activityEnded(turn.runtimeId, activity, frame.at, null, null, state.denied), ...(frame.image === undefined ? [] : [{ type: 'image-returned' as const, turnId: turn.runtimeId, itemId: activity.itemId, image: frame.image }]), ...(resumed === null ? [] : [resumed])]);
  }
  if (item === null || item.type === 'action') return NOTHING;
  if (item.type === 'userMessage') {
    if (turn.echoed) return NOTHING;
    turn.echoed = true;
    return mapped([{ type: 'message', turnId: turn.runtimeId, role: 'user', itemId: item.id, phase: null, text: item.text, ...(item.clientId === null ? {} : { clientId: item.clientId }), ...(item.cut ? { cut: true } : {}) }]);
  }
  // The whole message completes what its deltas opened, and no delta is taken for it afterwards (M19, C8).
  turn.messages.set(item.id, { phase: item.phase, completed: true });
  turn.actions.end(item.id);
  const message: AgentEvent = { type: 'message', turnId: turn.runtimeId, role: 'assistant', itemId: item.id, phase: item.phase, text: item.text, ...(item.questions.length === 0 ? {} : { questions: [...item.questions] }), ...(item.cut ? { cut: true } : {}) };
  if (item.phase !== 'commentary') { const resumed = action(turn); return mapped(resumed === null ? [message] : [message, resumed]); }
  // The turn's latest commentary is the action's label from here on (C43): its first line, cut.
  const line = cutLine(item.text);
  turn.commentary = line === '' ? turn.commentary : line;
  const relabel = action(turn);
  return mapped(relabel === null ? [message] : [message, relabel]);
}

/**
 * A plan item of the session's turn in flight (M22b, C14): its start opens it — once, with no text —
 * and its completion gives its whole text, once. One that comes after its turn's end changes nothing.
 */
function mapPlanItem(turn: MapperTurn, item: Extract<TakenItem, { type: 'plan' }>, started: boolean): Mapped {
  if (turn.ended) return NOTHING;
  const held = turn.plans.get(item.id);
  if (started) {
    if (held !== undefined) return NOTHING;
    turn.plans.set(item.id, { completed: false });
    turn.actions.start(item.id, { kind: 'writing', message: true });
    const changed = action(turn);
    return mapped([...(changed === null ? [] : [changed]), { type: 'plan-delta', turnId: turn.runtimeId, itemId: item.id, text: item.text }]);
  }
  if (held?.completed === true) return NOTHING;
  turn.plans.set(item.id, { completed: true });
  turn.actions.end(item.id);
  const changed = action(turn);
  return mapped([{ type: 'plan-completed', turnId: turn.runtimeId, itemId: item.id, text: item.text }, ...(changed === null ? [] : [changed])]);
}

/** More of a plan's text (M22b, C14): the session's own thread and its turn in flight alone, and a plan that is open. */
function mapPlanDelta(state: MapperState, params: unknown): Mapped {
  const frame = takePlanDeltaFrame(params);
  if (frame === null) return dropped('invalid');
  // A worker's plan and a side thread's are none of the session's.
  if (state.workers.has(frame.threadId) || state.asides.has(frame.threadId)) return NOTHING;
  if (frame.threadId !== state.threadId) return dropped('other-thread');
  const { turn } = state;
  if (turn === null || frame.turnId !== turn.cliId || turn.ended) return dropped('other-turn');
  const plan = turn.plans.get(frame.itemId);
  if (plan === undefined) return dropped('unopened-item');
  if (plan.completed) return dropped('completed-item');
  if (frame.text === '') return NOTHING;
  return mapped([{ type: 'plan-delta', turnId: turn.runtimeId, itemId: frame.itemId, text: frame.text }]);
}

/** More of an agent message's text (M19, C7, C8; M20a, C21). Whose it is, by the frame's own fields. */
function mapDelta(state: MapperState, params: unknown): Mapped {
  const frame = takeDeltaFrame(params);
  if (frame === null) return dropped('invalid');
  const worker = state.workers.get(frame.threadId);
  if (worker !== undefined) {
    if (worker.turnId !== null && frame.turnId !== null && frame.turnId !== worker.turnId) return dropped('other-turn');
    // An open worker's message, as it is written: the worker's own (M20a, C21).
    const message = worker.messages.get(frame.itemId);
    if (message === undefined) return dropped('unopened-item');
    if (message.completed) return dropped('completed-item');
    if (frame.text === '') return NOTHING;
    return mapped([{ type: 'message-delta', turnId: worker.startedIn, itemId: frame.itemId, phase: message.phase, text: frame.text, workerId: frame.threadId }]);
  }
  const aside = state.asides.get(frame.threadId);
  if (aside !== undefined) {
    // An aside's answer, as it is written (M20b, C20): the aside's own.
    const refused = notOf(aside, frame.turnId);
    if (refused !== null) return dropped(refused);
    const message = aside.messages.get(frame.itemId);
    if (message === undefined) return dropped('unopened-item');
    if (message.completed) return dropped('completed-item');
    if (frame.text === '') return NOTHING;
    return mapped([{ type: 'message-delta', turnId: aside.turnId, itemId: frame.itemId, phase: message.phase, text: frame.text, asideId: aside.asideId }]);
  }
  if (frame.threadId !== state.threadId) return dropped('other-thread');
  const { turn } = state;
  // The turn in flight alone: one that has ended takes no more of a message.
  if (turn === null || frame.turnId !== turn.cliId || turn.ended) return dropped('other-turn');
  const message = turn.messages.get(frame.itemId);
  if (message === undefined) return dropped('unopened-item');
  if (message.completed) return dropped('completed-item');
  if (frame.text === '') return NOTHING;
  return mapped([{ type: 'message-delta', turnId: turn.runtimeId, itemId: frame.itemId, phase: message.phase, text: frame.text }]);
}

/** The agent's task checklist, as it now reads (M20a, C24): the session's thread and its turn in flight alone. */
function mapPlan(state: MapperState, params: unknown): Mapped {
  const frame = takePlanFrame(params);
  if (frame === null) return dropped('invalid');
  // A worker's own checklist is none of the session's, and neither is a side thread's.
  if (state.workers.has(frame.threadId) || state.asides.has(frame.threadId)) return NOTHING;
  if (frame.threadId !== state.threadId) return dropped('other-thread');
  const { turn } = state;
  if (turn === null || frame.turnId !== turn.cliId || turn.ended) return dropped('other-turn');
  // One item a turn, under an id of fat-g's making: Codex gives the checklist none.
  return mapped([{ type: 'activity-started', turnId: turn.runtimeId, itemId: `${turn.runtimeId}#plan`, activityType: 'checklist', name: 'plan', summary: '', steps: [...frame.steps.steps], ...(frame.steps.cut === null ? {} : { cut: frame.steps.cut }) }]);
}

function mapTurnFrame(state: MapperState, params: unknown, completed: boolean): Mapped {
  const frame = takeTurnFrame(params);
  if (frame === null) return dropped('invalid');
  const worker = state.workers.get(frame.threadId);
  if (worker !== undefined) {
    if (worker.turnId !== null && frame.turnId !== null && frame.turnId !== worker.turnId) return dropped('other-turn');
    if (!completed) { worker.turnId = frame.turnId; return NOTHING; }
    if (worker.turnEnd !== null) return NOTHING;
    // A status the adapter does not know is no success.
    worker.turnEnd = frame.status ?? 'failed';
    worker.actions.clear();
    // Its closing item has come, or none is to come (K3): this is its end.
    if (worker.closing !== null || !worker.closes) return { events: endWorker(state, frame.threadId), effects: [{ type: 'worker-settled', workerId: frame.threadId }], drop: null };
    return { events: workerAction(frame.threadId, worker), effects: [{ type: 'worker-hold', workerId: frame.threadId }], drop: null };
  }
  const aside = state.asides.get(frame.threadId);
  if (aside !== undefined) {
    const refused = notOf(aside, frame.turnId);
    if (refused !== null) return dropped(refused);
    if (!completed) { aside.started = true; return NOTHING; }
    // The side thread's own `turn/completed`: the aside's turn is over, and nothing more of the thread is taken for it.
    aside.ended = true;
    return { events: [], effects: [{ type: 'aside-turn-ended', threadId: frame.threadId, status: frame.status ?? 'failed', detail: frame.detail ?? aside.detail }], drop: null };
  }
  if (frame.threadId !== state.threadId) return dropped('other-thread');
  const { turn } = state;
  if (turn === null || frame.turnId !== turn.cliId) return dropped('other-turn');
  if (!completed) {
    if (turn.started || turn.ended) return NOTHING;
    turn.started = true;
    return { events: [], effects: [{ type: 'turn-started' }], drop: null };
  }
  if (turn.ended) return NOTHING;
  turn.ended = true;
  turn.actions.clear();
  return { events: [], effects: [{ type: 'turn-ended', status: frame.status ?? 'failed', detail: frame.detail ?? turn.detail }], drop: null };
}

/** One frame of a mapped method. The state is changed in place; the answer is what the session then does. */
export function mapFrame(state: MapperState, method: MappedMethod, params: unknown): Mapped {
  switch (method) {
    case 'item/started': return mapItem(state, params, true);
    case 'item/agentMessage/delta': return mapDelta(state, params);
    case 'item/plan/delta': return mapPlanDelta(state, params);
    case 'item/completed': return mapItem(state, params, false);
    case 'turn/started': return mapTurnFrame(state, params, false);
    case 'turn/completed': return mapTurnFrame(state, params, true);
    case 'turn/plan/updated': return mapPlan(state, params);
    case 'error': {
      const frame = takeErrorFrame(params);
      if (frame === null) return dropped('invalid');
      if (state.workers.has(frame.threadId)) return NOTHING;
      const aside = state.asides.get(frame.threadId);
      if (aside !== undefined) {
        // A side thread's own error, kept for its turn's end as a turn's is (C39).
        if (!aside.ended && !frame.willRetry && frame.detail !== null && (frame.turnId === null || frame.turnId === aside.cliId)) aside.detail = frame.detail;
        return NOTHING;
      }
      if (frame.threadId !== state.threadId) return dropped('other-thread');
      const { turn } = state;
      if (turn === null || (frame.turnId !== null && frame.turnId !== turn.cliId)) return dropped('other-turn');
      // An error the CLI will retry ends nothing (C39).
      if (!frame.willRetry && frame.detail !== null) turn.detail = frame.detail;
      return NOTHING;
    }
    case 'thread/status/changed': {
      const frame = takeStatusFrame(params);
      if (frame === null) return dropped('invalid');
      // A side thread's status says nothing of the session's own (M20b, C4).
      if (state.workers.has(frame.threadId) || state.asides.has(frame.threadId)) return NOTHING;
      // T3's first worker frame arrives before the item that announces the worker.
      if (frame.threadId !== state.threadId) return dropped('other-thread');
      return { events: [], effects: [{ type: frame.active ? 'active' : 'inactive' }], drop: null };
    }
    case 'serverRequest/resolved': {
      // Whichever thread it names (M21, C23): a request is known by its own id, and the session holds it.
      const requestId = takeResolvedFrame(params);
      return requestId === null ? dropped('invalid') : { events: [], effects: [{ type: 'request-resolved', requestId }], drop: null };
    }
  }
}
