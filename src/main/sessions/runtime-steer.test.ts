// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8 (docs/planning/_archive/M23.md; C35–C46): Send now through the session runtime, on a real records store, a
// real conversation store, a real session service and a facet in the test's hands — the message
// recorded in the running turn before the adapter is called, its draft consumed, each steer outcome as
// its delivery, the stale turn's message sent once as the next prompt, a held message keeping the
// session busy until its CLI's word, the turn it became, a process lost with it, a command answered
// during a turn, and Send now offered and withdrawn.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import type { ChatPush } from '@shared/contracts/chat';
import { NO_INTENT } from '@shared/contracts/composer';
import type { ProviderStatus } from '@shared/contracts/status';
import { createBlobFiles } from '../attachments/files';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { createAppStateStore } from '../state/app-state-store';
import { type ChatService, createChatService } from './chat-service';
import { createGate } from './gate';
import { createRemoval } from './removal';
import { createSessionRuntime, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-02-11T09:00:00.000Z');

let dir: string;
let records: RecordsStore;
let service: SessionService;
let runtime: SessionRuntime;
let chat: ChatService;
let conversations: ConversationStore;
let fake: FakeFacet;
let ids: number;
let pushes: ChatPush[];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const modelUsed = vi.fn();
const status: ProviderStatus = { kind: 'ok' };

const root = () => ({ path: ROOT, trust: { answer: 'trusted', answeredAt: '2020-01-23T00:00:00.000Z' } });
const project = () => ({ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [root()] });
const session = (n: number) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: 'A session', nameSource: 'user',
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null,
});

function open(intercepts?: (prompt: string) => 'command-clear' | null): void {
  writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [project()], sessions: [session(1)] }));
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', now: () => AT, log });
  const store = createAppStateStore();
  fake = fakeFacet({ history: false, steers: true, ...(intercepts === undefined ? {} : { intercepts }) });
  const blobs = createBlobFiles(path.join(dir, ATTACHMENTS_FOLDER));
  conversations = createConversationStore({ dir, log, blobs });
  chat = createChatService({ store: conversations, log });
  pushes = [];
  chat.subscribe((push) => { pushes.push(push); });
  let ready = false;
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => false,
    snapshot: () => ({ status, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null } } }),
    hasRuntime: () => true,
    project: (id) => records.getProject(id),
    isMissing: () => false,
    kept: (id) => (ready ? runtime.kept(id) : undefined),
    platform: 'win32',
  });
  service = createSessionService({ records, store, now: () => AT, platform: 'win32', log, block: (record, hold) => gate.block(record, hold), onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome) });
  runtime = createSessionRuntime({
    modelUsed,
    sessions: service, records, chat, gate, log, now: () => AT, newId: () => `id-${++ids}`,
    facet: () => fake.facet,
    providerName: () => 'Codex',
    hasHistory: () => false,
    store: conversations,
    removal: createRemoval({ store: conversations, log }),
    composer: { store: conversations, blobs },
    // Its messages carry questions, which become async cards (M21).
    questions: () => 'both',
  });
  ready = true;
}

beforeEach(() => {
  modelUsed.mockReset();
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-runtime-steer-'));
  ids = 0;
  for (const spy of Object.values(log)) spy.mockClear();
});
afterEach(async () => {
  runtime?.dispose();
  // A record write still under way would make the folder again once it is removed.
  await service?.settled();
  service?.stop();
  conversations?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** What a steer's answer starts: its handlers run once the promise has settled. */
const settled = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/** A first prompt, taken: its turn runs. */
async function running(): Promise<string> {
  expect(await runtime.send(S(1), 'Read every file')).toEqual({ status: 'accepted' });
  const turnId = fake.latest().sent[0]?.turnId ?? '';
  fake.latest().emit({ type: 'turn-started', turnId, providerTurnId: 'pt-1' });
  return turnId;
}

function finish(turnId: string): void {
  fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'completed', reported: true });
}

