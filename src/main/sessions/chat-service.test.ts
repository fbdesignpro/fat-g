// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8, V26, V27 (docs/planning/_archive/M18.md; C14–C20, C54, C59, C60): a session's chat over a real store —
// what is written through and pushed, whose end a turn's end is, a window read again, and what
// happens to a write that fails: at acceptance, and during a turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AsideSource } from '@shared/contracts/aside';
import type { ChatAsideRead, ChatPush, ChatRead } from '@shared/contracts/chat';
import { itemText, MAX_MESSAGE_TEXT as MAX_TEXT, MAX_UNSAVED_ITEMS, PAGE_ENTRIES, WINDOW_ENTRIES } from '@shared/contracts/conversation';
import { CONVERSATIONS_VERSION } from '../conversations/format';
import type { ConversationStore, NewItem } from '../conversations/store';
import { CONVERSATION as A, OTHER as B, type Scratch, scratch } from '../conversations/test-support';
import { type ChatService, createChatService, MAX_OPEN_MESSAGES } from './chat-service';

let area: Scratch;
let store: ConversationStore;
let chat: ChatService;
let pushes: ChatPush[];
/** The store's transactions that fail, by name; `all` for every one. */
let fault: string | null;
const log = { warn: vi.fn() };

beforeEach(() => {
  area = scratch();
  fault = null;
  log.warn.mockClear();
  // Hundreds of turns in some tests, and nothing here to prove about the disk.
  store = area.open({ synchronous: 'OFF', hook: (point) => { if (fault === point || fault === 'all') throw Object.assign(new Error('C:\\Users\\someone\\conversations.sqlite is full'), { code: 'SQLITE_FULL' }); } });
  chat = createChatService({ store, log });
  pushes = [];
  chat.subscribe((push) => { pushes.push(push); });
  chat.ensure(A, 'checked');
});
afterEach(() => { area.dispose(); });

let made = 0;
const answer = (text: string, patch: Partial<NewItem> = {}): NewItem => {
  made += 1;
  return { id: `answer-${made}`, kind: 'message', origin: 'local', providerItemId: `p-${made}`, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 20, providerAt: null, ...patch };
};
const accept = (turnId: string, text = 'a prompt', session = A) => chat.accept(session, { turnId, itemId: `prompt-${turnId}`, text, at: 10, started: false });
const read = (window: Parameters<ChatService['read']>[1] = null, session = A): ChatRead => {
  const answered = chat.read(session, window, false);
  if (answered === null) throw new Error('no entry');
  return answered;
};
const texts = (answered: ChatRead = read()) => answered.items.map(itemText);
const turnOf = (id: string, answered: ChatRead = read()) => answered.turns.find((turn) => turn.id === id);
const kinds = () => pushes.map((push) => ('item' in push ? `item:${itemText(push.item)}` : 'changed'));

describe('a turn, written through (V6; C14, C15, C20)', () => {
  it('records the prompt, pushes it as an item with its running turn, and raises the revision by one each change', () => {
    expect(accept('t1', 'What is the cat’s name?')).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ sessionId: A, revision: 1, item: { id: 'prompt-t1', role: 'user' }, turn: { id: 't1', state: 'running' } });
    chat.add(A, 't1', answer('Miso.'));
    expect(pushes.map((push) => push.revision)).toEqual([1, 2]);
    expect(read()).toMatchObject({ revision: 2, latest: true, older: null, storage: 'ok' });
    expect(texts()).toEqual(['What is the cat’s name?', 'Miso.']);
    // It is on disk: another connection reads it.
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM item').get())).toEqual({ n: 2 });
  });

  it('names an echoed prompt, and adds nothing for it or for an item the turn already holds', () => {
    accept('t1');
    chat.echo(A, 'prompt-t1', 'provider-user-1');
    chat.echo(A, 'prompt-t1', 'provider-user-2');
    const first = answer('Once.');
    chat.add(A, 't1', first);
    chat.add(A, 't1', { ...first, id: 'another-id' });
    expect(kinds()).toEqual(['item:a prompt', 'changed', 'item:Once.']);
    expect(read().items.map((item) => item.providerItemId)).toEqual(['provider-user-1', first.providerItemId]);
  });

  it('pushes only to the session a change belongs to, and tells nothing of a session it has no entry for', () => {
    chat.ensure(B, 'checked');
    accept('t1');
    accept('b1', 'for the other', B);
    expect(pushes.map((push) => push.sessionId)).toEqual([A, B]);
    chat.add('33333333-3333-4333-8333-333333333333', null, answer('nowhere'));
    expect(pushes).toHaveLength(2);
    expect(chat.read('33333333-3333-4333-8333-333333333333', null, false)).toBeNull();
  });

  it('drops an item that names a turn the conversation does not have, without calling the session failing', () => {
    accept('t1');
    chat.add(A, 'another-run’s-turn', answer('stale'));
    expect(texts()).toEqual(['a prompt']);
    expect(read().storage).toBe('ok');
  });
});

describe('whose end it is (V26; C54, C59)', () => {
  it('stores an end the provider reported as the provider’s, and the turn reads ended', () => {
    accept('t1');
    chat.took(A, 't1', 'provider-turn-1');
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    expect(turnOf('t1')).toMatchObject({ state: 'ended', outcome: 'completed', time: { endReceivedAt: 30 } });
    expect(store.turn(A, 't1')).toMatchObject({ providerOutcome: 'completed', sessionOutcome: null });
  });

  it.each([
    ['a lost end', 'failed'],
    ['a lost connection', 'failed'],
    ['a Stop the provider never confirmed', 'interrupted'],
    ['a close', 'interrupted'],
  ] as const)('writes the session’s end and no provider’s for %s: the turn reads unfinished', (_what, outcome) => {
    accept('t1');
    chat.took(A, 't1', 'provider-turn-1');
    // The adapter ended it itself: the event was not `reported`.
    chat.ended(A, 't1', null);
    chat.sessionEnded(A, 't1', 40, outcome);
    expect(store.turn(A, 't1')).toMatchObject({ providerOutcome: null, endReceivedAt: null, sessionOutcome: outcome, sessionEndedAt: 40 });
    // No provider's end is invented: the outcome shown is the session's, and the turn is unfinished.
    expect(turnOf('t1')).toMatchObject({ state: 'unfinished', outcome });
  });

  it('settles the answer an end names with that end’s own write and push, and names none for an end that carries none (M16, C74)', () => {
    accept('t1');
    chat.add(A, 't1', answer('Looking.', { providerItemId: 'note', phase: 'commentary' }));
    chat.add(A, 't1', answer('Miso.', { providerItemId: 'the-answer', phase: 'commentary' }));
    const before = pushes.length;
    chat.ended(A, 't1', { outcome: 'completed', at: 30, answerItemId: 'the-answer' });
    expect(read().items.map((item) => [item.providerItemId, item.phase])).toEqual([[null, null], ['note', 'commentary'], ['the-answer', 'final']]);
    expect(turnOf('t1')).toMatchObject({ state: 'ended', outcome: 'completed' });
    // One push, the one the end sends: the page reads its window again and finds the phase changed in place.
    expect(kinds().slice(before)).toEqual(['changed']);
    // An end with no answer named changes no message, as every end did before.
    accept('t2');
    chat.add(A, 't2', answer('Still commentary.', { providerItemId: 'other', phase: 'commentary' }));
    chat.ended(A, 't2', { outcome: 'completed', at: 40 });
    chat.ended(A, 't2', { outcome: 'completed', at: 41, answerItemId: 'other' });
    expect(read().items.at(-1)).toMatchObject({ providerItemId: 'other', phase: 'commentary' });
  });

  it('settles an answer that could not be saved in the copy it keeps, whether or not the end itself was written (M16, C74; M18, C19)', () => {
    accept('t1');
    fault = 'item';
    chat.add(A, 't1', answer('Miso.', { providerItemId: 'the-answer', phase: 'commentary' }));
    fault = null;
    chat.ended(A, 't1', { outcome: 'completed', at: 30, answerItemId: 'the-answer' });
    expect(read().items.at(-1)).toMatchObject({ providerItemId: 'the-answer', phase: 'final' });
    expect(read()).toMatchObject({ storage: 'failing' });
    expect(store.turn(A, 't1')).toMatchObject({ providerOutcome: 'completed', gap: true });

    // The end's own write fails too: the copy is settled all the same, and nothing is said to be saved that is not.
    accept('t2');
    fault = 'all';
    chat.add(A, 't2', answer('Biscuit.', { providerItemId: 'second-answer', phase: 'commentary' }));
    chat.ended(A, 't2', { outcome: 'completed', at: 50, answerItemId: 'second-answer' });
    fault = null;
    expect(read().items.at(-1)).toMatchObject({ providerItemId: 'second-answer', phase: 'final' });
    expect(store.turn(A, 't2')).toMatchObject({ providerOutcome: null });
    // No other turn's unsaved item is touched by an id that happens to match.
    expect(read().items.filter((item) => item.phase === 'final').map((item) => item.providerItemId)).toEqual(['the-answer', 'second-answer']);
  });

  it('reads a start that failed as unacknowledged: the provider never took the turn', () => {
    accept('t1');
    chat.ended(A, 't1', null);
    chat.sessionEnded(A, 't1', 40, 'failed');
    expect(turnOf('t1')).toMatchObject({ state: 'unacknowledged', outcome: 'failed' });
  });

  it('reads a turn as running only while it is the one in flight', () => {
    accept('t1');
    expect(turnOf('t1')?.state).toBe('running');
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    accept('t2');
    expect([turnOf('t1')?.state, turnOf('t2')?.state]).toEqual(['ended', 'running']);
    // After a restart nothing is in flight: an entry made afresh reads the same store.
    const again = createChatService({ store, log });
    again.ensure(A, 'not-checked');
    expect(again.read(A, null, true)?.turns.map((turn) => turn.state)).toEqual(['ended', 'unacknowledged']);
  });

  it('tells the store of a session’s end for a session with no chat entry, and changes nothing for a turn it does not have', () => {
    chat.ensure(B, 'checked');
    accept('b1', 'x', B);
    chat.drop(B);
    const before = pushes.length;
    chat.sessionEnded(B, 'b1', 50, 'stopped');
    expect(store.turn(B, 'b1')).toMatchObject({ sessionOutcome: 'stopped', sessionEndedAt: 50 });
    // The demo source's turn: the store has none.
    chat.sessionEnded(A, 'demo-turn', 50, 'completed');
    expect(pushes).toHaveLength(before);
  });
});

