// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V25, V27 (docs/planning/_archive/M18.md, Design 5; C20, C58, C60): the window a chat's page holds. The
// hook alone, on a fake bridge that answers `chat:read` and `chat:page` as main does, from a
// conversation the test holds.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatPush } from '@shared/contracts/chat';
import { type ConversationItem, PAGE_ENTRIES, WINDOW_ENTRIES } from '@shared/contracts/conversation';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sessionId } from '../../../../tests/support/sessions';
import { approvalWith, cardWith, chatApproval, chatCard, chatItem, chatItems, chatTurn, type FakeChat, fakeChat } from '../test/chat';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { resetGrants, useGrantsStore } from './grants-store';
import { resetWaiting, useWaiting } from './questions-store';
import { useChat } from './useChat';
import { useChatPresentation } from './presentation-store';

const ID = sessionId('window');
const OTHER = sessionId('another');

let bridge: FakeBridge;
let main: FakeChat;
let requests: [InvokeChannel, unknown][];
/** Channels whose answers are held back until released; each is what main said when it was asked. */
let withheld: Set<InvokeChannel>;
let waiting: (() => void)[];
/** Changes an answer on its way to the page. */
let alter: (channel: InvokeChannel, answer: unknown) => unknown;

beforeEach(() => {
  bridge = installFakeBridge();
  main = fakeChat(ID);
  requests = [];
  withheld = new Set();
  waiting = [];
  alter = (_channel, answer) => answer;
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    const answer = channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0]) : channel === 'chat:page' ? main.page(request as Parameters<FakeChat['page']>[0]) : { status: 'saved' };
    const now = { ok: true, value: alter(channel, answer) };
    if (withheld.has(channel)) return new Promise((resolve) => { waiting.push(() => resolve(now)); });
    return Promise.resolve(now);
  });
});
afterEach(cleanup);

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const release = () => act(() => { for (const answer of waiting.splice(0)) answer(); });
const push = (payload: ChatPush) => act(() => { bridge.push('chat:message', payload); });
const itemPush = (item: ConversationItem, revision: number): ChatPush => ({ sessionId: item.conversationId, revision, item, turn: chatTurn(item.turnId, { place: item.order.turn }) });
const asked = (channel: InvokeChannel) => requests.filter(([name]) => name === channel).map(([, request]) => request);
const last = (channel: InvokeChannel) => asked(channel).at(-1);

/** The hook on a conversation of `count` messages, its first read answered. */
async function open(count: number) {
  main.items = chatItems(ID, count);
  main.revision = count;
  const hook = renderHook(() => useChat(ID));
  await settle();
  const view = () => {
    const held = hook.result.current.view;
    if (held === null) throw new Error('no window yet');
    return held;
  };
  const texts = () => view().items.map((item) => item.blocks[0]?.text);
  const earlier = async () => { act(() => hook.result.current.showEarlier()); await settle(); };
  return { hook, view, texts, earlier };
}

