// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V1 (docs/planning/_archive/M18.md; C1–C6, C17): the conversation's contracts — stable ids and stored
// places, the limits, a capability a descriptor does not declare, times that keep their source, and
// a worker that is no part of a turn.
import { describe, expect, it } from 'vitest';
import { type ActivityBody, startedBody } from './activity';
import {
  boundItems,
  CHAT_CAPABILITIES,
  chatCapability,
  compareItems,
  type ConversationItem,
  type ConversationTurn,
  type ConversationWorker,
  DetachedReadRequestSchema,
  DetachedRemoveRequestSchema,
  entriesOf,
  fitWindow,
  isItemKind,
  ITEM_KINDS,
  itemCut,
  itemText,
  itemUnits,
  MAX_MESSAGE_TEXT,
  MAX_PAGE_UNITS,
  MAX_WINDOW_UNITS,
  PAGE_ENTRIES,
  RESERVED_ITEM_KINDS,
  sameEntry,
  SET_ASIDE_STORE,
  SetAsideRemoveRequestSchema,
  WINDOW_ENTRIES,
  ITEM_STATES,
  turnElapsedMs,
} from './conversation';

const A = '11111111-1111-4111-8111-111111111111';

function item(turn: number, place: number, text = 'x', patch: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: `i-${turn}-${place}`, conversationId: A, turnId: `t-${turn}`, order: { turn, item: place }, kind: 'message', origin: 'local', providerItemId: null, workerId: null, activity: null, interaction: null, role: 'assistant', phase: 'final', model: null, state: 'complete',
    blocks: [{ type: 'text', text, cut: false }], questions: [], notice: null, detail: null, time: { receivedAt: 5, providerAt: null }, ...patch,
  };
}

describe('items and turns (V1; C1–C5)', () => {
  it('names the kinds M18 produces apart from the ones it only reserves (C3)', () => {
    // From M20a an activity is produced, and no longer only reserved (M20a, C3); from M21 an interaction (M21, C4).
    expect(ITEM_KINDS).toEqual(['message', 'notice', 'activity', 'interaction']);
    expect(RESERVED_ITEM_KINDS).toEqual(['attachment', 'branch']);
    for (const kind of [...ITEM_KINDS, ...RESERVED_ITEM_KINDS]) expect(isItemKind(kind)).toBe(true);
    for (const kind of ['tool', '', 7, null]) expect(isItemKind(kind)).toBe(false);
  });

  it('orders by the stored places alone: never by text, time or arrival (C2, C49)', () => {
    // Texts, times and array positions all say the opposite of the places.
    const first = item(1, 2, 'zzz', { time: { receivedAt: 900, providerAt: 900 } });
    const second = item(2, 1, 'aaa', { time: { receivedAt: 1, providerAt: 1 } });
    const third = item(2, 2, 'mmm', { time: { receivedAt: null, providerAt: null } });
    expect([third, second, first].sort(compareItems).map((entry) => entry.id)).toEqual(['i-1-2', 'i-2-1', 'i-2-2']);
  });

  it('keeps an item’s id whatever its place becomes (C2)', () => {
    const before = item(3, 1);
    const moved = { ...before, order: { turn: 9, item: 1 } };
    expect(moved.id).toBe(before.id);
  });

  it('keeps the provider’s times apart from fat-g’s own, each null when unknown (C4)', () => {
    const turn: ConversationTurn = {
      id: 't', place: 1, origin: 'provider', state: 'ended', outcome: 'completed', gap: false, mode: null,
      time: { acceptedAt: null, providerStartedAt: 1_000, providerEndedAt: 3_000, endReceivedAt: null, providerDurationMs: 1_500, elapsedMs: null },
    };
    // A provider's duration is its own word, not the difference of two of its times.
    expect(turn.time.providerDurationMs).not.toBe((turn.time.providerEndedAt ?? 0) - (turn.time.providerStartedAt ?? 0));
    expect(turn.time.acceptedAt).toBeNull();
    const read = item(1, 1, 'x', { origin: 'provider', time: { receivedAt: null, providerAt: 1_000 } });
    expect(read.time).toEqual({ receivedAt: null, providerAt: 1_000 });
  });

  it('has a worker beside a turn, not inside it: a turn’s shape holds none (C5)', () => {
    const worker: ConversationWorker = { id: 'w', startedAt: 10, endedAt: null, outcome: null };
    const turn: ConversationTurn = { id: 't', place: 1, origin: 'local', state: 'ended', outcome: 'completed', gap: false, mode: null, time: { acceptedAt: 1, providerStartedAt: null, providerEndedAt: null, endReceivedAt: 5, providerDurationMs: null, elapsedMs: null } };
    // The turn has ended, and the worker has not.
    expect(turn.state).toBe('ended');
    expect(worker.endedAt).toBeNull();
    expect(Object.keys(turn)).not.toContain('workers');
  });

  it('reads an item’s text and its cut mark from its blocks', () => {
    const cut = item(1, 1, 'a', { blocks: [{ type: 'text', text: 'a', cut: false }, { type: 'text', text: 'b', cut: true }] });
    expect(itemText(cut)).toBe('a\nb');
    expect(itemCut(cut)).toBe(true);
    expect(itemCut(item(1, 1))).toBe(false);
  });
});

