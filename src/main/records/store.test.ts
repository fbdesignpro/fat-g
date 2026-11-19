// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The records store (docs/planning/_archive/M12.md, Verification V1–V4, V18, V19, V27), in plain Node: no
// Electron, a temporary folder, and a writer the tests can hold or break.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../storage/atomic-write';
import { RECORDS_FILE, RECORDS_VERSION } from './format';
import { createRecordsStore, type ProjectInput, type RecordsStore, type RecordsStoreOptions, type SessionRecipe } from './store';

let dir: string;
let file: string;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const AT = Date.parse('2020-01-21T14:03:12.000Z');
const ID = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const OTHER = '9b2d6c1e-4f3a-4e8b-8c7d-6a5b4c3d2e1f';
const anyRoot = () => true;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-records-'));
  file = path.join(dir, RECORDS_FILE);
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

let ids = 0;
const open = (options: Partial<RecordsStoreOptions> = {}): RecordsStore =>
  createRecordsStore({
    dir,
    providerIds: ['codex', 'claude'],
    platform: 'win32',
    now: () => AT,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    log,
    ...options,
  });
const writeText = (text: string) => writeFileSync(file, text, 'utf8');
const writeDoc = (doc: unknown) => writeText(`${JSON.stringify(doc, null, 2)}\n`);
const readText = () => readFileSync(file, 'utf8');
const readBack = () => JSON.parse(readText()) as { projects: Record<string, unknown>[] } & Record<string, unknown>;

const input = (overrides: Partial<ProjectInput> = {}): ProjectInput & { color: 'teal' } => ({
  name: 'fat-g',
  color: 'teal',
  roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }],
  providers: ['codex'],
  ...overrides,
});
const project = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'fat-g',
  color: 'teal',
  roots: [{ path: 'D:\\Code\\fat-g', trust: { answer: 'trusted', answeredAt: '2026-01-01T00:00:00.000Z' } }],
  hidden: false,
  providers: ['codex'],
  ...overrides,
});
/** A file at this build's version. */
const current = (projects: unknown[], extra: Record<string, unknown> = {}) => ({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects, ...extra });
const NEWER = RECORDS_VERSION + 1;
const names = (store: RecordsStore) => store.getView().projects.map((entry) => (entry.kind === 'project' ? entry.name : '?'));

describe('saved project folds', () => {
  it.each([undefined, null, 'true', 1, false, true])('reads %j as folded only when it is true', (collapsed) => {
    writeDoc(current([project({ collapsed })]));
    expect(open().getProject(ID)?.collapsed).toBe(collapsed === true);
  });

  it('round trips each fold independently and preserves unknown fields through other edits', async () => {
    writeDoc(current([project({ future: { kept: true } }), project({ id: OTHER, name: 'other', collapsed: true })], { future: 'kept' }));
    const store = open();
    await store.setCollapsed(ID, true);
    await store.setCollapsed(OTHER, false);
    await store.update(ID, input({ name: 'renamed' }), anyRoot);
    await store.setHidden(ID, true);
    await store.move(ID, false, OTHER);
    expect(open().getProject(ID)).toMatchObject({ collapsed: true, name: 'renamed', hidden: false });
    expect(open().getProject(OTHER)?.collapsed).toBe(false);
    expect(readBack()).toMatchObject({ future: 'kept', projects: [expect.objectContaining({ future: { kept: true }, collapsed: true }), expect.objectContaining({ collapsed: false })] });
  });

  it('skips unchanged flags and refuses unknown projects without writing', async () => {
    writeDoc(current([project()]));
    const write = vi.fn(() => Promise.resolve());
    const store = open({ write });
    expect(await store.setCollapsed(ID, false)).toEqual({ status: 'saved' });
    expect(await store.setCollapsed(OTHER, true)).toEqual({ status: 'refused', reason: 'unknown-project' });
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves memory and the file unchanged on a failed write', async () => {
    writeDoc(current([project()]));
    const before = readText();
    const store = open({ write: () => Promise.reject(new Error('disk')) });
    await expect(store.setCollapsed(ID, true)).rejects.toThrow('disk');
    expect(store.getProject(ID)?.collapsed).toBe(false);
    expect(readText()).toBe(before);
  });

  it('refuses version 6 unchanged, including fold writes', async () => {
    writeDoc({ ...current([project()]), schemaVersion: 6, minReaderVersion: 6 });
    const before = readText();
    const store = open();
    expect(store.getView().status).toEqual({ kind: 'refused', cause: 'older' });
    expect(await store.setCollapsed(ID, true)).toEqual({ status: 'refused', reason: 'records-refused' });
    expect(readText()).toBe(before);
  });
});

