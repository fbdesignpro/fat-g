// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchChange } from './search';
import type { ConversationStore, NewItem } from './store';
import { CONVERSATION, OTHER, type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => area.dispose());
const prompt = (store: ConversationStore, id = 't1') => store.acceptPrompt({ conversationId: CONVERSATION, turnId: id, itemId: `p-${id}`, text: 'A user message', at: 5, started: false });
const message = (id: string, text: string, extra: Partial<NewItem> = {}): NewItem => ({ id, kind: 'message', role: 'assistant', phase: 'final', origin: 'local', providerItemId: null, receivedAt: 6, providerAt: null, text, cut: false, notice: null, detail: null, questions: [], ...extra });

describe('the search projection', () => {
  it('reads only saved user and assistant messages of the session itself, without changing stored bytes', () => {
    const store = area.open();
    prompt(store);
    store.addItem(CONVERSATION, 't1', message('answer', 'An assistant answer'));
    store.addItem(CONVERSATION, 't1', message('worker', 'A worker answer', { workerId: 'worker-1' }));
    store.addItem(CONVERSATION, 't1', message('notice', 'A notice', { kind: 'notice', role: null, notice: 'turn-not-shown' }));
    store.saveDraft(CONVERSATION, 1, { text: 'Unsent draft', intent: { plan: false, skill: null } }, 6, true);
    store.acceptPrompt({ conversationId: OTHER, turnId: 'aside', itemId: 'aside-p', text: 'An aside question', at: 7, started: false, aside: { parentId: CONVERSATION, source: null, title: 'Aside' } });
    const before = area.hashes();
    expect(store.searchMessages(0).messages.map((item) => [item.id, item.role, item.text])).toEqual([
      ['p-t1', 'user', 'A user message'], ['answer', 'assistant', 'An assistant answer'],
    ]);
    expect(store.searchMessage('worker')).toBeNull();
    expect(store.searchMessage('aside-p')).toBeNull();
    expect(store.searchMessage('answer')).toEqual({ id: 'answer', sessionId: CONVERSATION, role: 'assistant', text: 'An assistant answer' });
    expect(area.hashes()).toEqual(before);
  });

  it('pages by stored row id with count and size bounds', () => {
    const store = area.open({ synchronous: 'OFF' });
    prompt(store);
    for (let at = 0; at < 70; at += 1) store.addItem(CONVERSATION, 't1', message(`a${at}`, 'word '.repeat(20_000)));
    const ids: string[] = [];
    let cursor = 0;
    for (;;) {
      const page = store.searchMessages(cursor);
      expect(page.messages.length).toBeLessThanOrEqual(64);
      expect(page.messages.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(356_000);
      ids.push(...page.messages.map((item) => item.id));
      if (page.next === null) break;
      expect(page.next).toBeGreaterThan(cursor);
      cursor = page.next;
    }
    expect(ids).toHaveLength(71);
    expect(new Set(ids).size).toBe(71);
  });

  it('notifies only committed text changes, including streaming, removal and reset', () => {
    let fail = false;
    const store = area.open({ hook: () => { if (fail) throw new Error('failed write'); } });
    const changes: SearchChange[] = [];
    store.subscribeSearch((change) => changes.push(change));
    store.subscribeSearch(() => { throw new Error('broken search'); });
    prompt(store);
    expect(changes).toEqual([{ items: ['p-t1'], conversations: [] }]);
    fail = true;
    expect(() => prompt(store, 't2')).toThrow();
    expect(changes).toHaveLength(1);
    fail = false;
    const place = store.reserveItem(CONVERSATION, 't1');
    store.saveProgress(CONVERSATION, place, message('stream', 'partial'));
    store.completeItem(CONVERSATION, place, message('stream', 'whole answer'));
    expect(changes.slice(-2)).toEqual([{ items: ['stream'], conversations: [] }, { items: ['stream'], conversations: [] }]);
    store.markRemoving([CONVERSATION]);
    expect(store.searchMessages(0).messages).toEqual([]);
    store.liftRemoving([CONVERSATION]);
    expect(store.searchMessage('stream')?.text).toBe('whole answer');
    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION]);
    expect(changes.at(-1)).toEqual({ items: [], conversations: [CONVERSATION] });
    expect(store.searchMessage('stream')).toBeNull();
    store.close();
    expect(changes.at(-1)).toBeNull();
  });

  it('announces imported messages and history completion after their transaction commits', () => {
    const store = area.open();
    prompt(store);
    const place = store.reserveItem(CONVERSATION, 't1');
    store.saveProgress(CONVERSATION, place, message('partial', 'old partial text'));
    const changes: SearchChange[] = [];
    store.subscribeSearch((change) => changes.push(change));
    store.mergePage(CONVERSATION, [{ kind: 'matched', turnId: 't1', providerTurnId: null, end: null, clearGap: false, notShown: false, items: [
      { kind: 'complete', itemId: 'partial', message: { role: 'assistant', phase: 'final', itemId: 'remote-1', text: 'completed from history', at: 10, turnId: 'remote-turn' } },
      { kind: 'add', before: null, message: { role: 'assistant', phase: 'final', itemId: 'remote-2', text: 'imported history', at: 10, turnId: 'remote-turn' } },
    ] }], null, 'Not shown');
    expect(store.searchMessage('partial')?.text).toBe('completed from history');
    const imported = store.searchMessages(0).messages.find((item) => item.text === 'imported history');
    expect(imported).toBeDefined();
    expect(changes).toEqual([{ items: ['partial', imported?.id], conversations: [] }]);
  });
});
