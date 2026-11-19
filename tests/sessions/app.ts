// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One run of the app's session side, on a data folder (docs/planning/_archive/M18.md, Design 11): the records
// store, the conversation store, the chat service, the session service, the gate and the runtime
// are the app's own, wired as src/main/index.ts wires them; only Electron and the provider registry
// are absent. A second launch on the same folder is a restart. What tests/sessions/ and tests/codex/
// share; no provider is named here.
import type { ModelPreset } from '@shared/contracts/presets';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatPush, ChatRead } from '@shared/contracts/chat';
import { chatCapability, itemText } from '@shared/contracts/conversation';
import { PLANS_FOLDER } from '@shared/contracts/plans';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { ProviderStatus } from '@shared/contracts/status';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import { type ConversationStore, type ConversationStoreOptions, createConversationStore } from '../../src/main/conversations/store';
import { createPlanStore, type PlanStore } from '../../src/main/plans/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../../src/main/records/format';
import { createRecordsStore, type RecordsStore, type RecordsStoreOptions } from '../../src/main/records/store';
import { type ChatService, createChatService } from '../../src/main/sessions/chat-service';
import { createGate } from '../../src/main/sessions/gate';
import { createPermissions } from '../../src/main/sessions/permissions';
import { createPlanService, type PlanService } from '../../src/main/sessions/plans';
import { createRemoval, type Removal } from '../../src/main/sessions/removal';
import { createReviewService, type ReviewService } from '../../src/main/sessions/reviews';
import { createSessionRuntime, type SessionRuntime } from '../../src/main/sessions/runtime';
import { createWorkflowCoordinator, type WorkflowCoordinator } from '../../src/main/sessions/workflow';
import { createSessionService, type SessionService } from '../../src/main/sessions/service';
import { createAppStateStore } from '../../src/main/state/app-state-store';
import { type ConversationsFollower, followConversations } from '../../src/main/state/conversations';

export const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
export const S = (n: number): string => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A listed session's own preset, as the model chooser preselects it for a review. */
export function presetOf(app: Pick<App, 'service'>, sessionId: string): ModelPreset {
  const record = app.service.record(sessionId);
  if (record === undefined) throw new Error(`no session ${sessionId}`);
  return { providerId: record.providerId, instanceId: record.instanceId, model: record.model, effort: record.effort, speed: null };
}
export const AT = Date.parse('2020-01-25T13:00:00.000Z');
export const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** How long a test's quit waits for the records' last write: far longer than any write takes, so only a write that never ends is cut. */
const QUIT_WRITE_WAIT_MS = 30_000;

/** A session entry as records.json stores one, not yet started. */
export function sessionEntry(n: number, providerId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: S(n), projectId: PROJECT, providerId, instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'a-model', effort: 'low', speed: null, name: null, nameSource: null,
    starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null, ...overrides,
  };
}

/** A project's root as records.json stores one, with its trust answer. */
export interface PlacedRoot { readonly path: string; readonly answer?: 'trusted' | 'not-trusted' }

/**
 * A records file with one project and these sessions. The project is rooted in `folder` and trusted;
 * `project` changes that: more roots after the first, each with its own answer, and the providers
 * it is offered to.
 */
export function placeRecords(dir: string, folder: string, providerId: string, sessions: readonly Record<string, unknown>[], project: { readonly otherRoots?: readonly PlacedRoot[]; readonly answer?: 'trusted' | 'not-trusted'; readonly providers?: readonly string[]; readonly permissionModes?: Readonly<Record<string, string>> } = {}): void {
  mkdirSync(dir, { recursive: true });
  const root = (placed: PlacedRoot) => ({ path: placed.path, trust: { answer: placed.answer ?? 'trusted', answeredAt: '2020-01-23T00:00:00.000Z' } });
  writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({
    schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION,
    projects: [{ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: project.providers ?? [providerId], ...(project.permissionModes === undefined ? {} : { permissionModes: project.permissionModes }), roots: [root({ path: folder, ...(project.answer === undefined ? {} : { answer: project.answer }) }), ...(project.otherRoots ?? []).map(root)] }],
    sessions,
  }));
}

/** A session's entry as the file holds it now. */
export function storedSession(dir: string, n: number): Record<string, unknown> | undefined {
  return (JSON.parse(readFileSync(path.join(dir, RECORDS_FILE), 'utf8')) as { sessions: Record<string, unknown>[] }).sessions.find((entry) => entry['id'] === S(n));
}

