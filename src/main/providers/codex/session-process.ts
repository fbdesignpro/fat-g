// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One process per session (docs/planning/_archive/M15.md, Design 5; C12, C13, C15, C23): `codex app-server`,
// started exactly as the instance's existing connection is — the same executable, the same argument,
// fat-g's own probe folder — through the instance's scope, so an added account's folder reaches it
// by the variable the process layer sets. A project's folder never goes on a command line: it is
// `cwd` inside a request, and a prompt a request's input.
//
// The connection is opened once and never restarted (C84). A line over the limit is dropped and
// counted, with the connection up (C19). The limit is a session's own, 4 MiB (M20a, C16): Codex cuts
// a command's output at 1 MiB, and JSON's escaping can double it on the line.
//
// Of a line over the limit two things are read, and nothing else is kept (docs/planning/_archive/M22.md,
// Design 8; C67, C71): its kind, and — for a request — its id. A request the CLI waits on would
// otherwise wait for ever. What the session is handed is that reading alone, never the line's bytes.
import type { ProviderContext } from '@shared/provider-kit/context';
import { MEDIA_SESSION_LINE_BYTES, type OversizedLine, PEEK_BYTES, type PeekedLine, peekLine } from '@shared/provider-kit/ndjson';
import { ProcessFailure, type Executable } from '@shared/provider-kit/process';
import type { OpenConnection, UnhandledListener } from '@shared/provider-kit/rpc';
import { sendNotification, sendRequest, SERVER_REQUESTS, sessionHandshake } from './methods';
import { codexSessionTrace } from './lifecycle-trace';

/**
 * Whether a line over the limit is a reply to a request of fat-g's own: an `id` with a `result` or
 * an `error`, and no `method`, among the keys before its first nested value. Such a line is no
 * request and waits for nothing: it is skipped and counted as before, and its request ends at its
 * own deadline (M15, C88). The shared peek reads a kind from a `method` alone, and would call it unknown.
 */
function isReply(line: OversizedLine): boolean {
  const whole = new TextDecoder('utf-8', { fatal: false }).decode(line.peek.subarray(0, PEEK_BYTES));
  const start = whole.indexOf('{');
  if (start === -1) return false;
  const nested = whole.slice(start + 1).search(/[{[]/);
  const head = nested === -1 ? whole.slice(start + 1) : whole.slice(start + 1, start + 1 + nested);
  return !/"method"\s*:/.test(head) && /"(?:result|error)"\s*:/.test(head);
}

/**
 * A line over a session's limit, read for its kind and its request id (M22, C67): `yes` for one of
 * the ten requests Codex's schema lists, each of which waits for a reply; `no` for any other
 * method, and for a reply; `maybe` where no kind can be read. The bytes go no further than here.
 */
export function readOversized(line: OversizedLine): PeekedLine {
  if (isReply(line)) return { request: 'no', id: null, size: line.size };
  return peekLine(line, { methods: SERVER_REQUESTS });
}

/** A session's deadlines (C15, C28, C89, C133). A turn itself has none. */
export interface SessionTimings {
  /** The process's start, with its handshake. */
  readonly launchMs: number;
  /** `thread/start`, `thread/resume`. */
  readonly openMs: number;
  /** `turn/start`. */
  readonly sendMs: number;
  /** From a Stop's press to the turn's end. */
  readonly stopMs: number;
  /** From the thread leaving `active` to a `turn/completed` that never comes. */
  readonly lostEndMs: number;
  /** A worker's closing item and its own turn's end, one held for the other. */
  readonly workerSettleMs: number;
}

export const SESSION_TIMINGS: SessionTimings = Object.freeze({ launchMs: 30_000, openMs: 30_000, sendMs: 15_000, stopMs: 10_000, lostEndMs: 2_000, workerSettleMs: 2_000 });

export interface SessionProcessOptions {
  readonly context: ProviderContext;
  readonly executable: Executable;
  /** Test and smoke launch prefix, as the existing connection takes it. */
  readonly argsPrefix: readonly string[];
  readonly applicationVersion: string;
  readonly launchMs: number;
  readonly signal: AbortSignal;
  /** Told of each line dropped as over the limit: what it is, as far as its first bytes say, and its size. */
  readonly onOversized: (line: PeekedLine) => void;
  /** The handshake without the experimental API (M22b, C80): for a CLI that refused it, whose sessions then plan nothing. */
  readonly plain?: boolean;
  readonly unhandled: UnhandledListener;
}

/**
 * Starts the process and makes its handshake, inside one deadline. A failure closes what was
 * started and throws; the caller names the step.
 */
export async function openSessionProcess(options: SessionProcessOptions): Promise<OpenConnection> {
  const { context, signal } = options;
  if (signal.aborted) throw new ProcessFailure('aborted');
  const deadline = Date.now() + options.launchMs;
  const connection = await context.processes.open({
    executable: options.executable,
    args: [...options.argsPrefix, 'app-server'],
    options: { cwd: context.probeDirectory, stdoutLimit: 1024 * 1024 },
    oversizedLines: 'drop',
    lineBytes: MEDIA_SESSION_LINE_BYTES,
    tracePolicy: codexSessionTrace,
    // The transport hands the line's first bytes with its count: a caller that gives none is counted as a line nothing could be read of.
    onDropped: (line?: OversizedLine) => options.onOversized(line === undefined ? { request: 'no', id: null, size: 0 } : readOversized(line)),
    unhandled: options.unhandled,
  });
  try {
    if (signal.aborted) throw new ProcessFailure('aborted');
    await sendRequest('session', connection, 'initialize', sessionHandshake(options.applicationVersion, options.plain === true), { timeoutMs: Math.max(1, deadline - Date.now()), signal });
    await sendNotification('session', connection, 'initialized', {});
    return connection;
  } catch (error) {
    await connection.close();
    throw error instanceof ProcessFailure ? error : new ProcessFailure('spawn-failed');
  }
}
