// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { DEFAULT_SOUNDS } from './audio';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ATTENTION_FLASH } from './appearance';
import { MAX_MODELS } from './catalog';
import {
  applyPatch,
  defaultPreferences,
  MIN_READER_VERSION,
  POLL_INTERVAL_SEC,
  PreferencesPatchSchema,
  PreferencesSchema,
  PREFERENCES_VERSION,
} from './prefs';

const INSTANCE = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';

describe('defaults', () => {
  it('defaults absent or malformed hover times on at revision 22, preserves false and accepts only boolean patches', () => {
    for (const chat of [undefined, {}, { hoverMessageTimes: 'no' }, { messageTimes: true }]) {
      expect(PreferencesSchema.parse({ chat }).chat.hoverMessageTimes).toBe(true);
    }
    expect(PreferencesSchema.parse({ chat: { hoverMessageTimes: false } }).chat.hoverMessageTimes).toBe(false);
    expect(PreferencesPatchSchema.parse({ chat: { hoverMessageTimes: false } })).toEqual({ chat: { hoverMessageTimes: false } });
    expect(PreferencesPatchSchema.safeParse({ chat: { hoverMessageTimes: 'false' } }).success).toBe(false);
  });
  it('normalizes usernames, clears blanks and bounds names by grapheme clusters', () => {
    expect(PreferencesPatchSchema.parse({ chat: { username: '  Robin\n  Taylor\u0000 ' } }).chat?.username).toBe('Robin Taylor');
    expect(PreferencesPatchSchema.parse({ chat: { username: '   ' } }).chat?.username).toBeNull();
    const name = PreferencesPatchSchema.parse({ chat: { username: '🙂'.repeat(70) } }).chat?.username ?? '';
    expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)]).toHaveLength(60);
    expect(name.endsWith('…')).toBe(true);
    expect(PreferencesPatchSchema.safeParse({ chat: { elapsed: true } }).success).toBe(false);
  });
  it('are what the schema makes of an empty file', () => {
    expect(defaultPreferences()).toEqual({
      schemaVersion: PREFERENCES_VERSION,
      minReaderVersion: MIN_READER_VERSION,
      windows: { main: { bounds: null, maximized: false }, pet: { visible: true, autoHideOnMainFocus: true, bounds: null, size: 'compact' } },
      providers: {},
      presets: {},
      presetRecency: [],
      recentModels: [],
      usage: { pollIntervalSec: 300 },
      privacy: { maskEmail: true },
      audio: { muted: false, volume: 0.1, sounds: DEFAULT_SOUNDS },
      appearance: { theme: 'light', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: { enabled: true, speed: 'fast', seconds: 3 } },
      layout: { projectColumn: 'left' },
      chat: { messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: null },
      titles: { generated: true, models: {} },
      composer: { busyEnter: 'send-now' },
      avatars: { assignments: {}, active: {} },
    });
  });

  it('are revision 23, readable by revision 23 and later only', () => {
    expect([PREFERENCES_VERSION, MIN_READER_VERSION]).toEqual([23, 23]);
  });

  it('send now on Enter while a turn runs, until told to queue (M23, C80)', () => {
    expect(defaultPreferences().composer).toEqual({ busyEnter: 'send-now' });
    expect(PreferencesSchema.parse({ composer: { busyEnter: 'queue' } }).composer).toEqual({ busyEnter: 'queue' });
    // A value it does not know, and a section that is no object, read as Send now.
    expect(PreferencesSchema.parse({ composer: { busyEnter: 'later' } }).composer).toEqual({ busyEnter: 'send-now' });
    expect(PreferencesSchema.parse({ composer: 'queue' }).composer).toEqual({ busyEnter: 'send-now' });
  });

  it('keeps inline times off while hover and answer times default on', () => {
    expect(defaultPreferences().chat).toEqual({ messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: null });
    // A value of the wrong type, and a section that is no object, read as off.
    expect(PreferencesSchema.parse({ chat: { messageTimes: 'yes', username: 'Robin' } }).chat).toEqual({ messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: 'Robin' });
    expect(PreferencesSchema.parse({ chat: 'on' }).chat).toEqual({ messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: null });
  });

  it('are white with the projects on the left (M100, round 11; C91)', () => {
    expect(defaultPreferences().appearance.theme).toBe('light');
    expect(defaultPreferences().layout.projectColumn).toBe('left');
  });

  it('defaults an unknown Done animation level and refuses invalid patches', () => {
    expect(PreferencesSchema.parse({ appearance: { doneAnimation: 'unknown' } }).appearance.doneAnimation).toBe('animation-flash');
    expect(PreferencesPatchSchema.safeParse({ appearance: { doneAnimation: 'unknown' } }).success).toBe(false);
  });

  it('defaults missing or invalid creation animations to Wipe and validates patches', () => {
    for (const creationAnimation of [undefined, 'unknown', true]) {
      expect(PreferencesSchema.parse({ appearance: { creationAnimation } }).appearance.creationAnimation).toBe('wipe');
    }
    expect(PreferencesPatchSchema.safeParse({ appearance: { creationAnimation: 'unknown' } }).success).toBe(false);
    expect(PreferencesPatchSchema.safeParse({ appearance: { creationAnimation: true } }).success).toBe(false);
    for (const creationAnimation of ['none', 'wipe'] as const) {
      const patch = PreferencesPatchSchema.parse({ appearance: { creationAnimation } });
      expect(applyPatch(defaultPreferences(), patch).appearance).toEqual({ ...defaultPreferences().appearance, creationAnimation });
    }
  });

  it('mask the email until told otherwise', () => {
    expect(defaultPreferences().privacy.maskEmail).toBe(true);
  });

  it('are a fresh object each time, so nobody can mutate everyone else’s defaults', () => {
    expect(defaultPreferences()).not.toBe(defaultPreferences());
  });
});