export interface AppOptions {
  /** The data folder: records.json and the conversation store. */
  readonly dir: string;
  readonly descriptor: ProviderDescriptor;
  /** The facet of the provider's adapter, or undefined while it has no runtime. */
  readonly facet: () => SessionFacet | undefined;
  readonly log?: Pick<Console, 'info' | 'warn' | 'error'>;
  readonly records?: Partial<RecordsStoreOptions>;
  readonly store?: Partial<ConversationStoreOptions>;
  readonly now?: () => number;
  /** Whether a root folder cannot be found: none is missing unless a test says so. */
  readonly isMissing?: (root: string) => boolean;
  /** What the gate reads of the instance: found and signed in, unless a test says otherwise. */
  readonly status?: () => ProviderStatus;
  /** The demo source is on: its sessions take no prompt. */
  readonly demo?: () => boolean;
  /** How long after a session stopped running its process is closed: the runtime's own five minutes unless given. */
  readonly idleMs?: number;
  /** The user's default mode for the provider (M22, C40): none chosen, unless a test says one. */
  readonly userDefault?: () => string | null;
}

export interface App {
  readonly records: RecordsStore;
  readonly conversations: ConversationStore;
  readonly chat: ChatService;
  readonly service: SessionService;
  readonly runtime: SessionRuntime;
  readonly removal: Removal;
  readonly follower: ConversationsFollower;
  /** Every push, for every session, in order. */
  readonly pushes: ChatPush[];
  /** The plan store and the plan service (M22b), in `plans` of the data folder, as main makes them. */
  readonly plans: PlanService;
  readonly planStore: PlanStore;
  /** The review service (M22e), wired to the plan service and the runtime as main wires it. */
  readonly reviews: ReviewService;
  /** The plans' shared workflow (decision 0029). */
  readonly workflow: WorkflowCoordinator;
  /** The session's chat as the page reads it. */
  read(n: number): ChatRead;
  /** Each item of it as `role or notice: text`. */
  texts(n: number): string[];
  summary(n: number): ReturnType<SessionService['snapshot']>['sessions'][number]['summary'] | undefined;
  /** Selects the session, as the page does: its history is then checked. */
  select(n: number): Promise<void>;
  /** As the app's quit leaves it: the running turns stopped and written, the runtime gone, the store closed. */
  quit(): Promise<void>;
  /**
   * As a crash leaves it, as far as one process can show it: nothing is stopped and nothing more is
   * written. The store's connection is closed, which a killed process's is not: the killed-writer
   * tests are the ones that leave a log behind.
   */
  drop(): void;
}

