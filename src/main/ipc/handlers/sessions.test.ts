// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The session channels (docs/planning/_archive/M14.md: V7, V15, and V33's refusals; M14b.md: V9), through the
// real contract and dispatcher, on a real records store, session service and app state.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unavailable } from '@shared/contracts/availability';
import type { CatalogEffort, CatalogModel, CatalogState } from '@shared/contracts/catalog';
import type { ProviderStatus } from '@shared/contracts/status';
import { INVOKE_CHANNELS, type InvokeChannel } from '@shared/ipc/channels';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { createFolderBinding, instanceFolders } from '../../instances/binding';
import { resolveTrustedOrigins } from '../../app/origins';
import { RECORDS_FILE, RECORDS_VERSION } from '../../records/format';
import { createRecordsStore, type RecordsStore, type RecordsStoreOptions } from '../../records/store';
import { createSessionService, type SessionService } from '../../sessions/service';
import { type AppStateStore, createAppStateStore } from '../../state/app-state-store';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { projectHandlers } from './projects';
import { sessionHandlers } from './sessions';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-01-22T13:23:00.000Z');
/** An added Codex account, and one that is not configured. */
const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const GONE = '11111111-2222-4333-8444-555555555555';

const level = (id: string, place: number, caution = false): CatalogEffort => ({ id, label: id, place, caution });
const LEVELS = [level('low', 1), level('medium', 2), level('high', 3), level('ultra', 4, true)];
const model = (key: string, overrides: Partial<CatalogModel> = {}): CatalogModel =>
  sampleModel({ key, resolvedId: key, name: key, efforts: LEVELS, listedDefaultEffort: 'medium', listedDefault: false, ...overrides });
const CATALOG: CatalogState = {
  ...sampleCatalog([]),
  providers: [
    sampleCatalogProvider({
      id: 'claude',
      models: [
        model('default', { resolvedId: 'claude-opus-5-5[1m]', listedDefault: true, listedDefaultEffort: null }),
        model('opus[1m]', { resolvedId: 'claude-opus-5-5[1m]', listedDefaultEffort: null }),
        model('haiku', { efforts: [], listedDefaultEffort: null }),
      ],
    }),
    sampleCatalogProvider({ id: 'codex', models: [model('gpt-6-sol', { listedDefault: true }), model('gpt-5.6', { efforts: [level('low', 1), level('medium', 2)] }), model('gpt-hidden', { hidden: true })] }),
    // A second Codex account (M14b): it lists a model the first lacks, lacks one the first lists,
    // and gives the model they share fewer levels.
    sampleCatalogProvider({ id: 'codex', instanceId: WORK, models: [model('gpt-6-sol', { listedDefault: true, efforts: [level('low', 1), level('medium', 2)] }), model('gpt-6-team')] }),
  ],
};

let dir: string;
let file: string;
let records: RecordsStore;
let store: AppStateStore;
let sessions: SessionService;
/** Each instance's status, by provider and instance id: what the registry would publish. */
let statuses: Map<string, ProviderStatus>;
/** The added Codex account's folder, as the preferences hold it. */
let workFolder: string;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
/** What the secretary was asked to describe (M26, round 2), and whether it took the request. */
let describes: [string, { readonly providerId: string; readonly instanceId: string; readonly model: string }, string][];
let describeTaken: boolean;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-sessions-ipc-'));
  file = path.join(dir, RECORDS_FILE);
  statuses = new Map([['claude:default', { kind: 'ok' }], ['codex:default', { kind: 'ok' }], [`codex:${WORK}`, { kind: 'ok' }]]);
  workFolder = 'D:\\accounts\\work';
  describes = [];
  describeTaken = true;
  for (const spy of Object.values(log)) spy.mockClear();
});
afterEach(async () => {
  sessions?.stop();
  await sessions?.settled();
  rmSync(dir, { recursive: true, force: true });
});

const project = (overrides: Record<string, unknown> = {}) => ({ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex', 'claude', 'gemini'], roots: [{ path: 'D:\\Code\\fat-g' }], ...overrides });
const session = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: null, nameSource: null,
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null, ...overrides,
});
const place = (stored: unknown[], projects: unknown[] = [project()]) => writeFileSync(file, JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects, sessions: stored }));
const onDisk = (n: number) => (JSON.parse(readFileSync(file, 'utf8')) as { sessions: Record<string, unknown>[] }).sessions.find((entry) => entry['id'] === S(n));

function open(options: Partial<RecordsStoreOptions> = {}) {
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', now: () => AT, log, ...options });
  store = createAppStateStore();
  store.setCatalog(CATALOG);
  publishProviders();
  // As main wires it: the holds from the app state's snapshots, the folders from the launch.
  const binding = createFolderBinding({
    platform: 'win32',
    lookups: { realpath: (target) => Promise.resolve(target) },
    folderOf: instanceFolders({ platform: 'win32', env: {}, home: 'C:\\Users\\me', support: () => SUPPORT, added: (ref) => (ref.instanceId === WORK ? workFolder : null) }),
  });
  sessions = createSessionService({ records, store, now: () => AT, platform: 'win32', log, binding, unavailable: (ref) => unavailable(store.getSnapshot().providers, ref) });
  return sessionHandlers({
    sessions,
    records,
    store,
    hasProvider: (id) => id === 'codex' || id === 'claude',
    draftPreset: (id, preset) => records.setDraftPreset(id, preset),
    secretary: { draft: (id, session, text) => { describes.push([id, session, text]); return describeTaken; } },
  });
}

