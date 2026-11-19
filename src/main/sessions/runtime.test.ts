// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V14, V17, V22, V27, V32, V34, V37, V41, V42, V48, V51, V53 (docs/planning/_archive/M15.md) and V5, V6,
// V8, V11, V17, V21, V26, V28 (M18.md): the session runtime, on a real records store, a real
// conversation store and session service, and a facet in the test's hands. No Electron, no process.
// The same runtime against the replay fake is in tests/codex/runtime.integration.test.ts.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../tests/support/catalog';
import type { HistoryAnswer } from '@shared/provider-kit/sessions';
import type { ChatPush } from '@shared/contracts/chat';
import { itemText } from '@shared/contracts/conversation';
import type { ProviderStatus } from '@shared/contracts/status';
import { STORE_FILE } from '../conversations/format';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { writeFileAtomic } from '../storage/atomic-write';
import { createRecordsStore, type RecordsStore, type RecordsStoreOptions } from '../records/store';
import { createAppStateStore } from '../state/app-state-store';
import { type ChatService, createChatService } from './chat-service';
import { createGate } from './gate';
import { createRemoval } from './removal';
import { createSessionRuntime, IDLE_CLOSE_MS, QUIT_STOP_MS, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet, historyTurn, pagedHistory } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-01-24T13:00:00.000Z');

/** Timers a test moves by hand, so the store's own file writes keep their real time. */
function manualTimers() {
  let clock = 0;
  const pending = new Set<{ at: number; run: () => void }>();
  return {
    set(run: () => void, ms: number) { const entry = { at: clock + ms, run }; pending.add(entry); return entry; },
    clear(handle: unknown) { pending.delete(handle as { at: number; run: () => void }); },
    advance(ms: number) {
      clock += ms;
      for (const entry of [...pending].sort((a, b) => a.at - b.at)) if (entry.at <= clock && pending.delete(entry)) entry.run();
    },
    count: () => pending.size,
  };
}

let dir: string;
let file: string;
let records: RecordsStore;
let service: SessionService;
let runtime: SessionRuntime;
let chat: ChatService;
let conversations: ConversationStore;
let fake: FakeFacet;
let timers: ReturnType<typeof manualTimers>;
let ids: number;
/** The two clocks the runtime reads: the system's, which a user may move, and the monotonic one (M19, C44). */
let clock: { wall: number; mono: number };
let runtimeReady = false;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const modelUsed = vi.fn();
/** What the gate reads, for a test to change. */
const world = { status: { kind: 'ok' } as ProviderStatus, hasRuntime: true, hasFacet: true, demo: false, missing: false, history: true, otherFolders: false, missingRoots: new Set<string>() };
/** A fault for the conversation store's next writes: the transaction's name, or null for none. */
let storeFault: string | null = null;
/** What the runtime asked of the secretary (M26). */
const secretary = { titles: [] as { sessionId: string; providerId: string; instanceId: string; model: string; prompt: string }[], forgotten: [] as string[], disposed: 0 };

beforeEach(() => {
  modelUsed.mockReset();
  runtimeReady = false;
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-runtime-'));
  file = path.join(dir, RECORDS_FILE);
  ids = 0;
  clock = { wall: AT, mono: 5_000 };
  Object.assign(world, { status: { kind: 'ok' }, hasRuntime: true, hasFacet: true, demo: false, missing: false, history: true, otherFolders: false, missingRoots: new Set<string>() });
  storeFault = null;
  Object.assign(secretary, { titles: [], forgotten: [], disposed: 0 });
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

/** A root as the file stores it, with its trust answer. */
const root = (answer: 'trusted' | 'not-trusted' = 'trusted', rootPath = ROOT) => ({ path: rootPath, trust: { answer, answeredAt: '2020-01-23T00:00:00.000Z' } });
const project = (overrides: Record<string, unknown> = {}) => ({ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [root()], ...overrides });
const session = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: null, nameSource: null,
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null, ...overrides,
});
const started = (n: number, overrides: Record<string, unknown> = {}) => session(n, { reference: `thread-${n}`, folder: ROOT, lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'completed' }, name: 'Earlier', nameSource: 'first-message', ...overrides });
const place = (sessions: unknown[], projects: unknown[] = [project()]) => writeFileSync(file, JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects, sessions }));
const stored = (n: number) => (JSON.parse(readFileSync(file, 'utf8')) as { sessions: Record<string, unknown>[] }).sessions.find((entry) => entry['id'] === S(n));

function open(options: Partial<RecordsStoreOptions> = {}): void {
  runtimeReady = false;
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', now: () => AT, log, ...options });
  const store = createAppStateStore();
  fake = fakeFacet({ history: world.history });
  // A store on disk, in the same folder as the records: a second `open` is a restart.
  conversations?.close();
  conversations = createConversationStore({ dir, log, hook: (point) => { if (storeFault === point || storeFault === 'all') throw Object.assign(new Error('disk'), { code: 'EIO' }); } });
  timers = manualTimers();
  // On the test's own timers: a message's pushes and progress writes happen when the test says.
  chat = createChatService({ store: conversations, log, timers });
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => world.demo,
    snapshot: () => ({ status: world.status, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: world.history, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null } } }),
    hasRuntime: () => world.hasRuntime,
    project: (id) => records.getProject(id),
    isMissing: (rootPath) => world.missing || world.missingRoots.has(rootPath),
    // Asked while the service is made, before the runtime is: nothing is kept then.
    kept: (id) => (runtimeReady ? runtime.kept(id) : undefined),
    platform: 'win32',
  });
  service = createSessionService({
    records, store, now: () => AT, platform: 'win32', log, block: (record, hold) => gate.block(record, hold), onReferenceUnsaved: (id) => runtime.referenceUnsaved(id),
    onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome),
  });
  runtime = createSessionRuntime({
    modelUsed,
    catalog: () => sampleCatalog(['codex'], { providers: [sampleCatalogProvider({ id: 'codex', models: [sampleModel({ key: 'gpt-6-sol', resolvedId: 'gpt-6-sol', speedTiers: [{ id: 'priority', name: 'Ultra fast', description: null }] })] })] }),
    sessions: service, records, chat, gate, timers, log, now: () => clock.wall, monotonic: () => clock.mono, newId: () => `id-${++ids}`,
    facet: () => (world.hasFacet ? fake.facet : undefined),
    providerName: () => 'Codex',
    hasHistory: () => world.history,
    takesOtherFolders: () => world.otherFolders,
    configFolder: () => 'D:\\Accounts\\codex',
    store: conversations,
    removal: createRemoval({ store: conversations, log }),
    secretary: {
      title: (sessionId, record, prompt) => { secretary.titles.push({ sessionId, providerId: record.providerId, instanceId: record.instanceId, model: record.model, prompt }); },
      forget: (sessionId) => { secretary.forgotten.push(sessionId); },
      dispose: () => { secretary.disposed += 1; },
    },
  });
  runtimeReady = true;
}

const summary = (n: number) => service.snapshot().sessions.find((entry) => entry.record.id === S(n))?.summary;

