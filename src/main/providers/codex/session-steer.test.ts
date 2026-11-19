// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8, the Codex adapter's part (docs/planning/_archive/M23.md; C36, C38–C40; K1): a message sent into
// the running turn as `turn/steer` on the session's own connection — offered only while the turn
// Codex named runs, taken where the reply names that turn, its stale-turn refusal taken for the
// turn's end only where that end is known, any other refusal "not sent" with the code alone, and no
// reply "not confirmed".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import { ProcessFailure } from '@shared/provider-kit/process';
import type { SteerOutcome, TurnRequest } from '@shared/provider-kit/sessions';
import { mayBeSent } from './methods';
import { createCodexSession } from './session';
import { SESSION_TIMINGS } from './session-process';
import { scriptedContext, type ScriptedConnection, settle } from './session-test-support';

const executable = { path: 'C:\\bin\\codex.exe', kind: 'native' } as const;
const FOLDER = 'C:\\work\\project';
const THREAD = 'thread-1';
const CLI_TURN = 'cli-turn-1';
const START_REPLY = { thread: { id: THREAD }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never', model: 'gpt-x', reasoningEffort: 'low' };
const turn = (n = 1): TurnRequest => ({ turnId: `turn-${n}`, prompt: `Prompt ${n}`, effort: 'low', speed: null, messageId: `message-${n}` });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const script = scriptedContext();
  const session = createCodexSession({ context: script.context, executable: () => executable, argsPrefix: [], applicationVersion: '1.0.0', timings: SESSION_TIMINGS, start: { folder: FOLDER, model: 'gpt-x', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }, reference: null });
  const events: AgentEvent[] = [];
  session.subscribe((event) => { events.push(event); });
  const wire = (): ScriptedConnection => script.latest();
  return {
    session, events, wire,
    sent: () => wire().requests.map((request) => request.method),
    async running(request = turn()) {
      session.send(request); await settle();
      wire().pending('initialize').resolve({}); await settle();
      wire().pending('thread/start').resolve(START_REPLY); await settle();
      wire().pending('turn/start').resolve({ turn: { id: CLI_TURN } }); await settle();
      wire().notify('turn/started', { threadId: THREAD, turn: { id: CLI_TURN } });
    },
    completed() { wire().notify('turn/completed', { threadId: THREAD, turn: { id: CLI_TURN, status: 'completed', error: null } }); },
  };
}

const steer = (prompt = 'Also the tests') => ({ turnId: 'turn-1', messageId: 'steer-1', prompt });

describe('Send now on Codex (V8; C36, C38–C40)', () => {
  it('puts turn/steer in the session’s own set alone', () => {
    expect(mayBeSent('session', 'turn/steer')).toBe(true);
    for (const kind of ['existing', 'sandbox', 'secretary'] as const) expect(mayBeSent(kind, 'turn/steer')).toBe(false);
  });

  it('is open only while the turn Codex named runs, and waits once a Stop is pressed or the turn ended', async () => {
    const h = setup();
    expect(h.session.steerState()).toBe('wait');
    await h.running();
    expect(h.session.steerState()).toBe('open');
    h.completed();
    expect(h.session.steerState()).toBe('wait');
    const stopped = setup();
    await stopped.running();
    stopped.session.stop();
    expect(stopped.session.steerState()).toBe('wait');
  });

  it('says the turn takes a message by a steer-changed event once the turn/start reply named it, after its turn-started', async () => {
    const h = setup();
    await h.running();
    const types = h.events.map((event) => event.type);
    expect(types.filter((type) => type === 'steer-changed')).toHaveLength(1);
    expect(types.indexOf('steer-changed')).toBeGreaterThan(types.indexOf('turn-started'));
  });

  it('sends turn/steer naming Codex’s turn, the message’s id and its input, and is taken where the reply names that turn', async () => {
    const h = setup();
    await h.running();
    const outcome = h.session.steer({ ...steer(), attachments: [{ mediaType: 'image/png', path: 'D:\\data\\attachments\\a.png', bytes: new Uint8Array([1]) }] });
    await settle();
    expect(h.wire().pending('turn/steer').params).toEqual({
      threadId: THREAD, expectedTurnId: CLI_TURN, clientUserMessageId: 'steer-1',
      input: [{ type: 'text', text: 'Also the tests', text_elements: [] }, { type: 'localImage', path: 'D:\\data\\attachments\\a.png' }],
    });
    h.wire().pending('turn/steer').resolve({ turnId: CLI_TURN });
    expect(await outcome).toEqual({ kind: 'taken' });
    // No turn of its own: the one turn goes on.
    expect(h.events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
  });

  it('takes the stale-turn refusal for the turn’s end where that end came first, or comes within the Stop’s time', async () => {
    const h = setup();
    await h.running();
    const first = h.session.steer(steer());
    await settle();
    h.completed();
    h.wire().pending('turn/steer').reject(new ProcessFailure('rpc-error', -32600));
    expect(await first).toEqual({ kind: 'turn-over' });

    const later = setup();
    await later.running();
    const second = later.session.steer(steer());
    await settle();
    later.wire().pending('turn/steer').reject(new ProcessFailure('rpc-error', -32600));
    await settle();
    later.completed();
    expect(await second).toEqual({ kind: 'turn-over' });
  });

  it('says not sent, with the code alone, for that code while the turn goes on, and for any other refusal', async () => {
    const h = setup();
    await h.running();
    const stale = h.session.steer(steer());
    await settle();
    h.wire().pending('turn/steer').reject(new ProcessFailure('rpc-error', -32600));
    let answered: SteerOutcome | null = null;
    void stale.then((outcome) => { answered = outcome; });
    await vi.advanceTimersByTimeAsync(SESSION_TIMINGS.stopMs);
    expect(answered).toEqual({ kind: 'refused', detail: 'code -32600' });
    const other = h.session.steer({ ...steer(), messageId: 'steer-2' });
    await settle();
    h.wire().pending('turn/steer').reject(new ProcessFailure('rpc-error', -32000));
    expect(await other).toEqual({ kind: 'refused', detail: 'code -32000' });
  });

  it('says not confirmed where no reply came, or one that names another turn', async () => {
    const h = setup();
    await h.running();
    const silent = h.session.steer(steer());
    await settle();
    h.wire().pending('turn/steer').reject(new ProcessFailure('timeout'));
    expect(await silent).toEqual({ kind: 'unknown' });
    const strange = h.session.steer({ ...steer(), messageId: 'steer-2' });
    await settle();
    h.wire().pending('turn/steer').resolve({ turnId: 'another-turn' });
    expect(await strange).toEqual({ kind: 'unknown' });
  });

  it('writes nothing where the turn is over before the steer: the message is the next prompt’s', async () => {
    const h = setup();
    await h.running();
    h.completed();
    expect(await h.session.steer(steer())).toEqual({ kind: 'turn-over' });
    expect(h.sent()).not.toContain('turn/steer');
  });
});
