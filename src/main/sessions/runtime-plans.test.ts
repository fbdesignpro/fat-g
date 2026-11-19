// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4 (docs/planning/_archive/M22b.md, Design 6; C1–C3, C5, C10–C13, C15, C19, C27, C55, C56, C58, C59, C64,
// C65, C69, C72–C74, C76, C78): plans through the runtime, on a real records store, a real
// conversation store, a real plan store, the chat service, the session service, the request
// registry and the plan service, with a facet in the test's hands. No Electron, no process. The
// same against the replay fakes is in tests/claude/chat/plan.integration.test.ts and
// tests/codex/plan.integration.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { ChatRead } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type PlanBody, planOf } from '@shared/contracts/interaction';
import type { ModeAvailability, PermissionCapability } from '@shared/contracts/permissions';
import { type PlanAvailability, type PlanCapability, type PlanPush, PLAN_WORDS, readPlanBlock } from '@shared/contracts/plans';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { createPlanStore, type PlanStore } from '../plans/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { type AppStateStore, createAppStateStore } from '../state/app-state-store';
import { type ChatService, createChatService } from './chat-service';
import { createGate } from './gate';
import { createPermissions } from './permissions';
import { createPlanService, type PlanService } from './plans';
import { createRemoval } from './removal';
import { createSessionRuntime, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet, type FakeSession } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const OTHER_PROJECT = '7b2a9c11-1c4d-4e8f-9a0b-3c5d7e9f1a2b';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-02-08T13:00:00.000Z');
const TOKEN = 'abcdef012345';

const mode = (id: string, label: string, patch: Partial<PermissionCapability['modes'][number]> = {}) => ({ id, label, description: `What ${label} lets run.`, asks: true, reading: false, transitionsFrom: [], ...patch });
const CAPABILITY: PermissionCapability = {
  modes: [mode('read-only', 'Read only', { asks: false, reading: true }), mode('ask-first', 'Ask first'), mode('edits-ok', 'Edits ok')],
  fallback: 'ask-first',
  setup: { changes: 'The setup changes the machine.', approval: 'The system asks for leave.', waiting: 'The system may be asking.' },
  inherited: 'Rules of your own configuration act as it lets them.',
  rules: 'This CLI lists no rules.',
};
const PLANS: PlanCapability = { modes: ['ask-first', 'edits-ok'], unavailable: 'Read only takes no plan turn.' };
const available = (id: string): ModeAvailability => ({ id, available: true, reason: null, setup: false, records: false, unconfined: false, places: null });

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
let planStore: PlanStore;
let plans: PlanService;
let appState: AppStateStore;
let fake: FakeFacet;
let ids: number;
let clock: { wall: number; mono: number };
let planPushes: PlanPush[];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const modelUsed = vi.fn();
const world: { availability: PlanAvailability; userDefault: string | null } = { availability: { available: true }, userDefault: null };

beforeEach(() => {
  modelUsed.mockReset();
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-plans-'));
  ids = 0;
  clock = { wall: AT, mono: 5_000 };
  Object.assign(world, { availability: { available: true }, userDefault: null });
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
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: `Chat ${n}`, nameSource: 'user',
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null, ...overrides,
});
const project = (id: string) => ({ id, name: `p-${id.slice(0, 4)}`, color: 'teal', hidden: false, providers: ['codex'], roots: [{ ...root, path: id === PROJECT ? ROOT : 'D:\\Code\\other' }], permissionModes: {} });
const place = (sessions: unknown[]) => writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [project(PROJECT), project(OTHER_PROJECT)], sessions }));