describe('recent model tracking at prompt acceptance', () => {
  it('tracks only a successfully accepted selection, and no content or worker model', async () => {
    place([session(1)]);
    open();
    expect(modelUsed).not.toHaveBeenCalled();
    storeFault = 'accept';
    expect(await runtime.send(S(1), 'Private failed prompt')).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(modelUsed).not.toHaveBeenCalled();
    storeFault = null;
    const turnId = await accepted(1, 'Private accepted prompt');
    expect(modelUsed.mock.calls).toEqual([[{ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null }]]);
    fake.latest().emit({ type: 'worker-started', workerId: 'w1', model: 'gpt-6-astra' });
    expect(modelUsed).toHaveBeenCalledOnce();
    finish(turnId);
  });

  // Decision 0016: the record's speed tier starts the process, goes with every turn and is noted with the effort.
  it('hands the adapter the record’s speed tier at the start and with each turn, and notes it with the effort in force', async () => {
    place([session(1, { speed: 'priority' })]);
    open();
    const first = await accepted(1);
    expect(conversations.turn(S(1), first)?.speed).toEqual({ id: 'priority', name: 'Ultra fast' });
    expect(fake.latest().options).toMatchObject({ effort: 'high', speed: 'priority' });
    expect(fake.latest().sent.at(-1)).toMatchObject({ effort: 'high', speed: 'priority' });
    expect(modelUsed).toHaveBeenLastCalledWith({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: 'priority' });
    finish(first);
    await service.settled();
    // Changed between turns: the next turn asks for standard speed, on the same process.
    expect(await service.setSpeed(S(1), null)).toEqual({ status: 'saved' });
    const second = await accepted(1, 'And now standard');
    expect(conversations.turn(S(1), second)?.speed).toBeNull();
    expect(conversations.turn(S(1), first)?.speed).toEqual({ id: 'priority', name: 'Ultra fast' });
    expect(fake.made).toHaveLength(1);
    expect(fake.latest().sent.at(-1)).toMatchObject({ speed: null });
    expect(modelUsed).toHaveBeenLastCalledWith({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null });
  });

  it('dispatches an accepted prompt even when its recency callback fails', async () => {
    place([session(1)]);
    open();
    modelUsed.mockImplementationOnce(() => { throw new Error('private failure detail'); });
    await accepted(1);
    expect(fake.latest().sent).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('[sessions] recent model use could not be saved');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private failure detail');
  });
});
/** The chat as the page reads it, each item in the terms the tests speak: a notice's role is `notice`, and `itemId` is the provider's. */
const messages = (n: number) => {
  const read = runtime.read(S(n));
  return read.status === 'read' ? read.items.map((item) => ({ id: item.id, role: item.role ?? 'notice', phase: item.phase, text: itemText(item), notice: item.notice, detail: item.detail, itemId: item.providerItemId, origin: item.origin, turnId: item.turnId })) : [];
};
const texts = (n: number) => messages(n).map((message) => [message.role, message.text]);
const chatOf = (n: number) => { const read = runtime.read(S(n)); if (read.status !== 'read') throw new Error('not read'); return read; };
/** A turn accepted and named by the provider: its id, as the runtime made it. */
async function accepted(n: number, prompt = 'Fix the login bug'): Promise<string> {
  expect(await runtime.send(S(n), prompt)).toEqual({ status: 'accepted' });
  const turn = fake.latest().sent.at(-1);
  if (turn === undefined) throw new Error('nothing was sent');
  return turn.turnId;
}
/** The provider's own end of a turn. */
const finish = (turnId: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed') => fake.latest().emit({ type: 'turn-ended', turnId, outcome, reported: true });

describe('acceptance (V27; C86)', () => {
  it('promotes accepted work, while viewing, reading, refused sends and background completion preserve a manual placement', async () => {
    place([session(1), session(2), session(3)]);
    open();
    const order = () => records.getView().sessions.map((record) => record.id);
    await service.move(S(3), S(2), { list: 'active', starred: false });
    await service.select(S(3));
    await service.settled();
    expect(order()).toEqual([1, 3, 2].map(S));
    await service.move(S(3), null, { list: 'active', starred: false });
    runtime.read(S(3));
    world.missing = true;
    expect(await runtime.send(S(3), 'A refused prompt')).toMatchObject({ status: 'refused' });
    world.missing = false;
    await service.settled();
    expect(order()).toEqual([1, 2, 3].map(S));
    const turn = await accepted(3);
    await service.settled();
    expect(order()).toEqual([3, 1, 2].map(S));
    await service.move(S(3), null, { list: 'active', starred: false });
    finish(turn);
    await service.settled();
    expect(order()).toEqual([1, 2, 3].map(S));
    expect(records.getSession(S(3))?.lastTurn?.outcome).toBe('completed');
  });

  it('keeps an accepted prompt accepted when its ordering write fails, without logging content', async () => {
    place([session(1), session(2)]);
    open();
    vi.spyOn(records, 'promoteSession').mockRejectedValueOnce(new Error('private failure detail'));
    expect(await runtime.send(S(2), 'A private prompt')).toEqual({ status: 'accepted' });
    await service.settled();
    expect(records.getView().sessions.map((record) => record.id)).toEqual([1, 2].map(S));
    expect(fake.latest().sent).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('[sessions] session order could not be saved');
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/private|5e551000/);
  });

  it('makes the session running in one step, with its turn id and the user’s message, before anything is started', async () => {
    place([session(1)]);
    open();
    expect(await runtime.send(S(1), 'Fix the login bug\nIt fails on Tuesdays.')).toEqual({ status: 'accepted' });
    expect(summary(1)?.status).toBe('running');
    expect(typeof summary(1)?.turnStartedAt).toBe('number');
    expect(texts(1)).toEqual([['user', 'Fix the login bug\nIt fails on Tuesdays.']]);
    // The provider's session was asked for then, in the project's first root, with the record's preset.
    expect(fake.made).toHaveLength(1);
    expect(fake.latest().kind).toBe('start');
    expect(fake.latest().options).toEqual({ folder: ROOT, model: 'gpt-6-sol', effort: 'high', speed: null, otherFolders: [], mode: null, processKey: expect.any(String) as string });
    const [turn] = fake.latest().sent;
    expect(turn).toMatchObject({ prompt: 'Fix the login bug\nIt fails on Tuesdays.', effort: 'high' });
    expect(turn?.messageId).toBe(messages(1)[0]?.id);
    expect(turn?.turnId).not.toBe(turn?.messageId);
  });

  it('refuses a second Send, Complete and Remove through every starting step, and asks at quit', async () => {
    place([session(1)]);
    open();
    await accepted(1);
    // Nothing has come back from the provider yet: the session is running all the same.
    expect(await runtime.send(S(1), 'again')).toEqual({ status: 'refused', reason: 'running' });
    expect(await service.complete(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(await service.remove(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(service.runningCount()).toBe(1);
    expect(service.runningIn(PROJECT)).toBe(true);
    expect(service.runningOn({ providerId: 'codex', instanceId: 'default' })).toBe(true);
    expect(fake.latest().sent).toHaveLength(1);
    expect(texts(1)).toHaveLength(1);
  });

  it('shows a start that fails as a failed turn: ERROR on the capsule, its notice in the chat', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'notice', kind: 'start-failed', turnId, step: 'open' });
    fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'failed', failure: 'start-failed' });
    fake.latest().end();
    await service.settled();
    expect(summary(1)).toMatchObject({ status: 'not-started', attention: { kind: 'error' } });
    expect(messages(1).at(-1)).toMatchObject({ role: 'notice', notice: 'start-failed', text: 'Codex did not start the conversation. Nothing was sent after that; you can send again.' });
    expect(stored(1)?.['lastTurn']).toMatchObject({ outcome: 'failed' });
    expect(stored(1)?.['reference']).toBeNull();
    // The next prompt starts again: no reference was ever reported.
    await accepted(1, 'again');
    expect(fake.made.map((made) => made.kind)).toEqual(['start', 'start']);
  });

  it('refuses a prompt for a session it does not know, and drops an event that is not one', async () => {
    place([session(1)]);
    open();
    expect(await runtime.send(S(9), 'hello')).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(runtime.read(S(9))).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(runtime.stop(S(9))).toEqual({ status: 'refused', reason: 'unknown-session' });
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId: 'i1', phase: 'final', text: 'ok', frame: { raw: true } });
    fake.latest().emit({ type: 'something-else', turnId });
    expect(texts(1)).toHaveLength(1);
  });
});

describe('the prompt’s record (M18: V4, V8, V21; C9, C15, C19, C44)', () => {
  it('is committed before the dispatch, in the same step: nothing is awaited between them', async () => {
    place([session(1)]);
    open();
    const order: string[] = [];
    let heldAtDispatch: string[] = [];
    // A microtask queued as the record is committed would run before the dispatch if anything were awaited between the two.
    storeFault = null;
    const accepted = conversations.acceptPrompt.bind(conversations);
    conversations.acceptPrompt = (prompt) => { const made = accepted(prompt); order.push('committed'); queueMicrotask(() => { order.push('a later turn of the loop'); }); return made; };
    fake.onSend = () => { order.push('dispatched'); heldAtDispatch = conversations.newestPage(S(1)).items.map((item) => itemText(item)); };
    expect(await runtime.send(S(1), 'Fix the login bug')).toEqual({ status: 'accepted' });
    expect(order).toEqual(['committed', 'dispatched', 'a later turn of the loop']);
    // On disk when the provider is told: the prompt, under the id it is sent with.
    expect(heldAtDispatch).toEqual(['Fix the login bug']);
    expect(fake.latest().sent[0]?.messageId).toBe(conversations.newestPage(S(1)).items[0]?.id);
    expect(conversations.lastLocalTurn(S(1))).toMatchObject({ id: fake.latest().sent[0]?.turnId, providerTook: false });
  });

  it('refuses the Send when its record cannot be written: nothing is dispatched, the session does not run, and the next Send works', async () => {
    place([session(1)]);
    open();
    storeFault = 'accept';
    expect(await runtime.send(S(1), 'Fix the login bug')).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(fake.made).toEqual([]);
    expect(summary(1)?.status).toBe('not-started');
    expect(stored(1)?.['lastTurn']).toBeNull();
    expect(stored(1)?.['name']).toBeNull();
    storeFault = null;
    finish(await accepted(1));
    expect(texts(1)).toEqual([['user', 'Fix the login bug']]);
  });

  it('stores nothing of an event that carries what the events have no field for: an account, a command line, a frame', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    // Refused whole: the schema is strict, and an adapter that sent this would be at fault.
    fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId: 'i1', phase: 'final', text: 'An answer.', account: { email: 'someone@example.test' }, command: 'rm -rf C:\\Users\\someone', frame: { raw: true } });
    fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId: 'i2', phase: 'final', text: 'A clean answer.' });
    finish(turnId);
    expect(texts(1)).toEqual([['user', 'Fix the login bug'], ['assistant', 'A clean answer.']]);
    conversations.close();
    const held = readdirSync(dir).filter((name) => name.startsWith('conversations.sqlite')).map((name) => readFileSync(path.join(dir, name), 'latin1')).join('\n');
    expect(held).toContain('A clean answer.');
    for (const planted of ['someone@example.test', 'rm -rf', 'An answer.']) expect(held, planted).not.toContain(planted);
  });

  it('keeps a notice’s detail with the chat, and out of the log and the summary (C34)', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'notice', turnId, kind: 'turn-failed', detail: 'PRIVATE words of the CLI' });
    finish(turnId, 'failed');
    await service.settled();
    runtime.dispose();
    service.stop();
    open();
    // After a restart the notice is read back with its detail: it is conversation content.
    expect(messages(1).at(-1)).toMatchObject({ role: 'notice', notice: 'turn-failed', detail: 'PRIVATE words of the CLI' });
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls])).not.toContain('PRIVATE');
    expect(JSON.stringify(service.snapshot())).not.toContain('PRIVATE');
    expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE');
  });
});

