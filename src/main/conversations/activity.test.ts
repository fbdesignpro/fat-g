// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6 (docs/planning/_archive/M20a.md; S7, C11, C20, C28, C29, C31–C33, C35, C58): what the store keeps of a
// session's work, on a real file — an activity written at its start and ended by an update of named
// keys, what each end leaves, a worker's items under its turn and out of the session's pages, a
// window counted in entries, the history check's completion and insertion, and a removal that
// leaves no text.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ActivityStart, MAX_ACTIVITY_OUTPUT } from '@shared/contracts/activity';
import type { HistoryActivity, HistoryMessage, HistoryTurn } from '@shared/contracts/agent-events';
import { type ConversationItem, MAX_PAGE_UNITS, MAX_WINDOW_UNITS, PAGE_ENTRIES, WINDOW_ENTRIES } from '@shared/contracts/conversation';
import { CONVERSATIONS_VERSION, NEEDED_COLUMNS, SCHEMA, STORE_FILE } from './format';
import { listedTurn, planTurn } from './merge';
import type { ConversationStore, NewActivity, NewItem } from './store';
import { CONVERSATION, OTHER, type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

let made = 0;
const COMMAND: ActivityStart = { type: 'command', name: 'commandExecution', summary: 'rg --files', input: '"pwsh" -Command "rg --files"', files: [] };
function activity(providerItemId: string, patch: Partial<NewActivity> = {}, start: Partial<ActivityStart> = {}): NewActivity {
  made += 1;
  return { id: `activity-${made}`, origin: 'local', providerItemId, workerId: null, start: { ...COMMAND, ...start }, receivedAt: 10, providerAt: null, ...patch };
}
function message(text: string, patch: Partial<NewItem> = {}): NewItem {
  made += 1;
  return { id: `item-${made}`, kind: 'message', origin: 'local', providerItemId: null, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 10, providerAt: null, ...patch };
}
const accept = (store: ConversationStore, turnId: string, text = 'a prompt', conversationId = CONVERSATION) => store.acceptPrompt({ conversationId, turnId, itemId: `prompt-${turnId}`, text, at: 5, started: false });
/** A row's body as it is on disk: what the store's own reads make of it is another matter. */
const rawBody = (id: string): Record<string, unknown> => area.raw((db) => JSON.parse(String((db.prepare('SELECT body FROM item WHERE id = ?').get(id) as { body: string }).body)) as Record<string, unknown>);
const rawActivity = (id: string): Record<string, unknown> => rawBody(id)['activity'] as Record<string, unknown>;
const ids = (items: readonly ConversationItem[]): string[] => items.map((item) => item.id);

describe('the format, version 3 (S7, C28)', () => {
  it('has the worker’s column on an item, and an index by conversation, worker and place', () => {
    area.open();
    expect(NEEDED_COLUMNS['item']).toContain('workerId');
    expect(SCHEMA.join('\n')).toContain('CREATE INDEX item_worker ON item (conversationId, workerId, place)');
    area.raw((db) => {
      expect((db.prepare('SELECT name FROM pragma_table_info(?)').all('item') as { name: string }[]).map((row) => row.name)).toContain('workerId');
      expect((db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all('item_worker') as { name: string }[]).map((row) => row.name)).toEqual(['conversationId', 'workerId', 'place']);
      // The column and the index are version 3's; the store's version has moved on since (M20b, C27).
      expect(db.prepare('SELECT schemaVersion, minReaderVersion FROM meta WHERE id = 1').get()).toEqual({ schemaVersion: CONVERSATIONS_VERSION, minReaderVersion: CONVERSATIONS_VERSION });
    });
  });

  it('reads a row of a kind it does not know as a reserved kind, never as an activity', () => {
    const store = area.open();
    accept(store, 't1');
    area.raw((db) => db.prepare("INSERT INTO item (id, conversationId, turnId, place, kind, origin, body) VALUES ('later', ?, 't1', 2, 'a-later-kind', 'local', ?)").run(CONVERSATION, JSON.stringify({ activity: { type: 'command' } })));
    const item = store.newestPage(CONVERSATION).items.find((entry) => entry.id === 'later');
    // The first kind still reserved (M21, C4, C32): `interaction` has its body now, and is drawn.
    expect(item).toMatchObject({ kind: 'attachment', activity: null, interaction: null, blocks: [] });
  });
});

describe('an activity, as it is written (C28, C29)', () => {
  it('is a row from its start: its body under a key of its own, running and not complete', () => {
    const store = area.open();
    accept(store, 't1');
    const started = store.addActivity(CONVERSATION, 't1', activity('call-1', { providerAt: 1_579_924_800_000 }, { files: [{ path: 'src/tides.js', line: 12 }] }));
    expect(started.opened).toBe(true);
    expect(rawBody(started.item.id)).toEqual({
      activity: { type: 'command', name: 'commandExecution', summary: 'rg --files', input: '"pwsh" -Command "rg --files"', output: null, files: [{ path: 'src/tides.js', line: 12 }], status: 'running', exitCode: null, changes: [], steps: [], thinking: null, workerId: null, duration: null, cut: null, declinedBy: null, model: null, agentType: null },
      complete: false,
    });
    expect(started.item).toMatchObject({ kind: 'activity', turnId: 't1', order: { turn: 1, item: 2 }, origin: 'local', providerItemId: 'call-1', workerId: null, role: null, blocks: [], time: { receivedAt: 10, providerAt: 1_579_924_800_000 } });
  });

  it('reads an activity whose end is not stored as unfinished and partial: the store knows nothing that runs', () => {
    const store = area.open();
    accept(store, 't1');
    const { item } = store.addActivity(CONVERSATION, 't1', activity('call-1'));
    expect(item.state).toBe('partial');
    expect(item.activity?.status).toBe('unfinished');
    // As after a crash: a store opened again claims nothing either.
    store.close();
    expect(area.open().newestPage(CONVERSATION).items.at(-1)?.activity?.status).toBe('unfinished');
    expect(rawActivity(item.id)['status']).toBe('running');
  });

  it('is ended by an update of its body’s named keys: the row’s id, place and time stay, and so does every key it does not know', () => {
    const store = area.open();
    accept(store, 't1');
    const { item } = store.addActivity(CONVERSATION, 't1', activity('call-1'));
    // What a later build wrote: a key beside the activity, and one inside it.
    area.raw((db) => db.prepare("UPDATE item SET body = json_set(body, '$.later', 'kept', '$.activity.later', json('{\"deep\":1}')) WHERE id = ?").run(item.id));
    const ended = store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status: 'completed', output: 'a.md\nb.md\n', exitCode: 0, duration: { ms: 0, provenance: 'provider' } });
    expect(ended?.item).toMatchObject({ id: item.id, order: item.order, time: item.time, state: 'complete' });
    expect(ended?.item.activity).toMatchObject({ status: 'completed', output: 'a.md\nb.md\n', exitCode: 0, duration: { ms: 0, provenance: 'provider' }, input: '"pwsh" -Command "rg --files"' });
    const body = rawBody(item.id);
    expect(body['complete']).toBe(true);
    expect(body['later']).toBe('kept');
    expect(rawActivity(item.id)['later']).toEqual({ deep: 1 });
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM item').get())).toEqual({ n: 2 });
  });

  it.each(['failed', 'completed'] as const)('an end that reads %s is complete either way: its end has come', (status) => {
    const store = area.open();
    accept(store, 't1');
    const { item } = store.addActivity(CONVERSATION, 't1', activity('call-1'));
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status, exitCode: status === 'failed' ? 2 : 0 });
    expect(rawBody(item.id)['complete']).toBe(true);
  });

  it('a second start for an item the turn holds replaces its body’s named keys, and opens nothing: a checklist’s each update (C59)', () => {
    const store = area.open();
    accept(store, 't1');
    const plan = (steps: ActivityStart['steps']) => activity('turn-1#plan', {}, { type: 'checklist', name: 'plan', summary: 'Tasks', input: null, steps: steps ?? [] });
    const first = store.addActivity(CONVERSATION, 't1', plan([{ text: 'List files', state: 'in-progress' }, { text: 'Read README', state: 'pending' }]));
    area.raw((db) => db.prepare("UPDATE item SET body = json_set(body, '$.activity.later', 'kept') WHERE id = ?").run(first.item.id));
    const second = store.addActivity(CONVERSATION, 't1', plan([{ text: 'List files', state: 'completed' }, { text: 'Read README', state: 'in-progress' }]));
    expect(second.opened).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.order).toEqual(first.item.order);
    expect(second.item.activity?.steps).toEqual([{ text: 'List files', state: 'completed' }, { text: 'Read README', state: 'in-progress' }]);
    expect(rawActivity(first.item.id)).toMatchObject({ status: 'running', later: 'kept' });
    expect(area.raw((db) => db.prepare("SELECT count(*) AS n FROM item WHERE kind = 'activity'").get())).toEqual({ n: 1 });
  });

  it('a second start gives a worker item the worker paired with it, and keeps what its end already said', () => {
    const store = area.open();
    accept(store, 't1');
    const agent = (start: Partial<ActivityStart>) => activity('tool-use-1', {}, { type: 'worker', name: 'Agent', summary: 'Read notes', ...start });
    const first = store.addActivity(CONVERSATION, 't1', agent({}));
    expect(first.item.activity?.workerId).toBeNull();
    const paired = store.addActivity(CONVERSATION, 't1', agent({ summary: 'Reads notes-3.txt', workerId: 'worker-9' }));
    expect(paired.item.activity).toMatchObject({ workerId: 'worker-9', summary: 'Reads notes-3.txt' });
    expect(store.workerItem(CONVERSATION, 'worker-9')?.id).toBe(first.item.id);
    expect(store.workerItem(CONVERSATION, 'no-such-worker')).toBeNull();
  });

  it('finds an activity by the provider’s id in its turn, for its owner: another turn’s, and a worker’s under the same id, are others', () => {
    const store = area.open();
    accept(store, 't1');
    accept(store, 't2');
    const own = store.addActivity(CONVERSATION, 't1', activity('same-id'));
    const workers = store.addActivity(CONVERSATION, 't1', activity('same-id', { workerId: 'w1' }));
    const later = store.addActivity(CONVERSATION, 't2', activity('same-id'));
    expect(new Set([own.item.id, workers.item.id, later.item.id]).size).toBe(3);
    expect([own.opened, workers.opened, later.opened]).toEqual([true, true, true]);
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'same-id', workerId: 'w1' }, { status: 'failed' });
    expect([rawActivity(own.item.id)['status'], rawActivity(workers.item.id)['status'], rawActivity(later.item.id)['status']]).toEqual(['running', 'failed', 'running']);
  });

  it('answers null for an end no start opened, and refuses an activity for a turn the conversation does not have', () => {
    const store = area.open();
    accept(store, 't1');
    expect(store.endActivity(CONVERSATION, 't1', { providerItemId: 'never-started', workerId: null }, { status: 'completed' })).toBeNull();
    expect(() => store.addActivity(CONVERSATION, 'no-such-turn', activity('call-1'))).toThrow('no-turn');
  });

  it('bounds what it is handed on the way in: an output past its bound is cut, and the row says so', () => {
    const store = area.open();
    accept(store, 't1');
    store.addActivity(CONVERSATION, 't1', activity('call-1'));
    const ended = store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status: 'completed', output: 'x'.repeat(MAX_ACTIVITY_OUTPUT + 77) });
    expect(ended?.item.activity?.output).toHaveLength(MAX_ACTIVITY_OUTPUT);
    expect(ended?.item.activity?.cut).toEqual({ fields: ['output'], output: { omitted: 77, at: MAX_ACTIVITY_OUTPUT / 2 }, files: 0, steps: 0, changes: 0 });
  });

  it('leaves nothing of an activity whose transaction throws, at its start or at its end', () => {
    let fail: string | null = 'activity';
    const store = area.open({ hook: (point) => { if (point === fail) throw new Error('disk full'); } });
    accept(store, 't1');
    expect(() => store.addActivity(CONVERSATION, 't1', activity('call-1'))).toThrow('disk full');
    expect(store.newestPage(CONVERSATION).items).toHaveLength(1);
    fail = 'activity-end';
    const { item } = store.addActivity(CONVERSATION, 't1', activity('call-1'));
    expect(() => store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status: 'completed', output: 'lost' })).toThrow('disk full');
    expect(rawActivity(item.id)).toMatchObject({ status: 'running', output: null });
  });
});

