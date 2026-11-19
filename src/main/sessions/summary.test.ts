// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The live summary's rules (docs/planning/_archive/M14.md: V3, V33, and the pure part of V32), driven as tables.
// The fixture summaries of tests/fixtures/sessions are what the events below must produce, field for field.
import { describe, expect, it } from 'vitest';
import { attentionWords, MAX_FINISHED_AGENTS, type SessionEvent, type SessionSummary } from '@shared/contracts/sessions';
import { SUMMARIES, TURN_STARTED_AT as T } from '../../../tests/support/sessions';
import type { SessionRecord } from '../records/format';
import { acknowledged, applyEvent, type Applied, isRunning, type RecordEffect, type SessionState, stopped, summaryAtLaunch, withRecord } from './summary';

const ID = '8a1f0c52-3c1e-4d0b-9a37-5e2b7f6d9c10';
const SEC = 1000;

const record = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: ID, projectId: '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19', providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null,
  name: null, nameSource: null, starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: T - 60 * SEC, lastActiveAt: T - 60 * SEC, lastTurn: null, ...overrides,
});
const started = (overrides: Partial<SessionRecord> = {}) => record({ reference: '019f2c1a-7b3e', folder: 'D:\\Code\\fat-g', ...overrides });

// Events, without the session id every one of them carries.
type Step = readonly [atSeconds: number, event: DistributiveOmit<SessionEvent, 'sessionId'>];
type DistributiveOmit<U, K extends PropertyKey> = U extends unknown ? Omit<U, K> : never;

const turn = (turnId = 't1'): Step[1] => ({ type: 'turn-started', turnId });
const end = (outcome: 'completed' | 'interrupted' | 'failed' = 'completed', turnId = 't1'): Step[1] => ({ type: 'turn-ended', turnId, outcome });
const act = (kind: 'thinking' | 'reading' | 'writing' | 'running' | 'tool' | 'waiting' | 'asking' | null, extra: { line?: string; file?: string } = {}, turnId = 't1'): Step[1] =>
  ({ type: 'action-changed', turnId, kind, ...extra });
const worker = (n: number, description?: string, identifier?: string): Step[1] =>
  ({ type: 'worker-started', workerId: `worker-${n}`, ...(description === undefined ? {} : { description }), ...(identifier === undefined ? {} : { identifier }) });
const progress = (n: number, kind: 'thinking' | 'reading' | 'writing' | 'running' | 'tool', file?: string): Step[1] =>
  ({ type: 'worker-progressed', workerId: `worker-${n}`, kind, ...(file === undefined ? {} : { file }) });
const done = (n: number, outcome: 'completed' | 'failed' = 'completed'): Step[1] => ({ type: 'worker-ended', workerId: `worker-${n}`, outcome });
const ask = (requestId: string, kind: 'question' | 'approval', owner: { turnId: string } | { workerId: string } = { turnId: 't1' }, count = 1): Step[1] => ({ type: 'request-raised', owner, requestId, kind, count });
const answer = (requestId: string, owner: { turnId: string } | { workerId: string } = { turnId: 't1' }): Step[1] => ({ type: 'request-resolved', owner, requestId });

interface Run {
  readonly state: SessionState;
  readonly effects: readonly RecordEffect[];
  readonly discarded: readonly string[];
  readonly last: Applied | null;
}

function run(from: SessionRecord | SessionState, steps: readonly Step[]): Run {
  let state = 'summary' in from ? from : summaryAtLaunch(from);
  const effects: RecordEffect[] = [];
  const discarded: string[] = [];
  let last: Applied | null = null;
  for (const [at, event] of steps) {
    last = applyEvent(state, { ...event, sessionId: ID }, T + at * SEC);
    state = last.state;
    if (last.effect !== null) effects.push(last.effect);
    if (last.discarded !== null) discarded.push(last.discarded);
  }
  return { state, effects, discarded, last };
}

const threeWorkers: Step[] = [
  [0, turn()],
  [1, act('reading', { file: 'D:\\Code\\fat-g\\notes.txt' })],
  // The first names the model it runs on (M106, C14): the fixtures draw it.
  [12, { type: 'worker-started', workerId: 'worker-1', description: 'Explore the login flow', model: 'gpt-6-sol' }],
  [13, progress(1, 'reading', 'auth.ts')],
  [14, worker(2, 'Run the test suite')],
  [15, progress(2, 'running')],
  [20, worker(3, 'Check the release notes')],
  [21, progress(3, 'thinking')],
  [95, done(2)],
];

describe('the live turn clock', () => {
  it('holds through overlapping decisions, resumes at the last resolution and resets for a new turn', () => {
    const { state } = run(started(), [
      [0, turn()], [1, ask('q1', 'question')], [2, ask('a1', 'approval')],
      [3, answer('q1')], [61, answer('a1')],
    ]);
    expect(state.summary.turnWait).toEqual({ turnId: 't1', ms: 60_000, since: null });
    const ended = applyEvent(state, { ...end(), sessionId: ID }, T + 65 * SEC).state;
    const next = applyEvent(ended, { ...turn('t2'), sessionId: ID }, T + 70 * SEC).state;
    expect(next.summary.turnWait).toEqual({ turnId: 't2', ms: 0, since: null });
  });
});

describe('M105 semantic work and display deadlines', () => {
  it('starts thinking and restores actual work under overlapping requests', () => {
    const initial = run(started(), [[0, turn()]]).state;
    expect(initial.summary.action?.kind).toBe('thinking');
    const requested = run(initial, [[1, act('running')], [2, ask('a', 'approval')], [3, ask('q', 'question')]]).state;
    expect(requested.summary.action?.kind).toBe('approving');
    const one = run(requested, [[4, answer('a')]]).state;
    expect(one.summary.action?.kind).toBe('asking');
    const none = run(one, [[5, answer('q')]]).state;
    expect(none.summary.action?.kind).toBe('running');
    expect(none.summary.displayHold).toBeUndefined();
  });

  it('tool completion cannot erase attention, and resolution restores the latest work', () => {
    const result = run(started(), [[0, turn()], [1, act('reading')], [2, ask('a', 'approval')], [3, act('thinking')]]).state;
    expect(result.summary.action?.kind).toBe('approving');
    expect(result.work?.kind).toBe('thinking');
    const resumed = run(result, [[4, answer('a')]]).state;
    expect(resumed.summary.action?.kind).toBe('thinking');
    expect(resumed.summary.displayHold).toBeUndefined();
  });

  it('immediately ends semantic work, holds its safe kind for 2000 ms and never extends on repeated frames', () => {
    const first = run(started(), [[0, turn()], [1, act('reading', { file: 'secret.txt' })], [1.1, act('thinking')]]).state;
    expect(first.summary.action?.kind).toBe('thinking');
    expect(first.summary.displayHold).toEqual({ kind: 'reading', until: T + 3100 });
    const repeated = run(first, [[1.2, act('thinking')]]).state;
    expect(repeated.summary.displayHold).toBe(first.summary.displayHold);
    expect(JSON.stringify(first.summary.displayHold)).not.toContain('secret');
    const next = run(repeated, [[1.3, act('running')]]).state;
    expect(next.summary.displayHold).toBeUndefined();
  });

  it('decisions, plan ownership, Stop and a new turn discard a pending display hold', () => {
    const held = run(started(), [[0, turn()], [1, act('tool')], [1.1, act('thinking')]]).state;
    for (const event of [ask('a', 'approval'), { type: 'plan-wait', wait: 'review' } as const, end()]) {
      expect(run(held, [[1.2, event]]).state.summary.displayHold).toBeUndefined();
    }
    expect(stopped(held, T + 1200).summary.displayHold).toBeUndefined();
    expect(run(held, [[1.2, end()], [1.3, turn('t2')]]).state.summary).toMatchObject({ action: { kind: 'thinking' } });
    expect(run(held, [[1.2, end()], [1.3, turn('t2')]]).state.summary.displayHold).toBeUndefined();
  });

  it('workers get independent deadlines and terminal rows cannot retain them', () => {
    const result = run(started(), [[0, turn()], [1, worker(1)], [1.1, progress(1, 'reading')], [1.2, progress(1, 'thinking')]]).state;
    expect(result.summary.agents[0]?.displayHold).toEqual({ kind: 'reading', until: T + 3200 });
    expect(result.summary.displayHold).toBeUndefined();
    expect(run(result, [[1.3, done(1)]]).state.summary.agents[0]?.displayHold).toBeUndefined();
  });
});

