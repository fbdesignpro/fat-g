// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V7 (docs/planning/_archive/M20a.md; C20, C29, C30, C32, C34, C35): what a session does between its
// messages, through the chat service over a real store — an activity written and pushed at its
// start and at its end, what each end leaves of the open ones, a worker's items under its id and in
// no answer of the session's, the worker's own read, durations on a clock that only goes forward,
// and what is counted and said: kinds, never a text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActivityStart, MAX_ACTIVITY_OUTPUT } from '@shared/contracts/activity';
import type { ChatPush, ChatRead, ChatWorkerRead } from '@shared/contracts/chat';
import { type ConversationItem, itemText } from '@shared/contracts/conversation';
import type { ConversationStore, NewItem } from '../conversations/store';
import { CONVERSATION as A, type Scratch, scratch } from '../conversations/test-support';
import { type ChatService, createChatService, type EndedActivity, type StartedActivity } from './chat-service';

const PRIVATE = { command: 'rm -rf C:\\Users\\someone\\secret-project', path: 'C:\\Users\\someone\\secret.txt', output: 'someone@example.test said the password is hunter2' };

let area: Scratch;
let store: ConversationStore;
let chat: ChatService;
let pushes: ChatPush[];
let fault: string | null;
let clock: number;
let wall: number;
const log = { warn: vi.fn() };

beforeEach(() => {
  area = scratch();
  fault = null;
  clock = 1_000;
  wall = 50_000;
  log.warn.mockClear();
  store = area.open({ synchronous: 'OFF', hook: (point) => { if (fault === point || fault === 'all') throw Object.assign(new Error(`${PRIVATE.path} is full`), { code: 'SQLITE_FULL' }); } });
  chat = createChatService({ store, log, monotonic: () => clock, now: () => wall });
  pushes = [];
  chat.subscribe((push) => { pushes.push(push); });
  chat.ensure(A, 'checked');
});
afterEach(() => { area.dispose(); });

const COMMAND: ActivityStart = { type: 'command', name: 'commandExecution', summary: 'rg --files', input: PRIVATE.command, files: [{ path: PRIVATE.path, line: 3 }] };
const started = (itemId: string, patch: Partial<StartedActivity> = {}, start: Partial<ActivityStart> = {}): StartedActivity => ({ itemId, workerId: null, start: { ...COMMAND, ...start }, providerAt: null, ...patch });
const ended = (itemId: string, patch: Partial<EndedActivity> = {}): EndedActivity => ({ itemId, workerId: null, end: { status: 'completed', output: PRIVATE.output, exitCode: 0 }, providerAt: null, durationMs: null, ...patch });
const checklist = (steps: ActivityStart['steps']): StartedActivity => started('t1#plan', {}, { type: 'checklist', name: 'plan', summary: 'Tasks', input: null, files: [], steps: steps ?? [] });
const workerItem = (workerId: string | null = 'w1'): StartedActivity => started('sub-agent-1', {}, { type: 'worker', name: 'Agent', summary: 'Worker 1', input: '{}', files: [], ...(workerId === null ? {} : { workerId }) });
let made = 0;
const message = (text: string, patch: Partial<NewItem> = {}): NewItem => {
  made += 1;
  return { id: `message-${made}`, kind: 'message', origin: 'local', providerItemId: `p-${made}`, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 20, providerAt: null, ...patch };
};
const accept = (turnId: string) => chat.accept(A, { turnId, itemId: `prompt-${turnId}`, text: 'a prompt', at: 10, started: false });
const read = (): ChatRead => {
  const answered = chat.read(A, null, false);
  if (answered === null) throw new Error('no entry');
  return answered;
};
const readWorker = (workerId: string, before?: string): ChatWorkerRead => {
  const answered = chat.readWorker(A, workerId, before);
  if (answered === null || answered.status !== 'read') throw new Error(`the worker was not read: ${JSON.stringify(answered)}`);
  return answered;
};
const activities = (items: readonly ConversationItem[] = read().items) => items.filter((item) => item.kind === 'activity');
const statuses = (items: readonly ConversationItem[] = read().items) => activities(items).map((item) => [item.providerItemId, item.activity?.status]);
/** A row's status as it is on disk. */
const stored = (providerItemId: string): unknown => area.raw((db) => (db.prepare("SELECT json_extract(body, '$.activity.status') AS status FROM item WHERE providerItemId = ?").get(providerItemId) as { status: unknown } | undefined)?.status);
const itemPushes = () => pushes.flatMap((push) => ('item' in push ? [push] : []));

