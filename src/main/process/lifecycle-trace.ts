// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { TRACE_OPERATIONS, TRACE_OUTCOMES, TRACE_PHASES, type LifecycleTrace } from '@shared/provider-kit/lifecycle-trace';

export const lifecycleTraceEnabled = (isPackaged: boolean, setting: string | undefined): boolean => !isPackaged && setting === '1';

/** Console only. An external diagnostic launcher can save these lines and survive an app crash. */
export function createLifecycleTrace(enabled: boolean, appPid: number, write: (line: string) => void, now: () => number = Date.now): LifecycleTrace | undefined {
  if (!enabled) return undefined;
  const began = now();
  return (event) => {
    try {
      if (!TRACE_PHASES.includes(event.phase)) return;
      const at = now();
      const safe: Record<string, string | number | boolean | null> = { version: 1, at, elapsedMs: at - began, appPid, phase: event.phase, pid: Number.isSafeInteger(event.pid) && event.pid! > 0 ? event.pid! : null };
      if (Number.isSafeInteger(event.request) && event.request! > 0) safe['request'] = event.request!;
      if (event.operation !== undefined && TRACE_OPERATIONS.includes(event.operation)) safe['operation'] = event.operation;
      if (event.outcome !== undefined && TRACE_OUTCOMES.includes(event.outcome)) safe['outcome'] = event.outcome;
      if (event.numericCode === null || Number.isSafeInteger(event.numericCode)) safe['numericCode'] = event.numericCode!;
      if (event.refusal === 'active-writer' || event.refusal === 'other') safe['refusal'] = event.refusal;
      if (typeof event.ok === 'boolean') safe['ok'] = event.ok;
      write(`[fatg-trace] ${JSON.stringify(safe)}`);
    } catch { /* Diagnostics must not affect session behavior. */ }
  };
}