describe('a turn’s events (V14; C45–C47, C56)', () => {
  it('shows commentary and answer as messages, the action on the capsule, and READY at the end', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    live.emit({ type: 'turn-started', turnId });
    live.emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    live.emit({ type: 'message', turnId, role: 'user', itemId: 'item-user', phase: null, text: 'Fix the login bug', clientId: messages(1)[0]?.id });
    live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-1', phase: 'commentary', text: 'I will read login.ts.' });
    live.emit({ type: 'action-changed', turnId, kind: 'reading', line: 'I will read login.ts.', file: 'login.ts' });
    expect(summary(1)?.action).toEqual({ kind: 'reading', label: 'I will read login.ts.', detail: 'I will read login.ts.' });
    live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-2', phase: 'final', text: 'Fixed.' });
    finish(turnId);
    await service.settled();

    expect(messages(1).map((message) => [message.role, message.phase, message.text, message.itemId])).toEqual([
      ['user', null, 'Fix the login bug', 'item-user'], ['assistant', 'commentary', 'I will read login.ts.', 'item-1'], ['assistant', 'final', 'Fixed.', 'item-2'],
    ]);
    expect(summary(1)).toMatchObject({ status: 'idle', attention: { kind: 'ready', count: 1 }, action: null });
    expect(stored(1)).toMatchObject({ reference: 'thread-1', folder: ROOT, name: 'Fix the login bug', nameSource: 'first-message' });
    expect(stored(1)?.['lastTurn']).toMatchObject({ outcome: 'completed' });
  });

  it('gives the echo’s id to the user’s message by the turn when the echo carries no id of its own', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'message', turnId, role: 'user', itemId: 'item-user', phase: null, text: 'x' });
    fake.latest().emit({ type: 'message', turnId, role: 'user', itemId: 'item-user-2', phase: null, text: 'x' });
    expect(messages(1)).toHaveLength(1);
    expect(messages(1)[0]?.itemId).toBe('item-user');
  });

  it('raises ERROR on a failed turn with its notice and the CLI’s own words, and no question or approval ever', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'notice', turnId, kind: 'turn-failed', detail: 'The model is not supported.' });
    finish(turnId, 'failed');
    expect(summary(1)?.attention).toMatchObject({ kind: 'error' });
    expect(messages(1).at(-1)).toMatchObject({ role: 'notice', notice: 'turn-failed', detail: 'The model is not supported.', text: 'Codex reported an error, and the reply ended.' });
    const second = await accepted(1, 'again');
    finish(second, 'interrupted');
    // An interrupted turn was the user's doing: READY.
    expect(summary(1)?.attention).toMatchObject({ kind: 'ready' });
  });

  it('names the session from its first prompt once, and never again', async () => {
    place([session(1)]);
    open();
    finish(await accepted(1, '  \nFirst prompt here\nmore'));
    await service.settled();
    expect(stored(1)?.['name']).toBe('First prompt here');
    finish(await accepted(1, 'A second prompt'));
    await service.settled();
    expect(stored(1)?.['name']).toBe('First prompt here');
  });

  it('asks the secretary for a title at the first accepted prompt alone, and lets go of it at a rename, a removal and the quit (M26)', async () => {
    place([session(1), session(2, { name: 'Typed before', nameSource: 'user' })]);
    open();
    finish(await accepted(1, 'First prompt here'));
    await service.settled();
    finish(await accepted(1, 'A second prompt'));
    await service.settled();
    // A session the user named before its first prompt is asked nothing.
    finish(await accepted(2, 'Its first prompt'));
    await service.settled();
    expect(secretary.titles).toEqual([{ sessionId: S(1), providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', prompt: 'First prompt here' }]);
    expect(await service.setName(S(1), '  My   own name ')).toEqual({ status: 'saved' });
    await service.settled();
    expect(stored(1)).toMatchObject({ name: 'My own name', nameSource: 'user' });
    expect(secretary.forgotten).toContain(S(1));
    // A generated name that comes late is kept off by the ladder.
    service.apply({ type: 'name-reported', sessionId: S(1), name: 'Generated', source: 'generated' });
    await service.settled();
    expect(stored(1)?.['name']).toBe('My own name');
    // A user's name is told again at each change of the records, which lets go of nothing more.
    secretary.forgotten = [];
    expect(await service.remove(S(2))).toEqual({ status: 'saved' });
    await service.settled();
    expect(secretary.forgotten).toContain(S(2));
    await runtime.stopAll(0);
    expect(secretary.disposed).toBe(1);
  });

  // M26 (round 2): a session named from its unsent draft is still owed a title by its first turn,
  // and the first-prompt name is not written over the name it already has.
  it('asks for a title over a name written from a draft, and keeps that name until it lands', async () => {
    place([session(1, { name: 'setting things up', nameSource: 'generated' })]);
    open();
    finish(await accepted(1, 'First prompt here'));
    await service.settled();
    expect(stored(1)).toMatchObject({ name: 'setting things up', nameSource: 'generated' });
    expect(secretary.titles).toEqual([{ sessionId: S(1), providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', prompt: 'First prompt here' }]);
    service.apply({ type: 'name-reported', sessionId: S(1), name: 'Wait for both fields', source: 'generated' });
    await service.settled();
    expect(stored(1)).toMatchObject({ name: 'Wait for both fields', nameSource: 'generated' });
  });

  it('refuses a rename to nothing, and names the session with what is left once normalized (M26)', async () => {
    place([session(1)]);
    open();
    expect(await service.setName(S(1), ' \t\n ')).toEqual({ status: 'refused', reason: 'name-empty' });
    expect(await service.setName(S(1), 'x'.repeat(80))).toEqual({ status: 'saved' });
    await service.settled();
    expect(stored(1)).toMatchObject({ name: 'x'.repeat(80), nameSource: 'user' });
    expect(await service.setName(S(1), 'x'.repeat(180))).toEqual({ status: 'saved' });
    await service.settled();
    expect(stored(1)).toMatchObject({ name: `${'x'.repeat(159)}…`, nameSource: 'user' });
  });

  it('logs a start, a failure, a dropped event and a refused request as counts and kinds: no text, no id and no path (M16, V18; C55)', async () => {
    place([session(1)]);
    open();
    const secret = 'C:\\Users\\someone\\secret.txt';
    const turnId = await accepted(1, `Read ${secret}`);
    const live = fake.latest();
    live.emit({ type: 'turn-started', turnId });
    live.emit({ type: 'session-started', reference: 'reference-PRIVATE-1', folder: ROOT });
    // A request of the CLI's that the adapter refused: a notice in the chat, and no line of the runtime's.
    live.emit({ type: 'notice', turnId, kind: 'request-refused' });
    // Something that is no agent event: dropped, and counted by its kind alone.
    live.emit({ type: 'frame-of-the-cli', text: `PRIVATE ${secret}` });
    live.emit({ type: 'notice', turnId, kind: 'start-overruled' });
    live.emit({ type: 'turn-ended', turnId, outcome: 'failed', reported: false, failure: 'start-overruled' });
    await service.settled();
    expect(log.info.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[sessions]'))).toEqual([
      '[sessions] session started, 1 so far',
      '[sessions] event refused (not an agent event), 1 so far',
      '[sessions] turn ended (failed, start-overruled), 1 so far',
    ]);
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls])).not.toMatch(/someone|secret|PRIVATE|reference-|Read |D:\\\\Code/);
    // Both notices are in the chat, in fat-g's words, where they belong.
    expect(messages(1).map((message) => message.notice).filter((notice) => notice !== null)).toEqual(['request-refused', 'start-overruled']);
  });

  it('keeps conversation text out of the summary, the snapshot and the log, the action’s label apart (V2, V22)', async () => {
    place([session(1)]);
    open();
    const secret = 'C:\\Users\\someone\\secret.txt';
    const turnId = await accepted(1, `Read ${secret}`);
    fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId: 'i', phase: 'final', text: `It says ${secret}` });
    fake.latest().emit({ type: 'notice', turnId, kind: 'turn-failed', detail: `No access to ${secret}` });
    finish(turnId, 'failed');
    await service.settled();
    expect(JSON.stringify(service.snapshot().sessions.map((entry) => entry.summary))).not.toContain('someone');
    expect(JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls])).not.toMatch(/someone|secret|thread-|Read /);
    // The runtime's own lines are counts and kinds: here, the one turn's end.
    expect(log.info.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[sessions]'))).toEqual(['[sessions] turn ended (failed), 1 so far']);
    // The name is the one thing of a conversation fat-g's files hold, and it is cut as a label is (C77).
    expect(readFileSync(file, 'utf8')).not.toContain('It says');
    expect(readFileSync(file, 'utf8')).not.toContain('No access');
  });
});

describe('the values in force (V32, V36; C45, C103)', () => {
  it('shows the effort a turn was sent with through a change of the record, and the record’s again once it has ended', async () => {
    place([session(1, { effort: 'low' })]);
    open();
    const turnId = await accepted(1);
    expect(fake.latest().sent[0]?.effort).toBe('low');
    expect(summary(1)).toMatchObject({ model: 'gpt-6-sol', effort: 'low' });
    await service.setEffort(S(1), 'high');
    // The change is the record's alone while the turn runs.
    expect(stored(1)?.['effort']).toBe('high');
    expect(summary(1)?.effort).toBe('low');
    finish(turnId);
    expect(summary(1)?.effort).toBe('high');
    // Between turns the record's effort shows at once.
    await service.setEffort(S(1), 'medium');
    expect(summary(1)?.effort).toBe('medium');
    const next = await accepted(1, 'again');
    expect(fake.latest().sent.at(-1)?.effort).toBe('medium');
    expect(fake.latest().options.model).toBe('gpt-6-sol');
    finish(next);
  });
});

describe('resume (V7, V37; C24, C104)', () => {
  it('resumes a session from an earlier run by its reference, in its stored folder', async () => {
    place([started(1)]);
    open();
    runtime.read(S(1));
    runtime.loadHistory(S(1));
    await vi.waitFor(() => expect(chat.history(S(1))).toBe('checked'));
    await accepted(1);
    expect(fake.latest().kind).toBe('resume');
    expect(fake.latest().options).toEqual({ reference: 'thread-1', folder: ROOT, model: 'gpt-6-sol', effort: 'high', speed: null, otherFolders: [], mode: null, processKey: expect.any(String) as string });
  });

  it('forgets an idle session’s process that ends by itself without a word, and resumes at the next prompt', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    finish(turnId);
    await service.settled();
    const before = messages(1).length;
    const attention = summary(1)?.attention;
    fake.latest().end();
    await Promise.resolve();
    expect(messages(1)).toHaveLength(before);
    expect(summary(1)?.attention).toEqual(attention);
    await accepted(1, 'again');
    expect(fake.made.map((made) => [made.kind, made.options.reference])).toEqual([['start', undefined], ['resume', 'thread-1']]);
  });

  it('closes an idle session’s process and drops what the run held of it when its record is removed, by itself or with its project', async () => {
    place([session(1), session(2)]);
    open();
    finish(await accepted(1));
    const first = fake.latest();
    finish(await accepted(2));
    const second = fake.latest();
    expect(await service.remove(S(1))).toEqual({ status: 'saved' });
    expect(first.closes).toBe(1);
    expect(runtime.read(S(1))).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(chat.has(S(1))).toBe(false);
    // Its saved chat is not the listener's to delete: only an explicit removal does that (M18, C30).
    expect(conversations.conversation(S(1))).not.toBeNull();
    expect(second.closes).toBe(0);
    await records.remove(PROJECT);
    expect(second.closes).toBe(1);
    expect(chat.has(S(2))).toBe(false);
  });
});

describe('the idle close (V9; C85)', () => {
  it('closes a session’s process five minutes after it stopped running, never during a turn, and at once on completion', async () => {
    place([session(1), session(2)]);
    open();
    const turnId = await accepted(1);
    timers.advance(IDLE_CLOSE_MS * 3);
    expect(fake.latest().closes).toBe(0);
    finish(turnId);
    timers.advance(IDLE_CLOSE_MS - 1);
    expect(fake.latest().closes).toBe(0);
    timers.advance(1);
    expect(fake.latest().closes).toBe(1);

    // A new prompt stops the clock; completing closes at once.
    const first = await accepted(2);
    const live = fake.latest();
    finish(first);
    const second = await accepted(2, 'again');
    timers.advance(IDLE_CLOSE_MS);
    expect(live.closes).toBe(0);
    finish(second);
    expect(await service.complete(S(2))).toEqual({ status: 'saved' });
    expect(live.closes).toBe(1);
  });

  it('closes a session’s process at once when it is shelved, and a prompt in its chat resumes it and takes it off the shelf', async () => {
    place([session(1)]);
    open();
    finish(await accepted(1));
    await service.settled();
    const live = fake.latest();
    expect(await service.shelve(S(1))).toEqual({ status: 'saved' });
    await service.settled();
    expect(live.closes).toBe(1);
    finish(await accepted(1, 'again'));
    await service.settled();
    expect(service.record(S(1))?.shelvedAt).toBeNull();
  });

  it('makes a Send that comes while the idle process is closing wait for that close: the prompt goes to a resumed session, never to the one that is ending', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const first = fake.latest();
    first.emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    finish(turnId);
    // Its tree takes a moment to end.
    first.slowClose = true;
    timers.advance(IDLE_CLOSE_MS);
    expect(first.closes).toBe(1);

    const sending = runtime.send(S(1), 'again');
    await new Promise((resolve) => setImmediate(resolve));
    // Nothing is accepted, and nothing is written to the session that is ending.
    expect(summary(1)?.status).toBe('idle');
    expect(first.sent).toHaveLength(1);
    expect(fake.made).toHaveLength(1);

    first.end();
    expect(await sending).toEqual({ status: 'accepted' });
    expect(fake.made.map((made) => [made.kind, made.options.reference])).toEqual([['start', undefined], ['resume', 'thread-1']]);
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['again']);
    expect(first.sent).toHaveLength(1);
    expect(first.closes).toBe(1);
    // The turn runs, and ends as the provider ends it: nothing of the close reached it.
    finish(fake.latest().sent[0]?.turnId as string);
    await service.settled();
    expect(stored(1)?.['lastTurn']).toMatchObject({ outcome: 'completed' });
  });

  it('refuses that Send as unconfirmed when the close is not confirmed, and the same for a completed session’s close', async () => {
    place([session(1), session(2)]);
    open();
    const turnId = await accepted(1);
    const first = fake.latest();
    first.emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    finish(turnId);
    first.slowClose = true;
    first.recheck = { ok: false };
    timers.advance(IDLE_CLOSE_MS);
    const sending = runtime.send(S(1), 'again');
    await new Promise((resolve) => setImmediate(resolve));
    first.end({ ok: false });
    expect(await sending).toEqual({ status: 'refused', reason: 'unconfirmed' });
    expect(fake.made).toHaveLength(1);
    expect(first.sent).toHaveLength(1);

    // Completed: its process closes at once, and a prompt sent while it closes waits as well.
    const other = await accepted(2);
    const second = fake.latest();
    second.emit({ type: 'session-started', reference: 'thread-2', folder: ROOT });
    finish(other);
    second.slowClose = true;
    expect(await service.complete(S(2))).toEqual({ status: 'saved' });
    expect(second.closes).toBe(1);
    const reopening = runtime.send(S(2), 'once more');
    await new Promise((resolve) => setImmediate(resolve));
    expect(second.sent).toHaveLength(1);
    second.end();
    expect(await reopening).toEqual({ status: 'accepted' });
    expect(fake.latest()).not.toBe(second);
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['once more']);
  });
});