// ── The fixtures, from events ─────────────────────────────────────────────────────────────────
describe('the fixture summaries are what the events produce (V3)', () => {
  const cases: [keyof typeof SUMMARIES, SessionRecord, Step[], ((state: SessionState) => SessionState)?][] = [
    ['notStarted', record(), []],
    // Idle with nothing to say: a started session whose plan's decision was taken between turns. A launch reads READY, seen (C106, amended).
    ['idle', started(), [[0, { type: 'plan-waiting', waiting: true }], [1, { type: 'plan-waiting', waiting: false }]]],
    ['runningThinking', started({ model: 'opus[1m]', effort: 'max' }), [[0, turn()], [1, act('thinking')]]],
    ['runningWorkers', started(), threeWorkers],
    ['runningSentence', started(), [[0, turn()], [2, act('writing', { line: `I'll read sample.txt to find the cat's name, then compare it with the notes\nand then more` })]]],
    ['manyWorkers', started(), [
      [0, turn()],
      [1, act('waiting')],
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n): Step[] => [[5 + n * 9, worker(n, `Review module ${n}`)], [5 + n * 9, progress(n, 'reading', `src/module-${n}.ts`)]]),
      [90, worker(9, 'Summarise the findings')],
      [91, progress(9, 'writing', 'summary.md')],
      [95, worker(10, 'Fetch the changelog')],
      [96, progress(10, 'tool')],
      [100, worker(11, 'List the open issues')],
      [110, done(10, 'failed')],
      [120, worker(12, undefined, 'C:\\Users\\someone\\.codex\\agents\\019f2c1a-7b3e-7d21-8a4f-0c5d6e7f8a9b')],
      [135, done(12)],
      [150, done(9)],
      [170, done(11)],
    ]],
    ['waitingOnWorkers', started(), [...threeWorkers, [120, end()]]],
    ['questions', started(), [[0, turn()], [1, act('asking')], [2, ask('q1', 'question')], [3, ask('q2', 'question')], [4, ask('q3', 'question')]]],
    ['approval', started(), [[0, turn()], [1, act('running')], [2, ask('a1', 'approval')]]],
    ['ready', started(), [[0, turn()], [1, act('thinking')], [30, end()]]],
    ['readyAcknowledged', started(), [[0, turn()], [30, end()]], acknowledged],
    ['error', started(), [[0, turn()], [1, act('running')], [30, end('failed')]]],
    ['stopped', started({ lastTurn: { turnId: 'turn-0', startedAt: T - 500 * SEC, endedAt: null, outcome: null } }), []],
  ];

  it('are all produced here', () => {
    expect(cases.map(([name]) => name).sort()).toEqual(Object.keys(SUMMARIES).sort());
  });

  it.each(cases)('%s', (name, from, steps, after) => {
    const { state, discarded } = run(from, steps);
    expect(discarded).toEqual([]);
    expect((after ?? ((given) => given))(state).summary).toEqual({
      ...SUMMARIES[name],
      ...(name === 'questions' || name === 'approval' ? { turnWait: { turnId: 't1', ms: 0, since: T + 2 * SEC } } : {}),
    });
  });
});

// ── At launch ─────────────────────────────────────────────────────────────────────────────────
describe('at launch, from the record alone (C15, C74, C106)', () => {
  const none = null;
  // READY, as its status bar says, acknowledged: drawn dim, so a launch lights nothing (the maintainer's word, amending C106).
  const seen = 'ready seen';
  it.each<[string, Partial<SessionRecord>, SessionSummary['status'], string | null]>([
    ['no reference', {}, 'not-started', none],
    ['a reference', { reference: 'r', folder: 'D:\\x' }, 'idle', seen],
    ['a last turn with no end: left running by a crash or a logoff', { reference: 'r', folder: 'D:\\x', lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: null, outcome: null } }, 'idle', 'stopped'],
    ['a last turn ended stopped: a quit', { reference: 'r', folder: 'D:\\x', lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'stopped' } }, 'idle', 'stopped'],
    ['a stopped turn on a session that never got a reference', { lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'stopped' } }, 'not-started', 'stopped'],
    ['a last turn that failed', { reference: 'r', folder: 'D:\\x', lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'failed' } }, 'idle', 'error'],
    ['a last turn that completed: READY, seen', { reference: 'r', folder: 'D:\\x', lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'completed' } }, 'idle', seen],
    ['a last turn that was interrupted: READY, seen', { reference: 'r', folder: 'D:\\x', lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'interrupted' } }, 'idle', seen],
  ])('%s', (_name, overrides, status, attention) => {
    const { summary } = summaryAtLaunch(record(overrides));
    expect(summary.status).toBe(status);
    expect(summary.attention).toEqual(attention === null ? null : attention === seen ? { kind: 'ready', count: 1, acknowledged: true } : { kind: attention, count: 1, acknowledged: false });
    expect(summary).toMatchObject({ turnStartedAt: null, activeWorkers: 0, action: null, agents: [], model: 'gpt-6-sol', effort: 'high' });
  });

  it('a new turn clears what a launch showed (C19)', () => {
    const { state } = run(started({ lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'failed' } }), [[0, turn()]]);
    expect(state.summary.attention).toBeNull();
  });
});

