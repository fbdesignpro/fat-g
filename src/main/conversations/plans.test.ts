// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The conversation store at version 7 (docs/planning/_archive/M22b.md, Design 3; V2, V4; C17, C27, C55, C56,
// C69, C71, C74, C76, C78), on a real file: a plan turn's flag, a plan's line under the interaction's
// key, a decision taken in its prompt's own transaction, a plan brought into a chat in a turn of
// fat-g's own, and what a line that waits reads after a restart. And at version 8
// (docs/planning/_archive/M22e.md, Design 2; C53): a review prompt's fields.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryMessage, HistoryPlan, HistoryTurn } from '@shared/contracts/agent-events';
import { ITEM_KINDS } from '@shared/contracts/conversation';
import { planOf, raisedPlan } from '@shared/contracts/interaction';
import { planPrompt } from '@shared/contracts/plans';
import { APPLICATION_ID, NEEDED_COLUMNS, SCHEMA, STORE_FILE } from './format';
import { type ConversationStore, type NewPlan, StorageFailure } from './store';
import { planTurn } from './merge';
import { CONVERSATION, OTHER, type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const PLAN = 'a1b2c3d4-0000-4000-8000-000000000001';
let made = 0;
function line(patch: Partial<Parameters<typeof raisedPlan>[0]> = {}, providerItemId: string | null = 'toolu_plan'): NewPlan {
  made += 1;
  return { id: `line-${made}`, providerItemId, body: raisedPlan({ planId: PLAN, version: 1, came: 'made', request: false, ...patch }), receivedAt: 30 };
}
const accept = (store: ConversationStore, turnId: string, patch: Partial<Parameters<ConversationStore['acceptPrompt']>[0]> = {}) =>
  store.acceptPrompt({ conversationId: CONVERSATION, turnId, itemId: `prompt-${turnId}`, text: 'Make a plan', at: 5, started: false, ...patch });
const outcomeOf = (store: ConversationStore, itemId: string): string | null => {
  const item = store.item(CONVERSATION, itemId)?.item;
  return item === undefined ? null : planOf(item)?.outcome ?? null;
};

describe('the format, version 7 (V2; C17, C71)', () => {
  it('says on a turn whether it was a plan turn, and holds a plan’s line as an interaction, no item kind added', () => {
    expect(NEEDED_COLUMNS['turn']).toContain('plan');
    const store = area.open();
    accept(store, 't1', { plan: true });
    accept(store, 't2');
    expect(store.turn(CONVERSATION, 't1')?.plan).toBe(true);
    expect(store.turn(CONVERSATION, 't2')?.plan).toBe(false);
    const stored = store.addPlan(CONVERSATION, 't1', line());
    expect(stored.item.kind).toBe('interaction');
    expect(planOf(stored.item)).toMatchObject({ kind: 'plan', planId: PLAN, version: 1, came: 'made', outcome: 'pending' });
    expect(ITEM_KINDS).toEqual(['message', 'notice', 'activity', 'interaction']);
  });

  it('refuses a version-6 store, as M22 made it, as older, byte for byte unchanged', () => {
    const db = new DatabaseSync(area.file);
    db.exec('PRAGMA auto_vacuum=FULL');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    for (const statement of SCHEMA) db.exec(statement.replace(', plan INTEGER NOT NULL DEFAULT 0', ''));
    db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, 6, 6)').run();
    db.close();
    const before = area.hashes();
    const store = area.open();
    expect(store.status()).toEqual({ kind: 'refused', cause: 'older' });
    store.close();
    // The main file, byte for byte: SQLite's own keeps beside it are no part of it.
    expect(area.hashes()[STORE_FILE]).toBe(before[STORE_FILE]);
  });

  it('keeps a prompt’s plan fields on its item, and none on any other', () => {
    const store = area.open();
    const accepted = accept(store, 't1', { plan: true, fields: { planId: PLAN, version: 2, intent: 'revise' } });
    expect(accepted.item.plan).toEqual({ planId: PLAN, version: 2, intent: 'revise' });
    expect(accept(store, 't2').item.plan).toBeNull();
    expect(store.newestPage(CONVERSATION).items.map((item) => item.plan)).toEqual([{ planId: PLAN, version: 2, intent: 'revise' }, null]);
  });
});

