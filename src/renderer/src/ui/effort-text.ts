// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CatalogEffort } from '@shared/contracts/catalog';

/**
 * The mark a level with a warning carries beside its label, wherever a level can be chosen or is
 * listed, a native select's option included (decision 0013): its provider's module says what choosing
 * it costs. Whether a level may be chosen for the user is its `caution` flag, apart.
 */
export const WARNING_MARK = '⚠';

/** "High", or "Max ⚠" for a level that warns. */
export function effortText(effort: Pick<CatalogEffort, 'label' | 'warning'>): string {
  return effort.warning === undefined ? effort.label : `${effort.label} ${WARNING_MARK}`;
}

/** What a level says of itself on hover and to assistive technology: its warning, then what its CLI says of it. */
export function effortExplanation(effort: Pick<CatalogEffort, 'warning' | 'description'>): string | undefined {
  const parts = [effort.warning, effort.description].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(' ');
}
