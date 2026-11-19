// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ProviderSnapshot, ProviderStatus } from '@shared/contracts/status';
import { formatTime } from './format';

/**
 * What a provider's status means and what to do about it, in a sentence or two — for the usage
 * panel and the provider's section in Settings. The actions themselves live in Settings, so this
 * says where to go rather than offering a button. `null` when there is nothing to say: the usage
 * is simply there.
 */
export function providerStatusDetail(provider: ProviderSnapshot): string | null {
  const { status } = provider;
  switch (status.kind) {
    case 'disabled':
      return 'Disabled in Settings.';
    case 'blocked':
      return blocked(status);
    case 'detecting':
      return provider.installation === null ? 'Checking the installed CLI…' : firstCheck(provider);
    case 'not-installed':
      return status.overrideInvalid ? 'The selected executable could not be used. Automatic detection was not attempted.' : provider.descriptor.installGuidance;
    case 'not-logged-in':
      return 'Sign-in is the CLI’s own, in a terminal and your browser: fat-g never sees your login.';
    case 'not-applicable':
      return notApplicable(status);
    case 'ok':
      return provider.usage === null || provider.usage.windows.length === 0 ? 'Usage data is not available yet.' : null;
    case 'stale':
      return 'These readings are historical; the latest checks have not succeeded.';
    case 'waking':
      return provider.usage === null || provider.usage.windows.length === 0
        ? 'The machine just woke and the CLI has not reported its allocations yet. fat-g is asking again every few seconds for a few minutes.'
        : 'The machine just woke and the CLI has not reported its allocations yet. These readings are from before it slept; fat-g is asking again every few seconds for a few minutes.';
    case 'error':
      return status.message;
  }
}

/**
 * The CLI is found and its first read is under way (M13, C89). A new runtime reads at once (C97), so
 * a time it is due shows only while something holds that read back.
 */
function firstCheck(provider: ProviderSnapshot): string {
  const version = provider.installation?.version;
  const found = version === null || version === undefined ? 'Found the CLI.' : `Found CLI ${version}.`;
  if (provider.refreshing) return `${found} Reading its account and usage…`;
  if (provider.nextRefreshAt !== null) return `${found} Its first check is due at ${formatTime(provider.nextRefreshAt)}.`;
  return `${found} Its first check is starting.`;
}

function blocked(status: Extract<ProviderStatus, { kind: 'blocked' }>): string {
  switch (status.reason) {
    case 'preferences-unavailable': return 'Providers are paused because the preferences file cannot be used. Settings says why and what to do.';
    case 'invalid-preferences': return 'This provider is paused because its saved controls need repair in Settings.';
    // An added account's own (M14b, C16, C37, C59): nothing is started for it.
    case 'invalid-instance': return 'This account is paused because its saved entry cannot be used. Settings says why; removing it there is the remedy.';
    case 'folder-missing': return 'This account’s folder is missing, or is not a folder, so nothing is started for it. Remove the account in Settings.';
    case 'folder-refused': return 'This account’s folder cannot be used, so nothing is started for it. Settings says why; removing the account there is the remedy.';
  }
}

function notApplicable(status: Extract<ProviderStatus, { kind: 'not-applicable' }>): string {
  switch (status.reason) {
    case 'api-key': return 'Subscription allocations do not apply while the CLI uses an API key.';
    case 'cloud-provider': return 'Subscription allocations do not apply to this cloud-provider configuration.';
    case 'unsupported-cli-version': return 'This CLI version does not expose compatible account usage data. Update it, then reconnect.';
    case 'usage-unavailable': return 'The CLI reported no usage allocations for this account.';
  }
}

/**
 * Readings kept while the latest checks fail: shown, but marked as historical (C66) — by a hollow
 * fill in the control bar and in words wherever they are listed.
 */
export function isHistorical(provider: ProviderSnapshot): boolean {
  return provider.status.kind === 'stale' || provider.status.kind === 'waking'
    || (provider.status.kind === 'error' && (provider.usage?.windows.length ?? 0) > 0);
}
