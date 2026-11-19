// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V7, V24, V33, V34 (docs/planning/_archive/M21.md; C26, C28, C32, C33, C36, C41, C61, C62, C68, C77): what
// the store keeps of a question the session asks, on a real file — an item of kind `interaction`
// written at its raising, each outcome an update of named keys under the outcome it expects, an
// async card written with its message and answered with its prompt, the pass of the open cards, the
// mark at the answering turn's acknowledgement, what the history check makes, and a removal that
// leaves no text.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryMessage, HistoryTurn } from '@shared/contracts/agent-events';
import { type ConversationItem, entriesOf, itemUnits } from '@shared/contracts/conversation';
import { type InteractionQuestion, raisedPlan } from '@shared/contracts/interaction';
import { STORE_FILE } from './format';
import { planTurn, type TurnPlan } from './merge';
import { type ConversationStore, type NewInteraction, type NewItem, StorageFailure } from './store';
import { CONVERSATION, OTHER, type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const QUESTION: InteractionQuestion = { text: 'Which file should I read?', header: 'File', options: [{ label: 'notes-1.txt', description: 'The first note' }, { label: 'notes-2.txt', description: null }], multiple: false, freeText: true, secret: false };
let made = 0;
function asked(providerItemId: string, patch: Partial<NewInteraction> = {}): NewInteraction {
  made += 1;
  return { id: `card-${made}`, origin: 'local', providerItemId, workerId: null, mode: 'blocking', questions: [QUESTION], cut: false, receivedAt: 20, providerAt: null, ...patch };
}
const answer = (id: string, text: string, providerItemId: string | null, patch: Partial<NewItem> = {}): NewItem => ({ id, kind: 'message', origin: 'local', providerItemId, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 15, providerAt: null, ...patch });
const accept = (store: ConversationStore, turnId: string, text = 'a prompt', conversationId = CONVERSATION) => store.acceptPrompt({ conversationId, turnId, itemId: `prompt-${turnId}`, text, at: 5, started: false });
/** A row's body as it is on disk: what the store's own reads make of it is another matter. */
const rawBody = (id: string): Record<string, unknown> => area.raw((db) => JSON.parse(String((db.prepare('SELECT body FROM item WHERE id = ?').get(id) as { body: string }).body)) as Record<string, unknown>);
const rawInteraction = (id: string): Record<string, unknown> => rawBody(id)['interaction'] as Record<string, unknown>;
const rows = (): number => area.raw((db) => Number((db.prepare('SELECT count(*) AS n FROM item').get() as { n: number }).n));
const outcomes = (store: ConversationStore): string[] => store.newestPage(CONVERSATION).items.flatMap((item) => (item.interaction === null ? [] : [`${item.id}: ${item.interaction.outcome}`]));
const TITLES = [{ title: 'Which file do you want me to read?', options: ['notes-1.txt', 'notes-2.txt'] }];

describe('the format, version 5 (V7; S5, C32)', () => {
  it('holds a question under a key of its own in an item of kind interaction, and reads it back whole', () => {
    const store = area.open();
    accept(store, 't1');
    const stored = store.addInteraction(CONVERSATION, 't1', asked('toolu_1', { cut: true }));
    expect(stored?.item).toMatchObject({ kind: 'interaction', turnId: 't1', providerItemId: 'toolu_1', workerId: null, origin: 'local', role: null, blocks: [], questions: [], activity: null, state: 'complete', time: { receivedAt: 20, providerAt: null } });
    expect(stored?.item.interaction).toMatchObject({ mode: 'blocking', questions: [QUESTION], answers: null, settledAt: null, confirmedAt: null, answeredBy: null, withdrawnBy: null, cut: true });
    // On disk: its fields under their own key, and no column of its own.
    expect(Object.keys(rawBody(stored?.item.id ?? ''))).toEqual(['interaction']);
    expect(rawInteraction(stored?.item.id ?? '')).toMatchObject({ mode: 'blocking', outcome: 'pending', questions: [QUESTION] });
    store.close();
    expect(area.open().newestPage(CONVERSATION).items.at(-1)?.interaction).toMatchObject({ kind: 'question', questions: [QUESTION] });
  });

  it('is an entry of its own, counted by its questions’ and its answers’ texts (C36)', () => {
    const store = area.open();
    accept(store, 't1');
    store.addInteraction(CONVERSATION, 't1', asked('toolu_1'));
    store.addInteraction(CONVERSATION, 't1', asked('toolu_2'));
    const items = store.newestPage(CONVERSATION).items;
    expect(entriesOf(items).map((entry) => entry.length)).toEqual([1, 1, 1]);
    const card = items[1] as ConversationItem;
    expect(itemUnits(card)).toBe('Which file should I read?'.length + 'File'.length + 'notes-1.txt'.length + 'The first note'.length + 'notes-2.txt'.length);
    store.setInteraction(CONVERSATION, card.id, 'pending', { outcome: 'answered', answers: [{ options: [0], text: 'and the second', secret: false }], settledAt: 30 });
    expect(itemUnits(store.item(CONVERSATION, card.id)?.item as ConversationItem)).toBe(itemUnits(card) + 'and the second'.length);
  });
});

describe('a question, as it is written (V7; C6, C33, C61)', () => {
  it('reads dropped from the store while its outcome is not stored: the store knows no request that lives (C61)', () => {
    const store = area.open();
    accept(store, 't1');
    const stored = store.addInteraction(CONVERSATION, 't1', asked('toolu_1'));
    expect(stored?.item.interaction?.outcome).toBe('dropped');
    expect(rawInteraction(stored?.item.id ?? '')['outcome']).toBe('pending');
    // After a kill or a crash, where no end ran, the card comes back inert.
    store.close();
    expect(outcomes(area.open())).toEqual([`${stored?.item.id}: dropped`]);
  });

  it('stands once for its source and its owner, and collides with no message of the same id (C6, C28)', () => {
    const store = area.open();
    accept(store, 't1');
    expect(store.addItem(CONVERSATION, 't1', answer('m-1', 'Which one?', 'item-1'))?.interaction).toBeNull();
    expect(store.addInteraction(CONVERSATION, 't1', asked('item-1'))).not.toBeNull();
    expect(store.addInteraction(CONVERSATION, 't1', asked('item-1'))).toBeNull();
    // A worker's under the same id is another question.
    expect(store.addInteraction(CONVERSATION, 't1', asked('item-1', { workerId: 'worker-1' }))).not.toBeNull();
    expect(rows()).toBe(4);
    expect(() => store.addInteraction(CONVERSATION, 'no-such-turn', asked('item-2'))).toThrow(StorageFailure);
  });

  it('keeps a worker’s question with the worker’s items, and out of the session’s pages', () => {
    const store = area.open();
    accept(store, 't1');
    const stored = store.addInteraction(CONVERSATION, 't1', asked('toolu_w', { workerId: 'worker-1' }));
    expect(store.newestPage(CONVERSATION).items.map((item) => item.kind)).toEqual(['message']);
    expect(store.workerItems(CONVERSATION, 'worker-1')?.items.map((item) => item.id)).toEqual([stored?.item.id]);
  });

  it('writes each outcome by its named keys, and keeps whatever else the body holds (M18, C38)', () => {
    const store = area.open();
    accept(store, 't1');
    const id = store.addInteraction(CONVERSATION, 't1', asked('toolu_1'))?.item.id ?? '';
    area.raw((db) => db.prepare("UPDATE item SET body = json_set(body, '$.interaction.later', 'a key of a later version', '$.alsoLater', 7) WHERE id = ?").run(id));
    const answered = store.setInteraction(CONVERSATION, id, 'pending', { outcome: 'answered', answers: [{ options: [1], text: null, secret: false }], settledAt: 30 });
    expect(answered?.item.interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: null, secret: false }], settledAt: 30, confirmedAt: null });
    expect(store.setInteraction(CONVERSATION, id, 'answered', { confirmedAt: 31 })?.item.interaction).toMatchObject({ outcome: 'answered', confirmedAt: 31 });
    expect(rawInteraction(id)).toMatchObject({ later: 'a key of a later version', questions: [QUESTION], mode: 'blocking' });
    expect(rawBody(id)['alsoLater']).toBe(7);
  });

  it('changes no row whose outcome is not the one it expects (V33; C77)', () => {
    const store = area.open();
    accept(store, 't1');
    const id = store.addInteraction(CONVERSATION, 't1', asked('toolu_1'))?.item.id ?? '';
    // A blocking answer's write finds its row pending, or changes nothing.
    expect(store.setInteraction(CONVERSATION, id, 'open', { outcome: 'dismissed', settledAt: 30 })).toBeNull();
    expect(store.setInteraction(CONVERSATION, id, 'pending', { outcome: 'withdrawn', withdrawnBy: 'request', settledAt: 30 })?.item.interaction).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'request' });
    for (const from of ['pending', 'open', 'answered'] as const) expect(store.setInteraction(CONVERSATION, id, from, { outcome: 'answered', answers: [], settledAt: 99 }), from).toBeNull();
    expect(rawInteraction(id)).toMatchObject({ outcome: 'withdrawn', settledAt: 30, answers: null });
    // Another conversation's item, and one that is no interaction, are never touched.
    expect(store.setInteraction(OTHER, id, 'withdrawn', { outcome: 'dropped' })).toBeNull();
    expect(store.setInteraction(CONVERSATION, 'prompt-t1', 'pending', { outcome: 'dropped' })).toBeNull();
  });

  it('settles the pending ones an end names in one write, and leaves the settled as they are (C12, C33)', () => {
    const store = area.open();
    accept(store, 't1');
    const [first, second, third] = ['toolu_1', 'toolu_2', 'toolu_3'].map((source) => store.addInteraction(CONVERSATION, 't1', asked(source))?.item.id ?? '');
    store.setInteraction(CONVERSATION, second ?? '', 'pending', { outcome: 'answered', answers: [], settledAt: 25 });
    const settled = store.settlePending(CONVERSATION, [first ?? '', second ?? '', third ?? ''], { outcome: 'withdrawn', withdrawnBy: 'turn', settledAt: 40 });
    expect(settled.map((stored) => stored.item.id)).toEqual([first, third]);
    expect(outcomes(store)).toEqual([`${first}: withdrawn`, `${second}: answered`, `${third}: withdrawn`]);
    expect(store.settlePending(CONVERSATION, [], { outcome: 'dropped' })).toEqual([]);
    // One transaction: a failure writes none of them.
    const failing = area.open({ hook: (point) => { if (point === 'interactions-settled') throw new Error('disk'); } });
    accept(failing, 't2');
    const [fourth, fifth] = ['toolu_4', 'toolu_5'].map((source) => failing.addInteraction(CONVERSATION, 't2', asked(source))?.item.id ?? '');
    expect(() => failing.settlePending(CONVERSATION, [fourth ?? '', fifth ?? ''], { outcome: 'dropped', settledAt: 50 })).toThrow('disk');
    expect([rawInteraction(fourth ?? '')['outcome'], rawInteraction(fifth ?? '')['outcome']]).toEqual(['pending', 'pending']);
  });
});

