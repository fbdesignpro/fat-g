// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The launch of a chat session's process (decisions 0020, 0023, 0027; docs/planning/_archive/M16.md, Design 2,
// 3; C10–C14, C16, C17, C19, C20, C40, C88, C89; M20b.md, Design 3; C16, C54; M22.md, Design 6, 8; C5,
// C45, C47, C67): the user's own `claude`, started in the session's folder, in its instance's scope,
// once per session and never again by itself.
//
//   chatArguments ─► openProcess ─► the reader attached ─► `initialize` ─► its reply, by request id
//
// What it fixes is here and nowhere else: the arguments, the one variable the launch adds, and the
// deadlines. Two of the arguments are the session's mode's, from the mode table (chat-modes.ts): the
// permission mode the process starts under, and the tools it is offered. The reader has no total
// limit, and drops a line over the line limit with the session up (C16); the frames it reads are a
// few kilobytes each. Of a dropped line its kind and its request id are read, from its first bytes,
// and nothing else of it (M22, C67). No frame is logged, and none is kept.
import type { DiagnosticLogger } from '@shared/provider-kit/logger';
import { NdjsonDecoder, type PeekedLine, peekLine, SESSION_LINE_BYTES } from '@shared/provider-kit/ndjson';
import { ProcessFailure, shimRefuses, type CleanupResult, type Executable, type OpenedProcess, type ProviderProcesses } from '@shared/provider-kit/process';
import type { SessionStart } from '@shared/provider-kit/sessions';
import { claudeMode, type ClaudeMode, EXECUTION_TOOLS } from './chat-modes';
import { type ChatAnswer, type ChatSend, createChatWire, type PromptImage } from './chat-wire';

/** Every built-in tool a launch can offer, whatever its mode (M22, C5): the mode table's widest list. No launch offers a tool outside it. */
export const CHAT_TOOLS = EXECUTION_TOOLS;

/**
 * What every chat session's launch carries, in this order (C12, C14, C17; M19, C9; M22, C5, C45).
 * Stream-json both ways; the user's own configuration, through the CLI; the permission mode of the
 * session's mode, with every request sent to fat-g, which grants what the user grants on its card
 * and nothing else; the mode's tool list; and a reply's text as it is written, in `stream_event`
 * frames beside the whole messages, which stay the authority for what was said (M19).
 *
 * The mode's two values are the mode table's own (chat-modes.ts), and nothing else of a launch
 * differs by mode: no flag is added for any of them, the one that acts without asking included (C47).
 *
 * The CLI's own commands and skills are on, as in the terminal (M20b, C54; decision 0023): a prompt
 * that names one reaches the CLI as it was written, but for the few fat-g answers itself
 * (chat-commands.ts). No `Skill` tool is offered under any mode, and a skill runs only at the
 * user's word.
 */
export function chatFixedArgs(mode: ClaudeMode): readonly string[] {
  return Object.freeze([
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--setting-sources', 'user,project,local',
    '--permission-mode', mode.native, '--permission-prompt-tool', 'stdio',
    '--tools', mode.tools.join(','),
    '--include-partial-messages',
  ]);
}

/**
 * The one variable a launch adds to its scope's environment (C40): without it the `Agent` tool
 * starts its worker in the background, the turn ends while the worker runs, and the CLI then starts
 * a turn by itself. It is set here and never inherited: the keep list leaves it out (environment.ts).
 */
export const CHAT_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });

/** A session's deadlines (C88, C89). The turn's `init` has none, and neither has a turn. */
export interface ChatTimings {
  /**
   * The launch, to its `initialize` reply. Two minutes: a `SessionStart` hook of the user's holds
   * that reply back for as long as it runs, at every launch (C89, K26).
   */
  readonly launchMs: number;
  /** `apply_flag_settings`, to its reply. */
  readonly effortMs: number;
  /** A change of the permission mode, to its reply (M22, C5): as long as the effort's. */
  readonly modeMs: number;
  /** From the prompt's write to the frame that says the CLI took it, which comes before any hook of the user's (C88). */
  readonly startedMs: number;
  /** From a Stop's press to the turn's end. */
  readonly stopMs: number;
  /** How long a worker's frame is held for the `task_started` that pairs it with its worker (M20a, C22): as long as a Codex worker's closing is held for its other frame. */
  readonly pairMs: number;
  /** A side question, to its reply (M20b, C16): ten minutes, under the eleven the SDK's own bridge allows. */
  readonly asideMs: number;
  /** A context reading's request, to its reply (decision 0033): as long as the effort's. Nothing waits on it. */
  readonly contextMs: number;
}

