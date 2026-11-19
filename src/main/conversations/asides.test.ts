// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V21 (docs/planning/_archive/M20b.md; S7, C28–C30, C32, C35, C69, C71, C75; decision 0025): what the
// store keeps of a question asked beside a session, on a real file — an aside's conversation with
// its parent, its source and its title, the model a message names, its items out of every page of
// its session's, what a session's read lists of it, a prompt fat-g answered itself, and a removal
// that takes an aside with its parent and leaves no text.
import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AsideSource } from '@shared/contracts/aside';
import { CONVERSATIONS_VERSION, NEEDED_COLUMNS, SCHEMA, STORE_FILE } from './format';
import { type ConversationStore, type NewItem, turnView } from './store';
import { CONVERSATION, OTHER, type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const ASIDE = '33333333-3333-4333-8333-333333333333';
const SECOND = '44444444-4444-4444-8444-444444444444';
const EXCERPT = 'only-the-aside-holds-this-passage-0123456789';
const SOURCE: AsideSource = { kind: 'message', itemId: 'answer-1', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 5 }, range: { start: 12, end: 56 }, digest: '0badc0de', excerpt: EXCERPT, cut: false };
const FILE: AsideSource = { ...SOURCE, kind: 'file', itemId: null, role: null, path: 'C:\\work\\tide-tools\\README.md', lines: { first: 3, last: 3 } };

let made = 0;
function message(text: string, patch: Partial<NewItem> = {}): NewItem {
  made += 1;
  return { id: `item-${made}`, kind: 'message', origin: 'local', providerItemId: null, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 10, providerAt: null, ...patch };
}
/** A session's conversation with one answered turn. */
function session(store: ConversationStore, id = CONVERSATION): void {
  store.acceptPrompt({ conversationId: id, turnId: `turn-1-${id}`, itemId: `prompt-1-${id}`, text: 'a prompt of the session', at: 5, started: false });
  store.addItem(id, `turn-1-${id}`, message('an answer of the session', { id: `answer-1-${id}` }));
  store.providerEnded(id, `turn-1-${id}`, 'completed', 9);
  store.sessionEnded(id, `turn-1-${id}`, 9, 'completed');
}
/** An aside's first question, as the runtime records one: its conversation is made by the prompt that starts it. */
function ask(store: ConversationStore, id = ASIDE, source: AsideSource | null = SOURCE, parentId = CONVERSATION, text = 'the seed question, quoting the passage', title = 'A title of the aside') {
  return store.acceptPrompt({ conversationId: id, turnId: `aside-turn-1-${id}`, itemId: `aside-q-1-${id}`, text, at: 20, started: false, aside: { parentId, source, title } });
}