describe('a turn’s answer, as a review reads it (M22e, V3; C43, C49)', () => {
  const card = (providerItemId: string): NewInteraction => asked(providerItemId, { mode: 'async', questions: [{ ...QUESTION, header: null }] });

  it('is the turn’s last `final` message of the session’s own, a commentary and a worker’s passed over, by fat-g’s id', () => {
    const store = area.open();
    accept(store, 't1');
    store.addItem(CONVERSATION, 't1', answer('m-1', 'I will read the files first.', 'item-1', { phase: 'commentary' }));
    store.addItem(CONVERSATION, 't1', answer('m-2', 'The answer.', 'item-2'));
    store.addItem(CONVERSATION, 't1', answer('m-3', 'A worker’s answer.', 'item-3', { workerId: 'worker-1' }));
    expect(store.turnAnswer(CONVERSATION, 't1')).toEqual({ answer: { itemId: 'm-2', text: 'The answer.', cut: false }, card: null });
    expect(store.turnAnswer(CONVERSATION, 'no-such-turn')).toBeNull();
  });

  it('is the message Claude’s end names, labelled final by that end’s own write, and none for a turn without one', () => {
    const store = area.open();
    accept(store, 't1');
    store.addItem(CONVERSATION, 't1', answer('m-1', 'The answer.', 'msg_1', { phase: null }));
    expect(store.turnAnswer(CONVERSATION, 't1')?.answer).toBeNull();
    store.providerEnded(CONVERSATION, 't1', 'completed', 30, 'msg_1');
    expect(store.turnAnswer(CONVERSATION, 't1')?.answer?.itemId).toBe('m-1');
  });

  it('names the open card the turn asks on, and none once it is answered, dismissed or passed', () => {
    const store = area.open();
    accept(store, 't1');
    const stored = store.addItem(CONVERSATION, 't1', answer('m-1', 'One question before I review.', 'item-1', { questions: TITLES }), card('item-1'));
    const cardId = stored?.interaction?.id ?? '';
    expect(store.turnAnswer(CONVERSATION, 't1')).toEqual({ answer: { itemId: 'm-1', text: 'One question before I review.', cut: false }, card: cardId });
    accept(store, 't2');
    expect(store.turnAnswer(CONVERSATION, 't1')?.card).toBeNull();
  });
});