describe('the format, version 8 (M22e, V2; C53)', () => {
  it('keeps a review prompt’s fields, the intent `review`, and reads them back after a restart', () => {
    const store = area.open();
    expect(accept(store, 't1', { fields: { planId: PLAN, version: 3, intent: 'review' } }).item.plan).toEqual({ planId: PLAN, version: 3, intent: 'review' });
    expect(store.turn(CONVERSATION, 't1')?.plan).toBe(false);
    store.close();
    const again = area.open();
    expect(again.newestPage(CONVERSATION).items[0]?.plan).toEqual({ planId: PLAN, version: 3, intent: 'review' });
    expect(again.turnPlan(CONVERSATION, 't1')).toMatchObject({ plan: false, fields: { intent: 'review' } });
  });

  it('refuses a version-7 store, as M22b made it, as older, byte for byte unchanged: version 8 added no column', () => {
    const db = new DatabaseSync(area.file);
    db.exec('PRAGMA auto_vacuum=FULL');
    db.exec('PRAGMA journal_mode=WAL');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    for (const statement of SCHEMA) db.exec(statement);
    db.prepare('INSERT INTO meta (id, schemaVersion, minReaderVersion) VALUES (1, 7, 7)').run();
    db.close();
    const before = area.hashes();
    const store = area.open();
    expect(store.status()).toEqual({ kind: 'refused', cause: 'older' });
    store.close();
    expect(area.hashes()[STORE_FILE]).toBe(before[STORE_FILE]);
  });
});

describe('the format, version 11 (decision 0029)', () => {
  it('closes a line as superseded, decided elsewhere, left or retired, each kept across a restart', () => {
    const store = area.open();
    accept(store, 't1', { plan: true });
    const lines = (['superseded', 'elsewhere', 'left', 'retired'] as const).map((outcome) => {
      const stored = store.addPlan(CONVERSATION, 't1', line());
      expect(store.setInteraction(CONVERSATION, stored.item.id, 'pending', { outcome, settledAt: 9 })).not.toBeNull();
      return [stored.item.id, outcome] as const;
    });
    store.close();
    const again = area.open();
    for (const [itemId, outcome] of lines) expect(outcomeOf(again, itemId)).toBe(outcome);
    // None waits any more.
    expect(again.planWaiters(PLAN)).toEqual([]);
  });

  it('keeps where a plan the chat took part in was implemented, a session’s id and a time, until it is cleared', () => {
    const store = area.open();
    accept(store, 't1');
    expect(store.planNote(CONVERSATION)).toBeNull();
    store.setPlanNote(CONVERSATION, { sessionId: OTHER, at: 42 });
    store.close();
    const again = area.open();
    expect(again.planNote(CONVERSATION)).toEqual({ sessionId: OTHER, at: 42 });
    again.setPlanNote(CONVERSATION, null);
    expect(again.planNote(CONVERSATION)).toBeNull();
    // A conversation the store does not hold is left without one.
    again.setPlanNote('no-such-conversation', { sessionId: OTHER, at: 1 });
    expect(again.planNote('no-such-conversation')).toBeNull();
  });
});

describe('a line that waits, after a restart (C27, C56)', () => {
  it('stays pending where no request holds it, and reads dropped where one did', () => {
    const store = area.open();
    accept(store, 't1', { plan: true });
    const codex = store.addPlan(CONVERSATION, 't1', line());
    const claude = store.addPlan(CONVERSATION, 't1', line({ request: true, version: 2 }));
    store.close();
    const again = area.open();
    expect(outcomeOf(again, codex.item.id)).toBe('pending');
    expect(outcomeOf(again, claude.item.id)).toBe('dropped');
    expect(again.pendingPlans().map((row) => [row.itemId, row.request])).toEqual([[codex.item.id, false], [claude.item.id, true]]);
  });

  it('is unfinished at a launch where an earlier run left it written (C59, C74)', () => {
    const store = area.open();
    accept(store, 't1', { plan: true });
    const writing = store.addPlan(CONVERSATION, 't1', line({ writing: true }, 'plan_item'));
    expect(outcomeOf(store, writing.item.id)).toBe('writing');
    expect(store.unfinishPlans(99)).toBe(1);
    expect(store.item(CONVERSATION, writing.item.id)?.item.interaction).toMatchObject({ outcome: 'unfinished', settledAt: 99 });
    expect(store.unfinishPlans(100)).toBe(0);
  });
});

