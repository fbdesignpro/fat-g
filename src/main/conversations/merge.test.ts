// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16 (docs/planning/_archive/M18.md; C47–C50, C53): the history merge — first as a plan, on what the store
// is said to hold, then written to a real store: a prompt with no echo matched by its client id and
// shown once, an unknown turn placed among stored ones, nothing matched by text, time or position,
// and a second read that adds nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryActivity, HistoryMessage, HistoryTurn } from '@shared/contracts/agent-events';
import { type Held, type HeldTurn, listedTurn, orderEntries, planTurn, type TurnPlan } from './merge';
import type { ConversationStore, NewItem } from './store';
import { CONVERSATION, type Scratch, scratch } from './test-support';

const turn = (turnId: string, patch: Partial<HistoryTurn> = {}): HistoryTurn => ({ turnId, outcome: 'completed', startedAt: 1_000, endedAt: 3_000, durationMs: 1_900, ...patch });
const user = (turnId: string, itemId: string, text: string, clientId?: string): HistoryMessage => ({ role: 'user', itemId, phase: null, text, at: 1_000, turnId, ...(clientId === undefined ? {} : { clientId }) });
const reply = (turnId: string, itemId: string, text: string, phase: 'commentary' | 'final' = 'final'): HistoryMessage => ({ role: 'assistant', itemId, phase, text, at: 1_000, turnId });

function holding(turns: readonly HeldTurn[]): Held {
  return {
    byProviderTurnId: (id) => turns.find((entry) => entry.providerTurnId === id) ?? null,
    byItemId: (id) => turns.find((entry) => entry.items.some((item) => item.id === id)) ?? null,
  };
}
const heldTurn = (id: string, patch: Partial<HeldTurn> = {}): HeldTurn => ({ id, providerTurnId: null, ended: false, gap: false, reached: false, items: [], ...patch });