describe('an async question and its message (V7; C33)', () => {
  const card = (providerItemId: string): NewInteraction => asked(providerItemId, { mode: 'async', questions: [{ ...QUESTION, header: null }] });

  it('are one transaction: the card directly after its message, open', () => {
    const store = area.open();
    accept(store, 't1');
    const stored = store.addItem(CONVERSATION, 't1', answer('m-1', 'One question before I read.', 'item-1', { questions: TITLES }), card('item-1'));
    expect(stored?.interaction).toMatchObject({ kind: 'interaction', providerItemId: 'item-1', order: { turn: 1, item: 3 } });
    expect(stored?.interaction?.interaction).toMatchObject({ mode: 'async', outcome: 'open' });
    expect(store.newestPage(CONVERSATION).items.map((item) => item.kind)).toEqual(['message', 'message', 'interaction']);
    // The message keeps its questions as the conversation text they are (C6).
    expect(stored?.item.questions).toEqual(TITLES);
  });

  it('writes neither where the write fails', () => {
    const store = area.open({ hook: (point) => { if (point === 'item' || point === 'complete') throw new Error('disk'); } });
    accept(store, 't1');
    expect(() => store.addItem(CONVERSATION, 't1', answer('m-1', 'One question.', 'item-1', { questions: TITLES }), card('item-1'))).toThrow('disk');
    const place = store.reserveItem(CONVERSATION, 't1');
    expect(() => store.completeItem(CONVERSATION, place, answer('m-2', 'Another.', 'item-2', { questions: TITLES }), card('item-2'))).toThrow('disk');
    expect(rows()).toBe(1);
  });

  it('are one transaction at a message’s completion too, the card after every place kept for an item not written yet', () => {
    const store = area.open();
    accept(store, 't1');
    const place = store.reserveItem(CONVERSATION, 't1');
    store.saveProgress(CONVERSATION, place, answer('m-1', 'One quest', 'item-1', { complete: false }));
    const later = store.reserveItem(CONVERSATION, 't1');
    const stored = store.completeItem(CONVERSATION, place, answer('m-1', 'One question before I read.', 'item-1', { questions: TITLES }), card('item-1'));
    expect(stored.item).toMatchObject({ id: 'm-1', state: 'complete', questions: TITLES });
    expect(stored.interaction?.order.item).toBe(later.order.item + 1);
    // Once for its message: a second completion makes no second card.
    expect(store.completeItem(CONVERSATION, place, answer('m-1', 'One question before I read.', 'item-1', { questions: TITLES }), card('item-1')).interaction).toBeNull();
  });
});

