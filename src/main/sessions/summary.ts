// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's live summary, as a pure function of its record at launch and of the events a source
// sends (docs/planning/_archive/M14.md, Design 3; C15–C21, C23, C74, C106, C109, C113–C116). No clock, no
// store, no Electron: the service hands in the time, and applies what comes back.
//
// Every event names what it belongs to: a turn, by the id its turn-started event chose, or a worker,
// by its own id. One naming a turn other than the current one, any turn while none runs, or a worker
// that is not listed as running, changes nothing and is reported as discarded (C115). An event that
// changes nothing returns the very state it was given, so the service can tell (C24).
//
// A worker belongs to its session, not to a turn (C113): it is listed from its start whatever the
// turns do, and — since M106 (C26, C27) — stays listed once finished, across turns, until the bound
// drops the oldest finished; at launch the conversation store lists the finished ones again
// (`workers-listed`). A turn that ends while a worker still runs is not over for fat-g (C114): the
// session stays running, the outcome is held, and the last worker's end closes it. That a worker can
// outlive its turn comes from Claude's types, read and not observed (docs/research/turn-tracing.md);
// which of a provider's tasks count as workers, and which signal ends a turn, is M15's and M16's mapping.
import { normalizeSessionName } from '@shared/contracts/names';
import {
  actionDetail,
  actionLabel,
  type ActionKind,
  type ActionWait,
  actionStatus,
  type AgentView,
  type Attention,
  type AttentionKind,
  cleanLabel,
  type ListedWorker,
  MAX_FINISHED_AGENTS,
  type NameSource,
  orderAgents,
  type ReportedOutcome,
  sameContext,
  type RequestKind,
  type SessionAction,
  type SessionEvent,
  type SessionSummary,
  type TurnOutcome,
  waitingOnWorkers,
  workerLabel,
} from '@shared/contracts/sessions';
import type { SessionRecord } from '../records/format';
import { actionHold } from './presentation';

interface OpenRequest {
  readonly id: string;
  readonly kind: RequestKind;
  /** The worker that asked, or null for the turn itself. */
  readonly workerId: string | null;
  /** What the attention counts it as (M100b, C24): a question's request its questions, an approval one. */
  readonly count: number;
}

export interface SessionState {
  /** The adapter's current work, retained under blocking requests. Live only. */
  readonly work: SessionAction | null;
  readonly summary: SessionSummary;
  /** The turn that runs; null between turns, and while a turn that has ended waits on its workers. */
  readonly turnId: string | null;
  /** The outcome of a turn that ended while a worker still ran, held until the last one ends (C114). */
  readonly held: ReportedOutcome | null;
  /** The id of the turn whose outcome is held (M18, C54): what its end, when it is written, names. */
  readonly heldTurnId: string | null;
  /** The unanswered requests, oldest first: the oldest decides what the attention shows (C109). */
  readonly requests: readonly OpenRequest[];
  /** Whether the provider's session exists: what the status falls back to between turns (C5, C16). */
  readonly referenced: boolean;
  /** What a source said the session runs with; the record's stands for what it has not said (C23). */
  readonly reported: { readonly model?: string; readonly effort?: string | null };
  /** A plan it made waits for its decision with no request holding it (M22b, C27): a turn's end reads PLAN READY, and so does a launch that finds its line still waiting. */
  readonly planWaiting: boolean;
  /** A review's triage panel stands in its chat (M22e): a turn's end reads PLAN REVIEW, and so does a launch that finds it standing. */
  readonly reviewWaiting: boolean;
  /** The highest number a worker of the list was given (M106, C28): the next is one more, so none is given twice when the bound drops one. */
  readonly numbered: number;
}

/** What an event asks of the record (C6, C9, C10). The service turns each into one write. */
export type RecordEffect =
  | { readonly kind: 'reference'; readonly reference: string; readonly folder: string }
  | { readonly kind: 'turn-started'; readonly turnId: string; readonly at: number }
  | { readonly kind: 'turn-ended'; readonly turnId: string; readonly startedAt: number; readonly at: number; readonly outcome: TurnOutcome }
  | { readonly kind: 'name'; readonly name: string; readonly source: NameSource };

