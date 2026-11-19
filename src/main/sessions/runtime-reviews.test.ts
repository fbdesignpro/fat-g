// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3 (docs/planning/_archive/M22e.md, Design 3–7; C1–C3, C5, C8–C12, C23–C31, C34, C36, C38, C39, C43, C45–C53): plan
// review through the runtime, on a real records store, a real conversation store, a real plan store,
// the chat service, the session service, the request registry, the plan service and the review
// service, with a facet in the test's hands. No Electron, no process. The same against the replay
// fakes is in tests/codex/review.integration.test.ts and tests/claude/chat/review.integration.test.ts.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { ChatRead } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type PlanBody, planOf, questionOf } from '@shared/contracts/interaction';
import type { ModeAvailability, PermissionCapability } from '@shared/contracts/permissions';
import { type PlanCapability, planBlock } from '@shared/contracts/plans';
import { type Finding, integrationText, type ReviewPush, type ReviewView, reviewPrompt, sendNotesPrompt } from '@shared/contracts/review';
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
import { createReviewService, OFFER_WORDS, type ReviewService } from './reviews';
import type { PresetAdmission } from './preset-admission';
import type { ModelPreset } from '@shared/contracts/presets';
import { createSessionRuntime, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet, type FakeSession } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';
import { createWorkflowCoordinator, type WorkflowCoordinator } from './workflow';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-02-09T13:00:00.000Z');
const TOKEN = 'abcdef012345';
const PLAN_TEXT = '# Tidy the notes\n\n## Steps\n\n1. Read them.\n2. Tidy them.';

const mode = (id: string, label: string, patch: Partial<PermissionCapability['modes'][number]> = {}) => ({ id, label, description: `What ${label} lets run.`, asks: true, reading: false, transitionsFrom: [], ...patch });
const CAPABILITY: PermissionCapability = {
  modes: [mode('read-only', 'Read only', { asks: false, reading: true }), mode('ask-first', 'Ask first'), mode('edits-ok', 'Edits ok')],
  fallback: 'ask-first',
  setup: null,
  inherited: 'Rules of your own configuration act as it lets them.',
  rules: 'This CLI lists no rules.',
};
const PLANS: PlanCapability = { modes: ['ask-first', 'edits-ok'], unavailable: 'Read only takes no plan turn.' };
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
let pushes: ReviewPush[];
/** What the host's preset check says; null admits every preset. */
let admission: PresetAdmission | null;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const modelUsed = vi.fn();
const roundReady = vi.fn();

beforeEach(() => {
  modelUsed.mockReset();
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-reviews-'));
  ids = 0;
  clock = { wall: AT, mono: 5_000 };
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
const project = { id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [root], permissionModes: {} };
const place = (sessions: unknown[]) => writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [project], sessions }));

function open(): void {
  roundReady.mockClear();
  runtime?.dispose();
  service?.stop();
  records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', now: () => AT, log });
  appState = createAppStateStore();
  fake = fakeFacet({ history: false, plans: {}, permissions: { modes: () => CAPABILITY.modes.map((entry) => available(entry.id)) } });
  conversations?.close();
  conversations = createConversationStore({ dir, log, now: () => clock.wall });
  planStore = createPlanStore({ dir: path.join(dir, 'plans'), now: () => clock.wall, log });
  planStore.recover(new Set([PROJECT]));
  conversations.unfinishPlans(clock.wall);
  let ready = false;
  chat = createChatService({
    store: conversations, log, now: () => clock.wall,
    requests: { pending: (sessionId, itemId) => ready && runtime.requests.pending(sessionId, itemId), waiting: (sessionId) => (ready ? runtime.requests.waiting(sessionId) : []), view: (sessionId, itemId) => (ready ? runtime.requests.view(sessionId, itemId) : null) },
    processKey: (sessionId) => (ready ? runtime.processKey(sessionId) : null),
  });
  pushes = [];
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
    modelUsed,
    sessions: service, records, chat, gate, log, now: () => clock.wall, monotonic: () => clock.mono, newId: () => `id-${++ids}`,
    facet: () => fake.facet, providerName: () => 'Codex', hasHistory: () => false, questions: () => 'both',
    asides: () => ({ followUp: true, streamed: true, tools: 'none' }),
    store: conversations, removal, permissions, plans, planCapability: () => PLANS,
    reviews: () => (ready ? reviews : undefined),
    get workflow() { return ready ? workflow : undefined; },
  });
  workflow = createWorkflowCoordinator({
    store: planStore, conversations, chat,
    host: { record: (id) => service.record(id), name: (id) => service.record(id)?.name ?? null, running: (id) => service.isRunning(id), quitting: () => runtime.quitting() },
    runtime: () => (ready ? runtime : undefined), reviews: () => (ready ? reviews : undefined), lines: () => plans,
    now: () => clock.wall, newId: () => `wf-${++ids}`, token: () => TOKEN, log,
  });
  admission = null;
  reviews = createReviewService({
    onRoundReady: roundReady,
    store: planStore, conversations,
    host: {
      record: (id) => service.record(id), name: (id) => service.record(id)?.name ?? null, running: (id) => service.isRunning(id), quitting: () => runtime.quitting(),
      admit: (_projectId, preset) => admission ?? { ok: true, preset },
      create: (projectId, preset, name) => service.create(projectId, preset, name),
      remove: (id) => removal.run([id], () => service.remove(id), (answer) => answer.status === 'saved'),
      folder: (record) => gate.folder(record),
      complete: (id) => service.complete(id),
      runtime,
    },
    workflow,
    push: (push) => { pushes.push(push); }, now: () => clock.wall, newId: () => `rv-${++ids}`, token: () => TOKEN, log,
  });
  ready = true;
  service.availabilityChanged();
}

