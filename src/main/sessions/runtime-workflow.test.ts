// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A plan's shared workflow through the runtime (decision 0029), on a real records store, a real
// conversation store, a real plan store, the chat service, the session service, the request
// registry, the plan service, the review service and the workflow coordinator, with a facet in the
// test's hands: three chats sharing one plan, one operation admitted at a time, versions every chat
// decides on, requests retired, an implementation followed through to its end and the plan deleted,
// and what a restart and a removal leave. No Electron, no process.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { ChatRead } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type PlanBody, planOf, questionOf } from '@shared/contracts/interaction';
import type { ModeAvailability, PermissionCapability } from '@shared/contracts/permissions';
import { type PlanCapability, planChatName, type PlanDecideRequest, type PlanDecideResult, PLAN_WORDS, planBlock, planFeedback } from '@shared/contracts/plans';
import type { Finding } from '@shared/contracts/review';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { createPlanStore, type PlanStore } from '../plans/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { type AppStateStore, createAppStateStore } from '../state/app-state-store';
import { type ChatService, createChatService } from './chat-service';
import { createGate, type Gate } from './gate';
import { createPermissions } from './permissions';
import { createPlanService, type PlanService } from './plans';
import { createRemoval } from './removal';
import { createReviewService, type ReviewService } from './reviews';
import type { ModelPreset } from '@shared/contracts/presets';
import { createSessionRuntime, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet, type FakeSession } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';
import { createWorkflowCoordinator, type WorkflowCoordinator } from './workflow';

/** The preset a review starts on in these tests: the chat's own, as the popup preselects it. */
const chatPreset = (id: string): ModelPreset => {
  const record = service.record(id);
  return record === undefined ? { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null } : { providerId: record.providerId, instanceId: record.instanceId, model: record.model, effort: record.effort, speed: null };
};
const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-02-17T13:00:00.000Z');
const TOKEN = 'abcdef012345';
const TITLE = 'Tidy the notes';
const PLAN_V1 = `# ${TITLE}\n\n## Steps\n\n1. Read them.\n2. Tidy them.`;
const PLAN_V2 = `# ${TITLE}\n\n## Steps\n\n1. Read them all.\n2. Tidy them by date.`;

const mode = (id: string, label: string, patch: Partial<PermissionCapability['modes'][number]> = {}) => ({ id, label, description: `What ${label} lets run.`, asks: true, reading: false, transitionsFrom: [], ...patch });
const CAPABILITY: PermissionCapability = {
  modes: [mode('read-only', 'Read only', { asks: false, reading: true }), mode('ask-first', 'Ask first'), mode('edits-ok', 'Edits ok')],
  fallback: 'ask-first',
  setup: null,
  inherited: 'Rules of your own configuration act as it lets them.',
  rules: 'This CLI lists no rules.',
};
// As Codex: a plan turn under every mode, the reading one included, so a reviewer can integrate into itself.
const PLANS: PlanCapability = { modes: ['read-only', 'ask-first', 'edits-ok'], unavailable: 'No plan turn here.' };
const available = (id: string): ModeAvailability => ({ id, available: true, reason: null, setup: false, records: false, unconfined: false, places: null });

let dir: string;
let records: RecordsStore;
let service: SessionService;
let runtime: SessionRuntime;
let chat: ChatService;
let conversations: ConversationStore;
let planStore: PlanStore;
let plans: PlanService;
let reviews: ReviewService;
let workflow: WorkflowCoordinator;
let appState: AppStateStore;
let gate: Gate;
let fake: FakeFacet;
let ids: number;
let clock: { wall: number; mono: number };
/** Each session's process, as it was opened for it. */
let procs: Map<string, FakeSession>;
/** A step of the plan store's writes that fails while named, as a full disk would. */
let failing: string | null = null;
const planReady = vi.fn();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-workflow-'));
  failing = null;
  ids = 0;
  clock = { wall: AT, mono: 5_000 };
  for (const spy of Object.values(log)) spy.mockClear();
});
afterEach(async () => {
  await workflow?.settled();
  runtime?.dispose();
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
const project = { id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [root], permissionModes: {} };
const place = (sessions: unknown[]) => writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [project], sessions }));

