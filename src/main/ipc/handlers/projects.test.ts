// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9 and V26: the project and records channels, through the real contract and dispatcher
// (docs/planning/_archive/M12.md, C23, C26, C27, C52, C53, C82).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOKE_CHANNELS } from '@shared/ipc/channels';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { createPreferencesStore, type PreferencesStore } from '../../prefs/store';
import type { Lookups } from '../../records/lookup';
import { RECORDS_FILE, RECORDS_VERSION } from '../../records/format';
import { createRecordsStore, type RecordsStore } from '../../records/store';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { prefsHandlers } from './prefs';
import { projectHandlers, type ProjectHandlerDeps } from './projects';
import { recordsHandlers } from './records';

const ID = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const OTHER = '9b2d6c1e-4f3a-4e8b-8c7d-6a5b4c3d2e1f';
let dir: string;
let records: RecordsStore;
let prefs: PreferencesStore;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** No real paths: roots are compared by the OS's usual rules, and every folder is there. */
const lookups: Lookups = { realpath: () => Promise.resolve(null), folder: () => Promise.resolve('present') };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-projects-ipc-'));
});
afterEach(() => {
  prefs?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const openRecords = () => {
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', log });
  return records;
};
const saved = (projects: unknown[]) =>
  writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects }), 'utf8');
const project = (id: string, name: string, root: string) => ({
  id, name, color: 'teal', hidden: false, providers: ['codex'],
  roots: [{ path: root, trust: { answer: 'trusted', answeredAt: '2026-01-01T00:00:00.000Z' } }],
});

function handlers(overrides: Partial<ProjectHandlerDeps> = {}) {
  return projectHandlers({
    openFolder: () => Promise.resolve(''),
    showInFolder: () => undefined,
    records,
    lookups,
    hasProvider: (id) => id === 'codex' || id === 'claude',
    pickFolder: () => Promise.resolve(null),
    checkRoots: vi.fn(),
    platform: 'win32',
    ...overrides,
  });
}
const main = { windowKind: 'main' } as const;

describe('the folder picker (C23, C24, C26)', () => {
  it('returns the folder normalized, with its name and no conflict', async () => {
    openRecords();
    const answer = await handlers({ pickFolder: () => Promise.resolve('D:/Code/fat-g/') })['projects:pickFolder']({ projectId: null, roots: [] }, main);
    expect(answer).toEqual({ status: 'picked', path: 'D:\\Code\\fat-g', folderName: 'fat-g', conflict: null, account: null });
  });

  it('proposes no name for a drive', async () => {
    openRecords();
    const answer = await handlers({ pickFolder: () => Promise.resolve('E:\\') })['projects:pickFolder']({ projectId: null, roots: [] }, main);
    expect(answer).toMatchObject({ path: 'E:\\', folderName: null });
  });

  it('names the draft root a new folder overlaps, among those C23 admits only', async () => {
    openRecords();
    const answers = ['D:\\Code', 'D:\\Code\\fat-g'];
    const folder = vi.fn(() => Promise.resolve<'present'>('present'));
    const realpath = vi.fn(() => Promise.resolve(null));
    const set = handlers({ pickFolder: () => Promise.resolve(answers.shift() ?? null), lookups: { realpath, folder } });
    await set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    // 'D:\elsewhere' was never picked: it is skipped, and never looked up.
    const answer = await set['projects:pickFolder']({ projectId: null, roots: ['D:\\elsewhere', 'D:\\Code'] }, main);
    expect(answer).toMatchObject({ status: 'picked', conflict: { index: 1, relation: 'inside' } });
    expect(realpath.mock.calls.flat()).not.toContain('D:\\elsewhere');
  });

  it('opens one picker at a time, and cancels cleanly', async () => {
    openRecords();
    let finish: (value: string | null) => void = () => undefined;
    const set = handlers({ pickFolder: () => new Promise((resolve) => { finish = resolve; }) });
    const first = set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    await Promise.resolve();
    expect(await set['projects:pickFolder']({ projectId: null, roots: [] }, main)).toEqual({ status: 'refused', reason: 'busy' });
    finish(null);
    expect(await first).toEqual({ status: 'cancelled' });
  });

  it('refuses a path that is not absolute, and opens nothing while records are refused', async () => {
    openRecords();
    expect(await handlers({ pickFolder: () => Promise.resolve('relative\\x') })['projects:pickFolder']({ projectId: null, roots: [] }, main))
      .toEqual({ status: 'refused', reason: 'unsupported-path' });
    writeFileSync(path.join(dir, RECORDS_FILE), '{', 'utf8');
    openRecords();
    const pick = vi.fn(() => Promise.resolve('D:\\x'));
    expect(await handlers({ pickFolder: pick })['projects:pickFolder']({ projectId: null, roots: [] }, main)).toEqual({ status: 'refused', reason: 'records-refused' });
    expect(pick).not.toHaveBeenCalled();
  });
});

