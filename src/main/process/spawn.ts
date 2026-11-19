// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { spawn as nativeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import crossSpawn from 'cross-spawn';
import type { DiagnosticLogger } from '@shared/provider-kit/logger';
import { ProcessFailure, shimRefuses, type CleanupResult, type Executable, type ExitInfo, type ManagedProcess, type ProcessEvent, type RunOptions } from '@shared/provider-kit/process';
import { mergeEnvironment, type Environment } from './env';
import { deferred } from './deferred';
import type { ProcessRegistry } from './process-registry';
import { pidAlive, terminateTree, terminateTreeSync } from './tree-kill';

export const PROCESS_LIMITS = { timeoutMs: 15_000, stdoutBytes: 1024 * 1024, queuedBytes: 1024 * 1024 };

/** One launched tree as its owning scope sees it. */
export interface OwnedTree {
  /** Idempotent: EOF, kill, abort, disposal and quit all share this one tree cleanup. */
  stop(): Promise<CleanupResult>;
  /**
   * After a failed cleanup: true once the recorded root has exited and its pipes have closed (on
   * POSIX, its process group is gone too), which releases the registration. Read-only.
   */
  recheck(): boolean;
}

/** How a scope learns about its trees, so a failed cleanup can close it to new launches. */
export interface TreeOwnership {
  track(tree: OwnedTree): void;
  settled(tree: OwnedTree, result: CleanupResult): void;
}

interface LaunchHooks {
  /** Cleanup is starting, including the synchronous emergency path. */
  stopping?(): void;
  stopped?(result: CleanupResult): void;
  error?(): void;
  exit?(info: ExitInfo): void;
  close?(info: ExitInfo): void;
  stdinError?(): void;
  stdoutError?(): void;
}

interface LaunchedTree extends OwnedTree {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<ExitInfo>;
  readonly closed: Promise<ExitInfo>;
  exitInfo(): ExitInfo | undefined;
}

/**
 * Validates, launches and registers one child tree before returning. Callers own stdout (this never
 * attaches a data listener to it); stderr is always drained and only its size is recorded.
 */