describe('a decision taken by a prompt (C12, C15, C65)', () => {
  it('is checked and taken in the prompt’s own transaction, with the turn that carries it out', () => {
    const store = area.open();
    accept(store, 't1', { plan: true });
    const pending = store.addPlan(CONVERSATION, 't1', line());
    accept(store, 't2', { deciding: { itemId: pending.item.id, outcome: 'executed' }, fields: { planId: PLAN, version: 1, intent: 'execute' }, text: 'Implement the plan you proposed.' });
    expect(store.item(CONVERSATION, pending.item.id)?.item.interaction).toMatchObject({ outcome: 'executed', decidedAt: 5 });
    expect(store.turn(CONVERSATION, 't2')?.plan).toBe(false);
  });

  it('is refused as not pending, with nothing written, where the line was decided meanwhile', () => {
    const store = area.open();
    accept(store, 't1', { plan: true });
    const pending = store.addPlan(CONVERSATION, 't1', line());
    store.setInteraction(CONVERSATION, pending.item.id, 'pending', { outcome: 'cancelled', decidedAt: 6 });
    const before = store.newestPage(CONVERSATION).items.length;
    expect(() => accept(store, 't2', { deciding: { itemId: pending.item.id, outcome: 'feedback' } })).toThrow(new StorageFailure('not-pending'));
    expect(store.newestPage(CONVERSATION).items).toHaveLength(before);
    expect(store.turn(CONVERSATION, 't2')).toBeNull();
    // Nor an item that is no plan's line.
    expect(() => accept(store, 't3', { deciding: { itemId: 'prompt-t1', outcome: 'executed' } })).toThrow(new StorageFailure('not-pending'));
  });
});

// The maintainer: a feedback a request takes shows in the chat as the user's message.
describe('a feedback a plan’s request takes', () => {
  it('is written with the line’s outcome in one transaction: the user’s message after the line, naming its version to revise, kept across a restart', () => {
    let store = area.open();
    accept(store, 't1', { plan: true });
    const pending = store.addPlan(CONVERSATION, 't1', line({ request: true }));
    const written = store.setPlanFeedback(CONVERSATION, pending.item.id, { outcome: 'feedback', decidedAt: 6 }, { id: 'feedback-1', text: 'Shorter, please.', at: 6 });
    expect(written?.line.item.interaction).toMatchObject({ outcome: 'feedback', decidedAt: 6 });
    expect(written?.prompt.item).toMatchObject({ id: 'feedback-1', turnId: 't1', kind: 'message', role: 'user', plan: { planId: PLAN, version: 1, intent: 'revise' } });
    store.close();
    store = area.open();
    const items = store.newestPage(CONVERSATION).items;
    expect(items.map((item) => item.id).slice(-2)).toEqual([pending.item.id, 'feedback-1']);
    expect(items.at(-1)?.blocks[0]?.text).toBe('Shorter, please.');
    // The turn's prompt is still its first.
    expect(store.turnPlan(CONVERSATION, 't1')?.prompt).toBe('Make a plan');
  });

  it('writes nothing where the line is no longer pending, or is no plan’s line', () => {
    const store = area.open();
    accept(store, 't1', { plan: true });
    const pending = store.addPlan(CONVERSATION, 't1', line({ request: true }));
    store.setInteraction(CONVERSATION, pending.item.id, 'pending', { outcome: 'cancelled', decidedAt: 6 });
    const before = store.newestPage(CONVERSATION).items.length;
    expect(store.setPlanFeedback(CONVERSATION, pending.item.id, { outcome: 'feedback', decidedAt: 7 }, { id: 'feedback-1', text: 'Late.', at: 7 })).toBeNull();
    expect(store.setPlanFeedback(CONVERSATION, 'prompt-t1', { outcome: 'feedback', decidedAt: 7 }, { id: 'feedback-2', text: 'Nowhere.', at: 7 })).toBeNull();
    expect(store.newestPage(CONVERSATION).items).toHaveLength(before);
    expect(outcomeOf(store, pending.item.id)).toBe('cancelled');
  });
});

describe('a plan brought into a chat (C64, C76)', () => {
  it('stands in a turn of fat-g’s own, ended at once, in a conversation made for it where it is new', () => {
    const store = area.open();
    const brought = store.bringPlan(OTHER, { turnId: 'own-1', at: 40, started: false }, line({ came: 'brought' }, null));
    expect(brought.turn).toMatchObject({ own: true, place: 1, sessionOutcome: 'completed', sessionEndedAt: 40 });
    expect(planOf(brought.item)).toMatchObject({ came: 'brought', outcome: 'pending', request: false });
    expect(store.conversation(OTHER)?.startHeld).toBe(true);
    const page = store.newestPage(OTHER);
    expect(page.items.map((item) => item.id)).toEqual([brought.item.id]);
  });
});

