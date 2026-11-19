// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M14b, V5 and V23 (C10, C12, C13, C16–C18, C66): a provider's instances in preferences.json — the
// first one's label, the added ones read each by itself, their admission, and add, remove, rename
// and switch on the retained document.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_INSTANCE_ID, MAX_INSTANCES, type InstanceIssue } from '@shared/contracts/instances';
import { defaultPreferences } from '@shared/contracts/prefs';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from './store';

let dir: string;
let file: string;
let store: PreferencesStore | undefined;
const log = { warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-prefs-instances-'));
  file = path.join(dir, PREFERENCES_FILE);
});
afterEach(() => {
  store?.dispose();
  store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const A = uuid(1);
const B = uuid(2);
const work = (extra: Record<string, unknown> = {}) => ({ id: A, label: 'Work', folder: 'D:\\accounts\\work', enabled: true, ...extra });
const side = (extra: Record<string, unknown> = {}) => ({ id: B, label: 'Side', folder: 'D:\\accounts\\side', enabled: true, ...extra });

/** A version-4 file whose `codex` entry is `entry`. */
const place = (entry: unknown, extra: Record<string, unknown> = {}): void =>
  writeFileSync(file, JSON.stringify({ ...defaultPreferences(), providers: { codex: entry }, ...extra }), 'utf8');
const open = (options: Partial<Parameters<typeof createPreferencesStore>[0]> = {}): PreferencesStore => {
  let made = 100;
  store = createPreferencesStore({ dir, providerIds: ['codex', 'claude'], log, platform: 'win32', writeDelayMs: 10_000, newId: () => uuid(made += 1), ...options });
  return store;
};
const stored = (): Record<string, unknown> => {
  store?.flushSync();
  return ((JSON.parse(readFileSync(file, 'utf8')) as { providers: Record<string, Record<string, unknown>> }).providers['codex']) ?? {};
};
const codex = (prefs: PreferencesStore) => prefs.getSnapshot().instances['codex'];
const admission = (prefs: PreferencesStore, instanceId: string) => prefs.getInstanceAdmission({ providerId: 'codex', instanceId });
const controls = { enabled: true, executablePath: null, permissionMode: null };

describe('reading a provider’s instances (C12, C13)', () => {
  it('reads the first instance’s label and each added instance, and admits them', () => {
    place({ enabled: true, executablePath: null, label: 'Personal', instances: [work(), side({ enabled: false })] });
    const prefs = open();
    expect(prefs.getSnapshot().status).toEqual({ kind: 'ok' });
    expect(codex(prefs)).toEqual({
      firstLabel: 'Personal',
      added: [
        { key: A, id: A, label: 'Work', folder: 'D:\\accounts\\work', enabled: true, issue: null },
        { key: B, id: B, label: 'Side', folder: 'D:\\accounts\\side', enabled: false, issue: null },
      ],
    });
    // The first instance is admitted as its provider is, and names no folder (C4).
    expect(admission(prefs, FIRST_INSTANCE_ID)).toEqual({ kind: 'enabled', preferences: controls, folder: null });
    expect(admission(prefs, A)).toEqual({ kind: 'enabled', preferences: controls, folder: 'D:\\accounts\\work' });
    expect(admission(prefs, B)).toEqual({ kind: 'disabled', preferences: controls, folder: 'D:\\accounts\\side' });
    // An id's letter case does not make another instance.
    expect(admission(prefs, A.toUpperCase()).kind).toBe('enabled');
    // The provider's own controls and their projection are as before M14b.
    expect(prefs.getProviderAdmission('codex')).toEqual({ kind: 'enabled', preferences: controls });
    expect(prefs.getSnapshot().values.providers).toEqual({ codex: controls, claude: controls });
    expect(prefs.getSnapshot().providerIssues).toEqual({});
  });

  it('gives a provider with nothing stored one instance, with no label', () => {
    const prefs = open();
    expect(prefs.getSnapshot().instances).toEqual({ codex: { firstLabel: null, added: [] }, claude: { firstLabel: null, added: [] } });
    expect(admission(prefs, FIRST_INSTANCE_ID)).toEqual({ kind: 'enabled', preferences: controls, folder: null });
    expect(admission(prefs, A)).toEqual({ kind: 'blocked', reason: 'not-configured' });
  });

  it.each([
    ['surrounding and repeated spaces', '  My   work  ', 'My work'],
    ['a line break and a control character', 'Work\n\u0007account', 'Work account'],
    ['more than 24 characters', 'An account with a long name', 'An account with a long …'],
    ['24 characters exactly', 'x'.repeat(24), 'x'.repeat(24)],
  ])('cleans a label of %s as a name is, at 24 characters', (_name, written, shown) => {
    place({ label: written, instances: [work()] });
    const prefs = open();
    expect(codex(prefs)?.firstLabel).toBe(shown);
    expect([...new Intl.Segmenter().segment(codex(prefs)?.firstLabel ?? '')].length).toBeLessThanOrEqual(24);
  });

  it.each([['absent', undefined], ['not text', 7], ['empty once cleaned', ' \n '], ['null', null]])('reads a first label that is %s as none, and changes nothing in the file', (_name, label) => {
    place({ ...(label === undefined ? {} : { label }), instances: [work()] });
    const prefs = open();
    expect(codex(prefs)?.firstLabel).toBeNull();
    expect(prefs.getSnapshot().providerIssues).toEqual({});
    prefs.patch({ privacy: { maskEmail: false } });
    expect(stored()['label']).toEqual(label);
  });

  it('judges a folder by the platform’s own rules', () => {
    place({ instances: [work({ folder: '/accounts/work' }), side({ folder: 'D:\\accounts\\side' })] });
    expect(codex(open({ platform: 'linux' }))?.added.map((entry) => entry.issue)).toEqual([null, 'invalid-folder']);
    store?.dispose();
    expect(codex(open({ platform: 'win32' }))?.added.map((entry) => entry.issue)).toEqual(['invalid-folder', null]);
  });

  it('projects no instance of a provider that is not registered, and keeps it in the file', () => {
    writeFileSync(file, JSON.stringify({ ...defaultPreferences(), providers: { gemini: { label: 'Mine', instances: [work()] } } }), 'utf8');
    const prefs = open();
    expect(JSON.stringify(prefs.getSnapshot())).not.toContain('accounts');
    expect(prefs.getInstanceAdmission({ providerId: 'gemini', instanceId: A })).toEqual({ kind: 'blocked', reason: 'invalid-preferences' });
    prefs.patch({ privacy: { maskEmail: false } });
    prefs.flushSync();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ providers: { gemini: { label: 'Mine', instances: [work()] } } });
  });
});

