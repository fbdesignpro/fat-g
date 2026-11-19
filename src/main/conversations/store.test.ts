// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V5, V8, V9, V19, V29 (docs/planning/_archive/M18.md; C8–C13, C17, C20, C36–C41, C54, C62): the store's
// transactions on a real file — what a write leaves, what a failed one does not, pages and windows
// bounded by count and by size, unknown fields kept, a removal that leaves no trace, and the stores
// Start fresh sets aside.
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { MAX_PAGE_UNITS, PAGE_ENTRIES, WINDOW_ENTRIES } from '@shared/contracts/conversation';
import { CONVERSATIONS_VERSION, STORE_FILE } from './format';
import { type ConversationStore, type NewItem, StorageFailure, turnView } from './store';
import { CONVERSATION, OTHER, type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

let made = 0;
function message(text: string, patch: Partial<NewItem> = {}): NewItem {
  made += 1;
  return { id: `item-${made}`, kind: 'message', origin: 'local', providerItemId: null, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 10, providerAt: null, ...patch };
}
const accept = (store: ConversationStore, turnId: string, text = 'a prompt', conversationId = CONVERSATION, started = false) =>
  store.acceptPrompt({ conversationId, turnId, itemId: `prompt-${turnId}`, text, at: 5, started });
const texts = (items: readonly { blocks: readonly { text: string }[] }[]) => items.map((item) => item.blocks[0]?.text);

describe('requested speed per turn', () => {
  it('keeps distinct requests through progress, completion and reopening, with unknown fields intact', () => {
    let store = area.open();
    const fast = { id: 'priority', name: 'Fast' };
    const ultra = { id: 'express', name: 'Ultra fast' };
    for (const [id, speed] of [['fast', fast], ['ultra', ultra], ['standard', null]] as const) {
      store.acceptPrompt({ conversationId: CONVERSATION, turnId: id, itemId: `p-${id}`, text: 'Question', at: 5, started: true, speed });
      store.addItem(CONVERSATION, id, message('Answer'));
      store.providerEnded(CONVERSATION, id, 'completed', 10);
    }
    area.raw((db) => db.prepare("UPDATE turn SET extra = json_set(extra, '$.future', 'kept') WHERE id = 'fast'").run());
    store.close();
    store = area.open();
    expect(store.newestPage(CONVERSATION).turns.map((turn) => turnView(turn, false).speed)).toEqual([fast, ultra, null]);
    expect(area.raw((db) => db.prepare("SELECT json_extract(extra, '$.future') AS value FROM turn WHERE id = 'fast'").get())).toEqual({ value: 'kept' });
    expect(accept(store, 'unknown').turn.speed).toBeUndefined();
  });

  it('records the dispatched speed when a held message becomes a new turn and leaves the original request intact', () => {
    const store = area.open();
    const speed = { id: 'priority', name: 'Fast' };
    store.acceptPrompt({ conversationId: CONVERSATION, turnId: 'first', itemId: 'p1', text: 'Question', at: 5, started: true, speed });
    const held = store.addItem(CONVERSATION, 'first', message('Next question', { role: 'user' }));
    if (held === null) throw new Error('message not recorded');
    store.moveToTurn(CONVERSATION, held.item.id, 'next', 10, null);
    expect(store.turn(CONVERSATION, 'next')?.speed).toBeNull();
    expect(store.turn(CONVERSATION, 'first')?.speed).toEqual(speed);
    store.moveToTurn(CONVERSATION, held.item.id, 'next', 11, speed);
    expect(store.turn(CONVERSATION, 'next')?.speed).toBeNull();
    area.raw((db) => db.prepare("UPDATE turn SET extra = json_set(extra, '$.future', 'kept') WHERE id = 'next'").run());
    const another = store.addItem(CONVERSATION, 'first', message('Also this', { role: 'user' }));
    if (another === null) throw new Error('message not recorded');
    store.moveToTurn(CONVERSATION, another.item.id, 'next', 12, speed);
    expect(store.turn(CONVERSATION, 'next')?.speed).toBeNull();
    expect(area.raw((db) => db.prepare("SELECT json_extract(extra, '$.future') AS value FROM turn WHERE id = 'next'").get())).toEqual({ value: 'kept' });
  });

  it('refuses malformed tier metadata atomically and gives local commands no speed', () => {
    const store = area.open();
    expect(() => store.acceptPrompt({ conversationId: CONVERSATION, turnId: 'bad', itemId: 'p1', text: 'Question', at: 5, started: false, speed: { id: 'private\ntext', name: 'Fast' } })).toThrow();
    expect(store.conversation(CONVERSATION)).toBeNull();
    const local = store.acceptPrompt({ conversationId: CONVERSATION, turnId: 'local', itemId: 'p2', text: '/fast', at: 5, started: false, own: true, speed: { id: 'fast', name: 'Fast' } });
    expect(local.turn.speed).toBeUndefined();
  });
});

describe('a turn, as it is written (V3, V4; C9, C10, C14, C15, C54)', () => {
  it('records an accepted prompt as a conversation, a turn at the next place and the user’s item, whose id is the client id', () => {
    const store = area.open();
    const first = accept(store, 't1', 'What is the cat’s name?');
    expect(first.item).toMatchObject({ id: 'prompt-t1', conversationId: CONVERSATION, turnId: 't1', order: { turn: 1, item: 1 }, kind: 'message', origin: 'local', role: 'user', providerItemId: null, time: { receivedAt: 5, providerAt: null } });
    expect(first.turn).toMatchObject({ id: 't1', place: 1, origin: 'local', acceptedAt: 5, providerTook: false, providerOutcome: null, sessionOutcome: null });
    expect(accept(store, 't2').turn.place).toBe(2);
    expect(store.conversation(CONVERSATION)).toMatchObject({ id: CONVERSATION, reference: null, startHeld: true, reachedStart: false, removing: false, createdAt: 5 });
    // A conversation made for a session that had already started does not hold its start (C18).
    accept(store, 'o1', 'later', OTHER, true);
    expect(store.conversation(OTHER)?.startHeld).toBe(false);
  });

  it('leaves nothing of a transaction that throws', () => {
    let fail = true;
    const store = area.open({ hook: (point) => { if (fail && point === 'accept') throw new Error('disk full'); } });
    expect(() => accept(store, 't1')).toThrow('disk full');
    expect(store.conversation(CONVERSATION)).toBeNull();
    expect(store.newestPage(CONVERSATION).items).toEqual([]);
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM turn').get())).toEqual({ n: 0 });
    // And the next write works: nothing was left open.
    fail = false;
    expect(accept(store, 't1').turn.place).toBe(1);
  });

  it('keeps the provider’s end and the session’s end apart (C54)', () => {
    const store = area.open();
    accept(store, 't1');
    store.providerTook(CONVERSATION, 't1', 'provider-turn-1');
    expect(store.turn(CONVERSATION, 't1')).toMatchObject({ providerTook: true, providerTurnId: 'provider-turn-1' });
    store.providerEnded(CONVERSATION, 't1', 'completed', 20);
    expect(store.turn(CONVERSATION, 't1')).toMatchObject({ providerOutcome: 'completed', endReceivedAt: 20, sessionOutcome: null, sessionEndedAt: null });
    // The session stops running for it later: its last worker ended (M14, C114).
    expect(store.sessionEnded(CONVERSATION, 't1', 96, 'completed')).toBe(true);
    expect(store.turn(CONVERSATION, 't1')).toMatchObject({ providerOutcome: 'completed', endReceivedAt: 20, sessionOutcome: 'completed', sessionEndedAt: 96 });
    // The provider's end is written once.
    store.providerEnded(CONVERSATION, 't1', 'failed', 99);
    expect(store.turn(CONVERSATION, 't1')?.providerOutcome).toBe('completed');
    // A turn the store does not have changes nothing.
    expect(store.sessionEnded(CONVERSATION, 'demo-turn', 5, 'stopped')).toBe(false);
  });

  it('settles the answer’s phase in the transaction that stores the provider’s end, by that one key of its body (M16, C74)', () => {
    const store = area.open();
    accept(store, 't1');
    store.addItem(CONVERSATION, 't1', message('Looking.', { providerItemId: 'note', phase: 'commentary' }));
    store.addItem(CONVERSATION, 't1', message('Miso.', { providerItemId: 'answer', phase: 'commentary', questions: [{ title: 'Which cat?', options: ['Miso', 'Biscuit'] }] }));
    const before = store.newestPage(CONVERSATION).items;
    store.providerEnded(CONVERSATION, 't1', 'completed', 20, 'answer');
    const after = store.newestPage(CONVERSATION).items;
    expect(after.map((item) => [item.providerItemId, item.phase])).toEqual([[null, null], ['note', 'commentary'], ['answer', 'final']]);
    expect(store.turn(CONVERSATION, 't1')).toMatchObject({ providerOutcome: 'completed', endReceivedAt: 20 });
    // Nothing else of the item changed: its text, its questions, its place, its times, its id.
    expect({ ...after[2], phase: 'commentary' }).toEqual(before[2]);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    // A key this build does not know stays where it is through the write.
    area.raw((db) => db.prepare("UPDATE item SET body = json_set(body, '$.later', 'kept') WHERE providerItemId = 'note'").run());
    accept(store, 't2');
    store.addItem(CONVERSATION, 't2', message('Again.', { providerItemId: 'answer-2', phase: 'commentary' }));
    area.raw((db) => db.prepare("UPDATE item SET body = json_set(body, '$.later', 'kept') WHERE providerItemId = 'answer-2'").run());
    store.providerEnded(CONVERSATION, 't2', 'completed', 30, 'answer-2');
    expect(area.raw((db) => db.prepare("SELECT json_extract(body, '$.later') AS later, json_extract(body, '$.phase') AS phase FROM item WHERE providerItemId = 'answer-2'").get())).toEqual({ later: 'kept', phase: 'final' });
  });

  it('leaves neither the end nor the phase when that transaction fails, and settles nothing on an end the turn already had', () => {
    let fail = true;
    const store = area.open({ hook: (point) => { if (fail && point === 'provider-end') throw new Error('disk full'); } });
    accept(store, 't1');
    store.addItem(CONVERSATION, 't1', message('Miso.', { providerItemId: 'answer', phase: 'commentary' }));
    expect(() => store.providerEnded(CONVERSATION, 't1', 'completed', 20, 'answer')).toThrow('disk full');
    expect(store.turn(CONVERSATION, 't1')).toMatchObject({ providerOutcome: null, endReceivedAt: null });
    expect(store.newestPage(CONVERSATION).items.at(-1)).toMatchObject({ providerItemId: 'answer', phase: 'commentary' });
    fail = false;
    // The provider's end is written once (C54): a second names nothing.
    store.providerEnded(CONVERSATION, 't1', 'interrupted', 21);
    store.providerEnded(CONVERSATION, 't1', 'completed', 22, 'answer');
    expect(store.turn(CONVERSATION, 't1')).toMatchObject({ providerOutcome: 'interrupted', endReceivedAt: 21 });
    expect(store.newestPage(CONVERSATION).items.at(-1)).toMatchObject({ phase: 'commentary' });
  });

  it('settles only an assistant’s message of that turn, by the provider’s id: no other turn’s, no prompt, no notice', () => {
    const store = area.open();
    accept(store, 't1');
    store.setProviderItemId(CONVERSATION, 'prompt-t1', 'shared-id');
    store.addItem(CONVERSATION, 't1', message('Earlier answer.', { providerItemId: 'answer', phase: 'commentary' }));
    store.providerEnded(CONVERSATION, 't1', 'completed', 20);
    accept(store, 't2');
    store.addItem(CONVERSATION, 't2', message('A notice.', { kind: 'notice', role: null, phase: null, notice: 'turn-failed', providerItemId: 'shared-id' }));
    // The id names the first turn's prompt and the second turn's notice, and the first turn's answer under another: none is this turn's answer.
    store.providerEnded(CONVERSATION, 't2', 'completed', 30, 'shared-id');
    store.providerEnded(CONVERSATION, 't2', 'completed', 31, 'answer');
    expect(store.newestPage(CONVERSATION).items.map((item) => [item.turnId, item.role ?? item.notice, item.phase])).toEqual([['t1', 'user', null], ['t1', 'assistant', 'commentary'], ['t2', 'user', null], ['t2', 'turn-failed', null]]);
    // An id no item of the turn has settles nothing, and the end is stored all the same.
    accept(store, 't3');
    store.providerEnded(CONVERSATION, 't3', 'completed', 40, 'nobody');
    expect(store.turn(CONVERSATION, 't3')).toMatchObject({ providerOutcome: 'completed' });
  });

  it('reads a turn without the provider’s end as unfinished, or unacknowledged where the provider never took it (C16)', () => {
    const store = area.open();
    accept(store, 't1');
    const turn = () => store.turn(CONVERSATION, 't1')!;
    expect(turnView(turn(), true).state).toBe('running');
    expect(turnView(turn(), false)).toMatchObject({ state: 'unacknowledged', outcome: null });
    store.providerTook(CONVERSATION, 't1', null);
    expect(turnView(turn(), false).state).toBe('unfinished');
    // The session's end alone gives an outcome and no provider's end: it stays unfinished.
    store.sessionEnded(CONVERSATION, 't1', 9, 'stopped');
    expect(turnView(turn(), false)).toMatchObject({ state: 'unfinished', outcome: 'stopped' });
    store.providerEnded(CONVERSATION, 't1', 'interrupted', 12);
    expect(turnView(turn(), false)).toMatchObject({ state: 'ended', outcome: 'interrupted' });
  });

  it('stores the reference once, with its two folders, and never replaces it (C28)', () => {
    const store = area.open();
    accept(store, 't1');
    store.setReference(CONVERSATION, 'ref-1', 'C:\\work\\project', 'C:\\Users\\someone\\.codex');
    store.setReference(CONVERSATION, 'ref-2', 'D:\\other', null);
    expect(store.conversation(CONVERSATION)).toMatchObject({ reference: 'ref-1', folder: 'C:\\work\\project', configFolder: 'C:\\Users\\someone\\.codex' });
  });

  it('adds items in their turn’s order, skips one the turn already holds by the provider’s id, and names an echoed prompt (C14, C20)', () => {
    const store = area.open();
    accept(store, 't1');
    expect(store.setProviderItemId(CONVERSATION, 'prompt-t1', 'p-user')).toBe(true);
    expect(store.setProviderItemId(CONVERSATION, 'prompt-t1', 'p-other')).toBe(false);
    const added = store.addItem(CONVERSATION, 't1', message('Reading…', { phase: 'commentary', providerItemId: 'p-1' }));
    expect(added?.item.order).toEqual({ turn: 1, item: 2 });
    expect(store.addItem(CONVERSATION, 't1', message('Reading… again', { providerItemId: 'p-1' }))).toBeNull();
    store.addItem(CONVERSATION, 't1', message('The answer', { providerItemId: 'p-2' }));
    const page = store.newestPage(CONVERSATION);
    expect(texts(page.items)).toEqual(['a prompt', 'Reading…', 'The answer']);
    expect(page.items[0]?.providerItemId).toBe('p-user');
  });

  it('puts a notice with no turn at the end of the newest turn, with its detail, and refuses one with no turn at all (C34)', () => {
    const store = area.open();
    expect(() => store.addItem(CONVERSATION, null, message('x'))).toThrow(StorageFailure);
    accept(store, 't1');
    accept(store, 't2');
    const notice = store.addItem(CONVERSATION, null, message('Example reported an error, and the reply ended.', { kind: 'notice', role: null, phase: null, notice: 'turn-failed', detail: 'The model does not exist.' }));
    expect(notice?.item).toMatchObject({ turnId: 't2', kind: 'notice', notice: 'turn-failed', detail: 'The model does not exist.', role: null });
    expect(() => store.addItem(CONVERSATION, 'no-such-turn', message('x'))).toThrow(StorageFailure);
  });
});

describe('limits (V5, V8; C11, C12, C17)', () => {
  it('cuts a text over the limit on the way in, never inside a surrogate pair, and says so', () => {
    const store = area.open();
    accept(store, 't1');
    const long = `${'x'.repeat(MAX_MESSAGE_TEXT - 1)}😀 and more`;
    const added = store.addItem(CONVERSATION, 't1', message(long));
    const [block] = added?.item.blocks ?? [];
    expect(block?.cut).toBe(true);
    expect(block?.text).toHaveLength(MAX_MESSAGE_TEXT - 1);
    expect(block?.text).not.toMatch(/[\uD800-\uDBFF]$/);
    // At the limit, nothing is cut.
    expect(store.addItem(CONVERSATION, 't1', message('y'.repeat(MAX_MESSAGE_TEXT)))?.item.blocks[0]?.cut).toBe(false);
  });

  it('pages 1 200 messages back from disk with none lost and none twice', () => {
    const store = area.open({ synchronous: 'OFF' });
    for (let turn = 1; turn <= 300; turn += 1) {
      accept(store, `t${turn}`, `prompt ${turn}`);
      for (let part = 1; part <= 3; part += 1) store.addItem(CONVERSATION, `t${turn}`, message(`answer ${turn}.${part}`));
    }
    const seen: string[] = [];
    let page = store.newestPage(CONVERSATION);
    expect(page.items).toHaveLength(PAGE_ENTRIES);
    expect(page.latest).toBe(true);
    for (;;) {
      seen.unshift(...texts(page.items) as string[]);
      const [oldest] = page.items;
      if (!page.older || oldest === undefined) break;
      const next = store.pageBefore(CONVERSATION, oldest.id);
      if (next === null) throw new Error('the cursor was lost');
      page = next;
    }
    expect(seen).toHaveLength(1200);
    expect(new Set(seen).size).toBe(1200);
    expect(seen.slice(0, 5)).toEqual(['prompt 1', 'answer 1.1', 'answer 1.2', 'answer 1.3', 'prompt 2']);
    expect(seen.at(-1)).toBe('answer 300.3');
    // A page comes with the turns its items belong to.
    expect(page.turns.map((turn) => turn.id)).toEqual([...new Set(page.items.map((item) => item.turnId))]);
  });

  it('ends a page early before its text passes the size bound, with one item at least', () => {
    const store = area.open({ synchronous: 'OFF' });
    accept(store, 't1', 'first');
    const big = Math.floor(MAX_PAGE_UNITS / 12);
    for (let n = 1; n <= 16; n += 1) store.addItem(CONVERSATION, 't1', message(`${n}`.padEnd(big, 'z')));
    const page = store.newestPage(CONVERSATION);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(13);
    expect(page.items.reduce((sum, item) => sum + (item.blocks[0]?.text.length ?? 0), 0)).toBeLessThanOrEqual(MAX_PAGE_UNITS);
    expect(page.older).toBe(true);
    expect(page.items.at(-1)?.blocks[0]?.text.startsWith('16')).toBe(true);
  });

  it('answers a window from an item on, keeping the newest or the oldest, and null for an item it does not have (C60)', () => {
    const store = area.open({ synchronous: 'OFF' });
    for (let turn = 1; turn <= WINDOW_ENTRIES + 40; turn += 1) accept(store, `t${turn}`, `prompt ${turn}`);
    const all = store.window(CONVERSATION, 'prompt-t1', 'newest');
    // Past the bound it lets go of the oldest, and still ends with the newest.
    expect(all?.items).toHaveLength(WINDOW_ENTRIES);
    expect(all).toMatchObject({ latest: true, older: true });
    expect(texts(all?.items ?? []).at(-1)).toBe(`prompt ${WINDOW_ENTRIES + 40}`);
    const oldest = store.window(CONVERSATION, 'prompt-t1', 'oldest');
    expect(oldest).toMatchObject({ latest: false, older: false });
    expect(texts(oldest?.items ?? [])[0]).toBe('prompt 1');
    expect(oldest?.items).toHaveLength(WINDOW_ENTRIES);
    // Within the bound: the item asked for and all that follows it.
    const tail = store.window(CONVERSATION, `prompt-t${WINDOW_ENTRIES + 31}`, 'newest');
    expect(texts(tail?.items ?? [])).toHaveLength(10);
    expect(tail).toMatchObject({ latest: true, older: true });
    expect(store.window(CONVERSATION, 'not-held', 'newest')).toBeNull();
    expect(store.pageBefore(CONVERSATION, 'not-held')).toBeNull();
    // A cursor of another conversation is not this one's.
    expect(store.pageBefore(OTHER, 'prompt-t1')).toBeNull();
  });

  it('holds a row of a reserved kind and returns it as a kind alone (C3, C12)', () => {
    const store = area.open();
    accept(store, 't1');
    store.close();
    area.raw((db) => db.prepare("INSERT INTO item (id, conversationId, turnId, place, kind, origin, body) VALUES ('att-1', ?, 't1', 2, 'branch', 'local', ?)").run('11111111-1111-4111-8111-111111111111', JSON.stringify({ blob: 'blobs/abc', role: 'user', blocks: [{ type: 'text', text: 'not for this build' }] })));
    const again = area.open();
    const held = again.newestPage(CONVERSATION).items.find((item) => item.id === 'att-1');
    expect(held).toMatchObject({ kind: 'branch', blocks: [], questions: [], role: null, notice: null, detail: null });
    // Nothing of it was rewritten.
    again.addItem(CONVERSATION, 't1', message('after it'));
    again.close();
    expect(area.raw((db) => db.prepare("SELECT body FROM item WHERE id = 'att-1'").get())).toEqual({ body: JSON.stringify({ blob: 'blobs/abc', role: 'user', blocks: [{ type: 'text', text: 'not for this build' }] }) });
  });
});

describe('unknown fields (V3, V18; C8, C38)', () => {
  it('leaves a table, a column and a JSON key this build does not know as they are, through its writes', () => {
    const store = area.open();
    accept(store, 't1');
    store.addItem(CONVERSATION, 't1', message('an answer', { id: 'answer-1' }));
    store.close();
    area.raw((db) => {
      db.exec('CREATE TABLE future (id TEXT PRIMARY KEY, value TEXT) STRICT');
      db.exec("INSERT INTO future VALUES ('k', 'kept')");
      db.exec('ALTER TABLE turn ADD COLUMN mood TEXT');
      db.exec("UPDATE turn SET mood = 'curious', extra = '{\"later\":1}'");
      db.exec("UPDATE conversation SET extra = '{\"pinned\":true}'");
      db.exec("UPDATE item SET body = json_set(body, '$.reactions', json('[\"+1\"]'))");
    });

    const again = area.open();
    // Every kind of write this build makes to those rows.
    again.providerTook(CONVERSATION, 't1', 'provider-1');
    again.setProviderItemId(CONVERSATION, 'prompt-t1', 'p-user');
    again.setReference(CONVERSATION, 'ref', '/p', null);
    again.providerEnded(CONVERSATION, 't1', 'completed', 9);
    again.sessionEnded(CONVERSATION, 't1', 9, 'completed');
    again.markGap(CONVERSATION, 't1');
    again.markReached(CONVERSATION, ['provider-1'], true);
    again.markRemoving([CONVERSATION]);
    again.liftRemoving([CONVERSATION]);
    again.addItem(CONVERSATION, 't1', message('another'));
    again.close();

    area.raw((db) => {
      expect(db.prepare('SELECT value FROM future').get()).toEqual({ value: 'kept' });
      expect(db.prepare('SELECT mood, extra FROM turn').get()).toEqual({ mood: 'curious', extra: '{"later":1}' });
      expect(db.prepare('SELECT extra FROM conversation').get()).toEqual({ extra: '{"pinned":true}' });
      for (const id of ['prompt-t1', 'answer-1']) expect(db.prepare("SELECT json_extract(body, '$.reactions[0]') AS reaction FROM item WHERE id = ?").get(id), id).toEqual({ reaction: '+1' });
    });
  });

  it('never selects every column, replaces a row or deletes outside a removal, in its source (C38)', async () => {
    const { readFileSync } = await import('node:fs');
    // The code alone: its comments say what it does not do.
    const source = readFileSync(path.join(import.meta.dirname, 'store.ts'), 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    expect(source).not.toMatch(/SELECT \*|INSERT OR REPLACE|REPLACE INTO/i);
    // Every DELETE is the removal's.
    const deletes = source.split('\n').filter((line) => /'DELETE FROM/.test(line));
    expect(deletes).toHaveLength(3);
    for (const line of deletes) expect(line).toMatch(/WHERE (conversationId|id) = \?/);
  });
});

describe('a removal (V10, V29; C21, C30, C62, C63)', () => {
  const NEEDLE = 'only-the-removed-chat-holds-this-0123456789';

  /**
   * A long chat to remove, and a shorter one to keep: 362 rows, one commit each. A test opens the
   * store with `synchronous: 'OFF'` to write them, since waiting for the disk 362 times is seconds
   * of a busy machine's time and no part of what a removal is. The app never writes so.
   */
  function fill(store: ConversationStore): void {
    accept(store, 'keep-1', 'kept prompt', OTHER);
    for (let n = 0; n < 60; n += 1) store.addItem(OTHER, 'keep-1', message('kept '.repeat(300)));
    accept(store, 'gone-1', `${NEEDLE} prompt`);
    for (let n = 0; n < 300; n += 1) store.addItem(CONVERSATION, 'gone-1', message(`${NEEDLE} ${'removed '.repeat(250)}`, { detail: null }));
  }

  it('deletes only what is marked, and only on the word that deletes', () => {
    const store = area.open({ synchronous: 'OFF' });
    fill(store);
    store.markRemoving([CONVERSATION]);
    expect(store.removing()).toEqual([CONVERSATION]);
    // Marked, and whole: nothing has gone yet.
    expect(store.newestPage(CONVERSATION).items.length).toBe(PAGE_ENTRIES);
    store.liftRemoving([CONVERSATION]);
    expect(store.removing()).toEqual([]);
    // Unmarked, it is not deleted.
    store.deleteRemoving([CONVERSATION]);
    expect(store.conversation(CONVERSATION)).not.toBeNull();
    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION, OTHER]);
    expect(store.conversation(CONVERSATION)).toBeNull();
    expect(store.newestPage(CONVERSATION)).toMatchObject({ items: [], turns: [] });
    expect(store.conversations().map((entry) => entry.id)).toEqual([OTHER]);
    expect(store.newestPage(OTHER).items.length).toBe(61);
  });

  it('leaves the removed text in none of the store’s files, open or closed, and the main file smaller', () => {
    const store = area.open({ synchronous: 'OFF' });
    fill(store);
    store.close();
    // The removal itself runs on a store opened as the app opens it: every commit waits for the disk.
    const again = area.open();
    expect(area.holding(NEEDLE)).toContain(STORE_FILE);
    const before = statSync(area.file).size;
    again.markRemoving([CONVERSATION]);
    again.deleteRemoving([CONVERSATION]);
    // While open: overwritten, the pages given back, the log emptied.
    expect(area.holding(NEEDLE)).toEqual([]);
    expect(area.sizes()[`${STORE_FILE}-wal`]).toBe(0);
    expect(statSync(area.file).size).toBeLessThan(before / 2);
    again.close();
    expect(area.holding(NEEDLE)).toEqual([]);
    expect(readdirSync(area.dir)).toEqual([STORE_FILE]);
    // What was kept is whole.
    expect(area.open().newestPage(OTHER).items.length).toBe(61);
  });

  it('logs a checkpoint that fails by its kind, and the removal stands', () => {
    const warned: string[] = [];
    const store = area.open({ synchronous: 'OFF', hook: (point) => { if (point === 'checkpoint') throw Object.assign(new Error('C:\\Users\\someone\\secret'), { code: 'EBUSY' }); }, log: { info: () => undefined, warn: (line: string) => { warned.push(line); }, error: () => undefined } });
    fill(store);
    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION]);
    expect(store.conversation(CONVERSATION)).toBeNull();
    expect(warned).toEqual(['[conversations] the log could not be emptied (Error EBUSY)']);
  });
});

