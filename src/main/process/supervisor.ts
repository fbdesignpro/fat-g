// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { DiagnosticLogger } from '@shared/provider-kit/logger';
import { ProcessFailure, type CleanupResult, type ManagedProcess } from '@shared/provider-kit/process';
import type { RpcConnection, SupervisedConnection, SupervisorOptions, SupervisorState } from '@shared/provider-kit/rpc';
import { createRpcClient, type RpcClient } from './rpc-client';

export interface SupervisorDependencies {
  spawn(): Promise<ManagedProcess>;
  logger: DiagnosticLogger;
  now?: () => number;
  random?: () => number;
  rpc?: (child: ManagedProcess) => RpcClient;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}
/** At most one generation exists. Its drain AND tree cleanup precede replacement. */
export function createSupervisor(options: SupervisorOptions, deps: SupervisorDependencies): SupervisedConnection {
  const policy = { handshakeMs: 10_000, baseDelayMs: 1000, maxDelayMs: 30_000, failureLimit: 5, healthyMs: 60_000, cooldownMs: 60_000, ...options.policy };
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let state: SupervisorState = 'idle';
  let generation = 0;
  let failures = 0;
  let openUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt: Promise<RpcConnection> | undefined;
  let child: ManagedProcess | undefined;
  let rpc: RpcClient | undefined;
  let controller: AbortController | undefined;
  let cleanup: Promise<CleanupResult> | undefined;
  let disposal: Promise<CleanupResult> | undefined;
  let resetting: Promise<RpcConnection> | undefined;
  let reporting: Promise<void> | undefined;
  let readyAt: number | undefined;
  const subscriptions = new Map<string, Set<(params: unknown) => void>>();
  const attachments = new Map<string, () => void>();
  const lifecycle = new Set<(event: { state: SupervisorState; generation: number }) => void>();
  function change(next: SupervisorState): void {
    state = next;
    for (const listener of lifecycle) {
      try { listener({ state, generation }); } catch { /* isolate consumer errors */ }
    }
  }
  function attach(method: string, connection: RpcClient, tag: number): void {
    if (attachments.has(method)) return;
    attachments.set(method, connection.onNotification(method, (params) => {
      if (tag !== generation) return;
      for (const callback of subscriptions.get(method) ?? []) { try { callback(params); } catch { /* isolate consumer errors */ } }
    }));
  }
  function stopGeneration(): Promise<CleanupResult> {
    controller?.abort(); rpc?.dispose();
    for (const detach of attachments.values()) detach();
    attachments.clear();
    return cleanup ??= child ? child.stop() : Promise.resolve({ ok: true });
  }
  function schedule(reportedHang = false): void {
    if (state === 'disposed' || state === 'stopping') return;
    if (!reportedHang && readyAt !== undefined && now() - readyAt >= policy.healthyMs) failures = 0;
    readyAt = undefined;
    failures++;
    if (failures >= policy.failureLimit) { change('circuit-open'); openUntil = now() + policy.cooldownMs; return; }
    change('backoff');
    const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failures - 1) * (0.8 + Math.min(1, Math.max(0, random())) * 0.4));
    deps.logger.record({ type: 'restart-scheduled', attempt: failures, delayMs });
    timer = setTimer(() => { timer = undefined; change('idle'); void connect().catch(() => {}); }, delayMs);
  }
  async function recover(tag: number, connection: RpcClient): Promise<void> {
    await connection.done;
    if (tag !== generation || state === 'disposed' || state === 'stopping' || state === 'starting') return;
    change('stopping');
    const result = await stopGeneration();
    if (tag !== generation || disposal) return;
    if (!result.ok) { change('circuit-open'); openUntil = Infinity; return; }
    child = undefined; rpc = undefined; change('idle'); schedule();
  }
  function connect(): Promise<RpcConnection> {
    if (state === 'disposed' || disposal) return Promise.reject(new ProcessFailure('disposed'));
    if (state === 'ready' && rpc?.available) return Promise.resolve(rpc);
    if (attempt) return attempt;
    if (state === 'ready' || state === 'stopping') return Promise.reject(new ProcessFailure('transport-closed'));
    if (state === 'backoff') return Promise.reject(new ProcessFailure('transport-closed'));
    if (state === 'circuit-open' && now() < openUntil) return Promise.reject(new ProcessFailure('circuit-open'));
    const tag = ++generation;
    change('starting');
    controller = new AbortController();
    const signal = controller.signal;
    cleanup = undefined;
    attempt = (async () => {
      try {
        const spawned = await deps.spawn();
        if (tag !== generation || signal.aborted) {
          cleanup = spawned.stop();
          await cleanup;
          throw new ProcessFailure('disposed');
        }
        child = spawned;
        const connection = deps.rpc?.(spawned) ?? createRpcClient(spawned, deps.logger, { oversizedLines: options.oversizedLines, onDropped: options.onDropped, unhandled: options.unhandled, lineBytes: options.lineBytes, largeReplyBytes: options.largeReplyBytes });
        rpc = connection;
        for (const method of subscriptions.keys()) attach(method, connection, tag);
        let release = () => {};
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new ProcessFailure('disposed'));
            const timeout = setTimer(() => reject(new ProcessFailure('timeout')), policy.handshakeMs);
            signal.addEventListener('abort', abort, { once: true });
            release = () => { clearTimer(timeout); signal.removeEventListener('abort', abort); };
            void Promise.resolve().then(() => options.handshake(connection, signal)).then(resolve, () => reject(new ProcessFailure('protocol-error')));
            void connection.done.then(() => reject(new ProcessFailure('transport-closed')));
          });
        } finally { release(); }
        if (signal.aborted || tag !== generation || !connection.available) throw new ProcessFailure('transport-closed');
        change('ready'); readyAt = now();
        void recover(tag, connection);
        return connection;
      } catch (error) {
        const result = await stopGeneration();
        if (tag === generation && !disposal) {
          change('idle');
          if (!result.ok) { change('circuit-open'); openUntil = Infinity; } else schedule();
        }
        throw error instanceof ProcessFailure ? error : new ProcessFailure('spawn-failed');
      } finally { if (tag === generation) attempt = undefined; }
    })();
    return attempt;
  }
  async function dispose(): Promise<CleanupResult> {
    if (disposal) return disposal;
    change('disposed'); clearTimer(timer); controller?.abort(); rpc?.dispose();
    disposal = (async () => {
      await attempt?.catch(() => {});
      const result = await stopGeneration(); subscriptions.clear(); lifecycle.clear(); return result;
    })();
    return disposal;
  }
  function restart(): Promise<RpcConnection> {
    if (resetting) return resetting;
    const work = async () => {
      if (disposal) throw new ProcessFailure('disposed');
      generation++; // Invalidate recovery callbacks before closing this generation.
      change('stopping'); clearTimer(timer); controller?.abort(); rpc?.dispose();
      await attempt?.catch(() => {});
      const result = await stopGeneration();
      if (!result.ok) { change('circuit-open'); openUntil = Infinity; throw new ProcessFailure('cleanup-failed'); }
      if (disposal) throw new ProcessFailure('disposed');
      generation++; attempt = undefined; rpc = undefined; child = undefined; failures = 0; readyAt = undefined; change('idle');
      return connect();
    };
    resetting = work().finally(() => { resetting = undefined; });
    return resetting;
  }
  return {
    get state() { return state; },
    get generation() { return generation; },
    connect, dispose, restart,
    onState(listener) {
      if (disposal) return () => {};
      lifecycle.add(listener);
      return () => lifecycle.delete(listener);
    },
    markResponsive(tag) {
      if (tag !== generation || state !== 'ready') return;
      failures = 0;
      readyAt = now();
    },
    reportUnhealthy(tag) {
      if (reporting) return reporting;
      if (tag !== generation || state !== 'ready' || disposal) return Promise.resolve();
      const connection = rpc;
      if (connection === undefined) return Promise.resolve();
      const work = async (): Promise<void> => {
        change('stopping');
        controller?.abort();
        connection.dispose();
        const result = await stopGeneration();
        if (tag !== generation || disposal) return;
        if (!result.ok) { change('circuit-open'); openUntil = Infinity; return; }
        child = undefined; rpc = undefined; change('idle'); schedule(true);
      };
      reporting = work().finally(() => { reporting = undefined; });
      return reporting;
    },
    async request(method, params, requestOptions) {
      if (requestOptions?.signal?.aborted) throw new ProcessFailure('aborted');
      const signal = requestOptions?.signal;
      const starting = connect();
      // A caller may leave a shared startup without cancelling it for everyone else.
      const connection = signal ? await new Promise<RpcConnection>((resolve, reject) => {
        const abort = () => reject(new ProcessFailure('aborted'));
        signal.addEventListener('abort', abort, { once: true });
        void starting.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error: unknown) => { signal.removeEventListener('abort', abort); reject(error instanceof ProcessFailure ? error : new ProcessFailure('spawn-failed')); });
      }) : await starting;
      return connection.request(method, params, requestOptions);
    },
    async notify(method, params) { return (await connect()).notify(method, params); },
    onNotification(method, callback) {
      if (disposal) return () => {};
      let set = subscriptions.get(method);
      if (!set) { set = new Set(); subscriptions.set(method, set); }
      set.add(callback);
      if (rpc) attach(method, rpc, generation);
      return () => {
        set.delete(callback);
        if (!set.size) { subscriptions.delete(method); attachments.get(method)?.(); attachments.delete(method); }
      };
    },
  };
}