/** The preset a review starts on in these tests: the chat's own, as the popup preselects it. */
const chatPreset = (id: string): ModelPreset => {
  const record = service.record(id);
  return record === undefined ? { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null } : { providerId: record.providerId, instanceId: record.instanceId, model: record.model, effort: record.effort, speed: null };
};
const read = (id: string): ChatRead => { const answer = runtime.read(id); if (answer.status !== 'read') throw new Error(answer.reason); return answer; };
const planLine = (id: string): ConversationItem => { const found = read(id).items.filter((item) => planOf(item) !== null).at(-1); if (found === undefined) throw new Error('no plan line'); return found; };
const body = (item: ConversationItem): PlanBody => planOf(item) as PlanBody;
const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };
const emit = (from: FakeSession, event: AgentEvent): void => from.emit(event);
/** The turn just sent on a session, taken by the provider. */
function taken(from: FakeSession, reference: string): string {
  const turnId = from.sent.at(-1)?.turnId ?? '';
  if (from.options.mode !== null) emit(from, { type: 'in-force', turnId, mode: from.options.mode });
  emit(from, { type: 'session-started', reference, folder: ROOT });
  emit(from, { type: 'turn-started', turnId, providerTurnId: `p-${turnId}` });
  return turnId;
}
const end = (from: FakeSession, turnId: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed'): void => { emit(from, { type: 'turn-ended', turnId, outcome, reported: true }); };
const say = (from: FakeSession, turnId: string, text: string, itemId = `msg-${++ids}`, extra: Partial<{ phase: 'final' | 'commentary'; questions: { title: string; options: string[] }[] }> = {}): void => {
  emit(from, { type: 'message', turnId, role: 'assistant', itemId, phase: extra.phase ?? 'final', text, questions: extra.questions ?? [] });
};

const finding = (id: string, patch: Partial<Finding> = {}): Finding => ({ id, tier: Number(id.charAt(1)), category: 'PROD', title: `Title ${id}`, example: `Example ${id}.`, description: `Description ${id}.`, correction: `Correction ${id}.`, anchor: { heading: 'Steps', quote: 'Read them.' }, ...patch });
const block = (issues: readonly Finding[], version = 2): string => `\`\`\`json\n${JSON.stringify({ version, appraisal: 'One line on the plan.', issues }, null, 2)}\n\`\`\``;
const ROUND = [finding('T1.1'), finding('T2.1'), finding('T3.1')];

/** S(1)'s plan turn, its plan written and waiting, as Codex's waits: no request holds it. */
let doingWhilePlanning: string | null = null;
async function planned(): Promise<{ readonly planId: string; readonly turnId: string }> {
  expect(await runtime.send(S(1), 'Make a plan.', { plan: true })).toEqual({ status: 'accepted' });
  const from = fake.latest();
  const turnId = taken(from, 'thread-1');
  // While it runs, the chat says it writes a plan (M22e): what a Remove's notice says.
  doingWhilePlanning = runtime.doing(S(1));
  emit(from, { type: 'plan-completed', turnId, itemId: 'plan_item', text: PLAN_TEXT });
  end(from, turnId);
  await flush();
  return { planId: body(planLine(S(1))).planId, turnId };
}

/** The workflow's revision, as the plan's panel would name it with a start. */
const revisionOf = (planId: string): number => workflow.view(planId)?.revision ?? 0;
const view = (reviewId: string): ReviewView => { const answer = reviews.read({ reviewId }); if (answer.status !== 'read') throw new Error(answer.status); return answer.review; };

/** A review started from S(1)'s waiting line, its first turn taken by the reviewer's process. */
async function started(): Promise<{ readonly planId: string; readonly reviewId: string; readonly reviewer: string; readonly from: FakeSession; readonly turnId: string }> {
  const { planId } = await planned();
  const answer = await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 1, revision: revisionOf(planId) });
  if (answer.status !== 'started') throw new Error(answer.reason);
  const from = fake.latest();
  return { planId, reviewId: answer.reviewId, reviewer: answer.sessionId, from, turnId: taken(from, 'thread-reviewer') };
}
/** A review whose first round arrived. */
async function withRound(issues: readonly Finding[] = ROUND) {
  const made = await started();
  say(made.from, made.turnId, `A short appraisal.\n\n${block(issues)}`);
  end(made.from, made.turnId);
  await flush();
  return made;
}