// ── Status, the turn's start, the record ──────────────────────────────────────────────────────
describe('a turn (C16, C17, C10)', () => {
  it('runs from its start to its end, stamped by main and cleared between turns', () => {
    const begun = run(started(), [[7, turn()]]);
    expect(begun.state.summary).toMatchObject({ status: 'running', turnStartedAt: T + 7 * SEC });
    expect(isRunning(begun.state)).toBe(true);
    expect(begun.effects).toEqual([{ kind: 'turn-started', turnId: 't1', at: T + 7 * SEC }]);
    const over = run(begun.state, [[40, end()]]);
    expect(over.state.summary).toMatchObject({ status: 'idle', turnStartedAt: null, action: null });
    expect(over.effects).toEqual([{ kind: 'turn-ended', turnId: 't1', startedAt: T + 7 * SEC, at: T + 40 * SEC, outcome: 'completed' }]);
  });

  it.each([['completed', 'ready'], ['interrupted', 'ready'], ['failed', 'error']] as const)('ended %s leaves %s, unacknowledged (C19)', (outcome, kind) => {
    const { state, effects } = run(started(), [[0, turn()], [5, end(outcome)]]);
    expect(state.summary.attention).toEqual({ kind, count: 1, acknowledged: false });
    expect(effects.at(-1)).toMatchObject({ kind: 'turn-ended', outcome });
  });

  it('may run on a session without a reference, which reads not started again when it ends', () => {
    const { state } = run(record(), [[0, turn()], [5, end()]]);
    expect(state.summary.status).toBe('not-started');
  });

  it('clears the attention and the action the last one left, and keeps the finished workers (M106, C26)', () => {
    const first = run(started(), [...threeWorkers, [100, done(1)], [101, done(3)], [120, end()]]);
    expect(first.state.summary.attention?.kind).toBe('ready');
    expect(first.state.summary.agents).toHaveLength(3);
    const second = run(first.state, [[200, turn('t2')]]);
    expect(second.state.summary).toMatchObject({ status: 'running', turnStartedAt: T + 200 * SEC, attention: null, action: { kind: 'thinking' }, activeWorkers: 0 });
    expect(second.state.summary.agents.map((agent) => [agent.id, agent.state])).toEqual([['worker-1', 'completed'], ['worker-2', 'completed'], ['worker-3', 'completed']]);
  });

  it('becomes idle from not started when the reference is set, unless it runs — and asks for it to be stored once', () => {
    const set: Step[1] = { type: 'reference-set', reference: '019f2c1a', folder: 'D:\\Code\\fat-g' };
    const idle = run(record(), [[0, set]]);
    expect(idle.state.summary.status).toBe('idle');
    expect(idle.effects).toEqual([{ kind: 'reference', reference: '019f2c1a', folder: 'D:\\Code\\fat-g' }]);
    const during = run(record(), [[0, turn()], [1, set], [9, end()]]);
    expect(during.state.summary.status).toBe('idle');
    expect(run(record(), [[0, turn()], [1, set]]).state.summary.status).toBe('running');
  });
});

// ── The action and its label ──────────────────────────────────────────────────────────────────
describe('the current action (C21)', () => {
  // M100 (C52, V13): the detail is what the label says beyond the kind's words — the provider's line, else the file's name, else none.
  it.each<[string, Step[1], { kind: string; label: string; detail: string | null } | null]>([
    ['fat-g’s words when no line is sent', act('thinking'), { kind: 'thinking', label: 'Thinking…', detail: null }],
    ['a file by its name alone', act('reading', { file: 'C:\\Users\\someone\\notes.txt' }), { kind: 'reading', label: 'Reading notes.txt', detail: 'notes.txt' }],
    ['a provider’s line kept to its first, its paths cut', act('reading', { line: 'Reading C:\\Users\\Some One\\secret\\notes.txt\nsecond line' }), { kind: 'reading', label: 'Reading notes.txt', detail: 'Reading notes.txt' }],
    ['a provider’s line over the file it names', act('tool', { line: 'Copy 55 files to the backup', file: 'D:\\Code\\backup.ps1' }), { kind: 'tool', label: 'Copy 55 files to the backup', detail: 'Copy 55 files to the backup' }],
    ['no specific action during a turn', act(null), { kind: 'thinking', label: 'Thinking…', detail: null }],
  ])('shows %s', (_name, event, expected) => {
    expect(run(started(), [[0, turn()], [1, event]]).state.summary.action).toEqual(expected);
  });

  it('clamps a provider’s line like a name', () => {
    const label = run(started(), [[0, turn()], [1, act('writing', { line: 'word '.repeat(40) })]]).state.summary.action?.label ?? '';
    expect([...label]).toHaveLength(60);
  });

  // M100 (C60, V15): the status bar shows each file in turn, though the label reads the same.
  it('is changed by a detail that changes alone, under the same label, for the session and for a worker', () => {
    const first = run(started(), [[0, turn()], [1, act('tool', { file: 'a.ts' })]]);
    const second = run(first.state, [[2, act('tool', { file: 'b.ts' })]]);
    expect(first.state.summary.action).toEqual({ kind: 'tool', label: 'Using a tool', detail: 'a.ts' });
    expect(second.state).not.toBe(first.state);
    expect(second.state.summary.action).toEqual({ kind: 'tool', label: 'Using a tool', detail: 'b.ts' });
    // The same detail again changes nothing (C24).
    expect(run(second.state, [[3, act('tool', { file: 'b.ts' })]]).state).toBe(second.state);

    const listed = run(started(), [[0, turn()], [1, worker(1, 'Copy the files')], [2, progress(1, 'tool', 'a.ts')]]);
    const moved = run(listed.state, [[3, progress(1, 'tool', 'b.ts')]]);
    expect(moved.state).not.toBe(listed.state);
    expect(moved.state.summary.agents[0]?.action).toEqual({ kind: 'tool', label: 'Using a tool', detail: 'b.ts' });
  });
});

