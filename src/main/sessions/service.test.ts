// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The session service (docs/planning/_archive/M14.md: V3's change detection, V4, V8, V21, V32, V33), on a real
// records store in a temporary folder and a real app state store. No Electron.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAvatar } from '@shared/contracts/avatars';
import type { InstanceRef } from '@shared/contracts/instances';
import type { SessionEvent } from '@shared/contracts/sessions';
import { createFolderBinding, instanceFolders } from '../instances/binding';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore, type RecordsStoreOptions } from '../records/store';
import { type AppStateStore, createAppStateStore } from '../state/app-state-store';
import { createSessionService, type SessionService, type SessionServiceOptions } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const OTHER = '9b2d6c1e-4f3a-4e8b-8c7d-6a5b4c3d2e1f';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-01-22T13:23:00.000Z');

let dir: string;
let file: string;
let clock: number;
let records: RecordsStore;
let store: AppStateStore;
let service: SessionService;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-sessions-'));
  file = path.join(dir, RECORDS_FILE);
  clock = AT;
  for (const spy of Object.values(log)) spy.mockClear();
});
afterEach(async () => {
  // A record write still under way would make the folder again once it is removed.
  await service?.settled();
  service?.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const project = (id = PROJECT, name = 'fat-g') => ({ id, name, color: 'teal', hidden: false, providers: ['codex'], roots: [{ path: `D:\\Code\\${name}` }] });
const session = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: null, nameSource: null,
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null, ...overrides,
});
const place = (sessions: unknown[], projects: unknown[] = [project()]) => writeFileSync(file, JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects, sessions }));
const stored = (n: number) => (JSON.parse(readFileSync(file, 'utf8')) as { sessions: Record<string, unknown>[] }).sessions.find((entry) => entry['id'] === S(n));

function open(options: Partial<RecordsStoreOptions> = {}, extra: Partial<SessionServiceOptions> = {}): SessionService {
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', now: () => clock, log, ...options });
  store = createAppStateStore();
  service = createSessionService({ records, store, now: () => clock, platform: 'win32', log, ...extra });
  return service;
}

const summary = (n: number) => service.snapshot().sessions.find((entry) => entry.record.id === S(n))?.summary;
const send = (n: number, event: Record<string, unknown>, at?: number) => {
  if (at !== undefined) clock = at;
  service.apply({ sessionId: S(n), ...event });
};
const turn = (n: number, turnId = 't1', at?: number) => send(n, { type: 'turn-started', turnId }, at);
const end = (n: number, outcome = 'completed', turnId = 't1', at?: number) => send(n, { type: 'turn-ended', turnId, outcome }, at);