describe('starting a review (V3; C1, C2, C23, C26, C39, C52, C53)', () => {
  it('makes the reviewer on the chat’s preset under the reading mode, named and selected, and sends fat-g’s prompt under a turn written first', async () => {
    place([session(1)]);
    open();
    const { planId } = await planned();
    const answer = await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 1, revision: revisionOf(planId) });
    expect(answer).toMatchObject({ status: 'started' });
    if (answer.status !== 'started') return;
    const reviewer = service.record(answer.sessionId);
    expect(reviewer).toMatchObject({ projectId: PROJECT, providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', name: 'Review of Plan: Tidy the notes v1', nameSource: 'generated' });
    expect(service.snapshot().selectedId).toBe(answer.sessionId);
    // Under the reading mode, whatever the defaults say, saved as the chat's own.
    expect(runtime.chatMode(reviewer!)).toEqual({ id: 'read-only', source: 'chat' });
    expect(modelUsed).toHaveBeenCalledTimes(2);
    expect(modelUsed).toHaveBeenLastCalledWith({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null });
    const sent = fake.latest();
    expect(sent.options.mode).toBe('read-only');
    expect(sent.sent[0]?.prompt).toBe(reviewPrompt({ title: 'Tidy the notes', planId, version: 1, text: PLAN_TEXT, token: TOKEN, folder: ROOT }));
    expect(sent.sent[0]?.plan).toBeUndefined();
    // The prompt is kept with the review's fields, and the record names its turn.
    const prompt = read(answer.sessionId).items.find((item) => item.role === 'user');
    expect(prompt?.plan).toEqual({ planId, version: 1, intent: 'review' });
    expect(planStore.review(planId, answer.reviewId)).toMatchObject({ state: 'running', startedFrom: S(1), instruction: 2, reviewer: { sessionId: answer.sessionId, model: 'gpt-6-sol', effort: 'high' }, turns: [{ turnId: sent.sent[0]?.turnId, promptId: prompt?.id, kind: 'review', outcome: 'waiting' }] });
    // Its first prompt named nothing: the name is the review's still.
    expect(service.record(answer.sessionId)?.name).toBe('Review of Plan: Tidy the notes v1');
    expect(pushes.at(-1)).toEqual({ reviewId: answer.reviewId, planId, sessionId: answer.sessionId });
  });

  it('refuses a line that is not the plan and version named, a version a newer complete one has replaced, and an unknown chat', async () => {
    place([session(1)]);
    open();
    const { planId } = await planned();
    expect(await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 2, revision: revisionOf(planId) })).toEqual({ status: 'refused', reason: 'not-complete' });
    // A start drawn from an older state of the plan's workflow starts nothing (decision 0029).
    expect(await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 1, revision: revisionOf(planId) - 1 })).toEqual({ status: 'refused', reason: 'locked' });
    expect(await reviews.start({ sessionId: S(9), preset: chatPreset(S(9)), planId, version: 1, revision: revisionOf(planId) })).toEqual({ status: 'refused', reason: 'unknown-session' });
    // A newer complete version, written meanwhile in another chat (C52).
    planStore.write({ planId, projectId: PROJECT, title: 'Tidy the notes' }, { sessionId: S(1), turnId: 'other', providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', cause: 'feedback', revises: 1 }, '# Tidy v2');
    expect(await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 1, revision: revisionOf(planId) })).toEqual({ status: 'refused', reason: 'stale' });
    expect(fake.made).toHaveLength(1);
  });

  it('starts from a plan brought into another chat, after the chat that made it is removed (C23)', async () => {
    place([session(1), session(2)]);
    open();
    const { planId } = await planned();
    const hash = planStore.get(planId)?.versions[0]?.hash ?? '';
    // The line in S(1) is cancelled, and its chat removed: the plan stays in the registry.
    expect(await runtime.decidePlan(S(1), planLine(S(1)).id, 'cancel')).toEqual({ status: 'decided' });
    expect(await runtime.bringPlan(S(2), { planId, version: 1, hash })).toMatchObject({ status: 'brought' });
    await service.remove(S(1));
    await flush();
    const answer = await reviews.start({ sessionId: S(2), preset: chatPreset(S(2)), planId, version: 1, revision: revisionOf(planId) });
    expect(answer).toMatchObject({ status: 'started' });
  });

  it('makes the reviewer on the preset chosen, not the chat’s, and keeps that one in the review', async () => {
    place([session(1)]);
    open();
    const { planId } = await planned();
    const chosen = { ...chatPreset(S(1)), effort: 'low' };
    const answer = await reviews.start({ sessionId: S(1), preset: chosen, planId, version: 1, revision: revisionOf(planId) });
    if (answer.status !== 'started') throw new Error(answer.reason);
    expect(service.record(answer.sessionId)).toMatchObject({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'low' });
    expect(planStore.review(planId, answer.reviewId)?.reviewer).toEqual({ sessionId: answer.sessionId, providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'low' });
    expect(view(answer.reviewId).reviewer).toMatchObject({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'low' });
  });

  it('starts nothing on a preset a new chat would refuse, and says why', async () => {
    place([session(1)]);
    open();
    const { planId } = await planned();
    const before = service.snapshot().sessions.length;
    admission = { ok: false, reason: 'model-not-listed' };
    expect(await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 1, revision: revisionOf(planId) })).toEqual({ status: 'refused', reason: 'model-not-listed' });
    expect(service.snapshot().sessions).toHaveLength(before);
    expect(planStore.reviews(planId)).toEqual([]);
  });
});