// ── Attention ─────────────────────────────────────────────────────────────────────────────────
describe('attention (C19, C20, C109)', () => {
  const kinds = (state: SessionState) => state.summary.attention;

  it('counts the unanswered requests of a kind, and goes when the last is answered', () => {
    const asked = run(started(), [[0, turn()], [1, ask('q1', 'question')], [2, ask('q2', 'question')]]);
    expect(kinds(asked.state)).toEqual({ kind: 'question', count: 2, acknowledged: false });
    const one = run(asked.state, [[3, answer('q1')]]);
    expect(kinds(one.state)).toEqual({ kind: 'question', count: 1, acknowledged: false });
    expect(kinds(run(one.state, [[4, answer('q2')]]).state)).toBeNull();
  });

  // M100b, C24, V6: a question's request counts its questions, a worker's with the session's; an approval counts one.
  it('counts the questions of every question’s request, and one for each approval', () => {
    const asked = run(started(), [[0, turn()], [1, worker(1)], [2, ask('q1', 'question', { turnId: 't1' }, 2)], [3, ask('q2', 'question')], [4, ask('q3', 'question', { workerId: 'worker-1' }, 3)]]);
    expect(kinds(asked.state)).toEqual({ kind: 'question', count: 6, acknowledged: false });
    expect(kinds(run(asked.state, [[5, answer('q1')]]).state)).toEqual({ kind: 'question', count: 4, acknowledged: false });
    const approvals = run(started(), [[0, turn()], [1, ask('a1', 'approval')], [2, ask('a2', 'approval')], [3, ask('q1', 'question', { turnId: 't1' }, 4)]]);
    expect(kinds(approvals.state)).toEqual({ kind: 'approval', count: 2, acknowledged: false });
  });

  it('takes one request once, and ignores an answer to one it does not hold', () => {
    const asked = run(started(), [[0, turn()], [1, ask('q1', 'question')]]);
    expect(run(asked.state, [[2, ask('q1', 'question')]]).state).toBe(asked.state);
    expect(run(asked.state, [[2, answer('nope')]]).state).toBe(asked.state);
  });

  it('stays unacknowledged after a visit, while the count falls or rises', () => {
    const asked = run(started(), [[0, turn()], [1, ask('q1', 'question')], [2, ask('q2', 'question')], [3, ask('q3', 'question')]]);
    const seen = acknowledged(asked.state);
    expect(seen).toBe(asked.state);
    expect(kinds(seen)).toEqual({ kind: 'question', count: 3, acknowledged: false });
    expect(acknowledged(seen)).toBe(seen);
    const fewer = run(seen, [[4, answer('q2')]]);
    expect(kinds(fewer.state)).toEqual({ kind: 'question', count: 2, acknowledged: false });
    const more = run(fewer.state, [[5, ask('q4', 'question')]]);
    expect(kinds(more.state)).toEqual({ kind: 'question', count: 3, acknowledged: false });
  });

  it.each(['question', 'approval', 'plan', 'review'] as const)('visiting never acknowledges a pending %s decision', (kind) => {
    const { state } = kind === 'review' || kind === 'plan'
      ? run(started(), [[0, { type: kind === 'plan' ? 'plan-waiting' : 'review-waiting', waiting: true }]])
      : run(started(), [[0, turn()], [1, ask('r1', kind)]]);
    expect(state.summary.attention).toEqual({ kind, count: 1, acknowledged: false });
    expect(acknowledged(state)).toBe(state);
  });

  it.each(['ready', 'error', 'stopped'] as const)('visiting still acknowledges a %s notification', (kind) => {
    const state = kind === 'stopped'
      ? summaryAtLaunch(started({ lastTurn: { turnId: 'old', startedAt: 5, endedAt: null, outcome: null } }))
      : run(started(), [[0, turn()], [1, end(kind === 'error' ? 'failed' : 'completed')]]).state;
    expect(acknowledged(state).summary.attention).toEqual({ kind, count: 1, acknowledged: true });
  });

  // C109, V33: the oldest unanswered request decides the kind.
  it('shows the oldest request’s kind with that kind’s count, then the other kind — a change that clears acknowledged', () => {
    const both = run(started(), [[0, turn()], [1, ask('q1', 'question')], [2, ask('a1', 'approval')], [3, ask('a2', 'approval')]]);
    expect(kinds(both.state)).toEqual({ kind: 'question', count: 1, acknowledged: false });
    const seen = acknowledged(both.state);
    const answered = run(seen, [[4, answer('q1')]]);
    expect(kinds(answered.state)).toEqual({ kind: 'approval', count: 2, acknowledged: false });
    // And the other way round: an approval first.
    const reverse = run(started(), [[0, turn()], [1, ask('a1', 'approval')], [2, ask('q1', 'question')], [3, ask('q2', 'question')]]);
    expect(kinds(reverse.state)).toEqual({ kind: 'approval', count: 1, acknowledged: false });
    expect(kinds(run(reverse.state, [[4, answer('a1')]]).state)).toEqual({ kind: 'question', count: 2, acknowledged: false });
  });

  it('does nothing to a session with no attention', () => {
    const state = summaryAtLaunch(started());
    expect(acknowledged(state)).toBe(state);
  });

  it('goes with the turn: what was asked and not answered is not carried into READY', () => {
    const { state } = run(started(), [[0, turn()], [1, ask('q1', 'question')], [9, end()]]);
    expect(kinds(state)).toEqual({ kind: 'ready', count: 1, acknowledged: false });
    expect(state.requests).toEqual([]);
  });
});

// ── Workers ───────────────────────────────────────────────────────────────────────────────────
describe('workers (C18, C113)', () => {
  it('are numbered in the order they started, timed, and counted while they run', () => {
    const { state } = run(started(), threeWorkers);
    expect(state.summary.agents.map((agent) => [agent.number, agent.id, agent.state, agent.startedAt - T, agent.finishedAt === null ? null : agent.finishedAt - T])).toEqual([
      [1, 'worker-1', 'running', 12 * SEC, null],
      [2, 'worker-2', 'completed', 14 * SEC, 95 * SEC],
      [3, 'worker-3', 'running', 20 * SEC, null],
    ]);
    expect(state.summary.activeWorkers).toBe(2);
  });

  it('take the number after the highest one listed, whatever turn they run in (M106, C28)', () => {
    const first = run(started(), [[0, turn()], [1, worker(1)], [2, worker(2)], [3, done(1)], [9, end()]]);
    // Worker 2 still runs; worker 1, finished, stays listed through the new turn.
    const second = run(first.state, [[20, turn('t2')], [21, worker(7, 'Late')]]);
    expect(second.state.summary.agents.map((agent) => [agent.number, agent.id])).toEqual([[1, 'worker-1'], [2, 'worker-2'], [3, 'worker-7']]);
  });

  it('are labelled by their description, else their identifier without its path', () => {
    const { state } = run(started(), [[0, turn()], [1, worker(1, 'Explore\nmore')], [2, worker(2, undefined, '/home/someone/.codex/agents/reviewer')], [3, worker(3)]]);
    expect(state.summary.agents.map((agent) => agent.label)).toEqual(['Explore', 'reviewer', 'Worker 3']);
  });

  it('can fail, and keep their last action', () => {
    const { state } = run(started(), [[0, turn()], [1, worker(1)], [2, progress(1, 'tool')], [3, done(1, 'failed')]]);
    expect(state.summary.agents[0]).toMatchObject({ state: 'failed', finishedAt: T + 3 * SEC, action: { kind: 'tool', label: 'Using a tool' } });
    expect(state.summary.activeWorkers).toBe(0);
  });

  // Round 4 (C120, V36): a question that is still to be answered does not vanish with a new turn.
  it('keep what they asked through a new turn’s start, unacknowledged, while the turn’s own requests go', () => {
    const first = run(started(), [[0, turn()], [1, worker(1)], [2, ask('a1', 'approval', { workerId: 'worker-1' })], [3, ask('q1', 'question')], [9, end()]]);
    // The turn ended with its worker running: its own question went with it, the worker's approval stays.
    expect(first.state.summary.attention).toEqual({ kind: 'approval', count: 1, acknowledged: false });
    const seen = acknowledged(first.state);
    const next = run(seen, [[20, turn('t2')]]);
    expect(next.state.summary).toMatchObject({ status: 'running', attention: { kind: 'approval', count: 1, acknowledged: false }, activeWorkers: 1 });
    expect(next.state.requests).toEqual([{ id: 'a1', kind: 'approval', workerId: 'worker-1', count: 1 }]);
    // Answered, or its worker gone, it shows no more.
    expect(run(next.state, [[21, answer('a1', { workerId: 'worker-1' })]]).state.summary.attention).toBeNull();
    expect(run(next.state, [[21, done(1)]]).state.summary.attention).toBeNull();
  });

  it('raise attention of their own, which goes when they end', () => {
    const asked = run(started(), [[0, turn()], [1, worker(1)], [2, ask('a1', 'approval', { workerId: 'worker-1' })]]);
    expect(asked.state.summary.attention).toEqual({ kind: 'approval', count: 1, acknowledged: false });
    expect(run(asked.state, [[3, done(1)]]).state.summary.attention).toBeNull();
  });
});

