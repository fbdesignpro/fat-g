// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/**
 * Counts by kind (docs/planning/_archive/M19b.md, Design 7, 9; C35, C44): what main says of a file's read and
 * of an address it refused is a kind, counted — never a path, a target, an address or a text. In
 * memory, for the run, and read by the smoke run's report.
 */
export interface KindCounts {
  add(kind: string): void;
  snapshot(): Readonly<Record<string, number>>;
}

export function createKindCounts(): KindCounts {
  const counts = new Map<string, number>();
  return {
    add(kind) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    },
    snapshot: () => Object.fromEntries(counts),
  };
}
