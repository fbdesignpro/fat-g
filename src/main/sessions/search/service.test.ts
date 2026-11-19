// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH_FILTERS, type SessionSearchRequest } from '@shared/contracts/session-search';
import type { SessionEntry } from '@shared/contracts/sessions';
import { PROJECT_A, PROJECT_B, sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { type Scratch, scratch } from '../../conversations/test-support';
import type { ConversationStore, NewItem } from '../../conversations/store';
import { createSessionSearch, type SessionSearch } from './service';
import { excerpt, matchRanges } from './text';

let area: Scratch;
let store: ConversationStore;
let service: SessionSearch;
let sessions: SessionEntry[];
let refused: boolean;
let changed: () => void;
beforeEach(() => {
  area = scratch(); store = area.open({ synchronous: 'OFF' }); sessions = []; refused = false;
  service = createSessionSearch({ conversations: store, records: { isRefused: () => refused, subscribe: (listener) => { changed = listener; return () => undefined; } }, sessions: () => sessions, yield: () => Promise.resolve() });
});
afterEach(() => { service.stop(); area.dispose(); });
const request = (query: string, options: Partial<SessionSearchRequest> = {}): SessionSearchRequest => ({ ...DEFAULT_SEARCH_FILTERS, query, offset: 0, ...options });
async function search(query: string, options: Partial<SessionSearchRequest> = {}) {
  for (let at = 0; at < 100; at += 1) {
    const result = await service.search(request(query, options));
    if (result.status !== 'indexing') return result;
  }
  throw new Error('search did not finish indexing');
}
function add(name: string, text: string, overrides: Partial<SessionEntry['record']> = {}): SessionEntry {
  const entry = sessionEntry(name, SUMMARIES.idle, overrides);
  sessions.push(entry);
  store.acceptPrompt({ conversationId: entry.record.id, turnId: `t-${entry.record.id}`, itemId: `p-${entry.record.id}`, text, at: 1, started: false });
  changed();
  return entry;
}
function answer(entry: SessionEntry, id: string, text: string): NewItem {
  const item: NewItem = { id, kind: 'message', role: 'assistant', phase: 'final', origin: 'local', providerItemId: null, receivedAt: 2, providerAt: null, text, cut: false, notice: null, detail: null, questions: [] };
  store.addItem(entry.record.id, `t-${entry.record.id}`, item);
  return item;
}

describe('session search', () => {
  it('boosts names, tolerates typos and prefixes, and groups multiple messages into one session', async () => {
    const title = add('Avatar rendering', 'An unrelated prompt', { lastActiveAt: 1 });
    const text = add('Graphics', 'avatar rendering', { lastActiveAt: 2 });
    answer(text, 'a1', 'avatar rendering');
    const result = await search('avatr render');
    expect(result.hits.map((hit) => hit.sessionId)).toEqual([title.record.id, text.record.id]);
    expect(result.hits[0]?.titleRanges).toHaveLength(2);
    expect(result.hits[1]?.excerpt?.text).toBe('avatar rendering');
    expect((await search('avatr', { fuzzy: false })).hits).toEqual([]);
    expect((await search('avatar', { sort: 'recent' })).hits[0]?.sessionId).toBe(text.record.id);
  });

  it('requires all words in one name or message and searches user and assistant text equally', async () => {
    const entry = add('Separate words', 'galaxy');
    answer(entry, 'a1', 'planet');
    expect((await search('galaxy planet')).hits).toEqual([]);
    expect((await search('planet', { scope: 'messages' })).hits[0]?.excerpt?.role).toBe('assistant');
    expect((await search('galaxy', { scope: 'names' })).hits).toEqual([]);
    expect((await search('Separate', { scope: 'messages' })).hits).toEqual([]);
  });

  it('uses saved activity dates and project/lifecycle filters, without indexing project names', async () => {
    const active = add('One', 'needle', { lastActiveAt: 1 });
    const done = add('Two', 'needle', { lastActiveAt: 3, completedAt: 3 });
    const shelved = add('Three', 'needle', { lastActiveAt: 2, shelvedAt: 2, projectId: PROJECT_B });
    expect((await search('')).hits.map((hit) => hit.sessionId)).toEqual([done.record.id, shelved.record.id, active.record.id]);
    expect((await search('needle', { state: 'done' })).hits.map((hit) => hit.sessionId)).toEqual([done.record.id]);
    expect((await search('', { state: 'shelved' })).hits.map((hit) => hit.sessionId)).toEqual([shelved.record.id]);
    expect((await search('', { state: 'active', projectId: PROJECT_A })).hits.map((hit) => hit.sessionId)).toEqual([active.record.id]);
  });

  it('pages unique sessions, excludes detached conversations and empty unnamed drafts, and handles punctuation', async () => {
    for (let at = 0; at < 65; at += 1) add(`Session ${at}`, 'shared token', { lastActiveAt: at });
    sessions.push(sessionEntry(null, SUMMARIES.notStarted));
    store.acceptPrompt({ conversationId: 'detached', turnId: 'detached', itemId: 'detached', text: 'shared token', at: 1, started: false });
    const first = await search('shared token');
    const second = await search('shared token', { offset: 50 });
    expect(first).toMatchObject({ total: 65, more: true });
    expect(first.hits).toHaveLength(50);
    expect(second.hits).toHaveLength(15);
    expect(new Set([...first.hits, ...second.hits].map((hit) => hit.sessionId)).size).toBe(65);
    expect((await search('')).total).toBe(65);
    expect((await search('"*()')).hits).toEqual([]);
  });

  it('updates names and streaming messages, and removes content before and after deletion', async () => {
    const entry = add('Original', 'initial');
    await search('initial');
    const item = answer(entry, 'stream', 'old text');
    const place = store.reserveItem(entry.record.id, `t-${entry.record.id}`);
    store.saveProgress(entry.record.id, place, { ...item, id: 'live', text: 'unfinished sentence' });
    expect((await search('unfinished')).hits).toHaveLength(1);
    store.completeItem(entry.record.id, place, { ...item, id: 'live', text: 'finished sentence' });
    expect((await search('unfinished', { fuzzy: false })).hits).toEqual([]);
    expect((await search('finished')).hits).toHaveLength(1);
    sessions = [{ ...entry, record: { ...entry.record, name: 'Renamed' } }]; changed();
    expect((await search('Original')).hits).toEqual([]);
    expect((await search('Renamed')).hits).toHaveLength(1);
    store.markRemoving([entry.record.id]);
    expect((await search('finished')).hits).toEqual([]);
    store.liftRemoving([entry.record.id]);
    expect((await search('finished')).hits).toHaveLength(1);
    sessions = []; changed();
    store.markRemoving([entry.record.id]); store.deleteRemoving([entry.record.id]);
    expect((await search('')).hits).toEqual([]);
    expect((await search('sentence')).hits).toEqual([]);
  });

  it('never brings deleted sessions back from a yielding build', async () => {
    const entry = add('Gone', 'private phrase');
    expect((await service.search(request('private'))).status).toBe('indexing');
    sessions = []; changed();
    store.markRemoving([entry.record.id]); store.deleteRemoving([entry.record.id]);
    expect((await search('private')).hits).toEqual([]);
    expect((await search('Gone')).hits).toEqual([]);
  });

  it('falls back to names when messages cannot be read and refuses unreadable records', async () => {
    add('Findable', 'A message');
    store.close();
    expect(await search('Findable')).toMatchObject({ status: 'messages-unavailable', total: 1 });
    expect(await search('Findable', { scope: 'names' })).toMatchObject({ status: 'ready', total: 1 });
    refused = true; changed();
    expect(await search('Findable')).toMatchObject({ status: 'records-unavailable', total: 0 });
  });

  it('cancels a yielded query on close and never revives an index after a store reset', async () => {
    add('Findable', 'old private message');
    await search('private');
    const pending = service.search(request('message'));
    service.release();
    expect(await pending).toMatchObject({ status: 'indexing', hits: [] });
    expect(await search('private')).toMatchObject({ status: 'ready', total: 1 });
    const resetting = service.search(request('message'));
    store.close();
    expect(await resetting).toMatchObject({ status: 'indexing', hits: [] });
    expect(await search('private')).toMatchObject({ status: 'messages-unavailable', hits: [] });
    expect(await search('Findable', { scope: 'names' })).toMatchObject({ status: 'ready', total: 1 });
  });
});

describe('search excerpts', () => {
  it('normalizes accents and case while retaining original UTF-16 highlight offsets', async () => {
    add('Éléphant café', 'naïve résumé');
    expect((await search('ELEPHANT cafe')).hits[0]?.titleRanges).toEqual([{ start: 0, end: 8 }, { start: 9, end: 13 }]);
    expect((await search('naive resume')).hits[0]?.excerpt?.text).toBe('naïve résumé');
    expect(matchRanges('🦊 Cafe\u0301', ['cafe'])).toEqual([{ start: 3, end: 8 }]);
  });
  it('bounds plain-text excerpts around the match and never produces HTML markup', () => {
    const result = excerpt(`${'far away '.repeat(80)}<script>needle</script>${'🦊'.repeat(200)}`, ['needle']);
    expect(result.text.length).toBeLessThanOrEqual(240);
    expect(result.text).toContain('<script>needle</script>');
    expect(result.ranges.map((range) => result.text.slice(range.start, range.end))).toEqual(['needle']);
  });
});
