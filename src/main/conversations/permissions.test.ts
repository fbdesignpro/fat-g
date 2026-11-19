// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V22, V32 (docs/planning/_archive/M22.md; C12, C25, C40, C48, C49, C57, C77, C81, C83, C92): the store at
// version 6 — a chat's mode and where it came from, the mode each turn ran under, an approval as an
// interaction's body, its decision and its grant, each written under the outcome it expects, and a
// removal that leaves none of it.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ConversationItem, entriesOf, isItemKind, ITEM_KINDS, itemUnits } from '@shared/contracts/conversation';
import { type ApprovalBody, approvalOf, type ApprovalRequest, MAX_APPROVAL_CHANGE_UNITS } from '@shared/contracts/interaction';
import { APPLICATION_ID, NEEDED_COLUMNS, SCHEMA, STORE_FILE } from './format';
import type { ConversationStore, NewApproval } from './store';
import { CONVERSATION, OTHER, scratch, type Scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const COMMAND: ApprovalRequest = {
  kind: 'command', tool: 'Bash', summary: 'touch NEEDLE-COMMAND notes.txt', folder: 'D:\\Code\\fat-g', targets: ['D:\\Code\\fat-g\\NEEDLE-TARGET.txt'], outside: false, reason: 'NEEDLE-REASON', authority: [{ kind: 'mode', mode: 'edits-ok' }],
  detail: { kind: 'command', command: 'touch NEEDLE-COMMAND notes.txt' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch NEEDLE-COVERS notes.txt)' }, modeThatWouldStop: null, cut: false,
};
let made = 0;
function approval(providerItemId: string, request: ApprovalRequest = COMMAND, patch: Partial<NewApproval> = {}): NewApproval {
  made += 1;
  return { id: `approval-${made}`, origin: 'local', providerItemId, workerId: null, request, receivedAt: 20, providerAt: null, ...patch };
}
const accept = (store: ConversationStore, turnId: string, patch: Partial<Parameters<ConversationStore['acceptPrompt']>[0]> = {}) => store.acceptPrompt({ conversationId: CONVERSATION, turnId, itemId: `prompt-${turnId}`, text: 'a prompt', at: 5, started: false, ...patch });
const rawBody = (id: string): Record<string, unknown> => area.raw((db) => JSON.parse(String((db.prepare('SELECT body FROM item WHERE id = ?').get(id) as { body: string }).body)) as Record<string, unknown>);
const rawInteraction = (id: string): Record<string, unknown> => rawBody(id)['interaction'] as Record<string, unknown>;
const body = (store: ConversationStore, id: string): ApprovalBody => { const found = approvalOf(store.item(CONVERSATION, id)?.item ?? { interaction: null }); if (found === null) throw new Error('no approval'); return found; };

describe('the format, version 6 (V6; C25, C77, C83)', () => {
  it('has a mode and its source on a conversation and a mode on a turn, and adds no item kind', () => {
    area.open();
    expect(NEEDED_COLUMNS['conversation']).toEqual(expect.arrayContaining(['mode', 'modeSource']));
    expect(NEEDED_COLUMNS['turn']).toContain('mode');
    area.raw((db) => {
      const columns = (table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
      expect(columns('conversation')).toEqual(expect.arrayContaining(['mode', 'modeSource']));
      expect(columns('turn')).toContain('mode');
    });
    // An approval is an interaction, by its body's kind (C77).
    expect(ITEM_KINDS).toEqual(['message', 'notice', 'activity', 'interaction']);
    expect(isItemKind('approval')).toBe(false);
  });

  it('refuses a version-5 store, as M21 made it, as older, byte for byte unchanged', () => {
    const db = new DatabaseSync(area.file);
    db.exec('PRAGMA auto_vacuum=FULL');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    // Version 5's tables: without the three columns version 6 adds.
    for (const statement of SCHEMA) db.exec(statement.replace(', mode TEXT, modeSource TEXT', '').replace(', mode TEXT)', ')'));
    db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, 5, 5)').run();
    db.prepare("INSERT INTO conversation (id, startHeld, createdAt) VALUES (?, 1, 1)").run(CONVERSATION);
    db.close();
    const before = area.hashes();
    const store = area.open();
    expect(store.status()).toEqual({ kind: 'refused', cause: 'older' });
    store.close();
    // The main file, byte for byte: the look at its versions is read-only, and SQLite's own keeps beside it are no part of it.
    expect(area.hashes()[STORE_FILE]).toBe(before[STORE_FILE]);
  });
});

describe('a chat’s mode (V6; C25, C40, C75, C83)', () => {
  it('is written with its source when the session’s conversation is made, and never over a conversation that exists', () => {
    const store = area.open();
    store.createConversation(CONVERSATION, 7, { id: 'edits-ok', source: 'project' });
    expect(store.conversation(CONVERSATION)).toMatchObject({ mode: { id: 'edits-ok', source: 'project' }, startHeld: true, createdAt: 7, reference: null, parentId: null });
    store.createConversation(CONVERSATION, 9, { id: 'read-only', source: 'user' });
    expect(store.conversation(CONVERSATION)).toMatchObject({ mode: { id: 'edits-ok', source: 'project' }, createdAt: 7 });
    // A provider that declares no mode: the row is made, and holds none.
    store.createConversation(OTHER, 7, null);
    expect(store.conversation(OTHER)).toMatchObject({ mode: null, startHeld: true });
  });

  it('is changed by the chat’s own choice alone, with the source `chat`, making the row where there is none', () => {
    const store = area.open();
    store.createConversation(CONVERSATION, 7, { id: 'ask-first', source: 'fallback' });
    store.setMode(CONVERSATION, 'read-only', 8, false);
    expect(store.conversation(CONVERSATION)?.mode).toEqual({ id: 'read-only', source: 'chat' });
    // A session the record says had started, whose conversation the store does not hold: made, without its start.
    store.setMode(OTHER, 'edits-ok', 8, true);
    expect(store.conversation(OTHER)).toMatchObject({ mode: { id: 'edits-ok', source: 'chat' }, startHeld: false });
    store.close();
    expect(area.open().conversation(CONVERSATION)?.mode).toEqual({ id: 'read-only', source: 'chat' });
  });

  it('is written at a prompt’s acceptance only where the row holds none, and the turn keeps the mode it ran under', () => {
    const store = area.open();
    // No snapshot could be made when it was created: the first prompt brings it.
    expect(accept(store, 't1', { mode: { id: 'ask-first', source: 'fallback' } }).turn.mode).toBe('ask-first');
    expect(store.conversation(CONVERSATION)?.mode).toEqual({ id: 'ask-first', source: 'fallback' });
    // A saved one stands whatever a later prompt carries.
    expect(accept(store, 't2', { mode: { id: 'edits-ok', source: 'user' } }).turn.mode).toBe('ask-first');
    store.setMode(CONVERSATION, 'read-only', 8, false);
    expect(accept(store, 't3').turn.mode).toBe('read-only');
    expect(store.newestPage(CONVERSATION).turns.map((turn) => turn.mode)).toEqual(['ask-first', 'ask-first', 'read-only']);
    expect(area.raw((db) => (db.prepare('SELECT mode FROM turn ORDER BY place').all() as { mode: string | null }[]).map((row) => row.mode))).toEqual(['ask-first', 'ask-first', 'read-only']);
  });

  it('is none for an aside’s conversation and its turns, and a row’s unknown source reads as the chat’s own', () => {
    const store = area.open();
    accept(store, 't1', { mode: { id: 'ask-first', source: 'fallback' } });
    const aside = store.acceptPrompt({ conversationId: OTHER, turnId: 'a1', itemId: 'q1', text: 'why?', at: 6, started: false, aside: { parentId: CONVERSATION, source: null, title: 'An aside' }, mode: { id: 'ask-first', source: 'fallback' } });
    expect(aside.turn.mode).toBeNull();
    expect(store.conversation(OTHER)?.mode).toBeNull();
    expect(() => store.setMode(OTHER, 'read-only', 8, false)).toThrow();
    store.close();
    area.raw((db) => db.exec("UPDATE conversation SET modeSource = 'a-later-source', mode = 'ask-first' WHERE parentId IS NULL"));
    expect(area.open().conversation(CONVERSATION)?.mode).toEqual({ id: 'ask-first', source: 'chat' });
  });
});

describe('an approval, as it is written (V6, V22; C12, C48, C49, C77)', () => {
  it('is an interaction whose body says its kind, pending on disk and read dropped by a store that knows no request', () => {
    const store = area.open();
    accept(store, 't1');
    const stored = store.addInteraction(CONVERSATION, 't1', approval('call_1'));
    expect(stored?.item).toMatchObject({ kind: 'interaction', turnId: 't1', providerItemId: 'call_1', workerId: null, origin: 'local', role: null, blocks: [], questions: [], activity: null, state: 'complete' });
    expect(Object.keys(rawBody(stored?.item.id ?? ''))).toEqual(['interaction']);
    expect(rawInteraction(stored?.item.id ?? '')).toMatchObject({ kind: 'approval', outcome: 'pending', request: COMMAND, decidedAt: null, delivered: null, confirmedAt: null, grant: null });
    expect(stored?.item.interaction).toMatchObject({ kind: 'approval', outcome: 'dropped', request: COMMAND });
    // A body that names no kind is a question's, as every one written before there were approvals is.
    area.raw((db) => db.prepare("UPDATE item SET body = json_remove(body, '$.interaction.kind') WHERE id = ?").run(stored?.item.id ?? ''));
    expect(store.item(CONVERSATION, stored?.item.id ?? '')?.item.interaction).toMatchObject({ kind: 'question', questions: [] });
  });

  it('stands as often as its action asks: two requests of one item are two cards, as a question’s are not', () => {
    const store = area.open();
    accept(store, 't1');
    expect(store.addInteraction(CONVERSATION, 't1', approval('call_1'))).not.toBeNull();
    expect(store.addInteraction(CONVERSATION, 't1', approval('call_1'))).not.toBeNull();
    expect(store.newestPage(CONVERSATION).items.filter((item) => item.kind === 'interaction')).toHaveLength(2);
  });

  it('keeps a change cut as an activity’s is, and says so: the whole of it is never the store’s (C48)', () => {
    const store = area.open();
    accept(store, 't1');
    const big: ApprovalRequest = {
      ...COMMAND, kind: 'file-change', tool: 'Write', choices: ['approve', 'deny'], grant: null,
      detail: { kind: 'changes', changes: Array.from({ length: 21 }, (_, n) => ({ path: `D:\\Code\\fat-g\\file-${n}.txt`, kind: 'write' as const, text: n === 0 ? 'NEEDLE-HEAD'.padEnd(MAX_APPROVAL_CHANGE_UNITS / 4, 'x') + 'NEEDLE-TAIL' : 'short', replace: null, all: null })) },
    };
    const stored = store.addInteraction(CONVERSATION, 't1', approval('call_1', big));
    const kept = approvalOf(stored?.item ?? { interaction: null })?.request;
    expect(kept?.cut).toBe(true);
    expect(kept?.detail.kind === 'changes' ? kept.detail.changes.length : -1).toBe(20);
    expect(kept?.detail.kind === 'changes' ? kept.detail.changes[0]?.text?.length : -1).toBe(20_000);
    expect(area.holding('NEEDLE-HEAD')).not.toEqual([]);
    expect(area.holding('NEEDLE-TAIL')).toEqual([]);
    // What a page counts is the kept copy's size.
    const item = stored?.item as ConversationItem;
    expect(itemUnits(item)).toBeLessThan(40_000);
    expect(entriesOf(store.newestPage(CONVERSATION).items).map((entry) => entry.length)).toEqual([1, 1]);
  });

  it('writes a decision once, under `pending`, with its time and its grant in the one transaction', () => {
    const store = area.open();
    accept(store, 't1');
    const id = store.addInteraction(CONVERSATION, 't1', approval('call_1'))?.item.id ?? '';
    const grant = { covers: 'Bash(touch NEEDLE-COVERS notes.txt)', processKey: 'process-7' };
    expect(store.setInteraction(CONVERSATION, id, 'pending', { outcome: 'approved-session', decidedAt: 30, grant })?.item.interaction).toMatchObject({ kind: 'approval', outcome: 'approved-session', decidedAt: 30, delivered: null, grant: { ...grant, live: false } });
    // A second decision finds no pending row, and changes nothing (C13).
    expect(store.setInteraction(CONVERSATION, id, 'pending', { outcome: 'denied', decidedAt: 31 })).toBeNull();
    expect(body(store, id).outcome).toBe('approved-session');
    // `live` is never stored: a grant read from the store is ended (C81).
    expect(rawInteraction(id)['grant']).toEqual(grant);
  });

  it('writes the delivery and the confirmation on a decided item, whichever its decision was, and on no other', () => {
    const store = area.open();
    accept(store, 't1');
    const decided = ['approved', 'approved-session', 'denied'] as const;
    for (const outcome of decided) {
      const id = store.addInteraction(CONVERSATION, 't1', approval(`call_${outcome}`))?.item.id ?? '';
      expect(store.setInteraction(CONVERSATION, id, decided, { delivered: true })).toBeNull();
      store.setInteraction(CONVERSATION, id, 'pending', { outcome, decidedAt: 30 });
      expect(store.setInteraction(CONVERSATION, id, decided, { delivered: true })?.item.interaction).toMatchObject({ outcome, delivered: true, confirmedAt: null });
      expect(store.setInteraction(CONVERSATION, id, ['answered', ...decided], { confirmedAt: 40 })?.item.interaction).toMatchObject({ outcome, delivered: true, confirmedAt: 40 });
    }
  });

  it('settles what still waits with a question’s sweep: withdrawn with its cause, or dropped', () => {
    const store = area.open();
    accept(store, 't1');
    const first = store.addInteraction(CONVERSATION, 't1', approval('call_1'))?.item.id ?? '';
    const second = store.addInteraction(CONVERSATION, 't1', approval('call_2'))?.item.id ?? '';
    const third = store.addInteraction(CONVERSATION, 't1', approval('call_3'))?.item.id ?? '';
    store.setInteraction(CONVERSATION, third, 'pending', { outcome: 'approved', decidedAt: 30 });
    expect(store.settlePending(CONVERSATION, [first], { outcome: 'withdrawn', settledAt: 50, withdrawnBy: 'changed' }).map((settled) => settled.item.interaction)).toMatchObject([{ kind: 'approval', outcome: 'withdrawn', withdrawnBy: 'changed', settledAt: 50 }]);
    // A decided one is no longer pending, and no sweep relabels it.
    expect(store.settlePending(CONVERSATION, [second, third], { outcome: 'dropped', settledAt: 51 }).map((settled) => settled.item.id)).toEqual([second]);
    expect(body(store, third).outcome).toBe('approved');
  });

  it('fails as a whole when its write fails: nothing of a decision is on disk', () => {
    const store = area.open({ hook: (point) => { if (point === 'interaction-set') throw Object.assign(new Error('disk'), { code: 'EIO' }); } });
    accept(store, 't1');
    const id = store.addInteraction(CONVERSATION, 't1', approval('call_1'))?.item.id ?? '';
    expect(() => store.setInteraction(CONVERSATION, id, 'pending', { outcome: 'approved', decidedAt: 30 })).toThrow();
    expect(rawInteraction(id)).toMatchObject({ outcome: 'pending', decidedAt: null });
  });
});

describe('a session’s grants (V6, V32; C57, C92)', () => {
  it('are the decisions granted for the session whose reply was delivered, oldest first, a worker’s among them', () => {
    const store = area.open();
    accept(store, 't1');
    const grant = (n: number) => ({ covers: `Bash(run ${n})`, processKey: 'process-1' });
    const decide = (providerItemId: string, n: number, delivered: boolean | null, patch: Partial<NewApproval> = {}): string => {
      const id = store.addInteraction(CONVERSATION, 't1', approval(providerItemId, COMMAND, patch))?.item.id ?? '';
      store.setInteraction(CONVERSATION, id, 'pending', { outcome: 'approved-session', decidedAt: 30 + n, grant: grant(n) });
      if (delivered !== null) store.setInteraction(CONVERSATION, id, ['approved-session'], { delivered });
      return id;
    };
    const sent = decide('call_1', 1, true);
    decide('call_2', 2, false);
    decide('call_3', 3, null);
    const worker = decide('call_4', 4, true, { workerId: 'worker-1' });
    // An approval decided once sent no grant.
    const once = store.addInteraction(CONVERSATION, 't1', approval('call_5'))?.item.id ?? '';
    store.setInteraction(CONVERSATION, once, 'pending', { outcome: 'approved', decidedAt: 40 });
    store.setInteraction(CONVERSATION, once, ['approved'], { delivered: true });
    store.setInteraction(CONVERSATION, worker, ['approved-session'], { confirmedAt: 60 });
    expect(store.grants(CONVERSATION)).toEqual([
      { itemId: sent, covers: 'Bash(run 1)', processKey: 'process-1', decidedAt: 31, confirmedAt: null },
      { itemId: worker, covers: 'Bash(run 4)', processKey: 'process-1', decidedAt: 34, confirmedAt: 60 },
    ]);
    expect(store.grants(OTHER)).toEqual([]);
  });
});

describe('a removal (V6; C25, C26)', () => {
  it('leaves nothing of an approval, its decision or its grant in the store’s files', () => {
    const store = area.open();
    store.createConversation(CONVERSATION, 4, { id: 'ask-first', source: 'fallback' });
    accept(store, 't1');
    const id = store.addInteraction(CONVERSATION, 't1', approval('call_1'))?.item.id ?? '';
    store.setInteraction(CONVERSATION, id, 'pending', { outcome: 'approved-session', decidedAt: 30, grant: { covers: 'Bash(touch NEEDLE-COVERS notes.txt)', processKey: 'process-1' } });
    store.acceptPrompt({ conversationId: OTHER, turnId: 'o1', itemId: 'o-prompt', text: 'NEEDLE-KEPT', at: 6, started: false });
    const needles = ['NEEDLE-COMMAND', 'NEEDLE-TARGET', 'NEEDLE-REASON', 'NEEDLE-COVERS'];
    for (const text of needles) expect(area.holding(text), text).not.toEqual([]);
    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION]);
    for (const text of needles) expect(area.holding(text), text).toEqual([]);
    expect(area.holding('NEEDLE-KEPT')).toContain(STORE_FILE);
    expect(store.conversation(CONVERSATION)).toBeNull();
  });
});