function open(): void {
  planReady.mockClear();
  runtime?.dispose();
  service?.stop();
  procs = new Map();
  records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', now: () => AT, log });
  appState = createAppStateStore();
  fake = fakeFacet({ history: false, plans: {}, permissions: { modes: () => CAPABILITY.modes.map((entry) => available(entry.id)) } });
  conversations?.close();
  conversations = createConversationStore({ dir, log, now: () => clock.wall });
  planStore = createPlanStore({ dir: path.join(dir, 'plans'), now: () => clock.wall, log, hook: (point) => { if (point === failing) throw new Error(`failing at ${point}`); } });
  planStore.recover(new Set([PROJECT]));
  conversations.unfinishPlans(clock.wall);
  let ready = false;
  chat = createChatService({
    store: conversations, log, now: () => clock.wall,
    requests: { pending: (sessionId, itemId) => ready && runtime.requests.pending(sessionId, itemId), waiting: (sessionId) => (ready ? runtime.requests.waiting(sessionId) : []), view: (sessionId, itemId) => (ready ? runtime.requests.view(sessionId, itemId) : null) },
    processKey: (sessionId) => (ready ? runtime.processKey(sessionId) : null),
  });
  plans = createPlanService({
    store: planStore, conversations, chat, record: (id) => records.getSession(id), chatName: (id) => records.getSession(id)?.name ?? null,
    requestPending: (sessionId, itemId) => ready && runtime.requests.pending(sessionId, itemId), now: () => clock.wall, token: () => TOKEN, log,
    integration: (sessionId, turnId) => (ready ? reviews.integration(sessionId, turnId) : null),
    versionMade: (planId, version) => { if (ready) { reviews.versionMade(planId, version); workflow.versionMade(planId, version); } },
    admits: (planId, sessionId, turnId) => !ready || workflow.admits(planId, sessionId, turnId),
    joined: (planId, sessionId) => { if (ready) workflow.joined(planId, sessionId); },
    workflow: (planId) => (ready ? workflow.view(planId) : null),
  });
  const removal = createRemoval({ store: conversations, log });
  gate = createGate({
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
  const permissions = createPermissions({ capability: () => CAPABILITY, userDefault: () => null, projectDefault: () => null, availability: () => CAPABILITY.modes.map((entry) => available(entry.id)) });
  runtime = createSessionRuntime({
    sessions: service, records, chat, gate, log, now: () => clock.wall, monotonic: () => clock.mono, newId: () => `id-${++ids}`,
    facet: () => fake.facet, providerName: () => 'Codex', hasHistory: () => false, questions: () => 'both',
    asides: () => ({ followUp: true, streamed: true, tools: 'none' }),
    store: conversations, removal, permissions, plans, planCapability: () => PLANS,
    reviews: () => (ready ? reviews : undefined),
    get workflow() { return ready ? workflow : undefined; },
  });
  workflow = createWorkflowCoordinator({
    onReady: planReady,
    store: planStore, conversations, chat,
    host: { record: (id) => service.record(id), name: (id) => service.record(id)?.name ?? null, running: (id) => service.isRunning(id), quitting: () => runtime.quitting() },
    runtime: () => (ready ? runtime : undefined), reviews: () => (ready ? reviews : undefined), lines: () => plans,
    now: () => clock.wall, newId: () => `wf-${++ids}`, token: () => TOKEN, log,
  });
  reviews = createReviewService({
    store: planStore, conversations,
    host: {
      record: (id) => service.record(id), name: (id) => service.record(id)?.name ?? null, running: (id) => service.isRunning(id), quitting: () => runtime.quitting(),
      admit: (_projectId, preset) => ({ ok: true, preset }),
      create: (projectId, preset, name) => service.create(projectId, preset, name),
      remove: (id) => removal.run([id], () => service.remove(id), (answer) => answer.status === 'saved'),
      folder: (record) => gate.folder(record),
      complete: (id) => service.complete(id),
      runtime,
    },
    workflow,
    now: () => clock.wall, newId: () => `rv-${++ids}`, token: () => TOKEN, log,
  });
  ready = true;
  service.availabilityChanged();
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

const read = (id: string): ChatRead => { const answer = runtime.read(id); if (answer.status !== 'read') throw new Error(answer.reason); return answer; };
const lines = (id: string): ConversationItem[] => read(id).items.filter((item) => planOf(item) !== null);
const body = (item: ConversationItem | undefined): PlanBody => planOf(item as ConversationItem) as PlanBody;
const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };
const emit = (from: FakeSession, event: AgentEvent): void => from.emit(event);
const revisionOf = (planId: string): number => workflow.view(planId)?.revision ?? -1;
const sentCount = (): number => fake.made.reduce((sum, one) => sum + one.sent.length, 0);

/** Runs what may open a session's process, and keeps which process it opened. */
async function within<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
  const before = fake.made.length;
  const answer = await run();
  if (fake.made.length > before) procs.set(sessionId, fake.made.at(-1)!);
  return answer;
}
const proc = (sessionId: string): FakeSession => { const found = procs.get(sessionId); if (found === undefined) throw new Error(`no process for ${sessionId}`); return found; };
/** The turn just sent on a session, taken by the provider. */
function taken(sessionId: string): string {
  const from = proc(sessionId);
  const turnId = from.sent.at(-1)?.turnId ?? '';
  if (from.options.mode !== null) emit(from, { type: 'in-force', turnId, mode: from.options.mode });
  emit(from, { type: 'session-started', reference: `thread-${sessionId}`, folder: ROOT });
  emit(from, { type: 'turn-started', turnId, providerTurnId: `p-${turnId}` });
  return turnId;
}
const end = (sessionId: string, turnId: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed'): void => { emit(proc(sessionId), { type: 'turn-ended', turnId, outcome, reported: true }); };
const say = (sessionId: string, turnId: string, text: string, extra: Partial<{ questions: { title: string; options: string[] }[] }> = {}): void => {
  emit(proc(sessionId), { type: 'message', turnId, role: 'assistant', itemId: `msg-${++ids}`, phase: 'final', text, questions: extra.questions ?? [] });
};

/** A Codex plan made in the chat: written, completed, its turn ended; no request holds it. */
async function codexPlan(sessionId: string, text = PLAN_V1): Promise<string> {
  expect(await within(sessionId, () => runtime.send(sessionId, 'Make a plan.', { plan: true }))).toEqual({ status: 'accepted' });
  const turnId = taken(sessionId);
  emit(proc(sessionId), { type: 'plan-completed', turnId, itemId: `plan-${++ids}`, text });
  end(sessionId, turnId);
  await flush();
  return body(lines(sessionId).at(-1)).planId;
}
/** A Claude plan made in the chat: its request held, its turn waiting on it. */
async function claudePlan(sessionId: string, text = PLAN_V1): Promise<{ readonly planId: string; readonly turnId: string }> {
  expect(await within(sessionId, () => runtime.send(sessionId, 'Make a plan.', { plan: true }))).toEqual({ status: 'accepted' });
  const turnId = taken(sessionId);
  emit(proc(sessionId), { type: 'plan-raised', turnId, requestId: 'req-1', sourceId: 'toolu_1', text });
  await flush();
  return { planId: body(lines(sessionId).at(-1)).planId, turnId };
}
async function bring(sessionId: string, planId: string): Promise<void> {
  const version = planStore.get(planId)?.workflow.version ?? 0;
  const hash = planStore.get(planId)?.versions.find((one) => one.version === version)?.hash ?? '';
  expect(await runtime.bringPlan(sessionId, { planId, version, hash })).toMatchObject({ status: 'brought' });
}
function decide(sessionId: string, planId: string, decision: PlanDecideRequest['decision'], text?: string, revision = revisionOf(planId)): Promise<PlanDecideResult> {
  const request = (decision === 'feedback' ? { sessionId, planId, revision, decision, text: text ?? '' } : { sessionId, planId, revision, decision }) as PlanDecideRequest;
  return within(sessionId, () => workflow.decide(request));
}
const finding = (id: string): Finding => ({ id, tier: Number(id.charAt(1)), category: 'PROD', title: `Title ${id}`, example: `Example ${id}.`, description: `Description ${id}.`, correction: `Correction ${id}.` });
const block = (issues: readonly Finding[]): string => `\`\`\`json\n${JSON.stringify({ version: 2, appraisal: 'One line on the plan.', issues }, null, 2)}\n\`\`\``;
/** A review started from the chat, its first round arrived with these findings. */
async function reviewed(sessionId: string, planId: string, issues: readonly Finding[] = [finding('T1.1'), finding('T2.1')]): Promise<{ readonly reviewId: string; readonly reviewer: string }> {
  const before = fake.made.length;
  const answer = await reviews.start({ sessionId, preset: chatPreset(sessionId), planId, version: planStore.get(planId)?.workflow.version ?? 0, revision: revisionOf(planId) });
  if (answer.status !== 'started') throw new Error(answer.reason);
  if (fake.made.length > before) procs.set(answer.sessionId, fake.made.at(-1)!);
  const turnId = taken(answer.sessionId);
  say(answer.sessionId, turnId, `Two sentences.\n\n${block(issues)}`);
  end(answer.sessionId, turnId);
  await flush();
  return { reviewId: answer.reviewId, reviewer: answer.sessionId };
}
const part = (sessionId: string) => workflow.forSession(sessionId);
const attention = (sessionId: string): string | undefined => service.snapshot().sessions.find((entry) => entry.record.id === sessionId)?.summary.attention?.kind;
const waitOf = (sessionId: string): string | undefined => service.snapshot().sessions.find((entry) => entry.record.id === sessionId)?.summary.planWait;

// ── Three chats, one plan ───────────────────────────────────────────────────────────────────

describe('three chats sharing one plan (decision 0029)', () => {
  it('reviews from one, integrates into another, and implements the resulting version from the first; the plan is then deleted', async () => {
    place([session(1), session(2), session(3)]);
    open();
    const planId = await codexPlan(S(1));
    expect(service.snapshot().sessions.find((entry) => entry.record.id === S(1))?.summary.attention).toMatchObject({ kind: 'plan', acknowledged: false });
    await bring(S(2), planId);
    await bring(S(3), planId);
    for (const id of [S(2), S(3)]) expect(service.snapshot().sessions.find((entry) => entry.record.id === id)?.summary.attention).toEqual({ kind: 'plan', count: 1, acknowledged: false, flash: false });
    for (const id of [S(1), S(2), S(3)]) expect(part(id)).toMatchObject({ kind: 'plan', role: 'participant', workflow: { state: 'ready', version: 1, participants: [S(1), S(2), S(3)] } });

    // Review by model from the second chat: the plan is under review in every chat, a hard stop.
    const { reviewId, reviewer } = await reviewed(S(2), planId);
    for (const id of [S(1), S(2), S(3)]) expect(part(id)).toMatchObject({ workflow: { state: 'reviewing', reviewId, holder: { sessionId: reviewer } } });
    expect(part(reviewer)).toMatchObject({ kind: 'plan', role: 'reviewer' });
    expect(await runtime.send(S(1), 'Meanwhile.')).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(await decide(S(3), planId, 'execute')).toMatchObject({ status: 'refused', reason: 'locked', workflow: { state: 'reviewing' } });

    // Integrated into the third: being revised there, the reviewer Done once it was taken.
    reviews.mark({ reviewId, tier: 1, mark: 'accepted' });
    reviews.mark({ reviewId, tier: 2, mark: 'rejected' });
    expect(await within(S(3), () => reviews.integrate({ reviewId, target: { sessionId: S(3) } }))).toMatchObject({ status: 'sent', sessionId: S(3) });
    expect(part(S(1))).toMatchObject({ workflow: { state: 'revising', holder: { sessionId: S(3) } } });
    expect(service.record(reviewer)?.completedAt).not.toBeNull();
    expect(planStore.review(planId, reviewId)).toMatchObject({ state: 'closed', closed: 'handed' });
    const writing = taken(S(3));
    emit(proc(S(3)), { type: 'plan-completed', turnId: writing, itemId: 'plan-v2', text: PLAN_V2 });
    end(S(3), writing);
    await flush();

    // Every chat decides on v2 now; the older lines say so.
    for (const id of [S(1), S(2), S(3)]) expect(part(id)).toMatchObject({ workflow: { state: 'ready', version: 2 } });
    for (const id of [S(1), S(2), S(3)]) expect(service.snapshot().sessions.find((entry) => entry.record.id === id)?.summary.attention?.flash).toBeUndefined();
    expect(body(lines(S(1))[0]).outcome).toBe('superseded');
    expect(body(lines(S(2))[0]).outcome).toBe('superseded');

    // Execute from the first chat, which never saw v2: v2's whole text, never its old conversation.
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    const executing = proc(S(1)).sent.at(-1);
    expect(executing?.prompt).toBe(`${PLAN_WORDS.broughtExecute}\n\n${planBlock(planId, 2, PLAN_V2, TOKEN)}`);
    expect(part(S(2))).toMatchObject({ workflow: { state: 'implementing', holder: { sessionId: S(1) } } });
    // The others go on with ordinary conversation meanwhile.
    expect(await within(S(2), () => runtime.send(S(2), 'Something else.'))).toEqual({ status: 'accepted' });
    end(S(2), taken(S(2)));
    const turnId = taken(S(1));
    say(S(1), turnId, 'Done.');
    end(S(1), turnId);
    await flush();
    await workflow.settled();

    // Implemented: deleted, its reviews with it, and each chat says where.
    expect(planStore.get(planId)).toBeNull();
    for (const id of [S(1), S(2), S(3)]) expect(part(id)).toMatchObject({ kind: 'implemented', sessionId: S(1), chat: 'Chat 1' });
    expect(conversations.planNote(S(2))).toEqual({ sessionId: S(1), at: AT });
    // The chats' conversations stay as they were.
    expect(lines(S(1)).map((line) => body(line).outcome)).toEqual(['superseded']);
  });

  // Feedback asks for an acknowledgement and a revision summary, and shows in the chat.
  it('answers a Claude request with the user’s feedback after fat-g’s request, kept as sent as the user’s message after the line', async () => {
    place([session(1)]);
    open();
    const { planId, turnId } = await claudePlan(S(1));
    expect(await decide(S(1), planId, 'feedback', 'Read them all.')).toEqual({ status: 'decided' });
    expect(proc(S(1)).planned).toEqual([{ requestId: 'req-1', answer: { kind: 'feedback', text: planFeedback('Read them all.') } }]);
    const items = read(S(1)).items.filter((item) => item.turnId === turnId);
    const at = items.findIndex((item) => planOf(item) !== null);
    expect(body(items[at]).outcome).toBe('feedback');
    expect(items.slice(at + 1)).toHaveLength(1);
    expect(items[at + 1]).toMatchObject({ kind: 'message', role: 'user', plan: { planId, version: 1, intent: 'revise' } });
    expect(items[at + 1]?.blocks[0]?.text).toBe(planFeedback('Read them all.'));
  });

  it.each(['own', 'brought'] as const)('sends an %s plan’s feedback with the acknowledgement and summary request', async (route) => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    const target = route === 'own' ? S(1) : S(2);
    if (route === 'brought') await bring(target, planId);
    expect(await decide(target, planId, 'feedback', 'Shorter.')).toEqual({ status: 'decided' });
    const block = planBlock(planId, 1, route === 'own' ? '' : PLAN_V1, TOKEN);
    const expected = route === 'own' ? `${planFeedback('Shorter.')}\n\n${block}` : `${PLAN_WORDS.broughtFeedback}\n\n${block}\n\n${planFeedback('Shorter.')}`;
    expect(proc(target).sent.at(-1)?.prompt).toBe(expected);
  });

  it('shows v2 in every chat and sends v2 from each, the original Claude chat’s v1 request retired first', async () => {
    place([session(1), session(2)]);
    open();
    const { planId, turnId: holding } = await claudePlan(S(1));
    await bring(S(2), planId);
    // Feedback from the second chat: its brought line's own, a plan turn with v1's whole text.
    expect(await decide(S(2), planId, 'feedback', 'Read them all.')).toEqual({ status: 'decided' });
    expect(part(S(1))).toMatchObject({ workflow: { state: 'revising', holder: { sessionId: S(2) } } });
    const writing = taken(S(2));
    emit(proc(S(2)), { type: 'plan-completed', turnId: writing, itemId: 'plan-v2', text: PLAN_V2 });
    await flush();
    // The v1 request is retired as Cancel answers it: the decision waits a moment, until its turn ends.
    expect(proc(S(1)).planned).toEqual([{ requestId: 'req-1', answer: { kind: 'cancel' } }]);
    expect(body(lines(S(1))[0]).outcome).toBe('superseded');
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 2, busy: 'retiring' });
    expect(await decide(S(1), planId, 'execute')).toMatchObject({ status: 'refused', reason: 'locked' });
    emit(proc(S(1)), { type: 'plan-resolved', requestId: 'req-1', reason: 'confirmed' } as unknown as AgentEvent);
    end(S(1), holding, 'interrupted');
    end(S(2), writing);
    await flush();
    await workflow.settled();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 2, busy: null });
    expect(part(S(1))).toMatchObject({ workflow: { state: 'ready', version: 2 } });
    // Execute in the Claude chat sends v2 whole.
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    expect(proc(S(1)).sent.at(-1)?.prompt).toBe(`${PLAN_WORDS.broughtExecute}\n\n${planBlock(planId, 2, PLAN_V2, TOKEN)}`);
  });

  it('dispatches exactly one of competing Execute, feedback and review drawn from the same state', async () => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    const revision = revisionOf(planId);
    const before = sentCount();
    const made = fake.made.length;
    const answers = await Promise.all([
      decide(S(1), planId, 'execute', undefined, revision),
      decide(S(2), planId, 'feedback', 'Shorter.', revision),
      reviews.start({ sessionId: S(2), preset: chatPreset(S(2)), planId, version: 1, revision }),
      decide(S(2), planId, 'execute', undefined, revision),
    ]);
    expect(answers.filter((answer) => answer.status === 'decided' || answer.status === 'started')).toHaveLength(1);
    for (const answer of answers.slice(1)) expect(answer).toMatchObject({ status: 'refused' });
    // One prompt went, and no reviewer was made.
    expect(sentCount() - before).toBe(1);
    expect(fake.made.length - made).toBeLessThanOrEqual(1);
    expect(workflow.view(planId)).toMatchObject({ state: 'implementing', holder: { sessionId: S(1) } });
  });

  it('refuses a decision drawn from an older state, saying where the plan stands now, and sends nothing', async () => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    const stale = revisionOf(planId) - 1;
    const before = sentCount();
    expect(await decide(S(2), planId, 'execute', undefined, stale)).toMatchObject({ status: 'refused', reason: 'stale', workflow: { state: 'ready', version: 1 } });
    expect(await decide(S(3), planId, 'execute')).toMatchObject({ status: 'refused', reason: 'unknown-session' });
    expect(sentCount()).toBe(before);
  });
});

