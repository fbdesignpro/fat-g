// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V3, V6, V20, V22, V27–V30, V32 (docs/planning/_archive/M22.md; C1, C2, C10–C14, C40, C43, C46, C49,
// C57, C66, C75, C79, C81, C83, C86, C88–C90, C92): a chat's mode and an action asked leave for,
// through the runtime, on a real records store, a real conversation store, the chat service, the
// session service and the request registry, with a facet in the test's hands. No Electron, no
// process. The same against the replay fakes is in tests/claude/chat/ and tests/codex/.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { ChatPush, ChatRead } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type ApprovalBody, approvalOf, MAX_APPROVAL_DETAIL, outcomeWords, type RaisedApprovalRequest } from '@shared/contracts/interaction';
import type { ModeAvailability, PermissionCapability, SandboxSetupView } from '@shared/contracts/permissions';
import { storeFiles } from '../conversations/format';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { type AppStateStore, createAppStateStore } from '../state/app-state-store';
import { type ChatService, createChatService } from './chat-service';
import { createGate } from './gate';
import { createPermissions } from './permissions';
import { createRemoval } from './removal';
import { createSessionRuntime, IDLE_CLOSE_MS, type SessionRuntime } from './runtime';
import { fakeFacet, type FakeFacet, type FakeSession } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-02-04T13:00:00.000Z');

/** A provider's modes, as a descriptor declares them: a reading one, two a change reaches on the live process, and one that needs a sandbox. */
const mode = (id: string, label: string, patch: Partial<PermissionCapability['modes'][number]> = {}) => ({ id, label, description: `What ${label} lets run.`, asks: true, reading: false, transitionsFrom: [], ...patch });
const CAPABILITY: PermissionCapability = {
  modes: [mode('read-only', 'Read only', { asks: false, reading: true }), mode('ask-first', 'Ask first', { transitionsFrom: ['edits-ok'] }), mode('edits-ok', 'Edits ok', { transitionsFrom: ['ask-first'] }), mode('sandbox-ok', 'Sandbox ok')],
  fallback: 'ask-first',
  setup: { changes: 'The setup changes the machine.', approval: 'The system asks for leave.', waiting: 'The system may be asking.' },
  inherited: 'Rules of your own configuration act as it lets them.',
  rules: 'This CLI lists no rules.',
};
const available = (id: string, patch: Partial<ModeAvailability> = {}): ModeAvailability => ({ id, available: true, reason: null, setup: false, records: false, unconfined: false, places: null, ...patch });

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
const world: {
  userDefault: string | null;
  /** What the account can use: undefined while its facet says nothing. */
  availability: readonly ModeAvailability[] | undefined;
  setup: SandboxSetupView | null;
  storeFault: string | null;
  asides: boolean;
} = { userDefault: null, availability: undefined, setup: null, storeFault: null, asides: false };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-permissions-'));
  ids = 0;
  clock = { wall: AT, mono: 5_000 };
  Object.assign(world, { userDefault: null, availability: undefined, setup: null, storeFault: null, asides: false });
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
const place = (sessions: unknown[], permissionModes: Record<string, string> = {}) =>
  writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [{ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex'], roots: [root], permissionModes }], sessions }));

function open(): void {
  // A second `open` is a restart, on the same folder.
  runtime?.dispose();
  service?.stop();
  records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', now: () => AT, log });
  appState = createAppStateStore();
  fake = fakeFacet({
    history: false,
    asides: world.asides,
    permissions: {
      transition: (from, to) => (CAPABILITY.modes.find((candidate) => candidate.id === to)?.transitionsFrom.includes(from) === true ? 'idle' : 'restart'),
      modes: () => world.availability ?? [],
      sandbox: { state: () => world.setup ?? { state: 'idle', error: null, readiness: null }, act: () => 'no-setup' },
    },
  });
  conversations?.close();
  conversations = createConversationStore({ dir, log, now: () => clock.wall, hook: (point) => { if (world.storeFault === point) throw Object.assign(new Error('disk'), { code: 'EIO' }); } });
  timers = manualTimers();
  let ready = false;
  chat = createChatService({
    store: conversations, log, timers, now: () => clock.wall,
    requests: { pending: (sessionId, itemId) => ready && runtime.requests.pending(sessionId, itemId), waiting: (sessionId) => (ready ? runtime.requests.waiting(sessionId) : []), view: (sessionId, itemId) => (ready ? runtime.requests.view(sessionId, itemId) : null) },
    processKey: (sessionId) => (ready ? runtime.processKey(sessionId) : null),
  });
  pushes = [];
  chat.subscribe((push) => { pushes.push(push); });
  const removal = createRemoval({ store: conversations, log });
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => false,
    snapshot: () => ({ status: { kind: 'ok' }, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: false, models: true, asides: world.asides ? { followUp: true, streamed: true, tools: 'none' } : 'none', questions: 'none', permissions: CAPABILITY } } }),
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
  });
  const permissions = createPermissions({
    capability: () => CAPABILITY,
    userDefault: () => world.userDefault,
    projectDefault: (projectId, providerId) => records.getProject(projectId)?.permissionModes[providerId] ?? null,
    availability: () => world.availability,
  });
  runtime = createSessionRuntime({
    sessions: service, records, chat, gate, timers, log, now: () => clock.wall, monotonic: () => clock.mono, newId: () => `id-${++ids}`,
    facet: () => fake.facet,
    providerName: () => 'Codex',
    hasHistory: () => false,
    ...(world.asides ? { asides: () => ({ followUp: true, streamed: true, tools: 'none' as const }) } : {}),
    store: conversations,
    removal,
    permissions,
  });
  ready = true;
  service.availabilityChanged();
}

