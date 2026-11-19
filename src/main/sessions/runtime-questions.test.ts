// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V7, V8, V22, V24, V26, V31–V33 (docs/planning/_archive/M21.md; C10–C15, C26, C31, C33–C35, C41, C61,
// C67, C68, C70, C73, C75–C78): a question the session asks, through the runtime, on a real records
// store, a real conversation store, the chat service, the session service and the request registry,
// with a facet in the test's hands. No Electron, no process. The same against the replay fakes is
// in tests/claude/chat/ and tests/codex/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentEvent, MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import type { ChatPush, ChatRead, ChatWorkerRead } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type AnswerEntry, type BoundQuestion, MAX_ANSWER_TEXT, outcomeWords, type QuestionCapability } from '@shared/contracts/interaction';
import { storeFiles } from '../conversations/format';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { type AppStateStore, createAppStateStore } from '../state/app-state-store';
import { type ChatService, createChatService } from './chat-service';
import { createGate } from './gate';
import { createRemoval } from './removal';
import { createSessionRuntime, IDLE_CLOSE_MS, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet, type FakeSession } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-01-31T13:00:00.000Z');

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
  };
}

let dir: string;
let records: RecordsStore;
let service: SessionService;
let runtime: SessionRuntime;
let chat: ChatService;
let conversations: ConversationStore;
let appState: AppStateStore;
let fake: FakeFacet;
let timers: ReturnType<typeof manualTimers>;
let ids: number;
let clock: { wall: number; mono: number };
let pushes: ChatPush[];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const world: { questions: QuestionCapability; storeFault: string | null; hold: (() => Promise<void>) | null; /** The provider has a command fat-g answers itself (decision 0023). */ intercepts: boolean } = { questions: 'both', storeFault: null, hold: null, intercepts: false };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-questions-'));
  ids = 0;
  clock = { wall: AT, mono: 5_000 };
  Object.assign(world, { questions: 'both', storeFault: null, hold: null, intercepts: false });
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

const root = { path: ROOT, trust: { answer: 'trusted', answeredAt: '2020-01-23T00:00:00.000Z' } };
const session = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: null, nameSource: null,
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null, ...overrides,
});
const place = (sessions: unknown[]) => writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [{ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [root] }], sessions }));

function open(): void {
  // A second `open` is a restart, on the same folder.
  runtime?.dispose();
  service?.stop();
  records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', now: () => AT, log });
  appState = createAppStateStore();
  fake = fakeFacet({ history: false, ...(world.intercepts ? { intercepts: (prompt: string) => (prompt.startsWith('/clear') ? 'command-clear' as const : null) } : {}) });
  conversations?.close();
  conversations = createConversationStore({ dir, log, now: () => clock.wall, hook: (point) => { if (world.storeFault === point) throw Object.assign(new Error('disk'), { code: 'EIO' }); } });
  timers = manualTimers();
  let ready = false;
  // What waits is the registry's to say: the runtime, made below, holds it.
  chat = createChatService({ store: conversations, log, timers, now: () => clock.wall, requests: { pending: (sessionId, itemId) => ready && runtime.requests.pending(sessionId, itemId), waiting: (sessionId) => (ready ? runtime.requests.waiting(sessionId) : []) } });
  pushes = [];
  chat.subscribe((push) => { pushes.push(push); });
  const removal = createRemoval({ store: conversations, log });
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => false,
    snapshot: () => ({ status: { kind: 'ok' }, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: false, models: true, asides: 'none', questions: world.questions, permissions: null } } }),
    hasRuntime: () => true,
    project: (id) => records.getProject(id),
    isMissing: () => false,
    kept: (id) => (ready ? runtime.kept(id) : undefined),
    platform: 'win32',
  });
  const made = createSessionService({
    records, store: appState, now: () => AT, platform: 'win32', log, block: (record, hold) => gate.block(record, hold), onReferenceUnsaved: (id) => runtime.referenceUnsaved(id),
    onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome),
  });
  // A Send's first wait, in the test's hands where it says so (C77).
  service = { ...made, hold: async (id) => { await world.hold?.(); return made.hold(id); } };
  runtime = createSessionRuntime({
    sessions: service, records, chat, gate, timers, log, now: () => clock.wall, monotonic: () => clock.mono, newId: () => `id-${++ids}`,
    facet: () => fake.facet,
    providerName: () => 'Codex',
    hasHistory: () => false,
    questions: () => world.questions,
    store: conversations,
    removal,
  });
  ready = true;
}

