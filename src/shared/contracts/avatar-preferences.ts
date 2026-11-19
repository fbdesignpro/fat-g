// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The avatar section's own part beside the overrides (revision 14; decision 0031): each provider's
// active family. What a file holds is read entry by entry, an entry not of its form dropped without a
// word; a patch's entry sets or, null, removes one. How an avatar looks is its family's file alone
// (revision 15; decision 0032): the preferences hold no style.
//
// Renderer-safe: types, readers and merges over plain values.
import { type ActiveFamilies, type FamilyRef, isFamilyRef } from './avatars';

/** The active families a file holds: each a family reference of the form. Main keeps registered providers alone. */
export function readActiveFamilies(raw: Readonly<Record<string, unknown>>): ActiveFamilies {
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, FamilyRef] => isFamilyRef(entry[1])).map(([id, ref]) => [id, { origin: ref.origin, family: ref.family }]));
}

/** A patch's entries over the saved ones: a value sets one, null removes it. */
export function mergeEntries<T>(current: Readonly<Record<string, T>>, patch: Readonly<Record<string, T | null>> | undefined): Record<string, T> {
  const next: Record<string, T> = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