describe('workers left after their turn (V34; C99, C100)', () => {
  it('keeps the session running: Send, Complete and Remove are refused, the idle close waits, and Stop reaches the session', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    live.emit({ type: 'worker-started', workerId: 'w1' });
    finish(turnId);
    expect(summary(1)).toMatchObject({ status: 'running', activeWorkers: 1 });
    expect(await runtime.send(S(1), 'again')).toEqual({ status: 'refused', reason: 'running' });
    expect(await service.complete(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(await service.remove(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(service.runningCount()).toBe(1);
    timers.advance(IDLE_CLOSE_MS * 2);
    expect(live.closes).toBe(0);

    expect(runtime.stop(S(1))).toEqual({ status: 'stopping' });
    expect(live.stops).toBe(1);
    // The adapter ends the worker as failed, says so, and ends its process.
    live.emit({ type: 'worker-ended', workerId: 'w1', outcome: 'failed' });
    live.emit({ type: 'notice', kind: 'workers-stopped' });
    live.end();
    await service.settled();
    expect(summary(1)).toMatchObject({ status: 'not-started', attention: { kind: 'ready' } });
    expect(stored(1)?.['lastTurn']).toMatchObject({ outcome: 'completed' });
    expect(messages(1).at(-1)).toMatchObject({ notice: 'workers-stopped' });
    expect(runtime.stop(S(1))).toEqual({ status: 'refused', reason: 'not-running' });
  });

  it('makes sure no worker holds a session running once its provider’s session has ended', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'worker-started', workerId: 'w1' });
    finish(turnId);
    fake.latest().end();
    await vi.waitFor(() => expect(summary(1)?.status).not.toBe('running'));
    expect(service.runningCount()).toBe(0);
  });
});

describe('a reference the record could not store (V41; C108)', () => {
  it('keeps it for the run, resumes by it, says so once, and stores it at a later acceptance', async () => {
    place([session(1)]);
    let failing = true;
    open({ write: (target, text) => (failing && text.includes('thread-1') ? Promise.reject(Object.assign(new Error('disk'), { code: 'EIO' })) : writeFileAtomic(target, text)) });
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    finish(turnId);
    await service.settled();
    expect(stored(1)?.['reference']).toBeNull();
    expect(runtime.kept(S(1))).toEqual({ reference: 'thread-1', folder: ROOT });
    expect(messages(1).filter((message) => message.notice === 'session-unsaved')).toHaveLength(1);
    // The log holds the failure's kind alone.
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('thread-1');

    // After an idle close the next prompt resumes by the kept reference: no second start.
    fake.latest().end();
    await Promise.resolve();
    const second = await accepted(1, 'again');
    expect(fake.made.map((made) => [made.kind, made.options.reference])).toEqual([['start', undefined], ['resume', 'thread-1']]);
    finish(second);
    await service.settled();
    expect(messages(1).filter((message) => message.notice === 'session-unsaved')).toHaveLength(1);
    expect(stored(1)?.['reference']).toBeNull();

    // A later acceptance asks for the write again, and this time it lands, with its folders.
    failing = false;
    finish(await accepted(1, 'once more'));
    await service.settled();
    expect(stored(1)).toMatchObject({ reference: 'thread-1', folder: ROOT });
    await vi.waitFor(() => expect(runtime.kept(S(1))).toBeUndefined());
  });
});

describe('a Send and a removal or a completion exclude each other (V42; C109)', () => {
  it('refuses a Send that arrives while a Remove or a Complete is being written, and the write lands', async () => {
    place([session(1), session(2)]);
    open();
    const removing = service.remove(S(1));
    expect(service.isLeaving(S(1))).toBe(true);
    expect(await runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason: 'busy' });
    expect(await removing).toEqual({ status: 'saved' });
    expect(stored(1)).toBeUndefined();
    expect(fake.made).toHaveLength(0);

    const completing = service.complete(S(2));
    expect(await runtime.send(S(2), 'hello')).toEqual({ status: 'refused', reason: 'busy' });
    expect(await completing).toEqual({ status: 'saved' });
    expect(service.isLeaving(S(2))).toBe(false);
    expect(fake.made).toHaveLength(0);
  });

  it('refuses a Send to a session whose project is being removed, and refuses each of them once a Send was accepted', async () => {
    place([session(1), session(2)]);
    open();
    const removing = service.removingProject(PROJECT, () => records.remove(PROJECT));
    expect(removing).not.toBeNull();
    expect(await runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason: 'busy' });
    await removing;
    expect(fake.made).toHaveLength(0);
  });

  it('refuses a removal and a completion once a Send was accepted first', async () => {
    place([session(1)]);
    open();
    await accepted(1);
    expect(await service.remove(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(await service.complete(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(service.removingProject(PROJECT, () => records.remove(PROJECT))).toBeNull();
    expect(service.isLeaving(S(1))).toBe(false);
  });

  it('refuses a Send still waiting on its folder comparison when a removal begins', async () => {
    place([session(1)]);
    open();
    // The Send waits on its reason; the removal begins before that has answered.
    const sending = runtime.send(S(1), 'hello');
    const removing = service.remove(S(1));
    expect(await sending).toMatchObject({ status: 'refused' });
    expect(await removing).toEqual({ status: 'saved' });
    expect(fake.made).toHaveLength(0);
  });
});

describe('the reason, asked again when a prompt is sent (V38; C105)', () => {
  it.each([
    ['demo', () => { world.demo = true; }],
    ['signed-out', () => { world.status = { kind: 'not-logged-in' }; }],
    ['not-connected', () => { world.hasRuntime = false; }],
    ['folder-missing', () => { world.missing = true; }],
  ] as const)('refuses with %s, and nothing is started', async (reason, arrange) => {
    place([session(1)]);
    open();
    arrange();
    service.availabilityChanged();
    expect(service.snapshot().sessions[0]?.block).toBe(reason);
    expect(await runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason });
    expect(fake.made).toHaveLength(0);
    expect(texts(1)).toEqual([]);
    expect(summary(1)?.status).toBe('not-started');
  });

  it('refuses for the project’s folder and its providers, each with its own reason and no path in the entry', async () => {
    place([session(1), started(2, { folder: 'D:\\Elsewhere' })], [project({ roots: [root('not-trusted')] })]);
    open();
    expect(service.snapshot().sessions.map((entry) => entry.block)).toEqual(['folder-not-trusted', 'folder-not-root']);
    expect(JSON.stringify(service.snapshot())).not.toMatch(/Elsewhere|D:\\\\/);
    expect(await runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason: 'folder-not-trusted' });
  });

  it('takes a prompt whatever became of the usage reads (V45; C112)', async () => {
    place([session(1)]);
    open();
    for (const status of [{ kind: 'stale' }, { kind: 'error', message: 'The usage read failed.' }, { kind: 'not-applicable', reason: 'usage-unavailable' }] as ProviderStatus[]) {
      world.status = status;
      service.availabilityChanged();
      expect(service.snapshot().sessions[0]?.block).toBeNull();
    }
    finish(await accepted(1));
  });

  it('refuses as not connected when the instance lost its runtime between the reason and the start', async () => {
    place([session(1)]);
    open();
    world.hasFacet = false;
    expect(await runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason: 'not-connected' });
    expect(summary(1)?.status).toBe('not-started');
  });
});

describe('an end that could not be confirmed (V51; C116)', () => {
  it('holds that session alone: its Send is refused until a look finds its earlier process gone', async () => {
    place([session(1), session(2)]);
    open();
    const turnId = await accepted(1);
    const first = fake.latest();
    first.emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    finish(turnId);
    first.recheck = { ok: false };
    first.end({ ok: false });
    await service.settled();

    expect(await runtime.send(S(1), 'again')).toEqual({ status: 'refused', reason: 'unconfirmed' });
    expect(first.rechecks).toBe(1);
    expect(fake.made).toHaveLength(1);
    // Not a reason in its entry: the input stays, since the Send is what looks again.
    expect(service.snapshot().sessions[0]?.block).toBeNull();
    // Another session of the same instance starts all the same.
    finish(await accepted(2));
    expect(fake.made).toHaveLength(2);
    // It is not running, so Complete and Remove go through.
    expect(service.isRunning(S(1))).toBe(false);

    first.recheck = { ok: true };
    await accepted(1, 'again');
    expect(first.rechecks).toBe(2);
    expect(fake.latest().kind).toBe('resume');
    expect(fake.latest().options.reference).toBe('thread-1');
  });
});