describe('an activity, written and pushed (C29, C32)', () => {
  it('is written at its start and pushed at once, running, with its turn', () => {
    accept('t1');
    pushes.length = 0;
    chat.activityStarted(A, 't1', started('call-1', { providerAt: 1_579_924_800_000 }));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ sessionId: A, revision: 2, item: { kind: 'activity', turnId: 't1', providerItemId: 'call-1', workerId: null, state: 'streaming', time: { receivedAt: wall, providerAt: 1_579_924_800_000 } }, turn: { id: 't1', state: 'running' } });
    expect('workerId' in (pushes[0] ?? {})).toBe(false);
    expect(itemPushes()[0]?.item.activity).toMatchObject({ type: 'command', status: 'running', input: PRIVATE.command, output: null, files: [{ path: PRIVATE.path, line: 3 }] });
    // On disk already, and a read answers it as the push did.
    expect(stored('call-1')).toBe('running');
    expect(read().items.at(-1)).toEqual(itemPushes()[0]?.item);
  });

  it('is ended by one write and one push: its output, its exit code, and complete', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    pushes.length = 0;
    chat.activityEnded(A, 't1', ended('call-1'));
    expect(pushes).toHaveLength(1);
    expect(itemPushes()[0]?.item).toMatchObject({ providerItemId: 'call-1', state: 'complete', activity: { status: 'completed', output: PRIVATE.output, exitCode: 0, input: PRIVATE.command } });
    expect(read().items.at(-1)).toEqual(itemPushes()[0]?.item);
    expect(area.raw((db) => db.prepare("SELECT count(*) AS n FROM item WHERE kind = 'activity'").get())).toEqual({ n: 1 });
  });

  it('keeps one item for a second start of an open item: its body replaced, nothing opened (C59)', () => {
    accept('t1');
    chat.activityStarted(A, 't1', checklist([{ text: 'List files', state: 'in-progress' }, { text: 'Read README', state: 'pending' }]));
    chat.activityStarted(A, 't1', checklist([{ text: 'List files', state: 'completed' }, { text: 'Read README', state: 'in-progress' }]));
    const [first, second] = itemPushes().slice(-2);
    expect(second?.item.id).toBe(first?.item.id);
    expect(second?.item.activity).toMatchObject({ status: 'running', steps: [{ text: 'List files', state: 'completed' }, { text: 'Read README', state: 'in-progress' }] });
    expect(activities()).toHaveLength(1);
    expect(chat.activityCounts().started.checklist).toBe(1);
  });

  it('reads an open activity as running in every answer, and as unfinished once nothing holds it open', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    expect(statuses()).toEqual([['call-1', 'running']]);
    // Another service on the same store, as after a restart: nothing runs.
    const later = createChatService({ store, log });
    later.ensure(A, 'checked');
    expect(statuses(later.read(A, null, false)?.items ?? [])).toEqual([['call-1', 'unfinished']]);
  });

  it('takes the session’s own start in the turn in flight alone: another turn’s is dropped and counted', () => {
    accept('t1');
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    pushes.length = 0;
    chat.activityStarted(A, 't1', started('late'));
    expect(pushes).toEqual([]);
    expect(activities()).toEqual([]);
    expect(chat.activityCounts().dropped).toEqual({ 'turn-ended': 1, 'no-turn': 0, unopened: 0 });
  });

  it('drops an end no start opened, and counts it', () => {
    accept('t1');
    pushes.length = 0;
    chat.activityEnded(A, 't1', ended('never-started'));
    expect(pushes).toEqual([]);
    expect(chat.activityCounts().dropped.unopened).toBe(1);
  });

  it('tells nothing of a session it has no entry for', () => {
    chat.activityStarted('33333333-3333-4333-8333-333333333333', 't1', started('call-1'));
    chat.activityEnded('33333333-3333-4333-8333-333333333333', 't1', ended('call-1'));
    chat.lost('33333333-3333-4333-8333-333333333333');
    expect(pushes).toEqual([]);
  });
});