// Decision 0026, item 11: a card the model went on past is passed at its turn's end.
describe('an async card its model went on past', () => {
  const card = (providerItemId: string): NewInteraction => asked(providerItemId, { mode: 'async', questions: [{ ...QUESTION, header: null }] });
  function withCard(store: ConversationStore): string {
    accept(store, 't1');
    return store.addItem(CONVERSATION, 't1', answer('m-1', 'Which file do you want me to read?\n- notes-1.txt\n- notes-2.txt', 'item-1', { questions: TITLES, phase: 'commentary' }), card('item-1'))?.interaction?.id ?? '';
  }

  it('is passed where the model wrote a message after it in its turn, and read back so', () => {
    const store = area.open({ now: () => 77 });
    const id = withCard(store);
    store.addItem(CONVERSATION, 't1', answer('m-2', 'Only the report was added.', 'item-2'));
    const passed = store.passGonePast(CONVERSATION, 't1', 70);
    expect(passed.map((stored) => stored.item.id)).toEqual([id]);
    expect(passed[0]?.item.interaction).toMatchObject({ outcome: 'passed', settledAt: 70 });
    expect(outcomes(store)).toEqual([`${id}: passed`]);
    // Once: a second end passes nothing more.
    expect(store.passGonePast(CONVERSATION, 't1', 80)).toEqual([]);
    store.close();
    expect(outcomes(area.open())).toEqual([`${id}: passed`]);
  });

  it('stays open where it is the turn’s last word: an empty message, a worker’s or an activity after it says nothing', () => {
    const store = area.open();
    const id = withCard(store);
    store.addItem(CONVERSATION, 't1', answer('m-2', 'A worker’s report.', 'item-2', { workerId: 'worker-1' }));
    store.addActivity(CONVERSATION, 't1', { id: 'activity-1', origin: 'local', providerItemId: 'cmd-1', workerId: null, start: { type: 'command', name: 'commandExecution', summary: 'rg --files', input: 'rg --files', files: [] }, receivedAt: 30, providerAt: null });
    store.reserveItem(CONVERSATION, 't1');
    expect(store.passGonePast(CONVERSATION, 't1', 70)).toEqual([]);
    expect(outcomes(store)).toEqual([`${id}: open`]);
  });

  it('is passed where a plan’s line follows it in its turn', () => {
    const store = area.open();
    const id = withCard(store);
    store.addPlan(CONVERSATION, 't1', { id: 'line-1', providerItemId: 'plan-1', body: raisedPlan({ planId: 'a1b2c3d4-0000-4000-8000-000000000001', version: 1, came: 'made', request: false }), receivedAt: 30 });
    expect(store.passGonePast(CONVERSATION, 't1', 70).map((stored) => stored.item.id)).toEqual([id]);
  });

  it('leaves another turn’s card, a blocking one and one settled already as they are', () => {
    const store = area.open();
    const id = withCard(store);
    store.addItem(CONVERSATION, 't1', answer('m-2', 'The answer.', 'item-2'));
    expect(store.passGonePast(CONVERSATION, 't2', 70)).toEqual([]);
    store.setInteraction(CONVERSATION, id, 'open', { outcome: 'dismissed', settledAt: 60 });
    const blocking = store.addInteraction(CONVERSATION, 't1', asked('toolu_1'))?.item.id ?? '';
    store.addItem(CONVERSATION, 't1', answer('m-3', 'More.', 'item-3'));
    expect(store.passGonePast(CONVERSATION, 't1', 70)).toEqual([]);
    expect(outcomes(store)).toEqual([`${id}: dismissed`, `${blocking}: dropped`]);
    // A blocking card reads dropped from the store; on disk it still waits on its request.
    expect(rawInteraction(blocking)['outcome']).toBe('pending');
  });
});