describe('a review’s turns and rounds (V3; C5, C25, C43, C49, C55)', () => {
  it('reads the turn’s `final` answer, a commentary before it passed over, as the first round; marks open', async () => {
    place([session(1)]);
    open();
    const { from, turnId, reviewId, planId, reviewer } = await started();
    // While it runs, the reviewer says it writes its review (M22e): what a Remove's notice says.
    expect(runtime.doing(reviewer)).toBe('review');
    expect(doingWhilePlanning).toBe('plan');
    say(from, turnId, 'I will read the project first.', 'commentary-1', { phase: 'commentary' });
    say(from, turnId, `Two sentences.\n\n${block(ROUND)}`, 'final-1');
    end(from, turnId);
    await flush();
    const review = view(reviewId);
    expect(review).toMatchObject({ state: 'findings', failure: null, live: true, closed: null, concludable: false });
    expect(review.rounds).toHaveLength(1);
    expect(review.rounds[0]).toMatchObject({ appraisal: 'One line on the plan.', marks: { 'T1.1': 'open', 'T2.1': 'open', 'T3.1': 'open' }, live: true });
    // The answer named by fat-g's own item id.
    const final = read(review.reviewer.sessionId).items.find((item) => item.providerItemId === 'final-1');
    expect(review.turns[0]).toMatchObject({ outcome: 'round', answerId: final?.id });
    // The anchor found under its heading, by its quote.
    expect(review.anchors).toEqual({ 'T1.1': { line: 5 }, 'T2.1': { line: 5 }, 'T3.1': { line: 5 } });
    expect(planStore.review(planId, reviewId)?.endedAt).toBe(AT);
  });

  // The maintainer: one finding that does not read is set aside, and the rest is the round.
  it('reads a first answer with a finding that does not read as a round of the others, a field past its asked length whole', async () => {
    place([session(1)]);
    open();
    const first = await started();
    const { correction: _correction, ...broken } = finding('T1.1');
    say(first.from, first.turnId, `Two sentences.\n\n${block([broken, finding('T2.1', { correction: 'x'.repeat(5_000) }), finding('T3.1')] as Finding[])}`);
    end(first.from, first.turnId);
    await flush();
    const review = view(first.reviewId);
    expect(review).toMatchObject({ state: 'findings', failure: null });
    expect(review.rounds[0]?.findings.map((one) => one.id)).toEqual(['T2.1', 'T3.1']);
    expect(review.rounds[0]?.findings[0]?.correction).toHaveLength(5_000);
  });

  it('fails the review on a first answer whose findings none reads, `invalid`', async () => {
    place([session(1)]);
    open();
    const first = await started();
    const { correction: _correction, ...broken } = finding('T1.1');
    say(first.from, first.turnId, `Two sentences.\n\n${block([broken] as Finding[])}`);
    end(first.from, first.turnId);
    await flush();
    expect(view(first.reviewId)).toMatchObject({ state: 'failed', failure: 'invalid', turns: [{ outcome: 'failed', reason: 'invalid' }] });
  });

  it('fails the review on a first answer that brings no round, with its reason, and on a turn that ends with no answer', async () => {
    place([session(1)]);
    open();
    const first = await started();
    say(first.from, first.turnId, 'Findings in prose only.');
    end(first.from, first.turnId);
    await flush();
    expect(view(first.reviewId)).toMatchObject({ state: 'failed', failure: 'no-block', turns: [{ outcome: 'failed', reason: 'no-block' }] });
  });

  it.each([['failed', 'turn-failed'], ['interrupted', 'stopped'], ['completed', 'no-answer']] as const)('fails it by a turn that ends %s, as `%s`', async (outcome, reason) => {
    place([session(1)]);
    open();
    const made = await started();
    end(made.from, made.turnId, outcome);
    await flush();
    expect(view(made.reviewId)).toMatchObject({ state: 'failed', failure: reason });
  });

  it('takes no prompt of the user’s own in the reviewer while its review is open: a hard stop (decision 0029)', async () => {
    place([session(1)]);
    open();
    const made = await withRound();
    const before = view(made.reviewId);
    const sends = made.from.sent.length;
    expect(await runtime.send(made.reviewer, 'Why T2.1?')).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(made.from.sent).toHaveLength(sends);
    expect(view(made.reviewId).rounds).toEqual(before.rounds);
    expect(view(made.reviewId).turns).toEqual(before.turns);
    // Once it is closed, the reviewer is a chat as any, its plain composer's turns none of the review's (C25).
    expect(await reviews.close({ reviewId: made.reviewId, as: 'cancel' })).toEqual({ status: 'closed' });
    await service.restore(made.reviewer);
    expect(await runtime.send(made.reviewer, 'Why T2.1?')).toEqual({ status: 'accepted' });
    const turnId = made.from.sent.at(-1)?.turnId ?? '';
    emit(made.from, { type: 'turn-started', turnId, providerTurnId: 'p-plain' });
    say(made.from, turnId, `Because.\n\n${block([finding('T1.1')])}`);
    end(made.from, turnId);
    await flush();
    expect(view(made.reviewId).rounds.map((round) => round.findings)).toEqual(before.rounds.map((round) => round.findings));
    expect(view(made.reviewId).turns).toHaveLength(before.turns.length);
  });

  it('waits `asked` on a Codex card’s questions, and reads the answer’s turn as the review’s (C49)', async () => {
    place([session(1)]);
    open();
    const made = await started();
    say(made.from, made.turnId, 'One question before I review.', 'ask-1', { questions: [{ title: 'Which tests matter?', options: ['Unit', 'All'] }] });
    end(made.from, made.turnId);
    await flush();
    expect(view(made.reviewId)).toMatchObject({ state: 'running', turns: [{ outcome: 'asked' }] });
    const card = read(made.reviewer).items.find((item) => questionOf(item) !== null);
    expect(await runtime.answer(made.reviewer, card?.id ?? '', [{ question: 0, options: [0], text: null }])).toEqual({ status: 'answered' });
    const answerTurn = made.from.sent.at(-1)?.turnId ?? '';
    expect(view(made.reviewId).turns).toMatchObject([{ outcome: 'asked' }, { turnId: answerTurn, kind: 'review', outcome: 'waiting', continues: made.turnId }]);
    emit(made.from, { type: 'turn-started', turnId: answerTurn, providerTurnId: 'p-answer' });
    say(made.from, answerTurn, block(ROUND));
    end(made.from, answerTurn);
    await flush();
    expect(view(made.reviewId)).toMatchObject({ state: 'findings', turns: [{ outcome: 'asked' }, { outcome: 'round' }] });
  });

  it('reads the findings of a turn whose model asked during its work and went on: the card is passed at the end, no turn `asked` (decision 0026, item 11)', async () => {
    place([session(1)]);
    open();
    const made = await started();
    say(made.from, made.turnId, 'Which tests matter?\n- Unit\n- All', 'ask-1', { phase: 'commentary', questions: [{ title: 'Which tests matter?', options: ['Unit', 'All'] }] });
    say(made.from, made.turnId, block(ROUND));
    end(made.from, made.turnId);
    await flush();
    expect(view(made.reviewId)).toMatchObject({ state: 'findings', turns: [{ outcome: 'round' }] });
    expect(read(made.reviewer).items.find((item) => questionOf(item) !== null)?.interaction?.outcome).toBe('passed');
  });

  it('ends an asked turn with no answer where its card is dismissed, or passed by a plain-composer prompt (C49)', async () => {
    place([session(1)]);
    open();
    const made = await started();
    say(made.from, made.turnId, 'One question first.', 'ask-1', { questions: [{ title: 'Which?', options: ['A', 'B'] }] });
    end(made.from, made.turnId);
    await flush();
    const card = read(made.reviewer).items.find((item) => questionOf(item) !== null);
    expect(runtime.dismiss(made.reviewer, card?.id ?? '')).toEqual({ status: 'dismissed' });
    expect(view(made.reviewId)).toMatchObject({ state: 'failed', failure: 'no-answer' });
  });

  it('refuses a plain-composer prompt while a card of the review waits: the card is answered, dismissed, or the review cancelled', async () => {
    place([session(1)]);
    open();
    const made = await started();
    say(made.from, made.turnId, 'One question first.', 'ask-1', { questions: [{ title: 'Which?', options: ['A', 'B'] }] });
    end(made.from, made.turnId);
    await flush();
    expect(await runtime.send(made.reviewer, 'Never mind the question.')).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(view(made.reviewId)).toMatchObject({ state: 'running', turns: [{ outcome: 'asked' }] });
  });

  it('ends a review `stopped` when its reviewer is removed while it runs, waiting on its card; its record stays with the plan, the plan ready again', async () => {
    place([session(1)]);
    open();
    const made = await started();
    say(made.from, made.turnId, 'One question first.', 'ask-1', { questions: [{ title: 'Which?', options: ['A', 'B'] }] });
    end(made.from, made.turnId);
    await flush();
    expect(workflow.view(made.planId)).toMatchObject({ state: 'reviewing', reviewId: made.reviewId });
    expect(await service.remove(made.reviewer)).toEqual({ status: 'saved' });
    await flush();
    expect(view(made.reviewId)).toMatchObject({ state: 'failed', failure: 'stopped', reviewer: { chat: null } });
    expect(workflow.view(made.planId)).toMatchObject({ state: 'ready', version: 1, reviewId: null });
  });

  it.each(['remove', 'shelve', 'complete'] as const)('cancels a review whose findings wait when its reviewer is %sd (decision 0029)', async (how) => {
    place([session(1)]);
    open();
    const made = await withRound();
    // Its reference written first: a session with none has nothing to shelve.
    await service.settled();
    expect(await service[how](made.reviewer)).toEqual({ status: 'saved' });
    await workflow.settled();
    await flush();
    expect(planStore.review(made.planId, made.reviewId)).toMatchObject({ state: 'closed', closed: 'cancelled' });
    expect(workflow.view(made.planId)).toMatchObject({ state: 'ready', reviewId: null });
  });
});