describe('what the storage view reads (V11, V15; C23, C31)', () => {
  it('lists the conversations, names one by its first prompt and measures their text', () => {
    const store = area.open();
    accept(store, 't1', 'First line of the first prompt\nand a second line');
    store.addItem(CONVERSATION, 't1', message('an answer'));
    accept(store, 't2', 'a later prompt');
    accept(store, 'o1', 'the other one', OTHER);
    expect(store.conversations().map((entry) => entry.id).sort()).toEqual([CONVERSATION, OTHER]);
    expect(store.firstPrompt(CONVERSATION)).toBe('First line of the first prompt\nand a second line');
    expect(store.firstPrompt('33333333-3333-4333-8333-333333333333')).toBeNull();
    expect(store.textUnits([CONVERSATION])).toBeGreaterThan(store.textUnits([OTHER]));
    expect(store.textUnits([])).toBe(0);
    expect(store.files.totalSize()).toBeGreaterThan(0);
  });

  it('tells its listeners when a conversation appears, is marked or goes, and when the status changes', () => {
    const store = area.open();
    let told = 0;
    store.subscribe(() => { told += 1; });
    accept(store, 't1');
    expect(told).toBe(1);
    // A second prompt of the same conversation changes neither the set nor a mark.
    accept(store, 't2');
    expect(told).toBe(1);
    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION]);
    expect(told).toBe(3);
  });
});