describe('a duration (C7, C35)', () => {
  it('is the provider’s where it gives one, a zero included', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    clock += 4_000;
    chat.activityEnded(A, 't1', ended('call-1', { durationMs: 0 }));
    expect(activities()[0]?.activity?.duration).toEqual({ ms: 0, provenance: 'provider' });
  });

  it('is the span between main’s receipt of the start and of the end where the provider gives none, on a clock that only goes forward', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    clock += 1_234.4;
    // The system clock was set back an hour meanwhile: the duration does not follow it.
    wall -= 3_600_000;
    chat.activityEnded(A, 't1', ended('call-1'));
    expect(activities()[0]?.activity?.duration).toEqual({ ms: 1_234, provenance: 'local' });
  });

  it('measures none of its own for an end that says its start frame never came: the provider’s, or none', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('thinking-1', {}, { type: 'thinking', name: 'thinking', summary: '', input: null, files: [] }));
    clock += 700;
    chat.activityEnded(A, 't1', ended('thinking-1', { end: { status: 'completed' }, untimed: true }));
    expect(activities()[0]?.activity).toMatchObject({ status: 'completed', duration: null });
    chat.activityStarted(A, 't1', started('thinking-2', {}, { type: 'thinking', name: 'thinking', summary: '', input: null, files: [] }));
    chat.activityEnded(A, 't1', ended('thinking-2', { end: { status: 'completed' }, untimed: true, durationMs: 40 }));
    expect(activities()[1]?.activity?.duration).toEqual({ ms: 40, provenance: 'provider' });
  });

  it('has none for an item that never ended, and none of main’s own for one whose end came after its turn’s', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    chat.activityStarted(A, 't1', started('call-2'));
    chat.ended(A, 't1', { outcome: 'interrupted', at: 30 });
    expect(activities().map((item) => item.activity?.duration)).toEqual([null, null]);
    clock += 900;
    chat.activityEnded(A, 't1', ended('call-1'));
    chat.activityEnded(A, 't1', ended('call-2', { durationMs: 12 }));
    expect(activities().map((item) => item.activity?.duration)).toEqual([null, { ms: 12, provenance: 'provider' }]);
  });
});

