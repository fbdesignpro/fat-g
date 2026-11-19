// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V20 (docs/planning/_archive/M23.md; C47, C48, C50–C52, C54–C57, C82, C89): the queue through the session
// runtime, on a real records store, a real conversation store, a real session service and a facet in
// the test's hands — appended with its draft consumed, released oldest first at each turn's end through
// the send path, "Sending…" while claimed, a wait and a pause each as C89's table has them, Edit, Remove
// and reorder, the eleventh refused, released at a restart with no selection and no press, and dropped
// by an explicit completion with the draft kept.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { MAX_QUEUE, NO_INTENT, type PromptIntent } from '@shared/contracts/composer';
import type { ProviderStatus } from '@shared/contracts/status';
import { createBlobFiles } from '../attachments/files';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { createAppStateStore } from '../state/app-state-store';
import { createChatService } from './chat-service';
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
let conversations: ConversationStore;
let fake: FakeFacet;
let ids: number;
let status: ProviderStatus;
/** False: the app state lists no provider yet, as at the launch before the providers start (C89). */
let listedProviders: boolean;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const modelUsed = vi.fn();

const root = () => ({ path: ROOT, trust: { answer: 'trusted', answeredAt: '2020-01-23T00:00:00.000Z' } });
const project = () => ({ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [root()] });
const session = (n: number) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: 'A session', nameSource: 'user',
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null,
});

/** `connected`: false, as an instance with no runtime yet. */
function open(connected = true): void {
  writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [project()], sessions: [session(1)] }));
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', now: () => AT, log });
  const store = createAppStateStore();
  fake = fakeFacet({ history: false, steers: true });
  const blobs = createBlobFiles(path.join(dir, ATTACHMENTS_FOLDER));
  conversations = createConversationStore({ dir, log, blobs });
  const chat = createChatService({ store: conversations, log });
  let ready = false;
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => false,
    listed: () => listedProviders,
    snapshot: () => (!listedProviders ? undefined : { status, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null } } }),
    hasRuntime: () => connected && listedProviders,
    project: (id) => records.getProject(id),
    isMissing: () => false,
    kept: (id) => (ready ? runtime.kept(id) : undefined),
    platform: 'win32',
  });
  service = createSessionService({ records, store, now: () => AT, platform: 'win32', log, unavailable: () => (listedProviders ? null : 'provider-unavailable'), block: (record, hold) => gate.block(record, hold), onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome) });
  runtime = createSessionRuntime({
    modelUsed,
    sessions: service, records, chat, gate, log, now: () => AT, newId: () => `5e551000-0000-4000-9000-${String(++ids).padStart(12, '0')}`,
    facet: () => fake.facet,
    providerName: () => 'Codex',
    hasHistory: () => false,
    store: conversations,
    removal: createRemoval({ store: conversations, log }),
    composer: { store: conversations, blobs },
    planCapability: () => null,
  });
  ready = true;
}

function close(): void {
  runtime.dispose();
  service.stop();
  conversations.close();
}

beforeEach(() => {
  modelUsed.mockReset();
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-runtime-queue-'));
  ids = 0;
  status = { kind: 'ok' };
  listedProviders = true;
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

const settled = () => new Promise<void>((resolve) => { setImmediate(resolve); });
let revision = 10;
const queue = (prompt: string, intent: PromptIntent = NO_INTENT) => runtime.queue({ sessionId: S(1), op: 'append', prompt, revision: ++revision, attachments: [], intent });
const entries = () => conversations.queue(S(1));
const prompts = () => fake.latest().sent.map((turn) => turn.prompt);
/** Every prompt sent, across the processes a close ended. */
const sentEver = () => fake.made.flatMap((made) => made.sent.map((turn) => turn.prompt));
const paused = () => {
  const view = runtime.read(S(1));
  if (view.status !== 'read') throw new Error('not read');
  return view.composer?.queue.paused ?? null;
};

async function running(): Promise<string> {
  expect(await runtime.send(S(1), 'Read every file')).toEqual({ status: 'accepted' });
  const turnId = fake.latest().sent.at(-1)?.turnId ?? '';
  fake.latest().emit({ type: 'turn-started', turnId, providerTurnId: 'pt-1' });
  return turnId;
}

function finish(): void {
  const turnId = fake.latest().sent.at(-1)?.turnId ?? '';
  fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'completed', reported: true });
}