describe('a plan read back from the provider’s history (C28, C69)', () => {
  const read = (turnId: string): HistoryTurn => ({ turnId, outcome: 'completed', startedAt: 1_000, endedAt: 3_000, durationMs: 1_900 });
  const asked = (turnId: string, itemId: string, text: string, clientId?: string): HistoryMessage => ({ role: 'user', itemId, phase: null, text, turnId, at: 1_000, order: 0, ...(clientId === undefined ? {} : { clientId }) });
  const planned = (turnId: string, itemId: string, text: string): HistoryPlan => ({ turnId, itemId, text, at: 1_000, order: 1 });
  const merge = (store: ConversationStore, turnId: string, messages: readonly HistoryMessage[], plans: readonly HistoryPlan[]) =>
    store.mergePage(CONVERSATION, [planTurn(read(turnId), messages, 'full', store.held(CONVERSATION), [], plans)], null, 'not shown');
  const kinds = (store: ConversationStore) => store.newestPage(CONVERSATION).items.map((item) => (item.kind === 'message' ? `${item.role ?? ''}: ${item.blocks[0]?.text ?? ''}` : item.kind));

  it('is the plan line its turn holds, matched by the provider’s item id: nothing of it is written', () => {
    const store = area.open();
    accept(store, 't1', { plan: true });
    store.providerTook(CONVERSATION, 't1', 'p-1');
    const stored = store.addPlan(CONVERSATION, 't1', line({}, 'plan_item'));
    expect(merge(store, 'p-1', [asked('p-1', 'i-1', 'Make a plan', 'prompt-t1')], [planned('p-1', 'plan_item', '# The plan')]).changed).toBe(true);
    expect(kinds(store)).toEqual(['user: Make a plan', 'interaction']);
    expect(outcomeOf(store, stored.item.id)).toBe('pending');
    expect(store.pendingPlans()).toHaveLength(1);
    expect(merge(store, 'p-1', [asked('p-1', 'i-1', 'Make a plan', 'prompt-t1')], [planned('p-1', 'plan_item', '# The plan')]).changed).toBe(false);
  });

  it('is a message with the plan’s text where the store holds no line of it — never a version — and a second read adds nothing', () => {
    const store = area.open();
    merge(store, 'p-2', [asked('p-2', 'i-1', 'Plan elsewhere')], [planned('p-2', 'plan_elsewhere', '# Made in a terminal')]);
    expect(kinds(store)).toEqual(['user: Plan elsewhere', 'assistant: # Made in a terminal']);
    expect(store.pendingPlans()).toEqual([]);
    expect(merge(store, 'p-2', [asked('p-2', 'i-1', 'Plan elsewhere')], [planned('p-2', 'plan_elsewhere', '# Made in a terminal')]).changed).toBe(false);
    expect(kinds(store)).toHaveLength(2);
  });

  it('names the plan a prompt of fat-g’s composed, by its block, where the store holds no item of it, and none on a plain prompt (C69)', () => {
    const store = area.open();
    const prompt = planPrompt({ decision: 'execute', planId: PLAN, version: 2, text: null, feedback: null, token: '0123456789ab' });
    merge(store, 'p-3', [asked('p-3', 'i-1', prompt)], []);
    merge(store, 'p-4', [asked('p-4', 'i-2', 'A plain prompt')], []);
    const [executed, plain] = store.newestPage(CONVERSATION).items;
    expect(executed?.plan).toEqual({ planId: PLAN, version: 2, intent: 'execute' });
    expect(executed?.blocks[0]?.text).toBe(prompt);
    expect(plain?.plan).toBeNull();
  });
});

describe('what the runtime asks (C55, C73, C78)', () => {
  it('says whether a conversation planned before, what a turn plans, and which chats wait on a plan', () => {
    const store = area.open();
    accept(store, 't1');
    expect(store.plannedBefore(CONVERSATION)).toBe(false);
    accept(store, 't2', { plan: true, fields: { planId: PLAN, version: 1, intent: 'revise' } });
    expect(store.plannedBefore(CONVERSATION)).toBe(true);
    expect(store.turnPlan(CONVERSATION, 't2')).toEqual({ plan: true, fields: { planId: PLAN, version: 1, intent: 'revise' }, prompt: 'Make a plan', newest: null });
    const first = store.addPlan(CONVERSATION, 't2', line({ version: 2 }));
    store.setInteraction(CONVERSATION, first.item.id, 'pending', { outcome: 'feedback', decidedAt: 8 });
    const second = store.addPlan(CONVERSATION, 't2', line({ version: 3 }));
    expect(store.turnPlan(CONVERSATION, 't2')?.newest).toEqual({ itemId: second.item.id, planId: PLAN, version: 3, outcome: 'pending' });
    expect(store.turnPlan(CONVERSATION, 'no-turn')).toBeNull();
    store.bringPlan(OTHER, { turnId: 'own-1', at: 40, started: true }, line({ came: 'brought', version: 3 }, null));
    expect(store.planWaiters(PLAN).map((row) => [row.conversationId, row.version])).toEqual([[CONVERSATION, 3], [OTHER, 3]]);
    expect(store.planWaiters('other-plan')).toEqual([]);
  });
});
