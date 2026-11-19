// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V27 (docs/planning/_archive/M21.md, Design 6; C35, C43, C49, C71, C74): what an item's push does to the
// window the page holds — a new item at its end, a held one replaced where it stands on any page
// with no arrival counted, and the one line a raised question is posted by.
import { describe, expect, it } from 'vitest';
import type { ChatRead } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { approvalWith, cardWith, CHECKED, chatActivity, chatApproval, chatCard, chatItem, chatItems, chatTurn } from '../test/chat';
import { type ChatView, drawsEntry, holdsItem, isRaised, raisedBy, windowOf, withAsked, withItem, withNewer } from './window';

const ID = '5e551000-0000-4000-8000-000000000001';

function held(items: readonly ConversationItem[], latest = true): ChatView {
  const answer: Pick<ChatRead, 'items' | 'turns' | 'latest' | 'older' | 'history' | 'storage'> = { items, turns: [...new Set(items.map((item) => item.turnId))].map((id) => chatTurn(id)), latest, older: null, history: CHECKED, storage: 'ok' };
  return windowOf(answer, { serial: 1, kind: 'latest' }, null);
}
const ids = (view: ChatView): string[] => view.items.map((item) => item.id);

describe('an item’s push (V27; C71)', () => {
  it('puts a new item at the window’s end, and counts an arrival', () => {
    const view = held(chatItems(ID, 3));
    const next = chatItem(ID, 'assistant', 'next');
    const after = withItem(view, next, chatTurn(next.turnId), 2);
    expect(ids(after)).toEqual([...ids(view), next.id]);
    expect(after.arrivals).toBe(view.arrivals + 1);
    expect(after.change).toEqual({ serial: 2, kind: 'append' });
  });

  it('replaces a held item where it stands, and counts no arrival: an outcome’s push is nothing new below', () => {
    // Made in the order they are stored in: the card stands between two pairs of messages.
    const earlier = chatItems(ID, 2);
    const card = chatCard(ID, 't1');
    const view = held([...earlier, card, ...chatItems(ID, 2)]);
    const answered: ConversationItem = cardWith(card, { outcome: 'answered', answers: [{ options: [0], text: null, secret: false }], settledAt: 9 });
    const after = withItem(view, answered, chatTurn('t1'), 2);
    expect(ids(after)).toEqual(ids(view));
    expect(after.items[2]).toBe(answered);
    // Every other item is the object it was: no other entry is drawn again.
    expect(after.items.filter((item, index) => index !== 2 && item !== view.items[index])).toEqual([]);
    expect(after.arrivals).toBe(view.arrivals);
    expect(after.asked).toBeNull();
  });

  it('replaces a held item in a window that let go of its newest too: its items, its cursor and its word of something newer as they were', () => {
    const card = chatCard(ID, 't1', { mode: 'async', outcome: 'open' });
    const view = withNewer({ ...held([card, ...chatItems(ID, 3)], false), older: 'an-older-cursor' });
    expect(holdsItem(view, card.id)).toBe(true);
    const dismissed: ConversationItem = cardWith(card, { outcome: 'dismissed', settledAt: 9 });
    const after = withItem(view, dismissed, chatTurn('t1'), 2);
    expect(after.items[0]).toBe(dismissed);
    expect(after.items.slice(1)).toEqual(view.items.slice(1));
    expect(after).toMatchObject({ latest: false, older: 'an-older-cursor', newer: true, arrivals: view.arrivals });
    expect(holdsItem(view, 'an-item-past-its-end')).toBe(false);
  });

  it('keeps a streamed message’s completion in place the same way', () => {
    const earlier = chatItems(ID, 2);
    const open = chatItem(ID, 'assistant', 'Hel', { state: 'streaming' });
    const view = held([...earlier, open]);
    const whole: ConversationItem = { ...open, state: 'complete', blocks: [{ type: 'text', text: 'Hello, world.', cut: false }] };
    const after = withItem(view, whole, chatTurn(open.turnId), 2);
    expect(after.items.at(-1)).toBe(whole);
    expect(after.arrivals).toBe(view.arrivals);
  });
});