describe('marks, notes and Send notes (V3; C8, C28–C31, C46)', () => {
  it('writes a mark, a tier’s marks and a note at once, and refuses an unknown finding', async () => {
    place([session(1)]);
    open();
    const { reviewId, planId } = await withRound();
    expect(reviews.mark({ reviewId, findingId: 'T1.1', mark: 'accepted' })).toEqual({ status: 'saved', marks: { 'T1.1': 'accepted', 'T2.1': 'open', 'T3.1': 'open' } });
    expect(reviews.mark({ reviewId, tier: 3, mark: 'rejected' })).toMatchObject({ marks: { 'T3.1': 'rejected' } });
    expect(reviews.mark({ reviewId, findingId: 'T5.1', mark: 'accepted' })).toEqual({ status: 'refused', reason: 'unknown-finding' });
    expect(reviews.mark({ reviewId, tier: 4, mark: 'accepted' })).toEqual({ status: 'refused', reason: 'unknown-finding' });
    expect(reviews.note({ reviewId, findingId: 'T2.1', note: 'Why T2?' })).toEqual({ status: 'saved' });
    expect(planStore.review(planId, reviewId)?.marks).toEqual({ 'T1.1': { mark: 'accepted', note: '', revised: false }, 'T2.1': { mark: 'open', note: 'Why T2?', revised: false }, 'T3.1': { mark: 'rejected', note: '', revised: false } });
  });

  it('reads PLAN REVIEW on the reviewer while its triage panel stands, and lets go of it as the review closes', async () => {
    place([session(1)]);
    open();
    const { reviewId } = await withRound();
    const reviewer = view(reviewId).reviewer.sessionId;
    const attention = (): string | undefined => service.snapshot().sessions.find((entry) => entry.record.id === reviewer)?.summary.attention?.kind;
    expect(attention()).toBe('review');
    await service.select(reviewer);
    service.acknowledge(reviewer);
    reviews.mark({ reviewId, findingId: 'T1.1', mark: 'accepted' });
    expect(service.snapshot().sessions.find((entry) => entry.record.id === reviewer)?.summary.attention).toEqual({ kind: 'review', count: 1, acknowledged: false });
    expect(await reviews.close({ reviewId, as: 'cancel' })).toEqual({ status: 'closed' });
    expect(attention()).not.toBe('review');
  });

  it('Send notes: the turn written waiting with its notes, the fields emptied, fat-g’s prompt sent; the round carries by `was` (C29, C31)', async () => {
    place([session(1)]);
    open();
    const made = await withRound();
    reviews.mark({ reviewId: made.reviewId, findingId: 'T1.1', mark: 'accepted' });
    reviews.note({ reviewId: made.reviewId, findingId: 'T2.1', note: 'This is minor.' });
    expect(await reviews.send({ reviewId: made.reviewId })).toEqual({ status: 'sent' });
    const sent = made.from.sent.at(-1);
    expect(sent?.prompt).toBe(sendNotesPrompt({ findings: ROUND, marks: { 'T1.1': 'accepted', 'T2.1': 'open', 'T3.1': 'open' }, notes: { 'T2.1': 'This is minor.' } }));
    const held = view(made.reviewId);
    expect(held.turns.at(-1)).toMatchObject({ kind: 'notes', outcome: 'waiting' });
    expect(held.rounds[0]?.notes).toEqual({});
    // Refused while a turn of the review waits.
    expect(await reviews.send({ reviewId: made.reviewId })).toEqual({ status: 'refused', reason: 'no-note' });
    reviews.note({ reviewId: made.reviewId, findingId: 'T3.1', note: 'And this?' });
    expect(await reviews.send({ reviewId: made.reviewId })).toEqual({ status: 'refused', reason: 'turn-waiting' });
    // The round moves T2.1 down a tier, under a new id naming `was`.
    const turnId = sent?.turnId ?? '';
    emit(made.from, { type: 'turn-started', turnId, providerTurnId: 'p-notes' });
    say(made.from, turnId, `T2.1 moves to T4.\n\n${block([finding('T1.1'), finding('T4.1', { was: 'T2.1', title: 'Title T2.1' }), finding('T3.1')])}`);
    end(made.from, turnId);
    await flush();
    const after = view(made.reviewId);
    expect(after.rounds).toHaveLength(2);
    expect(after.rounds[0]).toMatchObject({ live: false, marks: { 'T1.1': 'accepted', 'T2.1': 'open' }, notes: { 'T2.1': 'This is minor.' } });
    expect(after.rounds[1]).toMatchObject({ live: true, marks: { 'T1.1': 'accepted', 'T4.1': 'open', 'T3.1': 'open' }, notes: { 'T3.1': 'And this?' }, revised: ['T4.1'] });
  });

  // The maintainer: a finding sent again but unreadable stands as the round before had it.
  it('keeps a finding a later answer garbles as the round before had it, with its mark and note, and leaves out a new one with no id', async () => {
    place([session(1)]);
    open();
    const made = await withRound();
    reviews.mark({ reviewId: made.reviewId, findingId: 'T1.1', mark: 'accepted' });
    reviews.note({ reviewId: made.reviewId, findingId: 'T2.1', note: 'Why this tier?' });
    expect(await reviews.send({ reviewId: made.reviewId })).toEqual({ status: 'sent' });
    reviews.note({ reviewId: made.reviewId, findingId: 'T1.1', note: 'Kept with it.' });
    const turnId = made.from.sent.at(-1)?.turnId ?? '';
    emit(made.from, { type: 'turn-started', turnId, providerTurnId: 'p-notes' });
    const { correction: _correction, ...garbled } = finding('T1.1', { title: 'A new title' });
    const { id: _id, ...unnumbered } = finding('T4.1');
    say(made.from, turnId, `Garbled.\n\n${block([garbled, finding('T2.1'), finding('T3.1'), unnumbered] as Finding[])}`);
    end(made.from, turnId);
    await flush();
    const after = view(made.reviewId);
    expect(after.rounds).toHaveLength(2);
    expect(after.rounds[1]?.findings).toEqual([finding('T2.1'), finding('T3.1'), finding('T1.1')]);
    expect(after.rounds[1]).toMatchObject({ live: true, marks: { 'T1.1': 'accepted', 'T2.1': 'open', 'T3.1': 'open' }, notes: { 'T1.1': 'Kept with it.' }, revised: [] });
  });

  it('keeps the notes in their fields where the send is refused, and says a later answer with no round', async () => {
    place([session(1)]);
    open();
    const made = await withRound();
    reviews.note({ reviewId: made.reviewId, findingId: 'T1.1', note: 'Kept.' });
    // The review is a hard stop: the reviewer takes no prompt of the user's own (decision 0029).
    expect(await runtime.send(made.reviewer, 'Plan something.', { plan: true })).toEqual({ status: 'refused', reason: 'plan-pending' });
    expect(await reviews.send({ reviewId: made.reviewId })).toEqual({ status: 'sent' });
    const turnId = made.from.sent.at(-1)?.turnId ?? '';
    emit(made.from, { type: 'turn-started', turnId, providerTurnId: 'p-notes' });
    say(made.from, turnId, 'An answer in prose alone.');
    end(made.from, turnId);
    await flush();
    expect(view(made.reviewId)).toMatchObject({ state: 'findings', turns: [{ outcome: 'round' }, { outcome: 'no-round', reason: 'no-block' }] });
    expect(view(made.reviewId).rounds).toHaveLength(1);
  });

  it('Explain: an aside of the reviewer’s session on the whole finding, by fat-g’s words, marking nothing (C34, C54)', async () => {
    place([session(1)]);
    open();
    const made = await withRound();
    const answer = await reviews.explain({ reviewId: made.reviewId, findingId: 'T2.1', place: { range: { start: 10, end: 90 }, digest: '0123abcd' } });
    expect(answer).toMatchObject({ status: 'accepted' });
    expect(made.from.asked.at(-1)?.text).toContain('about finding T2.1 of your review');
    expect(made.from.asked.at(-1)?.text.endsWith('Explain this finding.')).toBe(true);
    expect(view(made.reviewId).rounds[0]?.marks['T2.1']).toBe('open');
    // The same finding again reopens its aside.
    const again = await reviews.explain({ reviewId: made.reviewId, findingId: 'T2.1', place: { range: { start: 10, end: 90 }, digest: '0123abcd' } });
    expect(again).toEqual(answer);
    expect(made.from.asked).toHaveLength(1);
  });
});

