// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's connection for unit tests: what the adapter sent, and a way to answer it, to send a
// notification or a request of the CLI's, and to end the process. A request of the CLI's is handed
// to its handler with an id, as the real connection hands it (M21, C66); a reply the adapter gives
// later is kept, or refused, or held as a write still queued. The real connection, on a real
// process, is in tests/codex/. No test library is imported: this file is not a test, and the
// runtime-dependencies test reads it as source.
import type { ProviderContext } from '@shared/provider-kit/context';
import type { DiagnosticEvent } from '@shared/provider-kit/logger';
import type { OversizedLine } from '@shared/provider-kit/ndjson';
import { ProcessFailure, type CleanupResult } from '@shared/provider-kit/process';
import type { ConnectionOptions, OpenConnection, RequestHandler, RequestId, RequestReply } from '@shared/provider-kit/rpc';

export interface SentRequest {
  readonly method: string;
  readonly params: unknown;
  readonly timeoutMs: number | undefined;
  resolve(value: unknown): void;
  reject(error: ProcessFailure): void;
}

export interface ScriptedConnection {
  readonly connection: OpenConnection;
  readonly options: ConnectionOptions;
  /** Every request sent, in order. */
  readonly requests: SentRequest[];
  readonly notifications: { method: string; params: unknown }[];
  /** The latest request of that method still waiting for its answer. */
  readonly pending: (method: string) => SentRequest;
  /** A notification from the CLI: to its subscriber, or to the `unhandled` callback. */
  readonly notify: (method: string, params: unknown) => void;
  /**
   * A request from the CLI, under `id`: its handler's reply; null when the handler deferred it, its
   * reply then coming through `reply` (M21, C66); or undefined when nothing handles it.
   */
  readonly ask: (method: string, params?: unknown, id?: RequestId | null) => RequestReply | null | undefined;
  /** Every reply the adapter gave later, through the connection, in order: one refused or cut off is not among them. */
  readonly replies: { id: RequestId; reply: RequestReply }[];
  /** What a reply's write is rejected with from now on, as a process that refuses the line while it lives; undefined takes replies again. */
  refuseReplies: ProcessFailure | undefined;
  /** True holds each reply's write, as one still queued: `flushReplies` lets them go, and the process's end rejects them. */
  holdReplies: boolean;
  readonly flushReplies: () => void;
  /**
   * A line over the limit arrived and was dropped (M22, C67): `head` is how the line began, which is
   * all the transport keeps of it, and `size` its bytes. Left out, a notification's.
   */
  readonly drop: (head?: string, size?: number) => void;
  /** The process ends by itself. */
  readonly end: (result?: CleanupResult) => void;
  readonly closes: number;
  /** What `close()` and `recheck()` answer. */
  cleanup: CleanupResult;
  recheck: CleanupResult;
}

