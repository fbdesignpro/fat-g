// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V7 (docs/planning/_archive/M20b.md; C4, C10, C28–C35, C50, C70, C71, C73): a question asked beside a
// session, through the runtime, on a real records store, a real conversation store, the chat
// service and the session service, with a facet in the test's hands. No Electron, no process. The
// same against the replay fakes is in tests/claude/chat/ and tests/codex/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import { type AsideCapability, type AsideSource, drawnDigest, seedQuestion } from '@shared/contracts/aside';
import type { ChatAsideRead, ChatPush, ChatRead } from '@shared/contracts/chat';
import { type CommandNoticeKind, itemText } from '@shared/contracts/conversation';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { storeFiles } from '../conversations/format';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { createAppStateStore } from '../state/app-state-store';
import { followConversations } from '../state/conversations';
import { type ChatService, createChatService } from './chat-service';
import { createGate } from './gate';
import { createRemoval, type Removal } from './removal';
import { createSessionRuntime, IDLE_CLOSE_MS, pathFrom, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = (n: number) => `a51de000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-01-30T13:00:00.000Z');

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
let removal: Removal;
let fake: FakeFacet;
let timers: ReturnType<typeof manualTimers>;
let ids: number;
let clock: { wall: number; mono: number };
let pushes: ChatPush[];
let detached: () => readonly { readonly id: string }[];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const modelUsed = vi.fn();
const world: { asides: AsideCapability; facetAsides: boolean; intercepts: ((prompt: string) => CommandNoticeKind | null) | undefined; storeFault: string | null } = { asides: { followUp: true, streamed: true, tools: 'read-only' }, facetAsides: true, intercepts: undefined, storeFault: null };

beforeEach(() => {
  modelUsed.mockReset();
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-asides-'));
  ids = 0;
  clock = { wall: AT, mono: 5_000 };
  Object.assign(world, { asides: { followUp: true, streamed: true, tools: 'read-only' }, facetAsides: true, intercepts: undefined, storeFault: null });
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
/** A session the provider holds a conversation of: what an ask needs (C10). */
const started = (n: number, overrides: Record<string, unknown> = {}) => session(n, { reference: `thread-${n}`, folder: ROOT, lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'completed' }, name: 'Earlier', nameSource: 'first-message', ...overrides });
const place = (sessions: unknown[]) => writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [{ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [root] }], sessions }));

function open(): void {
  // A second `open` is a restart, on the same folder.
  runtime?.dispose();
  service?.stop();
  records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', now: () => AT, log });
  const store = createAppStateStore();
  fake = fakeFacet({ history: false, asides: world.facetAsides, ...(world.intercepts === undefined ? {} : { intercepts: world.intercepts }) });
  conversations?.close();
  conversations = createConversationStore({ dir, log, hook: (point) => { if (world.storeFault === point) throw Object.assign(new Error('disk'), { code: 'EIO' }); } });
  timers = manualTimers();
  chat = createChatService({ store: conversations, log, timers });
  pushes = [];
  chat.subscribe((push) => { pushes.push(push); });
  removal = createRemoval({ store: conversations, log });
  const follower = followConversations({ conversations, records, store });
  detached = () => follower.detached();
  let ready = false;
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => false,
    snapshot: () => ({ status: { kind: 'ok' }, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: false, models: true, asides: world.asides, questions: 'none', permissions: null } } }),
    hasRuntime: () => true,
    project: (id) => records.getProject(id),
    isMissing: () => false,
    kept: (id) => (ready ? runtime.kept(id) : undefined),
    platform: 'win32',
  });
  service = createSessionService({
    records, store, now: () => AT, platform: 'win32', log, block: (record, hold) => gate.block(record, hold), onReferenceUnsaved: (id) => runtime.referenceUnsaved(id),
    onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome),
  });
  runtime = createSessionRuntime({
    modelUsed,
    sessions: service, records, chat, gate, timers, log, now: () => clock.wall, monotonic: () => clock.mono, newId: () => `id-${++ids}`,
    facet: () => fake.facet,
    providerName: () => 'Codex',
    hasHistory: () => false,
    asides: () => world.asides,
    store: conversations,
    removal,
  });
  ready = true;
}

const SOURCE: AsideSource = { kind: 'message', itemId: 'item-9', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 4 }, range: { start: 10, end: 31 }, digest: drawnDigest('Biscuit is the cat.\nYes'), excerpt: 'Biscuit is the cat.\nYes', cut: false };
const sessionRead = (n: number): ChatRead => { const answer = runtime.read(S(n)); if (answer.status !== 'read') throw new Error(answer.reason); return answer; };
const asideRead = (n: number, aside: number): ChatAsideRead => { const answer = runtime.readAside(S(n), A(aside)); if (answer.status !== 'read') throw new Error(answer.reason); return answer; };
const texts = (read: { readonly items: ChatRead['items'] }): string[] => read.items.map((item) => `${item.role ?? item.notice ?? item.kind}: ${itemText(item)}`);
/** What the session's process says, as an adapter would. */
const emit = (event: AgentEvent): void => fake.latest().emit(event);
/** An aside's turn answered whole by its provider, as a reply that names its end. */
function answer(aside: number, text: string, extra: { readonly model?: string } = {}): void {
  const asked = fake.latest().asked.findLast((request) => request.asideId === A(aside));
  if (asked === undefined) throw new Error('nothing was asked');
  emit({ type: 'turn-started', turnId: asked.turnId, asideId: asked.asideId, providerTurnId: `p-${asked.turnId}` });
  emit({ type: 'message', turnId: asked.turnId, asideId: asked.asideId, role: 'assistant', itemId: `answer-${asked.turnId}`, phase: 'final', text, ...(extra.model === undefined ? {} : { model: extra.model }) });
  emit({ type: 'turn-ended', turnId: asked.turnId, asideId: asked.asideId, outcome: 'completed', reported: true });
}
const stored = (): string => storeFiles().map((name) => { try { return readFileSync(path.join(dir, name), 'latin1'); } catch { return ''; } }).join('\n');

describe('an ask, before anything is sent (V6; C10, C24, C73)', () => {
  it('is refused for a session the list does not show, a provider that answers no aside, and a session with no conversation yet', async () => {
    place([session(1), started(2)]);
    open();
    expect(await runtime.ask({ sessionId: S(9), asideId: A(1), text: 'Why?' })).toEqual({ status: 'refused', reason: 'unknown-session' });
    // No reference yet: the provider holds nothing to answer against (C10).
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why?' })).toEqual({ status: 'refused', reason: 'no-conversation' });
    world.asides = 'none';
    expect(await runtime.ask({ sessionId: S(2), asideId: A(1), text: 'Why?' })).toEqual({ status: 'refused', reason: 'unsupported' });
    expect(fake.made).toEqual([]);
    expect(conversations.conversations()).toEqual([]);
  });

  it('is refused, with nothing left behind, when the question cannot be recorded', async () => {
    place([started(1)]);
    open();
    world.storeFault = 'accept';
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why?' })).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(fake.made).toEqual([]);
    world.storeFault = null;
    expect(conversations.aside(A(1))).toBeNull();
    expect(sessionRead(1).asides).toEqual([]);
    expect(modelUsed).not.toHaveBeenCalled();
  });

  it('starts the session’s process through the gate, resumed, with no turn of the session’s (C10)', async () => {
    place([started(1)]);
    open();
    const before = service.snapshot().sessions[0]?.summary;
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why is it called that?' })).toEqual({ status: 'accepted', asideId: A(1) });
    expect(modelUsed.mock.calls).toEqual([[{ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null }]]);
    expect(fake.made).toHaveLength(1);
    expect(fake.latest()).toMatchObject({ kind: 'resume', options: { reference: 'thread-1', folder: ROOT } });
    expect(fake.latest().sent).toEqual([]);
    // The ask: the aside's id, a turn and a message of its own, the text as typed, no history yet, and the session's effort.
    expect(fake.latest().asked).toEqual([{ asideId: A(1), turnId: 'id-1', text: 'Why is it called that?', messageId: 'id-2', history: [], throughTurn: null, effort: 'high', speed: null }]);
    // Nothing of it is the session's: not running, no turn of its own, no action line (C4).
    expect(service.isRunning(S(1))).toBe(false);
    expect(service.snapshot().sessions[0]?.summary).toEqual(before);
  });
});

it('records the requested tier on side questions without borrowing later session settings', async () => {
  place([started(1, { speed: 'priority' })]);
  open();
  expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why?' })).toEqual({ status: 'accepted', asideId: A(1) });
  await service.setSpeed(S(1), null);
  expect(conversations.newestPage(A(1)).turns[0]?.speed).toEqual({ id: 'priority', name: 'priority' });
});

describe('an aside’s conversation (V6, V7; C28–C31, C33, C73)', () => {
  it('records the question before anything is sent, and keeps its answer under the aside alone, with the model that wrote it', async () => {
    place([started(1)]);
    open();
    const before = service.snapshot().sessions[0]?.summary;
    fake.onSend = () => { throw new Error('no prompt is sent for an ask'); };
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why is it called that?' });
    // Recorded, and running, before its provider has said anything.
    expect(texts(asideRead(1, 1))).toEqual(['user: Why is it called that?']);
    expect(asideRead(1, 1).aside).toEqual({ id: A(1), title: 'Why is it called that?', source: null, createdAt: AT, running: true });
    expect(asideRead(1, 1).turns).toMatchObject([{ state: 'running' }]);
    clock.mono += 1_250;
    answer(1, 'After the keeper’s cat.', { model: 'another-model' });
    const read = asideRead(1, 1);
    expect(texts(read)).toEqual(['user: Why is it called that?', 'assistant: After the keeper’s cat.']);
    expect(read.items[1]).toMatchObject({ model: 'another-model', phase: 'final', state: 'complete' });
    expect(read.items[0]).toMatchObject({ model: null });
    // The provider's end and the aside's own, kept apart, with its measured time (C34).
    expect(read.turns).toMatchObject([{ state: 'ended', outcome: 'completed', time: { elapsedMs: 1_250 } }]);
    expect(conversations.turn(A(1), 'id-1')).toMatchObject({ providerOutcome: 'completed', sessionOutcome: 'completed', providerTurnId: 'p-id-1' });
    expect(read.aside.running).toBe(false);
    // The session's own chat holds none of it, and lists it as a marker with no text (C30).
    expect(sessionRead(1).items).toEqual([]);
    expect(sessionRead(1).asides).toEqual([{ id: A(1), title: 'Why is it called that?', source: null, createdAt: AT, running: false }]);
    expect(conversations.conversation(A(1))).toMatchObject({ parentId: S(1), reference: null });
    // And nothing of it reached the summary or the record (C4, C33).
    expect(service.snapshot().sessions[0]?.summary).toEqual(before);
    expect(JSON.stringify(service.snapshot())).not.toContain('keeper');
    expect(readFileSync(path.join(dir, RECORDS_FILE), 'utf8')).not.toContain('keeper');
  });

  it('pushes an aside’s items under its session’s id and revision, each naming the aside, and tells the session when its list changed', async () => {
    place([started(1)]);
    open();
    const before = sessionRead(1).revision;
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why?' });
    answer(1, 'Because.');
    // Every push is the session's: one revision above the last, whatever it carries.
    expect(pushes.map((push) => push.sessionId)).toEqual(pushes.map(() => S(1)));
    expect(pushes.map((push) => push.revision)).toEqual(pushes.map((_, index) => before + index + 1));
    const items = pushes.flatMap((push) => ('item' in push ? [push] : []));
    expect(items.map((push) => [push.asideId, itemText(push.item)])).toEqual([[A(1), 'Why?'], [A(1), 'Because.']]);
    // A change that names no aside is the session's own: its list of asides, at the ask and at the end.
    expect(pushes.filter((push) => 'changed' in push && push.asideId === undefined)).toHaveLength(2);
    expect(sessionRead(1).revision).toBe(pushes.at(-1)?.revision);
    expect(asideRead(1, 1).revision).toBe(sessionRead(1).revision);
  });

  it('writes fat-g’s question around a selection, titles the aside by it, and keeps the excerpt with the aside alone (C29, C51)', async () => {
    place([started(1)]);
    open();
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), source: SOURCE })).toEqual({ status: 'accepted', asideId: A(1) });
    const question = seedQuestion('your earlier answer', SOURCE.excerpt);
    expect(fake.latest().asked[0]?.text).toBe(question);
    expect(question).toContain('> Biscuit is the cat.\n> Yes');
    expect(texts(asideRead(1, 1))).toEqual([`user: ${question}`]);
    expect(asideRead(1, 1).aside).toMatchObject({ title: 'Explained: Biscuit is the cat.', source: SOURCE });
    // The marker carries where it lay, its offsets and its digest, and no text (C30, C75).
    const { excerpt: _excerpt, cut: _cut, ...ref } = SOURCE;
    expect(sessionRead(1).asides).toEqual([{ id: A(1), title: 'Explained: Biscuit is the cat.', source: ref, createdAt: AT, running: true }]);
    expect(JSON.stringify(sessionRead(1))).not.toContain('Biscuit is the cat.\\nYes');
  });

  it('names a file by its path from the session’s folder, with its lines', async () => {
    place([started(1)]);
    open();
    const file: AsideSource = { ...SOURCE, kind: 'file', itemId: null, role: null, path: `${ROOT}\\src\\tides.js`, lines: { first: 12, last: 14 } };
    await runtime.ask({ sessionId: S(1), asideId: A(1), source: file });
    expect(fake.latest().asked[0]?.text).toContain('about a passage in the file src/tides.js, lines 12–14.');
    expect(pathFrom(ROOT, 'D:\\code\\FAT-G\\README.md')).toBe('README.md');
    expect(pathFrom(ROOT, 'D:\\Elsewhere\\notes.md')).toBe('D:\\Elsewhere\\notes.md');
    expect(pathFrom('/home/u/app', '/home/u/app/src/a.ts')).toBe('src/a.ts');
    expect(pathFrom('/home/u/app', '/home/u/application/a.ts')).toBe('/home/u/application/a.ts');
  });

  it('reopens the aside of the same selection and sends nothing; another range, or the same lines with another text, starts another (C50)', async () => {
    place([started(2), started(1)]);
    open();
    await runtime.ask({ sessionId: S(1), asideId: A(1), source: SOURCE });
    await service.settled();
    expect(service.snapshot().sessions.map((item) => item.record.id)).toEqual([S(1), S(2)]);
    answer(1, 'It is the cat’s name.');
    await service.move(S(1), null, { list: 'active', starred: false });
    const asked = fake.latest().asked.length;
    // The same source, lines and text, under another id the page made: the existing aside's id comes back.
    expect(await runtime.ask({ sessionId: S(1), asideId: A(2), source: { ...SOURCE, range: { start: 40, end: 61 } } })).toEqual({ status: 'accepted', asideId: A(1) });
    expect(fake.latest().asked).toHaveLength(asked);
    expect(conversations.aside(A(2))).toBeNull();
    await service.settled();
    expect(service.snapshot().sessions.map((item) => item.record.id)).toEqual([S(2), S(1)]);
    // Another sentence of the same lines, and the same lines whose text has changed, are other selections.
    expect(await runtime.ask({ sessionId: S(1), asideId: A(2), source: { ...SOURCE, excerpt: 'Yes' } })).toEqual({ status: 'accepted', asideId: A(2) });
    expect(await runtime.ask({ sessionId: S(1), asideId: A(3), source: { ...SOURCE, lines: { first: 5, last: 5 } } })).toEqual({ status: 'accepted', asideId: A(3) });
    expect(sessionRead(1).asides.map((aside) => aside.id)).toEqual([A(1), A(2), A(3)]);
    // A free question always starts a new one.
    await runtime.ask({ sessionId: S(1), asideId: A(4), text: SOURCE.excerpt });
    await runtime.ask({ sessionId: S(1), asideId: A(5), text: SOURCE.excerpt });
    expect(sessionRead(1).asides).toHaveLength(5);
  });

  it('sends a follow-up with the aside’s earlier exchanges, and takes one question of an aside at a time', async () => {
    place([started(1), started(2)]);
    open();
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'First?' });
    // While its turn runs, the same aside takes no second question; another aside does (C9).
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Second?' })).toEqual({ status: 'refused', reason: 'aside-running' });
    expect(await runtime.ask({ sessionId: S(1), asideId: A(2), text: 'Elsewhere?' })).toEqual({ status: 'accepted', asideId: A(2) });
    answer(1, 'One.');
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Second?' })).toEqual({ status: 'accepted', asideId: A(1) });
    expect(fake.latest().asked.at(-1)).toMatchObject({ asideId: A(1), text: 'Second?', history: [{ question: 'First?', response: 'One.' }] });
    answer(1, 'Two.');
    expect(texts(asideRead(1, 1))).toEqual(['user: First?', 'assistant: One.', 'user: Second?', 'assistant: Two.']);
    // An id that is another session's aside is none of this one's.
    expect(await runtime.ask({ sessionId: S(2), asideId: A(1), text: 'Mine?' })).toEqual({ status: 'refused', reason: 'unknown-aside' });
    expect(runtime.readAside(S(2), A(1))).toEqual({ status: 'refused', reason: 'unknown-aside' });
  });

  it('hands over the provider’s id of the session’s newest turn whose end the provider reported, never one in flight (C19)', async () => {
    place([started(1)]);
    open();
    expect(await runtime.send(S(1), 'Read the file.')).toEqual({ status: 'accepted' });
    const first = fake.latest().sent[0];
    emit({ type: 'turn-started', turnId: first?.turnId ?? '', providerTurnId: 'codex-turn-1' });
    // Its first turn runs: no turn has an end the provider reported.
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'During?' });
    expect(fake.latest().asked.at(-1)).toMatchObject({ throughTurn: null });
    emit({ type: 'turn-ended', turnId: first?.turnId ?? '', outcome: 'interrupted', reported: true });
    // An interrupted end is an end the provider reported.
    await runtime.ask({ sessionId: S(1), asideId: A(2), text: 'After?' });
    expect(fake.latest().asked.at(-1)).toMatchObject({ throughTurn: 'codex-turn-1' });
    expect(await runtime.send(S(1), 'Again.')).toEqual({ status: 'accepted' });
    emit({ type: 'turn-started', turnId: fake.latest().sent[1]?.turnId ?? '', providerTurnId: 'codex-turn-2' });
    await runtime.ask({ sessionId: S(1), asideId: A(3), text: 'Now?' });
    expect(fake.latest().asked.at(-1)).toMatchObject({ throughTurn: 'codex-turn-1' });
  });
});

describe('a session’s turn and its asides, together (V6; C4, C9, C10, C34)', () => {
  it('neither blocks the other, and the session’s status follows its own turn alone', async () => {
    place([started(1)]);
    open();
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Beside?' });
    // A turn is sent while the aside runs, on the same process.
    expect(await runtime.send(S(1), 'Go on.')).toEqual({ status: 'accepted' });
    expect(fake.made).toHaveLength(1);
    // And an ask is taken while the turn runs.
    expect(await runtime.ask({ sessionId: S(1), asideId: A(2), text: 'Also?' })).toEqual({ status: 'accepted', asideId: A(2) });
    const turn = fake.latest().sent[0];
    emit({ type: 'message', turnId: turn?.turnId ?? '', role: 'assistant', itemId: 'm1', phase: 'final', text: 'Done.' });
    answer(1, 'Yes.');
    expect(service.isRunning(S(1))).toBe(true);
    emit({ type: 'turn-ended', turnId: turn?.turnId ?? '', outcome: 'completed', reported: true });
    expect(service.isRunning(S(1))).toBe(false);
    // The session's chat holds its own turn; each aside its own.
    expect(texts(sessionRead(1))).toEqual(['user: Go on.', 'assistant: Done.']);
    expect(texts(asideRead(1, 1))).toEqual(['user: Beside?', 'assistant: Yes.']);
    expect(sessionRead(1).asides.map((aside) => aside.running)).toEqual([false, true]);
  });

  it('holds the idle clock for an aside as for a turn, and starts it when the last of both has ended', async () => {
    place([started(1)]);
    open();
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Beside?' });
    const made = fake.latest();
    timers.advance(IDLE_CLOSE_MS * 2);
    expect(made.closes).toBe(0);
    expect(runtime.runningOn({ providerId: 'codex', instanceId: 'default' })).toBe(true);
    answer(1, 'Yes.');
    expect(runtime.runningOn({ providerId: 'codex', instanceId: 'default' })).toBe(false);
    timers.advance(IDLE_CLOSE_MS - 1);
    expect(made.closes).toBe(0);
    timers.advance(1);
    expect(made.closes).toBe(1);
  });

  it('stops an aside by its own Stop, never the session’s (C12, C70)', async () => {
    place([started(1)]);
    open();
    expect(runtime.stopAside(S(1), A(1))).toEqual({ status: 'refused', reason: 'not-running' });
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Long?' });
    expect(runtime.stopAside(S(1), A(1))).toEqual({ status: 'stopping' });
    expect(fake.latest().asideStops).toEqual([A(1)]);
    expect(fake.latest().stops).toBe(0);
    const asked = fake.latest().asked[0];
    emit({ type: 'turn-started', turnId: asked?.turnId ?? '', asideId: A(1) });
    // The adapter's own end of a Stop its provider did not confirm: the aside's end alone (C70).
    emit({ type: 'notice', kind: 'stop-unconfirmed', turnId: asked?.turnId ?? '', asideId: A(1) });
    emit({ type: 'turn-ended', turnId: asked?.turnId ?? '', asideId: A(1), outcome: 'interrupted', reported: false });
    const read = asideRead(1, 1);
    expect(read.items.at(-1)).toMatchObject({ notice: 'stop-unconfirmed' });
    // The words are an aside's: nothing says a process was ended.
    expect(itemText(read.items.at(-1) as ChatRead['items'][number])).toBe('Codex did not confirm the stop. This question was ended here; the session goes on.');
    expect(read.turns).toMatchObject([{ state: 'unfinished', outcome: 'interrupted' }]);
    expect(fake.latest().ended).toBe(false);
  });

  it('ends an open aside’s turn when the process is lost, and at a quit, as a session’s is ended: its message partial, its activity unfinished', async () => {
    place([started(1), started(2)]);
    open();
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Lost?' });
    const lost = fake.latest();
    const asked = lost.asked[0];
    emit({ type: 'turn-started', turnId: asked?.turnId ?? '', asideId: A(1) });
    emit({ type: 'activity-started', turnId: asked?.turnId ?? '', asideId: A(1), itemId: 'read-1', activityType: 'read', name: 'read', summary: 'notes.txt' });
    emit({ type: 'message-delta', turnId: asked?.turnId ?? '', asideId: A(1), itemId: 'm1', phase: 'final', text: 'Half an ans' });
    lost.end({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    const read = asideRead(1, 1);
    expect(read.items.map((item) => [item.kind, item.state])).toEqual([['message', 'complete'], ['activity', 'partial'], ['message', 'partial']]);
    expect(read.items[1]).toMatchObject({ activity: { status: 'unfinished' } });
    expect(read.turns).toMatchObject([{ state: 'unfinished', outcome: 'failed' }]);
    expect(sessionRead(1).asides[0]).toMatchObject({ running: false });

    await runtime.ask({ sessionId: S(2), asideId: A(2), text: 'Quit?' });
    const quit = fake.latest();
    const stopping = runtime.stopAll(0);
    // The wait for the Stops is over at once: nothing confirmed this one.
    timers.advance(0);
    await stopping;
    // Stopped by its own Stop, and written as stopped where that was not confirmed in time.
    expect(quit.asideStops).toEqual([A(2)]);
    expect(quit.stops).toBe(0);
    expect(conversations.turn(A(2), quit.asked[0]?.turnId ?? '')).toMatchObject({ sessionOutcome: 'stopped', providerOutcome: null });
    expect(await runtime.ask({ sessionId: S(2), asideId: A(3), text: 'After?' })).toEqual({ status: 'refused', reason: 'busy' });
  });
});

describe('removal (V6; C32, C42, C71)', () => {
  it('removes an aside with everything the store holds of it, stopping a turn of it first, and leaves no text', async () => {
    place([started(1)]);
    open();
    await runtime.ask({ sessionId: S(1), asideId: A(1), source: { ...SOURCE, excerpt: 'ZEBRA-EXCERPT' } });
    answer(1, 'ZEBRA-ANSWER');
    await runtime.ask({ sessionId: S(1), asideId: A(2), text: 'ZEBRA-QUESTION' });
    expect(stored()).toContain('ZEBRA-EXCERPT');
    expect(runtime.removeAside(S(1), A(9))).toEqual({ status: 'refused', reason: 'unknown-aside' });
    // A running one is stopped, then removed.
    expect(runtime.removeAside(S(1), A(2))).toEqual({ status: 'removed' });
    expect(fake.latest().asideStops).toEqual([A(2)]);
    expect(runtime.removeAside(S(1), A(1))).toEqual({ status: 'removed' });
    expect(sessionRead(1).asides).toEqual([]);
    expect(conversations.conversations()).toEqual([]);
    expect(runtime.readAside(S(1), A(1))).toEqual({ status: 'refused', reason: 'unknown-aside' });
    for (const text of ['ZEBRA-EXCERPT', 'ZEBRA-ANSWER', 'ZEBRA-QUESTION']) expect(stored()).not.toContain(text);
    // What still comes of a removed aside's turn finds no aside.
    const late = fake.latest().asked.at(-1);
    emit({ type: 'message', turnId: late?.turnId ?? '', asideId: A(2), role: 'assistant', itemId: 'late', phase: 'final', text: 'ZEBRA-LATE' });
    expect(stored()).not.toContain('ZEBRA-LATE');
  });

  it('takes a session’s asides with the session, and never counts one as a chat without a session by itself', async () => {
    place([started(1), started(2)]);
    open();
    await runtime.send(S(1), 'ZEBRA-PROMPT');
    emit({ type: 'turn-ended', turnId: fake.latest().sent[0]?.turnId ?? '', outcome: 'completed', reported: true });
    await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'ZEBRA-ONE' });
    answer(1, 'ZEBRA-TWO');
    await runtime.ask({ sessionId: S(2), asideId: A(2), text: 'Kept?' });
    answer(2, 'Kept.');
    expect(detached()).toEqual([]);
    // The record is gone at the next launch: its chat is detached, with its aside, as one.
    await service.settled();
    place([started(2)]);
    open();
    expect(detached().map((entry) => entry.id)).toEqual([S(1)]);
    expect(conversations.textUnits([S(1)])).toBeGreaterThan(conversations.textUnits([A(1)]));
    // It returns: its aside is listed under it again.
    await service.settled();
    place([started(1), started(2)]);
    open();
    expect(detached()).toEqual([]);
    expect(sessionRead(1).asides.map((aside) => aside.id)).toEqual([A(1)]);
    // The session's removal takes its aside's rows, and nothing of the other session's.
    await removal.run([S(1)], () => service.remove(S(1)), (result) => result.status === 'saved');
    expect(conversations.conversations().map((entry) => [entry.id, entry.parentId])).toEqual([[A(2), S(2)]]);
    for (const text of ['ZEBRA-PROMPT', 'ZEBRA-ONE', 'ZEBRA-TWO']) expect(stored()).not.toContain(text);
    expect(texts(asideRead(2, 2))).toEqual(['user: Kept?', 'assistant: Kept.']);
    // A session that was asked beside and never prompted has asides and no conversation of its own: its removal takes them all the same.
    await removal.run([S(2)], () => service.remove(S(2)), (result) => result.status === 'saved');
    expect(conversations.conversations()).toEqual([]);
    expect(stored()).not.toContain('Kept');
  });
});

describe('a command fat-g answers itself (V6; C35, C55)', () => {
  it('is a turn of the session’s that is never sent: the prompt, fat-g’s notice, and an end that is its own', async () => {
    world.intercepts = (prompt) => (prompt.startsWith('/clear') ? 'command-clear' : null);
    place([started(1)]);
    open();
    expect(await runtime.send(S(1), '/clear')).toEqual({ status: 'accepted' });
    // No process was started for it, and nothing was sent.
    expect(fake.made).toEqual([]);
    const read = sessionRead(1);
    expect(texts(read)).toEqual(['user: /clear', 'command-clear: fat-g did not send /clear to Codex. A session in fat-g keeps one conversation: for another, start a new session, or pick one from fat-g’s list.']);
    // Completed, as fat-g's own end: no provider confirmed it, and none is said to have failed to (C35).
    expect(read.turns).toMatchObject([{ state: 'ended', outcome: 'completed' }]);
    expect(conversations.turn(S(1), read.turns[0]?.id ?? '')).toMatchObject({ own: true, providerOutcome: null, providerTook: false, sessionOutcome: 'completed' });
    expect(service.isRunning(S(1))).toBe(false);
    await service.settled();
    // The next prompt is sent as any is.
    expect(await runtime.send(S(1), 'Say /clear twice.')).toEqual({ status: 'accepted' });
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['Say /clear twice.']);
  });
});