describe('integration (V3; C9–C11, C24, C27, C36, C38, C45, C47, C49–C51)', () => {
  /** A review with every finding decided: two accepted, one refused with a note. */
  async function decided() {
    const made = await withRound();
    reviews.mark({ reviewId: made.reviewId, findingId: 'T1.1', mark: 'accepted' });
    reviews.mark({ reviewId: made.reviewId, findingId: 'T2.1', mark: 'accepted' });
    reviews.mark({ reviewId: made.reviewId, findingId: 'T3.1', mark: 'rejected' });
    reviews.note({ reviewId: made.reviewId, findingId: 'T3.1', note: 'Out of scope.' });
    return made;
  }

  it('offers each target by its route: the plan’s line as feedback, the reviewer under Read only unavailable, a new session as a plan turn', async () => {
    place([session(1)]);
    open();
    const made = await decided();
    expect(view(made.reviewId).offers).toEqual([
      { target: { sessionId: S(1) }, name: 'Chat 1', roles: ['own', 'started'], route: 'decision', reason: null },
      { target: { sessionId: made.reviewer }, name: 'Review of Plan: Tidy the notes v1', roles: ['reviewer'], route: null, reason: `Read only takes no plan turn. ${OFFER_WORDS.changeMode}` },
      { target: 'new', name: null, roles: ['new'], route: 'plan-turn', reason: null },
    ]);
  });

  it('offers a brought line no request holds as feedback only where its chat’s mode takes a plan turn, and says the way out (C50)', async () => {
    place([session(1), session(2)]);
    open();
    const made = await decided();
    const hash = planStore.get(made.planId)?.versions[0]?.hash ?? '';
    expect(await runtime.setMode(S(2), 'read-only')).toEqual({ status: 'set' });
    expect(await runtime.bringPlan(S(2), { planId: made.planId, version: 1, hash })).toMatchObject({ status: 'brought' });
    // One review of a plan at a time (decision 0029): the first is cancelled before the second starts.
    expect(await reviews.start({ sessionId: S(2), preset: chatPreset(S(2)), planId: made.planId, version: 1, revision: revisionOf(made.planId) })).toEqual({ status: 'refused', reason: 'locked' });
    expect(await reviews.close({ reviewId: made.reviewId, as: 'cancel' })).toEqual({ status: 'closed' });
    // S(2) is no target of this review's: the review started in S(1). Its route, worked out as an offer's.
    const second = await reviews.start({ sessionId: S(2), preset: chatPreset(S(2)), planId: made.planId, version: 1, revision: revisionOf(made.planId) });
    if (second.status !== 'started') throw new Error(second.reason);
    const from = fake.latest();
    const turnId = taken(from, 'thread-second');
    say(from, turnId, block(ROUND));
    end(from, turnId);
    await flush();
    expect(view(second.reviewId).offers.find((offer) => offer.target !== 'new' && offer.target.sessionId === S(2))).toEqual({ target: { sessionId: S(2) }, name: 'Chat 2', roles: ['started'], route: null, reason: `Read only takes no plan turn. ${OFFER_WORDS.bringAgain}` });
  });

  it('ends an integration sent to a session that is removed, `removed`', async () => {
    place([session(1), session(2)]);
    open();
    const made = await decided();
    const answer = await reviews.integrate({ reviewId: made.reviewId, target: { preset: chatPreset(S(1)) } });
    if (answer.status !== 'sent') throw new Error(answer.reason);
    const target = fake.latest();
    end(target, target.sent.at(-1)?.turnId ?? '', 'interrupted');
    await flush();
    expect(view(made.reviewId).integrations[0]).toMatchObject({ state: 'ended', reason: 'no-plan' });
  });

  it('refuses while a finding waits, and with none accepted', async () => {
    place([session(1)]);
    open();
    const made = await withRound();
    expect(await reviews.integrate({ reviewId: made.reviewId, target: { sessionId: S(1) } })).toEqual({ status: 'refused', reason: 'undecided' });
    reviews.mark({ reviewId: made.reviewId, tier: 1, mark: 'rejected' });
    reviews.mark({ reviewId: made.reviewId, tier: 2, mark: 'rejected' });
    reviews.mark({ reviewId: made.reviewId, tier: 3, mark: 'rejected' });
    expect(await reviews.integrate({ reviewId: made.reviewId, target: { sessionId: S(1) } })).toEqual({ status: 'refused', reason: 'none-accepted' });
  });

  it('into the plan’s own chat: its line’s feedback, a plan turn with the text and the empty block; the next version caused `integration`', async () => {
    place([session(1)]);
    open();
    const made = await decided();
    const answer = await reviews.integrate({ reviewId: made.reviewId, target: { sessionId: S(1) } });
    expect(answer).toMatchObject({ status: 'sent', sessionId: S(1) });
    if (answer.status !== 'sent') return;
    const own = fake.made[0]!;
    const sent = own.sent.at(-1);
    const text = integrationText({ title: 'Tidy the notes', version: 1, findings: ROUND, marks: { 'T1.1': 'accepted', 'T2.1': 'accepted', 'T3.1': 'rejected' }, notes: { 'T3.1': 'Out of scope.' } });
    expect(sent).toMatchObject({ plan: true, prompt: `${text}\n\n${planBlock(made.planId, 1, '', TOKEN)}` });
    // Written before it was sent, naming the round and the turn it went by (C24, C51).
    expect(planStore.review(made.planId, made.reviewId)?.integrations[0]).toMatchObject({ state: 'sent', route: 'decision', round: made.turnId, accepted: ['T1.1', 'T2.1'], notes: { 'T3.1': 'Out of scope.' }, turns: [sent?.turnId], planItem: planLine(S(1)).id });
    expect(view(made.reviewId).live).toBe(false);
    // Sent, its findings no longer wait: the reviewer lets go of PLAN REVIEW.
    expect(service.snapshot().sessions.find((entry) => entry.record.id === view(made.reviewId).reviewer.sessionId)?.summary.attention?.kind).not.toBe('review');
    // One integration of a review at a time (C24, C47).
    expect(await reviews.integrate({ reviewId: made.reviewId, target: { preset: chatPreset(S(1)) } })).toEqual({ status: 'refused', reason: 'integrating' });
    const turnId = sent?.turnId ?? '';
    emit(own, { type: 'turn-started', turnId, providerTurnId: 'p-integrate' });
    // While it runs, the plan's chat says it evaluates the review's feedback (M22e).
    expect(runtime.doing(S(1))).toBe('integration');
    emit(own, { type: 'plan-completed', turnId, itemId: 'plan_item_2', text: '# Tidy the notes\n\n1. Read them, all.' });
    end(own, turnId);
    await flush();
    expect(planStore.get(made.planId)?.versions[1]).toMatchObject({ version: 2, cause: 'integration', revises: 1, integration: { reviewId: made.reviewId, integrationId: answer.integrationId, findings: ['T1.1', 'T2.1'] } });
    expect(view(made.reviewId)).toMatchObject({ staleBy: 2, integrations: [{ state: 'integrated', produced: 2 }], live: false, offers: [] });
    expect(await reviews.integrate({ reviewId: made.reviewId, target: { sessionId: S(1) } })).toEqual({ status: 'refused', reason: 'stale' });
  });

  it('ends `no-plan` where its turn ends with no version, the review staying closed, the plan ready again, nothing sent again', async () => {
    place([session(1)]);
    open();
    const made = await decided();
    await reviews.integrate({ reviewId: made.reviewId, target: { sessionId: S(1) } });
    const own = fake.made[0]!;
    const turnId = own.sent.at(-1)?.turnId ?? '';
    const sends = own.sent.length;
    emit(own, { type: 'turn-started', turnId, providerTurnId: 'p-integrate' });
    say(own, turnId, 'I did not change the plan.');
    end(own, turnId);
    await flush();
    expect(view(made.reviewId)).toMatchObject({ integrations: [{ state: 'ended', reason: 'no-plan' }], state: 'closed', closed: 'handed', live: false, staleBy: null });
    expect(workflow.view(made.planId)).toMatchObject({ state: 'ready', version: 1 });
    expect(own.sent).toHaveLength(sends);
  });

  it('into a new session: made before the record, a plan turn with the block whole, named by its first prompt', async () => {
    place([session(1)]);
    open();
    const made = await decided();
    const answer = await reviews.integrate({ reviewId: made.reviewId, target: { preset: chatPreset(S(1)) } });
    expect(answer).toMatchObject({ status: 'sent' });
    if (answer.status !== 'sent') return;
    expect(service.record(answer.sessionId)).toMatchObject({ projectId: PROJECT, model: 'gpt-6-sol' });
    const sent = fake.latest().sent.at(-1);
    expect(sent?.prompt.endsWith(planBlock(made.planId, 1, PLAN_TEXT, TOKEN))).toBe(true);
    expect(conversations.turnPlan(answer.sessionId, sent?.turnId ?? '')?.fields).toEqual({ planId: made.planId, version: 1, intent: 'revise' });
    await service.settled();
    expect(service.record(answer.sessionId)?.nameSource).toBe('first-message');
  });

  it('into a new session on the preset chosen for it, which may be another than the reviewer’s', async () => {
    place([session(1)]);
    open();
    const made = await decided();
    const answer = await reviews.integrate({ reviewId: made.reviewId, target: { preset: { ...chatPreset(S(1)), effort: 'low' } } });
    if (answer.status !== 'sent') throw new Error(answer.reason);
    expect(service.record(answer.sessionId)).toMatchObject({ projectId: PROJECT, model: 'gpt-6-sol', effort: 'low' });
    expect(service.record(made.reviewer)?.effort).toBe('high');
  });

  it('makes no new session on a preset a new chat would refuse, and the review stays open', async () => {
    place([session(1)]);
    open();
    const made = await decided();
    const before = service.snapshot().sessions.length;
    admission = { ok: false, reason: 'instance-unavailable' };
    expect(await reviews.integrate({ reviewId: made.reviewId, target: { preset: chatPreset(S(1)) } })).toEqual({ status: 'refused', reason: 'instance-unavailable' });
    expect(service.snapshot().sessions).toHaveLength(before);
    expect(view(made.reviewId)).toMatchObject({ state: 'findings', integrations: [] });
  });

  it('carries an integration whose turn asks on through its card’s answer, its provenance kept (C49)', async () => {
    place([session(1)]);
    open();
    const made = await decided();
    await reviews.integrate({ reviewId: made.reviewId, target: { sessionId: S(1) } });
    const own = fake.made[0]!;
    const turnId = own.sent.at(-1)?.turnId ?? '';
    emit(own, { type: 'turn-started', turnId, providerTurnId: 'p-integrate' });
    say(own, turnId, 'Which do you prefer?', 'ask-i', { questions: [{ title: 'Which?', options: ['A', 'B'] }] });
    end(own, turnId);
    await flush();
    expect(view(made.reviewId).integrations[0]).toMatchObject({ state: 'sent' });
    const card = read(S(1)).items.find((item) => questionOf(item) !== null);
    expect(await runtime.answer(S(1), card?.id ?? '', [{ question: 0, options: [1], text: null }])).toEqual({ status: 'answered' });
    const next = own.sent.at(-1)?.turnId ?? '';
    expect(planStore.review(made.planId, made.reviewId)?.integrations[0]?.turns).toEqual([turnId, next]);
    emit(own, { type: 'turn-started', turnId: next, providerTurnId: 'p-next' });
    emit(own, { type: 'plan-completed', turnId: next, itemId: 'plan_item_3', text: '# Tidy v2' });
    end(own, next);
    await flush();
    expect(planStore.get(made.planId)?.versions[1]).toMatchObject({ cause: 'integration', revises: 1 });
    expect(view(made.reviewId).integrations[0]).toMatchObject({ state: 'integrated', produced: 2 });
  });

  it('on Claude’s route: the request’s feedback through the registry, the record naming the request’s turn (C11, C24)', async () => {
    place([session(1)]);
    open();
    expect(await runtime.send(S(1), 'Make a plan.', { plan: true })).toEqual({ status: 'accepted' });
    const own = fake.latest();
    const planTurn = taken(own, 'thread-1');
    emit(own, { type: 'plan-raised', turnId: planTurn, requestId: 'req-1', sourceId: 'toolu_1', text: PLAN_TEXT });
    const planId = body(planLine(S(1))).planId;
    const answer = await reviews.start({ sessionId: S(1), preset: chatPreset(S(1)), planId, version: 1, revision: revisionOf(planId) });
    if (answer.status !== 'started') throw new Error(answer.reason);
    const from = fake.latest();
    const turnId = taken(from, 'thread-reviewer');
    say(from, turnId, block(ROUND));
    end(from, turnId);
    await flush();
    for (const id of ['T1.1', 'T2.1', 'T3.1']) reviews.mark({ reviewId: answer.reviewId, findingId: id, mark: 'accepted' });
    expect(view(answer.reviewId).offers[0]).toMatchObject({ target: { sessionId: S(1) }, route: 'decision' });
    expect(await reviews.integrate({ reviewId: answer.reviewId, target: { sessionId: S(1) } })).toMatchObject({ status: 'sent' });
    const text = integrationText({ title: 'Tidy the notes', version: 1, findings: ROUND, marks: { 'T1.1': 'accepted', 'T2.1': 'accepted', 'T3.1': 'accepted' }, notes: {} });
    expect(own.planned).toEqual([{ requestId: 'req-1', answer: { kind: 'feedback', text } }]);
    expect(planStore.review(planId, answer.reviewId)?.integrations[0]).toMatchObject({ route: 'decision', turns: [planTurn] });
    // The request's turn plans on: its next plan is the integration's version.
    emit(own, { type: 'plan-resolved', requestId: 'req-1' } as unknown as AgentEvent);
    emit(own, { type: 'plan-raised', turnId: planTurn, requestId: 'req-2', sourceId: 'toolu_2', text: '# Tidy the notes, v2' });
    expect(planStore.get(planId)?.versions[1]).toMatchObject({ cause: 'integration', revises: 1 });
    expect(view(answer.reviewId).integrations[0]).toMatchObject({ state: 'integrated', produced: 2 });
  });
});