const SUPPORT = { variable: 'VENDOR_HOME', defaultFolder: ['.vendor'], withhold: { names: [], prefixes: [] } };

function publishProviders(): void {
  store.updateProviders(() => [...statuses].map(([key, status]) => {
    const [id = '', instanceId = ''] = key.split(':');
    return sampleProvider({ id, instanceId, status });
  }));
}
/** Sets one instance's status, as the registry would, and lets the sessions follow it. */
function setStatus(key: string, status: ProviderStatus | null): void {
  if (status === null) statuses.delete(key);
  else statuses.set(key, status);
  publishProviders();
  sessions.availabilityChanged();
}
/** The provider's switch in Settings: every instance of it reads disabled. */
const switchOff = (providerId: string): void => {
  for (const key of [...statuses.keys()]) if (key.startsWith(`${providerId}:`)) statuses.set(key, { kind: 'disabled' });
  setStatus(`${providerId}:default`, { kind: 'disabled' });
};

const main = { windowKind: 'main' } as const;
const SESSION_CHANNELS = INVOKE_CHANNELS.filter((channel) => channel.startsWith('sessions:'));
const deps = (detail: 'kinds' | 'full' = 'kinds', given = log): DispatchDeps => ({ origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log: given, detail });
const from = (kind: 'main' | 'pet', request: unknown) => ({ windowKind: kind, sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true }, request });
function dispatch(handlers: ReturnType<typeof open>, channel: InvokeChannel, kind: 'main' | 'pet', request: unknown, given = deps()) {
  const handler = (handlers as unknown as Record<string, Handler<unknown, unknown>>)[channel] ?? vi.fn();
  return dispatchInvoke(channel, INVOKE_SPECS[channel] as never, handler, from(kind, request), given);
}

const turn = (n: number) => sessions.apply({ type: 'turn-started', sessionId: S(n), turnId: 't1' });

describe('cancelling a new session', () => {
  it('removes only the unsent draft, retaining sessions that have started or are running', async () => {
    place([session(1), session(2, { reference: 'provider-session', folder: 'D:\\Code\\fat-g' }), session(3, { lastTurn: { turnId: 't1', startedAt: AT - 400, endedAt: AT - 300, outcome: 'completed' } }), session(4)]);
    const handlers = open();
    turn(4);
    expect(await handlers['sessions:remove']({ id: S(1), draftOnly: true }, main)).toEqual({ status: 'saved' });
    for (const n of [2, 3, 4]) {
      expect(await handlers['sessions:remove']({ id: S(n), draftOnly: true }, main)).toEqual({ status: 'refused', reason: 'draft-locked' });
      expect(onDisk(n)).toBeDefined();
    }
    expect(onDisk(1)).toBeUndefined();
  });
});