describe('the format, from version 4 (S7, C28, C35)', () => {
  it('has a parent, a source and a title on a conversation, an index by parent, and the mark of a prompt fat-g answered itself', () => {
    area.open();
    // Version 5 added no column (M21, C32).
    expect(NEEDED_COLUMNS['conversation']).toEqual(expect.arrayContaining(['parentId', 'source', 'title']));
    expect(NEEDED_COLUMNS['turn']).toContain('own');
    expect(SCHEMA.join('\n')).toContain('CREATE INDEX conversation_parent ON conversation (parentId)');
    area.raw((db) => {
      const columns = (table: string): string[] => (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((row) => row.name);
      expect(columns('conversation')).toEqual(expect.arrayContaining(['parentId', 'source', 'title']));
      expect(columns('turn')).toContain('own');
      expect(db.prepare('SELECT schemaVersion, minReaderVersion FROM meta WHERE id = 1').get()).toEqual({ schemaVersion: CONVERSATIONS_VERSION, minReaderVersion: CONVERSATIONS_VERSION });
    });
  });
});

describe('an aside’s conversation (C28, C29, C36)', () => {
  it('names its parent, its source with the passage, and its title, from the prompt that starts it', () => {
    const store = area.open();
    session(store);
    const { item, turn } = ask(store);
    expect(item).toMatchObject({ conversationId: ASIDE, role: 'user' });
    expect(turn).toMatchObject({ conversationId: ASIDE, place: 1 });
    expect(store.aside(ASIDE)).toEqual({ id: ASIDE, parentId: CONVERSATION, title: 'A title of the aside', source: SOURCE, createdAt: 20, removing: false });
    expect(store.conversation(ASIDE)).toMatchObject({ id: ASIDE, parentId: CONVERSATION, reference: null });
    // The session's own conversation has no parent, and is no aside.
    expect(store.conversation(CONVERSATION)).toMatchObject({ parentId: null });
    expect(store.aside(CONVERSATION)).toBeNull();
    expect(store.aside('no-such-aside')).toBeNull();
    area.raw((db) => {
      const row = db.prepare('SELECT parentId, source, title FROM conversation WHERE id = ?').get(ASIDE) as { parentId: string; source: string; title: string };
      expect(row.parentId).toBe(CONVERSATION);
      expect(row.title).toBe('A title of the aside');
      // As JSON, with its place in the drawing: two offsets and a digest (C75).
      expect(JSON.parse(row.source)).toEqual(SOURCE);
      expect(db.prepare('SELECT parentId, source, title FROM conversation WHERE id = ?').get(CONVERSATION)).toEqual({ parentId: null, source: null, title: null });
    });
  });

  it('keeps no source for a question typed freely, and a file’s source by its path and lines', () => {
    const store = area.open();
    session(store);
    ask(store, ASIDE, null, CONVERSATION, 'Why is the sea salty?', 'Why is the sea salty?');
    ask(store, SECOND, FILE);
    expect(store.aside(ASIDE)).toMatchObject({ source: null, title: 'Why is the sea salty?' });
    expect(store.aside(SECOND)?.source).toEqual(FILE);
  });

  it('is named and parented once, by its first question: a follow-up changes neither', () => {
    const store = area.open();
    session(store);
    ask(store);
    store.acceptPrompt({ conversationId: ASIDE, turnId: 'aside-turn-2', itemId: 'aside-q-2', text: 'a follow-up', at: 30, started: true, aside: { parentId: OTHER, source: null, title: 'Another title' } });
    expect(store.aside(ASIDE)).toMatchObject({ parentId: CONVERSATION, title: 'A title of the aside', source: SOURCE });
    expect(store.newestPage(ASIDE).items.map((item) => item.blocks[0]?.text)).toEqual(['the seed question, quoting the passage', 'a follow-up']);
  });

  it('reads back whole after the store is closed and opened again', () => {
    const store = area.open();
    session(store);
    ask(store);
    store.addItem(ASIDE, `aside-turn-1-${ASIDE}`, message('the answer to the aside'));
    store.close();
    const again = area.open();
    expect(again.aside(ASIDE)).toMatchObject({ parentId: CONVERSATION, source: SOURCE, title: 'A title of the aside' });
    expect(again.newestPage(ASIDE).items.map((item) => item.blocks[0]?.text)).toEqual(['the seed question, quoting the passage', 'the answer to the aside']);
  });

  it('reads a source this build cannot take as none, and the aside still opens', () => {
    const store = area.open();
    session(store);
    ask(store);
    store.close();
    area.raw((db) => { db.prepare("UPDATE conversation SET source = '{\"kind\":\"plan\"}' WHERE id = ?").run(ASIDE); });
    const again = area.open();
    expect(again.aside(ASIDE)).toMatchObject({ id: ASIDE, parentId: CONVERSATION, source: null });
    expect(again.asides(CONVERSATION).map((marker) => marker.source)).toEqual([null]);
  });
});

describe('the model that wrote a message (C7, C28)', () => {
  it('is kept on the message its provider named it for, and is absent from every other body', () => {
    const store = area.open();
    session(store);
    ask(store);
    const named = store.addItem(ASIDE, `aside-turn-1-${ASIDE}`, message('by another model', { id: 'named', model: 'claude-haiku-5' }));
    const plain = store.addItem(ASIDE, `aside-turn-1-${ASIDE}`, message('by the session’s', { id: 'plain' }));
    expect(named?.item.model).toBe('claude-haiku-5');
    expect(plain?.item.model).toBeNull();
    expect(store.newestPage(ASIDE).items.map((item) => item.model)).toEqual([null, 'claude-haiku-5', null]);
    area.raw((db) => {
      const body = (id: string): Record<string, unknown> => JSON.parse(String((db.prepare('SELECT body FROM item WHERE id = ?').get(id) as { body: string }).body)) as Record<string, unknown>;
      expect(body('named')['model']).toBe('claude-haiku-5');
      // Written only where it is named: a body without it is as version 3 wrote it.
      expect('model' in body('plain')).toBe(false);
    });
    // After a restart too.
    store.close();
    expect(area.open().newestPage(ASIDE).items.map((item) => item.model)).toEqual([null, 'claude-haiku-5', null]);
  });

  it('is set by the write that completes a message which was being written', () => {
    const store = area.open();
    session(store);
    ask(store);
    const place = store.reserveItem(ASIDE, `aside-turn-1-${ASIDE}`);
    store.saveProgress(ASIDE, place, message('half an', { id: 'streamed', complete: false }));
    expect(store.newestPage(ASIDE).items.at(-1)?.model).toBeNull();
    const done = store.completeItem(ASIDE, place, message('half an answer, whole', { id: 'streamed', model: 'gpt-6-luna' }));
    expect(done.item.model).toBe('gpt-6-luna');
    expect(store.newestPage(ASIDE).items.at(-1)).toMatchObject({ id: 'streamed', model: 'gpt-6-luna', state: 'complete' });
  });
});

describe('what a session’s read holds of its asides (C4, C30, C75)', () => {
  it('lists them as markers, oldest first, with where each came from and none of its text', () => {
    const store = area.open();
    session(store);
    session(store, OTHER);
    ask(store);
    store.acceptPrompt({ conversationId: SECOND, turnId: 'second-turn', itemId: 'second-q', text: 'Why is the sea salty?', at: 40, started: false, aside: { parentId: CONVERSATION, source: null, title: 'Why is the sea salty?' } });
    const markers = store.asides(CONVERSATION);
    expect(markers).toEqual([
      { id: ASIDE, title: 'A title of the aside', createdAt: 20, source: { kind: 'message', itemId: 'answer-1', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 5 }, range: { start: 12, end: 56 }, digest: '0badc0de' } },
      { id: SECOND, title: 'Why is the sea salty?', createdAt: 40, source: null },
    ]);
    // Two offsets and a digest, and no text: the passage is in the aside's own read alone.
    expect(JSON.stringify(markers)).not.toContain(EXCERPT);
    expect(store.aside(ASIDE)?.source?.excerpt).toBe(EXCERPT);
    // Another session has none of them.
    expect(store.asides(OTHER)).toEqual([]);
  });

  it('keeps an aside’s items out of every page and window of its session’s conversation, and its session’s out of its own', () => {
    const store = area.open();
    session(store);
    ask(store);
    store.addItem(ASIDE, `aside-turn-1-${ASIDE}`, message('the answer to the aside', { id: 'aside-answer' }));
    const own = store.newestPage(CONVERSATION);
    expect(own.items.map((item) => item.id)).toEqual([`prompt-1-${CONVERSATION}`, `answer-1-${CONVERSATION}`]);
    expect(own.turns.map((turn) => turn.id)).toEqual([`turn-1-${CONVERSATION}`]);
    expect(store.window(CONVERSATION, `prompt-1-${CONVERSATION}`, 'newest')?.items).toHaveLength(2);
    const asides = store.newestPage(ASIDE);
    expect(asides.items.map((item) => item.id)).toEqual([`aside-q-1-${ASIDE}`, 'aside-answer']);
    expect(asides.items.every((item) => item.conversationId === ASIDE)).toBe(true);
    // The session's turn count, its last turn and its first prompt are its own.
    expect(store.lastLocalTurn(CONVERSATION)?.id).toBe(`turn-1-${CONVERSATION}`);
    expect(store.firstPrompt(CONVERSATION)).toBe('a prompt of the session');
  });

  it('pages an aside’s own items newest first, then before a cursor, as a session’s are paged', () => {
    const store = area.open({ synchronous: 'OFF' });
    session(store);
    ask(store);
    for (let n = 0; n < 700; n += 1) store.addItem(ASIDE, `aside-turn-1-${ASIDE}`, message(`aside item ${n}`));
    const newest = store.newestPage(ASIDE);
    expect(newest.older).toBe(true);
    expect(newest.items.at(-1)?.blocks[0]?.text).toBe('aside item 699');
    const before = store.pageBefore(ASIDE, newest.items[0]?.id ?? '');
    expect(before?.items.at(-1)?.blocks[0]?.text).toBe(`aside item ${699 - newest.items.length}`);
    expect(new Set([...newest.items, ...(before?.items ?? [])].map((item) => item.id)).size).toBe(newest.items.length + (before?.items.length ?? 0));
    // A cursor of the session's own names nothing in the aside.
    expect(store.pageBefore(ASIDE, `answer-1-${CONVERSATION}`)).toBeNull();
  });
});