describe('across a restart (V2, V3; C6, C8, C27)', () => {
  it('keeps a review’s rounds, marks and notes, and the plan under it while its findings wait (decision 0029)', async () => {
    place([session(1)]);
    open();
    const made = await withRound();
    reviews.mark({ reviewId: made.reviewId, findingId: 'T1.1', mark: 'accepted' });
    reviews.note({ reviewId: made.reviewId, findingId: 'T2.1', note: 'A note.' });
    const before = view(made.reviewId);
    await service.settled();
    conversations.close();
    open();
    await workflow.launched();
    expect(view(made.reviewId)).toMatchObject({ rounds: before.rounds, state: 'findings', closed: null });
    expect(workflow.view(made.planId)).toMatchObject({ state: 'reviewing', reviewId: made.reviewId });
    // The session's own read names its review.
    expect(reviews.read({ sessionId: made.reviewer })).toMatchObject({ status: 'session', review: { reviewId: made.reviewId } });
  });

  it('reads PLAN REVIEW again at a launch where the triage panel stood, and READY, seen, where it was left (the maintainer’s word)', async () => {
    place([session(1)]);
    open();
    const made = await withRound();
    await service.settled();
    conversations.close();
    open();
    const attention = (): unknown => service.snapshot().sessions.find((entry) => entry.record.id === made.reviewer)?.summary.attention;
    expect(attention()).toEqual({ kind: 'ready', count: 1, acknowledged: true });
    reviews.launched();
    expect(attention()).toEqual({ kind: 'review', count: 1, acknowledged: false });
    await service.select(made.reviewer);
    expect(attention()).toEqual({ kind: 'review', count: 1, acknowledged: false });
    // Cancelled, a launch finds nothing to raise.
    expect(await reviews.close({ reviewId: made.reviewId, as: 'cancel' })).toEqual({ status: 'closed' });
    await service.settled();
    conversations.close();
    open();
    reviews.launched();
    expect(attention()).toEqual({ kind: 'ready', count: 1, acknowledged: true });
  });
});


it('notifies when new review findings arrive and stays silent when recovered', async () => {
  place([session(1)]); open();
  const made = await withRound();
  expect(roundReady).toHaveBeenCalledExactlyOnceWith(made.reviewId, 1);
  reviews.launched();
  expect(roundReady).toHaveBeenCalledOnce();
});