describe('the plan (V16; C48, C53)', () => {
  it('matches a turn by the provider’s turn id', () => {
    const held = holding([heldTurn('local-1', { providerTurnId: 'p-1', ended: true, items: [{ id: 'm1', kind: 'message', providerItemId: 'i-1', notice: null, complete: true }] })]);
    const plan = planTurn(turn('p-1'), [user('p-1', 'i-1', 'q'), reply('p-1', 'i-2', 'a')], 'full', held);
    expect(plan).toEqual({ kind: 'matched', turnId: 'local-1', providerTurnId: null, end: null, clearGap: false, notShown: false, items: [{ kind: 'add', before: null, message: reply('p-1', 'i-2', 'a') }] });
  });

  it('matches a prompt whose echo never came by its client id: the stored item gains the provider’s id and nothing is added (C53)', () => {
    // No provider turn id and no provider item id: fat-g was killed after the dispatch.
    const held = holding([heldTurn('local-1', { items: [{ id: 'client-1', kind: 'message', providerItemId: null, notice: null, complete: true }] })]);
    const plan = planTurn(turn('p-1'), [user('p-1', 'i-1', 'the provider’s copy of the prompt', 'client-1'), reply('p-1', 'i-2', 'a')], 'full', held);
    expect(plan).toMatchObject({ kind: 'matched', turnId: 'local-1', providerTurnId: 'p-1', end: turn('p-1') });
    expect(plan.kind === 'matched' ? plan.items : []).toEqual([{ kind: 'name', itemId: 'client-1', providerItemId: 'i-1' }, { kind: 'add', before: null, message: reply('p-1', 'i-2', 'a') }]);
  });

  it('makes a turn of its own of one the store lacks', () => {
    const messages = [user('p-9', 'i-1', 'asked elsewhere'), reply('p-9', 'i-2', 'answered elsewhere')];
    expect(planTurn(turn('p-9'), messages, 'full', holding([heldTurn('local-1', { providerTurnId: 'p-1' })]))).toEqual({ kind: 'new', turn: turn('p-9'), messages, notShown: false });
  });

  it('never matches by text, time or position', () => {
    // The same text, the same time and the same place in the list, under other ids.
    const held = holding([heldTurn('local-1', { providerTurnId: 'p-1', ended: true, items: [{ id: 'client-1', kind: 'message', providerItemId: 'i-1', notice: null, complete: true }, { id: 'm2', kind: 'message', providerItemId: 'i-2', notice: null, complete: true }] })]);
    const messages = [user('p-2', 'i-7', 'q', 'client-other'), reply('p-2', 'i-8', 'a')];
    expect(planTurn(turn('p-2'), messages, 'full', held).kind).toBe('new');
    // In a matched turn, a message under another item id is added, however alike it reads.
    const same = planTurn(turn('p-1'), [user('p-1', 'i-1', 'q'), reply('p-1', 'i-9', 'a')], 'full', held);
    expect(same.kind === 'matched' ? same.items : []).toEqual([{ kind: 'add', before: null, message: reply('p-1', 'i-9', 'a') }]);
  });

  it('does not take a turn that has another provider id as the client id’s turn', () => {
    const held = holding([heldTurn('local-1', { providerTurnId: 'p-1', items: [{ id: 'client-1', kind: 'message', providerItemId: null, notice: null, complete: true }] })]);
    expect(planTurn(turn('p-2'), [user('p-2', 'i-1', 'q', 'client-1')], 'full', held).kind).toBe('new');
  });

  it('adds an item the store lacks before the next one both sides hold, in the provider’s order', () => {
    const held = holding([heldTurn('local-1', { providerTurnId: 'p-1', ended: true, items: [{ id: 'm1', kind: 'message', providerItemId: 'i-1', notice: null, complete: true }, { id: 'm4', kind: 'message', providerItemId: 'i-4', notice: null, complete: true }] })]);
    const messages = [user('p-1', 'i-1', 'q'), reply('p-1', 'i-2', 'first', 'commentary'), reply('p-1', 'i-3', 'second', 'commentary'), reply('p-1', 'i-4', 'answer'), reply('p-1', 'i-5', 'after')];
    const plan = planTurn(turn('p-1'), messages, 'full', held);
    expect(plan.kind === 'matched' ? plan.items.map((item) => (item.kind === 'add' ? `${item.message.itemId} before ${String(item.before)}` : item.kind)) : []).toEqual(['i-2 before m4', 'i-3 before m4', 'i-5 before null']);
  });

  it('gives a stored turn without the provider’s end the outcome the provider gives, and leaves one that has its own', () => {
    const open = holding([heldTurn('local-1', { providerTurnId: 'p-1' })]);
    expect(planTurn(turn('p-1', { outcome: 'interrupted' }), [], 'full', open)).toMatchObject({ end: { outcome: 'interrupted' } });
    // The provider does not say how it ended: no outcome is invented.
    expect(planTurn(turn('p-1', { outcome: null }), [], 'full', open)).toMatchObject({ end: null });
    const ended = holding([heldTurn('local-1', { providerTurnId: 'p-1', ended: true })]);
    expect(planTurn(turn('p-1', { outcome: 'failed' }), [], 'full', ended)).toMatchObject({ end: null });
  });

  it('clears a gap only on a full read', () => {
    const held = holding([heldTurn('local-1', { providerTurnId: 'p-1', ended: true, gap: true })]);
    expect(planTurn(turn('p-1'), [], 'full', held)).toMatchObject({ clearGap: true });
    expect(planTurn(turn('p-1'), [], 'summary', held)).toMatchObject({ clearGap: false });
    expect(planTurn(turn('p-1'), [], 'passed-over', held)).toMatchObject({ clearGap: false });
  });

  it('puts one line in the place of a turn that was passed over, once', () => {
    expect(planTurn(turn('p-9'), [reply('p-9', 'i', 'unread')], 'passed-over', holding([]))).toEqual({ kind: 'new', turn: turn('p-9'), messages: [], notShown: true });
    const held = heldTurn('local-1', { providerTurnId: 'p-1', gap: true });
    expect(planTurn(turn('p-1'), [], 'passed-over', holding([held]))).toMatchObject({ kind: 'matched', notShown: true, items: [] });
    const noted = { ...held, items: [{ id: 'n1', kind: 'notice', providerItemId: null, notice: 'turn-not-shown', complete: true }] };
    expect(planTurn(turn('p-1'), [], 'passed-over', holding([noted]))).toMatchObject({ notShown: false });
  });

  it('reads a listed turn the store lacks, or holds unfinished or with a gap, and ends the walk at one an earlier check reached (C51)', () => {
    const held = holding([
      heldTurn('whole', { providerTurnId: 'p-whole', ended: true }),
      heldTurn('reached', { providerTurnId: 'p-reached', ended: true, reached: true }),
      heldTurn('unfinished', { providerTurnId: 'p-unfinished', reached: true }),
      heldTurn('gap', { providerTurnId: 'p-gap', ended: true, gap: true, reached: true }),
    ]);
    const verdict = (id: string) => { const { read, stop } = listedTurn(turn(id), held); return { read, stop }; };
    expect(verdict('p-unknown')).toEqual({ read: true, stop: false });
    expect(verdict('p-whole')).toEqual({ read: false, stop: false });
    expect(verdict('p-reached')).toEqual({ read: false, stop: true });
    expect(verdict('p-unfinished')).toEqual({ read: true, stop: false });
    expect(verdict('p-gap')).toEqual({ read: true, stop: false });
  });

  it('reads a turn that holds a message whose whole text never arrived, also once reached, and never ends the walk there (M19, C68)', () => {
    const items = [{ id: 'm1', kind: 'message', providerItemId: 'i-1', notice: null, complete: true }, { id: 'm2', kind: 'message', providerItemId: 'i-2', notice: null, complete: false }];
    const held = holding([
      // Finished and gapless, by the provider's own end: only the item says it is not whole.
      heldTurn('partial', { providerTurnId: 'p-partial', ended: true, items }),
      heldTurn('partial-reached', { providerTurnId: 'p-partial-reached', ended: true, reached: true, items }),
    ]);
    const verdict = (id: string) => { const { read, stop } = listedTurn(turn(id), held); return { read, stop }; };
    expect(verdict('p-partial')).toEqual({ read: true, stop: false });
    expect(verdict('p-partial-reached')).toEqual({ read: true, stop: false });
  });

  it('completes a matched message held as far as it got, and skips one held whole (M19, C68)', () => {
    const held = holding([heldTurn('local-1', { providerTurnId: 'p-1', ended: true, items: [
      { id: 'client-1', kind: 'message', providerItemId: 'i-1', notice: null, complete: true },
      { id: 'm-note', kind: 'message', providerItemId: 'i-2', notice: null, complete: true },
      { id: 'm-answer', kind: 'message', providerItemId: 'i-3', notice: null, complete: false },
    ] })]);
    const answer = reply('p-1', 'i-3', 'The whole answer.');
    const plan = planTurn(turn('p-1'), [user('p-1', 'i-1', 'q'), reply('p-1', 'i-2', 'a note', 'commentary'), answer], 'full', held);
    expect(plan).toMatchObject({ kind: 'matched', turnId: 'local-1', end: null, items: [{ kind: 'complete', itemId: 'm-answer', message: answer }] });
    // An item the history lacks gets no plan: it stays as it is.
    expect(planTurn(turn('p-1'), [user('p-1', 'i-1', 'q')], 'full', held)).toMatchObject({ kind: 'matched', items: [] });
    // And a turn passed over reads no item: nothing is completed from it.
    expect(planTurn(turn('p-1'), [], 'passed-over', held)).toMatchObject({ kind: 'matched', items: [] });
  });
});