// ── V1 ────────────────────────────────────────────────────────────────────────────────────
describe('a fresh start and a round trip (V1)', () => {
  it('starts with no projects and writes nothing until a change', () => {
    const store = open();
    expect(store.getView()).toEqual({ status: { kind: 'ok', keptAs: null }, projects: [], sessions: [], orphans: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes this build’s version twice at the first change, with both lists, and reads it back (M14, C1; M14b, C26)', async () => {
    const store = open();
    const answer = await store.add(input(), anyRoot);
    expect(answer).toEqual({ status: 'saved', id: '00000000-0000-4000-8000-000000000001' });
    expect(readText().endsWith('}\n')).toBe(true);
    expect(readBack()).toEqual({
      schemaVersion: RECORDS_VERSION,
      minReaderVersion: RECORDS_VERSION,
      projects: [{
        id: '00000000-0000-4000-8000-000000000001',
        name: 'fat-g',
        color: 'teal',
        roots: [{ path: 'D:\\Code\\fat-g', trust: { answer: 'trusted', answeredAt: '2020-01-21T14:03:12.000Z' } }],
        hidden: false,
        collapsed: false,
        providers: ['codex'],
        permissionModes: {},
      }],
      sessions: [],
    });
    const again = open();
    expect(again.getView()).toEqual(store.getView());
  });

  it('writes the list in its order, and a new project at the end (C15, C49)', async () => {
    const store = open();
    await store.add(input({ name: 'one' }), anyRoot);
    await store.add(input({ name: 'two', roots: [{ path: 'D:\\two', trust: 'trusted' }] }), anyRoot);
    await store.add(input({ name: 'three', roots: [{ path: 'D:\\three', trust: 'trusted' }] }), anyRoot);
    expect(readBack().projects.map((entry) => entry['name'])).toEqual(['one', 'two', 'three']);
    expect(names(open())).toEqual(['one', 'two', 'three']);
  });

  it('makes a new id for each project, never one in use (C14)', async () => {
    let next = 0;
    const sequence = [ID, ID, OTHER];
    writeDoc(current([project()]));
    const store = open({ newId: () => sequence[next++] ?? 'x' });
    expect(await store.add(input({ roots: [{ path: 'D:\\other', trust: 'trusted' }] }), anyRoot)).toEqual({ status: 'saved', id: OTHER });
  });

  it('logs counts only (C54)', () => {
    writeDoc(current([project({ name: 'Someone Private' }), 42]));
    open();
    expect(log.info).toHaveBeenCalledWith('[records] loaded 1 project, 1 unreadable; 0 sessions, 0 unreadable, 0 without a project');
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toMatch(/Someone|Code/);
  });
});

// ── V2 ────────────────────────────────────────────────────────────────────────────────────
describe('a file fat-g refuses (V2)', () => {
  const cases: [string, () => void, string, Partial<RecordsStoreOptions>?][] = [
    ['unreadable', () => mkdirSync(file), 'unreadable'],
    ['invalid JSON', () => writeText('{ "schemaVersion": 3,'), 'damaged'],
    ['not an object', () => writeText('[]'), 'damaged'],
    ['a missing envelope', () => writeDoc({ projects: [] }), 'damaged'],
    ['a bad envelope', () => writeDoc({ schemaVersion: 4, minReaderVersion: 5, projects: [] }), 'damaged'],
    ['projects that is not a list', () => writeDoc({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: {} }), 'damaged'],
    ['sessions that is not a list (M14, C3)', () => writeDoc({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [], sessions: {} }), 'damaged'],
    ['one that needs a newer reader', () => writeDoc({ schemaVersion: NEWER, minReaderVersion: NEWER, projects: [project()] }), 'newer'],
    ['version 1, which M14 left behind (C1)', () => writeDoc({ schemaVersion: 1, minReaderVersion: 1, projects: [project()] }), 'older'],
    ['version 2, which M14b left behind (M14b, C26)', () => writeDoc({ schemaVersion: 2, minReaderVersion: 2, projects: [project()], sessions: [] }), 'older'],
    ['version 3, which M18 left behind (M18, C29)', () => writeDoc({ schemaVersion: 3, minReaderVersion: 3, projects: [project()], sessions: [] }), 'older'],
    ['version 4, which M22 left behind (M22, C25)', () => writeDoc({ schemaVersion: 4, minReaderVersion: 4, projects: [project()], sessions: [] }), 'older'],
    ['version 5, which the session flags and the shelf left behind', () => writeDoc({ schemaVersion: 5, minReaderVersion: 5, projects: [project()], sessions: [] }), 'older'],
    ['an older version', () => writeDoc(current([project()])), 'older', { version: NEWER }],
  ];

  it.each(cases)('leaves %s byte-identical and refuses every change', async (_name, make, cause, options = {}) => {
    make();
    const before = existsSync(file) && !readdirSync(dir).includes('x') ? tryRead() : null;
    const store = open(options);
    expect(store.getView()).toEqual({ status: { kind: 'refused', cause }, projects: [], sessions: [], orphans: 0 });
    expect(store.isRefused()).toBe(true);
    const refused = { status: 'refused', reason: 'records-refused' };
    expect(await store.add(input(), anyRoot)).toEqual(refused);
    expect(await store.update(ID, input(), anyRoot)).toEqual(refused);
    expect(await store.setHidden(ID, true)).toEqual(refused);
    expect(await store.move(ID, false, null)).toEqual(refused);
    expect(await store.remove(ID)).toEqual(refused);
    expect(tryRead()).toBe(before);
    expect(readdirSync(dir)).toEqual([RECORDS_FILE]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(dir);
  });

  it('says why a file could not be opened, by its code only', () => {
    const store = open({ readFile: () => { throw Object.assign(new Error(`EBUSY: resource busy, open '${file}'`), { code: 'EBUSY' }); } });
    expect(store.getView().status).toEqual({ kind: 'refused', cause: 'unreadable' });
    expect(log.warn).toHaveBeenCalledWith('[records] could not be read (EBUSY); the file is left as it is');
  });

  it('loads an accepted envelope with no projects, and adds the list at the first change', async () => {
    writeDoc({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, future: 'keep' });
    const store = open();
    expect(store.getView().projects).toEqual([]);
    await store.add(input(), anyRoot);
    expect(readBack()).toMatchObject({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, future: 'keep', projects: [{ name: 'fat-g' }] });
  });
});

function tryRead(): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// ── V3 ────────────────────────────────────────────────────────────────────────────────────
describe('what this build does not know (V3)', () => {
  const future = () => ({
    schemaVersion: NEWER,
    minReaderVersion: RECORDS_VERSION,
    sessions: [{ id: 'kept' }],
    artifacts: [{ id: 'kept too' }],
    futureTop: { keep: true },
    projects: [
      project({
        color: 'gold',
        providers: ['gemini', 'codex'],
        futureProject: [1, 2],
        roots: [{ path: 'D:\\Code\\fat-g', trust: { answer: 'trusted', answeredAt: '2026-01-01T00:00:00.000Z', how: 'dialog' }, futureRoot: 'keep' }],
      }),
    ],
  });

  it('shows an unknown colour as none and lists only known providers (C12)', () => {
    writeDoc(future());
    const [entry] = open().getView().projects;
    expect(entry).toMatchObject({ kind: 'project', color: null, providers: ['codex'] });
  });

  it.each([
    ['a hide', (store: RecordsStore) => store.setHidden(ID, true)],
    ['a move', (store: RecordsStore) => store.move(ID, true, null)],
    ['an edit that names no colour', (store: RecordsStore) => store.update(ID, { name: 'renamed', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }], providers: ['claude'] }, anyRoot)],
    ['an add', (store: RecordsStore) => store.add(input({ roots: [{ path: 'D:\\elsewhere', trust: 'trusted' }] }), anyRoot)],
  ])('keeps every unknown field and value through %s (C11, C12, C76)', async (_name, change) => {
    writeDoc(future());
    const store = open();
    expect(await change(store)).toMatchObject({ status: 'saved' });
    const back = readBack();
    expect(back).toMatchObject({ schemaVersion: NEWER, minReaderVersion: RECORDS_VERSION, sessions: [{ id: 'kept' }], artifacts: [{ id: 'kept too' }], futureTop: { keep: true } });
    const [first] = back.projects;
    expect(first).toMatchObject({ color: 'gold', futureProject: [1, 2] });
    expect(first?.['providers']).toEqual(expect.arrayContaining(['gemini']));
    expect((first?.['roots'] as Record<string, unknown>[])[0]).toMatchObject({ futureRoot: 'keep', trust: { how: 'dialog' } });
    // It reloads with both numbers and its unknown fields.
    expect(open().getView().status).toEqual({ kind: 'ok', keptAs: null });
  });

  it('puts unknown provider ids after the known ones', async () => {
    writeDoc(future());
    const store = open();
    await store.update(ID, { name: 'fat-g', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }], providers: ['claude', 'codex'] }, anyRoot);
    expect(readBack().projects[0]?.['providers']).toEqual(['claude', 'codex', 'gemini']);
  });

  it('replaces an unknown colour when the edit names one', async () => {
    writeDoc(future());
    const store = open();
    await store.update(ID, { name: 'fat-g', color: 'blue', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }], providers: ['codex'] }, anyRoot);
    expect(readBack().projects[0]?.['color']).toBe('blue');
  });
});

// ── V4 ────────────────────────────────────────────────────────────────────────────────────
describe('writes (V4)', () => {
  it('leaves memory and disk as they were when a write fails, and rejects', async () => {
    writeDoc(current([project()]));
    const before = readText();
    const failure = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    const store = open({ write: () => Promise.reject(failure) });
    const view = store.getView();
    const listener = vi.fn();
    store.subscribe(listener);
    await expect(store.setHidden(ID, true)).rejects.toBe(failure);
    expect(store.getView()).toBe(view);
    expect(listener).not.toHaveBeenCalled();
    expect(readText()).toBe(before);
  });

  it('applies requests sent together in order, and answers none before its change is on disk', async () => {
    const releases: (() => void)[] = [];
    const written: string[] = [];
    const write = vi.fn((target: string, data: string) => new Promise<void>((resolve) => {
      releases.push(() => { void writeFileAtomic(target, data).then(() => { written.push(data); resolve(); }); });
    }));
    const store = open({ write });
    const answered: string[] = [];
    const first = store.add(input({ name: 'one' }), anyRoot).then(() => answered.push('one'));
    const second = store.add(input({ name: 'two', roots: [{ path: 'D:\\two', trust: 'trusted' }] }), anyRoot).then(() => answered.push('two'));
    const third = store.add(input({ name: 'three', roots: [{ path: 'D:\\three', trust: 'trusted' }] }), anyRoot).then(() => answered.push('three'));
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(answered).toEqual([]);
    // The first went at once; the two behind it wait for it, then go to disk together.
    releases[0]?.();
    await first;
    expect(answered).toEqual(['one']);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(answered).toEqual(['one']);
    releases[1]?.();
    await Promise.all([second, third]);
    expect(answered).toEqual(['one', 'two', 'three']);
    expect(write).toHaveBeenCalledTimes(2);
    expect(names(store)).toEqual(['one', 'two', 'three']);
    expect(JSON.parse(written[1] ?? '{}')).toMatchObject({ projects: [{ name: 'one' }, { name: 'two' }, { name: 'three' }] });
  });

  it('rejects every request in a failed write, and the next change starts from the old state', async () => {
    let fail = false;
    let release = (): void => undefined;
    const write = vi.fn((target: string, data: string) => {
      if (fail) return Promise.reject(new Error('EIO'));
      return new Promise<void>((resolve) => { release = () => { void writeFileAtomic(target, data).then(resolve); }; });
    });
    const store = open({ write });
    const first = store.add(input({ name: 'one' }), anyRoot);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const queued = [store.add(input({ name: 'two', roots: [{ path: 'D:\\two', trust: 'trusted' }] }), anyRoot), store.add(input({ name: 'three', roots: [{ path: 'D:\\three', trust: 'trusted' }] }), anyRoot)];
    fail = true;
    release();
    await first;
    const results = await Promise.allSettled(queued);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(names(store)).toEqual(['one']);
    fail = false;
    const fourth = store.add(input({ name: 'four', roots: [{ path: 'D:\\four', trust: 'trusted' }] }), anyRoot);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    release();
    await fourth;
    expect(names(store)).toEqual(['one', 'four']);
  });

  it('answers a change that alters nothing, or that the state refuses, without a write', async () => {
    writeDoc(current([project()]));
    const write = vi.fn(() => Promise.resolve());
    const store = open({ write });
    expect(await store.setHidden(ID, false)).toEqual({ status: 'saved' });
    expect(await store.setHidden(OTHER, true)).toEqual({ status: 'refused', reason: 'unknown-project' });
    expect(await store.move(ID, false, ID)).toEqual({ status: 'saved' });
    expect(write).not.toHaveBeenCalled();
  });

  it('lets the others go ahead when one change names a removed project', async () => {
    writeDoc(current([project(), project({ id: OTHER, name: 'website', roots: [{ path: 'D:\\website' }] })]));
    const store = open();
    const [removed, hidden, gone] = await Promise.all([store.remove(ID), store.setHidden(OTHER, true), store.setHidden(ID, true)]);
    expect([removed, hidden, gone]).toEqual([{ status: 'saved' }, { status: 'saved' }, { status: 'refused', reason: 'unknown-project' }]);
    expect(readBack().projects).toEqual([expect.objectContaining({ id: OTHER, hidden: true })]);
  });
});