export type Discarded = 'stale turn' | 'stale worker';

export interface Applied {
  readonly state: SessionState;
  readonly effect: RecordEffect | null;
  readonly discarded: Discarded | null;
}

/**
 * The summary a session has at launch, from its record alone (C15, C74, C106): not started without
 * a reference, else idle. A last turn with no end, or ended `stopped`, shows STOPPED — fat-g quit or
 * crashed while it ran — and one that failed shows ERROR, each unacknowledged. A started session
 * otherwise reads READY, as its status bar does, acknowledged (the maintainer's word,
 * amending C106): drawn dim, as a READY already seen is, so a launch still lights no session whose
 * last turn merely finished. The flag itself is never stored.
 */
export function summaryAtLaunch(record: SessionRecord): SessionState {
  const turn = record.lastTurn;
  const lit: AttentionKind | null = turn === null ? null : turn.endedAt === null || turn.outcome === 'stopped' ? 'stopped' : turn.outcome === 'failed' ? 'error' : null;
  const attention: Attention | null = lit !== null ? { kind: lit, count: 1, acknowledged: false } : record.reference === null ? null : { kind: 'ready', count: 1, acknowledged: true };
  return {
    work: null,
    summary: {
      status: record.reference === null ? 'not-started' : 'idle',
      turnStartedAt: null,
      activeWorkers: 0,
      attention,
      action: null,
      agents: [],
      model: record.model,
      effort: record.effort,
      // No process of it has confirmed a mode in this run (M22, C2).
      mode: null,
    },
    turnId: null,
    held: null,
    heldTurnId: null,
    requests: [],
    referenced: record.reference !== null,
    reported: {},
    // A plan's line that waits, and a review's findings that wait, are raised by their own events
    // once the runtime and the review service have read them (M22b, C27; M22e).
    planWaiting: false,
    reviewWaiting: false,
    // Its finished workers are listed by their own event, once the runtime has read them (M106, C26).
    numbered: 0,
  };
}

/** The record changed: the model and effort in force follow it, where no source has reported (C23). */
export function withRecord(state: SessionState, record: SessionRecord): SessionState {
  const model = state.reported.model ?? record.model;
  const effort = 'effort' in state.reported ? state.reported.effort ?? null : record.effort;
  if (model === state.summary.model && effort === state.summary.effort) return state;
  return { ...state, summary: { ...state.summary, model, effort } };
}

export function isRunning(state: SessionState): boolean {
  return state.summary.status === 'running';
}

/** Visiting acknowledges notifications; a pending decision stays lit until it is resolved. */
export function acknowledged(state: SessionState): SessionState {
  const { attention } = state.summary;
  if (attention === null || attention.acknowledged) return state;
  if (attention.kind === 'question' || attention.kind === 'approval' || attention.kind === 'plan' || attention.kind === 'review') return state;
  return { ...state, summary: { ...state.summary, attention: { ...attention, acknowledged: true } } };
}

/**
 * fat-g is quitting while this session runs (C75): it reads STOPPED, its workers are lost with it,
 * and nothing it was waiting on is waited on any more.
 */
export function stopped(state: SessionState, at: number): SessionState {
  if (!isRunning(state)) return state;
  const { displayHold: _hold, ...summary } = state.summary;
  return {
    ...state,
    work: null,
    turnId: null,
    held: null,
    heldTurnId: null,
    requests: [],
    summary: {
      ...summary,
      status: betweenTurns(state),
      turnStartedAt: null,
      activeWorkers: 0,
      attention: { kind: 'stopped', count: 1, acknowledged: false },
      action: null,
      // Nothing a worker asked is waited on any more: no row stays lit past a quit (M106, C8).
      agents: state.summary.agents.map((agent) => {
        const { displayHold: _workerHold, ...rest } = agent;
        return agent.state === 'running' ? { ...rest, state: 'failed', finishedAt: at, attention: null } : rest;
      }),
    },
  };
}

