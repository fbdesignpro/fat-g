// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One short-lived control session per usage read (decisions 0001 and 0006). fat-g's own client talks
// to the user's own binary, launched and cleaned up by fat-g's process layer, with exactly the
// arguments and `initialize` request the Agent SDK used for the same options — but without the SDK's
// identity: no entrypoint or SDK version variable is ever set. Idle: no prompt, no settings files,
// no MCP servers, no transcript. Torn down the same way on every path.
import { ProcessFailure, type CleanupResult, type Executable, type ManagedProcess, type ProviderProcesses } from '@shared/provider-kit/process';
import { createControlClient, type ControlClient } from './control-client';
import type { ClaudeModelReply } from './models';
import { readExperimentalUsage, type ExperimentalUsage } from './usage-experimental';

export const SESSION_LIMITS = {
  /** From entry: the launch and the `initialize` round trip that carries the account. */
  startupTimeoutMs: 15_000,
  /** The usage request alone, armed after the account passed its guard. */
  usageTimeoutMs: 10_000,
  /** After EOF the child may exit by itself before any forced cleanup (the SDK's own grace). */
  closeGraceMs: 2_000,
} as const;

/**
 * What Agent SDK 0.3.278 passed for fat-g's M7 options, as recorded in
 * tests/fixtures/claude/sdk-0.3.278-wire.json: stream-json both ways, no settings files, no MCP
 * servers — strictly, so not even the account's connectors — default permissions, no transcript.
 */
export const CONTROL_ARGS: readonly string[] = Object.freeze([
  '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  '--setting-sources=', '--strict-mcp-config', '--permission-mode', 'default', '--no-session-persistence',
]);

/** The SDK's `initialize` for those options. Its empty system prompt is never used: no turn runs. */
export const INITIALIZE_REQUEST: Readonly<Record<string, unknown>> = Object.freeze({ systemPrompt: Object.freeze(['']) });

export interface ClaudeSessionOptions {
  readonly processes: ProviderProcesses;
  readonly executable: Executable;
  readonly probeDirectory: string;
  /** Test/smoke only: a fixture script run by the resolved Node executable. */
  readonly argsPrefix?: readonly string[];
  /** Test/smoke only; production always uses SESSION_LIMITS. */
  readonly startupTimeoutMs?: number;
  readonly usageTimeoutMs?: number;
}

/**
 * `models`: the `initialize` reply's model list and fast-mode fields, unparsed — the catalog's, from
 * the reply this session already receives (M13, C27). Nothing else of the reply is kept.
 */
export type ClaudeSessionResult =
  | { readonly kind: 'read'; readonly account: unknown; readonly usage: ExperimentalUsage; readonly models: ClaudeModelReply }
  /** The account did not pass the caller's guard, so no usage request was sent. */
  | { readonly kind: 'account-only'; readonly account: unknown; readonly models: ClaudeModelReply }
  | { readonly kind: 'failed'; readonly reason: 'aborted' | 'startup-timeout' | 'unavailable' }
  /** Takes precedence over any reading: the session's tree could not be confirmed gone. */
  | { readonly kind: 'cleanup-failed' };

/**
 * `readUsageFor` validates the account the CLI reports before any usage request is sent. Resolves
 * only after the child tree is confirmed gone or its failure is latched.
 */
export async function runClaudeSession(options: ClaudeSessionOptions, signal: AbortSignal, readUsageFor: (account: unknown) => boolean): Promise<ClaudeSessionResult> {
  // Aborting this controller stops the whole tree at once (the child is spawned with its signal):
  // caller cancellation and the startup deadline. A normal end closes stdin instead.
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal.aborted) controller.abort(); else signal.addEventListener('abort', cancel, { once: true });
  let startupExpired = false;
  const startup = setTimeout(() => { startupExpired = true; controller.abort(); }, options.startupTimeoutMs ?? SESSION_LIMITS.startupTimeoutMs);
  let child: ManagedProcess | undefined;
  let client: ControlClient | undefined;
  let result: ClaudeSessionResult;
  try {
    if (controller.signal.aborted) throw new ProcessFailure('aborted');
    child = await beforeAbort(
      options.processes.spawn(options.executable, [...(options.argsPrefix ?? []), ...CONTROL_ARGS], { cwd: options.probeDirectory, signal: controller.signal }),
      controller.signal,
      (late) => { void late.stop(); },
    );
    client = createControlClient(child);
    const initialized = await client.request('initialize', INITIALIZE_REQUEST, controller.signal);
    if (initialized.kind !== 'success') throw new ProcessFailure('rpc-error');
    const reply = isRecord(initialized.value) ? initialized.value : {};
    const account = reply['account'];
    const models: ClaudeModelReply = { models: reply['models'], fastModeState: reply['fast_mode_state'], fastModeDisabledReason: reply['fast_mode_disabled_reason'] };
    clearTimeout(startup);
    if (!readUsageFor(account)) {
      result = { kind: 'account-only', account, models };
    } else {
      const usage = await readExperimentalUsage(client, controller.signal, options.usageTimeoutMs ?? SESSION_LIMITS.usageTimeoutMs);
      result = signal.aborted ? { kind: 'failed', reason: 'aborted' } : { kind: 'read', account, usage, models };
    }
  } catch (error) {
    if (error instanceof ProcessFailure && error.code === 'cleanup-failed') {
      result = { kind: 'cleanup-failed' }; // the scope is latched by an earlier child
    } else {
      result = { kind: 'failed', reason: startupExpired ? 'startup-timeout' : signal.aborted ? 'aborted' : 'unavailable' };
    }
  } finally {
    clearTimeout(startup);
    signal.removeEventListener('abort', cancel);
  }
  // Teardown, identical on every path: EOF, the grace to exit by itself, then confirm — or force —
  // registered tree cleanup. A child that already exited is confirmed without any kill.
  client?.close();
  let cleanup: CleanupResult = { ok: true };
  if (child !== undefined) {
    await closedWithin(child, SESSION_LIMITS.closeGraceMs);
    cleanup = await child.stop();
  }
  return cleanup.ok ? result : { kind: 'cleanup-failed' };
}

/** Rejects as soon as the signal aborts. A late value goes to `late`, a late failure is observed. */
function beforeAbort<T>(work: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new ProcessFailure('aborted')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    work.then((value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) late?.(value); else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(error instanceof Error ? error : new ProcessFailure('spawn-failed'));
    });
  });
}

/** Waits for the child's pipes to close, but never longer than `ms`, and leaves no timer behind. */
async function closedWithin(child: ManagedProcess, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([child.closed.then(() => undefined, () => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