// ── Reviews ─────────────────────────────────────────────────────────────────────────────────

describe('a review, a hard stop on its plan (decision 0029)', () => {
  it('is cancelled from a chat of the plan: the reviewer’s turn stopped, the review closed, the plan ready, the reviewer Done', async () => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    const answer = await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 1, revision: revisionOf(planId) });
    if (answer.status !== 'started') throw new Error(answer.reason);
    procs.set(answer.sessionId, fake.latest());
    const turnId = taken(answer.sessionId);
    const closing = reviews.close({ reviewId: answer.reviewId, as: 'cancel' });
    await flush();
    // Its turn is stopped and its end awaited before the plan is let go of.
    expect(proc(answer.sessionId).stops).toBe(1);
    expect(workflow.view(planId)).toMatchObject({ state: 'reviewing' });
    end(answer.sessionId, turnId, 'interrupted');
    expect(await closing).toEqual({ status: 'closed' });
    expect(planStore.review(planId, answer.reviewId)).toMatchObject({ state: 'closed', closed: 'cancelled' });
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1, reviewId: null });
    expect(service.record(answer.sessionId)?.completedAt).not.toBeNull();
    // A closed review closes no more.
    expect(await reviews.close({ reviewId: answer.reviewId, as: 'cancel' })).toEqual({ status: 'refused', reason: 'not-open' });
  });

  it('is cancelled from its reviewer, and concluded where it found nothing, or every finding is refused', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    const clean = await reviewed(S(1), planId, []);
    expect(await reviews.close({ reviewId: clean.reviewId, as: 'conclude' })).toEqual({ status: 'closed' });
    expect(planStore.review(planId, clean.reviewId)).toMatchObject({ closed: 'concluded' });
    expect(service.record(clean.reviewer)?.completedAt).not.toBeNull();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1 });

    const refused = await reviewed(S(1), planId);
    expect(await reviews.close({ reviewId: refused.reviewId, as: 'conclude' })).toEqual({ status: 'refused', reason: 'not-concludable' });
    reviews.mark({ reviewId: refused.reviewId, tier: 1, mark: 'rejected' });
    reviews.mark({ reviewId: refused.reviewId, tier: 2, mark: 'rejected' });
    expect(reviews.read({ reviewId: refused.reviewId })).toMatchObject({ review: { concludable: true } });
    expect(await reviews.close({ reviewId: refused.reviewId, as: 'conclude' })).toEqual({ status: 'closed' });

    const cancelled = await reviewed(S(1), planId);
    expect(await reviews.close({ reviewId: cancelled.reviewId, as: 'cancel' })).toEqual({ status: 'closed' });
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1 });
    // Every later review is a record of its own; the earlier ones stay as history.
    expect(planStore.reviews(planId).map((review) => review.closed)).toEqual(['concluded', 'concluded', 'cancelled']);
  });

  it('integrates into its own reviewer, which then takes part in the plan and is not marked Done', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    const { reviewId, reviewer } = await reviewed(S(1), planId);
    reviews.mark({ reviewId, tier: 1, mark: 'accepted' });
    reviews.mark({ reviewId, tier: 2, mark: 'accepted' });
    expect(await reviews.integrate({ reviewId, target: { sessionId: reviewer } })).toMatchObject({ status: 'sent', sessionId: reviewer });
    expect(service.record(reviewer)?.completedAt).toBeNull();
    expect(workflow.view(planId)).toMatchObject({ state: 'revising', holder: { sessionId: reviewer }, participants: [S(1), reviewer] });
    const turnId = taken(reviewer);
    emit(proc(reviewer), { type: 'plan-completed', turnId, itemId: 'plan-v2', text: PLAN_V2 });
    end(reviewer, turnId);
    await flush();
    expect(part(reviewer)).toMatchObject({ kind: 'plan', role: 'participant', workflow: { state: 'ready', version: 2 } });
  });

  it('returns the plan to Ready where its integration fails, the review staying closed and the reviewer Done', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    const { reviewId, reviewer } = await reviewed(S(1), planId);
    reviews.mark({ reviewId, tier: 1, mark: 'accepted' });
    reviews.mark({ reviewId, tier: 2, mark: 'accepted' });
    expect(await within(S(1), () => reviews.integrate({ reviewId, target: { sessionId: S(1) } }))).toMatchObject({ status: 'sent' });
    const turnId = taken(S(1));
    end(S(1), turnId, 'failed');
    await flush();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1 });
    expect(planStore.review(planId, reviewId)).toMatchObject({ state: 'closed', closed: 'handed', integrations: [{ state: 'ended' }] });
    expect(service.record(reviewer)?.completedAt).not.toBeNull();
  });

  it('closes a review whose first run fails, readying the plan with the failure kept', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    const answer = await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 1, revision: revisionOf(planId) });
    if (answer.status !== 'started') throw new Error(answer.reason);
    procs.set(answer.sessionId, fake.latest());
    end(answer.sessionId, taken(answer.sessionId), 'failed');
    await flush();
    expect(planStore.review(planId, answer.reviewId)).toMatchObject({ state: 'failed', failure: 'turn-failed' });
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', reviewId: null });
  });
});