describe('what an end leaves (C6, C11, C29)', () => {
  function open(store: ConversationStore) {
    accept(store, 't1');
    const command = store.addActivity(CONVERSATION, 't1', activity('call-1')).item.id;
    const checklist = store.addActivity(CONVERSATION, 't1', activity('t1#plan', {}, { type: 'checklist', name: 'plan', summary: 'Tasks', steps: [{ text: 'one', state: 'in-progress' }] })).item.id;
    const workers = store.addActivity(CONVERSATION, 't1', activity('call-9', { workerId: 'w1' })).item.id;
    return { command, checklist, workers };
  }
  const statuses = (...items: string[]) => items.map((id) => [rawActivity(id)['status'], rawBody(id)['complete']]);

  it('at the provider’s end of a turn: the session’s open activity unfinished with what it has, its checklist completed, and a worker’s still running', () => {
    const store = area.open();
    const { command, checklist, workers } = open(store);
    expect(store.settleActivities(CONVERSATION, [{ id: command, status: 'unfinished' }, { id: checklist, status: 'completed' }])).toBe(2);
    expect(statuses(command, checklist, workers)).toEqual([['unfinished', false], ['completed', true], ['running', false]]);
    // With what it has: its input is as it was, and its steps as they last read.
    expect(rawActivity(command)['input']).toBe('"pwsh" -Command "rg --files"');
    expect(rawActivity(checklist)['steps']).toEqual([{ text: 'one', state: 'in-progress' }]);
  });

  it('at a quit or a lost process: every open one unfinished, a worker’s included', () => {
    const store = area.open();
    const { command, workers } = open(store);
    store.settleActivities(CONVERSATION, [{ id: command, status: 'unfinished' }, { id: workers, status: 'unfinished' }]);
    expect(statuses(command, workers)).toEqual([['unfinished', false], ['unfinished', false]]);
  });

  it('leaves one that has ended meanwhile as it is, and changes nothing for no item', () => {
    const store = area.open();
    const { command } = open(store);
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status: 'completed', output: 'done' });
    expect(store.settleActivities(CONVERSATION, [{ id: command, status: 'unfinished' }])).toBe(0);
    expect(statuses(command)).toEqual([['completed', true]]);
    expect(store.settleActivities(CONVERSATION, [])).toBe(0);
    // Another conversation's id changes nothing of this one.
    expect(store.settleActivities(OTHER, [{ id: command, status: 'unfinished' }])).toBe(0);
  });

  it('a completion that comes after its turn’s end still ends an unfinished item (C6)', () => {
    const store = area.open();
    const { command } = open(store);
    store.settleActivities(CONVERSATION, [{ id: command, status: 'unfinished' }]);
    store.providerEnded(CONVERSATION, 't1', 'interrupted', 20);
    const late = store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status: 'completed', output: 'late', exitCode: 0 });
    expect(late?.item).toMatchObject({ id: command, state: 'complete' });
    expect(statuses(command)).toEqual([['completed', true]]);
    // The turn's end is as it was: a late item changes none.
    expect(store.turn(CONVERSATION, 't1')).toMatchObject({ providerOutcome: 'interrupted', endReceivedAt: 20 });
  });

  it('keeps a duration as it was handed, with whose it is: a clock moved during the item changes none (C35)', () => {
    const store = area.open({ now: () => 1 });
    accept(store, 't1');
    const { item } = store.addActivity(CONVERSATION, 't1', activity('call-1', { receivedAt: 9_000_000 }));
    // The wall clock went back between the start and the end: the duration is the span main measured.
    const ended = store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status: 'completed', duration: { ms: 1_234, provenance: 'local' } });
    expect(ended?.item.activity?.duration).toEqual({ ms: 1_234, provenance: 'local' });
    expect(ended?.item.time.receivedAt).toBe(9_000_000);
    expect(rawActivity(item.id)['duration']).toEqual({ ms: 1_234, provenance: 'local' });
  });
});