describe('the limits (V1, V8; C17, C58)', () => {
  it('are named once', () => {
    expect({ MAX_MESSAGE_TEXT, PAGE_ENTRIES, MAX_PAGE_UNITS, WINDOW_ENTRIES, MAX_WINDOW_UNITS }).toEqual({ MAX_MESSAGE_TEXT: 100_000, PAGE_ENTRIES: 100, MAX_PAGE_UNITS: 1_000_000, WINDOW_ENTRIES: 500, MAX_WINDOW_UNITS: 5_000_000 });
  });

  it('counts an item’s size in UTF-16 units of its text, questions and detail', () => {
    expect(itemUnits(item(1, 1, 'abc'))).toBe(3);
    expect(itemUnits(item(1, 1, '😀'))).toBe(2);
    expect(itemUnits(item(1, 1, 'ab', { questions: [{ title: 'cd', options: ['e', 'fg'] }], detail: 'hij' }))).toBe(10);
  });

  it('bounds a list by count, keeping the newest or the oldest', () => {
    const items = Array.from({ length: 7 }, (_, n) => item(1, n + 1));
    expect(boundItems(items, 'newest', 3, 1_000)).toEqual({ items: items.slice(4), cut: true });
    expect(boundItems(items, 'oldest', 3, 1_000)).toEqual({ items: items.slice(0, 3), cut: true });
    expect(boundItems(items, 'newest', 7, 1_000)).toEqual({ items, cut: false });
  });

  it('bounds a list by size, ending before it passes the bound, with one item at least', () => {
    const items = [item(1, 1, 'x'.repeat(40)), item(1, 2, 'x'.repeat(40)), item(1, 3, 'x'.repeat(40))];
    expect(boundItems(items, 'newest', 10, 100).items).toEqual(items.slice(1));
    expect(boundItems(items, 'oldest', 10, 100).items).toEqual(items.slice(0, 2));
    // One item over the bound by itself is still given.
    expect(boundItems(items, 'newest', 10, 10)).toEqual({ items: items.slice(2), cut: true });
    expect(boundItems([], 'newest', 10, 10)).toEqual({ items: [], cut: false });
  });

  it('holds a window to 500 items', () => {
    const items = Array.from({ length: WINDOW_ENTRIES + 20 }, (_, n) => item(1, n + 1));
    const newest = fitWindow(items, 'newest');
    expect(newest.items).toHaveLength(WINDOW_ENTRIES);
    expect(newest.items.at(-1)).toBe(items.at(-1));
    expect(fitWindow(items, 'oldest').items[0]).toBe(items[0]);
    expect(fitWindow(items.slice(0, 10), 'newest').cut).toBe(false);
  });
});

