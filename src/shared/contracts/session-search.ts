// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/** Search is Main-only transient content, never part of the app snapshot or preferences. */
export const SEARCH_PAGE_SIZE = 50;
export const MAX_SEARCH_QUERY = 200;
export const MAX_SEARCH_EXCERPT = 240;

export const SessionSearchRequestSchema = z.strictObject({
  query: z.string().max(MAX_SEARCH_QUERY),
  projectId: z.guid().nullable(),
  state: z.enum(['all', 'active', 'done', 'shelved']),
  scope: z.enum(['all', 'names', 'messages']),
  sort: z.enum(['match', 'recent']),
  fuzzy: z.boolean(),
  offset: z.number().int().min(0).max(1_000_000),
});
export type SessionSearchRequest = z.infer<typeof SessionSearchRequestSchema>;
export type SearchFilters = Omit<SessionSearchRequest, 'query' | 'offset'>;
export const DEFAULT_SEARCH_FILTERS: SearchFilters = { projectId: null, state: 'all', scope: 'all', sort: 'match', fuzzy: true };

/** Half-open UTF-16 offsets into the accompanying plain text. */
export interface SearchRange { readonly start: number; readonly end: number }
export interface SessionSearchHit {
  readonly sessionId: string;
  readonly titleRanges: readonly SearchRange[];
  readonly excerpt: { readonly text: string; readonly role: 'user' | 'assistant'; readonly ranges: readonly SearchRange[] } | null;
}
export interface SessionSearchResult {
  readonly status: 'ready' | 'indexing' | 'messages-unavailable' | 'records-unavailable';
  readonly hits: readonly SessionSearchHit[];
  readonly total: number;
  readonly more: boolean;
}