describe('what an end leaves (C6, C11, C20, C29)', () => {
  function open(): void {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    chat.activityStarted(A, 't1', checklist([{ text: 'one', state: 'in-progress' }]));
    chat.activityStarted(A, 't1', workerItem('w1'));
    chat.activityStarted(A, 't1', started('w-call', { workerId: 'w1' }));
  }
  const all = () => [...statuses(), ...statuses(readWorker('w1').items)];

  it('at the provider’s end of a turn: the session’s own unfinished with what it has, its checklist completed, and the worker’s — its item and the item that started it — still running', () => {
    open();
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    expect(all()).toEqual([['call-1', 'unfinished'], ['t1#plan', 'completed'], ['sub-agent-1', 'running'], ['w-call', 'running']]);
    expect([stored('call-1'), stored('t1#plan'), stored('sub-agent-1'), stored('w-call')]).toEqual(['unfinished', 'completed', 'running', 'running']);
    // With what it has: nothing of it is erased.
    expect(activities()[0]?.activity).toMatchObject({ input: PRIVATE.command, files: [{ path: PRIVATE.path, line: 3 }] });
    expect(activities()[1]?.activity?.steps).toEqual([{ text: 'one', state: 'in-progress' }]);
    expect(activities()[1]?.state).toBe('complete');
  });

  it('a worker’s end, after its turn’s, ends the item that started it and leaves what was still open of it unfinished', () => {
    open();
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    pushes.length = 0;
    chat.activityEnded(A, 't1', ended('sub-agent-1', { end: { status: 'completed', output: 'The file holds one line.' } }));
    expect(all()).toEqual([['call-1', 'unfinished'], ['t1#plan', 'completed'], ['sub-agent-1', 'completed'], ['w-call', 'unfinished']]);
    expect(stored('w-call')).toBe('unfinished');
    // The item's own push, then word that something else changed: what was open of the worker.
    expect(pushes.map((push) => ('item' in push ? 'item' : 'changed' in push ? 'changed' : 'partial'))).toEqual(['item', 'changed']);
    // The turn's end is as it was.
    expect(store.turn(A, 't1')).toMatchObject({ providerOutcome: 'completed', endReceivedAt: 30 });
  });

  it('an end the adapter made leaves every open one unfinished, a worker’s included, and a checklist completed', () => {
    open();
    chat.ended(A, 't1', null);
    expect(all()).toEqual([['call-1', 'unfinished'], ['t1#plan', 'completed'], ['sub-agent-1', 'unfinished'], ['w-call', 'unfinished']]);
    expect([stored('call-1'), stored('sub-agent-1'), stored('w-call')]).toEqual(['unfinished', 'unfinished', 'unfinished']);
  });

  it('a lost process leaves every open one unfinished, with no turn in flight too', () => {
    open();
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    pushes.length = 0;
    // The turn is over, and its worker ran on: the process is gone.
    chat.lost(A);
    expect(all()).toEqual([['call-1', 'unfinished'], ['t1#plan', 'completed'], ['sub-agent-1', 'unfinished'], ['w-call', 'unfinished']]);
    expect(pushes).toEqual([{ sessionId: A, revision: expect.any(Number) as number, changed: true }]);
    // Nothing more to leave: a second word of it changes nothing.
    pushes.length = 0;
    chat.lost(A);
    expect(pushes).toEqual([]);
  });

  it('a quit writes every open one unfinished and keeps it open: an end that comes in time still ends it', () => {
    open();
    chat.saveOpen();
    expect([stored('call-1'), stored('t1#plan'), stored('sub-agent-1'), stored('w-call')]).toEqual(['unfinished', 'completed', 'unfinished', 'unfinished']);
    chat.activityEnded(A, 't1', ended('call-1'));
    expect(stored('call-1')).toBe('completed');
    // And one that does not come leaves the row as the quit wrote it.
    chat.ended(A, 't1', null);
    expect(stored('w-call')).toBe('unfinished');
  });

  it('a completion that comes after its turn’s end still ends its item, and changes no end (C6)', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    chat.ended(A, 't1', { outcome: 'interrupted', at: 30 });
    const turn = store.turn(A, 't1');
    pushes.length = 0;
    chat.activityEnded(A, 't1', ended('call-1'));
    expect(statuses()).toEqual([['call-1', 'completed']]);
    expect(itemPushes()[0]?.item).toMatchObject({ state: 'complete', activity: { status: 'completed', output: PRIVATE.output } });
    expect(store.turn(A, 't1')).toEqual(turn);
  });

  it('leaves a worker item that no worker was paired with unfinished at its turn’s end: an attempted launch', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem(null));
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    expect(statuses()).toEqual([['sub-agent-1', 'unfinished']]);
  });

  it('keeps a worker item open through its turn’s end once a second start has paired it', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem(null));
    chat.activityStarted(A, 't1', workerItem('w1'));
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    expect(statuses()).toEqual([['sub-agent-1', 'running']]);
    expect(activities()[0]?.activity?.workerId).toBe('w1');
  });

  // M106 (V2; C19): the model a worker's first frame names reaches its item by a second start, as the pairing does.
  it('takes the model a later start names for a worker item, ended or not, and keeps its agent definition', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('sub-agent-1', {}, { type: 'worker', name: 'Agent', summary: 'Worker 1', input: '{}', files: [], model: 'haiku', agentType: 'Explore' }));
    chat.activityStarted(A, 't1', started('sub-agent-1', {}, { type: 'worker', name: 'Agent', summary: 'Worker 1', input: '{}', files: [], workerId: 'w1', model: 'claude-haiku-4-5-20251001' }));
    expect(activities()[0]?.activity).toMatchObject({ workerId: 'w1', model: 'claude-haiku-4-5-20251001', agentType: 'Explore', status: 'running' });
    chat.activityEnded(A, 't1', ended('sub-agent-1', { end: { status: 'completed' } }));
    chat.activityStarted(A, 't1', started('sub-agent-1', {}, { type: 'worker', name: 'Agent', summary: 'Worker 1', input: '{}', files: [], workerId: 'w1', model: 'claude-opus-5' }));
    expect(activities()[0]?.activity).toMatchObject({ model: 'claude-opus-5', agentType: 'Explore', status: 'completed' });
  });
});