describe('an async answer and its prompt (V7, V24, V33; C26, C41, C68, C77)', () => {
  function withCards(store: ConversationStore): { first: string; second: string } {
    accept(store, 't1');
    const first = store.addItem(CONVERSATION, 't1', answer('m-1', 'One question.', 'item-1', { questions: TITLES }), asked('item-1', { mode: 'async' }))?.interaction?.id ?? '';
    const second = store.addItem(CONVERSATION, 't1', answer('m-2', 'And another.', 'item-2', { questions: TITLES }), asked('item-2', { mode: 'async' }))?.interaction?.id ?? '';
    return { first, second };
  }
  const kept = [{ options: [1], text: null, secret: false }];

  it('are one transaction: the prompt’s record, the card answered by the turn the prompt starts, and the other open cards passed', () => {
    const store = area.open();
    const { first, second } = withCards(store);
    const accepted = store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't2', itemId: 'prompt-t2', text: 'Which file do you want me to read?\nnotes-2.txt', at: 50, started: false, answering: { itemId: first, answers: kept } });
    expect(accepted.passed).toEqual([second]);
    expect(store.item(CONVERSATION, first)?.item.interaction).toMatchObject({ outcome: 'answered', answers: kept, settledAt: 50, answeredBy: 't2', confirmedAt: null });
    expect(store.item(CONVERSATION, second)?.item.interaction).toMatchObject({ outcome: 'passed', settledAt: 50, answers: null });
    expect(accepted.item).toMatchObject({ id: 'prompt-t2', role: 'user', turnId: 't2' });
  });

  it('writes nothing of the three where the write fails', () => {
    const store = area.open({ hook: (point) => { if (point === 'accept' && rows() > 3) throw new Error('disk'); } });
    const { first, second } = withCards(store);
    expect(() => store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't2', itemId: 'prompt-t2', text: 'an answer', at: 50, started: false, answering: { itemId: first, answers: kept } })).toThrow('disk');
    expect([rawInteraction(first)['outcome'], rawInteraction(second)['outcome']]).toEqual(['open', 'open']);
    expect(store.turn(CONVERSATION, 't2')).toBeNull();
  });

  it.each(['dismissed', 'passed', 'answered'] as const)('refuses a card %s meanwhile as not open, with nothing written and that outcome standing (C77)', (outcome) => {
    const store = area.open();
    const { first, second } = withCards(store);
    store.setInteraction(CONVERSATION, first, 'open', { outcome, settledAt: 40 });
    const before = rows();
    const refused = (() => { try { store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't2', itemId: 'prompt-t2', text: 'an answer', at: 50, started: false, answering: { itemId: first, answers: kept } }); return null; } catch (error) { return error; } })();
    expect(refused).toBeInstanceOf(StorageFailure);
    expect((refused as StorageFailure).kind).toBe('not-open');
    expect(rows()).toBe(before);
    expect(store.turn(CONVERSATION, 't2')).toBeNull();
    expect(rawInteraction(first)).toMatchObject({ outcome, settledAt: 40, answeredBy: null });
    // The other card was not passed by a prompt that was never recorded.
    expect(rawInteraction(second)['outcome']).toBe('open');
  });

  it('refuses an answer to a blocking card, to another conversation’s card and to what is no card', () => {
    const store = area.open();
    accept(store, 't1');
    const blocking = store.addInteraction(CONVERSATION, 't1', asked('toolu_1'))?.item.id ?? '';
    accept(store, 'o1', 'elsewhere', OTHER);
    const elsewhere = store.addItem(OTHER, 'o1', answer('m-o', 'One question.', 'item-o', { questions: TITLES }), asked('item-o', { mode: 'async' }))?.interaction?.id ?? '';
    for (const itemId of [blocking, elsewhere, 'prompt-t1', 'no-such-item']) {
      expect(() => store.acceptPrompt({ conversationId: CONVERSATION, turnId: `t-${itemId}`, itemId: `p-${itemId}`, text: 'x', at: 50, started: false, answering: { itemId, answers: kept } }), itemId).toThrow('not-open');
    }
    expect(rawInteraction(elsewhere)['outcome']).toBe('open');
  });

  it('passes every open card at any prompt’s acceptance: the model has moved on with the newer message (C41)', () => {
    const store = area.open();
    const { first, second } = withCards(store);
    store.setInteraction(CONVERSATION, second, 'open', { outcome: 'dismissed', settledAt: 40 });
    const blocking = store.addInteraction(CONVERSATION, 't1', asked('toolu_1'))?.item.id ?? '';
    expect(accept(store, 't2', 'something else').passed).toEqual([first]);
    expect(outcomes(store)).toEqual([`${first}: passed`, `${second}: dismissed`, `${blocking}: dropped`]);
    // A settled card keeps its outcome, and a pending one is no card a prompt goes by.
    expect(rawInteraction(blocking)['outcome']).toBe('pending');
    expect(accept(store, 't3').passed).toEqual([]);
  });

  it('marks the answered card when the provider takes the prompt that answered it, once (C68)', () => {
    const store = area.open({ now: () => 77 });
    const { first, second } = withCards(store);
    store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't2', itemId: 'prompt-t2', text: 'an answer', at: 50, started: false, answering: { itemId: first, answers: kept } });
    // Another turn's acknowledgement marks nothing.
    expect(store.providerTook(CONVERSATION, 't1', 'p-1')).toBeNull();
    expect(store.item(CONVERSATION, first)?.item.interaction?.confirmedAt).toBeNull();
    expect(store.providerTook(CONVERSATION, 't2', 'p-2')).toBe(first);
    expect(store.item(CONVERSATION, first)?.item.interaction).toMatchObject({ outcome: 'answered', confirmedAt: 77, answeredBy: 't2' });
    expect(store.turn(CONVERSATION, 't2')).toMatchObject({ providerTook: true, providerTurnId: 'p-2' });
    expect(store.providerTook(CONVERSATION, 't2', 'p-2')).toBeNull();
    expect(store.item(CONVERSATION, second)?.item.interaction).toMatchObject({ outcome: 'passed', confirmedAt: null });
  });

  it('leaves an answer the provider never acknowledged answered and unmarked, after a restart too (V24)', () => {
    const store = area.open();
    const { first } = withCards(store);
    store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't2', itemId: 'prompt-t2', text: 'an answer', at: 50, started: false, answering: { itemId: first, answers: kept } });
    store.close();
    const again = area.open();
    expect(again.item(CONVERSATION, first)?.item.interaction).toMatchObject({ outcome: 'answered', confirmedAt: null, answeredBy: 't2' });
    expect(again.turn(CONVERSATION, 't2')).toMatchObject({ providerTook: false, providerOutcome: null });
  });
});