const QUESTION: BoundQuestion = { text: 'NEEDLE-QUESTION Which file should I read?', header: 'NEEDLE-HEADER', options: [{ label: 'NEEDLE-LABEL notes-1.txt', description: 'NEEDLE-DESCRIPTION the first note' }, { label: 'notes-2.txt', description: null }], multiple: false, freeText: true, secret: false };
const TITLES = [{ title: 'Which file do you want me to read?', options: ['notes-1.txt', 'notes-2.txt'] }];
const read = (n = 1): ChatRead => { const answer = runtime.read(S(n)); if (answer.status !== 'read') throw new Error(answer.reason); return answer; };
const workerRead = (workerId: string, n = 1): ChatWorkerRead => { const answer = runtime.readWorker(S(n), workerId); if (answer.status !== 'read') throw new Error(answer.reason); return answer; };
const cards = (items: readonly ConversationItem[] = read().items): ConversationItem[] => items.filter((item) => item.kind === 'interaction');
const card = (items?: readonly ConversationItem[]): ConversationItem => { const found = cards(items).at(-1); if (found === undefined) throw new Error('no card'); return found; };
const words = (item: ConversationItem = card(), unconfirmed = false): string | null => (item.interaction === null ? null : outcomeWords(item.interaction, unconfirmed));
const summary = (n = 1) => service.snapshot().sessions.find((entry) => entry.record.id === S(n))?.summary;
/** What the session's process says, as an adapter would. */
const emit = (event: AgentEvent, from: FakeSession = fake.latest()): void => from.emit(event);
const pick = (option: number, question = 0): AnswerEntry => ({ question, options: [option], text: null });
const stored = (): string => storeFiles().map((name) => { try { return readFileSync(path.join(dir, name), 'latin1'); } catch { return ''; } }).join('\n');
const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };
/** fat-g started again on the same folder: what the first run asked of its records has landed. */
async function restart(): Promise<void> {
  await service.settled();
  conversations.close();
  open();
}

/** A session whose turn runs: its prompt sent, and taken by the provider. */
async function running(n = 1, prompt = 'Read a note.'): Promise<string> {
  expect(await runtime.send(S(n), prompt)).toEqual({ status: 'accepted' });
  const turnId = fake.latest().sent.at(-1)?.turnId ?? '';
  emit({ type: 'turn-started', turnId, providerTurnId: `p-${turnId}` });
  return turnId;
}
function raise(turnId: string, requestId = 'request-1', patch: Partial<Extract<AgentEvent, { type: 'question-raised' }>> = {}): void {
  emit({ type: 'question-raised', turnId, requestId, sourceId: `source-${requestId}`, questions: [QUESTION], cut: false, ...patch });
}
const end = (turnId: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed', reported = true): void => { emit({ type: 'turn-ended', turnId, outcome, reported, ...(reported ? {} : { failure: 'connection-lost' as const }) }); };

describe('a blocking question, raised (V3, V8; C10, C15, C33–C35)', () => {
  it('is an item of its turn, pending, pushed at once, with the session’s attention raised and its line in fat-g’s words', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    pushes = [];
    raise(turnId);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ sessionId: S(1), item: { kind: 'interaction', turnId, providerItemId: 'source-request-1', workerId: null, interaction: { mode: 'blocking', outcome: 'pending', questions: [QUESTION], cut: false } }, turn: { id: turnId, state: 'running' } });
    expect(card().interaction).toMatchObject({ outcome: 'pending', answers: null });
    expect(summary()).toMatchObject({ status: 'running', attention: { kind: 'question', count: 1, acknowledged: false }, action: { kind: 'asking', label: 'Asking a question' } });
    // Visiting leaves a pending question lit until it is answered.
    await service.select(S(1));
    expect(summary()?.attention).toMatchObject({ kind: 'question', acknowledged: false });
  });

  it('is pending to a read made from inside its own push: the request is held before the card is told (C76)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    const seen: (string | undefined)[] = [];
    chat.subscribe((push) => { if ('item' in push && push.item?.kind === 'interaction') seen.push(card().interaction?.outcome); });
    raise(turnId);
    expect(seen).toEqual(['pending']);
  });

  it('makes one card for a request delivered twice, and two for two requests, the count following', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    raise(turnId);
    expect(cards()).toHaveLength(1);
    raise(turnId, 'request-2');
    expect(cards()).toHaveLength(2);
    expect(summary()?.attention).toMatchObject({ kind: 'question', count: 2 });
  });

  it('refuses through its session a request it cannot place: another turn’s, a worker’s that is not listed, one that could not be kept', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise('another-turn', 'late');
    raise(turnId, 'orphan', { workerId: 'worker-9' });
    world.storeFault = 'interaction';
    raise(turnId, 'unkept');
    world.storeFault = null;
    expect(fake.latest().answered).toEqual([{ requestId: 'late', answers: null }, { requestId: 'orphan', answers: null }, { requestId: 'unkept', answers: null }]);
    expect(cards()).toEqual([]);
    expect(summary()?.attention).toBeNull();
  });

  it('says nothing of the question to a log, the summary or the app state: kinds and counts alone (C34)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    expect(await runtime.answer(S(1), card().id, [{ question: 0, options: [0], text: 'NEEDLE-ANSWER and this too' }])).toEqual({ status: 'answered' });
    emit({ type: 'question-resolved', requestId: 'request-1', reason: 'confirmed' });
    end(turnId);
    await service.settled();
    const said = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].flat().map(String).join('\n');
    expect(said).toMatch(/question raised/);
    expect(said).toMatch(/question answered/);
    for (const text of [said, JSON.stringify(service.snapshot()), JSON.stringify(appState.getSnapshot()), readFileSync(path.join(dir, RECORDS_FILE), 'utf8')]) expect(text).not.toMatch(/NEEDLE|notes-|source-request/);
    // It is conversation content: in the store's files, and the Main window's reads.
    expect(stored()).toContain('NEEDLE-QUESTION');
    expect(stored()).toContain('NEEDLE-ANSWER');
  });
});

