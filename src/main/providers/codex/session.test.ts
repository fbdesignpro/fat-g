// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5–V8, V11, V27, V29, V33, V34, V39, V43, V57–V59 (docs/planning/_archive/M15.md): one Codex session, on a
// scripted connection. What it sends and when, what each outcome reads as, and what it counts. The
// same session on a real process, against the replay fake, is in tests/codex/.
//
// V26, the adapter's part (docs/planning/_archive/M18.md; C47, C59): a turn's start names Codex's own id for
// the turn, and of a turn's ends only the one Codex gave with `turn/completed` is `reported`.
//
// V5, V21–V23, V25, V26, V31, V35, the adapter's part (docs/planning/_archive/M21.md, Design 4): a question
// asked as a request, on the request K2's capture holds — held under its owner, answered through
// the connection's `reply`, and let go, withdrawn, confirmed or dropped as each end says.
//
// V2, V7, V21, V27, V31, the adapter's part (docs/planning/_archive/M22.md, Design 3, 4, 7, 8): the mode named
// on every start, resume and turn and held to in each reply; a request for leave held, shown,
// decided and let go as a question is, on K1's and K4's captured requests; a repeated delivery
// compared with its hold; and a line over the limit refused by its id, or answered by stopping
// everything. The events these tests list are every event but `in-force`, which is listed apart.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { ContextReading } from '@shared/contracts/sessions';
import { ProcessFailure } from '@shared/provider-kit/process';
import type { TurnRequest } from '@shared/provider-kit/sessions';
import { createCodexSession, MAX_HELD_CALLS, MAX_HELD_FRAMES, promptInput } from './session';
import { SESSION_TIMINGS } from './session-process';
import { scriptedContext, type ScriptedConnection, settle } from './session-test-support';

const executable = { path: 'C:\\bin\\codex.exe', kind: 'native' } as const;
const FOLDER = 'C:\\work\\project';
const THREAD = 'thread-1';
const CLI_TURN = 'cli-turn-1';
const WORKER = 'worker-thread-1';
const START_REPLY = { thread: { id: THREAD }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', model: 'other-model', reasoningEffort: 'high' };
/** What a read-only thread's reply reported, as each of its turns names it again (M22, C7): no reviewer, since its policy asks no one (C70). */
const READ_ONLY_TURN = { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false } };
const turn = (n = 1, effort: string | null = 'low'): TurnRequest => ({ turnId: `turn-${n}`, prompt: `Prompt ${n}`, effort, speed: null, messageId: `message-${n}` });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup(reference: string | null = null, hasExecutable = true, mode: string | null = 'read-only', startReply: Record<string, unknown> = START_REPLY, speed: string | null = null) {
  const script = scriptedContext();
  const checked: { mode: string; ok: boolean }[] = [];
  const session = createCodexSession({ context: script.context, executable: () => (hasExecutable ? executable : undefined), argsPrefix: [], applicationVersion: '1.0.0', timings: SESSION_TIMINGS, start: { folder: FOLDER, model: 'gpt-x', effort: 'low', speed, otherFolders: [], mode, processKey: 'process-1' }, reference, onChecked: (id, _reported, check) => { checked.push({ mode: id, ok: check.ok }); } });
  const events: AgentEvent[] = [];
  /** Each confirmation of the mode (M22, C2), apart from `events`: one for each start or resume reply that was as asked. */
  const inForce: AgentEvent[] = [];
  /** Its context readings (decision 0033), apart from `events` too. */
  const readings: ContextReading[] = [];
  // A `steer-changed` is left out: session-steer.test.ts reads those.
  session.subscribe((event) => { if (event.type === 'context') readings.push(event.reading); else if (event.type !== 'steer-changed') (event.type === 'in-force' ? inForce : events).push(event); });
  let closed: { ok: boolean } | undefined;
  void session.closed.then((result) => { closed = result; });
  const wire = (): ScriptedConnection => script.latest();
  return {
    script, session, events, inForce, readings, checked, wire,
    closed: () => closed,
    types: () => events.map((event) => event.type),
    notices: () => events.flatMap((event) => (event.type === 'notice' ? [event.kind] : [])),
    sent: () => wire().requests.map((request) => request.method),
    /** The process and its handshake. */
    async launch(request = turn()) { session.send(request); await settle(); wire().pending('initialize').resolve({}); await settle(); },
    /** Up to `turn/start` being sent. */
    async begin(request = turn()) {
      session.send(request); await settle();
      if (wire().requests.at(-1)?.method === 'initialize') { wire().pending('initialize').resolve({}); await settle(); }
      if (wire().requests.at(-1)?.method === 'thread/start' || wire().requests.at(-1)?.method === 'thread/resume') { wire().requests.at(-1)?.resolve(startReply); await settle(); }
    },
    /** Up to the reply that names the turn. */
    async named(request = turn(), cliTurn = CLI_TURN) { await this.begin(request); wire().pending('turn/start').resolve({ turn: { id: cliTurn } }); await settle(); },
    /** Up to the turn having started. */
    async running(request = turn(), cliTurn = CLI_TURN) { await this.named(request, cliTurn); wire().notify('turn/started', { threadId: THREAD, turn: { id: cliTurn } }); },
    completed(status = 'completed', cliTurn = CLI_TURN, error: unknown = null) { wire().notify('turn/completed', { threadId: THREAD, turn: { id: cliTurn, status, error } }); },
    openWorker(cliTurn = CLI_TURN) {
      wire().notify('item/started', { threadId: THREAD, turnId: cliTurn, item: { type: 'subAgentActivity', id: 'call-1', kind: 'started', agentThreadId: WORKER, agentPath: '/root/secret' } });
      wire().notify('turn/started', { threadId: WORKER, turn: { id: 'worker-turn-1' } });
    },
  };
}

const ended = (events: readonly AgentEvent[]) => events.filter((event) => event.type === 'turn-ended');

