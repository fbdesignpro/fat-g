// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3 (docs/planning/_archive/M103.md, Design 3; C3, C7, C9–C12, C14, C15; decisions 0031, 0032): what a
// model and a session resolve to — the override, then the active family's match, its face, the
// built-in face, then none — with the overlay, on a real avatar service over the file system
// stand-in, and the changes that ask again.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ATTENTION_FLASH } from '@shared/contracts/appearance';
import { DEFAULT_EFFORT_LOOK, type ModelLabel, NO_LABEL } from '@shared/contracts/avatar-overlay';
import { type ActiveFamilies, type Assignments, type AvatarRef, MANIFEST_VERSION, sameAvatar } from '@shared/contracts/avatars';
import type { CatalogState } from '@shared/contracts/catalog';
import { defaultPreferences, type PreferencesSnapshot } from '@shared/contracts/prefs';
import { sampleCatalogProvider, sampleModel, SAMPLE_CATALOG_PATH } from '../../../tests/support/catalog';
import { pngBytes } from '../images/test-support';
import { createAppStateStore } from '../state/app-state-store';
import { createAvatarResolver, followAvatarChanges } from './assignments';
import { createAvatarService } from './service';
import { avatarStandIn } from './test-support';

const BUILT_IN = path.resolve('/built-in');
const USER = path.resolve('/user');
const SQUARE = pngBytes(8, 8);
const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const manifest = (body: object): Uint8Array => new TextEncoder().encode(JSON.stringify({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, ...body }));

const OP: AvatarRef = { origin: 'built-in', family: 'Orange', avatar: 'Op' };
const DEFAULT: AvatarRef = { origin: 'built-in', family: 'Orange', avatar: 'Default' };
const ME: AvatarRef = { origin: 'user', family: 'Mine', avatar: 'Me' };
const planet = (avatar: string): AvatarRef => ({ origin: 'built-in', family: 'Planets', avatar });
const PLANETS = { origin: 'built-in', family: 'Planets' } as const;
const SHAPES = { origin: 'user', family: 'Shapes' } as const;

/** What a provider reads of Claude's ids, as its module would (decision 0032). */
const LABEL = (_providerId: string, id: string): ModelLabel => {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  return match === null ? NO_LABEL : { version: `${match[2]}.${match[3]}`, name: `${match[1]?.charAt(0).toUpperCase()}${match[1]?.slice(1)}` };
};

interface Settings {
  readonly assignments?: Assignments;
  readonly active?: ActiveFamilies;
}