function open(): void {
  // A second `open` is a restart, on the same folder.
  runtime?.dispose();
  service?.stop();
  records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', now: () => AT, log });
  appState = createAppStateStore();
  fake = fakeFacet({ history: false, plans: { availability: () => world.availability }, permissions: { modes: () => CAPABILITY.modes.map((entry) => available(entry.id)) } });
  conversations?.close();
  conversations = createConversationStore({ dir, log, now: () => clock.wall });
  // As main does at launch: what a crash left is finished, and a line left being written is unfinished.
  planStore = createPlanStore({ dir: path.join(dir, 'plans'), now: () => clock.wall, log });
  planStore.recover(new Set([PROJECT, OTHER_PROJECT]));
  conversations.unfinishPlans(clock.wall);
  const timers = manualTimers();
  let ready = false;
  chat = createChatService({
    store: conversations, log, timers, now: () => clock.wall,
    requests: { pending: (sessionId, itemId) => ready && runtime.requests.pending(sessionId, itemId), waiting: (sessionId) => (ready ? runtime.requests.waiting(sessionId) : []), view: (sessionId, itemId) => (ready ? runtime.requests.view(sessionId, itemId) : null) },
    processKey: (sessionId) => (ready ? runtime.processKey(sessionId) : null),
  });
  planPushes = [];
  plans = createPlanService({
    store: planStore, conversations, chat, record: (id) => records.getSession(id), chatName: (id) => records.getSession(id)?.name ?? null,
    requestPending: (sessionId, itemId) => ready && runtime.requests.pending(sessionId, itemId), push: (push) => { planPushes.push(push); }, now: () => clock.wall, token: () => TOKEN, log,
  });
  const removal = createRemoval({ store: conversations, log });
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => false,
    snapshot: () => ({ status: { kind: 'ok' }, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: false, models: true, asides: 'none', questions: 'both', permissions: CAPABILITY, plans: PLANS } } }),
    hasRuntime: () => true,
    project: (id) => records.getProject(id),
    isMissing: () => false,
    kept: (id) => (ready ? runtime.kept(id) : undefined),
    modeBlock: (record) => (ready ? runtime.modeBlock(record) : null),
    platform: 'win32',
  });
  service = createSessionService({
    records, store: appState, now: () => AT, platform: 'win32', log, block: (record, hold) => gate.block(record, hold), onReferenceUnsaved: (id) => runtime.referenceUnsaved(id),
    onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome),
    mode: (record) => (ready ? runtime.chatMode(record) : null),
    changingMode: (id) => ready && runtime.changingMode(id),
    planPending: (id) => ready && runtime.planPending(id),
  });
  const permissions = createPermissions({
    capability: () => CAPABILITY,
    userDefault: () => world.userDefault,
    projectDefault: () => null,
    availability: () => CAPABILITY.modes.map((entry) => available(entry.id)),
  });
  runtime = createSessionRuntime({
    modelUsed,
    sessions: service, records, chat, gate, timers, log, now: () => clock.wall, monotonic: () => clock.mono, newId: () => `id-${++ids}`,
    facet: () => fake.facet,
    providerName: () => 'Codex',
    hasHistory: () => false,
    questions: () => 'both',
    store: conversations,
    removal,
    permissions,
    plans,
    planCapability: () => PLANS,
  });
  ready = true;
  service.availabilityChanged();
}

const read = (n = 1): ChatRead => { const answer = runtime.read(S(n)); if (answer.status !== 'read') throw new Error(answer.reason); return answer; };
const lines = (n = 1): ConversationItem[] => read(n).items.filter((item) => planOf(item) !== null);
const line = (n = 1): ConversationItem => { const found = lines(n).at(-1); if (found === undefined) throw new Error('no plan line'); return found; };
const body = (item: ConversationItem = line()): PlanBody => planOf(item) as PlanBody;
const entry = (n = 1) => service.snapshot().sessions.find((candidate) => candidate.record.id === S(n));
const summary = (n = 1) => entry(n)?.summary;
const emit = (event: AgentEvent, from: FakeSession = fake.latest()): void => from.emit(event);
const notices = (n = 1): (string | null)[] => read(n).items.filter((item) => item.kind === 'notice').map((item) => item.notice);
const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };
async function restart(): Promise<void> {
  await service.settled();
  conversations.close();
  open();
}

