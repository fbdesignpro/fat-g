// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ProcessFailure, type Executable } from '@shared/provider-kit/process';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { AccountResult, ProviderEvent, UsageResult } from '@shared/provider-kit/provider';
import type { SupervisorPolicy } from '@shared/provider-kit/rpc';
import type { HistoryAnswer, HistoryRequest } from '@shared/provider-kit/sessions';
import type { UsageSnapshot, UsageWindow } from '@shared/contracts/usage';
import { MAX_MODELS } from '@shared/contracts/catalog';
import { readHistoryPage } from './history';
import { existingHandshake, HISTORY_METHOD, sendNotification, sendRequest, SKILLS_METHOD } from './methods';
import { MEDIA_SESSION_LINE_BYTES } from '@shared/provider-kit/ndjson';
import { mapCodexModels } from './models';
import { normalizeAccount, normalizeRateLimitPush, normalizeRateLimits, type NormalizedBucket } from './normalize';
import { ModelListPageSchema } from './schemas';

const MAX_QUEUED_PUSHES = 64;
/** `model/list` pages followed at most (M13, C29). */
export const MAX_MODEL_PAGES = 10;
const MAX_CURSOR = 1024;

export interface CodexAppServer {
  getAccount(signal: AbortSignal): Promise<AccountResult>;
  getUsage(signal: AbortSignal): Promise<UsageResult>;
  /** Asks `model/list` again, or joins a read already under way (M13, C69). Sends nothing unless connected. */
  reportModels(): Promise<void>;
  subscribe(listener: (event: ProviderEvent) => void): () => void;
  /** How many lines this connection has dropped as oversized (M15, C19, C120). */
  droppedLines(): number;
  /** One page of a session's earlier messages (M15, C57). Starts nothing: `failed` unless connected. */
  readHistory(reference: string, page: HistoryRequest, signal: AbortSignal): Promise<HistoryAnswer>;
  /** `skills/list` for one folder (M23, C63): the reply, unparsed. Starts nothing: null unless connected, and for a reply that never came. */
  listSkills(folder: string, signal: AbortSignal): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface CodexAppServerOptions {
  readonly argsPrefix?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly emptyRetryMs?: number;
  readonly supervisorPolicy?: SupervisorPolicy;
}

export function createCodexAppServer(
  context: ProviderContext,
  executable: Executable,
  applicationVersion: string,
  options: CodexAppServerOptions = {},
): CodexAppServer {
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const emptyRetryMs = options.emptyRetryMs ?? 750;
  let disposed = false;
  const lifetime = new AbortController();
  let modelRead: Promise<void> | undefined;
  let modelReadAgain = false;
  let readyGeneration = 0;
  let timeoutGeneration = 0;
  let consecutiveTimeouts = 0;
  let retriedEmptyGeneration = 0;
  let sawReady = false;
  let readActive = false;
  let pushSequence = 0;
  let readStartedAt = 0;
  let pushOverflow = false;
  let queuedPushes: { sequence: number; bucket: NormalizedBucket }[] = [];
  /** Lines dropped as oversized on this connection, counted since it was made (C120). */
  let droppedLines = 0;
  const dropListeners = new Set<() => void>();
  /** History reads, one at a time: a line dropped during one is then that read's own reply (C120). */
  let historyQueue: Promise<unknown> = Promise.resolve();
  const cache = new Map<string, readonly UsageWindow[]>();
  const listeners = new Set<(event: ProviderEvent) => void>();

  const supervisor = context.processes.supervise({
    executable,
    args: [...(options.argsPrefix ?? []), 'app-server'],
    options: { cwd: context.probeDirectory, stdoutLimit: 1024 * 1024 },
    policy: options.supervisorPolicy,
    // A line over the limit is dropped and counted, and the connection stays up (M15, C19): one
    // large history page must not restart the usage reads.
    oversizedLines: 'drop',
    largeReplyBytes: { [HISTORY_METHOD]: MEDIA_SESSION_LINE_BYTES },
    onDropped: () => {
      droppedLines += 1;
      for (const listener of [...dropListeners]) listener();
    },
    async handshake(rpc, signal) {
      // `clientInfo` alone, as before M15: this connection runs no thread (C13).
      await sendRequest('existing', rpc, 'initialize', existingHandshake(applicationVersion), { timeoutMs: requestTimeoutMs, signal });
      await sendNotification('existing', rpc, 'initialized', {});
    },
  });

  const detachRateLimits = supervisor.onNotification('account/rateLimits/updated', (params) => {
    if (disposed) return;
    const bucket = normalizeRateLimitPush(params);
    if (bucket === null) {
      emit({ type: 'invalidate' });
      return;
    }
    const sequence = ++pushSequence;
    if (readActive) {
      if (queuedPushes.length >= MAX_QUEUED_PUSHES) {
        pushOverflow = true;
        queuedPushes = [];
      } else {
        queuedPushes.push({ sequence, bucket });
      }
    }
    applyBucket(bucket);
    emit({ type: 'usage', usage: cachedUsage() });
  });
  const detachAccount = supervisor.onNotification('account/updated', () => {
    if (disposed) return;
    cache.clear();
    queuedPushes = [];
    pushOverflow = false;
    emit({ type: 'invalidate' });
    // Another account may see other models (C29).
    void readModelsSoon();
  });
  const detachLifecycle = supervisor.onState(({ state, generation }) => {
    if (disposed) return;
    if (state === 'ready') {
      const reconnected = sawReady && generation !== readyGeneration;
      sawReady = true;
      readyGeneration = generation;
      timeoutGeneration = generation;
      consecutiveTimeouts = 0;
      if (reconnected) {
        cache.clear();
        queuedPushes = [];
        pushOverflow = false;
      }
      emit({ type: 'connection', state: 'ready' });
      void readModelsSoon();
    } else if (sawReady && (state === 'backoff' || state === 'circuit-open' || state === 'stopping')) {
      emit({ type: 'connection', state: 'disconnected' });
    }
  });

  async function request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    // `supervisor.request` starts a lazy connection synchronously before returning its promise, so
    // sample the generation afterwards. Sampling before it would label the first request as the
    // previous idle generation and make the first live timeout invisible to hang recovery.
    const pending = sendRequest('existing', supervisor, method, params, { timeoutMs: requestTimeoutMs, signal });
    const generation = supervisor.generation;
    try {
      const value = await pending;
      const completedGeneration = supervisor.generation;
      supervisor.markResponsive(completedGeneration);
      timeoutGeneration = completedGeneration;
      consecutiveTimeouts = 0;
      return value;
    } catch (error) {
      if (isFailure(error, 'rpc-error')) {
        supervisor.markResponsive(supervisor.generation);
        timeoutGeneration = supervisor.generation;
        consecutiveTimeouts = 0;
      } else if (isFailure(error, 'timeout') && generation === supervisor.generation) {
        if (timeoutGeneration !== generation) {
          timeoutGeneration = generation;
          consecutiveTimeouts = 0;
        }
        consecutiveTimeouts += 1;
        if (consecutiveTimeouts >= 2) void supervisor.reportUnhealthy(generation);
      }
      throw error;
    }
  }