export function launchApp(options: AppOptions): App {
  const { dir, descriptor, log = QUIET } = options;
  const records = createRecordsStore({ dir, providerIds: [descriptor.id], log, ...options.records });
  const conversations = createConversationStore({ dir, log, ...options.store });
  const store = createAppStateStore();
  const follower = followConversations({ conversations, records, store });
  const removal = createRemoval({ store: conversations, log });
  let runtime = undefined as SessionRuntime | undefined;
  let reviews = undefined as ReviewService | undefined;
  const chat = createChatService({
    store: conversations, log,
    requests: { pending: (sessionId, itemId) => runtime?.requests.pending(sessionId, itemId) ?? false, waiting: (sessionId) => runtime?.requests.waiting(sessionId) ?? [], view: (sessionId, itemId) => runtime?.requests.view(sessionId, itemId) ?? null },
    processKey: (sessionId) => runtime?.processKey(sessionId) ?? null,
  });
  const pushes: ChatPush[] = [];
  chat.subscribe((push) => { pushes.push(push); });
  // As main makes them (M22b): what a crash left finished against the listed projects, and a line left being written unfinished.
  const planStore = createPlanStore({ dir: path.join(dir, PLANS_FOLDER), log });
  planStore.recover(records.isRefused() ? null : new Set(records.getView().projects.flatMap((entry) => (entry.kind === 'project' ? [entry.id] : []))));
  if (conversations.status().kind === 'ok') conversations.unfinishPlans(Date.now());
  // The plans' shared workflow (decision 0029), as main makes it: before the plan service, which asks it.
  let sessions = undefined as ReturnType<typeof createSessionService> | undefined;
  const workflow = createWorkflowCoordinator({
    store: planStore, conversations, chat, log,
    host: { record: (id) => records.getSession(id), name: (id) => records.getSession(id)?.name ?? null, running: (id) => sessions?.isRunning(id) === true, quitting: () => runtime?.quitting() ?? false },
    runtime: () => runtime, reviews: () => reviews, lines: () => plans,
  });
  const plans = createPlanService({
    store: planStore, conversations, chat, log, record: (id) => records.getSession(id), chatName: (id) => records.getSession(id)?.name ?? null,
    requestPending: (sessionId, itemId) => runtime?.requests.pending(sessionId, itemId) ?? false,
    integration: (sessionId, turnId) => reviews?.integration(sessionId, turnId) ?? null,
    versionMade: (planId, version) => { reviews?.versionMade(planId, version); workflow.versionMade(planId, version); },
    admits: (planId, sessionId, turnId) => workflow.admits(planId, sessionId, turnId),
    joined: (planId, sessionId) => { workflow.joined(planId, sessionId); },
    workflow: (planId) => workflow.view(planId),
  });
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => options.demo?.() === true,
    snapshot: () => ({ status: options.status?.() ?? { kind: 'ok' }, descriptor }),
    hasRuntime: () => options.facet() !== undefined,
    project: (id) => records.getProject(id),
    isMissing: (root) => options.isMissing?.(root) === true,
    kept: (id) => runtime?.kept(id),
    modeBlock: (record) => runtime?.modeBlock(record) ?? null,
  });
  const service = createSessionService({
    records, store, log, ...(options.now === undefined ? {} : { now: options.now }), block: (record, hold) => gate.block(record, hold),
    mode: (record) => runtime?.chatMode(record) ?? null,
    changingMode: (id) => runtime?.changingMode(id) ?? false,
    planPending: (id) => runtime?.planPending(id) ?? false,
    onReferenceUnsaved: (id) => runtime?.referenceUnsaved(id),
    onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome),
  });
  sessions = service;
  // The hierarchy (M22, C1): the descriptor's modes, the two defaults, and what the facet says its account can use.
  const permissions = createPermissions({
    capability: (providerId) => (providerId === descriptor.id ? descriptor.capabilities.permissions : null),
    userDefault: () => options.userDefault?.() ?? null,
    projectDefault: (projectId, providerId) => records.getProject(projectId)?.permissionModes[providerId] ?? null,
    availability: () => options.facet()?.modes?.(),
  });
  const made = createSessionRuntime({
    sessions: service, records, chat, gate, log, permissions, ...(options.now === undefined ? {} : { now: options.now }), ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    facet: options.facet,
    providerName: () => descriptor.displayName,
    hasHistory: () => chatCapability(descriptor, 'history') === 'supported',
    takesOtherFolders: () => descriptor.capabilities.otherFolders,
    asides: () => descriptor.capabilities.asides,
    questions: () => descriptor.capabilities.questions,
    store: conversations,
    removal,
    plans,
    planCapability: () => descriptor.capabilities.plans ?? null,
    reviews: () => reviews,
    workflow,
  });
  runtime = made;
  const reviewService = createReviewService({
    store: planStore, conversations, log,
    host: {
      record: (id) => service.record(id), name: (id) => service.record(id)?.name ?? null, running: (id) => service.isRunning(id), quitting: () => made.quitting(),
      admit: (_projectId, preset) => ({ ok: true, preset }),
      create: (projectId, preset, name) => service.create(projectId, preset, name),
      remove: (id) => removal.run([id], () => service.remove(id), (answer) => answer.status === 'saved'),
      folder: (record) => gate.folder(record),
      complete: (id) => service.complete(id),
      runtime: made,
    },
    workflow,
  });
  reviews = reviewService;
  void workflow.launched();
  // The runtime read each chat's saved mode as it was made: the entries show them from here on.
  service.availabilityChanged();

  const read = (n: number): ChatRead => {
    const answer = made.read(S(n));
    if (answer.status !== 'read') throw new Error(answer.reason);
    return answer;
  };
  let over = false;
  const end = (): void => { over = true; made.dispose(); service.stop(); follower.stop(); conversations.close(); };
  return {
    records, conversations, chat, service, runtime: made, removal, follower, pushes, read, plans, planStore, reviews: reviewService, workflow,
    texts: (n) => read(n).items.map((item) => `${item.role ?? item.notice ?? item.kind}: ${itemText(item)}`),
    summary: (n) => service.snapshot().sessions.find((entry) => entry.record.id === S(n))?.summary,
    async select(n) { await service.select(S(n)); made.selectionChanged(); },
    async quit() {
      if (over) return;
      await made.stopAll(2000);
      // The app gives its last writes two seconds and then goes (src/main/app/shutdown.test.ts holds
      // that bound). A test reads what the quit wrote, so here the writes are waited for: on a busy
      // disk one can take longer than the app would wait, and the file would lack what is asserted.
      await service.endRunningTurns(QUIT_WRITE_WAIT_MS);
      end();
    },
    drop() { if (!over) end(); },
  };
}

/** Waits until `check` holds, looking every 10 ms. */
export async function until<T>(check: () => T | undefined | false | null, what = 'the condition', timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not come to hold`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
