// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10 (docs/planning/_archive/M15.md, Design 13; C55, C76) and V11 (M18.md; C24): a session's conversation
// reaches the Main window at once, for the session it shows, and reaches no other window — on the
// chat service over a real store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatPush } from '@shared/contracts/chat';
import type { PushChannel, WindowKind } from '@shared/ipc/channels';
import type { NewItem } from '../conversations/store';
import { type Scratch, scratch } from '../conversations/test-support';
import { type ChatService, createChatService } from '../sessions/chat-service';
import { startChatPush } from './chat-push';
import type { BroadcastTarget } from './push';

const A = '5e551000-0000-4000-8000-000000000001';
const B = '5e551000-0000-4000-8000-000000000002';

interface FakeWindow extends BroadcastTarget {
  readonly received: { readonly channel: PushChannel; readonly payload: unknown }[];
  alive: boolean;
}
function fakeWindow(kind: WindowKind): FakeWindow {
  const window: FakeWindow = { kind, received: [], alive: true, isAlive: () => window.alive, send: (channel, payload) => { window.received.push({ channel, payload }); } };
  return window;
}
const pushes = (window: FakeWindow) => window.received.map((entry) => entry.payload as ChatPush);
const message = (id: string, text: string): NewItem => ({ id, kind: 'message', origin: 'local', providerItemId: null, role: 'assistant', phase: 'final', text, cut: false, questions: [], notice: null, detail: null, receivedAt: 1, providerAt: null });

const log = { error: vi.fn() };
let area: Scratch;
/** A chat over a store, with a turn open in each session named: the first item of each is its prompt. */
function chatWith(...sessions: string[]): ChatService {
  const chat = createChatService({ store: area.open(), log: { warn: () => undefined } });
  for (const session of sessions) {
    chat.ensure(session, 'checked');
    chat.accept(session, { turnId: `turn-${session}`, itemId: `prompt-${session}`, text: 'a prompt', at: 1, started: false });
  }
  return chat;
}
beforeEach(() => { vi.useFakeTimers(); log.error.mockClear(); area = scratch(); });
afterEach(() => { vi.useRealTimers(); area.dispose(); });

