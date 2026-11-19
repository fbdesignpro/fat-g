// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CleanupResult, Executable, RunOptions } from './process';
import type { RpcTracePolicy } from './lifecycle-trace';
export interface RequestOptions { readonly timeoutMs?: number; readonly signal?: AbortSignal }
/** A reply to a request from the CLI (M15, C35): its result, or an error with a code. */
export type RequestReply = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } };
/** The id a request from the CLI came with (M21, C66): what its reply names, whenever it is given. */
export type RequestId = string | number;
/**
 * Answers one request from the CLI (M15, C35; M21, C66): with its reply, which is written at once,
 * or with `null` for a reply its owner gives later through the connection's `reply`, by the id it
 * is handed here. `id` is null for a request that came with none a later reply could name: such a
 * request is answered at once or never.
 */
export type RequestHandler = (params: unknown, id: RequestId | null) => RequestReply | null;
/** What a request nothing answers is told, and one whose handler throws (M15, C35). */
export const METHOD_NOT_FOUND = Object.freeze({ code: -32601, message: 'Method not found' });
export interface RpcConnection {
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(method: string, callback: (params: unknown) => void): () => void;
  /**
   * Answers the CLI's requests of one method (M15, C35). A method with no handler is answered
   * "method not found", as every request was before; so is one whose handler throws. Nothing is
   * written for a request whose handler answers `null` (M21, C66): its owner replies later.
   */
  onRequest?(method: string, handler: RequestHandler): () => void;
  /**
   * The reply to a request whose handler deferred it (M21, C66), by the id that handler was handed.
   * Its promise is the write's: resolved when the line was handed to the process, and rejected as a
   * send's is — `output-limit` where the process refused the line while it lives, `transport-closed`
   * once its pipe is gone or the connection has exited or finished, and nothing is written then —
   * so that its owner learns whether the reply reached the CLI.
   */
  reply?(id: RequestId, reply: RequestReply): Promise<void>;
}
/** What a connection does with a line over its limit (M15, C19): end the connection, or drop the line and count it. */
export type OversizedLines = 'fail' | 'drop';
/** Told of each request or notification that nothing handles: its method, for the owner to count (C37). */
export type UnhandledListener = (kind: 'request' | 'notification', method: string) => void;
export interface ConnectionTuning {
  /** Used only with an enabled diagnostic sink; raw error text is never retained. */
  readonly tracePolicy?: RpcTracePolicy;
  readonly oversizedLines?: OversizedLines;
  /** The longest line the connection takes, in bytes (M20a, C16). Left out, the decoder's own: 1 MiB. */
  readonly lineBytes?: number;
  /** Larger reply envelopes for named, pending RPC methods only; notifications and requests keep the base limit. */
  readonly largeReplyBytes?: Readonly<Record<string, number>>;
  /** Called once for each line dropped as oversized (C120). */
  readonly onDropped?: () => void;
  readonly unhandled?: UnhandledListener;
}
export interface SupervisorPolicy {
  readonly handshakeMs?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly failureLimit?: number;
  readonly healthyMs?: number;
  readonly cooldownMs?: number;
}
export interface SupervisorOptions extends ConnectionTuning {
  readonly executable: Executable;
  readonly args: readonly string[];
  readonly options: RunOptions;
  readonly handshake: (rpc: RpcConnection, signal: AbortSignal) => Promise<void>;
  readonly policy?: SupervisorPolicy;
}
/**
 * A connection that is opened once and never started again (M15, C84): a session's process. The
 * scope's launch rules, limits, environment and confirmed cleanup are its own; its restarts are none.
 */
export interface ConnectionOptions extends ConnectionTuning {
  readonly executable: Executable;
  readonly args: readonly string[];
  readonly options: RunOptions;
}
export interface OpenConnection extends RpcConnection {
  onRequest(method: string, handler: RequestHandler): () => void;
  reply(id: RequestId, reply: RequestReply): Promise<void>;
  /** Resolves when the process has ended, with whether its tree is confirmed gone. It is never started again. */
  readonly done: Promise<CleanupResult>;
  /** Ends the process and its tree. Idempotent; resolves as `done` does. */
  close(): Promise<CleanupResult>;
  /**
   * After an end that was not confirmed (C116): the tree's own read-only recheck, true once its
   * recorded root has exited and its pipes have closed. It never kills.
   */
  recheck(): Promise<CleanupResult>;
}
export type SupervisorState = 'idle' | 'starting' | 'ready' | 'backoff' | 'circuit-open' | 'stopping' | 'disposed';
export interface SupervisorLifecycle {
  readonly state: SupervisorState;
  readonly generation: number;
}
export interface SupervisedConnection extends RpcConnection {
  readonly state: SupervisorState;
  readonly generation: number;
  connect(): Promise<RpcConnection>;
  restart(): Promise<RpcConnection>;
  /** Reports a live transport generation as unhealthy without resetting backoff/circuit history. */
  reportUnhealthy(generation: number): Promise<void>;
  /** A completed application request proves this replacement is responsive. */
  markResponsive(generation: number): void;
  onState(listener: (lifecycle: SupervisorLifecycle) => void): () => void;
  dispose(): Promise<CleanupResult>;
}