describe('a worker’s items (C20, C28, C31, C32)', () => {
  it('are stored under its id in the turn that started it, late or not, and change no end', () => {
    const store = area.open();
    accept(store, 't1');
    store.addItem(CONVERSATION, 't1', message('The sub-agent is reading.', { providerItemId: 'own-1', phase: 'commentary' }));
    store.addActivity(CONVERSATION, 't1', activity('w-call-1', { workerId: 'w1' }));
    store.providerEnded(CONVERSATION, 't1', 'completed', 20, 'own-1');
    const ended = store.turn(CONVERSATION, 't1');
    // After the provider's end of the turn: still its turn's.
    const late = store.addActivity(CONVERSATION, 't1', activity('w-call-2', { workerId: 'w1' }));
    store.addItem(CONVERSATION, 't1', message('The file holds one line.', { providerItemId: 'w-final', workerId: 'w1' }));
    expect(late.item).toMatchObject({ turnId: 't1', workerId: 'w1' });
    expect(store.turn(CONVERSATION, 't1')).toEqual(ended);
  });

  it('never is the turn’s answer: the end that names one settles the session’s own message, though a worker’s final message came later', () => {
    const store = area.open();
    accept(store, 't1');
    store.addItem(CONVERSATION, 't1', message('Miso.', { providerItemId: 'answer', phase: 'commentary' }));
    store.addItem(CONVERSATION, 't1', message('The file holds one line.', { providerItemId: 'answer', phase: 'commentary', workerId: 'w1' }));
    store.providerEnded(CONVERSATION, 't1', 'completed', 20, 'answer');
    const own = store.newestPage(CONVERSATION).items.find((item) => item.providerItemId === 'answer');
    expect(own).toMatchObject({ workerId: null, phase: 'final' });
    expect(store.workerItems(CONVERSATION, 'w1')?.items[0]).toMatchObject({ workerId: 'w1', phase: 'commentary' });
  });

  it('are in none of the session’s reads: its newest page, a page before, a window, the cursors and the marks', () => {
    const store = area.open();
    accept(store, 't1');
    store.addActivity(CONVERSATION, 't1', activity('w-call-1', { workerId: 'w1' }));
    const own = store.addItem(CONVERSATION, 't1', message('own'))?.item;
    store.addItem(CONVERSATION, 't1', message('worker’s', { workerId: 'w1' }));
    accept(store, 't2');
    const newest = store.newestPage(CONVERSATION);
    expect(ids(newest.items)).toEqual(['prompt-t1', own?.id, 'prompt-t2']);
    expect(newest).toMatchObject({ older: false, latest: true });
    expect(ids(store.pageBefore(CONVERSATION, 'prompt-t2')?.items ?? [])).toEqual(['prompt-t1', own?.id]);
    expect(ids(store.window(CONVERSATION, 'prompt-t1', 'oldest')?.items ?? [])).toEqual(['prompt-t1', own?.id, 'prompt-t2']);
    // A worker's item is no cursor of the session's.
    const workers = store.workerItems(CONVERSATION, 'w1')?.items ?? [];
    expect(store.pageBefore(CONVERSATION, workers[0]?.id ?? '')).toBeNull();
    expect(store.window(CONVERSATION, workers[0]?.id ?? '', 'newest')).toBeNull();
  });

  it('are read by the worker’s own read: newest first, then by pages before a cursor, across the entry bound', () => {
    const store = area.open({ synchronous: 'OFF' });
    accept(store, 't1');
    const total = WINDOW_ENTRIES + PAGE_ENTRIES + 30;
    for (let n = 1; n <= total; n += 1) store.addItem(CONVERSATION, 't1', message(`w ${n}`, { workerId: 'w1' }));
    store.addItem(CONVERSATION, 't1', message('another worker’s', { workerId: 'w2' }));
    const newest = store.workerItems(CONVERSATION, 'w1');
    expect(newest?.items).toHaveLength(WINDOW_ENTRIES);
    expect(newest?.items.at(-1)?.blocks[0]?.text).toBe(`w ${total}`);
    expect(newest).toMatchObject({ older: true, latest: true });
    const page = store.workerItems(CONVERSATION, 'w1', newest?.items[0]?.id);
    expect(page?.items).toHaveLength(PAGE_ENTRIES);
    expect(page?.items.at(-1)?.blocks[0]?.text).toBe(`w ${total - WINDOW_ENTRIES}`);
    expect(page).toMatchObject({ older: true, latest: false });
    const first = store.workerItems(CONVERSATION, 'w1', page?.items[0]?.id);
    expect(first?.items.map((item) => item.blocks[0]?.text)).toEqual(Array.from({ length: 30 }, (_, n) => `w ${n + 1}`));
    expect(first?.older).toBe(false);
    // Nothing lost and nothing twice, and none of another worker's.
    const all = [...(first?.items ?? []), ...(page?.items ?? []), ...(newest?.items ?? [])];
    expect(new Set(all.map((item) => item.id)).size).toBe(total);
    expect(all.every((item) => item.workerId === 'w1')).toBe(true);
    expect(newest?.turns.map((turn) => turn.id)).toEqual(['t1']);
  });

  it('ends a worker’s page before its text passes the size bound, and takes no cursor that is not that worker’s', () => {
    const store = area.open({ synchronous: 'OFF' });
    accept(store, 't1');
    const big = 'x'.repeat(90_000);
    const count = Math.ceil(MAX_WINDOW_UNITS / big.length) + 20;
    for (let n = 1; n <= count; n += 1) store.addItem(CONVERSATION, 't1', message(big, { workerId: 'w1' }));
    const newest = store.workerItems(CONVERSATION, 'w1');
    expect(newest?.items.length).toBe(Math.floor(MAX_WINDOW_UNITS / big.length));
    const page = store.workerItems(CONVERSATION, 'w1', newest?.items[0]?.id);
    expect(page?.items.length).toBe(Math.floor(MAX_PAGE_UNITS / big.length));
    expect(store.workerItems(CONVERSATION, 'w1', 'prompt-t1')).toBeNull();
    expect(store.workerItems(CONVERSATION, 'w1', 'no-such-item')).toBeNull();
    // A worker the store holds nothing of: no item, and nothing older.
    expect(store.workerItems(CONVERSATION, 'nobody')).toEqual({ items: [], turns: [], older: false, latest: true });
  });

  it('finds the item that started a worker which has no item of its own yet, among the newest turns', () => {
    const store = area.open();
    accept(store, 't1');
    const started = store.addActivity(CONVERSATION, 't1', activity('sub-agent-item', {}, { type: 'worker', name: 'subAgentActivity', summary: 'Worker 1', workerId: 'thread-9' }));
    accept(store, 't2');
    expect(store.workerItem(CONVERSATION, 'thread-9')).toMatchObject({ id: started.item.id, workerId: null, activity: { type: 'worker', workerId: 'thread-9', summary: 'Worker 1' } });
    // Once the worker has items, by their turn.
    store.addActivity(CONVERSATION, 't1', activity('w-call', { workerId: 'thread-9' }));
    expect(store.workerItem(CONVERSATION, 'thread-9')?.id).toBe(started.item.id);
    expect(store.workerItem(OTHER, 'thread-9')).toBeNull();
  });
});