// ── C114, C116: a worker that outlives its turn ───────────────────────────────────────────────
describe('a turn that ends while a worker runs (C114, V33)', () => {
  const waiting = () => run(started(), [...threeWorkers, [120, end()]]);

  it('leaves the session running with its start time, waiting on its workers, with no end written and no attention', () => {
    const { state, effects } = waiting();
    expect(state.summary).toMatchObject({ status: 'running', turnStartedAt: T, attention: null, action: { kind: 'waiting', label: 'Waiting for 2 sub-agents' }, activeWorkers: 2 });
    expect(isRunning(state)).toBe(true);
    expect(effects.map((effect) => effect.kind)).toEqual(['turn-started']);
    expect(state.held).toBe('completed');
  });

  it('counts down as they end, and the last one’s end writes the turn’s end and outcome and raises its attention', () => {
    const one = run(waiting().state, [[130, done(1)]]);
    expect(one.state.summary).toMatchObject({ status: 'running', action: { kind: 'waiting', label: 'Waiting for a sub-agent' }, attention: null });
    expect(one.effects).toEqual([]);
    const none = run(one.state, [[140, done(3, 'failed')]]);
    expect(none.state.summary).toMatchObject({ status: 'idle', turnStartedAt: null, action: null, activeWorkers: 0, attention: { kind: 'ready', count: 1, acknowledged: false } });
    // The end names the turn whose outcome was held, though no turn runs any more (M18, C54).
    expect(none.effects).toEqual([{ kind: 'turn-ended', turnId: 't1', startedAt: T, at: T + 140 * SEC, outcome: 'completed' }]);
    // The finished workers stay listed (M106, C26).
    expect(none.state.summary.agents.map((agent) => agent.state)).toEqual(['completed', 'completed', 'failed']);
  });

  it('holds a failed outcome the same way: ERROR comes when the last worker ends', () => {
    const { state, effects } = run(started(), [[0, turn()], [1, worker(1)], [5, end('failed')], [9, done(1)]]);
    expect(state.summary.attention?.kind).toBe('error');
    expect(effects.at(-1)).toEqual({ kind: 'turn-ended', turnId: 't1', startedAt: T, at: T + 9 * SEC, outcome: 'failed' });
  });

  it('takes a worker’s events between turns: progress, requests, and a new worker', () => {
    const between = run(waiting().state, [[125, progress(1, 'writing', 'report.md')], [126, ask('a9', 'approval', { workerId: 'worker-3' })], [127, worker(4, 'A late helper')]]);
    expect(between.discarded).toEqual([]);
    expect(between.state.summary.agents.find((agent) => agent.id === 'worker-1')?.action).toEqual({ kind: 'writing', label: 'Writing report.md', detail: 'report.md' });
    expect(between.state.summary.attention).toEqual({ kind: 'approval', count: 1, acknowledged: false });
    expect(between.state.summary).toMatchObject({ activeWorkers: 3, action: { label: 'Waiting for 3 sub-agents' } });
  });

  it('is taken over by a turn that starts meanwhile: the running workers stay listed, and nothing of the earlier turn is written', () => {
    const next = run(waiting().state, [[130, turn('t2')]]);
    expect(next.effects).toEqual([{ kind: 'turn-started', turnId: 't2', at: T + 130 * SEC }]);
    expect(next.state.summary).toMatchObject({ status: 'running', turnStartedAt: T + 130 * SEC, action: { kind: 'thinking' }, attention: null, activeWorkers: 2 });
    // The finished one stays listed too (M106, C26).
    expect(next.state.summary.agents.map((agent) => agent.id)).toEqual(['worker-1', 'worker-2', 'worker-3']);
    expect(next.state.held).toBeNull();
    expect(next.state.heldTurnId).toBeNull();
    // The new turn's own end is what counts from here.
    const over = run(next.state, [[140, done(1)], [141, done(3)], [150, end('interrupted', 't2')]]);
    expect(over.effects).toEqual([{ kind: 'turn-ended', turnId: 't2', startedAt: T + 130 * SEC, at: T + 150 * SEC, outcome: 'interrupted' }]);
  });

  it('ends as stopped at a quit, its workers lost with it', () => {
    const state = stopped(waiting().state, T + 200 * SEC);
    expect(state.summary).toMatchObject({ status: 'idle', turnStartedAt: null, action: null, activeWorkers: 0, attention: { kind: 'stopped', count: 1, acknowledged: false } });
    expect(state.summary.agents.map((agent) => [agent.state, agent.finishedAt])).toEqual([['failed', T + 200 * SEC], ['completed', T + 95 * SEC], ['failed', T + 200 * SEC]]);
    expect(isRunning(state)).toBe(false);
  });

  it('leaves a session that does not run alone at a quit', () => {
    const idle = summaryAtLaunch(started());
    expect(stopped(idle, T)).toBe(idle);
  });

  // C116: a source may report the whole set of running workers.
  it('ends the listed workers a reported set lacks, as completed — so a lost end cannot hold a session running', () => {
    const reported = run(waiting().state, [[130, { type: 'workers-reported', workerIds: ['worker-3', 'worker-99'] }]]);
    expect(reported.state.summary.agents.map((agent) => [agent.id, agent.state])).toEqual([['worker-1', 'completed'], ['worker-2', 'completed'], ['worker-3', 'running']]);
    expect(reported.state.summary.action?.label).toBe('Waiting for a sub-agent');
    const empty = run(reported.state, [[140, { type: 'workers-reported', workerIds: [] }]]);
    expect(empty.state.summary).toMatchObject({ status: 'idle', attention: { kind: 'ready' } });
    expect(empty.effects).toEqual([{ kind: 'turn-ended', turnId: 't1', startedAt: T, at: T + 140 * SEC, outcome: 'completed' }]);
  });

  it('changes nothing for a set that names every running worker', () => {
    const state = waiting().state;
    expect(run(state, [[130, { type: 'workers-reported', workerIds: ['worker-1', 'worker-3'] }]]).state).toBe(state);
  });
});

// ── C115: what an event belongs to ────────────────────────────────────────────────────────────
describe('stale events (C115)', () => {
  const idle = () => run(started(), [[0, turn()], [9, end()]]).state;

  it.each<[string, Step[1], string]>([
    ['an action of the turn that ended', act('thinking'), 'stale turn'],
    ['a request of the turn that ended', ask('q1', 'question'), 'stale turn'],
    ['an answer of the turn that ended', answer('q1'), 'stale turn'],
    ['a second end of the turn that ended', end(), 'stale turn'],
    ['a worker starting while nothing runs', worker(1), 'stale worker'],
    ['progress of a worker that is not listed', progress(4, 'thinking'), 'stale worker'],
    ['the end of a worker that is not listed', done(4), 'stale worker'],
    ['a request of a worker that is not listed', ask('a1', 'approval', { workerId: 'worker-4' }), 'stale worker'],
  ])('discards %s between turns, changing nothing', (_name, event, reason) => {
    const state = idle();
    const result = run(state, [[20, event]]);
    expect(result.state).toBe(state);
    expect(result.discarded).toEqual([reason]);
    expect(result.effects).toEqual([]);
  });

  it('discards an old turn’s events during the next turn, and a second start while one runs', () => {
    const next = run(idle(), [[20, turn('t2')]]).state;
    const result = run(next, [[21, act('reading', {}, 't1')], [22, end('failed', 't1')], [23, ask('q', 'question', { turnId: 't1' })], [24, turn('t3')]]);
    expect(result.state).toBe(next);
    expect(result.discarded).toEqual(['stale turn', 'stale turn', 'stale turn', 'stale turn']);
  });

  it('discards the events of a worker that has ended, and a second start of one that is listed', () => {
    const state = run(started(), [[0, turn()], [1, worker(1)], [2, done(1)]]).state;
    const result = run(state, [[3, progress(1, 'thinking')], [4, done(1)], [5, worker(1)], [6, ask('a', 'approval', { workerId: 'worker-1' })]]);
    expect(result.state).toBe(state);
    expect(result.discarded).toEqual(['stale worker', 'stale worker', 'stale worker', 'stale worker']);
  });
});

