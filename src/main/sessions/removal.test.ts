// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, V24, V29, V30 (docs/planning/_archive/M18.md, Design 9; C21, C22, C30, C42, C62, C63): a removal across
// the two stores, on a real conversation store and a records write in the test's hands — its three
// steps, each fault between them, and a removal a crash cut short, finished late.
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATIONS_VERSION, STORE_FILE } from '../conversations/format';
import type { ConversationStore } from '../conversations/store';
import { CONVERSATION as A, OTHER as B, type Scratch, scratch } from '../conversations/test-support';
import { createRemoval, type Removal } from './removal';

let area: Scratch;
let store: ConversationStore;
let removal: Removal;
/** The store's transactions that fail, by name. */
let fault: string | null;
const log = { warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  area = scratch();
  fault = null;
  for (const spy of Object.values(log)) spy.mockClear();
  store = area.open({ hook: (point) => { if (fault === point) throw Object.assign(new Error('C:\\Users\\someone\\conversations.sqlite'), { code: 'EIO' }); } });
  removal = createRemoval({ store, log });
});
afterEach(() => { area.dispose(); });

const NEEDLE = 'only-this-chat-holds-these-words-0123456789';
const chatOf = (id: string, text = 'a prompt') => store.acceptPrompt({ conversationId: id, turnId: `turn-${id}`, itemId: `prompt-${id}`, text, at: 5, started: false });
const SAVED = { status: 'saved' as const };
const saved = (answer: { status: string }) => answer.status === 'saved';
const held = (id: string) => store.conversation(id) !== null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a removal’s three steps (V10; C21, C30)', () => {
  it('marks, removes the record, then deletes the chat: the mark is there while the records write runs', async () => {
    chatOf(A);
    chatOf(B);
    let markedDuringWrite: readonly string[] = [];
    const answer = await removal.run([A], () => { markedDuringWrite = store.removing(); return Promise.resolve(SAVED); }, saved);
    expect(answer).toEqual(SAVED);
    expect(markedDuringWrite).toEqual([A]);
    expect([held(A), held(B)]).toEqual([false, true]);
    expect(store.removing()).toEqual([]);
  });

  it('leaves both the chat and the record when the records write is refused: the mark is lifted', async () => {
    chatOf(A);
    const refused = { status: 'refused' as const, reason: 'running' as const };
    expect(await removal.run([A], () => Promise.resolve(refused), saved)).toBe(refused);
    expect(held(A)).toBe(true);
    expect(store.removing()).toEqual([]);
    expect(store.newestPage(A).items).toHaveLength(1);
  });

  it('leaves both when the records write fails, and a retry removes both', async () => {
    chatOf(A);
    await expect(removal.run([A], () => Promise.reject(Object.assign(new Error('disk'), { code: 'EPERM' })), saved)).rejects.toThrow('disk');
    expect(held(A)).toBe(true);
    expect(store.removing()).toEqual([]);
    expect(await removal.run([A], () => Promise.resolve(SAVED), saved)).toEqual(SAVED);
    expect(held(A)).toBe(false);
  });

  it('removes a session that has no chat: there is nothing to mark, and the record goes', async () => {
    const write = vi.fn(() => Promise.resolve(SAVED));
    expect(await removal.run([A], write, saved)).toEqual(SAVED);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('removes several at once, as a project’s removal does', async () => {
    chatOf(A);
    chatOf(B);
    await removal.run([A, B], () => Promise.resolve(SAVED), saved);
    expect(store.conversations()).toEqual([]);
  });
});