/** A turn of the session's that runs: sent, taken, its process confirming the mode it was opened under. */
async function running(n = 1, prompt = 'Make a plan.', plan = true): Promise<string> {
  expect(await runtime.send(S(n), prompt, plan ? { plan: true } : undefined)).toEqual({ status: 'accepted' });
  return started(n);
}
/** The turn just sent, taken by the provider. */
function started(n = 1): string {
  const made = fake.latest();
  const turnId = made.sent.at(-1)?.turnId ?? '';
  if (made.options.mode !== null) emit({ type: 'in-force', turnId, mode: made.options.mode });
  emit({ type: 'session-started', reference: `thread-${n}`, folder: ROOT });
  emit({ type: 'turn-started', turnId, providerTurnId: `p-${turnId}` });
  return turnId;
}
const end = (turnId: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed'): void => { emit({ type: 'turn-ended', turnId, outcome, reported: true }); };
/** A plan streamed as Codex streams one: opened empty, two deltas, and its whole text. */
function writePlan(turnId: string, itemId = 'plan_item', text = '# Tidy the notes\n\n1. Read them.\n2. Tidy them.'): void {
  emit({ type: 'plan-delta', turnId, itemId, text: '' });
  emit({ type: 'plan-delta', turnId, itemId, text: text.slice(0, 10) });
  emit({ type: 'plan-delta', turnId, itemId, text: text.slice(10) });
  emit({ type: 'plan-completed', turnId, itemId, text });
}
/** A plan turn whose plan waits for its decision: the plan written, the turn ended. */
async function planned(n = 1): Promise<string> {
  const turnId = await running(n);
  writePlan(turnId);
  end(turnId);
  await flush();
  return turnId;
}
const lastSent = () => fake.latest().sent.at(-1);

describe('a plan turn (V4; C1–C3, C5)', () => {
  it('is a prompt with the turn’s flag and no notice, sent with `plan`; the chat’s mode is not changed for it', async () => {
    place([session(1)]);
    open();
    await running();
    expect(lastSent()).toMatchObject({ prompt: 'Make a plan.', plan: true });
    expect(modelUsed.mock.calls).toEqual([[{ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null }]]);
    expect(lastSent()?.plannedBefore).toBeUndefined();
    const turnId = lastSent()?.turnId ?? '';
    expect(conversations.turn(S(1), turnId)).toMatchObject({ plan: true, mode: 'ask-first' });
    expect(notices()).toEqual([]);
    expect(entry()?.mode).toMatchObject({ id: 'ask-first' });
  });

  it('is refused where the chat’s mode takes no plan turn, or the account’s CLI refused one, and nothing is written', async () => {
    place([session(1)]);
    open();
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'set' });
    expect(await runtime.send(S(1), 'Plan it.', { plan: true })).toEqual({ status: 'refused', reason: 'plans-unavailable' });
    expect(await runtime.setMode(S(1), 'edits-ok')).toEqual({ status: 'set' });
    world.availability = { available: false, reason: 'cli-refuses' };
    expect(await runtime.send(S(1), 'Plan it.', { plan: true })).toEqual({ status: 'refused', reason: 'plans-unavailable' });
    expect(fake.made).toEqual([]);
    expect(read().items).toEqual([]);
    expect(modelUsed).not.toHaveBeenCalled();
  });
});

