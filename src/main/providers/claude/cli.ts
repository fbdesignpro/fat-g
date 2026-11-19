// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One-shot CLI commands, each bounded and run from the neutral probe directory through the
// provider's process scope. `auth status` asks the CLI; it never reads a credential file.
import { ProcessFailure, type Executable, type ProviderProcesses } from '@shared/provider-kit/process';
import type { AccountResult } from '@shared/provider-kit/provider';
import { interpretAuthStatus } from './normalize';

export const CLI_LIMITS = {
  versionTimeoutMs: 5000,
  versionStdoutBytes: 16 * 1024,
  authTimeoutMs: 10_000,
  authStdoutBytes: 64 * 1024,
} as const;

/** A bounded semantic version from output such as `2.1.268 (Claude Code)`. */
const VERSION = /^(\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z.]{1,32})?)(?:\s+\([^()\r\n]{1,40}\))?$/;

export function parseVersion(stdout: string): string | null {
  if (stdout.length > 512) return null;
  return VERSION.exec(stdout.trim())?.[1] ?? null;
}

export interface CliCommand {
  readonly processes: ProviderProcesses;
  readonly executable: Executable;
  readonly cwd: string;
  /** Test/smoke only: a fixture script run by the resolved Node executable. */
  readonly argsPrefix?: readonly string[];
}

export async function readAuthStatus(command: CliCommand, signal: AbortSignal): Promise<AccountResult> {
  try {
    const result = await command.processes.run(command.executable, [...(command.argsPrefix ?? []), 'auth', 'status'], {
      cwd: command.cwd, signal, timeoutMs: CLI_LIMITS.authTimeoutMs, stdoutLimit: CLI_LIMITS.authStdoutBytes,
    });
    return interpretAuthStatus(result.code, result.stdout);
  } catch (error) {
    return { kind: 'error', reason: error instanceof ProcessFailure && error.code === 'cleanup-failed' ? 'cleanup-failed' : 'temporarily-unavailable' };
  }
}