describe('a worker’s items (C20, C32)', () => {
  it('are stored under its id in the turn that started it, whether they come before or after that turn’s end', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem('w1'));
    chat.activityStarted(A, 't1', started('w-call-1', { workerId: 'w1' }));
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    accept('t2');
    // The next turn runs; the worker of the first still works.
    chat.activityEnded(A, 't1', ended('w-call-1', { workerId: 'w1' }));
    chat.activityStarted(A, 't1', started('w-call-2', { workerId: 'w1' }));
    chat.add(A, 't1', message('The file holds one line.', { workerId: 'w1' }));
    const worker = readWorker('w1');
    expect(worker.items.map((item) => [item.turnId, item.workerId, item.kind])).toEqual([['t1', 'w1', 'activity'], ['t1', 'w1', 'activity'], ['t1', 'w1', 'message']]);
    expect(statuses(worker.items)).toEqual([['w-call-1', 'completed'], ['w-call-2', 'running']]);
    expect(worker.turns.map((turn) => turn.id)).toEqual(['t1']);
  });

  it('are in no answer of the session’s own: its read, its page, its window', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem('w1'));
    chat.activityStarted(A, 't1', started('w-call', { workerId: 'w1' }));
    chat.add(A, 't1', message('the worker’s', { workerId: 'w1' }));
    chat.delta(A, 't1', { itemId: 'w-streaming', phase: null, text: 'the worker is writing', workerId: 'w1' });
    chat.add(A, 't1', message('the session’s own'));
    expect(read().items.map((item) => item.workerId)).toEqual([null, null, null]);
    expect(read().items.map((item) => (item.kind === 'activity' ? item.providerItemId : itemText(item)))).toEqual(['a prompt', 'sub-agent-1', 'the session’s own']);
    const window = chat.read(A, { from: 'prompt-t1', keep: 'newest' }, false);
    expect(window?.items.every((item) => item.workerId === null)).toBe(true);
  });

  it('name their worker in every push: an item’s, and a message’s text as it is written', () => {
    vi.useFakeTimers();
    try {
      const timed = createChatService({ store, log, pushMs: 50 });
      const seen: ChatPush[] = [];
      timed.subscribe((push) => { seen.push(push); });
      timed.ensure(A, 'checked');
      timed.accept(A, { turnId: 't1', itemId: 'prompt-t1', text: 'a prompt', at: 10, started: false });
      seen.length = 0;
      timed.activityStarted(A, 't1', started('w-call', { workerId: 'w1' }));
      timed.delta(A, 't1', { itemId: 'w-text', phase: 'final', text: 'The file', workerId: 'w1' });
      vi.advanceTimersByTime(50);
      timed.add(A, 't1', message('The file holds one line.', { providerItemId: 'w-text', workerId: 'w1' }));
      expect(seen.map((push) => ('item' in push ? 'item' : 'partial' in push ? 'partial' : 'changed'))).toEqual(['item', 'item', 'partial', 'item']);
      expect(seen.map((push) => ('workerId' in push ? push.workerId : null))).toEqual(['w1', 'w1', 'w1', 'w1']);
      expect(seen.map((push) => push.revision)).toEqual([2, 3, 4, 5]);
      // The session's own names none.
      timed.add(A, 't1', message('own'));
      expect('workerId' in (seen.at(-1) ?? {})).toBe(false);
      timed.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('take a worker’s message whenever it comes: after its turn’s end too, where the session’s own is dropped', () => {
    accept('t1');
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    chat.delta(A, 't1', { itemId: 'own-late', phase: null, text: 'dropped' });
    chat.delta(A, 't1', { itemId: 'w-late', phase: 'final', text: 'kept', workerId: 'w1' });
    expect(chat.dropped()['turn-ended']).toBe(1);
    expect(readWorker('w1').items).toMatchObject([{ providerItemId: 'w-late', state: 'streaming', workerId: 'w1', turnId: 't1' }]);
  });

  it('leave a worker’s open message as far as it got when its worker ends, and at a lost process', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem('w1'));
    chat.delta(A, 't1', { itemId: 'w-text', phase: 'final', text: 'half an ans', workerId: 'w1' });
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    // Its turn's end left it open: the worker still writes.
    expect(readWorker('w1').items[0]?.state).toBe('streaming');
    chat.activityEnded(A, 't1', ended('sub-agent-1', { end: { status: 'failed' } }));
    expect(readWorker('w1').items[0]).toMatchObject({ state: 'partial', blocks: [{ text: 'half an ans' }] });
  });
});