const COMMAND: RaisedApprovalRequest = {
  kind: 'command', tool: 'Bash', summary: 'touch NEEDLE-COMMAND notes.txt', folder: ROOT, targets: ['D:\\Code\\fat-g\\NEEDLE-TARGET.txt'], outside: false, reason: 'NEEDLE-REASON to make the note', authority: [],
  detail: { kind: 'command', command: 'touch NEEDLE-COMMAND notes.txt' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch NEEDLE-COMMAND notes.txt)' }, modeThatWouldStop: null, cut: false,
};
const ONCE: RaisedApprovalRequest = { ...COMMAND, choices: ['approve', 'deny'], grant: null };

const read = (n = 1): ChatRead => { const answer = runtime.read(S(n)); if (answer.status !== 'read') throw new Error(answer.reason); return answer; };
const cards = (items: readonly ConversationItem[] = read().items): ConversationItem[] => items.filter((item) => item.kind === 'interaction');
const card = (items?: readonly ConversationItem[]): ConversationItem => { const found = cards(items).at(-1); if (found === undefined) throw new Error('no card'); return found; };
const body = (item: ConversationItem = card()): ApprovalBody => { const found = approvalOf(item); if (found === null) throw new Error('no approval'); return found; };
const entry = (n = 1) => service.snapshot().sessions.find((candidate) => candidate.record.id === S(n));
const summary = (n = 1) => entry(n)?.summary;
const emit = (event: AgentEvent, from: FakeSession = fake.latest()): void => from.emit(event);
const stored = (): string => storeFiles().map((name) => { try { return readFileSync(path.join(dir, name), 'latin1'); } catch { return ''; } }).join('\n');
const flush = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };
async function restart(): Promise<void> {
  await service.settled();
  conversations.close();
  open();
}

/** A session whose turn runs: its prompt sent, taken by the provider, its process confirming the mode it was opened under. */
async function running(n = 1, prompt = 'Make a note.'): Promise<string> {
  expect(await runtime.send(S(n), prompt)).toEqual({ status: 'accepted' });
  const made = fake.latest();
  const turnId = made.sent.at(-1)?.turnId ?? '';
  if (made.options.mode !== null) emit({ type: 'in-force', turnId, mode: made.options.mode });
  emit({ type: 'session-started', reference: `thread-${n}`, folder: ROOT });
  emit({ type: 'turn-started', turnId, providerTurnId: `p-${turnId}` });
  return turnId;
}
const end = (turnId: string, outcome: 'completed' | 'interrupted' | 'failed' = 'completed', failure?: 'policy-mismatch' | 'connection-lost'): void => { emit({ type: 'turn-ended', turnId, outcome, reported: failure === undefined, ...(failure === undefined ? {} : { failure }) }); };
function ask(turnId: string, requestId = 'n:1', request: RaisedApprovalRequest = COMMAND, patch: Partial<Extract<AgentEvent, { type: 'approval-raised' }>> = {}): void {
  emit({ type: 'approval-raised', turnId, requestId, sourceId: `item-${requestId}`, request, ...patch });
}

describe('which mode a chat has (V2, V15; C1, C40, C43, C44)', () => {
  it('snapshots the hierarchy’s answer with its source when the session is made, and keeps it whatever the defaults become', async () => {
    world.userDefault = 'edits-ok';
    place([session(1)]);
    open();
    // Made with the session: the conversation's row, holding the mode and where it came from.
    expect(conversations.conversation(S(1))).toMatchObject({ mode: { id: 'edits-ok', source: 'user' }, startHeld: true });
    expect(entry()?.mode).toEqual({ id: 'edits-ok', source: 'user' });
    // A later default touches no chat that exists (C40).
    world.userDefault = 'read-only';
    await restart();
    expect(entry()?.mode).toEqual({ id: 'edits-ok', source: 'user' });
    expect(read().mode).toEqual({ id: 'edits-ok', source: 'user' });
  });

  it('takes the project’s default before the user’s, and the fallback where neither chose', () => {
    world.userDefault = 'edits-ok';
    place([session(1)], { codex: 'read-only' });
    open();
    expect(entry()?.mode).toEqual({ id: 'read-only', source: 'project' });
    runtime.dispose(); service.stop(); conversations.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(tmpdir(), 'fatg-permissions-'));
    world.userDefault = null;
    place([session(1)]);
    open();
    expect(entry()?.mode).toEqual({ id: 'ask-first', source: 'fallback' });
  });

  it('falls back to the reading mode where the account cannot use the fallback, and never to a mode that acts without asking (C44)', () => {
    world.availability = [available('read-only'), available('ask-first', { available: false, reason: 'cli-refuses' }), available('edits-ok'), available('sandbox-ok')];
    place([session(1)]);
    open();
    expect(entry()?.mode).toEqual({ id: 'read-only', source: 'fallback' });
    expect(entry()?.block).toBeNull();
  });

  it('hands the chat’s mode and a key of the process’s own at every open, and writes the turn’s mode at its acceptance (C2, C81, C83)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    const first = fake.latest().options;
    expect(first).toMatchObject({ mode: 'ask-first' });
    expect(read().turns).toMatchObject([{ id: turnId, mode: 'ask-first' }]);
    end(turnId);
    // Its idle close, and the next prompt: another process, under the same mode, with another key.
    timers.advance(IDLE_CLOSE_MS);
    await flush();
    await running(1, 'Again.');
    expect(fake.made).toHaveLength(2);
    expect(fake.latest().options).toMatchObject({ mode: 'ask-first', reference: 'thread-1' });
    expect(fake.latest().options.processKey).not.toBe(first.processKey);
  });

  it('shows the mode a process confirmed as in force, and takes it back at that process’s end (C2, C75)', async () => {
    place([session(1)]);
    open();
    expect(summary()?.mode).toBeNull();
    const turnId = await running();
    expect(summary()?.mode).toBe('ask-first');
    end(turnId);
    expect(summary()?.mode).toBe('ask-first');
    fake.latest().end();
    await flush();
    expect(summary()?.mode).toBeNull();
  });
});

