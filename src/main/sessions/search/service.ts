// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { SearchResult } from 'minisearch';
import { SEARCH_PAGE_SIZE, type SessionSearchRequest, type SessionSearchResult } from '@shared/contracts/session-search';
import { sessionLabel, type SessionEntry } from '@shared/contracts/sessions';
import type { ConversationStore } from '../../conversations/store';
import type { SearchMessage } from '../../conversations/search';
import type { RecordsStore } from '../../records/store';
import { excerpt, matchRanges, tokenize } from './text';
import { SessionSearchIndex, type SearchDocument } from './index';

interface Source { sessionId: string; itemId: string | null }
interface Match { score: number; titleTerms: string[]; message: SearchResult | null }
export interface SessionSearch {
  search(request: SessionSearchRequest): Promise<SessionSearchResult>;
  release(): void;
  stop(): void;
}
export interface SearchDeps {
  readonly conversations: Pick<ConversationStore, 'status' | 'searchMessages' | 'searchMessage' | 'subscribeSearch'>;
  readonly records: Pick<RecordsStore, 'isRefused' | 'subscribe'>;
  readonly sessions: () => readonly SessionEntry[];
  /** Batches yield to live chat and window work. Tests can hold a batch at this boundary. */
  readonly yield?: () => Promise<void>;
}

const empty = (status: SessionSearchResult['status']): SessionSearchResult => ({ status, hits: [], total: 0, more: false });