describe('the worker’s read (C32)', () => {
  it('answers the worker’s items with the item that started it, at the session’s revision', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem('w1'));
    chat.activityStarted(A, 't1', started('w-call', { workerId: 'w1' }));
    const worker = readWorker('w1');
    expect(worker).toMatchObject({ status: 'read', sessionId: A, workerId: 'w1', revision: 3, older: null });
    expect(worker.worker).toMatchObject({ providerItemId: 'sub-agent-1', workerId: null, activity: { type: 'worker', workerId: 'w1', summary: 'Worker 1', status: 'running' } });
    expect(worker.items).toHaveLength(1);
  });

  it('answers a worker that has started and done nothing yet with no item, and one it holds nothing of as unknown', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem('w1'));
    expect(readWorker('w1')).toMatchObject({ items: [], turns: [], older: null });
    expect(chat.readWorker(A, 'nobody')).toEqual({ status: 'refused', reason: 'unknown-worker' });
    expect(chat.readWorker(A, 'w1', 'no-such-item')).toEqual({ status: 'refused', reason: 'unknown-cursor' });
    expect(chat.readWorker(A, 'w1', 'prompt-t1')).toEqual({ status: 'refused', reason: 'unknown-cursor' });
    expect(chat.readWorker('33333333-3333-4333-8333-333333333333', 'w1')).toBeNull();
  });

  it('pages a worker’s older items from a cursor', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem('w1'));
    for (let n = 1; n <= 640; n += 1) chat.add(A, 't1', message(`w ${n}`, { workerId: 'w1' }));
    const newest = readWorker('w1');
    expect(newest.items).toHaveLength(500);
    expect(itemText(newest.items.at(-1) as ConversationItem)).toBe('w 640');
    expect(newest.older).toBe(newest.items[0]?.id);
    const page = readWorker('w1', newest.older ?? '');
    expect(page.items).toHaveLength(100);
    expect(itemText(page.items.at(-1) as ConversationItem)).toBe('w 140');
    const first = readWorker('w1', page.older ?? '');
    expect(first.items).toHaveLength(40);
    expect(first.older).toBeNull();
  });

  it('answers unknown while the store cannot be read', () => {
    accept('t1');
    chat.activityStarted(A, 't1', workerItem('w1'));
    const refused = createChatService({ store: { ...store, status: () => ({ kind: 'refused', cause: 'damaged' }) }, log });
    refused.ensure(A, 'checked');
    expect(refused.readWorker(A, 'w1')).toEqual({ status: 'refused', reason: 'unknown-worker' });
  });
});