  async function getAccount(signal: AbortSignal): Promise<AccountResult> {
    try {
      return normalizeAccount(await request('account/read', { refreshToken: false }, signal));
    } catch (error) {
      return methodFailure(error);
    }
  }

  async function getUsage(signal: AbortSignal): Promise<UsageResult> {
    try {
      let normalized = await readUsage(signal);
      const generation = supervisor.generation;
      if (normalized.ok && normalized.usage.windows.length === 0 && retriedEmptyGeneration !== generation) {
        retriedEmptyGeneration = generation;
        await abortableDelay(emptyRetryMs, signal);
        normalized = await readUsage(signal);
      }
      if (!normalized.ok) return { kind: 'error', reason: 'unsupported-data' };
      if (normalized.usage.windows.length === 0) return { kind: 'empty' };
      return { kind: 'usage', usage: normalized.usage };
    } catch (error) {
      return methodFailure(error);
    }
  }

  async function readUsage(signal: AbortSignal): Promise<ReturnType<typeof normalizeRateLimits>> {
    readActive = true;
    readStartedAt = pushSequence;
    queuedPushes = [];
    pushOverflow = false;
    try {
      const result = normalizeRateLimits(await request('account/rateLimits/read', undefined, signal));
      if (!result.ok) return result;
      cache.clear();
      for (const bucket of result.buckets) applyBucket(bucket);
      if (pushOverflow) {
        cache.clear();
        emit({ type: 'invalidate' });
        return { ok: true, buckets: [], usage: { windows: [] } };
      }
      for (const queued of queuedPushes) if (queued.sequence > readStartedAt) applyBucket(queued.bucket);
      const usage = cachedUsage();
      return { ok: true, buckets: result.buckets, usage };
    } finally {
      readActive = false;
      queuedPushes = [];
      pushOverflow = false;
    }
  }