describe('a blocking question, answered (V3, V7; C13, C14, C31, C62, C63, C78)', () => {
  it('promotes an accepted answer or decline, preserving position for a refused answer', async () => {
    place([session(1), session(2)]);
    open();
    const turnId = await running();
    raise(turnId);
    await service.settled();
    await service.move(S(1), null, { list: 'active', starred: false });
    const order = () => service.snapshot().sessions.map((item) => item.record.id);
    expect(await runtime.answer(S(1), 'missing', [])).toMatchObject({ status: 'refused' });
    await service.settled();
    expect(order()).toEqual([S(2), S(1)]);
    expect(await runtime.answer(S(1), card().id, [{ question: 0, options: [0], text: null }])).toEqual({ status: 'answered' });
    await service.settled();
    expect(order()).toEqual([S(1), S(2)]);
    fake.latest().session.decline = () => undefined;
    raise(turnId, 'request-2');
    await service.move(S(1), null, { list: 'active', starred: false });
    expect(runtime.dismiss(S(1), card().id)).toEqual({ status: 'dismissed' });
    await service.settled();
    expect(order()).toEqual([S(1), S(2)]);
  });

  it('writes the answer before the CLI is told, resolves the attention, and takes its mark at the CLI’s confirmation', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    const id = card().id;
    pushes = [];
    clock.wall = AT + 4_000;
    expect(await runtime.answer(S(1), id, [{ question: 0, options: [1], text: 'and the third' }])).toEqual({ status: 'answered' });
    // The facet is given the answer by places, for it to encode from the request it holds (C59).
    expect(fake.latest().answered).toEqual([{ requestId: 'request-1', answers: [{ options: [1], text: 'and the third' }] }]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ item: { id, interaction: { outcome: 'answered', answers: [{ options: [1], text: 'and the third', secret: false }], settledAt: AT + 4_000, confirmedAt: null } } });
    expect(summary()).toMatchObject({ attention: null, action: { kind: 'thinking', label: 'Thinking…' } });
    clock.wall = AT + 4_005;
    emit({ type: 'question-resolved', requestId: 'request-1', reason: 'confirmed' });
    expect(card().interaction).toMatchObject({ outcome: 'answered', confirmedAt: AT + 4_005 });
    expect(pushes.at(-1)).toMatchObject({ item: { id, interaction: { confirmedAt: AT + 4_005 } } });
    // On disk, as it was answered.
    await restart();
    expect(card().interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: 'and the third', secret: false }], confirmedAt: AT + 4_005 });
  });

  it('sends nothing and stays pending where the answer could not be recorded', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    world.storeFault = 'interaction-set';
    expect(await runtime.answer(S(1), card().id, [pick(0)])).toEqual({ status: 'refused', reason: 'storage-failed' });
    world.storeFault = null;
    expect(fake.latest().answered).toEqual([]);
    expect(card().interaction?.outcome).toBe('pending');
    expect(await runtime.answer(S(1), card().id, [pick(0)])).toEqual({ status: 'answered' });
  });

  it.each<[string, AnswerEntry[], string]>([
    ['a place past the options', [pick(5)], 'mismatch'],
    ['several options where one may be chosen', [{ question: 0, options: [0, 1], text: null }], 'mismatch'],
    ['an answer too many', [pick(0), pick(0, 1)], 'mismatch'],
    ['a question named twice', [pick(0), pick(1)], 'mismatch'],
    ['nothing chosen and nothing typed', [{ question: 0, options: [], text: '  ' }], 'incomplete'],
  ])('refuses %s before any write (V35; C45, C78)', async (_name, entries, reason) => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    const before = stored().length;
    expect(await runtime.answer(S(1), card().id, entries)).toEqual({ status: 'refused', reason });
    expect(fake.latest().answered).toEqual([]);
    expect(card().interaction?.outcome).toBe('pending');
    expect(stored().length).toBe(before);
  });

  it('refuses a text for a question that takes none, and takes the option alone (V35; C78)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId, 'request-1', { questions: [{ ...QUESTION, freeText: false }] });
    expect(await runtime.answer(S(1), card().id, [{ question: 0, options: [0], text: 'something else' }])).toEqual({ status: 'refused', reason: 'mismatch' });
    expect(await runtime.answer(S(1), card().id, [pick(0)])).toEqual({ status: 'answered' });
  });

  it('refuses a stale press: a second answer, an unknown card, and a card of another session', async () => {
    place([session(1), session(2)]);
    open();
    const turnId = await running();
    raise(turnId);
    const id = card().id;
    expect(await runtime.answer(S(1), id, [pick(0)])).toEqual({ status: 'answered' });
    expect(await runtime.answer(S(1), id, [pick(1)])).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(await runtime.answer(S(1), 'no-such-card', [pick(0)])).toEqual({ status: 'refused', reason: 'unknown-item' });
    expect(await runtime.answer(S(2), id, [pick(0)])).toEqual({ status: 'refused', reason: 'unknown-item' });
    expect(await runtime.answer(S(9), id, [pick(0)])).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(fake.latest().answered).toHaveLength(1);
    expect(card().interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [0] }] });
  });

  it('keeps a secret’s answer as the fact alone, and gives its text to the session alone (C8, C44)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId, 'request-1', { questions: [{ ...QUESTION, options: [], freeText: false, secret: true }] });
    expect(await runtime.answer(S(1), card().id, [{ question: 0, options: [], text: 'NEEDLE-SECRET hunter2' }])).toEqual({ status: 'answered' });
    expect(fake.latest().answered[0]?.answers).toEqual([{ options: [], text: 'NEEDLE-SECRET hunter2' }]);
    expect(card().interaction).toMatchObject({ kind: 'question', answers: [{ options: [], text: null, secret: true }] });
    conversations.close();
    expect(stored()).not.toContain('NEEDLE-SECRET');
    expect(JSON.stringify(pushes)).not.toContain('NEEDLE-SECRET');
    expect([...log.info.mock.calls, ...log.warn.mock.calls].flat().map(String).join('\n')).not.toContain('NEEDLE-SECRET');
  });
});

