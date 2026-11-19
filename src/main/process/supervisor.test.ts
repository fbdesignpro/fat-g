// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnostics } from './diagnostics';
import { createSupervisor } from './supervisor';
import { controlledProcess } from './rpc-test-support';
import type { RpcConnection } from '@shared/provider-kit/rpc';
afterEach(() => vi.useRealTimers());
function setup(handshake: (rpc: RpcConnection, signal: AbortSignal) => Promise<void> = () => Promise.resolve()) {
  const children: ReturnType<typeof controlledProcess>[] = [];
  const spawn = vi.fn(() => { const child = controlledProcess(); children.push(child); return Promise.resolve(child.handle); });
  const supervisor = createSupervisor({ executable: { path: '/fake', kind: 'native' }, args: [], options: { cwd: '/tmp' }, handshake,
    policy: { baseDelayMs: 100, maxDelayMs: 3000, failureLimit: 3, healthyMs: 6000, cooldownMs: 1000, handshakeMs: 100 } }, { spawn, logger: createDiagnostics(), random: () => 0.5 });
  return { children, spawn, supervisor };
}
describe('supervision', () => {
  it('forwards the bounded allowance for pending history replies to its transport', async () => {
    const child = controlledProcess();
    const supervisor = createSupervisor({ executable: { path: '/fake', kind: 'native' }, args: [], options: { cwd: '/tmp' }, handshake: () => Promise.resolve(), lineBytes: 64, largeReplyBytes: { history: 512 } }, { spawn: () => Promise.resolve(child.handle), logger: createDiagnostics() });
    await supervisor.connect();
    const reply = supervisor.request('history');
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));
    child.value({ id: 1, result: 'x'.repeat(200) });
    expect(await reply).toBe('x'.repeat(200));
    await supervisor.dispose();
  });

  it('caller abort leaves shared startup alive and concurrent reset shares one replacement', async () => {
    let ready!: () => void;
    const { supervisor, spawn } = setup(() => new Promise<void>((resolve) => { ready = resolve; }));
    const controller = new AbortController(); const caller = supervisor.request('a', null, { signal: controller.signal }); const connect = supervisor.connect();
    await Promise.resolve(); await Promise.resolve(); controller.abort(); await expect(caller).rejects.toMatchObject({ code: 'aborted' });
    ready(); await connect; expect(supervisor.state).toBe('ready');
    const a = supervisor.restart(); const b = supervisor.restart(); expect(a).toBe(b);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2)); ready(); await a;
    expect(supervisor.state).toBe('ready'); await supervisor.dispose();
  });
  it('disposal during spawn awaits the acquired child and reports failed cleanup', async () => {
    let acquired!: (child: ReturnType<typeof controlledProcess>['handle']) => void;
    const child = controlledProcess(); child.setCleanup(false);
    const supervisor = createSupervisor({ executable: { path: '/fake', kind: 'native' }, args: [], options: { cwd: '/tmp' }, handshake: () => Promise.resolve() },
      { spawn: () => new Promise((resolve) => { acquired = resolve; }), logger: createDiagnostics() });
    const connect = expect(supervisor.connect()).rejects.toMatchObject({ code: 'disposed' }); const disposal = supervisor.dispose(); acquired(child.handle);
    expect(await disposal).toEqual({ ok: false }); await connect; expect(child.stopped).toBe(1);
  });
  it('is lazy, shares startup, gates on handshake, retains one subscription', async () => {
    let ready!: () => void;
    const handshake = vi.fn(() => new Promise<void>((r) => { ready = r; }));
    const { supervisor, spawn, children } = setup(handshake); const callback = vi.fn(); supervisor.onNotification('tick', callback);
    expect(spawn).not.toHaveBeenCalled(); const a = supervisor.connect(); const b = supervisor.connect(); expect(a).toBe(b);
    await Promise.resolve(); await Promise.resolve(); expect(supervisor.state).toBe('starting'); ready(); await a;
    children[0]!.value({ method: 'tick', params: 1 }); expect(callback).toHaveBeenCalledExactlyOnceWith(1); await supervisor.dispose();
  });
  it('recovers after drain and cleanup, does not replay and preserves subscriptions', async () => {
    vi.useFakeTimers(); const { supervisor, children, spawn } = setup(); const callback = vi.fn(); supervisor.onNotification('tick', callback);
    const rpc = await supervisor.connect(); const pending = rpc.request('work'); const child = children[0]!;
    child.emit({ type: 'exit', info: { code: 1, signal: null } }); await vi.advanceTimersByTimeAsync(20); expect(spawn).toHaveBeenCalledTimes(1);
    child.value({ id: 1, result: 'final' }); child.emit({ type: 'eof' }); expect(await pending).toBe('final');
    await vi.advanceTimersByTimeAsync(100); expect(spawn).toHaveBeenCalledTimes(2); expect(child.stopped).toBe(1);
    children[1]!.value({ method: 'tick', params: 2 }); expect(callback).toHaveBeenCalledExactlyOnceWith(2); expect(children[1]!.writes).toEqual([]);
    await supervisor.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('brief successes accumulate failures, open circuit and wait for explicit half-open', async () => {
    vi.useFakeTimers(); const { supervisor, children, spawn } = setup(); await supervisor.connect();
    for (let i = 0; i < 3; i++) { children[i]!.emit({ type: 'eof' }); await vi.advanceTimersByTimeAsync(i === 0 ? 100 : 200); }
    expect(supervisor.state).toBe('circuit-open'); await expect(supervisor.connect()).rejects.toMatchObject({ code: 'circuit-open' });
    await vi.advanceTimersByTimeAsync(1000); expect(spawn).toHaveBeenCalledTimes(3); await supervisor.connect(); expect(spawn).toHaveBeenCalledTimes(4); await supervisor.dispose();
  });
  it('times out hanging handshakes and cancels scheduled retry on disposal', async () => {
    vi.useFakeTimers(); const { supervisor, spawn, children } = setup(() => new Promise(() => {}));
    const pending = expect(supervisor.connect()).rejects.toMatchObject({ code: 'timeout' }); await vi.advanceTimersByTimeAsync(100); await pending;
    expect(children[0]!.stopped).toBe(1); expect(supervisor.state).toBe('backoff'); await supervisor.dispose(); await vi.advanceTimersByTimeAsync(10000); expect(spawn).toHaveBeenCalledTimes(1); expect(supervisor.state).toBe('disposed');
  });
  it('does not replace a generation with unconfirmed cleanup', async () => {
    vi.useFakeTimers(); const { supervisor, children, spawn } = setup(); await supervisor.connect(); children[0]!.setCleanup(false); children[0]!.emit({ type: 'eof' });
    await vi.advanceTimersByTimeAsync(10000); expect(spawn).toHaveBeenCalledTimes(1); await expect(supervisor.restart()).rejects.toMatchObject({ code: 'cleanup-failed' });
    expect((await supervisor.dispose()).ok).toBe(false);
  });
  it('disposal interrupts a shared startup and late handshake cannot revive it', async () => {
    let ready!: () => void; const { supervisor } = setup(() => new Promise<void>((r) => { ready = r; }));
    const pending = expect(supervisor.connect()).rejects.toMatchObject({ code: 'disposed' }); await Promise.resolve(); await Promise.resolve();
    await supervisor.dispose(); ready(); await pending; expect(supervisor.state).toBe('disposed');
  });

  it('reports lifecycle changes and ignores obsolete unhealthy generations', async () => {
    vi.useFakeTimers();
    const { supervisor, spawn, children } = setup();
    const states: string[] = [];
    const detach = supervisor.onState(({ state, generation }) => states.push(`${generation}:${state}`));
    await supervisor.connect();
    const first = supervisor.generation;

    await supervisor.reportUnhealthy(first);
    expect(children[0]!.stopped).toBe(1);
    expect(supervisor.state).toBe('backoff');
    await supervisor.reportUnhealthy(first - 1);
    expect(children[0]!.stopped).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(supervisor.state).toBe('ready'));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(supervisor.generation).toBeGreaterThan(first);
    expect(states).toContain(`${first}:stopping`);
    expect(states).toContain(`${first}:backoff`);
    expect(states.at(-1)).toBe(`${supervisor.generation}:ready`);

    detach();
    await supervisor.dispose();
  });

  it('counts reported hangs across long-idle replacements until the circuit opens', async () => {
    vi.useFakeTimers();
    const { supervisor, spawn } = setup();
    await supervisor.connect();

    for (let failure = 1; failure <= 3; failure += 1) {
      // A handshake and a long idle are not proof that application requests are responsive.
      await vi.advanceTimersByTimeAsync(7000);
      await supervisor.reportUnhealthy(supervisor.generation);
      if (failure < 3) {
        expect(supervisor.state).toBe('backoff');
        await vi.advanceTimersByTimeAsync(100 * 2 ** (failure - 1));
        await vi.waitFor(() => expect(supervisor.state).toBe('ready'));
      }
    }

    expect(supervisor.state).toBe('circuit-open');
    expect(spawn).toHaveBeenCalledTimes(3);
    await supervisor.dispose();
  });

  it('resets reported-hang history only after an application response', async () => {
    vi.useFakeTimers();
    const { supervisor, spawn } = setup();
    await supervisor.connect();
    await supervisor.reportUnhealthy(supervisor.generation);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(supervisor.state).toBe('ready'));

    supervisor.markResponsive(supervisor.generation);
    await supervisor.reportUnhealthy(supervisor.generation);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(supervisor.state).toBe('ready'));

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(supervisor.state).toBe('ready');
    await supervisor.dispose();
  });
});