const now = (prompt: string, revision = 2) => runtime.send(S(1), prompt, { now: true, input: { revision, attachmentIds: [], intent: NO_INTENT } });
const item = (id: string) => conversations.newestPage(S(1)).items.find((entry) => entry.id === id);

describe('Send now (V8; C35–C46)', () => {
  it('tracks the active turn effort for a steer after the next-turn effort changes', async () => {
    open();
    await running();
    await service.setEffort(S(1), 'low');
    expect(modelUsed).toHaveBeenCalledOnce();
    expect(await now('One more thing')).toEqual({ status: 'accepted' });
    expect(modelUsed).toHaveBeenCalledTimes(2);
    expect(modelUsed).toHaveBeenLastCalledWith({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null });
    expect(fake.latest().steers).toHaveLength(1);
  });
  it('records the message in the running turn before the adapter is called, consumes its draft, and says Taken from the steer’s reply', async () => {
    open();
    const turnId = await running();
    fake.latest().steerOutcome = 'hold';
    conversations.saveDraft(S(1), 1, { text: 'Also the tests', intent: NO_INTENT }, AT, true);
    expect(await now('Also the tests')).toEqual({ status: 'accepted' });
    const steer = fake.latest().steers[0];
    expect(steer).toMatchObject({ turnId, prompt: 'Also the tests' });
    expect(item(steer?.messageId ?? '')).toMatchObject({ role: 'user', turnId, delivery: { state: 'sent', detail: null } });
    expect(conversations.draft(S(1))).toMatchObject({ revision: 2, text: '' });
    fake.latest().settleSteer({ kind: 'taken' });
    await settled();
    expect(item(steer?.messageId ?? '')?.delivery).toEqual({ state: 'taken', detail: null });
    // No turn of its own: one prompt was sent, and the turn goes on.
    expect(fake.latest().sent).toHaveLength(1);
    expect(service.snapshot().sessions[0]?.summary.status).toBe('running');
  });

  it('sends nothing now with Plan pressed, a skill chosen, or where the process never takes a message during a turn, and nothing is recorded or held', async () => {
    open();
    await running();
    expect(await runtime.send(S(1), 'Plan it', { now: true, input: { revision: 2, attachmentIds: [], intent: { plan: true, skill: null } } })).toEqual({ status: 'refused', reason: 'not-steerable' });
    expect(await runtime.send(S(1), 'Use it', { now: true, input: { revision: 2, attachmentIds: [], intent: { plan: false, skill: { name: 'review', selector: 'a'.repeat(16) } } } })).toEqual({ status: 'refused', reason: 'not-steerable' });
    fake.latest().steerState = 'unsupported';
    expect(await now('Not now')).toEqual({ status: 'refused', reason: 'not-steerable' });
    expect(fake.latest().steers).toEqual([]);
    expect(conversations.newestPage(S(1)).items.filter((entry) => entry.role === 'user')).toHaveLength(1);
    expect(conversations.queue(S(1))).toEqual([]);
  });

  it('sends as an ordinary prompt where the turn ended before anything was written', async () => {
    open();
    finish(await running());
    expect(await now('After the end')).toEqual({ status: 'accepted' });
    expect(fake.latest().steers).toEqual([]);
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['Read every file', 'After the end']);
  });

  it('sends a message its turn’s end refused once as the next prompt, once that end is in, and says so under it', async () => {
    open();
    const turnId = await running();
    fake.latest().steerOutcome = { kind: 'turn-over' };
    await now('Too late for this turn');
    await settled();
    const messageId = fake.latest().steers[0]?.messageId ?? '';
    // Not yet: the turn's end is not in.
    expect(fake.latest().sent).toHaveLength(1);
    finish(turnId);
    await settled();
    const next = fake.latest().sent[1];
    expect(next).toMatchObject({ messageId, prompt: 'Too late for this turn' });
    expect(item(messageId)).toMatchObject({ turnId: next?.turnId, delivery: { state: 'next-prompt', detail: null } });
    expect(conversations.newestPage(S(1)).turns.map((turn) => turn.id)).toEqual([turnId, next?.turnId]);
  });

  it('says Not sent with the CLI’s word for a refusal, and Not confirmed where no word came; nothing is sent again', async () => {
    open();
    await running();
    fake.latest().steerOutcome = { kind: 'refused', detail: 'not now (-32000)' };
    await now('First');
    fake.latest().steerOutcome = { kind: 'unknown' };
    await now('Second', 3);
    await settled();
    const [first, second] = fake.latest().steers;
    expect(item(first?.messageId ?? '')?.delivery).toEqual({ state: 'not-sent', detail: 'not now (-32000)' });
    expect(item(second?.messageId ?? '')?.delivery).toEqual({ state: 'not-confirmed', detail: null });
    expect(fake.latest().sent).toHaveLength(1);
  });

  it('keeps the session busy while its CLI holds a handed message, and moves it to the turn it became', async () => {
    open();
    const turnId = await running();
    fake.latest().steerOutcome = { kind: 'handed' };
    await now('Then this');
    await service.setSpeed(S(1), 'priority');
    await settled();
    const messageId = fake.latest().steers[0]?.messageId ?? '';
    finish(turnId);
    // Not idle: nothing else is taken while the held message may yet start.
    expect(await runtime.send(S(1), 'Something else')).toEqual({ status: 'refused', reason: 'running' });
    fake.latest().emit({ type: 'held-turn-started', turnId: 'held-turn', messageId });
    expect(item(messageId)).toMatchObject({ turnId: 'held-turn', delivery: { state: 'taken', detail: null } });
    expect(conversations.turn(S(1), 'held-turn')?.speed).toBeNull();
    expect(service.snapshot().sessions[0]?.summary.status).toBe('running');
    fake.latest().emit({ type: 'message', turnId: 'held-turn', role: 'assistant', itemId: 'a2', phase: 'final', text: 'Done with that too' });
    finish('held-turn');
    expect(service.snapshot().sessions[0]?.summary.status).not.toBe('running');
    expect(await runtime.send(S(1), 'Something else')).toEqual({ status: 'accepted' });
  });

  it('says Cancelled for a held message a Stop took back, and Not confirmed for one its process ended with', async () => {
    open();
    await running();
    fake.latest().steerOutcome = { kind: 'handed' };
    await now('First');
    await now('Second', 3);
    await settled();
    const [first, second] = fake.latest().steers;
    fake.latest().emit({ type: 'delivery', messageId: first?.messageId ?? '', state: 'cancelled' });
    expect(item(first?.messageId ?? '')?.delivery).toEqual({ state: 'cancelled', detail: null });
    fake.latest().end();
    await settled();
    expect(item(second?.messageId ?? '')?.delivery).toEqual({ state: 'not-confirmed', detail: null });
  });

  it('answers a command fat-g answers itself in the running turn: its message and the notice there, nothing sent, no turn started', async () => {
    open((prompt) => (prompt === '/clear' ? 'command-clear' : null));
    const turnId = await running();
    expect(await now('/clear')).toEqual({ status: 'accepted' });
    expect(fake.latest().steers).toEqual([]);
    const items = conversations.newestPage(S(1)).items;
    expect(items.map((entry) => [entry.turnId, entry.role ?? entry.kind])).toEqual([[turnId, 'user'], [turnId, 'user'], [turnId, 'notice']]);
    expect(items[1]).not.toHaveProperty('delivery');
    expect(conversations.newestPage(S(1)).turns).toHaveLength(1);
  });

  it('answers an async card while its turn runs by a message into that turn, the card answered in the same write (C45)', async () => {
    open();
    const turnId = await running();
    fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-q', phase: 'commentary', text: 'One question first.', questions: [{ title: 'Which file?', options: ['notes-1.txt', 'notes-2.txt'] }] });
    const card = conversations.newestPage(S(1)).items.find((entry) => entry.kind === 'interaction');
    expect(await runtime.answer(S(1), card?.id ?? '', [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    const steer = fake.latest().steers[0];
    expect(steer?.turnId).toBe(turnId);
    expect(steer?.prompt).toContain('notes-2.txt');
    const items = conversations.newestPage(S(1)).items;
    expect(items.find((entry) => entry.id === card?.id)?.interaction).toMatchObject({ outcome: 'answered' });
    expect(items.find((entry) => entry.id === steer?.messageId)).toMatchObject({ turnId, role: 'user' });
    // No turn of its own.
    expect(fake.latest().sent).toHaveLength(1);
  });

  it('tells the page whether the turn takes a message, and when that changes, a change the adapter alone knows of among them', async () => {
    open();
    const read = runtime.read(S(1));
    if (read.status !== 'read') throw new Error('not read');
    expect(read.composer?.steer).toBe('wait');
    const turnId = await running();
    const told = () => pushes.filter((push): push is Extract<ChatPush, { composer: unknown }> => 'composer' in push).map((push) => push.composer.steer);
    expect(told().at(-1)).toBe('open');
    fake.latest().steerState = 'unsupported';
    fake.latest().emit({ type: 'steer-changed' });
    expect(told().at(-1)).toBe('unsupported');
    fake.latest().steerState = 'open';
    fake.latest().emit({ type: 'steer-changed' });
    runtime.stop(S(1));
    expect(told().at(-1)).toBe('open');
    finish(turnId);
    expect(told().at(-1)).toBe('wait');
  });
});

describe('a Send now held until the turn takes it', () => {
  const queued = () => conversations.queue(S(1)).map((entry) => entry.text);
  const shown = () => {
    const read = runtime.read(S(1));
    if (read.status !== 'read') throw new Error('not read');
    return read.composer?.queue.entries.map((entry) => [entry.text, entry.now]);
  };
  const open_ = (): void => { fake.latest().steerState = 'open'; fake.latest().emit({ type: 'steer-changed' }); };

  it('is held first in the queue, its draft consumed, and goes into the turn as soon as that takes a message', async () => {
    open();
    const turnId = await running();
    fake.latest().steerState = 'wait';
    conversations.saveDraft(S(1), 1, { text: 'Also the tests', intent: NO_INTENT }, AT, true);
    expect(await now('Also the tests')).toEqual({ status: 'accepted' });
    expect(fake.latest().steers).toEqual([]);
    expect(shown()).toEqual([['Also the tests', true]]);
    expect(conversations.draft(S(1))).toMatchObject({ revision: 2, text: '' });
    open_();
    await settled();
    const steer = fake.latest().steers[0];
    expect(steer).toMatchObject({ turnId, prompt: 'Also the tests' });
    expect(item(steer?.messageId ?? '')).toMatchObject({ role: 'user', turnId, delivery: { state: 'taken', detail: null } });
    expect(queued()).toEqual([]);
    expect(fake.latest().sent).toHaveLength(1);
  });

  it('goes as the next prompt where the turn ends first, ahead of what was queued before it', async () => {
    open();
    const turnId = await running();
    expect(await runtime.queue({ sessionId: S(1), op: 'append', prompt: 'Queued first', revision: 2, attachments: [], intent: NO_INTENT })).toEqual({ status: 'saved' });
    fake.latest().steerState = 'wait';
    expect(await now('Sent now', 3)).toEqual({ status: 'accepted' });
    expect(shown()).toEqual([['Sent now', true], ['Queued first', false]]);
    finish(turnId);
    await settled();
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['Read every file', 'Sent now']);
    expect(queued()).toEqual(['Queued first']);
  });

  it('waits out workers that run alone, and goes as the next prompt at their end', async () => {
    open();
    const turnId = await running();
    fake.latest().emit({ type: 'worker-started', workerId: 'worker-1', description: 'reads' });
    finish(turnId);
    expect(service.snapshot().sessions[0]?.summary.status).toBe('running');
    expect(await now('After the workers')).toEqual({ status: 'accepted' });
    expect(fake.latest().sent).toHaveLength(1);
    fake.latest().emit({ type: 'worker-ended', workerId: 'worker-1', outcome: 'completed' });
    await settled();
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['Read every file', 'After the workers']);
  });

  it('keeps presses in their order: one pressed while another is held goes behind it, even once the turn takes messages', async () => {
    open();
    await running();
    fake.latest().steerState = 'wait';
    await now('First', 2);
    await now('Second', 3);
    expect(shown()).toEqual([['First', true], ['Second', true]]);
    open_();
    await settled();
    await settled();
    expect(fake.latest().steers.map((steer) => steer.prompt)).toEqual(['First', 'Second']);
    expect(queued()).toEqual([]);
    // The turn takes messages, and nothing has said so yet: a press goes behind the one held, which goes first.
    fake.latest().steerState = 'wait';
    await now('Third', 4);
    fake.latest().steerState = 'open';
    await now('Fourth', 5);
    await settled();
    await settled();
    expect(fake.latest().steers.map((steer) => steer.prompt)).toEqual(['First', 'Second', 'Third', 'Fourth']);
  });

  it('goes as the next prompt after a Stop, the first opportunity a Stop leaves', async () => {
    open();
    const turnId = await running();
    fake.latest().steerState = 'wait';
    await now('After the stop');
    expect(runtime.stop(S(1))).toEqual({ status: 'stopping' });
    fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'interrupted', reported: true });
    await settled();
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['Read every file', 'After the stop']);
  });

  it('is refused where the queue holds ten already, and nothing is held', async () => {
    open();
    await running();
    for (let n = 0; n < 10; n += 1) await runtime.queue({ sessionId: S(1), op: 'append', prompt: `Queued ${n}`, revision: n + 2, attachments: [], intent: NO_INTENT });
    fake.latest().steerState = 'wait';
    expect(await now('One too many', 12)).toEqual({ status: 'refused', reason: 'queue-full' });
    expect(queued()).toHaveLength(10);
  });

  it('is held no more once edited, and stays ahead of what was queued', async () => {
    open();
    await running();
    await runtime.queue({ sessionId: S(1), op: 'append', prompt: 'Queued first', revision: 2, attachments: [], intent: NO_INTENT });
    fake.latest().steerState = 'wait';
    await now('Held', 3);
    const held = conversations.queue(S(1))[0];
    expect(await runtime.editQueued({ sessionId: S(1), entryId: held?.id ?? '', prompt: 'Typed meanwhile', revision: 4, attachments: [], intent: NO_INTENT })).toEqual({ status: 'saved' });
    expect(shown()).toEqual([['Typed meanwhile', false], ['Queued first', false]]);
    // A move of a held entry behind what was queued is refused.
    fake.latest().steerState = 'wait';
    await now('Held again', 6);
    const order = conversations.queue(S(1)).map((entry) => entry.id);
    expect(order.length).toBe(3);
    expect(await runtime.queue({ sessionId: S(1), op: 'reorder', ids: [order[1] ?? '', order[0] ?? '', order[2] ?? ''] })).toEqual({ status: 'refused', reason: 'sending' });
  });

  it('leaves an async card’s answer refused as running while the turn takes no message', async () => {
    open();
    const turnId = await running();
    fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-q', phase: 'commentary', text: 'One question first.', questions: [{ title: 'Which file?', options: ['notes-1.txt', 'notes-2.txt'] }] });
    const card = conversations.newestPage(S(1)).items.find((entry) => entry.kind === 'interaction');
    fake.latest().steerState = 'wait';
    expect(await runtime.answer(S(1), card?.id ?? '', [{ question: 0, options: [1], text: null }])).toEqual({ status: 'refused', reason: 'running' });
    expect(queued()).toEqual([]);
  });
});
