// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, V11, V15, V19 (docs/planning/_archive/M18.md, Design 8–10; C21–C24, C30–C32, C35, C41, C42): the
// conversation store's channels, and the removals that take a saved chat with its record — through
// the real contract and dispatcher, on a real records store, conversation store, session service
// and app state.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_ENTRIES } from '@shared/contracts/conversation';
import { INVOKE_CHANNELS, type InvokeChannel } from '@shared/ipc/channels';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { STORE_FILE } from '../../conversations/format';
import { type ConversationStore, createConversationStore } from '../../conversations/store';
import { createPlanStore } from '../../plans/store';
import { createLookups } from '../../records/lookup';
import { RECORDS_FILE, RECORDS_VERSION } from '../../records/format';
import { createRecordsStore, type RecordsStore } from '../../records/store';
import { createRemoval } from '../../sessions/removal';
import { createSessionService, type SessionService } from '../../sessions/service';
import { type AppStateStore, createAppStateStore } from '../../state/app-state-store';
import { type ConversationsFollower, followConversations } from '../../state/conversations';
import { projectForWindow } from '../../state/projection';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { conversationsHandlers } from './conversations';
import { projectHandlers } from './projects';
import { sessionHandlers } from './sessions';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const OTHER_PROJECT = '9b2d6c1e-4f3a-4e8b-8c7d-6a5b4c3d2e1f';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-01-25T13:00:00.000Z');
const SECRET = 'PRIVATE-first-prompt-of-a-chat';

let dir: string;
let records: RecordsStore;
let conversations: ConversationStore;
let store: AppStateStore;
let sessions: SessionService;
let follower: ConversationsFollower;
let afterStartFresh: ReturnType<typeof vi.fn<() => void>>;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-conversations-ipc-'));
  for (const spy of Object.values(log)) spy.mockClear();
});
afterEach(() => {
  sessions?.stop();
  follower?.stop();
  conversations?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const project = (id = PROJECT, name = 'fat-g') => ({ id, name, color: 'teal', hidden: false, providers: ['codex'], roots: [{ path: `D:\\Code\\${name}` }] });
const session = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: null, nameSource: null,
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT, lastActiveAt: AT, lastTurn: null, ...overrides,
});
const place = (stored: unknown[], projects: unknown[] = [project()]) => writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects, sessions: stored }));
/** A saved chat for a session id: a prompt and an answer. */
function chat(id: string, prompt = 'a prompt', turns = 1): void {
  for (let n = 1; n <= turns; n += 1) conversations.acceptPrompt({ conversationId: id, turnId: `${id}-t${n}`, itemId: `${id}-m${n}`, text: n === 1 ? prompt : `prompt ${n}`, at: AT + n, started: false });
}

function open() {
  records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'win32', now: () => AT, log });
  conversations = createConversationStore({ dir, log, now: () => AT });
  store = createAppStateStore();
  sessions = createSessionService({ records, store, now: () => AT, platform: 'win32', log });
  follower = followConversations({ conversations, records, store });
  const removal = createRemoval({ store: conversations, log });
  afterStartFresh = vi.fn<() => void>();
  return {
    ...conversationsHandlers({ conversations, records, detached: () => follower.detached(), removal, afterStartFresh, log }),
    ...sessionHandlers({ sessions, records, store, hasProvider: () => true, removal }),
    ...projectHandlers({ openFolder: () => Promise.resolve(''), showInFolder: () => undefined, records, lookups: createLookups(), hasProvider: () => true, pickFolder: () => Promise.resolve(null), checkRoots: () => undefined, removing: (projectId, write) => sessions.removingProject(projectId, write), removal, platform: 'win32' }),
  };
}

const deps = (): DispatchDeps => ({ origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log, detail: 'kinds' });
const from = (kind: 'main' | 'pet', request: unknown) => ({ windowKind: kind, sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true }, request });
function ask(handlers: ReturnType<typeof open>, channel: InvokeChannel, request: unknown, kind: 'main' | 'pet' = 'main') {
  const handler = (handlers as unknown as Record<string, Handler<unknown, unknown>>)[channel] ?? vi.fn();
  return dispatchInvoke(channel, INVOKE_SPECS[channel] as never, handler, from(kind, request), deps());
}
const value = async (answer: ReturnType<typeof ask>) => { const result = await answer; if (!result.ok) throw new Error(`failed: ${result.error}`); return result.value as Record<string, unknown>; };
const held = (id: string) => conversations.conversation(id) !== null;
const CHANNELS = INVOKE_CHANNELS.filter((channel) => channel.startsWith('conversations:') || channel === 'chat:page');
const validFor = (channel: InvokeChannel): unknown => ({
  'conversations:readDetached': { id: S(9) }, 'conversations:removeDetached': { ids: [S(9)] }, 'conversations:removeSetAside': { all: true }, 'chat:page': { sessionId: S(1), before: 'item' },
} as Record<string, unknown>)[channel] ?? null;