// ── Discard, leave, mode ────────────────────────────────────────────────────────────────────

describe('Discard plan, Leave plan mode, and a change of mode (decision 0029)', () => {
  it('Discard: every request retired and every line settled in every chat, then the plan deleted with its reviews', async () => {
    place([session(1), session(2)]);
    open();
    const { planId, turnId } = await claudePlan(S(1));
    await bring(S(2), planId);
    await reviewed(S(2), planId, []).then(({ reviewId }) => reviews.close({ reviewId, as: 'cancel' }));
    const discarding = decide(S(2), planId, 'cancel');
    await flush();
    expect(proc(S(1)).planned).toEqual([{ requestId: 'req-1', answer: { kind: 'cancel' } }]);
    expect(part(S(1))).toMatchObject({ workflow: { state: 'cancelled', busy: 'cancelling' } });
    end(S(1), turnId, 'interrupted');
    expect(await discarding).toEqual({ status: 'decided' });
    await workflow.settled();
    expect(planStore.get(planId)).toBeNull();
    expect(planStore.reviews(planId)).toEqual([]);
    expect(body(lines(S(1))[0]).outcome).toBe('cancelled');
    expect(body(lines(S(2))[0]).outcome).toBe('cancelled');
    for (const id of [S(1), S(2)]) expect(part(id)).toBeNull();
    // The conversations stay as they were: only the plan is gone.
    expect(lines(S(1))).toHaveLength(1);
  });

  it('Leave plan mode, keep plan: the chat leaves, the plan stays for the others and in the list', async () => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    expect(await decide(S(2), planId, 'leave')).toEqual({ status: 'decided' });
    expect(part(S(2))).toBeNull();
    expect(body(lines(S(2))[0]).outcome).toBe('left');
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', participants: [S(1)] });
    expect(await within(S(2), () => runtime.send(S(2), 'Something else.'))).toEqual({ status: 'accepted' });
    // The last chat leaves too: the plan is kept, listed, and can be brought again.
    expect(await decide(S(1), planId, 'leave')).toEqual({ status: 'decided' });
    expect(plans.list(PROJECT)).toMatchObject([{ planId, state: 'ready', participants: 0 }]);
    end(S(2), taken(S(2)));
    await flush();
    await bring(S(2), planId);
    expect(part(S(2))).toMatchObject({ workflow: { state: 'ready', participants: [S(2)] } });
  });

  it('takes a change of mode while the plan is ready, the chat’s request retired first, its decision kept on the same version', async () => {
    place([session(1)]);
    open();
    const { planId, turnId } = await claudePlan(S(1));
    const changing = runtime.setMode(S(1), 'edits-ok');
    await flush();
    expect(proc(S(1)).planned).toEqual([{ requestId: 'req-1', answer: { kind: 'cancel' } }]);
    expect(body(lines(S(1))[0]).outcome).toBe('retired');
    end(S(1), turnId, 'interrupted');
    expect(await changing).toEqual({ status: 'set' });
    expect(part(S(1))).toMatchObject({ workflow: { state: 'ready', version: 1, participants: [S(1)] } });
    // Its next Execute sends the version whole: the request is gone.
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    expect(proc(S(1)).sent.at(-1)?.prompt).toBe(`${PLAN_WORDS.broughtExecute}\n\n${planBlock(planId, 1, PLAN_V1, TOKEN)}`);
  });

  it('refuses a change of mode while the plan is under review or being revised', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    await reviewed(S(1), planId);
    expect(await runtime.setMode(S(1), 'edits-ok')).toEqual({ status: 'refused', reason: 'plan-pending' });
  });

  it('holds a queued message while the plan waits, and lets it go once the plan is no longer ready', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    expect(await runtime.send(S(1), 'After the plan.')).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(runtime.planPending(S(1))).toBe(true);
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    expect(runtime.planPending(S(1))).toBe(false);
  });
});