describe('the chat push', () => {
  it('sends an item at once, with no timer, to the Main window for the session it shows', () => {
    const chat = chatWith(A);
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => A, targets: () => [mainWindow], log });
    chat.add(A, `turn-${A}`, message('m1', 'Done.'));
    // Nothing was waited for.
    expect(vi.getTimerCount()).toBe(0);
    expect(mainWindow.received.map((entry) => entry.channel)).toEqual(['chat:message']);
    expect(pushes(mainWindow)[0]).toMatchObject({ sessionId: A, revision: 2, item: { id: 'm1', blocks: [{ text: 'Done.' }] }, turn: { id: `turn-${A}`, state: 'running' } });
    chat.add(A, `turn-${A}`, message('m2', 'And more.'));
    expect(pushes(mainWindow).map((push) => push.revision)).toEqual([2, 3]);
  });

  it('sends every change of the selected session: an item, and word that something else changed', () => {
    const chat = chatWith(A);
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => A, targets: () => [mainWindow], log });
    chat.setHistory(A, 'checking');
    chat.echo(A, `prompt-${A}`, 'item-1');
    chat.add(A, `turn-${A}`, message('m1', 'Now'));
    chat.ended(A, `turn-${A}`, { outcome: 'completed', at: 2 });
    const sent = pushes(mainWindow);
    expect(sent.map((push) => ('item' in push ? 'item' : 'changed'))).toEqual(['changed', 'changed', 'item', 'changed']);
    expect(sent.map((push) => push.revision)).toEqual([2, 3, 4, 5]);
  });

  it('keeps another session’s changes in main until they are read', () => {
    const chat = chatWith(A, B);
    let selected: string | null = A;
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => selected, targets: () => [mainWindow], log });
    chat.add(B, `turn-${B}`, message('b1', 'For the other session'));
    expect(mainWindow.received).toEqual([]);
    // Selected later: its next change is pushed, and its read brings what came before.
    selected = B;
    chat.add(B, `turn-${B}`, message('b2', 'And now'));
    expect(pushes(mainWindow)).toHaveLength(1);
    expect(pushes(mainWindow)[0]).toMatchObject({ sessionId: B, revision: 3 });
    expect(chat.read(B, null, false)?.items.map((entry) => entry.id)).toEqual([`prompt-${B}`, 'b1', 'b2']);
    // No session shown: nothing is sent.
    selected = null;
    chat.add(A, `turn-${A}`, message('a1', 'Unseen'));
    expect(pushes(mainWindow)).toHaveLength(1);
  });

  // C76: the Pet shows on screen shares, and never receives a word of a conversation.
  it('never sends to the Pet, nor to a window that is closing', () => {
    const chat = chatWith(A);
    const pet = fakeWindow('pet');
    const closing = fakeWindow('main');
    closing.alive = false;
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => A, targets: () => [pet, closing, mainWindow], log });
    chat.add(A, `turn-${A}`, message('m1', 'Done.'));
    chat.ended(A, `turn-${A}`, null);
    expect(pet.received).toEqual([]);
    expect(closing.received).toEqual([]);
    expect(mainWindow.received).toHaveLength(2);
  });

  it('reads its targets at each push, and stops when told to', () => {
    const chat = chatWith(A);
    const windows: FakeWindow[] = [];
    const stop = startChatPush({ chat, selected: () => A, targets: () => windows, log });
    chat.add(A, `turn-${A}`, message('m1', 'Before a window'));
    const mainWindow = fakeWindow('main');
    windows.push(mainWindow);
    chat.add(A, `turn-${A}`, message('m2', 'After'));
    expect(pushes(mainWindow).map((push) => push.revision)).toEqual([3]);
    stop();
    chat.add(A, `turn-${A}`, message('m3', 'Stopped'));
    expect(mainWindow.received).toHaveLength(1);
  });

  it('survives a window that fails, serves the next one, and logs no word of the message', () => {
    const chat = chatWith(A);
    const broken = fakeWindow('main');
    broken.send = () => { throw new Error('PRIVATE object has been destroyed'); };
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => A, targets: () => [broken, mainWindow], log });
    chat.add(A, `turn-${A}`, message('m1', 'PRIVATE answer'));
    expect(mainWindow.received).toHaveLength(1);
    expect(log.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('PRIVATE');
  });

  // M19, V9 and V11 (C23–C25): a message as it is written goes where every message goes, and nowhere else.
  it('sends a message’s opening at once and its text at most every 50 ms, to the Main window for the session it shows', () => {
    const chat = chatWith(A);
    const mainWindow = fakeWindow('main');
    const pet = fakeWindow('pet');
    startChatPush({ chat, selected: () => A, targets: () => [pet, mainWindow], log });
    chat.delta(A, `turn-${A}`, { itemId: 'p-1', phase: 'final', text: '' });
    expect(pushes(mainWindow)).toHaveLength(1);
    expect(pushes(mainWindow)[0]).toMatchObject({ sessionId: A, revision: 2, item: { state: 'streaming', blocks: [{ text: '' }] } });
    chat.delta(A, `turn-${A}`, { itemId: 'p-1', phase: 'final', text: 'PRIVATE ' });
    chat.delta(A, `turn-${A}`, { itemId: 'p-1', phase: 'final', text: 'answer' });
    expect(pushes(mainWindow)).toHaveLength(1);
    vi.advanceTimersByTime(49);
    expect(pushes(mainWindow)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(pushes(mainWindow)[1]).toMatchObject({ sessionId: A, revision: 3, partial: { before: 0, append: 'PRIVATE answer' } });
    chat.add(A, `turn-${A}`, { ...message('m1', 'PRIVATE answer, whole.'), providerItemId: 'p-1' });
    expect(pushes(mainWindow)[2]).toMatchObject({ revision: 4, item: { state: 'complete', blocks: [{ text: 'PRIVATE answer, whole.' }] } });
    // The Pet received none of it, and no log holds a word of it.
    expect(pet.received).toEqual([]);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('PRIVATE');
    chat.dispose();
  });

  it('pushes nothing of a message written in a session that is not shown: its read brings what was pushed for it', () => {
    const chat = chatWith(A, B);
    let selected: string | null = A;
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => selected, targets: () => [mainWindow], log });
    chat.delta(B, `turn-${B}`, { itemId: 'p-1', phase: null, text: 'Written while ' });
    vi.advanceTimersByTime(50);
    expect(mainWindow.received).toEqual([]);
    // Selected while it is written: the read has the text so far, at its revision, and the next push appends to exactly that.
    selected = B;
    const read = chat.read(B, null, false);
    expect(read).toMatchObject({ revision: 3 });
    expect(read?.items.at(-1)).toMatchObject({ state: 'streaming', blocks: [{ text: 'Written while ' }] });
    chat.delta(B, `turn-${B}`, { itemId: 'p-1', phase: null, text: 'unseen.' });
    vi.advanceTimersByTime(50);
    expect(pushes(mainWindow)).toHaveLength(1);
    expect(pushes(mainWindow)[0]).toMatchObject({ sessionId: B, revision: 4, partial: { before: 14, append: 'unseen.' } });
    chat.dispose();
  });

  // M20a, V7 (C30, C32, C34): what a session does, and what its workers do, goes where a message goes and nowhere else.
  it('sends an activity at its start and at its end, at once, to the Main window alone: the Pet receives none of it, and no log a word', () => {
    const chat = chatWith(A);
    const mainWindow = fakeWindow('main');
    const pet = fakeWindow('pet');
    startChatPush({ chat, selected: () => A, targets: () => [pet, mainWindow], log });
    chat.activityStarted(A, `turn-${A}`, { itemId: 'call-1', workerId: null, providerAt: null, start: { type: 'command', name: 'commandExecution', summary: 'PRIVATE line', input: 'PRIVATE command line', files: [{ path: 'C:\\Users\\PRIVATE\\a.md', line: null }] } });
    expect(vi.getTimerCount()).toBe(0);
    chat.activityEnded(A, `turn-${A}`, { itemId: 'call-1', workerId: null, providerAt: null, durationMs: 3, end: { status: 'completed', output: 'PRIVATE output' } });
    expect(pushes(mainWindow).map((push) => ('item' in push ? push.item.activity?.status : null))).toEqual(['running', 'completed']);
    expect(pushes(mainWindow).every((push) => !('workerId' in push))).toBe(true);
    expect(pet.received).toEqual([]);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('PRIVATE');
    chat.dispose();
  });

  it('sends a worker’s item and its text as it is written with the worker’s name on each, as the page routes them by', () => {
    const chat = chatWith(A);
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => A, targets: () => [mainWindow], log });
    chat.activityStarted(A, `turn-${A}`, { itemId: 'w-call', workerId: 'w1', providerAt: null, start: { type: 'read', name: 'Read', summary: 'Read notes.txt' } });
    chat.delta(A, `turn-${A}`, { itemId: 'w-text', phase: 'final', text: 'The file', workerId: 'w1' });
    vi.advanceTimersByTime(50);
    expect(pushes(mainWindow).map((push) => ['item' in push ? 'item' : 'partial' in push ? 'partial' : 'changed', 'workerId' in push ? push.workerId : null])).toEqual([['item', 'w1'], ['item', 'w1'], ['partial', 'w1']]);
    // Each one above the last: the list takes a worker's push for its revision, and reads nothing again for it.
    expect(pushes(mainWindow).map((push) => push.revision)).toEqual([2, 3, 4]);
    chat.dispose();
  });

  it('pushes nothing of a worker of a session that is not shown', () => {
    const chat = chatWith(A, B);
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => A, targets: () => [mainWindow], log });
    chat.activityStarted(B, `turn-${B}`, { itemId: 'w-call', workerId: 'w1', providerAt: null, start: { type: 'read', name: 'Read', summary: 'Read notes.txt' } });
    expect(mainWindow.received).toEqual([]);
    chat.dispose();
  });

  // M20b, V7 (C4, C33, C73): an aside's conversation is its session's to push, under the session's
  // id and revision, each push naming the aside — to the Main window alone.
  const ASIDE = 'a51de000-0000-4000-8000-000000000001';
  const SECRET = 'PRIVATE-ASIDE-TEXT';
  /** An aside of a session, with its question recorded and a turn of it running. */
  function asideOf(chat: ChatService, session: string): void {
    chat.ensureAside(ASIDE, session);
    chat.accept(ASIDE, { turnId: 'aside-turn', itemId: 'aside-question', text: `${SECRET} question`, at: 2, started: false, aside: { parentId: session, source: null, title: 'A title' } });
  }

  it('sends an aside’s question, its answer and its text as it is written with the aside’s name on each, to the Main window that shows its session', () => {
    const chat = chatWith(A);
    const mainWindow = fakeWindow('main');
    const pet = fakeWindow('pet');
    startChatPush({ chat, selected: () => A, targets: () => [mainWindow, pet], log });
    asideOf(chat, A);
    chat.delta(ASIDE, 'aside-turn', { itemId: 'aside-answer', phase: 'final', text: `${SECRET} half an` });
    vi.advanceTimersByTime(50);
    chat.add(ASIDE, 'aside-turn', { ...message('a-1', `${SECRET} answer`), providerItemId: 'aside-answer' });
    const sent = pushes(mainWindow);
    expect(sent.map((push) => ['item' in push ? 'item' : 'partial' in push ? 'partial' : 'changed', push.sessionId, push.asideId ?? null])).toEqual([
      ['item', A, ASIDE], ['item', A, ASIDE], ['partial', A, ASIDE], ['item', A, ASIDE],
    ]);
    // One count with the session's own: each is one above the last, the prompt's having been the first.
    expect(sent.map((push) => push.revision)).toEqual([2, 3, 4, 5]);
    // The Pet receives none of it, and no log holds a word of it.
    expect(pet.received).toEqual([]);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(SECRET);
    chat.dispose();
  });

  it('pushes nothing of an aside whose session is not shown: its tab reads when its session is', () => {
    const chat = chatWith(A, B);
    const mainWindow = fakeWindow('main');
    startChatPush({ chat, selected: () => A, targets: () => [mainWindow], log });
    asideOf(chat, B);
    chat.add(ASIDE, 'aside-turn', message('a-1', `${SECRET} answer`));
    expect(mainWindow.received).toEqual([]);
    chat.dispose();
  });
});