async function setup(initial: Settings = {}) {
  const standIn = avatarStandIn({
    // Claude's starting family, first by name to name it so, its Default its default, with no match entry.
    [path.join(BUILT_IN, 'Orange', 'family.json')]: manifest({ defaultFor: ['claude'], avatars: [{ folder: 'Default' }] }),
    [path.join(BUILT_IN, 'Orange', 'Default', 'portrait.png')]: SQUARE,
    [path.join(BUILT_IN, 'Orange', 'Op', 'portrait.png')]: SQUARE,
    // An avatar with no usable portrait (M102, C10).
    [path.join(BUILT_IN, 'Orange', 'Sketch', 'small.png')]: SQUARE,
    // A family to make active: its Default — listed, its entry not read — then match entries of each strength, overlay layers.
    [path.join(BUILT_IN, 'Planets', 'family.json')]: manifest({
      overlay: { version: { preset: 'glow' }, effort: { position: 'top', size: 9 } },
      avatars: [
        { folder: 'Default', matches: ['*'] },
        { folder: 'Sun', matches: ['*opus*'], overlay: { version: { effectColor: '#ff9a1f' }, effort: { color: '#ff0000' } } },
        { folder: 'Earth', matches: ['*opus*'] },
        { folder: 'Moon', matches: [{ provider: 'claude', key: 'claude-opus-5-5' }], overlay: { effort: { show: false } } },
      ],
    }),
    [path.join(BUILT_IN, 'Planets', 'Sun', 'portrait.png')]: SQUARE,
    [path.join(BUILT_IN, 'Planets', 'Earth', 'portrait.png')]: SQUARE,
    [path.join(BUILT_IN, 'Planets', 'Moon', 'portrait.png')]: SQUARE,
    [path.join(BUILT_IN, 'Planets', 'Default', 'portrait.png')]: SQUARE,
    // A user family with no manifest: the scan makes its family.json with the defaults, which match
    // nothing; its Default is its default.
    [path.join(USER, 'Mine', 'Default', 'portrait.png')]: SQUARE,
    [path.join(USER, 'Mine', 'Me', 'portrait.png')]: SQUARE,
    // A user family with no avatar to draw, so it cannot stand as an active family.
    [path.join(USER, 'Blank', 'Sketch', 'small.png')]: SQUARE,
    // A user family whose avatar matches, but which has no Default: it cannot stand either.
    [path.join(USER, 'Lone', 'family.json')]: manifest({ avatars: [{ folder: 'Solo', matches: ['*opus*'] }] }),
    [path.join(USER, 'Lone', 'Solo', 'portrait.png')]: SQUARE,
    // A user family with a match entry and its Default.
    [path.join(USER, 'Shapes', 'family.json')]: manifest({ avatars: [{ folder: 'Square', matches: ['*sonnet*'] }] }),
    [path.join(USER, 'Shapes', 'Square', 'portrait.png')]: SQUARE,
    [path.join(USER, 'Shapes', 'Default', 'portrait.png')]: SQUARE,
  });
  const avatars = createAvatarService({ roots: { builtIn: BUILT_IN, user: USER }, fs: standIn.fs, providers: ['claude', 'codex'], log: { info: vi.fn(), warn: vi.fn() } });
  await avatars.scan();
  let held = { assignments: {}, active: {}, ...initial };
  const resolver = createAvatarResolver({ avatars, preferences: () => held, label: LABEL });
  return { standIn, avatars, resolver, assign: (next: Settings) => { held = { ...held, ...next }; } };
}

/** Claude's two accounts: `opus` and the listed default resolving to the same model, a hidden `haiku`; the second lists `opus` alone. */
const CATALOG: CatalogState = {
  providers: [
    sampleCatalogProvider({
      id: 'claude',
      models: [
        sampleModel({ key: 'default', resolvedId: 'claude-opus-5-5', listedDefault: true }),
        sampleModel({ key: 'opus', resolvedId: 'claude-opus-5-5', listedDefault: false }),
        sampleModel({ key: 'haiku', resolvedId: 'claude-haiku-5-5', listedDefault: false, hidden: true }),
      ],
    }),
    sampleCatalogProvider({ id: 'claude', instanceId: WORK, models: [sampleModel({ key: 'opus', resolvedId: 'claude-opus-5-5', listedDefault: false })] }),
  ],
  override: { kind: 'none', path: SAMPLE_CATALOG_PATH },
};
const FIRST = { providerId: 'claude', instanceId: 'default' };

describe('a model (V3; C10, C14)', () => {
  it('carries its own override by its key, else its provider’s default face, else none', async () => {
    const { resolver } = await setup({ assignments: { claude: { opus: OP } } });
    expect(resolver.forModel('claude', 'opus')).toMatchObject({ ref: OP, source: 'override' });
    expect(resolver.forModel('claude', 'sonnet')).toMatchObject({ ref: DEFAULT, source: 'family-face' });
    expect(resolver.forModel('codex', 'gpt-6-sol')).toBeNull();
  });

  it('draws the default face when it has none, whether or not the face is another model’s override', async () => {
    const { resolver } = await setup({ assignments: { claude: { sonnet: DEFAULT } } });
    expect(resolver.forModel('claude', 'sonnet')?.ref).toEqual(DEFAULT);
    expect(resolver.forModel('claude', 'opus')?.ref).toEqual(DEFAULT);
  });

  it('resolves alike as long as the scan stands', async () => {
    const { resolver } = await setup({ assignments: { claude: { opus: OP } } });
    expect(sameAvatar(resolver.forModel('claude', 'opus'), resolver.forModel('claude', 'opus'))).toBe(true);
  });
});

