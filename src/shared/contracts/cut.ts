// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The one cut for every bounded string (docs/planning/_archive/M15.md, C113). A file of its own since M20a,
// so that the activity contract and the agent events, which reads it, both cut by it.

/**
 * `value` cut to `max` UTF-16 units, never between the two halves of a surrogate pair (C113). The
 * one cut for every bounded string: the adapters use it as they take a field, the bridge for a name
 * and a label.
 */
export function cutTo(value: string, max: number): { readonly text: string; readonly cut: boolean } {
  if (value.length <= max) return { text: value, cut: false };
  const last = value.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return { text: value.slice(0, end), cut: true };
}

/**
 * The last `max` UTF-16 units of `value`, never from between the two halves of a surrogate pair:
 * what `cutTo` is to a text's start, for its end.
 */
export function cutFromEnd(value: string, max: number): string {
  if (value.length <= max) return value;
  const first = value.charCodeAt(value.length - max);
  const start = first >= 0xdc00 && first <= 0xdfff ? value.length - max + 1 : value.length - max;
  return value.slice(start);
}