describe('a Codex plan: no request holds it (V4; C14, C27, C56, C58, C59, C74)', () => {
  it('opens a line `writing` at its first delta, streams the draft to the tab, and waits `pending` from its completion', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    emit({ type: 'plan-delta', turnId, itemId: 'plan_item', text: '' });
    expect(body()).toMatchObject({ outcome: 'writing', came: 'made', request: false, version: 1 });
    emit({ type: 'plan-delta', turnId, itemId: 'plan_item', text: '# Tidy' });
    expect(planPushes.at(-1)).toMatchObject({ state: 'drafting', partial: { before: 0, append: '# Tidy' } });
    emit({ type: 'plan-completed', turnId, itemId: 'plan_item', text: '# Tidy the notes' });
    expect(body()).toMatchObject({ outcome: 'pending' });
    const plan = planStore.get(body().planId);
    expect(plan).toMatchObject({ projectId: PROJECT, title: 'Tidy the notes', versions: [{ version: 1, state: 'complete', cause: 'plan-turn', sessionId: S(1), turnId }] });
    // While its turn runs, the attention waits for the turn's end, which reads PLAN READY.
    expect(summary()?.attention).toBeNull();
    end(turnId);
    expect(summary()?.attention).toMatchObject({ kind: 'plan', count: 1 });
    await service.select(S(1));
    service.acknowledge(S(1));
    expect(summary()?.attention).toEqual({ kind: 'plan', count: 1, acknowledged: false });
    expect(entry()?.planPending).toBe(true);
    expect(runtime.planPending(S(1))).toBe(true);
  });

  it('refuses a prompt and a change of mode while its decision waits (C56, C58)', async () => {
    place([session(1)]);
    open();
    await planned();
    expect(await runtime.send(S(1), 'Something else.')).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(await runtime.send(S(1), 'Plan again.', { plan: true })).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(await runtime.setMode(S(1), 'edits-ok')).toEqual({ status: 'refused', reason: 'plan-pending' });
  });

  it('leaves a line whose turn ended while it was written unfinished, with all it received, never decided (C59, C74)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    emit({ type: 'plan-delta', turnId, itemId: 'plan_item', text: '# Half' });
    end(turnId, 'interrupted');
    expect(body()).toMatchObject({ outcome: 'unfinished' });
    expect(planStore.get(body().planId)?.versions[0]).toMatchObject({ state: 'unfinished', length: 6 });
    expect(runtime.planPending(S(1))).toBe(false);
    expect(await runtime.decidePlan(S(1), line().id, 'execute')).toEqual({ status: 'refused', reason: 'not-pending' });
  });

  it('Execute: a turn under the chat’s mode with fat-g’s words and an empty block, the line executed in its prompt’s own transaction (C15, C55, C68)', async () => {
    place([session(1)]);
    open();
    await planned();
    const { planId } = body();
    expect(await runtime.decidePlan(S(1), line().id, 'execute')).toEqual({ status: 'decided' });
    const sent = lastSent();
    expect(sent?.plan).toBeUndefined();
    expect(sent?.plannedBefore).toBe(true);
    expect(sent?.prompt).toBe(`${PLAN_WORDS.execute}\n\n<fat-g-plan id="${planId}" version="1" token="${TOKEN}">\n</fat-g-plan token="${TOKEN}">`);
    expect(readPlanBlock(sent?.prompt ?? '')).toMatchObject({ planId, version: 1, text: '' });
    expect(body()).toMatchObject({ outcome: 'executed' });
    const prompt = read().items.find((item) => item.role === 'user' && item.blocks[0]?.text === sent?.prompt);
    expect(prompt?.plan).toEqual({ planId, version: 1, intent: 'execute' });
    expect(runtime.planPending(S(1))).toBe(false);
    expect(entry()?.planPending).toBeUndefined();
    // A decision taken twice is refused, and nothing more is sent.
    started();
    end(sent?.turnId ?? '');
    expect(await runtime.decidePlan(S(1), line().id, 'execute')).toEqual({ status: 'refused', reason: 'not-pending' });
  });

  it('feedback: a plan turn whose prompt is the user’s text and the plan’s block, its next plan the next version (C15, C19, C78)', async () => {
    place([session(1)]);
    open();
    await planned();
    const { planId, } = body();
    const first = line().id;
    expect(await runtime.decidePlan(S(1), first, 'feedback', 'Shorter, please.')).toEqual({ status: 'decided' });
    expect(lastSent()).toMatchObject({ plan: true, prompt: `Shorter, please.\n\n<fat-g-plan id="${planId}" version="1" token="${TOKEN}">\n</fat-g-plan token="${TOKEN}">` });
    const turnId = started();
    writePlan(turnId, 'plan_item_2', '# Tidy\n\n1. Tidy.');
    end(turnId);
    expect(read().items.find((item) => item.id === first) && body(read().items.find((item) => item.id === first))).toMatchObject({ outcome: 'feedback' });
    expect(body()).toMatchObject({ planId, version: 2, outcome: 'pending' });
    expect(planStore.get(planId)?.versions.map((version) => [version.version, version.cause, version.revises])).toEqual([[1, 'plan-turn', null], [2, 'feedback', 1]]);
  });

  it('Cancel: nothing is sent, the line cancelled, and PLAN READY lets go', async () => {
    place([session(1)]);
    open();
    await planned();
    const sends = fake.latest().sent.length;
    expect(await runtime.decidePlan(S(1), line().id, 'cancel')).toEqual({ status: 'decided' });
    expect(fake.latest().sent).toHaveLength(sends);
    expect(body()).toMatchObject({ outcome: 'cancelled' });
    expect(summary()?.attention).toBeNull();
    expect(await runtime.send(S(1), 'Something else.')).toEqual({ status: 'accepted' });
  });

  it('refuses feedback under a mode that takes no plan turn before anything is consumed, and takes Execute there (C72)', async () => {
    place([session(1)]);
    open();
    await planned();
    world.availability = { available: false, reason: 'cli-refuses' };
    expect(await runtime.decidePlan(S(1), line().id, 'feedback', 'More.')).toEqual({ status: 'refused', reason: 'plans-unavailable' });
    expect(body()).toMatchObject({ outcome: 'pending' });
    expect(await runtime.decidePlan(S(1), line().id, 'execute')).toEqual({ status: 'decided' });
  });

  it('waits across a restart: the line pending, Send refused, PLAN READY raised at the launch (C27, C56, as amended)', async () => {
    place([session(1)]);
    open();
    await planned();
    await restart();
    expect(body()).toMatchObject({ outcome: 'pending' });
    expect(runtime.planPending(S(1))).toBe(true);
    expect(summary()?.attention).toEqual({ kind: 'plan', count: 1, acknowledged: false });
    await service.select(S(1));
    expect(summary()?.attention).toEqual({ kind: 'plan', count: 1, acknowledged: false });
    expect(await runtime.send(S(1), 'Something else.')).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(await runtime.decidePlan(S(1), line().id, 'execute')).toEqual({ status: 'decided' });
    expect(summary()?.attention?.kind).not.toBe('plan');
    // A thread that planned before, after a restart (C55).
    expect(lastSent()?.plannedBefore).toBe(true);
  });

  it('names `plannedBefore` on every later turn of a thread a plan turn ran on, and on none of a thread that never planned (C55)', async () => {
    place([session(1), session(2)]);
    open();
    const turnId = await running(1);
    end(turnId);
    await runtime.send(S(1), 'Plainly.');
    expect(lastSent()).toMatchObject({ plannedBefore: true });
    expect(lastSent()?.plan).toBeUndefined();
    await runtime.send(S(2), 'Plainly.');
    expect(lastSent()?.plannedBefore).toBeUndefined();
  });

  it('says once that the thread may be left in plan mode where plans went off for its account (C55)', async () => {
    place([session(1)]);
    open();
    end(await running());
    world.availability = { available: false, reason: 'cli-refuses' };
    end(await running(1, 'Plainly.', false));
    end(await running(1, 'Plainly again.', false));
    expect(notices().filter((kind) => kind === 'plan-mode-left')).toHaveLength(1);
  });

  it('withdraws a line a second plan of the same turn replaces, as changed: the decision stands on the newest (C78)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    writePlan(turnId, 'plan_a', '# First');
    writePlan(turnId, 'plan_b', '# Second');
    end(turnId);
    const [first, second] = lines();
    expect(first && body(first)).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'changed', version: 1 });
    expect(second && body(second)).toMatchObject({ outcome: 'pending', version: 2 });
    expect(runtime.planPending(S(1))).toBe(true);
  });
});

