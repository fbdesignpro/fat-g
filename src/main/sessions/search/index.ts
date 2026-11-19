// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import MiniSearch, { type SearchOptions, type SearchResult } from 'minisearch';
import { normalizeTerm, tokenize } from './text';

export interface SearchDocument { id: string; title: string; message: string }

/**
 * A logical index in small partitions. MiniSearch queries are synchronous: bounding each partition
 * lets even a broad prefix yield between queries, and releases intermediate hit objects early.
 * Only ids and postings are retained; snippets come from the conversation store.
 */
export class SessionSearchIndex {
  private readonly parts: MiniSearch<SearchDocument>[] = [];
  private readonly owners = new Map<string, MiniSearch<SearchDocument>>();

  add(document: SearchDocument): void {
    this.discard(document.id);
    let part = this.parts.at(-1);
    if (part === undefined || part.documentCount >= 128) {
      part = new MiniSearch<SearchDocument>({ fields: ['title', 'message'], tokenize, processTerm: normalizeTerm,
        searchOptions: { combineWith: 'AND', boost: { title: 3 }, weights: { prefix: 0.6, fuzzy: 0.4 } } });
      this.parts.push(part);
    }
    part.add(document);
    this.owners.set(document.id, part);
  }

  discard(id: string): void {
    const part = this.owners.get(id);
    if (part === undefined) return;
    part.discard(id);
    this.owners.delete(id);
    if (part.documentCount === 0) this.parts.splice(this.parts.indexOf(part), 1);
  }

  /** The caller checks its generation after each yield, so obsolete work stops without publishing. */
  async search(query: string, options: SearchOptions, accept: (hit: SearchResult) => void, proceed: () => Promise<boolean>): Promise<void> {
    for (const part of [...this.parts]) {
      if (!await proceed()) return;
      for (const hit of part.search(query, options)) accept(hit);
    }
  }
}
