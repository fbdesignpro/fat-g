// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Sample app state for tests in both Vitest projects (node and jsdom). Pure data and no Node APIs:
// tsconfig.web.json compiles this file too.
import type { AccountInfo } from '@shared/contracts/account';
import type { Theme } from '@shared/contracts/appearance';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { ProviderSnapshot } from '@shared/contracts/status';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { UsageWindow } from '@shared/contracts/usage';
import { sampleCatalog } from './catalog';

export const SAMPLE_EMAIL = 'user@example.com';
export const SAMPLE_ORGANIZATION = 'Example Org';

export function sampleWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: 'weekly',
    kind: 'weekly',
    label: 'Weekly',
    durationMs: 604_800_000,
    usedPercent: 32,
    resetsAt: 1_578_924_800_000,
    severity: 'normal',
    ...overrides,
  };
}

export function sampleAccount(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return { authKind: 'subscription', plan: 'max', email: SAMPLE_EMAIL, organization: SAMPLE_ORGANIZATION, ...overrides };
}

export function sampleDescriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: 'claude',
    displayName: 'Claude',
    installGuidance: 'Install the CLI.',
    loginCommand: 'claude auth login',
    minPollIntervalSec: 60,
    // The sample provider has sessions, so sample projects offer it (M15, C6); a test of a provider
    // without them says so itself.
    capabilities: { account: true, usage: 'poll', sessions: true, history: true, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null },
    ...overrides,
  };
}

export function sampleProvider(overrides: Partial<ProviderSnapshot> = {}): ProviderSnapshot {
  return {
    id: 'claude',
    // The provider's first instance, with no label of its own, of a module that declares no variable.
    instanceId: 'default',
    label: 'Default',
    instanceVariable: null,
    startedWithout: [],
    displayName: 'Claude',
    descriptor: sampleDescriptor(),
    installation: { source: 'path', version: '1.0.0' },
    status: { kind: 'ok' },
    account: sampleAccount(),
    usage: { windows: [sampleWindow()] },
    asOf: 1_578_851_400_000,
    nextRefreshAt: null,
    refreshing: false,
    ...overrides,
    ...(overrides.id !== undefined || overrides.displayName !== undefined
      ? { descriptor: overrides.descriptor ?? sampleDescriptor({ id: overrides.id ?? 'claude', displayName: overrides.displayName ?? 'Claude' }) }
      : {}),
  };
}

/** With a catalog entry for each of its providers, as main sets one before any window opens (M13). */
export function sampleSnapshot(seq = 1, providers?: readonly ProviderSnapshot[], theme: Theme = 'light'): AppStateSnapshot {
  const list = providers ?? [
    sampleProvider(),
    sampleProvider({ id: 'codex', displayName: 'Codex', account: sampleAccount({ plan: 'prolite', organization: undefined }) }),
  ];
  return { seq, appearance: { theme }, providers: list, catalog: sampleCatalog(list.map((provider) => provider.id)) };
}