describe('an async answer given while the chat planned (V4; C71)', () => {
  it('carries the plan turn on: the answer’s turn is a plan turn, sent with `plan`, and keeps the fields its turn’s prompt named', async () => {
    place([session(1)]);
    open();
    await planned();
    expect(await runtime.decidePlan(S(1), line().id, 'feedback', 'Which file?')).toEqual({ status: 'decided' });
    const turnId = started();
    emit({ type: 'message', turnId, role: 'assistant', itemId: 'item-q', phase: 'final', text: 'One question first.', questions: [{ title: 'Which file?', options: ['notes-1.txt', 'notes-2.txt'] }] });
    end(turnId);
    const card = read().items.find((item) => item.kind === 'interaction' && planOf(item) === null);
    expect(await runtime.answer(S(1), card?.id ?? '', [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    expect(lastSent()).toMatchObject({ plan: true });
    const answerTurn = lastSent()?.turnId ?? '';
    expect(conversations.turn(S(1), answerTurn)).toMatchObject({ plan: true });
    expect(conversations.turnPlan(S(1), answerTurn)?.fields).toMatchObject({ planId: body().planId, version: 1, intent: 'revise' });
  });
});

describe('a Claude plan: a request holds it (V4; C10–C12, C27, C56)', () => {
  const raise = (turnId: string, requestId = 'req-1', text = '# Plan\n\n1. Do it.'): void => { emit({ type: 'plan-raised', turnId, requestId, sourceId: `toolu_${requestId}`, text }); };

  it('excludes the plan decision wait from the saved elapsed time on a monotonic clock', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    clock.mono += 1_000;
    raise(turnId);
    clock.mono += 60_000;
    clock.wall -= 3_600_000;
    expect(await runtime.decidePlan(S(1), line().id, 'execute')).toEqual({ status: 'decided' });
    clock.mono += 2_000;
    end(turnId);
    expect(conversations.turn(S(1), turnId)?.elapsedMs).toBe(3_000);
    expect(read().turns.find((turn) => turn.id === turnId)?.time.elapsedMs).toBe(3_000);
  });

  it('writes the version whole, then the line, pending while its request lives; PLAN READY on the turn that waits', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    expect(body()).toMatchObject({ outcome: 'pending', request: true, came: 'made' });
    expect(planStore.get(body().planId)?.versions[0]).toMatchObject({ state: 'complete', length: '# Plan\n\n1. Do it.'.length });
    expect(summary()).toMatchObject({ attention: { kind: 'plan', count: 1 }, action: { kind: 'plan-ready' } });
    expect(entry()?.planPending).toBe(true);
  });

  it('takes each decision through the registry: written first, then the session told; the turn goes on, or Cancel ends it (C11, C12)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    raise(turnId);
    expect(await runtime.decidePlan(S(1), line().id, 'feedback', 'Add tests.')).toEqual({ status: 'decided' });
    expect(fake.latest().planned).toEqual([{ requestId: 'req-1', answer: { kind: 'feedback', text: 'Add tests.' } }]);
    expect(body()).toMatchObject({ outcome: 'feedback' });
    // The next plan of the same turn is the plan's next version (C19, C78).
    raise(turnId, 'req-2', '# Plan\n\n1. Do it.\n2. Test it.');
    expect(body()).toMatchObject({ version: 2, outcome: 'pending' });
    expect(await runtime.decidePlan(S(1), line().id, 'execute')).toEqual({ status: 'decided' });
    expect(fake.latest().planned.at(-1)).toEqual({ requestId: 'req-2', answer: { kind: 'execute' } });
    emit({ type: 'plan-resolved', requestId: 'req-2', reason: 'confirmed' });
    expect(body()).toMatchObject({ outcome: 'executed' });
    expect(body().confirmedAt).not.toBeNull();
    expect(runtime.planPending(S(1))).toBe(false);
    expect(planStore.get(body().planId)?.versions.map((version) => version.cause)).toEqual(['plan-turn', 'feedback']);
  });

  it('withdraws a line whose turn ended with its request, and reads one a restart found `dropped` (C56)', async () => {
    place([session(1), session(2)]);
    open();
    const turnId = await running();
    raise(turnId);
    end(turnId, 'interrupted');
    expect(body()).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn' });
    const other = await running(2);
    raise(other, 'req-9');
    await restart();
    expect(body(line(2))).toMatchObject({ outcome: 'dropped' });
    expect(runtime.planPending(S(2))).toBe(false);
  });
});