// ── V7: who may ask, and what ─────────────────────────────────────────────────────────────────
describe('the contract (V7; C31)', () => {
  it.each(SESSION_CHANNELS)('refuses the Pet on %s, before any handler runs', async (channel) => {
    place([session(1)]);
    const handlers = open();
    const before = readFileSync(file, 'utf8');
    expect(await dispatch(handlers, channel, 'pet', { id: S(1), flag: 'starred', on: true })).toEqual({ ok: false, error: 'forbidden' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(sessions.snapshot().selectedId).toBeNull();
  });

  it.each([
    ['sessions:create', { projectId: PROJECT, preset: { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high' }, name: 'x' }],
    ['sessions:create', { projectId: PROJECT, preset: { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', type: 'plan' } }],
    ['sessions:create', { projectId: PROJECT, preset: { providerId: 'codex', model: 'gpt-6-sol', effort: 'high' } }],
    ['sessions:create', { projectId: PROJECT, preset: { providerId: 'codex', instanceId: 'Work', model: 'gpt-6-sol', effort: 'high' } }],
    ['sessions:setEffort', { id: S(1), effort: 'low', instanceId: 'default' }],
    ['sessions:select', { id: S(1), acknowledge: false }],
    ['sessions:setFlag', { id: S(1), flag: 'starred', on: true, completed: true }],
    ['sessions:setFlag', { id: S(1), starred: true }],
    ['sessions:setFlag', { id: S(1), flag: 'pinned', on: true }],
    ['sessions:shelve', { id: S(1), at: 1 }],
    ['sessions:restore', { id: 'not-a-uuid' }],
    ['sessions:rename', { id: S(1), name: 'x', source: 'user' }],
    ['sessions:rename', { id: S(1), name: 'x'.repeat(2001) }],
    ['sessions:move', { id: S(1), before: null, group: 'starred' }],
    ['sessions:setEffort', { id: S(1), effort: 'low', model: 'gpt-5.6' }],
    ['sessions:remove', { id: S(1), force: true }],
    ['sessions:removeOrphans', {}],
    ['sessions:complete', { id: 'not-a-uuid' }],
  ] as const)('refuses %s with %j as a bad request', async (channel, request) => {
    place([session(1)]);
    expect(await dispatch(open(), channel, 'main', request)).toEqual({ ok: false, error: 'bad-request' });
  });

  it('refuses a session it does not have, on every channel that names one', async () => {
    place([session(1)]);
    const handlers = open();
    const unknown = { status: 'refused', reason: 'unknown-session' };
    expect(await handlers['sessions:select']({ id: S(9) }, main)).toEqual(unknown);
    expect(handlers['sessions:acknowledge']({ id: S(9) }, main)).toEqual(unknown);
    expect(await handlers['sessions:setFlag']({ id: S(9), flag: 'starred', on: true }, main)).toEqual(unknown);
    expect(await handlers['sessions:rename']({ id: S(9), name: 'Mine' }, main)).toEqual(unknown);
    expect(await handlers['sessions:complete']({ id: S(9) }, main)).toEqual(unknown);
    expect(await handlers['sessions:shelve']({ id: S(9) }, main)).toEqual(unknown);
    expect(await handlers['sessions:restore']({ id: S(9) }, main)).toEqual(unknown);
    expect(await handlers['sessions:move']({ id: S(9), before: null, group: { list: 'active', starred: false } }, main)).toEqual(unknown);
    expect(await handlers['sessions:setEffort']({ id: S(9), effort: 'low' }, main)).toEqual(unknown);
    expect(await handlers['sessions:remove']({ id: S(9) }, main)).toEqual(unknown);
  });

  it('answers records-refused while the file is refused', async () => {
    writeFileSync(file, '{');
    const handlers = open();
    const refused = { status: 'refused', reason: 'records-refused' };
    expect(await handlers['sessions:create']({ projectId: PROJECT, preset: { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null } }, main)).toEqual(refused);
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'low' }, main)).toEqual(refused);
    expect(await handlers['sessions:removeOrphans'](null, main)).toEqual(refused);
  });
});

describe('sessions:setDraftPreset admission', () => {
  const preset = { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'medium', speed: null };
  it('validates a main-window request and updates only the selection fields', async () => {
    place([session(1, { name: 'Typed draft', nameSource: 'user', starred: true })]);
    const handlers = open();
    expect(await dispatch(handlers, 'sessions:setDraftPreset', 'main', { id: S(1), preset: { ...preset, instanceId: WORK } })).toEqual({ ok: true, value: { status: 'saved' } });
    expect(onDisk(1)).toMatchObject({ id: S(1), name: 'Typed draft', starred: true, ...preset, instanceId: WORK });
    expect(onDisk(1)).not.toHaveProperty('presetId');
  });

  it.each([
    [{ instanceId: GONE }, 'instance-unavailable'],
    [{ model: 'gpt-hidden' }, 'model-not-listed'],
    [{ effort: 'nonexistent' }, 'effort-not-listed'],
    [{ providerId: 'claude', model: 'haiku', effort: null }, 'provider-not-offered'],
  ])('refuses an unavailable selection %j', async (patch, reason) => {
    place([session(1)], [project({ providers: ['codex'] })]);
    const handlers = open();
    const before = readFileSync(file, 'utf8');
    expect(await handlers['sessions:setDraftPreset']({ id: S(1), preset: { ...preset, ...patch } }, main)).toEqual({ status: 'refused', reason });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

// ── C32: create ───────────────────────────────────────────────────────────────────────────────
describe('sessions:create (V7; C32, C94)', () => {
  const create = (handlers: ReturnType<typeof open>, preset: { providerId: string; instanceId?: string; model: string; effort: string | null; speed?: string | null }, projectId = PROJECT) =>
    handlers['sessions:create']({ projectId, preset: { instanceId: 'default', speed: null, ...preset } }, main);

  it('makes the record with the preset, no reference and no folder, and selects it', async () => {
    place([session(1)]);
    const handlers = open();
    const answer = await create(handlers, { providerId: 'codex', model: 'gpt-5.6', effort: 'low' });
    expect(answer).toMatchObject({ status: 'saved' });
    const id = 'id' in answer ? answer.id : '';
    expect(sessions.snapshot().selectedId).toBe(id);
    expect(records.getSession(id)).toMatchObject({ projectId: PROJECT, providerId: 'codex', instanceId: 'default', model: 'gpt-5.6', effort: 'low', reference: null, folder: null, configFolder: null, name: null });
  });

  it('stores the surviving row’s key for a preset naming the row the tiles leave out (C94)', async () => {
    place([]);
    const handlers = open();
    const answer = await create(handlers, { providerId: 'claude', model: 'default', effort: 'high' });
    expect(records.getSession('id' in answer ? answer.id : '')).toMatchObject({ model: 'opus[1m]', effort: 'high' });
  });

  it.each([
    ['a project it does not have', { providerId: 'codex', model: 'gpt-6-sol', effort: 'high' }, S(50), 'unknown-project'],
    ['a hidden model', { providerId: 'codex', model: 'gpt-hidden', effort: 'high' }, PROJECT, 'model-not-listed'],
    ['a model that is not listed', { providerId: 'codex', model: 'gpt-9', effort: 'high' }, PROJECT, 'model-not-listed'],
    ['a level the model lacks', { providerId: 'codex', model: 'gpt-5.6', effort: 'ultra' }, PROJECT, 'effort-not-listed'],
    ['no level for a model with levels', { providerId: 'codex', model: 'gpt-6-sol', effort: null }, PROJECT, 'effort-not-listed'],
    ['a level for a model with none', { providerId: 'claude', model: 'haiku', effort: 'high' }, PROJECT, 'effort-not-listed'],
  ] as const)('refuses a preset for %s', async (_name, preset, projectId, reason) => {
    place([]);
    const handlers = open();
    expect(await create(handlers, preset, projectId)).toEqual({ status: 'refused', reason });
    expect(sessions.snapshot().sessions).toEqual([]);
  });

  it('refuses a preset whose provider the project does not offer, or that is switched off', async () => {
    place([], [project({ providers: ['codex'] })]);
    const handlers = open();
    expect(await create(handlers, { providerId: 'claude', model: 'opus[1m]', effort: 'high' })).toEqual({ status: 'refused', reason: 'provider-not-offered' });
    switchOff('codex');
    expect(await create(handlers, { providerId: 'codex', model: 'gpt-6-sol', effort: 'high' })).toEqual({ status: 'refused', reason: 'provider-unavailable' });
    // Whichever of its instances the preset names.
    expect(await create(handlers, { providerId: 'codex', instanceId: WORK, model: 'gpt-6-sol', effort: 'low' })).toEqual({ status: 'refused', reason: 'provider-unavailable' });
  });

  // M14b, V9 (C25, C30): the preset's instance.
  it('makes the record on the instance the preset names: every switched-on instance of an offered provider is accepted', async () => {
    place([]);
    const handlers = open();
    const answer = await create(handlers, { providerId: 'codex', instanceId: WORK, model: 'gpt-6-team', effort: 'ultra' });
    expect(answer).toMatchObject({ status: 'saved' });
    expect(records.getSession('id' in answer ? answer.id : '')).toMatchObject({ providerId: 'codex', instanceId: WORK, model: 'gpt-6-team', effort: 'ultra', configFolder: null });
    expect(await create(handlers, { providerId: 'codex', model: 'gpt-5.6', effort: 'low' })).toMatchObject({ status: 'saved' });
    expect(sessions.snapshot().sessions.map((entry) => entry.record.instanceId)).toEqual(['default', WORK]);
  });

  it.each<[string, string, ProviderStatus | null]>([
    ['is not configured', GONE, null],
    ['is switched off', WORK, { kind: 'disabled' }],
    ['is an entry that cannot be used', WORK, { kind: 'blocked', reason: 'invalid-instance', issue: 'label-taken' }],
    ['has lost its folder', WORK, { kind: 'blocked', reason: 'folder-missing' }],
    ['has a folder that is refused', WORK, { kind: 'blocked', reason: 'folder-refused', rule: 'project' }],
  ])('refuses a preset whose instance %s, and makes nothing', async (_name, instanceId, status) => {
    place([]);
    const handlers = open();
    if (status !== null) setStatus(`codex:${instanceId}`, status);
    expect(await create(handlers, { providerId: 'codex', instanceId, model: 'gpt-6-sol', effort: 'low' })).toEqual({ status: 'refused', reason: 'instance-unavailable' });
    expect(sessions.snapshot().sessions).toEqual([]);
    // The provider's other instance still takes one.
    expect(await create(handlers, { providerId: 'codex', model: 'gpt-6-sol', effort: 'high' })).toMatchObject({ status: 'saved' });
  });

  it.each([
    ['a model the named instance lacks, though the first lists it', { providerId: 'codex', instanceId: WORK, model: 'gpt-5.6', effort: 'low' }, 'model-not-listed'],
    ['a model the first instance lacks, though the added one lists it', { providerId: 'codex', model: 'gpt-6-team', effort: 'high' }, 'model-not-listed'],
    ['a level the named instance’s model lacks, though the first’s has it', { providerId: 'codex', instanceId: WORK, model: 'gpt-6-sol', effort: 'high' }, 'effort-not-listed'],
  ] as const)('refuses %s', async (_name, preset, reason) => {
    place([]);
    const handlers = open();
    expect(await create(handlers, preset)).toEqual({ status: 'refused', reason });
  });

  it('refuses an instance id that is neither the first one’s nor a UUID as a bad request', async () => {
    place([]);
    const handlers = open();
    for (const instanceId of ['work', '', 'D:\\accounts\\work']) {
      const request = { projectId: PROJECT, preset: { providerId: 'codex', instanceId, model: 'gpt-6-sol', effort: 'high' } };
      expect(await dispatch(handlers, 'sessions:create', 'main', request)).toEqual({ ok: false, error: 'bad-request' });
    }
  });

  it('answers a provider this build does not have as a bad request, as the provider channels do', async () => {
    place([]);
    const handlers = open();
    const request = { projectId: PROJECT, preset: { providerId: 'gemini', instanceId: 'default', model: 'gemini-3', effort: null } };
    expect(await dispatch(handlers, 'sessions:create', 'main', request)).toEqual({ ok: false, error: 'bad-request' });
  });
});

// ── C35, C108: the effort menu. The model is fixed at create (M14b, C55) ─────────────────────
describe('sessions:setEffort (V7; C35, C108; M14b, V20)', () => {
  it('has no channel that sets a model: the handlers hold none, and a request for one names no channel', () => {
    // Search has its own read-only handler module; mutations remain in this one.
    expect(Object.keys(open()).sort()).toEqual(SESSION_CHANNELS.filter((channel) => channel !== 'sessions:search' && channel !== 'sessions:closeSearch').sort());
    expect(SESSION_CHANNELS).not.toContain('sessions:setModel');
    expect(Object.keys(INVOKE_SPECS)).not.toContain('sessions:setModel');
  });

  it('leaves the model as it was through a change of level', async () => {
    place([session(1, { model: 'gpt-5.6', effort: 'low' })]);
    const handlers = open();
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'medium' }, main)).toEqual({ status: 'saved' });
    expect(onDisk(1)).toMatchObject({ model: 'gpt-5.6', effort: 'medium' });
  });

  it('sets one of the model’s levels, a caution one included, and refuses one it lacks', async () => {
    place([session(1), session(2, { model: 'gpt-5.6', effort: 'low' }), session(3, { providerId: 'claude', model: 'haiku', effort: null })]);
    const handlers = open();
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'ultra' }, main)).toEqual({ status: 'saved' });
    expect(onDisk(1)).toMatchObject({ effort: 'ultra' });
    expect(await handlers['sessions:setEffort']({ id: S(2), effort: 'ultra' }, main)).toEqual({ status: 'refused', reason: 'effort-not-listed' });
    expect(await handlers['sessions:setEffort']({ id: S(3), effort: 'high' }, main)).toEqual({ status: 'refused', reason: 'effort-not-listed' });
    expect(onDisk(2)).toMatchObject({ effort: 'low' });
  });

  it('refuses a level for a model the catalog no longer lists: the generic entry has none (C7)', async () => {
    place([session(1, { model: 'gpt-4-retired' })]);
    const handlers = open();
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'low' }, main)).toEqual({ status: 'refused', reason: 'effort-not-listed' });
  });

  it('refuses it for a session whose provider is switched off, or is not registered in this build (C108)', async () => {
    place([session(1), session(2, { providerId: 'gemini', model: 'gemini-3' })]);
    const handlers = open();
    switchOff('codex');
    const refusal = { status: 'refused', reason: 'provider-unavailable' };
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'low' }, main)).toEqual(refusal);
    expect(await handlers['sessions:setEffort']({ id: S(2), effort: 'low' }, main)).toEqual(refusal);
    // Both stay listed and selectable, with their star, Complete and Remove.
    expect(await handlers['sessions:select']({ id: S(2) }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:setFlag']({ id: S(2), flag: 'starred', on: true }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:complete']({ id: S(1) }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:remove']({ id: S(2) }, main)).toEqual({ status: 'saved' });
  });

  it('refuses it before the provider’s CLI has reported: it lists no model', async () => {
    place([session(1)]);
    const handlers = open();
    store.setCatalog({ ...CATALOG, providers: CATALOG.providers.map((provider) => (provider.id === 'codex' ? { ...provider, source: { kind: 'none' }, models: [] } : provider)) });
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'low' }, main)).toEqual({ status: 'refused', reason: 'effort-not-listed' });
  });
});