export function scriptedConnection(options: ConnectionOptions): ScriptedConnection {
  const requests: SentRequest[] = [];
  const notifications: { method: string; params: unknown }[] = [];
  const subscribers = new Map<string, Set<(params: unknown) => void>>();
  const handlers = new Map<string, RequestHandler>();
  const replies: { id: RequestId; reply: RequestReply }[] = [];
  /** The replies whose write is held: each goes, or is rejected when the process ends. */
  const queued: { go(): void; fail(): void }[] = [];
  let ended = false;
  let closes = 0;
  /** The ids of the CLI's requests that were given none: each its own. */
  let asked = 0;
  let resolveDone: (result: CleanupResult) => void = () => undefined;
  const done = new Promise<CleanupResult>((resolve) => { resolveDone = resolve; });
  const script: ScriptedConnection = {
    options, requests, notifications, replies,
    cleanup: { ok: true },
    recheck: { ok: true },
    refuseReplies: undefined,
    holdReplies: false,
    flushReplies() { for (const write of queued.splice(0)) write.go(); },
    get closes() { return closes; },
    pending(method) {
      const found = requests.findLast((request) => request.method === method);
      if (found === undefined) throw new Error(`no ${method} request was sent; sent: ${requests.map((request) => request.method).join(', ')}`);
      return found;
    },
    notify(method, params) {
      const set = subscribers.get(method);
      if (set === undefined) { options.unhandled?.('notification', method); return; }
      for (const subscriber of [...set]) subscriber(params);
    },
    ask(method, params, id = `request-${String(asked++)}`) {
      const handler = handlers.get(method);
      if (handler === undefined) { options.unhandled?.('request', method); return undefined; }
      return handler(params, id);
    },
    drop(head = '{"method":"item/completed","params":{"item":{', size = 5 * 1024 * 1024) {
      // As the transport hands it (rpc-client.ts): the first bytes and the size, to a callback declared with no argument.
      const line: OversizedLine = { peek: new TextEncoder().encode(head).subarray(0, 512), size };
      (options.onDropped as ((line: OversizedLine) => void) | undefined)?.(line);
    },
    end(result = { ok: true }) {
      if (ended) return;
      ended = true;
      for (const request of requests) request.reject(new ProcessFailure('transport-closed'));
      // A write still queued is rejected by the stop, as the process layer rejects one (spawn.ts).
      for (const write of queued.splice(0)) write.fail();
      resolveDone(result);
    },
    connection: {
      request(method, params, requestOptions) {
        if (ended) return Promise.reject(new ProcessFailure('transport-closed'));
        return new Promise((resolve, reject) => {
          const abort = (): void => reject(new ProcessFailure('aborted'));
          requestOptions?.signal?.addEventListener('abort', abort, { once: true });
          const timer = requestOptions?.timeoutMs === undefined ? undefined : setTimeout(() => reject(new ProcessFailure('timeout')), requestOptions.timeoutMs);
          const settle = <T>(finish: (value: T) => void) => (value: T): void => { clearTimeout(timer); requestOptions?.signal?.removeEventListener('abort', abort); finish(value); };
          requests.push({ method, params, timeoutMs: requestOptions?.timeoutMs, resolve: settle(resolve), reject: settle(reject) });
        });
      },
      notify(method, params) {
        if (ended) return Promise.reject(new ProcessFailure('transport-closed'));
        notifications.push({ method, params });
        return Promise.resolve();
      },
      onNotification(method, callback) {
        let set = subscribers.get(method);
        if (set === undefined) { set = new Set(); subscribers.set(method, set); }
        set.add(callback);
        return () => { set.delete(callback); };
      },
      onRequest(method, handler) {
        handlers.set(method, handler);
        return () => { handlers.delete(method); };
      },
      reply(id, reply) {
        // As the real connection's (M21, C66): the write's own promise, rejected as a send's is.
        if (ended) return Promise.reject(new ProcessFailure('transport-closed'));
        if (script.refuseReplies !== undefined) return Promise.reject(script.refuseReplies);
        if (!script.holdReplies) { replies.push({ id, reply }); return Promise.resolve(); }
        return new Promise((resolve, reject) => { queued.push({ go: () => { replies.push({ id, reply }); resolve(); }, fail: () => reject(new ProcessFailure('transport-closed')) }); });
      },
      done,
      close() {
        closes += 1;
        script.end(script.cleanup);
        return done;
      },
      recheck: () => Promise.resolve(script.recheck),
    },
  };
  return script;
}

export interface ScriptedContext {
  readonly context: ProviderContext;
  /** Every connection opened, in order. */
  readonly opened: ScriptedConnection[];
  readonly diagnostics: DiagnosticEvent[];
  /** Makes the next `open` fail. */
  readonly failNextOpen: (error?: ProcessFailure) => void;
  /** The latest connection, once it is open. */
  readonly latest: () => ScriptedConnection;
}

const unused = (): Promise<never> => Promise.reject(new ProcessFailure('disposed'));

export function scriptedContext(): ScriptedContext {
  const opened: ScriptedConnection[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  let failure: ProcessFailure | undefined;
  const open = (options: ConnectionOptions): Promise<OpenConnection> => {
    if (failure !== undefined) { const error = failure; failure = undefined; return Promise.reject(error); }
    const script = scriptedConnection(options);
    opened.push(script);
    return Promise.resolve(script.connection);
  };
  return {
    opened, diagnostics,
    failNextOpen(error = new ProcessFailure('spawn-failed')) { failure = error; },
    latest() {
      const script = opened.at(-1);
      if (script === undefined) throw new Error('no connection was opened');
      return script;
    },
    context: {
      processes: { resolve: unused, spawn: unused, run: unused, supervise: () => { throw new ProcessFailure('disposed'); }, open, openProcess: unused, recheck: () => Promise.resolve({ ok: true }), dispose: () => Promise.resolve({ ok: true }) },
      logger: { record: (event) => { diagnostics.push(event); } },
      probeDirectory: 'C:\\probe',
    },
  };
}

/** Lets the adapter's own promises run: a few turns of the microtask queue. */
export async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