describe('the active family (decision 0031)', () => {
  it('draws the strongest match, at equal strength the first in the family’s order, then the family’s face', async () => {
    const { resolver } = await setup({ active: { claude: PLANETS } });
    expect(resolver.forModel('claude', 'opus')).toMatchObject({ ref: planet('Sun'), source: 'match' });
    // An exact key qualified for the provider is stronger than a pattern.
    expect(resolver.forModel('claude', 'opus', 'claude-opus-5-5')).toMatchObject({ ref: planet('Moon'), source: 'match' });
    // Nothing matches Sonnet: the Default's own `*` is not read, and it is drawn as the family's face.
    expect(resolver.forModel('claude', 'sonnet')).toMatchObject({ ref: planet('Default'), source: 'family-face' });
  });

  it('lets several models draw one avatar, and an override stand before the search', async () => {
    const { resolver } = await setup({ active: { claude: PLANETS }, assignments: { claude: { 'opus[1m]': OP } } });
    expect(resolver.forModel('claude', 'opus')?.ref).toEqual(planet('Sun'));
    expect(resolver.forModel('claude', 'claude-opus-6')?.ref).toEqual(planet('Sun'));
    expect(resolver.forModel('claude', 'opus[1m]')).toMatchObject({ ref: OP, source: 'override' });
  });

  it('falls to the chosen family’s own Default, whatever the provider: never the built-in family’s', async () => {
    const { resolver } = await setup({ active: { claude: SHAPES, codex: { origin: 'user', family: 'Mine' } } });
    expect(resolver.forModel('claude', 'sonnet')).toMatchObject({ ref: { origin: 'user', family: 'Shapes', avatar: 'Square' }, source: 'match' });
    expect(resolver.forModel('claude', 'haiku')).toMatchObject({ ref: { origin: 'user', family: 'Shapes', avatar: 'Default' }, source: 'family-face' });
    // A family whose file names no provider and matches nothing stands for any provider by its Default.
    expect(resolver.forModel('codex', 'gpt-6-sol')).toMatchObject({ ref: { origin: 'user', family: 'Mine', avatar: 'Default' }, source: 'family-face' });
  });

  it.each([
    ['a family the scan does not list', { origin: 'user', family: 'Gone' } as const],
    ['a family with no avatar to draw', { origin: 'user', family: 'Blank' } as const],
    // Its Solo matches `opus`, and is not drawn: a family with no Default is not used at all.
    ['a family with no Default', { origin: 'user', family: 'Lone' } as const],
  ])('stands aside for the built-in family when the choice is %s', async (_name, chosen) => {
    const { resolver } = await setup({ active: { claude: chosen } });
    expect(resolver.forModel('claude', 'opus')).toMatchObject({ ref: DEFAULT, source: 'family-face' });
  });

  it('is asked at each resolution, so a change of family is drawn at once', async () => {
    const { resolver, assign } = await setup();
    expect(resolver.forModel('claude', 'opus')?.ref).toEqual(DEFAULT);
    assign({ active: { claude: PLANETS } });
    expect(resolver.forModel('claude', 'opus')?.ref).toEqual(planet('Sun'));
  });
});