describe('an instance fat-g cannot use is blocked alone (C16, C66)', () => {
  const cases: [string, InstanceIssue, unknown, boolean][] = [
    // name, the issue, the stored entry, whether its id is usable
    ['is not an object', 'invalid-entry', 'D:\\accounts\\work', false],
    ['is null', 'invalid-entry', null, false],
    ['is a list', 'invalid-entry', [], false],
    ['has no id', 'invalid-id', { label: 'Work', folder: 'D:\\accounts\\work', enabled: true }, false],
    ['has an id that is no UUID', 'invalid-id', work({ id: 'work' }), false],
    ['claims the first instance’s id', 'invalid-id', work({ id: FIRST_INSTANCE_ID }), false],
    ['repeats an earlier id', 'duplicate-id', work({ id: B, label: 'Work' }), false],
    ['repeats an earlier id in another letter case', 'duplicate-id', work({ id: B.toUpperCase(), label: 'Work' }), false],
    ['has no label', 'invalid-label', { id: A, folder: 'D:\\accounts\\work', enabled: true }, true],
    ['has a label that is empty once cleaned', 'invalid-label', work({ label: ' \t ' }), true],
    ['has a label that is not text', 'invalid-label', work({ label: 7 }), true],
    ['has an earlier instance’s label', 'label-taken', work({ label: 'side' }), true],
    ['has the first instance’s shown label', 'label-taken', work({ label: 'DEFAULT' }), true],
    ['has a relative folder', 'invalid-folder', work({ folder: 'accounts\\work' }), true],
    ['has a drive-relative folder', 'invalid-folder', work({ folder: 'D:accounts' }), true],
    ['has no folder', 'invalid-folder', { id: A, label: 'Work', enabled: true }, true],
    ['has a folder that is not text', 'invalid-folder', work({ folder: 3 }), true],
    ['has a switch that is not a boolean', 'invalid-enabled', work({ enabled: 'yes' }), true],
    ['has no switch', 'invalid-enabled', { id: A, label: 'Work', folder: 'D:\\accounts\\work' }, true],
  ];

  it.each(cases)('an entry that %s reads as %s, keeps its place and its value, and leaves the others running', (_name, issue, entry, usableId) => {
    const before = [side(), entry];
    place({ enabled: true, executablePath: null, instances: before });
    const prefs = open();
    const [good, bad] = codex(prefs)?.added ?? [];
    expect(good).toEqual({ key: B, id: B, label: 'Side', folder: 'D:\\accounts\\side', enabled: true, issue: null });
    expect(bad?.issue).toBe(issue);
    expect(bad?.id).toBe(usableId ? A : null);
    // The others run: the earlier instance, the first instance and the provider.
    expect(admission(prefs, B).kind).toBe('enabled');
    expect(admission(prefs, FIRST_INSTANCE_ID).kind).toBe('enabled');
    expect(prefs.getProviderAdmission('codex').kind).toBe('enabled');
    expect(prefs.getSnapshot().providerIssues).toEqual({});
    if (usableId) expect(admission(prefs, A)).toEqual({ kind: 'blocked', reason: 'invalid-instance', issue });
    // Through an unrelated write and a change to its neighbour, it is still there, as it was.
    prefs.patch({ privacy: { maskEmail: false }, providers: { codex: { instances: { [B]: { enabled: false } } } } });
    expect(stored()['instances']).toEqual([side({ enabled: false }), entry]);
  });

  it('shows nothing of an unusable entry that is not a label or an absolute folder', () => {
    place({ instances: [{ id: 'secret-id', label: 7, folder: 'relative\\secret', enabled: 'secret' }] });
    const prefs = open();
    const [entry] = codex(prefs)?.added ?? [];
    expect(entry).toMatchObject({ id: null, label: null, folder: null, enabled: false, issue: 'invalid-id' });
    expect(JSON.stringify(prefs.getSnapshot())).not.toContain('secret');
  });

  it('blocks the entries past the cap, each alone, and the seven before them run', () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({ id: uuid(index + 1), label: `Account ${index + 1}`, folder: `D:\\accounts\\${index + 1}`, enabled: true }));
    place({ instances: entries });
    const prefs = open();
    expect(codex(prefs)?.added.map((entry) => entry.issue)).toEqual([null, null, null, null, null, null, null, 'over-limit', 'over-limit']);
    expect(MAX_INSTANCES).toBe(8);
    expect(admission(prefs, uuid(7)).kind).toBe('enabled');
    expect(admission(prefs, uuid(8))).toEqual({ kind: 'blocked', reason: 'invalid-instance', issue: 'over-limit' });
    // Removing one before it brings the eighth entry inside the cap.
    expect(prefs.removeInstance('codex', uuid(1))).toEqual({ status: 'removed' });
    expect(codex(prefs)?.added.map((entry) => entry.issue)).toEqual([null, null, null, null, null, null, null, 'over-limit']);
    expect(admission(prefs, uuid(8)).kind).toBe('enabled');
  });

  it('removes an unusable entry by a key made for the run, which it keeps through other changes (C66)', () => {
    const twin = { label: 'No id', folder: 'D:\\accounts\\a', enabled: true };
    place({ instances: [twin, side(), twin, 'not an entry', work({ id: B, label: 'Work' })] });
    const prefs = open();
    const keys = codex(prefs)?.added.map((entry) => entry.key) ?? [];
    expect(new Set(keys).size).toBe(5);
    expect(keys[1]).toBe(B);
    for (const key of [keys[0], keys[2], keys[3], keys[4]]) expect(key).toMatch(/^[0-9a-f]{8}-0000-4000-8000-0{12}$/);
    // A key is never written, and an unrelated change, a rename and a removal leave the others' keys alone.
    prefs.patch({ privacy: { maskEmail: false }, providers: { codex: { instances: { [B]: { label: 'Renamed' } } } } });
    expect(codex(prefs)?.added.map((entry) => entry.key)).toEqual(keys);
    expect(JSON.stringify(stored())).not.toContain(keys[0]);
    expect(prefs.removeInstance('codex', keys[3] ?? '')).toEqual({ status: 'removed' });
    expect(codex(prefs)?.added.map((entry) => entry.key)).toEqual([keys[0], keys[1], keys[2], keys[4]]);
    // The second of two identical entries goes, by its own key, and the first stays.
    expect(prefs.removeInstance('codex', keys[2] ?? '')).toEqual({ status: 'removed' });
    expect(codex(prefs)?.added.map((entry) => entry.key)).toEqual([keys[0], keys[1], keys[4]]);
    // The entry that repeated an earlier id is named by a key of its own, never by that id.
    expect(prefs.removeInstance('codex', keys[4] ?? '')).toEqual({ status: 'removed' });
    expect(stored()['instances']).toEqual([twin, side({ label: 'Renamed' })]);
  });

  it('lets an entry with a taken label be renamed, which is its remedy (C66)', () => {
    place({ instances: [side(), work({ label: 'SIDE', future: ['keep'] })] });
    const prefs = open();
    expect(admission(prefs, A)).toEqual({ kind: 'blocked', reason: 'invalid-instance', issue: 'label-taken' });
    prefs.patch({ providers: { codex: { instances: { [A]: { label: 'Work' } } } } });
    expect(admission(prefs, A)).toEqual({ kind: 'enabled', preferences: controls, folder: 'D:\\accounts\\work' });
    expect(stored()['instances']).toEqual([side(), work({ future: ['keep'] })]);
  });

  it('takes a list that is not a list as the provider’s issue: its first instance runs, and no account can be added', () => {
    place({ enabled: true, executablePath: null, label: 'Personal', instances: { [A]: work() } });
    const prefs = open();
    expect(prefs.getSnapshot().providerIssues).toEqual({ codex: 'invalid-instances' });
    expect(codex(prefs)).toEqual({ firstLabel: 'Personal', added: [] });
    expect(prefs.getProviderAdmission('codex').kind).toBe('enabled');
    expect(admission(prefs, FIRST_INSTANCE_ID).kind).toBe('enabled');
    expect(admission(prefs, A)).toEqual({ kind: 'blocked', reason: 'not-configured' });
    const rev = prefs.getSnapshot().rev;
    expect(prefs.addInstance('codex', { label: 'Work', folder: 'D:\\accounts\\work' })).toEqual({ status: 'refused', reason: 'preferences-blocked' });
    expect(prefs.getSnapshot().rev).toBe(rev);
    expect(stored()['instances']).toEqual({ [A]: work() });
  });
});

