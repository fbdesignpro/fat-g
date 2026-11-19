// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V51 (docs/planning/_archive/M15.md; C84, C116): a connection that is opened once. Its real tree, its
// latch and its scope are in tests/process/managed-cleanup.test.ts; here, what it says of its end.
import { describe, expect, it, vi } from 'vitest';
import { createOpenConnection } from './connection';
import { createDiagnostics } from './diagnostics';
import { controlledProcess } from './rpc-test-support';

const close = { type: 'close', info: { code: 0, signal: null } } as const;

function setup(tuning: Parameters<typeof createOpenConnection>[0] = {}) {
  const child = controlledProcess();
  const recheck = vi.fn(() => false);
  const connection = createOpenConnection(tuning, { child: child.handle, logger: createDiagnostics(), recheck, rpc: { requestMs: 200, drainMs: 50 } });
  return { child, connection, recheck };
}

describe('a connection opened once', () => {
  it('exchanges requests, notifications and the CLI’s own requests like any connection', async () => {
    const { child, connection } = setup();
    const seen = vi.fn();
    connection.onNotification('tick', seen);
    connection.onRequest('ask', () => ({ result: 'no' }));
    const pending = connection.request('hello', { a: 1 });
    child.value({ id: 1, result: 'world' }); child.value({ method: 'tick', params: 2 }); child.value({ id: 'x', method: 'ask' });
    expect(await pending).toBe('world');
    expect(seen).toHaveBeenCalledExactlyOnceWith(2);
    expect(child.writes).toEqual([{ id: 1, method: 'hello', params: { a: 1 } }, { id: 'x', result: 'no' }]);
    await connection.notify('bye');
    expect(child.writes.at(-1)).toEqual({ method: 'bye' });
    await connection.close();
  });

  it('lets a request of the CLI’s wait for its owner’s reply, and tells that owner what became of the reply’s write (M21, V25; C66)', async () => {
    const { child, connection } = setup();
    const ids: unknown[] = [];
    connection.onRequest('ask', (_params, id) => { ids.push(id); return null; });
    child.value({ id: 0, method: 'ask', params: { q: 1 } });
    expect(ids).toEqual([0]);
    expect(child.writes).toEqual([]);
    await connection.reply(0, { result: { answers: {} } });
    expect(child.writes).toEqual([{ id: 0, result: { answers: {} } }]);
    // Refused while the connection lives: its owner is told, and the connection does not end itself for it.
    child.refuse('output-limit');
    await expect(connection.reply(0, { result: 1 })).rejects.toMatchObject({ code: 'output-limit' });
    expect(child.stopped).toBe(0);
    child.refuse(undefined);
    // Once the connection is over a reply is rejected, and nothing is written.
    child.emit(close);
    await connection.done;
    await expect(connection.reply(0, { result: 1 })).rejects.toMatchObject({ code: 'transport-closed' });
    expect(child.writes).toHaveLength(1);
  });

  it('is over when its process ends: `done` answers that the tree is gone, and nothing is started again', async () => {
    const { child, connection } = setup();
    const pending = expect(connection.request('never')).rejects.toMatchObject({ code: 'transport-closed' });
    child.emit(close);
    await pending;
    await expect(connection.done).resolves.toEqual({ ok: true });
    await expect(connection.request('again')).rejects.toMatchObject({ code: 'transport-closed' });
    await expect(connection.notify('again')).rejects.toMatchObject({ code: 'transport-closed' });
    // The one cleanup of its tree, and no second process: the child it was given is the only one.
    expect(child.stopped).toBe(1);
    await expect(connection.close()).resolves.toEqual({ ok: true });
  });

  it('answers a close with the cleanup’s own result, the same as `done`', async () => {
    const { child, connection } = setup();
    const pending = expect(connection.request('running')).rejects.toMatchObject({ code: 'disposed' });
    await expect(connection.close()).resolves.toEqual({ ok: true });
    await pending;
    await expect(connection.done).resolves.toEqual({ ok: true });
    await expect(connection.recheck()).resolves.toEqual({ ok: true });
    expect(child.stopped).toBeGreaterThan(0);
  });

  it('says so when its end cannot be confirmed, and looks again only through the tree’s read-only recheck (C116)', async () => {
    const { child, connection, recheck } = setup();
    child.setCleanup(false);
    await expect(connection.close()).resolves.toEqual({ ok: false });
    await expect(connection.done).resolves.toEqual({ ok: false });
    await expect(connection.recheck()).resolves.toEqual({ ok: false });
    expect(recheck).toHaveBeenCalledTimes(1);
    recheck.mockReturnValue(true);
    await expect(connection.recheck()).resolves.toEqual({ ok: true });
    // Confirmed once, it asks no more.
    await expect(connection.recheck()).resolves.toEqual({ ok: true });
    expect(recheck).toHaveBeenCalledTimes(2);
  });

  it('takes its line limit from its tuning (M20a, C16): a line a default connection would drop is taken, and one over it is dropped and counted', async () => {
    const onDropped = vi.fn();
    const child = controlledProcess();
    const connection = createOpenConnection({ oversizedLines: 'drop', onDropped, lineBytes: 256 }, { child: child.handle, logger: createDiagnostics(), recheck: () => true, rpc: { lineBytes: 32 } });
    const seen: unknown[] = [];
    connection.onNotification('big', (params) => { seen.push(params); });
    child.value({ method: 'big', params: 'x'.repeat(100) });
    expect(seen).toEqual(['x'.repeat(100)]);
    expect(onDropped).not.toHaveBeenCalled();
    child.value({ method: 'big', params: 'x'.repeat(400) });
    expect(seen).toHaveLength(1);
    expect(onDropped).toHaveBeenCalledTimes(1);
    await connection.close();
  });

  it('passes its tuning to the client: a line over the limit is dropped and counted, and the connection stays up (C19)', async () => {
    const onDropped = vi.fn();
    const child = controlledProcess();
    const connection = createOpenConnection({ oversizedLines: 'drop', onDropped }, { child: child.handle, logger: createDiagnostics(), recheck: () => true, rpc: { lineBytes: 32 } });
    child.value({ method: 'big', params: 'x'.repeat(100) });
    expect(onDropped).toHaveBeenCalledTimes(1);
    const next = connection.request('small'); child.value({ id: 1, result: 1 });
    expect(await next).toBe(1);
    await connection.close();
  });
});
