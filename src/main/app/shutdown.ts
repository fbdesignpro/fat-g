// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The normal quit's drain, and the emergency path (docs/planning/_archive/M15.md, Design 11; M14, C75; M15,
// C117, C118; M18, C45). Electron-free: `quitSteps` names what the app's quit does, in its order, and the
// tests run the very steps the app runs.
import type { CleanupResult } from '@shared/provider-kit/process';
import { DRAFT_FLUSH_WAIT_MS } from './draft-flush';
import type { ProviderRegistry } from '../services/provider-registry';
import type { SessionRuntime } from '../sessions/runtime';
import type { SessionService } from '../sessions/service';

export interface ShutdownDependencies {
  /** Step 0: stops new work. Ends no runtime and no process. */
  beginQuit(): void;
  closeAdmission(): void;
  /**
   * Steps 1 to 3, before any process tree is asked to end: each running session is stopped and its
   * end awaited, then the turns still running are written stopped and the writes awaited. Each step
   * bounds itself; a failure is that step's to log, and holds nothing.
   */
  settle?(): Promise<void>;
  /** The most `settle` may take before the trees are asked to end whatever it is doing. */
  settleMs?: number;
  /** Step 4: every runtime disposed, and every process tree ended. */
  killAll(): Promise<CleanupResult>;
  emergency(): CleanupResult;
  resumeQuit(): void;
  failure(): void;
  deadlineMs?: number;
}

/** Electron will not await event handlers: prevent once, then re-enter quit after cleanup. */
export function createShutdown(deps: ShutdownDependencies) {
  let state: 'running' | 'draining' | 'ready' = 'running';
  let emergency = false;
  let done: Promise<CleanupResult> | undefined;
  function start(): Promise<CleanupResult> {
    if (done) return done;
    state = 'draining'; deps.beginQuit(); deps.closeAdmission();
    const deadlineMs = deps.deadlineMs ?? 5000;
    done = new Promise((resolve) => {
      const timer = setTimeout(() => finish({ ok: false }), deadlineMs);
      let settled = false;
      function finish(result: CleanupResult): void {
        if (settled) return;
        settled = true; clearTimeout(timer); state = 'ready';
        if (!result.ok) deps.failure();
        resolve(result);
      }
      // A record left without an end reads the same at the next launch (M14, C74), so a failure
      // while the sessions settle never fails the cleanup. And the trees are always asked to end:
      // a settling that does not answer in its time is left behind (C118).
      const settling = (async () => { try { await deps.settle?.(); } catch { /* the step logs its own */ } })();
      let bound: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<void>((resolveLimit) => { bound = setTimeout(resolveLimit, deps.settleMs ?? deadlineMs); });
      void Promise.race([settling, limit]).then(() => {
        clearTimeout(bound);
        try { void deps.killAll().then((result) => finish(result), () => finish({ ok: false })); } catch { finish({ ok: false }); }
      });
    });
    return done;
  }
  let resuming = false;
  return {
    get quitting() { return state !== 'running'; },
    get readyToQuit() { return state === 'ready'; },
    beforeQuit(event: { preventDefault(): void }) {
      if (state === 'ready') return;
      event.preventDefault();
      const cleanup = start();
      if (!resuming) { resuming = true; void cleanup.then(() => deps.resumeQuit()); }
    },
    cleanup: start,
    emergency() {
      if (emergency) return;
      emergency = true; state = 'ready'; deps.beginQuit(); deps.closeAdmission();
      if (!deps.emergency().ok) deps.failure();
    },
  };
}

/** How long the sessions' Stops have, in all (C117). */
export const QUIT_STOP_WAIT_MS = 5000;
/** How long the writes still pending have, once the Stops have had theirs (C118). */
export const QUIT_WRITE_WAIT_MS = 2000;
/** What the process layer's `killAll` has. */
export const QUIT_KILL_MS = 5000;
/** The drain's deadline: the sum of its steps' times. */
export const QUIT_DEADLINE_MS = QUIT_STOP_WAIT_MS + QUIT_WRITE_WAIT_MS + QUIT_KILL_MS;