// ── An implementation followed through ──────────────────────────────────────────────────────

describe('an implementation (decision 0029)', () => {
  it('in the plan’s own chat: its own line’s Execute, implemented once its turn ends well, the plan deleted', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    expect(proc(S(1)).sent.at(-1)?.prompt).toBe(`${PLAN_WORDS.execute}\n\n${planBlock(planId, 1, '', TOKEN)}`);
    expect(part(S(1))).toMatchObject({ workflow: { state: 'implementing', holder: { sessionId: S(1) } } });
    const turnId = taken(S(1));
    end(S(1), turnId);
    await flush();
    await workflow.settled();
    expect(planStore.get(planId)).toBeNull();
    expect(part(S(1))).toMatchObject({ kind: 'implemented', sessionId: S(1) });
  });

  it('is interrupted by a Stop or a failure, continued by the chat’s next ordinary prompt, and implemented once that ends well', async () => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    end(S(1), taken(S(1)), 'interrupted');
    await flush();
    expect(part(S(2))).toMatchObject({ workflow: { state: 'interrupted', holder: { sessionId: S(1) } } });
    // Not executed again elsewhere: Execute is no decision while it is interrupted.
    expect(await decide(S(2), planId, 'execute')).toMatchObject({ status: 'refused', reason: 'locked' });
    // A plan turn in the chat that carries it is refused; an ordinary prompt continues it.
    expect(await runtime.send(S(1), 'Another plan.', { plan: true })).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(await within(S(1), () => runtime.send(S(1), 'Go on.'))).toEqual({ status: 'accepted' });
    expect(workflow.view(planId)).toMatchObject({ state: 'implementing' });
    end(S(1), taken(S(1)), 'failed');
    await flush();
    expect(workflow.view(planId)).toMatchObject({ state: 'interrupted' });
    expect(await within(S(1), () => runtime.send(S(1), 'Go on again.'))).toEqual({ status: 'accepted' });
    end(S(1), taken(S(1)));
    await flush();
    await workflow.settled();
    expect(planStore.get(planId)).toBeNull();
    expect(part(S(2))).toMatchObject({ kind: 'implemented', sessionId: S(1) });
  });

  it('waits for the workers of its turn: implemented once the last of them ends', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    const turnId = taken(S(1));
    emit(proc(S(1)), { type: 'worker-started', workerId: 'w1' });
    end(S(1), turnId);
    await flush();
    await workflow.settled();
    expect(workflow.view(planId)).toMatchObject({ state: 'implementing' });
    emit(proc(S(1)), { type: 'worker-ended', workerId: 'w1', outcome: 'completed' });
    await flush();
    await workflow.settled();
    expect(planStore.get(planId)).toBeNull();
  });

  it('waits on a question its turn asks, and is implemented by the turn the answer starts', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    const turnId = taken(S(1));
    say(S(1), turnId, 'Which order?', { questions: [{ title: 'Order?', options: ['Date', 'Name'] }] });
    end(S(1), turnId);
    await flush();
    await workflow.settled();
    // Not implemented while the card may continue it.
    expect(workflow.view(planId)).toMatchObject({ state: 'implementing' });
    const card = read(S(1)).items.find((item) => questionOf(item) !== null);
    expect(await runtime.answer(S(1), card?.id ?? '', [{ question: 0, options: [0], text: null }])).toEqual({ status: 'answered' });
    const next = proc(S(1)).sent.at(-1)?.turnId ?? '';
    expect(planStore.get(planId)?.workflow.operation?.turns).toEqual([turnId, next]);
    emit(proc(S(1)), { type: 'turn-started', turnId: next, providerTurnId: 'p-next' });
    end(S(1), next);
    await flush();
    await workflow.settled();
    expect(planStore.get(planId)).toBeNull();
  });

  it('is implemented where its card is dismissed after its turn ended well', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    const turnId = taken(S(1));
    say(S(1), turnId, 'Which order?', { questions: [{ title: 'Order?', options: ['Date', 'Name'] }] });
    end(S(1), turnId);
    await flush();
    const card = read(S(1)).items.find((item) => questionOf(item) !== null);
    expect(runtime.dismiss(S(1), card?.id ?? '')).toEqual({ status: 'dismissed' });
    await workflow.settled();
    expect(planStore.get(planId)).toBeNull();
  });

  it('readies the plan in the chats left where the interrupted implementation’s chat is removed or marked Done, and keeps it interrupted where it is shelved (the maintainer)', async () => {
    for (const how of ['shelve', 'complete', 'remove'] as const) {
      place([session(1), session(2)]);
      open();
      const planId = await codexPlan(S(1));
      await bring(S(2), planId);
      expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
      end(S(1), taken(S(1)), 'interrupted');
      await flush();
      await service.settled();
      expect(waitOf(S(2))).toBe('implementation');
      expect(await service[how](S(1))).toEqual({ status: 'saved' });
      await flush();
      await workflow.settled();
      if (how === 'shelve') expect(workflow.view(planId)).toMatchObject({ state: 'interrupted' });
      else {
        // Ready again in the chat left, never said implemented, and the chat gone or Done out of it.
        expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1, holder: null, participants: [S(2)] });
        expect([attention(S(2)), waitOf(S(2))]).toEqual(['plan', undefined]);
        if (how === 'complete') expect([part(S(1)), waitOf(S(1))]).toEqual([null, undefined]);
        expect(await decide(S(2), planId, 'execute')).toEqual({ status: 'decided' });
      }
      await workflow.settled();
      runtime.dispose();
      await service.settled();
      service.stop();
      conversations.close();
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(path.join(tmpdir(), 'fatg-workflow-'));
    }
  });

  it('keeps a plan whose only chat, carrying it out, is removed among the project’s plans, to be brought again (the maintainer)', async () => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    end(S(1), taken(S(1)), 'interrupted');
    await flush();
    await service.settled();
    expect(await service.remove(S(1))).toEqual({ status: 'saved' });
    await flush();
    await workflow.settled();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1, holder: null, participants: [] });
    expect(plans.list(PROJECT)).toEqual([expect.objectContaining({ planId, state: 'ready', participants: 0 })]);
    await bring(S(2), planId);
    expect(attention(S(2))).toBe('plan');
    expect(await decide(S(2), planId, 'execute')).toEqual({ status: 'decided' });
  });
});