describe('the first prompt (V5, V6; C20–C23, C26, C33)', () => {
  it('launches nothing until it is sent a prompt', async () => {
    const { script } = setup();
    await settle();
    expect(script.opened).toHaveLength(0);
  });

  it('starts the thread in the folder it was given, read-only, never asking, with the model, and nothing else', async () => {
    const h = setup();
    await h.launch();
    expect(h.sent()).toEqual(['initialize', 'thread/start']);
    expect(h.wire().pending('thread/start').params).toEqual({ cwd: FOLDER, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-x', serviceTier: 'default' });
    expect(h.wire().pending('thread/start').timeoutMs).toBe(30_000);
  });

  it('sends the prompt as one text input, with the model, the effort and the message’s id; no effort for a model with no levels', async () => {
    const h = setup();
    await h.begin(turn(1, 'medium'));
    expect(h.wire().pending('turn/start').params).toEqual({ threadId: THREAD, input: [{ type: 'text', text: 'Prompt 1', text_elements: [] }], model: 'gpt-x', effort: 'medium', serviceTier: 'default', clientUserMessageId: 'message-1', ...READ_ONLY_TURN });
    expect(h.wire().pending('turn/start').timeoutMs).toBe(15_000);

    const none = setup();
    await none.begin(turn(1, null));
    expect(none.wire().pending('turn/start').params).toEqual({ threadId: THREAD, input: [{ type: 'text', text: 'Prompt 1', text_elements: [] }], model: 'gpt-x', serviceTier: 'default', clientUserMessageId: 'message-1', ...READ_ONLY_TURN });
  });

  it('reports the reference with its folder once the first turn has started: not at the start’s reply, not when the turn is named (V58; C130)', async () => {
    const h = setup();
    await h.begin();
    expect(h.events).toEqual([]);
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    expect(h.events).toEqual([{ type: 'turn-started', turnId: 'turn-1', providerTurnId: CLI_TURN }]);
    h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    expect(h.events.at(-1)).toEqual({ type: 'session-started', reference: THREAD, folder: FOLDER });
    // Once: the next turn of the same session reports none.
    h.completed();
    await h.running(turn(2), 'cli-turn-2');
    expect(h.events.filter((event) => event.type === 'session-started')).toHaveLength(1);
    expect(h.sent()).toEqual(['initialize', 'thread/start', 'turn/start', 'turn/start']);
  });

  // Decision 0018: the speed tier, named on the start and on every turn; null asks for
  // standard speed, so a `service_tier` of the user's own configuration applies to no chat of fat-g's.
  it('names the record’s speed tier on the thread’s start and the turn’s own on every turn, and `default` for standard speed', async () => {
    const fast = setup(null, true, 'read-only', START_REPLY, 'priority');
    await fast.running({ ...turn(1, 'medium'), speed: 'priority' });
    expect(fast.wire().pending('thread/start').params).toMatchObject({ model: 'gpt-x', serviceTier: 'priority' });
    expect(fast.wire().pending('turn/start').params).toMatchObject({ effort: 'medium', serviceTier: 'priority' });
    // A change after the start: the next turn asks for standard speed, explicitly.
    fast.completed();
    await fast.begin(turn(2, 'medium'));
    expect(fast.wire().pending('turn/start').params).toMatchObject({ serviceTier: 'default' });
    expect(Object.prototype.hasOwnProperty.call(fast.wire().pending('turn/start').params, 'serviceTier')).toBe(true);
    expect(fast.sent()).toEqual(['initialize', 'thread/start', 'turn/start', 'turn/start']);
    // And on a resume, the record's tier.
    const resumed = setup('stored-thread', true, 'read-only', START_REPLY, 'priority');
    await resumed.launch({ ...turn(1), speed: 'priority' });
    expect(resumed.wire().pending('thread/resume').params).toMatchObject({ threadId: 'stored-thread', serviceTier: 'priority' });
  });

  it('says a faster tier the thread did not take as not served, and one it took as served, from the start reply alone', async () => {
    const dropped = setup(null, true, 'read-only', { ...START_REPLY, serviceTier: null }, 'priority');
    await dropped.running({ ...turn(1), speed: 'priority' });
    expect(dropped.inForce).toEqual([{ type: 'in-force', mode: 'read-only' }, { type: 'in-force', served: 'standard', servedReason: 'not-offered' }]);
    const taken = setup(null, true, 'read-only', { ...START_REPLY, serviceTier: 'priority' }, 'priority');
    await taken.running({ ...turn(1), speed: 'priority' });
    expect(taken.inForce).toEqual([{ type: 'in-force', mode: 'read-only' }, { type: 'in-force', served: 'fast', servedReason: null }]);
    // Standard speed asked says nothing of a speed served.
    const plain = setup(null, true, 'read-only', { ...START_REPLY, serviceTier: 'default' });
    await plain.running(turn(1));
    expect(plain.inForce).toEqual([{ type: 'in-force', mode: 'read-only' }]);
  });

  it('carries the session’s model and the turn’s own effort in every turn, whatever the start reply said (V32; C22, C45)', async () => {
    const h = setup();
    await h.running(turn(1, 'low'));
    h.completed();
    await h.begin(turn(2, 'high'));
    expect(h.wire().pending('turn/start').params).toMatchObject({ model: 'gpt-x', effort: 'high' });
    // What is told as in force is the mode alone (M22, C2), once, at the start reply's check: never a model or an effort the reply named.
    expect(h.inForce).toEqual([{ type: 'in-force', mode: 'read-only' }]);
  });

  it.each([
    ['another sandbox', { ...START_REPLY, sandbox: { type: 'workspaceWrite', networkAccess: false } }],
    ['network access', { ...START_REPLY, sandbox: { type: 'readOnly', networkAccess: true } }],
    ['another policy', { ...START_REPLY, approvalPolicy: 'on-request' }],
    ['no sandbox at all', { thread: { id: THREAD }, approvalPolicy: 'never' }],
  ])('sends no prompt when the reply reports %s, says why, and closes the process (C21)', async (_name, reply) => {
    const h = setup();
    await h.launch();
    h.wire().pending('thread/start').resolve(reply);
    await settle();
    expect(h.sent()).toEqual(['initialize', 'thread/start']);
    expect(h.events).toEqual([{ type: 'notice', kind: 'not-read-only', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'not-read-only' }]);
    expect(h.wire().closes).toBe(1);
    expect(h.closed()).toEqual({ ok: true });
  });
});

describe('resume (V7, V57; C24, C25, C129)', () => {
  it('resumes by the reference, in the stored folder, read-only, never asking, without the turns, then sends the prompt', async () => {
    const h = setup('stored-thread');
    await h.launch();
    expect(h.wire().pending('thread/resume').params).toEqual({ threadId: 'stored-thread', cwd: FOLDER, sandbox: 'read-only', approvalPolicy: 'never', serviceTier: 'default', excludeTurns: true });
    h.wire().pending('thread/resume').resolve({ ...START_REPLY, thread: { id: 'stored-thread' } });
    await settle();
    expect(h.wire().pending('turn/start').params).toMatchObject({ threadId: 'stored-thread', model: 'gpt-x' });
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    h.wire().notify('turn/started', { threadId: 'stored-thread', turn: { id: CLI_TURN } });
    // The record holds the reference already: none is reported again.
    expect(h.types()).toEqual(['turn-started']);
  });

  it('checks the resume’s reply as it checks a start’s', async () => {
    const h = setup('stored-thread');
    await h.launch();
    h.wire().pending('thread/resume').resolve({ ...START_REPLY, approvalPolicy: 'untrusted' });
    await settle();
    expect(h.notices()).toEqual(['not-read-only']);
    expect(h.sent()).not.toContain('turn/start');
  });

  it('offers the removal on the missing thread’s code alone, whatever was said with it, and sends no prompt', async () => {
    const h = setup('stored-thread');
    await h.launch();
    h.wire().pending('thread/resume').reject(new ProcessFailure('rpc-error', -32600));
    await settle();
    expect(h.events).toEqual([{ type: 'notice', kind: 'session-not-reopened', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'session-not-reopened' }]);
    expect(h.sent()).toEqual(['initialize', 'thread/resume']);
    expect(h.wire().closes).toBe(1);
  });

  it('reads a refusal with another code as a failed start, with no offer', async () => {
    const h = setup('stored-thread');
    await h.launch();
    h.wire().pending('thread/resume').reject(new ProcessFailure('rpc-error', -32000));
    await settle();
    expect(h.events).toEqual([{ type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'reopen' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' }]);
  });
});

describe('a start that fails after acceptance (V27; C15, C87)', () => {
  it('names the launch when there is no executable, and when the process cannot be started', async () => {
    const none = setup(null, false);
    none.session.send(turn());
    await settle();
    expect(none.events).toEqual([{ type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'launch' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' }]);
    expect(none.closed()).toEqual({ ok: true });

    const failing = setup();
    failing.script.failNextOpen();
    failing.session.send(turn());
    await settle();
    expect(failing.notices()).toEqual(['start-failed']);
    expect(failing.events[0]).toMatchObject({ step: 'launch' });
  });

  it.each([['open', null, 'thread/start', 30_000], ['reopen', 'stored-thread', 'thread/resume', 30_000]] as const)('names the %s step when it gets no answer inside its deadline, and sends nothing more', async (step, reference, method, deadline) => {
    const h = setup(reference);
    await h.launch();
    expect(h.wire().pending(method).timeoutMs).toBe(deadline);
    await vi.advanceTimersByTimeAsync(deadline);
    expect(h.events).toEqual([{ type: 'notice', kind: 'start-failed', turnId: 'turn-1', step }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' }]);
    expect(h.sent().at(-1)).toBe(method);
    expect(h.wire().closes).toBe(1);
  });

  it('names the send when turn/start is refused or gets no answer, and closes the process', async () => {
    const refused = setup();
    await refused.begin();
    refused.wire().pending('turn/start').reject(new ProcessFailure('rpc-error', -32600));
    await settle();
    expect(refused.events).toEqual([{ type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'send' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' }]);
    expect(refused.wire().closes).toBe(1);

    const silent = setup();
    await silent.begin();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(silent.notices()).toEqual(['start-failed']);
    expect(silent.sent().filter((method) => method === 'turn/start')).toHaveLength(1);
  });

  it('names the step it was at when the process ends during the start, and resolves `closed` after the turn’s end', async () => {
    const h = setup();
    await h.launch();
    const order: string[] = [];
    h.session.subscribe((event) => { if (event.type === 'turn-ended') order.push('turn-ended'); });
    void h.session.closed.then(() => order.push('closed'));
    h.wire().end();
    await settle(12);
    expect(h.events).toEqual([{ type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'open' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' }]);
    expect(order).toEqual(['turn-ended', 'closed']);
  });

  it('takes no second prompt while a turn is in flight, and none once it is over', async () => {
    const h = setup();
    await h.begin();
    h.session.send(turn(2));
    await settle();
    expect(h.sent().filter((method) => method === 'turn/start')).toHaveLength(1);
    await h.session.close();
    h.session.send(turn(3));
    await settle();
    expect(h.script.opened).toHaveLength(1);
  });
});

describe('Stop (V8, V58; C27, C28, C131)', () => {
  it('cancels a start before turn/start is sent: nothing more is sent, the turn ends interrupted, the process is closed, no reference is reported', async () => {
    const h = setup();
    await h.launch();
    h.session.stop();
    await settle(12);
    expect(h.sent()).toEqual(['initialize', 'thread/start']);
    expect(h.events).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(h.wire().closes).toBe(1);
    expect(h.closed()).toEqual({ ok: true });
  });

  it('cancels during the launch too, and closes the process that was starting', async () => {
    const h = setup();
    h.session.send(turn());
    await settle();
    h.session.stop();
    await settle(12);
    expect(h.sent()).toEqual(['initialize']);
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(h.wire().closes).toBe(1);
  });

  it('pressed before the turn has started, sends its interrupt when turn/started arrives, and none at the reply', async () => {
    const h = setup();
    await h.begin();
    h.session.stop();
    await settle();
    expect(h.sent()).not.toContain('turn/interrupt');
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    // Named, and not started: Codex would refuse an interrupt now.
    expect(h.sent()).not.toContain('turn/interrupt');
    h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    expect(h.sent().filter((method) => method === 'turn/interrupt')).toHaveLength(1);
    expect(h.wire().pending('turn/interrupt').params).toEqual({ threadId: THREAD, turnId: CLI_TURN });
    h.completed('interrupted');
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
    // The thread had started its turn, so it is kept: the reference was reported.
    expect(h.types()).toContain('session-started');
    expect(h.wire().closes).toBe(0);
  });

  it('names the thread and the turn during a turn, once, and the turn ends interrupted', async () => {
    const h = setup();
    await h.running();
    h.session.stop();
    h.session.stop();
    expect(h.wire().requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params)).toEqual([{ threadId: THREAD, turnId: CLI_TURN }]);
    h.wire().pending('turn/interrupt').resolve({});
    h.completed('interrupted');
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
    // T4's late item names the ended turn and changes nothing.
    const before = h.events.length;
    h.wire().notify('item/completed', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'commandExecution', id: 'late' } });
    h.wire().notify('item/started', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'commandExecution', id: 'late-2' } });
    expect(h.events).toHaveLength(before);
    // The stop's clock was let go with the turn.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.wire().closes).toBe(0);
    expect(h.events).toHaveLength(before);
  });

  it('ends the process when Codex has not confirmed the Stop 10 seconds later: the turn interrupted, with its notice', async () => {
    const h = setup();
    await h.running();
    h.session.stop();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.wire().closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.events.slice(-2)).toEqual([{ type: 'notice', kind: 'stop-unconfirmed', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(h.wire().closes).toBe(1);
    expect(h.closed()).toEqual({ ok: true });
  });

  it('leaves an interrupt Codex refuses to the same 10 seconds', async () => {
    const h = setup();
    await h.running();
    h.session.stop();
    h.wire().pending('turn/interrupt').reject(new ProcessFailure('rpc-error', -32600));
    await settle();
    expect(ended(h.events)).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.notices()).toEqual(['stop-unconfirmed']);
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
  });
});

describe('workers (V29, V34, V59; C17, C90, C99, C100, C132)', () => {
  it('a Stop interrupts the session’s turn and each open worker’s own, and ends the workers as failed before the turn', async () => {
    const h = setup();
    await h.running();
    h.openWorker();
    h.session.stop();
    expect(h.wire().requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params)).toEqual([{ threadId: THREAD, turnId: CLI_TURN }, { threadId: WORKER, turnId: 'worker-turn-1' }]);
    h.completed('interrupted');
    expect(h.events.slice(-2)).toEqual([{ type: 'worker-ended', workerId: WORKER, outcome: 'failed' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
    // The worker's later frames find no open worker.
    const before = h.events.length;
    h.wire().notify('turn/completed', { threadId: WORKER, turn: { id: 'worker-turn-1', status: 'interrupted' } });
    expect(h.events).toHaveLength(before);
    expect(h.session.counts.dropped['other-thread']).toBe(1);
    expect(JSON.stringify(h.events)).not.toContain('/root/secret');
  });

  it('a worker whose turn is not named yet gets no interrupt', async () => {
    const h = setup();
    await h.running();
    h.wire().notify('item/started', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'subAgentActivity', id: 'call-1', kind: 'started', agentThreadId: WORKER } });
    h.session.stop();
    expect(h.sent().filter((method) => method === 'turn/interrupt')).toHaveLength(1);
  });

  it.each([
    ['a process that ends', (h: ReturnType<typeof setup>) => { h.wire().end(); }, 'failed', 'connection-lost'],
    ['a forced Stop', (h: ReturnType<typeof setup>) => { h.session.stop(); vi.advanceTimersByTime(10_000); }, 'interrupted', 'stop-unconfirmed'],
    ['a lost end', (h: ReturnType<typeof setup>) => { h.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } }); vi.advanceTimersByTime(2_000); }, 'failed', 'output-lost'],
  ] as const)('%s ends an open worker as failed before the turn’s end, and the session is no longer running', async (_name, act, outcome, notice) => {
    const h = setup();
    await h.running();
    h.openWorker();
    act(h);
    await settle(12);
    const tail = h.events.slice(-3);
    expect(tail[0]).toEqual({ type: 'worker-ended', workerId: WORKER, outcome: 'failed' });
    expect(tail[1]).toMatchObject({ type: 'notice', kind: notice });
    expect(tail[2]).toMatchObject({ type: 'turn-ended', outcome, reported: false });
  });

  it('settles a worker’s end by its closing item and its own turn’s end, and by the clock when one never comes (C133)', async () => {
    const h = setup();
    await h.running();
    h.openWorker();
    h.wire().notify('turn/completed', { threadId: WORKER, turn: { id: 'worker-turn-1', status: 'failed' } });
    expect(h.types()).not.toContain('worker-ended');
    h.wire().notify('item/started', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: WORKER } });
    expect(h.events.at(-1)).toEqual({ type: 'worker-ended', workerId: WORKER, outcome: 'failed' });
    // Its clock was let go: nothing more after 2 seconds.
    const before = h.events.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.events).toHaveLength(before);

    const lone = setup();
    await lone.running();
    lone.openWorker();
    lone.wire().notify('item/completed', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: WORKER } });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(lone.types()).not.toContain('worker-ended');
    await vi.advanceTimersByTimeAsync(1);
    expect(lone.events.at(-1)).toEqual({ type: 'worker-ended', workerId: WORKER, outcome: 'completed' });
  });

  it('with workers left after their turn, Stop ends the process at once: the workers failed, with its notice', async () => {
    const h = setup();
    await h.running();
    h.openWorker();
    h.completed();
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
    expect(h.types()).not.toContain('worker-ended');
    h.session.stop();
    await settle();
    expect(h.events.slice(-2)).toEqual([{ type: 'worker-ended', workerId: WORKER, outcome: 'failed' }, { type: 'notice', kind: 'workers-stopped' }]);
    expect(h.sent()).not.toContain('turn/interrupt');
    expect(h.wire().closes).toBe(1);
    expect(ended(h.events)).toHaveLength(1);
  });

  it('a process that ends by itself with workers left reads the same, with its own notice', async () => {
    const h = setup();
    await h.running();
    h.openWorker();
    h.completed();
    h.wire().end();
    await settle();
    expect(h.events.slice(-2)).toEqual([{ type: 'worker-ended', workerId: WORKER, outcome: 'failed' }, { type: 'notice', kind: 'workers-lost' }]);
    expect(h.closed()).toEqual({ ok: true });
  });

  it('a Stop with nothing running does nothing', async () => {
    const h = setup();
    await h.running();
    h.completed();
    const before = h.events.length;
    h.session.stop();
    await settle();
    expect(h.events).toHaveLength(before);
    expect(h.wire().closes).toBe(0);
  });
});

describe('a lost process and a lost end (V9, V28; C17, C89)', () => {
  it('ends the turn as failed with connection-lost when its process ends, and starts nothing again', async () => {
    const h = setup();
    await h.running();
    h.wire().end();
    await settle();
    expect(h.events.slice(-2)).toEqual([{ type: 'notice', kind: 'connection-lost', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' }]);
    expect(h.closed()).toEqual({ ok: true });
    expect(h.script.opened).toHaveLength(1);
  });

  it('forgets an idle session’s process without a word', async () => {
    const h = setup();
    await h.running();
    h.completed();
    const before = h.events.length;
    h.wire().end();
    await settle();
    expect(h.events).toHaveLength(before);
    expect(h.closed()).toEqual({ ok: true });
  });

  it('takes a turn’s end from the thread’s status when turn/completed never comes: failed with end-lost after 2 seconds', async () => {
    const h = setup();
    await h.running();
    h.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(ended(h.events)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.events.slice(-2)).toEqual([{ type: 'notice', kind: 'output-lost', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'end-lost' }]);
    // The process is up: the next prompt needs no resume.
    expect(h.wire().closes).toBe(0);
    await h.named(turn(2), 'cli-turn-2');
    expect(h.sent().filter((method) => method === 'thread/start')).toHaveLength(1);
  });

  it('reads the lost end as interrupted after a Stop, and not at all when turn/completed follows', async () => {
    const stopped = setup();
    await stopped.running();
    stopped.session.stop();
    stopped.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ended(stopped.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(stopped.notices()).toEqual([]);

    const normal = setup();
    await normal.running();
    normal.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
    normal.completed();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ended(normal.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
  });

  it('fails a turn with the CLI’s own message as the notice’s detail (C39)', async () => {
    const h = setup();
    await h.running();
    h.wire().notify('error', { threadId: THREAD, turnId: CLI_TURN, willRetry: false, error: { message: JSON.stringify({ error: { message: 'The model is not supported.' } }) } });
    h.completed('failed');
    expect(h.events.slice(-2)).toEqual([{ type: 'notice', kind: 'turn-failed', turnId: 'turn-1', detail: 'The model is not supported.' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: true, failure: 'turn-failed' }]);
    expect(h.wire().closes).toBe(0);
  });
});

describe('frames held until the turn is named (V33, V43; C110)', () => {
  const answer = (cliTurn = CLI_TURN) => ({ threadId: THREAD, turnId: cliTurn, item: { type: 'agentMessage', id: 'answer-1', text: 'Done.', phase: 'final_answer' } });

  it('maps every frame that came before the reply once the turn is named, in order, the turn’s end included', async () => {
    const h = setup();
    await h.begin();
    h.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'active' } });
    h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    h.wire().notify('item/completed', answer());
    h.completed();
    expect(h.events).toEqual([]);
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    expect(h.types()).toEqual(['turn-started', 'session-started', 'message', 'turn-ended']);
    expect(h.events.at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true });
  });

  it('does the same on a resumed session', async () => {
    const h = setup(THREAD);
    await h.begin();
    h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    h.wire().notify('item/completed', answer());
    h.completed();
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    expect(h.types()).toEqual(['turn-started', 'message', 'turn-ended']);
  });

  it('maps a worker’s frames after the announcement that came with them, so its failure is not lost', async () => {
    const h = setup();
    await h.begin();
    // One chunk: the worker's own frames, and the announcement that makes them its own.
    h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    h.openWorker();
    h.wire().notify('item/started', { threadId: WORKER, turnId: 'worker-turn-1', item: { type: 'commandExecution', id: 'c1', commandActions: [{ type: 'read', name: 'notes.txt' }] } });
    h.wire().notify('turn/completed', { threadId: WORKER, turn: { id: 'worker-turn-1', status: 'failed' } });
    h.wire().notify('item/started', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: WORKER } });
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    expect(h.events.filter((event) => event.type.startsWith('worker'))).toEqual([
      { type: 'worker-started', workerId: WORKER },
      { type: 'worker-progressed', workerId: WORKER, kind: 'reading', file: 'notes.txt' },
      { type: 'worker-progressed', workerId: WORKER, kind: 'thinking' },
      { type: 'worker-ended', workerId: WORKER, outcome: 'failed' },
    ]);
    expect(h.session.counts.dropped['other-thread']).toBe(0);
  });

  it('drops and counts a held frame of another turn', async () => {
    const h = setup();
    await h.begin();
    h.wire().notify('item/completed', answer('some-other-turn'));
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    expect(h.types()).toEqual(['turn-started']);
    expect(h.session.counts.dropped['other-turn']).toBe(1);
    expect(h.script.diagnostics).toContainEqual({ type: 'frame-dropped', reason: 'other-turn' });
  });

  it('drops and counts a frame past the bound, of a queue that holds both threads', async () => {
    const h = setup();
    await h.begin();
    for (let i = 0; i < MAX_HELD_FRAMES - 1; i++) h.wire().notify('thread/status/changed', { threadId: i % 2 === 0 ? THREAD : WORKER, status: { type: 'active' } });
    h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    h.wire().notify('item/completed', answer());
    h.wire().notify('item/completed', { ...answer(), item: { ...answer().item, id: 'answer-2' } });
    expect(h.session.counts.dropped['held-overflow']).toBe(2);
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    // What was held is mapped; what did not fit is gone.
    expect(h.types()).toEqual(['turn-started', 'session-started']);
  });

  it('discards what was held when the start fails or is cancelled', async () => {
    const h = setup();
    await h.begin();
    h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    h.wire().notify('item/completed', answer());
    h.wire().pending('turn/start').reject(new ProcessFailure('rpc-error', -32600));
    await settle();
    expect(h.types()).toEqual(['notice', 'turn-ended']);
    expect(h.types()).not.toContain('session-started');
  });

  it('maps nothing of the thread before its first turn/start', async () => {
    const h = setup();
    await h.launch();
    h.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
    h.wire().pending('thread/start').resolve(START_REPLY);
    await settle();
    expect(h.events).toEqual([]);
    expect(h.session.counts.unmapped).toBe(1);
  });
});

describe('requests from the CLI (V11, V39; C34, C106)', () => {
  it('declines the two approval requests, refuses every other, counts each by method and says so once a turn', async () => {
    const h = setup();
    await h.running();
    expect(h.wire().ask('item/commandExecution/requestApproval', { command: 'rm -rf /' })).toEqual({ result: { decision: 'decline' } });
    expect(h.wire().ask('item/fileChange/requestApproval', {})).toEqual({ result: { decision: 'decline' } });
    // An MCP server's own form or address (decision 0018): "method not found", as before.
    expect(h.wire().ask('mcpServer/elicitation/request', {})).toEqual({ error: { code: -32601, message: 'Method not found' } });
    // No handler: the connection answers "method not found", and tells the session.
    expect(h.wire().ask('C:\\Users\\someone\\private', {})).toBeUndefined();
    expect(h.session.counts.refused).toEqual({ 'item/commandExecution/requestApproval': 1, 'item/fileChange/requestApproval': 1, 'mcpServer/elicitation/request': 1, other: 1 });
    expect(h.notices()).toEqual(['request-refused']);
    expect(h.events.find((event) => event.type === 'notice')).toEqual({ type: 'notice', kind: 'request-refused', turnId: 'turn-1' });
    const refusals = h.script.diagnostics.filter((event) => event.type === 'request-refused');
    expect(refusals.map((event) => event.method)).toEqual(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'mcpServer/elicitation/request', 'other']);
    expect(JSON.stringify(h.script.diagnostics)).not.toMatch(/someone|rm -rf/);
    // The turn goes on to its own end.
    h.completed();
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
    // The next turn says it again, once.
    await h.running(turn(2), 'cli-turn-2');
    h.wire().ask('item/fileChange/requestApproval', {});
    h.wire().ask('item/fileChange/requestApproval', {});
    expect(h.notices()).toEqual(['request-refused', 'request-refused']);
  });

  it('counts the notifications it does not map, never parsed, and a dropped line', async () => {
    const h = setup();
    await h.running();
    h.wire().notify('remoteControl/status/changed', { serverName: 'private-host' });
    h.wire().drop();
    expect(h.session.counts.unmapped).toBe(1);
    expect(h.session.counts.dropped.oversized).toBe(1);
    expect(JSON.stringify(h.events)).not.toContain('private-host');
  });
});

// Decision 0033: each thread's token report, read beside the mapper for the session's own thread.
describe('how full the context is (decision 0033)', () => {
  const usage = (input: number, cached: number, output: number, reasoning = 0) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: reasoning });
  const report = (threadId: string, last = usage(15_747, 12_544, 53), total = usage(31_000, 25_000, 120, 7)) => ({ threadId, turnId: CLI_TURN, tokenUsage: { total, last, modelContextWindow: 258_400 } });

  it('says its own thread’s report as the reading: the last call’s whole count, the window, the last call and every call so far, and no line', async () => {
    const h = setup();
    await h.running();
    h.wire().notify('thread/tokenUsage/updated', report(THREAD));
    expect(h.readings).toEqual([{
      used: 15_800, window: 258_400,
      lastCall: { input: 3_203, cacheRead: 12_544, cacheWrite: 0, output: 53, reasoning: 0 },
      calls: { input: 6_000, cacheRead: 25_000, cacheWrite: 0, output: 120, reasoning: 7 },
    }]);
    // The same report again says nothing; another count does.
    h.wire().notify('thread/tokenUsage/updated', report(THREAD));
    h.wire().notify('thread/tokenUsage/updated', report(THREAD, usage(15_834, 12_544, 53)));
    expect(h.readings.map((reading) => reading.used)).toEqual([15_800, 15_887]);
    expect(h.session.counts.context).toEqual({ read: 3, skipped: 0 });
    expect(h.events.filter((event) => event.type === 'context')).toEqual([]);
  });

  it('skips and counts a sub-agent’s report, a side thread’s, and one it cannot read', async () => {
    const h = setup();
    await h.running();
    h.openWorker();
    h.wire().notify('thread/tokenUsage/updated', report(WORKER, usage(14_000, 0, 530)));
    h.wire().notify('thread/tokenUsage/updated', report('side-thread'));
    h.wire().notify('thread/tokenUsage/updated', { threadId: THREAD });
    h.wire().notify('thread/tokenUsage/updated', { ...report(THREAD), tokenUsage: { ...report(THREAD).tokenUsage, modelContextWindow: 0 } });
    expect(h.readings).toEqual([]);
    expect(h.session.counts.context).toEqual({ read: 0, skipped: 4 });
  });
});