describe('a mode that blocks a prompt, and the change that is its remedy (V2, V29; C43, C46, C89)', () => {
  it('blocks Send for a saved mode the account cannot use, with nothing substituted, and takes the change to one it can', async () => {
    world.userDefault = 'sandbox-ok';
    place([session(1)]);
    open();
    world.availability = [available('read-only'), available('ask-first'), available('edits-ok'), available('sandbox-ok', { available: false, reason: 'needs-setup', setup: true })];
    service.availabilityChanged();
    expect(entry()).toMatchObject({ block: 'mode-unavailable', mode: { id: 'sandbox-ok', source: 'user' } });
    expect(await runtime.send(S(1), 'Hello')).toEqual({ status: 'refused', reason: 'mode-unavailable' });
    expect(fake.made).toHaveLength(0);
    // The mode asked for is what is checked, and never the one it replaces (C89).
    expect(await runtime.setMode(S(1), 'sandbox-ok')).toEqual({ status: 'refused', reason: 'mode-unavailable' });
    expect(entry()?.block).toBe('mode-unavailable');
    expect(await runtime.setMode(S(1), 'ask-first')).toEqual({ status: 'set' });
    expect(entry()).toMatchObject({ block: null, mode: { id: 'ask-first', source: 'chat' } });
    expect(await runtime.send(S(1), 'Hello')).toEqual({ status: 'accepted' });
    expect(fake.latest().options.mode).toBe('ask-first');
  });

  it('blocks Send after a start that reported another policy, until a mode is chosen, and then sends (C46, C75)', async () => {
    place([session(1)]);
    open();
    expect(await runtime.send(S(1), 'Hello')).toEqual({ status: 'accepted' });
    const turnId = fake.latest().sent[0]?.turnId ?? '';
    emit({ type: 'notice', turnId, kind: 'policy-mismatch', detail: 'readOnly, never' });
    end(turnId, 'failed', 'policy-mismatch');
    fake.latest().end();
    await flush();
    expect(entry()).toMatchObject({ block: 'mode-unconfirmed', mode: { id: 'ask-first', source: 'fallback' } });
    // The notice names the mode fat-g asked for, in fat-g's words, and keeps what the CLI reported.
    const notice = read().items.find((item) => item.kind === 'notice');
    expect(notice?.blocks[0]?.text).toBe('Codex reported another policy than Ask first; nothing was sent. Choose a mode this account runs, or check Codex’s own configuration.');
    expect(notice?.detail).toBe('readOnly, never');
    expect(await runtime.send(S(1), 'Again')).toEqual({ status: 'refused', reason: 'mode-unconfirmed' });
    // The block's own remedy: the change is taken under it, and the next prompt goes.
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'set' });
    expect(entry()?.block).toBeNull();
    expect(await runtime.send(S(1), 'Again')).toEqual({ status: 'accepted' });
    expect(fake.latest().options.mode).toBe('read-only');
  });

  it('takes the same mode again from that block, which lifts it for another try', async () => {
    place([session(1)]);
    open();
    expect(await runtime.setMode(S(1), 'ask-first')).toEqual({ status: 'set' });
    expect(await runtime.setMode(S(1), 'ask-first')).toEqual({ status: 'refused', reason: 'same' });
    await runtime.send(S(1), 'Hello');
    const turnId = fake.latest().sent[0]?.turnId ?? '';
    end(turnId, 'failed', 'policy-mismatch');
    fake.latest().end();
    await flush();
    expect(entry()?.block).toBe('mode-unconfirmed');
    expect(await runtime.setMode(S(1), 'ask-first')).toEqual({ status: 'set' });
    expect(entry()?.block).toBeNull();
  });
});

