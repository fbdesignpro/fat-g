// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Opt-in developer diagnostics: closed metadata values, never provider text.
export const TRACE_PHASES = ['spawn', 'exit', 'close', 'stop', 'cleanup', 'request', 'reply', 'turn-started', 'turn-completed'] as const;
export const TRACE_OPERATIONS = ['initialize', 'open', 'resume', 'send', 'interrupt', 'other'] as const;
export const TRACE_OUTCOMES = ['ok', 'completed', 'interrupted', 'failed', 'unknown', 'spawn-failed', 'aborted', 'timeout', 'output-limit', 'transport-closed', 'protocol-error', 'rpc-error', 'circuit-open', 'disposed', 'cleanup-failed'] as const;
export type TraceOperation = (typeof TRACE_OPERATIONS)[number];
export type TraceOutcome = (typeof TRACE_OUTCOMES)[number];
export interface LifecycleTraceEvent {
  readonly phase: (typeof TRACE_PHASES)[number];
  readonly pid: number | undefined;
  readonly request?: number;
  readonly operation?: TraceOperation;
  readonly outcome?: TraceOutcome;
  readonly numericCode?: number | null;
  readonly refusal?: 'active-writer' | 'other';
  readonly ok?: boolean;
}
export type LifecycleTrace = (event: LifecycleTraceEvent) => void;
/** Provider-owned classification for diagnostics only; does not change RPC errors or behavior. */
export interface RpcTracePolicy {
  operation(method: string): TraceOperation;
  refusal(method: string, message: unknown): 'active-writer' | 'other';
  notification(method: string, params: unknown): { phase: 'turn-started' | 'turn-completed'; outcome?: TraceOutcome } | null;
}