describe('a write that fails (M18, C19)', () => {
  it('keeps an activity the store did not take for the run, pushed as usual, and takes its end here too', () => {
    accept('t1');
    fault = 'activity';
    pushes.length = 0;
    chat.activityStarted(A, 't1', started('call-1'));
    expect(itemPushes()[0]?.item).toMatchObject({ kind: 'activity', providerItemId: 'call-1', state: 'streaming', activity: { status: 'running' } });
    expect(read()).toMatchObject({ storage: 'failing' });
    expect(statuses()).toEqual([['call-1', 'running']]);
    fault = null;
    chat.activityEnded(A, 't1', ended('call-1'));
    expect(statuses()).toEqual([['call-1', 'completed']]);
    expect(activities()[0]?.activity?.output).toBe(PRIVATE.output);
    // Nothing of it reached the disk, and its turn says that something was lost.
    expect(stored('call-1')).toBeUndefined();
    expect(read().turns[0]?.gap).toBe(true);
  });

  it('leaves a kept activity unfinished at its turn’s end, as a stored one is', () => {
    accept('t1');
    fault = 'activity';
    chat.activityStarted(A, 't1', started('call-1'));
    fault = null;
    chat.ended(A, 't1', { outcome: 'completed', at: 30 });
    expect(activities()[0]).toMatchObject({ state: 'partial', activity: { status: 'unfinished' } });
  });

  it('reads an activity whose end could not be written as unfinished, and says that something was lost', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    fault = 'activity-end';
    chat.activityEnded(A, 't1', ended('call-1'));
    fault = null;
    expect(statuses()).toEqual([['call-1', 'unfinished']]);
    expect(read()).toMatchObject({ storage: 'failing' });
    expect(read().turns[0]?.gap).toBe(true);
  });

  it('drops an activity for a turn the conversation does not have, and counts it', () => {
    accept('t1');
    pushes.length = 0;
    chat.activityStarted(A, 'another-run’s-turn', started('stale', { workerId: 'w1' }));
    expect(pushes).toEqual([]);
    expect(chat.activityCounts().dropped['no-turn']).toBe(1);
    expect(read().storage).toBe('ok');
  });
});

describe('what main says (C30, C34)', () => {
  it('counts activities by type, the ones cut, and the events not taken by kind', () => {
    accept('t1');
    chat.activityStarted(A, 't1', started('call-1'));
    chat.activityStarted(A, 't1', started('call-2', {}, { type: 'read', name: 'Read' }));
    chat.activityStarted(A, 't1', started('call-3', {}, { type: 'read', name: 'Read' }));
    chat.activityEnded(A, 't1', ended('call-1', { end: { status: 'completed', output: 'x'.repeat(MAX_ACTIVITY_OUTPUT), cut: { fields: ['output'], output: { omitted: 500, at: MAX_ACTIVITY_OUTPUT / 2 }, files: 0, steps: 0, changes: 0 } } }));
    chat.activityEnded(A, 't1', ended('nothing'));
    const counts = chat.activityCounts();
    expect(counts.started).toMatchObject({ command: 1, read: 2, edit: 0, worker: 0 });
    expect(counts.cut).toBe(1);
    expect(counts.dropped).toEqual({ 'turn-ended': 0, 'no-turn': 0, unopened: 1 });
  });

  it('logs kinds and counts alone: never a command line, a path, an output or an id', () => {
    accept('t1');
    for (let n = 1; n <= 12; n += 1) {
      chat.activityStarted(A, 't1', started(`call-${n}`));
      chat.activityEnded(A, 't1', ended(`call-${n}`, { end: { status: 'failed', output: PRIVATE.output, exitCode: 1, cut: { fields: ['output'], output: { omitted: 1, at: 1 }, files: 0, steps: 0, changes: 0 } } }));
    }
    chat.activityEnded(A, 't1', ended('never-started'));
    fault = 'activity';
    chat.activityStarted(A, 't1', started('unsaved'));
    fault = null;
    chat.readWorker(A, 'nobody');
    const said = log.warn.mock.calls.flat().map(String).join('\n');
    expect(said).toContain('activity (command)');
    expect(said).toContain('dropped (unopened)');
    for (const secret of [PRIVATE.command, PRIVATE.path, PRIVATE.output, 'someone', 'secret', 'hunter2', 'call-1', 'never-started', 't1']) expect(said, secret).not.toContain(secret);
  });
});
