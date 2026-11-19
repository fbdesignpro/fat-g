// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ProviderSnapshot, ProviderStatus } from '@shared/contracts/status';

/** The label, or "Up to date" for a provider whose usage is simply there — for describing it in full. */
export function providerStatusSummary(provider: ProviderSnapshot): string {
  if (provider.status.kind === 'ok' && (provider.usage?.windows.length ?? 0) > 0) return 'Up to date';
  return providerStatusLabel(provider);
}

function blockedLabel(status: Extract<ProviderStatus, { kind: 'blocked' }>): string {
  switch (status.reason) {
    case 'preferences-unavailable': return 'Preferences unavailable';
    case 'invalid-preferences': return 'Preferences need repair';
    // An added account's own (M14b, C16, C37, C59).
    case 'invalid-instance': return 'Account needs repair';
    case 'folder-missing': return 'Folder missing';
    case 'folder-refused': return 'Folder not usable';
  }
}

/**
 * A provider's status in a few words, for compact places: the Pet, a usage block in the control bar,
 * the status line in Settings. Never carries personal data (status messages may not).
 */
export function providerStatusLabel(provider: Pick<ProviderSnapshot, 'status' | 'installation'>): string {
  const status: ProviderStatus = provider.status;
  switch (status.kind) {
    case 'disabled': return 'Disabled';
    case 'blocked': return blockedLabel(status);
    // Once the CLI is found, what is left is its first read (M13, C89).
    case 'detecting': return provider.installation === null ? 'Detecting CLI' : 'Checking usage';
    case 'not-installed': return status.overrideInvalid ? 'Selected CLI unavailable' : 'CLI not found';
    case 'not-logged-in': return 'Sign-in needed';
    case 'not-applicable': return 'Usage not applicable';
    case 'ok': return 'Usage unavailable';
    case 'stale': return 'Usage stale';
    // The one wording for the wake's recovery: this label, and the caption beside a block's bars.
    case 'waking': return 'Updating after machine sleep';
    case 'error': return 'Usage error';
  }
}