describe('a plan brought into a chat (V4; C64, C65, C67, C76)', () => {
  /** A plan of the project, made in chat 1 and cancelled there: complete, and waiting nowhere. */
  async function made(): Promise<{ planId: string; hash: string }> {
    await planned(1);
    const { planId } = body(line(1));
    expect(await runtime.decidePlan(S(1), line(1).id, 'cancel')).toEqual({ status: 'decided' });
    const version = planStore.get(planId)?.versions[0];
    return { planId, hash: version?.hash ?? '' };
  }

  it('stands in a turn of fat-g’s own, waits with no attention raised, and executes with the version’s whole text in its block', async () => {
    place([session(1), session(2)]);
    open();
    const { planId, hash } = await made();
    const brought = await runtime.bringPlan(S(2), { planId, version: 1, hash });
    expect(brought).toMatchObject({ status: 'brought' });
    expect(body(line(2))).toMatchObject({ planId, version: 1, came: 'brought', outcome: 'pending', request: false });
    expect(conversations.turn(S(2), line(2).turnId)).toMatchObject({ own: true, sessionOutcome: 'completed' });
    expect(summary(2)?.attention).toBeNull();
    expect(runtime.planPending(S(2))).toBe(true);
    // A restart raises no PLAN READY for it either: it waits, and the chat reads READY, seen (amended).
    await restart();
    expect(runtime.planPending(S(2))).toBe(true);
    expect(summary(2)?.attention?.kind).not.toBe('plan');
    expect(await runtime.decidePlan(S(2), line(2).id, 'execute')).toEqual({ status: 'decided' });
    const prompt = lastSent()?.prompt ?? '';
    expect(prompt.startsWith(`${PLAN_WORDS.broughtExecute}\n\n`)).toBe(true);
    expect(readPlanBlock(prompt)).toMatchObject({ planId, version: 1, text: '# Tidy the notes\n\n1. Read them.\n2. Tidy them.' });
  });

  it('takes feedback on it as fat-g’s words, the block, then the user’s text, and plans its next version there', async () => {
    place([session(1), session(2)]);
    open();
    const { planId, hash } = await made();
    await runtime.bringPlan(S(2), { planId, version: 1, hash });
    expect(await runtime.decidePlan(S(2), line(2).id, 'feedback', 'Two steps only.')).toEqual({ status: 'decided' });
    const prompt = lastSent()?.prompt ?? '';
    expect(lastSent()?.plan).toBe(true);
    expect(readPlanBlock(prompt)).toMatchObject({ before: PLAN_WORDS.broughtFeedback, after: 'Two steps only.' });
    const turnId = started(2);
    writePlan(turnId, 'plan_2', '# Tidy\n\n1. One.\n2. Two.');
    end(turnId);
    expect(body(line(2))).toMatchObject({ planId, version: 2, came: 'made' });
  });

  it('refuses a plan of another project, a stale hash, an incomplete version and a chat whose decision waits', async () => {
    place([session(1), session(2), session(3, { projectId: OTHER_PROJECT })]);
    open();
    const { planId, hash } = await made();
    expect(await runtime.bringPlan(S(3), { planId, version: 1, hash })).toEqual({ status: 'refused', reason: 'other-project' });
    expect(await runtime.bringPlan(S(2), { planId, version: 1, hash: '0'.repeat(64) })).toEqual({ status: 'refused', reason: 'stale' });
    expect(await runtime.bringPlan(S(2), { planId, version: 2, hash })).toEqual({ status: 'refused', reason: 'not-complete' });
    await runtime.bringPlan(S(2), { planId, version: 1, hash });
    expect(await runtime.bringPlan(S(2), { planId, version: 1, hash })).toEqual({ status: 'refused', reason: 'plan-pending' });
  });

  it('takes no Execute under the reading mode, refused before anything is taken, and takes Cancel there (C81)', async () => {
    place([session(1), session(2)]);
    open();
    const { planId, hash } = await made();
    expect(await runtime.setMode(S(2), 'read-only')).toEqual({ status: 'set' });
    await runtime.bringPlan(S(2), { planId, version: 1, hash });
    expect(await runtime.decidePlan(S(2), line(2).id, 'execute')).toEqual({ status: 'refused', reason: 'reads-only' });
    expect(body(line(2))).toMatchObject({ outcome: 'pending' });
    expect(await runtime.decidePlan(S(2), line(2).id, 'cancel')).toEqual({ status: 'decided' });
    expect(body(line(2))).toMatchObject({ outcome: 'cancelled' });
  });
});