export const CHAT_TIMINGS: ChatTimings = Object.freeze({ launchMs: 120_000, effortMs: 15_000, modeMs: 15_000, startedMs: 30_000, stopMs: 10_000, pairMs: 2_000, asideMs: 600_000, contextMs: 15_000 });

export interface ChatTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const REAL_TIMERS: ChatTimers = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export interface ChatArguments {
  readonly args: readonly string[];
  /** How many of the other folders a shim launch would refuse, and so were left out (C20). */
  readonly leftOut: number;
}

/**
 * The whole argument line: a function of the executable's kind and the session's start, and of
 * nothing else. A prompt never goes on it (C13).
 *
 * Per session: its mode's permission mode and tools, in the fixed list's own places (M22, C5) — a
 * start that names no mode, or one this build does not know, is the reading mode's; the record's
 * model key; its effort, left out for a model with no levels; the reference of a started session;
 * and each other folder main handed over. A folder whose path a
 * launch through a `.cmd` shim would refuse is left out by the rule the process layer itself
 * applies, so the launch is never refused for it (C20). The working folder is no argument.
 */
export function chatArguments(kind: Executable['kind'], start: SessionStart, reference: string | null): ChatArguments {
  const passed = kind === 'cmd-shim' ? start.otherFolders.filter((folder) => !shimRefuses(folder)) : start.otherFolders;
  return {
    args: [
      ...chatFixedArgs(claudeMode(start.mode)),
      '--model', start.model,
      ...(start.effort === null ? [] : ['--effort', start.effort]),
      ...(reference === null ? [] : ['--resume', reference]),
      ...passed.flatMap((folder) => ['--add-dir', folder]),
    ],
    leftOut: start.otherFolders.length - passed.length,
  };
}

/** A request of fat-g's that waits for a reply: seven of the wire's ten. */
export type ChatRequest = Exclude<ChatSend, { readonly kind: 'prompt' | 'steer' | 'cancel' }>;