// ── Written to a store ────────────────────────────────────────────────────────────────────────

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const NOT_SHOWN = 'A reply here was too large to show.';
const local = (store: ConversationStore, turnId: string, text: string) => store.acceptPrompt({ conversationId: CONVERSATION, turnId, itemId: `client-${turnId}`, text, at: 50, started: false });
const answer = (id: string, text: string, providerItemId: string | null): NewItem => ({ id, kind: 'message', origin: 'local', providerItemId, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 60, providerAt: null });
const shown = (store: ConversationStore) => store.newestPage(CONVERSATION).items.map((item) => `${item.role ?? item.notice}: ${item.blocks[0]?.text}`);
/** The turns in stored order, each by the provider's id where it has one. */
const order = (store: ConversationStore) => store.newestPage(CONVERSATION).turns.map((entry) => entry.providerTurnId ?? entry.id);
/** One provider page, newest first, planned on what the store holds and written. */
function merge(store: ConversationStore, page: readonly { turn: HistoryTurn; messages: readonly HistoryMessage[] }[], anchor: string | null = null) {
  const plans: TurnPlan[] = page.map((entry) => planTurn(entry.turn, entry.messages, 'full', store.held(CONVERSATION)));
  return store.mergePage(CONVERSATION, plans, anchor, NOT_SHOWN);
}