describe('the first read, and pushes (V9; C20)', () => {
  it('refreshes avatars on an older page without rereading, replacing items or advancing transcript revisions', async () => {
    const { view, earlier } = await open(700);
    for (let page = 0; page < 5; page += 1) await earlier();
    expect(view().latest).toBe(false);
    const before = view();
    const reads = asked('chat:read').length;
    push({ sessionId: ID, revision: 99_999, presentationOnly: true, presentation: { revision: 2, models: { unlisted: null }, workers: {} } });
    expect(view()).toBe(before);
    expect(asked('chat:read')).toHaveLength(reads);
    expect(useChatPresentation.getState().value?.models).toHaveProperty('unlisted', null);
    // Its transcript revision was not consumed: the very next content change still applies.
    const item = view().items[0] as ConversationItem;
    main.revision += 1;
    push(itemPush({ ...item, state: 'partial' }, main.revision));
    expect(view().items[0]?.state).toBe('partial');
    expect(asked('chat:read')).toHaveLength(reads);
  });
  it('reads the newest page, and holds no window before it has answered', async () => {
    withheld.add('chat:read');
    main.items = chatItems(ID, 250);
    const hook = renderHook(() => useChat(ID));
    await settle();
    expect(hook.result.current.view).toBeNull();
    expect(hook.result.current.busy).toBe(true);
    release();
    await settle();
    expect(asked('chat:read')).toEqual([{ sessionId: ID }]);
    expect(hook.result.current.view?.items).toHaveLength(PAGE_ENTRIES);
    expect(hook.result.current.view?.items.at(-1)).toBe(main.items.at(-1));
    expect(hook.result.current.view).toMatchObject({ latest: true, older: main.items[150]?.id, change: { kind: 'latest' } });
    expect(hook.result.current.busy).toBe(false);
  });

  it('appends an item one revision above, with its turn, and drops the same push twice', async () => {
    const { view, texts } = await open(3);
    const next = chatItem(ID, 'assistant', 'next');
    push({ ...itemPush(next, 4), turn: chatTurn(next.turnId, { state: 'running', outcome: null }) });
    push(itemPush(next, 4));
    expect(texts()).toEqual(['message 1', 'message 2', 'message 3', 'next']);
    expect(view().turns.get(next.turnId)?.state).toBe('running');
    expect(view().change.kind).toBe('append');
    expect(asked('chat:read')).toHaveLength(1);
  });

  it('sorts by the stored places, whatever order the answer came in (C2)', async () => {
    main.items = chatItems(ID, 5).reverse();
    const hook = renderHook(() => useChat(ID));
    await settle();
    expect(hook.result.current.view?.items.map((item) => item.blocks[0]?.text)).toEqual(['message 1', 'message 2', 'message 3', 'message 4', 'message 5']);
  });

  it('reads the window it holds again on a gap in the revisions', async () => {
    const { view, texts } = await open(3);
    const four = chatItem(ID, 'assistant', 'four');
    const five = chatItem(ID, 'assistant', 'five');
    main.items.push(four, five);
    main.revision = 5;
    push(itemPush(five, 5));
    await settle();
    expect(last('chat:read')).toEqual({ sessionId: ID, from: main.items[0]?.id, keep: 'newest' });
    expect(texts()).toEqual(['message 1', 'message 2', 'message 3', 'four', 'five']);
    expect(view().change.kind).toBe('replace');
  });

  it('drops an answer and a push that name another session', async () => {
    const { texts } = await open(2);
    push(itemPush(chatItem(OTHER, 'user', 'for another'), 3));
    expect(texts()).toEqual(['message 1', 'message 2']);
    expect(asked('chat:read')).toHaveLength(1);
    // A read answered for another session, though it is newer.
    alter = (channel, answer) => (channel === 'chat:read' ? { ...(answer as object), sessionId: OTHER, items: [chatItem(OTHER, 'user', 'another’s')], revision: 9 } : answer);
    main.revision = 3;
    push({ sessionId: ID, revision: 3, changed: true });
    await settle();
    expect(asked('chat:read')).toHaveLength(2);
    expect(texts()).toEqual(['message 1', 'message 2']);
  });

  it('reads again at the next push when its first read failed', async () => {
    main.items = chatItems(ID, 2);
    main.revision = 2;
    bridge.setInvoke(() => Promise.resolve({ ok: false, error: 'internal' }));
    const hook = renderHook(() => useChat(ID));
    await settle();
    expect(hook.result.current.view).toBeNull();
    expect(hook.result.current.busy).toBe(false);
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      return Promise.resolve({ ok: true, value: main.read(request as Parameters<FakeChat['read']>[0]) });
    });
    const next = chatItem(ID, 'assistant', 'next');
    main.items.push(next);
    main.revision = 3;
    push(itemPush(next, 3));
    await settle();
    expect(asked('chat:read')).toEqual([{ sessionId: ID }]);
    expect(hook.result.current.view?.items.map((item) => item.blocks[0]?.text)).toEqual(['message 1', 'message 2', 'next']);
  });

  it('reads the newest page when it holds no item', async () => {
    const { texts } = await open(0);
    main.items = chatItems(ID, 2, 'imported');
    main.revision = 1;
    push({ sessionId: ID, revision: 1, changed: true });
    await settle();
    expect(last('chat:read')).toEqual({ sessionId: ID });
    expect(texts()).toEqual(['imported 1', 'imported 2']);
  });
});