// ── Changes ───────────────────────────────────────────────────────────────────────────────
describe('changes', () => {
  it('refuses a root the picker did not return in this run (C23)', async () => {
    const store = open();
    const picked = new Set(['D:\\a']);
    expect(await store.add(input({ roots: [{ path: 'D:\\a', trust: 'trusted' }, { path: 'D:\\b', trust: 'trusted' }] }), (root) => picked.has(root)))
      .toEqual({ status: 'refused', reason: 'root-not-allowed', index: 1 });
  });

  it('lets an edit keep the project’s saved roots without picking them again, and no other project’s', async () => {
    writeDoc(current([project(), project({ id: OTHER, name: 'website', roots: [{ path: 'D:\\website' }] })]));
    const store = open();
    const none = () => false;
    expect(await store.update(ID, { name: 'renamed', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }], providers: ['codex'] }, none)).toEqual({ status: 'saved' });
    expect(await store.update(ID, { name: 'renamed', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }, { path: 'D:\\website', trust: 'trusted' }], providers: ['codex'] }, none))
      .toEqual({ status: 'refused', reason: 'root-not-allowed', index: 1 });
  });

  it('stamps a trust answer when it is new or changed, and keeps the old time otherwise (C33)', async () => {
    writeDoc(current([project()]));
    let now = AT;
    const store = open({ now: () => now });
    now = AT + 60_000;
    await store.update(ID, { name: 'fat-g', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }, { path: 'D:\\docs', trust: 'not-trusted' }], providers: ['codex'] }, anyRoot);
    expect(readBack().projects[0]?.['roots']).toEqual([
      { path: 'D:\\Code\\fat-g', trust: { answer: 'trusted', answeredAt: '2026-01-01T00:00:00.000Z' } },
      { path: 'D:\\docs', trust: { answer: 'not-trusted', answeredAt: '2020-01-21T14:04:12.000Z' } },
    ]);
    now = AT + 120_000;
    await store.update(ID, { name: 'fat-g', roots: [{ path: 'D:\\Code\\fat-g', trust: 'not-trusted' }], providers: ['codex'] }, anyRoot);
    // The removed root's answer went with it.
    expect(readBack().projects[0]?.['roots']).toEqual([{ path: 'D:\\Code\\fat-g', trust: { answer: 'not-trusted', answeredAt: '2020-01-21T14:05:12.000Z' } }]);
  });

  it('shows the normalized name, and saves it at the next change (C16)', async () => {
    writeDoc(current([project({ name: '  fat-g \t tools  ' })]));
    const store = open();
    expect(names(store)).toEqual(['fat-g tools']);
    await store.setHidden(ID, true);
    expect(readBack().projects[0]?.['name']).toBe('  fat-g \t tools  ');
    await store.update(ID, { name: 'fat-g tools', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }], providers: ['codex'] }, anyRoot);
    expect(readBack().projects[0]?.['name']).toBe('fat-g tools');
  });

  describe('moves (C68, C74, C75)', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'].map((letter) => `${letter.repeat(8)}-0000-4000-8000-000000000000`);
    const [A, B, C, D, E] = keys as [string, string, string, string, string];
    const five = () => current([
      project({ id: A, name: 'A' }),
      project({ id: B, name: 'B' }),
      project({ id: C, name: 'C', hidden: true }),
      project({ id: D, name: 'D' }),
      project({ id: E, name: 'E', hidden: true }),
    ]);
    const order = (store: RecordsStore) => store.getView().projects.map((entry) => (entry.kind === 'project' ? `${entry.name}${entry.hidden ? '*' : ''}` : '?'));

    it.each([
      ['before another visible project', A, false, D, ['B', 'C*', 'A', 'D', 'E*']],
      ['to the end of the visible group', A, false, null, ['B', 'C*', 'D', 'A', 'E*']],
      ['into the hidden group, before a hidden project', B, true, C, ['A', 'B*', 'C*', 'D', 'E*']],
      ['to the end of the hidden group', A, true, null, ['B', 'C*', 'D', 'E*', 'A*']],
      ['a hidden project among the visible ones', E, false, B, ['A', 'E', 'B', 'C*', 'D']],
      ['a hidden project to the end of the visible group', C, false, null, ['A', 'B', 'D', 'C', 'E*']],
      ['only its group, at its own place', B, true, B, ['A', 'B*', 'C*', 'D', 'E*']],
    ] as const)('moves %s', async (_name, id, hidden, before, expected) => {
      writeDoc(five());
      const store = open();
      expect(await store.move(id, hidden, before)).toEqual({ status: 'saved' });
      expect(order(store)).toEqual(expected);
      expect(order(open())).toEqual(expected);
    });

    it('puts a visible drop first when no project is visible, and a hidden one last when none is hidden', async () => {
      writeDoc(current([project({ id: A, name: 'A', hidden: true }), project({ id: B, name: 'B', hidden: true })]));
      const store = open();
      await store.move(B, false, null);
      expect(order(store)).toEqual(['B', 'A*']);
      writeDoc(current([project({ id: A, name: 'A' }), project({ id: B, name: 'B' })]));
      const other = open();
      await other.move(A, true, null);
      expect(order(other)).toEqual(['B', 'A*']);
    });

    it('refuses a place before an entry that is gone', async () => {
      writeDoc(five());
      expect(await open().move(A, false, OTHER)).toEqual({ status: 'refused', reason: 'unknown-project' });
    });
  });
});

// ── V19 ───────────────────────────────────────────────────────────────────────────────────
// M22, V6 (C25, C40): a project's default mode for each provider, in its entry and nowhere else.
describe('a project’s default modes (M22: V6; C25, C40)', () => {
  it('reads none for an entry that stores none, shows a registered provider’s alone, and keeps every other entry through a write', async () => {
    writeDoc(current([project(), project({ id: OTHER, name: 'website', roots: [{ path: 'D:\\website' }], permissionModes: { codex: 'sandbox-ok', gemini: 'full', claude: 'Not An Id', '': 'ask-first' } })]));
    const store = open();
    expect(store.getProject(ID)?.permissionModes).toEqual({});
    // What is no provider id or no mode id is read as nothing, and the entry stays readable.
    expect(store.getProject(OTHER)?.permissionModes).toEqual({ codex: 'sandbox-ok', gemini: 'full' });
    const shown = store.getView().projects.find((entry) => entry.kind === 'project' && entry.id === OTHER);
    expect(shown).toMatchObject({ permissionModes: { codex: 'sandbox-ok' } });
    // A change names the registered providers' defaults; one this build does not know stays as it was.
    const website = { name: 'website', roots: [{ path: 'D:\\website', trust: 'trusted' as const }], providers: ['codex'] };
    expect(await store.update(OTHER, { ...website, permissionModes: { codex: 'read-only' } }, () => false)).toEqual({ status: 'saved' });
    expect(readBack().projects[1]?.['permissionModes']).toEqual({ codex: 'read-only', gemini: 'full' });
    expect(await store.update(OTHER, { ...website, permissionModes: {} }, () => false)).toEqual({ status: 'saved' });
    expect(readBack().projects[1]?.['permissionModes']).toEqual({ gemini: 'full' });
    // Nothing of a chat is here: no turn, no decision, no grant.
    expect(Object.keys(readBack().projects[1] ?? {}).sort()).toEqual(['color', 'hidden', 'id', 'name', 'permissionModes', 'providers', 'roots']);
  });
});

