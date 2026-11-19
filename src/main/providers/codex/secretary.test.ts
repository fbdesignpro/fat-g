// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary on Codex (docs/planning/_archive/M26.md, Design 3), against a scripted connection answered
// with the frames of M26's K2 capture (its run with the base instructions and the overrides): what it launches and sends, the check before its turn, the
// answer it takes, and its end on every path. The real process is in tests/codex/secretary.integration.test.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProcessFailure, type Executable } from '@shared/provider-kit/process';
import { DELTA_METHODS } from './methods';
import { runCodexSecretary, SECRETARY_CONFIG } from './secretary';
import { scriptedContext, settle } from './session-test-support';

const EXECUTABLE: Executable = { path: 'C:\\bin\\codex.exe', kind: 'native' };
const REQUEST = { instructions: 'Name the session.', text: 'The first message of the session:\n\nFix the login form', model: 'gpt-6-luna', effort: 'low' };
const THREAD = '019f2c1a-7b3e-7d21-8a4f-0c5d6e7f8a9b';
const TURN = '019f2c1a-7b3e-7d21-8a4f-0c5d6e7f8a9c';

// K2's frames, its aliases given ids of the shape Codex's are.
interface Frame { readonly dir: string; readonly frame: { readonly id?: number; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: unknown } }
const captured = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/captures/m26-codex-config-off.json'), 'utf8').replaceAll('<session-1>', THREAD).replaceAll('<turn-2>', TURN).replaceAll('<item-4>', 'msg_1')) as { frames: Frame[] };
const methodOf = new Map(captured.frames.filter((f) => f.dir === 'send' && f.frame.id !== undefined).map((f) => [f.frame.id, f.frame.method]));
const replyTo = (method: string): unknown => captured.frames.find((f) => f.dir === 'recv' && f.frame.method === undefined && methodOf.get(f.frame.id) === method)?.frame.result;
const notified = (method: string): Record<string, unknown> => {
  const found = captured.frames.find((f) => f.dir === 'recv' && f.frame.method === method && (method !== 'item/completed' || (f.frame.params?.['item'] as { type?: string } | undefined)?.type === 'agentMessage'));
  if (found?.frame.params === undefined) throw new Error(`K2 has no ${method}`);
  return found.frame.params;
};

function setup(timings?: { launchMs?: number; requestMs?: number }) {
  const script = scriptedContext();
  const controller = new AbortController();
  const answer = runCodexSecretary({ context: script.context, executable: () => EXECUTABLE, argsPrefix: [], applicationVersion: '1.2.3', ...(timings === undefined ? {} : { timings }) }, REQUEST, controller.signal);
  return { script, controller, answer };
}

/** The handshake, the start and the turn, answered as K2's were. */
async function throughTheTurn(script: ReturnType<typeof scriptedContext>, start: unknown = replyTo('thread/start')) {
  await settle();
  const connection = script.latest();
  connection.pending('initialize').resolve({});
  await settle();
  connection.pending('thread/start').resolve(start);
  await settle();
  return connection;
}

