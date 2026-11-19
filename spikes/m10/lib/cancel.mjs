// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Cancellation: Ctrl+C and the invocation budget share one path (Design 1). The spike's own code
// reacts to `signal`, runs its teardown, then exits 130.
import { INVOCATION_BUDGET } from './deadlines.mjs';

const SIGNALS = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * `budgetMs: 0` disables the budget (self-tests drive cancellation in code instead). A second
 * Ctrl+C does not force an exit: cleanup is bounded by the shutdown wait anyway, and an exit in
 * the middle of it is exactly what the launch record exists to survive.
 */
export function createCancellation({ budgetMs = INVOCATION_BUDGET, onSignalAgain } = {}) {
  const controller = new AbortController();
  const handlers = [];
  for (const name of SIGNALS) {
    const handler = () => {
      if (controller.signal.aborted) { onSignalAgain?.(name); return; }
      controller.abort(`signal ${name}`);
    };
    try {
      process.on(name, handler);
      handlers.push([name, handler]);
    } catch { /* signal not supported on this platform */ }
  }
  const budget = budgetMs > 0 ? setTimeout(() => controller.abort(`invocation budget of ${budgetMs} ms`), budgetMs) : undefined;
  budget?.unref?.();
  return {
    signal: controller.signal,
    /** Cancels from code, as a signal would. */
    cancel(reason = 'cancelled in code') { if (!controller.signal.aborted) controller.abort(reason); },
    dispose() {
      clearTimeout(budget);
      for (const [name, handler] of handlers) process.off(name, handler);
    },
  };
}