describe('reading a file', () => {
  it('keeps every valid value', () => {
    const file = {
      schemaVersion: PREFERENCES_VERSION,
      minReaderVersion: MIN_READER_VERSION,
      windows: { main: { bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: true }, pet: { visible: false, autoHideOnMainFocus: false, bounds: null, size: 'compact' } },
      providers: { claude: { enabled: false, executablePath: 'C:\\bin\\claude.exe', permissionMode: 'ask-first' } },
      presets: {},
      presetRecency: [],
      recentModels: [],
      usage: { pollIntervalSec: 900 },
      privacy: { maskEmail: false },
      audio: { muted: true, volume: 0.25, sounds: DEFAULT_SOUNDS },
      appearance: { theme: 'dark', doneAnimation: 'animation-only', creationAnimation: 'none', flash: { enabled: false, speed: 'slow', seconds: 10 } },
      // The side the default is not (C91): a file that names it keeps it.
      layout: { projectColumn: 'right' },
      chat: { messageTimes: true, hoverMessageTimes: true, answerTimes: true, username: 'Robin' },
      titles: { generated: false, models: { claude: 'haiku' } },
      composer: { busyEnter: 'queue' },
      avatars: {
        assignments: { claude: { opus: { origin: 'built-in', family: 'Orange', avatar: 'Op 5.5' } }, codex: { 'gpt-6-sol': { origin: 'user', family: 'Mine', avatar: 'Sol' } } },
        active: { codex: { origin: 'built-in', family: 'Codex Spatial' } },
      },
    };
    expect(PreferencesSchema.parse(file)).toEqual(file);
  });

  it('drops an assignment of the wrong form as it is read, keeping the others (M103, C2, C5)', () => {
    const kept = { origin: 'built-in', family: 'Orange', avatar: 'Op 5.5' };
    const parsed = PreferencesSchema.parse({
      avatars: {
        assignments: {
          claude: { opus: kept, 'not a key!': kept, sonnet: { ...kept, origin: 'elsewhere' }, haiku: { ...kept, path: 'C:\\art' }, fable: { ...kept, avatar: 'x'.repeat(256) } },
          codex: 'gpt-6-sol',
          other: {},
        },
      },
    });
    expect(parsed.avatars).toEqual({ assignments: { claude: { opus: kept } }, active: {} });
    expect(PreferencesSchema.parse({ avatars: { assignments: [kept] } }).avatars).toEqual({ assignments: {}, active: {} });
    expect(PreferencesSchema.parse({ avatars: 'none' }).avatars).toEqual({ assignments: {}, active: {} });
  });

  it('drops an active family of the wrong form as it is read, keeping the others, and reads no overlay (decisions 0031, 0032)', () => {
    const parsed = PreferencesSchema.parse({
      avatars: {
        active: { claude: { origin: 'built-in', family: 'Claude Elements' }, codex: { origin: 'elsewhere', family: 'X' }, other: 'Mine' },
        overlay: { enabled: false, families: { 'built-in/Codex Spatial': { size: 18 } } },
      },
    });
    expect(parsed.avatars).toEqual({ assignments: {}, active: { claude: { origin: 'built-in', family: 'Claude Elements' } } });
  });

  it.each([
    ['a theme it does not know', { appearance: { theme: 'purple' } }],
    ['"follow the OS", which is not a value', { appearance: { theme: 'system' } }],
    ['a theme of the wrong type', { appearance: { theme: 1 } }],
    ['a section that is not an object', { appearance: 'dark' }],
  ])('reads %s as the light theme, keeping the column side', (_name, file) => {
    const parsed = PreferencesSchema.parse({ ...file, layout: { projectColumn: 'right' } });
    expect(parsed.appearance).toEqual({ theme: 'light', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: DEFAULT_ATTENTION_FLASH });
    expect(parsed.layout).toEqual({ projectColumn: 'right' });
  });

  it.each([
    ['a side it does not know', { layout: { projectColumn: 'top' } }],
    ['a section that is not an object', { layout: [] }],
  ])('reads %s as the left side, keeping the theme', (_name, file) => {
    const parsed = PreferencesSchema.parse({ ...file, appearance: { theme: 'dark' } });
    expect(parsed.layout).toEqual({ projectColumn: 'left' });
    expect(parsed.appearance).toEqual({ theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: DEFAULT_ATTENTION_FLASH });
  });

  // Added at revision 16, at the maintainer's choice (decision 0005): a file without it, or a
  // field of it this build does not know the value of, reads as that field's default, the others kept.
  it.each([
    ['no flash', undefined, DEFAULT_ATTENTION_FLASH],
    ['one that is not an object', 'fast', DEFAULT_ATTENTION_FLASH],
    ['a speed it does not know', { enabled: false, speed: 'blinding', seconds: 5 }, { enabled: false, speed: 'fast', seconds: 5 }],
    ['a duration Settings does not offer', { enabled: true, speed: 'slow', seconds: 4 }, { enabled: true, speed: 'slow', seconds: 3 }],
    ['a switch of the wrong type', { enabled: 'yes', speed: 'medium', seconds: 1 }, { enabled: true, speed: 'medium', seconds: 1 }],
  ])('reads %s as the flash it can', (_name, flash, expected) => {
    expect(PreferencesSchema.parse({ appearance: { theme: 'dark', flash } }).appearance).toEqual({ theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: expected });
  });

  it('falls back on the bad leaf only, keeping its neighbours', () => {
    const parsed = PreferencesSchema.parse({
      schemaVersion: PREFERENCES_VERSION,
      minReaderVersion: MIN_READER_VERSION,
      usage: { pollIntervalSec: 'soon' },
      privacy: { maskEmail: false },
      audio: { muted: true, volume: 'loud' },
    });
    expect(parsed.usage.pollIntervalSec).toBe(300);
    expect(parsed.privacy.maskEmail).toBe(false); // the neighbour survived
    expect(parsed.audio).toEqual({ muted: true, volume: 0.1, sounds: DEFAULT_SOUNDS });
  });

  it.each([
    [5, POLL_INTERVAL_SEC.min],
    [59, POLL_INTERVAL_SEC.min],
    [60, 60],
    [3600, 3600],
    [99_999, POLL_INTERVAL_SEC.max],
  ])('clamps a poll interval of %s to %s', (written, expected) => {
    expect(PreferencesSchema.parse({ usage: { pollIntervalSec: written } }).usage.pollIntervalSec).toBe(expected);
  });

  it.each([
    [-1, 0],
    [0.3, 0.3],
    [4, 1],
  ])('clamps a volume of %s to %s', (written, expected) => {
    expect(PreferencesSchema.parse({ audio: { volume: written } }).audio.volume).toBe(expected);
  });

  // Added at revision 16, at the maintainer's choice (decision 0005): a file without it, or
  // with a size this build does not know, reads as the compact size.
  it.each([[undefined, 'compact'], ['compact', 'compact'], ['capsule', 'capsule'], ['huge', 'compact'], [3, 'compact']])('reads a Pet size of %j as %s', (written, expected) => {
    expect(PreferencesSchema.parse({ windows: { pet: { visible: false, size: written } } }).windows.pet).toEqual({ visible: false, autoHideOnMainFocus: true, bounds: null, size: expected });
  });

  it.each([undefined, null, 'false', 0, true, false])('reads the Pet auto-hide preference %j with a true fallback', (written) => {
    expect(PreferencesSchema.parse({ windows: { pet: { autoHideOnMainFocus: written } } }).windows.pet.autoHideOnMainFocus).toBe(typeof written === 'boolean' ? written : true);
  });

  it('drops a half-written rectangle rather than using it', () => {
    expect(PreferencesSchema.parse({ windows: { main: { bounds: { x: 10, y: 20 }, maximized: true } } }).windows.main).toEqual({
      bounds: null,
      maximized: true,
    });
  });

  it('ignores keys it does not know', () => {
    const parsed = PreferencesSchema.parse({ usage: { pollIntervalSec: 120, ghost: true }, somethingElse: 1 });
    expect(parsed.usage).toEqual({ pollIntervalSec: 120 });
    expect(parsed).not.toHaveProperty('somethingElse');
  });

  it.each([42, 'nope', null, []])('refuses a file that is %j, rather than silently starting fresh', (file) => {
    // Not an object means not a preferences file. The store turns this into "back the file up and
    // load defaults" (src/main/prefs/store.ts), which keeps the user's bytes and says what happened —
    // better than the schema swallowing it. An object with bad *contents* still falls back per leaf.
    expect(PreferencesSchema.safeParse(file).success).toBe(false);
    expect(PreferencesSchema.parse({ ...(typeof file === 'object' && file !== null ? file : {}) })).toEqual(defaultPreferences());
  });

  it('keeps a valid provider entry and defaults a broken one', () => {
    const parsed = PreferencesSchema.parse({
      providers: { claude: { enabled: false, executablePath: 'C:\\bin\\claude.exe' }, codex: { enabled: 'sure', executablePath: '' } },
    });
    expect(parsed.providers['claude']).toEqual({ enabled: false, executablePath: 'C:\\bin\\claude.exe', permissionMode: null });
    expect(parsed.providers['codex']).toEqual({ enabled: true, executablePath: null, permissionMode: null });
  });
});