describe('changing a chat’s mode (V2, V20, V30; C2, C66, C74, C75, C90)', () => {
  it('refuses an id the provider does not list, and a change while a turn, a pending request or the setup runs', async () => {
    place([session(1)]);
    open();
    expect(await runtime.setMode(S(1), 'berserk')).toEqual({ status: 'refused', reason: 'unknown-mode' });
    expect(await runtime.setMode(S(9), 'ask-first')).toEqual({ status: 'refused', reason: 'unknown-session' });
    const turnId = await running();
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'refused', reason: 'running' });
    end(turnId);
    world.setup = { state: 'waiting', error: null, readiness: null };
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'refused', reason: 'setting-up' });
    expect(await runtime.send(S(1), 'Hello')).toEqual({ status: 'refused', reason: 'setting-up' });
    world.setup = null;
    expect(entry()?.mode).toEqual({ id: 'ask-first', source: 'fallback' });
  });

  it('by a restart: saves the choice at once, closes the live process, launches nothing, and opens the next prompt under it', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    end(turnId);
    const first = fake.latest();
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'set' });
    expect(conversations.conversation(S(1))?.mode).toEqual({ id: 'read-only', source: 'chat' });
    expect(first.closes).toBe(1);
    expect(fake.made).toHaveLength(1);
    // Saved and not yet confirmed: the header says it applies at the next prompt (C75).
    expect(entry()).toMatchObject({ mode: { id: 'read-only', source: 'chat' }, summary: { mode: null }, changingMode: false });
    await running(1, 'Read it back.');
    expect(fake.made).toHaveLength(2);
    expect(fake.latest().options).toMatchObject({ mode: 'read-only', reference: 'thread-1' });
    expect(summary()?.mode).toBe('read-only');
    // Each turn keeps the mode it ran under (C83).
    expect(read().turns.map((turn) => turn.mode)).toEqual(['ask-first', 'read-only']);
  });

  it('on the live process where its adapter changes it there: confirmed by the CLI, then saved', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    end(turnId);
    const live = fake.latest();
    expect(await runtime.setMode(S(1), 'edits-ok')).toEqual({ status: 'set' });
    expect(live.modeSets).toEqual(['edits-ok']);
    expect(live.closes).toBe(0);
    expect(conversations.conversation(S(1))?.mode).toEqual({ id: 'edits-ok', source: 'chat' });
    expect(entry()).toMatchObject({ mode: { id: 'edits-ok', source: 'chat' }, summary: { mode: 'edits-ok' }, block: null });
    // The next prompt goes to the same process.
    await running(1, 'Edit it.');
    expect(fake.made).toHaveLength(1);
  });

  it('is a transition the session is busy under: a prompt, a decision and a second change are refused until it is written', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    end(turnId);
    const live = fake.latest();
    live.modeChange = 'hold';
    const changing = runtime.setMode(S(1), 'edits-ok');
    await flush();
    expect(entry()?.changingMode).toBe(true);
    expect(await runtime.send(S(1), 'Hello')).toEqual({ status: 'refused', reason: 'changing-mode' });
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'refused', reason: 'changing-mode' });
    expect(runtime.decide(S(1), 'no-card', 'approve')).toEqual({ status: 'refused', reason: 'unknown-item' });
    live.settleMode({ confirmed: true });
    expect(await changing).toEqual({ status: 'set' });
    expect(entry()).toMatchObject({ changingMode: false, mode: { id: 'edits-ok' } });
    expect(await runtime.send(S(1), 'Hello')).toEqual({ status: 'accepted' });
  });

  it('saves nothing of a change the CLI did not confirm, and blocks Send until a change is taken (C46)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    end(turnId);
    fake.latest().modeChange = { confirmed: false, detail: 'default' };
    expect(await runtime.setMode(S(1), 'edits-ok')).toEqual({ status: 'refused', reason: 'not-confirmed', detail: 'default' });
    expect(conversations.conversation(S(1))?.mode).toEqual({ id: 'ask-first', source: 'fallback' });
    expect(entry()).toMatchObject({ block: 'mode-unconfirmed', mode: { id: 'ask-first' }, changingMode: false });
    expect(await runtime.send(S(1), 'Hello')).toEqual({ status: 'refused', reason: 'mode-unconfirmed' });
  });

  it('refuses a change it could not save, and closes nothing', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    end(turnId);
    world.storeFault = 'mode';
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'refused', reason: 'storage-failed' });
    world.storeFault = null;
    expect(fake.latest().closes).toBe(0);
    expect(entry()?.mode).toEqual({ id: 'ask-first', source: 'fallback' });
  });
});