const KEPT: Omit<Applied, 'state'> = { effect: null, discarded: null };
const same = (state: SessionState): Applied => ({ state, ...KEPT });
const discard = (state: SessionState, discarded: Discarded): Applied => ({ state, effect: null, discarded });

const betweenTurns = (state: SessionState): 'idle' | 'not-started' => (state.referenced ? 'idle' : 'not-started');
const running = (agents: readonly AgentView[]): number => agents.filter((agent) => agent.state === 'running').length;
const listedRunning = (state: SessionState, workerId: string): AgentView | undefined => state.summary.agents.find((agent) => agent.id === workerId && agent.state === 'running');

/** An agent definition's name as a label (M106, C20): cleaned as a description is, or none. */
const agentTypeOf = (value: string | null | undefined): string | null => {
  const cleaned = value === undefined || value === null ? '' : cleanLabel(value);
  return cleaned === '' ? null : cleaned;
};

/**
 * The finished workers the store listed (M106, C26, C28), newest first, as the list's agents: numbered
 * from 1 in the order they started, each with what its item held, none of them lit.
 */
function listed(workers: readonly ListedWorker[]): AgentView[] {
  // A worker once, its newest item standing for it.
  const once = workers.filter((worker, index) => workers.findIndex((other) => other.workerId === worker.workerId) === index);
  const started = once.map((worker, index) => ({ worker, index })).sort((a, b) => a.worker.startedAt - b.worker.startedAt || b.index - a.index);
  return started.map(({ worker }, at): AgentView => {
    const number = at + 1;
    return {
      id: worker.workerId, number, label: workerLabel(number, worker.label), state: worker.status, action: null, startedAt: worker.startedAt, finishedAt: worker.finishedAt,
      model: worker.model, agentType: agentTypeOf(worker.agentType), attention: null,
    };
  });
}

/** The label merges the kind's words with what the source said; the detail keeps what it said apart from them (M100, C52). */
function action(kind: ActionKind | null, line: string | undefined, file: string | undefined, wait?: ActionWait, tool?: true): SessionAction | null {
  return kind === null ? null : { kind, ...(wait === undefined ? {} : { wait }), ...(tool === undefined ? {} : { tool }), label: kind === 'waiting' ? actionStatus({ kind, ...(wait === undefined ? {} : { wait }) }) : actionLabel(kind, line, file), detail: actionDetail(line, file) };
}

/** An action whose detail alone changed is a changed action (M100, C60): the status bar shows each file in turn. */
const sameAction = (a: SessionAction | null, b: SessionAction | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.label === b.label && a.tool === b.tool && a.wait?.reason === b.wait?.reason && (a.wait?.reason !== 'subagents' || b.wait?.reason === 'subagents' && a.wait.count === b.wait.count) && (a.detail ?? null) === (b.detail ?? null));

/**
 * The attention the unanswered requests give (C19, C20, C109): the kind of the oldest and the count
 * of that kind — the questions of every question's request, the session's and its workers', and one
 * for each approval (M100b, C24). Pending requests are never acknowledged by visiting.
 */
function attentionOf(requests: readonly OpenRequest[], previous: Attention | null): Attention | null {
  const [oldest] = requests;
  if (oldest === undefined) return null;
  const count = requests.reduce((sum, request) => (request.kind === oldest.kind ? sum + request.count : sum), 0);
  if (previous !== null && previous.kind === oldest.kind && previous.count === count && !previous.acknowledged) return previous;
  return { kind: oldest.kind, count, acknowledged: false };
}

/**
 * The list within its bound (M106, C27): every running worker, and the most recently finished, by the
 * order the page draws them in; the rest leave it, in the order they started otherwise.
 */
function bounded(agents: readonly AgentView[]): readonly AgentView[] {
  const { finished } = orderAgents(agents);
  if (finished.length <= MAX_FINISHED_AGENTS) return agents;
  const dropped = new Set(finished.slice(MAX_FINISHED_AGENTS));
  return agents.filter((agent) => !dropped.has(agent));
}

/**
 * Each worker's own attention (M106, C8): its own unanswered requests, counted as the session's are —
 * the kind of its oldest and that kind's count — never acknowledged; none for a finished one. An
 * agent whose attention is unchanged is kept as it was.
 */