describe('the patch schema (a trust boundary)', () => {
  it('accepts a partial patch', () => {
    expect(PreferencesPatchSchema.parse({ privacy: { maskEmail: false } })).toEqual({ privacy: { maskEmail: false } });
    expect(PreferencesPatchSchema.parse({})).toEqual({});
  });

  it('accepts a rename and a switch of an instance, and the first instance’s label set or cleared (M14b, C21)', () => {
    const patch = { providers: { codex: { label: 'Personal', instances: { [INSTANCE]: { label: 'Work', enabled: false } } } } };
    expect(PreferencesPatchSchema.parse(patch)).toEqual(patch);
    expect(PreferencesPatchSchema.parse({ providers: { codex: { label: null } } })).toEqual({ providers: { codex: { label: null } } });
  });

  it('accepts the size the Pet draws its capsules at, and no other (decision 0010)', () => {
    expect(PreferencesPatchSchema.parse({ windows: { pet: { size: 'compact' } } })).toEqual({ windows: { pet: { size: 'compact' } } });
    expect(PreferencesPatchSchema.safeParse({ windows: { pet: { size: 'huge' } } }).success).toBe(false);
  });

  it('accepts only boolean changes to the Pet auto-hide preference', () => {
    for (const autoHideOnMainFocus of [true, false]) {
      const patch = { windows: { pet: { autoHideOnMainFocus } } };
      expect(PreferencesPatchSchema.parse(patch)).toEqual(patch);
      expect(applyPatch(defaultPreferences(), patch).windows.pet).toEqual({ ...defaultPreferences().windows.pet, autoHideOnMainFocus });
    }
    expect(PreferencesPatchSchema.safeParse({ windows: { pet: { autoHideOnMainFocus: 'false' } } }).success).toBe(false);
  });

  it('accepts what Enter does while a turn runs (M23, C80)', () => {
    expect(PreferencesPatchSchema.parse({ composer: { busyEnter: 'queue' } })).toEqual({ composer: { busyEnter: 'queue' } });
  });

  it('accepts a theme and a column side', () => {
    const patch = { appearance: { theme: 'dark' }, layout: { projectColumn: 'left' } };
    expect(PreferencesPatchSchema.parse(patch)).toEqual(patch);
  });

  it('accepts one model’s avatar, set or cleared (M103, C6)', () => {
    const set = { avatars: { assignments: { claude: { 'claude-opus-5-5[1m]': { origin: 'user', family: 'Mine', avatar: 'A / B' } } } } };
    expect(PreferencesPatchSchema.parse(set)).toEqual(set);
    expect(PreferencesPatchSchema.parse({ avatars: { assignments: { codex: { 'gpt-6-sol': null } } } })).toEqual({ avatars: { assignments: { codex: { 'gpt-6-sol': null } } } });
  });

  it('accepts one avatar under several keys, and an active family set or cleared (decision 0031)', () => {
    const A = { origin: 'user', family: 'Mine', avatar: 'A' } as const;
    const shared = { avatars: { assignments: { claude: { opus: A, haiku: A } } } };
    expect(PreferencesPatchSchema.parse(shared)).toEqual(shared);
    const active = { avatars: { active: { codex: { origin: 'built-in', family: 'Codex Elements' }, claude: null } } };
    expect(PreferencesPatchSchema.parse(active)).toEqual(active);
  });

  it('accepts one provider’s several models’ avatars, sets and clears together, up to a catalog’s models (M104, C24)', () => {
    const A = { origin: 'user', family: 'Moons', avatar: 'A' } as const;
    const B = { origin: 'built-in', family: 'Moons', avatar: 'A' } as const;
    const several = { avatars: { assignments: { claude: { opus: A, sonnet: B, haiku: null, fable: null } } } };
    expect(PreferencesPatchSchema.parse(several)).toEqual(several);
    const most = Object.fromEntries(Array.from({ length: MAX_MODELS }, (_, index) => [`m-${index}`, index === 0 ? A : null]));
    expect(PreferencesPatchSchema.safeParse({ avatars: { assignments: { codex: most } } }).success).toBe(true);
  });

  it.each([
    ['a typo', { privacy: { maskEmails: false } }],
    ['an unknown section', { sounds: { on: true } }],
    ['a theme it does not know', { appearance: { theme: 'purple' } }],
    ['"follow the OS"', { appearance: { theme: 'system' } }],
    ['an extra appearance key', { appearance: { theme: 'dark', accent: 'red' } }],
    ['a flash speed it does not know', { appearance: { flash: { speed: 'blinding' } } }],
    ['a flash duration Settings does not offer', { appearance: { flash: { seconds: 4 } } }],
    ['an extra flash key', { appearance: { flash: { enabled: true, colour: 'red' } } }],
    ['a side it does not know', { layout: { projectColumn: 'top' } }],
    ['an extra layout key', { layout: { projectColumn: 'left', width: 400 } }],
    ['the schema version, which only migrations may set', { schemaVersion: 2 }],
    // M14b (C18, C21): a patch renames and switches. It sets no folder, and adds and removes nothing.
    ['a folder for an instance', { providers: { codex: { instances: { [INSTANCE]: { folder: 'D:\\accounts\\other' } } } } }],
    ['a folder for the first instance', { providers: { codex: { folder: 'D:\\accounts\\other' } } }],
    ['an instance named by something other than an id', { providers: { codex: { instances: { default: { enabled: false } } } } }],
    ['a list of instances', { providers: { codex: { instances: [{ id: INSTANCE, label: 'Work', folder: 'D:\\accounts\\work', enabled: true }] } } }],
    ['an id in an instance’s patch', { providers: { codex: { instances: { [INSTANCE]: { id: INSTANCE } } } } }],
    ['a label that is not text', { providers: { codex: { label: 7 } } }],
    ['an instance’s label cleared, which only the first instance’s may be', { providers: { codex: { instances: { [INSTANCE]: { label: null } } } } }],
    ['a label far past any length', { providers: { codex: { label: 'x'.repeat(257) } } }],
    ['a wrong type', { usage: { pollIntervalSec: 'fast' } }],
    ['a busy Enter it does not know', { composer: { busyEnter: 'later' } }],
    ['an extra composer key', { composer: { busyEnter: 'queue', sound: true } }],
    ['a half-written rectangle', { windows: { main: { bounds: { x: 1, y: 2 } } } }],
    // M103 (C2, C6, C27) and M104 (C24): one provider's models, a reference of the form or null.
    ['two providers’ avatars', { avatars: { assignments: { claude: { opus: null }, codex: { 'gpt-6-sol': null } } } }],
    ['more models than a catalog holds', { avatars: { assignments: { claude: Object.fromEntries(Array.from({ length: MAX_MODELS + 1 }, (_, index) => [`m-${index}`, null])) } } }],
    ['an avatar for no model', { avatars: { assignments: { claude: {} } } }],
    ['an avatar section with nothing in it', { avatars: { assignments: {} } }],
    ['the whole section', { avatars: { assignments: { claude: { opus: null } }, futureAvatars: true } }],
    ['a model key that is no catalog id', { avatars: { assignments: { claude: { 'not a key!': null } } } }],
    ['a reference with a path', { avatars: { assignments: { claude: { opus: { origin: 'user', family: 'Mine', avatar: 'A', path: 'C:\\art' } } } } }],
    ['a reference to a root it does not know', { avatars: { assignments: { claude: { opus: { origin: 'elsewhere', family: 'Mine', avatar: 'A' } } } } }],
    ['a reference with a name past 255 units', { avatars: { assignments: { claude: { opus: { origin: 'user', family: 'x'.repeat(256), avatar: 'A' } } } } }],
    ['a reference with an empty name', { avatars: { assignments: { claude: { opus: { origin: 'user', family: 'Mine', avatar: '' } } } } }],
    // Decision 0031: an active family of the form. Revision 15 (decision 0032): no overlay of the user's.
    ['an active family naming an avatar', { avatars: { active: { codex: { origin: 'built-in', family: 'Codex Spatial', avatar: 'Sol' } } } }],
    ['an active family in a root it does not know', { avatars: { active: { codex: { origin: 'elsewhere', family: 'X' } } } }],
    ['the overlay’s switch, which the preferences no longer hold', { avatars: { overlay: { enabled: false } } }],
    ['a family style, which is the family’s file’s alone', { avatars: { overlay: { families: { 'user/Mine': { size: 18 } } } } }],
    ['a model’s style or labels', { avatars: { overlay: { models: { codex: { 'gpt-6-sol': { name: 'Sun' } } } } } }],
    ['not an object', 42],
  ])('rejects %s', (_name, patch) => {
    expect(PreferencesPatchSchema.safeParse(patch).success).toBe(false);
  });
});