describe('an entry fat-g cannot read (V19)', () => {
  const bad = { id: 'not-an-id', name: 'broken', future: [1] };
  const doc = () => current([project(), bad, project({ id: OTHER, name: 'website', roots: [{ path: 'D:\\website' }] })]);

  it.each([
    ['not an object', 42],
    ['an id that is not a UUID', project({ id: 'fat-g' })],
    ['an id an earlier entry uses', project({ name: 'twin' })],
    ['an empty name', project({ id: OTHER, name: ' \t ' })],
    ['a name that is not a string', project({ id: OTHER, name: 5 })],
    ['a colour that is not a string', project({ id: OTHER, color: null })],
    ['no root', project({ id: OTHER, roots: [] })],
    ['a relative root', project({ id: OTHER, roots: [{ path: 'Code\\fat-g' }] })],
    ['a root with no path', project({ id: OTHER, roots: [{ trust: null }] })],
    ['a hidden flag that is not a boolean', project({ id: OTHER, hidden: 'no' })],
    ['a provider that is not a string', project({ id: OTHER, providers: [1] })],
  ])('makes %s unreadable, and leaves the others', (_name, entry) => {
    writeDoc(current([project(), entry]));
    const view = open().getView();
    expect(view.projects[0]).toMatchObject({ kind: 'project', id: ID });
    expect(view.projects[1]).toEqual({ kind: 'unreadable', key: expect.any(String) as string, sessions: 0 });
  });

  it.each([
    ['a hide', (store: RecordsStore) => store.setHidden(OTHER, true)],
    ['an edit', (store: RecordsStore) => store.update(ID, { name: 'renamed', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }], providers: ['codex'] }, anyRoot)],
    ['a move past it', (store: RecordsStore) => store.move(ID, false, null)],
    ['an add', (store: RecordsStore) => store.add(input({ roots: [{ path: 'D:\\new', trust: 'trusted' }] }), anyRoot)],
    ['a remove of another', (store: RecordsStore) => store.remove(ID)],
  ])('keeps the bad entry unchanged, at its place, through %s', async (_name, change) => {
    writeDoc(doc());
    const store = open();
    expect(await change(store)).toMatchObject({ status: 'saved' });
    const projects = readBack().projects;
    const at = projects.findIndex((entry) => entry['id'] === 'not-an-id');
    expect(projects[at]).toEqual(bad);
    // Its place among the others: after fat-g (unless fat-g moved or went) and before website.
    expect(projects.findIndex((entry) => entry['id'] === OTHER)).toBeGreaterThan(at);
  });

  it('is removed by its key, which is never written', async () => {
    writeDoc(doc());
    const store = open();
    const entry = store.getView().projects[1];
    expect(entry?.kind).toBe('unreadable');
    expect(await store.remove(entry?.key ?? '')).toEqual({ status: 'saved' });
    expect(readBack().projects.map((item) => item['id'])).toEqual([ID, OTHER]);
    expect(readText()).not.toContain(entry?.key ?? '-');
  });
});

// ── V27 ───────────────────────────────────────────────────────────────────────────────────
describe('trust answers this build does not know (V27)', () => {
  it.each([
    ['no trust', undefined],
    ['null', null],
    ['an unknown answer', { answer: 'maybe', answeredAt: '2026-01-01T00:00:00.000Z' }],
    ['a string', 'trusted'],
  ])('reads %s as not answered, and keeps it until the user answers', async (_name, trust) => {
    const root = trust === undefined ? { path: 'D:\\Code\\fat-g' } : { path: 'D:\\Code\\fat-g', trust };
    writeDoc(current([project({ roots: [root] }), project({ id: OTHER, name: 'website', roots: [{ path: 'D:\\website' }] })]));
    const store = open();
    const [entry] = store.getView().projects;
    expect(entry).toMatchObject({ roots: [{ path: 'D:\\Code\\fat-g', trust: null }] });
    await store.setHidden(ID, true);
    await store.move(OTHER, false, ID);
    expect(readBack().projects[1]?.['roots']).toEqual([root]);
    await store.update(ID, { name: 'fat-g', roots: [{ path: 'D:\\Code\\fat-g', trust: 'trusted' }], providers: ['codex'] }, anyRoot);
    expect(readBack().projects[1]?.['roots']).toEqual([{ ...root, trust: { ...(typeof trust === 'object' && trust !== null ? trust : {}), answer: 'trusted', answeredAt: '2020-01-21T14:03:12.000Z' } }]);
  });
});

// ── V18 (the store's part) ────────────────────────────────────────────────────────────────
describe('Start fresh and Try again (V18)', () => {
  const kept = 'records.set-aside.2020-01-21T14-03-12Z.json';

  it.each([
    ['newer', JSON.stringify({ schemaVersion: NEWER, minReaderVersion: NEWER, projects: [] })],
    ['damaged', '{ broken'],
  ])('moves a %s file aside byte-identical, then starts with no projects and writes nothing', async (cause, contents) => {
    writeText(contents);
    const store = open();
    expect(store.getView().status).toEqual({ kind: 'refused', cause });
    const listener = vi.fn();
    store.subscribe(listener);
    expect(await store.startFresh()).toEqual({ status: 'done', keptAs: path.join(dir, kept) });
    expect(readFileSync(path.join(dir, kept), 'utf8')).toBe(contents);
    expect(readdirSync(dir)).toEqual([kept]);
    expect(store.getView()).toEqual({ status: { kind: 'ok', keptAs: path.join(dir, kept) }, projects: [], sessions: [], orphans: 0 });
    expect(listener).toHaveBeenCalledOnce();
    // The column keeps naming the kept file for the rest of the run (C63).
    await store.add(input(), anyRoot);
    expect(store.getView().status).toEqual({ kind: 'ok', keptAs: path.join(dir, kept) });
    expect(readBack()).toMatchObject({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION });
  });

  it('moves an older file aside too', async () => {
    writeDoc(current([project()]));
    const store = open({ version: NEWER });
    expect(store.getView().status).toEqual({ kind: 'refused', cause: 'older' });
    expect(await store.startFresh()).toMatchObject({ status: 'done' });
  });

  it('keeps the first copy when a second Start fresh lands in the same second', async () => {
    writeFileSync(path.join(dir, kept), 'earlier');
    writeText('{');
    expect(await open().startFresh()).toEqual({ status: 'done', keptAs: path.join(dir, 'records.set-aside.2020-01-21T14-03-12Z-2.json') });
    expect(readFileSync(path.join(dir, kept), 'utf8')).toBe('earlier');
  });

  it('changes nothing when the file cannot be moved', async () => {
    writeText('{');
    const failure = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    const store = open({ setAsideIo: { lstat: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })), rename: () => Promise.reject(failure) } });
    await expect(store.startFresh()).rejects.toBe(failure);
    expect(store.getView().status).toEqual({ kind: 'refused', cause: 'damaged' });
    expect(readText()).toBe('{');
  });

  it('has nothing to start over from when the file was read', async () => {
    expect(await open().startFresh()).toEqual({ status: 'refused', reason: 'not-refused' });
    expect(open().retry()).toEqual({ status: 'refused', reason: 'not-refused' });
  });

  it('loads a file that has become readable on Try again (C67)', () => {
    let locked = true;
    writeDoc(current([project()]));
    const read = (target: string) => {
      if (locked) throw Object.assign(new Error('x'), { code: 'EBUSY' });
      return readFileSync(target, 'utf8');
    };
    const store = open({ readFile: read });
    expect(store.retry()).toEqual({ status: 'refused', reason: 'still-refused' });
    expect(store.getView().status).toEqual({ kind: 'refused', cause: 'unreadable' });
    locked = false;
    expect(store.retry()).toEqual({ status: 'loaded' });
    expect(names(store)).toEqual(['fat-g']);
  });

  it('shows the cause a new read gives', () => {
    let text: string | null = null;
    const store = open({ readFile: () => { if (text === null) throw Object.assign(new Error('x'), { code: 'EBUSY' }); return text; } });
    const listener = vi.fn();
    store.subscribe(listener);
    text = '{';
    expect(store.retry()).toEqual({ status: 'refused', reason: 'still-refused' });
    expect(store.getView().status).toEqual({ kind: 'refused', cause: 'damaged' });
    expect(listener).toHaveBeenCalledOnce();
  });
});