describe('pages and windows, in entries (C31)', () => {
  /** A turn of a prompt, `tools` activities and an answer: three entries. */
  function turn(store: ConversationStore, n: number, tools: number, output = ''): void {
    accept(store, `t${n}`, `prompt ${n}`);
    for (let tool = 1; tool <= tools; tool += 1) {
      store.addActivity(CONVERSATION, `t${n}`, activity(`call-${n}-${tool}`));
      store.endActivity(CONVERSATION, `t${n}`, { providerItemId: `call-${n}-${tool}`, workerId: null }, { status: 'completed', output });
    }
    store.addItem(CONVERSATION, `t${n}`, message(`answer ${n}`));
  }
  const groupsOf = (items: readonly ConversationItem[]): number[] => {
    const sizes: number[] = [];
    let last: ConversationItem | undefined;
    for (const item of items) {
      if (item.kind === 'activity' && last?.kind === 'activity' && last.turnId === item.turnId) sizes[sizes.length - 1] = (sizes.at(-1) ?? 0) + 1;
      else if (item.kind === 'activity') sizes.push(1);
      last = item;
    }
    return sizes;
  };

  it('counts a turn’s consecutive activities as one entry: a page of 100 entries holds far more items', () => {
    const store = area.open({ synchronous: 'OFF' });
    for (let n = 1; n <= 40; n += 1) turn(store, n, 12);
    const page = store.newestPage(CONVERSATION);
    // 100 entries: the newest 33 turns whole, and the answer of the one before.
    expect(page.items).toHaveLength(33 * 14 + 1);
    expect(page.items[0]?.blocks[0]?.text).toBe('answer 7');
    expect(groupsOf(page.items)).toEqual(Array.from({ length: 33 }, () => 12));
    expect(page).toMatchObject({ older: true, latest: true });
  });

  it('never splits a group: the page before a cursor ends at an entry’s boundary, with none lost and none twice', () => {
    const store = area.open({ synchronous: 'OFF' });
    for (let n = 1; n <= 80; n += 1) turn(store, n, 7);
    const seen: ConversationItem[] = [];
    let page = store.newestPage(CONVERSATION);
    for (;;) {
      seen.unshift(...page.items);
      expect(groupsOf(page.items).every((size) => size === 7), 'a group is whole').toBe(true);
      if (!page.older) break;
      const before = store.pageBefore(CONVERSATION, page.items[0]?.id ?? '');
      if (before === null) throw new Error('the cursor was not found');
      page = before;
    }
    expect(seen).toHaveLength(80 * 9);
    expect(new Set(ids(seen)).size).toBe(80 * 9);
    expect(seen[0]?.blocks[0]?.text).toBe('prompt 1');
  });

  it('holds a window to 500 entries, a group one of them, keeping the newest or the oldest', () => {
    const store = area.open({ synchronous: 'OFF' });
    for (let n = 1; n <= 200; n += 1) turn(store, n, 3);
    const newest = store.window(CONVERSATION, 'prompt-t1', 'newest');
    // 500 entries from the end: 166 turns whole, and the group and the answer of the one before.
    expect(newest?.items).toHaveLength(166 * 5 + 4);
    expect(newest?.items.at(-1)?.blocks[0]?.text).toBe('answer 200');
    expect(newest?.items[0]?.kind).toBe('activity');
    expect(groupsOf(newest?.items ?? []).every((size) => size === 3)).toBe(true);
    const oldest = store.window(CONVERSATION, 'prompt-t1', 'oldest');
    expect(oldest?.items).toHaveLength(166 * 5 + 4);
    expect(oldest?.items[0]?.blocks[0]?.text).toBe('prompt 1');
    expect(oldest?.items.at(-1)?.kind).toBe('activity');
    expect(oldest).toMatchObject({ older: false, latest: false });
  });

  it('cuts a page by its units too, counting an activity’s whole body, and gives a group that is over the bound by itself', () => {
    const store = area.open({ synchronous: 'OFF' });
    const output = 'y'.repeat(MAX_ACTIVITY_OUTPUT);
    for (let n = 1; n <= 3; n += 1) turn(store, n, 30, output);
    const page = store.newestPage(CONVERSATION);
    // A group of 30 outputs is some 600,000 units: the newest turn fits a page of 1,000,000 with the
    // answer before it, and the group before that does not, so the page ends there, at its boundary.
    expect(page.items).toHaveLength(33);
    expect(page.items[0]?.blocks[0]?.text).toBe('answer 2');
    expect(page.items[1]?.blocks[0]?.text).toBe('prompt 3');
    expect(groupsOf(page.items)).toEqual([30]);
    // One entry at least: a group that passes the bound by itself is still given whole.
    const huge = area.open({ dir: area.dir, synchronous: 'OFF' });
    accept(huge, 'big', 'prompt');
    for (let tool = 1; tool <= 60; tool += 1) {
      huge.addActivity(CONVERSATION, 'big', activity(`big-${tool}`));
      huge.endActivity(CONVERSATION, 'big', { providerItemId: `big-${tool}`, workerId: null }, { status: 'completed', output });
    }
    expect(huge.newestPage(CONVERSATION).items).toHaveLength(60);
  });

  it('counts a conversation of messages alone as it always did: 100 a page', () => {
    const store = area.open({ synchronous: 'OFF' });
    for (let n = 1; n <= 130; n += 1) accept(store, `t${n}`, `prompt ${n}`);
    expect(store.newestPage(CONVERSATION).items).toHaveLength(PAGE_ENTRIES);
  });
});

