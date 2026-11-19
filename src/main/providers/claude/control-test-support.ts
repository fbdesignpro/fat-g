// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Test support: a scripted stand-in for one managed Claude child. Tests read the frames fat-g wrote
// and decide what the "CLI" answers; nothing here knows the protocol's subtypes.
import { ProcessFailure, type ExitInfo, type FailureCode, type ManagedProcess, type ProcessEvent } from '@shared/provider-kit/process';

export type Frame = Record<string, unknown> & { readonly request_id?: string; readonly request?: Record<string, unknown> };

export interface ScriptedChildOptions {
  /** Like the real CLI: EOF on stdin makes it exit by itself. */
  readonly exitOnEnd?: boolean;
  /** Called for every frame fat-g writes. */
  readonly onFrame?: (frame: Frame, child: ScriptedChild) => void;
}

export interface ScriptedChild {
  readonly frames: Frame[];
  readonly log: string[];
  child: ManagedProcess;
  setCleanup(ok: boolean): void;
  failWrites(code: FailureCode): void;
  line(value: unknown): void;
  bytes(data: string | Uint8Array): void;
  emit(event: ProcessEvent): void;
  reply(frame: Frame, response: unknown): void;
  reject(frame: Frame, error: unknown): void;
  exit(code?: number | null): void;
  abort(): void;
}

export function scriptedChild(options: ScriptedChildOptions = {}): ScriptedChild {
  let listener: (event: ProcessEvent) => void = () => {};
  let resolveExited!: (info: ExitInfo) => void;
  let resolveClosed!: (info: ExitInfo) => void;
  const exited = new Promise<ExitInfo>((resolve) => { resolveExited = resolve; });
  const closed = new Promise<ExitInfo>((resolve) => { resolveClosed = resolve; });
  const frames: Frame[] = [];
  /** 'end', 'killed' (abort), 'exit' and 'stop', in order. */
  const log: string[] = [];
  let gone = false;
  let cleanupOk = true;
  let writeFailure: ProcessFailure | undefined;

  const scripted: ScriptedChild = {
    frames,
    log,
    child: undefined as unknown as ManagedProcess,
    setCleanup(ok: boolean) { cleanupOk = ok; },
    failWrites(code: FailureCode) { writeFailure = new ProcessFailure(code); },
    /** One stdout line holding `value` as JSON. */
    line(value: unknown) { listener({ type: 'stdout', data: new TextEncoder().encode(`${JSON.stringify(value)}\n`) }); },
    bytes(data: string | Uint8Array) { listener({ type: 'stdout', data: typeof data === 'string' ? new TextEncoder().encode(data) : data }); },
    emit(event: ProcessEvent) { listener(event); },
    reply(frame: Frame, response: unknown) {
      scripted.line({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } });
    },
    reject(frame: Frame, error: unknown) {
      scripted.line({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error } });
    },
    /** The process ends by itself: stdout EOF, then exit and close. */
    exit(code: number | null = 0) {
      if (gone) return;
      gone = true;
      log.push('exit');
      const info = { code, signal: null };
      listener({ type: 'eof' });
      resolveExited(info);
      listener({ type: 'exit', info });
      resolveClosed(info);
      listener({ type: 'close', info });
    },
    /** What the process layer does when the spawn signal aborts: report it, then stop the tree. */
    abort() {
      log.push('killed');
      listener({ type: 'error', code: 'aborted' });
      scripted.exit(null);
    },
  };

  scripted.child = {
    pid: 4321,
    exited,
    closed,
    consume(next) { listener = next; return () => { listener = () => {}; }; },
    write(bytes, signal) {
      if (signal?.aborted) return Promise.reject(new ProcessFailure('aborted'));
      if (writeFailure !== undefined) return Promise.reject(writeFailure);
      const frame = JSON.parse(new TextDecoder().decode(bytes)) as Frame;
      frames.push(frame);
      queueMicrotask(() => options.onFrame?.(frame, scripted));
      return Promise.resolve();
    },
    end() {
      log.push('end');
      if (options.exitOnEnd ?? true) queueMicrotask(() => scripted.exit(0));
    },
    stop() {
      log.push('stop');
      return Promise.resolve({ ok: cleanupOk });
    },
  };
  return scripted;
}