export function launchTree(executable: Executable, args: readonly string[], cwd: string, env: Record<string, string>, registry: ProcessRegistry, logger: DiagnosticLogger, hooks: LaunchHooks = {}, ownership?: TreeOwnership): LaunchedTree {
  registry.assertOpen();
  if (!path.isAbsolute(executable.path) || !path.isAbsolute(cwd) || [executable.path, cwd, ...args].some((v) => v.includes('\0'))) throw new ProcessFailure('spawn-failed');
  // cmd expansion and batch re-parsing are not lossless for some values: the kit's one rule says
  // which (M16, C20). Native executables accept them; callers of shims receive a typed failure
  // rather than altered text or execution.
  if (executable.kind === 'cmd-shim' && (process.platform !== 'win32' || [executable.path, ...args].some(shimRefuses))) throw new ProcessFailure('spawn-failed');
  if (process.platform === 'win32' && (executable.kind === 'native' ? !/\.(exe|com)$/i.test(executable.path) : !/\.(cmd|bat)$/i.test(executable.path))) throw new ProcessFailure('spawn-failed');
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (executable.kind === 'cmd-shim' ? crossSpawn : nativeSpawn)(executable.path, [...args], {
      cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: 'pipe',
    }) as ChildProcessWithoutNullStreams;
  } catch { throw new ProcessFailure('spawn-failed'); }
  logger.trace?.({ phase: 'spawn', pid: child.pid });
  let exitInfo: ExitInfo | undefined;
  let closeInfo: ExitInfo | undefined;
  let stopping: Promise<CleanupResult> | undefined;
  let result: CleanupResult | undefined;
  let confirmed = false;
  const exited = deferred<ExitInfo>();
  const closed = deferred<ExitInfo>();
  const tree = { pid: child.pid, rootExited: () => exitInfo !== undefined, streamsClosed: () => closeInfo !== undefined, end: () => child.stdin.end() };
  const unregister = registry.register({ stop, emergency: (timeout) => { hooks.stopping?.(); return terminateTreeSync(tree, timeout); } });
  function stop(): Promise<CleanupResult> {
    if (confirmed) return Promise.resolve({ ok: true });
    if (stopping) return stopping;
    logger.trace?.({ phase: 'stop', pid: child.pid });
    hooks.stopping?.();
    stopping = terminateTree(tree).catch(() => ({ ok: false })).then((outcome) => {
      result = outcome;
      logger.trace?.({ phase: 'cleanup', pid: child.pid, ok: outcome.ok });
      child.stdin.destroy();
      if (outcome.ok) {
        confirmed = true;
        child.stdout.destroy(); child.stderr.destroy();
        unregister();
      } else {
        // Keep the read ends open and flowing: their natural close is the later evidence a recheck
        // needs. Destroying them would make 'close' fire even while a descendant holds the pipes.
        child.stdout.resume();
        logger.record({ type: 'failure', code: 'cleanup-failed' });
      }
      hooks.stopped?.(outcome);
      ownership?.settled(owned, outcome);
      return outcome;
    });
    return stopping;
  }
  function recheck(): boolean {
    if (confirmed) return true;
    if (result === undefined || exitInfo === undefined || closeInfo === undefined) return false;
    if (process.platform !== 'win32' && tree.pid !== undefined && pidAlive(-tree.pid)) return false;
    confirmed = true;
    unregister();
    return true;
  }
  child.on('error', () => { logger.record({ type: 'failure', code: 'spawn-failed' }); hooks.error?.(); void stop(); });
  child.stdout.on('error', () => { hooks.stdoutError?.(); void stop(); });
  child.stderr.on('data', (data: Buffer) => logger.record({ type: 'stderr-observed', byteCount: data.length }));
  child.stderr.on('error', () => {});
  child.stdin.on('error', () => { hooks.stdinError?.(); });
  child.on('exit', (code, signal) => { logger.trace?.({ phase: 'exit', pid: child.pid, numericCode: code }); exitInfo = { code, signal }; exited.resolve(exitInfo); hooks.exit?.(exitInfo); });
  child.on('close', (code, signal) => {
    logger.trace?.({ phase: 'close', pid: child.pid, numericCode: code });
    closeInfo = { code, signal }; exitInfo ??= closeInfo;
    exited.resolve(exitInfo); closed.resolve(closeInfo); hooks.close?.(closeInfo); void stop();
  });
  const owned: LaunchedTree = { child, exited: exited.promise, closed: closed.promise, exitInfo: () => exitInfo, stop, recheck };
  ownership?.track(owned);
  return owned;
}