describe('add and update (V9)', () => {
  const root = (rootPath: string) => ({ path: rootPath, trust: 'trusted' as const });

  it('refuses a path the picker did not return', async () => {
    openRecords();
    expect(await handlers()['projects:add']({ name: 'fat-g', color: 'teal', roots: [root('D:\\Code\\fat-g')], providers: ['codex'] }, main))
      .toEqual({ status: 'refused', reason: 'root-not-allowed', index: 0 });
  });

  it('adds a project from a picked folder', async () => {
    openRecords();
    const set = handlers({ pickFolder: () => Promise.resolve('D:\\Code\\fat-g') });
    await set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    const answer = await set['projects:add']({ name: '  fat-g  ', color: 'teal', roots: [root('D:\\Code\\fat-g')], providers: ['codex'] }, main);
    expect(answer).toMatchObject({ status: 'saved' });
    expect(records.getView().projects).toEqual([expect.objectContaining({ name: 'fat-g', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }] })]);
  });

  // M22, V15 (C40, C43): a project's default mode for each provider, saved with the project.
  it('saves a project’s default modes with it: one a provider lists, never one it does not, and an update that names none keeps what is stored', async () => {
    openRecords();
    const listed = (providerId: string, mode: string): boolean => ({ codex: ['read-only', 'ask-first', 'sandbox-ok'], claude: ['read-only', 'ask-first', 'edits-ok'] } as Record<string, string[]>)[providerId]?.includes(mode) === true;
    const set = handlers({ pickFolder: () => Promise.resolve('D:\\Code\\fat-g'), hasMode: listed });
    await set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    const draft = { name: 'fat-g', color: 'teal' as const, roots: [root('D:\\Code\\fat-g')], providers: ['codex', 'claude'] };
    const added = await set['projects:add']({ ...draft, permissionModes: { codex: 'sandbox-ok', claude: 'sandbox-ok' } }, main);
    if (added.status !== 'saved') throw new Error('not saved');
    // Claude lists no such mode: no default is ever a mode its provider does not have.
    expect(records.getProject(added.id)?.permissionModes).toEqual({ codex: 'sandbox-ok' });
    expect(records.getView().projects[0]).toMatchObject({ permissionModes: { codex: 'sandbox-ok' } });
    // Left out, what is stored stays; given, it is the whole of it: a provider left out uses the user's default.
    expect(await set['projects:update']({ id: added.id, ...draft }, main)).toEqual({ status: 'saved' });
    expect(records.getProject(added.id)?.permissionModes).toEqual({ codex: 'sandbox-ok' });
    expect(await set['projects:update']({ id: added.id, ...draft, permissionModes: { claude: 'edits-ok' } }, main)).toEqual({ status: 'saved' });
    expect(records.getProject(added.id)?.permissionModes).toEqual({ claude: 'edits-ok' });
    expect(await set['projects:update']({ id: added.id, ...draft, permissionModes: {} }, main)).toEqual({ status: 'saved' });
    expect(records.getProject(added.id)?.permissionModes).toEqual({});
    // A provider outside the registry is a bad request, as it is among the project's providers.
    await expect(Promise.resolve().then(() => set['projects:update']({ id: added.id, ...draft, permissionModes: { gemini: 'ask-first' } }, main))).rejects.toThrow();
  });

  it('after a restart, lets an edit keep the project’s saved roots — a missing one included — and refuses another project’s', async () => {
    saved([project(ID, 'fat-g', 'D:\\Code\\fat-g'), project(OTHER, 'website', 'D:\\Code\\website')]);
    openRecords();
    // A new handler set is a new run: nothing has been picked.
    const set = handlers({ lookups: { realpath: () => Promise.resolve(null), folder: () => Promise.resolve('missing') } });
    expect(await set['projects:update']({ id: ID, name: 'renamed', roots: [root('D:\\Code\\fat-g')], providers: ['codex'] }, main)).toEqual({ status: 'saved' });
    expect(await set['projects:update']({ id: ID, name: 'renamed', roots: [root('D:\\Code\\fat-g'), root('D:\\Code\\website')], providers: ['codex'] }, main))
      .toEqual({ status: 'refused', reason: 'root-not-allowed', index: 1 });
  });

  it('refuses overlapping roots of one project, naming both and how they stand (C26)', async () => {
    openRecords();
    const answers = ['D:\\Code', 'd:\\code\\FAT-G'];
    const set = handlers({ pickFolder: () => Promise.resolve(answers.shift() ?? null) });
    await set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    await set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    expect(await set['projects:add']({ name: 'x', color: 'red', roots: [root('D:\\Code'), root('d:\\code\\FAT-G')], providers: ['codex'] }, main))
      .toEqual({ status: 'refused', reason: 'root-overlap', first: 0, second: 1, relation: 'inside' });
  });

  it('lets one folder be a root of two projects (C27)', async () => {
    saved([project(ID, 'fat-g', 'D:\\Code\\fat-g')]);
    openRecords();
    const set = handlers({ pickFolder: () => Promise.resolve('D:\\Code\\fat-g') });
    await set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    expect(await set['projects:add']({ name: 'again', color: 'red', roots: [root('D:\\Code\\fat-g')], providers: ['claude'] }, main)).toMatchObject({ status: 'saved' });
  });

  it.each([
    ['an empty name', { name: ' \n\t ' }, { status: 'refused', reason: 'name-empty' }],
    ['no provider', { providers: [] }, { status: 'refused', reason: 'no-provider' }],
  ])('refuses %s', async (_name, change, expected) => {
    openRecords();
    const set = handlers({ pickFolder: () => Promise.resolve('D:\\x') });
    await set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    expect(await set['projects:add']({ name: 'x', color: 'red', roots: [root('D:\\x')], providers: ['codex'], ...change }, main)).toEqual(expected);
  });

  it('refuses an unknown project, and a provider outside the registry as a bad request', async () => {
    openRecords();
    expect(await handlers()['projects:update']({ id: ID, name: 'x', roots: [root('D:\\x')], providers: ['codex'] }, main)).toEqual({ status: 'refused', reason: 'unknown-project' });
    const result = await dispatchInvoke('projects:add', INVOKE_SPECS['projects:add'], handlers()['projects:add'], fromMain({ name: 'x', color: 'red', roots: [root('D:\\x')], providers: ['gemini'] }), deps('kinds'));
    expect(result).toEqual({ ok: false, error: 'bad-request' });
  });

  it('checks a project’s roots when its dialog asks, and nothing for an unknown id', () => {
    saved([project(ID, 'fat-g', 'D:\\Code\\fat-g')]);
    openRecords();
    const checkRoots = vi.fn();
    const set = handlers({ checkRoots });
    expect(set['projects:checkRoots']({ id: ID }, main)).toBeNull();
    expect(set['projects:checkRoots']({ id: OTHER }, main)).toBeNull();
    expect(checkRoots.mock.calls).toEqual([[['D:\\Code\\fat-g']]]);
  });
});