describe('admission (C17)', () => {
  it('the provider’s switch turns off every instance, and an added instance’s own switch only itself', () => {
    place({ enabled: false, executablePath: null, instances: [work(), side({ enabled: false })] });
    const prefs = open();
    const off = { enabled: false, executablePath: null, permissionMode: null };
    expect(admission(prefs, FIRST_INSTANCE_ID)).toEqual({ kind: 'disabled', preferences: off, folder: null });
    expect(admission(prefs, A)).toEqual({ kind: 'disabled', preferences: off, folder: 'D:\\accounts\\work' });
    expect(admission(prefs, B).kind).toBe('disabled');

    prefs.patch({ providers: { codex: { enabled: true } } });
    expect(admission(prefs, FIRST_INSTANCE_ID).kind).toBe('enabled');
    expect(admission(prefs, A).kind).toBe('enabled');
    expect(admission(prefs, B).kind).toBe('disabled');
  });

  it('blocks every instance of a provider whose own controls are malformed, and of every provider when the file is refused', () => {
    place({ enabled: 'yes', instances: [work()] });
    const prefs = open();
    expect(admission(prefs, FIRST_INSTANCE_ID)).toEqual({ kind: 'blocked', reason: 'invalid-preferences' });
    expect(admission(prefs, A)).toEqual({ kind: 'blocked', reason: 'invalid-preferences' });
    // The executable override stays one per provider.
    prefs.patch({ providers: { codex: { enabled: true, executablePath: 'C:\\bin\\codex.exe' } } });
    expect(admission(prefs, A)).toMatchObject({ kind: 'enabled', preferences: { executablePath: 'C:\\bin\\codex.exe' } });
    prefs.dispose();

    writeFileSync(file, JSON.stringify({ ...defaultPreferences(), schemaVersion: 3, minReaderVersion: 3, providers: { codex: { instances: [work()] } } }), 'utf8');
    const refused = open();
    expect(refused.getSnapshot().instances).toEqual({ codex: { firstLabel: null, added: [] }, claude: { firstLabel: null, added: [] } });
    expect(refused.getInstanceAdmission({ providerId: 'codex', instanceId: FIRST_INSTANCE_ID })).toEqual({ kind: 'blocked', reason: 'preferences-unavailable' });
    expect(refused.getInstanceAdmission({ providerId: 'codex', instanceId: A })).toEqual({ kind: 'blocked', reason: 'preferences-unavailable' });
    expect(refused.addInstance('codex', { label: 'Work', folder: 'D:\\accounts\\work' })).toEqual({ status: 'refused', reason: 'preferences-blocked' });
    expect(refused.removeInstance('codex', A)).toEqual({ status: 'refused', reason: 'preferences-blocked' });
  });
});