describe('a blocking question, withdrawn (V3; C12, C20, C22)', () => {
  it('reads withdrawn by the model where the CLI takes the request back and the turn goes on', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    emit({ type: 'question-resolved', requestId: 'request-1', reason: 'withdrawn' });
    expect(card().interaction).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'request' });
    expect(words()).toBe('Withdrawn: the model went on without an answer');
    expect(summary()).toMatchObject({ status: 'running', attention: null, action: { kind: 'thinking' } });
    // A stale press, and an answer that lost the race (C14).
    expect(await runtime.answer(S(1), card().id, [pick(0)])).toEqual({ status: 'refused', reason: 'not-pending' });
  });

  it('reads withdrawn by its turn’s end where the turn ends with it pending: a Stop’s interrupted end, or any other', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    expect(runtime.stop(S(1))).toEqual({ status: 'stopping' });
    // The Stop leaves the request to the turn's end: the adapter says nothing of it.
    end(turnId, 'interrupted');
    expect(card().interaction).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn' });
    expect(words()).toBe('Withdrawn: the reply ended');
    expect(summary()).toMatchObject({ attention: { kind: 'ready' } });
    expect(fake.latest().answered).toEqual([]);
  });

  it('settles the first to arrive: a withdrawal after an answer changes nothing', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    await runtime.answer(S(1), card().id, [pick(0)]);
    emit({ type: 'question-resolved', requestId: 'request-1', reason: 'withdrawn' });
    expect(card().interaction).toMatchObject({ outcome: 'answered', withdrawnBy: null });
  });

  it('leaves a pending question pending however long it waits: no timeout, no default answer (C9)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    clock.wall += 3_600_000;
    clock.mono += 3_600_000;
    timers.advance(3_600_000);
    expect(card().interaction?.outcome).toBe('pending');
    expect(fake.latest().answered).toEqual([]);
    expect(fake.latest().closes).toBe(0);
  });
});

