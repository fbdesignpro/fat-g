// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ATTENTION_FLASH } from '@shared/contracts/appearance';
import { defaultPreferences, POLL_INTERVAL_SEC, PreferencesPatchSchema } from '@shared/contracts/prefs';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from './store';

let dir: string;
let file: string;
let store: PreferencesStore | undefined;
const log = { warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-prefs-'));
  file = path.join(dir, PREFERENCES_FILE);
  log.warn.mockClear();
  log.error.mockClear();
});
afterEach(() => {
  store?.dispose();
  store = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const open = (options: Partial<Parameters<typeof createPreferencesStore>[0]> = {}): PreferencesStore => {
  store = createPreferencesStore({ dir, providerIds: ['codex'], log, ...options });
  return store;
};
const writeFile = (contents: unknown): void => writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
const readText = (): string => readFileSync(file, 'utf8');
const readBack = (): Record<string, unknown> => JSON.parse(readText()) as Record<string, unknown>;
/**
 * Waits for what a real write leaves on disk. `vi.waitFor` gives up after one second unless told
 * otherwise, and a write that waits for the disk can take longer than that on a busy machine.
 */
const onDisk = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 15_000 });
const current = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...defaultPreferences(), ...extra });

describe('new and legacy documents', () => {
  it('defaults absent hover times on without rewriting, persisting an explicit false', () => {
    writeFile(current({ chat: { messageTimes: false, answerTimes: true, username: null, futureChat: 'keep' } }));
    const original = readText();
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().status.kind).toBe('ok');
    expect(prefs.getSnapshot().values.chat.hoverMessageTimes).toBe(true);
    prefs.flushSync();
    expect(readText()).toBe(original);
    prefs.patch({ chat: { username: 'Robin' } });
    prefs.flushSync();
    expect(readBack()['chat']).not.toHaveProperty('hoverMessageTimes');
    prefs.patch({ chat: { hoverMessageTimes: false } });
    prefs.flushSync();
    expect(readBack()).toMatchObject({ schemaVersion: 23, minReaderVersion: 23, chat: { hoverMessageTimes: false, futureChat: 'keep', username: 'Robin' } });
    prefs.dispose();
    store = undefined;
    expect(open().getSnapshot().values.chat.hoverMessageTimes).toBe(false);
  });
  it('starts safely on revision-5 defaults and creates a discoverable file', async () => {
    const snapshot = open({ writeDelayMs: 1 }).getSnapshot();
    expect(snapshot).toEqual({ rev: 0, values: defaultPreferences(), status: { kind: 'ok' }, providerIssues: {}, instances: { codex: { firstLabel: null, added: [] } } });
    expect(store?.getProviderAdmission('codex')).toEqual({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    await onDisk(() => expect(existsSync(file)).toBe(true));
    expect(readBack()).toMatchObject({ schemaVersion: 23, minReaderVersion: 23, appearance: { theme: 'light' }, layout: { projectColumn: 'left' }, chat: { messageTimes: false, answerTimes: true, username: null }, titles: { generated: true, models: {} }, composer: { busyEnter: 'send-now' }, avatars: { assignments: {} }, presets: {}, recentModels: [] });
    expect(readText().endsWith('\n')).toBe(true);
  });

  // No migrations before the first public release (decision 0014): an older file is refused and
  // left exactly as it was, and the defaults apply in memory — light, projects on the left.
  it.each([
    ['revision 22', 22, { ...defaultPreferences(), schemaVersion: 22, minReaderVersion: 22 }],
    ['revision 21', 21, { ...defaultPreferences(), schemaVersion: 21, minReaderVersion: 21 }],
    ['revision 20', 20, { ...defaultPreferences(), schemaVersion: 20, minReaderVersion: 20 }],
    ['revision 19', 19, { ...defaultPreferences(), schemaVersion: 19, minReaderVersion: 19 }],
    ['revision 18', 18, { ...defaultPreferences(), schemaVersion: 18, minReaderVersion: 18 }],
    ['revision 17', 17, { ...defaultPreferences(), schemaVersion: 17, minReaderVersion: 17, future: ['keep'] }],
    ['revision 16', 16, { ...defaultPreferences(), schemaVersion: 16, minReaderVersion: 16, future: ['keep'] }],
    ['revision 10', 10, { ...defaultPreferences(), schemaVersion: 10, minReaderVersion: 10, future: ['keep'] }],
    ['revision 9', 9, { ...defaultPreferences(), schemaVersion: 9, minReaderVersion: 9, future: ['keep'] }],
    // The file every installation had before M103 (C1): refused as older, with Start fresh as the way on.
    ['revision 8', 8, { ...defaultPreferences(), schemaVersion: 8, minReaderVersion: 8, composer: { busyEnter: 'queue' }, future: ['keep'] }],
    // And the one before M23.
    ['revision 7', 7, { ...defaultPreferences(), schemaVersion: 7, minReaderVersion: 7, titles: { generated: false, models: {} }, future: ['keep'] }],
    // And the one before M26.
    ['revision 6', 6, { ...defaultPreferences(), schemaVersion: 6, minReaderVersion: 6, providers: { codex: { enabled: true, executablePath: null, permissionMode: 'read-only' } }, future: ['keep'] }],
    // And the one before M22 (M22, C25).
    ['revision 5', 5, { ...defaultPreferences(), schemaVersion: 5, minReaderVersion: 5, chat: { messageTimes: true, answerTimes: true, username: null }, future: ['keep'] }],
    // And the one before M19 (C41, S9).
    ['revision 4', 4, { ...defaultPreferences(), schemaVersion: 4, minReaderVersion: 4, appearance: { theme: 'dark' }, future: ['keep'] }],
    // And the one before M14b (C12).
    ['revision 3', 3, { ...defaultPreferences(), schemaVersion: 3, minReaderVersion: 3, providers: { codex: { enabled: false, executablePath: null } }, future: ['keep'] }],
    ['revision 2', 2, { ...defaultPreferences(), schemaVersion: 2, minReaderVersion: 2, privacy: { maskEmail: false }, future: ['keep'] }],
    // Revision 1 still goes through the existing step to revision 2, then is refused like one.
    ['revision 1', 2, { schemaVersion: 1, providers: { codex: { enabled: false, executablePath: 'C:\\bin\\codex.exe' } }, futureTop: ['a', { b: 2 }] }],
  ])('refuses a %s file unchanged, with the defaults in memory', (_name, version, contents) => {
    writeFile(contents);
    const before = readText();
    const prefs = open({ writeDelayMs: 1 });
    expect(prefs.getSnapshot().status).toEqual({ kind: 'read-only', reason: 'incompatible', fileVersion: version, minReaderVersion: version });
    expect(prefs.getSnapshot().values).toEqual(defaultPreferences());
    expect(prefs.getProviderAdmission('codex')).toEqual({ kind: 'blocked', reason: 'preferences-unavailable' });
    expect(prefs.patch({ appearance: { theme: 'dark' } }).rev).toBe(0);
    prefs.flushSync();
    expect(readText()).toBe(before);
    expect(readdirSync(dir)).toEqual([PREFERENCES_FILE]);
  });
});

describe('the chat section (M19, C41)', () => {
  it('saves message times and a username, each alone, keeping unknown fields beside them', () => {
    writeFile(current({ chat: { messageTimes: false, answerTimes: true, username: null, futureChat: 'keep' } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.patch({ chat: { messageTimes: true } }).values.chat).toEqual({ messageTimes: true, hoverMessageTimes: true, answerTimes: true, username: null });
    expect(prefs.patch({ chat: { username: 'Robin' } }).values.chat).toEqual({ messageTimes: true, hoverMessageTimes: true, answerTimes: true, username: 'Robin' });
    expect(prefs.patch({ chat: { answerTimes: false } }).values.chat).toEqual({ messageTimes: true, hoverMessageTimes: true, answerTimes: false, username: 'Robin' });
    prefs.flushSync();
    expect(readBack()['chat']).toEqual({ messageTimes: true, answerTimes: false, username: 'Robin', futureChat: 'keep' });
    // After a restart: read back as saved.
    store = undefined;
    expect(open().getSnapshot().values.chat).toEqual({ messageTimes: true, hoverMessageTimes: true, answerTimes: false, username: 'Robin' });
  });

  it('reads a file with no chat section with defaults, and writes the section at the first change', () => {
    const { chat: _chat, ...without } = defaultPreferences();
    writeFile(without);
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().values.chat).toEqual({ messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: null });
    prefs.patch({ chat: { username: 'Robin' } });
    prefs.flushSync();
    expect(readBack()['chat']).toEqual({ username: 'Robin' });
  });
});

describe('the composer section (M23, C80)', () => {
  it('saves what Enter does while a turn runs, an unknown field kept, and reads it back after a restart', () => {
    writeFile(current({ composer: { busyEnter: 'send-now', futureComposer: 'keep' } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().values.composer).toEqual({ busyEnter: 'send-now' });
    expect(prefs.patch({ composer: { busyEnter: 'queue' } }).values.composer).toEqual({ busyEnter: 'queue' });
    prefs.flushSync();
    expect(readBack()['composer']).toEqual({ busyEnter: 'queue', futureComposer: 'keep' });
    store = undefined;
    expect(open().getSnapshot().values.composer).toEqual({ busyEnter: 'queue' });
  });
});

describe('the Pet window (decision 0010)', () => {
  it('saves auto-hide independently, preserves other and unknown fields, and reads it after a restart', () => {
    writeFile(current({ windows: { ...defaultPreferences().windows, pet: { ...defaultPreferences().windows.pet, visible: false, size: 'capsule', futurePet: 'keep' } } }));
    const prefs = open({ writeDelayMs: 10_000 });
    prefs.patch({ windows: { pet: { autoHideOnMainFocus: false } } });
    prefs.flushSync();
    expect((readBack()['windows'] as Record<string, unknown>)['pet']).toEqual({ ...defaultPreferences().windows.pet, visible: false, size: 'capsule', autoHideOnMainFocus: false, futurePet: 'keep' });
    store = undefined;
    expect(open().getSnapshot().values.windows.pet).toEqual({ ...defaultPreferences().windows.pet, visible: false, size: 'capsule', autoHideOnMainFocus: false });
  });

  it('saves the size the Pet draws at beside its other fields, and reads it back after a restart', () => {
    writeFile(current({ windows: { ...defaultPreferences().windows, pet: { visible: false, bounds: { x: 10, y: 20, width: 300, height: 54 }, futurePet: 'keep' } } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().values.windows.pet.size).toBe('compact');
    expect(prefs.patch({ windows: { pet: { size: 'capsule' } } }).values.windows.pet).toEqual({ visible: false, autoHideOnMainFocus: true, bounds: { x: 10, y: 20, width: 300, height: 54 }, size: 'capsule' });
    prefs.flushSync();
    expect((readBack()['windows'] as Record<string, unknown>)['pet']).toEqual({ visible: false, bounds: { x: 10, y: 20, width: 300, height: 54 }, futurePet: 'keep', size: 'capsule' });
    store = undefined;
    expect(open().getSnapshot().values.windows.pet.size).toBe('capsule');
  });
});

describe('the titles section (M26)', () => {
  it('saves the switch and a provider’s model, each alone, a null clearing the model, unknown fields kept', () => {
    writeFile(current({ titles: { generated: true, models: { claude: 'haiku' }, futureTitles: 'keep' } }));
    const prefs = open({ writeDelayMs: 10_000, providerIds: ['codex', 'claude'] });
    expect(prefs.getSnapshot().values.titles).toEqual({ generated: true, models: { claude: 'haiku' } });
    expect(prefs.patch({ titles: { generated: false } }).values.titles).toEqual({ generated: false, models: { claude: 'haiku' } });
    expect(prefs.patch({ titles: { models: { codex: 'gpt-6-luna' } } }).values.titles.models).toEqual({ claude: 'haiku', codex: 'gpt-6-luna' });
    expect(prefs.patch({ titles: { models: { claude: null } } }).values.titles.models).toEqual({ codex: 'gpt-6-luna' });
    prefs.flushSync();
    expect(readBack()['titles']).toEqual({ generated: false, models: { codex: 'gpt-6-luna' }, futureTitles: 'keep' });
    store = undefined;
    expect(open({ providerIds: ['codex', 'claude'] }).getSnapshot().values.titles).toEqual({ generated: false, models: { codex: 'gpt-6-luna' } });
  });

  it('reads a file with no titles section as on with no model chosen, and drops a model that is no key', () => {
    const { titles: _titles, ...without } = defaultPreferences();
    writeFile(without);
    expect(open().getSnapshot().values.titles).toEqual({ generated: true, models: {} });
    store = undefined;
    writeFile(current({ titles: { generated: 'yes', models: { claude: 42, codex: '', other: 'x'.repeat(300), kept: 'sonnet' } } }));
    expect(open().getSnapshot().values.titles).toEqual({ generated: true, models: { kept: 'sonnet' } });
  });

  it('refuses a model for a provider that is not registered', () => {
    writeFile(current({}));
    const prefs = open({ writeDelayMs: 10_000 });
    const before = prefs.getSnapshot().rev;
    const refused = prefs.patch({ titles: { models: { someone: 'model' } } });
    expect([refused.rev, refused.values.titles.models]).toEqual([before, {}]);
  });
});

describe('the avatars section (M103, V1, V2; decision 0031)', () => {
  const X = { origin: 'built-in', family: 'Orange', avatar: 'X' } as const;
  const Y = { origin: 'user', family: 'Mine', avatar: 'Y' } as const;
  const Z = { origin: 'built-in', family: 'Blue', avatar: 'Default' } as const;
  const both = { providerIds: ['claude', 'codex'] };
  const assignments = (): unknown => (readBack()['avatars'] as Record<string, unknown>)['assignments'];

  it('saves one model’s avatar, a key no account lists included, keeping unknown fields in and beside the section, and reads it back after a restart', () => {
    writeFile(current({ avatars: { assignments: { claude: { opus: X, futureKey: 'keep' }, gemini: { pro: Y } }, futureAvatars: [1] }, futureTop: 'keep' }));
    const prefs = open({ writeDelayMs: 10_000, ...both });
    expect(prefs.getSnapshot().values.avatars).toEqual({ assignments: { claude: { opus: X } }, active: {} });
    expect(prefs.patch({ avatars: { assignments: { codex: { 'model-no-account-lists': Y } } } }).values.avatars.assignments).toEqual({ claude: { opus: X }, codex: { 'model-no-account-lists': Y } });
    prefs.flushSync();
    expect(readBack()).toMatchObject({ avatars: { assignments: { claude: { opus: X, futureKey: 'keep' }, gemini: { pro: Y }, codex: { 'model-no-account-lists': Y } }, futureAvatars: [1] }, futureTop: 'keep' });
    store = undefined;
    expect(open(both).getSnapshot().values.avatars.assignments).toEqual({ claude: { opus: X }, codex: { 'model-no-account-lists': Y } });
  });

  it('drops a malformed entry and one for a provider not registered as it reads, keeps one avatar on several models, and leaves the file unchanged', async () => {
    writeFile(current({ avatars: { assignments: { codex: { a: X, b: X, 'not a key!': Y, c: { ...Y, path: 'C:\\art' } }, claude: { sonnet: X, haiku: Z }, gemini: { pro: Y } } } }));
    const before = readText();
    const prefs = open({ writeDelayMs: 1, ...both });
    expect(prefs.getSnapshot().values.avatars.assignments).toEqual({ claude: { haiku: Z, sonnet: X }, codex: { a: X, b: X } });
    expect(JSON.stringify(prefs.getSnapshot())).not.toContain('gemini');
    await new Promise((resolve) => setTimeout(resolve, 20));
    prefs.flushSync();
    expect(readText()).toBe(before);
  });

  it.each([
    ['an override', { avatars: { assignments: { gemini: { pro: X } } } }],
    ['an active family', { avatars: { active: { gemini: { origin: 'user', family: 'Mine' } } } }],
  ] as const)('refuses %s for a provider that is not registered, whole', (_name, patch) => {
    writeFile(current({}));
    const prefs = open({ writeDelayMs: 10_000, ...both });
    const listener = vi.fn();
    prefs.subscribe(listener);
    const refused = prefs.patch(patch);
    expect([refused.rev, refused.values.avatars]).toEqual([0, { assignments: {}, active: {} }]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('sets an avatar another model holds without taking it; the same again changes nothing; null clears', () => {
    writeFile(current({ avatars: { assignments: { claude: { opus: X, sonnet: Y } } } }));
    const prefs = open({ writeDelayMs: 10_000, ...both });
    const listener = vi.fn();
    prefs.subscribe(listener);
    expect(prefs.patch({ avatars: { assignments: { claude: { haiku: X } } } }).values.avatars.assignments).toEqual({ claude: { haiku: X, opus: X, sonnet: Y } });
    expect(prefs.patch({ avatars: { assignments: { codex: { 'gpt-6-sol': Y } } } }).values.avatars.assignments).toEqual({ claude: { haiku: X, opus: X, sonnet: Y }, codex: { 'gpt-6-sol': Y } });
    expect(listener).toHaveBeenCalledTimes(2);
    const rev = prefs.getSnapshot().rev;
    expect(prefs.patch({ avatars: { assignments: { codex: { 'gpt-6-sol': Y } } } }).rev).toBe(rev);
    expect(prefs.patch({ avatars: { assignments: { codex: { 'gpt-6-luna': null } } } }).rev).toBe(rev);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(prefs.patch({ avatars: { assignments: { claude: { haiku: null } } } }).values.avatars.assignments).toEqual({ claude: { opus: X, sonnet: Y }, codex: { 'gpt-6-sol': Y } });
    prefs.flushSync();
    expect(assignments()).toEqual({ claude: { opus: X, sonnet: Y }, codex: { 'gpt-6-sol': Y } });
  });

  it('sets several models of one provider in one write, in order, and reads them again from the file it wrote (M104, C24)', () => {
    const W = { origin: 'user', family: 'Mine', avatar: 'W' } as const;
    writeFile(current({ avatars: { assignments: { claude: { opus: X, sonnet: { avatar: 'Y', origin: 'user', family: 'Mine' }, fable: W, futureKey: 'keep' }, codex: { 'gpt-6-sol': Z } }, futureAvatars: true } }));
    const prefs = open({ writeDelayMs: 10_000, ...both });
    const saved = prefs.patch({ avatars: { assignments: { claude: { opus: Z, sonnet: Y, haiku: X, fable: null } } } });
    expect([saved.rev, saved.values.avatars.assignments]).toEqual([1, { claude: { haiku: X, opus: Z, sonnet: Y }, codex: { 'gpt-6-sol': Z } }]);
    prefs.flushSync();
    expect(readBack()['avatars']).toEqual({ assignments: { claude: { opus: Z, sonnet: Y, futureKey: 'keep', haiku: X }, codex: { 'gpt-6-sol': Z } }, futureAvatars: true });
    // The unchanged entry is kept as it was written.
    expect(Object.keys((assignments() as { claude: { sonnet: object } }).claude.sonnet)).toEqual(['avatar', 'origin', 'family']);
    store?.dispose();
    store = undefined;
    expect(open(both).getSnapshot().values.avatars.assignments).toEqual({ claude: { haiku: X, opus: Z, sonnet: Y }, codex: { 'gpt-6-sol': Z } });
  });

  it('writes an active family, reads it back after a restart, and removes it with null; an overlay the file holds is kept and never read', () => {
    writeFile(current({ avatars: { assignments: { claude: { opus: X } }, overlay: { enabled: false, futureOverlay: 'keep' } } }));
    const prefs = open({ writeDelayMs: 10_000, ...both });
    const avatars = { active: { codex: { origin: 'built-in', family: 'Codex Elements' } } } as const;
    expect(prefs.patch({ avatars }).values.avatars).toEqual({ assignments: { claude: { opus: X } }, ...avatars });
    prefs.flushSync();
    expect((readBack()['avatars'] as Record<string, unknown>)['overlay']).toEqual({ enabled: false, futureOverlay: 'keep' });
    store?.dispose();
    store = undefined;
    const again = open({ writeDelayMs: 10_000, ...both });
    expect(again.getSnapshot().values.avatars).toEqual({ assignments: { claude: { opus: X } }, ...avatars });
    const cleared = again.patch({ avatars: { active: { codex: null } } });
    expect(cleared.values.avatars).toEqual({ assignments: { claude: { opus: X } }, active: {} });
  });

  it('refuses a patch of the overlay the preferences no longer hold (revision 15)', () => {
    writeFile(current({}));
    const prefs = open({ writeDelayMs: 10_000, ...both });
    expect(PreferencesPatchSchema.safeParse({ avatars: { overlay: { enabled: false } } }).success).toBe(false);
    expect(prefs.getSnapshot().values.avatars).toEqual({ assignments: {}, active: {} });
  });
});

describe('appearance and layout', () => {
  it('saves the creation animation independently, preserving unknown fields across a restart', () => {
    writeFile(current({ appearance: { theme: 'dark', doneAnimation: 'animation-only', futureAppearance: 'keep' } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.patch({ appearance: { creationAnimation: 'none' } }).values.appearance.creationAnimation).toBe('none');
    prefs.flushSync();
    expect(readBack()['appearance']).toEqual({ theme: 'dark', doneAnimation: 'animation-only', creationAnimation: 'none', futureAppearance: 'keep' });
    store = undefined;
    expect(open().getSnapshot().values.appearance.creationAnimation).toBe('none');
  });
  it('saves the Done animation choice and preserves other appearance fields', () => {
    writeFile(current({ appearance: { theme: 'dark', futureAppearance: 'keep' } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.patch({ appearance: { doneAnimation: 'animation-only' } }).values.appearance.doneAnimation).toBe('animation-only');
    prefs.flushSync();
    expect(readBack()['appearance']).toEqual({ theme: 'dark', doneAnimation: 'animation-only', futureAppearance: 'keep' });
    store = undefined;
    expect(open().getSnapshot().values.appearance.doneAnimation).toBe('animation-only');
  });
  it('saves a theme and a column side, keeping unknown fields beside them', () => {
    writeFile(current({ appearance: { theme: 'light', futureAppearance: 'keep' }, layout: { projectColumn: 'left', futureLayout: [1] } }));
    const prefs = open({ writeDelayMs: 10_000 });
    const snapshot = prefs.patch({ appearance: { theme: 'dark' }, layout: { projectColumn: 'right' } });
    expect(snapshot.values.appearance).toEqual({ theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: DEFAULT_ATTENTION_FLASH });
    expect(snapshot.values.layout).toEqual({ projectColumn: 'right' });
    prefs.flushSync();
    expect(readBack()).toMatchObject({
      appearance: { theme: 'dark', futureAppearance: 'keep' },
      layout: { projectColumn: 'right', futureLayout: [1] },
    });
  });

  // The maintainer: the attention flash, a field at a time, beside fields this build does not know.
  it('saves the attention flash a field at a time, keeping unknown fields in and beside it, and reads it back after a restart', () => {
    writeFile(current({ appearance: { theme: 'dark', futureAppearance: 'keep', flash: { enabled: true, speed: 'fast', seconds: 3, futureFlash: 'keep' } } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.patch({ appearance: { flash: { speed: 'medium' } } }).values.appearance).toEqual({ theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: { enabled: true, speed: 'medium', seconds: 3 } });
    expect(prefs.patch({ appearance: { flash: { enabled: false, seconds: 5 } } }).values.appearance.flash).toEqual({ enabled: false, speed: 'medium', seconds: 5 });
    prefs.flushSync();
    expect(readBack()['appearance']).toEqual({ theme: 'dark', futureAppearance: 'keep', flash: { enabled: false, speed: 'medium', seconds: 5, futureFlash: 'keep' } });
    store = undefined;
    expect(open().getSnapshot().values.appearance.flash).toEqual({ enabled: false, speed: 'medium', seconds: 5 });
  });

  it('reads an invalid stored value as its default and leaves it in the file until the user changes it', () => {
    writeFile(current({ appearance: { theme: 'purple' }, layout: { projectColumn: 'top' } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().status).toEqual({ kind: 'ok' });
    expect(prefs.getSnapshot().values.appearance.theme).toBe('light');
    expect(prefs.getSnapshot().values.layout.projectColumn).toBe('left');

    prefs.patch({ privacy: { maskEmail: false }, appearance: {} });
    prefs.flushSync();
    expect(readBack()).toMatchObject({ appearance: { theme: 'purple' }, layout: { projectColumn: 'top' }, privacy: { maskEmail: false } });

    prefs.patch({ layout: { projectColumn: 'right' } });
    prefs.flushSync();
    expect(readBack()).toMatchObject({ appearance: { theme: 'purple' }, layout: { projectColumn: 'right' } });
  });

  it('notifies once for a real change of theme, and not for the same theme again', () => {
    const prefs = open({ writeDelayMs: 10_000 });
    const listener = vi.fn();
    prefs.subscribe(listener);
    prefs.patch({ appearance: { theme: 'dark' } });
    prefs.patch({ appearance: { theme: 'dark' } });
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('compatible future revisions', () => {
  const future = () => ({
    schemaVersion: 24,
    minReaderVersion: 23,
    windows: { ...defaultPreferences().windows, futureWindow: { keep: true } },
    providers: {
      codex: { enabled: false, executablePath: 'C:\\codex.exe', nestedFuture: { keep: [1, 2] } },
      futureProvider: { enabled: false, opaque: ['keep'] },
    },
    usage: { pollIntervalSec: 900, futureUsage: 'keep' },
    privacy: { maskEmail: false, futurePrivacy: true },
    audio: defaultPreferences().audio,
    appearance: { theme: 'dark', futureAppearance: 'keep' },
    layout: { projectColumn: 'right' },
    futureTop: [{ keep: true }],
  });

  it('projects only known fields and preserves every unknown field on a debounced edit', async () => {
    writeFile(future());
    const prefs = open({ writeDelayMs: 1 });
    expect(prefs.getSnapshot().values.schemaVersion).toBe(24);
    expect(prefs.getSnapshot().values.appearance).toEqual({ theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: DEFAULT_ATTENTION_FLASH });
    expect(prefs.getSnapshot().values.providers).toEqual({ codex: { enabled: false, executablePath: 'C:\\codex.exe', permissionMode: null } });
    expect(JSON.stringify(prefs.getSnapshot())).not.toContain('futureProvider');
    prefs.patch({ privacy: { maskEmail: true } });
    await onDisk(() => expect((readBack()['privacy'] as Record<string, unknown>)['maskEmail']).toBe(true));
    expect(readBack()).toEqual({ ...future(), privacy: { maskEmail: true, futurePrivacy: true } });
  });

  it('preserves version metadata and unknown arrays through synchronous flush', () => {
    writeFile(future());
    const prefs = open({ writeDelayMs: 10_000 });
    prefs.patch({ audio: { muted: true } });
    prefs.flushSync();
    expect(readBack()).toMatchObject({ schemaVersion: 24, minReaderVersion: 23, futureTop: [{ keep: true }], audio: { muted: true } });
  });
});

describe('unavailable and incompatible input', () => {
  it.each([
    ['broken JSON', '{'],
    ['non-object JSON', '42'],
    ['missing envelope', JSON.stringify({ privacy: { maskEmail: false } })],
    ['invalid envelope ordering', JSON.stringify({ schemaVersion: 2, minReaderVersion: 3 })],
  ])('preserves %s byte-for-byte, refuses writes and blocks providers', (_name, contents) => {
    writeFile(contents);
    const before = readText();
    const prefs = open({ writeDelayMs: 1 });
    expect(prefs.getSnapshot().status).toMatchObject({ kind: 'read-only' });
    expect(prefs.getProviderAdmission('codex')).toMatchObject({ kind: 'blocked' });
    expect(prefs.patch({ audio: { muted: true } }).rev).toBe(0);
    prefs.flushSync();
    expect(readText()).toBe(before);
    expect(readdirSync(dir)).toEqual([PREFERENCES_FILE]);
  });

  it('refuses a newer minimum-reader requirement without lowering its metadata', () => {
    const future = { schemaVersion: 24, minReaderVersion: 24, privacy: { maskEmail: false }, future: ['keep'] };
    writeFile(future);
    const prefs = open();
    expect(prefs.getSnapshot().status).toEqual({ kind: 'read-only', reason: 'incompatible', fileVersion: 24, minReaderVersion: 24 });
    expect(prefs.getProviderAdmission('codex')).toEqual({ kind: 'blocked', reason: 'preferences-unavailable' });
    prefs.patch({ privacy: { maskEmail: true } });
    prefs.flushSync();
    expect(readBack()).toEqual(future);
  });

  it('distinguishes an unreadable path from a genuinely absent file', () => {
    mkdirSync(file);
    const prefs = open();
    expect(prefs.getSnapshot().status).toEqual({ kind: 'read-only', reason: 'unreadable' });
    expect(prefs.getProviderAdmission('codex')).toEqual({ kind: 'blocked', reason: 'preferences-unavailable' });
  });
});

describe('provider admission and repair', () => {
  it('blocks a malformed control, preserves it through unrelated writes, then accepts an explicit repair', () => {
    writeFile(current({ providers: { codex: { enabled: 'false', executablePath: null, future: 'keep' } } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().providerIssues).toEqual({ codex: 'invalid-enabled' });
    expect(prefs.getProviderAdmission('codex')).toEqual({ kind: 'blocked', reason: 'invalid-preferences' });
    prefs.patch({ privacy: { maskEmail: false } });
    prefs.flushSync();
    expect((readBack()['providers'] as Record<string, Record<string, unknown>>)['codex']?.['enabled']).toBe('false');

    prefs.patch({ providers: { codex: { enabled: false } } });
    expect(prefs.getSnapshot().providerIssues).toEqual({});
    expect(prefs.getProviderAdmission('codex').kind).toBe('disabled');
    prefs.flushSync();
    expect(readBack()).toMatchObject({ providers: { codex: { enabled: false, executablePath: null, future: 'keep' } } });
  });

  // M22, V15 (C25, C40): the user's default mode for a provider, saved by its own control alone.
  it('saves a provider’s default mode by a patch, clears it by null, and reads one that is no id as none chosen', () => {
    writeFile(current({ providers: { codex: { future: 'keep' } } }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().values.providers['codex']).toEqual({ enabled: true, executablePath: null, permissionMode: null });
    prefs.patch({ providers: { codex: { permissionMode: 'sandbox-ok' } } });
    expect(prefs.getSnapshot().values.providers['codex']?.permissionMode).toBe('sandbox-ok');
    // A default reaches no running session: the provider is admitted as it was.
    expect(prefs.getProviderAdmission('codex')).toEqual({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: 'sandbox-ok' } });
    prefs.flushSync();
    expect(readBack()).toMatchObject({ providers: { codex: { permissionMode: 'sandbox-ok', future: 'keep' } } });
    prefs.patch({ providers: { codex: { permissionMode: null } } });
    prefs.flushSync();
    expect((readBack()['providers'] as Record<string, Record<string, unknown>>)['codex']).toEqual({ future: 'keep', permissionMode: null });
    prefs.dispose();
    // Hand-edited to something that is no id: none chosen, and nothing blocked for it.
    writeFile(current({ providers: { codex: { permissionMode: 'Ask First!' } } }));
    const again = open();
    expect(again.getSnapshot().values.providers['codex']?.permissionMode).toBeNull();
    expect(again.getSnapshot().providerIssues).toEqual({});
    expect(again.getProviderAdmission('codex').kind).toBe('enabled');
  });

  it('honours an explicit disable even if its path is malformed', () => {
    writeFile(current({ providers: { codex: { enabled: false, executablePath: 42 } } }));
    const prefs = open();
    expect(prefs.getSnapshot().providerIssues).toEqual({ codex: 'invalid-executable-path' });
    expect(prefs.getProviderAdmission('codex').kind).toBe('disabled');
  });

  it('does not repair an invalid whole providers section through an in-app patch', () => {
    writeFile(current({ providers: 'broken' }));
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().providerIssues).toEqual({ codex: 'invalid-provider-section' });
    expect(prefs.patch({ providers: { codex: { enabled: true } } }).rev).toBe(0);
    prefs.flushSync();
    expect(readBack()['providers']).toBe('broken');
  });

  it('keeps genuine missing controls on the stable enabled/automatic defaults', () => {
    writeFile(current({ providers: { codex: {} } }));
    expect(open().getProviderAdmission('codex')).toEqual({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
  });

  it('will not let IPC-style patches create unknown provider ids', () => {
    const prefs = open();
    expect(prefs.patch({ providers: { unknown: { enabled: false } } }).rev).toBe(0);
    expect(prefs.getSnapshot().values.providers).toEqual({});
  });
});

describe('patching and writes', () => {
  it('clamps patched cosmetic values and notifies once per real change', () => {
    const prefs = open({ writeDelayMs: 10_000 });
    const listener = vi.fn();
    prefs.subscribe(listener);
    expect(prefs.patch({ usage: { pollIntervalSec: 1 } }).values.usage.pollIntervalSec).toBe(POLL_INTERVAL_SEC.min);
    expect(listener).toHaveBeenCalledOnce();
    prefs.patch({ usage: { pollIntervalSec: POLL_INTERVAL_SEC.min } });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('queues one follow-up when a change lands during an asynchronous write', async () => {
    let release = (): void => undefined;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const write = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const prefs = open({ writeDelayMs: 1, write });
    prefs.patch({ privacy: { maskEmail: false } });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    prefs.patch({ usage: { pollIntervalSec: 600 } });
    prefs.patch({ usage: { pollIntervalSec: 900 } });
    release();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    const data = String(write.mock.calls[1]?.[1]);
    expect(JSON.parse(data)).toMatchObject({ privacy: { maskEmail: false }, usage: { pollIntervalSec: 900 } });
  });

  it('flushes a pending edit synchronously and cancels its delayed write', () => {
    const write = vi.fn(() => Promise.resolve());
    const prefs = open({ writeDelayMs: 10_000, write });
    prefs.patch({ audio: { muted: true } });
    prefs.flushSync();
    expect(readBack()).toMatchObject({ audio: { muted: true } });
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps running after an asynchronous or final write failure', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('EPERM')).mockResolvedValue(undefined);
    const prefs = open({ writeDelayMs: 1, write, writeSync: () => { throw new Error('EPERM'); } });
    prefs.patch({ privacy: { maskEmail: false } });
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledOnce());
    prefs.patch({ audio: { muted: true } });
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(() => prefs.flushSync()).not.toThrow();
  });
});

// ── M12: Start fresh and Try again from Settings (C64, C81) ─────────────────────────────────
describe('Start fresh (V20)', () => {
  const at = Date.parse('2020-01-21T14:03:12.000Z');
  const kept = 'preferences.set-aside.2020-01-21T14-03-12Z.json';

  it.each([
    ['an older development file', JSON.stringify({ ...defaultPreferences(), schemaVersion: 3, minReaderVersion: 3 })],
    // The file every installation had before M103 (C1).
    ['a revision-8 file', JSON.stringify({ ...defaultPreferences(), schemaVersion: 8, minReaderVersion: 8, avatars: undefined })],
    ['a newer file', JSON.stringify({ schemaVersion: 24, minReaderVersion: 24 })],
    ['a damaged file', '{ not json'],
  ])('moves %s aside byte-identical, then takes the defaults and admits the providers', async (_name, contents) => {
    writeFile(contents);
    const prefs = open({ writeDelayMs: 1, now: () => at, providerIds: ['codex', 'claude'] });
    expect(prefs.getProviderAdmission('codex').kind).toBe('blocked');
    const listener = vi.fn();
    prefs.subscribe(listener);

    const result = await prefs.startFresh();

    expect(result).toEqual({ status: 'done', keptAs: path.join(dir, kept) });
    expect(readFileSync(path.join(dir, kept), 'utf8')).toBe(contents);
    expect(prefs.getSnapshot().status).toEqual({ kind: 'ok' });
    expect(prefs.getSnapshot().values).toEqual(defaultPreferences());
    expect(prefs.getSnapshot().rev).toBe(1);
    expect(listener).toHaveBeenCalledOnce();
    for (const id of ['codex', 'claude']) expect(prefs.getProviderAdmission(id)).toEqual({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    // Written as on a first run, a moment later.
    await onDisk(() => expect(existsSync(file)).toBe(true));
    expect(readBack()).toMatchObject({ schemaVersion: 23, minReaderVersion: 23 });
  });

  it('keeps the first copy when a second Start fresh lands in the same second', async () => {
    writeFileSync(path.join(dir, kept), 'an earlier copy');
    writeFile('{');
    const prefs = open({ writeDelayMs: 10_000, now: () => at });
    expect(await prefs.startFresh()).toEqual({ status: 'done', keptAs: path.join(dir, 'preferences.set-aside.2020-01-21T14-03-12Z-2.json') });
    expect(readFileSync(path.join(dir, kept), 'utf8')).toBe('an earlier copy');
  });

  it('changes nothing when the file cannot be moved, and says so by rejecting', async () => {
    writeFile('{');
    const before = readText();
    const prefs = open({ writeDelayMs: 1, now: () => at, setAsideIo: { lstat: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })), rename: () => Promise.reject(Object.assign(new Error('x'), { code: 'EBUSY' })) } });
    await expect(prefs.startFresh()).rejects.toMatchObject({ code: 'EBUSY' });
    expect(prefs.getSnapshot().status).toMatchObject({ kind: 'read-only', reason: 'corrupt' });
    expect(prefs.getProviderAdmission('codex').kind).toBe('blocked');
    expect(readText()).toBe(before);
    expect(readdirSync(dir)).toEqual([PREFERENCES_FILE]);
  });

  it('refuses when the file was read, and moves nothing', async () => {
    const prefs = open({ writeDelayMs: 10_000 });
    expect(await prefs.startFresh()).toEqual({ status: 'refused', reason: 'not-refused' });
  });

  it('moves the file once for two confirmations sent together', async () => {
    writeFile('{');
    const prefs = open({ writeDelayMs: 10_000, now: () => at });
    const [first, second] = await Promise.all([prefs.startFresh(), prefs.startFresh()]);
    expect(first).toEqual(second);
    expect(readdirSync(dir).filter((name) => name.includes('set-aside'))).toEqual([kept]);
  });
});

describe('Try again (V25)', () => {
  it('loads a file that has become readable, and admits the providers by its switches', () => {
    mkdirSync(file);
    const prefs = open({ writeDelayMs: 10_000 });
    expect(prefs.getSnapshot().status).toEqual({ kind: 'read-only', reason: 'unreadable' });
    const listener = vi.fn();
    prefs.subscribe(listener);

    rmSync(file, { recursive: true });
    writeFile(current({ providers: { codex: { enabled: false } }, privacy: { maskEmail: false } }));
    expect(prefs.retry()).toEqual({ status: 'loaded' });

    expect(prefs.getSnapshot().status).toEqual({ kind: 'ok' });
    expect(prefs.getSnapshot().values.privacy.maskEmail).toBe(false);
    expect(prefs.getProviderAdmission('codex').kind).toBe('disabled');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps the note for a file still locked, and changes nothing', () => {
    const locked = () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); };
    const prefs = open({ writeDelayMs: 10_000, readFile: locked });
    const listener = vi.fn();
    prefs.subscribe(listener);
    expect(prefs.retry()).toEqual({ status: 'refused', reason: 'still-refused' });
    expect(prefs.getSnapshot()).toMatchObject({ rev: 0, status: { kind: 'read-only', reason: 'unreadable' } });
    expect(prefs.getProviderAdmission('codex')).toEqual({ kind: 'blocked', reason: 'preferences-unavailable' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('shows the cause the new read gives', () => {
    let text: string | null = null;
    const read = () => {
      if (text === null) throw Object.assign(new Error('x'), { code: 'EBUSY' });
      return text;
    };
    const prefs = open({ writeDelayMs: 10_000, readFile: read });
    text = '{';
    expect(prefs.retry()).toEqual({ status: 'refused', reason: 'still-refused' });
    expect(prefs.getSnapshot().status).toMatchObject({ kind: 'read-only', reason: 'corrupt' });
  });

  it('has nothing to retry for a file that was read', () => {
    expect(open().retry()).toEqual({ status: 'refused', reason: 'not-refused' });
  });
});


describe('audio selection persistence', () => {
  it('merges one event and preserves unknown audio and mapping fields in compatible files', () => {
    writeFile(current({ audio: { ...defaultPreferences().audio, futureAudio: ['kept'], sounds: { ...defaultPreferences().audio.sounds, futureCue: 'future.wav' } } }));
    const prefs = open();
    prefs.patch({ audio: { sounds: { click: null } } }); prefs.flushSync();
    expect(readBack()).toMatchObject({ audio: { futureAudio: ['kept'], sounds: { click: null, done: 'done.wav', futureCue: 'future.wav' } } });
    expect(open().getSnapshot().values.audio.sounds.click).toBeNull();
  });
});