describe('adding an account (C6, C10, C13, C14)', () => {
  it('stores a new entry at the end, switched on, with a fresh id, a cleaned label and the folder as a root is stored', () => {
    place({ enabled: true, executablePath: null, future: { keep: true }, instances: [side({ future: 1 })] });
    const prefs = open();
    const listener = vi.fn();
    prefs.subscribe(listener);
    const result = prefs.addInstance('codex', { label: '  My   work ', folder: 'D:\\accounts\\work\\' });
    expect(result).toEqual({ status: 'saved', id: uuid(101) });
    expect(listener).toHaveBeenCalledOnce();
    expect(prefs.getSnapshot().rev).toBe(1);
    expect(codex(prefs)?.added.at(-1)).toEqual({ key: uuid(101), id: uuid(101), label: 'My work', folder: 'D:\\accounts\\work', enabled: true, issue: null });
    expect(admission(prefs, uuid(101))).toEqual({ kind: 'enabled', preferences: controls, folder: 'D:\\accounts\\work' });
    expect(stored()).toEqual({
      enabled: true, executablePath: null, future: { keep: true },
      instances: [side({ future: 1 }), { id: uuid(101), label: 'My work', folder: 'D:\\accounts\\work', enabled: true }],
    });
  });

  it('makes the provider’s entry and its list for a provider that had neither', () => {
    const prefs = open();
    expect(prefs.addInstance('claude', { label: 'Work', folder: 'D:\\accounts\\claude-work' }).status).toBe('saved');
    prefs.flushSync();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ schemaVersion: 23, minReaderVersion: 23, providers: { claude: { instances: [{ label: 'Work', folder: 'D:\\accounts\\claude-work', enabled: true }] } } });
    expect(prefs.getProviderAdmission('claude')).toEqual({ kind: 'enabled', preferences: controls });
  });

  it.each([
    ['an empty label', { label: ' \n ', folder: 'D:\\accounts\\x' }, 'label-empty'],
    ['a label another account has, whatever its letter case', { label: 'SIDE', folder: 'D:\\accounts\\x' }, 'label-taken'],
    ['the first account’s shown label', { label: 'default', folder: 'D:\\accounts\\x' }, 'label-taken'],
    ['a folder that is not absolute', { label: 'Work', folder: 'accounts\\work' }, 'folder-invalid'],
    ['a folder with a NUL in it', { label: 'Work', folder: 'D:\\accounts\0\\x' }, 'folder-invalid'],
  ] as const)('refuses %s, and stores nothing', (_name, instance, reason) => {
    place({ instances: [side()] });
    const prefs = open();
    expect(prefs.addInstance('codex', instance)).toEqual({ status: 'refused', reason });
    expect(prefs.getSnapshot().rev).toBe(0);
    expect(stored()['instances']).toEqual([side()]);
  });

  it('refuses the first account’s own label, once it has one', () => {
    place({ label: 'Personal' });
    const prefs = open();
    expect(prefs.addInstance('codex', { label: 'personal', folder: 'D:\\accounts\\x' })).toEqual({ status: 'refused', reason: 'label-taken' });
    // "Default" is free again: the first account no longer shows it.
    expect(prefs.addInstance('codex', { label: 'Default', folder: 'D:\\accounts\\x' }).status).toBe('saved');
  });

  it('refuses a ninth instance: eight a provider, the first included (C10)', () => {
    const prefs = open();
    for (let n = 1; n <= 7; n += 1) expect(prefs.addInstance('codex', { label: `Account ${n}`, folder: `D:\\accounts\\${n}` }).status).toBe('saved');
    expect(prefs.addInstance('codex', { label: 'One too many', folder: 'D:\\accounts\\8' })).toEqual({ status: 'refused', reason: 'limit' });
    expect(codex(prefs)?.added).toHaveLength(7);
    // Removing one makes room for another.
    expect(prefs.removeInstance('codex', uuid(101))).toEqual({ status: 'removed' });
    expect(prefs.addInstance('codex', { label: 'Now it fits', folder: 'D:\\accounts\\8' }).status).toBe('saved');
    // The cap is each provider's own.
    expect(prefs.addInstance('claude', { label: 'Work', folder: 'D:\\accounts\\claude' }).status).toBe('saved');
  });

  it('counts an entry that cannot be used: it still holds its place in the list', () => {
    const entries = Array.from({ length: 7 }, (_, index) => ({ id: uuid(index + 1), label: `Account ${index + 1}`, folder: index === 3 ? 'relative' : `D:\\accounts\\${index + 1}`, enabled: true }));
    place({ instances: entries });
    const prefs = open();
    expect(codex(prefs)?.added.filter((entry) => entry.issue !== null)).toHaveLength(1);
    expect(prefs.addInstance('codex', { label: 'One too many', folder: 'D:\\accounts\\8' })).toEqual({ status: 'refused', reason: 'limit' });
    expect(prefs.removeInstance('codex', uuid(4))).toEqual({ status: 'removed' });
    expect(prefs.addInstance('codex', { label: 'Now it fits', folder: 'D:\\accounts\\8' }).status).toBe('saved');
  });

  it('refuses a provider that is not registered', () => {
    const prefs = open();
    expect(prefs.addInstance('gemini', { label: 'Work', folder: 'D:\\accounts\\x' })).toEqual({ status: 'refused', reason: 'unknown-provider' });
    expect(prefs.removeInstance('gemini', A)).toEqual({ status: 'refused', reason: 'unknown-provider' });
  });
});

