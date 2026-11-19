// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { DiagnosticLogger } from '@shared/provider-kit/logger';
import type { TraceOperation } from '@shared/provider-kit/lifecycle-trace';
import { ProcessFailure, type ManagedProcess, type ProcessEvent } from '@shared/provider-kit/process';
import { METHOD_NOT_FOUND, type ConnectionTuning, type RequestHandler, type RequestId, type RequestOptions, type RequestReply, type RpcConnection } from '@shared/provider-kit/rpc';
import { NdjsonDecoder, type OversizedLine } from '@shared/provider-kit/ndjson';
import { deferred } from './deferred';

interface Pending { sent: boolean; method: string; refusal?: 'active-writer' | 'other'; finish(error?: ProcessFailure, value?: unknown): void }
export interface RpcClient extends RpcConnection {
  onRequest(method: string, handler: RequestHandler): () => void;
  reply(id: RequestId, reply: RequestReply): Promise<void>;
  readonly available: boolean;
  readonly done: Promise<void>;
  dispose(): void;
}
export interface RpcOptions extends ConnectionTuning { drainMs?: number; requestMs?: number; lineBytes?: number; pendingLimit?: number }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** A reply as its line: under the request's own id, and "method not found" where there is none to give. */
const replyLine = (id: RequestId | null, reply: RequestReply | undefined): unknown => (reply === undefined ? { id, error: METHOD_NOT_FOUND } : 'result' in reply ? { id, result: reply.result } : { id, error: { code: reply.error.code, message: reply.error.message } });
export function createRpcClient(child: ManagedProcess, logger: DiagnosticLogger, options: RpcOptions = {}): RpcClient {
  const pending = new Map<number, Pending>();
  const subscriptions = new Map<string, Set<(params: unknown) => void>>();
  const handlers = new Map<string, RequestHandler>();
  const done = deferred<void>();
  let nextId = 0;
  let exited = false;
  let terminal = false;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const consumer = { detach: undefined as (() => void) | undefined };
  // A line over the limit ends the connection, unless its owner asked for it to be dropped (C19):
  // none of it is kept or parsed, so a reply lost this way leaves its request to its own deadline (C88).
  // Its first bytes and its size go to its owner with the count (M22, C67), for the one look an
  // adapter takes at them: `onDropped` is declared with no argument, and one that takes none ignores it.
  const told = options.onDropped as ((line: OversizedLine) => void) | undefined;
  const dropped = options.oversizedLines === 'drop' ? (line: OversizedLine) => { logger.record({ type: 'frame-dropped', reason: 'oversized' }); try { told?.(line); } catch { /* the owner's count is its own */ } } : undefined;
  const replyLimit = (head: Uint8Array): number | undefined => {
    // The observed reply envelope starts with its numeric id. Read only this prefix, never
    // a key inside a result, and grant a larger envelope only to an outstanding named method.
    const prefix = new TextDecoder().decode(head);
    const id = /^\s*\{\s*"id"\s*:\s*(\d{1,15})\s*,\s*"(?:result|error)"\s*:/.exec(prefix)?.[1];
    const request = id === undefined ? undefined : pending.get(Number(id));
    return request === undefined ? undefined : options.largeReplyBytes?.[request.method];
  };
  const decoder = new NdjsonDecoder(receive, () => logger.record({ type: 'malformed-frame' }), options.lineBytes, dropped, options.largeReplyBytes === undefined ? undefined : replyLimit);
  const unhandled = (kind: 'request' | 'notification', method: string): void => { try { options.unhandled?.(kind, method); } catch { /* the owner's count is its own */ } };
  function finish(error = new ProcessFailure('transport-closed')): void {
    if (terminal) return;
    terminal = true; clearTimeout(drain); decoder.discard();
    for (const entry of pending.values()) entry.finish(error);
    subscriptions.clear(); handlers.clear(); consumer.detach?.(); done.resolve();
  }
  function send(value: unknown, signal?: AbortSignal, onSent?: () => void): Promise<void> {
    if (exited || terminal) return Promise.reject(new ProcessFailure('transport-closed'));
    try { return child.write(new TextEncoder().encode(JSON.stringify(value) + '\n'), signal, onSent); }
    catch { return Promise.reject(new ProcessFailure('protocol-error')); }
  }
  function receive(value: unknown): void {
    if (!object(value)) { logger.record({ type: 'malformed-frame' }); return; }
    if (typeof value['method'] === 'string') {
      if ('id' in value) {
        // Every request from the CLI is refused unless its owner registered a handler (C35).
        const handler = handlers.get(value['method']);
        const id = typeof value['id'] === 'string' || typeof value['id'] === 'number' ? value['id'] : null;
        let reply: RequestReply | null | undefined;
        if (handler) { try { reply = handler(value['params'], id); } catch { reply = undefined; } }
        if (reply === undefined) unhandled('request', value['method']);
        // A handler that answered `null` gives its reply later, through `reply` (M21, C66): nothing
        // is written for its request here. What became of a reply written here is not said to anyone.
        if (reply !== null && (id !== null || value['id'] === null)) void send(replyLine(id, reply)).catch(() => {});
      } else {
        if (logger.trace !== undefined && options.tracePolicy !== undefined) {
          try {
            const event = options.tracePolicy.notification(value['method'], value['params']);
            if (event !== null) logger.trace({ ...event, pid: child.pid });
          } catch { /* diagnostics never affect the protocol */ }
        }
        const subscribers = subscriptions.get(value['method']);
        if (subscribers === undefined) unhandled('notification', value['method']);
        for (const subscriber of subscribers ?? []) {
          try { subscriber(value['params']); } catch { logger.record({ type: 'malformed-frame' }); }
        }
      }
      return;
    }
    const id = value['id'];
    if (typeof id !== 'number') return;
    const entry = pending.get(id);
    if (!entry) return;
    if ('method' in value || ('result' in value) === ('error' in value)) { entry.finish(new ProcessFailure('protocol-error')); return; }
    if ('result' in value) { entry.finish(undefined, value['result']); return; }
    const error = value['error'];
    if (!object(error) || typeof error['code'] !== 'number' || !Number.isFinite(error['code'])) { entry.finish(new ProcessFailure('protocol-error')); return; }
    if (logger.trace !== undefined && options.tracePolicy !== undefined) {
      try { entry.refusal = options.tracePolicy.refusal(entry.method, error['message']); } catch { /* classification is optional */ }
    }
    entry.finish(new ProcessFailure('rpc-error', error['code']));
  }
  function consume(event: ProcessEvent): void {
    if (terminal) return;
    switch (event.type) {
      case 'stdout':
        try { decoder.push(event.data); } catch { finish(new ProcessFailure('protocol-error')); void child.stop(); }
        break;
      case 'eof':
        try { decoder.end(); } catch { finish(new ProcessFailure('protocol-error')); }
        finish(); break;
      case 'exit':
        if (exited) break;
        exited = true;
        for (const entry of pending.values()) if (!entry.sent) entry.finish(new ProcessFailure('transport-closed'));
        drain = setTimeout(() => finish(), options.drainMs ?? 1000);
        break;
      case 'error': finish(new ProcessFailure(event.code)); break;
      case 'stdin-error': if (!exited) finish(); break;
      case 'close': finish(); break;
    }
  }
  consumer.detach = child.consume(consume);
  if (terminal) consumer.detach();
  return {
    get available() { return !exited && !terminal; },
    done: done.promise,
    dispose: () => finish(new ProcessFailure('disposed')),
    request(method: string, params?: unknown, requestOptions: RequestOptions = {}) {
      if (requestOptions.signal?.aborted) return Promise.reject(new ProcessFailure('aborted'));
      if (exited || terminal) return Promise.reject(new ProcessFailure('transport-closed'));
      if (pending.size >= (options.pendingLimit ?? 128)) return Promise.reject(new ProcessFailure('output-limit'));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        let operation: TraceOperation = 'other';
        if (logger.trace !== undefined && options.tracePolicy !== undefined) {
          try { operation = options.tracePolicy.operation(method); } catch { /* fall back to other */ }
          logger.trace({ phase: 'request', pid: child.pid, request: id, operation });
        }
        const writes = new AbortController();
        const abort = () => entry.finish(new ProcessFailure('aborted'));
        const timer = setTimeout(() => entry.finish(new ProcessFailure('timeout')), requestOptions.timeoutMs ?? options.requestMs ?? 10_000);
        const entry: Pending = {
          method,
          sent: false,
          finish(error, value) {
            if (!pending.delete(id)) return;
            clearTimeout(timer); requestOptions.signal?.removeEventListener('abort', abort); writes.abort();
            if (options.tracePolicy !== undefined) logger.trace?.({ phase: 'reply', pid: child.pid, request: id, operation, outcome: error?.code ?? 'ok', ...(error?.numericCode === undefined ? {} : { numericCode: error.numericCode }), ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }) });
            if (error) reject(error); else resolve(value);
          },
        };
        pending.set(id, entry);
        requestOptions.signal?.addEventListener('abort', abort, { once: true });
        void send({ id, method, params }, writes.signal, () => { entry.sent = true; }).catch((error: unknown) => {
          // Once exit started, a failed writable pipe says nothing about buffered responses.
          if (exited && entry.sent) return;
          entry.finish(error instanceof ProcessFailure ? error : new ProcessFailure('transport-closed'));
        });
      });
    },
    notify: (method, params) => send({ method, params }),
    // The write's own promise (M21, C66): its owner learns whether the line was handed to the process.
    reply: (id, reply) => send(replyLine(id, reply)),
    onRequest(method, handler) {
      if (terminal) return () => {};
      handlers.set(method, handler);
      return () => { if (handlers.get(method) === handler) handlers.delete(method); };
    },
    onNotification(method, callback) {
      if (terminal) return () => {};
      let set = subscriptions.get(method);
      if (!set) { set = new Set(); subscriptions.set(method, set); }
      set.add(callback);
      return () => { set.delete(callback); if (!set.size) subscriptions.delete(method); };
    },
  };
}