describe('the merge, written (V16; C47–C50, C53)', () => {
  it('shows a prompt whose echo never came once: its id, text and time kept, the provider’s ids gained, and a second read adds nothing', () => {
    const store = area.open();
    local(store, 't1', 'What is the cat’s name?');
    const page = [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'What is the cat’s name? (as the provider kept it)', 'client-t1'), reply('p-1', 'i-2', 'Miso.')] }];
    expect(merge(store, page)).toEqual({ anchor: 't1', changed: true });
    expect(shown(store)).toEqual(['user: What is the cat’s name?', 'assistant: Miso.']);
    const [prompt, imported] = store.newestPage(CONVERSATION).items;
    expect(prompt).toMatchObject({ id: 'client-t1', origin: 'local', providerItemId: 'i-1', time: { receivedAt: 50, providerAt: null } });
    expect(imported).toMatchObject({ origin: 'provider', providerItemId: 'i-2', time: { receivedAt: null, providerAt: 1_000 } });
    // The turn gained the provider's id, its outcome and its times: none from the local clock.
    expect(store.turn(CONVERSATION, 't1')).toMatchObject({ providerTurnId: 'p-1', providerOutcome: 'completed', providerStartedAt: 1_000, providerEndedAt: 3_000, providerDurationMs: 1_900, endReceivedAt: null });
    expect(merge(store, page)).toEqual({ anchor: 't1', changed: false });
    expect(shown(store)).toHaveLength(2);
  });

  it('places a turn the store lacks between stored ones, and after a store-only one (C49)', () => {
    const store = area.open();
    local(store, 'a', 'first of fat-g’s own');
    store.providerTook(CONVERSATION, 'a', 'p-a');
    local(store, 'only', 'a turn the provider never had');
    local(store, 'c', 'second of fat-g’s own');
    store.providerTook(CONVERSATION, 'c', 'p-c');
    // The provider's history, newest first: p-c, then one made in its own app, then p-a.
    const result = merge(store, [
      { turn: turn('p-c'), messages: [] },
      { turn: turn('p-elsewhere'), messages: [user('p-elsewhere', 'e-1', 'asked in the provider’s app'), reply('p-elsewhere', 'e-2', 'answered there')] },
      { turn: turn('p-a'), messages: [] },
    ]);
    expect(result.changed).toBe(true);
    expect(order(store)).toEqual(['p-a', 'only', 'p-elsewhere', 'p-c']);
    expect(shown(store)).toEqual(['user: first of fat-g’s own', 'user: a turn the provider never had', 'user: asked in the provider’s app', 'assistant: answered there', 'user: second of fat-g’s own']);
    expect(store.newestPage(CONVERSATION).turns.find((entry) => entry.providerTurnId === 'p-elsewhere')).toMatchObject({ origin: 'provider', acceptedAt: null, providerOutcome: 'completed', reached: false });
  });

  it('places a turn newer than every stored one last, and carries the anchor to the next older page', () => {
    const store = area.open();
    local(store, 'a', 'fat-g’s own');
    store.providerTook(CONVERSATION, 'a', 'p-a');
    const newest = merge(store, [{ turn: turn('p-new'), messages: [user('p-new', 'n-1', 'newest, made elsewhere')] }]);
    expect(order(store)).toEqual(['p-a', 'p-new']);
    // The next page is older than the anchor: its unknown turn goes directly before it.
    merge(store, [{ turn: turn('p-mid'), messages: [user('p-mid', 'm-1', 'between')] }, { turn: turn('p-a'), messages: [] }, { turn: turn('p-old'), messages: [user('p-old', 'o-1', 'oldest')] }], newest.anchor);
    expect(order(store)).toEqual(['p-old', 'p-a', 'p-mid', 'p-new']);
  });

  it('adds what a matched turn lacked, in the provider’s order, and loses nothing it held', () => {
    const store = area.open();
    local(store, 't1', 'q');
    store.providerTook(CONVERSATION, 't1', 'p-1');
    store.setProviderItemId(CONVERSATION, 'client-t1', 'i-1');
    store.addItem(CONVERSATION, 't1', answer('kept-answer', 'the answer, as fat-g recorded it', 'i-4'));
    store.addItem(CONVERSATION, 't1', { ...answer('kept-notice', 'Example reported an error, and the reply ended.', null), kind: 'notice', role: null, phase: null, notice: 'turn-failed', detail: 'local detail' });
    merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'q'), reply('p-1', 'i-2', 'looking', 'commentary'), reply('p-1', 'i-3', 'still looking', 'commentary'), reply('p-1', 'i-4', 'the answer, as the provider kept it')] }]);
    expect(shown(store)).toEqual(['user: q', 'assistant: looking', 'assistant: still looking', 'assistant: the answer, as fat-g recorded it', 'turn-failed: Example reported an error, and the reply ended.']);
    // The local detail the provider never had is still there.
    expect(store.newestPage(CONVERSATION).items.at(-1)?.detail).toBe('local detail');
  });

  it('keeps a cursor through an import that moves places (C20)', () => {
    const store = area.open();
    for (const id of ['a', 'b', 'c']) { local(store, id, `prompt ${id}`); store.providerTook(CONVERSATION, id, `p-${id}`); }
    const before = store.pageBefore(CONVERSATION, 'client-c');
    expect(before?.items.map((item) => item.id)).toEqual(['client-a', 'client-b']);
    merge(store, [{ turn: turn('p-c'), messages: [] }, { turn: turn('p-x'), messages: [user('p-x', 'x-1', 'imported')] }, { turn: turn('p-b'), messages: [] }]);
    // The same cursor, after the turns moved: what is before it now includes the import.
    expect(store.pageBefore(CONVERSATION, 'client-c')?.items.map((item) => item.blocks[0]?.text)).toEqual(['prompt a', 'prompt b', 'imported']);
    expect(store.window(CONVERSATION, 'client-b', 'newest')?.items.map((item) => item.blocks[0]?.text)).toEqual(['prompt b', 'imported', 'prompt c']);
  });

  it('keeps imported turns through a restart, and removes them with their conversation (C50)', () => {
    const store = area.open();
    local(store, 't1', 'q');
    merge(store, [{ turn: turn('p-9'), messages: [user('p-9', 'e-1', 'made elsewhere'), reply('p-9', 'e-2', 'kept as content')] }]);
    store.close();
    const again = area.open();
    expect(shown(again)).toEqual(['user: q', 'user: made elsewhere', 'assistant: kept as content']);
    again.markRemoving([CONVERSATION]);
    again.deleteRemoving([CONVERSATION]);
    expect(area.raw((db) => db.prepare('SELECT (SELECT count(*) FROM turn) + (SELECT count(*) FROM item) AS n').get())).toEqual({ n: 0 });
  });

  it('writes a passed-over turn as one line, which a later check matches by id and does not add again', () => {
    const store = area.open();
    local(store, 't1', 'q');
    const passed = [planTurn(turn('p-big'), [], 'passed-over', store.held(CONVERSATION))];
    store.mergePage(CONVERSATION, passed, null, NOT_SHOWN);
    expect(shown(store)).toEqual(['user: q', `turn-not-shown: ${NOT_SHOWN}`]);
    const again = [planTurn(turn('p-big'), [], 'passed-over', store.held(CONVERSATION))];
    expect(store.mergePage(CONVERSATION, again, null, NOT_SHOWN).changed).toBe(false);
    expect(shown(store)).toHaveLength(2);
  });

  it('marks the turns a check saw, and the start, in one write (C61)', () => {
    const store = area.open();
    local(store, 'a', 'q');
    store.providerTook(CONVERSATION, 'a', 'p-a');
    merge(store, [{ turn: turn('p-new'), messages: [user('p-new', 'n-1', 'x')] }]);
    store.markReached(CONVERSATION, ['p-a', 'p-new'], true);
    expect(store.newestPage(CONVERSATION).turns.map((entry) => entry.reached)).toEqual([true, true]);
    expect(store.conversation(CONVERSATION)?.reachedStart).toBe(true);
  });

  it('writes a page whole, or none of it', () => {
    let fail = false;
    const store = area.open({ hook: (point) => { if (fail && point === 'merge') throw new Error('disk full'); } });
    local(store, 'a', 'q');
    fail = true;
    expect(() => merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i', 'x')] }, { turn: turn('p-2'), messages: [user('p-2', 'j', 'y')] }])).toThrow('disk full');
    expect(shown(store)).toEqual(['user: q']);
  });
});