describe('the lifecycle (V3, V14, V19, V21; C33, C40, C41, C45)', () => {
  it('closes twice without harm, and answers every later write as a storage failure', () => {
    const store = area.open();
    accept(store, 't1');
    store.close();
    store.close();
    expect(() => accept(store, 't2')).toThrow(StorageFailure);
    expect(() => store.newestPage(CONVERSATION)).toThrow(StorageFailure);
    expect(() => store.sessionEnded(CONVERSATION, 't1', 5, 'stopped')).toThrow(StorageFailure);
    try { accept(store, 't3'); } catch (error) { expect((error as StorageFailure).kind).toBe('closed'); }
  });

  it('refuses every read and write of a store it cannot read, and leaves it as it is', () => {
    area.open().close();
    area.raw((db) => db.exec(`UPDATE meta SET schemaVersion = ${CONVERSATIONS_VERSION + 1}, minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    const before = area.hashes()[STORE_FILE];
    const store = area.open();
    expect(store.status()).toEqual({ kind: 'refused', cause: 'newer' });
    expect(() => accept(store, 't1')).toThrow(StorageFailure);
    expect(() => store.conversations()).toThrow(StorageFailure);
    expect(area.hashes()[STORE_FILE]).toBe(before);
  });

  it('starts fresh only from a refused store: the files move aside together, unchanged, and a new store opens', async () => {
    const first = area.open();
    accept(first, 't1', 'kept in the old store');
    expect(await first.startFresh()).toEqual({ status: 'refused', reason: 'not-refused' });
    first.close();
    area.raw((db) => db.exec(`UPDATE meta SET minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    // A sidecar the old store left, as after a killed writer.
    writeFileSync(`${area.file}-wal`, 'a log');
    const main = area.hashes()[STORE_FILE];

    const store = area.open({ now: () => Date.parse('2020-01-25T14:03:12.345Z') });
    let told = 0;
    store.subscribe(() => { told += 1; });
    const answer = await store.startFresh();
    const kept = 'conversations.set-aside.2020-01-25T14-03-12Z.sqlite';
    expect(answer).toEqual({ status: 'done', keptAs: path.join(area.dir, kept) });
    expect(store.status()).toEqual({ kind: 'ok' });
    expect(told).toBe(1);
    expect(existsSync(path.join(area.dir, `${kept}-wal`))).toBe(true);
    // The copy is the old file, byte for byte; the new store holds nothing.
    const { createHash } = await import('node:crypto');
    const { readFileSync } = await import('node:fs');
    expect(createHash('sha256').update(readFileSync(path.join(area.dir, kept))).digest('hex')).toBe(main);
    expect(store.conversations()).toEqual([]);
    accept(store, 't1', 'in the new store');
    expect(texts(store.newestPage(CONVERSATION).items)).toEqual(['in the new store']);
  });

  it('counts the set-aside stores with their size and removes one by its name, touching no other file (C41)', async () => {
    area.open().close();
    area.raw((db) => db.exec(`UPDATE meta SET minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    writeFileSync(`${area.file}-wal`, 'a log of some length');
    const store = area.open({ now: () => Date.parse('2020-01-25T14:03:12Z') });
    await store.startFresh();
    writeFileSync(path.join(area.dir, 'records.json'), '{}');
    writeFileSync(path.join(area.dir, 'records.set-aside.2020-01-25T14-03-12Z.json'), '{}');
    const [aside] = store.files.setAside();
    expect(store.files.setAside()).toHaveLength(1);
    expect(aside?.name).toBe('conversations.set-aside.2020-01-25T14-03-12Z.sqlite');
    // The main file, the log and the index the check left beside them: one store, one size.
    const parts = readdirSync(area.dir).filter((name) => name.startsWith(aside?.name ?? 'none'));
    expect(parts.sort()).toEqual([aside?.name, `${aside?.name}-shm`, `${aside?.name}-wal`]);
    expect(aside?.bytes).toBe(parts.reduce((sum, name) => sum + statSync(path.join(area.dir, name)).size, 0));

    // A name that is not a set-aside store's is not removed, whatever it points at.
    expect(store.files.removeSetAside(['records.json', '..\\conversations.sqlite', STORE_FILE, 'conversations.set-aside.2026-01-01T00-00-00Z.sqlite'])).toEqual({ removed: 0, failed: 4 });
    expect(store.files.removeSetAside([aside?.name ?? ''])).toEqual({ removed: 1, failed: 0 });
    expect(store.files.setAside()).toEqual([]);
    expect(readdirSync(area.dir).filter((name) => !name.startsWith(STORE_FILE))).toEqual(['records.json', 'records.set-aside.2020-01-25T14-03-12Z.json']);
    expect(store.status()).toEqual({ kind: 'ok' });
  });
});

// V6, V26 (docs/planning/_archive/M19.md; C14–C17, C22, C44, C64): a message as it is written — its place
// kept before anything of it is stored, inserted at its first text as incomplete, its text and its
// cut flag written again together, and completed by its whole message in one transaction.
describe('a message as it is written (M19: V6, V26; C14–C17, C64)', () => {
  const partial = (id: string, text: string, patch: Partial<NewItem> = {}): NewItem => message(text, { id, providerItemId: `p-${id}`, phase: 'commentary', receivedAt: 30, ...patch });
  const body = (id: string): Record<string, unknown> => area.raw((db) => JSON.parse(String((db.prepare('SELECT body FROM item WHERE id = ?').get(id) as { body: string }).body)) as Record<string, unknown>);
  const places = (store: ConversationStore) => store.newestPage(CONVERSATION).items.map((item) => `${item.id}@${item.order.item}`);
  const react = (id: string): void => area.raw((db) => { db.prepare("UPDATE item SET body = json_set(body, '$.reactions', json('[\"+1\"]')) WHERE id = ?").run(id); });

  it('keeps the next place for a message that has no text yet: nothing is written, and what comes later goes after it', () => {
    const store = area.open();
    accept(store, 't1');
    const place = store.reserveItem(CONVERSATION, 't1');
    expect(place).toEqual({ turnId: 't1', order: { turn: 1, item: 2 } });
    // Nothing was written for it.
    expect(places(store)).toEqual(['prompt-t1@1']);
    // A notice that arrives meanwhile, and a second message that opens, take later places.
    store.addItem(CONVERSATION, null, message('a notice', { id: 'notice-1', kind: 'notice', role: null, phase: null, notice: 'request-refused' }));
    expect(store.reserveItem(CONVERSATION, null).order).toEqual({ turn: 1, item: 4 });
    // Its first text inserts it at the place kept, incomplete.
    store.saveProgress(CONVERSATION, place, partial('open-1', 'Hel'));
    expect(places(store)).toEqual(['prompt-t1@1', 'open-1@2', 'notice-1@3']);
    expect(store.newestPage(CONVERSATION).items[1]).toMatchObject({ id: 'open-1', state: 'partial', phase: 'commentary', providerItemId: 'p-open-1', blocks: [{ type: 'text', text: 'Hel', cut: false }], time: { receivedAt: 30, providerAt: null } });
    expect(body('open-1')['complete']).toBe(false);
    // An item written whole says that it is complete, and so does every item read.
    expect(body('prompt-t1')['complete']).toBe(true);
    expect(store.newestPage(CONVERSATION).items.map((item) => item.state)).toEqual(['complete', 'partial', 'complete']);
  });

  it('has no place to keep in a conversation with no turn', () => {
    const store = area.open();
    expect(() => store.reserveItem(CONVERSATION, null)).toThrow(StorageFailure);
    accept(store, 't1');
    expect(() => store.reserveItem(CONVERSATION, 'no-such-turn')).toThrow(StorageFailure);
  });

  it('writes the text so far again with its cut flag, in one write, and leaves every other key of the row alone (C16, C64)', () => {
    const store = area.open();
    accept(store, 't1');
    const place = store.reserveItem(CONVERSATION, 't1');
    store.saveProgress(CONVERSATION, place, partial('open-1', 'Hel'));
    react('open-1');
    store.saveProgress(CONVERSATION, place, partial('open-1', 'Hello, wor'));
    expect(body('open-1')).toMatchObject({ complete: false, phase: 'commentary', blocks: [{ type: 'text', text: 'Hello, wor', cut: false }], reactions: ['+1'] });
    // At the bound the flag is stored with the text it belongs to, as a JSON boolean.
    store.saveProgress(CONVERSATION, place, partial('open-1', 'Hello, world', { cut: true }));
    expect(body('open-1')).toMatchObject({ complete: false, blocks: [{ type: 'text', text: 'Hello, world', cut: true }], reactions: ['+1'] });
    expect(store.newestPage(CONVERSATION).items[1]).toMatchObject({ state: 'partial', blocks: [{ text: 'Hello, world', cut: true }] });
    // One row, at its place, with its id and its time: an update, never a delete and an insert.
    expect(places(store)).toEqual(['prompt-t1@1', 'open-1@2']);
    expect(area.raw((db) => db.prepare('SELECT receivedAt, providerItemId FROM item WHERE id = ?').get('open-1'))).toEqual({ receivedAt: 30, providerItemId: 'p-open-1' });
  });

  it('cuts a text over the limit as it writes it, and says so', () => {
    const store = area.open();
    accept(store, 't1');
    const place = store.reserveItem(CONVERSATION, 't1');
    store.saveProgress(CONVERSATION, place, partial('open-1', 'x'));
    store.saveProgress(CONVERSATION, place, partial('open-1', 'x'.repeat(MAX_MESSAGE_TEXT + 5)));
    const [, stored] = store.newestPage(CONVERSATION).items;
    expect(stored?.blocks[0]?.text).toHaveLength(MAX_MESSAGE_TEXT);
    expect(stored?.blocks[0]?.cut).toBe(true);
  });

  it('completes it in one transaction: text, state, phase, questions and cut flag together, the row’s id, place and time kept (C17)', () => {
    const store = area.open();
    accept(store, 't1');
    const place = store.reserveItem(CONVERSATION, 't1');
    store.saveProgress(CONVERSATION, place, partial('open-1', 'Which o', { cut: true }));
    react('open-1');
    // The whole message is the authority: another text than the deltas brought, questions added, the cut flag cleared.
    const whole = store.completeItem(CONVERSATION, place, partial('open-1', 'Which one?', { phase: 'final', questions: [{ title: 'Pick', options: ['a', 'b'] }], receivedAt: 999 }));
    expect(whole.item).toMatchObject({ id: 'open-1', state: 'complete', phase: 'final', order: { turn: 1, item: 2 }, blocks: [{ type: 'text', text: 'Which one?', cut: false }], questions: [{ title: 'Pick', options: ['a', 'b'] }], time: { receivedAt: 30 } });
    expect(whole.turn.id).toBe('t1');
    expect(body('open-1')).toMatchObject({ complete: true, role: 'assistant', reactions: ['+1'] });
    // And the other way: questions cleared, the flag set.
    const second = store.reserveItem(CONVERSATION, 't1');
    store.saveProgress(CONVERSATION, second, { ...partial('open-2', 'A'), questions: [{ title: 'Old', options: [] }] });
    expect(store.completeItem(CONVERSATION, second, partial('open-2', 'All of it', { cut: true })).item).toMatchObject({ state: 'complete', questions: [], blocks: [{ text: 'All of it', cut: true }] });
    // A progress write that comes after all changes nothing of a complete row.
    store.saveProgress(CONVERSATION, place, partial('open-1', 'stale'));
    expect(store.newestPage(CONVERSATION).items[1]).toMatchObject({ state: 'complete', blocks: [{ text: 'Which one?' }] });
  });

  it('inserts the whole message at the place kept where every earlier write of it failed (C17, C21)', () => {
    let fail = true;
    const store = area.open({ hook: (point) => { if (fail && point === 'progress') throw new Error('disk full'); } });
    accept(store, 't1');
    const place = store.reserveItem(CONVERSATION, 't1');
    expect(() => store.saveProgress(CONVERSATION, place, partial('open-1', 'Hel'))).toThrow('disk full');
    // A later message of the turn is stored meanwhile, after the place that is kept.
    store.addItem(CONVERSATION, 't1', message('later', { id: 'later-1' }));
    expect(places(store)).toEqual(['prompt-t1@1', 'later-1@3']);
    // A later progress write is attempted on its own, and inserts at the kept place.
    fail = false;
    store.saveProgress(CONVERSATION, place, partial('open-1', 'Hello'));
    expect(places(store)).toEqual(['prompt-t1@1', 'open-1@2', 'later-1@3']);
    // And a whole message with no row is the insert, with the same id, place and time.
    const other = store.reserveItem(CONVERSATION, 't1');
    const whole = store.completeItem(CONVERSATION, other, partial('open-2', 'All of it', { phase: 'final' }));
    expect(whole.item).toMatchObject({ id: 'open-2', state: 'complete', order: { turn: 1, item: 4 }, time: { receivedAt: 30 } });
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM item').get())).toEqual({ n: 4 });
  });

  it('leaves the last progress write when the whole message’s transaction fails', () => {
    let fail = false;
    const store = area.open({ hook: (point) => { if (fail && point === 'complete') throw new Error('disk full'); } });
    accept(store, 't1');
    const place = store.reserveItem(CONVERSATION, 't1');
    store.saveProgress(CONVERSATION, place, partial('open-1', 'Hello, wor'));
    fail = true;
    expect(() => store.completeItem(CONVERSATION, place, partial('open-1', 'Hello, world.', { phase: 'final' }))).toThrow('disk full');
    expect(store.newestPage(CONVERSATION).items[1]).toMatchObject({ state: 'partial', phase: 'commentary', blocks: [{ text: 'Hello, wor', cut: false }] });
  });

  it('reads an incomplete message as partial after the store is opened again: nothing streams in a store (C15, C19)', () => {
    const store = area.open();
    accept(store, 't1');
    store.saveProgress(CONVERSATION, store.reserveItem(CONVERSATION, 't1'), partial('open-1', 'Half an ans', { cut: true }));
    store.close();
    const again = area.open();
    expect(again.newestPage(CONVERSATION).items[1]).toMatchObject({ id: 'open-1', state: 'partial', blocks: [{ text: 'Half an ans', cut: true }] });
    // What the history check plans with says which items are not whole (C68).
    expect(again.held(CONVERSATION).byItemId('open-1')?.items).toEqual([
      { id: 'prompt-t1', kind: 'message', providerItemId: null, notice: null, complete: true },
      { id: 'open-1', kind: 'message', providerItemId: 'p-open-1', notice: null, complete: false },
    ]);
    // The places kept in the earlier run are gone with it: the next item goes after what is stored.
    expect(again.reserveItem(CONVERSATION, 't1').order.item).toBe(3);
  });

  it('stores a turn’s elapsed time with the provider’s end, beside the provider’s own duration (C44)', () => {
    const store = area.open();
    accept(store, 't1');
    store.providerEnded(CONVERSATION, 't1', 'completed', 20, null, 1_234);
    const turn = store.turn(CONVERSATION, 't1');
    expect(turn).toMatchObject({ providerOutcome: 'completed', endReceivedAt: 20, elapsedMs: 1_234, providerDurationMs: null });
    if (turn === null) throw new Error('no turn');
    expect(turnView(turn, false).time).toMatchObject({ elapsedMs: 1_234, providerDurationMs: null });
    // An end the turn already had measures nothing again; a turn with no measure keeps none.
    store.providerEnded(CONVERSATION, 't1', 'completed', 99, null, 5);
    expect(store.turn(CONVERSATION, 't1')?.elapsedMs).toBe(1_234);
    accept(store, 't2');
    store.providerEnded(CONVERSATION, 't2', 'completed', 30);
    expect(store.turn(CONVERSATION, 't2')?.elapsedMs).toBeNull();
  });
});