describe('the turn a side thread starts from (C19, C69)', () => {
  it('is the newest turn whose end the provider reported — a failed or an interrupted one included — and none while no end was reported', () => {
    const store = area.open();
    const accept = (turnId: string, at: number) => store.acceptPrompt({ conversationId: CONVERSATION, turnId, itemId: `prompt-${turnId}`, text: 'a prompt', at, started: at > 1 });
    accept('t1', 1);
    expect(store.lastReportedTurn(CONVERSATION)).toBeNull();
    store.providerTook(CONVERSATION, 't1', 'provider-turn-1');
    // In flight: taken, and not ended.
    expect(store.lastReportedTurn(CONVERSATION)).toBeNull();
    store.providerEnded(CONVERSATION, 't1', 'completed', 2);
    store.sessionEnded(CONVERSATION, 't1', 2, 'completed');
    expect(store.lastReportedTurn(CONVERSATION)).toBe('provider-turn-1');
    for (const [turnId, outcome] of [['t2', 'failed'], ['t3', 'interrupted']] as const) {
      accept(turnId, 3);
      store.providerTook(CONVERSATION, turnId, `provider-${turnId}`);
      store.providerEnded(CONVERSATION, turnId, outcome, 4);
      store.sessionEnded(CONVERSATION, turnId, 4, outcome);
      expect(store.lastReportedTurn(CONVERSATION), turnId).toBe(`provider-${turnId}`);
    }
    // One whose end was lost — the session ended it, the provider never said — is never the one.
    accept('t4', 5);
    store.providerTook(CONVERSATION, 't4', 'provider-t4');
    store.sessionEnded(CONVERSATION, 't4', 6, 'failed');
    expect(store.lastReportedTurn(CONVERSATION)).toBe('provider-t3');
    // Nor the one in flight after it.
    accept('t5', 7);
    store.providerTook(CONVERSATION, 't5', 'provider-t5');
    expect(store.lastReportedTurn(CONVERSATION)).toBe('provider-t3');
    // An aside's own turns are no turn of the session's.
    ask(store);
    store.providerTook(ASIDE, `aside-turn-1-${ASIDE}`, 'child-turn-1');
    store.providerEnded(ASIDE, `aside-turn-1-${ASIDE}`, 'completed', 30);
    expect(store.lastReportedTurn(CONVERSATION)).toBe('provider-t3');
    expect(store.lastReportedTurn('no-such-conversation')).toBeNull();
  });
});