// ── M14b, V9 and V21: a session's own instance (C28, C29, C62) ────────────────────────────────
describe('sessions:setEffort and the session’s instance (M14b; C28, C29, C62)', () => {
  const held = (n: number) => sessions.snapshot().sessions.find((entry) => entry.record.id === S(n))?.hold;

  it('checks the level against the session’s own instance, whatever another instance of the provider lists', async () => {
    // The added account's gpt-6-sol has low and medium; the first account's has high and ultra too.
    place([session(1, { instanceId: WORK, effort: 'low' }), session(2, { effort: 'low' }), session(3, { instanceId: WORK, model: 'gpt-6-team', effort: 'low' })]);
    const handlers = open();
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'high' }, main)).toEqual({ status: 'refused', reason: 'effort-not-listed' });
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'medium' }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:setEffort']({ id: S(2), effort: 'high' }, main)).toEqual({ status: 'saved' });
    // A model only the added account lists has its levels there.
    expect(await handlers['sessions:setEffort']({ id: S(3), effort: 'ultra' }, main)).toEqual({ status: 'saved' });
    expect([onDisk(1), onDisk(2), onDisk(3)].map((entry) => entry?.['effort'])).toEqual(['medium', 'high', 'ultra']);
    expect([onDisk(1), onDisk(2), onDisk(3)].map((entry) => entry?.['instanceId'])).toEqual([WORK, 'default', WORK]);
  });

  it.each<[string, string, ProviderStatus | null]>([
    ['is no longer configured', GONE, null],
    ['is switched off', WORK, { kind: 'disabled' }],
    ['is blocked by its folder', WORK, { kind: 'blocked', reason: 'folder-missing' }],
  ])('refuses a session whose instance %s, which stays listed and selectable with its star and its Remove (C29)', async (_name, instanceId, status) => {
    place([session(1, { instanceId, effort: 'low' }), session(2)]);
    const handlers = open();
    if (status !== null) setStatus(`codex:${instanceId}`, status);
    expect([held(1), held(2)]).toEqual(['instance-unavailable', null]);
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'medium' }, main)).toEqual({ status: 'refused', reason: 'instance-unavailable' });
    expect(onDisk(1)).toMatchObject({ effort: 'low' });
    expect(await handlers['sessions:select']({ id: S(1) }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:setFlag']({ id: S(1), flag: 'starred', on: true }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:remove']({ id: S(1) }, main)).toEqual({ status: 'saved' });
    // The provider's other session is untouched.
    expect(await handlers['sessions:setEffort']({ id: S(2), effort: 'low' }, main)).toEqual({ status: 'saved' });
  });

  it('refuses a session whose configuration folder has moved, with the comparison awaited first, and keeps its Remove (C62, C73)', async () => {
    place([session(1, { instanceId: WORK, effort: 'low', reference: 'ref', folder: 'D:\\Code\\fat-g', configFolder: 'D:\\accounts\\work' })]);
    workFolder = 'D:\\accounts\\edited';
    const handlers = open();
    // Asked at once, before any comparison could have been published.
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'medium' }, main)).toEqual({ status: 'refused', reason: 'folder-moved' });
    expect(held(1)).toBe('folder-moved');
    expect(onDisk(1)).toMatchObject({ effort: 'low' });
    expect(await handlers['sessions:remove']({ id: S(1) }, main)).toEqual({ status: 'saved' });
  });

  it('takes the level for a session whose folder stands, and for one that has no reference yet', async () => {
    place([
      session(1, { instanceId: WORK, effort: 'low', reference: 'ref', folder: 'D:\\Code\\fat-g', configFolder: 'D:\\accounts\\work' }),
      session(2, { instanceId: WORK, effort: 'low' }),
    ]);
    const handlers = open();
    expect(await handlers['sessions:setEffort']({ id: S(1), effort: 'medium' }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:setEffort']({ id: S(2), effort: 'medium' }, main)).toEqual({ status: 'saved' });
  });
});