describe('history (M15: V30, V53; M18: V17, V28; C51, C52, C57, C61, C93, C121, C122)', () => {
  /** A turn made in the provider's own app: the store has never seen it. */
  const elsewhere = historyTurn('p-1', [
    { role: 'user', itemId: 'h1', phase: null, text: 'An earlier question' },
    { role: 'assistant', itemId: 'h2', phase: 'final', text: 'An earlier answer' },
  ]);
  const selected = async (n: number) => { await service.select(S(n)); runtime.selectionChanged(); };
  const state = (n: number) => chat.history(S(n));

  it('checks a selected session’s earlier conversation, imports what the store lacks, and changes neither its summary nor what runs', async () => {
    place([started(1)]);
    open();
    fake.history = pagedHistory([elsewhere]);
    const before = summary(1);
    // The record says the session had started, and the store holds nothing of it yet (C18).
    expect(chatOf(1)).toMatchObject({ history: { state: 'not-checked', earlierMissing: true }, items: [] });
    await selected(1);
    expect(state(1)).toBe('checking');
    await vi.waitFor(() => expect(state(1)).toBe('checked'));
    expect(texts(1)).toEqual([['user', 'An earlier question'], ['assistant', 'An earlier answer']]);
    expect(messages(1).map((message) => [message.origin, message.itemId])).toEqual([['provider', 'h1'], ['provider', 'h2']]);
    // The turns were listed without their items first, and only then read (C51).
    expect(fake.reads).toEqual([
      { reference: 'thread-1', page: { cursor: null, size: 8, detail: 'none' } },
      { reference: 'thread-1', page: { cursor: null, size: 8, detail: 'full' } },
    ]);
    expect(summary(1)).toBe(before);
    expect(fake.made).toHaveLength(0);
    // The walk reached the start: nothing earlier is missing any more.
    expect(chatOf(1).history).toEqual({ state: 'checked', olderUnread: false, earlierMissing: false });
    // Checked: selecting it again asks nothing.
    await selected(1);
    expect(fake.reads).toHaveLength(2);
  });

  it('reads no item again at the next start, when nothing is missing', async () => {
    place([started(1)]);
    open();
    fake.history = pagedHistory([elsewhere]);
    await selected(1);
    await vi.waitFor(() => expect(state(1)).toBe('checked'));
    // A restart: once per session after each start of fat-g.
    runtime.dispose();
    service.stop();
    open();
    fake.history = pagedHistory([elsewhere]);
    expect(texts(1)).toEqual([['user', 'An earlier question'], ['assistant', 'An earlier answer']]);
    await selected(1);
    await vi.waitFor(() => expect(state(1)).toBe('checked'));
    expect(fake.reads.map((read) => read.page.detail)).toEqual(['none']);
    expect(texts(1)).toHaveLength(2);
  });

  it('counts a session not yet started as checked, and asks nothing for it', async () => {
    place([session(1)]);
    open();
    await selected(1);
    expect(state(1)).toBe('checked');
    expect(chatOf(1).history.earlierMissing).toBe(false);
    finish(await accepted(1));
    expect(fake.reads).toEqual([]);
  });

  it('asks a provider with no history nothing: its chat reads unsupported, and takes a prompt (C25)', async () => {
    place([started(1)]);
    world.history = false;
    open();
    await selected(1);
    expect(state(1)).toBe('unsupported');
    expect(runtime.loadHistory(S(1))).toEqual({ status: 'refused', reason: 'unsupported' });
    expect(fake.reads).toEqual([]);
    // What fat-g did not record is missing, and is said to be: as plain fact, with nothing to try again.
    expect(chatOf(1).history).toEqual({ state: 'unsupported', olderUnread: false, earlierMissing: true });
    finish(await accepted(1));
    expect(fake.latest().kind).toBe('resume');
  });

  it('shows a failed check with nothing added, leaves Send usable, and recovers on reselection, on the facet’s word and on Try again', async () => {
    place([started(1), session(2)]);
    open();
    fake.history = { kind: 'failed' };
    await selected(1);
    await vi.waitFor(() => expect(state(1)).toBe('failed'));
    expect(messages(1)).toEqual([]);

    await selected(2);
    await selected(1);
    await vi.waitFor(() => expect(fake.reads).toHaveLength(2));
    await vi.waitFor(() => expect(state(1)).toBe('failed'));
    fake.available();
    await vi.waitFor(() => expect(fake.reads).toHaveLength(3));
    await vi.waitFor(() => expect(state(1)).toBe('failed'));

    // A failed check refuses no Send.
    finish(await accepted(1));

    fake.history = pagedHistory([elsewhere]);
    expect(runtime.loadHistory(S(1))).toEqual({ status: 'loading' });
    await vi.waitFor(() => expect(state(1)).toBe('checked'));
    // The provider's history does not hold this run's turn, which the store alone has: what it
    // holds that the store lacks is newer than nothing both hold, and goes last (C49).
    expect(texts(1)).toEqual([['user', 'Fix the login bug'], ['user', 'An earlier question'], ['assistant', 'An earlier answer']]);
  });

  it('refuses a Send while the check runs, starting it if none is under way', async () => {
    place([started(1)]);
    open();
    let release: (answer: HistoryAnswer) => void = () => undefined;
    fake.history = () => new Promise((resolve) => { release = resolve; });
    expect(await runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason: 'history-loading' });
    expect(state(1)).toBe('checking');
    expect(await runtime.send(S(1), 'hello')).toEqual({ status: 'refused', reason: 'history-loading' });
    expect(fake.reads).toHaveLength(1);
    expect(fake.made).toHaveLength(0);
    release({ kind: 'page', turns: [], messages: [], next: null });
    await vi.waitFor(() => expect(state(1)).toBe('checked'));
    await accepted(1);
  });

  it('starts a check asked for during a turn once the session is idle, and shows no message twice', async () => {
    place([started(1)]);
    open();
    fake.history = { kind: 'failed' };
    await selected(1);
    await vi.waitFor(() => expect(state(1)).toBe('failed'));
    const turnId = await accepted(1, 'A live question');
    const clientId = messages(1)[0]?.id ?? '';
    fake.latest().emit({ type: 'turn-started', turnId, providerTurnId: 'p-live' });
    fake.latest().emit({ type: 'message', turnId, role: 'user', itemId: 'live-q', phase: null, text: 'A live question', clientId });
    fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId: 'live-a', phase: 'final', text: 'A live answer' });

    // The provider's history now holds this run's turn too, after the one made elsewhere.
    fake.history = pagedHistory([elsewhere, historyTurn('p-live', [
      { role: 'user', itemId: 'live-q', phase: null, text: 'A live question', clientId },
      { role: 'assistant', itemId: 'live-a', phase: 'final', text: 'A live answer' },
    ])]);
    const reads = fake.reads.length;
    expect(runtime.loadHistory(S(1))).toEqual({ status: 'waiting' });
    fake.available();
    expect(fake.reads).toHaveLength(reads);
    finish(turnId);
    await vi.waitFor(() => expect(state(1)).toBe('checked'));
    expect(texts(1)).toEqual([['user', 'An earlier question'], ['assistant', 'An earlier answer'], ['user', 'A live question'], ['assistant', 'A live answer']]);
    // The turn fat-g ran was held whole: none of its items was asked for.
    expect(fake.reads.slice(reads).filter((read) => read.page.detail !== 'none').map((read) => read.page)).toEqual([{ cursor: '1', size: 1, detail: 'full' }]);
  });

  it('does not check a session held for its provider, its instance or its folder: it stays as it is', async () => {
    place([started(1)]);
    open();
    world.demo = true;
    await selected(1);
    expect(state(1)).toBe('not-checked');
    expect(runtime.loadHistory(S(1))).toEqual({ status: 'refused', reason: 'demo' });
    expect(fake.reads).toEqual([]);
  });

  it('is failed while its instance has no runtime, and checks once it is told that something changed', async () => {
    place([started(1)]);
    open();
    world.hasFacet = false;
    await selected(1);
    expect(state(1)).toBe('failed');
    world.hasFacet = true;
    fake.history = pagedHistory([elsewhere]);
    runtime.selectionChanged();
    await vi.waitFor(() => expect(state(1)).toBe('checked'));
  });

  it('marks no turn when the quit aborts a check, so the next one lists the same turns and reads none it now holds (C61)', async () => {
    place([started(1)]);
    open();
    const older = historyTurn('p-0', [{ role: 'user', itemId: 'g1', phase: null, text: 'The oldest question' }]);
    const turns = [older, ...Array.from({ length: 8 }, (_, n) => historyTurn(`p-${n + 1}`, [{ role: 'user', itemId: `h${n + 1}`, phase: null, text: `Question ${n + 1}` }]))];
    const page = pagedHistory(turns);
    // The second page never answers: the first is merged, and the walk is still under way at the quit.
    fake.history = (reference, request) => (request.cursor === null ? page(reference, request) : new Promise<HistoryAnswer>(() => undefined));
    await selected(1);
    await vi.waitFor(() => expect(texts(1)).toHaveLength(8));
    void runtime.stopAll();
    await vi.waitFor(() => expect(state(1)).toBe('failed'));
    expect(conversations.newestPage(S(1)).turns.every((turn) => !turn.reached)).toBe(true);
    expect(conversations.conversation(S(1))?.reachedStart).toBe(false);

    // The next run: the same turns are listed, none of the eight is read again, and the rest is imported.
    runtime.dispose();
    service.stop();
    open();
    fake.history = pagedHistory(turns);
    await selected(1);
    await vi.waitFor(() => expect(state(1)).toBe('checked'));
    expect(fake.reads.map((read) => [read.page.cursor, read.page.size, read.page.detail])).toEqual([[null, 8, 'none'], ['8', 8, 'none'], ['8', 8, 'full']]);
    expect(texts(1)).toHaveLength(9);
    expect(texts(1)[0]).toEqual(['user', 'The oldest question']);
    expect(conversations.newestPage(S(1)).turns.every((turn) => turn.reached)).toBe(true);
    expect(conversations.conversation(S(1))?.reachedStart).toBe(true);
  });
});

describe('whether a session runs on a process of its own (Design 10; C18, C99)', () => {
  const FIRST = { providerId: 'codex', instanceId: 'default' };
  it('answers for a session in a turn on its instance alone, and not for one that runs with no process', async () => {
    place([session(1), session(2)]);
    open();
    expect(runtime.runningOn(FIRST)).toBe(false);
    const turnId = await accepted(1);
    expect(runtime.runningOn(FIRST)).toBe(true);
    expect(runtime.runningOn({ providerId: 'codex', instanceId: '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19' })).toBe(false);
    expect(runtime.runningOn({ providerId: 'claude', instanceId: 'default' })).toBe(false);
    finish(turnId);
    expect(runtime.runningOn(FIRST)).toBe(false);
    // Running all the same, with no process: what the demo source's sessions do.
    service.apply({ sessionId: S(2), type: 'turn-started', turnId: 'demo' });
    expect(service.isRunning(S(2))).toBe(true);
    expect(runtime.runningOn(FIRST)).toBe(false);
  });
});

describe('the quit (V48, V52; C117, C118)', () => {
  it('sends Stop to every running session, waits for them to end, and takes no Send from then on', async () => {
    place([session(1), session(2), session(3)]);
    open();
    const first = await accepted(1);
    const one = fake.latest();
    const second = await accepted(2);
    const two = fake.latest();
    let done = false;
    const stopping = runtime.stopAll().then(() => { done = true; });
    expect([one.stops, two.stops]).toEqual([1, 1]);
    expect(await runtime.send(S(3), 'hello')).toEqual({ status: 'refused', reason: 'busy' });
    one.emit({ type: 'turn-ended', turnId: first, outcome: 'interrupted', reported: true });
    await Promise.resolve();
    expect(done).toBe(false);
    two.emit({ type: 'turn-ended', turnId: second, outcome: 'interrupted', reported: true });
    await stopping;
    // A turn that ended in time keeps its own outcome.
    await service.settled();
    expect(stored(1)?.['lastTurn']).toMatchObject({ outcome: 'interrupted' });
    expect(timers.count()).toBe(2);
  });

  it('stops waiting after five seconds, and resolves at once when nothing runs', async () => {
    place([session(1)]);
    open();
    await runtime.stopAll();
    runtime.dispose();
    service.stop();

    open();
    await accepted(1);
    let done = false;
    const stopping = runtime.stopAll().then(() => { done = true; });
    timers.advance(QUIT_STOP_MS - 1);
    await Promise.resolve();
    expect(done).toBe(false);
    timers.advance(1);
    await stopping;
    expect(service.isRunning(S(1))).toBe(true);
  });
});

