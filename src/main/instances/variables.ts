// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the definitions declare about instances, gathered for the layers that may not name a
// provider or a variable (docs/planning/_archive/M14b.md, C5, C8).
import type { ProviderDefinition } from '@shared/provider-kit/provider';

/**
 * Every variable a provider declares as its configuration folder. No per-run override may set one,
 * in any scope, the first instance's included (C8): only an added instance's scope sets it, to the
 * folder the user picked.
 */
export function protectedVariables(definitions: readonly Pick<ProviderDefinition, 'instances'>[]): string[] {
  return [...new Set(definitions.flatMap((definition) => (definition.instances === undefined ? [] : [definition.instances.variable])))];
}