// ── Decision 0016: the speed tier, a fifth field changed as the effort is ────────────
describe('sessions:setSpeed (decision 0016)', () => {
  const unable = (): CatalogState => ({ ...CATALOG, providers: CATALOG.providers.map((provider) => (provider.id === 'codex' && provider.instanceId === 'default' ? { ...provider, speedTierRequest: { possible: false, reason: 'sdk_opt_in_required' } } : provider)) });

  it('sets a tier the session’s model lists, and standard speed again, and the page’s view of the record says it', async () => {
    place([session(1)]);
    const handlers = open();
    expect(await handlers['sessions:setSpeed']({ id: S(1), speed: 'priority' }, main)).toEqual({ status: 'saved' });
    expect(onDisk(1)).toMatchObject({ model: 'gpt-6-sol', effort: 'high', speed: 'priority' });
    expect(sessions.snapshot().sessions.find((entry) => entry.record.id === S(1))?.record.speed).toBe('priority');
    expect(await handlers['sessions:setSpeed']({ id: S(1), speed: null }, main)).toEqual({ status: 'saved' });
    expect(onDisk(1)).toMatchObject({ speed: null });
  });

  it('refuses a tier the model does not list, and any tier where its own account cannot ask for one; standard speed is always taken', async () => {
    place([session(1, { speed: 'priority' }), session(2, { instanceId: WORK })]);
    const handlers = open();
    expect(await handlers['sessions:setSpeed']({ id: S(1), speed: 'fast' }, main)).toEqual({ status: 'refused', reason: 'speed-not-listed' });
    store.setCatalog(unable());
    expect(await handlers['sessions:setSpeed']({ id: S(1), speed: 'priority' }, main)).toEqual({ status: 'refused', reason: 'speed-unavailable' });
    expect(onDisk(1)).toMatchObject({ speed: 'priority' });
    expect(await handlers['sessions:setSpeed']({ id: S(1), speed: null }, main)).toEqual({ status: 'saved' });
    // The added account's own entry says it can ask.
    expect(await handlers['sessions:setSpeed']({ id: S(2), speed: 'priority' }, main)).toEqual({ status: 'saved' });
  });

  it('refuses a tier for a model the catalog no longer lists, and any change for a session that is held or unknown', async () => {
    place([session(1, { model: 'gpt-4-retired' }), session(2)]);
    const handlers = open();
    expect(await handlers['sessions:setSpeed']({ id: S(1), speed: 'priority' }, main)).toEqual({ status: 'refused', reason: 'speed-not-listed' });
    expect(await handlers['sessions:setSpeed']({ id: S(9), speed: null }, main)).toEqual({ status: 'refused', reason: 'unknown-session' });
    switchOff('codex');
    expect(await handlers['sessions:setSpeed']({ id: S(2), speed: null }, main)).toEqual({ status: 'refused', reason: 'provider-unavailable' });
  });

  it('is the Main window’s only, and takes a tier’s id or null and nothing else', async () => {
    place([session(1)]);
    const handlers = open();
    expect(await dispatch(handlers, 'sessions:setSpeed', 'pet', { id: S(1), speed: null })).toEqual({ ok: false, error: 'forbidden' });
    expect((await dispatch(handlers, 'sessions:setSpeed', 'main', { id: S(1), speed: 'two words' })).ok).toBe(false);
    expect(await dispatch(handlers, 'sessions:setSpeed', 'main', { id: S(1), speed: 'priority' })).toEqual({ ok: true, value: { status: 'saved' } });
  });

  it('creates a session, and sets a draft’s preset, with the speed tier the preset carries, checked as the effort is', async () => {
    place([session(1)]);
    const handlers = open();
    const preset = { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: 'priority' };
    const created = await handlers['sessions:create']({ projectId: PROJECT, preset }, main);
    expect(created.status).toBe('saved');
    expect(created.status === 'saved' && records.getSession(created.id)?.speed).toBe('priority');
    expect(await handlers['sessions:create']({ projectId: PROJECT, preset: { ...preset, speed: 'fast' } }, main)).toEqual({ status: 'refused', reason: 'speed-not-listed' });
    expect(await handlers['sessions:setDraftPreset']({ id: S(1), preset }, main)).toEqual({ status: 'saved' });
    expect(onDisk(1)).toMatchObject({ speed: 'priority' });
    store.setCatalog(unable());
    expect(await handlers['sessions:setDraftPreset']({ id: S(1), preset: { ...preset, effort: 'low' } }, main)).toEqual({ status: 'refused', reason: 'speed-unavailable' });
    expect(onDisk(1)).toMatchObject({ effort: 'high', speed: 'priority' });
  });
});