describe('a removal takes the saved chat with its record (V10; C21, C30)', () => {
  it('removes a session’s chat with the session, and no other', async () => {
    place([session(1), session(2)]);
    const handlers = open();
    chat(S(1));
    chat(S(2));
    expect(await value(ask(handlers, 'sessions:remove', { id: S(1) }))).toEqual({ status: 'saved' });
    expect([held(S(1)), held(S(2))]).toEqual([false, true]);
    expect(records.getSession(S(1))).toBeUndefined();
  });

  it('removes the chats of every session a project’s removal takes, an unreadable entry’s included', async () => {
    // The third entry is one this build cannot read: its id is still its chat's.
    place([session(1), session(2), { ...session(3), model: 7 }, session(4, { projectId: OTHER_PROJECT })], [project(), project(OTHER_PROJECT, 'website')]);
    const handlers = open();
    for (const n of [1, 2, 3, 4]) chat(S(n));
    expect(await value(ask(handlers, 'projects:remove', { key: PROJECT }))).toEqual({ status: 'saved' });
    expect([1, 2, 3, 4].map((n) => held(S(n)))).toEqual([false, false, false, true]);
  });

  it('removes the chats of the sessions without a project with their entries', async () => {
    place([session(1), session(2, { projectId: S(77) })]);
    const handlers = open();
    chat(S(1));
    chat(S(2));
    expect(await value(ask(handlers, 'sessions:removeOrphans', null))).toEqual({ status: 'saved' });
    expect([held(S(1)), held(S(2))]).toEqual([true, false]);
  });

  it('keeps the chat when the removal is refused: a running session’s, and an unknown one’s', async () => {
    place([session(1)]);
    const handlers = open();
    chat(S(1));
    sessions.apply({ type: 'turn-started', sessionId: S(1), turnId: 't1' });
    expect(await value(ask(handlers, 'sessions:remove', { id: S(1) }))).toEqual({ status: 'refused', reason: 'running' });
    expect(await value(ask(handlers, 'projects:remove', { key: PROJECT }))).toEqual({ status: 'refused', reason: 'session-running' });
    expect(await value(ask(handlers, 'sessions:remove', { id: S(8) }))).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(held(S(1))).toBe(true);
    expect(conversations.removing()).toEqual([]);
  });

  it('deletes nothing a record’s loss did not ask for: a chat whose record is gone stays, as a detached one (C30)', () => {
    place([session(1)]);
    open();
    chat(S(1));
    chat(S(5), 'its session was never listed');
    expect(held(S(5))).toBe(true);
    expect(follower.detached().map((entry) => entry.id)).toEqual([S(5)]);
    expect(store.getSnapshot().conversations).toEqual({ status: { kind: 'ok' }, detached: 1 });
  });
});