describe('a project’s other folders (M16, V7, V24; C19, C20, C61, C72)', () => {
  const SECOND = 'D:\\Code\\second';
  const THIRD = 'D:\\Code\\third';
  const FOURTH = 'D:\\Code\\fourth';
  const roots = () => project({ roots: [root(), root('trusted', SECOND), root('not-trusted', THIRD), root('trusted', FOURTH)] });
  const handed = () => fake.latest().options.otherFolders;
  /** A turn that runs to its end on the open session, the provider's session named on the way. */
  async function turn(n: number, reference?: string): Promise<void> {
    const turnId = await accepted(n);
    if (reference !== undefined) fake.latest().emit({ type: 'session-started', reference, folder: ROOT });
    finish(turnId);
    await service.settled();
  }

  it('hands a provider that takes them the roots that are trusted and present, without the working folder, at a start and again at a resume', async () => {
    place([session(1)], [roots()]);
    world.otherFolders = true;
    open();
    await turn(1, 'conversation-1');
    expect(fake.latest().kind).toBe('start');
    expect(fake.latest().options).toEqual({ folder: ROOT, model: 'gpt-6-sol', effort: 'high', speed: null, otherFolders: [SECOND, FOURTH], mode: null, processKey: expect.any(String) as string });
    // The session's process ends by itself; meanwhile one of the folders goes missing.
    fake.latest().end();
    await Promise.resolve();
    world.missingRoots.add(FOURTH);
    await turn(1);
    expect(fake.made).toHaveLength(2);
    expect(fake.latest().kind).toBe('resume');
    // Read again at the resume: the list is this launch's own.
    expect(fake.latest().options).toEqual({ reference: 'conversation-1', folder: ROOT, model: 'gpt-6-sol', effort: 'high', speed: null, otherFolders: [SECOND], mode: null, processKey: expect.any(String) as string });
  });

  it('hands an empty list to a provider without the capability, whatever the project’s roots', async () => {
    place([session(1)], [roots()]);
    open();
    await turn(1, 'conversation-1');
    expect(handed()).toEqual([]);
    fake.latest().end();
    await Promise.resolve();
    await turn(1);
    expect(fake.latest().kind).toBe('resume');
    expect(handed()).toEqual([]);
    // Nothing is compared for it either: its process is never closed for a folder.
    world.missingRoots.add(SECOND);
    await turn(1);
    expect(fake.made).toHaveLength(2);
  });

  it('hands none for a project with one root', async () => {
    place([session(1)]);
    world.otherFolders = true;
    open();
    await accepted(1);
    expect(handed()).toEqual([]);
  });

  it('closes the session’s process at the next Send when a folder that was handed over is no longer eligible, and resumes without it (C72)', async () => {
    place([session(1)], [roots()]);
    world.otherFolders = true;
    open();
    await turn(1, 'conversation-1');
    const first = fake.latest();
    expect(first.options.otherFolders).toEqual([SECOND, FOURTH]);
    // While its process is up, the folder stays readable to it: nothing is closed until a prompt is sent.
    world.missingRoots.add(FOURTH);
    expect(first.closes).toBe(0);

    const turnId = await accepted(1, 'Next');
    // Closed before the prompt was accepted: the prompt went to a session opened without the folder.
    expect(first.closes).toBe(1);
    expect(first.sent).toHaveLength(1);
    expect(fake.made).toHaveLength(2);
    expect(fake.latest().kind).toBe('resume');
    expect(fake.latest().options).toMatchObject({ reference: 'conversation-1', otherFolders: [SECOND] });
    expect(fake.latest().sent.map((sent) => sent.prompt)).toEqual(['Next']);
    finish(turnId);
    // With nothing changed, the next prompt goes to the same process.
    await turn(1);
    expect(fake.made).toHaveLength(2);
    expect(log.info.mock.calls.flat().join('\n')).not.toMatch(/fourth|second/i);
  });

  it('leaves a session’s process alone when a folder becomes eligible: it waits for the next launch (C72)', async () => {
    place([session(1)], [roots()]);
    world.otherFolders = true;
    world.missingRoots.add(FOURTH);
    open();
    await turn(1, 'conversation-1');
    expect(handed()).toEqual([SECOND]);
    world.missingRoots.clear();
    await turn(1);
    expect(fake.made).toHaveLength(1);
    expect(fake.latest().closes).toBe(0);
    // The next launch has it.
    fake.latest().end();
    await Promise.resolve();
    await turn(1);
    expect(handed()).toEqual([SECOND, FOURTH]);
  });

  it('refuses the Send as unconfirmed when that close cannot be confirmed, and sends nothing (C72, C116)', async () => {
    place([session(1)], [roots()]);
    world.otherFolders = true;
    open();
    await turn(1, 'conversation-1');
    const first = fake.latest();
    first.cleanup = { ok: false };
    first.recheck = { ok: false };
    world.missingRoots.add(SECOND);
    expect(await runtime.send(S(1), 'Next')).toEqual({ status: 'refused', reason: 'unconfirmed' });
    expect(fake.made).toHaveLength(1);
    expect(first.sent).toHaveLength(1);
    expect(service.isRunning(S(1))).toBe(false);
    // Once a look finds the earlier process gone, the prompt resumes the session without the folder.
    first.recheck = { ok: true };
    await accepted(1, 'Next');
    expect(fake.latest().options).toMatchObject({ reference: 'conversation-1', otherFolders: [FOURTH] });
  });

  it('shows once a run that a folder could not be handed over, in fat-g’s words and with no path (C20)', async () => {
    place([session(1)], [roots()]);
    world.otherFolders = true;
    open();
    const first = await accepted(1);
    fake.latest().emit({ type: 'notice', kind: 'folder-not-passed', turnId: first });
    fake.latest().emit({ type: 'session-started', reference: 'conversation-1', folder: ROOT });
    finish(first);
    await service.settled();
    // The next launch leaves the folder out again, and says so again: it is shown once.
    fake.latest().end();
    await Promise.resolve();
    const second = await accepted(1);
    fake.latest().emit({ type: 'notice', kind: 'folder-not-passed', turnId: second });
    finish(second);
    const notices = messages(1).filter((message) => message.notice === 'folder-not-passed');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toBe('One of this project’s folders could not be passed to Codex: its path holds a character fat-g cannot pass safely. The session runs without it.');
    expect(notices[0]?.text).not.toMatch(/[A-Za-z]:\\/);
  });
});

describe('a turn’s answer, named on its end (M16, V29; C35, C74)', () => {
  const said = (turnId: string, itemId: string, text: string) => fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId, phase: 'commentary', text });
  const phases = (n: number) => messages(n).filter((message) => message.role === 'assistant').map((message) => [message.itemId, message.phase]);

  it('settles the named message as the answer when the provider’s completed end names it, and leaves the others as they were said', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    said(turnId, 'note-1', 'Looking.');
    said(turnId, 'answer-1', 'It fails on Tuesdays.');
    expect(phases(1)).toEqual([['note-1', 'commentary'], ['answer-1', 'commentary']]);
    fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'completed', reported: true, answerItemId: 'answer-1' });
    expect(phases(1)).toEqual([['note-1', 'commentary'], ['answer-1', 'final']]);
    // In the store, with the provider's end: both are there after a restart.
    expect(conversations.turn(S(1), turnId)).toMatchObject({ providerOutcome: 'completed' });
    await service.settled();
    runtime.dispose();
    service.stop();
    open();
    expect(phases(1)).toEqual([['note-1', 'commentary'], ['answer-1', 'final']]);
    expect(chatOf(1).turns[0]).toMatchObject({ state: 'ended', outcome: 'completed' });
  });

  it('settles nothing on an end that is interrupted or failed, on one the adapter made, or on one that names none', async () => {
    place([session(1), session(2), session(3), session(4)]);
    open();
    const ends: Record<number, Record<string, unknown>> = {
      1: { outcome: 'interrupted', reported: true, answerItemId: 'answer' },
      2: { outcome: 'failed', reported: true, failure: 'turn-failed', answerItemId: 'answer' },
      3: { outcome: 'completed', reported: false, answerItemId: 'answer' },
      4: { outcome: 'completed', reported: true },
    };
    for (const n of [1, 2, 3, 4]) {
      const turnId = await accepted(n);
      said(turnId, 'answer', 'Almost.');
      fake.latest().emit({ type: 'turn-ended', turnId, ...ends[n] });
      expect(phases(n), String(n)).toEqual([['answer', 'commentary']]);
    }
  });

  it('settles an item that could not be saved in the copy kept for the run (M18, C19)', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    storeFault = 'item';
    said(turnId, 'answer-1', 'It fails on Tuesdays.');
    storeFault = null;
    expect(chatOf(1).storage).toBe('failing');
    fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'completed', reported: true, answerItemId: 'answer-1' });
    expect(phases(1)).toEqual([['answer-1', 'final']]);
    expect(chatOf(1).turns[0]).toMatchObject({ gap: true, state: 'ended' });
  });

  it('shows the change on the push the end already sends: one more, and no other', async () => {
    place([session(1)]);
    open();
    const pushes: unknown[] = [];
    chat.subscribe((push) => { pushes.push(push); });
    const turnId = await accepted(1);
    said(turnId, 'answer-1', 'Done.');
    const before = pushes.length;
    fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'completed', reported: true, answerItemId: 'answer-1' });
    const after = pushes.slice(before) as { changed?: boolean }[];
    // The end's own push, and the session's end: neither is new for the answer.
    expect(after.every((push) => push.changed === true)).toBe(true);
    expect(after.length).toBeLessThanOrEqual(2);
  });
});