describe('the secretary on Codex (M26, Design 3)', () => {
  it('opens an app-server in the probe folder, starts one ephemeral read-only thread and one turn, answers its message, and closes', async () => {
    const { script, answer } = setup();
    const connection = await throughTheTurn(script);
    expect(connection.options).toMatchObject({ executable: EXECUTABLE, args: ['app-server'], options: { cwd: 'C:\\probe' } });
    expect(connection.requests.map((request) => request.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(connection.requests[0]?.params).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '1.2.3' }, capabilities: { optOutNotificationMethods: [...DELTA_METHODS] } });
    expect(connection.notifications).toEqual([{ method: 'initialized', params: {} }]);
    expect(connection.requests[1]?.params).toEqual({ cwd: 'C:\\probe', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, baseInstructions: 'Name the session.', model: 'gpt-6-luna', serviceTier: 'default', config: SECRETARY_CONFIG });
    expect(connection.requests[2]?.params).toEqual({ threadId: THREAD, input: [{ type: 'text', text: REQUEST.text, text_elements: [] }], model: 'gpt-6-luna', effort: 'low', serviceTier: 'default' });
    connection.pending('turn/start').resolve(replyTo('turn/start'));
    connection.notify('item/completed', notified('item/completed'));
    connection.notify('turn/completed', notified('turn/completed'));
    expect(await answer).toEqual({ kind: 'answered', text: 'Disable Submit Until Login Fields Are Filled' });
    expect(connection.closes).toBeGreaterThanOrEqual(1);
  });

  it('sends no turn when the start reply is not Read only, and names no level for a model with none', async () => {
    const { script, answer } = setup();
    const start = replyTo('thread/start') as Record<string, unknown>;
    const connection = await throughTheTurn(script, { ...start, sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } });
    expect(await answer).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(connection.requests.map((request) => request.method)).toEqual(['initialize', 'thread/start']);

    const other = scriptedContext();
    void runCodexSecretary({ context: other.context, executable: () => EXECUTABLE, argsPrefix: [], applicationVersion: '1.2.3' }, { ...REQUEST, effort: null }, new AbortController().signal);
    const second = await throughTheTurn(other);
    expect(second.requests[2]?.params).not.toHaveProperty('effort');
  });

  it('answers no title for a turn that failed, one with no message, or a process that ended first', async () => {
    for (const end of ['failed', 'silent', 'ended'] as const) {
      const { script, answer } = setup();
      const connection = await throughTheTurn(script);
      connection.pending('turn/start').resolve(replyTo('turn/start'));
      const completed = notified('turn/completed');
      if (end === 'failed') { connection.notify('item/completed', notified('item/completed')); connection.notify('turn/completed', { ...completed, turn: { ...(completed['turn'] as object), status: 'failed' } }); }
      if (end === 'silent') connection.notify('turn/completed', completed);
      if (end === 'ended') connection.end();
      expect(await answer, end).toEqual({ kind: 'failed', reason: 'unavailable' });
    }
  });

  it('asks once more without its overrides when Codex refuses the start with them, and asks no third time', async () => {
    const { script, answer } = setup();
    await settle();
    const connection = script.latest();
    connection.pending('initialize').resolve({});
    await settle();
    connection.pending('thread/start').reject(new ProcessFailure('rpc-error'));
    await settle();
    expect(connection.requests.filter((request) => request.method === 'thread/start').map((request) => 'config' in (request.params as object))).toEqual([true, false]);
    connection.pending('thread/start').reject(new ProcessFailure('rpc-error'));
    expect(await answer).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(connection.requests.filter((request) => request.method === 'thread/start')).toHaveLength(2);
  });

  it('refuses whatever Codex asks: no handler is registered for any request', async () => {
    const { script, answer, controller } = setup();
    const connection = await throughTheTurn(script);
    expect(connection.ask('item/commandExecution/requestApproval', { threadId: THREAD })).toBeUndefined();
    controller.abort();
    expect(await answer).toEqual({ kind: 'failed', reason: 'aborted' });
  });

  it('closes the process at once when let go of, and answers that it was', async () => {
    const { script, controller, answer } = setup();
    await settle();
    const connection = script.latest();
    controller.abort();
    connection.pending('initialize').reject(new ProcessFailure('aborted'));
    expect(await answer).toEqual({ kind: 'failed', reason: 'aborted' });
    expect(connection.closes).toBeGreaterThanOrEqual(1);
  });

  it('opens nothing with no executable or a request already let go of, and answers no title when the open fails', async () => {
    const script = scriptedContext();
    const run = (signal: AbortSignal, detected = true) => runCodexSecretary({ context: script.context, executable: () => (detected ? EXECUTABLE : undefined), argsPrefix: [], applicationVersion: '1.2.3' }, REQUEST, signal);
    expect(await run(new AbortController().signal, false)).toEqual({ kind: 'failed', reason: 'unavailable' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await run(aborted.signal)).toEqual({ kind: 'failed', reason: 'aborted' });
    expect(script.opened).toEqual([]);
    script.failNextOpen();
    expect(await run(new AbortController().signal)).toEqual({ kind: 'failed', reason: 'unavailable' });
  });
});