// V27 (docs/planning/_archive/M19.md; C68): a message whose completing frame never came, under a turn the
// provider ended, is completed by the provider's own history, where the history has it.
describe('a partial message, completed from history (M19: V27; C68)', () => {
  /** A finished, gapless turn that holds a prompt, a whole note and an answer as far as it got. */
  function partialTurn(store: ConversationStore): void {
    local(store, 't1', 'q');
    store.providerTook(CONVERSATION, 't1', 'p-1');
    store.setProviderItemId(CONVERSATION, 'client-t1', 'i-1');
    store.addItem(CONVERSATION, 't1', { ...answer('m-note', 'a note', 'i-2'), phase: 'commentary' });
    store.saveProgress(CONVERSATION, store.reserveItem(CONVERSATION, 't1'), { ...answer('m-answer', 'The whole ans', 'i-3'), phase: 'commentary', cut: true });
    store.providerEnded(CONVERSATION, 't1', 'completed', 70);
  }
  const stored = (store: ConversationStore, id: string) => store.newestPage(CONVERSATION).items.find((item) => item.id === id);

  it('takes the provider’s text, phase, questions and cut flag, and keeps the item’s id, place and time; a second merge changes nothing', () => {
    const store = area.open();
    partialTurn(store);
    const before = stored(store, 'm-answer');
    expect(before).toMatchObject({ state: 'partial', phase: 'commentary', order: { turn: 1, item: 3 }, blocks: [{ text: 'The whole ans', cut: true }], time: { receivedAt: 60, providerAt: null } });
    expect(listedTurn(turn('p-1'), store.held(CONVERSATION))).toMatchObject({ read: true, stop: false });

    const whole: HistoryMessage = { ...reply('p-1', 'i-3', 'The whole answer, as the provider kept it.'), questions: [{ title: 'Pick', options: ['a'] }] };
    const page = [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'q'), reply('p-1', 'i-2', 'a note', 'commentary'), whole] }];
    expect(merge(store, page)).toEqual({ anchor: 't1', changed: true });
    expect(stored(store, 'm-answer')).toMatchObject({
      id: 'm-answer', state: 'complete', phase: 'final', origin: 'local', order: { turn: 1, item: 3 }, providerItemId: 'i-3',
      blocks: [{ text: 'The whole answer, as the provider kept it.', cut: false }], questions: [{ title: 'Pick', options: ['a'] }], time: { receivedAt: 60, providerAt: null },
    });
    // Nothing was added beside it, and the turn is whole now: a later check passes it by.
    expect(shown(store)).toEqual(['user: q', 'assistant: a note', 'assistant: The whole answer, as the provider kept it.']);
    expect(listedTurn(turn('p-1'), store.held(CONVERSATION))).toMatchObject({ read: false, stop: false });
    expect(merge(store, page)).toEqual({ anchor: 't1', changed: false });
  });

  it('leaves it partial where the history has no such item, as for an answer that was stopped', () => {
    const store = area.open();
    partialTurn(store);
    const page = [{ turn: turn('p-1', { outcome: 'interrupted' }), messages: [user('p-1', 'i-1', 'q'), reply('p-1', 'i-2', 'a note', 'commentary')] }];
    expect(merge(store, page)).toEqual({ anchor: 't1', changed: false });
    expect(stored(store, 'm-answer')).toMatchObject({ state: 'partial', blocks: [{ text: 'The whole ans', cut: true }] });
    // Still not whole: read again wherever a walk comes to it.
    expect(listedTurn(turn('p-1'), store.held(CONVERSATION))).toMatchObject({ read: true, stop: false });
  });

  it('keeps a key of the body this build does not know through the completion (M18, C38)', () => {
    const store = area.open();
    partialTurn(store);
    area.raw((db) => { db.prepare("UPDATE item SET body = json_set(body, '$.reactions', json('[\"+1\"]')) WHERE id = ?").run('m-answer'); });
    merge(store, [{ turn: turn('p-1'), messages: [reply('p-1', 'i-3', 'whole')] }]);
    expect(area.raw((db) => db.prepare("SELECT json_extract(body, '$.reactions[0]') AS reaction, json_extract(body, '$.complete') AS complete FROM item WHERE id = ?").get('m-answer'))).toEqual({ reaction: '+1', complete: 1 });
  });
});