describe('a prompt fat-g answered itself (C35)', () => {
  it('is a turn no provider took or ended, which reads ended all the same, also after a restart', () => {
    const store = area.open();
    session(store);
    const { turn } = store.acceptPrompt({ conversationId: CONVERSATION, turnId: 'own-turn', itemId: 'own-prompt', text: '/clear', at: 50, started: true, own: true });
    expect(turn.own).toBe(true);
    store.addItem(CONVERSATION, 'own-turn', message('fat-g did not send /clear.', { kind: 'notice', role: null, phase: null, notice: 'command-clear' }));
    store.sessionEnded(CONVERSATION, 'own-turn', 51, 'completed');
    const stored = store.turn(CONVERSATION, 'own-turn');
    expect(stored).toMatchObject({ own: true, providerTook: false, providerEndedAt: null, providerOutcome: null, sessionOutcome: 'completed' });
    expect(turnView(stored as NonNullable<typeof stored>, false)).toMatchObject({ state: 'ended', outcome: 'completed' });
    // The same turn without the mark would read as never acknowledged: the mark is what tells them apart.
    expect(turnView({ ...(stored as NonNullable<typeof stored>), own: false }, false).state).toBe('unacknowledged');
    // It is no turn a side thread starts from: no provider reported its end.
    expect(store.lastReportedTurn(CONVERSATION)).toBeNull();
    store.close();
    const again = area.open();
    expect(turnView(again.turn(CONVERSATION, 'own-turn') as NonNullable<ReturnType<ConversationStore['turn']>>, false)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(again.newestPage(CONVERSATION).items.at(-1)).toMatchObject({ notice: 'command-clear' });
  });

  it('is an ordinary turn where the mark is not given', () => {
    const store = area.open();
    const { turn } = store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't1', itemId: 'p1', text: 'a prompt', at: 1, started: false });
    expect(turn.own).toBe(false);
  });
});

