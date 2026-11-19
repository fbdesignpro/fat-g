// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Explicit, lossless preferences migrations. Each step receives and returns the retained raw JSON
// document; spreading at the top level is intentional so fields unknown to this build survive.
export type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: (input) => ({ ...input, schemaVersion: 2, minReaderVersion: 2 }),
};

export type MigrationResult =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly applied: readonly number[] }
  | { readonly ok: false; readonly stuckAt: number };

export function migrate(
  value: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
): MigrationResult {
  let current = value;
  const applied: number[] = [];
  try {
    for (let version = fromVersion; version < toVersion; version += 1) {
      const step = migrations[version];
      if (step === undefined) return { ok: false, stuckAt: version };
      current = step(current);
      applied.push(version);
    }
  } catch {
    return { ok: false, stuckAt: fromVersion + applied.length };
  }
  return { ok: true, value: current, applied };
}