// ── Decision 0033: how full the context is ────────────────────────────────────────────────────
describe('the context reading (decision 0033)', () => {
  const reading = (used: number): Step[1] => ({ type: 'context', reading: { used, window: 200_000, compactAt: 167_000, parts: [{ label: 'Messages', tokens: used }] } });

  it('is none at launch, is set and replaced by each report, and a report that says nothing new changes nothing', () => {
    expect(summaryAtLaunch(started()).summary).not.toHaveProperty('context');
    const first = run(started(), [[0, reading(20_000)]]).state;
    expect(first.summary.context).toEqual({ used: 20_000, window: 200_000, compactAt: 167_000, parts: [{ label: 'Messages', tokens: 20_000 }] });
    expect(run(first, [[1, reading(20_000)]]).state).toBe(first);
    expect(run(first, [[1, reading(31_000)]]).state.summary.context?.used).toBe(31_000);
  });

  it('outlives its turn, a Stop, a withdrawn report and the record’s change: it is the conversation’s', () => {
    const during = run(started(), [[0, turn()], [1, reading(20_000)]]).state;
    const ended = run(during, [[2, { type: 'turn-ended', turnId: 't1', outcome: 'completed' }]]).state;
    expect(ended.summary.context?.used).toBe(20_000);
    expect(stopped(during, T + 3 * SEC).summary.context?.used).toBe(20_000);
    expect(run(ended, [[3, { type: 'in-force', withdrawn: true }]]).state.summary.context?.used).toBe(20_000);
    expect(withRecord(ended, started({ effort: 'low' })).summary.context?.used).toBe(20_000);
  });
});

// ── C23: model and effort in force ────────────────────────────────────────────────────────────
describe('the model and effort in force (C23)', () => {
  const report = (fields: { model?: string; effort?: string | null }): Step[1] => ({ type: 'in-force', ...fields });

  it('are the record’s until a source reports', () => {
    // A turn that asked for a faster tier and ran at standard speed says so, with its reason, until one is served fast (decision 0016).
    const slow = run(record(), [[0, { type: 'in-force', served: 'standard', servedReason: 'out_of_credits' }]]).state;
    expect(slow.summary.notFast).toEqual({ reason: 'out_of_credits' });
    expect(slow.summary.effort).toBe(record().effort);
    expect(run(slow, [[1, { type: 'in-force', served: 'fast', servedReason: null }]]).state.summary).not.toHaveProperty('notFast');
    expect(run(slow, [[1, { type: 'in-force', withdrawn: true }]]).state.summary.notFast).toEqual({ reason: 'out_of_credits' });
    expect(run(slow, [[1, { type: 'in-force', served: 'standard', servedReason: 'out_of_credits' }]]).state).toBe(slow);
    expect(summaryAtLaunch(record({ model: 'haiku', effort: null })).summary).toMatchObject({ model: 'haiku', effort: null });
  });

  it('follow what a source reports, field by field', () => {
    const { state } = run(started(), [[0, report({ model: 'gpt-5.6-sol' })]]);
    expect(state.summary).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high' });
    expect(run(state, [[1, report({ effort: null })]]).state.summary).toMatchObject({ model: 'gpt-5.6-sol', effort: null });
  });

  it('follow a change of the record where nothing was reported, and keep what was', () => {
    const fresh = summaryAtLaunch(started());
    expect(withRecord(fresh, started({ model: 'gpt-5.6-sol', effort: 'low' })).summary).toMatchObject({ model: 'gpt-5.6-sol', effort: 'low' });
    const reported = run(started(), [[0, report({ model: 'gpt-reported' })]]).state;
    expect(withRecord(reported, started({ model: 'gpt-5.6-sol', effort: 'low' })).summary).toMatchObject({ model: 'gpt-reported', effort: 'low' });
    expect(withRecord(fresh, started())).toBe(fresh);
  });

  it('keeps the very summary when a report names what the record already says', () => {
    const fresh = summaryAtLaunch(started());
    expect(run(fresh, [[0, report({ model: 'gpt-6-sol', effort: 'high' })]]).state.summary).toBe(fresh.summary);
  });

  // M15 (V36; C103): a turn's effort holds for that turn, and is taken back when the session stops running.
  it('holds a report through a change of the record until it is withdrawn, then follows the record again', () => {
    const withdraw: Step[1] = { type: 'in-force', withdrawn: true };
    const reported = run(started({ effort: 'low' }), [[0, report({ effort: 'low' })]]).state;
    // The record changes during the turn: the report still stands.
    const during = withRecord(reported, started({ effort: 'high' }));
    expect(during.summary.effort).toBe('low');
    // Withdrawn: nothing is reported, and the record's value shows at once and from then on.
    const after = run(during, [[1, withdraw]]).state;
    expect(after.reported).toEqual({});
    expect(withRecord(after, started({ effort: 'high' })).summary.effort).toBe('high');
    expect(withRecord(after, started({ effort: 'medium' })).summary.effort).toBe('medium');
  });

  it('keeps the very state when there is nothing to withdraw', () => {
    const fresh = summaryAtLaunch(started());
    expect(run(fresh, [[0, { type: 'in-force', withdrawn: true }]]).state).toBe(fresh);
  });
});

// ── C24: nothing changes, nothing is pushed ───────────────────────────────────────────────────
describe('an event that changes nothing returns the state it was given (C24)', () => {
  it.each<[string, Step[], Step[1]]>([
    ['the same action again', [[0, turn()], [1, act('thinking')]], act('thinking')],
    ['the same worker progress again', [[0, turn()], [1, worker(1)], [2, progress(1, 'reading', 'a.ts')]], progress(1, 'reading', 'a.ts')],
    ['the same model and effort again', [[0, { type: 'in-force', model: 'gpt-5.6-sol', effort: 'low' }]], { type: 'in-force', model: 'gpt-5.6-sol', effort: 'low' }],
    ['an empty report of nothing', [], { type: 'in-force' }],
    ['a name: it is the record’s business', [], { type: 'name-reported', name: 'Create plan', source: 'provider' }],
    ['a reference set again', [[0, { type: 'reference-set', reference: 'r2', folder: 'D:\\x' }]], { type: 'reference-set', reference: 'r3', folder: 'D:\\y' }],
  ])('%s', (_name, before, event) => {
    const state = run(started(), before).state;
    expect(run(state, [[50, event]]).state).toBe(state);
  });

  it('asks the record for a name, normalized, and for nothing when the name is empty', () => {
    expect(run(started(), [[0, { type: 'name-reported', name: '  Create \n plan ', source: 'first-message' }]]).effects).toEqual([{ kind: 'name', name: 'Create plan', source: 'first-message' }]);
    expect(run(started(), [[0, { type: 'name-reported', name: ' \t ', source: 'user' }]]).effects).toEqual([]);
  });
});

// ── The mapping table (docs/research/turn-tracing.md §4) ──────────────────────────────────────
describe('the summary’s fields are the mapping table’s, one by one (C15)', () => {
  // The rows of the turn-tracing note's mapping table (§4), in its order.
  const rows = ['Status', 'Turn start', 'Active workers', 'Attention: kind and count', 'Current action', 'Agent list'];
  const FIELD: Record<string, keyof SessionSummary> = {
    'Status': 'status',
    'Turn start': 'turnStartedAt',
    'Active workers': 'activeWorkers',
    'Attention: kind and count': 'attention',
    'Current action': 'action',
    'Agent list': 'agents',
  };

  it('has a field for each row of the table, and beside them only the model and effort in force (C23) and the mode its process confirmed (M22, C2)', () => {
    expect(rows).toEqual(Object.keys(FIELD));
    const fields = Object.keys(summaryAtLaunch(record()).summary).sort();
    expect(fields).toEqual([...Object.values(FIELD), 'model', 'effort', 'mode'].sort());
  });
});