describe('older pages, and the window’s bounds (V25; C58)', () => {
  it('asks for an older page only when told to, by the cursor of its oldest item', async () => {
    const { hook, view, earlier } = await open(250);
    const first = main.items[150];
    // Pushes and reads never ask for one.
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(asked('chat:page')).toEqual([]);
    await earlier();
    expect(asked('chat:page')).toEqual([{ sessionId: ID, before: first?.id }]);
    expect(view().items).toHaveLength(200);
    expect(view().items[0]).toBe(main.items[50]);
    expect(view()).toMatchObject({ latest: true, older: main.items[50]?.id, change: { kind: 'older-page' }, loaded: { count: 100 } });
    await earlier();
    // The conversation's start: nothing is older, and nothing more is asked.
    expect(view().items).toHaveLength(250);
    expect(view().older).toBeNull();
    await earlier();
    expect(asked('chat:page')).toHaveLength(2);
    expect(view().loaded?.count).toBe(50);
    expect(hook.result.current.busy).toBe(false);
  });

  it('is busy from the asking until the page is in', async () => {
    const { hook, earlier } = await open(250);
    withheld.add('chat:page');
    await earlier();
    expect(hook.result.current.busy).toBe(true);
    // A second asking while one is on its way asks nothing.
    await earlier();
    expect(asked('chat:page')).toHaveLength(1);
    release();
    await settle();
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.view?.items).toHaveLength(200);
  });

  it('never holds more than 500: past that an older page lets go of the newest, pushes are not appended, and Show latest returns to the newest page', async () => {
    const { hook, view, earlier } = await open(1200);
    for (let page = 0; page < 4; page += 1) {
      await earlier();
      expect(view().items.length).toBeLessThanOrEqual(WINDOW_ENTRIES);
    }
    expect(view().items).toHaveLength(WINDOW_ENTRIES);
    expect(view().latest).toBe(true);
    // A push at a full window that holds the newest: the oldest is let go, and stays on disk.
    const next = chatItem(ID, 'assistant', 'next');
    main.items.push(next);
    main.revision += 1;
    push(itemPush(next, main.revision));
    expect(view().items).toHaveLength(WINDOW_ENTRIES);
    expect(view().items.at(-1)).toBe(next);
    expect(view().older).toBe(view().items[0]?.id);
    expect(view().items[0]).toBe(main.items[701]);
    // One page more: the newest are let go.
    await earlier();
    expect(view().items).toHaveLength(WINDOW_ENTRIES);
    expect(view().latest).toBe(false);
    expect(view().items[0]).toBe(main.items[601]);
    expect(view().items.at(-1)).toBe(main.items[1100]);
    // A push is not appended: its revision alone is taken, so the next one is no gap.
    const reads = asked('chat:read').length;
    const unseen = chatItem(ID, 'assistant', 'unseen');
    main.items.push(unseen);
    main.revision += 1;
    push(itemPush(unseen, main.revision));
    const second = chatItem(ID, 'assistant', 'unseen too');
    main.items.push(second);
    main.revision += 1;
    push(itemPush(second, main.revision));
    await settle();
    expect(view().items.at(-1)).toBe(main.items[1100]);
    expect(asked('chat:read')).toHaveLength(reads);
    // Show latest.
    await act(() => hook.result.current.showLatest());
    expect(last('chat:read')).toEqual({ sessionId: ID });
    expect(view().items).toHaveLength(PAGE_ENTRIES);
    expect(view().items.at(-1)).toBe(second);
    expect(view()).toMatchObject({ latest: true, change: { kind: 'latest' }, loaded: null });
  });

  it('reads its window again after a page answered at another revision than the one held', async () => {
    const { view, earlier } = await open(250);
    // The turn changed between the read and the page.
    main.revision += 1;
    await earlier();
    expect(asked('chat:read')).toHaveLength(2);
    expect(last('chat:read')).toEqual({ sessionId: ID, from: main.items[50]?.id, keep: 'newest' });
    expect(view().items).toHaveLength(200);
    // The line for the page stays through the read that follows it.
    expect(view()).toMatchObject({ change: { kind: 'replace' }, loaded: { count: 100 } });
  });

  it('reads its window again when the store no longer has the cursor', async () => {
    const { view, earlier } = await open(250);
    alter = (channel, answer) => (channel === 'chat:page' ? { status: 'refused', reason: 'unknown-cursor' } : answer);
    await earlier();
    expect(asked('chat:read')).toHaveLength(2);
    expect(last('chat:read')).toEqual({ sessionId: ID, from: main.items[150]?.id, keep: 'newest' });
    expect(view().items).toHaveLength(100);
  });

  it('drops a page that names another session', async () => {
    const { view, earlier } = await open(250);
    alter = (channel, answer) => (channel === 'chat:page' ? { ...(answer as object), sessionId: OTHER } : answer);
    await earlier();
    expect(view().items).toHaveLength(100);
  });
});