describe('the queue (V9; C47, C48, C50–C57, C82, C89)', () => {
  it('tracks a queued message at dispatch using that turn effort, without counting removed entries', async () => {
    open();
    await running();
    expect(await queue('Drop this')).toEqual({ status: 'saved' });
    expect(modelUsed).toHaveBeenCalledOnce();
    expect(runtime.unqueue(S(1), entries()[0]!.id)).toEqual({ status: 'saved' });
    expect(await queue('Send after this turn')).toEqual({ status: 'saved' });
    expect(modelUsed).toHaveBeenCalledOnce();
    await service.setEffort(S(1), 'low');
    await service.setSpeed(S(1), 'priority');
    finish();
    await settled();
    expect(prompts()).toEqual(['Read every file', 'Send after this turn']);
    expect(modelUsed).toHaveBeenCalledTimes(2);
    expect(modelUsed).toHaveBeenLastCalledWith({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'low', speed: 'priority' });
    const dispatched = fake.latest().sent.at(-1)!;
    expect(conversations.turn(S(1), dispatched.turnId)?.speed).toEqual({ id: 'priority', name: 'priority' });
  });
  it('promotes a queue submission once, and automatic delivery preserves a later drag', async () => {
    open();
    const other = await records.createSession({ projectId: PROJECT, providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null });
    if (other.status !== 'saved') throw new Error('session not created');
    await running();
    await service.move(S(1), null, { list: 'active', starred: false });
    expect(await queue('Do this next')).toEqual({ status: 'saved' });
    await service.settled();
    expect(records.getView().sessions.map((record) => record.id)).toEqual([S(1), other.id]);
    await service.move(S(1), null, { list: 'active', starred: false });
    finish();
    await settled();
    await service.settled();
    expect(prompts()).toEqual(['Read every file', 'Do this next']);
    expect(records.getView().sessions.map((record) => record.id)).toEqual([other.id, S(1)]);
  });

  it('appends the draft while a turn runs, its draft consumed, and releases the entries oldest first, one at each turn’s end', async () => {
    open();
    await running();
    conversations.saveDraft(S(1), 11, { text: 'First after', intent: NO_INTENT }, AT, true);
    expect(await queue('First after')).toEqual({ status: 'saved' });
    expect(await queue('Second after')).toEqual({ status: 'saved' });
    expect(entries().map((entry) => entry.text)).toEqual(['First after', 'Second after']);
    expect(conversations.draft(S(1))?.text).toBe('');
    finish();
    await settled();
    expect(prompts()).toEqual(['Read every file', 'First after']);
    expect(entries().map((entry) => entry.text)).toEqual(['Second after']);
    finish();
    await settled();
    expect(prompts()).toEqual(['Read every file', 'First after', 'Second after']);
    expect(entries()).toEqual([]);
  });

  it('releases at once a message queued while the session is idle', async () => {
    open();
    expect(await queue('Right away')).toEqual({ status: 'saved' });
    await settled();
    expect(prompts()).toEqual(['Right away']);
  });

  it('refuses the eleventh, keeping the draft', async () => {
    open();
    await running();
    for (let n = 0; n < MAX_QUEUE; n += 1) expect(await queue(`Entry ${n}`)).toEqual({ status: 'saved' });
    expect(await queue('One too many')).toEqual({ status: 'refused', reason: 'full' });
    expect(entries()).toHaveLength(MAX_QUEUE);
  });

  it('removes an entry, puts the queue in a new order, and refuses ids that are not each of the session’s once', async () => {
    open();
    await running();
    await queue('A');
    await queue('B');
    await queue('C');
    const [a, b, c] = entries().map((entry) => entry.id);
    expect(await runtime.queue({ sessionId: S(1), op: 'reorder', ids: [c ?? '', a ?? '', b ?? ''] })).toEqual({ status: 'saved' });
    expect(entries().map((entry) => entry.text)).toEqual(['C', 'A', 'B']);
    expect(await runtime.queue({ sessionId: S(1), op: 'reorder', ids: [c ?? '', a ?? ''] })).toMatchObject({ status: 'refused' });
    expect(runtime.unqueue(S(1), a ?? '')).toEqual({ status: 'saved' });
    expect(entries().map((entry) => entry.text)).toEqual(['C', 'B']);
    expect(runtime.unqueue(S(1), a ?? '')).toEqual({ status: 'refused', reason: 'unknown-entry' });
  });

  it('swaps an entry with the draft on Edit, and takes the slot away for an empty draft', async () => {
    open();
    await running();
    await queue('Queued words');
    const id = entries()[0]?.id ?? '';
    expect(await runtime.editQueued({ sessionId: S(1), entryId: id, prompt: 'Draft words', revision: ++revision, attachments: [], intent: NO_INTENT })).toEqual({ status: 'saved' });
    expect(entries().map((entry) => entry.text)).toEqual(['Draft words']);
    expect(conversations.draft(S(1))?.text).toBe('Queued words');
  });

  it('holds the entry being sent: no Remove, no Edit, no move of it, until its send answers', async () => {
    open();
    await running();
    await queue('Being sent');
    await queue('Next');
    const [sending, next] = entries().map((entry) => entry.id);
    // The next send's history wait never ends: the claim stays while its admission waits.
    let release: () => void = () => undefined;
    fake.onSend = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const original = service.hold.bind(service);
    service.hold = async (id) => { await hold; return original(id); };
    finish();
    await settled();
    const view = runtime.read(S(1));
    if (view.status !== 'read') throw new Error('not read');
    expect(view.composer?.queue.entries.map((entry) => [entry.text, entry.sending])).toEqual([['Being sent', true], ['Next', false]]);
    expect(runtime.unqueue(S(1), sending ?? '')).toEqual({ status: 'refused', reason: 'sending' });
    expect(await runtime.queue({ sessionId: S(1), op: 'reorder', ids: [next ?? '', sending ?? ''] })).toEqual({ status: 'refused', reason: 'sending' });
    release();
    await settled();
    expect(prompts()).toEqual(['Read every file', 'Being sent']);
  });

  it('pauses on a refusal the user must remedy, with its reason, and Resume releases it through the same checks', async () => {
    open();
    await running();
    await queue('Plan this', { plan: true, skill: null });
    finish();
    await settled();
    // The chat takes no plan turn here: a settled refusal, never sent as something weaker.
    const view = runtime.read(S(1));
    if (view.status !== 'read') throw new Error('not read');
    expect(view.composer?.queue.paused).toEqual({ reason: 'plans-unavailable' });
    expect(prompts()).toEqual(['Read every file']);
    expect(runtime.resumeQueue(S(1))).toEqual({ status: 'saved' });
    await settled();
    // Resumed with nothing remedied: the same checks, the same refusal, and paused again.
    const again = runtime.read(S(1));
    if (again.status !== 'read') throw new Error('not read');
    expect(again.composer?.queue.paused).toEqual({ reason: 'plans-unavailable' });
    expect(prompts()).toEqual(['Read every file']);
    expect(entries()).toHaveLength(1);
  });

  it('refuses Resume where the queue is not paused', () => {
    open();
    expect(runtime.resumeQueue(S(1))).toEqual({ status: 'refused', reason: 'not-paused' });
  });

  it('waits while the instance is still being detected, and goes once the providers change', async () => {
    status = { kind: 'detecting' };
    open(false);
    expect(await queue('When connected')).toEqual({ status: 'saved' });
    await settled();
    const view = runtime.read(S(1));
    if (view.status !== 'read') throw new Error('not read');
    expect(view.composer?.queue.paused).toBeNull();
    expect(fake.made).toEqual([]);
  });

  it('holds a shelved session’s queue, the shelving’s own pause gone, and lets it go at Unshelve', async () => {
    open();
    await running();
    await queue('Plan this', { plan: true, skill: null });
    finish();
    await settled();
    expect(paused()).toEqual({ reason: 'plans-unavailable' });
    await service.settled();
    expect(await service.shelve(S(1))).toEqual({ status: 'saved' });
    await service.settled();
    // Shelved: the pause goes, and a message queued now waits as well.
    expect(paused()).toBeNull();
    expect(runtime.unqueue(S(1), entries()[0]?.id ?? '')).toEqual({ status: 'saved' });
    expect(await queue('After the shelf')).toEqual({ status: 'saved' });
    await settled();
    expect(sentEver()).toEqual(['Read every file']);
    expect(entries().map((entry) => entry.text)).toEqual(['After the shelf']);
    expect(await service.restore(S(1))).toEqual({ status: 'saved' });
    await service.settled();
    await settled();
    expect(sentEver()).toEqual(['Read every file', 'After the shelf']);
    expect(entries()).toEqual([]);
  });

  it('lets go of a queued message taken before its session was shelved: it waits for Unshelve, and starts no turn', async () => {
    open();
    await running();
    await queue('Being sent');
    // Its admission waits: the claim stays meanwhile.
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const original = service.hold.bind(service);
    service.hold = async (id) => { await hold; return original(id); };
    finish();
    await settled();
    await service.settled();
    expect(await service.shelve(S(1))).toEqual({ status: 'saved' });
    await service.settled();
    release();
    await settled();
    await settled();
    expect(sentEver()).toEqual(['Read every file']);
    expect([entries().map((entry) => entry.text), paused(), service.record(S(1))?.shelvedAt]).toEqual([['Being sent'], null, AT]);
    expect(await service.restore(S(1))).toEqual({ status: 'saved' });
    await service.settled();
    await settled();
    expect(sentEver()).toEqual(['Read every file', 'Being sent']);
  });

  it('drops the queue at an explicit completion, and keeps the draft and the conversation', async () => {
    open();
    await running();
    // Paused, so that the session is idle with its queue held.
    await queue('Plan this', { plan: true, skill: null });
    await queue('Then this');
    finish();
    await settled();
    expect(entries()).toHaveLength(2);
    conversations.saveDraft(S(1), 50, { text: 'Kept draft', intent: NO_INTENT }, AT, true);
    expect(await service.complete(S(1))).toEqual({ status: 'saved' });
    await service.settled();
    expect(entries()).toEqual([]);
    expect(conversations.draft(S(1))?.text).toBe('Kept draft');
    expect(conversations.newestPage(S(1)).items.length).toBeGreaterThan(0);
  });
});

describe('a restart (V20; C52, C89)', () => {
  it('releases a queued message as soon as the session is idle, with no selection and no press', async () => {
    open();
    await running();
    await queue('After the restart');
    close();
    open();
    await settled();
    expect(service.snapshot().selectedId).toBeNull();
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['After the restart']);
    expect(entries()).toEqual([]);
  });

  // The launch wakes every queue before the providers start, when the app state lists none: an
  // instance not listed then is not yet detected, and the queue waits for the listing (V13).
  it('waits, rather than pausing, while the app state lists no provider, and goes once the providers are listed', async () => {
    open();
    await running();
    await queue('After the restart');
    close();
    listedProviders = false;
    open();
    await settled();
    const view = runtime.read(S(1));
    if (view.status !== 'read') throw new Error('not read');
    expect(view.composer?.queue.paused).toBeNull();
    expect(entries()).toHaveLength(1);
    // The providers start: the app state's change reaches the runtime as the main process's reasonsChanged passes it on.
    listedProviders = true;
    runtime.selectionChanged();
    await settled();
    expect(fake.latest().sent.map((turn) => turn.prompt)).toEqual(['After the restart']);
    expect(entries()).toEqual([]);
  });
});