describe('removing an account (C23)', () => {
  it('deletes that entry and nothing else', () => {
    place({ enabled: false, executablePath: 'C:\\bin\\codex.exe', label: 'Personal', future: [1], instances: [work(), side({ future: 2 })] });
    const prefs = open();
    const listener = vi.fn();
    prefs.subscribe(listener);
    expect(prefs.removeInstance('codex', A)).toEqual({ status: 'removed' });
    expect(listener).toHaveBeenCalledOnce();
    expect(admission(prefs, A)).toEqual({ kind: 'blocked', reason: 'not-configured' });
    expect(stored()).toEqual({ enabled: false, executablePath: 'C:\\bin\\codex.exe', label: 'Personal', future: [1], instances: [side({ future: 2 })] });
  });

  it('refuses the first instance, which has no entry, and a key it does not know', () => {
    place({ instances: [work()] });
    const prefs = open();
    expect(prefs.removeInstance('codex', FIRST_INSTANCE_ID)).toEqual({ status: 'refused', reason: 'first-instance' });
    expect(prefs.removeInstance('codex', B)).toEqual({ status: 'refused', reason: 'unknown-instance' });
    expect(prefs.removeInstance('claude', A)).toEqual({ status: 'refused', reason: 'unknown-instance' });
    expect(prefs.getSnapshot().rev).toBe(0);
  });
});