describe('an approval, raised and decided (V3, V22, V23; C8–C14, C49, C77–C79, C88)', () => {
  it('promotes an accepted approval and an explicit Stop, while refused decisions preserve order', async () => {
    place([session(1), session(2)]);
    open();
    const turnId = await running();
    ask(turnId);
    await service.settled();
    await service.move(S(1), null, { list: 'active', starred: false });
    const order = () => service.snapshot().sessions.map((item) => item.record.id);
    expect(runtime.decide(S(1), 'missing', 'approve')).toMatchObject({ status: 'refused' });
    await service.settled();
    expect(order()).toEqual([S(2), S(1)]);
    expect(runtime.decide(S(1), card().id, 'approve')).toEqual({ status: 'decided' });
    await service.settled();
    expect(order()).toEqual([S(1), S(2)]);
    await service.move(S(1), null, { list: 'active', starred: false });
    expect(runtime.stop(S(1))).toEqual({ status: 'stopping' });
    await service.settled();
    expect(order()).toEqual([S(1), S(2)]);
  });

  it('is an item of its turn, pending, pushed with the request whole, the attention raised and the line in fat-g’s words', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    pushes = [];
    ask(turnId);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ sessionId: S(1), item: { kind: 'interaction', turnId, providerItemId: 'item-n:1', workerId: null, interaction: { kind: 'approval', outcome: 'pending', request: COMMAND, grant: null } } });
    expect(body()).toMatchObject({ outcome: 'pending', decidedAt: null, delivered: null, confirmedAt: null });
    expect(summary()).toMatchObject({ status: 'running', attention: { kind: 'approval', count: 1 }, action: { kind: 'approving', label: 'Waiting for your approval' } });
    // No item kind was added (C77): it is an interaction, by its body's kind.
    expect(card().kind).toBe('interaction');
  });

  it('shows the action whole while its request lives, and the store’s cut copy once it is decided (C48, C79)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    const long = 'x'.repeat(MAX_APPROVAL_DETAIL);
    ask(turnId, 'n:1', { ...ONCE, detail: { kind: 'command', command: long } });
    expect(body().request).toMatchObject({ cut: false, detail: { kind: 'command', command: long } });
    expect(runtime.decide(S(1), card().id, 'approve')).toEqual({ status: 'decided' });
    const kept = body().request;
    expect(kept.cut).toBe(true);
    expect(kept.detail.kind === 'command' ? kept.detail.command.length : -1).toBe(10_000);
  });

  it('writes the decision before it is sent, sends the choice by the request’s own id, and records the delivery apart (C12)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId, 's:req-7', ONCE);
    const seen: unknown[] = [];
    const live = fake.latest();
    const decide = live.session.decide?.bind(live.session);
    live.session.decide = (requestId, choice) => { seen.push(body().outcome); return decide?.(requestId, choice) ?? Promise.resolve(true); };
    expect(runtime.decide(S(1), card().id, 'approve')).toEqual({ status: 'decided' });
    // The item was already written when the session was told.
    expect(seen).toEqual(['approved']);
    expect(live.decided).toEqual([{ requestId: 's:req-7', choice: 'approve' }]);
    expect(body()).toMatchObject({ outcome: 'approved', decidedAt: AT, grant: null });
    await flush();
    expect(body()).toMatchObject({ delivered: true, confirmedAt: null });
    expect(summary()).toMatchObject({ attention: null, action: { kind: 'thinking' } });
    // The CLI's word that it took the decision is a third thing, and says nothing of the action's success (C14).
    emit({ type: 'approval-resolved', requestId: 's:req-7', reason: 'confirmed' });
    expect(body().confirmedAt).toBe(AT);
    expect(outcomeWords(body(), false)).toBe('Approved once');
  });

  it('takes only a choice the request’s own view lists, once, on the process that raised it (C13, C88)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId, 'n:1', ONCE);
    const id = card().id;
    expect(runtime.decide(S(1), id, 'approve-session')).toEqual({ status: 'refused', reason: 'not-offered' });
    expect(runtime.decide(S(1), 'no-such-card', 'approve')).toEqual({ status: 'refused', reason: 'unknown-item' });
    expect(runtime.decide(S(9), id, 'approve')).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(body().outcome).toBe('pending');
    expect(runtime.decide(S(1), id, 'deny')).toEqual({ status: 'decided' });
    expect(runtime.decide(S(1), id, 'approve')).toEqual({ status: 'refused', reason: 'not-pending' });
    expect(fake.latest().decided).toEqual([{ requestId: 'n:1', choice: 'deny' }]);
    expect(outcomeWords(body(), false)).toBe('Denied');
  });

  it('sends nothing for a decision it could not write (C49)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId);
    world.storeFault = 'interaction-set';
    expect(runtime.decide(S(1), card().id, 'approve')).toEqual({ status: 'refused', reason: 'storage-failed' });
    world.storeFault = null;
    expect(fake.latest().decided).toEqual([]);
    expect(body().outcome).toBe('pending');
    expect(summary()?.attention).toMatchObject({ kind: 'approval' });
  });

  it('keeps a number and a string of one spelling apart, makes one card of a repeated delivery, and refuses a changed one as a defect (C10, C91)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId, 'n:0');
    ask(turnId, 's:0');
    expect(cards()).toHaveLength(2);
    ask(turnId, 'n:0');
    expect(cards()).toHaveLength(2);
    // A differing view under a held id never reaches here from an adapter that compared it: refused all the same.
    ask(turnId, 'n:0', ONCE);
    expect(cards()).toHaveLength(2);
    expect(fake.latest().decided).toEqual([{ requestId: 'n:0', choice: null }]);
  });

  it('withdraws a card whose request changed under its id, in those words, and one whose turn ended (C91)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId, 'n:1');
    emit({ type: 'approval-resolved', requestId: 'n:1', reason: 'changed' });
    expect(body()).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'changed' });
    expect(outcomeWords(body(), false)).toBe('Withdrawn: the request changed under its id and was refused');
    ask(turnId, 'n:2');
    end(turnId, 'interrupted');
    expect(body()).toMatchObject({ outcome: 'withdrawn', withdrawnBy: 'turn' });
    expect(summary()?.attention).not.toMatchObject({ kind: 'approval' });
  });

  it('refuses through its session a request it cannot place, and drops what waited when its process is lost', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask('another-turn', 'n:8');
    ask(turnId, 'n:9', COMMAND, { workerId: 'worker-9' });
    expect(cards()).toEqual([]);
    expect(fake.latest().decided).toEqual([{ requestId: 'n:8', choice: null }, { requestId: 'n:9', choice: null }]);
    ask(turnId, 'n:1');
    fake.latest().end();
    await flush();
    expect(body().outcome).toBe('dropped');
    expect(outcomeWords(body(), false)).toBe('Not answered: the session’s process ended');
  });

  it('is its worker’s in a worker’s tab: listed as waiting by its kind, with no line of the session’s changed (C11, C36)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    emit({ type: 'worker-started', workerId: 'worker-1', description: 'Makes the note' });
    emit({ type: 'action-changed', turnId, kind: 'running' });
    ask(turnId, 'n:1', COMMAND, { workerId: 'worker-1' });
    expect(cards()).toEqual([]);
    expect(read().waiting).toMatchObject([{ workerId: 'worker-1', kind: 'approval' }]);
    expect(summary()).toMatchObject({ attention: { kind: 'approval', count: 1 }, action: { kind: 'running' } });
    const waitingId = read().waiting[0]?.itemId ?? '';
    expect(runtime.decide(S(1), waitingId, 'approve')).toEqual({ status: 'decided' });
    expect(read().waiting).toEqual([]);
  });

  it('comes back inert after a restart: a card an earlier run left pending reads dropped, and nothing of it is decided', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId);
    const id = card().id;
    await restart();
    expect(body()).toMatchObject({ outcome: 'dropped', request: { cut: false } });
    expect(runtime.decide(S(1), id, 'approve')).toEqual({ status: 'refused', reason: 'not-pending' });
  });
});

