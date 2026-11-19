// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, V9 (docs/planning/_archive/M15.md; C12, C13, C15, C19, C23): a session's process, as it is started.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessFailure } from '@shared/provider-kit/process';
import { MESSAGE_DELTA_METHOD, OPTED_OUT_DELTAS } from './methods';
import { PEEK_BYTES } from '@shared/provider-kit/ndjson';
import { openSessionProcess, readOversized, SESSION_TIMINGS } from './session-process';
import { scriptedContext, settle } from './session-test-support';

afterEach(() => vi.useRealTimers());

const executable = { path: 'C:\\bin\\codex.exe', kind: 'native' } as const;

function start(overrides: { argsPrefix?: string[]; launchMs?: number; signal?: AbortSignal } = {}) {
  const script = scriptedContext();
  const onDropped = vi.fn();
  const unhandled = vi.fn();
  const opening = openSessionProcess({ context: script.context, executable, argsPrefix: overrides.argsPrefix ?? [], applicationVersion: '9.9.9', launchMs: overrides.launchMs ?? SESSION_TIMINGS.launchMs, signal: overrides.signal ?? new AbortController().signal, onOversized: onDropped, unhandled });
  return { ...script, opening, onDropped, unhandled };
}

describe('a session’s process (C12, C23)', () => {
  it('is launched like the existing connection: the same executable and argument, in fat-g’s own probe folder, with nothing of a project', async () => {
    const { opening, latest } = start({ argsPrefix: ['fake.mjs'] });
    await settle();
    const { options } = latest();
    expect(options.executable).toEqual(executable);
    expect(options.args).toEqual(['fake.mjs', 'app-server']);
    expect(options.options).toEqual({ cwd: 'C:\\probe', stdoutLimit: 1024 * 1024 });
    expect(options.options.env).toBeUndefined();
    latest().pending('initialize').resolve({});
    await opening;
  });

  it('drops an oversized line and counts it, and is told of what nothing handles (C19, C37)', async () => {
    const { opening, latest, onDropped, unhandled } = start();
    await settle();
    expect(latest().options.oversizedLines).toBe('drop');
    // A session's own limit (M20a, C16): 4 MiB, so that an output Codex cut at 1 MiB arrives however JSON escapes it.
    expect(latest().options.lineBytes).toBe(32 * 1024 * 1024);
    latest().drop();
    latest().notify('remoteControl/status/changed', { serverName: 'private-host' });
    expect(onDropped).toHaveBeenCalledTimes(1);
    // What it is told of the line is its kind, its request id and its size, and never its bytes (M22, C67).
    expect(onDropped).toHaveBeenCalledWith({ request: 'no', id: null, size: 5 * 1024 * 1024 });
    expect(unhandled).toHaveBeenCalledExactlyOnceWith('notification', 'remoteControl/status/changed');
    latest().pending('initialize').resolve({});
    await opening;
  });

  it('opts out of the nine other delta notifications in its handshake, keeping an agent message’s and a plan’s, asks for the experimental API, then says initialized (C13; M19, C7; M22b, C13, C14)', async () => {
    const { opening, latest } = start();
    await settle();
    const initialize = latest().pending('initialize');
    expect(initialize.params).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '9.9.9' }, capabilities: { experimentalApi: true, optOutNotificationMethods: [...OPTED_OUT_DELTAS] } });
    expect(OPTED_OUT_DELTAS).toHaveLength(9);
    expect(JSON.stringify(initialize.params)).not.toContain(MESSAGE_DELTA_METHOD);
    expect(JSON.stringify(initialize.params)).not.toContain('item/plan/delta');
    initialize.resolve({ platformFamily: 'windows' });
    const connection = await opening;
    expect(latest().notifications).toEqual([{ method: 'initialized', params: {} }]);
    expect(latest().requests.map((request) => request.method)).toEqual(['initialize']);
    expect(connection).toBe(latest().connection);
  });

  it('keeps the start and its handshake inside one deadline of 30 seconds (C15)', async () => {
    vi.useFakeTimers();
    const { opening, latest } = start();
    const failed = expect(opening).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest().pending('initialize').timeoutMs).toBeGreaterThan(29_000);
    expect(latest().pending('initialize').timeoutMs).toBeLessThanOrEqual(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    // What was started is closed.
    expect(latest().closes).toBe(1);
  });

  it('closes the process when the handshake is refused, and when the start is cancelled', async () => {
    const refused = start();
    await settle();
    refused.latest().pending('initialize').reject(new ProcessFailure('rpc-error', -32600));
    await expect(refused.opening).rejects.toMatchObject({ code: 'rpc-error' });
    expect(refused.latest().closes).toBe(1);

    const controller = new AbortController();
    const cancelled = start({ signal: controller.signal });
    await settle();
    controller.abort();
    await expect(cancelled.opening).rejects.toMatchObject({ code: 'aborted' });
    expect(cancelled.latest().closes).toBe(1);
  });

  it('launches nothing when it is cancelled first, and says so when the launch fails', async () => {
    const controller = new AbortController();
    controller.abort();
    const never = start({ signal: controller.signal });
    await expect(never.opening).rejects.toMatchObject({ code: 'aborted' });
    expect(never.opened).toHaveLength(0);

    const script = scriptedContext();
    script.failNextOpen(new ProcessFailure('cleanup-failed'));
    await expect(openSessionProcess({ context: script.context, executable, argsPrefix: [], applicationVersion: '1', launchMs: 100, signal: new AbortController().signal, onOversized: () => undefined, unhandled: () => undefined })).rejects.toMatchObject({ code: 'cleanup-failed' });
  });
});