describe('renaming and switching through the patch (C13, C18, C21)', () => {
  it('renames an added instance and flips its switch, keeping its folder, its id and its unknown fields', () => {
    place({ instances: [work({ future: ['keep'] }), side()] });
    const prefs = open();
    const snapshot = prefs.patch({ providers: { codex: { instances: { [A]: { label: '  Day   job ', enabled: false } } } } });
    expect(snapshot.rev).toBe(1);
    expect(snapshot.instances['codex']?.added[0]).toEqual({ key: A, id: A, label: 'Day job', folder: 'D:\\accounts\\work', enabled: false, issue: null });
    expect(stored()['instances']).toEqual([work({ label: 'Day job', enabled: false, future: ['keep'] }), side()]);
  });

  it('sets and clears the first instance’s label', () => {
    place({ enabled: true, executablePath: null, instances: [work()] });
    const prefs = open();
    expect(prefs.patch({ providers: { codex: { label: '  Personal ' } } }).instances['codex']?.firstLabel).toBe('Personal');
    expect(stored()['label']).toBe('Personal');
    expect(prefs.patch({ providers: { codex: { label: null } } }).instances['codex']?.firstLabel).toBeNull();
    expect(stored()).toEqual({ enabled: true, executablePath: null, instances: [work()] });
    prefs.patch({ providers: { codex: { label: 'Personal' } } });
    // An empty label clears it too.
    expect(prefs.patch({ providers: { codex: { label: '   ' } } }).instances['codex']?.firstLabel).toBeNull();
    expect(stored()).not.toHaveProperty('label');
  });

  it('writes nothing for a label that is already the one stored, or cleared when there is none', () => {
    place({ label: 'Personal', instances: [work()] });
    const prefs = open();
    expect(prefs.patch({ providers: { codex: { label: 'Personal', instances: { [A]: { label: 'Work', enabled: true } } } } }).rev).toBe(0);
    expect(prefs.patch({ providers: { claude: { label: null } } }).rev).toBe(0);
    prefs.flushSync();
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('providers.claude');
  });

  it.each([
    ['an instance the provider does not have', { instances: { [uuid(9)]: { enabled: false } } }],
    ['an empty label for an added instance', { instances: { [A]: { label: '  ' } } }],
    ['a label another added instance has', { instances: { [A]: { label: 'side' } } }],
    ['the first instance’s shown label for an added one', { instances: { [A]: { label: 'Personal' } } }],
    ['an added instance’s label for the first', { label: 'WORK' }],
    ['two renames that end on one label', { instances: { [A]: { label: 'Same' }, [B]: { label: 'same' } } }],
    ['the first instance and an added one renamed to one label', { label: 'Same', instances: { [A]: { label: 'same' } } }],
  ])('changes nothing for a patch with %s, its other parts included', (_name, update) => {
    place({ label: 'Personal', instances: [work(), side()] });
    const prefs = open();
    const before = readFileSync(file, 'utf8');
    const listener = vi.fn();
    prefs.subscribe(listener);
    expect(prefs.patch({ privacy: { maskEmail: false }, providers: { codex: update } }).rev).toBe(0);
    expect(prefs.getSnapshot().values.privacy.maskEmail).toBe(true);
    expect(listener).not.toHaveBeenCalled();
    prefs.flushSync();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a swap of two labels in one patch, and makes it in steps through a third name', () => {
    place({ instances: [work(), side()] });
    const prefs = open();
    expect(prefs.patch({ providers: { codex: { instances: { [A]: { label: 'Side' }, [B]: { label: 'Work' } } } } }).rev).toBe(0);
    prefs.patch({ providers: { codex: { instances: { [A]: { label: 'Tmp' } } } } });
    prefs.patch({ providers: { codex: { instances: { [B]: { label: 'Work' } } } } });
    prefs.patch({ providers: { codex: { instances: { [A]: { label: 'Side' } } } } });
    expect(codex(prefs)?.added.map((entry) => entry.label)).toEqual(['Side', 'Work']);
  });

  it('has no way to change a folder: after every kind of change it is the one stored at add (C18)', () => {
    const prefs = open();
    const added = prefs.addInstance('codex', { label: 'Work', folder: 'D:\\accounts\\work' });
    if (added.status !== 'saved') throw new Error('not saved');
    prefs.patch({ providers: { codex: { enabled: false, label: 'Personal', instances: { [added.id]: { label: 'Day job', enabled: false } } } } });
    prefs.patch({ providers: { codex: { enabled: true, instances: { [added.id]: { enabled: true } } } } });
    expect(admission(prefs, added.id)).toEqual({ kind: 'enabled', preferences: controls, folder: 'D:\\accounts\\work' });
  });
});