describe('a loss, a quit and a close (V22, V26, V31; C9, C14, C61, C67, C70, C75)', () => {
  it('reads not answered, never withdrawn, where the process is lost with a question pending: the adapter’s drop comes before its ends', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    // An adapter's own order at its process's end (C67).
    emit({ type: 'question-resolved', requestId: 'request-1', reason: 'dropped' });
    emit({ type: 'notice', turnId, kind: 'connection-lost' });
    end(turnId, 'failed', false);
    fake.latest().end();
    await flush();
    expect(card().interaction).toMatchObject({ outcome: 'dropped', withdrawnBy: null });
    expect(words()).toBe('Not answered: the session’s process ended');
  });

  it('drops first when the handle closes, whatever the adapter said: no end made for the loss withdraws it', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    // The session ends with no word of its own: the runtime makes its turn's end itself.
    fake.latest().end();
    await flush();
    expect(card().interaction?.outcome).toBe('dropped');
    expect(summary()).toMatchObject({ status: 'not-started', attention: { kind: 'error' } });
    void turnId;
  });

  it('drops a pending question before the quit’s Stop, so the Stop’s interrupted end withdraws nothing', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    const stopped = runtime.stopAll();
    expect(fake.latest().stops).toBe(1);
    expect(card().interaction?.outcome).toBe('dropped');
    end(turnId, 'interrupted');
    await stopped;
    expect(words()).toBe('Not answered: the session’s process ended');
  });

  it('drops before the close of a session that is removed, and holds nothing of it after', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    emit({ type: 'worker-started', workerId: 'worker-1', description: 'reads' });
    raise(turnId, 'request-w', { workerId: 'worker-1' });
    const id = card(workerRead('worker-1').items).id;
    // Removed with its project while it waits: dropped before the close, and nothing held after.
    const closesBefore = fake.latest().closes;
    await records.removeSession(S(1));
    expect(fake.latest().closes).toBe(closesBefore + 1);
    expect(conversations.item(S(1), id)?.item.interaction?.outcome).toBe('dropped');
    expect(runtime.requests.pending(S(1), id)).toBe(false);
  });

  it('never relabels an answer written and never confirmed: through its turn’s end and the idle close it reads answered, and after a restart (V26; C70)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    await runtime.answer(S(1), card().id, [pick(0)]);
    // The write went; no confirmation came; the turn ended first.
    end(turnId);
    expect(card().interaction).toMatchObject({ outcome: 'answered', confirmedAt: null });
    timers.advance(IDLE_CLOSE_MS);
    await flush();
    expect(fake.latest().closes).toBe(1);
    expect(card().interaction).toMatchObject({ outcome: 'answered', confirmedAt: null });
    // The card says so once its turn is over: the item's own turn, for a blocking item (C68).
    expect(read().turns.find((turn) => turn.id === card().turnId)?.state).toBe('ended');
    expect(words(card(), true)).toBe('Answered; the model did not confirm it');
    await restart();
    expect(card().interaction).toMatchObject({ outcome: 'answered', confirmedAt: null });
  });

  it('reads not answered where the answer’s write was still queued at the quit: the adapter’s drop finds its item (V31; C75)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    await runtime.answer(S(1), card().id, [pick(0)]);
    const stopped = runtime.stopAll();
    // Answered, and so not dropped by the quit: it waits for its mark, its drop or the close.
    expect(card().interaction?.outcome).toBe('answered');
    // The stop rejected the queued write: the adapter says so, before its own ends.
    emit({ type: 'question-resolved', requestId: 'request-1', reason: 'dropped' });
    end(turnId, 'interrupted');
    await stopped;
    expect(card().interaction).toMatchObject({ outcome: 'dropped' });
    expect(words()).toBe('Not answered: the session’s process ended');
  });

  it('changes nothing for a word that comes after the handle closed: the entry was let go as it was', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    await runtime.answer(S(1), card().id, [pick(0)]);
    const closing = fake.latest();
    end(turnId);
    closing.end();
    await flush();
    emit({ type: 'question-resolved', requestId: 'request-1', reason: 'dropped' }, closing);
    expect(card().interaction?.outcome).toBe('answered');
  });

  it('reads a card an earlier run left pending as not answered, and never answers it (C13, C61)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    const id = card().id;
    // Killed: no end ran, and the stored outcome is still pending.
    await restart();
    expect(card().interaction?.outcome).toBe('dropped');
    expect(words()).toBe('Not answered: the session’s process ended');
    expect(await runtime.answer(S(1), id, [pick(0)])).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(fake.made).toEqual([]);
  });

  it('answers nothing raised on an earlier process of the session', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    const id = card().id;
    const first = fake.latest();
    emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    first.end();
    await flush();
    // Another process, another turn, and the same request id again.
    const next = await running(1, 'Again.');
    expect(fake.made).toHaveLength(2);
    raise(next);
    expect(cards()).toHaveLength(2);
    expect(await runtime.answer(S(1), id, [pick(0)])).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(await runtime.answer(S(1), card().id, [pick(1)])).toEqual({ status: 'answered' });
    expect(first.answered).toEqual([]);
    expect(fake.latest().answered).toEqual([{ requestId: 'request-1', answers: [{ options: [1], text: null }] }]);
  });
});

describe('a worker’s question (V21, V29, V32; C12, C65, C73, C76)', () => {
  async function asked(): Promise<{ turnId: string; id: string }> {
    place([session(1)]);
    open();
    const turnId = await running();
    emit({ type: 'worker-started', workerId: 'worker-1', description: 'reads the notes' });
    raise(turnId, 'request-w', { workerId: 'worker-1' });
    return { turnId, id: card(workerRead('worker-1').items).id };
  }

  it('is the worker’s item: in the worker’s read, named in its push, and listed as waiting in the session’s', async () => {
    const { id } = await asked();
    expect(cards()).toEqual([]);
    expect(read().waiting).toEqual([{ workerId: 'worker-1', itemId: id, kind: 'question' }]);
    expect(pushes.at(-1)).toMatchObject({ workerId: 'worker-1', item: { id, workerId: 'worker-1', interaction: { outcome: 'pending' } } });
    // The attention is the session's; its own line says nothing of a worker's question.
    expect(summary()).toMatchObject({ attention: { kind: 'question', count: 1 }, action: { kind: 'thinking' } });
  });

  it('outlives its turn while the worker runs: pending and answerable after the parent’s end, and withdrawn at the worker’s', async () => {
    const { turnId, id } = await asked();
    end(turnId);
    expect(card(workerRead('worker-1').items).interaction?.outcome).toBe('pending');
    expect(read().waiting).toEqual([{ workerId: 'worker-1', itemId: id, kind: 'question' }]);
    raise(turnId, 'request-w2', { workerId: 'worker-1' });
    expect(read().waiting).toHaveLength(2);
    expect(await runtime.answer(S(1), id, [pick(0)])).toEqual({ status: 'answered' });
    // Two questions of one worker keep its row until both are settled (C73).
    expect(read().waiting.map((entry) => entry.workerId)).toEqual(['worker-1']);
    emit({ type: 'worker-ended', workerId: 'worker-1', outcome: 'completed' });
    expect(read().waiting).toEqual([]);
    expect(cards(workerRead('worker-1').items).map((item) => item.interaction?.outcome)).toEqual(['answered', 'withdrawn']);
    expect(words(card(workerRead('worker-1').items))).toBe('Withdrawn: the reply ended');
  });

  it('shows an answered item answered, and no row for it, between the answer and its mark — and is confirmed after the parent’s end (V32; C76)', async () => {
    const { turnId, id } = await asked();
    end(turnId);
    await runtime.answer(S(1), id, [pick(1)]);
    expect(read().waiting).toEqual([]);
    expect(card(workerRead('worker-1').items).interaction).toMatchObject({ outcome: 'answered', confirmedAt: null });
    emit({ type: 'question-resolved', requestId: 'request-w', reason: 'confirmed' });
    expect(card(workerRead('worker-1').items).interaction?.confirmedAt).toBe(AT);
  });
});