describe('what refuses a removal (V19; C42, C63)', () => {
  it('refuses while the conversation store is refused, and never runs the records write', async () => {
    store.close();
    area.raw((db) => db.exec(`UPDATE meta SET minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    const refusedStore = area.open();
    const write = vi.fn(() => Promise.resolve(SAVED));
    expect(await createRemoval({ store: refusedStore, log }).run([A], write, saved)).toEqual({ status: 'refused', reason: 'conversations-refused' });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when the mark cannot be written, and removes nothing', async () => {
    chatOf(A);
    fault = 'mark';
    const write = vi.fn(() => Promise.resolve(SAVED));
    expect(await removal.run([A], write, saved)).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(write).not.toHaveBeenCalled();
    expect(held(A)).toBe(true);
    // By kind: the message holds a path.
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('someone');
    expect(log.warn.mock.calls[0]?.[0]).toBe('[removal] a removal could not be marked (Error EIO)');
  });
});

describe('what a removal leaves (V29; C62)', () => {
  it('leaves the removed chat’s text in none of the store’s files, open or closed, and the main file smaller', async () => {
    // Three hundred rows of setup, written with no wait for the disk: the app never writes so, and
    // the removal below runs on a store opened as the app opens it.
    store.close();
    store = area.open({ synchronous: 'OFF' });
    chatOf(B, 'kept');
    chatOf(A, `${NEEDLE} as a prompt`);
    for (let n = 0; n < 300; n += 1) store.addItem(A, `turn-${A}`, { id: `a-${n}`, kind: 'message', origin: 'local', providerItemId: null, role: 'assistant', phase: 'final', text: `${NEEDLE} ${'words '.repeat(300)}`, cut: false, questions: [], notice: null, detail: null, receivedAt: 6, providerAt: null });
    store.close();
    store = area.open();
    removal = createRemoval({ store, log });
    const before = statSync(area.file).size;
    expect(area.holding(NEEDLE)).not.toEqual([]);

    await removal.run([A], () => Promise.resolve(SAVED), saved);
    expect(area.holding(NEEDLE)).toEqual([]);
    expect(statSync(area.file).size).toBeLessThan(before / 2);
    store.close();
    expect(area.holding(NEEDLE)).toEqual([]);
    expect(Object.keys(area.sizes())).toEqual([STORE_FILE]);
  });
});

describe('a removal a crash cut short (V24, V30; C63)', () => {
  it('finishes one whose record is gone at the next open: the rows go', () => {
    chatOf(A);
    store.markRemoving([A]);
    // The crash came after the records write: the session is no longer listed.
    removal.finish(() => false, vi.fn());
    expect(held(A)).toBe(false);
    expect(removal.pending(A)).toBe(false);
  });

  it('finishes one whose record is still listed in that order: the record first, then the rows', async () => {
    chatOf(A);
    store.markRemoving([A]);
    const order: string[] = [];
    let release: (removed: boolean) => void = () => undefined;
    removal.finish(() => true, (id) => { order.push(`record ${id}`); return new Promise((resolve) => { release = resolve; }); });
    // Under way: the rows are still there, and the session is neither reconciled nor checked.
    expect(removal.pending(A)).toBe(true);
    expect(held(A)).toBe(true);
    // Asked again meanwhile, by another change of the records: the record's removal is not asked for twice.
    removal.finish(() => true, () => { order.push('twice'); return Promise.resolve(true); });
    release(true);
    await tick();
    expect(order).toEqual([`record ${A}`]);
    expect(held(A)).toBe(false);
    expect(removal.pending(A)).toBe(false);
  });

  it('keeps both when the record’s write fails there: the mark is lifted, and the session stays listed with its chat', async () => {
    chatOf(A);
    store.markRemoving([A]);
    const settled = vi.fn();
    removal.finish(() => true, () => Promise.reject(new Error('disk')), settled);
    await tick();
    expect(held(A)).toBe(true);
    expect(store.removing()).toEqual([]);
    expect(settled).toHaveBeenCalledWith(A);
    expect(removal.pending(A)).toBe(false);
  });

  it('deletes nothing while the records cannot be read: `finish` is not called then, and the mark waits', () => {
    chatOf(A);
    store.markRemoving([A]);
    store.close();
    // The next launch, with the records refused: the runtime does not ask for the finish.
    const again = area.open();
    expect(again.removing()).toEqual([A]);
    expect(again.conversation(A)).toMatchObject({ removing: true });
    expect(again.newestPage(A).items).toHaveLength(1);
  });

  it('keeps the marks when the rows cannot be deleted yet, answers the removal as saved, and finishes at the next open', async () => {
    chatOf(A);
    fault = 'delete';
    expect(await removal.run([A], () => Promise.resolve(SAVED), saved)).toEqual(SAVED);
    expect(store.removing()).toEqual([A]);
    expect(log.error.mock.calls[0]?.[0]).toBe("[removal] removed sessions' chats could not be deleted yet (Error EIO)");
    fault = null;
    removal.finish(() => false, vi.fn());
    expect(held(A)).toBe(false);
  });

  it('keeps the marks, and says so by kind, when neither store could be written', async () => {
    chatOf(A);
    // The records write fails, and so does lifting the mark.
    await expect(removal.run([A], () => { fault = 'lift'; return Promise.reject(new Error('disk')); }, saved)).rejects.toThrow('disk');
    expect(store.removing()).toEqual([A]);
    expect(log.error.mock.calls[0]?.[0]).toBe("[removal] a removal's marks could not be lifted (Error EIO)");
  });
});

describe('the detached cleanup (V14; C32)', () => {
  it('removes conversations that have no record to remove, whole', () => {
    chatOf(A, NEEDLE);
    chatOf(B);
    removal.detached([A]);
    expect([held(A), held(B)]).toEqual([false, true]);
    expect(area.holding(NEEDLE)).toEqual([]);
  });

  it('throws when the store cannot do it, and removes nothing', () => {
    chatOf(A);
    fault = 'mark';
    expect(() => removal.detached([A])).toThrow();
    expect(held(A)).toBe(true);
  });
});