describe('the overlay (decision 0032)', () => {
  it('draws the version its provider reads, in the family file’s layers, the family’s then the avatar’s', async () => {
    const { resolver } = await setup({ active: { claude: PLANETS } });
    expect(resolver.forModel('claude', 'opus', 'claude-opus-5-5')?.overlay?.text).toMatchObject({ name: null, version: '5.5', look: { effect: 'glow', effectColor: '#7fc4ff' } });
    expect(resolver.forModel('claude', 'claude-opus-5-5')?.ref).toEqual(planet('Moon'));
    // Sun's own layer over the family's glow; `opus` alone says no version, so no text is drawn.
    expect(resolver.forModel('claude', 'claude-sonnet-5-1', null)?.overlay?.text).toMatchObject({ version: '5.1', look: { effect: 'glow' } });
    expect(resolver.forModel('claude', 'opus')?.overlay?.text).toBeNull();
    expect(resolver.forModel('claude', 'claude-opus-6-0')).toMatchObject({ ref: planet('Sun'), overlay: { text: { version: '6.0', look: { effectColor: '#ff9a1f' } } } });
  });

  it('draws the marks in the family’s look and the avatar’s own, carrying no effort of its own', async () => {
    const { resolver } = await setup({ active: { claude: PLANETS } });
    // Sun: the family's top edge and size, its own colour.
    expect(resolver.forModel('claude', 'claude-opus-6-0')?.overlay?.effort).toEqual({ ...DEFAULT_EFFORT_LOOK, position: 'top', size: 9, color: '#ff0000' });
    // Earth takes the family's alone; Moon hides its marks and still draws its text.
    expect(resolver.forModel('claude', 'claude-sonnet-5-1', null)?.overlay?.effort).toEqual({ ...DEFAULT_EFFORT_LOOK, position: 'top', size: 9 });
    expect(resolver.forModel('claude', 'opus', 'claude-opus-5-5')?.overlay).toMatchObject({ text: { version: '5.5' }, effort: null });
    // A model whose identifiers say no version draws the marks alone.
    const marks = { ...DEFAULT_EFFORT_LOOK, position: 'top', size: 9, color: '#ff0000' } as const;
    expect(resolver.forModel('claude', 'opus')?.overlay).toEqual({ text: null, effort: marks, fast: marks });
    expect(JSON.stringify(resolver.forModel('claude', 'claude-opus-6-0'))).not.toMatch(/medium|high|ultra/);
  });

  it('is the same for every model the preferences hold, which hold no style', async () => {
    const { resolver } = await setup({ active: { claude: PLANETS }, assignments: { claude: { haiku: OP } } });
    // An override from another family takes that family's layers, Orange's: none of its own.
    expect(resolver.forModel('claude', 'haiku', 'claude-haiku-4-5')?.overlay).toMatchObject({ text: { version: '4.5', look: { effect: 'outline' } }, effort: DEFAULT_EFFORT_LOOK });
  });

  it('reads a session model the catalog does not list by the id it reports', async () => {
    const { resolver } = await setup();
    expect(resolver.forSession(undefined, FIRST, 'claude-fable-5-1')?.overlay?.text).toMatchObject({ version: '5.1' });
  });
});