describe('an async question (V7, V24; C26, C33, C41, C68)', () => {
  /** A turn that asked in its message, and ended. */
  async function asked(n = 1, itemId = 'item-q'): Promise<string> {
    const turnId = await running(n);
    emit({ type: 'message', turnId, role: 'assistant', itemId, phase: 'final', text: 'One question before I read.', questions: TITLES });
    // The empty message that follows makes no item (C56).
    emit({ type: 'message', turnId, role: 'assistant', itemId: `${itemId}-trailer`, phase: 'final', text: '' });
    end(turnId);
    return turnId;
  }

  it('is a card written with its message, directly after it, open, with no attention of its own', async () => {
    place([session(1)]);
    open();
    pushes = [];
    await asked();
    const items = read().items;
    expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'interaction']);
    expect(items[2]).toMatchObject({ providerItemId: 'item-q', interaction: { mode: 'async', outcome: 'open', questions: [{ text: 'Which file do you want me to read?', options: [{ label: 'notes-1.txt' }, { label: 'notes-2.txt' }], freeText: true }] } });
    // The message keeps its questions as the conversation text they are (C6).
    expect(items[1]?.questions).toEqual(TITLES);
    expect(summary()?.attention).toMatchObject({ kind: 'ready' });
    expect(pushes.flatMap((push) => ('item' in push ? [push.item.kind] : []))).toEqual(['message', 'message', 'interaction']);
  });

  it('makes no card for a provider that asks none in its messages, nor for a worker’s message', async () => {
    world.questions = 'blocking';
    place([session(1)]);
    open();
    const turnId = await running();
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-q', phase: 'final', text: 'One question.', questions: TITLES });
    expect(cards()).toEqual([]);
    world.questions = 'both';
    emit({ type: 'worker-started', workerId: 'worker-1' });
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-w', phase: 'final', text: 'A worker asks.', questions: TITLES, workerId: 'worker-1' });
    expect(cards(workerRead('worker-1').items)).toEqual([]);
  });

  it('is answered by a prompt in fat-g’s words, a turn as any, the card answered by that turn in the prompt’s own write', async () => {
    place([session(1)]);
    open();
    await asked();
    const id = card().id;
    clock.wall = AT + 9_000;
    expect(await runtime.answer(S(1), id, [pick(1)])).toEqual({ status: 'answered' });
    const sent = fake.latest().sent.at(-1);
    expect(sent).toMatchObject({ prompt: 'Which file do you want me to read?\nnotes-2.txt', effort: 'high' });
    expect(card().interaction).toMatchObject({ outcome: 'answered', answers: [{ options: [1], text: null, secret: false }], answeredBy: sent?.turnId, settledAt: AT + 9_000, confirmedAt: null });
    expect(read().items.at(-1)).toMatchObject({ role: 'user', turnId: sent?.turnId, blocks: [{ text: 'Which file do you want me to read?\nnotes-2.txt' }] });
    expect(summary()).toMatchObject({ status: 'running' });
    // Its mark is its answering turn's acknowledgement (C68).
    clock.wall = AT + 9_400;
    emit({ type: 'turn-started', turnId: sent?.turnId ?? '', providerTurnId: 'p-answer' });
    expect(card().interaction).toMatchObject({ outcome: 'answered', confirmedAt: AT + 9_400 });
  });

  it('leaves the answer unmarked where the process is lost before the acknowledgement, and the same after a restart (V24)', async () => {
    place([session(1)]);
    open();
    await asked();
    emit({ type: 'session-started', reference: 'thread-1', folder: ROOT });
    await runtime.answer(S(1), card().id, [pick(0)]);
    const answering = fake.latest().sent.at(-1)?.turnId ?? '';
    expect(read().turns.find((turn) => turn.id === answering)?.state).toBe('running');
    fake.latest().end();
    await flush();
    expect(card().interaction).toMatchObject({ outcome: 'answered', confirmedAt: null, answeredBy: answering });
    expect(read().turns.find((turn) => turn.id === answering)?.state).toBe('unacknowledged');
    await restart();
    expect(card().interaction).toMatchObject({ outcome: 'answered', confirmedAt: null, answeredBy: answering });
  });

  it('takes an answer to any of its questions, and refuses one that says nothing, one that does not fit, and one past a prompt’s bound', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    const twelve = Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? { title: `${index}: Which file do you want me to read?`, options: ['notes-1.txt', 'notes-2.txt'] } : { title: `${index}: In which form?`, options: ['A summary'] }));
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-q', phase: 'final', text: 'Twelve questions.', questions: twelve });
    end(turnId);
    const id = card().id;
    const nothing = Array.from({ length: 12 }, (_, question): AnswerEntry => ({ question, options: [], text: null }));
    const before = stored().length;
    expect(await runtime.answer(S(1), id, nothing)).toEqual({ status: 'refused', reason: 'incomplete' });
    expect(await runtime.answer(S(1), id, nothing.slice(1))).toEqual({ status: 'refused', reason: 'mismatch' });
    expect(await runtime.answer(S(1), id, nothing.map((entry, index) => (index === 1 ? { ...entry, options: [1] } : entry)))).toEqual({ status: 'refused', reason: 'mismatch' });
    // Twelve answers of 10,000 units pass a prompt's bound: nothing is written or sent (C26).
    expect(12 * MAX_ANSWER_TEXT).toBeGreaterThan(MAX_MESSAGE_TEXT);
    expect(await runtime.answer(S(1), id, nothing.map((entry) => ({ ...entry, text: 'y'.repeat(MAX_ANSWER_TEXT) })))).toEqual({ status: 'refused', reason: 'too-long' });
    expect(stored().length).toBe(before);
    expect(fake.latest().sent).toHaveLength(1);
    expect(card().interaction?.outcome).toBe('open');
    // One answer of the twelve is an answer, and the eleven others say "No answer" (M100b, C30).
    expect(await runtime.answer(S(1), id, nothing.map((entry, index) => (index === 3 ? { ...entry, text: 'the whole text' } : entry)))).toEqual({ status: 'answered' });
    expect(fake.latest().sent.at(-1)?.prompt).toBe(twelve.map((asked, index) => `${asked.title}\n${index === 3 ? 'the whole text' : 'No answer'}`).join('\n\n'));
  });

  it('is refused with the send’s own reasons: while a turn runs, and where the prompt cannot be recorded', async () => {
    place([session(1)]);
    open();
    await asked();
    const id = card().id;
    await running(1, 'Something else first.');
    // That prompt passed the card: answer another, asked while this turn runs.
    expect(card().interaction?.outcome).toBe('passed');
    const turnId = fake.latest().sent.at(-1)?.turnId ?? '';
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-q2', phase: 'commentary', text: 'Another question.', questions: TITLES });
    const second = card().id;
    expect(second).not.toBe(id);
    expect(await runtime.answer(S(1), second, [pick(0)])).toEqual({ status: 'refused', reason: 'running' });
    end(turnId);
    world.storeFault = 'accept';
    expect(await runtime.answer(S(1), second, [pick(0)])).toEqual({ status: 'refused', reason: 'storage-failed' });
    world.storeFault = null;
    expect(card().interaction?.outcome).toBe('open');
    expect(await runtime.answer(S(1), id, [pick(0)])).toEqual({ status: 'refused', reason: 'not-pending' });
  });

  it('passes every other open card at a prompt’s acceptance, an answer’s among them, each pushed (C41)', async () => {
    place([session(1)]);
    open();
    const first = await asked(1, 'item-a');
    void first;
    const turnId = await running(1, 'Go on.');
    expect(cards().map((item) => item.interaction?.outcome)).toEqual(['passed']);
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-b', phase: 'commentary', text: 'A question.', questions: TITLES });
    // A message that is its questions alone: nothing the model wrote goes past the first, which stays open at the end.
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-c', phase: 'final', text: '', questions: TITLES });
    end(turnId);
    expect(cards().map((item) => item.interaction?.outcome)).toEqual(['passed', 'open', 'open']);
    const [, b, c] = cards();
    pushes = [];
    expect(await runtime.answer(S(1), c?.id ?? '', [pick(0)])).toEqual({ status: 'answered' });
    expect(cards().map((item) => item.interaction?.outcome)).toEqual(['passed', 'passed', 'answered']);
    expect(words(cards()[1])).toBe('Passed over: the conversation went on without an answer');
    // The prompt, the card it answered, and the card it passed: each as it now is.
    expect(pushes.flatMap((push) => ('item' in push ? [`${push.item.kind} ${push.item.interaction?.outcome ?? push.item.role}`] : []))).toEqual(['message user', 'interaction answered', 'interaction passed']);
    expect(pushes.find((push) => 'item' in push && push.item.id === b?.id)).toBeDefined();
  });

  // Decision 0026, item 11: Codex's question asked during ongoing work, which its model does not wait on.
  it('is passed at its turn’s end where the model went on past it, pushed so, and stays open where it was the turn’s last word', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-q', phase: 'commentary', text: 'Which file do you want me to read?\n- notes-1.txt\n- notes-2.txt', questions: TITLES });
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-m', phase: 'commentary', text: 'Reading both for now.' });
    // While the turn runs, it waits as any open card does.
    expect(card().interaction?.outcome).toBe('open');
    pushes = [];
    clock.wall = AT + 5_000;
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-f', phase: 'final', text: 'Both notes read.' });
    end(turnId);
    expect(card().interaction).toMatchObject({ outcome: 'passed', settledAt: AT + 5_000, answers: null });
    expect(words()).toBe('Passed over: the conversation went on without an answer');
    expect(pushes.flatMap((push) => ('item' in push && push.item.kind === 'interaction' ? [push.item.interaction?.outcome] : []))).toEqual(['passed']);
    expect(summary()?.attention).toMatchObject({ kind: 'ready' });
    expect(await runtime.answer(S(1), card().id, [pick(0)])).toEqual({ status: 'refused', reason: 'not-pending' });
    // The next turn asks and ends on its question: it waits.
    await asked(1, 'item-r');
    expect(cards().map((item) => item.interaction?.outcome)).toEqual(['passed', 'open']);
  });

  it('is passed by a command fat-g answers itself, as by any prompt: the conversation moved on, and nothing was sent (C83; decision 0023)', async () => {
    world.intercepts = true;
    place([session(1)]);
    open();
    await asked();
    const sent = fake.latest().sent.length;
    expect(await runtime.send(S(1), '/clear')).toEqual({ status: 'accepted' });
    expect(fake.latest().sent).toHaveLength(sent);
    expect(card().interaction).toMatchObject({ outcome: 'passed', answers: null });
    expect(words()).toBe('Passed over: the conversation went on without an answer');
    // And an answer is fat-g's own words, never a command: one whose text would begin as a command is sent as the prompt it is.
    const turnId = await running(1, 'Ask again.');
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-r', phase: 'final', text: 'Again.', questions: [{ title: '/clear the notes?', options: ['Yes', 'No'] }] });
    end(turnId);
    const before = fake.latest().sent.length;
    expect(await runtime.answer(S(1), card().id, [pick(0)])).toEqual({ status: 'answered' });
    expect(fake.latest().sent).toHaveLength(before + 1);
    expect(fake.latest().sent.at(-1)?.prompt).toBe('/clear the notes?\nYes');
  });

  it('is dismissed at the user’s word, the CLI told nothing, and no press settles it twice', async () => {
    place([session(1)]);
    open();
    await asked();
    const id = card().id;
    const sent = fake.latest().sent.length;
    pushes = [];
    expect(runtime.dismiss(S(1), id)).toEqual({ status: 'dismissed' });
    expect(card().interaction).toMatchObject({ outcome: 'dismissed', settledAt: AT });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ item: { id, interaction: { outcome: 'dismissed' } } });
    expect(fake.latest().sent).toHaveLength(sent);
    expect(fake.latest().answered).toEqual([]);
    expect(runtime.dismiss(S(1), id)).toEqual({ status: 'refused', reason: 'not-open' });
    expect(await runtime.answer(S(1), id, [pick(0)])).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(runtime.dismiss(S(1), 'no-such-card')).toEqual({ status: 'refused', reason: 'unknown-item' });
    expect(runtime.dismiss(S(1), read().items[0]?.id ?? '')).toEqual({ status: 'refused', reason: 'unknown-item' });
    expect(runtime.dismiss(S(9), id)).toEqual({ status: 'refused', reason: 'unknown-session' });
  });

  it('never dismisses a blocking card: a request must be replied to (C25)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    expect(runtime.dismiss(S(1), card().id)).toEqual({ status: 'refused', reason: 'not-open' });
    expect(card().interaction?.outcome).toBe('pending');
  });

  it.each(['dismissed', 'passed'] as const)('refuses an answer whose card was %s while its send waited: nothing written, nothing sent, that outcome standing (V33; C77)', async (outcome) => {
    place([session(1)]);
    open();
    await asked();
    const id = card().id;
    const sent = fake.latest().sent.length;
    let release: () => void = () => undefined;
    world.hold = () => new Promise<void>((resolve) => { release = resolve; });
    const answering = runtime.answer(S(1), id, [pick(1)]);
    // While the send waits on its first check, the card is settled another way.
    world.hold = null;
    if (outcome === 'dismissed') expect(runtime.dismiss(S(1), id)).toEqual({ status: 'dismissed' });
    else conversations.setInteraction(S(1), id, 'open', { outcome: 'passed', settledAt: AT });
    const rowsBefore = stored().length;
    release();
    expect(await answering).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(fake.latest().sent).toHaveLength(sent);
    expect(card().interaction).toMatchObject({ outcome, answers: null, answeredBy: null });
    expect(stored().length).toBe(rowsBefore);
    expect(summary()?.status).not.toBe('running');
  });
});