// V7, V15 (docs/planning/_archive/M19.md; C3, C4, C18, C19, C43, C44): a message that streams through the
// runtime, what each kind of end leaves of one that never finished, and the turn's elapsed time.
describe('a message as it is written (M19: V7, V15; C18, C19, C43, C44)', () => {
  const delta = (turnId: string, text: string, itemId = 'item-1') => fake.latest().emit({ type: 'message-delta', turnId, itemId, phase: 'commentary', text });
  const answerOf = (n: number) => chatOf(n).items.find((item) => item.role === 'assistant');
  /** A turn whose answer is half written: opened, with text the page was pushed and text it was not. */
  async function halfWritten(n = 1): Promise<string> {
    const turnId = await accepted(n);
    fake.latest().emit({ type: 'turn-started', turnId, providerTurnId: 'provider-turn-1' });
    delta(turnId, '');
    delta(turnId, 'Half an ans');
    timers.advance(50);
    delta(turnId, 'wer');
    return turnId;
  }

  it('shows a message from its first delta, growing, and completes it by its whole message, which is the authority (C3, C4)', async () => {
    place([session(1)]);
    open();
    const pushes: ChatPush[] = [];
    chat.subscribe((push) => { pushes.push(push); });
    const turnId = await halfWritten();
    expect(answerOf(1)).toMatchObject({ state: 'streaming', phase: 'commentary', providerItemId: 'item-1', blocks: [{ text: 'Half an ans' }] });
    timers.advance(50);
    expect(answerOf(1)).toMatchObject({ state: 'streaming', blocks: [{ text: 'Half an answer' }] });
    fake.latest().emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-1', phase: 'final', text: 'Half an answer, and the other half.' });
    expect(answerOf(1)).toMatchObject({ state: 'complete', phase: 'final', blocks: [{ text: 'Half an answer, and the other half.' }] });
    // One message, under one id, from its opening to its completion.
    expect(texts(1)).toEqual([['user', 'Fix the login bug'], ['assistant', 'Half an answer, and the other half.']]);
    const kinds = pushes.map((push) => ('item' in push ? `item:${push.item.state}` : 'partial' in push ? 'partial' : 'changed'));
    // The prompt, the provider's word that it took it, then the message: opened, grown twice, completed.
    expect(kinds).toEqual(['item:complete', 'changed', 'item:streaming', 'partial', 'partial', 'item:complete']);
    // Nothing of it reached the summary, and a late delta changes nothing.
    expect(JSON.stringify(service.snapshot())).not.toContain('Half an');
    delta(turnId, ' More.');
    timers.advance(50);
    expect(answerOf(1)).toMatchObject({ blocks: [{ text: 'Half an answer, and the other half.' }] });
    expect(chat.dropped()).toMatchObject({ complete: 1 });
    finish(turnId);
  });

  it.each([
    ['a Stop the provider confirms', (turnId: string) => { expect(runtime.stop(S(1))).toEqual({ status: 'stopping' }); fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'interrupted', reported: true }); }, 'ended'],
    ['an end the adapter makes', (turnId: string) => { fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'failed', reported: false, failure: 'end-lost' }); }, 'unfinished'],
    ['a lost process', () => { fake.latest().end({ ok: true }); }, 'unfinished'],
  ] as const)('leaves an open message partial with its text after %s (C18)', async (_name, end, turnState) => {
    place([session(1)]);
    open();
    const turnId = await halfWritten();
    end(turnId);
    await Promise.resolve();
    await Promise.resolve();
    // What was received, the part the page had not been pushed included, and nothing more.
    expect(answerOf(1)).toMatchObject({ state: 'partial', blocks: [{ text: 'Half an answer', cut: false }] });
    expect(conversations.newestPage(S(1)).items.find((item) => item.role === 'assistant')).toMatchObject({ state: 'partial', blocks: [{ text: 'Half an answer' }] });
    expect(chatOf(1).turns[0]).toMatchObject({ state: turnState });
    expect(service.isRunning(S(1))).toBe(false);
    // A delta that comes after the end changes nothing.
    delta(turnId, ' and more');
    timers.advance(50);
    expect(answerOf(1)).toMatchObject({ blocks: [{ text: 'Half an answer' }] });
  });

  it('writes each open message’s text at the quit, before its turn is written stopped: partial at the next launch, and never streaming (C19)', async () => {
    place([session(1)]);
    open();
    await halfWritten();
    // On disk so far: what the first text's write stored.
    expect(conversations.newestPage(S(1)).items.find((item) => item.role === 'assistant')).toMatchObject({ blocks: [{ text: 'Half an ans' }] });
    const stopping = runtime.stopAll();
    // At once, before anything is waited for.
    expect(conversations.newestPage(S(1)).items.find((item) => item.role === 'assistant')).toMatchObject({ state: 'partial', blocks: [{ text: 'Half an answer' }] });
    // The provider never confirms the Stop: the wait runs out, and the turn is written stopped.
    timers.advance(QUIT_STOP_MS);
    await stopping;
    await service.endRunningTurns();
    runtime.dispose();
    service.stop();

    // The next launch.
    open();
    expect(answerOf(1)).toMatchObject({ state: 'partial', blocks: [{ text: 'Half an answer' }] });
    expect(chatOf(1).turns[0]).toMatchObject({ state: 'unfinished', outcome: 'stopped' });
    expect(summary(1)?.status).not.toBe('running');
  });

  it('measures a turn from its prompt’s acceptance to the provider’s end on the monotonic clock: moving the system clock does not change it (C43, C44)', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'turn-started', turnId });
    // 1.5 seconds pass, and the user sets the system clock back an hour meanwhile.
    clock.mono += 1_500.4;
    clock.wall -= 3_600_000;
    finish(turnId);
    const [turn] = chatOf(1).turns;
    expect(turn).toMatchObject({ state: 'ended', time: { elapsedMs: 1_500, providerDurationMs: null } });
    expect(conversations.turn(S(1), turnId)).toMatchObject({ elapsedMs: 1_500, acceptedAt: AT, endReceivedAt: AT - 3_600_000 });
  });

  it('stores no elapsed time for a turn whose end the provider never gave (C43)', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    clock.mono += 900;
    fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'failed', reported: false, failure: 'connection-lost' });
    expect(chatOf(1).turns[0]).toMatchObject({ state: 'unacknowledged', time: { elapsedMs: null } });
    expect(conversations.turn(S(1), turnId)?.elapsedMs).toBeNull();
  });
});