describe('a removal settles what waits first (V4; C73)', () => {
  it('cancels a request’s line through its process and any other’s here, one after another', async () => {
    place([session(1), session(2)]);
    open();
    await planned(1);
    const { planId } = body(line(1));
    const turnId = await running(2);
    emit({ type: 'plan-raised', turnId, requestId: 'req-1', sourceId: 'toolu_1', text: '# Other' });
    expect(plans.waiters(planId).map((waiter) => waiter.sessionId)).toEqual([S(1)]);
    const otherId = body(line(2)).planId;
    expect(await runtime.settlePlans([planId, otherId])).toBe(2);
    expect(body(line(1))).toMatchObject({ outcome: 'cancelled' });
    expect(body(line(2))).toMatchObject({ outcome: 'cancelled' });
    expect(fake.latest().planned).toEqual([{ requestId: 'req-1', answer: { kind: 'cancel' } }]);
    expect(runtime.planPending(S(1))).toBe(false);
  });
});

describe('a conversation store fat-g cannot read (C56)', () => {
  it('holds no waiting line, asks the store nothing and counts no failure, and reads it once it opens', () => {
    let refused = true;
    const info = vi.fn();
    const pendingPlans = vi.fn((): ReturnType<ConversationStore['pendingPlans']> => []);
    const service = createPlanService({
      store: planStore,
      conversations: { status: () => (refused ? { kind: 'refused', cause: 'older' } : { kind: 'ok' }), pendingPlans, turnPlan: () => null, planWaiters: () => [], item: () => null },
      chat, record: () => undefined, log: { info, warn: vi.fn() },
    });
    for (let ask = 0; ask < 20; ask += 1) expect(service.waiting(S(1))).toBeNull();
    expect(pendingPlans).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    refused = false;
    expect(service.waiting(S(1))).toBeNull();
    expect(service.waiting(S(1))).toBeNull();
    expect(pendingPlans).toHaveBeenCalledTimes(1);
  });
});