// ── V16's files ───────────────────────────────────────────────────────────────────────────
describe('the visual-review fixtures (tests/fixtures/records, V16)', () => {
  const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, '../../../tests/fixtures/records', name), 'utf8');

  it('hold what the review needs: all eight colours, an unreadable entry, two hidden, an unanswered root', () => {
    writeText(fixture('visual-review.json'));
    const projects = open().getView().projects;
    const readable = projects.filter((entry) => entry.kind === 'project');
    expect(new Set(readable.map((entry) => entry.color))).toEqual(new Set(['red', 'orange', 'green', 'teal', 'blue', 'purple', 'pink', 'grey']));
    expect(projects.filter((entry) => entry.kind === 'unreadable')).toHaveLength(1);
    expect(readable.filter((entry) => entry.hidden)).toHaveLength(2);
    expect(readable.flatMap((entry) => entry.roots).some((root) => root.trust === null)).toBe(true);
  });

  // M14 (Verification, "Manual"): the stored states the review walks through.
  it('hold the sessions the M14 review needs', () => {
    writeText(fixture('visual-review.json'));
    const view = open().getView();
    const project = (name: string) => view.projects.find((entry) => entry.kind === 'project' && entry.name === name);
    const of = (name: string) => view.sessions.filter((session) => session.projectId === (project(name)?.kind === 'project' ? project(name)?.key : ''));
    const main = of('fat-g');
    expect(main.some((session) => session.reference === null && session.name === null)).toBe(true); // not started
    expect(main.some((session) => session.reference !== null && session.lastTurn?.outcome === 'completed' && session.completedAt === null)).toBe(true); // idle
    expect(main.filter((session) => session.lastTurn?.outcome === 'stopped' || (session.lastTurn !== null && session.lastTurn.endedAt === null))).toHaveLength(2); // both stopped forms
    expect(main.some((session) => session.lastTurn?.outcome === 'failed')).toBe(true);
    expect(main.some((session) => session.starred && session.completedAt === null)).toBe(true);
    expect(main.filter((session) => session.completedAt !== null)).toHaveLength(12);
    expect(main.filter((session) => session.completedAt !== null && session.starred)).toHaveLength(2);
    // The shelf: two shelved, one of them starred, and flags on the active ones — the three on one name of sixty characters.
    expect(main.filter((session) => session.shelvedAt !== null).map((session) => [session.starred, session.toDo, session.toVerify])).toEqual([[false, false, true], [true, true, false]]);
    expect(main.some((session) => session.shelvedAt === null && session.completedAt === null && session.starred && session.toDo && session.toVerify && [...(session.name ?? '')].length === 60)).toBe(true);
    expect(main.some((session) => [...(session.name ?? '')].length === 60)).toBe(true);
    expect(main.some((session) => session.providerId === 'gemini')).toBe(true);
    expect(of('old-experiment').length).toBeGreaterThan(0);
    expect(project('old-experiment')).toMatchObject({ hidden: true });
    expect(view.orphans).toBe(2);
    expect(log.info).toHaveBeenCalledWith('[records] loaded 8 projects, 1 unreadable; 30 sessions, 1 unreadable, 2 without a project');
  });

  // M14b (Verification, "Manual"): the sessions the accounts' review walks through.
  it('hold the sessions the M14b review needs: on an added account, on one no longer set up, and with a configuration folder', () => {
    writeText(fixture('visual-review.json'));
    const sessions = open().getView().sessions;
    const added = sessions.filter((session) => session.instanceId !== 'default');
    expect(new Set(added.map((session) => session.instanceId)).size).toBe(2);
    expect(added.some((session) => session.reference === null && session.configFolder === null)).toBe(true);
    expect(added.some((session) => session.reference !== null && session.configFolder !== null)).toBe(true);
    // On the first account, started in a folder that is no CLI's default: it reads as moved.
    expect(sessions.some((session) => session.instanceId === 'default' && session.reference !== null && session.configFolder !== null)).toBe(true);
    // Every other started session stored none, so the review's own accounts hold none of them back.
    expect(sessions.filter((session) => session.configFolder !== null)).toHaveLength(2);
  });

  it.each([['damaged.json', 'damaged'], ['newer.json', 'newer']])('refuse %s as %s', (name, cause) => {
    writeText(fixture(name));
    expect(open().getView().status).toEqual({ kind: 'refused', cause });
  });
});