describe('the history check, for activities (C19, C24, C58)', () => {
  const historyTurn: HistoryTurn = { turnId: 'p-1', outcome: 'completed', startedAt: 1_000, endedAt: 3_000, durationMs: 1_900 };
  const user: HistoryMessage = { role: 'user', itemId: 'h-user', phase: null, text: 'a prompt', turnId: 'p-1', clientId: 'prompt-t1', at: 1_000, order: 0 };
  const answer: HistoryMessage = { role: 'assistant', itemId: 'h-answer', phase: 'final', text: 'Two files.', turnId: 'p-1', at: 1_000, order: 3 };
  const command = (itemId: string, order: number, patch: Partial<HistoryActivity> = {}): HistoryActivity => ({
    turnId: 'p-1', itemId, activityType: 'command', name: 'commandExecution', summary: 'rg --files', input: 'rg --files', status: 'completed', output: `out of ${itemId}`, exitCode: 0, durationMs: 0, at: 1_000, order, ...patch,
  });

  function live(store: ConversationStore): { readonly first: string; readonly second: string } {
    accept(store, 't1');
    store.providerTook(CONVERSATION, 't1', 'p-1');
    const first = store.addActivity(CONVERSATION, 't1', activity('call-1')).item.id;
    const second = store.addActivity(CONVERSATION, 't1', activity('call-2')).item.id;
    return { first, second };
  }

  it('holds a turn for the check while an activity of it is not complete, and not for a checklist or a worker’s item', () => {
    const store = area.open();
    const { first, second } = live(store);
    store.providerEnded(CONVERSATION, 't1', 'completed', 20);
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status: 'completed' });
    store.settleActivities(CONVERSATION, [{ id: second, status: 'unfinished' }]);
    expect(listedTurn(historyTurn, store.held(CONVERSATION))).toMatchObject({ read: true, stop: false });
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-2', workerId: null }, { status: 'failed' });
    expect(listedTurn(historyTurn, store.held(CONVERSATION)).read).toBe(false);
    // A checklist left running by a crash, and a worker's item that never ended, hold no turn: history returns neither.
    store.addActivity(CONVERSATION, 't1', activity('t1#plan', {}, { type: 'checklist', name: 'plan', summary: 'Tasks' }));
    store.addActivity(CONVERSATION, 't1', activity('w-call', { workerId: 'w1' }));
    expect(listedTurn(historyTurn, store.held(CONVERSATION)).read).toBe(false);
    // A worker's item is none of the session's history: the check is not handed it.
    const held = store.held(CONVERSATION).byProviderTurnId('p-1')?.items ?? [];
    expect(held.map((item) => item.providerItemId)).toEqual([null, 'call-1', 'call-2', 't1#plan']);
    expect(held.map((item) => item.id)).toContain(first);
  });

  it('completes a stored activity in place by the provider’s id: its id, place, time and unknown keys kept, and a second merge changes nothing', () => {
    const store = area.open();
    const { first, second } = live(store);
    store.settleActivities(CONVERSATION, [{ id: first, status: 'unfinished' }, { id: second, status: 'unfinished' }]);
    area.raw((db) => db.prepare("UPDATE item SET body = json_set(body, '$.activity.later', 'kept') WHERE id = ?").run(first));
    const before = store.newestPage(CONVERSATION).items;
    const plan = planTurn(historyTurn, [user, answer], 'full', store.held(CONVERSATION), [command('call-1', 1), command('call-2', 2, { status: 'failed', exitCode: 3, output: 'no' })]);
    expect(plan.kind === 'matched' ? plan.items.map((item) => item.kind) : []).toEqual(['name', 'complete-activity', 'complete-activity', 'add']);
    expect(store.mergePage(CONVERSATION, [plan], null, 'not shown').changed).toBe(true);
    const after = store.newestPage(CONVERSATION).items;
    expect(ids(after)).toEqual([...ids(before), after.at(-1)?.id]);
    expect(after[1]).toMatchObject({ id: first, order: before[1]?.order, time: before[1]?.time, state: 'complete', activity: { status: 'completed', output: 'out of call-1', exitCode: 0, duration: { ms: 0, provenance: 'provider' }, input: '"pwsh" -Command "rg --files"' } });
    expect(after[2]?.activity).toMatchObject({ status: 'failed', exitCode: 3, output: 'no' });
    expect(rawActivity(first)['later']).toBe('kept');
    // Whole now: the same history plans nothing for them, and writes nothing.
    const again = planTurn(historyTurn, [user, answer], 'full', store.held(CONVERSATION), [command('call-1', 1), command('call-2', 2)]);
    expect(again.kind === 'matched' ? again.items : ['x']).toEqual([]);
    expect(store.mergePage(CONVERSATION, [again], null, 'not shown').changed).toBe(false);
  });

  it('inserts one the store lacks in the provider’s order, and leaves one the history lacks as it is', () => {
    const store = area.open();
    const { first, second } = live(store);
    store.settleActivities(CONVERSATION, [{ id: first, status: 'unfinished' }, { id: second, status: 'unfinished' }]);
    // History has call-1, one the store never saw, and no call-2.
    const plan = planTurn(historyTurn, [user, { ...answer, order: 4 }], 'full', store.held(CONVERSATION), [command('call-0', 1), command('call-1', 2), command('call-1b', 3)]);
    store.mergePage(CONVERSATION, [plan], null, 'not shown');
    const items = store.newestPage(CONVERSATION).items;
    expect(items.map((item) => item.providerItemId)).toEqual(['h-user', 'call-0', 'call-1', 'call-2', 'call-1b', 'h-answer']);
    // Read from history: the provider's origin, no receipt of fat-g's, and its turn's time alone.
    expect(items[1]).toMatchObject({ kind: 'activity', origin: 'provider', workerId: null, state: 'complete', time: { receivedAt: null, providerAt: 1_000 }, activity: { status: 'completed', output: 'out of call-0' } });
    expect(items[3]).toMatchObject({ id: second, state: 'partial', activity: { status: 'unfinished' } });
  });

  it('leaves a stored activity unfinished where history says no more of it than that', () => {
    const store = area.open();
    const { first } = live(store);
    store.settleActivities(CONVERSATION, [{ id: first, status: 'unfinished' }]);
    const plan = planTurn(historyTurn, [user], 'full', store.held(CONVERSATION), [command('call-1', 1, { status: 'unfinished' })]);
    expect(plan.kind === 'matched' ? plan.items.map((item) => item.kind) : []).toEqual(['name']);
  });

  it('makes a turn the store lacks of its messages and activities together, in the provider’s order', () => {
    const store = area.open();
    store.ensure(CONVERSATION, 1);
    const plan = planTurn(historyTurn, [{ ...user, clientId: 'unknown-client' }, answer], 'full', store.held(CONVERSATION), [command('call-1', 1), command('call-2', 2)]);
    expect(plan.kind).toBe('new');
    store.mergePage(CONVERSATION, [plan], null, 'not shown');
    const items = store.newestPage(CONVERSATION).items;
    expect(items.map((item) => [item.kind, item.providerItemId, item.order.item])).toEqual([['message', 'h-user', 1], ['activity', 'call-1', 2], ['activity', 'call-2', 3], ['message', 'h-answer', 4]]);
    expect(items.every((item) => item.origin === 'provider')).toBe(true);
  });
});

