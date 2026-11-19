// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { PetPresentation } from '@shared/contracts/pet';

/**
 * A provider's colour, mark and stream: the catalog's in the Main window, and in the Pet, which has no
 * catalog, its own view's (decision 0010). Undefined for a provider neither holds.
 */
export function providerPresentation(snapshot: AppStateSnapshot | null, providerId: string): PetPresentation | undefined {
  return snapshot?.catalog?.providers.find((provider) => provider.id === providerId)?.presentation ?? snapshot?.pet?.presentation[providerId];
}