describe('a session (V3; C3, C9, C15)', () => {
  it('keeps a version image on its resolved id when the CLI moves the alias to a newer model', async () => {
    const assignments: Assignments = { claude: { opus: ME, 'claude-opus-5-5': OP } };
    const { resolver } = await setup({ assignments });
    expect(resolver.forModel('claude', 'opus', 'claude-opus-5-5')?.ref).toEqual(OP);
    expect(resolver.forSession(CATALOG, FIRST, 'opus')?.ref).toEqual(OP);
    expect(resolver.forSession(CATALOG, FIRST, 'claude-opus-5-5')?.ref).toEqual(OP);
    const newer: CatalogState = { ...CATALOG, providers: CATALOG.providers.map((provider) => ({
      ...provider, models: provider.models.map((model) => model.key === 'opus' || model.key === 'default' ? { ...model, resolvedId: 'claude-opus-6' } : model),
    })) };
    expect(resolver.forSession(newer, FIRST, 'opus')?.ref).toEqual(ME);
    expect(resolver.forSession(newer, FIRST, 'claude-opus-6')?.ref).toEqual(ME);
    expect(resolver.forSession(newer, FIRST, 'claude-opus-5-5')?.ref).toEqual(OP);
    expect(assignments['claude']).toEqual({ opus: ME, 'claude-opus-5-5': OP });
  });

  it('uses the version id across different aliases and accounts, and without a catalog', async () => {
    const { resolver } = await setup({ assignments: { claude: { 'claude-opus-5-5': OP } } });
    expect(resolver.forSession(CATALOG, FIRST, 'default')?.ref).toEqual(OP);
    expect(resolver.forSession(CATALOG, { providerId: 'claude', instanceId: WORK }, 'opus')?.ref).toEqual(OP);
    expect(resolver.forSession(undefined, FIRST, 'claude-opus-5-5')?.ref).toEqual(OP);
    expect(resolver.forModel('claude', 'opus', null)?.ref).toEqual(DEFAULT);
  });

  it.each([
    ['its key', 'opus'],
    ['its resolved id, the row that is not the listed default', 'claude-opus-5-5'],
  ])('carries its model in force’s override, found by %s', async (_name, reported) => {
    const { resolver } = await setup({ assignments: { claude: { opus: OP } } });
    expect(resolver.forSession(CATALOG, FIRST, reported)?.ref).toEqual(OP);
  });

  it('carries a hidden model’s, and one the catalog does not know by the id it reports', async () => {
    const { resolver } = await setup({ assignments: { claude: { haiku: OP, 'claude-sonnet-9': ME } } });
    expect(resolver.forSession(CATALOG, FIRST, 'haiku')?.ref).toEqual(OP);
    expect(resolver.forSession(CATALOG, FIRST, 'claude-sonnet-9')?.ref).toEqual(ME);
  });

  it('resolves alike on either account of the provider, and when held on one no longer configured', async () => {
    const { resolver } = await setup({ assignments: { claude: { opus: OP } } });
    expect(resolver.forSession(CATALOG, { providerId: 'claude', instanceId: WORK }, 'claude-opus-5-5')?.ref).toEqual(OP);
    const gone = { providerId: 'claude', instanceId: '7c1d9e2a-3b4c-4d5e-8f6a-1b2c3d4e5f60' };
    expect(resolver.forSession(CATALOG, gone, 'opus')?.ref).toEqual(OP);
    expect(resolver.forSession(undefined, FIRST, 'opus')?.ref).toEqual(OP);
    // With no catalog entry the reported id is the key: a resolved id finds no override, and the face stands.
    expect(resolver.forSession(CATALOG, gone, 'claude-opus-5-5')?.ref).toEqual(DEFAULT);
  });

  it('carries the default face on a model with no override', async () => {
    const { resolver } = await setup({ assignments: { claude: { opus: OP } } });
    expect(resolver.forSession(CATALOG, FIRST, 'haiku')?.ref).toEqual(DEFAULT);
  });

  // M106 (V4; C14, C17): a sub-agent is resolved by its model as a session is — by the alias its tool
  // use asked for until its own frames name the id, which then finds the model's row.
  it('resolves a sub-agent’s alias the catalog does not list to the face, and the id its frames name to that model’s override', async () => {
    const { resolver } = await setup({ assignments: { claude: { opus: OP } } });
    expect(resolver.forSession(CATALOG, FIRST, 'sonnet')?.ref).toEqual(DEFAULT);
    expect(resolver.forSession(CATALOG, FIRST, 'claude-opus-5-5')?.ref).toEqual(OP);
  });
});