describe('reading the held window again (V27; C60)', () => {
  it.each(['an echo', 'a turn’s start', 'a turn’s end'])('keeps the older pages loaded through %s', async () => {
    const { view, earlier } = await open(450);
    await earlier();
    await earlier();
    const held = view().items;
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(last('chat:read')).toEqual({ sessionId: ID, from: held[0]?.id, keep: 'newest' });
    expect(asked('chat:page')).toHaveLength(2);
    expect(view().items).toEqual(held);
    expect(view().items[0]).toBe(main.items[150]);
    expect(view().latest).toBe(true);
  });

  it('takes a turn’s new state from the window read again', async () => {
    const { view } = await open(3);
    const turn = main.items[2]?.turnId ?? '';
    main.turns.set(turn, chatTurn(turn, { state: 'unfinished', outcome: null, gap: true }));
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(view().turns.get(turn)).toMatchObject({ state: 'unfinished', gap: true });
  });

  it('shows an answer settled on its turn’s end in place: the same item, with its new phase, and nothing added (M16, C74)', async () => {
    const { view } = await open(3);
    // What the provider said while it worked, as it arrived.
    main.items = main.items.map((item, index) => (index === 2 ? { ...item, role: 'assistant', phase: 'commentary' } : item));
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(view().items[2]).toMatchObject({ phase: 'commentary' });
    const before = view().items.map((item) => item.id);

    // The turn ends, naming it: main settles the phase, and tells the page that something changed.
    const turn = main.items[2]?.turnId ?? '';
    main.items = main.items.map((item, index) => (index === 2 ? { ...item, phase: 'final' } : item));
    main.turns.set(turn, chatTurn(turn, { state: 'ended', outcome: 'completed' }));
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(view().items.map((item) => item.id)).toEqual(before);
    expect(view().items[2]).toMatchObject({ id: before[2], role: 'assistant', phase: 'final' });
    expect(view().turns.get(turn)).toMatchObject({ state: 'ended', outcome: 'completed' });
    expect(view().items).toHaveLength(3);
  });

  it('keeps the older pages loaded through an import, which goes in among them', async () => {
    const { view, earlier } = await open(450);
    await earlier();
    const first = view().items[0];
    // A turn made elsewhere, placed between two the window holds.
    const before = main.items[300] as ConversationItem;
    const imported = [0.25, 0.5].map((step) => chatItem(ID, 'assistant', `imported ${step}`, { origin: 'provider', order: { turn: before.order.turn - 1 + step, item: 0 } }));
    main.items.splice(300, 0, ...imported);
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(last('chat:read')).toEqual({ sessionId: ID, from: first?.id, keep: 'newest' });
    expect(view().items).toHaveLength(202);
    expect(view().items[0]).toBe(first);
    expect(view().items.slice(50, 52)).toEqual(imported);
  });

  it('keeps the oldest when it had let go of its newest', async () => {
    const { view, earlier } = await open(1200);
    for (let page = 0; page < 5; page += 1) await earlier();
    expect(view().latest).toBe(false);
    const held = view().items;
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(last('chat:read')).toEqual({ sessionId: ID, from: held[0]?.id, keep: 'oldest' });
    expect(view().items).toEqual(held);
    expect(view().latest).toBe(false);
  });

  it('keeps the newest when a full window that holds them is read again', async () => {
    const { view, earlier } = await open(600);
    for (let page = 0; page < 4; page += 1) await earlier();
    expect(view().items).toHaveLength(WINDOW_ENTRIES);
    expect(view().items[0]).toBe(main.items[100]);
    // Two items it was never pushed: the window read again is two past its bound.
    main.items.push(chatItem(ID, 'user', 'missed'), chatItem(ID, 'assistant', 'newest'));
    main.revision += 2;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(last('chat:read')).toEqual({ sessionId: ID, from: main.items[100]?.id, keep: 'newest' });
    expect(view().items).toHaveLength(WINDOW_ENTRIES);
    expect(view().items.at(-1)?.blocks[0]?.text).toBe('newest');
    expect(view().items[0]).toBe(main.items[102]);
    expect(view()).toMatchObject({ latest: true, older: main.items[102]?.id });
  });

  it('takes the newest page as such when the store no longer has the item it asked from', async () => {
    const { view, earlier } = await open(250);
    await earlier();
    const from = view().items[0]?.id;
    // Another conversation altogether: none of its items is one the window holds.
    main.items = chatItems(ID, 150, 'other');
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(last('chat:read')).toEqual({ sessionId: ID, from, keep: 'newest' });
    expect(view().items).toHaveLength(PAGE_ENTRIES);
    expect(view().items.at(-1)).toBe(main.items.at(-1));
    expect(view()).toMatchObject({ latest: true, older: main.items[50]?.id });
  });

  it('does not take an answer for a window it no longer holds: an older page went in meanwhile', async () => {
    const { view, earlier } = await open(250);
    // A read of the window, held back…
    withheld.add('chat:read');
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    withheld.delete('chat:read');
    // …while an older page goes in. Its revision is not the one held, so the window is read again.
    await earlier();
    expect(view().items).toHaveLength(200);
    // The answer for the window as it was arrives last: the page it would lose stays.
    release();
    await settle();
    expect(view().items).toHaveLength(200);
    expect(view().items[0]).toBe(main.items[50]);
    expect(last('chat:read')).toEqual({ sessionId: ID, from: main.items[50]?.id, keep: 'newest' });
  });
});