// ── Through the contract ──────────────────────────────────────────────────────────────────

const origins = resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined });
const deps = (detail: DispatchDeps['detail']): DispatchDeps => ({ origins, log, detail });
const fromMain = (request: unknown) => ({ windowKind: 'main' as const, sender: { frameUrl: 'app://fatg/index.html', isTopFrame: true }, request });
const fromPet = (request: unknown) => ({ windowKind: 'pet' as const, sender: { frameUrl: 'app://fatg/pet.html', isTopFrame: true }, request });

const RECORDS_CHANNELS = INVOKE_CHANNELS.filter((channel) => /^(projects|records):|^prefs:(startFresh|retry)$/.test(channel));
const VALID: Record<string, unknown> = {
  'prefs:startFresh': null,
  'prefs:retry': null,
  'records:startFresh': null,
  'records:retry': null,
  'projects:pickFolder': { projectId: null, roots: [] },
  'projects:openFolder': { projectId: ID, path: 'D:/Code' },
  'projects:add': { name: 'x', color: 'red', roots: [{ path: 'D:\\x', trust: 'trusted' }], providers: ['codex'] },
  'projects:update': { id: ID, name: 'x', roots: [{ path: 'D:\\x', trust: 'trusted' }], providers: ['codex'] },
  'projects:setHidden': { id: ID, hidden: true },
  'projects:setCollapsed': { id: ID, collapsed: true },
  'projects:move': { id: ID, hidden: false, before: null },
  'projects:remove': { key: ID },
  'projects:checkRoots': { id: ID },
};