describe('while the conversation store is refused (V14, V19; C33, C42)', () => {
  function refuse(): void {
    conversations = createConversationStore({ dir, log });
    conversations.close();
    // A store a later fat-g wrote.
    const raw = createConversationStore({ dir, log, version: 1 });
    raw.close();
    writeFileSync(path.join(dir, STORE_FILE), Buffer.concat([Buffer.from('not a database at all, '), Buffer.alloc(4096, 7)]));
  }

  it('refuses the removal of a session, of a project and of the sessions without a project, and leaves the records as they were', async () => {
    refuse();
    place([session(1), session(2, { projectId: S(77) })]);
    const handlers = open();
    expect(conversations.status()).toEqual({ kind: 'refused', cause: 'damaged' });
    expect(store.getSnapshot().conversations).toEqual({ status: { kind: 'refused', cause: 'damaged' }, detached: 0 });
    const refused = { status: 'refused', reason: 'conversations-refused' };
    expect(await value(ask(handlers, 'sessions:remove', { id: S(1) }))).toEqual(refused);
    expect(await value(ask(handlers, 'projects:remove', { key: PROJECT }))).toEqual(refused);
    expect(await value(ask(handlers, 'sessions:removeOrphans', null))).toEqual(refused);
    expect(records.getView().sessions.map((record) => record.id)).toEqual([S(1)]);
    expect(records.getView().orphans).toBe(1);
  });

  it('starts fresh after the files are moved aside, tells main to reconcile, and lists the store that was set aside', async () => {
    refuse();
    place([session(1)]);
    const handlers = open();
    const answer = await value(ask(handlers, 'conversations:startFresh', null));
    expect(answer['status']).toBe('done');
    expect(afterStartFresh).toHaveBeenCalledOnce();
    expect(conversations.status()).toEqual({ kind: 'ok' });
    expect(store.getSnapshot().conversations).toEqual({ status: { kind: 'ok' }, detached: 0 });
    const storage = await value(ask(handlers, 'conversations:storage', null));
    expect((storage['setAside'] as { name: string }[]).map((entry) => entry.name)).toHaveLength(1);
    // Asked again, there is nothing to start over from.
    expect(await value(ask(handlers, 'conversations:startFresh', null))).toEqual({ status: 'refused', reason: 'not-refused' });
    expect(afterStartFresh).toHaveBeenCalledOnce();
  });

  it('removes a set-aside store by the name Start fresh gave it, and no other file (C41)', async () => {
    refuse();
    place([session(1)]);
    const handlers = open();
    await ask(handlers, 'conversations:startFresh', null);
    const [aside] = (await value(ask(handlers, 'conversations:storage', null)))['setAside'] as { name: string; bytes: number }[];
    expect(aside?.bytes).toBeGreaterThan(0);
    expect(await ask(handlers, 'conversations:removeSetAside', { names: [RECORDS_FILE] })).toEqual({ ok: false, error: 'bad-request' });
    expect(await ask(handlers, 'conversations:removeSetAside', { names: [STORE_FILE] })).toEqual({ ok: false, error: 'bad-request' });
    expect(await value(ask(handlers, 'conversations:removeSetAside', { names: [aside?.name] }))).toEqual({ status: 'saved', removed: 1, failed: 0 });
    expect(readdirSync(dir).filter((name) => name.includes('set-aside'))).toEqual([]);
    expect(readdirSync(dir)).toEqual(expect.arrayContaining([RECORDS_FILE, STORE_FILE]));
    // Nothing left to remove: all of none.
    expect(await value(ask(handlers, 'conversations:removeSetAside', { all: true }))).toEqual({ status: 'saved', removed: 0, failed: 0 });
  });
});