// ── What each chat shows ────────────────────────────────────────────────────────────────────

describe('what each chat of a plan shows (decision 0029; the maintainer)', () => {
  it('reads PLAN READY in every chat while the plan is ready, and what the others wait on while one chat or the reviewer holds it', async () => {
    place([session(1), session(2), session(3)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    await bring(S(3), planId);
    for (const id of [S(1), S(2), S(3)]) expect([attention(id), waitOf(id)]).toEqual(['plan', undefined]);

    // Under review: the reviewer's own PLAN REVIEW, and every chat of the plan waiting on it.
    const { reviewId, reviewer } = await reviewed(S(2), planId);
    expect([attention(reviewer), waitOf(reviewer)]).toEqual(['review', undefined]);
    for (const id of [S(1), S(2), S(3)]) {
      expect(attention(id)).not.toBe('plan');
      expect(waitOf(id)).toBe('review');
    }

    // Being revised in the third, which shows its own turn; the others wait on the revision.
    reviews.mark({ reviewId, tier: 1, mark: 'accepted' });
    reviews.mark({ reviewId, tier: 2, mark: 'rejected' });
    expect(await within(S(3), () => reviews.integrate({ reviewId, target: { sessionId: S(3) } }))).toMatchObject({ status: 'sent' });
    expect([waitOf(S(1)), waitOf(S(2)), waitOf(S(3))]).toEqual(['revision', 'revision', undefined]);
    const writing = taken(S(3));
    emit(proc(S(3)), { type: 'plan-completed', turnId: writing, itemId: 'plan-v2', text: PLAN_V2 });
    end(S(3), writing);
    await flush();
    for (const id of [S(1), S(2), S(3)]) expect([attention(id), waitOf(id)]).toEqual(['plan', undefined]);

    // Carried out from the first: the others wait on its implementation, an interrupted one's too.
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    expect([waitOf(S(1)), waitOf(S(2)), waitOf(S(3))]).toEqual([undefined, 'implementation', 'implementation']);
    for (const id of [S(1), S(2), S(3)]) expect(attention(id)).not.toBe('plan');
    end(S(1), taken(S(1)), 'interrupted');
    await flush();
    expect(workflow.view(planId)).toMatchObject({ state: 'interrupted' });
    expect([waitOf(S(1)), waitOf(S(2)), waitOf(S(3))]).toEqual([undefined, 'implementation', 'implementation']);

    // Implemented: nothing of the plan shows any more.
    expect(await within(S(1), () => runtime.send(S(1), 'Go on.'))).toEqual({ status: 'accepted' });
    end(S(1), taken(S(1)));
    await flush();
    await workflow.settled();
    expect(planStore.get(planId)).toBeNull();
    for (const id of [S(1), S(2), S(3)]) expect([attention(id) === 'plan', waitOf(id)]).toEqual([false, undefined]);
  });

  it('shows nothing in a chat that left the plan, nor anywhere once it is discarded, and shows it again after a restart', async () => {
    place([session(1), session(2), session(3)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    await bring(S(3), planId);
    expect(await decide(S(3), planId, 'leave')).toEqual({ status: 'decided' });
    expect([attention(S(3)) === 'plan', waitOf(S(3))]).toEqual([false, undefined]);
    const { reviewId } = await reviewed(S(2), planId);
    expect([waitOf(S(1)), waitOf(S(2)), waitOf(S(3))]).toEqual(['review', 'review', undefined]);

    // A restart holds no summary of it: the launch shows it again.
    await workflow.settled();
    await service.settled();
    conversations.close();
    open();
    await workflow.launched();
    expect([waitOf(S(1)), waitOf(S(2)), waitOf(S(3))]).toEqual(['review', 'review', undefined]);

    // The review cancelled: ready again in every chat of the plan.
    expect(await reviews.close({ reviewId, as: 'cancel' })).toEqual({ status: 'closed' });
    await flush();
    await workflow.settled();
    expect([attention(S(1)), attention(S(2)), attention(S(3)) === 'plan']).toEqual(['plan', 'plan', false]);

    expect(await decide(S(2), planId, 'cancel')).toEqual({ status: 'decided' });
    for (const id of [S(1), S(2), S(3)]) expect([attention(id) === 'plan', waitOf(id)]).toEqual([false, undefined]);
  });

  it('names a chat that has none after the plan brought into it, and leaves a named one as it is', async () => {
    place([session(1), session(2, { name: null, nameSource: null }), session(3)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    await bring(S(3), planId);
    await service.settled();
    expect(service.record(S(2))).toMatchObject({ name: planChatName(TITLE), nameSource: 'generated' });
    expect(service.record(S(3))).toMatchObject({ name: 'Chat 3', nameSource: 'user' });
    // Its name is no log's.
    const said = [...log.info.mock.calls, ...log.warn.mock.calls].flat().map(String).join('\n');
    expect(said).not.toContain(TITLE);
  });
});

// ── Removal and restart ─────────────────────────────────────────────────────────────────────

describe('removal and a restart (decision 0029)', () => {
  it('detaches a chat that is removed, and readies the plan where the chat writing it is removed', async () => {
    place([session(1), session(2), session(3)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    await bring(S(3), planId);
    expect(await service.remove(S(3))).toEqual({ status: 'saved' });
    await flush();
    expect(workflow.view(planId)).toMatchObject({ participants: [S(1), S(2)] });
    expect(await decide(S(2), planId, 'feedback', 'Shorter.')).toEqual({ status: 'decided' });
    taken(S(2));
    await service.settled();
    // A running chat is stopped before it is removed: here its turn ends with its process.
    proc(S(2)).end();
    await flush();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1 });
    expect(await service.remove(S(2))).toEqual({ status: 'saved' });
    await flush();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', participants: [S(1)] });
  });

  it('reads every chat’s part the same across a restart, and recovers each operation from the disk', async () => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    const before = [part(S(1)), part(S(2))];
    await workflow.settled();
    await service.settled();
    conversations.close();
    open();
    await workflow.launched();
    expect([part(S(1)), part(S(2))]).toEqual(before);

    // A revision a restart found running is ready again on the version before.
    expect(await decide(S(2), planId, 'feedback', 'Shorter.')).toEqual({ status: 'decided' });
    await service.settled();
    conversations.close();
    open();
    await workflow.launched();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1 });

    // An implementation whose turn a restart found ended well is implemented, and the plan deleted:
    // here the write that said so failed, which kept every other decision waiting meanwhile.
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    const turnId = taken(S(1));
    failing = 'record';
    end(S(1), turnId);
    await flush();
    failing = null;
    expect(workflow.view(planId)).toMatchObject({ state: 'implementing' });
    expect(await decide(S(2), planId, 'execute')).toMatchObject({ status: 'refused', reason: 'locked' });
    await service.settled();
    conversations.close();
    open();
    await workflow.launched();
    expect(planStore.get(planId)).toBeNull();
    expect(part(S(2))).toMatchObject({ kind: 'implemented', sessionId: S(1) });
  });

  it('cancels a review whose reviewer a restart no longer lists, and the plan is ready again in every chat (the maintainer)', async () => {
    place([session(1), session(2), session(3)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    await bring(S(3), planId);
    const { reviewId, reviewer } = await reviewed(S(2), planId);
    expect([waitOf(S(1)), waitOf(S(2)), waitOf(S(3))]).toEqual(['review', 'review', 'review']);
    await workflow.settled();
    await service.settled();
    runtime.dispose();
    service.stop();
    conversations.close();
    // The records started over without the reviewer, as the stream form's do at each start.
    place([session(1), session(2), session(3)]);
    open();
    expect(service.record(reviewer)).toBeUndefined();
    await workflow.launched();
    await workflow.settled();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', holder: null, participants: [S(1), S(2), S(3)] });
    expect(planStore.review(planId, reviewId)).toMatchObject({ state: 'closed', closed: 'cancelled' });
    for (const id of [S(1), S(2), S(3)]) expect([attention(id), waitOf(id)]).toEqual(['plan', undefined]);
  });

  it.each([
    ['still running', null],
    ['interrupted', 'interrupted'],
  ] as const)('readies a plan whose implementing chat a restart no longer lists, its turn %s, in every chat left (the maintainer)', async (_how, outcome) => {
    place([session(1), session(2), session(3)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    await bring(S(3), planId);
    expect(await decide(S(3), planId, 'execute')).toEqual({ status: 'decided' });
    const turnId = taken(S(3));
    if (outcome !== null) {
      end(S(3), turnId, outcome);
      await flush();
      expect(workflow.view(planId)).toMatchObject({ state: 'interrupted' });
    }
    expect([waitOf(S(1)), waitOf(S(2))]).toEqual(['implementation', 'implementation']);
    await workflow.settled();
    await service.settled();
    runtime.dispose();
    service.stop();
    conversations.close();
    // The records started over without the chat carrying it out.
    place([session(1), session(2)]);
    open();
    await workflow.launched();
    await workflow.settled();
    expect(workflow.view(planId)).toMatchObject({ state: 'ready', version: 1, holder: null, participants: [S(1), S(2)] });
    for (const id of [S(1), S(2)]) expect([attention(id), waitOf(id)]).toEqual(['plan', undefined]);
    // Either chat left may carry it out again.
    expect(await decide(S(2), planId, 'execute')).toEqual({ status: 'decided' });
  });

  it('reads an implementation a restart cut short as interrupted, its chat still holding it — a worker of it still running among them', async () => {
    place([session(1)]);
    open();
    const planId = await codexPlan(S(1));
    expect(await decide(S(1), planId, 'execute')).toEqual({ status: 'decided' });
    const turnId = taken(S(1));
    // Its turn ended well, but a worker of it still ran when fat-g ended: no success is established.
    emit(proc(S(1)), { type: 'worker-started', workerId: 'w1' });
    end(S(1), turnId);
    await flush();
    await service.settled();
    conversations.close();
    open();
    await workflow.launched();
    expect(workflow.view(planId)).toMatchObject({ state: 'interrupted', holder: { sessionId: S(1) } });
  });
});

describe('what is kept apart (decision 0029)', () => {
  it('logs no plan’s text or title, and its push names ids alone', async () => {
    place([session(1), session(2)]);
    open();
    const planId = await codexPlan(S(1));
    await bring(S(2), planId);
    await decide(S(1), planId, 'execute');
    end(S(1), taken(S(1)));
    await flush();
    await workflow.settled();
    const said = [...log.info.mock.calls, ...log.warn.mock.calls].flat().map(String).join('\n');
    expect(said).not.toContain(TITLE);
    expect(said).not.toContain('Read them');
    expect(Object.keys(workflow.counts()).join(' ')).not.toContain(TITLE);
    expect(attention(S(1))).not.toBe('plan');
  });
});


it('notifies once for a new plan version, not for another participant or recovery', async () => {
  place([session(1), session(2)]); open();
  const planId = await codexPlan(S(1));
  expect(planReady).toHaveBeenCalledExactlyOnceWith(planId, 1);
  await bring(S(2), planId);
  await workflow.launched();
  expect(planReady).toHaveBeenCalledOnce();
});