describe('a removal (C32, C71)', () => {
  const stored = (store: ConversationStore): string[] => store.conversations().map((entry) => entry.id).sort();

  it('takes an aside alone, by its own id, and leaves its session’s conversation and its other asides whole', () => {
    const store = area.open();
    session(store);
    ask(store);
    ask(store, SECOND, FILE);
    store.markRemoving([ASIDE]);
    expect(store.removing()).toEqual([ASIDE]);
    expect(store.aside(ASIDE)).toMatchObject({ removing: true });
    // A marked aside is no longer listed for its session.
    expect(store.asides(CONVERSATION).map((marker) => marker.id)).toEqual([SECOND]);
    store.deleteRemoving([ASIDE]);
    expect(stored(store)).toEqual([CONVERSATION, SECOND].sort());
    expect(store.aside(ASIDE)).toBeNull();
    expect(store.newestPage(ASIDE)).toMatchObject({ items: [], turns: [] });
    expect(store.newestPage(CONVERSATION).items).toHaveLength(2);
    expect(store.removing()).toEqual([]);
  });

  it('takes every aside with its session’s removal: marked with it, never named beside it, and deleted before it', () => {
    const store = area.open();
    session(store);
    session(store, OTHER);
    ask(store);
    ask(store, SECOND, null);
    const others = '55555555-5555-4555-8555-555555555555';
    ask(store, others, SOURCE, OTHER);
    store.markRemoving([CONVERSATION]);
    // One removal, named by the session alone: a crash finishes both from that one name.
    expect(store.removing()).toEqual([CONVERSATION]);
    expect(store.asides(CONVERSATION)).toEqual([]);
    expect(store.conversations().filter((entry) => entry.removing).map((entry) => entry.id).sort()).toEqual([CONVERSATION, ASIDE, SECOND].sort());
    // Lifted, all three are back.
    store.liftRemoving([CONVERSATION]);
    expect(store.asides(CONVERSATION)).toHaveLength(2);
    expect(store.conversations().some((entry) => entry.removing)).toBe(false);
    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION]);
    expect(stored(store)).toEqual([OTHER, others].sort());
    expect(store.aside(others)).toMatchObject({ parentId: OTHER });
  });

  it('takes the asides of a session that has no conversation row of its own', () => {
    const store = area.open();
    // Asked beside, the store having been made anew since the session's own turns: only the aside's rows are here.
    ask(store);
    expect(store.conversation(CONVERSATION)).toBeNull();
    store.markRemoving([CONVERSATION]);
    expect(store.removing()).toEqual([ASIDE]);
    store.deleteRemoving([CONVERSATION]);
    expect(stored(store)).toEqual([]);
  });

  it('counts a session’s text with its asides’: their questions, their answers and the passage they were asked about', () => {
    const store = area.open();
    session(store);
    const alone = store.textUnits([CONVERSATION]);
    ask(store);
    store.addItem(ASIDE, `aside-turn-1-${ASIDE}`, message('the answer to the aside'));
    const withAside = store.textUnits([CONVERSATION]);
    expect(withAside).toBeGreaterThanOrEqual(alone + 'the seed question, quoting the passage'.length + 'the answer to the aside'.length + EXCERPT.length);
    // A parent is told by `parentId`: what lists the chats without a session classifies by it (C71).
    expect(store.conversations().map((entry) => [entry.id, entry.parentId])).toEqual(expect.arrayContaining([[CONVERSATION, null], [ASIDE, CONVERSATION]]));
  });

  it.each([
    ['the aside’s own removal', [ASIDE]],
    ['its session’s removal', [CONVERSATION]],
  ] as const)('leaves the passage, the question and the answer in none of the store’s files after %s', (_name, ids) => {
    const QUESTION = 'only-the-aside-question-holds-this-0123456789';
    const ANSWER = 'only-the-aside-answer-holds-this-0123456789';
    const filler = area.open({ synchronous: 'OFF' });
    session(filler);
    session(filler, OTHER);
    ask(filler, ASIDE, SOURCE, CONVERSATION, QUESTION);
    for (let n = 0; n < 40; n += 1) filler.addItem(ASIDE, `aside-turn-1-${ASIDE}`, message(`${ANSWER} ${'answer '.repeat(200)}`));
    filler.close();
    // The removal runs on a store opened as the app opens it: every commit waits for the disk.
    const store = area.open();
    for (const needle of [EXCERPT, QUESTION, ANSWER]) expect(area.holding(needle), needle).toContain(STORE_FILE);
    store.markRemoving([...ids]);
    store.deleteRemoving([...ids]);
    for (const needle of [EXCERPT, QUESTION, ANSWER]) expect(area.holding(needle), needle).toEqual([]);
    store.close();
    for (const needle of [EXCERPT, QUESTION, ANSWER]) expect(area.holding(needle), needle).toEqual([]);
    expect(readdirSync(area.dir)).toEqual([STORE_FILE]);
    // What was not removed is whole.
    expect(area.open().newestPage(OTHER).items).toHaveLength(2);
  });
});