// ── The history check (C28, C41) ──────────────────────────────────────────────────────────────

const turn = (turnId: string): HistoryTurn => ({ turnId, outcome: 'completed', startedAt: 1_000, endedAt: 3_000, durationMs: 1_900 });
const user = (turnId: string, itemId: string, text: string, clientId?: string): HistoryMessage => ({ role: 'user', turnId, itemId, phase: null, text, at: 1_000, ...(clientId === undefined ? {} : { clientId }) });
const asking = (turnId: string, itemId: string, text = 'One question before I read.'): HistoryMessage => ({ role: 'assistant', turnId, itemId, phase: 'final', text, at: 1_000, questions: TITLES });
function merge(store: ConversationStore, page: readonly { turn: HistoryTurn; messages: readonly HistoryMessage[] }[], cards = true, anchor: string | null = null) {
  const plans: TurnPlan[] = page.map((entry) => planTurn(entry.turn, entry.messages, 'full', store.held(CONVERSATION)));
  return store.mergePage(CONVERSATION, plans, anchor, 'A reply here was too large to show.', cards);
}
const kinds = (store: ConversationStore): string[] => store.newestPage(CONVERSATION).items.map((item) => (item.interaction === null ? `${item.role}` : `card ${item.interaction.outcome}`));

describe('what the history check makes of a message with questions (V7, V34; C28, C41)', () => {
  it('makes an open card after the message of a turn placed last, and a second read changes nothing', () => {
    const store = area.open();
    store.ensure(CONVERSATION, 1);
    const page = [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.'), asking('p-1', 'i-2')] }];
    expect(merge(store, page).changed).toBe(true);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card open']);
    const card = store.newestPage(CONVERSATION).items[2];
    expect(card).toMatchObject({ kind: 'interaction', origin: 'provider', providerItemId: 'i-2', time: { receivedAt: null, providerAt: 1_000 } });
    expect(card?.interaction).toMatchObject({ mode: 'async', questions: [{ text: 'Which file do you want me to read?', header: null, options: [{ label: 'notes-1.txt', description: null }, { label: 'notes-2.txt', description: null }], multiple: false, freeText: true, secret: false }] });
    expect(merge(store, page).changed).toBe(false);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card open']);
  });

  it('makes it passed where any turn follows it, and passes an open card when it adds a turn after one', () => {
    const store = area.open({ now: () => 88 });
    store.ensure(CONVERSATION, 1);
    // Newest first: the answering turn made in the provider's own app, then the one that asked.
    merge(store, [
      { turn: turn('p-2'), messages: [user('p-2', 'i-3', 'notes-2.txt')] },
      { turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.'), asking('p-1', 'i-2')] },
    ]);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card passed', 'user']);
    expect(store.newestPage(CONVERSATION).items[2]?.interaction).toMatchObject({ outcome: 'passed', settledAt: 88 });
  });

  it('passes a card an earlier check left open when a later check adds a turn after it, the card’s own turn not read again', () => {
    const store = area.open({ now: () => 99 });
    store.ensure(CONVERSATION, 1);
    const first = { turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.'), asking('p-1', 'i-2')] };
    merge(store, [first]);
    store.markReached(CONVERSATION, ['p-1'], true);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card open']);
    // The next check lists the newer turn, and the held one with nothing of it to write.
    const before = store.newestPage(CONVERSATION).items.slice(0, 2).map((item) => JSON.stringify(item));
    merge(store, [{ turn: turn('p-2'), messages: [user('p-2', 'i-3', 'typed in the provider’s app')] }, { turn: turn('p-1'), messages: [] }]);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card passed', 'user']);
    expect(store.newestPage(CONVERSATION).items[2]?.interaction).toMatchObject({ outcome: 'passed', settledAt: 99 });
    expect(store.newestPage(CONVERSATION).items.slice(0, 2).map((item) => JSON.stringify(item))).toEqual(before);
  });

  it('keeps a settled card’s outcome: a check that comes again makes no second card and reopens none', () => {
    const store = area.open();
    store.ensure(CONVERSATION, 1);
    const page = [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.'), asking('p-1', 'i-2')] }];
    merge(store, page);
    const id = store.newestPage(CONVERSATION).items[2]?.id ?? '';
    store.setInteraction(CONVERSATION, id, 'open', { outcome: 'dismissed', settledAt: 40 });
    // Read again with its items, as a turn with a gap is.
    store.markGap(CONVERSATION, store.newestPage(CONVERSATION).turns[0]?.id ?? '');
    merge(store, page);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card dismissed']);
    merge(store, [{ turn: turn('p-2'), messages: [user('p-2', 'i-3', 'later')] }, { turn: turn('p-1'), messages: [] }]);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card dismissed', 'user']);
  });

  it('makes none where the store holds the message with its questions already: the card it made live is all there is (M18, C51)', () => {
    const store = area.open();
    accept(store, 't1', 'Read a note.');
    store.providerTook(CONVERSATION, 't1', 'p-1');
    const live = store.addItem(CONVERSATION, 't1', answer('m-1', 'One question before I read.', 'i-2', { questions: TITLES }), asked('i-2', { mode: 'async' }));
    store.providerEnded(CONVERSATION, 't1', 'completed', 60);
    expect(merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.', 'prompt-t1'), asking('p-1', 'i-2')] }]).changed).toBe(true);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card open']);
    expect(store.newestPage(CONVERSATION).items[2]?.id).toBe(live?.interaction?.id);
    // The card shares its message's id, and is never taken for the message (C28).
    expect(store.held(CONVERSATION).byProviderTurnId('p-1')?.items.map((item) => `${item.kind} ${item.providerItemId}`)).toEqual(['message i-1', 'message i-2', 'interaction i-2']);
  });

  it('makes the card of a message it completes from a partial one: open with no turn after it (V34)', () => {
    const store = area.open();
    accept(store, 't1', 'Read a note.');
    store.providerTook(CONVERSATION, 't1', 'p-1');
    store.saveProgress(CONVERSATION, store.reserveItem(CONVERSATION, 't1'), answer('m-1', 'One quest', 'i-2', { complete: false }));
    merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.', 'prompt-t1'), asking('p-1', 'i-2')] }]);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card open']);
    expect(store.newestPage(CONVERSATION).items[1]).toMatchObject({ id: 'm-1', state: 'complete', questions: TITLES });
  });

  it('makes it passed where a later turn is stored locally and was never acknowledged: a prompt passes a card at its acceptance (V34)', () => {
    const store = area.open();
    accept(store, 't1', 'Read a note.');
    store.providerTook(CONVERSATION, 't1', 'p-1');
    store.saveProgress(CONVERSATION, store.reserveItem(CONVERSATION, 't1'), answer('m-1', 'One quest', 'i-2', { complete: false }));
    // Stored before its dispatch, and never taken: it passed no card, since none existed yet.
    accept(store, 't2', 'never acknowledged');
    expect(store.turn(CONVERSATION, 't2')?.providerTook).toBe(false);
    merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.', 'prompt-t1'), asking('p-1', 'i-2')] }]);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card passed', 'user']);
  });

  it('makes a card directly after a message it adds to a turn the store holds, before the items that follow it', () => {
    const store = area.open();
    accept(store, 't1', 'Read a note.');
    store.providerTook(CONVERSATION, 't1', 'p-1');
    store.addItem(CONVERSATION, 't1', answer('m-9', 'The last thing said.', 'i-9'));
    merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.', 'prompt-t1'), asking('p-1', 'i-2'), { role: 'assistant', turnId: 'p-1', itemId: 'i-9', phase: 'final', text: 'The last thing said.', at: 1_000 }] }]);
    expect(store.newestPage(CONVERSATION).items.map((item) => `${item.kind} ${item.providerItemId}`)).toEqual(['message i-1', 'message i-2', 'interaction i-2', 'message i-9']);
    expect(store.newestPage(CONVERSATION).items.map((item) => item.order.item)).toEqual([1, 2, 3, 4]);
  });

  it('makes it passed where its model went on past it in an ended turn, and open where the turn has not ended (decision 0026, item 11)', () => {
    const store = area.open({ now: () => 66 });
    store.ensure(CONVERSATION, 1);
    const said = { role: 'assistant' as const, turnId: 'p-1', itemId: 'i-3', phase: 'final' as const, text: 'Only the report was added.', at: 1_000 };
    merge(store, [{ turn: { ...turn('p-1'), outcome: null }, messages: [user('p-1', 'i-1', 'Read a note.'), asking('p-1', 'i-2'), { ...said, phase: 'commentary' as const }] }]);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card open', 'assistant']);
    merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.'), asking('p-1', 'i-2'), { ...said, phase: 'commentary' as const }] }]);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card passed', 'assistant']);
    expect(store.newestPage(CONVERSATION).items[2]?.interaction).toMatchObject({ outcome: 'passed', settledAt: 66 });
  });

  it('makes it passed in a new turn whose model went on past it', () => {
    const store = area.open();
    store.ensure(CONVERSATION, 1);
    merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.'), asking('p-1', 'i-2'), { role: 'assistant', turnId: 'p-1', itemId: 'i-3', phase: 'final', text: 'The answer.', at: 1_000 }] }]);
    expect(kinds(store)).toEqual(['user', 'assistant', 'card passed', 'assistant']);
  });

  it('makes no card for a provider that asks none in its messages: the questions stay the message’s own', () => {
    const store = area.open();
    store.ensure(CONVERSATION, 1);
    merge(store, [{ turn: turn('p-1'), messages: [user('p-1', 'i-1', 'Read a note.'), asking('p-1', 'i-2')] }], false);
    expect(kinds(store)).toEqual(['user', 'assistant']);
    expect(store.newestPage(CONVERSATION).items[1]?.questions).toEqual(TITLES);
  });
});