describe('a session grant (V27, V28, V32; C21, C57, C66, C81, C86, C92)', () => {
  /** A session with one command granted for the session, its reply delivered. */
  async function granted(): Promise<{ turnId: string; id: string; live: FakeSession }> {
    const turnId = await running();
    ask(turnId);
    const id = card().id;
    expect(runtime.decide(S(1), id, 'approve-session')).toEqual({ status: 'decided' });
    await flush();
    return { turnId, id, live: fake.latest() };
  }

  it('keeps with the decision what it covered and the process it was sent to, and lists it once its reply was delivered', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId);
    const id = card().id;
    fake.latest().delivery = 'silent';
    expect(runtime.decide(S(1), id, 'approve-session')).toEqual({ status: 'decided' });
    expect(fake.latest().decided).toEqual([{ requestId: 'n:1', choice: 'approve-session' }]);
    expect(body()).toMatchObject({ outcome: 'approved-session', grant: { covers: 'Bash(touch NEEDLE-COMMAND notes.txt)', processKey: fake.latest().options.processKey, live: true }, delivered: null });
    // Written, and not yet known delivered: no grant fat-g can say it sent (C92).
    expect(read().grants).toEqual([]);
  });

  it('lists a delivered grant as live, confirmed only at the CLI’s own word', async () => {
    place([session(1)]);
    open();
    const { id } = await granted();
    expect(read().grants).toEqual([{ itemId: id, covers: 'Bash(touch NEEDLE-COMMAND notes.txt)', decidedAt: AT, confirmed: false, live: true }]);
    emit({ type: 'approval-resolved', requestId: 'n:1', reason: 'confirmed' });
    expect(read().grants).toMatchObject([{ confirmed: true, live: true }]);
    expect(outcomeWords(body(), false)).toBe('Approved for this session');
  });

  it('says a grant the process did not take is not delivered, on its card alone', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId);
    fake.latest().delivery = false;
    expect(runtime.decide(S(1), card().id, 'approve-session')).toEqual({ status: 'decided' });
    await flush();
    expect(body()).toMatchObject({ outcome: 'approved-session', delivered: false });
    expect(outcomeWords(body(), false)).toBe('Approved for this session; the process did not take it');
    expect(read().grants).toEqual([]);
    // The adapter's own word of the same failure changes nothing more.
    emit({ type: 'approval-resolved', requestId: 'n:1', reason: 'dropped' });
    expect(body()).toMatchObject({ outcome: 'approved-session', delivered: false });
  });

  it.each([
    ['a change of mode that restarts the process', async (turnId: string) => { end(turnId); expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'set' }); }],
    ['the idle close', async (turnId: string) => { end(turnId); timers.advance(IDLE_CLOSE_MS); await flush(); }],
    ['a loss', async () => { fake.latest().end(); await flush(); }],
    ['a quit', async () => { const quit = runtime.stopAll(1_000); fake.latest().end(); await flush(); timers.advance(1_000); await quit; }],
  ])('ends with its process, and with nothing else: %s', async (_name, ending) => {
    place([session(1)]);
    open();
    const { turnId, id } = await granted();
    pushes = [];
    await ending(turnId);
    expect(read().grants).toMatchObject([{ itemId: id, live: false }]);
    expect(body(read().items.find((item) => item.id === id))).toMatchObject({ grant: { live: false } });
    // The page was told to read again: its list and its card say ended.
    expect(pushes.some((push) => 'changed' in push)).toBe(true);
  });

  it('stays live through a change the live process took, and is never sent again after a resume', async () => {
    place([session(1)]);
    open();
    const { turnId, live } = await granted();
    end(turnId);
    expect(await runtime.setMode(S(1), 'edits-ok')).toEqual({ status: 'set' });
    expect(read().grants).toMatchObject([{ live: true }]);
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'set' });
    await running(1, 'Read.');
    expect(read().grants).toMatchObject([{ live: false }]);
    // The new process was told nothing of the old one's grants.
    expect(fake.latest()).not.toBe(live);
    expect(fake.latest().decided).toEqual([]);
  });

  it('reads ended after a restart of fat-g, whatever a generation number says (C81)', async () => {
    place([session(1)]);
    open();
    await granted();
    await restart();
    expect(read().grants).toMatchObject([{ live: false }]);
    // The first process of the new run has the generation the old one had, and another key.
    await running(1, 'Again.');
    expect(read().grants).toMatchObject([{ live: false }]);
  });
});