export interface QuitParts {
  readonly providers: Pick<ProviderRegistry, 'quiesce' | 'dispose'>;
  readonly runtime: Pick<SessionRuntime, 'stopAll'>;
  readonly sessions: Pick<SessionService, 'endRunningTurns'>;
  readonly processes: { closeAdmission(): void; killAll(): Promise<CleanupResult>; emergency(): CleanupResult };
  /**
   * The conversation store (M18, C45): closed in the last step, once the runtimes are disposed. A
   * close that did not happen leaves a store the next launch opens as after a crash.
   */
  readonly conversations?: { close(): void };
  /**
   * The page's unsent drafts (M23, C31): asked for first in step 1, before the Stops, so main holds
   * them when it writes every draft. Bounded by its own wait; a page already gone answers at once.
   */
  readonly drafts?: { flush(): Promise<void> };
  /** Returned-image writes finish before their conversation store closes. */
  readonly images?: { flush(): Promise<void> };
  /** The demo source, when one runs: it stops at step 0. */
  readonly demo?: () => { stop(): void } | undefined;
  readonly windows: { beginQuit(): void };
  /** Whatever else stops new work at step 0: the power monitor's hooks, for one. */
  readonly beforeQuit?: () => void;
  readonly resumeQuit: () => void;
  readonly failure: () => void;
  /** The steps' times; a test shortens them. */
  readonly waits?: { readonly stopMs?: number; readonly writeMs?: number; readonly killMs?: number; readonly draftsMs?: number };
}

/**
 * The quit, in its order (Design 11). 0: new work stops — the registry is quiesced, admission
 * closed — and nothing is ended. 1: the Main page hands over the drafts it has not (M23, C31), a
 * second at most. 1–2: each running session is stopped, and the quit waits up to five
 * seconds for every turn to end; one that ends in time keeps its own outcome. 3: the turns still
 * running are written stopped, to the record and to the conversation store, and every pending
 * write is awaited, two seconds at most. 4: the runtimes are disposed and every process tree ended,
 * whatever became of step 3's writes, and the conversation store is closed once the runtimes have
 * answered: nothing writes to it after them.
 */
export function quitSteps(parts: QuitParts): ShutdownDependencies {
  const stopMs = parts.waits?.stopMs ?? QUIT_STOP_WAIT_MS;
  const writeMs = parts.waits?.writeMs ?? QUIT_WRITE_WAIT_MS;
  const killMs = parts.waits?.killMs ?? QUIT_KILL_MS;
  const draftsMs = parts.drafts === undefined ? 0 : parts.waits?.draftsMs ?? DRAFT_FLUSH_WAIT_MS;
  return {
    beginQuit: () => {
      parts.beforeQuit?.();
      parts.providers.quiesce();
      parts.demo?.()?.stop();
      parts.windows.beginQuit();
    },
    closeAdmission: () => parts.processes.closeAdmission(),
    async settle() {
      try { await parts.drafts?.flush(); } catch { /* the page's drafts are its own loss */ }
      try { await parts.runtime.stopAll(stopMs); } finally { await parts.sessions.endRunningTurns(writeMs); }
    },
    // Steps 1 to 3 are bounded; this bound is theirs together, with a margin, should any not keep to its own.
    settleMs: draftsMs + stopMs + writeMs + 500,
    async killAll() {
      const disposed = parts.providers.dispose().catch(() => undefined).then(async () => { await parts.images?.flush(); parts.conversations?.close(); });
      const [, result] = await Promise.all([disposed, parts.processes.killAll()]);
      return result;
    },
    emergency: () => parts.processes.emergency(),
    resumeQuit: parts.resumeQuit,
    failure: parts.failure,
    deadlineMs: draftsMs + stopMs + writeMs + killMs,
  };
}
