// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnostics } from './diagnostics';
import { createRpcClient } from './rpc-client';
import { controlledProcess } from './rpc-test-support';
import type { LifecycleTraceEvent, RpcTracePolicy } from '@shared/provider-kit/lifecycle-trace';
afterEach(() => vi.useRealTimers());
const exit = { type: 'exit', info: { code: 0, signal: null } } as const;
function setup() { const child = controlledProcess(); const log = createDiagnostics(); const rpc = createRpcClient(child.handle, log, { drainMs: 100, requestMs: 200, pendingLimit: 2 }); return { child, log, rpc }; }

describe('RPC diagnostic isolation', () => {
  const policy = () => ({ operation: () => 'resume', refusal: vi.fn(() => 'active-writer' as const), notification: () => null } satisfies RpcTracePolicy);
  it('never examines error text without an enabled trace', async () => {
    const child = controlledProcess(); const tracePolicy = policy();
    const rpc = createRpcClient(child.handle, createDiagnostics(), { tracePolicy });
    const result = rpc.request('resume').catch((error: unknown) => error);
    child.value({ id: 1, error: { code: -32600, message: 'private', data: 'private' } });
    expect(await result).toMatchObject({ code: 'rpc-error', numericCode: -32600 });
    expect(tracePolicy.refusal).not.toHaveBeenCalled(); rpc.dispose();
  });
  it('correlates metadata without changing a refusal or saving params, messages or data', async () => {
    const child = controlledProcess(); const trace = vi.fn<(event: LifecycleTraceEvent) => void>();
    const rpc = createRpcClient(child.handle, createDiagnostics(undefined, undefined, trace), { tracePolicy: policy() });
    const result = rpc.request('resume', { threadId: 'private', prompt: 'private' }).catch((error: unknown) => error);
    child.value({ id: 1, error: { code: -32600, message: 'private', data: 'private' } });
    const error = await result;
    expect(error).toMatchObject({ code: 'rpc-error', numericCode: -32600 });
    expect(JSON.stringify(error)).not.toContain('private');
    expect(trace.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'request', pid: child.handle.pid, request: 1, operation: 'resume' },
      { phase: 'reply', pid: child.handle.pid, request: 1, operation: 'resume', outcome: 'rpc-error', numericCode: -32600, refusal: 'active-writer' },
    ]);
    expect(JSON.stringify(trace.mock.calls)).not.toContain('private'); rpc.dispose();
  });
  it('a broken classifier or sink cannot break a successful RPC', async () => {
    const child = controlledProcess();
    const tracePolicy = policy(); tracePolicy.operation = () => { throw Error('bad classifier'); };
    const rpc = createRpcClient(child.handle, createDiagnostics(undefined, undefined, () => { throw Error('bad sink'); }), { tracePolicy });
    const result = rpc.request('resume'); child.value({ id: 1, result: { ok: true } });
    expect(await result).toEqual({ ok: true }); rpc.dispose();
  });
});
describe('RPC lifecycle', () => {
  it('correlates out of order, preserves ID type and permits null', async () => {
    const { child, rpc } = setup();
    const a = rpc.request('a'); const b = rpc.request('b');
    child.value({ id: '1', result: 'wrong' }); child.value({ id: 2, result: null }); child.value({ id: 1, result: 'right' });
    expect(await a).toBe('right'); expect(await b).toBeNull(); rpc.dispose();
  });
  it('refuses server requests even when their IDs collide', async () => {
    const { child, rpc } = setup(); const pending = rpc.request('test');
    child.value({ id: 1, method: 'approval' });
    expect(child.writes[1]).toEqual({ id: 1, error: { code: -32601, message: 'Method not found' } });
    child.value({ id: 1, result: 8 }); expect(await pending).toBe(8); rpc.dispose();
  });
  it.each([{ id: 1 }, { id: 1, result: null, error: {} }, { id: 1, error: { message: 'secret' } }, { id: 1, method: false, result: 0 }])('rejects matching malformed response %j', async (value) => {
    const { child, rpc } = setup(); const pending = rpc.request('a'); child.value(value);
    await expect(pending).rejects.toMatchObject({ code: 'protocol-error' }); rpc.dispose();
  });
  it('discards remote error text and data', async () => {
    const { child, rpc, log } = setup(); const pending = rpc.request('a');
    child.value({ id: 1, error: { code: 42, message: 'secret', data: 'private' } });
    await expect(pending).rejects.toMatchObject({ code: 'rpc-error', numericCode: 42, message: 'rpc-error' });
    expect(JSON.stringify(log.snapshot())).not.toMatch(/secret|private/); rpc.dispose();
  });
  it('timeout removes pending slots and ignores late responses', async () => {
    vi.useFakeTimers(); const { child, rpc } = setup();
    const first = expect(rpc.request('a')).rejects.toMatchObject({ code: 'timeout' });
    const second = expect(rpc.request('b')).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(200); await first; await second;
    child.value({ id: 1, result: 'late' }); const next = rpc.request('c'); child.value({ id: 3, result: 2 }); expect(await next).toBe(2);
    rpc.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('pre-abort writes nothing and queued cancellation removes unsent bytes', async () => {
    const { child, rpc } = setup(); const abort = new AbortController(); abort.abort();
    await expect(rpc.request('a', null, { signal: abort.signal })).rejects.toMatchObject({ code: 'aborted' });
    child.pause(); const running = new AbortController(); const pending = rpc.request('b', null, { signal: running.signal }); running.abort(); child.flush();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' }); expect(child.writes).toEqual([]); rpc.dispose();
  });
  it.each([true, false])('drains final response after exit (newline=%s)', async (newline) => {
    vi.useFakeTimers(); const { child, rpc } = setup(); const pending = rpc.request('a');
    child.emit(exit); expect(rpc.available).toBe(false);
    await expect(rpc.request('late')).rejects.toMatchObject({ code: 'transport-closed' });
    await expect(rpc.notify('late')).rejects.toMatchObject({ code: 'transport-closed' });
    child.emit({ type: 'stdin-error' }); child.bytes('{"id":1,"result":"final"}' + (newline ? '\n' : '')); child.emit({ type: 'eof' });
    expect(await pending).toBe('final'); await rpc.done; expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects unsent work at exit but preserves sent work', async () => {
    const { child, rpc } = setup(); const sent = rpc.request('a'); child.pause(); const queued = rpc.request('b'); child.emit(exit);
    await expect(queued).rejects.toMatchObject({ code: 'transport-closed' }); child.flush();
    child.value({ id: 1, result: 1 }); child.emit({ type: 'eof' }); expect(await sent).toBe(1); expect(child.writes).toHaveLength(1);
  });
  it('fixed drain deadline discards a complete-looking unterminated line', async () => {
    vi.useFakeTimers(); const { child, rpc } = setup();
    const pending = expect(rpc.request('a')).rejects.toMatchObject({ code: 'transport-closed' }); child.emit(exit);
    await vi.advanceTimersByTimeAsync(90); child.bytes('{"id":1,"result":"must not parse"}');
    await vi.advanceTimersByTimeAsync(10); await pending; await rpc.done; expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['abort', 'timeout', 'dispose'] as const)('%s remains effective during drain', async (kind) => {
    vi.useFakeTimers(); const { child, rpc } = setup(); const controller = new AbortController();
    const pending = expect(rpc.request('a', null, { signal: controller.signal, timeoutMs: 50 })).rejects.toMatchObject({ code: kind === 'abort' ? 'aborted' : kind === 'dispose' ? 'disposed' : 'timeout' });
    child.emit(exit); if (kind === 'abort') controller.abort(); if (kind === 'dispose') rpc.dispose();
    await vi.advanceTimersByTimeAsync(100); await pending; rpc.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('answers a request from the CLI through its handler, and one with no handler as before (M15, C35)', () => {
    const unhandled = vi.fn();
    const child = controlledProcess(); const rpc = createRpcClient(child.handle, createDiagnostics(), { unhandled });
    const off = rpc.onRequest('approve', (params) => ({ result: { decision: 'decline', saw: params } }));
    rpc.onRequest('refuse', () => ({ error: { code: -32000, message: 'no' } }));
    rpc.onRequest('broken', () => { throw new Error('secret'); });
    child.value({ id: 'a', method: 'approve', params: { x: 1 } });
    child.value({ id: 7, method: 'refuse' });
    child.value({ id: 8, method: 'broken' });
    child.value({ id: 9, method: 'other/request' });
    off(); child.value({ id: 10, method: 'approve' });
    expect(child.writes).toEqual([
      { id: 'a', result: { decision: 'decline', saw: { x: 1 } } },
      { id: 7, error: { code: -32000, message: 'no' } },
      { id: 8, error: { code: -32601, message: 'Method not found' } },
      { id: 9, error: { code: -32601, message: 'Method not found' } },
      { id: 10, error: { code: -32601, message: 'Method not found' } },
    ]);
    // A handler that throws, and a method with none, are told to the owner; an answered one is not.
    expect(unhandled.mock.calls).toEqual([['request', 'broken'], ['request', 'other/request'], ['request', 'approve']]);
    rpc.dispose();
  });
  // M21, V25 (C66): a handler may answer later. The dispatcher writes nothing for its request, and
  // its owner writes the reply through `reply`, whose promise is the write's.
  it('hands a handler its request’s id, and writes nothing for one it defers until its owner replies (M21, C66)', async () => {
    const unhandled = vi.fn();
    const child = controlledProcess(); const rpc = createRpcClient(child.handle, createDiagnostics(), { unhandled });
    const seen: unknown[] = [];
    rpc.onRequest('now', (params, id) => { seen.push(['now', id, params]); return { result: 'at once' }; });
    rpc.onRequest('later', (params, id) => { seen.push(['later', id, params]); return null; });
    child.value({ id: 3, method: 'now', params: 1 });
    child.value({ id: 'q-1', method: 'later', params: { a: 1 } });
    child.value({ id: 0, method: 'later' });
    // One that replies at once is served as before; nothing at all is written for the two deferred.
    expect(child.writes).toEqual([{ id: 3, result: 'at once' }]);
    expect(seen).toEqual([['now', 3, 1], ['later', 'q-1', { a: 1 }], ['later', 0, undefined]]);
    // A deferred request is answered, only later: its owner is told of nothing unhandled.
    expect(unhandled).not.toHaveBeenCalled();
    // The reply names the request's own id, a number as a number and a string as a string.
    await expect(rpc.reply(0, { result: { answers: {} } })).resolves.toBeUndefined();
    await rpc.reply('q-1', { error: { code: -32601, message: 'Method not found' } });
    expect(child.writes.slice(1)).toEqual([{ id: 0, result: { answers: {} } }, { id: 'q-1', error: { code: -32601, message: 'Method not found' } }]);
    rpc.dispose();
  });
  it('resolves a reply when its line was handed to the process, and no sooner', async () => {
    const { child, rpc } = setup();
    rpc.onRequest('later', () => null);
    child.value({ id: 5, method: 'later' });
    child.pause();
    let went = false;
    const reply = rpc.reply(5, { result: 1 }).then(() => { went = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(went).toBe(false); expect(child.writes).toEqual([]);
    child.flush(); await reply;
    expect(went).toBe(true); expect(child.writes).toEqual([{ id: 5, result: 1 }]);
    rpc.dispose();
  });
  it('gives two requests of the same id to the handler, each as it comes', () => {
    const { child, rpc } = setup(); const ids: unknown[] = [];
    rpc.onRequest('later', (_params, id) => { ids.push(id); return null; });
    child.value({ id: 7, method: 'later' }); child.value({ id: 7, method: 'later' });
    expect(ids).toEqual([7, 7]); expect(child.writes).toEqual([]);
    rpc.dispose();
  });
  it('rejects a reply as a send is rejected, and writes nothing: the process refused the line, it exited, or the connection finished (M21, V23, V25)', async () => {
    const { child, rpc } = setup();
    rpc.onRequest('later', () => null);
    child.value({ id: 1, method: 'later' });
    // Its queue is full: the process lives, and so does the connection.
    child.refuse('output-limit');
    await expect(rpc.reply(1, { result: 1 })).rejects.toMatchObject({ code: 'output-limit' });
    expect(rpc.available).toBe(true);
    // Its pipe is gone.
    child.refuse('transport-closed');
    await expect(rpc.reply(1, { result: 1 })).rejects.toMatchObject({ code: 'transport-closed' });
    // It has exited: the write is not tried.
    child.refuse(undefined); child.emit(exit);
    await expect(rpc.reply(1, { result: 1 })).rejects.toMatchObject({ code: 'transport-closed' });
    expect(child.writes).toEqual([]);

    const finished = setup();
    finished.rpc.onRequest('later', () => null);
    finished.child.value({ id: 2, method: 'later' });
    finished.rpc.dispose();
    await expect(finished.rpc.reply(2, { result: 1 })).rejects.toMatchObject({ code: 'transport-closed' });
    expect(finished.child.writes).toEqual([]);
  });
  it('hands a handler null for an id no later reply could name, and writes a reply given at once only under an id of the protocol’s kinds', () => {
    const { child, rpc } = setup(); const ids: unknown[] = [];
    rpc.onRequest('now', (_params, id) => { ids.push(id); return { result: true }; });
    child.value({ id: null, method: 'now' }); child.value({ id: { nested: 1 }, method: 'now' }); child.value({ id: true, method: 'now' });
    expect(ids).toEqual([null, null, null]);
    // As before: a null id is answered under null, and an id that is none gets no line.
    expect(child.writes).toEqual([{ id: null, result: true }]);
    rpc.dispose();
  });
  it('tells its owner of a notification nobody subscribed to, and of none that somebody did (C37)', () => {
    const unhandled = vi.fn();
    const child = controlledProcess(); const rpc = createRpcClient(child.handle, createDiagnostics(), { unhandled });
    rpc.onNotification('known', () => {});
    child.value({ method: 'known', params: 1 }); child.value({ method: 'remoteControl/status/changed', params: { serverName: 'private-host' } });
    expect(unhandled.mock.calls).toEqual([['notification', 'remoteControl/status/changed']]);
    rpc.dispose();
  });
  it('allows a larger pending history reply alone and resets the budget for later replies and requests', async () => {
    vi.useFakeTimers();
    const child = controlledProcess(); const onDropped = vi.fn();
    const rpc = createRpcClient(child.handle, createDiagnostics(), { requestMs: 200, lineBytes: 64, largeReplyBytes: { history: 512 }, oversizedLines: 'drop', onDropped });
    const history = rpc.request('history');
    child.value({ id: 1, result: 'x'.repeat(200) });
    expect(await history).toBe('x'.repeat(200));
    expect(onDropped).not.toHaveBeenCalled();
    const account = expect(rpc.request('account')).rejects.toMatchObject({ code: 'timeout' });
    child.value({ id: 2, result: 'x'.repeat(200) });
    await vi.advanceTimersByTimeAsync(200); await account;
    expect(onDropped).toHaveBeenCalledTimes(1);
    // An id that already settled cannot acquire another large reply allowance.
    child.value({ id: 1, result: 'x'.repeat(200) });
    expect(onDropped).toHaveBeenCalledTimes(2);
    const next = rpc.request('history');
    child.value({ id: 3, method: 'unexpected', params: 'x'.repeat(200) });
    expect(onDropped).toHaveBeenCalledTimes(3);
    child.value({ id: 3, result: 'ok' });
    expect(await next).toBe('ok');
    rpc.dispose();
  });

  it('drops a line over the limit and stays up, when asked to: the lost reply runs to its deadline and nothing is sent again (C19, C88)', async () => {
    vi.useFakeTimers();
    const onDropped = vi.fn(); const log = createDiagnostics();
    const child = controlledProcess(); const rpc = createRpcClient(child.handle, log, { requestMs: 200, lineBytes: 64, oversizedLines: 'drop', onDropped });
    const lost = expect(rpc.request('big')).rejects.toMatchObject({ code: 'timeout' });
    child.value({ id: 1, result: 'x'.repeat(200) });
    expect(onDropped).toHaveBeenCalledTimes(1); expect(rpc.available).toBe(true); expect(child.stopped).toBe(0);
    expect(log.snapshot()).toEqual([{ type: 'frame-dropped', reason: 'oversized' }]);
    const next = rpc.request('small'); child.value({ id: 2, result: 'ok' }); expect(await next).toBe('ok');
    await vi.advanceTimersByTimeAsync(200); await lost;
    expect(child.writes.map((write) => write['method'])).toEqual(['big', 'small']);
    rpc.dispose();
  });
  it('ends the connection on a line over the limit when it was not asked to drop it', async () => {
    const child = controlledProcess(); const rpc = createRpcClient(child.handle, createDiagnostics(), { lineBytes: 64 });
    const pending = expect(rpc.request('big')).rejects.toMatchObject({ code: 'protocol-error' });
    child.value({ id: 1, result: 'x'.repeat(200) });
    await pending; expect(child.stopped).toBe(1); expect(rpc.available).toBe(false);
  });
  it('isolates subscribers, detaches them, and rejects pending overflow', async () => {
    const { child, rpc } = setup(); const callback = vi.fn(); rpc.onNotification('tick', () => { throw new Error('secret'); }); const off = rpc.onNotification('tick', callback);
    child.value({ method: 'tick', params: 1 }); off(); child.value({ method: 'tick', params: 2 }); expect(callback).toHaveBeenCalledExactlyOnceWith(1);
    const a = rpc.request('a').catch(() => {}); const b = rpc.request('b').catch(() => {});
    await expect(rpc.request('overflow')).rejects.toMatchObject({ code: 'output-limit' }); rpc.dispose(); await Promise.all([a, b]);
  });
});