/** One ephemeral index for Main. Only the store reads SQLite; no text is serialized here. */
export function createSessionSearch(deps: SearchDeps): SessionSearch {
  const pause = deps.yield ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  let index = new SessionSearchIndex();
  const sources = new Map<string, Source>();
  const bySession = new Map<string, Set<string>>();
  const names = new Map<string, string | null>();
  let sessions = new Map<string, SessionEntry>();
  const dirtyItems = new Set<string>();
  const dirtySessions = new Set<string>();
  let generation = 0;
  let built = false;
  let failed = false;
  let stopped = false;
  let building: Promise<void> | null = null;
  let refreshing: Promise<void> | null = null;
  let revision = 0;
  let serial = 0;
  let cached: { readonly key: string; readonly revision: number; readonly result: SessionSearchResult } | null = null;

  function discard(id: string): void {
    const source = sources.get(id);
    if (source === undefined) return;
    index.discard(id);
    sources.delete(id);
    bySession.get(source.sessionId)?.delete(id);
  }

  function discardSession(id: string, messagesOnly = false): void {
    for (const doc of [...(bySession.get(id) ?? [])]) if (!messagesOnly || sources.get(doc)?.itemId !== null) discard(doc);
    if (!messagesOnly) { bySession.delete(id); names.delete(id); }
  }

  function add(document: SearchDocument, source: Source): void {
    discard(document.id);
    index.add(document);
    sources.set(document.id, source);
    const ids = bySession.get(source.sessionId) ?? new Set<string>();
    ids.add(document.id);
    bySession.set(source.sessionId, ids);
  }

  function addMessage(message: SearchMessage): void {
    if (!sessions.has(message.sessionId) || message.text.trim() === '') return;
    add({ id: `m:${message.id}`, title: '', message: message.text }, { sessionId: message.sessionId, itemId: message.id });
  }

  function reset(): void {
    generation += 1;
    index = new SessionSearchIndex();
    sources.clear(); bySession.clear(); names.clear(); sessions.clear();
    dirtyItems.clear(); dirtySessions.clear();
    built = false; failed = false; building = null; refreshing = null;
    revision += 1; cached = null;
  }

  function syncSessions(): void {
    if (deps.records.isRefused()) { reset(); return; }
    const next = new Map(deps.sessions().filter((entry) => entry.summary.status !== 'not-started' || entry.record.name !== null || entry.content === true).map((entry) => [entry.record.id, entry]));
    for (const id of sessions.keys()) if (!next.has(id)) discardSession(id);
    for (const [id, entry] of next) {
      if ((built || building !== null) && !sessions.has(id)) dirtySessions.add(id);
      if (!names.has(id) || names.get(id) !== entry.record.name) {
        discard(`n:${id}`);
        if (entry.record.name !== null) add({ id: `n:${id}`, title: entry.record.name, message: '' }, { sessionId: id, itemId: null });
        names.set(id, entry.record.name);
      }
    }
    sessions = next;
  }

  async function scan(epoch: number, sessionId?: string): Promise<void> {
    let cursor = 0;
    do {
      await pause();
      if (epoch !== generation || stopped) return;
      const page = deps.conversations.searchMessages(cursor, sessionId);
      for (const message of page.messages) addMessage(message);
      if (page.next === null) return;
      cursor = page.next;
    } while (epoch === generation && !stopped);
  }

  async function refresh(epoch: number): Promise<void> {
    const changedSessions = [...dirtySessions];
    const changedItems = [...dirtyItems];
    dirtySessions.clear(); dirtyItems.clear();
    for (const id of changedSessions) {
      if (!sessions.has(id)) continue;
      discardSession(id, true);
      await scan(epoch, id);
      if (epoch !== generation || stopped) return;
    }
    for (let at = 0; at < changedItems.length; at += 16) {
      await pause();
      if (epoch !== generation || stopped) return;
      for (const id of changedItems.slice(at, at + 16)) {
        discard(`m:${id}`);
        const message = deps.conversations.searchMessage(id);
        if (message !== null) addMessage(message);
      }
    }
  }

  const unsubscribeContent = deps.conversations.subscribeSearch((change) => {
    if (change === null) { reset(); return; }
    revision += 1; cached = null;
    if (!built && building === null) return;
    for (const id of change.items) { discard(`m:${id}`); dirtyItems.add(id); }
    for (const id of change.conversations) { discardSession(id, true); dirtySessions.add(id); }
  });
  const unsubscribeRecords = deps.records.subscribe(() => {
    revision += 1; cached = null;
    // Removals must disappear even while the dialog is closed or a build is yielding.
    if (!stopped && (built || building !== null || names.size > 0)) syncSessions();
  });

  function startBuild(): void {
    const epoch = generation;
    building = (async () => {
      try {
        await scan(epoch);
        if (epoch !== generation || stopped) return;
        await refresh(epoch);
        if (epoch === generation && !stopped) built = true;
      } catch {
        if (epoch === generation) failed = true;
      } finally {
        if (epoch === generation) building = null;
      }
    })();
  }

  return {
    async search(request) {
      const sequence = ++serial;
      if (stopped || deps.records.isRefused()) return empty('records-unavailable');
      syncSessions();
      const epoch = generation;
      const readable = deps.conversations.status().kind === 'ok';
      if (request.scope !== 'names' && readable && !failed) {
        if (!built && building === null) startBuild();
        else if (built) {
          refreshing ??= refresh(epoch).catch(() => { if (epoch === generation) failed = true; }).finally(() => { if (epoch === generation) refreshing = null; });
          await refreshing;
        }
      }
      if (epoch !== generation || stopped) return empty('indexing');
      syncSessions();
      const status = request.scope === 'names' ? 'ready' : !readable || failed ? 'messages-unavailable' : !built || dirtyItems.size > 0 || dirtySessions.size > 0 ? 'indexing' : 'ready';
      const key = JSON.stringify(request);
      if (status === 'ready' && cached?.key === key && cached.revision === revision) return cached.result;
      const searchedRevision = revision;
      const allowed = (entry: SessionEntry): boolean => (request.projectId === null || entry.record.projectId === request.projectId)
        && (request.state === 'all' || (request.state === 'done' ? entry.record.completedAt !== null : request.state === 'shelved' ? entry.record.shelvedAt !== null : entry.record.completedAt === null && entry.record.shelvedAt === null));
      const matches = new Map<string, Match>();
      const query = request.query.trim();
      if (query === '') {
        for (const [id, entry] of sessions) if (allowed(entry)) matches.set(id, { score: 0, titleTerms: [], message: null });
      } else if (tokenize(query).length > 0) {
        await index.search(query, {
          fields: request.scope === 'names' || !built || !readable || failed ? ['title'] : request.scope === 'messages' ? ['message'] : ['title', 'message'],
          prefix: (term) => term.length >= 2,
          fuzzy: (term) => !request.fuzzy || term.length < 4 ? false : term.length < 8 ? 1 : 2,
          filter: (result) => {
            const source = sources.get(String(result.id));
            const entry = source === undefined ? undefined : sessions.get(source.sessionId);
            return entry !== undefined && allowed(entry) && (request.scope !== 'messages' || source?.itemId !== null);
          },
        }, (result) => {
          const source = sources.get(String(result.id));
          if (source === undefined) return;
          const previous = matches.get(source.sessionId) ?? { score: 0, titleTerms: [], message: null };
          matches.set(source.sessionId, {
            score: Math.max(previous.score, result.score),
            titleTerms: source.itemId === null ? result.terms : previous.titleTerms,
            message: source.itemId !== null && (previous.message === null || result.score > previous.message.score) ? result : previous.message,
          });
        }, async () => { await pause(); return epoch === generation && !stopped && sequence === serial && searchedRevision === revision; });
      }
      // A write, removal, reset or newer query during a yielded search invalidates the whole result.
      if (epoch !== generation || stopped || sequence !== serial || searchedRevision !== revision) return empty('indexing');
      const ordered = [...matches].sort(([a, am], [b, bm]) => (request.sort === 'match' && query !== '' ? bm.score - am.score : 0)
        || (sessions.get(b)?.record.lastActiveAt ?? 0) - (sessions.get(a)?.record.lastActiveAt ?? 0) || a.localeCompare(b));
      const hits = ordered.slice(request.offset, request.offset + SEARCH_PAGE_SIZE).map(([id, match]) => {
        const entry = sessions.get(id);
        const source = match.message === null ? undefined : sources.get(String(match.message.id));
        const message = source?.itemId == null ? null : deps.conversations.searchMessage(source.itemId);
        return { sessionId: id, titleRanges: matchRanges(entry === undefined ? '' : sessionLabel(entry), match.titleTerms), excerpt: message === null ? null : { ...excerpt(message.text, match.message?.terms ?? []), role: message.role } };
      });
      const result: SessionSearchResult = { status, hits, total: ordered.length, more: request.offset + hits.length < ordered.length };
      if (status === 'ready') cached = { key, revision, result };
      return result;
    },
    release() { serial += 1; cached = null; },
    stop() { stopped = true; unsubscribeContent(); unsubscribeRecords(); reset(); },
  };
}
