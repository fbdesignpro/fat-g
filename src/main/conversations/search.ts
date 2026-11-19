// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/** The store's search projection: saved session messages alone, with no provider fields. */
export interface SearchMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}
export interface SearchMessagePage {
  readonly messages: readonly SearchMessage[];
  readonly next: number | null;
}
/** Delivered only after commit. Null invalidates every outstanding read on close/reset. */
export type SearchChange = { readonly items: readonly string[]; readonly conversations: readonly string[] } | null;
export interface SearchMessageReader {
  searchMessages(after: number, sessionId?: string): SearchMessagePage;
  searchMessage(id: string): SearchMessage | null;
  subscribeSearch(listener: (change: SearchChange) => void): () => void;
}

export const SEARCH_FROM = "FROM item i JOIN conversation c ON c.id = i.conversationId WHERE c.parentId IS NULL AND c.removing = 0 AND i.workerId IS NULL AND i.kind = 'message' AND json_extract(i.body, '$.role') IN ('user', 'assistant')";