function withAttention(agents: readonly AgentView[], requests: readonly OpenRequest[]): readonly AgentView[] {
  return agents.map((agent) => {
    const own = agent.state === 'running' ? requests.filter((request) => request.workerId === agent.id) : [];
    // A worker's attention is never acknowledged, so the session's rule keeps it so.
    const attention = attentionOf(own, agent.attention);
    return attention === agent.attention ? agent : { ...agent, attention };
  });
}

/** The state with these agents and requests, its worker count, its attention and — while a turn's end is held — its waiting line. */
function settle(state: SessionState, given: readonly AgentView[], requests: readonly OpenRequest[]): SessionState {
  const agents = withAttention(bounded(given), requests);
  const active = running(agents);
  const own = requests.find((request) => request.workerId === null);
  const current = own === undefined ? state.held !== null && active > 0 ? waitingOnWorkers(active) : state.work
    : action(own.kind === 'approval' ? 'approving' : own.kind === 'plan' ? 'plan-ready' : 'asking', undefined, undefined);
  return {
    ...state,
    requests,
    summary: {
      ...state.summary,
      agents,
      activeWorkers: active,
      attention: attentionOf(requests, state.summary.attention),
      action: sameAction(current, state.summary.action) ? state.summary.action : current,
    },
  };
}

/** The turn that runs, or the one whose end is held while its workers run: what a quit ends (M18, C45). */
export function turnOf(state: SessionState): string | null {
  return state.turnId ?? state.heldTurnId;
}

/** A turn is over, with nothing running after it (C16, C19): READY or ERROR, and its end for the record. */
function closeTurn(state: SessionState, turnId: string, outcome: ReportedOutcome, at: number): Applied {
  const startedAt = state.summary.turnStartedAt ?? at;
  return {
    state: {
      ...state,
      turnId: null,
      held: null,
      heldTurnId: null,
      requests: [],
      summary: {
        ...state.summary,
        status: betweenTurns(state),
        turnStartedAt: null,
        activeWorkers: 0,
        // An interrupted turn was the user's doing, so it is ready — or its plan is (M22b, C27), or its review's findings are (M22e).
        attention: { kind: outcome === 'failed' ? 'error' : state.planWaiting ? 'plan' : state.reviewWaiting ? 'review' : 'ready', count: 1, acknowledged: false },
        action: null,
      },
    },
    effect: { kind: 'turn-ended', turnId, startedAt, at, outcome },
    discarded: null,
  };
}

/** One or more workers end; the last one's end closes a turn that was waiting on it (C114). */
function endWorkers(state: SessionState, ended: ReadonlyMap<string, 'completed' | 'failed'>, at: number): Applied {
  const agents = state.summary.agents.map((agent): AgentView => {
    const outcome = agent.state === 'running' ? ended.get(agent.id) : undefined;
    return outcome === undefined ? agent : { ...agent, state: outcome, finishedAt: at };
  });
  // What an ended worker asked can no longer be answered.
  const requests = state.requests.filter((request) => request.workerId === null || !ended.has(request.workerId));
  const next = settle(state, agents, requests);
  if (state.held !== null && state.heldTurnId !== null && next.summary.activeWorkers === 0) return closeTurn(next, state.heldTurnId, state.held, at);
  return same(next);
}

/** Whether a request's owner is current: the turn that runs, or a worker listed as running (C115). */
function ownerOf(state: SessionState, owner: { readonly turnId: string } | { readonly workerId: string }): { readonly workerId: string | null } | Discarded {
  if ('turnId' in owner) return state.turnId !== null && owner.turnId === state.turnId ? { workerId: null } : 'stale turn';
  return listedRunning(state, owner.workerId) === undefined ? 'stale worker' : { workerId: owner.workerId };
}

/**
 * Whether a request's owner is current (M21, C11): the turn that runs, or a worker listed as
 * running. What the request registry asks before it opens a card, so that a request it cannot place
 * is refused through its session and not silently discarded.
 */
