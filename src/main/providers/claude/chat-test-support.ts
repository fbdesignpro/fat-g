// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A chat session's process for unit tests: what the adapter was launched with and wrote, and a way
// to answer it, to send it a frame of the CLI's, and to end the process. The real process, through
// the real process layer, is in tests/claude/chat/. No test library is imported: this file is not a
// test, and the runtime-dependencies test reads it as source.
import type { ProviderContext } from '@shared/provider-kit/context';
import type { DiagnosticEvent } from '@shared/provider-kit/logger';
import { ProcessFailure, type CleanupResult, type Executable, type FailureCode, type OpenedProcess, type RunOptions } from '@shared/provider-kit/process';
import type { ChatTimers } from './chat-launch';
import { type Frame, scriptedChild, type ScriptedChild } from './control-test-support';

/** One process the adapter opened. */
export interface ScriptedLaunch {
  readonly script: ScriptedChild;
  readonly executable: Executable;
  readonly args: readonly string[];
  readonly options: RunOptions;
  /** How often `close()` was called. */
  closes: number;
  /** What a close, the process's own end and a later look answer. */
  cleanup: CleanupResult;
  recheck: CleanupResult;
  /** Every frame fat-g wrote to it, in order. */
  readonly frames: Frame[];
  /** The latest request of that subtype fat-g wrote. */
  sent(subtype: string): Frame;
  /** The prompts fat-g wrote, as their frames. */
  prompts(): Frame[];
  /** Answers a request of fat-g's, as the CLI does. */
  reply(request: Frame, response?: unknown): void;
  refuse(request: Frame): void;
  /** One frame from the CLI. */
  frame(value: unknown): void;
  /** The process ends by itself. */
  end(code?: number | null): void;
  readonly ended: boolean;
}

export interface ScriptedChat {
  readonly context: ProviderContext;
  readonly launches: ScriptedLaunch[];
  latest(): ScriptedLaunch;
  readonly diagnostics: DiagnosticEvent[];
  /** The next launch is refused with this code, before any process exists. */
  failNextLaunch(code: FailureCode): void;
  /** Called with each launch as it is made, before the adapter writes to it. */
  onLaunch: ((launch: ScriptedLaunch) => void) | null;
}

/**
 * How the script answers the session's context requests (decision 0033): `refuse`, at once with the
 * error reply a CLI that has no such request gives, so a session asks once a process and no request
 * is left waiting on a timer; `manual`, never by itself — the test answers each, or lets it wait.
 */
export interface ScriptedChatOptions {
  readonly context?: 'refuse' | 'manual';
}

export function scriptedChat(options: ScriptedChatOptions = {}): ScriptedChat {
  const contextAnswer = options.context ?? 'refuse';
  const launches: ScriptedLaunch[] = [];
  const diagnostics: DiagnosticEvent[] = [];
  let refusal: FailureCode | undefined;
  const unused = (): Promise<never> => Promise.reject(new ProcessFailure('spawn-failed'));

  function open(executable: Executable, args: readonly string[], options: RunOptions): Promise<OpenedProcess> {
    if (refusal !== undefined) {
      const code = refusal;
      refusal = undefined;
      return Promise.reject(new ProcessFailure(code));
    }
    const script = scriptedChild({
      exitOnEnd: true,
      onFrame: (written, child) => { if (contextAnswer === 'refuse' && written.request?.['subtype'] === 'get_context_usage') child.reject(written, 'get_context_usage is not supported in this context'); },
    });
    let ended = false;
    let resolveDone: (result: CleanupResult) => void = () => undefined;
    const done = new Promise<CleanupResult>((resolve) => { resolveDone = resolve; });
    const launch: ScriptedLaunch = {
      script, executable, args, options, closes: 0, cleanup: { ok: true }, recheck: { ok: true },
      frames: script.frames,
      get ended() { return ended; },
      sent(subtype) {
        const found = script.frames.findLast((frame) => frame.request?.['subtype'] === subtype);
        if (found === undefined) throw new Error(`no ${subtype} request was written; written: ${script.frames.map((frame) => String(frame.request?.['subtype'] ?? frame['type'])).join(', ')}`);
        return found;
      },
      prompts: () => script.frames.filter((frame) => frame['type'] === 'user'),
      reply(request, response) { script.line({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, ...(response === undefined ? {} : { response }) } }); },
      refuse(request) { script.reject(request, 'refused'); },
      frame(value) { script.line(value); },
      end(code = 0) { script.exit(code); },
    };
    void script.child.closed.then(() => { ended = true; resolveDone(launch.cleanup); });
    launches.push(launch);
    chat.onLaunch?.(launch);
    return Promise.resolve({
      process: script.child,
      done,
      close() {
        launch.closes += 1;
        // A cleanup that cannot be confirmed leaves the process as it is: closed all the same.
        if (launch.cleanup.ok) script.exit(null); else { ended = true; resolveDone(launch.cleanup); }
        return done;
      },
      recheck: () => Promise.resolve(launch.recheck),
    });
  }

  const chat: ScriptedChat = {
    launches, diagnostics,
    onLaunch: null,
    latest() {
      const last = launches.at(-1);
      if (last === undefined) throw new Error('no process was opened');
      return last;
    },
    failNextLaunch(code) { refusal = code; },
    context: {
      processes: { resolve: unused, spawn: unused, run: unused, supervise: () => { throw new ProcessFailure('disposed'); }, open: unused, openProcess: open, recheck: () => Promise.resolve({ ok: true }), dispose: () => Promise.resolve({ ok: true }) },
      logger: { record: (event) => { diagnostics.push(event); } },
      probeDirectory: 'C:\\probe',
    },
  };
  return chat;
}

export interface ManualTimers extends ChatTimers {
  /** Runs every timer due within `ms` from now, in order. */
  advance(ms: number): void;
  /** The delays of the timers still set, soonest first. */
  pending(): number[];
}

/** A clock a test moves: the session's deadlines, handed in (docs/planning/_archive/M16.md, Verification). */
export function manualTimers(): ManualTimers {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    set(run, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clear(handle) { if (typeof handle === 'number') timers.delete(handle); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    pending: () => [...timers.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
  };
}

/** Lets every promise that is ready run: a few turns of the event loop, each after every microtask before it. */
export const settled = async (rounds = 4): Promise<void> => { for (let round = 0; round < rounds; round++) await new Promise<void>((resolve) => { setImmediate(resolve); }); };