describe('a removal (V7; C36)', () => {
  it('deletes a conversation’s questions and answers, and leaves no text of them in the store’s files', () => {
    const store = area.open();
    accept(store, 't1');
    const needle = (name: string): InteractionQuestion => ({ text: `NEEDLE-QUESTION-${name}`, header: `NEEDLE-HEADER-${name}`, options: [{ label: `NEEDLE-LABEL-${name}`, description: `NEEDLE-DESCRIPTION-${name}` }], multiple: false, freeText: true, secret: false });
    const id = store.addInteraction(CONVERSATION, 't1', asked('toolu_1', { questions: [needle('A')] }))?.item.id ?? '';
    store.setInteraction(CONVERSATION, id, 'pending', { outcome: 'answered', answers: [{ options: [], text: 'NEEDLE-ANSWER-A', secret: false }], settledAt: 30 });
    accept(store, 'o1', 'kept', OTHER);
    store.addInteraction(OTHER, 'o1', asked('toolu_k', { questions: [needle('KEPT')] }));
    const needles = ['NEEDLE-QUESTION-A', 'NEEDLE-HEADER-A', 'NEEDLE-LABEL-A', 'NEEDLE-DESCRIPTION-A', 'NEEDLE-ANSWER-A'];
    for (const text of needles) expect(area.holding(text), text).not.toEqual([]);
    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION]);
    for (const text of needles) expect(area.holding(text), text).toEqual([]);
    expect(area.holding('NEEDLE-QUESTION-KEPT')).toContain(STORE_FILE);
    expect(store.newestPage(CONVERSATION).items).toEqual([]);
  });
});