describe('the session’s end (V9, V51; C84, C116)', () => {
  it('closes its process when it is closed, ending a running turn first, and resolves `closed`', async () => {
    const h = setup();
    await h.running();
    h.openWorker();
    await expect(h.session.close()).resolves.toEqual({ ok: true });
    expect(h.events.slice(-2)).toEqual([{ type: 'worker-ended', workerId: WORKER, outcome: 'failed' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(h.wire().closes).toBe(1);
    expect(h.closed()).toEqual({ ok: true });
  });

  it('closes during a launch without leaving the process that was starting', async () => {
    const h = setup();
    h.session.send(turn());
    await settle();
    const closing = h.session.close();
    await settle(12);
    await expect(closing).resolves.toEqual({ ok: true });
    expect(h.wire().closes).toBeGreaterThan(0);
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
  });

  it('closes a session that never started with nothing to end', async () => {
    const h = setup();
    await expect(h.session.close()).resolves.toEqual({ ok: true });
    await expect(h.session.recheck()).resolves.toEqual({ ok: true });
    expect(h.script.opened).toHaveLength(0);
  });

  it('says so when its process’s end cannot be confirmed, and looks again only through the connection’s recheck', async () => {
    const h = setup();
    await h.running();
    h.completed();
    h.wire().cleanup = { ok: false };
    h.wire().recheck = { ok: false };
    await expect(h.session.close()).resolves.toEqual({ ok: false });
    expect(h.closed()).toEqual({ ok: false });
    await expect(h.session.recheck()).resolves.toEqual({ ok: false });
    h.wire().recheck = { ok: true };
    await expect(h.session.recheck()).resolves.toEqual({ ok: true });
  });

  it('emits only events that pass the schema, through a whole turn with a worker', async () => {
    const h = setup();
    await h.running();
    h.wire().notify('item/started', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'reasoning', id: 'r1' } });
    h.wire().notify('item/completed', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'userMessage', id: 'u1', clientId: 'message-1', content: [{ type: 'text', text: 'Prompt 1' }] } });
    h.wire().notify('item/completed', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'agentMessage', id: 'a1', text: 'Looking.', phase: 'commentary' } });
    h.openWorker();
    h.completed();
    expect(h.events.length).toBeGreaterThan(5);
    for (const event of h.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    expect(h.events.find((event) => event.type === 'message' && event.role === 'user')).toMatchObject({ clientId: 'message-1', itemId: 'u1' });
  });
});

describe('whose end it is (M18, V26; C47, C59)', () => {
  type Setup = ReturnType<typeof setup>;
  const idle = (h: Setup): void => { h.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } }); };

  it('names Codex’s own id for the turn at its start, each turn its own', async () => {
    const h = setup();
    await h.running();
    h.completed();
    await h.running(turn(2), 'cli-turn-2');
    expect(h.events.filter((event) => event.type === 'turn-started')).toEqual([{ type: 'turn-started', turnId: 'turn-1', providerTurnId: CLI_TURN }, { type: 'turn-started', turnId: 'turn-2', providerTurnId: 'cli-turn-2' }]);
  });

  it.each([
    ['completed', 'completed', 'completed', false],
    ['interrupted', 'interrupted', 'interrupted', false],
    ['interrupted after a Stop', 'interrupted', 'interrupted', true],
    ['failed', 'failed', 'failed', false],
    // A status the adapter does not know reads as failed, as it did before: the end is still Codex's word.
    ['a status it does not know', 'somethingNew', 'failed', false],
  ] as const)('reports the end Codex gave with turn/completed: %s', async (_name, status, outcome, stop) => {
    const h = setup();
    await h.running();
    if (stop) h.session.stop();
    h.completed(status);
    expect(ended(h.events)).toEqual([expect.objectContaining({ turnId: 'turn-1', outcome, reported: true })]);
  });

  it('reports it when turn/completed came before the reply that names the turn', async () => {
    const h = setup();
    await h.begin();
    h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    h.completed();
    h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
    await settle();
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
  });

  it.each([
    ['a lost end', async (h: Setup) => { await h.running(); idle(h); await vi.advanceTimersByTimeAsync(2_000); }, 'failed'],
    ['a lost end after a Stop', async (h: Setup) => { await h.running(); h.session.stop(); idle(h); await vi.advanceTimersByTimeAsync(2_000); }, 'interrupted'],
    ['a lost connection', async (h: Setup) => { await h.running(); h.wire().end(); await settle(); }, 'failed'],
    ['a lost connection after a Stop', async (h: Setup) => { await h.running(); h.session.stop(); h.wire().end(); await settle(); }, 'interrupted'],
    ['an unconfirmed Stop', async (h: Setup) => { await h.running(); h.session.stop(); await vi.advanceTimersByTimeAsync(10_000); }, 'interrupted'],
    ['a failed start', async (h: Setup) => { await h.begin(); h.wire().pending('turn/start').reject(new ProcessFailure('rpc-error', -32600)); await settle(); }, 'failed'],
    ['a cancelled start', async (h: Setup) => { await h.launch(); h.session.stop(); await settle(12); }, 'interrupted'],
    ['a close', async (h: Setup) => { await h.running(); await h.session.close(); }, 'interrupted'],
    ['a close during the start', async (h: Setup) => { await h.launch(); await h.session.close(); }, 'interrupted'],
  ] as const)('does not report %s: the end is the adapter’s own', async (_name, act, outcome) => {
    const h = setup();
    await act(h);
    expect(ended(h.events)).toEqual([expect.objectContaining({ turnId: 'turn-1', outcome, reported: false })]);
    for (const event of h.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
  });

  it('keeps an end it made its own when Codex’s word comes after it: one end, and not reported', async () => {
    const h = setup();
    await h.running();
    idle(h);
    await vi.advanceTimersByTimeAsync(2_000);
    h.completed();
    await settle();
    expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'end-lost' }]);
  });
});