// ── C33–C36, C96, C107, C114 ──────────────────────────────────────────────────────────────────
describe('the other actions (V7, V33)', () => {
  it('selects, acknowledges, stars, moves and completes through the service', async () => {
    place([session(1), session(2)]);
    const handlers = open();
    expect(await handlers['sessions:select']({ id: S(1) }, main)).toEqual({ status: 'saved' });
    expect(sessions.snapshot().selectedId).toBe(S(1));
    expect(handlers['sessions:acknowledge']({ id: S(2) }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:setFlag']({ id: S(2), flag: 'starred', on: true }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:move']({ id: S(1), before: S(2), group: { list: 'active', starred: false } }, main)).toEqual({ status: 'refused', reason: 'outside-group' });
    expect(await handlers['sessions:complete']({ id: S(1) }, main)).toEqual({ status: 'saved' });
    expect(onDisk(1)).toMatchObject({ completedAt: AT });
    expect(await handlers['sessions:move']({ id: S(1), before: null, group: { list: 'active', starred: false } }, main)).toEqual({ status: 'refused', reason: 'outside-group' });
    expect(onDisk(2)).toMatchObject({ starred: true });
  });

  it('sets a flag, shelves and restores through the service', async () => {
    place([session(1, { reference: 'r', folder: 'D:\\Code\\fat-g' })]);
    const handlers = open();
    expect(await handlers['sessions:setFlag']({ id: S(1), flag: 'toVerify', on: true }, main)).toEqual({ status: 'saved' });
    expect(await handlers['sessions:shelve']({ id: S(1) }, main)).toEqual({ status: 'saved' });
    expect(onDisk(1)).toMatchObject({ toVerify: true, shelvedAt: AT });
    expect(await handlers['sessions:restore']({ id: S(1) }, main)).toEqual({ status: 'saved' });
    expect(onDisk(1)).toMatchObject({ toVerify: true, shelvedAt: null });
  });

  it('refuses Complete, Remove session and Remove project while a turn runs', async () => {
    place([session(1), session(2)]);
    const handlers = open();
    const projects = projectHandlers({ openFolder: () => Promise.resolve(''), showInFolder: () => undefined, records, lookups: { realpath: () => Promise.resolve(null), folder: () => Promise.resolve('present') }, hasProvider: () => true, pickFolder: () => Promise.resolve(null), checkRoots: vi.fn(), sessionRunning: (id) => sessions.runningIn(id), platform: 'win32' });
    turn(1);
    expect(await handlers['sessions:complete']({ id: S(1) }, main)).toEqual({ status: 'refused', reason: 'running' });
    expect(await handlers['sessions:remove']({ id: S(1) }, main)).toEqual({ status: 'refused', reason: 'running' });
    expect(await projects['projects:remove']({ key: PROJECT }, main)).toEqual({ status: 'refused', reason: 'session-running' });
    expect(records.getProject(PROJECT)).toBeDefined();
    // The other session of the project does not run, and goes.
    expect(await handlers['sessions:remove']({ id: S(2) }, main)).toEqual({ status: 'saved' });
  });

  it('says what a running session does where main can say it, and answers sessions:doing (M22e)', async () => {
    place([session(1), session(2)]);
    open();
    const saying = sessionHandlers({ sessions, records, store, hasProvider: (id) => id === 'codex', doing: (id) => (id === S(1) ? 'integration' : 'turn') });
    turn(1);
    expect(await saying['sessions:complete']({ id: S(1) }, main)).toEqual({ status: 'refused', reason: 'running', doing: 'integration' });
    expect(await saying['sessions:remove']({ id: S(1) }, main)).toEqual({ status: 'refused', reason: 'running', doing: 'integration' });
    expect(await saying['sessions:shelve']({ id: S(1) }, main)).toEqual({ status: 'refused', reason: 'running', doing: 'integration' });
    expect(await saying['sessions:doing']({ id: S(1) }, main)).toEqual({ status: 'read', doing: 'integration' });
    // Not running: nothing to say.
    expect(await saying['sessions:doing']({ id: S(2) }, main)).toEqual({ status: 'read', doing: null });
    expect(await saying['sessions:doing']({ id: S(9) }, main)).toEqual({ status: 'refused', reason: 'unknown-session' });
  });

  it('refuses all three for a session waiting on its workers after its turn (C114)', async () => {
    place([session(1)]);
    const handlers = open();
    const projects = projectHandlers({ openFolder: () => Promise.resolve(''), showInFolder: () => undefined, records, lookups: { realpath: () => Promise.resolve(null), folder: () => Promise.resolve('present') }, hasProvider: () => true, pickFolder: () => Promise.resolve(null), checkRoots: vi.fn(), sessionRunning: (id) => sessions.runningIn(id), platform: 'win32' });
    turn(1);
    sessions.apply({ type: 'worker-started', sessionId: S(1), workerId: 'w1' });
    sessions.apply({ type: 'turn-ended', sessionId: S(1), turnId: 't1', outcome: 'completed' });
    expect(await handlers['sessions:complete']({ id: S(1) }, main)).toEqual({ status: 'refused', reason: 'running' });
    expect(await handlers['sessions:remove']({ id: S(1) }, main)).toEqual({ status: 'refused', reason: 'running' });
    expect(await projects['projects:remove']({ key: PROJECT }, main)).toEqual({ status: 'refused', reason: 'session-running' });
    sessions.apply({ type: 'worker-ended', sessionId: S(1), workerId: 'w1', outcome: 'completed' });
    await sessions.settled();
    expect(await projects['projects:remove']({ key: PROJECT }, main)).toEqual({ status: 'saved' });
    expect(sessions.snapshot().sessions).toEqual([]);
  });

  it('removes the entries without a project in one request (C107)', async () => {
    place([session(1), session(5, { projectId: S(77) }), 'text']);
    const handlers = open();
    expect(sessions.snapshot().orphans).toBe(2);
    expect(await handlers['sessions:removeOrphans'](null, main)).toEqual({ status: 'saved' });
    expect(sessions.snapshot().orphans).toBe(0);
    expect(onDisk(1)).toBeDefined();
  });
});