describe('what is kept, and where (V6, V7; C25, C26)', () => {
  it('keeps the command, the reason and the grant in the conversation store alone: none of it is in the app state or a log', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId);
    expect(runtime.decide(S(1), card().id, 'approve-session')).toEqual({ status: 'decided' });
    await flush();
    end(turnId);
    await service.settled();
    expect(stored()).toContain('NEEDLE-COMMAND');
    const outside = JSON.stringify([appState.getSnapshot(), log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, readFileSync(path.join(dir, RECORDS_FILE), 'utf8')]);
    for (const needle of ['NEEDLE-COMMAND', 'NEEDLE-TARGET', 'NEEDLE-REASON']) expect(outside).not.toContain(needle);
  });
});

// What the audit of the milestone's verification rows found no test for (docs/planning/_archive/M22.md,
// Results): each is a clause of a row, held here through the real stores, registry and services.
describe('the gates, case by case (V2, V18, V27, V29, V30, V32; C2, C13, C62, C89, C90, C92)', () => {
  const A = (n: number) => `a51de000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const READY = [available('read-only'), available('ask-first'), available('edits-ok'), available('sandbox-ok')];

  it('refuses a change that would restart the process while a worker outlives its turn, while that worker’s request waits, and while an aside runs (C2)', async () => {
    world.asides = true;
    place([session(1)]);
    open();
    const turnId = await running();
    emit({ type: 'worker-started', workerId: 'worker-1', description: 'Makes the note' });
    end(turnId);
    // The turn is over and its worker is not: the session still runs.
    expect(summary()?.status).toBe('running');
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'refused', reason: 'running' });
    ask(turnId, 'n:1', ONCE, { workerId: 'worker-1' });
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'refused', reason: 'running' });
    expect(runtime.decide(S(1), read().waiting[0]?.itemId ?? '', 'approve')).toEqual({ status: 'decided' });
    await flush();
    emit({ type: 'approval-resolved', requestId: 'n:1', reason: 'confirmed' });
    emit({ type: 'worker-ended', workerId: 'worker-1', outcome: 'completed' });
    await flush();
    expect(summary()?.status).toBe('idle');
    // Nothing of the session's own runs now, and an aside does.
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why?' })).toEqual({ status: 'accepted', asideId: A(1) });
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'refused', reason: 'running' });
    expect(entry()?.mode).toEqual({ id: 'ask-first', source: 'fallback' });
    const asked = fake.latest().asked.at(-1);
    emit({ type: 'turn-started', turnId: asked?.turnId ?? '', providerTurnId: 'aside-turn', asideId: A(1) });
    emit({ type: 'turn-ended', turnId: asked?.turnId ?? '', asideId: A(1), outcome: 'completed', reported: true });
    await flush();
    // With nothing running the same change is taken, and the process closed.
    const live = fake.latest();
    expect(await runtime.setMode(S(1), 'read-only')).toEqual({ status: 'set' });
    expect(live.closes).toBe(1);
  });

  it('takes no aside’s question while a setup holds the account, and none during a change of mode (C62, C90)', async () => {
    world.asides = true;
    place([session(1)]);
    open();
    end(await running());
    world.setup = { state: 'waiting', error: null, readiness: null };
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why?' })).toEqual({ status: 'refused', reason: 'setting-up' });
    world.setup = null;
    const live = fake.latest();
    live.modeChange = 'hold';
    const changing = runtime.setMode(S(1), 'edits-ok');
    await flush();
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why?' })).toEqual({ status: 'refused', reason: 'changing-mode' });
    live.settleMode({ confirmed: true });
    expect(await changing).toEqual({ status: 'set' });
    expect(live.asked).toEqual([]);
    expect(await runtime.ask({ sessionId: S(1), asideId: A(1), text: 'Why?' })).toEqual({ status: 'accepted', asideId: A(1) });
  });

  it('refuses a decision during a change of mode for the change itself, on a card the chat holds; once it is written the same press is only stale (C90)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId, 'n:1', ONCE);
    const { id } = card();
    expect(runtime.decide(S(1), id, 'approve')).toEqual({ status: 'decided' });
    await flush();
    emit({ type: 'approval-resolved', requestId: 'n:1', reason: 'confirmed' });
    end(turnId);
    const live = fake.latest();
    live.modeChange = 'hold';
    const changing = runtime.setMode(S(1), 'edits-ok');
    await flush();
    expect(runtime.decide(S(1), id, 'deny')).toEqual({ status: 'refused', reason: 'changing-mode' });
    live.settleMode({ confirmed: true });
    expect(await changing).toEqual({ status: 'set' });
    expect(runtime.decide(S(1), id, 'deny')).toEqual({ status: 'refused', reason: 'not-pending' });
    // Neither press wrote anything, or reached the process.
    expect(body(read().items.find((item) => item.id === id))).toMatchObject({ outcome: 'approved' });
    expect(live.decided).toEqual([{ requestId: 'n:1', choice: 'approve' }]);
  });

  it('takes a decision on a pending card while the chat’s mode blocks a prompt: it is decided under the mode in force on its process (C13, C89)', async () => {
    world.availability = READY;
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId, 'n:1', ONCE);
    // The account can no longer use the chat's mode: a prompt is blocked, and the live card is not.
    world.availability = [available('read-only'), available('ask-first', { available: false, reason: 'needs-setup' }), available('edits-ok'), available('sandbox-ok')];
    service.availabilityChanged();
    expect(entry()).toMatchObject({ block: 'mode-unavailable', mode: { id: 'ask-first' } });
    expect(runtime.decide(S(1), card().id, 'approve')).toEqual({ status: 'decided' });
    await flush();
    expect(body()).toMatchObject({ outcome: 'approved', delivered: true });
    expect(fake.latest().decided).toEqual([{ requestId: 'n:1', choice: 'approve' }]);
    end(turnId);
    expect(await runtime.send(S(1), 'Again')).toEqual({ status: 'refused', reason: 'mode-unavailable' });
  });

  it('refuses a mode the account cannot use under the unconfirmed block too, with that mode’s own reason, and the block stands (C89)', async () => {
    world.availability = [...READY.slice(0, 3), available('sandbox-ok', { available: false, reason: 'needs-setup', setup: true })];
    place([session(1)]);
    open();
    expect(await runtime.send(S(1), 'Hello')).toEqual({ status: 'accepted' });
    end(fake.latest().sent[0]?.turnId ?? '', 'failed', 'policy-mismatch');
    fake.latest().end();
    await flush();
    expect(entry()?.block).toBe('mode-unconfirmed');
    expect(await runtime.setMode(S(1), 'sandbox-ok')).toEqual({ status: 'refused', reason: 'mode-unavailable' });
    expect(entry()).toMatchObject({ block: 'mode-unconfirmed', mode: { id: 'ask-first', source: 'fallback' } });
    expect(await runtime.setMode(S(1), 'edits-ok')).toEqual({ status: 'set' });
    expect(entry()).toMatchObject({ block: null, mode: { id: 'edits-ok', source: 'chat' } });
  });

  it('answers nothing itself under a live grant: a request the grant would cover, which the CLI still sends, is a card that waits (C21, C59)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId);
    expect(runtime.decide(S(1), card().id, 'approve-session')).toEqual({ status: 'decided' });
    await flush();
    emit({ type: 'approval-resolved', requestId: 'n:1', reason: 'confirmed' });
    expect(read().grants).toMatchObject([{ confirmed: true, live: true }]);
    // The same action, asked again by the CLI: fat-g matches nothing against its own record.
    ask(turnId, 'n:2');
    expect(cards()).toHaveLength(2);
    expect(body()).toMatchObject({ outcome: 'pending', delivered: null });
    expect(summary()).toMatchObject({ attention: { kind: 'approval', count: 1 }, action: { kind: 'approving' } });
    expect(fake.latest().decided).toEqual([{ requestId: 'n:1', choice: 'approve-session' }]);
  });

  it('shows no grant as sent for a decision written and never heard of: lost with its process, and after a restart, it is in no list and its card says so (C92)', async () => {
    place([session(1)]);
    open();
    const turnId = await running();
    ask(turnId);
    const { id } = card();
    // The write to the process neither went nor failed, as far as fat-g knows: a crash between the two.
    fake.latest().delivery = 'silent';
    expect(runtime.decide(S(1), id, 'approve-session')).toEqual({ status: 'decided' });
    await flush();
    expect(body()).toMatchObject({ outcome: 'approved-session', delivered: null, confirmedAt: null });
    expect(read().grants).toEqual([]);
    fake.latest().end();
    await flush();
    expect(read().grants).toEqual([]);
    await restart();
    const kept = body(read().items.find((item) => item.id === id));
    expect(kept).toMatchObject({ outcome: 'approved-session', delivered: null, confirmedAt: null, grant: { live: false } });
    expect(read().grants).toEqual([]);
    // Its turn is over: the card says what is known, and no more.
    expect(outcomeWords(kept, true)).toBe('Approved for this session; the CLI did not confirm it');
    expect(runtime.decide(S(1), id, 'approve')).toEqual({ status: 'refused', reason: 'not-pending' });
  });
});
