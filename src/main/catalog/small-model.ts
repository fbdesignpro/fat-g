// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CatalogModel } from '@shared/contracts/catalog';
import type { ProviderDefinition } from '@shared/provider-kit/provider';

/** Compare numeric components, so 6.10 comes after 6.9. Equal versions keep the CLI's order. */
function newer(left: readonly number[], right: readonly number[]): boolean {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Uses only this account's visible reported models, never an invented or override-only model. */
export function latestSmallModel(models: readonly CatalogModel[], versionOf: ProviderDefinition['smallModelVersion']): string | undefined {
  if (versionOf === undefined) return undefined;
  let best: { key: string; version: readonly number[] } | undefined;
  for (const model of models) {
    if (model.hidden || model.origin !== 'reported') continue;
    const version = versionOf(model.resolvedId ?? model.key);
    if (version === null || version.some((part) => !Number.isSafeInteger(part) || part < 0)) continue;
    if (best === undefined || newer(version, best.version)) best = { key: model.key, version };
  }
  return best?.key;
}