describe('a question raised (V10, V30; C43, C74)', () => {
  it('is a blocking question, pending: what its raising pushes, and no other state of a card', () => {
    expect(isRaised(chatCard(ID, 't1'))).toBe(true);
    for (const body of [{ outcome: 'answered' as const }, { outcome: 'dropped' as const }, { outcome: 'withdrawn' as const }, { mode: 'async' as const, outcome: 'open' as const }]) expect(isRaised(chatCard(ID, 't1', body)), JSON.stringify(body)).toBe(false);
    expect(isRaised(chatItem(ID, 'assistant', 'no card'))).toBe(false);
  });

  it('is noted once by the push that brings it: not by a read, and not by its outcome’s push', () => {
    const view = held(chatItems(ID, 2));
    expect(view.asked).toBeNull();
    const card = chatCard(ID, 't1');
    const raised = withItem(view, card, chatTurn('t1', { state: 'running' }), 2);
    expect(raised.asked).toEqual({ serial: 2, worker: false, what: 'question' });
    const answered = withItem(raised, cardWith(card, { outcome: 'answered' }), chatTurn('t1'), 3);
    expect(answered.asked).toEqual({ serial: 2, worker: false, what: 'question' });
    // A window read again keeps the line it had; a first read, which saw nothing raised, has none.
    expect(windowOf({ items: answered.items, turns: [], latest: true, older: null, history: CHECKED, storage: 'ok' }, { serial: 4, kind: 'replace' }, answered).asked).toEqual({ serial: 2, worker: false, what: 'question' });
    expect(held([card]).asked).toBeNull();
    // An async card's arrival posts nothing: the model went on, and no attention is raised (C5).
    expect(withItem(view, chatCard(ID, 't1', { mode: 'async', outcome: 'open' }), chatTurn('t1'), 2).asked).toBeNull();
  });

  it('is noted for a question the window does not take in — a worker’s, or one past its end — with nothing in the window moved', () => {
    const view = held(chatItems(ID, 2));
    const after = withAsked(view, 5, true, chatCard(ID, 't1', {}, { workerId: 'worker-1' }));
    expect(after.asked).toEqual({ serial: 5, worker: true, what: 'question' });
    expect(after.items).toBe(view.items);
    expect(after.change).toBe(view.change);
    expect(after.arrivals).toBe(view.arrivals);
  });
});

describe('what draws (V10; C43)', () => {
  it('counts a question’s card as an entry that draws, and one whose body cannot be read as one that does not', () => {
    const card = chatCard(ID, 't1');
    expect(drawsEntry([card])).toBe(true);
    expect(drawsEntry([{ ...card, interaction: null }])).toBe(false);
    // As before: a message, a group that holds more than thinking, and nothing for a reserved kind.
    expect(drawsEntry([chatItem(ID, 'assistant', 'x')])).toBe(true);
    expect(drawsEntry([chatActivity(ID, 't1', { type: 'thinking' })])).toBe(false);
    expect(drawsEntry([{ ...chatItem(ID, 'assistant', 'x'), kind: 'attachment', role: null }])).toBe(false);
  });
});

// M22, V9 (docs/planning/_archive/M22.md, Design 10; C36): an approval is raised as a blocking question is.
describe('an approval’s raising (M22; C36)', () => {
  it('is raised by a pending approval, by what it asks leave for, and by no settled one', () => {
    expect(raisedBy(chatApproval(ID, 't1'))).toBe('command');
    expect(raisedBy(chatApproval(ID, 't1', { request: { kind: 'file-change' } }))).toBe('file-change');
    expect(raisedBy(chatApproval(ID, 't1', { request: { kind: 'tool' } }))).toBe('tool');
    for (const outcome of ['approved', 'approved-session', 'denied', 'withdrawn', 'dropped'] as const) expect(isRaised(chatApproval(ID, 't1', { outcome })), outcome).toBe(false);
    // A question's as before: blocking and pending, and never an async one.
    expect(raisedBy(chatCard(ID, 't1'))).toBe('question');
    expect(raisedBy(chatCard(ID, 't1', { mode: 'async', outcome: 'open' }))).toBeNull();
    expect(raisedBy(chatItem(ID, 'assistant', 'x'))).toBeNull();
  });

  it('notes one that is new here with what it asks, keeps the line through its decision, and counts it as an entry that draws', () => {
    const view = held(chatItems(ID, 2));
    const card = chatApproval(ID, 't1', { request: { kind: 'file-change' } });
    const raised = withItem(view, card, chatTurn('t1', { state: 'running' }), 2);
    expect(raised.asked).toEqual({ serial: 2, worker: false, what: 'file-change' });
    expect(drawsEntry([card])).toBe(true);
    const decided = withItem(raised, approvalWith(card, { outcome: 'denied', decidedAt: 9 }), chatTurn('t1'), 3);
    expect(decided.asked).toBe(raised.asked);
    expect(decided.arrivals).toBe(raised.arrivals);
  });

  it('is noted for a worker’s approval, which the window does not take in, and changes nothing for an item that raises nothing', () => {
    const view = held(chatItems(ID, 2));
    const after = withAsked(view, 5, true, chatApproval(ID, 't1', {}, { workerId: 'worker-1' }));
    expect(after.asked).toEqual({ serial: 5, worker: true, what: 'command' });
    expect(after.items).toBe(view.items);
    expect(withAsked(view, 6, true, chatApproval(ID, 't1', { outcome: 'approved' }))).toBe(view);
  });
});