// M26 (round 2): what a session with no turn yet is described by, from its unsent draft.
describe('sessions:describeDraft (M26, round 2)', () => {
  it('hands the draft to the secretary with the session’s own instance and model, and saves nothing', async () => {
    place([session(1)]);
    const handlers = open();
    const before = readFileSync(file, 'utf8');
    expect(await handlers['sessions:describeDraft']({ id: S(1), text: 'Set up the login form' }, main)).toEqual({ status: 'taken' });
    expect(describes).toEqual([[S(1), expect.objectContaining({ providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol' }), 'Set up the login form']]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('answers skipped when the secretary asks nothing — the switch off, or no model it lists', async () => {
    place([session(1)]);
    describeTaken = false;
    expect(await open()['sessions:describeDraft']({ id: S(1), text: 'Set up the login form' }, main)).toEqual({ status: 'skipped' });
  });

  it.each([
    ['one that has a provider session', { reference: 'thread-1', folder: 'D:\\Code\\fat-g', configFolder: 'C:\\Users\\me\\.vendor' }],
    ['one whose turn has run', { lastTurn: { turnId: 't1', startedAt: AT - 400, endedAt: AT - 300, outcome: 'completed' } }],
    ['one the user has named', { name: 'Mine', nameSource: 'user' }],
  ])('asks nothing for %s', async (_name, overrides) => {
    place([session(1, overrides)]);
    expect(await open()['sessions:describeDraft']({ id: S(1), text: 'Set up the login form' }, main)).toEqual({ status: 'skipped' });
    expect(describes).toEqual([]);
  });

  it('refuses a session it does not have', async () => {
    place([session(1)]);
    expect(await open()['sessions:describeDraft']({ id: S(9), text: 'Set up' }, main)).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(describes).toEqual([]);
  });

  it('asks nothing while the records are refused', async () => {
    writeFileSync(file, '{');
    expect(await open()['sessions:describeDraft']({ id: S(1), text: 'Set up' }, main)).toEqual({ status: 'refused', reason: 'records-refused' });
    expect(describes).toEqual([]);
  });

  it.each([
    ['no text', { id: S(1) }],
    ['an empty text', { id: S(1), text: '' }],
    ['whitespace alone', { id: S(1), text: '   ' }],
    ['more than a name is written from', { id: S(1), text: 'x'.repeat(2001) }],
  ])('refuses %s as a bad request', async (_name, request) => {
    place([session(1)]);
    expect(await dispatch(open(), 'sessions:describeDraft', 'main', request)).toEqual({ ok: false, error: 'bad-request' });
    expect(describes).toEqual([]);
  });
});

// ── V15: the log, as a packaged build ─────────────────────────────────────────────────────────
describe('the log (V15; C66)', () => {
  const PRIVATE = /Private|private|019f2c1a|D:\\\\|notes\.txt/;

  it('logs the channel and the kind of a failed session write, with no name, reference, path or label', async () => {
    place([session(1, { name: 'Private plan', nameSource: 'user', reference: '019f2c1a-private', folder: 'D:\\Private\\folder' })], [project({ name: 'Private project' })]);
    const failure = Object.assign(new Error(`EPERM: operation not permitted, rename 'D:\\Private\\records.json.tmp'`), { code: 'EPERM' });
    const handlers = open({ write: () => Promise.reject(failure) });
    const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    expect(await dispatch(handlers, 'sessions:setFlag', 'main', { id: S(1), flag: 'starred', on: true }, deps('kinds', quiet))).toEqual({ ok: false, error: 'internal' });
    expect(quiet.error.mock.calls).toEqual([['[ipc] sessions:setFlag handler failed (Error EPERM)']]);
    expect(JSON.stringify([quiet.error.mock.calls, quiet.warn.mock.calls, log.error.mock.calls, log.warn.mock.calls, log.info.mock.calls])).not.toMatch(PRIVATE);
  });

  it('logs the channel and the fault of a refused request, never its values', async () => {
    place([session(1)]);
    const handlers = open();
    const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await dispatch(handlers, 'sessions:setEffort', 'main', { id: S(1), effort: 'a private level name', label: 'notes.txt' }, deps('kinds', quiet));
    await dispatch(handlers, 'sessions:create', 'main', { projectId: PROJECT, preset: { providerId: 'gemini', instanceId: 'default', model: 'private-model', effort: null, speed: null } }, deps('kinds', quiet));
    await dispatch(handlers, 'sessions:select', 'pet', { id: S(1) }, deps('kinds', quiet));
    expect(quiet.warn.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringMatching(/^\[ipc\] bad request on sessions:setEffort from the main window: /),
      '[ipc] bad request on sessions:create from the main window',
      expect.stringMatching(/^\[ipc\] refused sessions:select from the pet window: /),
    ]);
    expect(quiet.warn.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect(JSON.stringify(quiet.warn.mock.calls)).not.toMatch(PRIVATE);
  });

  it('logs a session event’s failed write by kind only', async () => {
    place([session(1, { name: 'Private plan', nameSource: 'user' })]);
    open({ write: () => Promise.reject(Object.assign(new Error(`EIO: i/o error, write 'D:\\Private\\records.json.tmp'`), { code: 'EIO' })) });
    sessions.apply({ type: 'turn-started', sessionId: S(1), turnId: 't1' });
    sessions.apply({ type: 'action-changed', sessionId: S(1), turnId: 't1', kind: 'reading', file: 'D:\\Private\\notes.txt' });
    await sessions.settled();
    expect(log.error.mock.calls).toEqual([['[sessions] a record change could not be saved (Error EIO)']]);
    expect(JSON.stringify([log.error.mock.calls, log.warn.mock.calls, log.info.mock.calls])).not.toMatch(PRIVATE);
  });
});