// V11 (docs/planning/_archive/M19.md; C24–C27, C46, C49): a message that is being written, as the page takes it.
describe('a message that is being written (M19: V11; C24–C27, C46)', () => {
  /** Main as it is while a message is written: the item at the end of the conversation, with the text main has pushed, at main's revision. */
  function streaming(text: string): ConversationItem {
    const item = chatItem(ID, 'assistant', text, { state: 'streaming', phase: 'commentary' });
    main.items.push(item);
    main.turns.set(item.turnId, chatTurn(item.turnId, { state: 'running', outcome: null, place: item.order.turn }));
    main.revision += 1;
    return item;
  }
  /** Main appends to the text it has pushed, and pushes the append. */
  function grow(item: ConversationItem, append: string): ChatPush {
    const held = main.items.findIndex((entry) => entry.id === item.id);
    const before = main.items[held]?.blocks[0]?.text ?? '';
    main.items[held] = { ...(main.items[held] as ConversationItem), blocks: [{ type: 'text', text: before + append, cut: false }] };
    main.revision += 1;
    return { sessionId: ID, revision: main.revision, partial: { itemId: item.id, before: before.length, append } };
  }
  const textOf = (view: () => { items: readonly ConversationItem[] }, id: string) => view().items.find((item) => item.id === id)?.blocks[0]?.text;
  const reads = () => asked('chat:read').length;

  it('appends a partial push’s text to the held item of exactly that length, with no read, and leaves every other item as it is', async () => {
    const { view } = await open(4);
    const item = streaming('');
    push(itemPush(item, main.revision));
    const before = view().items.slice(0, 4);
    const turnsBefore = view().turns;
    const asks = reads();

    push(grow(item, 'Hel'));
    push(grow(item, 'lo, world'));
    expect(textOf(view, item.id)).toBe('Hello, world');
    expect(view().change.kind).toBe('grow');
    expect(reads()).toBe(asks);
    // The other items are the objects they were, and so are the turns: nothing else is drawn again (C65).
    expect(view().items.slice(0, 4)).toEqual(before);
    expect(view().items.slice(0, 4).every((held, index) => held === before[index])).toBe(true);
    expect(view().turns).toBe(turnsBefore);
    expect(view().items.at(-1)).toMatchObject({ id: item.id, state: 'streaming' });
    expect(view().arrivals).toBe(3);
  });

  it('reads its window again when the text it holds is not as long as the push says, and then holds what main has', async () => {
    const { view } = await open(4);
    const item = streaming('');
    push(itemPush(item, main.revision));
    const first = grow(item, 'Hel');
    const second = grow(item, 'lo');
    // The first push never arrived as such: the second finds a text of another length.
    const asks = reads();
    push({ ...second, revision: first.revision });
    await settle();
    expect(reads()).toBe(asks + 1);
    expect(textOf(view, item.id)).toBe('Hello');
    // And the push for what the read already holds is dropped: nothing is appended twice.
    push(second);
    await settle();
    expect(textOf(view, item.id)).toBe('Hello');
  });

  it('reads its window again for a partial push that names an item it does not hold, and on a gap in the revisions', async () => {
    const { view } = await open(4);
    const item = streaming('Half');
    // Its opening push never arrived: the page learns of the message by a partial push.
    const asks = reads();
    push(grow(item, ' an answer'));
    await settle();
    expect(reads()).toBe(asks + 1);
    expect(textOf(view, item.id)).toBe('Half an answer');

    grow(item, ', and');
    const late = grow(item, ' more');
    push(late);
    await settle();
    expect(reads()).toBe(asks + 2);
    expect(textOf(view, item.id)).toBe('Half an answer, and more');
  });

  it('replaces a held item by its id without a read: the item pushed at a message’s completion stands where its opening stood (C26)', async () => {
    const { view } = await open(4);
    const item = streaming('');
    push(itemPush(item, main.revision));
    push(grow(item, 'Helo, wrold'));
    const asks = reads();
    main.revision += 1;
    // The whole message is the authority: another text than the deltas brought, and complete.
    const whole: ConversationItem = { ...item, state: 'complete', phase: 'final', blocks: [{ type: 'text', text: 'Hello, world.', cut: false }] };
    push(itemPush(whole, main.revision));
    expect(reads()).toBe(asks);
    expect(view().items).toHaveLength(5);
    expect(view().items.at(-1)).toMatchObject({ id: item.id, state: 'complete', phase: 'final', blocks: [{ text: 'Hello, world.' }] });
  });

  it('takes a read that crossed an append, a published one and a completion, with no text twice and none lost (C26)', async () => {
    // The first read is on its way while the message is written.
    withheld.add('chat:read');
    main.items = chatItems(ID, 2);
    main.revision = 2;
    const hook = renderHook(() => useChat(ID));
    await settle();
    const item = streaming('Hel');
    // A partial push arrives before the read's answer, which was made before it: the page reads once more.
    const answerBefore = waiting.length;
    push(grow(item, 'lo'));
    withheld.delete('chat:read');
    expect(waiting).toHaveLength(answerBefore);
    release();
    await settle();
    const view = () => hook.result.current.view;
    expect(view()?.items.at(-1)?.blocks[0]?.text).toBe('Hello');
    expect(view()?.items.filter((held) => held.id === item.id)).toHaveLength(1);

    // A window read again while an append is on its way: the answer holds it, and its push is then dropped.
    const pending = grow(item, ', world');
    push({ sessionId: ID, revision: pending.revision - 1 + 0, changed: true });
    await settle();
    push(pending);
    await settle();
    expect(view()?.items.at(-1)?.blocks[0]?.text).toBe('Hello, world');

    // And a completion that crosses a read: the item is there once, complete.
    main.items[main.items.length - 1] = { ...(main.items.at(-1) as ConversationItem), state: 'complete', blocks: [{ type: 'text', text: 'Hello, world.', cut: false }] };
    main.revision += 1;
    push(itemPush(main.items.at(-1) as ConversationItem, main.revision));
    push({ sessionId: ID, revision: main.revision + 1, changed: true });
    main.revision += 1;
    await settle();
    expect(view()?.items.filter((held) => held.id === item.id)).toHaveLength(1);
    expect(view()?.items.at(-1)).toMatchObject({ state: 'complete', blocks: [{ text: 'Hello, world.' }] });
  });

  it('takes the revisions alone in a window that let go of its newest: no read, no item moved, and word that something newer arrived (C46)', async () => {
    const { view, earlier } = await open(WINDOW_ENTRIES + PAGE_ENTRIES);
    for (let page = 0; page < 5; page += 1) await earlier();
    expect(view().latest).toBe(false);
    expect(view().newer).toBe(false);
    const held = view().items;
    const asks = reads();

    const item = streaming('');
    push(itemPush(item, main.revision));
    push(grow(item, 'Unseen '));
    push(grow(item, 'text'));
    expect(reads()).toBe(asks);
    expect(view().items).toBe(held);
    expect(view().newer).toBe(true);
    // A gap still reads the held window again, and it stays the window it was.
    grow(item, ' and');
    push(grow(item, ' more'));
    await settle();
    expect(reads()).toBe(asks + 1);
    expect(view().items[0]).toBe(held[0]);
    expect(view().latest).toBe(false);
    expect(view().newer).toBe(true);
  });

  it('notes a turn that ran here and is over, once, with how it ended; a first read notes none (C49)', async () => {
    main.items = chatItems(ID, 2);
    main.revision = 2;
    // A turn that had ended before the chat was opened.
    main.turns.set(main.items[1]?.turnId ?? '', chatTurn(main.items[1]?.turnId ?? '', { state: 'ended', outcome: 'completed' }));
    const hook = renderHook(() => useChat(ID));
    await settle();
    const view = () => { if (hook.result.current.view === null) throw new Error('no window'); return hook.result.current.view; };
    expect(view().ended).toBeNull();

    const item = streaming('An answer');
    // As main pushes it: with its turn as it then is, running.
    push({ sessionId: ID, revision: main.revision, item, turn: main.turnOf(item) });
    expect(view().turns.get(item.turnId)?.state).toBe('running');
    expect(view().ended).toBeNull();
    // The turn ends: main says that something changed, and the window read again holds the ended turn.
    main.turns.set(item.turnId, chatTurn(item.turnId, { state: 'ended', outcome: 'interrupted', place: item.order.turn }));
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(view().ended).toMatchObject({ outcome: 'interrupted' });
    const noted = view().ended;
    // Read again for another reason, the same notice stands: nothing is said twice.
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(view().ended).toEqual(noted);
  });
});