// ── M14: sessions (docs/planning/_archive/M14.md, V1, V2, V25) ──────────────────────────────────────────
describe('sessions (M14)', () => {
  const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const session = (n: number, overrides: Record<string, unknown> = {}) => ({
    id: S(n),
    projectId: ID,
    providerId: 'codex',
    instanceId: 'default',
    reference: null,
    folder: null,
    configFolder: null,
    model: 'gpt-6-sol',
    effort: 'high',
    speed: null,
    name: null,
    nameSource: null,
    starred: false,
    toDo: false,
    toVerify: false,
    shelvedAt: null,
    completedAt: null,
    createdAt: AT - 5000,
    lastActiveAt: AT - 5000,
    lastTurn: null,
    ...overrides,
  });
  const website = () => project({ id: OTHER, name: 'website', roots: [{ path: 'D:\\website' }] });
  const stored = () => (readBack()['sessions'] as Record<string, unknown>[]);
  const storedIds = () => stored().map((entry) => entry['id']);
  const shown = (store: RecordsStore) => store.getView().sessions.map((entry) => entry.id);
  const preset = { projectId: ID, providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null };

  describe('the file (V1)', () => {
    it('reads a missing sessions as none, and writes it at the next change (C3)', async () => {
      writeDoc(current([project()]));
      const store = open();
      expect(store.getView()).toMatchObject({ sessions: [], orphans: 0 });
      expect(readText()).not.toContain('sessions');
      await store.setHidden(ID, true);
      expect(readBack()['sessions']).toEqual([]);
    });

    it('creates a session with no reference, folder or name, stamped now, and holding only what a record holds (C2, C4, C10, C14)', async () => {
      writeDoc(current([project()]));
      const store = open();
      const answer = await store.createSession(preset);
      const id = '00000000-0000-4000-8000-' + String(ids).padStart(12, '0');
      expect(answer).toEqual({ status: 'saved', id });
      // Exactly the record's fields: no order field, and nothing of a live summary.
      expect(stored()).toEqual([{
        id, projectId: ID, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null,
        name: null, nameSource: null, starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT, lastActiveAt: AT, lastTurn: null,
      }]);
      expect(store.getView().sessions).toEqual([expect.objectContaining({ id, reference: null, folder: null, name: null })]);
      expect(store.getSession(id)).toMatchObject({ projectId: ID, model: 'gpt-6-sol', effort: 'high' });
      expect(open().getView().sessions).toEqual(store.getView().sessions);
    });

    it('stores a null effort for a model with no levels (C7)', async () => {
      writeDoc(current([project()]));
      const store = open();
      await store.createSession({ ...preset, model: 'haiku', effort: null });
      expect(stored()[0]).toMatchObject({ model: 'haiku', effort: null });
    });

    it('stores the speed tier a session is created with, and reads it back (decision 0016)', async () => {
      writeDoc(current([project()]));
      const store = open();
      const answer = await store.createSession({ ...preset, speed: 'priority' });
      expect(stored()[0]).toMatchObject({ model: 'gpt-6-sol', effort: 'high', speed: 'priority' });
      expect(answer.status === 'saved' && open().getSession(answer.id)?.speed).toBe('priority');
    });

    it('sets a draft’s speed tier with the rest of its preset, and keeps it through a restart (decision 0016)', async () => {
      writeDoc(current([project()], { sessions: [session(1)] }));
      const store = open();
      expect(await store.setDraftPreset(S(1), { providerId: 'codex', instanceId: 'default', model: 'gpt-6-luna', effort: 'low', speed: 'priority' })).toEqual({ status: 'saved' });
      expect(stored()[0]).toMatchObject({ model: 'gpt-6-luna', effort: 'low', speed: 'priority' });
      expect(open().getSession(S(1))).toMatchObject({ model: 'gpt-6-luna', effort: 'low', speed: 'priority' });
      expect(await store.setDraftPreset(S(1), { providerId: 'codex', instanceId: 'default', model: 'gpt-6-luna', effort: 'low', speed: null })).toEqual({ status: 'saved' });
      expect(open().getSession(S(1))?.speed).toBeNull();
    });

    it('refuses a session for a project it does not have, or cannot read', async () => {
      writeDoc(current([project(), { id: OTHER, name: 5 }]));
      const store = open();
      expect(await store.createSession({ ...preset, projectId: S(99) })).toEqual({ status: 'refused', reason: 'unknown-project' });
      expect(await store.createSession({ ...preset, projectId: OTHER })).toEqual({ status: 'refused', reason: 'unknown-project' });
      expect(readText()).not.toContain('sessions');
    });

    it('never reuses an id a session or a project entry holds (C4)', async () => {
      writeDoc(current([project()], { sessions: [session(1)] }));
      const sequence = [ID, S(1), S(2)];
      let next = 0;
      const store = open({ newId: () => sequence[next++] ?? 'x' });
      expect(await store.createSession(preset)).toEqual({ status: 'saved', id: S(2) });
    });

    it('logs counts only (C66)', () => {
      writeDoc(current([project({ name: 'Someone Private' })], {
        sessions: [session(1, { name: 'Private plan', nameSource: 'user', folder: 'D:\\Private', reference: 'ref-private' }), 42, session(2, { projectId: OTHER })],
      }));
      open();
      expect(log.info).toHaveBeenCalledWith('[records] loaded 1 project, 0 unreadable; 2 sessions, 1 unreadable, 2 without a project');
      expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toMatch(/Private|private/);
    });

    it('makes an entry repeating an earlier session id unreadable', () => {
      writeDoc(current([project()], { sessions: [session(1), session(1, { model: 'twin' })] }));
      expect(open().getView().sessions.map((entry) => entry.model)).toEqual(['gpt-6-sol']);
    });
  });

  describe('entries fat-g cannot show (V1; C3, C13, C107)', () => {
    const broken = { id: 'not-an-id', projectId: ID, name: 'broken', future: [1] };
    const orphan = session(7, { projectId: S(77) });
    const underUnreadable = session(8, { projectId: OTHER });
    const unreadableProject = { id: OTHER, name: 5, color: 'teal' };
    const doc = () => current([project(), unreadableProject], { sessions: [session(1), broken, session(2), orphan, underUnreadable, 'a string'] });

    it('shows only the readable sessions of readable projects, and counts the rest', () => {
      writeDoc(doc());
      const view = open().getView();
      expect(view.sessions.map((entry) => entry.id)).toEqual([S(1), S(2)]);
      // The orphan, and the entry that is not even an object; the broken one names a project that exists.
      expect(view.orphans).toBe(2);
      expect(view.projects.map((entry) => entry.sessions)).toEqual([3, 1]);
      expect(log.info).toHaveBeenCalledWith('[records] loaded 1 project, 1 unreadable; 4 sessions, 2 unreadable, 2 without a project');
    });

    it.each([
      ['a new session', (store: RecordsStore) => store.createSession(preset)],
      ['a star', (store: RecordsStore) => store.changeSession(S(1), () => ({ starred: true }))],
      ['a move', (store: RecordsStore) => store.moveSession(S(1), null, { list: 'active', starred: false })],
      ['the removal of another session', (store: RecordsStore) => store.removeSession(S(1))],
      ['a project being hidden', (store: RecordsStore) => store.setHidden(ID, true)],
      ['several changes at once', (store: RecordsStore) => store.changeSessions(new Map<string, SessionRecipe>([[S(1), () => ({ starred: true })], [S(2), () => ({ completedAt: AT })]]))],
    ])('keeps each at its place and value through %s', async (_name, change) => {
      writeDoc(doc());
      const store = open();
      expect(await change(store)).toMatchObject({ status: 'saved' });
      const kept = stored().filter((entry) => typeof entry !== 'object' || ![S(1), S(2)].includes(entry['id'] as string) && !String(entry['id']).startsWith('00000000'));
      expect(kept).toEqual([broken, orphan, underUnreadable, 'a string']);
      // Still between the two sessions around it, when both are still there.
      const at = stored().findIndex((entry) => entry['id'] === 'not-an-id');
      if (storedIds().includes(S(1)) && storedIds().indexOf(S(1)) < at) expect(storedIds().indexOf(S(2))).toBeGreaterThan(at);
    });

    it('keeps the fields this build does not know in a session, through a change (C11)', async () => {
      writeDoc(current([project()], { sessions: [session(1, { futureField: { keep: true }, lastTurn: { turnId: 'turn-0', startedAt: AT - 100, endedAt: null, outcome: null, tokens: 12 } })] }));
      const store = open();
      await store.changeSession(S(1), (record) => ({ starred: true, lastTurn: { turnId: 'turn-0', startedAt: record.lastTurn?.startedAt ?? 0, endedAt: AT, outcome: 'completed' } }));
      expect(stored()[0]).toMatchObject({ starred: true, futureField: { keep: true }, lastTurn: { turnId: 'turn-0', startedAt: AT - 100, endedAt: AT, outcome: 'completed', tokens: 12 } });
    });
  });

  describe('removal (V1; C13, C36, C107)', () => {
    it('takes with a project, in one write, every session entry storing its id — unreadable ones too', async () => {
      const unreadable = { id: 'nope', projectId: ID };
      writeDoc(current([project(), website()], { sessions: [session(1), unreadable, session(2, { projectId: OTHER }), session(3)] }));
      const write = vi.fn((target: string, data: string) => writeFileAtomic(target, data));
      const store = open({ write });
      expect(store.getView().projects.map((entry) => entry.sessions)).toEqual([3, 1]);
      expect(await store.remove(ID)).toEqual({ status: 'saved' });
      expect(write).toHaveBeenCalledOnce();
      expect(storedIds()).toEqual([S(2)]);
      expect(shown(store)).toEqual([S(2)]);
    });

    it('takes with an unreadable project’s row the sessions storing that entry’s id', async () => {
      const unreadableProject = { id: OTHER, name: 5 };
      writeDoc(current([project(), unreadableProject], { sessions: [session(1), session(2, { projectId: OTHER }), { id: 'x', projectId: OTHER }] }));
      const store = open();
      const row = store.getView().projects[1];
      expect(row).toMatchObject({ kind: 'unreadable', sessions: 2 });
      expect(await store.remove(row?.key ?? '')).toEqual({ status: 'saved' });
      expect(storedIds()).toEqual([S(1)]);
    });

    it('takes none when another project entry stores the same id: the twin’s sessions stay', async () => {
      writeDoc(current([project(), project({ name: 'twin' })], { sessions: [session(1), session(2)] }));
      const store = open();
      const [first, twin] = store.getView().projects;
      expect([first?.sessions, twin?.sessions]).toEqual([0, 0]);
      expect(await store.remove(twin?.key ?? '')).toEqual({ status: 'saved' });
      expect(storedIds()).toEqual([S(1), S(2)]);
      // The same for the readable one of the pair.
      writeDoc(current([project(), project({ name: 'twin' })], { sessions: [session(1), session(2)] }));
      const again = open();
      expect(await again.remove(ID)).toEqual({ status: 'saved' });
      expect(storedIds()).toEqual([S(1), S(2)]);
    });

    it('takes none with an entry that stores no id', async () => {
      writeDoc(current([project(), 42], { sessions: [session(1)] }));
      const store = open();
      expect(await store.remove(store.getView().projects[1]?.key ?? '')).toEqual({ status: 'saved' });
      expect(storedIds()).toEqual([S(1)]);
    });

    it('removes one session, and refuses an id it does not have (C36)', async () => {
      writeDoc(current([project()], { sessions: [session(1), session(2)] }));
      const store = open();
      expect(await store.removeSession(S(1))).toEqual({ status: 'saved' });
      expect(await store.removeSession(S(1))).toEqual({ status: 'refused', reason: 'unknown-session' });
      expect(storedIds()).toEqual([S(2)]);
    });

    it('removes exactly the entries without a project, in one write (C107)', async () => {
      const unreadableProject = { id: OTHER, name: 5 };
      const orphans = [session(5, { projectId: S(77) }), { id: 'x', projectId: 'not-a-uuid' }, 'text'];
      writeDoc(current([project(), unreadableProject], { sessions: [session(1), orphans[0], session(2, { projectId: OTHER }), orphans[1], { id: 'y', projectId: ID }, orphans[2]] }));
      const write = vi.fn((target: string, data: string) => writeFileAtomic(target, data));
      const store = open({ write });
      expect(store.getView().orphans).toBe(3);
      expect(await store.removeOrphans()).toEqual({ status: 'saved' });
      expect(write).toHaveBeenCalledOnce();
      expect(storedIds()).toEqual([S(1), S(2), 'y']);
      expect(store.getView().orphans).toBe(0);
      // With none left, nothing is written.
      expect(await store.removeOrphans()).toEqual({ status: 'saved' });
      expect(write).toHaveBeenCalledOnce();
    });
  });

  describe('changes (V1, V2; C5–C10, C12)', () => {
    it.each([
      ['a star', { starred: true }],
      ['a flag', { toVerify: true }],
      ['a shelving, stored as its time', { shelvedAt: AT }],
      ['a completion, stored as its time', { completedAt: AT }],
      ['a completion off the shelf, its flags but the star cleared', { completedAt: AT, shelvedAt: null, toDo: false, toVerify: false }],
      ['an effort', { effort: 'medium' }],
      ['a speed tier (decision 0016)', { speed: 'priority' }],
      ['a name with its source', { name: 'Create plan', nameSource: 'user' as const }],
      ['a reference with its folder', { reference: '019f2c1a-7b3e', folder: 'D:\\Code\\fat-g' }],
      ['a reference with its folder and its configuration folder (M14b, C61)', { reference: '019f2c1a-7b3e', folder: 'D:\\Code\\fat-g', configFolder: 'D:\\accounts\\work' }],
      ['a turn’s start', { lastTurn: { turnId: 'turn-0', startedAt: AT, endedAt: null, outcome: null }, lastActiveAt: AT, completedAt: null }],
      ['a turn’s end', { lastTurn: { turnId: 'turn-0', startedAt: AT - 60_000, endedAt: AT, outcome: 'completed' as const }, lastActiveAt: AT }],
    ])('writes %s once, and reads it back', async (_name, change) => {
      writeDoc(current([project()], { sessions: [session(1)] }));
      const write = vi.fn((target: string, data: string) => writeFileAtomic(target, data));
      const store = open({ write });
      expect(await store.changeSession(S(1), () => change)).toEqual({ status: 'saved' });
      expect(write).toHaveBeenCalledOnce();
      expect(stored()[0]).toMatchObject(change);
      expect(open().getSession(S(1))).toMatchObject(change);
      // The same again changes nothing, and writes nothing.
      expect(await store.changeSession(S(1), () => change)).toEqual({ status: 'saved' });
      expect(write).toHaveBeenCalledOnce();
    });

    it('writes nothing when the recipe changes nothing, and refuses an unknown session', async () => {
      writeDoc(current([project()], { sessions: [session(1)] }));
      const write = vi.fn(() => Promise.resolve());
      const store = open({ write });
      expect(await store.changeSession(S(1), () => null)).toEqual({ status: 'saved' });
      expect(await store.changeSession(S(9), () => ({ starred: true }))).toEqual({ status: 'refused', reason: 'unknown-session' });
      expect(write).not.toHaveBeenCalled();
    });

    it('hands the recipe the record as the queue has it: two changes sent together see each other', async () => {
      writeDoc(current([project()], { sessions: [session(1)] }));
      const store = open();
      const seen: (string | null)[] = [];
      await Promise.all([
        store.changeSession(S(1), (record) => { seen.push(record.reference); return { reference: 'first', folder: 'D:\\one' }; }),
        store.changeSession(S(1), (record) => { seen.push(record.reference); return record.reference === null ? { reference: 'second', folder: 'D:\\two' } : null; }),
      ]);
      expect(seen).toEqual([null, 'first']);
      expect(stored()[0]).toMatchObject({ reference: 'first', folder: 'D:\\one' });
    });

    // M14b, V9 (C26, C61): what a session is, and where its account's folder was, never change.
    it('drops the instance, and every other field a session keeps for good, from a change', async () => {
      writeDoc(current([project()], { sessions: [session(1)] }));
      const write = vi.fn((target: string, data: string) => writeFileAtomic(target, data));
      const store = open({ write });
      // The model too: it is fixed when the session is created (M14b, C55).
      const fixed = { id: S(9), projectId: OTHER, providerId: 'claude', instanceId: '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19', model: 'gpt-5.6-sol', createdAt: 1 };
      expect(await store.changeSession(S(1), () => fixed as never)).toEqual({ status: 'saved' });
      expect(write).not.toHaveBeenCalled();
      expect(await store.changeSession(S(1), () => ({ ...fixed, starred: true }))).toEqual({ status: 'saved' });
      expect(stored()[0]).toEqual(session(1, { starred: true }));
    });

    it('stores the configuration folder with the reference in one write, and never again', async () => {
      writeDoc(current([project()], { sessions: [session(1)] }));
      const write = vi.fn((target: string, data: string) => writeFileAtomic(target, data));
      const store = open({ write });
      await store.changeSession(S(1), () => ({ reference: 'ref', folder: 'D:\\Code\\fat-g', configFolder: 'D:\\accounts\\work' }));
      expect(write).toHaveBeenCalledOnce();
      expect(stored()[0]).toMatchObject({ reference: 'ref', folder: 'D:\\Code\\fat-g', configFolder: 'D:\\accounts\\work' });
      // A later change that names another folder leaves it, and writes nothing for it.
      expect(await store.changeSession(S(1), () => ({ configFolder: 'D:\\accounts\\other' }))).toEqual({ status: 'saved' });
      expect(await store.changeSession(S(1), () => ({ configFolder: null }))).toEqual({ status: 'saved' });
      expect(write).toHaveBeenCalledOnce();
      expect(store.getSession(S(1))?.configFolder).toBe('D:\\accounts\\work');
    });

    it('changes several sessions in one write, passing over an id it does not have (C75)', async () => {
      writeDoc(current([project()], { sessions: [session(1), session(2)] }));
      const write = vi.fn((target: string, data: string) => writeFileAtomic(target, data));
      const store = open({ write });
      const end = (): { lastTurn: { turnId: 'turn-0', startedAt: number; endedAt: number; outcome: 'stopped' } } => ({ lastTurn: { turnId: 'turn-0', startedAt: AT - 10, endedAt: AT, outcome: 'stopped' } });
      expect(await store.changeSessions(new Map([[S(1), end], [S(9), end], [S(2), end]]))).toEqual({ status: 'saved' });
      expect(write).toHaveBeenCalledOnce();
      expect(stored().map((entry) => (entry['lastTurn'] as { outcome: string }).outcome)).toEqual(['stopped', 'stopped']);
    });

    it('shows a stored name normalized, and keeps the stored one until a change names it (C8)', async () => {
      writeDoc(current([project()], { sessions: [session(1, { name: '  Create \t plan ', nameSource: 'provider' })] }));
      const store = open();
      expect(store.getSession(S(1))).toMatchObject({ name: 'Create plan', nameSource: 'provider' });
      await store.changeSession(S(1), () => ({ starred: true }));
      expect(stored()[0]?.['name']).toBe('  Create \t plan ');
    });

    it('keeps a session’s folder after that root leaves its project (C6)', async () => {
      writeDoc(current([project()], { sessions: [session(1, { reference: 'ref', folder: 'D:\\Code\\fat-g' })] }));
      const store = open();
      await store.update(ID, { name: 'fat-g', roots: [{ path: 'D:\\elsewhere', trust: 'trusted' }], providers: ['codex'] }, anyRoot);
      expect(store.getSession(S(1))).toMatchObject({ reference: 'ref', folder: 'D:\\Code\\fat-g' });
      expect(stored()[0]).toMatchObject({ folder: 'D:\\Code\\fat-g' });
    });

    it('rejects, changing nothing, when the write fails', async () => {
      writeDoc(current([project()], { sessions: [session(1)] }));
      const before = readText();
      const failure = Object.assign(new Error('EPERM'), { code: 'EPERM' });
      const store = open({ write: () => Promise.reject(failure) });
      await expect(store.changeSession(S(1), () => ({ starred: true }))).rejects.toBe(failure);
      expect(store.getSession(S(1))?.starred).toBe(false);
      expect(readText()).toBe(before);
    });
  });

  describe('order and moves (V25; C11, C55)', () => {
    it('naturally displaces a manual placement as other sessions are used, retaining timestamps and unknown fields', async () => {
      writeDoc(current([project()], { sessions: [1, 2, 3, 4, 5].map((n) => session(n, { futureField: { n } })) }));
      const store = open();
      const group = { list: 'active', starred: false } as const;
      await store.moveSession(S(5), S(2), group);
      expect(storedIds()).toEqual([1, 5, 2, 3, 4].map(S));
      await store.promoteSession(S(3));
      await store.promoteSession(S(2));
      expect(shown(open())).toEqual([2, 3, 1, 5, 4].map(S));
      expect(store.getSession(S(5))).toMatchObject({ lastActiveAt: AT - 5000 });
      expect(stored().find((entry) => entry['id'] === S(5))?.['futureField']).toEqual({ n: 5 });
    });

    it.each(['active', 'shelf', 'completed'] as const)('moves and promotes independently in both star groups of %s', async (list) => {
      const state = { shelvedAt: list === 'shelf' ? AT : null, completedAt: list === 'completed' ? AT : null };
      writeDoc(current([project(), website()], { sessions: [session(1, state), session(2, { ...state, starred: true }), session(9, { ...state, projectId: OTHER }), session(3, state), session(4, { ...state, starred: true }), session(5, state)] }));
      const store = open();
      await store.moveSession(S(5), S(1), { list, starred: false });
      await store.promoteSession(S(4));
      expect(storedIds()).toEqual([5, 1, 4, 2, 9, 3].map(S));
      expect(shown(open())).toEqual(storedIds());
      expect(await store.moveSession(S(5), null, { list, starred: true })).toEqual({ status: 'refused', reason: 'outside-group' });
    });

    it('places lifecycle entries first atomically, preserves star-only positions, and writes no-op promotions nowhere', async () => {
      writeDoc(current([project()], { sessions: [session(1, { shelvedAt: AT }), session(2), session(3, { completedAt: AT }), session(4)] }));
      const write = vi.fn((target: string, data: string) => writeFileAtomic(target, data));
      const store = open({ write });
      await store.changeSession(S(4), () => ({ shelvedAt: AT + 1 }));
      expect(storedIds()).toEqual([4, 1, 2, 3].map(S));
      expect(write).toHaveBeenCalledOnce();
      await store.changeSession(S(3), () => ({ completedAt: null }));
      expect(storedIds()).toEqual([4, 1, 3, 2].map(S));
      await store.changeSession(S(2), () => ({ starred: true }));
      expect(storedIds()).toEqual([4, 1, 3, 2].map(S));
      write.mockClear();
      await store.promoteSession(S(4));
      expect(write).not.toHaveBeenCalled();
    });

    it('rolls back a failed promotion or lifecycle placement in memory and on disk', async () => {
      writeDoc(current([project()], { sessions: [session(1), session(2), session(3, { completedAt: AT })] }));
      const before = readText();
      const store = open({ write: () => Promise.reject(new Error('disk unavailable')) });
      await expect(store.promoteSession(S(2))).rejects.toThrow();
      await expect(store.changeSession(S(2), () => ({ completedAt: AT + 1 }))).rejects.toThrow();
      expect(readText()).toBe(before);
      expect(shown(store)).toEqual([1, 2, 3].map(S));
      expect(store.getSession(S(2))?.completedAt).toBeNull();
    });
    const five = () => current([project(), website()], {
      sessions: [session(1), session(2, { starred: true }), session(3), session(9, { projectId: OTHER }), session(4, { starred: true }), session(5, { completedAt: AT - 10 }), session(6)],
    });

    it('puts a new session before its project’s others, and one for a project with none at the end', async () => {
      writeDoc(current([project(), website()], { sessions: [session(9, { projectId: OTHER }), session(1), session(2)] }));
      const store = open();
      const first = await store.createSession(preset);
      const id = first.status === 'saved' ? first.id : '';
      expect(storedIds()).toEqual([S(9), id, S(1), S(2)]);
      writeDoc(current([project(), website()], { sessions: [session(1)] }));
      const other = open();
      const added = await other.createSession({ ...preset, projectId: OTHER });
      expect(storedIds()).toEqual([S(1), added.status === 'saved' ? added.id : '']);
    });

    it.each([
      ['before another of its group', 6, 1, [S(6), S(1), S(2), S(3), S(9), S(4), S(5)]],
      ['to the end of its group', 1, null, [S(2), S(3), S(9), S(4), S(5), S(6), S(1)]],
      ['a starred one before the other starred one', 4, 2, [S(1), S(4), S(2), S(3), S(9), S(5), S(6)]],
      ['a starred one to the end of the starred', 2, null, [S(1), S(3), S(9), S(4), S(2), S(5), S(6)]],
    ] as const)('moves %s in one write, and the order survives a reload', async (_name, id, before, expected) => {
      writeDoc(five());
      const write = vi.fn((target: string, data: string) => writeFileAtomic(target, data));
      const store = open({ write });
      expect(await store.moveSession(S(id), before === null ? null : S(before), { list: 'active', starred: id === 2 || id === 4 })).toEqual({ status: 'saved' });
      expect(write).toHaveBeenCalledOnce();
      expect(storedIds()).toEqual(expected);
      expect(shown(open())).toEqual(expected);
      // No order field: the order is the order of the entries.
      for (const entry of stored()) expect(Object.keys(entry)).not.toEqual(expect.arrayContaining(['order']));
    });

    it('refuses a stale active-group move of a shelved session, or a move across lists', async () => {
      writeDoc(current([project()], { sessions: [session(1), session(2, { shelvedAt: AT - 10 }), session(3)] }));
      const before0 = readText();
      const store = open();
      expect(await store.moveSession(S(2), null, { list: 'active', starred: false })).toEqual({ status: 'refused', reason: 'outside-group' });
      expect(await store.moveSession(S(1), S(2), { list: 'active', starred: false })).toEqual({ status: 'refused', reason: 'outside-group' });
      expect(readText()).toBe(before0);
      // The group's end is after its last active session, wherever a shelved one stands.
      expect(await store.moveSession(S(1), null, { list: 'active', starred: false })).toEqual({ status: 'saved' });
      expect(storedIds()).toEqual([S(2), S(3), S(1)]);
    });

    it('writes nothing for a move to where it already is', async () => {
      writeDoc(five());
      const write = vi.fn(() => Promise.resolve());
      const store = open({ write });
      expect(await store.moveSession(S(1), S(1), { list: 'active', starred: false })).toEqual({ status: 'saved' });
      expect(await store.moveSession(S(6), null, { list: 'active', starred: false })).toEqual({ status: 'saved' });
      expect(await store.moveSession(S(9), null, { list: 'active', starred: false })).toEqual({ status: 'saved' });
      expect(write).not.toHaveBeenCalled();
    });

    it.each([
      ['a place in another project', 1, 9, 'outside-group'],
      ['a place in the other group', 1, 2, 'outside-group'],
      ['a place before a completed session', 1, 5, 'outside-group'],
      ['a completed session', 5, null, 'outside-group'],
      ['a place before a session that is gone', 1, 99, 'unknown-session'],
      ['a session that is gone', 99, null, 'unknown-session'],
    ] as const)('refuses %s', async (_name, id, before, reason) => {
      writeDoc(five());
      const before0 = readText();
      expect(await open().moveSession(S(id), before === null ? null : S(before), { list: 'active', starred: false })).toEqual({ status: 'refused', reason });
      expect(readText()).toBe(before0);
    });
  });

  it('refuses every session change while the file is refused', async () => {
    writeText('{');
    const store = open();
    const refused = { status: 'refused', reason: 'records-refused' };
    expect(await store.createSession(preset)).toEqual(refused);
    expect(await store.changeSession(S(1), () => ({ starred: true }))).toEqual(refused);
    expect(await store.changeSessions(new Map())).toEqual(refused);
    expect(await store.moveSession(S(1), null, { list: 'active', starred: false })).toEqual(refused);
    expect(await store.removeSession(S(1))).toEqual(refused);
    expect(await store.removeOrphans()).toEqual(refused);
    expect(store.getSession(S(1))).toBeUndefined();
    expect(readText()).toBe('{');
  });
});