export function owns(state: SessionState, owner: { readonly turnId: string } | { readonly workerId: string }): boolean {
  return typeof ownerOf(state, owner) !== 'string';
}

function reduceEvent(state: SessionState, event: SessionEvent, now: number): Applied {
  switch (event.type) {
    case 'reference-set': {
      const effect: RecordEffect = { kind: 'reference', reference: event.reference, folder: event.folder };
      if (state.referenced) return { state, effect, discarded: null };
      const status = state.summary.status === 'not-started' ? 'idle' : state.summary.status;
      return { state: { ...state, referenced: true, summary: { ...state.summary, status } }, effect, discarded: null };
    }

    case 'turn-started': {
      // While a turn runs, another one's start is an old turn's tail or a defect of the source.
      if (state.turnId !== null) return discard(state, 'stale turn');
      // Every worker stays listed, a finished one too (M106, C26); so does what the running ones asked.
      const requests = state.requests.filter((request) => request.workerId !== null);
      const thinking = action('thinking', undefined, undefined);
      const base: SessionState = { ...state, work: thinking, turnId: event.turnId, held: null, heldTurnId: null, summary: { ...state.summary, status: 'running', turnStartedAt: now, ...(state.summary.turnWait === undefined ? {} : { turnWait: { turnId: event.turnId, ms: 0, since: null } }), attention: null, action: thinking } };
      return { state: settle(base, state.summary.agents, requests), effect: { kind: 'turn-started', turnId: event.turnId, at: now }, discarded: null };
    }

    case 'turn-ended': {
      if (state.turnId === null || event.turnId !== state.turnId) return discard(state, 'stale turn');
      const active = running(state.summary.agents);
      if (active === 0) return closeTurn(state, event.turnId, event.outcome, now);
      // A worker still runs: the session stays running, and nothing is written yet (C114).
      const requests = state.requests.filter((request) => request.workerId !== null);
      return same(settle({ ...state, turnId: null, held: event.outcome, heldTurnId: event.turnId }, state.summary.agents, requests));
    }

    case 'action-changed': {
      if (state.turnId === null || event.turnId !== state.turnId) return discard(state, 'stale turn');
      const next = event.kind === null ? action('thinking', undefined, undefined) : action(event.kind, event.line, event.file, event.wait, event.tool);
      return sameAction(next, state.work) ? same(state) : same(settle({ ...state, work: next }, state.summary.agents, state.requests));
    }

    case 'worker-started': {
      // Taken while the session runs; an id the list already holds is not a new worker.
      if (!isRunning(state) || state.summary.agents.some((agent) => agent.id === event.workerId)) return discard(state, 'stale worker');
      // The next after the highest given, so a session's fourth is 4 whatever turn it ran in (M106, C28).
      const number = Math.max(state.numbered, ...state.summary.agents.map((agent) => agent.number)) + 1;
      const agent: AgentView = {
        id: event.workerId, number, label: workerLabel(number, event.description, event.identifier), state: 'running', action: action('thinking', undefined, undefined), startedAt: now, finishedAt: null,
        // Its model as the CLI named it, a key; its agent definition cleaned as a label is (M106, C14, C20).
        model: event.model ?? null, agentType: agentTypeOf(event.agentType), attention: null,
      };
      return same(settle({ ...state, numbered: number }, [...state.summary.agents, agent], state.requests));
    }

    case 'worker-model': {
      // A model named once the worker spoke (M106, C38): a finished one's too, its frames coming late.
      const worker = state.summary.agents.find((agent) => agent.id === event.workerId);
      if (worker === undefined) return discard(state, 'stale worker');
      if (worker.model === event.model) return same(state);
      return same({ ...state, summary: { ...state.summary, agents: state.summary.agents.map((agent) => (agent === worker ? { ...agent, model: event.model } : agent)) } });
    }

    case 'workers-listed': {
      // At launch (M106, C26): what the store holds is the list of a session that does not run; one that
      // runs already lists its own.
      if (isRunning(state)) return discard(state, 'stale worker');
      if (event.workers.length === 0 && state.summary.agents.length === 0) return same(state);
      const agents = listed(event.workers);
      return same({ ...state, numbered: agents.length, summary: { ...state.summary, agents: bounded(agents), activeWorkers: 0 } });
    }

    case 'worker-progressed': {
      const worker = listedRunning(state, event.workerId);
      if (worker === undefined) return discard(state, 'stale worker');
      const next = event.kind === null ? action('thinking', undefined, undefined) : action(event.kind, event.line, event.file, event.wait, event.tool);
      if (sameAction(next, worker.action)) return same(state);
      return same({ ...state, summary: { ...state.summary, agents: state.summary.agents.map((agent) => (agent === worker ? { ...agent, action: next } : agent)) } });
    }

    case 'worker-ended': {
      if (listedRunning(state, event.workerId) === undefined) return discard(state, 'stale worker');
      return endWorkers(state, new Map([[event.workerId, event.outcome]]), now);
    }

    case 'workers-reported': {
      // The whole running set: a listed worker missing from it has ended, its end having been lost (C116).
      const reported = new Set(event.workerIds);
      const lost = state.summary.agents.filter((agent) => agent.state === 'running' && !reported.has(agent.id));
      if (lost.length === 0) return same(state);
      return endWorkers(state, new Map(lost.map((agent) => [agent.id, 'completed'])), now);
    }

    case 'request-raised': {
      const owner = ownerOf(state, event.owner);
      if (typeof owner === 'string') return discard(state, owner);
      if (state.requests.some((request) => request.id === event.requestId)) return same(state);
      const wait = state.summary.turnWait ?? { turnId: state.turnId ?? '', ms: 0, since: null };
      const base = owner.workerId === null && wait.since === null
        ? { ...state, summary: { ...state.summary, turnWait: { ...wait, since: now } } } : state;
      return same(settle(base, state.summary.agents, [...state.requests, { id: event.requestId, kind: event.kind, workerId: owner.workerId, count: event.count }]));
    }

    case 'request-resolved': {
      const owner = ownerOf(state, event.owner);
      if (typeof owner === 'string') return discard(state, owner);
      if (!state.requests.some((request) => request.id === event.requestId)) return same(state);
      const requests = state.requests.filter((request) => request.id !== event.requestId);
      const wait = state.summary.turnWait;
      const base = wait !== undefined && wait.since !== null && !requests.some((request) => request.workerId === null)
        ? { ...state, summary: { ...state.summary, turnWait: { ...wait, ms: wait.ms + Math.max(0, now - wait.since), since: null } } } : state;
      return same(settle(base, state.summary.agents, requests));
    }

    case 'in-force': {
      // The speed a turn ran at, where the session asked for a faster tier (decision 0016): a turn
      // that fell back to standard says so until a later one is served fast. No turn's, and no record's.
      if (event.served !== undefined) {
        const { served, servedReason, ...rest } = event;
        const { notFast: _held, ...others } = state.summary;
        const summary = served === 'standard' ? { ...others, notFast: { reason: servedReason ?? null } } : others;
        const changed = served === 'standard' ? state.summary.notFast?.reason !== (servedReason ?? null) || state.summary.notFast === undefined : state.summary.notFast !== undefined;
        return applyEvent(changed ? { ...state, summary } : state, rest, now);
      }
      // The mode the session's process runs under (M22, C2, C75) is the process's, and no turn's: it
      // is set at each confirmation, taken back by a null at the process's end, and never by `withdrawn`.
      if (event.mode !== undefined && event.mode !== state.summary.mode) {
        const { mode, ...rest } = event;
        return applyEvent({ ...state, summary: { ...state.summary, mode } }, rest, now);
      }
      // Taken back (M15, C103): nothing is reported any more. The service then puts the record's own
      // values back, which this function does not hold.
      if (event.withdrawn === true) return Object.keys(state.reported).length === 0 ? same(state) : same({ ...state, reported: {} });
      const reported = { ...state.reported, ...(event.model === undefined ? {} : { model: event.model }), ...(event.effort === undefined ? {} : { effort: event.effort }) };
      if (reported.model === state.reported.model && reported.effort === state.reported.effort && ('effort' in reported) === ('effort' in state.reported)) return same(state);
      const model = reported.model ?? state.summary.model;
      const effort = 'effort' in reported ? reported.effort ?? null : state.summary.effort;
      // What was reported is remembered either way; the summary changes only when what is in force does.
      const unchanged = model === state.summary.model && effort === state.summary.effort;
      return same({ ...state, reported, summary: unchanged ? state.summary : { ...state.summary, model, effort } });
    }

    case 'name-reported': {
      const name = normalizeSessionName(event.name);
      return name === '' ? same(state) : { state, effect: { kind: 'name', name, source: event.source }, discarded: null };
    }

    case 'plan-waiting': {
      if (event.waiting === state.planWaiting) return same(state);
      const { attention } = state.summary;
      // Between turns the attention says it at once (M22b, C27); while a turn runs, its end does.
      // A decision taken lets go of PLAN READY, and of nothing else.
      const next: Attention | null = isRunning(state) ? attention : event.waiting ? { kind: 'plan', count: 1, acknowledged: false, ...(event.flash === false ? { flash: false as const } : {}) } : attention?.kind === 'plan' ? null : attention;
      return same({ ...state, planWaiting: event.waiting, summary: next === attention ? state.summary : { ...state.summary, attention: next } });
    }

    case 'plan-wait': {
      // No attention (decision 0029): the chat waits on another, not on the user, and a turn changes none of it.
      if (event.wait === (state.summary.planWait ?? null)) return same(state);
      const { planWait: _planWait, ...rest } = state.summary;
      return same({ ...state, summary: event.wait === null ? rest : { ...rest, planWait: event.wait } });
    }

    case 'review-waiting': {
      if (event.waiting === state.reviewWaiting) return same(state);
      const { attention } = state.summary;
      // As a plan's (M22e): between turns at once, while a turn runs at its end; going, it lets go of PLAN REVIEW alone.
      const next: Attention | null = isRunning(state) ? attention : event.waiting ? (attention === null || attention.kind === 'ready' ? { kind: 'review', count: 1, acknowledged: false } : attention) : attention?.kind === 'review' ? null : attention;
      return same({ ...state, reviewWaiting: event.waiting, summary: next === attention ? state.summary : { ...state.summary, attention: next } });
    }

    case 'context':
      // How full the context window is (decision 0033): the process's, and no turn's. Each report
      // replaces the one held, which outlives its turn and its process; one that says nothing new is no change.
      return sameContext(state.summary.context, event.reading) ? same(state) : same({ ...state, summary: { ...state.summary, context: event.reading } });
  }
}