describe('detached conversations (V14, V15; C31, C32, C35)', () => {
  it('lists each by its first prompt’s first line, clamped as a name, and by nothing for one with no prompt', async () => {
    place([session(1)]);
    const handlers = open();
    chat(S(1), 'a listed session’s chat');
    chat(S(5), `Fix the login bug\nIt fails on Tuesdays. ${'x'.repeat(200)}`);
    chat(S(6), `${'A very long first line '.repeat(10)}`);
    conversations.ensure(S(7), AT + 5);
    const listed = (await ask(handlers, 'conversations:listDetached', null)) as { ok: true; value: { id: string; name: string | null }[] };
    expect(listed.value.map((entry) => [entry.id, entry.name])).toEqual([[S(5), 'Fix the login bug'], [S(6), `${'A very long first line '.repeat(10)}`.trim().slice(0, 159) + '…'], [S(7), null]]);
  });

  it('reads one a page at a time, with no turn running, and refuses a listed session’s chat and an unknown cursor', async () => {
    place([session(1)]);
    const handlers = open();
    chat(S(1));
    chat(S(5), 'first', PAGE_ENTRIES + 20);
    const newest = await value(ask(handlers, 'conversations:readDetached', { id: S(5) }));
    expect(newest).toMatchObject({ status: 'page', sessionId: S(5), revision: 0 });
    expect(newest['items']).toHaveLength(PAGE_ENTRIES);
    expect((newest['turns'] as { state: string }[]).every((turn) => turn.state !== 'running')).toBe(true);
    const older = await value(ask(handlers, 'conversations:readDetached', { id: S(5), before: newest['older'] }));
    expect(older['items']).toHaveLength(20);
    expect(older['older']).toBeNull();
    expect(await value(ask(handlers, 'conversations:readDetached', { id: S(1) }))).toEqual({ status: 'refused', reason: 'unknown-conversation' });
    expect(await value(ask(handlers, 'conversations:readDetached', { id: S(5), before: 'no-such-item' }))).toEqual({ status: 'refused', reason: 'unknown-cursor' });
  });

  it('removes one, or all, and only what is detached', async () => {
    place([session(1)]);
    const handlers = open();
    chat(S(1));
    for (const n of [5, 6, 7]) chat(S(n));
    expect(await value(ask(handlers, 'conversations:removeDetached', { ids: [S(1)] }))).toEqual({ status: 'refused', reason: 'unknown-conversation' });
    expect(await value(ask(handlers, 'conversations:removeDetached', { ids: [S(5)] }))).toEqual({ status: 'saved' });
    expect([5, 6, 7].map((n) => held(S(n)))).toEqual([false, true, true]);
    expect(store.getSnapshot().conversations?.detached).toBe(2);
    expect(await value(ask(handlers, 'conversations:removeDetached', { all: true }))).toEqual({ status: 'saved' });
    expect([1, 6, 7].map((n) => held(S(n)))).toEqual([true, false, false]);
    expect(store.getSnapshot().conversations?.detached).toBe(0);
  });

  it('attaches a conversation again by its id when its record returns, and counts every chat while records are refused without offering their removal (C31, C32)', async () => {
    writeFileSync(path.join(dir, RECORDS_FILE), '{');
    const handlers = open();
    chat(S(1));
    // Records refused: no session is listed, so its chat counts as detached, and is not removed.
    expect(store.getSnapshot().conversations?.detached).toBe(1);
    expect(await value(ask(handlers, 'conversations:removeDetached', { all: true }))).toEqual({ status: 'refused', reason: 'records-refused' });
    expect(held(S(1))).toBe(true);
    // The file is repaired, and Try again reads it: the chat is its session's again.
    place([session(1)]);
    expect(records.retry()).toEqual({ status: 'loaded' });
    expect(store.getSnapshot().conversations?.detached).toBe(0);
    expect(await value(ask(handlers, 'conversations:removeDetached', { ids: [S(1)] }))).toEqual({ status: 'refused', reason: 'unknown-conversation' });
  });

  it('neither shows nor counts a conversation a removal has marked (C63)', async () => {
    place([]);
    const handlers = open();
    chat(S(5));
    conversations.markRemoving([S(5)]);
    expect(store.getSnapshot().conversations?.detached).toBe(0);
    expect(((await ask(handlers, 'conversations:listDetached', null)) as { value: unknown[] }).value).toEqual([]);
    expect(await value(ask(handlers, 'conversations:readDetached', { id: S(5) }))).toEqual({ status: 'refused', reason: 'unknown-conversation' });
  });
});

describe('the storage view’s numbers (V11; C23)', () => {
  it('gives the store’s size, the detached count and their text’s size', async () => {
    place([session(1)]);
    const handlers = open();
    chat(S(1), 'x'.repeat(5000));
    chat(S(5), 'y'.repeat(900));
    const storage = await value(ask(handlers, 'conversations:storage', null));
    expect(storage['status']).toEqual({ kind: 'ok' });
    expect(storage['bytes']).toBeGreaterThan(4096);
    expect(storage['detached']).toMatchObject({ count: 1 });
    expect((storage['detached'] as { textUnits: number }).textUnits).toBeGreaterThan(900);
    expect((storage['detached'] as { textUnits: number }).textUnits).toBeLessThan(5000);
    expect(storage['setAside']).toEqual([]);
  });
});