describe('a removal (C33)', () => {
  it('deletes a conversation’s activities and its workers’ items with it, and leaves their text in none of the store’s files', () => {
    const store = area.open();
    accept(store, 't1', 'a prompt');
    store.addActivity(CONVERSATION, 't1', activity('call-1', {}, { input: 'NEEDLE-COMMAND-LINE --flag', files: [{ path: 'C:\\Users\\someone\\NEEDLE-PATH.txt', line: null }] }));
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'call-1', workerId: null }, { status: 'completed', output: 'NEEDLE-TOOL-OUTPUT' });
    store.addActivity(CONVERSATION, 't1', activity('w-call', { workerId: 'w1' }, { input: 'NEEDLE-WORKER-COMMAND' }));
    store.addItem(CONVERSATION, 't1', message('NEEDLE-WORKER-MESSAGE', { workerId: 'w1' }));
    accept(store, 'o1', 'kept', OTHER);
    store.addActivity(OTHER, 'o1', activity('kept-call', {}, { input: 'KEPT-COMMAND' }));
    for (const needle of ['NEEDLE-COMMAND-LINE', 'NEEDLE-PATH', 'NEEDLE-TOOL-OUTPUT', 'NEEDLE-WORKER-COMMAND', 'NEEDLE-WORKER-MESSAGE']) expect(area.holding(needle), needle).not.toEqual([]);

    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION]);
    for (const needle of ['NEEDLE-COMMAND-LINE', 'NEEDLE-PATH', 'NEEDLE-TOOL-OUTPUT', 'NEEDLE-WORKER-COMMAND', 'NEEDLE-WORKER-MESSAGE']) expect(area.holding(needle), needle).toEqual([]);
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM item WHERE conversationId = ?').get(CONVERSATION))).toEqual({ n: 0 });
    // Another conversation's is untouched.
    expect(area.holding('KEPT-COMMAND')).toContain(STORE_FILE);
    store.close();
    for (const needle of ['NEEDLE-COMMAND-LINE', 'NEEDLE-TOOL-OUTPUT', 'NEEDLE-WORKER-MESSAGE']) expect(area.holding(needle), needle).toEqual([]);
  });
});

