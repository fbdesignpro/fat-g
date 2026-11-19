// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type InstanceRef, shownLabel } from '@shared/contracts/instances';
import type { ProviderSnapshot } from '@shared/contracts/status';

/** Account labels disambiguate a provider's configured accounts; a single account needs none. */
export function presetAccountName(accounts: readonly ProviderSnapshot[], ref: InstanceRef): string {
  const name = accounts.find((account) => account.id === ref.providerId)?.displayName ?? ref.providerId;
  const label = shownLabel(accounts, ref);
  return label === null ? name : `${name} (${label})`;
}