/** One chat session's process, opened: what is sent to it, and how it ends. Every frame it sends goes to the session. */
export interface ChatConnection {
  /** The `initialize` reply's value, unparsed. */
  readonly reply: unknown;
  /**
   * Sends one request and resolves with its reply's value. Rejects with a ProcessFailure: `timeout`
   * at the deadline, `aborted`, `rpc-error` when the CLI refused it, `transport-closed` when the
   * process ended or the write failed.
   */
  request(what: ChatRequest, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  /**
   * The same, with the id the request was given (M20b, C15): what a cancel names. `requestId` is
   * null where nothing was written — the process had ended, or the signal was aborted — and `reply`
   * then rejects.
   */
  begin(what: ChatRequest, timeoutMs: number, signal?: AbortSignal): { readonly requestId: string | null; readonly reply: Promise<unknown> };
  /** Takes back a request that still waits, by its id (M20b, C15). Its reply, an error, answers that request. */
  cancel(requestId: string): void;
  /** Writes one prompt, with its images (M23, C21). Resolves once it was handed to the process; rejects when it could not be. */
  prompt(id: string, text: string, images?: readonly PromptImage[]): Promise<void>;
  /** Writes one message while a turn runs (M23, C36), as a prompt is written. */
  steer(id: string, text: string, images?: readonly PromptImage[]): Promise<void>;
  /**
   * Answers a request of the CLI's. The promise is the write's (M21, C14, C66): true once the line
   * was handed to the process, false when it was not — the process refused it or had ended, or the
   * request's id is too long to echo.
   */
  answer(what: ChatAnswer): Promise<boolean>;
  /** Resolves when the process has ended, with whether its tree is confirmed gone. */
  readonly done: Promise<CleanupResult>;
  close(): Promise<CleanupResult>;
  recheck(): Promise<CleanupResult>;
}

export interface ChatLaunchOptions {
  readonly processes: Pick<ProviderProcesses, 'openProcess'>;
  readonly logger: DiagnosticLogger;
  readonly executable: Executable;
  /** Test and smoke launch prefix, as the usage session takes it. */
  readonly argsPrefix: readonly string[];
  /** From `chatArguments`. */
  readonly args: readonly string[];
  /** The session's folder: the process's working folder. */
  readonly folder: string;
  /**
   * The CLI's word for the mode the launch names (M22b, C7, C51): the wire holds it, so that a plan
   * turn's restoration may name it and no other change does. Left out, none.
   */
  readonly launchWord?: string | null;
  readonly launchMs: number;
  readonly timers: ChatTimers;
  /** Cancels the launch: what was started is closed. */
  readonly signal: AbortSignal;
  /**
   * Every frame that is no reply to a request of fat-g's, from the first line on: those that arrive
   * before the `initialize` reply too, a hook's among them, which the session drops and counts as
   * any frame of no turn (K26). `answer` answers a request of the CLI's, which can come that early,
   * and says whether its line went (M21, C66).
   */
  readonly onFrame: (frame: unknown, answer: (what: ChatAnswer) => Promise<boolean>) => void;
  /**
   * A line over the line limit was dropped (C16). `line` is what its first bytes say it was (M22,
   * C67): whether it is, or may be, a request of the CLI's, its id where one could be read, and its
   * size. `answer` answers that request, by that id.
   */
  readonly onOversized: (line: PeekedLine, answer: (what: ChatAnswer) => Promise<boolean>) => void;
}

/**
 * Why a launch failed. `spawn`: no process was started. `initialize`: one was, and `initialize` was
 * refused, late, cancelled, or the process ended first. `missing`: before that, the process sent
 * the one frame a resume of a session Claude no longer has gives — a `result` that is an error and
 * counts no turn (C26, K3). The frame says that the resume could not be made, and not why.
 */
export class ChatLaunchFailure extends Error {
  constructor(
    readonly stage: 'spawn' | 'initialize',
    readonly missing: boolean,
    /** Whether the tree of the process that was started is confirmed gone; true when none was. */
    readonly cleanup: CleanupResult = { ok: true },
    /** That tree's read-only recheck, after an end that was not confirmed. */
    readonly recheck: () => Promise<CleanupResult> = () => Promise.resolve({ ok: true }),
  ) {
    super(stage);
    this.name = 'ChatLaunchFailure';
  }
}

interface Pending { resolve(value: unknown): void; reject(error: ProcessFailure): void }

/** The one type of line by which the CLI asks something and waits for a reply: what a line over the limit is read for (M22, C67). */
const REQUEST_TYPE = 'control_request';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Starts the process and makes its `initialize`, inside one deadline. A failure closes what was
 * started and throws a ChatLaunchFailure; the caller names the step.
 */
export async function launchChat(options: ChatLaunchOptions): Promise<ChatConnection> {
  const { timers, signal } = options;
  if (signal.aborted) throw new ChatLaunchFailure('spawn', false);
  let opened: OpenedProcess;
  try {
    opened = await options.processes.openProcess(options.executable, [...options.argsPrefix, ...options.args], { cwd: options.folder, env: CHAT_ENVIRONMENT });
  } catch {
    throw new ChatLaunchFailure('spawn', false);
  }

  const wire = createChatWire(opened.process, options.launchWord ?? null);
  const pending = new Map<string, Pending>();
  let ended = false;
  // One close, whoever asks for it: the launch's own failure, the reader's end, the session.
  // Asked once even when the close itself ends the reader, which asks again before it has returned.
  let closeAsked = false;
  let closing: Promise<CleanupResult> | null = null;
  const close = (): Promise<CleanupResult> => {
    if (!closeAsked) { closeAsked = true; closing = opened.close(); }
    return closing ?? opened.done;
  };
  /** C26's sign was seen before any reply. */
  let missing = false;
  let replied = false;
  /** Answers a request of the CLI's, from the first frame on. Once the process has ended nothing is written: false. */
  const answer = (what: ChatAnswer): Promise<boolean> => (ended ? Promise.resolve(false) : wire.answer(what));

  function failAll(code: 'transport-closed'): void {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(new ProcessFailure(code));
  }

  /** Nothing more can be read: what waits for a reply fails, and the process is ended. */
  function end(): void {
    if (ended) return;
    ended = true;
    failAll('transport-closed');
    void close();
  }

  function route(frame: unknown): void {
    if (isRecord(frame) && frame['type'] === 'control_response') {
      const response = frame['response'];
      const entry = isRecord(response) && typeof response['request_id'] === 'string' ? pending.get(response['request_id']) : undefined;
      if (entry !== undefined && isRecord(response)) {
        pending.delete(response['request_id'] as string);
        // The reply's own words, on a refusal, are never read (C26).
        if (response['subtype'] === 'success') entry.resolve(response['response']); else entry.reject(new ProcessFailure('rpc-error'));
        return;
      }
    }
    if (!replied && isRecord(frame) && frame['type'] === 'result' && frame['is_error'] === true && frame['num_turns'] === 0) missing = true;
    try { options.onFrame(frame, answer); } catch { /* the session's own failure is its own */ }
  }

  // A non-JSON line is counted and dropped; a line over the limit is skipped to its newline, with
  // the session up (C16). The limit is a session's own, 4 MiB (M20a, C16): a tool's result arrives
  // with its frame, and is cut to its own bound by the mapping. Invalid UTF-8 breaks the framing
  // itself: nothing more is read. Of a line over the limit the first bytes are looked at once, for
  // the one type of line that waits for a reply and for its id (M22, C67), and are then let go.
  const decoder = new NdjsonDecoder(route, () => options.logger.record({ type: 'malformed-frame' }), SESSION_LINE_BYTES, (line) => {
    options.logger.record({ type: 'frame-dropped', reason: 'oversized' });
    // With the request's tool, read in its own keys (M22b, C61, C79): a plan's is refused with its own notice.
    try { options.onOversized(peekLine(line, { types: [REQUEST_TYPE], name: { object: 'request', field: 'tool_name' } }), answer); } catch { /* the session's count is its own */ }
  });
  opened.process.consume((event) => {
    switch (event.type) {
      case 'stdout':
        if (ended) return;
        try { decoder.push(event.data); } catch { end(); }
        return;
      case 'eof':
        try { decoder.end(); } catch { /* the last line was no text */ }
        end();
        return;
      case 'error':
        end();
        return;
      // `exit` can precede the last stdout bytes, so what is still in the pipe is read until EOF;
      // a write failure surfaces through the write itself.
      case 'exit':
      case 'close':
      case 'stdin-error':
        return;
    }
  });
  void opened.done.then(() => { ended = true; failAll('transport-closed'); });

  function begin(what: ChatRequest, timeoutMs: number, requestSignal?: AbortSignal): { readonly requestId: string | null; readonly reply: Promise<unknown> } {
    if (ended) return { requestId: null, reply: Promise.reject(new ProcessFailure('transport-closed')) };
    if (requestSignal?.aborted) return { requestId: null, reply: Promise.reject(new ProcessFailure('aborted')) };
    const sent = wire.send(what);
    const id = sent.requestId as string;
    const reply = new Promise<unknown>((resolve, reject) => {
      const finish = (work: () => void): void => {
        pending.delete(id);
        timers.clear(timer);
        requestSignal?.removeEventListener('abort', abort);
        work();
      };
      const abort = (): void => finish(() => reject(new ProcessFailure('aborted')));
      const timer = timers.set(() => finish(() => reject(new ProcessFailure('timeout'))), timeoutMs);
      pending.set(id, { resolve: (value) => finish(() => resolve(value)), reject: (error) => finish(() => reject(error)) });
      requestSignal?.addEventListener('abort', abort, { once: true });
      sent.written.catch(() => { if (pending.has(id)) finish(() => reject(new ProcessFailure('transport-closed'))); });
    });
    return { requestId: id, reply };
  }
  const request = (what: ChatRequest, timeoutMs: number, requestSignal?: AbortSignal): Promise<unknown> => begin(what, timeoutMs, requestSignal).reply;

  let reply: unknown;
  try {
    reply = await request({ kind: 'initialize' }, options.launchMs, signal);
    replied = true;
  } catch {
    const cleanup = await close();
    throw new ChatLaunchFailure('initialize', missing, cleanup, () => opened.recheck());
  }

  return {
    reply,
    request,
    begin,
    // Only for a request that still waits: one that was answered, or given up, has nothing to take back.
    cancel(requestId) { if (!ended && pending.has(requestId)) void wire.send({ kind: 'cancel', requestId }).written.catch(() => undefined); },
    prompt: (id, text, images = []) => (ended ? Promise.reject(new ProcessFailure('transport-closed')) : wire.send({ kind: 'prompt', id, text, ...(images.length === 0 ? {} : { images }) }).written),
    steer: (id, text, images = []) => (ended ? Promise.reject(new ProcessFailure('transport-closed')) : wire.send({ kind: 'steer', id, text, ...(images.length === 0 ? {} : { images }) }).written),
    answer,
    done: opened.done,
    close,
    recheck: () => opened.recheck(),
  };
}
