// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Session order is a saved list, independent of activity timestamps. These rules are shared by
// the authoritative records store and the page's drag preview; no provider knows about ordering.
import { z } from 'zod';

export const SessionOrderGroupSchema = z.strictObject({
  list: z.enum(['active', 'shelf', 'completed']),
  starred: z.boolean(),
});
export type SessionOrderGroup = z.infer<typeof SessionOrderGroupSchema>;
type OrderedSession = { readonly starred: boolean; readonly shelvedAt: number | null; readonly completedAt: number | null };

export function sessionOrderGroup(record: OrderedSession): SessionOrderGroup {
  return { list: record.shelvedAt !== null ? 'shelf' : record.completedAt !== null ? 'completed' : 'active', starred: record.starred };
}

export function sameSessionOrderGroup(a: SessionOrderGroup, b: SessionOrderGroup): boolean {
  return a.list === b.list && a.starred === b.starred;
}

/** Move one entry before a neighbour, or to its group's end. A no-op keeps the original list. */
export function moveSessionEntry<T>(entries: readonly T[], entry: T, before: T | null, belongs: (other: T) => boolean): readonly T[] {
  if (!entries.includes(entry) || !belongs(entry) || (before !== null && (!entries.includes(before) || !belongs(before)))) return entries;
  const group = entries.filter(belongs);
  if (before === entry || before === (group[group.indexOf(entry) + 1] ?? null)) return entries;
  const rest = entries.filter((other) => other !== entry);
  const at = before === null ? rest.findLastIndex(belongs) + 1 : rest.indexOf(before);
  return [...rest.slice(0, at), entry, ...rest.slice(at)];
}

/** Put an entry first in its group, leaving every other entry's relative order intact. */
export function promoteSessionEntry<T>(entries: readonly T[], entry: T, belongs: (other: T) => boolean): readonly T[] {
  const first = entries.find(belongs);
  return first === undefined ? entries : moveSessionEntry(entries, entry, first, belongs);
}