// M22 (V3; C67, C71): a line over the limit, read for its kind and its request id alone.
describe('a line over a session’s limit, as it is read (M22; C67, C71)', () => {
  const line = (head: string, size = 5 * 1024 * 1024) => ({ peek: new TextEncoder().encode(head).subarray(0, PEEK_BYTES), size });

  it.each([
    ['a request for leave, its id a number, as Codex writes one', '{"method":"item/fileChange/requestApproval","id":0,"params":{"threadId":"t","reason":"', { request: 'yes', id: { kind: 'number', value: 0 } }],
    ['a command’s request, its id a string', '{"method":"item/commandExecution/requestApproval","id":"req-7","params":{', { request: 'yes', id: { kind: 'string', value: 'req-7' } }],
    ['a question’s request', '{"method":"item/tool/requestUserInput","id":12,"params":{"questions":[', { request: 'yes', id: { kind: 'number', value: 12 } }],
    ['any other request Codex waits on', '{"method":"mcpServer/elicitation/request","id":3,"params":{', { request: 'yes', id: { kind: 'number', value: 3 } }],
    ['a request whose id is past its first bytes', '{"method":"item/fileChange/requestApproval","params":{"threadId":"t"', { request: 'yes', id: null }],
    ['a notification', '{"method":"item/completed","params":{"item":{"aggregatedOutput":"', { request: 'no', id: null }],
    ['a method that is no request of the schema’s, whatever id it carries', '{"method":"something/new","id":4,"params":{', { request: 'no', id: null }],
    ['a reply to a request of fat-g’s own', '{"id":3,"result":{"thread":{"id":"', { request: 'no', id: null }],
    ['an error reply, as Codex writes one', '{"error":{"code":-32600,"message":"', { request: 'no', id: null }],
    ['a line of no kind', '{"params":{"padding":"', { request: 'maybe', id: null }],
    ['a line that is no object', 'xxxxxxxxxxxxxxxxxxxx', { request: 'maybe', id: null }],
  ])('reads %s', (_name, head, expected) => {
    expect(readOversized(line(head))).toEqual({ ...expected, size: 5 * 1024 * 1024 });
  });

  it('takes nothing inside a request’s payload for a key of the line: a `result` or an `id` in its params says nothing', () => {
    expect(readOversized(line('{"method":"item/fileChange/requestApproval","params":{"id":9,"result":"x","reason":"'))).toMatchObject({ request: 'yes', id: null });
    expect(readOversized(line('{"params":{"result":{"id":3}},"padding":"'))).toMatchObject({ request: 'maybe', id: null });
  });

  it('hands the session that reading alone: its kind, its id and its size, and none of its bytes', async () => {
    const { opening, latest, onDropped } = start();
    await settle();
    latest().drop('{"method":"item/commandExecution/requestApproval","id":5,"params":{"command":"rm -rf /"', 6 * 1024 * 1024);
    expect(onDropped).toHaveBeenCalledExactlyOnceWith({ request: 'yes', id: { kind: 'number', value: 5 }, size: 6 * 1024 * 1024 });
    expect(JSON.stringify(onDropped.mock.calls)).not.toContain('rm -rf');
    latest().pending('initialize').resolve({});
    await opening;
  });
});