// ── M21: a question asked as a request ────────────────────────────────────────────────────────
describe('a question asked as a request (M21; C11, C14, C23, C59, C60, C65–C67, C70, C75, C78)', () => {
  type Setup = ReturnType<typeof setup>;
  const REQUEST = 'item/tool/requestUserInput';
  const NOT_FOUND = { error: { code: -32601, message: 'Method not found' } };
  interface RawQuestion { id: string; header: string; question: string; isOther: boolean; isSecret: boolean; options: { label: string; description: string }[] }
  interface Captured { readonly dir: string; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: { questions: RawQuestion[] } & Record<string, unknown>; readonly result?: unknown } }
  const K2 = (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m21-codex-plan.json'), 'utf8')) as { frames: Captured[] }).frames;
  const asked = K2.find((f) => f.dir === 'recv' && f.frame.method === REQUEST) as Captured;
  const sent = K2.find((f) => f.dir === 'send' && f.frame.method === undefined && f.frame.id === asked.frame.id) as Captured;
  const [QUESTION] = (asked.frame.params as { questions: RawQuestion[] }).questions as [RawQuestion];
  /** K2's request as it came, on this session's thread and turn. */
  const request = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...asked.frame.params, threadId: THREAD, turnId: CLI_TURN, itemId: 'item-q', ...extra });
  const question = (extra: Partial<RawQuestion> = {}): RawQuestion => ({ ...QUESTION, ...extra });
  const options = (count: number, label = (n: number) => `option ${String(n)}`): RawQuestion['options'] => Array.from({ length: count }, (_, n) => ({ label: label(n), description: `About ${String(n)}.` }));
  const raised = (h: Setup) => h.events.flatMap((event) => (event.type === 'question-raised' ? [event] : []));
  const resolved = (h: Setup) => h.events.flatMap((event) => (event.type === 'question-resolved' ? [event] : []));
  const resolve = (h: Setup, requestId: unknown): void => { h.wire().notify('serverRequest/resolved', { threadId: THREAD, requestId }); };
  const second = { options: [1], text: null };
  const CARD = { text: 'Which file should the plan be about?', header: 'Choose file', options: [{ label: 'notes-1.txt', description: 'Plan to summarise notes-1.txt.' }, { label: 'notes-2.txt', description: 'Plan to summarise notes-2.txt.' }], multiple: false, freeText: true, secret: false };

  describe('held, and answered (V5, V25; C23, C25, C59)', () => {
    it('holds K2’s request under the session’s turn: nothing is written, and it is told with its questions, `isOther` as free text', async () => {
      const h = setup();
      await h.running();
      expect(asked.frame.params).toMatchObject({ isBlocking: true, autoResolutionMs: null });
      expect(h.wire().ask(REQUEST, request(), 0)).toBeNull();
      expect(raised(h)).toEqual([{ type: 'question-raised', turnId: 'turn-1', requestId: 'n:0', sourceId: 'item-q', questions: [CARD], cut: false }]);
      expect(AgentEventSchema.safeParse(raised(h)[0]).success).toBe(true);
      expect(h.wire().replies).toEqual([]);
      expect(h.notices()).toEqual([]);
      expect(h.session.counts.refused).toEqual({});
    });

    it('answers with `answers` keyed by the question’s own id, frame for frame as K2 sent it, and Codex’s word then confirms it', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request(), asked.frame.id);
      h.session.answer('n:0', [second]);
      await settle();
      expect(h.wire().replies).toEqual([{ id: asked.frame.id, reply: { result: sent.frame.result } }]);
      expect(sent.frame.result).toEqual({ answers: { notes_file: { answers: ['notes-2.txt'] } } });
      expect(resolved(h)).toEqual([]);
      // K2: `serverRequest/resolved` came 3 ms after the reply, the request's id a number as it was sent.
      resolve(h, 0);
      expect(resolved(h)).toEqual([{ type: 'question-resolved', requestId: 'n:0', reason: 'confirmed' }]);
      // Once: the hold went with Codex's word, and a second word names nothing held.
      resolve(h, 0);
      expect(resolved(h)).toHaveLength(1);
      expect(h.session.counts.questions).toEqual({ repeated: 0, unheld: 1, unwritten: 0 });
      // The turn goes on to its own end, and nothing was refused.
      h.completed();
      expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
      expect(h.notices()).toEqual([]);
      for (const event of h.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    });

    it('gives the chosen option and the typed text as separate strings, and a text alone where no option was chosen', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request({ questions: [question({ id: 'file' }), question({ id: 'style', question: 'Quoted or summarised?', options: [] })] }), 'q-7');
      expect(raised(h)[0]).toMatchObject({ requestId: 's:q-7', questions: [{ text: QUESTION.question }, { text: 'Quoted or summarised?', options: [], freeText: true }] });
      h.session.answer('s:q-7', [{ options: [0], text: 'and its neighbour' }, { options: [], text: 'Quoted, please.' }]);
      await settle();
      // The id is given back as it came: a string as a string.
      expect(h.wire().replies).toEqual([{ id: 'q-7', reply: { result: { answers: { file: { answers: ['notes-1.txt', 'and its neighbour'] }, style: { answers: ['Quoted, please.'] } } } } }]);
    });

    it('encodes from the request as it came: a label cut for the card is sent whole, by its place, and two alike for 500 units each give their own (C59)', async () => {
      const h = setup();
      await h.running();
      const long = (n: number): string => `${'x'.repeat(500)} — the ${String(n)}th`;
      h.wire().ask(REQUEST, request({ questions: [question({ question: 'q'.repeat(600), options: options(9, long) })] }), 0);
      const [event] = raised(h);
      // For the card: eight options, each label cut to its bound, and the cut said.
      expect(event).toMatchObject({ cut: true });
      expect(event?.questions[0]?.options).toHaveLength(8);
      expect(event?.questions[0]?.text).toHaveLength(500);
      expect(new Set(event?.questions[0]?.options.map((option) => option.label))).toEqual(new Set(['x'.repeat(500)]));
      expect(AgentEventSchema.safeParse(event).success).toBe(true);
      h.session.answer('n:0', [{ options: [1], text: null }]);
      await settle();
      expect(h.wire().replies).toEqual([{ id: 0, reply: { result: { answers: { [QUESTION.id]: { answers: [long(1)] } } } } }]);
    });

    it('reads nothing of `autoResolutionMs`: an hour later the request is still held, and still answered', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request({ autoResolutionMs: 1_000, isBlocking: false }), 0);
      const timersBefore = vi.getTimerCount();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(vi.getTimerCount()).toBe(timersBefore);
      expect(resolved(h)).toEqual([]);
      expect(h.wire().replies).toEqual([]);
      // `isBlocking: false` changes nothing either (C25): it is held and told as any, and no dismissal answers it.
      expect(raised(h)).toEqual([{ type: 'question-raised', turnId: 'turn-1', requestId: 'n:0', sourceId: 'item-q', questions: [CARD], cut: false }]);
      h.session.answer('n:0', [second]);
      await settle();
      expect(h.wire().replies).toHaveLength(1);
    });

    it('takes a second delivery of a held id as the same request: counted, no second event, and the one reply its id names', async () => {
      const h = setup();
      await h.running();
      expect(h.wire().ask(REQUEST, request(), 0)).toBeNull();
      expect(h.wire().ask(REQUEST, request(), 0)).toBeNull();
      expect(raised(h)).toHaveLength(1);
      expect(h.session.counts.questions.repeated).toBe(1);
      expect(h.session.counts.refused).toEqual({});
      h.session.answer('n:0', [second]);
      await settle();
      expect(h.wire().replies).toEqual([{ id: 0, reply: { result: sent.frame.result } }]);
    });

    it('takes a question of options alone as one with no free text, answered by its option; and a secret one as a secret (V35; C25, C78)', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request({ questions: [question({ isOther: false })] }), 0);
      expect(raised(h)[0]?.questions).toEqual([{ ...CARD, freeText: false }]);
      h.session.answer('n:0', [{ options: [0], text: null }]);
      await settle();
      expect(h.wire().replies.at(-1)).toEqual({ id: 0, reply: { result: { answers: { notes_file: { answers: ['notes-1.txt'] } } } } });
      resolve(h, 0);

      h.wire().ask(REQUEST, request({ questions: [question({ id: 'token', isSecret: true, isOther: false, options: [] })] }), 1);
      expect(raised(h)[1]?.questions).toEqual([{ ...CARD, options: [], freeText: false, secret: true }]);
      h.session.answer('n:1', [{ options: [], text: 'correct horse battery' }]);
      await settle();
      expect(h.wire().replies.at(-1)).toEqual({ id: 1, reply: { result: { answers: { token: { answers: ['correct horse battery'] } } } } });
      // Nothing of a question, an option or an answer is in what the adapter logged, a secret least of all.
      expect(JSON.stringify(h.script.diagnostics)).not.toMatch(/notes-|Which file|Choose file|correct horse|token/);
    });
  });

  describe('refused on the wire (V5, V21, V35; C11, C48, C60, C78)', () => {
    const many = (count: number): RawQuestion[] => Array.from({ length: count }, (_, n) => question({ id: `q${String(n)}` }));
    it.each([
      ['seventeen questions', () => request({ questions: many(17) })],
      ['twenty questions', () => request({ questions: many(20) })],
      ['no question at all', () => request({ questions: [] })],
      ['nine options and no free text', () => request({ questions: [question({ isOther: false, options: options(9) })] })],
      ['no option and no free text, which nothing could answer', () => request({ questions: [question(), question({ id: 'b', isOther: false, options: [] })] })],
      ['another turn of the session’s thread', () => request({ turnId: 'some-other-turn' })],
      ['a thread that is neither the session’s nor an open worker’s', () => request({ threadId: 'some-other-thread' })],
      ['no questions to read', () => ({ threadId: THREAD, turnId: CLI_TURN, itemId: 'item-q' })],
      ['an item id that is no id', () => request({ itemId: 'x'.repeat(300) })],
    ] as const)('answers %s with the error reply at once: counted under its method, with the notice, and no event', async (_name, params) => {
      const h = setup();
      await h.running();
      expect(h.wire().ask(REQUEST, params(), 0)).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
      expect(h.session.counts.refused).toEqual({ [REQUEST]: 1 });
      expect(h.events.filter((event) => event.type === 'notice')).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
      expect(h.script.diagnostics).toContainEqual({ type: 'request-refused', method: REQUEST });
      expect(h.wire().replies).toEqual([]);
      // Nothing was held: an answer names nothing, and writes nothing.
      h.session.answer('n:0', [second]);
      await settle();
      expect(h.wire().replies).toEqual([]);
      expect(h.session.counts.questions.unheld).toBe(1);
      // The turn goes on to its own end.
      h.completed();
      expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
    });

    it('refuses the session’s own request once its turn has ended, and one that comes with an id no reply could name (C11)', async () => {
      const h = setup();
      await h.running();
      expect(h.wire().ask(REQUEST, request(), null)).toEqual(NOT_FOUND);
      h.completed();
      expect(h.wire().ask(REQUEST, request(), 0)).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
      expect(h.session.counts.refused).toEqual({ [REQUEST]: 2 });
      // Said once a turn, as every refusal is: the one after the turn's end adds no notice.
      expect(h.events.filter((event) => event.type === 'notice')).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
    });

    it('still takes what can be drawn and answered: sixteen questions; nine options beside free text, cut; no option beside free text', async () => {
      const h = setup();
      await h.running();
      expect(h.wire().ask(REQUEST, request({ questions: many(16) }), 0)).toBeNull();
      expect(h.wire().ask(REQUEST, request({ questions: [question({ options: options(9) })] }), 1)).toBeNull();
      expect(h.wire().ask(REQUEST, request({ questions: [question({ options: [] })] }), 2)).toBeNull();
      expect(raised(h).map((event) => [event.requestId, event.questions.length, event.questions[0]?.options.length, event.cut])).toEqual([['n:0', 16, 2, false], ['n:1', 1, 8, true], ['n:2', 1, 0, false]]);
      for (const event of raised(h)) expect(AgentEventSchema.safeParse(event).success).toBe(true);
      expect(h.session.counts.refused).toEqual({});
    });

    it('writes the error reply through the connection when main refuses a request it was told of, also from inside that very event (C11, C30)', async () => {
      const h = setup();
      await h.running();
      // As the registry does for a request it cannot place: at once, while the adapter is still telling it.
      h.session.subscribe((event) => { if (event.type === 'question-raised' && event.requestId === 'n:0') h.session.answer(event.requestId, null); });
      expect(h.wire().ask(REQUEST, request(), 0)).toBeNull();
      await settle();
      expect(h.wire().replies).toEqual([{ id: 0, reply: NOT_FOUND }]);
      expect(h.session.counts.refused).toEqual({ [REQUEST]: 1 });
      expect(h.notices()).toEqual(['request-refused']);
      expect(resolved(h)).toEqual([]);
      // And later, for one it holds: the same reply, once.
      h.wire().ask(REQUEST, request(), 1);
      h.session.answer('n:1', null);
      h.session.answer('n:1', null);
      h.session.answer('n:1', [second]);
      await settle();
      expect(h.wire().replies).toEqual([{ id: 0, reply: NOT_FOUND }, { id: 1, reply: NOT_FOUND }]);
      expect(h.session.counts.refused).toEqual({ [REQUEST]: 2 });
      expect(h.session.counts.questions.unheld).toBe(2);
    });

    it('still declines the two approvals at once and refuses an elicitation and a permissions request, as before (C29, C48)', async () => {
      const h = setup();
      await h.running();
      expect(h.wire().ask('item/commandExecution/requestApproval', {}, 4)).toEqual({ result: { decision: 'decline' } });
      expect(h.wire().ask('item/fileChange/requestApproval', {}, 5)).toEqual({ result: { decision: 'decline' } });
      // An MCP server's own form or address: "method not found", from its handler now (decision 0018).
      expect(h.wire().ask('mcpServer/elicitation/request', {}, 6)).toEqual({ error: { code: -32601, message: 'Method not found' } });
      expect(h.wire().ask('item/permissions/requestApproval', {}, 7)).toBeUndefined();
      expect(h.wire().replies).toEqual([]);
      expect(h.notices()).toEqual(['request-refused']);
      // Codex's word that a declined approval is over names no question: counted, and nothing is said.
      resolve(h, 4);
      expect(resolved(h)).toEqual([]);
      expect(h.session.counts.questions.unheld).toBe(1);
      expect(h.session.counts.unmapped).toBe(0);
    });
  });

  describe('withdrawn, and let go with its owner (V5, V21, V25; C12, C27, C65)', () => {
    it('reads Codex’s word for an unanswered request while its turn runs as a withdrawal, and writes nothing for it', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request(), 0);
      resolve(h, 0);
      expect(resolved(h)).toEqual([{ type: 'question-resolved', requestId: 'n:0', reason: 'withdrawn' }]);
      h.session.answer('n:0', [second]);
      await settle();
      expect(h.wire().replies).toEqual([]);
      expect(h.session.counts.questions.unheld).toBe(1);
      // A word that is no frame of the kind is dropped, and counted.
      h.wire().notify('serverRequest/resolved', { threadId: THREAD });
      expect(h.session.counts.dropped.invalid).toBe(1);
    });

    it.each(['completed', 'interrupted', 'failed'] as const)('lets the turn’s own hold go at its `turn/completed`, %s, with no event and no reply: main sweeps at that end', async (status) => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request(), 0);
      if (status === 'interrupted') h.session.stop();
      h.completed(status);
      expect(resolved(h)).toEqual([]);
      expect(ended(h.events)).toHaveLength(1);
      // K2 (C27): at an interrupt Codex's word followed the turn's end, and then names nothing held.
      resolve(h, 0);
      expect(resolved(h)).toEqual([]);
      h.session.answer('n:0', [second]);
      await settle();
      expect(h.wire().replies).toEqual([]);
      expect(h.session.counts.questions.unheld).toBe(2);
    });

    it('lets it go at an end the adapter makes too: a turn whose end was lost', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request(), 0);
      h.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'end-lost' }]);
      expect(resolved(h)).toEqual([]);
      h.session.answer('n:0', [second]);
      await settle();
      expect(h.wire().replies).toEqual([]);
    });

    it('does not take a waiting thread for an idle one: K2’s status while the request is pending starts no lost-end clock', async () => {
      const h = setup();
      await h.running();
      h.wire().notify('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
      h.wire().ask(REQUEST, request(), 0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ended(h.events)).toEqual([]);
      expect(resolved(h)).toEqual([]);
    });

    const workerRequest = (): Record<string, unknown> => request({ threadId: WORKER, turnId: 'worker-turn-1' });
    const endWorker = (h: Setup): void => {
      h.wire().notify('turn/completed', { threadId: WORKER, turn: { id: 'worker-turn-1', status: 'completed' } });
      h.wire().notify('item/started', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: WORKER } });
    };

    it('places a worker’s request under the worker, with the turn that started it, and keeps it past that turn’s end: answered then, and confirmed', async () => {
      const h = setup();
      await h.running();
      h.openWorker();
      expect(h.wire().ask(REQUEST, workerRequest(), 0)).toBeNull();
      expect(raised(h)).toEqual([{ type: 'question-raised', turnId: 'turn-1', workerId: WORKER, requestId: 'n:0', sourceId: 'item-q', questions: [CARD], cut: false }]);
      h.completed();
      expect(ended(h.events)).toHaveLength(1);
      expect(resolved(h)).toEqual([]);
      h.session.answer('n:0', [second]);
      await settle();
      expect(h.wire().replies).toEqual([{ id: 0, reply: { result: sent.frame.result } }]);
      h.wire().notify('serverRequest/resolved', { threadId: WORKER, requestId: 0 });
      expect(resolved(h)).toEqual([{ type: 'question-resolved', requestId: 'n:0', reason: 'confirmed' }]);
    });

    it('places one a worker raises after its parent’s completion, with no turn current, and lets it go at the worker’s end', async () => {
      const h = setup();
      await h.running();
      h.openWorker();
      h.completed();
      expect(h.wire().ask(REQUEST, workerRequest(), 3)).toBeNull();
      expect(raised(h)).toEqual([expect.objectContaining({ turnId: 'turn-1', workerId: WORKER, requestId: 'n:3' })]);
      expect(h.session.counts.refused).toEqual({});
      // The session's own, with no turn current, is refused all the same.
      expect(h.wire().ask(REQUEST, request(), 4)).toEqual(NOT_FOUND);
      endWorker(h);
      expect(h.events.at(-1)).toEqual({ type: 'worker-ended', workerId: WORKER, outcome: 'completed' });
      // No event of the adapter's for it: main's sweep at the worker's end settles its card.
      expect(resolved(h)).toEqual([]);
      h.session.answer('n:3', [second]);
      await settle();
      expect(h.wire().replies).toEqual([]);
      // Its thread is no worker's any more: a request that names it is no one's.
      expect(h.wire().ask(REQUEST, workerRequest(), 5)).toEqual(NOT_FOUND);
    });

    it('lets a worker’s hold go when its worker is ended with the turn: a Stop, and the settle clock', async () => {
      const stopped = setup();
      await stopped.running();
      stopped.openWorker();
      stopped.wire().ask(REQUEST, workerRequest(), 0);
      stopped.session.stop();
      stopped.completed('interrupted');
      expect(stopped.types().slice(-2)).toEqual(['worker-ended', 'turn-ended']);
      stopped.session.answer('n:0', [second]);
      await settle();
      expect(stopped.wire().replies).toEqual([]);
      expect(resolved(stopped)).toEqual([]);

      const settled = setup();
      await settled.running();
      settled.openWorker();
      settled.wire().ask(REQUEST, workerRequest(), 0);
      settled.wire().notify('item/completed', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: WORKER } });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled.events.at(-1)).toEqual({ type: 'worker-ended', workerId: WORKER, outcome: 'completed' });
      settled.session.answer('n:0', [second]);
      await settle();
      expect(settled.wire().replies).toEqual([]);
    });
  });

  describe('a request that comes before the turn is named (C110)', () => {
    it('waits with the frames for the `turn/start` reply, and is placed, or refused through the connection, once the turn is named', async () => {
      const h = setup();
      await h.begin();
      h.wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
      expect(h.wire().ask(REQUEST, request(), 0)).toBeNull();
      expect(h.wire().ask(REQUEST, request({ turnId: 'some-other-turn' }), 1)).toBeNull();
      // Codex took the first back before the reply came: in the order it was sent.
      expect(h.wire().ask(REQUEST, request(), 2)).toBeNull();
      resolve(h, 2);
      expect(h.events).toEqual([]);
      expect(h.wire().replies).toEqual([]);
      h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
      await settle();
      expect(h.types()).toEqual(['turn-started', 'session-started', 'question-raised', 'notice', 'question-raised', 'question-resolved']);
      expect(raised(h).map((event) => event.requestId)).toEqual(['n:0', 'n:2']);
      expect(resolved(h)).toEqual([{ type: 'question-resolved', requestId: 'n:2', reason: 'withdrawn' }]);
      expect(h.wire().replies).toEqual([{ id: 1, reply: NOT_FOUND }]);
      expect(h.session.counts.refused).toEqual({ [REQUEST]: 1 });
    });
  });

  describe('a lost process, and a reply it did not take (V22, V23, V26, V31; C14, C66, C67, C70, C75)', () => {
    it('says `dropped` for every request it holds unanswered, the session’s own and a worker’s, before the ends it makes; an answered one is let go', async () => {
      const h = setup();
      await h.running();
      h.openWorker();
      h.wire().ask(REQUEST, request(), 0);
      h.wire().ask(REQUEST, request({ threadId: WORKER, turnId: 'worker-turn-1' }), 1);
      h.wire().ask(REQUEST, request({ itemId: 'item-r' }), 2);
      // Its write went, and Codex's word never came.
      h.session.answer('n:2', [second]);
      await settle();
      const before = h.events.length;
      h.wire().end();
      await settle(12);
      expect(h.events.slice(before).map((event) => (event.type === 'question-resolved' ? `${event.reason}:${event.requestId}` : event.type === 'notice' ? `notice:${event.kind}` : event.type))).toEqual(['dropped:n:0', 'dropped:n:1', 'activity-ended', 'worker-ended', 'notice:connection-lost', 'turn-ended']);
      expect(h.events.at(-1)).toMatchObject({ outcome: 'failed', reported: false, failure: 'connection-lost' });
      expect(resolved(h).every((event) => event.reason === 'dropped' && event.requestId !== 'n:2')).toBe(true);
      expect(h.wire().replies).toHaveLength(1);
      expect(h.closed()).toEqual({ ok: true });
      for (const event of h.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    });

    it('says it for a worker’s request held with no turn current, before the workers’ end and its notice', async () => {
      const h = setup();
      await h.running();
      h.openWorker();
      h.completed();
      h.wire().ask(REQUEST, request({ threadId: WORKER, turnId: 'worker-turn-1' }), 0);
      const before = h.events.length;
      h.wire().end();
      await settle();
      expect(h.events.slice(before).map((event) => event.type)).toEqual(['question-resolved', 'activity-ended', 'worker-ended', 'notice']);
      expect(resolved(h)).toEqual([{ type: 'question-resolved', requestId: 'n:0', reason: 'dropped' }]);
    });

    it('says nothing for a request it was closed with: main drops before it closes, and the hold goes with the turn', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request(), 0);
      await h.session.close();
      expect(resolved(h)).toEqual([]);
      expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    });

    it('says `dropped` and ends the process when the process refuses the reply while it lives: the turn then ends failed, with its notice, and nothing is sent again', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request(), 0);
      h.wire().refuseReplies = new ProcessFailure('output-limit');
      const before = h.events.length;
      h.session.answer('n:0', [second]);
      await settle(12);
      expect(h.events.slice(before)).toEqual([
        { type: 'question-resolved', requestId: 'n:0', reason: 'dropped' },
        { type: 'notice', kind: 'connection-lost', turnId: 'turn-1' },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' },
      ]);
      expect(h.wire().closes).toBe(1);
      expect(h.closed()).toEqual({ ok: true });
      expect(h.wire().replies).toEqual([]);
      expect(h.session.counts.questions.unwritten).toBe(1);
      // The hold is gone: a second answer writes nothing, and no second process was opened for it.
      h.session.answer('n:0', [second]);
      await settle();
      expect(resolved(h)).toHaveLength(1);
      expect(h.script.opened).toHaveLength(1);
    });

    it('ends the workers left after their turn when a worker’s reply is refused with no turn current', async () => {
      const h = setup();
      await h.running();
      h.openWorker();
      h.completed();
      h.wire().ask(REQUEST, request({ threadId: WORKER, turnId: 'worker-turn-1' }), 0);
      h.wire().refuseReplies = new ProcessFailure('output-limit');
      const before = h.events.length;
      h.session.answer('n:0', [second]);
      await settle(12);
      expect(h.events.slice(before).map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type))).toEqual(['question-resolved', 'activity-ended', 'worker-ended', 'notice:workers-lost']);
      expect(resolved(h)).toEqual([{ type: 'question-resolved', requestId: 'n:0', reason: 'dropped' }]);
      expect(h.wire().closes).toBe(1);
    });

    it('says `dropped` for an answer whose write is still queued when the process is stopped: by its own write, after the close’s own end', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request(), 0);
      h.wire().holdReplies = true;
      h.session.answer('n:0', [second]);
      await settle();
      expect(resolved(h)).toEqual([]);
      await h.session.close();
      await settle();
      expect(h.types().slice(-2)).toEqual(['turn-ended', 'question-resolved']);
      expect(resolved(h)).toEqual([{ type: 'question-resolved', requestId: 'n:0', reason: 'dropped' }]);
      expect(h.wire().replies).toEqual([]);
      expect(h.session.counts.questions.unwritten).toBe(1);
    });

    it('says nothing for an answer whose write went and that Codex never confirmed: the process’s end lets it go, and so does the turn’s', async () => {
      const lost = setup();
      await lost.running();
      lost.wire().ask(REQUEST, request(), 0);
      lost.session.answer('n:0', [second]);
      await settle();
      lost.wire().end();
      await settle(12);
      expect(resolved(lost)).toEqual([]);
      expect(ended(lost.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' }]);

      const ended_ = setup();
      await ended_.running();
      ended_.wire().ask(REQUEST, request(), 0);
      ended_.session.answer('n:0', [second]);
      await settle();
      ended_.completed();
      await ended_.session.close();
      expect(resolved(ended_)).toEqual([]);
    });

    it('says `dropped` for a reply written as the process ends, whatever has ended meanwhile, and counts an answer for a hold already gone', async () => {
      const h = setup();
      await h.running();
      h.wire().ask(REQUEST, request(), 0);
      h.wire().ask(REQUEST, request({ itemId: 'item-r' }), 1);
      // The process is gone, and the session has not heard of it yet: the write is rejected.
      h.wire().end();
      h.session.answer('n:0', [second]);
      await settle(12);
      // The unanswered one first, at the process's end; then the rejected write's own word, after the turn's end.
      expect(h.events.flatMap((event) => (event.type === 'question-resolved' ? [`${event.reason}:${event.requestId}`] : event.type === 'turn-ended' ? ['turn-ended'] : []))).toEqual(['dropped:n:1', 'turn-ended', 'dropped:n:0']);
      expect(h.session.counts.questions).toEqual({ repeated: 0, unheld: 0, unwritten: 1 });
      // And once the session knows: its holds are gone, an answer is counted, and nothing is written.
      h.session.answer('n:1', [second]);
      await settle();
      expect(resolved(h)).toHaveLength(2);
      expect(h.session.counts.questions.unheld).toBe(1);
      expect(h.wire().replies).toEqual([]);
    });
  });
});