function allHandlers(): Record<string, Handler<unknown, unknown>> {
  prefs = createPreferencesStore({ dir, providerIds: ['codex'], writeDelayMs: 10_000, log });
  return { ...prefsHandlers(prefs), ...recordsHandlers(records), ...handlers({ lookups: { ...lookups, realpath: (path) => Promise.resolve(path) } }) } as unknown as Record<string, Handler<unknown, unknown>>;
}

describe('the Main window’s only (V9, V26)', () => {
  it.each(RECORDS_CHANNELS)('refuses the Pet on %s, whatever it sends', async (channel) => {
    openRecords();
    const handler = vi.fn(allHandlers()[channel]);
    const result = await dispatchInvoke(channel, INVOKE_SPECS[channel] as never, handler, fromPet(VALID[channel]), deps('kinds'));
    expect(result).toEqual({ ok: false, error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(RECORDS_CHANNELS)('refuses an extra field on %s', async (channel) => {
    openRecords();
    const handler = vi.fn(allHandlers()[channel]);
    const valid = VALID[channel];
    const request = valid === null ? { extra: 1 } : { ...(valid as object), extra: 1 };
    const result = await dispatchInvoke(channel, INVOKE_SPECS[channel] as never, handler, fromMain(request), deps('kinds'));
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(RECORDS_CHANNELS)('accepts the Main window’s valid %s', async (channel) => {
    if (channel === 'projects:openFolder') saved([project(ID, 'Work', 'D:/Code')]);
    openRecords();
    const result = await dispatchInvoke(channel, INVOKE_SPECS[channel] as never, allHandlers()[channel] as never, fromMain(VALID[channel]), deps('kinds'));
    expect(result.ok).toBe(true);
  });
});

// M14b, V22 (C58): a project's root may not be an added account's folder, nor lie inside or around
// one. The account's own pick refuses the same three from its side (instances.test.ts), so the
// relation is refused in whichever order the two are made.
describe('a root and an added account’s folder (M14b, C58)', () => {
  const KEY = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const accountFolders = () => [{ providerId: 'codex', key: KEY, folder: 'D:\\accounts\\work' }];
  const account = (relation: string) => ({ providerId: 'codex', key: KEY, relation });
  const cases: [string, string, string][] = [
    ['is the account’s folder', 'D:\\accounts\\WORK', 'same'],
    ['is inside it', 'D:\\accounts\\work\\project', 'inside'],
    ['is around it', 'D:\\accounts', 'around'],
  ];

  it.each(cases)('the picker says at once that a folder which %s is refused, and for which account', async (_name, folder, relation) => {
    openRecords();
    const answer = await handlers({ pickFolder: () => Promise.resolve(folder), accountFolders })['projects:pickFolder']({ projectId: null, roots: [] }, main);
    expect(answer).toMatchObject({ status: 'picked', path: folder, conflict: null, account: account(relation) });
  });

  it.each(cases)('add refuses a root that %s, with a reason of its own, and saves nothing', async (_name, folder, relation) => {
    openRecords();
    const h = handlers({ pickFolder: () => Promise.resolve(folder), accountFolders });
    await h['projects:pickFolder']({ projectId: null, roots: [] }, main);
    const answer = await h['projects:add']({ name: 'P', color: 'teal', roots: [{ path: folder, trust: 'trusted' }], providers: ['codex'] }, main);
    expect(answer).toEqual({ status: 'refused', reason: 'account-folder', index: 0, account: account(relation) });
    expect(records.getView().projects).toEqual([]);
  });

  it.each(cases)('update refuses a new root that %s, and keeps the project as it was', async (_name, folder, relation) => {
    saved([project(ID, 'P', 'D:\\code\\app')]);
    openRecords();
    const h = handlers({ pickFolder: () => Promise.resolve(folder), accountFolders });
    await h['projects:pickFolder']({ projectId: ID, roots: ['D:\\code\\app'] }, main);
    const roots = [{ path: 'D:\\code\\app', trust: 'trusted' as const }, { path: folder, trust: 'trusted' as const }];
    expect(await h['projects:update']({ id: ID, name: 'P', roots, providers: ['codex'] }, main)).toEqual({ status: 'refused', reason: 'account-folder', index: 1, account: account(relation) });
    expect(records.getProject(ID)?.roots.map((root) => root.path)).toEqual(['D:\\code\\app']);
  });

  it('judges on the real paths: a link that leads into an account’s folder is inside it', async () => {
    openRecords();
    const real: Lookups = { realpath: (target) => Promise.resolve(target === 'D:\\links\\in' ? 'D:\\accounts\\work\\nested' : target), folder: () => Promise.resolve('present') };
    const answer = await handlers({ lookups: real, pickFolder: () => Promise.resolve('D:\\links\\in'), accountFolders })['projects:pickFolder']({ projectId: null, roots: [] }, main);
    expect(answer).toMatchObject({ status: 'picked', account: account('inside') });
  });

  it('accepts a folder beside an account’s, and a root around the first account’s default folder', async () => {
    openRecords();
    // The home folder holds the provider's default folder; only added accounts are compared.
    for (const folder of ['D:\\accounts\\other', 'C:\\Users\\me']) {
      const h = handlers({ pickFolder: () => Promise.resolve(folder), accountFolders });
      expect(await h['projects:pickFolder']({ projectId: null, roots: [] }, main)).toMatchObject({ status: 'picked', account: null });
      expect(await h['projects:add']({ name: folder, color: 'teal', roots: [{ path: folder, trust: 'trusted' }], providers: ['codex'] }, main)).toMatchObject({ status: 'saved' });
    }
  });

  it('leaves a root the project already had alone: only a root a change brings is refused', async () => {
    // The account was put inside the project's root by a hand edit; the project can still be renamed.
    saved([project(ID, 'P', 'D:\\accounts')]);
    openRecords();
    const h = handlers({ accountFolders });
    expect(await h['projects:update']({ id: ID, name: 'Renamed', roots: [{ path: 'D:\\accounts', trust: 'trusted' }], providers: ['codex'] }, main)).toEqual({ status: 'saved' });
  });

  it('compares nothing when no account was added', async () => {
    openRecords();
    const h = handlers({ pickFolder: () => Promise.resolve('D:\\accounts\\work') });
    expect(await h['projects:pickFolder']({ projectId: null, roots: [] }, main)).toMatchObject({ status: 'picked', account: null });
  });
});


describe('opening a project root in the file manager', () => {
  function opener(platform = 'win32') {
    const openFolder = vi.fn(() => Promise.resolve(''));
    const showInFolder = vi.fn();
    const folder = vi.fn(() => Promise.resolve<'present' | 'missing' | 'no-answer'>('present'));
    const realpath = vi.fn((path: string) => Promise.resolve<string | null>(path));
    const set = handlers({ openFolder, showInFolder, platform, lookups: { folder, realpath } });
    return { set, openFolder, showInFolder, folder, realpath };
  }

  it('opens a saved root, including an untrusted one, without changing the project', async () => {
    saved([{ ...project(ID, 'Work', 'D:/Code'), roots: [{ path: 'D:/Code', trust: { answer: 'not-trusted', answeredAt: '2026-01-01T00:00:00.000Z' } }] }]);
    openRecords();
    const h = opener();
    const before = records.getView();
    expect(await h.set['projects:openFolder']({ projectId: ID, path: 'D:/Code' }, main)).toBeNull();
    expect(h.openFolder).toHaveBeenCalledExactlyOnceWith('D:\\Code');
    expect(h.showInFolder).not.toHaveBeenCalled();
    expect(records.getView()).toEqual(before);
  });

  it('opens a folder picked before the project is saved', async () => {
    openRecords();
    const openFolder = vi.fn(() => Promise.resolve(''));
    const set = handlers({ openFolder, pickFolder: () => Promise.resolve('D:/Code'), lookups: { folder: () => Promise.resolve('present'), realpath: (path) => Promise.resolve(path) } });
    await set['projects:pickFolder']({ projectId: null, roots: [] }, main);
    expect(await set['projects:openFolder']({ projectId: null, path: 'D:/Code' }, main)).toBeNull();
    expect(openFolder).toHaveBeenCalledOnce();
    expect(records.getView().projects).toEqual([]);
  });

  it('refuses an unpicked path, a root from another project, a relative path and an unknown project before any lookup', async () => {
    saved([project(ID, 'Work', 'D:/Code'), project(OTHER, 'Other', 'D:/Other')]);
    openRecords();
    const h = opener();
    for (const request of [{ projectId: null, path: 'D:/Code' }, { projectId: ID, path: 'D:/Other' }, { projectId: ID, path: 'relative' }, { projectId: ID, path: 'D:/Code/file.txt' }, { projectId: '00000000-0000-4000-8000-000000000000', path: 'D:/Code' }]) {
      await expect(h.set['projects:openFolder'](request, main)).rejects.toThrow();
    }
    expect(h.folder).not.toHaveBeenCalled();
    expect(h.realpath).not.toHaveBeenCalled();
    expect(h.openFolder).not.toHaveBeenCalled();
  });

  it.each(['missing', 'no-answer'] as const)('opens nothing if the selected path is now %s (including replacement by a file)', async (state) => {
    saved([project(ID, 'Work', 'D:/Code')]);
    openRecords();
    const h = opener();
    h.folder.mockResolvedValue(state);
    await expect(h.set['projects:openFolder']({ projectId: ID, path: 'D:/Code' }, main)).rejects.toThrow();
    expect(h.openFolder).not.toHaveBeenCalled();
    expect(h.showInFolder).not.toHaveBeenCalled();
  });

  it('refuses an unresolved folder, and hides native error paths on failure', async () => {
    saved([project(ID, 'Work', 'D:/Code')]);
    openRecords();
    const h = opener();
    h.realpath.mockResolvedValueOnce(null);
    await expect(h.set['projects:openFolder']({ projectId: ID, path: 'D:/Code' }, main)).rejects.toThrow();
    expect(h.openFolder).not.toHaveBeenCalled();
    h.openFolder.mockResolvedValueOnce('private path D:/Code');
    await expect(h.set['projects:openFolder']({ projectId: ID, path: 'D:/Code' }, main)).rejects.toThrow('the project folder could not be opened');
    h.openFolder.mockRejectedValueOnce(new Error('private path D:/Code'));
    await expect(h.set['projects:openFolder']({ projectId: ID, path: 'D:/Code' }, main)).rejects.toThrow('the project folder could not be opened');
  });

  it('reveals a macOS bundle reached through a symlink, without launching it', async () => {
    saved([project(ID, 'Work', '/work/link')]);
    records = createRecordsStore({ dir, providerIds: ['codex'], platform: 'darwin', log });
    const h = opener('darwin');
    h.realpath.mockResolvedValue('/Applications/Example.app');
    expect(await h.set['projects:openFolder']({ projectId: ID, path: '/work/link' }, main)).toBeNull();
    expect(h.showInFolder).toHaveBeenCalledExactlyOnceWith('/Applications/Example.app');
    expect(h.openFolder).not.toHaveBeenCalled();
  });
});