// ── M106: a session's sub-agents, at launch ───────────────────────────────────────────────────
// V2 (docs/planning/_archive/M106.md, Design 4; C19, C26): the worker item names its model and agent
// definition, a later start replaces the model and keeps the rest, and `workers()` lists a session's
// sub-agents from these items, newest first, each start and end by one rule.
describe('a session’s sub-agents, from their items (M106: V2)', () => {
  const agent = (providerItemId: string, start: Partial<ActivityStart>, patch: Partial<NewActivity> = {}) => activity(providerItemId, patch, { type: 'worker', name: 'Agent', summary: 'Reads notes', ...start });

  it('writes the model and the agent definition at the start, replaces the model at a later start, and keeps the rest', () => {
    const store = area.open();
    accept(store, 't1');
    const first = store.addActivity(CONVERSATION, 't1', agent('use-1', { model: 'haiku', agentType: 'general-purpose' }));
    expect(rawActivity(first.item.id)).toMatchObject({ model: 'haiku', agentType: 'general-purpose', workerId: null });
    store.addActivity(CONVERSATION, 't1', agent('use-1', { workerId: 'w1' }));
    store.addActivity(CONVERSATION, 't1', agent('use-1', { workerId: 'w1', model: 'claude-haiku-4-5-20251001' }));
    expect(rawActivity(first.item.id)).toMatchObject({ model: 'claude-haiku-4-5-20251001', agentType: 'general-purpose', workerId: 'w1', status: 'running' });
    expect(store.workerItem(CONVERSATION, 'w1')?.activity).toMatchObject({ model: 'claude-haiku-4-5-20251001', agentType: 'general-purpose' });
    // A key this build does not know, beside them, stays.
    area.raw((db) => db.prepare("UPDATE item SET body = json_set(body, '$.activity.later', 'kept') WHERE id = ?").run(first.item.id));
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'use-1', workerId: null }, { status: 'completed', duration: { ms: 4_000, provenance: 'provider' } });
    expect(rawActivity(first.item.id)).toMatchObject({ later: 'kept', model: 'claude-haiku-4-5-20251001', status: 'completed' });
  });

  it('lists the session’s own worker items newest first, within the limit, each start and end by one rule', () => {
    const store = area.open();
    accept(store, 't1');
    // Received, with the provider's duration — completed.
    store.addActivity(CONVERSATION, 't1', agent('use-a', { summary: 'First', workerId: 'w-a', model: 'claude-opus-5', agentType: 'Explore' }, { receivedAt: 1_000 }));
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'use-a', workerId: null }, { status: 'completed', duration: { ms: 4_000, provenance: 'provider' } });
    // No receipt kept, the provider's start, a local duration — failed.
    store.addActivity(CONVERSATION, 't1', agent('use-b', { summary: 'Second', workerId: 'w-b', model: 'gpt-6-astra' }, { receivedAt: null, providerAt: 2_000 }));
    store.endActivity(CONVERSATION, 't1', { providerItemId: 'use-b', workerId: null }, { status: 'failed', duration: { ms: 500, provenance: 'local' } });
    // An item that never paired a worker is no sub-agent; nor is a worker's own item, nor another session's.
    store.addActivity(CONVERSATION, 't1', agent('use-x', { summary: 'Never started' }));
    store.addActivity(CONVERSATION, 't1', activity('w-read', { workerId: 'w-a' }));
    accept(store, 'o1', 'a prompt', OTHER);
    store.addActivity(OTHER, 'o1', agent('use-o', { workerId: 'w-o' }));
    // Left open at a quit: unfinished, with no duration, its turn's end the session's.
    accept(store, 't2');
    store.addActivity(CONVERSATION, 't2', agent('use-c', { summary: 'Third', workerId: 'w-c', model: 'two words' }, { receivedAt: 3_000 }));
    store.providerEnded(CONVERSATION, 't2', 'completed', 3_500);
    store.settleActivities(CONVERSATION, [{ id: store.workerItem(CONVERSATION, 'w-c')?.id ?? '', status: 'unfinished' }]);
    store.sessionEnded(CONVERSATION, 't2', 9_000, 'stopped');
    expect(store.workers(CONVERSATION, 10)).toEqual([
      // The session's end stands before the provider's; a model that is no key is none.
      { workerId: 'w-c', label: 'Third', status: 'failed', model: null, agentType: null, startedAt: 3_000, finishedAt: 9_000 },
      { workerId: 'w-b', label: 'Second', status: 'failed', model: 'gpt-6-astra', agentType: null, startedAt: 2_000, finishedAt: 2_500 },
      { workerId: 'w-a', label: 'First', status: 'completed', model: 'claude-opus-5', agentType: 'Explore', startedAt: 1_000, finishedAt: 5_000 },
    ]);
    expect(store.workers(CONVERSATION, 2).map((worker) => worker.workerId)).toEqual(['w-c', 'w-b']);
    expect(store.workers(OTHER, 10).map((worker) => worker.workerId)).toEqual(['w-o']);
    expect(store.workers('no-such-conversation', 10)).toEqual([]);
  });

  it('takes its turn’s acceptance for a start it has no other, the provider’s end for one only it ended, and none for one with no end', () => {
    const store = area.open();
    accept(store, 't1');
    store.addActivity(CONVERSATION, 't1', agent('use-a', { workerId: 'w-a' }, { receivedAt: null }));
    expect(store.workers(CONVERSATION, 10)).toEqual([{ workerId: 'w-a', label: 'Reads notes', status: 'failed', model: null, agentType: null, startedAt: 5, finishedAt: null }]);
    store.providerEnded(CONVERSATION, 't1', 'completed', 700);
    expect(store.workers(CONVERSATION, 10)[0]).toMatchObject({ status: 'failed', finishedAt: 700 });
  });
});