describe('what a session does, and its workers (M20a: V6, V7; C20, C23, C29, C30, C32)', () => {
  const PRIVATE = 'rm -rf C:\\Users\\someone\\secret';
  const activitiesOf = (n: number) => chatOf(n).items.filter((item) => item.kind === 'activity').map((item) => ({ id: item.providerItemId, status: item.activity?.status, type: item.activity?.type, summary: item.activity?.summary }));
  const workerOf = (n: number, workerId: string) => { const read = runtime.readWorker(S(n), workerId); if (read.status !== 'read') throw new Error(`not read: ${JSON.stringify(read)}`); return read; };
  const command = (turnId: string, itemId: string, extra: Record<string, unknown> = {}) => ({ type: 'activity-started', turnId, itemId, activityType: 'command', name: 'commandExecution', summary: 'rg --files', input: PRIVATE, ...extra });

  it('keeps an activity as an item of the conversation, in its place among the turn’s messages, and nothing of it in the summary or the record', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'm1', phase: 'commentary', text: 'I will list the files.' });
    live.emit(command(turnId, 'call-1'));
    live.emit({ type: 'activity-ended', turnId, itemId: 'call-1', status: 'completed', output: 'a.md\nb.md', exitCode: 0, durationMs: 4 });
    live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'm2', phase: 'final', text: 'Two files.' });
    finish(turnId);
    await service.settled();
    expect(chatOf(1).items.map((item) => item.kind)).toEqual(['message', 'message', 'activity', 'message']);
    expect(chatOf(1).items[2]?.activity).toMatchObject({ type: 'command', status: 'completed', input: PRIVATE, output: 'a.md\nb.md', exitCode: 0, duration: { ms: 4, provenance: 'provider' } });
    // Conversation content: the store alone holds it (C30).
    expect(JSON.stringify(service.snapshot())).not.toContain('secret');
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
    expect(JSON.stringify(log.info.mock.calls) + JSON.stringify(log.warn.mock.calls)).not.toContain('secret');
  });

  it('names the item that started a worker as the agent list names that worker, whatever the adapter called it (C23)', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    // A provider that says nothing of its worker: the list calls it by its number.
    live.emit({ type: 'worker-started', workerId: 'thread-9' });
    live.emit({ type: 'activity-started', turnId, itemId: 'sub-agent-1', activityType: 'worker', name: 'subAgentActivity', summary: 'the adapter’s own line', pairedWorkerId: 'thread-9' });
    const label = summary(1)?.agents[0]?.label;
    expect(label).toBe('Worker 1');
    expect(activitiesOf(1)).toEqual([{ id: 'sub-agent-1', status: 'running', type: 'worker', summary: label }]);
    expect(workerOf(1, 'thread-9').worker?.activity).toMatchObject({ summary: label, workerId: 'thread-9' });
  });

  it('gives a worker item its worker’s description once a second start pairs it, and keeps the adapter’s line for one the list does not have', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    const agent = { type: 'activity-started', turnId, itemId: 'tool-use-1', activityType: 'worker', name: 'Agent', summary: 'Read notes-3.txt contents' };
    live.emit(agent);
    expect(activitiesOf(1)).toEqual([{ id: 'tool-use-1', status: 'running', type: 'worker', summary: 'Read notes-3.txt contents' }]);
    live.emit({ type: 'worker-started', workerId: 'task-7', description: 'Reads the notes' });
    live.emit({ ...agent, pairedWorkerId: 'task-7' });
    expect(activitiesOf(1)).toEqual([{ id: 'tool-use-1', status: 'running', type: 'worker', summary: summary(1)?.agents[0]?.label }]);
    expect(summary(1)?.agents[0]?.label).toContain('Reads the notes');
    // A worker the summary never listed: the line stays the adapter's.
    live.emit({ type: 'activity-started', turnId, itemId: 'tool-use-2', activityType: 'worker', name: 'Agent', summary: 'Another', pairedWorkerId: 'unlisted' });
    expect(activitiesOf(1)[1]).toMatchObject({ id: 'tool-use-2', summary: 'Another' });
  });

  it('keeps a worker’s items under it, late or not, and lets none of them end the turn, be its answer, its action line or its name (C20)', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1, 'Hand it to a sub-agent');
    const live = fake.latest();
    live.emit({ type: 'worker-started', workerId: 'w1' });
    live.emit({ type: 'activity-started', turnId, itemId: 'sub-agent-1', activityType: 'worker', name: 'subAgentActivity', summary: 'x', pairedWorkerId: 'w1' });
    live.emit({ type: 'action-changed', turnId, kind: 'waiting' });
    const before = summary(1);
    live.emit(command(turnId, 'w-call-1', { workerId: 'w1' }));
    live.emit({ type: 'message-delta', turnId, itemId: 'w-text', phase: 'final', text: 'The file', workerId: 'w1' });
    live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'w-text', phase: 'final', text: 'The file holds one line.', workerId: 'w1' });
    // Nothing of the summary moved for any of them.
    expect(summary(1)).toEqual(before);
    live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'own', phase: 'commentary', text: 'Waiting for the sub-agent.' });
    live.emit({ type: 'turn-ended', turnId, outcome: 'completed', reported: true, answerItemId: 'own' });
    // The turn has ended and its worker runs on: its late items are still its turn's.
    expect(summary(1)).toMatchObject({ status: 'running', activeWorkers: 1 });
    live.emit({ type: 'activity-ended', turnId, itemId: 'w-call-1', status: 'completed', output: 'one line', workerId: 'w1' });
    live.emit(command(turnId, 'w-call-2', { workerId: 'w1' }));
    const turn = conversations.turn(S(1), turnId);
    expect(turn).toMatchObject({ providerOutcome: 'completed' });

    const worker = workerOf(1, 'w1');
    expect(worker.items.map((item) => [item.kind, item.providerItemId, item.turnId, item.workerId])).toEqual([['activity', 'w-call-1', turnId, 'w1'], ['message', 'w-text', turnId, 'w1'], ['activity', 'w-call-2', turnId, 'w1']]);
    expect(worker.items.map((item) => item.activity?.status ?? null)).toEqual(['completed', null, 'running']);
    // The session's own list holds none of it, and the answer is the session's own message.
    expect(chatOf(1).items.every((item) => item.workerId === null)).toBe(true);
    expect(messages(1).filter((message) => message.role === 'assistant')).toMatchObject([{ itemId: 'own', phase: 'final' }]);

    // The worker ends: its item does, and what was still open of it is left unfinished.
    live.emit({ type: 'worker-ended', workerId: 'w1', outcome: 'completed' });
    live.emit({ type: 'activity-ended', turnId, itemId: 'sub-agent-1', status: 'completed', output: 'The file holds one line.' });
    await service.settled();
    expect(activitiesOf(1)).toMatchObject([{ id: 'sub-agent-1', status: 'completed' }]);
    expect(workerOf(1, 'w1').items.map((item) => item.activity?.status ?? null)).toEqual(['completed', null, 'unfinished']);
    // Its name is its first prompt's first line: no worker's message named it.
    expect(stored(1)?.['name']).toBe('Hand it to a sub-agent');
    expect(conversations.turn(S(1), turnId)).toMatchObject({ providerOutcome: turn?.providerOutcome, endReceivedAt: turn?.endReceivedAt });
    expect(summary(1)?.status).not.toBe('running');
  });

  it('leaves what was open unfinished when the provider’s end of the turn comes, and completes its checklist', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    live.emit(command(turnId, 'call-1'));
    live.emit({ type: 'activity-started', turnId, itemId: `${turnId}#plan`, activityType: 'checklist', name: 'plan', summary: 'Tasks', steps: [{ text: 'one', state: 'in-progress' }] });
    live.emit({ type: 'activity-started', turnId, itemId: `${turnId}#plan`, activityType: 'checklist', name: 'plan', summary: 'Tasks', steps: [{ text: 'one', state: 'completed' }] });
    finish(turnId, 'interrupted');
    expect(activitiesOf(1)).toMatchObject([{ id: 'call-1', status: 'unfinished' }, { id: `${turnId}#plan`, status: 'completed', type: 'checklist' }]);
    expect(chatOf(1).items.at(-1)?.activity?.steps).toEqual([{ text: 'one', state: 'completed' }]);
    // A completion that comes late still ends its item.
    live.emit({ type: 'activity-ended', turnId, itemId: 'call-1', status: 'completed', output: 'late' });
    expect(activitiesOf(1)[0]).toMatchObject({ id: 'call-1', status: 'completed' });
  });

  it('leaves every open activity unfinished, a worker’s included, when the session’s process is gone with no turn in flight', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    live.emit({ type: 'worker-started', workerId: 'w1' });
    live.emit({ type: 'activity-started', turnId, itemId: 'sub-agent-1', activityType: 'worker', name: 'subAgentActivity', summary: 'x', pairedWorkerId: 'w1' });
    live.emit(command(turnId, 'w-call-1', { workerId: 'w1' }));
    finish(turnId);
    expect(activitiesOf(1)).toMatchObject([{ id: 'sub-agent-1', status: 'running' }]);
    // The process ends by itself, and no adapter said a word of its worker.
    live.end();
    await vi.waitFor(() => expect(summary(1)?.status).not.toBe('running'));
    expect(activitiesOf(1)).toMatchObject([{ id: 'sub-agent-1', status: 'unfinished' }]);
    expect(workerOf(1, 'w1').items.map((item) => item.activity?.status)).toEqual(['unfinished']);
  });

  it('writes what was open unfinished at a quit, before anything is waited for, and shows it so at the next launch', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit(command(turnId, 'call-1'));
    const stopping = runtime.stopAll();
    expect(conversations.newestPage(S(1)).items.at(-1)).toMatchObject({ state: 'partial', activity: { status: 'unfinished', input: PRIVATE } });
    timers.advance(QUIT_STOP_MS);
    await stopping;
    await service.endRunningTurns();
    runtime.dispose();
    service.stop();
    open();
    expect(activitiesOf(1)).toMatchObject([{ id: 'call-1', status: 'unfinished' }]);
  });

  it('refuses an activity that fails its schema, as any event that does: a type it does not know, a field it does not name', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit(command(turnId, 'call-1', { activityType: 'plan' }));
    fake.latest().emit(command(turnId, 'call-2', { command: PRIVATE }));
    expect(activitiesOf(1)).toEqual([]);
  });

  it('answers a worker’s read for a listed session alone', async () => {
    place([session(1)]);
    open();
    expect(runtime.readWorker(S(9), 'w1')).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(runtime.readWorker(S(1), 'w1')).toEqual({ status: 'refused', reason: 'unknown-worker' });
    const turnId = await accepted(1);
    fake.latest().emit(command(turnId, 'w-call-1', { workerId: 'w1' }));
    expect(runtime.readWorker(S(1), 'w1')).toMatchObject({ status: 'read', workerId: 'w1', worker: null });
    expect(runtime.readWorker(S(1), 'w1', 'no-such-cursor')).toEqual({ status: 'refused', reason: 'unknown-cursor' });
  });
});

describe('the history check, for what a session did (M20a: V6; C19, C58)', () => {
  it('reads a turn again while an activity of it is unfinished, and the provider’s history completes it in place', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    live.emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    live.emit({ type: 'turn-started', turnId, providerTurnId: 'p-1' });
    live.emit({ type: 'activity-started', turnId, itemId: 'call-1', activityType: 'command', name: 'commandExecution', summary: 'ls', input: 'ls' });
    finish(turnId, 'interrupted');
    await service.settled();
    const before = chatOf(1).items.find((item) => item.kind === 'activity');
    expect(before?.activity?.status).toBe('unfinished');
    runtime.dispose();
    service.stop();

    // The next launch: the provider's own history has the command's end.
    open();
    const prompt = chatOf(1).items[0];
    fake.history = pagedHistory([{
      turn: { turnId: 'p-1', outcome: 'interrupted', startedAt: 1_000, endedAt: 3_000, durationMs: 1_900 },
      messages: [{ role: 'user', itemId: 'h-user', phase: null, text: 'Fix the login bug', turnId: 'p-1', clientId: prompt?.id ?? '', at: 1_000, order: 0 }],
    }]);
    const withActivities = fake.history;
    fake.history = (reference, page) => {
      const answer = withActivities(reference, page) as HistoryAnswer;
      return answer.kind === 'page' && page.detail === 'full'
        ? { ...answer, activities: [{ turnId: 'p-1', itemId: 'call-1', activityType: 'command', name: 'commandExecution', summary: 'ls', input: 'ls', status: 'completed', output: 'a.md', exitCode: 0, durationMs: 7, at: 1_000, order: 1 }] }
        : answer;
    };
    await service.select(S(1));
    runtime.selectionChanged();
    await vi.waitFor(() => expect(chatOf(1).history.state).toBe('checked'));
    const after = chatOf(1).items.find((item) => item.kind === 'activity');
    expect(after).toMatchObject({ id: before?.id, order: before?.order, state: 'complete', activity: { status: 'completed', output: 'a.md', exitCode: 0, duration: { ms: 7, provenance: 'provider' } } });
    // With its items, since it was not whole.
    expect(fake.reads.some((read) => read.page.detail === 'full')).toBe(true);
  });
});

// ── M106: a session's sub-agents across a restart ─────────────────────────────────────────────
// V1, V2 (docs/planning/_archive/M106.md, Design 3, 4; C19, C26): the worker item keeps the model and the
// agent definition, the later model by a second start of it; the reconcile step lists the finished
// sub-agents from the store at launch, once a session, again after a Start fresh's `force`, and never
// over a session that runs.
describe('a session’s sub-agents across a restart (M106: V1, V2)', () => {
  /** Its rows gone from the store, as a new store would hold none of them. */
  const forget = (n: number): void => {
    const db = new DatabaseSync(path.join(dir, STORE_FILE));
    try { db.prepare('DELETE FROM item WHERE conversationId = ?').run(S(n)); } finally { db.close(); }
  };

  it('lists the finished ones at launch from their items, with the model their frames named, and again only when forced', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    const live = fake.latest();
    const item = { type: 'activity-started', turnId, itemId: 'use-1', activityType: 'worker', name: 'Agent', summary: 'Reads the notes' } as const;
    live.emit(item);
    live.emit({ type: 'worker-started', workerId: 'task-1', description: 'Reads the notes', model: 'haiku', agentType: 'general-purpose' });
    live.emit({ ...item, pairedWorkerId: 'task-1', model: 'haiku', agentType: 'general-purpose' });
    live.emit({ type: 'worker-model', workerId: 'task-1', model: 'claude-haiku-4-5-20251001' });
    live.emit({ ...item, pairedWorkerId: 'task-1', model: 'claude-haiku-4-5-20251001' });
    expect(summary(1)?.agents[0]).toMatchObject({ model: 'claude-haiku-4-5-20251001', agentType: 'general-purpose', state: 'running' });
    live.emit({ type: 'activity-ended', turnId, itemId: 'use-1', status: 'completed', durationMs: 4_000 });
    live.emit({ type: 'worker-ended', workerId: 'task-1', outcome: 'completed' });
    finish(turnId);
    await service.settled();

    // A restart: the record says nothing of it, and the store lists it.
    open();
    const [listed] = summary(1)?.agents ?? [];
    expect(listed).toMatchObject({ id: 'task-1', number: 1, label: 'Reads the notes', state: 'completed', action: null, model: 'claude-haiku-4-5-20251001', agentType: 'general-purpose', attention: null });
    expect((listed?.finishedAt ?? 0) - (listed?.startedAt ?? 0)).toBe(4_000);
    // Its thread reads as it did.
    expect(runtime.readWorker(S(1), 'task-1')).toMatchObject({ status: 'read' });

    // Reconciled once a run: a store that changed meanwhile is read again only when forced.
    forget(1);
    runtime.reconcile();
    expect(summary(1)?.agents).toHaveLength(1);
    runtime.reconcile(true);
    expect(summary(1)?.agents).toEqual([]);
  });

  it('leaves a session that runs with its own list when forced', async () => {
    place([session(1)]);
    open();
    const turnId = await accepted(1);
    fake.latest().emit({ type: 'worker-started', workerId: 'w1', model: 'gpt-6-astra' });
    forget(1);
    runtime.reconcile(true);
    expect(summary(1)?.agents.map((agent) => [agent.id, agent.model])).toEqual([['w1', 'gpt-6-astra']]);
    finish(turnId);
  });
});