// M22b (C27): a plan the session made, waiting for its decision with no request holding it.
describe('a plan that waits (M22b; C27)', () => {
  const waiting = (value: boolean): Step[1] => ({ type: 'plan-waiting', waiting: value });

  it('reads PLAN READY at its turn’s end, in READY’s place, and an error’s stays an error', () => {
    const ended = run(started(), [[0, turn()], [1, waiting(true)], [2, end()]]);
    expect(ended.state.summary.attention).toEqual({ kind: 'plan', count: 1, acknowledged: false });
    const failed = run(started(), [[0, turn()], [1, waiting(true)], [2, end('failed')]]);
    expect(failed.state.summary.attention).toEqual({ kind: 'error', count: 1, acknowledged: false });
  });

  it('says so at once between turns, and lets go of PLAN READY alone once decided', () => {
    const now = run(started(), [[0, waiting(true)]]);
    expect(now.state.summary.attention).toEqual({ kind: 'plan', count: 1, acknowledged: false });
    expect(run(now.state, [[1, waiting(false)]]).state.summary.attention).toBeNull();
    const stopped_ = run(started({ lastTurn: { turnId: 't0', startedAt: T, endedAt: null, outcome: null } }), [[0, waiting(false)]]);
    expect(stopped_.state.summary.attention?.kind).toBe('stopped');
  });

  it('is nothing at a launch, and the same state again changes nothing', () => {
    const launched = summaryAtLaunch(started());
    expect(launched.planWaiting).toBe(false);
    expect(run(launched, [[0, waiting(false)]]).state).toBe(launched);
  });

  it('is gone at the next turn’s start, which takes the attention', () => {
    const waited = run(started(), [[0, waiting(true)], [1, turn('t2')]]);
    expect(waited.state.summary.attention).toBeNull();
    expect(run(waited.state, [[2, waiting(false)], [3, end('completed', 't2')]]).state.summary.attention?.kind).toBe('ready');
  });
});

// M22e (the maintainer's V6 review): a review's triage panel standing in the reviewer's chat.
describe('a review whose findings wait (M22e)', () => {
  const waiting = (value: boolean): Step[1] => ({ type: 'review-waiting', waiting: value });

  it('reads PLAN REVIEW in READY’s place once its round is recorded after the turn’s end, and an error’s stays an error', () => {
    const ended = run(started(), [[0, turn()], [1, end()], [2, waiting(true)]]);
    expect(ended.state.summary.attention).toEqual({ kind: 'review', count: 1, acknowledged: false });
    expect(attentionWords({ kind: 'review', count: 1 })).toBe('plan review');
    const failed = run(started(), [[0, turn()], [1, end('failed')], [2, waiting(true)]]);
    expect(failed.state.summary.attention?.kind).toBe('error');
  });

  it('reads PLAN REVIEW at a turn’s end while the panel stands, and lets go of it alone once it goes', () => {
    const ended = run(started(), [[0, turn()], [1, waiting(true)], [2, end()]]);
    expect(ended.state.summary.attention?.kind).toBe('review');
    expect(run(ended.state, [[3, waiting(false)]]).state.summary.attention).toBeNull();
    const stopped_ = run(started({ lastTurn: { turnId: 't0', startedAt: T, endedAt: null, outcome: null } }), [[0, waiting(true)]]);
    expect(stopped_.state.summary.attention?.kind).toBe('stopped');
  });

  it('is nothing at a launch, and a plan’s PLAN READY stands before it', () => {
    const launched = summaryAtLaunch(started());
    expect(launched.reviewWaiting).toBe(false);
    expect(run(launched, [[0, waiting(false)]]).state).toBe(launched);
    const both = run(started(), [[0, turn()], [1, waiting(true)], [2, { type: 'plan-waiting', waiting: true }], [3, end()]]);
    expect(both.state.summary.attention?.kind).toBe('plan');
  });
});

// Decision 0029 (the maintainer): a chat whose plan another chat or the reviewer holds.
describe('what a chat of a plan waits on', () => {
  const wait = (value: 'review' | 'revision' | 'implementation' | null): Step[1] => ({ type: 'plan-wait', wait: value });

  it('holds the kind it waits on, raises no attention, and lets go of it alone', () => {
    const ended = run(started(), [[0, turn()], [1, end()]]);
    const waiting = run(ended.state, [[2, wait('review')]]);
    expect(waiting.state.summary.planWait).toBe('review');
    expect(waiting.state.summary.attention).toEqual(ended.state.summary.attention);
    expect(run(waiting.state, [[3, wait('revision')]]).state.summary.planWait).toBe('revision');
    const gone = run(waiting.state, [[3, wait(null)]]).state;
    expect('planWait' in gone.summary).toBe(false);
    expect(gone.summary.attention).toEqual(ended.state.summary.attention);
  });

  it('is nothing at a launch, changes nothing said again, and stays across a turn of the chat’s own', () => {
    const launched = summaryAtLaunch(started());
    expect('planWait' in launched.summary).toBe(false);
    expect(run(launched, [[0, wait(null)]]).state).toBe(launched);
    const held = run(launched, [[0, wait('implementation')]]).state;
    expect(run(held, [[1, wait('implementation')]]).state).toBe(held);
    expect(run(held, [[1, turn()], [2, end()]]).state.summary.planWait).toBe('implementation');
  });
});