  /**
   * The CLI's models (M13, C29, C30), straight through the supervisor: this read takes no part in
   * `request`'s timeout count, so slow model reads never restart the connection, and it sends
   * nothing unless the connection is ready — `connect()` would otherwise start a CLI (S6). A
   * failure, a timeout, an unsupported method or a reply that is not a list sends nothing and
   * changes nothing else. The read is abandoned when the connection is replaced between pages.
   */
  async function readModelsOnce(): Promise<void> {
    if (disposed || supervisor.state !== 'ready') return;
    const generation = supervisor.generation;
    const rows: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES && rows.length < MAX_MODELS; page += 1) {
      if (disposed || supervisor.state !== 'ready' || supervisor.generation !== generation) return;
      let reply: unknown;
      try {
        reply = await sendRequest('existing', supervisor, 'model/list', { includeHidden: true, ...(cursor === null ? {} : { cursor }) }, { timeoutMs: requestTimeoutMs, signal: lifetime.signal });
      } catch {
        return;
      }
      if (disposed || supervisor.generation !== generation) return;
      const parsed = ModelListPageSchema.safeParse(reply);
      if (!parsed.success) return;
      rows.push(...parsed.data.data);
      const next = parsed.data.nextCursor;
      cursor = typeof next === 'string' && next.length > 0 && next.length <= MAX_CURSOR ? next : null;
      if (cursor === null) break;
    }
    const report = mapCodexModels(rows);
    if (report !== null && !disposed) emit({ type: 'models', report });
  }

  /**
   * A page of history (M15, C57, C88), straight through the supervisor as the model reads are: it
   * takes no part in `request`'s timeout count, so a slow page restarts nothing, and it sends
   * nothing unless the connection is ready.
   */
  function listSkills(folder: string, signal: AbortSignal): Promise<unknown> {
    if (disposed || supervisor.state !== 'ready') return Promise.resolve(null);
    return sendRequest('existing', supervisor, SKILLS_METHOD, { cwds: [folder] }, { timeoutMs: requestTimeoutMs, signal }).catch(() => null);
  }

  function readHistory(reference: string, page: HistoryRequest, signal: AbortSignal): Promise<HistoryAnswer> {
    const read = (): Promise<HistoryAnswer> => readHistoryPage({
      ready: () => !disposed && supervisor.state === 'ready',
      droppedLines: () => droppedLines,
      onDropped(listener) { dropListeners.add(listener); return () => dropListeners.delete(listener); },
      ask: (method, params, requestSignal) => sendRequest('existing', supervisor, method, params, { timeoutMs: requestTimeoutMs, signal: requestSignal }),
    }, reference, page, signal);
    const next = historyQueue.then(read, read);
    historyQueue = next.catch(() => undefined);
    return next;
  }

  /** On `ready` and `account/updated`: one read at a time, and one more after it for a trigger meanwhile. */
  function readModelsSoon(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (modelRead !== undefined) {
      modelReadAgain = true;
      return modelRead;
    }
    const run = (async () => {
      do {
        modelReadAgain = false;
        await readModelsOnce();
      } while (modelReadAgain && !disposed);
    })();
    modelRead = run.finally(() => { modelRead = undefined; });
    return modelRead;
  }

  function applyBucket(bucket: NormalizedBucket): void {
    cache.set(bucket.id, bucket.windows);
  }

  function cachedUsage(): UsageSnapshot {
    return { windows: [...cache.values()].flat() };
  }

  function emit(event: ProviderEvent): void {
    for (const listener of listeners) {
      try { listener(event); } catch { /* isolate consumers from the transport */ }
    }
  }

  return {
    getAccount,
    getUsage,
    // A read under way already answers the ask: it started no earlier than the reason for it.
    reportModels: () => modelRead ?? readModelsSoon(),
    droppedLines: () => droppedLines,
    listSkills,
    readHistory,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      detachRateLimits();
      detachAccount();
      detachLifecycle();
      listeners.clear();
      await supervisor.dispose();
    },
  };
}

function methodFailure(error: unknown):
  | { readonly kind: 'not-applicable'; readonly reason: 'unsupported-cli-version' }
  | { readonly kind: 'error'; readonly reason: 'temporarily-unavailable' } {
  if (isFailure(error, 'rpc-error') && error.numericCode === -32601) return { kind: 'not-applicable', reason: 'unsupported-cli-version' };
  return { kind: 'error', reason: 'temporarily-unavailable' };
}

function isFailure(error: unknown, code: ProcessFailure['code']): error is ProcessFailure {
  return error instanceof ProcessFailure && error.code === code;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ProcessFailure('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new ProcessFailure('aborted'));
    };
    function finish(): void {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