describe('selection unfolds its project', () => {
  it('expands on creation in the same write as the new session', async () => {
    place([], [{ ...project(), collapsed: true }]);
    const write = vi.fn((target: string, text: string) => { writeFileSync(target, text); return Promise.resolve(); });
    open({ write });
    const made = await service.create(PROJECT, { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null });
    expect(made.status).toBe('saved');
    expect(write).toHaveBeenCalledTimes(1);
    expect(records.getProject(PROJECT)?.collapsed).toBe(false);
    expect(service.snapshot().selectedId).toBe(made.status === 'saved' ? made.id : null);
  });

  it('persists expansion on selection and reselection, but permits folding the current chat', async () => {
    place([session(1)], [{ ...project(), collapsed: true }]);
    open();
    expect(await service.select(S(1))).toEqual({ status: 'saved' });
    expect(records.getProject(PROJECT)?.collapsed).toBe(false);
    await records.setCollapsed(PROJECT, true);
    expect(service.snapshot().selectedId).toBe(S(1));
    expect(records.getProject(PROJECT)?.collapsed).toBe(true);
    expect(await service.select(S(1))).toEqual({ status: 'saved' });
    expect(records.getProject(PROJECT)?.collapsed).toBe(false);
    expect(createRecordsStore({ dir, platform: 'win32', log }).getProject(PROJECT)?.collapsed).toBe(false);
  });

  it('keeps the previous selection and fold when expansion cannot be saved', async () => {
    place([session(1), session(2, { projectId: OTHER })], [{ ...project(), collapsed: true }, project(OTHER, 'other')]);
    open({ write: () => Promise.reject(new Error('disk')) });
    await service.select(S(2));
    expect(await service.select(S(1))).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(service.snapshot().selectedId).toBe(S(2));
    expect(records.getProject(PROJECT)?.collapsed).toBe(true);
  });

  it('does not let a delayed expansion override the latest selection', async () => {
    place([session(1), session(2, { projectId: OTHER })], [{ ...project(), collapsed: true }, project(OTHER, 'other')]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    open({ write: async (target, text) => { await gate; writeFileSync(target, text); } });
    const first = service.select(S(1));
    const second = service.select(S(2));
    release();
    await Promise.all([first, second]);
    expect(service.snapshot().selectedId).toBe(S(2));
    expect(records.getProject(PROJECT)?.collapsed).toBe(false);
  });

  it('expands after a manual fold that is still being written', async () => {
    place([session(1)]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    open({ write: async (target, text) => { await gate; writeFileSync(target, text); } });
    const folding = records.setCollapsed(PROJECT, true);
    expect(records.getProject(PROJECT)?.collapsed).toBe(false);
    const selecting = service.select(S(1));
    release();
    await Promise.all([folding, selecting]);
    expect(records.getProject(PROJECT)?.collapsed).toBe(false);
    expect(service.snapshot().selectedId).toBe(S(1));
  });

  it('revalidates a session removed while its project is unfolding', async () => {
    place([session(1)], [{ ...project(), collapsed: true }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    open({ write: async (target, text) => { await gate; writeFileSync(target, text); } });
    const selecting = service.select(S(1));
    const removing = records.removeSession(S(1));
    release();
    await Promise.all([selecting, removing]);
    expect(service.snapshot().selectedId).toBeNull();
  });
});

// ── At start ──────────────────────────────────────────────────────────────────────────────────
describe('at start', () => {
  it('puts every session with its launch summary in the app state, in stored order, with none selected', () => {
    place([session(1), session(2, { reference: 'r', folder: 'D:\\Code\\fat-g', lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: null, outcome: null } })]);
    open();
    const state = store.getSnapshot().sessions;
    expect(state).toBe(service.snapshot());
    expect(state?.selectedId).toBeNull();
    expect(state?.orphans).toBe(0);
    expect(state?.sessions.map((entry) => [entry.record.id, entry.summary.status, entry.summary.attention?.kind ?? null])).toEqual([[S(1), 'not-started', null], [S(2), 'idle', 'stopped']]);
  });

  it('shows the page neither the reference, the folder nor the configuration folder (C65; M14b, C61)', () => {
    place([session(1, { reference: 'private-reference', folder: 'D:\\Private\\folder', configFolder: 'D:\\Private\\account' })]);
    open();
    expect(JSON.stringify(store.getSnapshot().sessions)).not.toMatch(/private-reference|Private/);
    expect(Object.keys(store.getSnapshot().sessions?.sessions[0]?.record ?? {}).sort()).toEqual(
      ['completedAt', 'createdAt', 'effort', 'id', 'instanceId', 'lastActiveAt', 'model', 'name', 'nameSource', 'projectId', 'providerId', 'shelvedAt', 'speed', 'starred', 'toDo', 'toVerify'],
    );
    // Beside them: what it is held for, and why it cannot take a prompt, each one word (M15, C105); its
    // chat's mode, an id and where it came from, and whether a change of it is under way (M22, C1, C90);
    // and the avatar it draws, ids alone (M102, C29).
    expect(Object.keys(store.getSnapshot().sessions?.sessions[0] ?? {}).sort()).toEqual(['avatar', 'block', 'changingMode', 'hold', 'mode', 'record', 'summary']);
  });

  it('writes nothing at launch: a record without an end stays so (C105)', () => {
    place([session(1, { lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: null, outcome: null } })]);
    const before = readFileSync(file, 'utf8');
    open();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('gives no summary to a session whose project cannot be read, and counts the ones without a project', () => {
    place([session(1), session(2, { projectId: OTHER }), session(3, { projectId: S(77) })], [project(), { id: OTHER, name: 5 }]);
    open();
    expect(service.snapshot().sessions.map((entry) => entry.record.id)).toEqual([S(1)]);
    expect(service.snapshot().orphans).toBe(1);
    expect(service.record(S(2))).toBeUndefined();
  });

  it('holds no session while the records are refused', async () => {
    writeFileSync(file, '{');
    open();
    expect(service.snapshot()).toEqual({ sessions: [], selectedId: null, orphans: 0 });
    expect(await service.setFlag(S(1), 'starred', true)).toEqual({ status: 'refused', reason: 'records-refused' });
    expect(await service.move(S(1), null, { list: 'active', starred: false })).toEqual({ status: 'refused', reason: 'records-refused' });
    expect(await service.remove(S(1))).toEqual({ status: 'refused', reason: 'records-refused' });
  });
});

// ── V4: sources ───────────────────────────────────────────────────────────────────────────────
describe('sources (V4)', () => {
  it('takes a source’s events once attached, and none once detached (C25)', () => {
    place([session(1)]);
    open();
    let listener: ((event: SessionEvent) => void) | null = null;
    const detach = service.attach({ subscribe: (given) => { listener = given; return () => { listener = null; }; } });
    (listener as ((event: SessionEvent) => void) | null)?.({ type: 'turn-started', sessionId: S(1), turnId: 't1' });
    expect(summary(1)?.status).toBe('running');
    detach();
    expect(listener).toBeNull();
  });

  it('refuses and counts an event for a session the records do not hold (C26)', () => {
    place([session(1), session(2, { projectId: OTHER })], [project(), { id: OTHER, name: 5 }]);
    open();
    const seq = store.getSnapshot().seq;
    turn(9);
    turn(2);
    expect(store.getSnapshot().seq).toBe(seq);
    expect(log.warn).toHaveBeenCalledWith('[sessions] event refused (unknown session), 1 so far');
    for (let index = 0; index < 8; index += 1) turn(9);
    expect(log.warn).toHaveBeenCalledWith('[sessions] event refused (unknown session), 10 so far');
    expect(log.warn.mock.calls.filter(([text]) => String(text).startsWith('[sessions]'))).toHaveLength(2);
  });

  it('refuses and counts what is not an event, an extra field included', () => {
    place([session(1)]);
    open();
    service.apply({ type: 'turn-started', sessionId: S(1), turnId: 't1', prompt: 'do something private' });
    service.apply('turn-started');
    send(1, { type: 'reference-set', reference: 'r', folder: 'relative\\folder' });
    expect(summary(1)?.status).toBe('not-started');
    expect(log.warn).toHaveBeenCalledWith('[sessions] event refused (not an event), 1 so far');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('private');
  });

  it('stores the reference and its folder in one write, as a root is stored, and keeps them from then on (C5, C6)', async () => {
    place([session(1)]);
    const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
    open({ write });
    send(1, { type: 'reference-set', reference: '019f2c1a-7b3e', folder: 'D:/Code/fat-g/' });
    await service.settled();
    expect(write).toHaveBeenCalledOnce();
    expect(stored(1)).toMatchObject({ reference: '019f2c1a-7b3e', folder: 'D:\\Code\\fat-g' });
    expect(summary(1)?.status).toBe('idle');
    send(1, { type: 'reference-set', reference: 'another', folder: 'E:\\elsewhere' });
    await service.settled();
    expect(write).toHaveBeenCalledOnce();
    expect(stored(1)).toMatchObject({ reference: '019f2c1a-7b3e', folder: 'D:\\Code\\fat-g' });
  });

  it('writes the last turn and the last-active time when a turn starts, and again when it ends (C10)', async () => {
    place([session(1)]);
    open();
    turn(1, 't1', AT + 1000);
    await service.settled();
    expect(stored(1)).toMatchObject({ lastTurn: { startedAt: AT + 1000, endedAt: null, outcome: null }, lastActiveAt: AT + 1000 });
    end(1, 'interrupted', 't1', AT + 9000);
    await service.settled();
    expect(stored(1)).toMatchObject({ lastTurn: { startedAt: AT + 1000, endedAt: AT + 9000, outcome: 'interrupted' }, lastActiveAt: AT + 9000 });
  });

  it('takes a shelved session off the shelf in the same write as the turn’s start', async () => {
    place([session(1, { reference: 'r', folder: 'D:\\Code\\fat-g', shelvedAt: AT - 100, toVerify: true })]);
    const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
    open({ write });
    turn(1);
    await service.settled();
    expect(write).toHaveBeenCalledOnce();
    // Its flags stay: only Done clears them.
    expect(stored(1)).toMatchObject({ shelvedAt: null, toVerify: true, lastTurn: { startedAt: AT, endedAt: null } });
  });

  it('clears a completion in the same write as the turn’s start: a turn reopens a completed session (C35)', async () => {
    place([session(1, { completedAt: AT - 100 })]);
    const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
    open({ write });
    turn(1);
    await service.settled();
    expect(write).toHaveBeenCalledOnce();
    expect(stored(1)).toMatchObject({ completedAt: null, lastTurn: { startedAt: AT, endedAt: null } });
    expect(service.snapshot().sessions[0]?.record.completedAt).toBeNull();
  });

  it('applies the fallback order to a reported name: a lower rank is refused, the same or a higher one replaces (C9)', async () => {
    place([session(1, { name: 'From the provider', nameSource: 'provider' })]);
    open();
    const name = async (text: string, source: string) => { send(1, { type: 'name-reported', name: text, source }); await service.settled(); return stored(1)?.['name']; };
    expect(await name('From the first message', 'first-message')).toBe('From the provider');
    expect(await name('  Renamed  by the provider ', 'provider')).toBe('Renamed by the provider');
    expect(await name('Generated', 'generated')).toBe('Generated');
    expect(await name('By the user', 'user')).toBe('By the user');
    expect(await name('Generated again', 'generated')).toBe('By the user');
    expect(stored(1)?.['nameSource']).toBe('user');
    expect(service.snapshot().sessions[0]?.record).toMatchObject({ name: 'By the user', nameSource: 'user' });
  });

  it('writes nothing for what only the summary holds: actions, workers, requests, the model in force (C12, C14)', async () => {
    place([session(1)]);
    open();
    turn(1);
    await service.settled();
    const before = readFileSync(file, 'utf8');
    send(1, { type: 'action-changed', turnId: 't1', kind: 'reading', file: 'notes.txt' });
    send(1, { type: 'worker-started', workerId: 'w1', description: 'Explore' });
    send(1, { type: 'worker-progressed', workerId: 'w1', kind: 'thinking' });
    send(1, { type: 'request-raised', owner: { turnId: 't1' }, requestId: 'q1', kind: 'question', count: 1 });
    send(1, { type: 'in-force', model: 'gpt-5.6-sol' });
    await service.select(S(1));
    await service.settled();
    expect(summary(1)).toMatchObject({ activeWorkers: 1, action: { kind: 'asking' }, attention: { kind: 'question', acknowledged: false }, model: 'gpt-5.6-sol' });
    send(1, { type: 'request-resolved', owner: { turnId: 't1' }, requestId: 'q1' });
    expect(summary(1)?.action?.label).toBe('Reading notes.txt');
    send(1, { type: 'action-changed', turnId: 't1', kind: 'thinking' });
    expect(summary(1)?.displayHold?.kind).toBe('reading');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(file, 'utf8')).not.toMatch(/attention|activeWorkers|agents|Explore|notes\.txt|displayHold|subagents/);
  });

  it('keeps what the event said when the write fails, and logs the kind only (C66)', async () => {
    place([session(1, { name: 'Private plan', nameSource: 'user' })]);
    open({ write: () => Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, rename '${file}'`), { code: 'EPERM' })) });
    turn(1);
    await service.settled();
    expect(summary(1)?.status).toBe('running');
    expect(log.error).toHaveBeenCalledWith('[sessions] a record change could not be saved (Error EPERM)');
    expect(JSON.stringify(log.error.mock.calls)).not.toMatch(/Private|fatg-sessions/);
  });
});

// ── C24: change detection ─────────────────────────────────────────────────────────────────────
describe('change detection (V3; C24)', () => {
  it('leaves seq where it was for an identical event, and pushes a timestamp once', async () => {
    place([session(1)]);
    open();
    turn(1);
    await service.settled();
    send(1, { type: 'action-changed', turnId: 't1', kind: 'thinking' });
    const seq = store.getSnapshot().seq;
    const state = store.getSnapshot().sessions;
    send(1, { type: 'action-changed', turnId: 't1', kind: 'thinking' });
    send(1, { type: 'in-force', model: 'gpt-6-sol', effort: 'high' });
    clock += 60_000;
    send(1, { type: 'action-changed', turnId: 't1', kind: 'thinking' });
    expect(store.getSnapshot().seq).toBe(seq);
    expect(store.getSnapshot().sessions).toBe(state);
    // The turn's start was stamped once; a minute on, nothing was pushed for the time passing.
    expect(summary(1)?.turnStartedAt).toBe(AT);
  });

  it('keeps the entries of the sessions an event did not touch', () => {
    place([session(1), session(2)]);
    open();
    const [first, second] = service.snapshot().sessions;
    turn(1);
    const [nextFirst, nextSecond] = service.snapshot().sessions;
    expect(nextFirst).not.toBe(first);
    expect(nextSecond).toBe(second);
  });
});

// ── V8: selection ─────────────────────────────────────────────────────────────────────────────
describe('selection (V8; C33, C34)', () => {
  const ready = () => { turn(1); end(1); };

  it('is none at launch, and never saved', async () => {
    place([session(1)]);
    open();
    expect(service.snapshot().selectedId).toBeNull();
    await service.select(S(1));
    await service.settled();
    expect(readFileSync(file, 'utf8')).not.toMatch(/selected/i);
    service.stop();
    expect(open().snapshot().selectedId).toBeNull();
  });

  it('selects one session, and acknowledges its ready notification', async () => {
    place([session(1), session(2)]);
    open();
    ready();
    expect(summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: false });
    expect(await service.select(S(1))).toEqual({ status: 'saved' });
    expect(service.snapshot().selectedId).toBe(S(1));
    expect(summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: true });
    expect(await service.select(S(2))).toEqual({ status: 'saved' });
    expect(service.snapshot().selectedId).toBe(S(2));
  });

  // Decision 0011, item 12: viewing preserves order, including a manual placement.
  it.each(['active', 'shelf', 'completed'] as const)('preserves saved and manually moved positions when viewing %s sessions', async (list) => {
    const state = { shelvedAt: list === 'shelf' ? AT : null, completedAt: list === 'completed' ? AT : null };
    place([session(1, state), session(2, state), session(3, { ...state, starred: true }), session(4, state)]);
    open();
    const order = () => records.getView().sessions.map((record) => record.id);
    await service.select(S(4));
    await service.settled();
    expect(order()).toEqual([S(1), S(2), S(3), S(4)]);
    await service.move(S(4), S(2), { list, starred: false });
    await service.select(S(1));
    await service.select(S(4));
    await service.settled();
    expect(order()).toEqual([S(1), S(4), S(2), S(3)]);
    // Viewing a starred session preserves its place too.
    await service.select(S(3));
    await service.settled();
    expect(order()).toEqual([S(1), S(4), S(2), S(3)]);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { sessions: { id: string }[] }).sessions.map((entry) => entry.id)).toEqual(order());
  });

  it('views an expanded project without an ordering write, even when writes would fail', async () => {
    place([session(1), session(2)]);
    const write = vi.fn(() => Promise.reject(new Error('disk')));
    open({ write });
    expect(await service.select(S(2))).toEqual({ status: 'saved' });
    await service.settled();
    expect(service.snapshot().selectedId).toBe(S(2));
    expect(records.getView().sessions.map((record) => record.id)).toEqual([S(1), S(2)]);
    expect(write).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  // M100 (C49, V12): the current chat has the focus already, so its READY never lights its capsule.
  it('acknowledges a ready attention of the selected session as it arrives, and of no other session', async () => {
    place([session(1), session(2)]);
    open();
    await service.select(S(1));
    turn(1);
    turn(2);
    end(1);
    end(2);
    expect(summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: true });
    expect(summary(2)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: false });
  });

  // The user away from the Main window has not seen it, so the Pet keeps it.
  it('keeps the selected session’s ready lit while the Main window is away, until it takes the focus', async () => {
    let focused = false;
    place([session(1), session(2)]);
    open({}, { mainHasFocus: () => focused });
    await service.select(S(1));
    turn(1);
    end(1);
    expect(summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: false });
    focused = true;
    service.mainFocused();
    expect(summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: true });
  });

  it('leaves the selected session lit when a press on the Pet brings the Main window forward for another', async () => {
    place([session(1), session(2)]);
    open({}, { mainHasFocus: () => false });
    await service.select(S(1));
    turn(1);
    turn(2);
    end(1);
    end(2);
    service.revealing(S(2));
    service.mainFocused();
    expect(summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: false });
    await service.select(S(2));
    expect(summary(2)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: true });
    // The press is spent: the next focus is the user's return to what the window shows.
    service.mainFocused();
    expect(summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: false });
    expect(summary(2)?.attention?.acknowledged).toBe(true);
  });

  it('acknowledges the pressed session on focus when the Pet opens the one already selected', async () => {
    place([session(1)]);
    open({}, { mainHasFocus: () => false });
    await service.select(S(1));
    turn(1);
    end(1);
    service.revealing(S(1));
    service.mainFocused();
    expect(summary(1)?.attention).toEqual({ kind: 'ready', count: 1, acknowledged: true });
  });

  it('keeps an error lit on focus, as on arrival (C49)', async () => {
    place([session(1)]);
    open({}, { mainHasFocus: () => false });
    await service.select(S(1));
    turn(1);
    end(1, 'failed');
    service.mainFocused();
    expect(summary(1)?.attention).toEqual({ kind: 'error', count: 1, acknowledged: false });
  });

  it('lights the selected session for an error, a question or an approval, as before (C49)', async () => {
    place([session(1)]);
    open();
    await service.select(S(1));
    turn(1);
    send(1, { type: 'request-raised', owner: { turnId: 't1' }, requestId: 'q1', kind: 'question', count: 1 });
    expect(summary(1)?.attention).toEqual({ kind: 'question', count: 1, acknowledged: false });
    send(1, { type: 'request-resolved', owner: { turnId: 't1' }, requestId: 'q1' });
    send(1, { type: 'request-raised', owner: { turnId: 't1' }, requestId: 'a1', kind: 'approval', count: 1 });
    expect(summary(1)?.attention).toEqual({ kind: 'approval', count: 1, acknowledged: false });
    end(1, 'failed');
    expect(summary(1)?.attention).toEqual({ kind: 'error', count: 1, acknowledged: false });
  });

  it('acknowledges nothing at launch, where nothing is selected (C49)', () => {
    place([session(1, { reference: 'r', folder: 'D:\\Code\\fat-g', lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: null, outcome: null } })]);
    open();
    expect(service.snapshot().selectedId).toBeNull();
    expect(summary(1)?.attention).toEqual({ kind: 'stopped', count: 1, acknowledged: false });
  });

  it('acknowledges without selecting, for the Pet’s click', () => {
    place([session(1)]);
    open();
    ready();
    expect(service.acknowledge(S(1))).toEqual({ status: 'saved' });
    expect(summary(1)?.attention?.acknowledged).toBe(true);
    expect(service.snapshot().selectedId).toBeNull();
  });

  it.each(['question', 'approval', 'plan', 'review'] as const)('selection and explicit acknowledgement keep a pending %s lit', async (kind) => {
    place([session(1), session(2)]);
    open();
    if (kind === 'plan' || kind === 'review') {
      send(1, { type: kind === 'plan' ? 'plan-waiting' : 'review-waiting', waiting: true });
    } else {
      turn(1);
      send(1, { type: 'request-raised', owner: { turnId: 't1' }, requestId: 'r1', kind, count: 1 });
    }
    expect(service.acknowledge(S(1))).toEqual({ status: 'saved' });
    expect(service.snapshot().selectedId).toBeNull();
    expect(summary(1)?.attention).toEqual({ kind, count: 1, acknowledged: false });
    expect(await service.select(S(1))).toEqual({ status: 'saved' });
    await service.select(S(2));
    await service.select(S(1));
    expect(service.snapshot().selectedId).toBe(S(1));
    expect(summary(1)?.attention).toEqual({ kind, count: 1, acknowledged: false });
    if (kind === 'plan' || kind === 'review') {
      send(1, { type: kind === 'plan' ? 'plan-waiting' : 'review-waiting', waiting: false });
    } else {
      send(1, { type: 'request-resolved', owner: { turnId: 't1' }, requestId: 'r1' });
    }
    expect(summary(1)?.attention).toBeNull();
  });

  it('refuses a session it does not have', async () => {
    place([session(1)]);
    open();
    expect(await service.select(S(9))).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(service.acknowledge(S(9))).toEqual({ status: 'refused', reason: 'unknown-session' });
  });

  it('is cleared when the selected session is removed, or its project is', async () => {
    place([session(1), session(2)]);
    open();
    await service.select(S(1));
    expect(await service.remove(S(1))).toEqual({ status: 'saved' });
    expect(service.snapshot().selectedId).toBeNull();
    await service.select(S(2));
    await records.remove(PROJECT);
    expect(service.snapshot()).toEqual({ sessions: [], selectedId: null, orphans: 0 });
  });

  // The maintainer: Done empties the session window, as a removal does.
  it('is cleared when the selected session is completed, and left alone when another one is', async () => {
    place([session(1), session(2)]);
    open();
    await service.select(S(1));
    expect(await service.complete(S(2))).toEqual({ status: 'saved' });
    expect(service.snapshot().selectedId).toBe(S(1));
    expect(await service.complete(S(1))).toEqual({ status: 'saved' });
    expect(service.snapshot().selectedId).toBeNull();
    expect(service.snapshot().sessions[0]?.record.completedAt).toBe(AT);
  });

  it('selects a session as it is created (C32)', async () => {
    place([session(1)]);
    open();
    const created = await service.create(PROJECT, { providerId: 'codex', instanceId: 'default', model: 'gpt-5.6-sol', effort: 'medium', speed: null });
    expect(created).toMatchObject({ status: 'saved' });
    const id = created.status === 'saved' ? created.id : '';
    expect(service.snapshot().selectedId).toBe(id);
    // Before its project's others (C11), not started, with the preset it was given.
    expect(service.snapshot().sessions.map((entry) => entry.record.id)).toEqual([id, S(1)]);
    expect(service.snapshot().sessions[0]).toMatchObject({ record: { model: 'gpt-5.6-sol', effort: 'medium', name: null }, summary: { status: 'not-started', model: 'gpt-5.6-sol', effort: 'medium' } });
    expect(service.record(id)).toMatchObject({ reference: null, folder: null });
  });
});

// ── The Main window's changes ─────────────────────────────────────────────────────────────────
describe('the actions (C35, C36, C96, C114)', () => {
  it('stars, moves, and sets the effort, each as one write', async () => {
    place([session(1), session(2)]);
    open();
    expect(await service.setFlag(S(1), 'starred', true)).toEqual({ status: 'saved' });
    expect(await service.setEffort(S(1), 'medium')).toEqual({ status: 'saved' });
    expect(await service.setEffort(S(2), 'low')).toEqual({ status: 'saved' });
    expect(await service.move(S(2), null, { list: 'active', starred: false })).toEqual({ status: 'saved' });
    expect(stored(1)).toMatchObject({ starred: true, model: 'gpt-6-sol', effort: 'medium' });
    expect(stored(2)).toMatchObject({ effort: 'low' });
    // The summary's effort in force follows the record until a source reports (C23).
    expect(summary(1)).toMatchObject({ model: 'gpt-6-sol', effort: 'medium' });
  });

  it('sets the speed tier as one write, which the page’s view of the record says, and creates a session with one (decision 0016)', async () => {
    place([session(1)]);
    open();
    expect(await service.setSpeed(S(1), 'priority')).toEqual({ status: 'saved' });
    expect(stored(1)).toMatchObject({ effort: 'high', speed: 'priority' });
    expect(service.snapshot().sessions[0]?.record.speed).toBe('priority');
    expect(await service.setSpeed(S(1), null)).toEqual({ status: 'saved' });
    expect(service.record(S(1))?.speed).toBeNull();
    expect(await service.setSpeed(S(9), null)).toEqual({ status: 'refused', reason: 'unknown-session' });
    const created = await service.create(PROJECT, { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: 'priority' });
    expect(created.status === 'saved' && service.record(created.id)?.speed).toBe('priority');
  });

  it('sets one flag at a time, leaving the others, and writes nothing for a flag already so', async () => {
    place([session(1, { starred: true })]);
    const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
    open({ write });
    expect(await service.setFlag(S(1), 'toVerify', true)).toEqual({ status: 'saved' });
    expect(await service.setFlag(S(1), 'toDo', false)).toEqual({ status: 'saved' });
    expect(write).toHaveBeenCalledOnce();
    expect(stored(1)).toMatchObject({ starred: true, toDo: false, toVerify: true });
    expect(service.snapshot().sessions[0]?.record).toMatchObject({ starred: true, toDo: false, toVerify: true });
  });

  it('shelves a session between its turns, takes it out of the window, and back with Unshelve, the selection staying', async () => {
    place([session(1, { reference: 'r', folder: 'D:\\Code\\fat-g' }), session(2, { reference: 's', folder: 'D:\\Code\\fat-g' })]);
    open();
    await service.select(S(1));
    turn(1);
    expect(await service.shelve(S(1))).toEqual({ status: 'refused', reason: 'running' });
    end(1);
    await service.settled();
    expect(await service.shelve(S(2))).toEqual({ status: 'saved' });
    expect(service.snapshot().selectedId).toBe(S(1));
    expect(await service.shelve(S(1))).toEqual({ status: 'saved' });
    expect(service.snapshot().selectedId).toBeNull();
    expect([stored(1)?.['shelvedAt'], service.snapshot().sessions[0]?.record.shelvedAt]).toEqual([AT, AT]);
    // Moved no more, and a second shelving writes nothing.
    expect(await service.move(S(1), null, { list: 'active', starred: false })).toEqual({ status: 'refused', reason: 'outside-group' });
    expect(await service.shelve(S(1))).toEqual({ status: 'saved' });
    await service.select(S(1));
    expect(await service.restore(S(1))).toEqual({ status: 'saved' });
    expect(stored(1)?.['shelvedAt']).toBeNull();
    expect(service.snapshot().selectedId).toBe(S(1));
  });

  it('shelves no session before its first turn, nor a shelved one again: nothing is written, and the selection stays', async () => {
    place([session(1), session(2, { reference: 'r', folder: 'D:\\Code\\fat-g', shelvedAt: AT - 10 })]);
    const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
    open({ write });
    await service.select(S(1));
    expect(await service.shelve(S(1))).toEqual({ status: 'saved' });
    expect(await service.shelve(S(2))).toEqual({ status: 'saved' });
    expect(write).not.toHaveBeenCalled();
    expect(service.snapshot().selectedId).toBe(S(1));
  });

  it('shelves a completed session, which is then no longer completed, its flags kept', async () => {
    place([session(1, { reference: 'r', folder: 'D:\\Code\\fat-g', completedAt: AT - 10, toVerify: true })]);
    open();
    expect(await service.shelve(S(1))).toEqual({ status: 'saved' });
    expect(stored(1)).toMatchObject({ shelvedAt: AT, completedAt: null, toVerify: true });
  });

  it('restores a completed session, a starred one too, to the active list, its flags and the selection kept', async () => {
    place([session(1, { reference: 'r', folder: 'D:\\Code\\fat-g', completedAt: AT - 10 }), session(2, { reference: 's', folder: 'D:\\Code\\fat-g', completedAt: AT - 20, starred: true })]);
    const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
    open({ write });
    await service.select(S(1));
    for (const n of [1, 2]) expect(await service.restore(S(n))).toEqual({ status: 'saved' });
    expect([stored(1), stored(2)]).toMatchObject([{ completedAt: null, shelvedAt: null }, { completedAt: null, shelvedAt: null, starred: true }]);
    expect(service.snapshot().selectedId).toBe(S(1));
    // An active session has nowhere to come back from: nothing more is written.
    expect(await service.restore(S(1))).toEqual({ status: 'saved' });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('clears every flag but the star at Done, and takes a shelved session off the shelf', async () => {
    place([session(1, { reference: 'r', folder: 'D:\\Code\\fat-g', starred: true, toDo: true, toVerify: true, shelvedAt: AT - 10 }), session(2, { reference: 's', folder: 'D:\\Code\\fat-g', toVerify: true })]);
    open();
    for (const n of [1, 2]) expect(await service.complete(S(n))).toEqual({ status: 'saved' });
    expect(stored(1)).toMatchObject({ completedAt: AT, shelvedAt: null, starred: true, toDo: false, toVerify: false });
    expect(stored(2)).toMatchObject({ completedAt: AT, starred: false, toDo: false, toVerify: false });
  });

  it('refuses a change to a session the list does not show', async () => {
    place([session(1), session(2, { projectId: OTHER })], [project(), { id: OTHER, name: 5 }]);
    open();
    for (const answer of [await service.setFlag(S(2), 'starred', true), await service.complete(S(9)), await service.shelve(S(9)), await service.restore(S(2)), await service.move(S(2), null, { list: 'active', starred: false }), await service.remove(S(2)), await service.setEffort(S(9), 'low')]) {
      expect(answer).toEqual({ status: 'refused', reason: 'unknown-session' });
    }
    expect(stored(2)).toMatchObject({ starred: false });
  });

  it('refuses Complete and Remove while a turn runs, and takes both once it has ended', async () => {
    place([session(1), session(2)]);
    open();
    turn(1);
    expect(service.isRunning(S(1))).toBe(true);
    expect([service.runningCount(), service.runningIn(PROJECT), service.runningIn(OTHER)]).toEqual([1, true, false]);
    expect(await service.complete(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(await service.remove(S(1))).toEqual({ status: 'refused', reason: 'running' });
    end(1);
    expect(service.runningCount()).toBe(0);
    expect(await service.complete(S(1))).toEqual({ status: 'saved' });
    expect(await service.remove(S(1))).toEqual({ status: 'saved' });
    expect(stored(1)).toBeUndefined();
  });

  // V33: a session waiting on its workers counts as running.
  it('counts a session waiting on its workers as running, for the quit question, Complete and Remove', async () => {
    place([session(1)]);
    open();
    turn(1);
    send(1, { type: 'worker-started', workerId: 'w1' });
    end(1);
    await service.settled();
    expect(summary(1)).toMatchObject({ status: 'running', attention: null, action: { label: 'Waiting for a sub-agent' } });
    expect(stored(1)).toMatchObject({ lastTurn: { endedAt: null, outcome: null } });
    expect(service.runningCount()).toBe(1);
    expect(await service.complete(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(await service.remove(S(1))).toEqual({ status: 'refused', reason: 'running' });
    send(1, { type: 'worker-ended', workerId: 'w1', outcome: 'completed' }, AT + 5000);
    await service.settled();
    expect(summary(1)).toMatchObject({ status: 'not-started', attention: { kind: 'ready' } });
    expect(stored(1)).toMatchObject({ lastTurn: { startedAt: AT, endedAt: AT + 5000, outcome: 'completed' } });
    expect(service.runningCount()).toBe(0);
  });

  // M26 (round 2): what an earlier run left provisional — no reference, no turn, no name — goes at
  // the next launch, since nothing of it is shown once it is not the selected session.
  it('removes the sessions an earlier run left unstarted, and nothing else', async () => {
    place([
      session(1),
      session(2, { name: 'setting things up', nameSource: 'generated' }),
      session(3, { reference: 'thread-3', folder: 'D:" + B + B + "Code" + B + B + "fat-g' }),
      session(4, { lastTurn: { turnId: 't1', startedAt: AT - 400, endedAt: AT - 300, outcome: 'completed' } }),
      session(5, { createdAt: AT + 1000, lastActiveAt: AT + 1000 }),
    ]);
    open();
    expect(await service.removeUnstarted()).toEqual({ status: 'saved' });
    await service.settled();
    expect(stored(1)).toBeUndefined();
    for (const n of [2, 3, 4, 5]) expect(stored(n)).toBeDefined();
  });

  // M23 (V17; C83): one whose draft or queue holds something stays, and so does one the conversation store cannot answer for.
  it('leaves an unstarted session whose draft or queue holds something, or that the store cannot answer for', async () => {
    place([session(1), session(2), session(3)]);
    const content = new Map<string, boolean | null>([[S(1), false], [S(2), true], [S(3), null]]);
    open({}, { hasContent: (id) => (content.has(id) ? (content.get(id) ?? null) : false) });
    expect(await service.removeUnstarted()).toEqual({ status: 'saved' });
    await service.settled();
    expect(stored(1)).toBeUndefined();
    expect(stored(2)).toBeDefined();
    expect(stored(3)).toBeDefined();
    // The entry says so by a presence alone, where the store says yes.
    const entries = service.snapshot().sessions;
    expect(entries.find((entry) => entry.record.id === S(2))?.content).toBe(true);
    expect(entries.find((entry) => entry.record.id === S(3))).not.toHaveProperty('content');
  });

  it('removes nothing while the records are refused', async () => {
    writeFileSync(file, '{');
    open();
    expect(await service.removeUnstarted()).toEqual({ status: 'refused', reason: 'records-refused' });
  });

  it('removes the entries without a project', async () => {
    place([session(1), session(3, { projectId: S(77) })]);
    open();
    expect(service.snapshot().orphans).toBe(1);
    expect(await service.removeOrphans()).toEqual({ status: 'saved' });
    expect(service.snapshot().orphans).toBe(0);
    expect(stored(3)).toBeUndefined();
  });
});

// ── V32: stale events ─────────────────────────────────────────────────────────────────────────
// M21, V3 (C11): what the request registry asks before it opens a card.
describe('whether a request’s owner is current (M21; C11)', () => {
  it('is true for the turn that runs and for a worker listed as running, and false for any other', () => {
    place([session(1)]);
    open();
    // No turn runs: no owner is current.
    expect(service.owns(S(1), { turnId: 't1' })).toBe(false);
    turn(1);
    send(1, { type: 'worker-started', workerId: 'w1' });
    expect(service.owns(S(1), { turnId: 't1' })).toBe(true);
    expect(service.owns(S(1), { turnId: 't0' })).toBe(false);
    expect(service.owns(S(1), { workerId: 'w1' })).toBe(true);
    expect(service.owns(S(1), { workerId: 'w9' })).toBe(false);
    // A turn that has ended while its worker runs: the worker is still current, the turn no more.
    end(1);
    expect(service.owns(S(1), { turnId: 't1' })).toBe(false);
    expect(service.owns(S(1), { workerId: 'w1' })).toBe(true);
    send(1, { type: 'worker-ended', workerId: 'w1', outcome: 'completed' });
    expect(service.owns(S(1), { workerId: 'w1' })).toBe(false);
    // A session the list does not show owns nothing.
    expect(service.owns(S(9), { turnId: 't1' })).toBe(false);
  });
});

describe('stale events (V32; C115)', () => {
  it('discards and counts an ended turn’s action, request and end, alone', () => {
    place([session(1)]);
    open();
    turn(1);
    end(1);
    const state = store.getSnapshot().sessions;
    send(1, { type: 'action-changed', turnId: 't1', kind: 'running' });
    send(1, { type: 'request-raised', owner: { turnId: 't1' }, requestId: 'a1', kind: 'approval', count: 1 });
    end(1, 'failed');
    expect(store.getSnapshot().sessions).toBe(state);
    expect(log.warn).toHaveBeenCalledWith('[sessions] event discarded (stale turn), 1 so far');
    expect(log.warn.mock.calls.filter(([text]) => String(text).includes('stale turn'))).toHaveLength(1);
  });

  // The order of tests/fixtures/codex/captures/t4-interrupt.json: `turn/completed` (interrupted), then
  // the command's `item/completed` 4 ms later — and here the next turn has already started.
  it('keeps an interrupted turn’s late tail out of the next turn, in the order of the Codex interrupt capture', async () => {
    const capture = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../tests/fixtures/codex/captures/t4-interrupt.json'), 'utf8')) as { frames?: unknown };
    const text = JSON.stringify(capture);
    expect(text.indexOf('turn/completed')).toBeGreaterThan(-1);
    expect(text.lastIndexOf('item/completed')).toBeGreaterThan(text.indexOf('turn/completed'));

    place([session(1)]);
    open();
    turn(1, 'turn-a', AT);
    send(1, { type: 'action-changed', turnId: 'turn-a', kind: 'running' });
    end(1, 'interrupted', 'turn-a', AT + 1000);
    turn(1, 'turn-b', AT + 1002);
    send(1, { type: 'action-changed', turnId: 'turn-b', kind: 'thinking' });
    // The tail of turn-a, 4 ms after its end, interleaved with turn-b's own events.
    send(1, { type: 'action-changed', turnId: 'turn-a', kind: null }, AT + 1004);
    send(1, { type: 'request-raised', owner: { turnId: 'turn-a' }, requestId: 'late', kind: 'approval', count: 1 });
    send(1, { type: 'action-changed', turnId: 'turn-b', kind: 'reading', file: 'sample.txt' });
    end(1, 'failed', 'turn-a', AT + 1006);
    await service.settled();
    expect(summary(1)).toMatchObject({ status: 'running', turnStartedAt: AT + 1002, attention: null, action: { kind: 'reading', label: 'Reading sample.txt' } });
    expect(stored(1)).toMatchObject({ lastTurn: { startedAt: AT + 1002, endedAt: null, outcome: null } });
    expect(log.warn).toHaveBeenCalledWith('[sessions] event discarded (stale turn), 1 so far');
  });

  it('takes a worker’s event while it is listed as running, between turns too, and discards and counts it otherwise', () => {
    place([session(1)]);
    open();
    turn(1);
    send(1, { type: 'worker-started', workerId: 'w1', description: 'Explore' });
    end(1);
    send(1, { type: 'worker-progressed', workerId: 'w1', kind: 'reading', file: 'a.ts' });
    expect(summary(1)?.agents[0]?.action).toEqual({ kind: 'reading', label: 'Reading a.ts', detail: 'a.ts' });
    send(1, { type: 'worker-ended', workerId: 'w1', outcome: 'completed' });
    const state = store.getSnapshot().sessions;
    send(1, { type: 'worker-progressed', workerId: 'w1', kind: 'thinking' });
    send(1, { type: 'worker-ended', workerId: 'w2', outcome: 'failed' });
    expect(store.getSnapshot().sessions).toBe(state);
    expect(log.warn).toHaveBeenCalledWith('[sessions] event discarded (stale worker), 1 so far');
  });
});

// ── V21: quit and the next launch ─────────────────────────────────────────────────────────────
describe('quit and the next launch (V21; C74, C75, C105)', () => {
  it('ends every running turn’s record as stopped at the quit’s time, in one write, and nothing on the others', async () => {
    place([session(1), session(2), session(3, { reference: 'r', folder: 'D:\\x', lastTurn: { turnId: 'turn-0', startedAt: 1, endedAt: 2, outcome: 'completed' } })]);
    const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
    open({ write });
    turn(1, 't1', AT + 1000);
    turn(2, 't1', AT + 2000);
    send(2, { type: 'worker-started', workerId: 'w1' });
    end(2, 'completed', 't1', AT + 3000);
    await service.settled();
    write.mockClear();
    clock = AT + 9000;
    await service.endRunningTurns();
    expect(write).toHaveBeenCalledOnce();
    expect(stored(1)).toMatchObject({ lastTurn: { startedAt: AT + 1000, endedAt: AT + 9000, outcome: 'stopped' }, lastActiveAt: AT + 9000 });
    // A turn that had ended and was waiting on its workers is stopped too (C114).
    expect(stored(2)).toMatchObject({ lastTurn: { startedAt: AT + 2000, endedAt: AT + 9000, outcome: 'stopped' } });
    expect(stored(3)).toMatchObject({ lastTurn: { startedAt: 1, endedAt: 2, outcome: 'completed' } });
    // The one that had finished reads READY, seen, as a launch has it (C106, amended).
    expect([summary(1)?.attention?.kind, summary(2)?.attention?.kind, summary(3)?.attention ?? null]).toEqual(['stopped', 'stopped', { kind: 'ready', count: 1, acknowledged: true }]);
    expect(service.runningCount()).toBe(0);
  });

  it('shows STOPPED on each of them at the next launch, and nothing on the others', async () => {
    place([session(1), session(2)]);
    open();
    turn(1);
    await service.endRunningTurns();
    service.stop();
    open();
    expect(summary(1)).toMatchObject({ status: 'not-started', attention: { kind: 'stopped', count: 1, acknowledged: false } });
    expect(summary(2)).toMatchObject({ status: 'not-started', attention: null });
  });

  it('shows the same for a record a crash left running: the other persisted form', async () => {
    place([session(1)]);
    open();
    turn(1);
    await service.settled();
    // No quit: the process is gone, and the record keeps its missing end.
    service.stop();
    expect(stored(1)).toMatchObject({ lastTurn: { endedAt: null, outcome: null } });
    open();
    expect(summary(1)?.attention).toEqual({ kind: 'stopped', count: 1, acknowledged: false });
  });

  it('is cleared by a new turn', async () => {
    place([session(1, { lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'stopped' } })]);
    open();
    expect(summary(1)?.attention?.kind).toBe('stopped');
    turn(1);
    expect(summary(1)?.attention).toBeNull();
    await service.settled();
  });

  it('takes no event once the turns are ended: nothing continues while fat-g closes (C74)', async () => {
    place([session(1)]);
    open();
    turn(1);
    await service.endRunningTurns();
    const state = store.getSnapshot().sessions;
    turn(1, 't2');
    end(1);
    expect(store.getSnapshot().sessions).toBe(state);
    expect(summary(1)?.status).toBe('not-started');
  });

  it('writes nothing when no session runs', async () => {
    place([session(1)]);
    const write = vi.fn(() => Promise.resolve());
    open({ write });
    await service.endRunningTurns();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not hold the quit when the write fails: it resolves, logs the kind, and the record keeps its missing end', async () => {
    place([session(1)]);
    let fail = false;
    open({ write: (target, data) => { if (fail) return Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })); writeFileSync(target, data); return Promise.resolve(); } });
    turn(1);
    await service.settled();
    fail = true;
    await expect(service.endRunningTurns()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith('[sessions] the stopped turns could not be saved (Error EIO)');
    expect(stored(1)).toMatchObject({ lastTurn: { endedAt: null, outcome: null } });
    service.stop();
    // Which reads the same at the next launch.
    expect(open().snapshot().sessions[0]?.summary.attention?.kind).toBe('stopped');
  });
});

// ── M14b: a session and its instance (docs/planning/_archive/M14b.md, V9, V21; C26, C29, C61, C62) ──────
describe('a session’s instance (M14b)', () => {
  const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const support = { variable: 'VENDOR_HOME', defaultFolder: ['.vendor'], withhold: { names: [], prefixes: [] } };
  /** Real paths; a path not listed is its own. */
  const lookups = (real: Record<string, string> = {}) => ({ realpath: (target: string) => Promise.resolve(real[target] ?? target) });
  /** A launch: what fat-g's own environment names, and the added instances' stored folders. */
  const launch = (env: Record<string, string | undefined>, added: Record<string, string> = { [WORK]: 'D:\\accounts\\work' }, real: Record<string, string> = {}) =>
    createFolderBinding({
      platform: 'win32',
      lookups: lookups(real),
      folderOf: instanceFolders({ platform: 'win32', env, home: 'C:\\Users\\me', support: () => support, added: (ref) => added[ref.instanceId] ?? null }),
    });
  const hold = (n: number) => service.snapshot().sessions.find((entry) => entry.record.id === S(n))?.hold;
  /** The comparisons are asked at start; this lets each answer and be published. */
  const compared = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  describe('the record (V9)', () => {
    it('stores the instance at create, shows it to the page, and carries it in no later change (C26)', async () => {
      place([]);
      const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
      open({ write });
      const created = await service.create(PROJECT, { providerId: 'codex', instanceId: WORK, model: 'gpt-6-sol', effort: 'high', speed: null });
      const id = created.status === 'saved' ? created.id : '';
      const onDisk = () => (JSON.parse(readFileSync(file, 'utf8')) as { sessions: Record<string, unknown>[] }).sessions.find((entry) => entry['id'] === id);
      expect(onDisk()).toMatchObject({ instanceId: WORK, configFolder: null, reference: null });
      expect(service.snapshot().sessions[0]?.record.instanceId).toBe(WORK);
      // Every change the service makes, from the page and from a source.
      const before = write.mock.calls.length;
      await service.setFlag(id, 'starred', true);
      await service.setEffort(id, 'low');
      service.apply({ sessionId: id, type: 'reference-set', reference: 'ref', folder: 'D:\\Code\\fat-g' });
      service.apply({ sessionId: id, type: 'turn-started', turnId: 't1' });
      service.apply({ sessionId: id, type: 'name-reported', name: 'A name', source: 'provider' });
      service.apply({ sessionId: id, type: 'turn-ended', turnId: 't1', outcome: 'completed' });
      await service.settled();
      await service.complete(id);
      expect(write.mock.calls.length).toBeGreaterThan(before);
      expect(onDisk()).toMatchObject({ instanceId: WORK, starred: true, effort: 'low', reference: 'ref', name: 'A name' });
    });

    it.each<[string, string, Record<string, string | undefined>, string]>([
      ['an added instance’s own folder', WORK, { VENDOR_HOME: 'D:\\accounts\\personal' }, 'D:\\accounts\\work'],
      ['for the first instance, the folder the inherited variable names', 'default', { VENDOR_HOME: 'D:/accounts/personal/' }, 'D:\\accounts\\personal'],
      ['for the first instance, the declared default when the variable is unset', 'default', {}, 'C:\\Users\\me\\.vendor'],
    ])('stores with the reference, in the same write, %s (C61)', async (_name, instanceId, env, expected) => {
      place([session(1, { instanceId })]);
      const write = vi.fn((target: string, data: string) => { writeFileSync(target, data); return Promise.resolve(); });
      open({ write }, { binding: launch(env) });
      send(1, { type: 'reference-set', reference: 'ref', folder: 'D:\\Code\\fat-g' });
      await service.settled();
      expect(write).toHaveBeenCalledOnce();
      expect(stored(1)).toMatchObject({ reference: 'ref', folder: 'D:\\Code\\fat-g', configFolder: expected });
      expect(hold(1)).toBeNull();
    });

    it('takes the configuration folder from main, never from the event: an event that names one is no event', async () => {
      place([session(1)]);
      open({}, { binding: launch({}) });
      send(1, { type: 'reference-set', reference: 'ref', folder: 'D:\\Code\\fat-g', configFolder: 'D:\\elsewhere' });
      await service.settled();
      expect(stored(1)).toMatchObject({ reference: null, configFolder: null });
    });

    it('keeps the stored folder through every later change, a second reference and a changed launch included', async () => {
      place([session(1)]);
      const binding = launch({ VENDOR_HOME: 'D:\\accounts\\personal' });
      open({}, { binding });
      send(1, { type: 'reference-set', reference: 'ref', folder: 'D:\\Code\\fat-g' });
      send(1, { type: 'reference-set', reference: 'other', folder: 'D:\\Code\\other' });
      turn(1);
      end(1);
      await service.settled();
      await service.setFlag(S(1), 'starred', true);
      expect(stored(1)).toMatchObject({ reference: 'ref', configFolder: 'D:\\accounts\\personal', starred: true });
      expect(JSON.stringify(service.snapshot())).not.toContain('accounts');
    });

    it('stores none without the binding, and none for a provider that declares no instances', async () => {
      place([session(1), session(2)]);
      open();
      send(1, { type: 'reference-set', reference: 'ref', folder: 'D:\\Code\\fat-g' });
      await service.settled();
      expect(stored(1)).toMatchObject({ reference: 'ref', configFolder: null });
      service.stop();
      const none = createFolderBinding({ platform: 'win32', lookups: lookups(), folderOf: instanceFolders({ platform: 'win32', env: {}, home: 'C:\\Users\\me', support: () => undefined, added: () => null }) });
      open({}, { binding: none });
      send(2, { type: 'reference-set', reference: 'ref-2', folder: 'D:\\Code\\fat-g' });
      await service.settled();
      expect(stored(2)).toMatchObject({ reference: 'ref-2', configFolder: null });
    });
  });

  describe('a session that cannot be used (V9; C29)', () => {
    it('says why in its entry, and stays listed and selectable', async () => {
      place([session(1), session(2, { instanceId: WORK }), session(3, { providerId: 'gemini' })]);
      const off = new Map<string, 'provider-unavailable' | 'instance-unavailable'>([['gemini:default', 'provider-unavailable'], [`codex:${WORK}`, 'instance-unavailable']]);
      open({}, { unavailable: (ref: InstanceRef) => off.get(`${ref.providerId}:${ref.instanceId}`) ?? null });
      expect([hold(1), hold(2), hold(3)]).toEqual([null, 'instance-unavailable', 'provider-unavailable']);
      expect(await service.select(S(2))).toEqual({ status: 'saved' });
      expect(service.snapshot().selectedId).toBe(S(2));
    });

    it('follows the instances: a change is published once, and an unchanged answer not at all', async () => {
      place([session(1, { instanceId: WORK }), session(2)]);
      let off: 'instance-unavailable' | null = null;
      open({}, { unavailable: (ref: InstanceRef) => (ref.instanceId === WORK ? off : null) });
      const untouched = service.snapshot().sessions[1];
      const seq = store.getSnapshot().seq;
      service.availabilityChanged();
      expect(store.getSnapshot().seq).toBe(seq);
      off = 'instance-unavailable';
      service.availabilityChanged();
      expect(store.getSnapshot().seq).toBe(seq + 1);
      expect(hold(1)).toBe('instance-unavailable');
      // The other session's entry is the very same one.
      expect(service.snapshot().sessions[1]).toBe(untouched);
      expect(await service.hold(S(1))).toBe('instance-unavailable');
      expect(await service.hold(S(2))).toBeNull();
      expect(await service.hold(S(9))).toBeNull();
    });

    it('holds nothing without the rule: a service built with none, as the tests before M14b build it', async () => {
      place([session(1, { instanceId: WORK, reference: 'r', folder: 'D:\\Code', configFolder: 'D:\\accounts\\gone' })]);
      open();
      expect(hold(1)).toBeNull();
      expect(await service.hold(S(1))).toBeNull();
    });
  });

  // V21: a table of launches. The session started with the variable naming D:\accounts\personal.
  describe('a session whose folder has moved (V21; C62)', () => {
    const startedIn = (configFolder: string | null, overrides: Record<string, unknown> = {}) =>
      session(1, { reference: configFolder === null ? null : 'ref', folder: configFolder === null ? null : 'D:\\Code\\fat-g', configFolder, ...overrides });

    it.each<[string, Record<string, string | undefined>, Record<string, string>, 'folder-moved' | null]>([
      ['with the variable changed', { VENDOR_HOME: 'D:\\accounts\\other' }, {}, 'folder-moved'],
      ['with the variable unset', {}, {}, 'folder-moved'],
      ['with the variable set again as it was', { VENDOR_HOME: 'D:\\accounts\\personal' }, {}, null],
      ['with the variable spelling the same folder another way', { VENDOR_HOME: 'D:/Accounts/Personal' }, { 'D:\\Accounts\\Personal': 'D:\\accounts\\personal' }, null],
    ])('relaunched %s', async (_name, env, real, expected) => {
      place([startedIn('D:\\accounts\\personal')]);
      open({}, { binding: launch(env, {}, real) });
      // Not held until the comparison answers.
      if (expected !== null && env['VENDOR_HOME'] !== 'D:\\accounts\\personal') expect(hold(1)).toBeNull();
      await compared();
      expect(hold(1)).toBe(expected);
      expect(await service.hold(S(1))).toBe(expected);
    });

    it('holds an added instance’s session once its stored folder was edited, and not while it stands', async () => {
      place([startedIn('D:\\accounts\\work', { instanceId: WORK })]);
      open({}, { binding: launch({}, { [WORK]: 'D:\\accounts\\edited' }) });
      await compared();
      expect(hold(1)).toBe('folder-moved');
      service.stop();
      open({}, { binding: launch({}, { [WORK]: 'D:\\accounts\\work' }) });
      await compared();
      expect(hold(1)).toBeNull();
    });

    it('never holds a session with no reference, whatever its instance points to', async () => {
      place([startedIn(null), session(2, { configFolder: 'D:\\accounts\\personal' })]);
      open({}, { binding: launch({ VENDOR_HOME: 'D:\\accounts\\other' }) });
      await compared();
      // The second stores a folder with no reference, which only a hand edit makes: not held either.
      expect([hold(1), hold(2)]).toEqual([null, null]);
      expect(await service.hold(S(2))).toBeNull();
    });

    it('awaits the comparison when asked, before it was published', async () => {
      place([startedIn('D:\\accounts\\personal')]);
      open({}, { binding: launch({}) });
      expect(hold(1)).toBeNull();
      expect(await service.hold(S(1))).toBe('folder-moved');
    });

    it('compares again when the instances change: an edit put back releases the session', async () => {
      place([startedIn('D:\\accounts\\work', { instanceId: WORK })]);
      const added: Record<string, string> = { [WORK]: 'D:\\accounts\\edited' };
      open({}, { binding: launch({}, added) });
      await compared();
      expect(hold(1)).toBe('folder-moved');
      added[WORK] = 'D:\\accounts\\work';
      service.instancesChanged();
      await compared();
      expect(hold(1)).toBeNull();
    });

    it('keeps a held session held while its folder is compared again: no release in between, and nothing published for the same answer', async () => {
      place([startedIn('D:\\accounts\\personal')]);
      open({}, { binding: launch({}) });
      await compared();
      expect(hold(1)).toBe('folder-moved');
      const seq = store.getSnapshot().seq;
      // Any change to the preferences, a window's place included, asks again.
      service.instancesChanged();
      expect(hold(1)).toBe('folder-moved');
      await compared();
      expect(hold(1)).toBe('folder-moved');
      expect(store.getSnapshot().seq).toBe(seq);
    });

    it('says the instance before the folder: one that is not configured has no folder to compare', async () => {
      place([startedIn('D:\\accounts\\work', { instanceId: WORK })]);
      open({}, { binding: launch({}, {}), unavailable: () => 'instance-unavailable' });
      await compared();
      expect(hold(1)).toBe('instance-unavailable');
    });

    it('keeps a held session’s Remove, and its star (C73)', async () => {
      place([startedIn('D:\\accounts\\personal')]);
      open({}, { binding: launch({}) });
      await compared();
      expect(hold(1)).toBe('folder-moved');
      expect(await service.setFlag(S(1), 'starred', true)).toEqual({ status: 'saved' });
      expect(await service.remove(S(1))).toEqual({ status: 'saved' });
      expect(stored(1)).toBeUndefined();
    });
  });

  describe('whether a session of an instance runs (C23)', () => {
    it('counts a running turn, and a session waiting on its workers, of that instance alone', () => {
      place([session(1), session(2, { instanceId: WORK }), session(3, { providerId: 'claude', instanceId: WORK })]);
      open();
      const first = { providerId: 'codex', instanceId: 'default' };
      const work = { providerId: 'codex', instanceId: WORK };
      expect([service.runningOn(first), service.runningOn(work)]).toEqual([false, false]);
      turn(2);
      expect([service.runningOn(first), service.runningOn(work), service.runningOn({ providerId: 'claude', instanceId: WORK })]).toEqual([false, true, false]);
      // One id in another letter case is the same instance.
      expect(service.runningOn({ providerId: 'codex', instanceId: WORK.toUpperCase() })).toBe(true);
      send(2, { type: 'worker-started', workerId: 'w1' });
      end(2);
      expect(service.runningOn(work)).toBe(true);
      send(2, { type: 'worker-ended', workerId: 'w1', outcome: 'completed' });
      expect(service.runningOn(work)).toBe(false);
    });
  });
});

// ── M14b: the model is fixed at create (docs/planning/_archive/M14b.md, V20; C55, C63) ──────────────────
describe('a session’s model (M14b; C55, C63)', () => {
  it('has no way to set one: the service holds no such action', () => {
    place([session(1)]);
    open();
    expect(Object.keys(service)).not.toContain('setModel');
  });

  it('carries the model in no change: every one the service makes leaves the record’s key', async () => {
    place([session(1, { model: 'opus' })]);
    open();
    await service.setFlag(S(1), 'starred', true);
    await service.setEffort(S(1), 'low');
    send(1, { type: 'reference-set', reference: 'ref', folder: 'D:\\Code\\fat-g' });
    turn(1);
    send(1, { type: 'in-force', model: 'claude-opus-5-5', effort: 'low' });
    send(1, { type: 'name-reported', name: 'A name', source: 'provider' });
    end(1);
    await service.settled();
    await service.complete(S(1));
    await service.endRunningTurns();
    expect(stored(1)).toMatchObject({ model: 'opus', starred: true, effort: 'low', reference: 'ref', name: 'A name' });
  });

  it('keeps the record’s key when a later report resolves it to another model, and shows the model reported (C63)', async () => {
    // The key is what the CLI takes; an alias may come to mean another model after an update.
    place([session(1, { model: 'opus' })]);
    open();
    expect(summary(1)?.model).toBe('opus');
    turn(1);
    send(1, { type: 'in-force', model: 'claude-opus-5-5' });
    await service.settled();
    expect(summary(1)?.model).toBe('claude-opus-5-5');
    expect(service.snapshot().sessions[0]?.record.model).toBe('opus');
    expect(stored(1)).toMatchObject({ model: 'opus' });
    // The next launch shows the record's key again, until the session reports.
    service.stop();
    open();
    expect(summary(1)?.model).toBe('opus');
    send(1, { type: 'in-force', model: 'claude-opus-6' }, AT + 1000);
    await service.settled();
    expect(summary(1)?.model).toBe('claude-opus-6');
    expect(stored(1)).toMatchObject({ model: 'opus' });
  });
});

// ── M15: what the runtime needs of the service ───────────────────────────────────────────────
describe('the entry’s reason (V38, V55; C105, C126)', () => {
  it('carries what it is told for each session, worked out again whenever something it reads changes', () => {
    place([session(1), session(2)]);
    let missing = false;
    let connected = true;
    open({}, { block: (record) => (record.id === S(2) ? 'not-offered' : missing ? 'folder-missing' : connected ? null : 'not-connected') });
    const blocks = () => store.getSnapshot().sessions?.sessions.map((entry) => entry.block);
    expect(blocks()).toEqual([null, 'not-offered']);
    expect(service.blockOf(S(1))).toBeNull();
    expect(service.blockOf(S(2))).toBe('not-offered');
    expect(service.blockOf(S(9))).toBeNull();

    // A root's missing mark changes, with no other event: the entry follows.
    const before = store.getSnapshot().sessions;
    missing = true;
    service.availabilityChanged();
    expect(blocks()).toEqual(['folder-missing', 'not-offered']);
    expect(store.getSnapshot().sessions).not.toBe(before);
    // The session whose reason did not change keeps its very entry.
    expect(store.getSnapshot().sessions?.sessions[1]).toBe(before?.sessions[1]);

    // An instance loses its runtime, then gains it again.
    missing = false;
    connected = false;
    service.availabilityChanged();
    expect(blocks()).toEqual(['not-connected', 'not-offered']);
    connected = true;
    service.availabilityChanged();
    expect(blocks()).toEqual([null, 'not-offered']);
    // Nothing changed: the app state is not told again.
    const settled = store.getSnapshot().sessions;
    service.availabilityChanged();
    expect(store.getSnapshot().sessions).toBe(settled);
  });

  it('gives no reason when it is not told how to find one, and no path in an entry either way', () => {
    place([session(1, { reference: 'r', folder: 'D:\\Private\\folder' })]);
    open();
    expect(store.getSnapshot().sessions?.sessions[0]?.block).toBeNull();
    expect(JSON.stringify(store.getSnapshot().sessions)).not.toContain('Private');
  });
});

describe('a withdrawal (V36; C103)', () => {
  it('makes the summary follow the record again, at once and after a later change of the record', async () => {
    place([session(1, { effort: 'low' })]);
    open();
    turn(1);
    send(1, { type: 'in-force', effort: 'low' });
    await service.setEffort(S(1), 'high');
    // Reported during a turn: it holds through the record's change.
    expect(summary(1)?.effort).toBe('low');
    end(1);
    send(1, { type: 'in-force', withdrawn: true });
    expect(summary(1)?.effort).toBe('high');
    await service.setEffort(S(1), 'medium');
    expect(summary(1)?.effort).toBe('medium');
  });
});

describe('the marks on a session that is leaving (V42; C109)', () => {
  it('marks a session from its Remove or its Complete until the write has answered, whatever the answer', async () => {
    place([session(1), session(2)]);
    open();
    const removing = service.remove(S(1));
    expect(service.isLeaving(S(1))).toBe(true);
    expect(service.isLeaving(S(2))).toBe(false);
    await removing;
    expect(service.isLeaving(S(1))).toBe(false);

    const completing = service.complete(S(2));
    expect(service.isLeaving(S(2))).toBe(true);
    await completing;
    expect(service.isLeaving(S(2))).toBe(false);
  });

  it('lifts the mark when the write fails', async () => {
    place([session(1)]);
    open({ write: () => Promise.reject(Object.assign(new Error('disk'), { code: 'EIO' })) });
    await expect(service.remove(S(1))).rejects.toBeDefined();
    expect(service.isLeaving(S(1))).toBe(false);
    expect(stored(1)).toBeDefined();
  });

  it('marks nothing for a session that runs: the refusal comes in the same step as the check', async () => {
    place([session(1)]);
    open();
    turn(1);
    expect(await service.remove(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(await service.complete(S(1))).toEqual({ status: 'refused', reason: 'running' });
    expect(service.isLeaving(S(1))).toBe(false);
  });

  it('marks every session of a project for its removal, and refuses the removal while one of them runs', async () => {
    place([session(1), session(2), session(3, { projectId: OTHER })], [project(), project(OTHER, 'other')]);
    open();
    turn(3);
    let wrote = false;
    const removing = service.removingProject(PROJECT, async () => { wrote = true; await records.remove(PROJECT); return 'done'; });
    expect(removing).not.toBeNull();
    expect([service.isLeaving(S(1)), service.isLeaving(S(2)), service.isLeaving(S(3))]).toEqual([true, true, false]);
    expect(await removing).toBe('done');
    expect(wrote).toBe(true);
    expect(service.isLeaving(S(1))).toBe(false);

    let asked = false;
    expect(service.removingProject(OTHER, () => { asked = true; return Promise.resolve('never'); })).toBeNull();
    expect(asked).toBe(false);
    expect(service.isLeaving(S(3))).toBe(false);
  });
});

describe('a reference that could not be stored (V41; C108)', () => {
  it('tells of it by the session’s id alone, and logs the failure’s kind', async () => {
    place([session(1)]);
    const unsaved: string[] = [];
    open({ write: () => Promise.reject(Object.assign(new Error('disk'), { code: 'EIO' })) }, { onReferenceUnsaved: (id) => unsaved.push(id) });
    send(1, { type: 'reference-set', reference: 'private-reference', folder: 'D:\\Code\\fat-g' });
    await service.settled();
    expect(unsaved).toEqual([S(1)]);
    // The summary reads started; the record does not hold it.
    expect(summary(1)?.status).toBe('idle');
    expect(stored(1)?.['reference']).toBeNull();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('private-reference');
    // Another turn's write failing is not a reference's.
    turn(1);
    await service.settled();
    expect(unsaved).toEqual([S(1)]);
  });

  it('says nothing when the write lands', async () => {
    place([session(1)]);
    const unsaved: string[] = [];
    open({}, { onReferenceUnsaved: (id) => unsaved.push(id) });
    send(1, { type: 'reference-set', reference: 'ref', folder: 'D:\\Code\\fat-g' });
    await service.settled();
    expect(unsaved).toEqual([]);
    expect(stored(1)).toMatchObject({ reference: 'ref' });
  });
});

describe('the quit’s wait for the writes still pending (V40, V52; C118)', () => {
  it('waits for an earlier write when it writes nothing itself: a turn that ended in time keeps its own outcome', async () => {
    place([session(1)]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    open({ write: async (target, text) => { writes += 1; if (writes === 2) await gate; writeFileSync(target, text); } });
    turn(1);
    await service.settled();
    // The turn's own end: its write is the one held back.
    end(1, 'interrupted');
    let done = false;
    const quitting = service.endRunningTurns().then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);
    release();
    await quitting;
    expect(stored(1)?.['lastTurn']).toMatchObject({ outcome: 'interrupted' });
  });

  it('stops waiting at its bound for a write that never lands, and the record keeps its missing end', async () => {
    place([session(1)]);
    let writes = 0;
    let fire: () => void = () => undefined;
    const waits: number[] = [];
    open({ write: (target, text) => { writes += 1; if (writes === 1) { writeFileSync(target, text); return Promise.resolve(); } return new Promise<void>(() => undefined); } },
      { setTimer: (run, ms) => { waits.push(ms); fire = run; return 1; }, clearTimer: () => undefined });
    turn(1);
    await service.settled();
    let done = false;
    const quitting = service.endRunningTurns().then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(done).toBe(false);
    expect(waits).toEqual([2000]);
    fire();
    await quitting;
    expect(stored(1)?.['lastTurn']).toMatchObject({ endedAt: null, outcome: null });
    // It reads STOPPED all the same, now and at the next launch.
    expect(summary(1)?.attention).toMatchObject({ kind: 'stopped' });
  });
});

// ── M18: a turn's id, the session's end, and what the conversation store holds ──────────────────
describe('a turn’s two homes (M18: V13, V23; C29, C45, C54)', () => {
  type Ended = [sessionId: string, turnId: string, at: number, outcome: string];
  const tellStore = () => {
    const told: Ended[] = [];
    return { told, extra: { onSessionEnded: (...end: Ended) => { told.push(end); } } };
  };

  it('stores the turn’s id with its start and with its end (C29)', async () => {
    place([session(1)]);
    open();
    turn(1, 'turn-a', AT + 1000);
    await service.settled();
    expect(stored(1)?.['lastTurn']).toEqual({ turnId: 'turn-a', startedAt: AT + 1000, endedAt: null, outcome: null });
    end(1, 'completed', 'turn-a', AT + 2000);
    await service.settled();
    expect(stored(1)?.['lastTurn']).toEqual({ turnId: 'turn-a', startedAt: AT + 1000, endedAt: AT + 2000, outcome: 'completed' });
  });

  it('tells the conversation store of the session’s end in the step that ends the turn, by the turn’s id', () => {
    place([session(1)]);
    const { told, extra } = tellStore();
    open({}, extra);
    turn(1, 'turn-a', AT + 1000);
    expect(told).toEqual([]);
    end(1, 'interrupted', 'turn-a', AT + 2000);
    // In the same step: nothing was awaited.
    expect(told).toEqual([[S(1), 'turn-a', AT + 2000, 'interrupted']]);
  });

  it('tells it of the session’s end only when the last worker ends, and by the id of the turn whose outcome was held (C54)', async () => {
    place([session(1)]);
    const { told, extra } = tellStore();
    open({}, extra);
    turn(1, 'turn-a', AT + 1000);
    send(1, { type: 'worker-started', workerId: 'w1' });
    end(1, 'completed', 'turn-a', AT + 2000);
    // The provider's turn is over, the session still runs: no session's end yet, in either store.
    expect(told).toEqual([]);
    await service.settled();
    expect(stored(1)?.['lastTurn']).toMatchObject({ turnId: 'turn-a', endedAt: null, outcome: null });
    send(1, { type: 'worker-ended', workerId: 'w1', outcome: 'completed' }, AT + 78_000);
    expect(told).toEqual([[S(1), 'turn-a', AT + 78_000, 'completed']]);
    await service.settled();
    expect(stored(1)?.['lastTurn']).toEqual({ turnId: 'turn-a', startedAt: AT + 1000, endedAt: AT + 78_000, outcome: 'completed' });
  });

  it('writes a quit’s stopped end to both, for a turn that runs and for one whose worker still does (C45)', async () => {
    place([session(1), session(2), session(3)]);
    const { told, extra } = tellStore();
    open({}, extra);
    turn(1, 'turn-a', AT + 1000);
    turn(2, 'turn-b', AT + 2000);
    send(2, { type: 'worker-started', workerId: 'w1' });
    end(2, 'completed', 'turn-b', AT + 3000);
    clock = AT + 9000;
    await service.endRunningTurns();
    expect(told).toEqual([[S(1), 'turn-a', AT + 9000, 'stopped'], [S(2), 'turn-b', AT + 9000, 'stopped']]);
    expect(stored(1)?.['lastTurn']).toMatchObject({ turnId: 'turn-a', outcome: 'stopped' });
    // The held turn is ended by its own id, not as a turn with none.
    expect(stored(2)?.['lastTurn']).toMatchObject({ turnId: 'turn-b', outcome: 'stopped', endedAt: AT + 9000 });
    expect(stored(3)?.['lastTurn']).toBeNull();
  });

  it('holds nothing when the conversation store cannot take the end: the record’s write goes on', async () => {
    place([session(1)]);
    open({}, { onSessionEnded: () => { throw Object.assign(new Error('C:\\Users\\someone\\conversations.sqlite'), { code: 'SQLITE_FULL' }); } });
    turn(1, 'turn-a', AT + 1000);
    end(1, 'completed', 'turn-a', AT + 2000);
    await service.settled();
    expect(stored(1)?.['lastTurn']).toMatchObject({ outcome: 'completed' });
    // By kind: never the message, which holds a path.
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('someone');
  });
});

describe('reconciliation (M18: V13, V22; C28, C29, C55)', () => {
  const FOLDER = 'D:\\Code\\fat-g';

  it('takes a reference the conversation store holds, by the once-only rule, and reads idle at once', async () => {
    place([session(1)]);
    open();
    expect(summary(1)?.status).toBe('not-started');
    service.reconcile(S(1), { reference: { reference: 'thread-9', folder: FOLDER, configFolder: 'D:\\Accounts\\work' } });
    // The summary is rebuilt from the record as it will be: before the write has answered.
    expect(summary(1)?.status).toBe('idle');
    await service.settled();
    expect(stored(1)).toMatchObject({ reference: 'thread-9', folder: FOLDER, configFolder: 'D:\\Accounts\\work' });
  });

  it('never replaces the record’s own reference', async () => {
    place([session(1, { reference: 'the-records-own', folder: FOLDER })]);
    open();
    service.reconcile(S(1), { reference: { reference: 'another', folder: 'D:\\elsewhere', configFolder: null } });
    await service.settled();
    expect(stored(1)).toMatchObject({ reference: 'the-records-own', folder: FOLDER });
  });

  it('takes a last turn only the store holds: a turn left without an end reads STOPPED, and one with the session’s end does not', async () => {
    place([session(1), session(2)]);
    open();
    service.reconcile(S(1), { lastTurn: { turnId: 'turn-a', startedAt: AT + 100, endedAt: null, outcome: null } });
    service.reconcile(S(2), { lastTurn: { turnId: 'turn-b', startedAt: AT + 100, endedAt: AT + 900, outcome: 'completed' } });
    expect(summary(1)?.attention).toMatchObject({ kind: 'stopped' });
    expect(summary(2)?.attention).toBeNull();
    await service.settled();
    expect(stored(1)).toMatchObject({ lastTurn: { turnId: 'turn-a', startedAt: AT + 100, endedAt: null, outcome: null }, lastActiveAt: AT + 100 });
    expect(stored(2)).toMatchObject({ lastTurn: { turnId: 'turn-b', endedAt: AT + 900, outcome: 'completed' }, lastActiveAt: AT + 900 });
  });

  it('reopens a session completed before the turn the store holds, as that turn’s start would have (C35)', async () => {
    place([session(1, { completedAt: AT - 1000 }), session(2, { completedAt: AT + 5000 })]);
    open();
    for (const n of [1, 2]) service.reconcile(S(n), { lastTurn: { turnId: 'turn-a', startedAt: AT + 100, endedAt: AT + 200, outcome: 'completed' } });
    await service.settled();
    expect(stored(1)?.['completedAt']).toBeNull();
    // Completed after the turn: it stays completed.
    expect(stored(2)?.['completedAt']).toBe(AT + 5000);
  });

  it('takes a session off the shelf when the store holds a turn after its shelving, and leaves one shelved after it', async () => {
    place([session(1, { shelvedAt: AT - 1000 }), session(2, { shelvedAt: AT + 5000 })]);
    open();
    for (const n of [1, 2]) service.reconcile(S(n), { lastTurn: { turnId: 'turn-a', startedAt: AT + 100, endedAt: AT + 200, outcome: 'completed' } });
    await service.settled();
    expect([stored(1)?.['shelvedAt'], stored(2)?.['shelvedAt']]).toEqual([null, AT + 5000]);
  });

  it('says so when the reference could not be saved, and still reads as started', async () => {
    place([session(1)]);
    const unsaved: string[] = [];
    open({ write: () => Promise.reject(Object.assign(new Error('no'), { code: 'EPERM' })) }, { onReferenceUnsaved: (id) => { unsaved.push(id); } });
    service.reconcile(S(1), { reference: { reference: 'thread-9', folder: FOLDER, configFolder: null } });
    await service.settled();
    expect(unsaved).toEqual([S(1)]);
    expect(stored(1)?.['reference']).toBeNull();
    expect(summary(1)?.status).toBe('idle');
  });

  it('leaves a running session’s summary as its events made it', async () => {
    place([session(1)]);
    open();
    turn(1, 'turn-a', AT + 1000);
    service.reconcile(S(1), { reference: { reference: 'thread-9', folder: FOLDER, configFolder: null } });
    expect(summary(1)?.status).toBe('running');
    await service.settled();
    expect(stored(1)?.['reference']).toBe('thread-9');
  });

  it('does nothing for a session that is not listed, and nothing after the quit', async () => {
    place([session(1)]);
    open();
    service.reconcile(S(9), { lastTurn: { turnId: 'turn-a', startedAt: 1, endedAt: 2, outcome: 'completed' } });
    await service.endRunningTurns();
    const before = readFileSync(file, 'utf8');
    service.reconcile(S(1), { reference: { reference: 'thread-9', folder: FOLDER, configFolder: null } });
    await service.settled();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

// ── The avatar each entry draws (M102, V6; C29, C57) ─────────────────────────────────────────
describe('the avatar each entry draws (M102, V6)', () => {
  const face = (portrait: string): ResolvedAvatar => ({ ref: { origin: 'built-in', family: 'Blue', avatar: 'Default' }, portrait, small: null });

  it('carries none before the avatars’ scan lands, and its provider’s face once it has, asked by the record', () => {
    place([session(1), session(2, { providerId: 'claude' })]);
    let faces = new Map<string, ResolvedAvatar>();
    const asked: string[] = [];
    open({}, { avatar: (record) => { asked.push(record.providerId); return faces.get(record.providerId) ?? null; } });
    expect(service.snapshot().sessions.map((entry) => entry.avatar)).toEqual([null, null]);
    faces = new Map([['codex', face('a'.repeat(32))]]);
    service.avatarsChanged();
    expect(service.snapshot().sessions.map((entry) => entry.avatar?.portrait ?? null)).toEqual(['a'.repeat(32), null]);
    expect(asked).toContain('claude');
  });

  it('sends an entry again for a Rescan’s new ids, and keeps it the same object where its files are the same', () => {
    place([session(1)]);
    let current = face('a'.repeat(32));
    open({}, { avatar: () => current });
    const before = service.snapshot().sessions[0];
    // A new object for the same files: nothing is sent again.
    current = face('a'.repeat(32));
    service.avatarsChanged();
    expect(service.snapshot().sessions[0]).toBe(before);
    current = face('b'.repeat(32));
    service.avatarsChanged();
    expect(service.snapshot().sessions[0]).not.toBe(before);
    expect(store.getSnapshot().sessions?.sessions[0]?.avatar?.portrait).toBe('b'.repeat(32));
  });

  // M103 (V3; C9, C12): the model asked for is the one in force, the record's until a source reports.
  it('is asked by the model in force, and follows it when a source reports another', () => {
    place([session(1, { providerId: 'claude', model: 'opus' })]);
    const byModel = new Map([['opus', face('a'.repeat(32))], ['claude-sonnet-9', face('b'.repeat(32))]]);
    const asked: string[] = [];
    open({}, { avatar: (_record, model) => { asked.push(model); return byModel.get(model) ?? null; } });
    expect(asked.at(-1)).toBe('opus');
    expect(service.snapshot().sessions[0]?.avatar?.portrait).toBe('a'.repeat(32));
    send(1, { type: 'in-force', model: 'claude-sonnet-9' });
    expect(asked.at(-1)).toBe('claude-sonnet-9');
    expect(store.getSnapshot().sessions?.sessions[0]?.avatar?.portrait).toBe('b'.repeat(32));
  });
});

// ── Each sub-agent’s avatar (M106, V4; C16, C17) ─────────────────────────────────────────────────
describe('each sub-agent’s avatar (M106, V4)', () => {
  const face = (portrait: string): ResolvedAvatar => ({ ref: { origin: 'built-in', family: 'Orange', avatar: 'Default' }, portrait, small: null });
  const started = (n: number, workerId: string, model?: string) => send(n, { type: 'worker-started', workerId, ...(model === undefined ? {} : { model }) });

  it('resolves each listed sub-agent by its own model, once a model, and leaves out one with none', () => {
    place([session(1, { providerId: 'claude', model: 'claude-sonnet-5' })]);
    let byModel = new Map([['claude-sonnet-5', face('a'.repeat(32))], ['haiku', face('b'.repeat(32))], ['claude-haiku-4-5-20251001', face('c'.repeat(32))]]);
    const asked: string[] = [];
    open({}, { avatar: (_record, model) => { asked.push(model); return byModel.get(model) ?? null; } });
    // A session that lists none names no map, and the entry’s keys stand.
    expect(service.snapshot().sessions[0]?.agentAvatars).toBeUndefined();
    send(1, { type: 'turn-started', turnId: 't1' });
    started(1, 'w1', 'haiku');
    started(1, 'w2', 'haiku');
    started(1, 'w3');
    started(1, 'w4', 'gpt-unknown');
    const entry = service.snapshot().sessions[0];
    expect(entry?.agentAvatars).toEqual({ w1: face('b'.repeat(32)), w2: face('b'.repeat(32)), w4: null });
    expect(Object.keys(store.getSnapshot().sessions?.sessions[0] ?? {}).sort()).toEqual(['agentAvatars', 'avatar', 'block', 'changingMode', 'hold', 'mode', 'record', 'summary']);
    // Once a model at each publish: the session’s, the alias, the unknown one.
    asked.length = 0;
    send(1, { type: 'worker-progressed', workerId: 'w1', kind: 'reading' });
    expect(asked.sort()).toEqual(['claude-sonnet-5', 'gpt-unknown', 'haiku']);
    // The map is kept while every avatar in it is the same; a model named later moves its row.
    const kept = service.snapshot().sessions[0]?.agentAvatars;
    send(1, { type: 'worker-progressed', workerId: 'w2', kind: 'reading' });
    expect(service.snapshot().sessions[0]?.agentAvatars).toBe(kept);
    send(1, { type: 'worker-model', workerId: 'w1', model: 'claude-haiku-4-5-20251001' });
    expect(service.snapshot().sessions[0]?.agentAvatars?.['w1']?.portrait).toBe('c'.repeat(32));
    // An assignment changed: the rows are redrawn with the session.
    byModel = new Map([['haiku', face('d'.repeat(32))]]);
    const before = service.snapshot().sessions[0];
    service.avatarsChanged();
    expect(service.snapshot().sessions[0]).not.toBe(before);
    expect(service.snapshot().sessions[0]?.agentAvatars?.['w2']?.portrait).toBe('d'.repeat(32));
  });

  it('sends the entry again when a sub-agent’s avatar alone changed', () => {
    place([session(1)]);
    let current = face('a'.repeat(32));
    open({}, { avatar: (_record, model) => (model === 'gpt-6-terra' ? current : null) });
    send(1, { type: 'turn-started', turnId: 't1' });
    started(1, 'w1', 'gpt-6-terra');
    const before = service.snapshot().sessions[0];
    current = face('b'.repeat(32));
    service.avatarsChanged();
    expect(service.snapshot().sessions[0]).not.toBe(before);
    expect(service.snapshot().sessions[0]?.summary).toBe(before?.summary);
  });
});


describe('live audio lifecycle observations', () => {
  it('starts once, closes after workers, and does not replay saved history', async () => {
    place([session(1)]);
    const started = vi.fn(); const ended = vi.fn();
    open({}, { onTurnStarted: started, onSessionEnded: ended });
    expect(started).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
    turn(1); turn(1);
    expect(started).toHaveBeenCalledOnce();
    send(1, { type: 'worker-started', workerId: 'w1', description: 'Explore' });
    end(1); expect(ended).not.toHaveBeenCalled();
    send(1, { type: 'worker-ended', workerId: 'w1', outcome: 'completed' });
    end(1);
    expect(ended).toHaveBeenCalledExactlyOnceWith(S(1), 't1', AT, 'completed');
    await service.settled(); service.stop();
    open({}, { onTurnStarted: started, onSessionEnded: ended });
    expect(started).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalledOnce();
  });
  it('reports only actual successful disposition changes, including Unshelve', async () => {
    place([session(1), session(2)]);
    const changed = vi.fn(); open({}, { onDisposition: changed });
    await service.shelve(S(1)); expect(changed).not.toHaveBeenCalled();
    turn(1); await service.complete(S(1)); expect(changed).not.toHaveBeenCalled();
    end(1); await service.settled();
    await service.complete(S(1)); await service.complete(S(1));
    await service.restore(S(1)); await service.restore(S(1));
    await service.shelve(S(1)); await service.shelve(S(1)); await service.restore(S(1));
    expect(changed.mock.calls).toEqual([['done'], ['restore'], ['shelve'], ['restore']]);
  });
  it('emits no disposition observation when the record write fails', async () => {
    place([session(1)]);
    const changed = vi.fn();
    open({ write: () => Promise.reject(new Error('unwritable')) }, { onDisposition: changed });
    await expect(service.complete(S(1))).rejects.toThrow('unwritable');
    expect(changed).not.toHaveBeenCalled();
  });
});


describe('new pending-request notifications', () => {
  it('observes each accepted card once, including workers, and never stale or resolved cards', () => {
    place([session(1)]);
    const raised = vi.fn(); open({}, { onRequestRaised: raised });
    expect(raised).not.toHaveBeenCalled();
    turn(1);
    send(1, { type: 'request-raised', owner: { turnId: 'old' }, requestId: 'stale', kind: 'question', count: 1 });
    const question = { type: 'request-raised', owner: { turnId: 't1' }, requestId: 'q1', kind: 'question', count: 3 };
    send(1, question); send(1, question);
    send(1, { type: 'worker-started', workerId: 'w1', description: 'Explore' });
    send(1, { type: 'request-raised', owner: { workerId: 'w1' }, requestId: 'wq', kind: 'question', count: 2 });
    send(1, { type: 'request-raised', owner: { turnId: 't1' }, requestId: 'a1', kind: 'approval', count: 1 });
    send(1, { type: 'request-resolved', owner: { turnId: 't1' }, requestId: 'q1' });
    expect(raised.mock.calls).toEqual([[S(1), 'q1', 'question'], [S(1), 'wq', 'question'], [S(1), 'a1', 'approval']]);
  });
});