// ── M106: sub-agents across turns and restarts ────────────────────────────────────────────────
// V1 (docs/planning/_archive/M106.md, Design 3; C8, C13, C26–C29, C38).
describe('sub-agents across turns and restarts (M106: V1)', () => {
  const named = (n: number, model: string, agentType?: string): Step[1] => ({ type: 'worker-started', workerId: `worker-${n}`, description: `Task ${n}`, model, ...(agentType === undefined ? {} : { agentType }) });
  const modelOf = (n: number, model: string): Step[1] => ({ type: 'worker-model', workerId: `worker-${n}`, model });
  const listing = (workers: { workerId: string; label: string; status: 'completed' | 'failed'; model: string | null; agentType: string | null; startedAt: number; finishedAt: number | null }[]): Step[1] => ({ type: 'workers-listed', workers });
  const agentsOf = (state: SessionState) => state.summary.agents.map((agent) => [agent.number, agent.id, agent.state]);

  it('keeps the finished ones across a turn’s start, and the running ones, numbering on (C26, C28)', () => {
    const first = run(started(), [[0, turn()], [1, worker(1)], [2, worker(2)], [3, done(1)], [9, end()]]);
    const second = run(first.state, [[20, turn('t2')], [21, worker(3)], [22, done(2)], [23, done(3)], [30, end('completed', 't2')], [40, turn('t3')]]);
    expect(agentsOf(second.state)).toEqual([[1, 'worker-1', 'completed'], [2, 'worker-2', 'completed'], [3, 'worker-3', 'completed']]);
    // The running count, a waiting turn and a reported set read the running ones alone (C29).
    expect(second.state.summary.activeWorkers).toBe(0);
    const waiting = run(second.state, [[41, worker(4)], [42, end('completed', 't3')]]);
    expect(waiting.state.summary).toMatchObject({ status: 'running', activeWorkers: 1, action: { label: 'Waiting for a sub-agent' } });
    const reported = run(waiting.state, [[43, { type: 'workers-reported', workerIds: [] }]]);
    expect(reported.state.summary).toMatchObject({ status: 'idle', activeWorkers: 0, attention: { kind: 'ready' } });
    expect(reported.state.summary.agents).toHaveLength(4);
  });

  it('bounds the finished ones to the most recently finished, keeps every running one, and gives no number twice (C27, C28)', () => {
    const steps: Step[] = [[0, turn()], [1, worker(1)]];
    // Worker 1 runs throughout; 101 more start and finish, the last of them first.
    for (let n = 2; n <= 102; n += 1) steps.push([n, worker(n)]);
    steps.push([200, done(102)]);
    for (let n = 2; n <= 101; n += 1) steps.push([200 + n, done(n)]);
    const { state } = run(started(), steps);
    expect(state.summary.agents.filter((agent) => agent.state !== 'running')).toHaveLength(MAX_FINISHED_AGENTS);
    // The one that finished first leaves: the newest started of all, so the highest number left the list.
    expect(state.summary.agents.some((agent) => agent.id === 'worker-102')).toBe(false);
    expect(state.summary.agents.find((agent) => agent.id === 'worker-1')?.state).toBe('running');
    const next = run(state, [[400, worker(200)]]);
    expect(next.state.summary.agents.at(-1)).toMatchObject({ id: 'worker-200', number: 103 });
  });

  it('lights a worker’s own row by its open requests, counted as the session’s are, and lets it go when answered, when it ends and at a quit (C8)', () => {
    const asked = run(started(), [[0, turn()], [1, worker(1)], [2, worker(2)], [3, ask('q1', 'question', { workerId: 'worker-1' }, 2)], [4, ask('a1', 'approval', { workerId: 'worker-1' })], [5, ask('q2', 'question', { workerId: 'worker-1' })], [6, ask('q3', 'question')]]);
    const [one, two] = asked.state.summary.agents;
    expect(one?.attention).toEqual({ kind: 'question', count: 3, acknowledged: false });
    expect(two?.attention).toBeNull();
    // Acknowledging the session's attention acknowledges no row.
    expect(acknowledged(asked.state).summary.agents[0]?.attention).toEqual({ kind: 'question', count: 3, acknowledged: false });
    // An unchanged count keeps its object; an answer moves it on; the last answer lets it go.
    const turnAnswered = run(asked.state, [[7, answer('q3')]]);
    expect(turnAnswered.state.summary.agents[0]?.attention).toBe(one?.attention);
    const partly = run(asked.state, [[7, answer('q1', { workerId: 'worker-1' })], [8, answer('q2', { workerId: 'worker-1' })]]);
    expect(partly.state.summary.agents[0]?.attention).toEqual({ kind: 'approval', count: 1, acknowledged: false });
    expect(run(partly.state, [[9, answer('a1', { workerId: 'worker-1' })]]).state.summary.agents[0]?.attention).toBeNull();
    expect(run(asked.state, [[9, done(1)]]).state.summary.agents[0]).toMatchObject({ state: 'completed', attention: null });
    expect(stopped(asked.state, T + 50 * SEC).summary.agents.map((agent) => agent.attention)).toEqual([null, null]);
  });

  it('keeps the model a worker starts on and the one its first frame names, a finished worker’s too, and discards one for a worker not listed (C13, C38)', () => {
    const { state } = run(started(), [[0, turn()], [1, named(1, 'haiku', ' general-purpose \nmore')], [2, worker(2)]]);
    expect(state.summary.agents.map((agent) => [agent.model, agent.agentType])).toEqual([['haiku', 'general-purpose'], [null, null]]);
    const resolved = run(state, [[3, modelOf(1, 'claude-haiku-4-5-20251001')], [4, done(2)], [5, modelOf(2, 'claude-opus-5')]]);
    expect(resolved.state.summary.agents.map((agent) => agent.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5']);
    expect(run(resolved.state, [[6, modelOf(1, 'claude-haiku-4-5-20251001')]]).state).toBe(resolved.state);
    const stale = run(resolved.state, [[7, modelOf(9, 'opus')]]);
    expect(stale.state).toBe(resolved.state);
    expect(stale.discarded).toEqual(['stale worker']);
    // An agent definition that cleans to nothing is none.
    expect(run(started(), [[0, turn()], [1, named(1, 'haiku', '   ')]]).state.summary.agents[0]?.agentType).toBeNull();
  });

  it('lists the store’s finished workers at launch, numbered in the order they started, for a session that does not run (C26, C28)', () => {
    const launched = summaryAtLaunch(started({ lastTurn: { turnId: 't0', startedAt: T, endedAt: T + 50 * SEC, outcome: 'completed' } }));
    // Newest first, as the store gives them: one with no end, one failed, one completed with an empty label.
    const { state, discarded } = run(launched, [[60, listing([
      { workerId: 'w-c', label: 'Third', status: 'failed', model: null, agentType: null, startedAt: T + 30 * SEC, finishedAt: null },
      { workerId: 'w-b', label: 'Second\nline', status: 'failed', model: 'claude-opus-5', agentType: 'Explore', startedAt: T + 20 * SEC, finishedAt: T + 50 * SEC },
      { workerId: 'w-a', label: '', status: 'completed', model: 'haiku', agentType: 'general-purpose', startedAt: T + 10 * SEC, finishedAt: T + 40 * SEC },
    ])]]);
    expect(discarded).toEqual([]);
    expect(state.summary.agents).toEqual([
      { id: 'w-a', number: 1, label: 'Worker 1', state: 'completed', action: null, startedAt: T + 10 * SEC, finishedAt: T + 40 * SEC, model: 'haiku', agentType: 'general-purpose', attention: null },
      { id: 'w-b', number: 2, label: 'Second', state: 'failed', action: null, startedAt: T + 20 * SEC, finishedAt: T + 50 * SEC, model: 'claude-opus-5', agentType: 'Explore', attention: null },
      { id: 'w-c', number: 3, label: 'Third', state: 'failed', action: null, startedAt: T + 30 * SEC, finishedAt: null, model: null, agentType: null, attention: null },
    ]);
    // The launch's own attention stands: the list lights nothing.
    expect(state.summary.attention).toBe(launched.summary.attention);
    // And the next worker numbers on from them.
    expect(run(state, [[70, turn()], [71, worker(9)]]).state.summary.agents.at(-1)?.number).toBe(4);
    // An empty list for a session with none changes nothing.
    expect(run(launched, [[60, listing([])]]).state).toBe(launched);
    // It replaces what was listed: Start fresh empties it.
    expect(run(state, [[80, listing([])]]).state.summary.agents).toEqual([]);
  });

  it('discards a store’s list for a session that runs, which lists its own (C26)', () => {
    const running = run(started(), [[0, turn()], [1, worker(1)]]).state;
    const result = run(running, [[2, listing([{ workerId: 'w-old', label: 'Old', status: 'completed', model: null, agentType: null, startedAt: T, finishedAt: T }])]]);
    expect(result.state).toBe(running);
    expect(result.discarded).toEqual(['stale worker']);
  });
});