describe('a write that fails (V8; C19)', () => {
  it('refuses the Send when its record cannot be written, and leaves nothing: no item, no push, no failing chat', () => {
    fault = 'accept';
    expect(accept('t1')).toBe(false);
    expect(pushes).toEqual([]);
    expect(read()).toMatchObject({ items: [], storage: 'ok' });
    // A later Send works.
    fault = null;
    expect(accept('t2', 'again')).toBe(true);
    expect(texts()).toEqual(['again']);
  });

  it('keeps the output of a running turn shown when it cannot be saved, marks the gap once a write succeeds, and takes the next prompt', () => {
    accept('t1');
    fault = 'item';
    chat.add(A, 't1', answer('first, not saved'));
    chat.add(A, 't1', answer('second, not saved'));
    // Pushed as usual, and read after the stored tail.
    expect(kinds()).toEqual(['item:a prompt', 'item:first, not saved', 'item:second, not saved']);
    expect(texts()).toEqual(['a prompt', 'first, not saved', 'second, not saved']);
    expect(read()).toMatchObject({ storage: 'failing', latest: true });
    // The turn says that part of it could not be saved, before the store itself holds that.
    expect(turnOf('t1')?.gap).toBe(true);
    expect(store.turn(A, 't1')?.gap).toBe(false);

    // The next write that succeeds sets the gap in the store.
    fault = null;
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    expect(store.turn(A, 't1')).toMatchObject({ gap: true, providerOutcome: 'completed' });
    expect(accept('t2', 'a later prompt')).toBe(true);
    chat.add(A, 't2', answer('saved'));
    // What was not saved stays shown for the run, after the stored tail.
    expect(texts()).toEqual(['a prompt', 'a later prompt', 'saved', 'first, not saved', 'second, not saved']);
    // On disk: the prompts and the saved answer alone.
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM item').get())).toEqual({ n: 3 });
  });

  it('marks a turn whose end could not be written, so that a check reads it again', () => {
    accept('t1');
    chat.took(A, 't1', 'provider-turn-1');
    fault = 'provider-end';
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    expect(read().storage).toBe('failing');
    fault = null;
    chat.sessionEnded(A, 't1', 31, 'completed');
    expect(store.turn(A, 't1')).toMatchObject({ gap: true, providerOutcome: null, sessionOutcome: 'completed' });
  });

  it('keeps at most 200 unsaved items a session, the newest', () => {
    accept('t1');
    fault = 'item';
    for (let n = 1; n <= MAX_UNSAVED_ITEMS + 30; n += 1) chat.add(A, 't1', answer(`unsaved ${n}`));
    const shown = texts();
    // The stored prompt, and the newest 200 of what could not be saved.
    expect(shown).toHaveLength(MAX_UNSAVED_ITEMS + 1);
    expect(shown[1]).toBe('unsaved 31');
    expect(shown.at(-1)).toBe(`unsaved ${MAX_UNSAVED_ITEMS + 30}`);
  });

  it('shows what the run kept when the store cannot be read at all, and logs kinds only', () => {
    accept('t1', 'a prompt with a secret in it');
    fault = 'item';
    chat.add(A, 't1', answer('kept in memory, with a secret'));
    store.close();
    expect(read()).toMatchObject({ storage: 'failing', latest: true, older: null });
    expect(texts()).toEqual(['kept in memory, with a secret']);
    expect(accept('t2')).toBe(false);
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).not.toMatch(/secret|someone|a prompt/);
    expect(log.warn.mock.calls[0]?.[0]).toBe('[chat] a write could not be saved (Error SQLITE_FULL), 1 so far');
  });

  it('shows nothing, and says the store is refused, while it is (C33)', () => {
    accept('t1');
    store.close();
    area.raw((db) => db.exec(`UPDATE meta SET minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    const refusedStore = area.open();
    const refused = createChatService({ store: refusedStore, log });
    refused.ensure(A, 'not-checked');
    expect(refused.read(A, null, true)).toMatchObject({ items: [], turns: [], storage: 'refused', latest: true, older: null });
    expect(refused.accept(A, { turnId: 't2', itemId: 'm2', text: 'x', at: 1, started: true })).toBe(false);
  });
});

describe('pages and the held window (V9, V27; C17, C18, C20, C60)', () => {
  /** `count` turns of one prompt each, ended. */
  function fill(count: number): void {
    for (let n = 1; n <= count; n += 1) { accept(`t${n}`, `prompt ${n}`); chat.ended(A, `t${n}`, { outcome: 'completed', at: 30 }); }
    pushes.length = 0;
  }

  it('answers the newest page first, with a cursor to the older ones, and each older page by that cursor', () => {
    fill(250);
    const newest = read();
    expect(newest.items).toHaveLength(PAGE_ENTRIES);
    expect(newest).toMatchObject({ latest: true, older: 'prompt-t151' });
    const older = chat.page(A, 'prompt-t151');
    expect(older).toMatchObject({ status: 'page', sessionId: A, revision: newest.revision, older: 'prompt-t51' });
    expect(older?.status === 'page' ? older.items.map(itemText).at(-1) : null).toBe('prompt 150');
    const oldest = chat.page(A, 'prompt-t51');
    expect(oldest).toMatchObject({ status: 'page', older: null });
    expect(chat.page(A, 'no-such-item')).toEqual({ status: 'refused', reason: 'unknown-cursor' });
  });

  it('reads the held window again from its oldest item: an echo, a turn’s start and end and an import leave the older pages where they were', () => {
    fill(250);
    // The page holds the newest page and one older page: its oldest held item is prompt 51.
    const held = { from: 'prompt-t51', keep: 'newest' as const };
    const before = texts(read(held));
    expect(before).toHaveLength(200);
    expect(before[0]).toBe('prompt 51');

    accept('live', 'a live prompt');
    chat.echo(A, 'prompt-live', 'provider-live');
    chat.took(A, 'live', 'provider-turn-live');
    chat.ended(A, 'live', { outcome: 'completed', at: 40 });
    // An import: a turn made elsewhere, merged before the live one.
    store.mergePage(A, [{ kind: 'new', turn: { turnId: 'p-else', outcome: 'completed', startedAt: 1, endedAt: 2, durationMs: 1 }, messages: [{ role: 'user', itemId: 'e-1', phase: null, text: 'made elsewhere', at: 1, turnId: 'p-else' }], notShown: false }], 'live', 'not shown');
    chat.changed(A);
    // Each of them told the page to read again, and none of them was a new item at the end but the prompt.
    expect(kinds()).toEqual(['item:a live prompt', 'changed', 'changed', 'changed', 'changed']);

    const after = read(held);
    expect(after.latest).toBe(true);
    expect(texts(after).slice(0, 200)).toEqual(before);
    expect(texts(after).slice(200)).toEqual(['made elsewhere', 'a live prompt']);
    expect(after.older).toBe('prompt-t51');
  });

  it('keeps the newest of a full window that holds them, and the oldest of one that had let them go', () => {
    fill(WINDOW_ENTRIES + 60);
    const newest = read({ from: 'prompt-t1', keep: 'newest' });
    expect(newest.items).toHaveLength(WINDOW_ENTRIES);
    expect(newest).toMatchObject({ latest: true, older: 'prompt-t61' });
    expect(texts(newest).at(-1)).toBe(`prompt ${WINDOW_ENTRIES + 60}`);
    const oldest = read({ from: 'prompt-t1', keep: 'oldest' });
    expect(oldest).toMatchObject({ latest: false, older: null });
    expect(texts(oldest)[0]).toBe('prompt 1');
    expect(texts(oldest).at(-1)).toBe(`prompt ${WINDOW_ENTRIES}`);
  });

  it('answers a `from` the store does not have as a first read: the newest page', () => {
    fill(150);
    const answered = read({ from: 'gone-with-a-removal', keep: 'oldest' });
    expect(answered.items).toHaveLength(PAGE_ENTRIES);
    expect(answered).toMatchObject({ latest: true, older: 'prompt-t51' });
  });

  it('says separately what the store holds and what a check found: earlier history missing, and older messages unread (C18)', () => {
    chat.ensure(B, 'not-checked');
    // A session the record says had started, of which the store holds nothing.
    expect(chat.read(B, null, true)?.history).toEqual({ state: 'not-checked', olderUnread: false, earlierMissing: true });
    chat.accept(B, { turnId: 'b1', itemId: 'mb1', text: 'the first fat-g recorded', at: 5, started: true });
    expect(chat.read(B, null, true)?.history.earlierMissing).toBe(true);
    chat.setHistory(B, 'checked', true);
    expect(chat.read(B, null, true)).toMatchObject({ history: { state: 'checked', olderUnread: true, earlierMissing: true }, items: [{ id: 'mb1' }] });
    // A check that reaches the start settles it.
    store.markReached(B, [], true);
    expect(chat.read(B, null, true)?.history.earlierMissing).toBe(false);
    // A conversation made at the session's first prompt holds its start.
    accept('t1');
    expect(read().history.earlierMissing).toBe(false);
  });

  it('pushes a change of the history state, and nothing when it is set to what it is', () => {
    chat.setHistory(A, 'checked');
    expect(pushes).toEqual([]);
    chat.setHistory(A, 'checking');
    chat.setHistory(A, 'checked', true);
    expect(kinds()).toEqual(['changed', 'changed']);
    expect(chat.history(A)).toBe('checked');
  });

  it('shows nothing of a conversation a removal has marked (C63)', () => {
    accept('t1');
    store.markRemoving([A]);
    expect(read()).toMatchObject({ items: [], turns: [], latest: true });
    store.liftRemoving([A]);
    expect(texts()).toEqual(['a prompt']);
  });
});

// ── M19: a message as it is written ───────────────────────────────────────────────────────────
// V2, V7, V9, V11, V26 (docs/planning/_archive/M19.md; C3–C6, C14–C19, C21, C23–C27, C64): the open messages
// of a session on a clock in the test's hands — what is pushed and when, what a read answers, what
// is written and when, and what an end, a quit and a failed write leave.

/** A clock in the test's hands: a timer fires only when the clock is advanced to it. */
function manualClock() {
  let time = 0;
  let made = 0;
  const pending = new Map<number, { readonly at: number; readonly run: () => void }>();
  return {
    timers: {
      set: (run: () => void, ms: number): unknown => { made += 1; pending.set(made, { at: time + ms, run }); return made; },
      clear: (handle: unknown): void => { pending.delete(handle as number); },
    },
    advance(ms: number): void {
      const end = time + ms;
      for (;;) {
        const [next] = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (next === undefined) break;
        pending.delete(next[0]);
        time = next[1].at;
        next[1].run();
      }
      time = end;
    },
    pending: (): number => pending.size,
  };
}

describe('a message as it is written (M19)', () => {
  let clock: ReturnType<typeof manualClock>;
  let stream: ChatService;
  let sent: ChatPush[];
  /** The store's transactions that ran, by name. */
  let wrote: string[];

  beforeEach(() => {
    clock = manualClock();
    wrote = [];
    let ids = 0;
    area.dispose();
    area = scratch();
    store = area.open({ synchronous: 'OFF', hook: (point) => { if (fault === point || fault === 'all') throw Object.assign(new Error('C:\\Users\\someone\\conversations.sqlite is full'), { code: 'SQLITE_FULL' }); wrote.push(point); } });
    stream = createChatService({ store, log, timers: clock.timers, now: () => 30, newId: () => `open-${++ids}` });
    sent = [];
    stream.subscribe((push) => { sent.push(push); });
    stream.ensure(A, 'checked');
  });

  const begin = (turnId = 't1'): void => { expect(stream.accept(A, { turnId, itemId: `prompt-${turnId}`, text: 'a prompt', at: 10, started: false })).toBe(true); sent.length = 0; wrote.length = 0; };
  const delta = (text: string, itemId = 'p-1', turnId = 't1', phase: 'commentary' | 'final' | null = 'commentary'): void => stream.delta(A, turnId, { itemId, phase, text });
  const whole = (text: string, patch: Partial<NewItem> = {}): NewItem => ({ id: 'the-runtime-made-this', kind: 'message', origin: 'local', providerItemId: 'p-1', role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 999, providerAt: null, ...patch });
  const shown = (): ChatRead => { const answered = stream.read(A, null, false); if (answered === null) throw new Error('no entry'); return answered; };
  const item = (id: string, answered: ChatRead = shown()) => answered.items.find((entry) => entry.id === id);
  const row = (id: string): Record<string, unknown> | null => area.raw((db) => { const found = db.prepare('SELECT body FROM item WHERE id = ?').get(id) as { body: string } | undefined; return found === undefined ? null : JSON.parse(found.body) as Record<string, unknown>; });
  const rowText = (id: string): unknown => (row(id)?.['blocks'] as { text: string }[] | undefined)?.[0]?.text;
  const said = () => sent.map((push) => ('item' in push ? `item:${push.item.state}:${itemText(push.item)}` : 'partial' in push ? `partial:${push.partial.before}+${push.partial.append}` : 'changed'));

  // M21, V20 (C56, C69): the empty message a provider sends after one that asks a question.
  describe('an empty whole message (M21: V20; C56, C69)', () => {
    it('is let go at its completion where its start opened it and no text came: closed unwritten, told as a change, with no row and nothing of it in a read after', () => {
      begin();
      delta('', 'p-trailer', 't1', 'final');
      expect(said()).toEqual(['item:streaming:']);
      expect(item('open-1')).toMatchObject({ state: 'streaming' });
      sent.length = 0;
      stream.add(A, 't1', whole('', { providerItemId: 'p-trailer' }));
      expect(said()).toEqual(['changed']);
      expect(wrote).toEqual([]);
      expect(row('open-1')).toBeNull();
      expect(shown().items.map((entry) => entry.id)).toEqual(['prompt-t1']);
      // A delta that names it afterwards is dropped: it is over.
      delta('late', 'p-trailer', 't1', 'final');
      expect(shown().items).toHaveLength(1);
      expect(stream.dropped().complete).toBe(1);
    });

    it('makes no item where nothing opened it either', () => {
      begin();
      stream.add(A, 't1', whole('', { providerItemId: 'p-trailer' }));
      expect(sent).toEqual([]);
      expect(wrote).toEqual([]);
      expect(shown().items).toHaveLength(1);
    });

    it('leaves an ordinary message as it was: it starts empty, streams its deltas and completes; and an interrupted one stays open with what it received', () => {
      begin();
      delta('', 'p-1', 't1', 'final');
      delta('Hello, ');
      delta('world.');
      stream.add(A, 't1', whole('Hello, world.'));
      expect(item('open-1')).toMatchObject({ state: 'complete', blocks: [{ text: 'Hello, world.' }] });
      expect(rowText('open-1')).toBe('Hello, world.');
      // Its completion never comes: the turn's end leaves it as far as it got.
      delta('', 'p-2', 't1', 'final');
      delta('Half an ans', 'p-2');
      stream.ended(A, 't1', { outcome: 'interrupted', at: 40 });
      expect(item('open-2')).toMatchObject({ state: 'partial', blocks: [{ text: 'Half an ans' }] });
    });

    it('keeps a message with no text that carries questions: the questions are what it says', () => {
      begin();
      stream.add(A, 't1', whole('', { providerItemId: 'p-q', questions: [{ title: 'Which file?', options: ['a', 'b'] }] }));
      expect(shown().items.map((entry) => entry.questions.length)).toEqual([0, 1]);
    });
  });

  describe('opened, grown and completed (V2, V11; C3, C4, C14, C24–C26)', () => {
    it('opens at its first delta: pushed at once as an empty streaming item at the place kept for it, and nothing written', () => {
      begin();
      delta('');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ sessionId: A, revision: 2, item: { id: 'open-1', turnId: 't1', role: 'assistant', phase: 'commentary', state: 'streaming', providerItemId: 'p-1', order: { turn: 1, item: 2 }, blocks: [{ text: '', cut: false }], time: { receivedAt: 30 } }, turn: { id: 't1', state: 'running' } });
      expect(wrote).toEqual([]);
      expect(row('open-1')).toBeNull();
      // A read shows it, streaming, though the store has no row of it.
      expect(item('open-1')).toMatchObject({ state: 'streaming', blocks: [{ text: '' }] });
      expect(clock.pending()).toBe(0);
    });

    it('writes its first text at once as incomplete, and pushes what it gathers at most every 50 ms', () => {
      begin();
      delta('');
      delta('Hel');
      // On disk at once, incomplete: fat-g killed now keeps it.
      expect(wrote).toEqual(['progress']);
      expect(row('open-1')).toMatchObject({ complete: false, blocks: [{ type: 'text', text: 'Hel', cut: false }] });
      delta('lo, ');
      delta('wor');
      // Nothing more is pushed until the interval has passed.
      expect(said()).toEqual(['item:streaming:']);
      clock.advance(49);
      expect(sent).toHaveLength(1);
      clock.advance(1);
      expect(sent[1]).toEqual({ sessionId: A, revision: 3, partial: { itemId: 'open-1', before: 0, append: 'Hello, wor' } });
      // The next delta arms the next push: one a 50 ms, with everything gathered by then.
      clock.advance(200);
      expect(sent).toHaveLength(2);
      delta('ld');
      delta('.');
      clock.advance(50);
      expect(sent[2]).toEqual({ sessionId: A, revision: 4, partial: { itemId: 'open-1', before: 10, append: 'ld.' } });
      clock.advance(1_000);
      expect(sent).toHaveLength(3);
    });

    it('opens a message whose first delta carries text: the opening first, then the text as a partial push', () => {
      begin();
      delta('Hello');
      expect(said()).toEqual(['item:streaming:']);
      clock.advance(50);
      expect(said()).toEqual(['item:streaming:', 'partial:0+Hello']);
      expect(rowText('open-1')).toBe('Hello');
    });

    it('answers a read with the text it has pushed and its revision together: no text is told twice, and none is lost (C26)', () => {
      begin();
      delta('Hel');
      clock.advance(50);
      delta('lo');
      // Gathered and not pushed: the read leaves it for the next partial push.
      const crossed = shown();
      expect(crossed.revision).toBe(3);
      expect(item('open-1', crossed)).toMatchObject({ state: 'streaming', blocks: [{ text: 'Hel' }] });
      clock.advance(50);
      expect(sent.at(-1)).toEqual({ sessionId: A, revision: 4, partial: { itemId: 'open-1', before: 3, append: 'lo' } });
      // After the push the read has it, at that push's revision.
      const after = shown();
      expect(after.revision).toBe(4);
      expect(item('open-1', after)).toMatchObject({ blocks: [{ text: 'Hello' }] });
      // The store's own row may be shorter or longer than what was pushed: the read is what was pushed.
      expect(rowText('open-1')).toBe('Hel');
    });

    it('is completed by its whole message: one write, one push at once, the whole text in place of the deltas’, and what was gathered dropped (C4, C17, C25)', () => {
      begin();
      delta('Hel');
      clock.advance(50);
      delta('lo, wrold');
      wrote.length = 0;
      stream.add(A, 't1', whole('Hello, world.'));
      expect(wrote).toEqual(['complete']);
      // The id, the place and the time are the ones its opening fixed, not the whole message's own.
      expect(sent.at(-1)).toMatchObject({ revision: 4, item: { id: 'open-1', state: 'complete', phase: 'final', order: { turn: 1, item: 2 }, blocks: [{ text: 'Hello, world.', cut: false }], time: { receivedAt: 30 } }, turn: { id: 't1', state: 'running' } });
      expect(row('open-1')).toMatchObject({ complete: true, phase: 'final', blocks: [{ text: 'Hello, world.', cut: false }] });
      // Nothing is appended after it: the gathered text went, and no timer is left.
      clock.advance(5_000);
      expect(said()).toEqual(['item:streaming:', 'partial:0+Hel', 'item:complete:Hello, world.']);
      expect(wrote).toEqual(['complete']);
      expect(clock.pending()).toBe(0);
      expect(shown().items.map((entry) => `${entry.id}:${entry.state}`)).toEqual(['prompt-t1:complete', 'open-1:complete']);
    });

    it('takes a message no delta opened as a whole message, as before', () => {
      begin();
      stream.add(A, 't1', whole('All at once.', { id: 'whole-1' }));
      expect(said()).toEqual(['item:complete:All at once.']);
      expect(wrote).toEqual(['item']);
      expect(row('whole-1')).toMatchObject({ complete: true });
    });

    it('keeps the order messages began in: a second message that opens, and completes first, stays second (C14)', () => {
      begin();
      delta('first, slow', 'p-1');
      delta('second', 'p-2');
      stream.add(A, 't1', whole('second, done', { providerItemId: 'p-2' }));
      stream.add(A, 't1', whole('first, done', { providerItemId: 'p-1' }));
      expect(shown().items.map((entry) => `${entry.id}@${entry.order.item}:${itemText(entry)}`)).toEqual(['prompt-t1@1:a prompt', 'open-1@2:first, done', 'open-2@3:second, done']);
    });

    it('pushes one partial update a 50 ms for a session, also with two messages open (C25)', () => {
      begin();
      delta('a', 'p-1');
      delta('b', 'p-2');
      sent.length = 0;
      clock.advance(50);
      expect(said()).toEqual(['partial:0+a']);
      clock.advance(50);
      expect(said()).toEqual(['partial:0+a', 'partial:0+b']);
    });
  });

  describe('written as it grows (V6; C16)', () => {
    it('writes the text so far again at most every 2 seconds, and only when it has grown', () => {
      begin();
      delta('one');
      expect(wrote).toEqual(['progress']);
      delta(' two');
      clock.advance(1_999);
      expect(wrote).toEqual(['progress']);
      expect(rowText('open-1')).toBe('one');
      clock.advance(1);
      expect(wrote).toEqual(['progress', 'progress']);
      expect(rowText('open-1')).toBe('one two');
      // Nothing arrives: nothing is written.
      clock.advance(10_000);
      expect(wrote).toEqual(['progress', 'progress']);
      // A delta arms the next write, two seconds on.
      delta(' three');
      delta(' four');
      clock.advance(2_000);
      expect(wrote).toEqual(['progress', 'progress', 'progress']);
      expect(rowText('open-1')).toBe('one two three four');
    });

    it('writes nothing for a message that has no text', () => {
      begin();
      delta('');
      clock.advance(10_000);
      expect(wrote).toEqual([]);
    });
  });

  describe('deltas that are not taken (V2; C6, C23)', () => {
    it('drops and counts a delta for a turn that has ended, and for a message that is complete', () => {
      begin();
      delta('Hel');
      stream.add(A, 't1', whole('Hello.'));
      delta('lo.');
      expect(stream.dropped()).toMatchObject({ complete: 1 });
      // A whole message that no delta opened is complete too.
      stream.add(A, 't1', whole('Second.', { id: 'whole-2', providerItemId: 'p-2' }));
      delta('Sec', 'p-2');
      expect(stream.dropped()).toMatchObject({ complete: 2 });
      stream.ended(A, 't1', { outcome: 'completed', at: 40 });
      delta('late', 'p-3');
      delta('late', 'p-1');
      // Another turn's, while a turn runs.
      begin('t2');
      delta('for the turn before', 'p-9', 't1');
      expect(stream.dropped()).toEqual({ bound: 0, 'turn-ended': 3, complete: 2, unopened: 0 });
      expect(shown().items.map(itemText)).toEqual(['a prompt', 'Hello.', 'Second.', 'a prompt']);
      expect(said()).toEqual([]);
    });

    it('opens nothing for a session with no turn in flight, and no more than sixteen messages at once', () => {
      stream.ensure(B, 'checked');
      stream.delta(B, 't-none', { itemId: 'p-1', phase: null, text: 'x' });
      expect(stream.dropped()).toMatchObject({ 'turn-ended': 1 });
      expect(sent).toEqual([]);
      begin();
      for (let n = 1; n <= MAX_OPEN_MESSAGES; n += 1) delta('', `p-${n}`);
      expect(sent).toHaveLength(MAX_OPEN_MESSAGES);
      // One more could not be opened: its deltas are dropped, each counted, and nothing is pushed for it.
      delta('x', 'p-over');
      delta('y', 'p-over');
      expect(sent).toHaveLength(MAX_OPEN_MESSAGES);
      expect(stream.dropped()).toMatchObject({ unopened: 2 });
      // Its whole message still arrives whole.
      stream.add(A, 't1', whole('whole', { id: 'whole-over', providerItemId: 'p-over' }));
      expect(item('whole-over')).toMatchObject({ state: 'complete', blocks: [{ text: 'whole' }] });
    });

    it('logs a dropped delta by its kind and a count, and nothing it held (C23)', () => {
      begin();
      stream.ended(A, 't1', null);
      delta('a secret answer');
      const logged = JSON.stringify(log.warn.mock.calls);
      expect(logged).toContain('[chat] a delta was dropped (turn-ended), 1 so far');
      expect(logged).not.toMatch(/secret/);
    });
  });

  describe('the bound (V2, V26; C6, C64)', () => {
    const fill = (units: number): void => { for (let done = 0; done < units; done += 10_000) delta('x'.repeat(Math.min(10_000, units - done))); };

    it('takes no more past 100,000 units: the rest is dropped and counted, and the item is pushed at once, cut, while it still streams', () => {
      begin();
      fill(MAX_TEXT - 3);
      clock.advance(50);
      sent.length = 0;
      delta('abcdef');
      // Pushed as an item, with the text to the bound and its flag: nothing stays gathered.
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ item: { id: 'open-1', state: 'streaming', blocks: [{ cut: true }] } });
      const pushed = 'item' in (sent[0] as ChatPush) ? (sent[0] as Extract<ChatPush, { item: unknown }>).item : null;
      expect(itemText(pushed ?? { blocks: [] })).toHaveLength(MAX_TEXT);
      expect(itemText(pushed ?? { blocks: [] }).endsWith('xabc')).toBe(true);
      delta('more');
      delta('and more');
      clock.advance(50);
      expect(sent).toHaveLength(1);
      expect(stream.dropped()).toMatchObject({ bound: 3 });
      expect(item('open-1')).toMatchObject({ state: 'streaming', blocks: [{ cut: true }] });
    });

    it('never cuts between the two halves of a pair', () => {
      begin();
      fill(MAX_TEXT - 1);
      delta('😀');
      const text = itemText(item('open-1') ?? { blocks: [] });
      expect(text).toHaveLength(MAX_TEXT - 1);
      expect(item('open-1')?.blocks[0]?.cut).toBe(true);
    });

    it('stores the flag with the text at the next progress write, at the turn’s end and at the quit', () => {
      begin();
      fill(MAX_TEXT);
      delta('over');
      // The bound brings no write of its own.
      expect((row('open-1')?.['blocks'] as { cut: boolean }[])[0]?.cut).toBe(false);
      clock.advance(2_000);
      expect(row('open-1')).toMatchObject({ complete: false, blocks: [{ cut: true }] });
      expect(String(rowText('open-1'))).toHaveLength(MAX_TEXT);

      // The turn's end: a second message that passed its bound a moment before it.
      delta('y'.repeat(10), 'p-2');
      for (let n = 0; n < 10; n += 1) delta('y'.repeat(10_000), 'p-2');
      stream.ended(A, 't1', null);
      expect(row('open-2')).toMatchObject({ complete: false, blocks: [{ cut: true }] });

      // The quit: a message past its bound, written by the quit's own save.
      begin('t2');
      delta('z', 'p-3', 't2');
      for (let n = 0; n < 10; n += 1) delta('z'.repeat(10_000), 'p-3', 't2');
      expect((row('open-3')?.['blocks'] as { cut: boolean }[])[0]?.cut).toBe(false);
      stream.saveOpen();
      expect(row('open-3')).toMatchObject({ complete: false, blocks: [{ cut: true }] });
    });

    it('is kept partial and cut after a Stop, and reads so at the next launch', () => {
      begin();
      fill(MAX_TEXT);
      delta('over');
      stream.ended(A, 't1', { outcome: 'interrupted', at: 40 });
      expect(item('open-1')).toMatchObject({ state: 'partial', blocks: [{ cut: true }] });
      // The next launch: a new service over the same store.
      const next = createChatService({ store, log, timers: clock.timers });
      next.ensure(A, 'checked');
      expect(next.read(A, null, false)?.items[1]).toMatchObject({ id: 'open-1', state: 'partial', blocks: [{ cut: true }] });
    });

    it('lets a whole message that arrives after all be the authority for the flag', () => {
      begin();
      fill(MAX_TEXT);
      delta('over');
      stream.add(A, 't1', whole('The provider’s own, shorter text.'));
      expect(item('open-1')).toMatchObject({ state: 'complete', blocks: [{ text: 'The provider’s own, shorter text.', cut: false }] });
      expect(row('open-1')).toMatchObject({ complete: true, blocks: [{ cut: false }] });
    });
  });

  describe('a turn that ends with a message open (V7; C18, C19)', () => {
    it.each([
      ['a Stop the provider confirmed', { outcome: 'interrupted', at: 40 } as const, 'ended'],
      ['an end the adapter made', null, 'unfinished'],
    ])('leaves it partial with what was received, after %s: nothing erased, nothing invented', (_name, reported, turnState) => {
      begin();
      stream.took(A, 't1', 'provider-turn-1');
      delta('Half an ans');
      clock.advance(50);
      delta('wer, and a bit');
      sent.length = 0;
      stream.ended(A, 't1', reported);
      // What was gathered and not pushed is kept too: the end's write has all of it.
      expect(row('open-1')).toMatchObject({ complete: false, phase: 'commentary', blocks: [{ text: 'Half an answer, and a bit', cut: false }] });
      // The page is told that something changed, and reads it: partial, under its turn as M18 reads it.
      expect(said()).toEqual(['changed']);
      const answered = shown();
      expect(item('open-1', answered)).toMatchObject({ state: 'partial', blocks: [{ text: 'Half an answer, and a bit' }] });
      expect(answered.turns.find((turn) => turn.id === 't1')).toMatchObject({ state: turnState });
      // No push and no write follows it.
      clock.advance(10_000);
      expect(said()).toEqual(['changed']);
      expect(clock.pending()).toBe(0);
    });

    it('keeps nothing of a message that opened and never had text', () => {
      begin();
      delta('');
      stream.ended(A, 't1', null);
      expect(shown().items.map((entry) => entry.id)).toEqual(['prompt-t1']);
      expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM item').get())).toEqual({ n: 1 });
    });

    it('writes each open message’s text at the quit, before the store is closed: partial under its unfinished turn at the next launch (C19)', () => {
      begin();
      stream.took(A, 't1', 'provider-turn-1');
      delta('one');
      delta(' two');
      expect(rowText('open-1')).toBe('one');
      stream.saveOpen();
      expect(rowText('open-1')).toBe('one two');
      // The quit's own end, the session's, and the close.
      stream.sessionEnded(A, 't1', 50, 'stopped');
      stream.dispose();
      expect(clock.pending()).toBe(0);
      store.close();
      const again = area.open();
      const next = createChatService({ store: again, log });
      next.ensure(A, 'checked');
      const answered = next.read(A, null, false);
      expect(answered?.items[1]).toMatchObject({ id: 'open-1', state: 'partial', blocks: [{ text: 'one two' }] });
      expect(answered?.turns[0]).toMatchObject({ state: 'unfinished', outcome: 'stopped' });
    });

    it('holds, after a crash, what the last write stored: all but the last two seconds at most, partial and never streaming', () => {
      begin();
      delta('written at once');
      delta(', written at two seconds');
      clock.advance(2_000);
      delta(', and lost with the process');
      // No end, no quit: the process is gone.
      store.close();
      const next = createChatService({ store: area.open(), log });
      next.ensure(A, 'checked');
      expect(next.read(A, null, false)?.items[1]).toMatchObject({ state: 'partial', blocks: [{ text: 'written at once, written at two seconds' }] });
    });
  });

  describe('a write that fails (V9; C21)', () => {
    it('makes one row at the place kept, when the first insert fails and a later write succeeds', () => {
      begin();
      fault = 'progress';
      delta('Hel');
      expect(row('open-1')).toBeNull();
      // Shown all the same, and the chat says that it is failing.
      clock.advance(50);
      expect(item('open-1')).toMatchObject({ state: 'streaming', blocks: [{ text: 'Hel' }] });
      expect(shown()).toMatchObject({ storage: 'failing' });
      // A notice of the turn is stored meanwhile, after the place that is kept.
      stream.add(A, 't1', whole('a notice', { id: 'notice-1', kind: 'notice', role: null, phase: null, providerItemId: null, notice: 'request-refused' }));
      delta('lo');
      fault = null;
      // The next progress write is attempted on its own, with the latest text.
      clock.advance(2_000);
      expect(rowText('open-1')).toBe('Hello');
      expect(area.raw((db) => db.prepare('SELECT id, place FROM item ORDER BY place').all())).toEqual([{ id: 'prompt-t1', place: 1 }, { id: 'open-1', place: 2 }, { id: 'notice-1', place: 3 }]);
      expect(shown().items.map((entry) => entry.id)).toEqual(['prompt-t1', 'open-1', 'notice-1']);
      // The gap is the turn's, in the store once a write has succeeded.
      expect(store.turn(A, 't1')?.gap).toBe(true);
    });

    it('does not let a failed progress write prevent a later one, or the completion', () => {
      begin();
      delta('one');
      fault = 'progress';
      delta(' two');
      clock.advance(2_000);
      expect(rowText('open-1')).toBe('one');
      fault = null;
      delta(' three');
      clock.advance(2_000);
      expect(rowText('open-1')).toBe('one two three');
      fault = 'progress';
      delta(' four');
      clock.advance(2_000);
      fault = null;
      stream.add(A, 't1', whole('one two three four.'));
      expect(row('open-1')).toMatchObject({ complete: true, blocks: [{ text: 'one two three four.' }] });
    });

    it('keeps the completed text shown for the run when the final write fails: over the stale row, never beside it, and not written again by itself', () => {
      begin();
      delta('Half');
      fault = 'complete';
      stream.add(A, 't1', whole('The whole answer.'));
      fault = null;
      expect(sent.at(-1)).toMatchObject({ item: { id: 'open-1', state: 'complete', phase: 'final', blocks: [{ text: 'The whole answer.' }] }, turn: { gap: true } });
      // The store still has what the last write left.
      expect(row('open-1')).toMatchObject({ complete: false, blocks: [{ text: 'Half' }] });
      // A read, a window read again and a switch away and back all show the whole text, once, at its place.
      for (const answered of [shown(), stream.read(A, { from: 'prompt-t1', keep: 'newest' }, false), shown()]) {
        expect(answered?.items.map((entry) => `${entry.id}@${entry.order.item}:${entry.state}:${itemText(entry)}`)).toEqual(['prompt-t1@1:complete:a prompt', 'open-1@2:complete:The whole answer.']);
        expect(answered).toMatchObject({ storage: 'failing' });
      }
      // No failed write is queued: time passes, later writes succeed, and the row is as it was.
      clock.advance(60_000);
      stream.ended(A, 't1', { outcome: 'completed', at: 40 });
      expect(row('open-1')).toMatchObject({ complete: false, blocks: [{ text: 'Half' }] });
      expect(store.turn(A, 't1')).toMatchObject({ gap: true, providerOutcome: 'completed' });
      expect(item('open-1')).toMatchObject({ state: 'complete', blocks: [{ text: 'The whole answer.' }] });
    });

    it('keeps a message partial in memory, with its cut flag, when the end’s write fails', () => {
      begin();
      delta('x'.repeat(10));
      for (let n = 0; n < 10; n += 1) delta('x'.repeat(10_000));
      fault = 'progress';
      stream.ended(A, 't1', null);
      fault = null;
      expect(item('open-1')).toMatchObject({ state: 'partial', blocks: [{ cut: true }] });
      expect(itemText(item('open-1') ?? { blocks: [] })).toHaveLength(MAX_TEXT);
      expect(String(rowText('open-1'))).toHaveLength(10);
    });

    it('shows a streaming message when the store cannot be read at all', () => {
      begin();
      delta('kept in memory');
      clock.advance(50);
      store.close();
      delta(', and more');
      clock.advance(50);
      const answered = shown();
      expect(answered).toMatchObject({ storage: 'failing', latest: true });
      expect(answered.items.map((entry) => `${entry.state}:${itemText(entry)}`)).toEqual(['streaming:kept in memory, and more']);
    });

    it('logs kinds and counts only: never a text of a message (C23)', () => {
      begin();
      fault = 'progress';
      delta('a secret answer');
      fault = 'complete';
      stream.add(A, 't1', whole('the whole secret answer'));
      const logged = JSON.stringify(log.warn.mock.calls);
      expect(logged).toContain('a write could not be saved');
      expect(logged).not.toMatch(/secret|someone/);
    });
  });
});

// M20b (V7, V21; C4, C28–C31, C33, C50, C73, C75): an aside is a conversation of its own in the
// store, and an entry of its own here — whose pushes go out under its session's id and revision,
// each naming the aside.
describe('an aside (M20b)', () => {
  const ASIDE = '33333333-3333-4333-8333-333333333333';
  const SECOND = '44444444-4444-4444-8444-444444444444';
  const EXCERPT = 'The tide table lists high and low water.';
  const SOURCE: AsideSource = { kind: 'message', itemId: 'answer-0', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 5 }, range: { start: 12, end: 52 }, digest: '0badc0de', excerpt: EXCERPT, cut: false };
  /** An aside's question, as the runtime records one: the first makes its conversation. */
  const ask = (turnId: string, text: string, asideId = ASIDE, source: AsideSource | null = SOURCE, session = A) => {
    chat.ensureAside(asideId, session);
    return chat.accept(asideId, { turnId, itemId: `q-${turnId}`, text, at: 30, started: false, aside: { parentId: session, source, title: 'A title' } });
  };
  const readAside = (before?: string, asideId = ASIDE, session = A): ChatAsideRead => {
    const answered = chat.readAside(session, asideId, before);
    if (answered === null || answered.status !== 'read') throw new Error(`not read: ${JSON.stringify(answered)}`);
    return answered;
  };
  const end = (turnId: string, asideId = ASIDE) => { chat.ended(asideId, turnId, { outcome: 'completed', at: 40 }); chat.sessionEnded(asideId, turnId, 40, 'completed'); };

  describe('its pushes (V7; C33, C73)', () => {
    it('go out under its session’s id and revision, each naming the aside: one count for the session, its asides and its own items together', () => {
      accept('t1');
      expect(ask('at1', 'Explain this passage.')).toBe(true);
      chat.add(ASIDE, 'at1', answer('It lists the two tides.'));
      chat.add(A, 't1', answer('The session’s own answer.'));
      expect(pushes.map((push) => [push.sessionId, push.revision, push.asideId ?? null, 'item' in push ? itemText(push.item) : 'changed'])).toEqual([
        [A, 1, null, 'a prompt'],
        [A, 2, ASIDE, 'Explain this passage.'],
        [A, 3, ASIDE, 'It lists the two tides.'],
        [A, 4, null, 'The session’s own answer.'],
      ]);
      // No push is the aside's own id's: nothing subscribes by it.
      expect(pushes.some((push) => push.sessionId === ASIDE)).toBe(false);
      expect(read().revision).toBe(4);
      expect(readAside().revision).toBe(4);
      // That the session's list of asides changed is the runtime's to say, with the ask it took (C30).
    });

    it('carry its turn as it is — running, then ended — and the model a message names', () => {
      accept('t1');
      ask('at1', 'Explain this passage.');
      const question = pushes.at(-1) as Extract<ChatPush, { item: unknown }>;
      expect(question.turn).toMatchObject({ id: 'at1', state: 'running' });
      chat.add(ASIDE, 'at1', answer('By another model.', { model: 'claude-haiku-5' }));
      expect((pushes.at(-1) as Extract<ChatPush, { item: unknown }>).item).toMatchObject({ conversationId: ASIDE, role: 'assistant', model: 'claude-haiku-5' });
      end('at1');
      const last = pushes.at(-1) as ChatPush;
      expect(last.asideId).toBe(ASIDE);
      expect(readAside().turns).toMatchObject([{ id: 'at1', state: 'ended', outcome: 'completed' }]);
      // And after a restart the model is still the message's own (C7).
      expect(readAside().items.map((item) => item.model)).toEqual([null, 'claude-haiku-5']);
    });

    it('carry its text as it is written, as partials that name it, gathered as a session’s are', () => {
      vi.useFakeTimers();
      try {
        chat.dispose();
        chat = createChatService({ store, log });
        pushes = [];
        chat.subscribe((push) => { pushes.push(push); });
        chat.ensure(A, 'checked');
        accept('t1');
        ask('at1', 'Explain this passage.');
        chat.delta(ASIDE, 'at1', { itemId: 'p-stream', phase: 'final', text: '' });
        chat.delta(ASIDE, 'at1', { itemId: 'p-stream', phase: 'final', text: 'It lists ' });
        chat.delta(ASIDE, 'at1', { itemId: 'p-stream', phase: 'final', text: 'the two tides.' });
        vi.advanceTimersByTime(60);
        const partials = pushes.flatMap((push) => ('partial' in push ? [push] : []));
        expect(partials.length).toBeGreaterThan(0);
        expect(partials.every((push) => push.sessionId === A && push.asideId === ASIDE)).toBe(true);
        expect(partials.map((push) => push.partial.append).join('')).toBe('It lists the two tides.');
        // What a read of the aside answers is what was pushed, with the revision together.
        const answered = readAside();
        expect(itemText(answered.items.at(-1) as NonNullable<ReturnType<typeof answered.items.at>>)).toBe('It lists the two tides.');
        expect(answered.items.at(-1)?.state).toBe('streaming');
        // And nothing of it is in the session's own read.
        expect(texts()).toEqual(['a prompt']);
      } finally { vi.useRealTimers(); }
    });
  });

  describe('what a session’s read holds of it (V7, V21; C4, C30, C75)', () => {
    it('lists it as a marker — where it came from, its offsets and its digest, whether a turn of it runs — and none of its text or its items', () => {
      accept('t1');
      ask('at1', 'Explain this passage.');
      chat.add(ASIDE, 'at1', answer('It lists the two tides.'));
      const answered = read();
      expect(texts(answered)).toEqual(['a prompt']);
      expect(answered.turns.map((turn) => turn.id)).toEqual(['t1']);
      expect(answered.asides).toEqual([{
        id: ASIDE, title: 'A title', createdAt: 30, running: true,
        source: { kind: 'message', itemId: 'answer-0', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 5 }, range: { start: 12, end: 52 }, digest: '0badc0de' },
      }]);
      // The whole read holds no word of the passage, the question or the answer.
      const whole = JSON.stringify(answered);
      for (const text of [EXCERPT, 'Explain this passage.', 'It lists the two tides.']) expect(whole).not.toContain(text);
      end('at1');
      expect(read().asides.map((marker) => marker.running)).toEqual([false]);
    });

    it('lists an aside asked freely with no source, each session’s own asides alone, and none while the store is refused', () => {
      chat.ensure(B, 'checked');
      accept('t1');
      accept('t1b', 'another session’s prompt', B);
      ask('at1', 'Why is the sea salty?', ASIDE, null);
      ask('bt1', 'Explain this passage.', SECOND, SOURCE, B);
      expect(read().asides).toMatchObject([{ id: ASIDE, source: null }]);
      expect(read(null, B).asides.map((marker) => marker.id)).toEqual([SECOND]);
      // What `asking` says is the runtime's: here it is never offered.
      expect(read().asking).toBe('none');
    });
  });

  describe('its own read (V6; C31, C73)', () => {
    it('answers the aside with its passage, and its newest window with its turns', () => {
      accept('t1');
      ask('at1', 'Explain this passage.');
      chat.add(ASIDE, 'at1', answer('It lists the two tides.'));
      end('at1');
      const answered = readAside();
      expect(answered).toMatchObject({ status: 'read', sessionId: A, asideId: ASIDE, older: null });
      expect(answered.aside).toEqual({ id: ASIDE, title: 'A title', source: SOURCE, createdAt: 30, running: false });
      expect(answered.items.map(itemText)).toEqual(['Explain this passage.', 'It lists the two tides.']);
      expect(answered.items.every((item) => item.conversationId === ASIDE)).toBe(true);
      expect(answered.turns).toMatchObject([{ id: 'at1', state: 'ended' }]);
    });

    it('answers the page before a cursor, and refuses a cursor it does not have', () => {
      accept('t1');
      ask('at1', 'question 0');
      for (let n = 1; n < PAGE_ENTRIES + 40; n += 1) chat.add(ASIDE, 'at1', answer(`answer ${n}`));
      const newest = readAside();
      expect(newest.items).toHaveLength(PAGE_ENTRIES);
      expect(newest.older).toBe(newest.items[0]?.id);
      const older = readAside(newest.older ?? undefined);
      expect(older.items.map(itemText)[0]).toBe('question 0');
      expect(older.items).toHaveLength(40);
      expect(older.older).toBeNull();
      expect(chat.readAside(A, ASIDE, 'no-such-item')).toEqual({ status: 'refused', reason: 'unknown-cursor' });
    });

    it('is the aside’s own session’s alone: another session’s, an unknown one and one being removed read as unknown; a session with no entry as nothing', () => {
      chat.ensure(B, 'checked');
      accept('t1');
      ask('at1', 'Explain this passage.');
      expect(chat.readAside(B, ASIDE)).toEqual({ status: 'refused', reason: 'unknown-aside' });
      expect(chat.readAside(A, SECOND)).toEqual({ status: 'refused', reason: 'unknown-aside' });
      expect(chat.readAside('55555555-5555-4555-8555-555555555555', ASIDE)).toBeNull();
      store.markRemoving([ASIDE]);
      expect(chat.readAside(A, ASIDE)).toEqual({ status: 'refused', reason: 'unknown-aside' });
      expect(read().asides).toEqual([]);
    });
  });

  describe('the same selection again (V10; C50)', () => {
    it('is found by its source, its lines and its text, and by nothing less', () => {
      accept('t1');
      ask('at1', 'Explain this passage.');
      expect(chat.findAside(A, SOURCE)).toBe(ASIDE);
      // Drawn at another place since: its offsets and digest are no part of what makes it the same.
      expect(chat.findAside(A, { ...SOURCE, range: { start: 90, end: 130 }, digest: 'ffffffff' })).toBe(ASIDE);
      expect(chat.findAside(A, { ...SOURCE, excerpt: 'It is read each morning.' })).toBeNull();
      expect(chat.findAside(A, { ...SOURCE, lines: { first: 9, last: 11 } })).toBeNull();
      expect(chat.findAside(A, { ...SOURCE, itemId: 'answer-9' })).toBeNull();
      // Another session's selection of the same words is another's.
      chat.ensure(B, 'checked');
      expect(chat.findAside(B, SOURCE)).toBeNull();
      // One being removed is found no more.
      store.markRemoving([ASIDE]);
      expect(chat.findAside(A, SOURCE)).toBeNull();
    });
  });

  describe('its earlier exchanges (V3, V4; C13, C22)', () => {
    it('are each question as it was sent with the answer it got, oldest first: one with no answer is left out, and what was said on the way is none of it', () => {
      accept('t1');
      ask('at1', 'One?');
      chat.add(ASIDE, 'at1', answer('thinking aloud', { phase: 'commentary' }));
      chat.add(ASIDE, 'at1', answer('First.'));
      end('at1');
      chat.accept(ASIDE, { turnId: 'at2', itemId: 'q-at2', text: 'Two, never answered?', at: 50, started: true });
      chat.add(ASIDE, 'at2', answer('fat-g’s notice', { kind: 'notice', role: null, phase: null, notice: 'no-answer' }));
      end('at2');
      chat.accept(ASIDE, { turnId: 'at3', itemId: 'q-at3', text: 'Three?', at: 60, started: true });
      chat.add(ASIDE, 'at3', answer('Third.'));
      end('at3');
      expect(chat.exchanges(ASIDE)).toEqual([{ question: 'One?', response: 'First.' }, { question: 'Three?', response: 'Third.' }]);
      // The question being asked now has no answer yet, and is none of them.
      chat.accept(ASIDE, { turnId: 'at4', itemId: 'q-at4', text: 'Four?', at: 70, started: true });
      expect(chat.exchanges(ASIDE)).toHaveLength(2);
      expect(chat.exchanges(SECOND)).toEqual([]);
    });
  });

  describe('its session’s entry going (C32)', () => {
    it('takes the asides’ entries with it, and leaves what the store holds until a removal deletes it', () => {
      accept('t1');
      ask('at1', 'Explain this passage.');
      expect(chat.has(ASIDE)).toBe(true);
      chat.drop(A);
      expect(chat.has(A)).toBe(false);
      expect(chat.has(ASIDE)).toBe(false);
      expect(store.aside(ASIDE)).toMatchObject({ parentId: A });
      // Listed again under its session when the session's entry returns.
      chat.ensure(A, 'checked');
      expect(read().asides.map((marker) => marker.id)).toEqual([ASIDE]);
      expect(readAside().items.map(itemText)).toEqual(['Explain this passage.']);
    });
  });

  describe('a write that fails (C19)', () => {
    it('refuses the ask when its record cannot be written, and leaves nothing: no aside, no item, no push', () => {
      accept('t1');
      const before = pushes.length;
      fault = 'all';
      expect(ask('at1', 'Explain this passage.')).toBe(false);
      fault = null;
      expect(pushes).toHaveLength(before);
      expect(store.aside(ASIDE)).toBeNull();
      expect(read().asides).toEqual([]);
    });
  });
});


describe('live nonblocking question notifications', () => {
  it('reports a newly saved card once and does not manufacture signals when reading history', () => {
    const notified = vi.fn();
    chat = createChatService({ store, log, onQuestion: notified }); chat.ensure(A, 'checked');
    accept('t1');
    const message = answer('Which file?', { questions: [{ title: 'Which file?', options: ['a', 'b'] }] });
    chat.add(A, 't1', message, true);
    const card = read().items.find((item) => item.interaction?.kind === 'question');
    expect(notified).toHaveBeenCalledExactlyOnceWith(A, card?.id);
    chat.add(A, 't1', message, true); read();
    expect(notified).toHaveBeenCalledOnce();
    const reopened = createChatService({ store, log, onQuestion: notified }); reopened.ensure(A, 'checked'); reopened.read(A, null, false);
    expect(notified).toHaveBeenCalledOnce();
  });
  it('reports a card attached to a streamed completion, and keeps failed writes silent', () => {
    const notified = vi.fn();
    chat = createChatService({ store, log, onQuestion: notified }); chat.ensure(A, 'checked'); accept('t1');
    chat.delta(A, 't1', { itemId: 'p-stream', text: 'Which ', phase: 'final' });
    chat.add(A, 't1', answer('Which file?', { providerItemId: 'p-stream', questions: [{ title: 'Which file?', options: ['a', 'b'] }] }), true);
    expect(notified).toHaveBeenCalledOnce();
    fault = 'all';
    chat.add(A, 't1', answer('Another?', { questions: [{ title: 'Another?', options: ['yes', 'no'] }] }), true);
    expect(notified).toHaveBeenCalledOnce();
  });
});


it('notifies a live nonblocking question delivered with the final end after the turn closes', () => {
  const notified = vi.fn();
  chat = createChatService({ store, log, onQuestion: notified }); chat.ensure(A, 'checked'); accept('t1');
  chat.ended(A, 't1', { outcome: 'completed', at: 30 }); chat.sessionEnded(A, 't1', 30, 'completed');
  chat.add(A, 't1', answer('Choose?', { questions: [{ title: 'Choose?', options: ['a', 'b'] }] }), true);
  expect(notified).toHaveBeenCalledOnce();
});