describe('entries (M20a, V6; C31)', () => {
  const activity = (turn: number, place: number, patch: Partial<ActivityBody> = {}): ConversationItem =>
    item(turn, place, '', { kind: 'activity', role: null, phase: null, blocks: [], activity: startedBody({ type: 'command', name: 'commandExecution', summary: 'ls', ...patch }) });
  const ids = (list: readonly (readonly ConversationItem[])[]): string[][] => list.map((entry) => entry.map((entered) => entered.id));

  it('makes one entry of a turn’s consecutive activities, and one of each message and notice', () => {
    const items = [item(1, 1), activity(1, 2), activity(1, 3), item(1, 4), activity(1, 5), item(1, 6, 'n', { kind: 'notice', role: null }), activity(1, 7)];
    expect(ids(entriesOf(items))).toEqual([['i-1-1'], ['i-1-2', 'i-1-3'], ['i-1-4'], ['i-1-5'], ['i-1-6'], ['i-1-7']]);
  });

  it('ends a group at its turn: the next turn’s activities are another entry', () => {
    expect(ids(entriesOf([activity(1, 1), activity(1, 2), activity(2, 1)]))).toEqual([['i-1-1', 'i-1-2'], ['i-2-1']]);
    expect(sameEntry(activity(1, 1), activity(1, 2))).toBe(true);
    expect(sameEntry(activity(1, 1), activity(2, 1))).toBe(false);
    expect(sameEntry(item(1, 1), activity(1, 2))).toBe(false);
    expect(sameEntry(undefined, activity(1, 1))).toBe(false);
  });

  it('never makes a group of an item of a kind it only reserves', () => {
    const reserved = item(1, 2, '', { kind: 'attachment', role: null, blocks: [] });
    expect(ids(entriesOf([activity(1, 1), reserved, { ...reserved, id: 'i-1-3' }]))).toEqual([['i-1-1'], ['i-1-2'], ['i-1-3']]);
  });

  it('counts a group as one entry, and keeps it whole or not at all', () => {
    // A prompt, a group of fifty, an answer: three entries, fifty-two items.
    const turn = (n: number): ConversationItem[] => [item(n, 1), ...Array.from({ length: 50 }, (_, place) => activity(n, place + 2)), item(n, 52)];
    const items = [...turn(1), ...turn(2)];
    expect(boundItems(items, 'newest', 4, 1_000_000).items.map((entered) => entered.id)).toEqual(['i-1-52', ...turn(2).map((entered) => entered.id)]);
    // The group does not fit beside the answer: none of it is kept.
    const newest = boundItems(items, 'newest', 1, 1_000_000);
    expect(newest).toEqual({ items: [items.at(-1)], cut: true });
    const oldest = boundItems(items, 'oldest', 2, 1_000_000);
    expect(oldest.items).toHaveLength(51);
    expect(oldest.items.at(-1)?.id).toBe('i-1-51');
  });

  it('counts an activity’s whole body in its units, and a group’s together', () => {
    const big = activity(1, 2, { input: 'x'.repeat(40), output: 'y'.repeat(50) });
    expect(itemUnits(big)).toBe('commandExecution'.length + 'ls'.length + 90);
    const items = [item(1, 1, 'x'.repeat(10)), big, { ...big, id: 'i-1-3', order: { turn: 1, item: 3 } }, item(1, 4, 'x'.repeat(10))];
    // The answer and the group pass the bound together: the group goes whole.
    expect(boundItems(items, 'newest', 10, 150).items.map((entered) => entered.id)).toEqual(['i-1-4']);
    expect(boundItems(items, 'newest', 10, 230).items.map((entered) => entered.id)).toEqual(['i-1-2', 'i-1-3', 'i-1-4']);
    // One entry at least, though it is over the bound by itself.
    expect(boundItems(items.slice(1, 3), 'newest', 10, 10)).toEqual({ items: items.slice(1, 3), cut: false });
  });

  it('answers the very list when nothing is let go', () => {
    const items = [item(1, 1), activity(1, 2)];
    expect(boundItems(items, 'newest', 10, 1_000).items).toBe(items);
  });

  it('counts a conversation of messages alone as it always did', () => {
    const items = Array.from({ length: PAGE_ENTRIES + 5 }, (_, n) => item(n + 1, 1));
    expect(boundItems(items, 'newest', PAGE_ENTRIES, MAX_PAGE_UNITS).items).toHaveLength(PAGE_ENTRIES);
  });
});

