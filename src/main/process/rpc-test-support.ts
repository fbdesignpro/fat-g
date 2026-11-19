// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ProcessFailure, type ManagedProcess, type ProcessEvent } from '@shared/provider-kit/process';
import { deferred } from './deferred';
export function controlledProcess() {
  let listener: (event: ProcessEvent) => void = () => {};
  const exited = deferred<{ code: number | null; signal: string | null }>();
  const closed = deferred<{ code: number | null; signal: string | null }>();
  const writes: Record<string, unknown>[] = [];
  const queued: (() => void)[] = [];
  let paused = false;
  let stopped = 0;
  let cleanupOk = true;
  let refusal: ProcessFailure['code'] | undefined;
  const handle: ManagedProcess = {
    pid: 1234, exited: exited.promise, closed: closed.promise,
    consume(callback) { listener = callback; return () => { listener = () => {}; }; },
    write(bytes, signal, onSent) {
      // As a process refuses a line (spawn.ts): its queue full while it lives, or its pipe gone.
      if (refusal !== undefined) return Promise.reject(new ProcessFailure(refusal));
      return new Promise((resolve, reject) => {
        const abort = () => reject(new ProcessFailure('aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        const send = () => {
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) { reject(new ProcessFailure('aborted')); return; }
          onSent?.(); writes.push(JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>); resolve();
        };
        if (paused) queued.push(send); else send();
      });
    },
    end() {},
    stop() { stopped++; return Promise.resolve({ ok: cleanupOk }); },
  };
  return {
    handle, writes,
    get stopped() { return stopped; },
    setCleanup(ok: boolean) { cleanupOk = ok; },
    /** Every write from now on is refused with this code, and nothing of it is taken; undefined takes writes again. */
    refuse(code: ProcessFailure['code'] | undefined) { refusal = code; },
    pause() { paused = true; },
    flush() { paused = false; queued.splice(0).forEach((send) => send()); },
    emit(event: ProcessEvent) {
      if (event.type === 'exit') exited.resolve(event.info);
      if (event.type === 'close') closed.resolve(event.info);
      listener(event);
    },
    bytes(text: string) { listener({ type: 'stdout', data: new TextEncoder().encode(text) }); },
    value(value: unknown) { listener({ type: 'stdout', data: new TextEncoder().encode(JSON.stringify(value) + '\n') }); },
  };
}