/** One main-owned deadline survives page/window mounts; renderers own only its wake-up timer. */
export function applyEvent(state: SessionState, event: SessionEvent, now: number): Applied {
  const applied = reduceEvent(state, event, now);
  const next = applied.state;
  if (next === state) return applied;
  const eligible = next.summary.status === 'running' && next.summary.attention === null && next.summary.planWait === undefined
    && state.turnId === next.turnId && state.summary.attention === null && state.summary.planWait === undefined;
  const hold = actionHold(state.summary, next.summary, eligible, now);
  let changed = false;
  const agents = next.summary.agents.map((agent) => {
    const previous = state.summary.agents.find((candidate) => candidate.id === agent.id);
    const held = previous === undefined ? undefined : actionHold(previous, agent,
      agent.state === 'running' && agent.attention === null && previous.attention === null, now);
    if (held === agent.displayHold) return agent;
    changed = true;
    const { displayHold: _hold, ...rest } = agent;
    return held === undefined ? rest : { ...rest, displayHold: held };
  });
  if (hold === next.summary.displayHold && !changed && (next.summary.status === 'running' || next.work === null)) return applied;
  const { displayHold: _hold, ...rest } = next.summary;
  return { ...applied, state: { ...next, work: next.summary.status === 'running' ? next.work : null,
    summary: { ...rest, ...(hold === undefined ? {} : { displayHold: hold }), agents: changed ? agents : next.summary.agents },
  } };
}