describe('capabilities (V1; C6)', () => {
  const descriptor = (capabilities: object) => ({ capabilities });

  it('answers supported only for a capability the descriptor declares', () => {
    expect(CHAT_CAPABILITIES).toEqual(['history']);
    expect(chatCapability(descriptor({ sessions: true, history: true }), 'history')).toBe('supported');
    expect(chatCapability(descriptor({ sessions: true, history: false }), 'history')).toBe('unsupported');
  });

  it('answers unsupported for every name the descriptor does not declare, whatever the sessions flag says', () => {
    // A descriptor written before the capability existed.
    expect(chatCapability(descriptor({ sessions: true }), 'history')).toBe('unsupported');
    // A reserved kind's name enables nothing, and neither does a flag that is not a chat capability.
    for (const name of ['attachments', 'forks', 'activity', 'sessions', '', 'constructor']) {
      expect(chatCapability(descriptor({ sessions: true, history: true, attachments: true, forks: true }), name), name).toBe('unsupported');
    }
  });
});

describe('the conversations channels (V11; C24, C41)', () => {
  it('read a detached conversation by its id, with a cursor or without', () => {
    expect(DetachedReadRequestSchema.safeParse({ id: A }).success).toBe(true);
    expect(DetachedReadRequestSchema.safeParse({ id: A, before: 'item-1' }).success).toBe(true);
    expect(DetachedReadRequestSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(DetachedReadRequestSchema.safeParse({ id: A, path: 'C:\\x' }).success).toBe(false);
  });

  it('remove named conversations or all of them, and nothing else', () => {
    expect(DetachedRemoveRequestSchema.safeParse({ ids: [A] }).success).toBe(true);
    expect(DetachedRemoveRequestSchema.safeParse({ all: true }).success).toBe(true);
    for (const request of [{ ids: [] }, { all: false }, { ids: [A], all: true }, { ids: ['x'] }, {}]) expect(DetachedRemoveRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
  });

  // M19 (C15, C43, C44): an item's state, and the one duration the Elapsed line shows.
  it('has three states for an item, and shows a turn’s elapsed time only once the provider’s end is known', () => {
    expect([...ITEM_STATES]).toEqual(['complete', 'streaming', 'partial']);
    const time = { acceptedAt: 1, providerStartedAt: null, providerEndedAt: null, endReceivedAt: 9, providerDurationMs: 700, elapsedMs: 1_500 };
    const turn = (state: ConversationTurn['state'], origin: ConversationTurn['origin'], patch: Partial<ConversationTurn['time']> = {}): ConversationTurn => ({ id: 't', place: 1, origin, state, outcome: null, gap: false, mode: null, time: { ...time, ...patch } });
    // A turn fat-g ran: its own measure. One read from history: the provider's duration, or nothing.
    expect(turnElapsedMs(turn('ended', 'local'))).toBe(1_500);
    expect(turnElapsedMs(turn('ended', 'provider'))).toBe(700);
    expect(turnElapsedMs(turn('ended', 'provider', { providerDurationMs: null }))).toBeNull();
    expect(turnElapsedMs(turn('ended', 'local', { elapsedMs: null }))).toBeNull();
    // A turn that runs, is unfinished or was never confirmed shows none, whatever is stored.
    for (const state of ['running', 'unfinished', 'unacknowledged'] as const) expect(turnElapsedMs(turn(state, 'local')), state).toBeNull();
  });

  it('take a set-aside store only by the name Start fresh gives one', () => {
    const name = 'conversations.set-aside.2020-01-25T14-03-12Z.sqlite';
    expect(SET_ASIDE_STORE.test(name)).toBe(true);
    expect(SET_ASIDE_STORE.test('conversations.set-aside.2020-01-25T14-03-12Z-2.sqlite')).toBe(true);
    expect(SetAsideRemoveRequestSchema.safeParse({ names: [name] }).success).toBe(true);
    expect(SetAsideRemoveRequestSchema.safeParse({ all: true }).success).toBe(true);
    for (const other of ['conversations.sqlite', 'records.json', `..\\${name}`, `${name}-wal`, 'conversations.set-aside.2020-01-25T14-03-12Z.json', `x/${name}`, 'records.set-aside.2020-01-25T14-03-12Z.json']) {
      expect(SetAsideRemoveRequestSchema.safeParse({ names: [other] }).success, other).toBe(false);
    }
  });
});
