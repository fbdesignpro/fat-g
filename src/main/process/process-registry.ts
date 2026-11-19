// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ProcessFailure, type CleanupResult } from '@shared/provider-kit/process';

export interface OwnedProcess {
  stop(): Promise<CleanupResult>;
  emergency(timeoutMs: number): CleanupResult;
}
export function createProcessRegistry(deadlineMs = 5000) {
  const entries = new Set<OwnedProcess>();
  const stopHooks = new Set<() => Promise<CleanupResult>>();
  let closed = false;
  let cleanup: Promise<CleanupResult> | undefined;
  let emergency: CleanupResult | undefined;
  function assertOpen(): void { if (closed) throw new ProcessFailure('disposed'); }
  function closeAdmission(): void { closed = true; }
  function invoke(stop: () => Promise<CleanupResult>): Promise<CleanupResult> {
    try { return stop(); } catch { return Promise.resolve({ ok: false }); }
  }
  return {
    assertOpen,
    closeAdmission,
    register(entry: OwnedProcess): () => void {
      assertOpen();
      entries.add(entry);
      return () => entries.delete(entry);
    },
    onStop(hook: () => Promise<CleanupResult>): () => void {
      assertOpen(); stopHooks.add(hook); return () => stopHooks.delete(hook);
    },
    killAll(): Promise<CleanupResult> {
      closeAdmission();
      return cleanup ??= new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false }), deadlineMs);
        // Hooks synchronously cancel restart/startup work, before any await.
        const work = [...stopHooks].map(invoke);
        work.push(...[...entries].map((entry) => invoke(() => entry.stop())));
        void Promise.allSettled(work).then((results) => {
          clearTimeout(timer);
          resolve({ ok: results.every((r) => r.status === 'fulfilled' && r.value.ok) });
        });
      });
    },
    emergency(): CleanupResult {
      if (emergency) return emergency;
      closeAdmission();
      for (const hook of stopHooks) void invoke(hook).catch(() => {});
      const deadline = Date.now() + deadlineMs;
      let ok = true;
      for (const entry of entries) {
        if (Date.now() >= deadline) { ok = false; break; }
        try { if (!entry.emergency(Math.max(1, deadline - Date.now())).ok) ok = false; } catch { ok = false; }
      }
      return emergency = { ok };
    },
  };
}
export type ProcessRegistry = ReturnType<typeof createProcessRegistry>;
