// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The unstable usage request (decision 0001, amended by 0006): the only production file that sends
// `get_usage` or knows the CLI's rejection text. One attempt, bounded and linked to session teardown.
// When the CLI renames or removes the request, this file is the whole change.
import type { ControlClient } from './control-client';

/**
 * The CLI's fixed answer to a control request it does not implement (checked against Claude Code
 * 2.1.268, and again in spike S2). Compared exactly, and only here: other control failures are
 * never version signals.
 */
const UNSUPPORTED_REQUEST: ReadonlySet<string> = new Set(['Unsupported control request subtype: get_usage', 'Unsupported control request subtype']);

export type ExperimentalUsage =
  | { readonly kind: 'available'; readonly value: unknown }
  /** Outcome C: the CLI rejected `get_usage` as unsupported — an account-only panel. */
  | { readonly kind: 'missing' }
  /** Timeout, abort or any other failure: transient, never "old CLI" or "logged out". */
  | { readonly kind: 'failed' };

export async function readExperimentalUsage(client: Pick<ControlClient, 'request'>, signal: AbortSignal, timeoutMs: number): Promise<ExperimentalUsage> {
  if (signal.aborted) return { kind: 'failed' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const reply = await client.request('get_usage', { skip_behaviors: true }, controller.signal);
    if (reply.kind === 'success') return { kind: 'available', value: reply.value };
    return UNSUPPORTED_REQUEST.has(reply.error) ? { kind: 'missing' } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