// ── M22: the mode, and leave for an action ────────────────────────────────────────────────────
describe('what the session may do (M22; C4, C7, C8, C13, C21, C46, C64, C67–C71, C76, C84, C91)', () => {
  type Setup = ReturnType<typeof setup>;
  const NOT_FOUND = { error: { code: -32601, message: 'Method not found' } };
  const COMMAND = 'item/commandExecution/requestApproval';
  const FILE = 'item/fileChange/requestApproval';
  const QUESTION = 'item/tool/requestUserInput';
  /** A workspace sandbox as K6's and K4's start replies report it. */
  const WORKSPACE = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  const reported = (sandbox: unknown, approvalPolicy: unknown, approvalsReviewer: unknown = 'user'): Record<string, unknown> => ({ thread: { id: THREAD }, sandbox, approvalPolicy, approvalsReviewer, model: 'other-model' });
  const MODES = ['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk'] as const;
  /** What each mode names at a start and a resume, and what its own reply reports. */
  const NAMED: Record<(typeof MODES)[number], Record<string, string>> = {
    'read-only': { sandbox: 'read-only', approvalPolicy: 'never' },
    'ask-first': { sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
    'sandbox-ok': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
    'auto-reviewed': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
    berserk: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
  };
  const REPLIES: Record<(typeof MODES)[number], Record<string, unknown>> = {
    'read-only': reported({ type: 'readOnly', networkAccess: false }, 'never'),
    'ask-first': reported(WORKSPACE, 'untrusted'),
    'sandbox-ok': reported(WORKSPACE, 'on-request'),
    'auto-reviewed': reported(WORKSPACE, 'on-request', 'auto_review'),
    berserk: reported({ type: 'dangerFullAccess' }, 'never'),
  };
  const under = (mode: (typeof MODES)[number], reference: string | null = null, reply: Record<string, unknown> = REPLIES[mode]): Setup => setup(reference, true, mode, reply);
  const raised = (h: Setup) => h.events.flatMap((event) => (event.type === 'approval-raised' ? [event] : []));
  const resolved = (h: Setup) => h.events.flatMap((event) => (event.type === 'approval-resolved' || event.type === 'question-resolved' ? [`${event.type}:${event.reason}:${event.requestId}`] : []));
  const activityEnds = (h: Setup) => h.events.flatMap((event) => (event.type === 'activity-ended' ? [event] : []));

  interface Captured { readonly index: number; readonly dir: string; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: unknown } }
  const capture = (name: string): Captured[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures', `${name}.json`), 'utf8')) as { frames: Captured[] }).frames;
  /** K1's command request as it came, on this session's thread and turn. */
  const K1_COMMAND = capture('m22-codex-once').find((f) => f.dir === 'recv' && f.frame.method === COMMAND)?.frame.params as Record<string, unknown>;
  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...K1_COMMAND, threadId: THREAD, turnId: CLI_TURN, itemId: 'item-c', ...extra });
  const commandItem = (status: string, extra: Record<string, unknown> = {}) => ({ threadId: THREAD, turnId: CLI_TURN, item: { type: 'commandExecution', id: 'item-c', command: K1_COMMAND['command'], cwd: FOLDER, status, commandActions: K1_COMMAND['commandActions'], aggregatedOutput: null, exitCode: null, durationMs: null, ...extra } });
  /** K1's file change: the item that holds it, and the request that names the item and no file. */
  const K1_FILE = capture('m22-codex-file-session-same-main');
  const K1_FILE_REQUEST = K1_FILE.find((f) => f.dir === 'recv' && f.frame.method === FILE)?.frame.params as Record<string, unknown>;
  const K1_CHANGES = ((K1_FILE.find((f) => f.dir === 'recv' && f.frame.method === 'item/started' && (f.frame.params?.['item'] as { type?: string }).type === 'fileChange')?.frame.params?.['item']) as { changes: unknown[] }).changes;
  const fileItem = (status: string, itemId = 'item-f', threadId = THREAD, turnId = CLI_TURN, changes: unknown = K1_CHANGES) => ({ threadId, turnId, item: { type: 'fileChange', id: itemId, changes, status } });
  const fileRequest = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...K1_FILE_REQUEST, threadId: THREAD, turnId: CLI_TURN, itemId: 'item-f', ...extra });
  const COMMAND_VIEW = {
    kind: 'command', tool: 'commandExecution', summary: K1_COMMAND['command'], folder: '<scratch>', targets: [], outside: false, reason: null, authority: [{ kind: 'saved-rule', mode: null }],
    detail: { kind: 'command', command: K1_COMMAND['command'] }, choices: ['approve', 'deny'], grant: null, modeThatWouldStop: null, cut: false,
  };

  describe('the mode, named and held to (V2; C4, C7, C46, C64, C70)', () => {
    it.each(MODES)('names %s’s sandbox, policy and reviewer on the start, and what the reply reported on every turn', async (mode) => {
      const h = under(mode);
      await h.launch(turn(1, 'medium'));
      expect(h.wire().pending('thread/start').params).toEqual({ cwd: FOLDER, ...NAMED[mode], model: 'gpt-x', serviceTier: 'default' });
      await h.running(turn(1, 'medium'));
      const reply = REPLIES[mode];
      const again = { approvalPolicy: reply['approvalPolicy'], sandboxPolicy: reply['sandbox'], ...(NAMED[mode]['approvalsReviewer'] === undefined ? {} : { approvalsReviewer: reply['approvalsReviewer'] }) };
      expect(h.wire().pending('turn/start').params).toEqual({ threadId: THREAD, input: [{ type: 'text', text: 'Prompt 1', text_elements: [] }], model: 'gpt-x', effort: 'medium', serviceTier: 'default', clientUserMessageId: 'message-1', ...again });
      // The reply's own sandbox object, sent back as it came (K4).
      expect((h.wire().pending('turn/start').params as { sandboxPolicy: unknown }).sandboxPolicy).toBe(reply['sandbox']);
      // The next turn names the same, and nothing was started twice.
      h.completed();
      await h.running(turn(2), 'cli-turn-2');
      expect(h.wire().pending('turn/start').params).toMatchObject(again);
      expect(h.sent()).toEqual(['initialize', 'thread/start', 'turn/start', 'turn/start']);
    });

    it.each(MODES)('names %s’s on a resume too, in a fresh process, without the turns', async (mode) => {
      const h = under(mode, 'stored-thread');
      await h.launch();
      expect(h.wire().pending('thread/resume').params).toEqual({ threadId: 'stored-thread', cwd: FOLDER, ...NAMED[mode], serviceTier: 'default', excludeTurns: true });
    });

    it('names no reviewer for Read only and Berserk, at the start, the resume and the turn, though the reply reports one (C70)', async () => {
      for (const mode of ['read-only', 'berserk'] as const) {
        const h = under(mode);
        await h.running();
        expect(REPLIES[mode]['approvalsReviewer']).toBe('user');
        for (const method of ['thread/start', 'turn/start']) expect(h.wire().pending(method).params, `${mode} ${method}`).not.toHaveProperty('approvalsReviewer');
      }
    });

    it('says the mode is in force once its reply is as asked, before anything of the turn, and tells whoever keeps the account’s replies', async () => {
      const h = under('sandbox-ok');
      await h.launch();
      expect(h.inForce).toEqual([]);
      h.wire().pending('thread/start').resolve(REPLIES['sandbox-ok']);
      await settle();
      // Confirmed before the prompt is answered: `turn/start` is only now out.
      expect(h.inForce).toEqual([{ type: 'in-force', mode: 'sandbox-ok' }]);
      expect(AgentEventSchema.safeParse(h.inForce[0]).success).toBe(true);
      expect(h.events).toEqual([]);
      expect(h.checked).toEqual([{ mode: 'sandbox-ok', ok: true }]);
      // Once for the process: its later turns say nothing more of it.
      h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
      await settle();
      h.completed();
      await h.running(turn(2), 'cli-turn-2');
      expect(h.inForce).toHaveLength(1);
    });

    it.each([
      ['another policy under Ask first', 'ask-first', reported(WORKSPACE, 'on-request'), 'sandbox: workspaceWrite; approvalPolicy: on-request; approvalsReviewer: user'],
      ['Codex’s own reviewer under Sandbox ok', 'sandbox-ok', reported(WORKSPACE, 'on-request', 'auto_review'), 'sandbox: workspaceWrite; approvalPolicy: on-request; approvalsReviewer: auto_review'],
      ['the user under Auto reviewed', 'auto-reviewed', reported(WORKSPACE, 'on-request', 'user'), 'sandbox: workspaceWrite; approvalPolicy: on-request; approvalsReviewer: user'],
      ['read-only under Sandbox ok, as an account with no sandbox reports it', 'sandbox-ok', reported({ type: 'readOnly', networkAccess: false }, 'on-request'), 'sandbox: readOnly; approvalPolicy: on-request; approvalsReviewer: user'],
      ['a workspace sandbox under Berserk', 'berserk', reported(WORKSPACE, 'never'), 'sandbox: workspaceWrite; approvalPolicy: never; approvalsReviewer: user'],
      ['full access under Ask first', 'ask-first', reported({ type: 'dangerFullAccess' }, 'untrusted'), 'sandbox: dangerFullAccess; approvalPolicy: untrusted; approvalsReviewer: user'],
    ] as const)('sends no prompt when the reply reports %s: the turn fails as a policy mismatch, with what was reported, and the process is closed (C7, C46)', async (_name, mode, reply, detail) => {
      const h = under(mode, null, reply);
      await h.begin();
      expect(h.sent()).toEqual(['initialize', 'thread/start']);
      expect(h.events).toEqual([{ type: 'notice', kind: 'policy-mismatch', turnId: 'turn-1', detail }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'policy-mismatch' }]);
      for (const event of h.events) expect(AgentEventSchema.safeParse(event).success).toBe(true);
      // Nothing is in force, and the account's keeper is told of the reply all the same.
      expect(h.inForce).toEqual([]);
      expect(h.checked).toEqual([{ mode, ok: false }]);
      expect(h.wire().closes).toBe(1);
    });

    it('fails a resume the same way, with its mismatch and no step', async () => {
      const h = under('auto-reviewed', 'stored-thread', reported(WORKSPACE, 'on-request', 'user'));
      await h.begin();
      expect(h.sent()).toEqual(['initialize', 'thread/resume']);
      expect(h.events[0]).toEqual({ type: 'notice', kind: 'policy-mismatch', turnId: 'turn-1', detail: 'sandbox: workspaceWrite; approvalPolicy: on-request; approvalsReviewer: user' });
      expect(h.events[1]).toMatchObject({ type: 'turn-ended', failure: 'policy-mismatch', reported: false });
    });

    it('keeps Read only’s own word for a start that was not restricted, with no detail', async () => {
      const h = under('read-only', null, reported(WORKSPACE, 'never'));
      await h.begin();
      expect(h.events).toEqual([{ type: 'notice', kind: 'not-read-only', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'not-read-only' }]);
    });

    it('takes read-only for Ask first’s workspace sandbox, and names that sandbox on the turn: the session is unconfined (C4)', async () => {
      const readOnly = { type: 'readOnly', networkAccess: false };
      const h = under('ask-first', null, reported(readOnly, 'untrusted'));
      await h.running();
      expect(h.inForce).toEqual([{ type: 'in-force', mode: 'ask-first' }]);
      expect(h.wire().pending('turn/start').params).toMatchObject({ approvalPolicy: 'untrusted', sandboxPolicy: readOnly, approvalsReviewer: 'user' });
      expect(h.notices()).toEqual([]);
    });

    it('runs a start that names no mode, or one that is none of Codex’s, as Read only, and says that is what is in force', async () => {
      for (const mode of [null, 'edits-ok']) {
        const h = setup(null, true, mode);
        await h.running();
        expect(h.wire().pending('thread/start').params).toEqual({ cwd: FOLDER, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-x', serviceTier: 'default' });
        expect(h.inForce).toEqual([{ type: 'in-force', mode: 'read-only' }]);
        expect(h.wire().ask(COMMAND, command())).toEqual({ result: { decision: 'decline' } });
      }
    });

    it('leaves an aside’s fork and its turns as they were, whatever the session’s mode: read-only, asking no one, and naming no policy (C84)', async () => {
      const h = under('sandbox-ok');
      h.session.ask({ asideId: 'aside-1', turnId: 'aside-turn-1', text: 'What does this do?', messageId: 'aside-message-1', history: [], throughTurn: null, effort: 'low', speed: null });
      await settle();
      h.wire().pending('initialize').resolve({});
      await settle();
      // The session's own thread is opened under its mode, and the mode is in force for the process.
      expect(h.wire().pending('thread/start').params).toMatchObject(NAMED['sandbox-ok']);
      h.wire().pending('thread/start').resolve(REPLIES['sandbox-ok']);
      await settle();
      expect(h.inForce).toEqual([{ type: 'in-force', mode: 'sandbox-ok' }]);
      const fork = h.wire().pending('thread/fork').params as Record<string, unknown>;
      expect(Object.keys(fork).sort()).toEqual(['approvalPolicy', 'cwd', 'developerInstructions', 'ephemeral', 'excludeTurns', 'model', 'sandbox', 'serviceTier', 'threadId']);
      expect(fork).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
      h.wire().pending('thread/fork').resolve({ thread: { id: 'side-1' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', approvalsReviewer: 'user' });
      await settle();
      expect(h.wire().pending('turn/start').params).toEqual({ threadId: 'side-1', input: [{ type: 'text', text: 'What does this do?', text_elements: [] }], model: 'gpt-x', effort: 'low', serviceTier: 'default', clientUserMessageId: 'aside-message-1' });
      // A side thread asks for nothing a card could grant: a request that names it is no one's.
      h.wire().pending('turn/start').resolve({ turn: { id: 'side-turn-1' } });
      await settle();
      expect(h.wire().ask(COMMAND, command({ threadId: 'side-1', turnId: 'side-turn-1' }))).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
    });

    // Decision 0018: an aside follows the chat's speed tier, on its fork and on its turns.
    it('names the chat’s speed tier on an aside’s fork and on its turn', async () => {
      const h = under('sandbox-ok');
      h.session.ask({ asideId: 'aside-1', turnId: 'aside-turn-1', text: 'What does this do?', messageId: 'aside-message-1', history: [], throughTurn: null, effort: 'low', speed: 'priority' });
      await settle();
      h.wire().pending('initialize').resolve({});
      await settle();
      h.wire().pending('thread/start').resolve(REPLIES['sandbox-ok']);
      await settle();
      expect(h.wire().pending('thread/fork').params).toMatchObject({ serviceTier: 'priority' });
      h.wire().pending('thread/fork').resolve({ thread: { id: 'side-1' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', approvalsReviewer: 'user' });
      await settle();
      expect(h.wire().pending('turn/start').params).toMatchObject({ threadId: 'side-1', effort: 'low', serviceTier: 'priority' });
    });

    it('sends a fork’s question nothing when its reply is the session’s workspace sandbox and not read-only', async () => {
      const h = under('sandbox-ok');
      h.session.ask({ asideId: 'aside-1', turnId: 'aside-turn-1', text: 'What does this do?', messageId: 'aside-message-1', history: [], throughTurn: null, effort: 'low', speed: null });
      await settle();
      h.wire().pending('initialize').resolve({});
      await settle();
      h.wire().pending('thread/start').resolve(REPLIES['sandbox-ok']);
      await settle();
      h.wire().pending('thread/fork').resolve(REPLIES['sandbox-ok']);
      await settle();
      expect(h.sent()).toEqual(['initialize', 'thread/start', 'thread/fork']);
      expect(h.events).toEqual([{ type: 'notice', kind: 'not-read-only', turnId: 'aside-turn-1', asideId: 'aside-1' }, { type: 'turn-ended', turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'failed', reported: false, failure: 'not-read-only' }]);
    });
  });

  describe('a request for leave, held and decided (V3, V27; C8, C9, C13, C21, C68, C69, C76)', () => {
    it('holds K1’s command request under the session’s turn: nothing is written, and it is told whole, as a card shows it', async () => {
      const h = under('ask-first');
      await h.running();
      expect(h.wire().ask(COMMAND, command(), 0)).toBeNull();
      expect(raised(h)).toEqual([{ type: 'approval-raised', turnId: 'turn-1', requestId: 'n:0', sourceId: 'item-c', request: COMMAND_VIEW }]);
      expect(AgentEventSchema.safeParse(raised(h)[0]).success).toBe(true);
      expect(h.wire().replies).toEqual([]);
      expect(h.notices()).toEqual([]);
      expect(h.session.counts.refused).toEqual({});
    });

    it('writes the user’s Approve as `accept`, frame for frame as K1 sent it, says the write went, and takes Codex’s word as its confirmation', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().ask(COMMAND, command(), 0);
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(true);
      expect(h.wire().replies).toEqual([{ id: 0, reply: { result: { decision: 'accept' } } }]);
      expect(capture('m22-codex-once').find((f) => f.dir === 'send' && f.frame.method === undefined && f.frame.id === 0)?.frame.result).toEqual({ decision: 'accept' });
      expect(resolved(h)).toEqual([]);
      h.wire().notify('serverRequest/resolved', { threadId: THREAD, requestId: 0 });
      expect(resolved(h)).toEqual(['approval-resolved:confirmed:n:0']);
      // Decided once: a second decision names nothing held, and nothing more is written.
      await expect(h.session.decide('n:0', 'deny')).resolves.toBe(false);
      expect(h.wire().replies).toHaveLength(1);
      expect(h.session.counts.approvals).toEqual({ repeated: 0, unheld: 1, unwritten: 0 });
    });

    it('writes the user’s Deny as `decline`, and the item’s end, declined, then names the user (C13, C76)', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', commandItem('inProgress'));
      h.wire().ask(COMMAND, command(), 1);
      await expect(h.session.decide('n:1', 'deny')).resolves.toBe(true);
      expect(h.wire().replies).toEqual([{ id: 1, reply: { result: { decision: 'decline' } } }]);
      h.wire().notify('serverRequest/resolved', { threadId: THREAD, requestId: 1 });
      // K1: the item ended `declined`, as it started but for its status.
      h.wire().notify('item/completed', commandItem('declined'));
      expect(activityEnds(h)).toEqual([{ type: 'activity-ended', turnId: 'turn-1', itemId: 'item-c', status: 'declined', declinedBy: 'user' }]);
      expect(AgentEventSchema.safeParse(activityEnds(h)[0]).success).toBe(true);
      expect(resolved(h)).toEqual(['approval-resolved:confirmed:n:1']);
      // The turn goes on to its own end: a decline is no failure of it.
      h.completed();
      expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
    });

    it('ends an approved action by Codex’s own status, and a declined one nobody here denied as declined with no one named', async () => {
      const approved = under('ask-first');
      await approved.running();
      approved.wire().notify('item/started', commandItem('inProgress'));
      approved.wire().ask(COMMAND, command(), 0);
      await approved.session.decide('n:0', 'approve');
      approved.wire().notify('item/completed', commandItem('completed', { exitCode: 1 }));
      expect(activityEnds(approved)).toMatchObject([{ status: 'failed', exitCode: 1 }]);
      expect(activityEnds(approved)[0]).not.toHaveProperty('declinedBy');

      // Under Read only fat-g declines every request itself: the item is declined, and not by the user.
      const reading = under('read-only');
      await reading.running();
      reading.wire().notify('item/started', commandItem('inProgress'));
      expect(reading.wire().ask(COMMAND, command(), 0)).toEqual({ result: { decision: 'decline' } });
      reading.wire().notify('item/completed', commandItem('declined'));
      expect(activityEnds(reading)).toEqual([{ type: 'activity-ended', turnId: 'turn-1', itemId: 'item-c', status: 'declined' }]);
      expect(raised(reading)).toEqual([]);
    });

    it('shows a file change from the item it kept, whole, and writes Approve for this session as `acceptForSession` (C9, C21, C69)', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', fileItem('inProgress'));
      expect(h.wire().ask(FILE, fileRequest(), 0)).toBeNull();
      expect(raised(h)).toEqual([{
        type: 'approval-raised', turnId: 'turn-1', requestId: 'n:0', sourceId: 'item-f',
        request: {
          kind: 'file-change', tool: 'fileChange', summary: 'k1-same.txt', folder: null, targets: ['<scratch>\\k1-same.txt'], outside: false, reason: null, authority: [],
          detail: { kind: 'changes', changes: [{ path: '<scratch>\\k1-same.txt', kind: 'add', text: 'alpha\n', replace: null, all: null }] },
          choices: ['approve', 'approve-session', 'deny'], grant: { covers: '<scratch>\\k1-same.txt' }, modeThatWouldStop: null, cut: false,
        },
      }]);
      expect(AgentEventSchema.safeParse(raised(h)[0]).success).toBe(true);
      await expect(h.session.decide('n:0', 'approve-session')).resolves.toBe(true);
      // K1's own reply, and nothing beside the decision: no root, no rule, no destination.
      expect(h.wire().replies).toEqual([{ id: 0, reply: { result: { decision: 'acceptForSession' } } }]);
      expect(K1_FILE.find((f) => f.dir === 'send' && f.frame.method === undefined && f.frame.id === 0)?.frame.result).toEqual({ decision: 'acceptForSession' });
    });

    it('keeps a change uncut for its card, where the activity’s own copy is cut (C48)', async () => {
      const h = under('ask-first');
      await h.running();
      const big = 'd'.repeat(120_000);
      h.wire().notify('item/started', fileItem('inProgress', 'item-f', THREAD, CLI_TURN, [{ path: 'big.txt', kind: { type: 'add' }, diff: big }]));
      h.wire().ask(FILE, fileRequest(), 0);
      const [event] = raised(h);
      expect(event?.request.detail).toEqual({ kind: 'changes', changes: [{ path: 'big.txt', kind: 'add', text: big, replace: null, all: null }] });
      const started = h.events.find((item) => item.type === 'activity-started');
      expect(started?.type === 'activity-started' && started.changes?.[0]?.text?.length).toBe(20_000);
    });

    it('refuses a file change whose item it does not hold: never started here, another thread’s, or already ended (C9)', async () => {
      const h = under('ask-first');
      await h.running();
      expect(h.wire().ask(FILE, fileRequest({ itemId: 'never-started' }), 0)).toEqual(NOT_FOUND);
      // Kept by its thread too: an item of a worker's is not the session's own.
      h.wire().notify('item/started', fileItem('inProgress', 'item-w', 'some-other-thread'));
      expect(h.wire().ask(FILE, fileRequest({ itemId: 'item-w' }), 1)).toEqual(NOT_FOUND);
      h.wire().notify('item/started', fileItem('inProgress'));
      h.wire().notify('item/completed', fileItem('completed'));
      expect(h.wire().ask(FILE, fileRequest(), 2)).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
      expect(h.session.counts.refused).toEqual({ [FILE]: 3 });
      // Said once a turn, as every refusal that names no size is.
      expect(h.events.filter((event) => event.type === 'notice')).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
    });

    it('lets go of a turn’s kept changes at its end: a request of the next turn cannot name them', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', fileItem('inProgress'));
      h.completed();
      await h.running(turn(2), 'cli-turn-2');
      expect(h.wire().ask(FILE, fileRequest({ turnId: 'cli-turn-2' }), 0)).toEqual(NOT_FOUND);
    });

    it('refuses a request past a bound on the wire, with a notice that names the bound and the size each time; nothing is shown cut (C9, C48)', async () => {
      const h = under('ask-first');
      await h.running();
      expect(h.wire().ask(COMMAND, command({ command: 'c'.repeat(65_537) }), 0)).toEqual(NOT_FOUND);
      h.wire().notify('item/started', fileItem('inProgress', 'item-f', THREAD, CLI_TURN, Array.from({ length: 33 }, (_, n) => ({ path: `f${String(n)}.txt`, kind: { type: 'add' }, diff: 'x' }))));
      expect(h.wire().ask(FILE, fileRequest(), 1)).toEqual(NOT_FOUND);
      h.wire().notify('item/started', fileItem('inProgress', 'item-g', THREAD, CLI_TURN, [{ path: 'huge.txt', kind: { type: 'add' }, diff: 'x'.repeat(1_048_577) }]));
      expect(h.wire().ask(FILE, fileRequest({ itemId: 'item-g' }), 2)).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
      expect(h.events.filter((event) => event.type === 'notice')).toEqual([
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'detail', size: 65_537 },
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'targets', size: 33 },
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'detail', size: 1_048_577 },
      ]);
      for (const event of h.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
      // Counted by method, and nothing of the command or the change is in a log.
      expect(h.session.counts.refused).toEqual({ [COMMAND]: 1, [FILE]: 2 });
      expect(JSON.stringify(h.script.diagnostics)).not.toMatch(/ccccc|huge\.txt/);
    });

    it('refuses a request it cannot place — no id, no command, another turn’s, a thread that is no one’s — as "method not found", counted, with the notice', async () => {
      const h = under('ask-first');
      await h.running();
      expect(h.wire().ask(COMMAND, command(), null)).toEqual(NOT_FOUND);
      expect(h.wire().ask(COMMAND, command({ command: null }), 0)).toEqual(NOT_FOUND);
      expect(h.wire().ask(COMMAND, command({ turnId: 'some-other-turn' }), 1)).toEqual(NOT_FOUND);
      expect(h.wire().ask(COMMAND, command({ threadId: 'some-other-thread' }), 2)).toEqual(NOT_FOUND);
      expect(h.wire().ask(COMMAND, {}, 3)).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
      expect(h.session.counts.refused).toEqual({ [COMMAND]: 5 });
      expect(h.notices()).toEqual(['request-refused']);
    });

    it('refuses a decision main cannot place, and a choice the request’s view never listed, with the error reply: the session’s grant is never written where it was not offered (C69, C88)', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().ask(COMMAND, command(), 0);
      h.wire().ask(COMMAND, command({ itemId: 'item-d' }), 1);
      // The refusal's write went: that is what the promise says.
      await expect(h.session.decide('n:0', null)).resolves.toBe(true);
      await expect(h.session.decide('n:1', 'approve-session')).resolves.toBe(true);
      expect(h.wire().replies).toEqual([{ id: 0, reply: NOT_FOUND }, { id: 1, reply: NOT_FOUND }]);
      expect(h.session.counts.refused).toEqual({ [COMMAND]: 2 });
      expect(h.notices()).toEqual(['request-refused']);
      expect(resolved(h)).toEqual([]);
      // Both holds are gone.
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(false);
    });

    it('takes a decision for a request for leave alone, and an answer for a question alone', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().ask(COMMAND, command(), 0);
      const K2 = capture('m21-codex-plan').find((f) => f.dir === 'recv' && f.frame.method === QUESTION)?.frame.params as Record<string, unknown>;
      h.wire().ask(QUESTION, { ...K2, threadId: THREAD, turnId: CLI_TURN, itemId: 'item-q' }, 1);
      h.session.answer('n:0', [{ options: [0], text: null }]);
      await expect(h.session.decide('n:1', 'approve')).resolves.toBe(false);
      await expect(h.session.decide('n:9', 'approve')).resolves.toBe(false);
      await settle();
      expect(h.wire().replies).toEqual([]);
      expect(h.session.counts.questions.unheld).toBe(1);
      expect(h.session.counts.approvals.unheld).toBe(2);
    });

    it('holds `0` and `"0"` apart: two requests, each answered by the id it came with (C10)', async () => {
      const h = under('ask-first');
      await h.running();
      expect(h.wire().ask(COMMAND, command(), 0)).toBeNull();
      expect(h.wire().ask(COMMAND, command({ itemId: 'item-d', command: 'echo other' }), '0')).toBeNull();
      expect(raised(h).map((event) => [event.requestId, event.sourceId])).toEqual([['n:0', 'item-c'], ['s:0', 'item-d']]);
      await h.session.decide('s:0', 'deny');
      await h.session.decide('n:0', 'approve');
      expect(h.wire().replies).toEqual([{ id: '0', reply: { result: { decision: 'decline' } } }, { id: 0, reply: { result: { decision: 'accept' } } }]);
      // Codex's word for each names its own.
      h.wire().notify('serverRequest/resolved', { threadId: THREAD, requestId: '0' });
      expect(resolved(h)).toEqual(['approval-resolved:confirmed:s:0']);
    });

    it('holds a request that arrives under Berserk too: a request that comes is a card, whatever the mode expects', async () => {
      const h = under('berserk');
      await h.running();
      expect(h.wire().ask(COMMAND, command(), 0)).toBeNull();
      expect(raised(h)).toHaveLength(1);
    });

    it('holds a worker’s request under the worker, whatever the session’s turn, and lets it go with the worker', async () => {
      const h = under('ask-first');
      await h.running();
      h.openWorker();
      // K1: a worker's request names the worker's own thread and turn.
      expect(h.wire().ask(COMMAND, command({ threadId: WORKER, turnId: 'worker-turn-1' }), 0)).toBeNull();
      expect(raised(h)).toEqual([{ type: 'approval-raised', turnId: 'turn-1', workerId: WORKER, requestId: 'n:0', sourceId: 'item-c', request: COMMAND_VIEW }]);
      // The session's turn ends, and the worker goes on: its request stays held.
      h.completed();
      h.wire().ask(COMMAND, command({ threadId: WORKER, turnId: 'worker-turn-1', itemId: 'item-e' }), 1);
      expect(raised(h)).toHaveLength(2);
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(true);
      // The worker's end takes what it still asked, with no event: main sweeps at that end.
      h.session.stop();
      await expect(h.session.decide('n:1', 'approve')).resolves.toBe(false);
      expect(resolved(h)).toEqual([]);
    });

    it('holds a request that comes while `turn/start` waits with the frames, in order, and places it once the turn is named (C110)', async () => {
      const h = under('ask-first');
      await h.begin();
      // The change's item, then the request that names it: both before the turn has a name.
      h.wire().notify('item/started', fileItem('inProgress'));
      expect(h.wire().ask(FILE, fileRequest(), 0)).toBeNull();
      expect(h.wire().ask(COMMAND, command({ turnId: 'some-other-turn' }), 1)).toBeNull();
      expect(raised(h)).toEqual([]);
      h.wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } });
      await settle();
      expect(raised(h).map((event) => [event.requestId, event.request.kind])).toEqual([['n:0', 'file-change']]);
      // The one that is another turn's is refused late, as any is.
      expect(h.wire().replies).toEqual([{ id: 1, reply: NOT_FOUND }]);
      expect(h.session.counts.refused).toEqual({ [COMMAND]: 1 });
    });

    it('says `withdrawn` where Codex takes an undecided request back, and nothing where its owner ends first', async () => {
      const taken = under('ask-first');
      await taken.running();
      taken.wire().ask(COMMAND, command(), 0);
      taken.wire().notify('serverRequest/resolved', { threadId: THREAD, requestId: 0 });
      expect(resolved(taken)).toEqual(['approval-resolved:withdrawn:n:0']);
      await expect(taken.session.decide('n:0', 'approve')).resolves.toBe(false);
      expect(taken.wire().replies).toEqual([]);

      // K1: a Stop with a request pending — the turn ends interrupted, and Codex's word comes after it.
      const stopped = under('ask-first');
      await stopped.running();
      stopped.wire().ask(COMMAND, command(), 0);
      stopped.session.stop();
      stopped.completed('interrupted');
      stopped.wire().notify('serverRequest/resolved', { threadId: THREAD, requestId: 0 });
      expect(resolved(stopped)).toEqual([]);
      expect(ended(stopped.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
      await expect(stopped.session.decide('n:0', 'approve')).resolves.toBe(false);
      expect(stopped.wire().replies).toEqual([]);
    });

    it('says `dropped` for what was undecided when the process ended, before any end made here, and nothing for what was decided', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().ask(COMMAND, command(), 0);
      h.wire().ask(COMMAND, command({ itemId: 'item-d' }), 1);
      await h.session.decide('n:0', 'approve');
      h.wire().end();
      await settle();
      expect(h.events.flatMap((event) => (event.type === 'approval-resolved' ? [`${event.reason}:${event.requestId}`] : event.type === 'turn-ended' ? ['turn-ended'] : []))).toEqual(['dropped:n:1', 'turn-ended']);
      await expect(h.session.decide('n:1', 'approve')).resolves.toBe(false);
    });

    it('says `dropped` for leave still undecided when the session is closed, before the end the close makes: a loss never reads as a withdrawal (C11, C12)', async () => {
      const h = under('ask-first');
      await h.running();
      h.openWorker();
      h.wire().ask(COMMAND, command(), 0);
      h.wire().ask(COMMAND, command({ itemId: 'item-d' }), 1);
      h.wire().ask(COMMAND, command({ threadId: WORKER, turnId: 'worker-turn-1', itemId: 'item-w' }), 2);
      await h.session.decide('n:1', 'approve');
      const before = h.events.length;
      await expect(h.session.close()).resolves.toEqual({ ok: true });
      // The session's own and the worker's, each once; the decided one is let go with no event.
      const told = h.events.slice(before).flatMap((event) => (event.type === 'approval-resolved' ? [`${event.reason}:${event.requestId}`] : event.type === 'turn-ended' ? [`turn-ended:${String(event.reported)}`] : []));
      expect(told).toEqual(['dropped:n:0', 'dropped:n:2', 'turn-ended:false']);
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(false);
      expect(h.wire().replies).toEqual([{ id: 1, reply: { result: { decision: 'accept' } } }]);
    });

    it('says the write did not go where the process refuses it: `dropped`, false, and the process is ended (C12, C92)', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().ask(COMMAND, command(), 0);
      h.wire().refuseReplies = new ProcessFailure('output-limit');
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(false);
      expect(h.wire().replies).toEqual([]);
      expect(resolved(h)).toEqual(['approval-resolved:dropped:n:0']);
      expect(h.session.counts.approvals.unwritten).toBe(1);
      await settle();
      expect(h.wire().closes).toBe(1);
      // The refusal main asks for is told the same way.
      const refusal = under('ask-first');
      await refusal.running();
      refusal.wire().ask(COMMAND, command(), 0);
      refusal.wire().refuseReplies = new ProcessFailure('transport-closed');
      await expect(refusal.session.decide('n:0', null)).resolves.toBe(false);
      expect(resolved(refusal)).toEqual(['approval-resolved:dropped:n:0']);
    });
  });

  // Decision 0018: Codex's leave to run an MCP tool, an elicitation that names its server and the
  // call's arguments and no item, placed on the call the session holds (spikes/codex-mcp).
  describe('leave to run an MCP tool (decision 0018)', () => {
    const MCP = 'mcpServer/elicitation/request';
    /** What K1 sent for a capture's `nth` request: its result, or its error. */
    const reply = (name: string, nth = 0): unknown => {
      const frames = capture(name);
      const asked = frames.filter((f) => f.dir === 'recv' && f.frame.method === MCP)[nth];
      const sent: { readonly result?: unknown; readonly error?: unknown } | undefined = frames.find((f) => f.dir === 'send' && asked !== undefined && f.index > asked.index && f.frame.method === undefined && f.frame.id === asked.frame.id)?.frame;
      return sent?.result ?? sent?.error;
    };
    /** K1's first request as it came, on this session's thread and turn: it names the server and the arguments. */
    const K1_MCP = capture('codex-mcp-approval-once').find((f) => f.dir === 'recv' && f.frame.method === MCP)?.frame.params as Record<string, unknown>;
    const SERVER = K1_MCP['serverName'] as string;
    const mcpRequest = (args: unknown = { label: 'first' }, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...K1_MCP, threadId: THREAD, turnId: CLI_TURN, _meta: { ...(K1_MCP['_meta'] as Record<string, unknown>), tool_params: args }, ...extra });
    const mcpItem = (status: string, itemId = 'item-m', tool = 'stamp', args: unknown = { label: 'first' }, extra: Record<string, unknown> = {}) => ({ threadId: THREAD, turnId: CLI_TURN, item: { type: 'mcpToolCall', id: itemId, server: SERVER, tool, status, arguments: args, result: null, error: null, durationMs: null, ...extra } });
    const MCP_VIEW = {
      kind: 'tool', tool: 'mcpToolCall', summary: `${SERVER}: stamp`, folder: null, targets: [], outside: false, reason: null, authority: [{ kind: 'saved-rule', mode: null }],
      detail: { kind: 'input', text: JSON.stringify({ label: 'first' }, null, 2) }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: `${SERVER}: stamp` }, modeThatWouldStop: null, cut: false,
    };

    it('holds K1’s request on the call it asks for: nothing is written, and the card shows the server, the tool and the arguments whole', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress'));
      expect(h.wire().ask(MCP, mcpRequest(), 0)).toBeNull();
      expect(raised(h)).toEqual([{ type: 'approval-raised', turnId: 'turn-1', requestId: 'n:0', sourceId: 'item-m', request: MCP_VIEW }]);
      expect(AgentEventSchema.safeParse(raised(h)[0]).success).toBe(true);
      expect(h.wire().replies).toEqual([]);
      expect(h.notices()).toEqual([]);
      expect(h.session.counts.refused).toEqual({});
    });

    it.each([
      ['approve', 'codex-mcp-approval-once', { action: 'accept', content: null, _meta: null }],
      ['approve-session', 'codex-mcp-approval-session', { action: 'accept', content: null, _meta: { persist: 'session' } }],
      ['deny', 'codex-mcp-approval-deny', { action: 'decline', content: null, _meta: null }],
    ] as const)('writes %s as the elicitation’s answer, frame for frame as K1 sent it, and never `always`', async (choice, name, written) => {
      const h = under('sandbox-ok');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress'));
      h.wire().ask(MCP, mcpRequest(), 0);
      await expect(h.session.decide('n:0', choice)).resolves.toBe(true);
      expect(h.wire().replies).toEqual([{ id: 0, reply: { result: written } }]);
      expect(reply(name)).toEqual(written);
      expect(JSON.stringify(h.wire().replies)).not.toContain('always');
      h.wire().notify('serverRequest/resolved', { threadId: THREAD, requestId: 0 });
      expect(resolved(h)).toEqual(['approval-resolved:confirmed:n:0']);
    });

    it('ends a call the user denied as declined by the user, though Codex ends it failed in its own words', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress'));
      h.wire().ask(MCP, mcpRequest(), 0);
      await h.session.decide('n:0', 'deny');
      // K1's `deny`: the item ended `failed`, with Codex's words, and nothing ran.
      h.wire().notify('item/completed', mcpItem('failed', 'item-m', 'stamp', { label: 'first' }, { error: { message: 'user rejected MCP tool call' } }));
      expect(activityEnds(h)).toMatchObject([{ type: 'activity-ended', itemId: 'item-m', status: 'declined', declinedBy: 'user', output: 'user rejected MCP tool call' }]);
      expect(AgentEventSchema.safeParse(activityEnds(h)[0]).success).toBe(true);
      // A call that failed with no Deny of the user's is failed, as before.
      const other = under('ask-first');
      await other.running();
      other.wire().notify('item/started', mcpItem('inProgress'));
      other.wire().ask(MCP, mcpRequest(), 0);
      await other.session.decide('n:0', 'approve');
      other.wire().notify('item/completed', mcpItem('failed', 'item-m', 'stamp', { label: 'first' }, { error: { message: 'tool error' } }));
      expect(activityEnds(other)).toMatchObject([{ status: 'failed' }]);
      expect(activityEnds(other)[0]).not.toHaveProperty('declinedBy');
    });

    it('offers no session grant where Codex offers none, and says `always` only where it offers it', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress'));
      h.wire().ask(MCP, mcpRequest({ label: 'first' }, { _meta: { codex_approval_kind: 'mcp_tool_call', persist: [], tool_params: { label: 'first' } } }), 0);
      expect(raised(h)[0]?.request).toMatchObject({ choices: ['approve', 'deny'], grant: null, authority: [] });
    });

    it('places a request on the oldest alike call not yet asked for, and refuses one it cannot place: no call, or alike calls of different tools', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress', 'item-1'));
      h.wire().notify('item/started', mcpItem('inProgress', 'item-2'));
      h.wire().ask(MCP, mcpRequest(), 0);
      h.wire().ask(MCP, mcpRequest(), 1);
      expect(raised(h).map((event) => event.sourceId)).toEqual(['item-1', 'item-2']);

      const none = under('ask-first');
      await none.running();
      // A call that ended is let go: a request for it finds nothing.
      none.wire().notify('item/started', mcpItem('inProgress'));
      none.wire().notify('item/completed', mcpItem('completed'));
      expect(none.wire().ask(MCP, mcpRequest(), 0)).toEqual(NOT_FOUND);
      expect(none.wire().ask(MCP, mcpRequest({ label: 'other' }), 1)).toEqual(NOT_FOUND);
      expect(none.session.counts.refused).toEqual({ [MCP]: 2 });
      expect(none.notices()).toEqual(['request-refused']);

      const two = under('ask-first');
      await two.running();
      two.wire().notify('item/started', mcpItem('inProgress', 'item-1', 'stamp'));
      two.wire().notify('item/started', mcpItem('inProgress', 'item-2', 'stamp_other'));
      expect(two.wire().ask(MCP, mcpRequest(), 0)).toEqual(NOT_FOUND);
      expect(raised(two)).toEqual([]);
    });

    it('refuses one that names no turn, or another thread’s, as it refuses every request it cannot place', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress'));
      expect(h.wire().ask(MCP, mcpRequest({ label: 'first' }, { turnId: null }), 0)).toEqual(NOT_FOUND);
      expect(h.wire().ask(MCP, mcpRequest({ label: 'first' }, { threadId: 'thread-other' }), 1)).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
    });

    it('refuses further MCP approvals for a thread whose open calls exceed the bound, without matching the wrong tool', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress', 'delete-call', 'delete_all'));
      for (let i = 0; i < MAX_HELD_CALLS; i++) h.wire().notify('item/started', mcpItem('inProgress', `read-${String(i)}`, 'read'));
      // A request names no tool field: losing delete-call must not make this look like read.
      expect(h.wire().ask(MCP, mcpRequest(), 0)).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
      await expect(h.session.decide('n:0', 'approve-session')).resolves.toBe(false);
      expect(h.wire().replies).toEqual([]);
      // Freeing a slot cannot restore the missing information while this turn lives.
      h.wire().notify('item/completed', mcpItem('completed', 'read-0', 'read'));
      h.wire().notify('item/started', mcpItem('inProgress', 'later-call', 'stamp', { label: 'later' }));
      expect(h.wire().ask(MCP, mcpRequest({ label: 'later' }), 1)).toEqual(NOT_FOUND);
      h.completed();
      await h.running(turn(2), 'cli-turn-2');
      h.wire().notify('item/started', { ...mcpItem('inProgress', 'next-turn'), turnId: 'cli-turn-2' });
      expect(h.wire().ask(MCP, mcpRequest({ label: 'first' }, { turnId: 'cli-turn-2' }), 2)).toBeNull();
      expect(raised(h).map((event) => event.sourceId)).toEqual(['next-turn']);
    });

    it.each(['stamp', 'stamp_other'])('forgets interrupted calls before a later turn uses %s with the same arguments', async (tool) => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress', 'old-call'));
      // Stop can end a turn without an item/completed, as K1's stop capture does.
      h.completed('interrupted');
      await h.running(turn(2), 'cli-turn-2');
      h.wire().notify('item/started', { ...mcpItem('inProgress', 'new-call', tool), turnId: 'cli-turn-2' });
      expect(h.wire().ask(MCP, mcpRequest({ label: 'first' }, { turnId: 'cli-turn-2' }), 0)).toBeNull();
      expect(raised(h).map((event) => event.sourceId)).toEqual(['new-call']);
    });

    it('ignores starts from another turn or an unowned thread, and an old completion cannot remove a current call', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', { ...mcpItem('inProgress', 'old-call', 'stamp_other'), turnId: 'old-turn' });
      h.wire().notify('item/started', { ...mcpItem('inProgress', 'unnamed-call', 'stamp_other'), turnId: null });
      for (let i = 0; i < MAX_HELD_CALLS; i++) h.wire().notify('item/started', { ...mcpItem('inProgress', `other-${String(i)}`), threadId: 'unowned' });
      h.wire().notify('item/started', mcpItem('inProgress', 'current-call'));
      h.wire().notify('item/completed', { ...mcpItem('completed', 'current-call'), turnId: 'old-turn' });
      h.wire().notify('item/completed', { ...mcpItem('completed', 'current-call'), threadId: 'unowned' });
      expect(h.wire().ask(MCP, mcpRequest(), 0)).toBeNull();
      expect(raised(h).map((event) => event.sourceId)).toEqual(['current-call']);
    });

    it('confines overflow to its thread, and keeps a worker’s calls after the parent turn ends', async () => {
      const h = under('ask-first');
      await h.running();
      h.openWorker();
      const workerItem = (itemId: string) => ({ ...mcpItem('inProgress', itemId), threadId: WORKER, turnId: 'worker-turn-1' });
      const workerRequest = () => mcpRequest({ label: 'first' }, { threadId: WORKER, turnId: 'worker-turn-1' });
      h.wire().notify('item/started', workerItem('worker-call'));
      for (let i = 0; i < MAX_HELD_CALLS; i++) h.wire().notify('item/started', mcpItem('inProgress', `parent-${String(i)}`));
      expect(h.wire().ask(MCP, mcpRequest(), 0)).toEqual(NOT_FOUND);
      h.completed();
      // The parent's overflow and end affect neither the worker's call nor its owner.
      expect(h.wire().ask(MCP, workerRequest(), 1)).toBeNull();
      expect(raised(h)).toMatchObject([{ sourceId: 'worker-call', workerId: WORKER, turnId: 'turn-1' }]);
    });

    it('still answers an approval already placed before its thread overflows', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress', 'already-placed'));
      h.wire().ask(MCP, mcpRequest(), 0);
      for (let i = 0; i < MAX_HELD_CALLS; i++) h.wire().notify('item/started', mcpItem('inProgress', `extra-${String(i)}`));
      expect(h.wire().ask(MCP, mcpRequest(), 1)).toEqual(NOT_FOUND);
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(true);
      expect(h.wire().replies).toEqual([{ id: 0, reply: { result: { action: 'accept', content: null, _meta: null } } }]);
    });

    it('places a worker’s approval only on its named turn, and stops taking new requests once that turn ends', async () => {
      const h = under('ask-first');
      await h.running();
      h.openWorker();
      h.wire().notify('item/started', { ...mcpItem('inProgress', 'stale-worker-call', 'stamp_other'), threadId: WORKER, turnId: 'old-worker-turn' });
      h.wire().notify('item/started', { ...mcpItem('inProgress', 'worker-call'), threadId: WORKER, turnId: 'worker-turn-1' });
      expect(h.wire().ask(MCP, mcpRequest({ label: 'first' }, { threadId: WORKER, turnId: 'old-worker-turn' }), 0)).toEqual(NOT_FOUND);
      expect(h.wire().ask(MCP, mcpRequest({ label: 'first' }, { threadId: WORKER, turnId: 'worker-turn-1' }), 1)).toBeNull();
      expect(raised(h).map((event) => event.sourceId)).toEqual(['worker-call']);
      h.wire().notify('item/started', { ...mcpItem('inProgress', 'unasked-worker-call'), threadId: WORKER, turnId: 'worker-turn-1' });
      h.wire().notify('turn/completed', { threadId: WORKER, turn: { id: 'worker-turn-1', status: 'completed' } });
      // Its closing item has not come yet: the mapper still holds the worker, but its turn is over.
      expect(h.wire().ask(MCP, mcpRequest({ label: 'first' }, { threadId: WORKER, turnId: 'worker-turn-1' }), 2)).toEqual(NOT_FOUND);
      expect(raised(h)).toHaveLength(1);
    });

    it('forgets a worker’s uncompleted calls when the worker ends', async () => {
      const h = under('ask-first');
      await h.running();
      h.openWorker();
      for (let i = 0; i < MAX_HELD_CALLS; i++) h.wire().notify('item/started', { ...mcpItem('inProgress', `worker-${String(i)}`), threadId: WORKER, turnId: 'worker-turn-1' });
      h.wire().notify('turn/completed', { threadId: WORKER, turn: { id: 'worker-turn-1', status: 'completed' } });
      h.wire().notify('item/completed', { threadId: THREAD, turnId: CLI_TURN, item: { type: 'subAgentActivity', id: 'call-1', kind: 'completed', agentThreadId: WORKER } });
      h.wire().notify('item/started', mcpItem('inProgress', 'parent-call'));
      expect(h.wire().ask(MCP, mcpRequest(), 0)).toBeNull();
      expect(raised(h).map((event) => event.sourceId)).toEqual(['parent-call']);
    });

    it.each([undefined, null, {}, { codex_approval_kind: 'other' }])('withdraws a held approval whose repeated request has changed metadata: %j', async (meta) => {
      const h = under('ask-first');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress'));
      h.wire().ask(MCP, mcpRequest(), 0);
      expect(h.wire().ask(MCP, mcpRequest({ label: 'first' }, { _meta: meta }), 0)).toEqual(NOT_FOUND);
      expect(resolved(h)).toEqual(['approval-resolved:changed:n:0']);
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(false);
      expect(h.wire().replies).toEqual([]);
    });

    it('declines one at once under Read only, where Codex asks none, keeping nothing of its calls', async () => {
      const h = under('read-only');
      await h.running();
      h.wire().notify('item/started', mcpItem('inProgress'));
      expect(h.wire().ask(MCP, mcpRequest(), 0)).toEqual({ result: { action: 'decline', content: null, _meta: null } });
      expect(raised(h)).toEqual([]);
      expect(h.session.counts.refused).toEqual({ [MCP]: 1 });
    });

    it('refuses an MCP server’s own form, as K1 saw Codex take it, with the notice and no card', async () => {
      const form = capture('codex-mcp-server-form').find((f) => f.dir === 'recv' && f.frame.method === MCP)?.frame.params as Record<string, unknown>;
      // K1 refused it with the same error, and Codex told the server `decline`.
      expect(reply('codex-mcp-server-form')).toEqual(NOT_FOUND.error);
      const h = under('ask-first');
      await h.running();
      expect(h.wire().ask(MCP, { ...form, threadId: THREAD, turnId: CLI_TURN }, 0)).toEqual(NOT_FOUND);
      expect(raised(h)).toEqual([]);
      expect(h.session.counts.refused).toEqual({ [MCP]: 1 });
      expect(h.notices()).toEqual(['request-refused']);
    });
  });

  describe('a request delivered again under a held id (V31; C91)', () => {
    it('counts the same request again as a repeat, and writes nothing: its one reply answers it', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().ask(COMMAND, command(), 0);
      // The same payload, its keys in another order.
      expect(h.wire().ask(COMMAND, Object.fromEntries(Object.entries(command()).reverse()), 0)).toBeNull();
      expect(raised(h)).toHaveLength(1);
      expect(h.session.counts.approvals.repeated).toBe(1);
      expect(h.session.counts.changed).toBe(0);
      await h.session.decide('n:0', 'approve');
      // And once decided: counted again, the reply not written a second time.
      expect(h.wire().ask(COMMAND, command(), 0)).toBeNull();
      expect(h.wire().replies).toHaveLength(1);
      expect(h.session.counts.approvals.repeated).toBe(2);
    });

    it.each([
      ['another command', { command: 'rm -rf elsewhere' }],
      ['another folder', { cwd: 'C:\\somewhere\\else' }],
      ['another owner', { threadId: WORKER, turnId: 'worker-turn-1' }],
      ['another list of decisions', { availableDecisions: ['accept', 'acceptForSession'] }],
      ['one field more', { reason: 'because' }],
    ])('refuses the same id with %s under that id, lets the first go as changed, and shows nothing of the second', async (_name, change) => {
      const h = under('ask-first');
      await h.running();
      h.openWorker();
      h.wire().ask(COMMAND, command(), 0);
      const before = h.events.length;
      expect(h.wire().ask(COMMAND, command(change), 0)).toEqual(NOT_FOUND);
      expect(raised(h)).toHaveLength(1);
      expect(resolved(h)).toEqual(['approval-resolved:changed:n:0']);
      expect(h.session.counts).toMatchObject({ changed: 1, approvals: { repeated: 0 }, refused: { [COMMAND]: 1 } });
      // Nothing of the second payload is in an event or a log.
      expect(JSON.stringify([h.events.slice(before), h.script.diagnostics])).not.toMatch(/elsewhere|somewhere|because/);
      // The hold is gone: a decision for it writes nothing.
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(false);
      expect(h.wire().replies).toEqual([]);
      for (const event of h.events) expect(AgentEventSchema.safeParse(event).success, event.type).toBe(true);
    });

    it('refuses a changed delivery of a request already decided the same way, and one that comes under another method', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().ask(COMMAND, command(), 0);
      await h.session.decide('n:0', 'approve');
      expect(h.wire().ask(COMMAND, command({ command: 'echo other' }), 0)).toEqual(NOT_FOUND);
      expect(resolved(h)).toEqual(['approval-resolved:changed:n:0']);
      h.wire().notify('item/started', fileItem('inProgress'));
      h.wire().ask(FILE, fileRequest(), 1);
      expect(h.wire().ask(COMMAND, fileRequest(), 1)).toEqual(NOT_FOUND);
      expect(resolved(h)).toEqual(['approval-resolved:changed:n:0', 'approval-resolved:changed:n:1']);
      expect(h.session.counts.changed).toBe(2);
    });

    it('refuses a question’s changed repeat the same way: the hold is one for both kinds', async () => {
      const h = setup();
      await h.running();
      const K2 = capture('m21-codex-plan').find((f) => f.dir === 'recv' && f.frame.method === QUESTION)?.frame.params as { questions: Record<string, unknown>[] } & Record<string, unknown>;
      const question = (extra: Record<string, unknown> = {}) => ({ ...K2, threadId: THREAD, turnId: CLI_TURN, itemId: 'item-q', ...extra });
      expect(h.wire().ask(QUESTION, question(), 0)).toBeNull();
      // The same again is M21's repeat.
      expect(h.wire().ask(QUESTION, question(), 0)).toBeNull();
      expect(h.session.counts.questions.repeated).toBe(1);
      // Another question under its id is refused, and the first is let go.
      expect(h.wire().ask(QUESTION, question({ questions: [{ ...K2.questions[0], question: 'Which file should be deleted?' }] }), 0)).toEqual(NOT_FOUND);
      expect(resolved(h)).toEqual(['question-resolved:changed:n:0']);
      expect(JSON.stringify(h.events)).not.toContain('deleted');
      h.session.answer('n:0', [{ options: [0], text: null }]);
      await settle();
      expect(h.wire().replies).toEqual([]);
      expect(h.session.counts).toMatchObject({ changed: 1, questions: { repeated: 1, unheld: 1 } });
    });
  });

  describe('a line over the limit (V3; C67, C71)', () => {
    const MIB = 1024 * 1024;
    const line = (method: string, rest: string): string => `{"method":"${method}",${rest}`;

    it('refuses a request by the id read from it, a number or a string, with the line’s size, and the turn goes on (C67)', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().drop(line(FILE, '"id":7,"params":{"threadId":"x","reason":"'), 5 * MIB + 3);
      h.wire().drop(line(COMMAND, '"id":"req-9","params":{"command":"'), 6 * MIB);
      await settle();
      expect(h.wire().replies).toEqual([{ id: 7, reply: NOT_FOUND }, { id: 'req-9', reply: NOT_FOUND }]);
      expect(h.events.filter((event) => event.type !== 'turn-started' && event.type !== 'session-started')).toEqual([
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'line', size: 5 * MIB + 3 },
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'line', size: 6 * MIB },
      ]);
      for (const event of h.events) expect(AgentEventSchema.safeParse(event).success).toBe(true);
      expect(h.session.counts.oversized).toEqual({ refused: 2, stopped: 0 });
      expect(h.session.counts.dropped.oversized).toBe(2);
      // Nothing was stopped, and no card was raised: the turn goes on to its own end.
      expect(h.sent()).not.toContain('turn/interrupt');
      h.completed();
      expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true }]);
      // Nothing of the line but its kind and its id reached a log.
      expect(JSON.stringify(h.script.diagnostics)).not.toMatch(/threadId|reason|req-9/);
    });

    it('refuses any of the requests Codex waits on so, a question’s among them, and under Read only too', async () => {
      const h = setup();
      await h.running();
      h.wire().drop(line(QUESTION, '"id":2,"params":{"questions":['), 5 * MIB);
      h.wire().drop(line('mcpServer/elicitation/request', '"id":3,"params":{'), 5 * MIB);
      await settle();
      expect(h.wire().replies).toEqual([{ id: 2, reply: NOT_FOUND }, { id: 3, reply: NOT_FOUND }]);
      expect(h.notices()).toEqual(['request-refused', 'request-refused']);
    });

    it('lets go, as changed, of a held request that comes again as a line too long to compare (C91)', async () => {
      const h = under('ask-first');
      await h.running();
      h.wire().ask(COMMAND, command(), 0);
      h.wire().drop(line(COMMAND, '"id":0,"params":{"command":"'), 5 * MIB);
      await settle();
      expect(resolved(h)).toEqual(['approval-resolved:changed:n:0']);
      expect(h.wire().replies).toEqual([{ id: 0, reply: NOT_FOUND }]);
      await expect(h.session.decide('n:0', 'approve')).resolves.toBe(false);
    });

    it('stops the turn and its workers, each by its own interrupt, where a request’s id cannot be read: Codex may wait on it for ever (C71)', async () => {
      const h = under('ask-first');
      await h.running();
      h.openWorker();
      // The id is past the first bytes: after the request's whole `params`.
      h.wire().drop(line(FILE, '"params":{"threadId":"x","reason":"'), 7 * MIB);
      expect(h.events.at(-1)).toEqual({ type: 'notice', kind: 'line-too-long', turnId: 'turn-1', size: 7 * MIB });
      expect(AgentEventSchema.safeParse(h.events.at(-1)).success).toBe(true);
      expect(h.wire().requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params)).toEqual([{ threadId: THREAD, turnId: CLI_TURN }, { threadId: WORKER, turnId: 'worker-turn-1' }]);
      expect(h.session.counts.oversized).toEqual({ refused: 0, stopped: 1 });
      // No process is closed for the line itself: the turn ends as a Stop's does.
      expect(h.wire().closes).toBe(0);
      h.completed('interrupted');
      expect(ended(h.events)).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
      expect(h.wire().replies).toEqual([]);
    });

    it('stops everything for a line of no kind it can read, too: workers left after a turn, as the session’s Stop ends them', async () => {
      const h = under('ask-first');
      await h.running();
      h.openWorker();
      h.completed();
      h.wire().drop('{"params":{"padding":"', 8 * MIB);
      // The notice first, naming no turn since none runs; then the worker's item and the worker, as a Stop ends them.
      expect(h.events.slice(-4)).toEqual([{ type: 'notice', kind: 'line-too-long', size: 8 * MIB }, expect.objectContaining({ type: 'activity-ended', itemId: 'call-1', status: 'failed' }), { type: 'worker-ended', workerId: WORKER, outcome: 'failed' }, { type: 'notice', kind: 'workers-stopped' }]);
      await settle();
      expect(h.wire().closes).toBe(1);
    });

    it('stops an aside alone by its own Stop, with its own notice, where only it runs; and both, each with its notice, where a turn runs beside it', async () => {
      const ask = async (h: Setup): Promise<void> => {
        h.session.ask({ asideId: 'aside-1', turnId: 'aside-turn-1', text: 'What does this do?', messageId: 'aside-message-1', history: [], throughTurn: null, effort: 'low', speed: null });
        await settle();
        h.wire().pending('thread/fork').resolve({ thread: { id: 'side-1' }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' });
        await settle();
        h.wire().pending('turn/start').resolve({ turn: { id: 'side-turn-1' } });
        await settle();
        h.wire().notify('turn/started', { threadId: 'side-1', turn: { id: 'side-turn-1' } });
      };
      const alone = under('ask-first');
      await alone.running();
      alone.completed();
      await ask(alone);
      const before = alone.events.length;
      alone.wire().drop('{"params":{"padding":"', 5 * MIB);
      expect(alone.events.slice(before)).toEqual([{ type: 'notice', kind: 'line-too-long', turnId: 'aside-turn-1', asideId: 'aside-1', size: 5 * MIB }]);
      expect(alone.wire().requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params)).toEqual([{ threadId: 'side-1', turnId: 'side-turn-1' }]);

      const both = under('ask-first');
      await both.running();
      await ask(both);
      const start = both.events.length;
      both.wire().drop(line(COMMAND, '"params":{"command":"'), 5 * MIB);
      expect(both.events.slice(start)).toEqual([{ type: 'notice', kind: 'line-too-long', turnId: 'turn-1', size: 5 * MIB }, { type: 'notice', kind: 'line-too-long', turnId: 'aside-turn-1', asideId: 'aside-1', size: 5 * MIB }]);
      expect(both.wire().requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params)).toEqual([{ threadId: THREAD, turnId: CLI_TURN }, { threadId: 'side-1', turnId: 'side-turn-1' }]);
      expect(both.session.counts.oversized).toEqual({ refused: 0, stopped: 1 });
    });

    it('counts a line alone where nothing runs, and where it is a notification or a reply of fat-g’s own request: as before', async () => {
      const h = under('ask-first');
      await h.running();
      h.completed();
      const before = h.events.length;
      // Nothing runs: a request with no id is a line skipped.
      h.wire().drop(line(FILE, '"params":{"reason":"'), 5 * MIB);
      h.wire().drop('{"params":{"padding":"', 5 * MIB);
      await h.running(turn(2), 'cli-turn-2');
      const running = h.events.length;
      // A turn runs: a notification, and a reply to a request of fat-g's own, stop nothing.
      h.wire().drop();
      h.wire().drop(line('turn/completed', '"params":{"threadId":"x","turn":{'), 5 * MIB);
      h.wire().drop('{"id":3,"result":{"turn":{"id":"', 5 * MIB);
      h.wire().drop('{"error":{"code":-32600,"message":"', 5 * MIB);
      await settle();
      expect(h.events.slice(before, running).filter((event) => event.type === 'notice')).toEqual([]);
      expect(h.events.slice(running)).toEqual([]);
      expect(h.session.counts.dropped.oversized).toBe(6);
      expect(h.session.counts.oversized).toEqual({ refused: 0, stopped: 0 });
      expect(h.sent()).not.toContain('turn/interrupt');
      expect(h.wire().replies).toEqual([]);
    });
  });

  describe('Codex’s own reviewer (V34; C96)', () => {
    it('counts the reviewer’s three frames of K4’s turn, and makes no card, notice or item of them', async () => {
      const h = under('auto-reviewed');
      await h.running();
      const K4 = capture('m22-codex-auto-review-main').filter((f) => f.dir === 'recv' && ['item/autoApprovalReview/started', 'guardianWarning', 'item/autoApprovalReview/completed'].includes(f.frame.method ?? ''));
      expect(K4.map((f) => f.frame.method)).toEqual(['item/autoApprovalReview/started', 'guardianWarning', 'item/autoApprovalReview/completed']);
      const before = h.events.length;
      for (const f of K4) h.wire().notify(f.frame.method as string, { ...f.frame.params, threadId: THREAD, turnId: CLI_TURN });
      expect(h.events.slice(before)).toEqual([]);
      expect(h.session.counts.reviews).toBe(3);
      // Counted apart from what is simply unmapped, and never parsed: the reviewer's sentence goes nowhere.
      expect(h.session.counts.unmapped).toBe(0);
      expect(JSON.stringify([h.events, h.script.diagnostics])).not.toMatch(/Automatic approval review|rationale/);
    });
  });
});