describe('a reference that resolves past itself (V3; C7, C11)', () => {
  it.each<[string, AvatarRef]>([
    ['an avatar the scan did not list', { ...OP, avatar: 'Gone' }],
    ['a family the scan did not list', { ...OP, family: 'Gone' }],
    ['the same names in the other root', { ...OP, origin: 'user' }],
    ['an avatar with no usable portrait', { ...OP, avatar: 'Sketch' }],
  ])('carries the default face for %s, the override kept', async (_name, ref) => {
    const assignments = { claude: { opus: ref } };
    const { resolver } = await setup({ assignments });
    expect(resolver.forModel('claude', 'opus')?.ref).toEqual(DEFAULT);
    expect(assignments).toEqual({ claude: { opus: ref } });
  });

  it('falls back when a Rescan no longer lists its family, and comes back when one lists it again', async () => {
    const { resolver, avatars, standIn } = await setup({ assignments: { claude: { opus: ME } } });
    expect(resolver.forModel('claude', 'opus')?.ref).toEqual(ME);
    standIn.remove(path.join(USER, 'Mine'));
    await avatars.scan();
    expect(resolver.forModel('claude', 'opus')?.ref).toEqual(DEFAULT);
    standIn.set(path.join(USER, 'Mine', 'Me', 'portrait.png'), SQUARE);
    await avatars.scan();
    expect(resolver.forModel('claude', 'opus')?.ref).toEqual(ME);
  });
});

describe('the changes that ask again (V3; C12)', () => {
  function fakePrefs(assignments: Assignments) {
    let snapshot: PreferencesSnapshot = { rev: 0, values: { ...defaultPreferences(), avatars: { assignments, active: {} } }, status: { kind: 'ok' }, providerIssues: {}, instances: {} };
    const listeners = new Set<(value: PreferencesSnapshot) => void>();
    return {
      getSnapshot: () => snapshot,
      subscribe(listener: (value: PreferencesSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      change(values: Partial<PreferencesSnapshot['values']>) {
        snapshot = { ...snapshot, rev: snapshot.rev + 1, values: { ...snapshot.values, ...values } };
        for (const listener of listeners) listener(snapshot);
      },
    };
  }

  function follow() {
    const prefs = fakePrefs({ claude: { opus: OP } });
    const store = createAppStateStore();
    const calls: string[] = [];
    const stop = followAvatarChanges({ prefs, store, catalog: { avatarsChanged: () => calls.push('catalog') }, sessions: { avatarsChanged: () => calls.push('sessions') } });
    return { prefs, store, calls, stop };
  }

  it('asks the models, then the sessions, when the overrides change, and neither at another preference', () => {
    const { prefs, calls } = follow();
    prefs.change({ appearance: { theme: 'dark', flash: DEFAULT_ATTENTION_FLASH, doneAnimation: 'animation-flash', creationAnimation: 'wipe' } });
    prefs.change({ avatars: { assignments: { claude: { opus: OP } }, active: {} } });
    expect(calls).toEqual([]);
    prefs.change({ avatars: { assignments: { claude: { sonnet: OP } }, active: {} } });
    expect(calls).toEqual(['catalog', 'sessions']);
  });

  it('asks again when an active family changes', () => {
    const { prefs, calls } = follow();
    prefs.change({ avatars: { assignments: { claude: { opus: OP } }, active: { claude: PLANETS } } });
    prefs.change({ avatars: { assignments: { claude: { opus: OP } }, active: { claude: SHAPES } } });
    expect(calls).toEqual(['catalog', 'sessions', 'catalog', 'sessions']);
  });

  it('asks the sessions when the catalog changes, once the change has reached every listener', async () => {
    const { store, calls } = follow();
    const catalog: CatalogState = { providers: [], override: { kind: 'none', path: SAMPLE_CATALOG_PATH } };
    store.setCatalog(catalog);
    expect(calls).toEqual([]);
    await Promise.resolve();
    expect(calls).toEqual(['sessions']);
    store.setZoom(110);
    await Promise.resolve();
    expect(calls).toEqual(['sessions']);
  });

  it('asks nothing once stopped', async () => {
    const { prefs, store, calls, stop } = follow();
    stop();
    prefs.change({ avatars: { assignments: {}, active: {} } });
    store.setCatalog({ providers: [], override: { kind: 'none', path: SAMPLE_CATALOG_PATH } });
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});