// M20a, V6 (C19, C58): a turn's messages and activities as one list. Written to a real store in activity.test.ts.
describe('a turn’s activities, in the plan (M20a; C19, C58)', () => {
  const command = (itemId: string, order: number, status: HistoryActivity['status'] = 'completed'): HistoryActivity => ({ turnId: 'p-1', itemId, activityType: 'command', name: 'commandExecution', summary: 'ls', status, at: 1_000, order });
  const placed = (message: HistoryMessage, order: number): HistoryMessage => ({ ...message, order });

  it('puts a turn’s messages and activities in one order, by the place each names', () => {
    const entries = orderEntries([placed(user('p-1', 'i-1', 'q'), 0), placed(reply('p-1', 'i-4', 'a'), 3)], [command('c-2', 2), command('c-1', 1)]);
    expect(entries.map((entry) => (entry.kind === 'message' ? entry.message.itemId : entry.activity.itemId))).toEqual(['i-1', 'c-1', 'c-2', 'i-4']);
  });

  it('keeps messages that name no place in the order they were given, as before', () => {
    const entries = orderEntries([user('p-1', 'i-1', 'q'), reply('p-1', 'i-2', 'a'), reply('p-1', 'i-3', 'b')], []);
    expect(entries.map((entry) => (entry.kind === 'message' ? entry.message.itemId : ''))).toEqual(['i-1', 'i-2', 'i-3']);
  });

  it('hands a new turn its activities beside its messages, and none where history gave none', () => {
    const messages = [placed(user('p-9', 'i-1', 'q'), 0)];
    const held = holding([]);
    expect(planTurn(turn('p-9'), messages, 'full', held, [command('c-1', 1)])).toEqual({ kind: 'new', turn: turn('p-9'), messages, activities: [command('c-1', 1)], notShown: false });
    expect(planTurn(turn('p-9'), messages, 'full', held)).toEqual({ kind: 'new', turn: turn('p-9'), messages, notShown: false });
    // A turn that was passed over has neither.
    expect(planTurn(turn('p-9'), messages, 'passed-over', held, [command('c-1', 1)])).toEqual({ kind: 'new', turn: turn('p-9'), messages: [], notShown: true });
  });

  it('completes a stored activity whose end never came, skips one held whole, and adds one the store lacks before the next item both hold', () => {
    const held = holding([heldTurn('local-1', { providerTurnId: 'p-1', ended: true, items: [
      { id: 'm1', kind: 'message', providerItemId: 'i-1', notice: null, complete: true },
      { id: 'a1', kind: 'activity', providerItemId: 'c-1', notice: null, complete: false },
      { id: 'a2', kind: 'activity', providerItemId: 'c-2', notice: null, complete: true },
      { id: 'm2', kind: 'message', providerItemId: 'i-9', notice: null, complete: true },
    ] })]);
    const plan = planTurn(turn('p-1'), [placed(user('p-1', 'i-1', 'q'), 0), placed(reply('p-1', 'i-9', 'a'), 9)], 'full', held, [command('c-0', 1), command('c-1', 2), command('c-2', 3), command('c-3', 4)]);
    expect(plan.kind === 'matched' ? plan.items : []).toEqual([
      { kind: 'add-activity', before: 'a1', activity: command('c-0', 1) },
      { kind: 'complete-activity', itemId: 'a1', activity: command('c-1', 2) },
      { kind: 'add-activity', before: 'm2', activity: command('c-3', 4) },
    ]);
  });

  it('completes nothing from a history that says the activity is unfinished too', () => {
    const held = holding([heldTurn('local-1', { providerTurnId: 'p-1', ended: true, items: [{ id: 'a1', kind: 'activity', providerItemId: 'c-1', notice: null, complete: false }] })]);
    const plan = planTurn(turn('p-1'), [], 'full', held, [command('c-1', 1, 'unfinished')]);
    expect(plan.kind === 'matched' ? plan.items : ['x']).toEqual([]);
    // And the turn is read again at the next check: it is still not whole.
    expect(listedTurn(turn('p-1'), held)).toMatchObject({ read: true, stop: false });
  });
});