// M23, V5 (C21, C24; K1): a prompt's images as `turn/start` takes them, by the paths main handed over.
describe('a prompt with images (M23: V5; C21, C24)', () => {
  const attachments = [
    { mediaType: 'image/png' as const, path: 'C:\\data\\attachments\\aaaa.png', bytes: new Uint8Array([1]) },
    { mediaType: 'image/jpeg' as const, path: 'C:\\data\\attachments\\bbbb.jpg', bytes: new Uint8Array([2]) },
  ];

  it('sends the text item and one localImage item per image, in their order, and none of their bytes', async () => {
    const h = setup();
    await h.begin({ ...turn(1, 'medium'), attachments });
    expect(h.wire().pending('turn/start').params).toEqual({
      threadId: THREAD,
      input: [{ type: 'text', text: 'Prompt 1', text_elements: [] }, { type: 'localImage', path: 'C:\\data\\attachments\\aaaa.png' }, { type: 'localImage', path: 'C:\\data\\attachments\\bbbb.jpg' }],
      model: 'gpt-x', effort: 'medium', serviceTier: 'default', clientUserMessageId: 'message-1', ...READ_ONLY_TURN,
    });
  });

  it('sends images alone for a prompt with no text, and the text item alone without images', () => {
    expect(promptInput('', attachments)).toEqual([{ type: 'localImage', path: 'C:\\data\\attachments\\aaaa.png' }, { type: 'localImage', path: 'C:\\data\\attachments\\bbbb.jpg' }]);
    expect(promptInput('Look', [])).toEqual([{ type: 'text', text: 'Look', text_elements: [] }]);
    expect(promptInput('', [])).toEqual([{ type: 'text', text: '', text_elements: [] }]);
  });

  it('matches the input K1 sent, a path for each image', () => {
    const capture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../../../../tests/fixtures/codex/captures/m23-codex-image.json'), 'utf8')) as { frames: { dir: string; frame: { method?: string; params?: { input?: { type: string; text?: string; path?: string }[] } } }[] };
    const sent = capture.frames.filter((entry) => entry.dir === 'send' && entry.frame.method === 'turn/start').map((entry) => entry.frame.params?.input ?? []);
    for (const input of sent) {
      const text = input.find((part) => part.type === 'text')?.text ?? '';
      const paths = input.filter((part) => part.type === 'localImage').map((part) => ({ path: part.path ?? '' }));
      expect(promptInput(text, paths)).toEqual(input);
    }
    expect(sent.some((input) => input.filter((part) => part.type === 'localImage').length === 2)).toBe(true);
  });
});