// M21, V27, V29, V30 (C35, C43, C49, C71, C73, C74): a question's card in the window the page holds.
describe('a question’s card (M21: V27, V29, V30; C71, C73, C74)', () => {
  beforeEach(resetWaiting);
  const settled = (item: ConversationItem, outcome: 'answered' | 'dismissed' | 'passed' | 'withdrawn'): ConversationItem => cardWith(item, { outcome, settledAt: 9 });
  const reads = () => asked('chat:read').length;

  it('redraws a card that was answered, dismissed or passed while the window shows an older page: in place, with no read, no arrival and no word of something newer', async () => {
    main.items = [...chatItems(ID, 50), chatCard(ID, 't-card', { mode: 'async', outcome: 'open' }), ...chatItems(ID, WINDOW_ENTRIES + PAGE_ENTRIES)];
    main.revision = main.items.length;
    const card = main.items[50] as ConversationItem;
    const hook = renderHook(() => useChat(ID));
    await settle();
    const view = () => hook.result.current.view as NonNullable<typeof hook.result.current.view>;
    for (let page = 0; page < 8 && !view().items.some((item) => item.id === card.id); page += 1) { act(() => hook.result.current.showEarlier()); await settle(); }
    expect(view().latest).toBe(false);
    expect(view().items.some((item) => item.id === card.id)).toBe(true);
    const before = view();
    const asks = reads();
    for (const outcome of ['dismissed', 'answered', 'passed'] as const) {
      main.revision += 1;
      push(itemPush(settled(card, outcome), main.revision));
      expect(view().items.find((item) => item.id === card.id)?.interaction?.outcome).toBe(outcome);
    }
    expect(reads()).toBe(asks);
    expect(view().items.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
    expect(view()).toMatchObject({ latest: false, older: before.older, newer: false, arrivals: before.arrivals });
    // A push of an item the window does not hold still says something newer arrived, and moves nothing.
    main.revision += 1;
    push(itemPush(chatItem(ID, 'assistant', 'past its end'), main.revision));
    expect(view().newer).toBe(true);
    expect(view().items.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
    expect(reads()).toBe(asks);
  });

  it('notes a blocking question raised here once, by the push that brings it, and one raised past an older page’s end all the same (C43)', async () => {
    const { view } = await open(3);
    expect(view().asked).toBeNull();
    const card = chatCard(ID, 't-ask');
    push({ ...itemPush(card, 4), turn: chatTurn('t-ask', { state: 'running', outcome: null }) });
    const first = view().asked;
    expect(first).toMatchObject({ worker: false });
    push(itemPush(settled(card, 'answered'), 5));
    expect(view().asked).toBe(first);
    expect(view().arrivals).toBe(1);
  });

  it('notes a question raised right behind a change it is still reading for: the read brings the card, and the raising is said once all the same (C43, C74)', async () => {
    const { view } = await open(3);
    const reads = () => asked('chat:read').length;
    const before = reads();
    // The turn was taken: something changed, and the window reads again.
    main.revision = 4;
    push({ sessionId: ID, revision: 4, changed: true });
    expect(reads()).toBe(before + 1);
    // The question's push comes before that read's answer, two revisions on: a gap, so it is not applied.
    const card = chatCard(ID, 't-ask');
    main.items.push(card);
    main.revision = 6;
    push({ ...itemPush(card, 6), turn: chatTurn('t-ask', { state: 'running', outcome: null }) });
    const noted = view().asked;
    expect(noted).toMatchObject({ worker: false });
    expect(view().items.some((item) => item.id === card.id)).toBe(false);
    await settle();
    // The reads bring the card, and the note stands as it was: one line, not two.
    expect(view().items.at(-1)?.id).toBe(card.id);
    expect(view().asked).toBe(noted);

    // A worker's, behind a change too: its row waits and its raising is noted, once.
    const worker = chatCard(ID, 't-ask', {}, { workerId: 'worker-1' });
    main.revision = 7;
    push({ sessionId: ID, revision: 7, changed: true });
    main.revision = 9;
    main.waiting = [{ workerId: 'worker-1', itemId: worker.id, kind: 'question' }];
    push({ ...itemPush(worker, 9), workerId: 'worker-1', turn: chatTurn('t-ask', { state: 'running', outcome: null }) });
    expect(view().asked).toMatchObject({ worker: true });
    expect(view().asked?.serial).toBeGreaterThan(noted?.serial ?? 0);
    const said = view().asked;
    await settle();
    expect(view().asked).toBe(said);
    expect(useWaiting.getState().waiting).toEqual([{ workerId: 'worker-1', itemId: worker.id, kind: 'question' }]);
  });

  it('lists a worker’s waiting questions from the read, and follows its pushes: a row waits while any item of the worker’s is pending (V29; C73)', async () => {
    const one = chatCard(ID, 't-w', {}, { workerId: 'worker-1' });
    const two = chatCard(ID, 't-w', {}, { workerId: 'worker-1' });
    main.waiting = [{ workerId: 'worker-1', itemId: one.id, kind: 'question' }];
    const { view } = await open(3);
    const waits = (workerId = 'worker-1') => useWaiting.getState().waiting.filter((entry) => entry.workerId === workerId).map((entry) => entry.itemId);
    expect(useWaiting.getState().sessionId).toBe(ID);
    expect(waits()).toEqual([one.id]);
    const before = view().items;
    const asks = reads();
    const theirs = (item: ConversationItem): void => { main.revision += 1; push({ ...itemPush(item, main.revision), workerId: 'worker-1' }); };
    // A second question of the same worker: both wait.
    theirs(two);
    expect(waits()).toEqual([one.id, two.id]);
    // The answer to one leaves the row: the other still waits.
    theirs(settled(one, 'answered'));
    expect(waits()).toEqual([two.id]);
    theirs(settled(two, 'withdrawn'));
    expect(waits()).toEqual([]);
    // A worker's pushes pass: nothing of the list changed, and nothing was read again.
    expect(view().items).toBe(before);
    expect(reads()).toBe(asks);
    // A read between an answer and its mark lists no row for it (V32; C76).
    main.waiting = [];
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, changed: true });
    await settle();
    expect(waits()).toEqual([]);
  });

  it('posts a worker’s question once, at the pass of its pending push, whether or not its tab is shown (V30; C74)', async () => {
    const { view } = await open(3);
    const card = chatCard(ID, 't-w', {}, { workerId: 'worker-1' });
    main.revision += 1;
    push({ ...itemPush(card, main.revision), workerId: 'worker-1' });
    const posted = view().asked;
    expect(posted).toMatchObject({ worker: true });
    // The same item again, as it still waits, and then as it is answered: nothing more is posted.
    main.revision += 1;
    push({ ...itemPush(card, main.revision), workerId: 'worker-1' });
    main.revision += 1;
    push({ ...itemPush(settled(card, 'answered'), main.revision), workerId: 'worker-1' });
    expect(view().asked).toBe(posted);
    // An activity of the worker's, and a card of an aside's that could never be, post nothing.
    expect(view().items).toHaveLength(3);
  });

  it('holds nothing of a session’s waiting questions once its chat is closed', async () => {
    main.waiting = [{ workerId: 'worker-1', itemId: 'card-1', kind: 'question' }];
    const { hook } = await open(3);
    expect(useWaiting.getState().waiting).toHaveLength(1);
    hook.unmount();
    expect(useWaiting.getState()).toEqual({ sessionId: null, waiting: [] });
  });
});