describe('applyPatch', () => {
  it('changes only what the patch names', () => {
    const current = PreferencesSchema.parse({ usage: { pollIntervalSec: 900 }, privacy: { maskEmail: false } });
    const next = applyPatch(current, { privacy: { maskEmail: true } });
    expect(next.privacy.maskEmail).toBe(true);
    expect(next.usage.pollIntervalSec).toBe(900);
  });

  it('clamps whatever a window sends', () => {
    expect(applyPatch(defaultPreferences(), { usage: { pollIntervalSec: 1 } }).usage.pollIntervalSec).toBe(POLL_INTERVAL_SEC.min);
    expect(applyPatch(defaultPreferences(), { audio: { volume: 9 } }).audio.volume).toBe(1);
  });

  it('merges one provider without dropping the others', () => {
    const current = PreferencesSchema.parse({
      providers: { claude: { enabled: true, executablePath: 'C:\\bin\\claude.exe' }, codex: { enabled: true, executablePath: null } },
    });
    const next = applyPatch(current, { providers: { claude: { enabled: false } } });
    expect(next.providers['claude']).toEqual({ enabled: false, executablePath: 'C:\\bin\\claude.exe', permissionMode: null });
    expect(next.providers['codex']).toEqual({ enabled: true, executablePath: null, permissionMode: null });
  });

  it('changes the theme and the column side, and nothing else', () => {
    const next = applyPatch(defaultPreferences(), { appearance: { theme: 'dark' }, layout: { projectColumn: 'right' } });
    expect(next).toEqual({ ...defaultPreferences(), appearance: { theme: 'dark', flash: DEFAULT_ATTENTION_FLASH, doneAnimation: 'animation-flash', creationAnimation: 'wipe' }, layout: { projectColumn: 'right' } });
    expect(applyPatch(next, { appearance: {} }).appearance.theme).toBe('dark');
  });

  it('changes one field of the flash, keeping the others and the theme', () => {
    const next = applyPatch({ ...defaultPreferences(), appearance: { theme: 'dark', flash: DEFAULT_ATTENTION_FLASH, doneAnimation: 'animation-flash', creationAnimation: 'wipe' } }, { appearance: { flash: { speed: 'slow' } } });
    expect(next.appearance).toEqual({ theme: 'dark', doneAnimation: 'animation-flash', creationAnimation: 'wipe', flash: { enabled: true, speed: 'slow', seconds: 3 } });
    expect(applyPatch(next, { appearance: { flash: { enabled: false, seconds: 10 } } }).appearance.flash).toEqual({ enabled: false, speed: 'slow', seconds: 10 });
  });

  it('leaves a provider’s controls alone for a patch of its instances, which main applies itself', () => {
    const current = PreferencesSchema.parse({ providers: { codex: { enabled: false, executablePath: 'C:\\bin\\codex.exe' } } });
    const next = applyPatch(current, { providers: { codex: { label: 'Personal', instances: { [INSTANCE]: { enabled: false } } } } });
    expect(next.providers['codex']).toEqual({ enabled: false, executablePath: 'C:\\bin\\codex.exe', permissionMode: null });
  });

  it('adds a provider it has never seen', () => {
    expect(applyPatch(defaultPreferences(), { providers: { codex: { enabled: false } } }).providers['codex']).toEqual({
      enabled: false,
      executablePath: null,
      permissionMode: null,
    });
  });

  it('changes what Enter does while a turn runs, and nothing else (M23, C80)', () => {
    const next = applyPatch(defaultPreferences(), { composer: { busyEnter: 'queue' } });
    expect(next).toEqual({ ...defaultPreferences(), composer: { busyEnter: 'queue' } });
    expect(applyPatch(next, { composer: {} }).composer.busyEnter).toBe('queue');
  });

  it('sets one model’s avatar, another model holding the same keeping it; the same again changes nothing; null clears (M103, C6; decision 0031)', () => {
    const X = { origin: 'built-in', family: 'Orange', avatar: 'X' } as const;
    const Y = { origin: 'user', family: 'Mine', avatar: 'Y' } as const;
    const current = PreferencesSchema.parse({ avatars: { assignments: { claude: { opus: X, sonnet: Y } } } });
    const shared = applyPatch(current, { avatars: { assignments: { codex: { 'gpt-6-sol': X } } } });
    expect(shared.avatars.assignments).toEqual({ claude: { opus: X, sonnet: Y }, codex: { 'gpt-6-sol': X } });
    expect(applyPatch(shared, { avatars: { assignments: { codex: { 'gpt-6-sol': X } } } })).toEqual(shared);
    expect(applyPatch(shared, { avatars: { assignments: { claude: { sonnet: null } } } }).avatars.assignments).toEqual({ claude: { opus: X }, codex: { 'gpt-6-sol': X } });
    expect(applyPatch(shared, { privacy: { maskEmail: false } }).avatars).toEqual(shared.avatars);
  });

  it('sets several models’ avatars of one provider in order (M104, C24)', () => {
    const X = { origin: 'built-in', family: 'Orange', avatar: 'X' } as const;
    const Y = { origin: 'user', family: 'Mine', avatar: 'Y' } as const;
    const Z = { origin: 'user', family: 'Mine', avatar: 'Z' } as const;
    const current = PreferencesSchema.parse({ avatars: { assignments: { claude: { opus: X, sonnet: Y }, codex: { 'gpt-6-sol': Z } } } });
    const next = applyPatch(current, { avatars: { assignments: { claude: { opus: Y, sonnet: X, haiku: Z, fable: null } } } });
    expect(next.avatars.assignments).toEqual({ claude: { opus: Y, sonnet: X, haiku: Z }, codex: { 'gpt-6-sol': Z } });
  });

  it('sets and clears an active family, leaving the overrides (decision 0031)', () => {
    const X = { origin: 'built-in', family: 'Orange', avatar: 'X' } as const;
    const current = PreferencesSchema.parse({ avatars: { assignments: { claude: { opus: X } } } });
    const next = applyPatch(current, { avatars: { active: { codex: { origin: 'built-in', family: 'Codex Elements' } } } });
    expect(next.avatars).toEqual({ assignments: { claude: { opus: X } }, active: { codex: { origin: 'built-in', family: 'Codex Elements' } } });
    const cleared = applyPatch(next, { avatars: { active: { codex: null } } });
    expect(cleared.avatars).toEqual({ assignments: { claude: { opus: X } }, active: {} });
  });

  it('keeps the schema version out of a window’s reach', () => {
    const next = applyPatch(defaultPreferences(), { privacy: { maskEmail: false } });
    expect(next.schemaVersion).toBe(PREFERENCES_VERSION);
  });

  it('does not mutate what it was given', () => {
    const current = defaultPreferences();
    const before = JSON.stringify(current);
    applyPatch(current, { audio: { muted: true }, providers: { claude: { enabled: false } } });
    expect(JSON.stringify(current)).toBe(before);
  });
});