interface Write { bytes: Uint8Array; resolve(): void; reject(error: ProcessFailure): void; dispose(): void; onSent?: () => void }
/** `protectedNames`: what `options.env` may never set (M14b, C8); see mergeEnvironment. */
export function spawnManaged(executable: Executable, args: readonly string[], options: RunOptions, env: Environment, registry: ProcessRegistry, logger: DiagnosticLogger, protectedNames: readonly string[], ownership?: TreeOwnership): ManagedProcess {
  registry.assertOpen();
  if (options.signal?.aborted) throw new ProcessFailure('aborted');
  let listener: ((event: ProcessEvent) => void) | undefined;
  let subscribed = false;
  let buffered: ProcessEvent[] = [];
  let bufferedBytes = 0;
  let writeClosed = false;
  let active: Write | undefined;
  const queue: Write[] = [];
  let queuedBytes = 0;
  function emit(event: ProcessEvent): void {
    if (listener) { listener(event); return; }
    if (event.type === 'stdout') {
      bufferedBytes += event.data.byteLength;
      if (bufferedBytes > (options.stdoutLimit ?? PROCESS_LIMITS.stdoutBytes)) {
        buffered = [{ type: 'error', code: 'output-limit' }];
        void launched.stop(); return;
      }
    }
    if (buffered.length < 4096) buffered.push(event);
    else { buffered = [{ type: 'error', code: 'output-limit' }]; void launched.stop(); }
  }
  function finishWrite(item: Write, error?: ProcessFailure): void {
    queuedBytes -= item.bytes.byteLength;
    item.dispose();
    if (error) item.reject(error); else item.resolve();
  }
  function failWrites(): void {
    writeClosed = true;
    if (active) { finishWrite(active, new ProcessFailure('transport-closed')); active = undefined; }
    for (const item of queue.splice(0)) finishWrite(item, new ProcessFailure('transport-closed'));
  }
  function pump(): void {
    if (active || writeClosed) return;
    const item = queue.shift();
    if (!item) return;
    active = item;
    item.onSent?.();
    // The callback waits for this chunk to flush; only then may another queued write begin.
    launched.child.stdin.write(item.bytes, (error) => {
      if (active !== item) return;
      active = undefined;
      finishWrite(item, error ? new ProcessFailure('transport-closed') : undefined);
      if (error) failWrites(); else pump();
    });
  }
  function abort(): void { emit({ type: 'error', code: 'aborted' }); void launched.stop(); }
  const launched = launchTree(executable, args, options.cwd, mergeEnvironment(env, options.env ?? {}, process.platform, protectedNames), registry, logger, {
    stopping: failWrites,
    stopped: () => options.signal?.removeEventListener('abort', abort),
    error: () => emit({ type: 'error', code: 'spawn-failed' }),
    stdoutError: () => emit({ type: 'error', code: 'transport-closed' }),
    stdinError: () => { failWrites(); emit({ type: 'stdin-error' }); },
    exit: (info) => { failWrites(); emit({ type: 'exit', info }); },
    close: (info) => { failWrites(); emit({ type: 'close', info }); },
  }, ownership);
  const { child } = launched;
  child.stdout.on('data', (data: Buffer) => emit({ type: 'stdout', data }));
  child.stdout.on('end', () => emit({ type: 'eof' }));
  options.signal?.addEventListener('abort', abort, { once: true });
  return {
    pid: child.pid, exited: launched.exited, closed: launched.closed, stop: () => launched.stop(),
    consume(next) {
      if (subscribed) throw new ProcessFailure('protocol-error');
      subscribed = true; listener = next;
      const events = buffered; buffered = []; bufferedBytes = 0;
      for (const event of events) next(event);
      return () => { listener = () => {}; };
    },
    write(bytes, signal, onSent) {
      if (signal?.aborted) return Promise.reject(new ProcessFailure('aborted'));
      if (writeClosed) return Promise.reject(new ProcessFailure('transport-closed'));
      if (queuedBytes + bytes.byteLength > PROCESS_LIMITS.queuedBytes) return Promise.reject(new ProcessFailure('output-limit'));
      return new Promise((resolve, reject) => {
        const cancel = () => {
          const index = queue.indexOf(item);
          if (index >= 0) { queue.splice(index, 1); finishWrite(item, new ProcessFailure('aborted')); }
        };
        const item: Write = { bytes: bytes.slice(), resolve, reject, dispose: () => signal?.removeEventListener('abort', cancel), onSent };
        queuedBytes += bytes.byteLength; queue.push(item); signal?.addEventListener('abort', cancel, { once: true }); pump();
      });
    },
    end() { if (!writeClosed) child.stdin.end(); },
  };
}

export async function collectRun(child: ManagedProcess, options: RunOptions): Promise<ExitInfo & { stdout: string }> {
  let size = 0;
  const chunks: Uint8Array[] = [];
  const outcome = deferred<ExitInfo & { stdout: string }>();
  const fail = (code: 'timeout' | 'aborted' | 'output-limit') => outcome.reject(new ProcessFailure(code));
  const timer = setTimeout(() => fail('timeout'), options.timeoutMs ?? PROCESS_LIMITS.timeoutMs);
  const abort = () => fail('aborted');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const detach = child.consume((event) => {
    if (event.type === 'stdout') {
      size += event.data.byteLength;
      if (size > (options.stdoutLimit ?? PROCESS_LIMITS.stdoutBytes)) fail('output-limit');
      else chunks.push(event.data.slice());
    } else if (event.type === 'error') outcome.reject(new ProcessFailure(event.code));
    else if (event.type === 'close') outcome.resolve({ ...event.info, stdout: Buffer.concat(chunks).toString('utf8') });
  });
  child.end();
  try { return await outcome.promise; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); detach(); await child.stop(); }
}
