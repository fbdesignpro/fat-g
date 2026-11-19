// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Smoke-mode provider composition: deterministic fixtures, accelerated timing, and a guard that no
// provider can resolve the CLIs installed on this machine. Electron-free, so it is unit-tested.
import path from 'node:path';
import type { ProviderDefinition } from '@shared/provider-kit/provider';
import type { BuiltInProviderOptions } from '../providers';

type Env = Readonly<Record<string, string | undefined>>;

/** Short test-only deadlines. Smoke waits stay longer than each of these plus cleanup. */
export const SMOKE_CLAUDE_TIMING = { minimumPollIntervalSec: 1, startupTimeoutMs: 2000, usageTimeoutMs: 2500 } as const;

export function smokeProviderOptions(env: Env): BuiltInProviderOptions {
  const names = fixtureExecutableNames(env);
  const codexFixture = absolute(env['FATG_SMOKE_CODEX_FIXTURE']);
  const claudeFixture = absolute(env['FATG_SMOKE_CLAUDE_FIXTURE']);
  const claudeDirectory = absolute(env['FATG_SMOKE_CLAUDE_DIR']);
  return {
    // Without its fixture a provider resolves nothing at all: smoke fails closed, never falling back
    // to a real CLI (and so to a real account).
    claude: claudeFixture === undefined || claudeDirectory === undefined ? { executableNames: [] } : {
      argsPrefix: [claudeFixture, '--fixture-dir', claudeDirectory],
      executableNames: names,
      ...SMOKE_CLAUDE_TIMING,
    },
    codex: codexFixture === undefined ? { executableNames: [] } : {
      argsPrefix: [codexFixture], executableNames: names,
      minimumPollIntervalSec: 1, requestTimeoutMs: 250, emptyRetryMs: 25,
      supervisorPolicy: { baseDelayMs: 50, maxDelayMs: 250, cooldownMs: 500 },
    },
  };
}

/** Where a smoke run looks for executables: only the smoke runner's Node directory. */
export function smokeKnownDirectories(env: Env): string[] | undefined {
  const node = absolute(env['FATG_SMOKE_NODE']);
  return node === undefined ? undefined : [path.dirname(node)];
}

/** True when every definition can only ever resolve the smoke runner's Node executable. */
export function fixtureOnlyProviders(definitions: readonly ProviderDefinition[], env: Env): boolean {
  const allowed = new Set(fixtureExecutableNames(env));
  return definitions.every((definition) => definition.executableNames.every((name) => allowed.has(name)));
}

function fixtureExecutableNames(env: Env): string[] {
  const node = absolute(env['FATG_SMOKE_NODE']);
  return [node === undefined ? 'node' : path.basename(node)];
}

function absolute(value: string | undefined): string | undefined {
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}
