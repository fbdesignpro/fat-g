// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { MAX_SEARCH_EXCERPT, type SearchRange } from '@shared/contracts/session-search';

const words = (): RegExp => /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
export const normalizeTerm = (term: string): string => term.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export const tokenize = (text: string): string[] => [...text.matchAll(words())].map((match) => match[0]);

export function matchRanges(text: string, terms: readonly string[]): SearchRange[] {
  const wanted = new Set(terms.map(normalizeTerm));
  return [...text.matchAll(words())].flatMap((match) => wanted.has(normalizeTerm(match[0])) ? [{ start: match.index, end: match.index + match[0].length }] : []);
}

/** Plain text and offsets, never HTML supplied by an index or a conversation. */
export function excerpt(text: string, terms: readonly string[]): { text: string; ranges: SearchRange[] } {
  const plain = text.replace(/\s+/gu, ' ');
  const ranges = matchRanges(plain, terms);
  let start = Math.max(0, (ranges[0]?.start ?? 0) - 60);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(plain[start] ?? '')) start -= 1;
  let end = Math.min(plain.length, start + MAX_SEARCH_EXCERPT - 2);
  if (/[\uD800-\uDBFF]/u.test(plain[end - 1] ?? '')) end -= 1;
  const prefix = start > 0 ? '…' : '';
  return {
    text: prefix + plain.slice(start, end) + (end < plain.length ? '…' : ''),
    ranges: ranges.filter((range) => range.end > start && range.start < end).map((range) => ({ start: Math.max(start, range.start) - start + prefix.length, end: Math.min(end, range.end) - start + prefix.length })),
  };
}