// M22, V9, V32 (docs/planning/_archive/M22.md, Design 5, 10; C36, C57, C92): an approval in the window the
// page holds, and the session's grants, which its read lists and its approvals' pushes keep.
describe('an approval’s card, and the session’s grants (M22: V9, V32; C36, C57, C92)', () => {
  beforeEach(() => { resetWaiting(); resetGrants(); });
  const grants = () => useGrantsStore.getState();
  const GRANTED = { choices: ['approve' as const, 'approve-session' as const, 'deny' as const], grant: { covers: 'Bash(touch notes.txt)' } };
  const running = (item: ConversationItem, revision: number): ChatPush => ({ ...itemPush(item, revision), turn: chatTurn(item.turnId, { state: 'running', outcome: null }) });

  it('notes an approval raised here once, by what it asks leave for, and applies its decision in place with no read', async () => {
    const { view } = await open(3);
    const card = chatApproval(ID, 't-ask', { request: { kind: 'file-change' } });
    push(running(card, 4));
    const first = view().asked;
    expect(first).toMatchObject({ worker: false, what: 'file-change' });
    const reads = asked('chat:read').length;
    push(itemPush(approvalWith(card, { outcome: 'approved', decidedAt: 9, delivered: true }), 5));
    expect(view().items.find((item) => item.id === card.id)?.interaction?.outcome).toBe('approved');
    expect(view().asked).toBe(first);
    expect(view().arrivals).toBe(1);
    expect(asked('chat:read')).toHaveLength(reads);
  });

  it('lists a worker’s approval that waits as an approval, and notes its raising for the chat to post (C36)', async () => {
    const { view } = await open(3);
    const worker = chatApproval(ID, 't-w', {}, { workerId: 'worker-1' });
    push({ ...running(worker, 4), workerId: 'worker-1' });
    expect(useWaiting.getState().waiting).toEqual([{ workerId: 'worker-1', itemId: worker.id, kind: 'approval' }]);
    expect(view().asked).toMatchObject({ worker: true, what: 'command' });
    // Its item is its tab's: the session's window holds none of it.
    expect(view().items.some((item) => item.id === worker.id)).toBe(false);
    push({ ...itemPush(approvalWith(worker, { outcome: 'denied', decidedAt: 9, delivered: true }), 5), workerId: 'worker-1' });
    expect(useWaiting.getState().waiting).toEqual([]);
  });

  it('holds the grants its read lists, for its own session, and none of them once its chat is closed', async () => {
    main.grants = [{ itemId: 'm-g1', covers: 'notes.txt', decidedAt: 5, confirmed: true, live: true }, { itemId: 'm-g2', covers: 'Bash(ls)', decidedAt: 6, confirmed: false, live: false }];
    const { hook } = await open(3);
    expect(grants()).toEqual({ sessionId: ID, grants: main.grants });
    hook.unmount();
    expect(grants()).toEqual({ sessionId: null, grants: [] });
  });

  it('lists a grant from its card’s pushes once its reply was delivered, and never one the process did not take (V32; C92)', async () => {
    await open(3);
    const card = chatApproval(ID, 't-g', { request: GRANTED });
    push(running(card, 4));
    expect(grants().grants).toEqual([]);
    const decided = approvalWith(card, { outcome: 'approved-session', decidedAt: 7, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: true } });
    // Written, and not yet known to be delivered: nothing of it stands for a send.
    push(running(decided, 5));
    expect(grants().grants).toEqual([]);
    push(running(approvalWith(decided, { delivered: true }), 6));
    expect(grants().grants).toEqual([{ itemId: card.id, covers: 'Bash(touch notes.txt)', decidedAt: 7, confirmed: false, live: true }]);
    push(running(approvalWith(decided, { delivered: true, confirmedAt: 8 }), 7));
    expect(grants().grants).toEqual([{ itemId: card.id, covers: 'Bash(touch notes.txt)', decidedAt: 7, confirmed: true, live: true }]);
    // Another, whose reply the process refused: on its card alone.
    const other = chatApproval(ID, 't-g', { request: GRANTED });
    push(running(other, 8));
    push(running(approvalWith(other, { outcome: 'approved-session', decidedAt: 9, delivered: false, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: false } }), 9));
    expect(grants().grants.map((grant) => grant.itemId)).toEqual([card.id]);
    expect(asked('chat:read')).toHaveLength(1);
  });

  it('takes a worker’s grant from its push too, and what a later read lists in place of what it held', async () => {
    await open(3);
    const worker = approvalWith(chatApproval(ID, 't-w', { request: GRANTED }, { workerId: 'worker-1' }), { outcome: 'approved-session', decidedAt: 7, delivered: true, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: true } });
    push({ ...running(worker, 4), workerId: 'worker-1' });
    expect(grants().grants).toEqual([{ itemId: worker.id, covers: 'Bash(touch notes.txt)', decidedAt: 7, confirmed: false, live: true }]);
    // The session's process ended — a change of mode, the idle close, a loss: main says so, and the read lists the grant ended.
    main.grants = [{ itemId: worker.id, covers: 'Bash(touch notes.txt)', decidedAt: 7, confirmed: false, live: false }];
    main.revision = 5;
    push({ sessionId: ID, revision: 5, changed: true });
    await settle();
    expect(grants().grants).toEqual(main.grants);
  });
});