describe('who may ask, and what is said (V11; C24)', () => {
  it.each(CHANNELS)('refuses the Pet on %s as forbidden', async (channel) => {
    place([session(1)]);
    const handlers = open();
    expect(INVOKE_SPECS[channel].from).toEqual(['main']);
    expect(await ask(handlers, channel, validFor(channel), 'pet')).toEqual({ ok: false, error: 'forbidden' });
  });

  it.each([
    ['conversations:storage', { all: true }],
    ['conversations:listDetached', {}],
    ['conversations:readDetached', { id: S(5), path: 'C:\\x' }],
    ['conversations:readDetached', { id: 'not-an-id' }],
    ['conversations:removeDetached', { ids: [] }],
    ['conversations:removeDetached', { ids: [S(5)], all: true }],
    ['conversations:removeSetAside', { names: ['..\\records.json'] }],
    ['conversations:removeSetAside', { names: ['conversations.set-aside.2020-01-25T14-03-12Z.sqlite'], force: true }],
    ['conversations:startFresh', { keep: false }],
  ] as const)('refuses a bad request on %s (%j)', async (channel, request) => {
    place([]);
    const handlers = open();
    expect(await ask(handlers, channel, request)).toEqual({ ok: false, error: 'bad-request' });
  });

  it('puts no text, name or id of a chat in a log, in the app state or in the Pet’s projection', async () => {
    place([session(1, { name: 'A listed session' })]);
    const handlers = open();
    chat(S(1), SECRET);
    chat(S(5), SECRET);
    await ask(handlers, 'conversations:listDetached', null);
    await ask(handlers, 'conversations:readDetached', { id: S(5) });
    await ask(handlers, 'conversations:storage', null);
    await ask(handlers, 'conversations:removeDetached', { ids: [S(5)] });
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(S(5));
    // The app state holds a status and a count: no text, and no conversation's id.
    const snapshot = store.getSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(Object.keys(snapshot.conversations ?? {}).sort()).toEqual(['detached', 'status']);
    // The Pet is shown none of it.
    expect(projectForWindow('pet', snapshot)).not.toHaveProperty('conversations');
  });
});

// M22b (C62, C73): a project's plans go with it — its decisions settled first, its mark written
// whole before the records' write, the plans deleted after it and the mark last; or the mark lifted.
describe('a project’s plans go with it (M22b; C62, C73)', () => {
  const source = { sessionId: S(1), turnId: 't1', providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', cause: 'plan-turn' as const, revises: null };
  function withPlans(write: 'saved' | 'refused' = 'saved') {
    const handlers = open();
    const plans = createPlanStore({ dir: path.join(dir, 'plans'), now: () => AT, log });
    plans.recover(new Set([PROJECT, OTHER_PROJECT]));
    const mine = plans.write({ planId: null, projectId: PROJECT, title: 'Mine' }, source, '# Mine');
    const theirs = plans.write({ planId: null, projectId: OTHER_PROJECT, title: 'Theirs' }, source, '# Theirs');
    const did: string[] = [];
    const project_ = projectHandlers({
      openFolder: () => Promise.resolve(''), showInFolder: () => undefined,
      records, lookups: createLookups(), hasProvider: () => true, pickFolder: () => Promise.resolve(null), checkRoots: () => undefined, platform: 'win32',
      removing: (projectId, run) => (write === 'saved' ? sessions.removingProject(projectId, run) : Promise.resolve({ status: 'refused', reason: 'storage-failed' }) as never),
      removal: createRemoval({ store: conversations, log }),
      plans: {
        settle: (projectId) => { did.push(`settle ${projectId === PROJECT ? 'mine' : 'other'}`); return Promise.resolve(0); },
        mark: (projectId) => { did.push('mark'); plans.markProject(projectId); },
        lift: (projectId) => { did.push('lift'); plans.liftProject(projectId); },
        finish: (projectId) => { did.push('finish'); plans.finishProject(projectId); },
      },
    });
    return { handlers: { ...handlers, ...project_ }, plans, mine, theirs, did };
  }

  it('settles, marks, removes the records, then deletes the project’s plans and the mark: another project’s stay', async () => {
    place([session(1)], [project(), project(OTHER_PROJECT, 'website')]);
    const { handlers, plans, mine, theirs, did } = withPlans();
    expect(await value(ask(handlers, 'projects:remove', { key: PROJECT }))).toEqual({ status: 'saved' });
    expect(did).toEqual(['settle mine', 'mark', 'finish']);
    expect(plans.get(mine.planId)).toBeNull();
    expect(plans.get(theirs.planId)).not.toBeNull();
    expect(readdirSync(path.join(dir, 'plans')).sort()).toEqual([theirs.planId]);
  });

  it('lifts the mark where the records’ write did not land, and keeps every plan', async () => {
    place([session(1)], [project(), project(OTHER_PROJECT, 'website')]);
    const { handlers, plans, mine, did } = withPlans('refused');
    expect(await value(ask(handlers, 'projects:remove', { key: PROJECT }))).toMatchObject({ status: 'refused' });
    expect(did).toEqual(['settle mine', 'mark', 'lift']);
    expect(plans.get(mine.planId)).not.toBeNull();
    expect(readdirSync(path.join(dir, 'plans')).filter((name) => name.startsWith('.removing'))).toEqual([]);
  });
});
