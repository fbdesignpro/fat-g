// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V15, V25 (docs/planning/_archive/M102.md, Design 5; C20, C29, C30, C33, C60, C71): the avatar catalog of
// both roots — each provider's default face from the first built-in family in name order, a user
// family's never; none for a provider no built-in family names; ids opaque, stable for a file
// unchanged and new for one changed; same-named families of both roots apart; and the
// families fat-g ships, scanned from the repository.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFORT_LOOK, FAMILY_DEFAULT_LAYER, mergeEffortStyles, mergeVersionStyles, type ModelLabel, NO_LABEL, resolveOverlay } from '@shared/contracts/avatar-overlay';
import { AVATAR_ID, type FamilyRef, MANIFEST_VERSION } from '@shared/contracts/avatars';
import { claudeModelLabel } from '../providers/claude/models';
import { codexModelLabel } from '../providers/codex/models';
import { createAvatarResolver } from './assignments';
import { pngBytes, webpBytes } from '../images/test-support';
import { avatarId, buildCatalog, countsLine } from './catalog';
import { nodeAvatarFs } from './fs';
import { scanRoot } from './scan';
import { avatarStandIn, type StandInNode } from './test-support';

const BUILT_IN = path.resolve('/built-in');
const USER = path.resolve('/user');
const KNOWN = new Set(['claude', 'codex']);
const SQUARE = pngBytes(8, 8);
const SMALL = webpBytes('VP8L', 4, 4);
const manifest = (body: object): Uint8Array => new TextEncoder().encode(JSON.stringify({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, ...body }));

async function catalogOf(builtIn: Readonly<Record<string, StandInNode>>, user: Readonly<Record<string, StandInNode>> = {}) {
  const files = { ...Object.fromEntries(Object.entries(builtIn).map(([relative, node]) => [path.join(BUILT_IN, relative), node])), ...Object.fromEntries(Object.entries(user).map(([relative, node]) => [path.join(USER, relative), node])) };
  const standIn = avatarStandIn(files);
  return buildCatalog([await scanRoot('built-in', BUILT_IN, standIn.fs), await scanRoot('user', USER, standIn.fs)], KNOWN);
}

describe('each family’s default and each provider’s built-in face (V6; C29, C30, C33; decision 0031)', () => {
  it.each(['any', 'claude', 'codex', 'future-provider'])('honours a family scoped to %s in its matches, default and starting-family selection', async (provider) => {
    const catalog = await catalogOf({
      'Scoped/family.json': manifest({ provider, defaultFor: ['claude', 'codex'], avatars: [{ folder: 'Match', matches: ['*'] }] }),
      'Scoped/Default/portrait.png': SQUARE,
      'Scoped/Match/portrait.png': SQUARE,
      'ZFallback/family.json': manifest({ defaultFor: ['claude', 'codex'] }),
      'ZFallback/Default/portrait.png': SQUARE,
    });
    const ref = { origin: 'built-in', family: 'Scoped' } as const;
    const family = catalog.family(ref);
    expect(catalog.listing.roots[0]?.families[0]?.provider).toBe(provider);
    const active = { claude: ref, codex: ref };
    const resolver = createAvatarResolver({ avatars: { ...catalog, assigned: (ref) => catalog.byRef(ref) }, preferences: () => ({ assignments: {}, active }) });
    for (const providerId of ['claude', 'codex']) {
      const supported = provider === 'any' || provider === providerId;
      expect(family?.usableFor(providerId)).toBe(supported);
      expect(family?.face(providerId)?.ref.family ?? null).toBe(supported ? 'Scoped' : null);
      expect(family?.match(providerId, { key: 'test', resolvedId: null })?.ref.avatar ?? null).toBe(supported ? 'Match' : null);
      expect(catalog.defaultFamily(providerId)?.family).toBe(supported ? 'Scoped' : 'ZFallback');
      expect(resolver.forModel(providerId, 'test')?.ref.family).toBe(supported ? 'Scoped' : 'ZFallback');
    }
  });

  it('is a family’s Default folder, listed first, for any provider; the built-in face the first built-in family’s in name order to name the provider its starting family', async () => {
    const catalog = await catalogOf({
      'Blue/family.json': manifest({
        defaultFor: ['codex', 'claude'],
        overlay: { version: { preset: 'band' } },
        // The Default's own entry is not read: its matches and its layer stand for nothing.
        avatars: [{ folder: 'Lu', matches: ['*luna*'] }, { folder: 'Default', matches: ['*'], overlay: { version: { preset: 'chip' } } }],
      }),
      'Blue/Lu/portrait.png': SQUARE,
      'Blue/Default/portrait.png': SQUARE,
      'Orange/family.json': manifest({ defaultFor: ['claude'] }),
      'Orange/Default/portrait.png': SQUARE,
      'Orange/Default/small.webp': SMALL,
    });
    const blue = catalog.listing.roots[0]?.families.find((family) => family.folder === 'Blue');
    expect(blue?.avatars.map((avatar) => [avatar.folder, avatar.fallback, avatar.matches])).toEqual([['Default', true, []], ['Lu', false, [{ provider: null, key: '*luna*' }]]]);
    expect(blue?.avatars[0]).not.toHaveProperty('overlay');
    expect(blue?.problems).toEqual([]);
    expect(blue?.defaultFor).toEqual(['codex', 'claude']);
    // Its style is the family's alone, with the name and version always, and the search passes it over: a
    // model nothing else matches falls to it as the face.
    expect(catalog.layers({ origin: 'built-in', family: 'Blue', avatar: 'Default' })).toEqual([{ version: { preset: 'band' } }, FAMILY_DEFAULT_LAYER]);
    expect(catalog.layers({ origin: 'built-in', family: 'Blue', avatar: 'Lu' })[0]).toEqual({ version: { preset: 'band' } });
    const index = catalog.family({ origin: 'built-in', family: 'Blue' });
    expect(index?.match('codex', { key: 'gpt-6-sol', resolvedId: null })).toBeNull();
    expect(index?.match('codex', { key: 'gpt-6-luna', resolvedId: null })?.ref.avatar).toBe('Lu');
    const codex = catalog.defaultFace('codex');
    expect(codex).toMatchObject({ ref: { origin: 'built-in', family: 'Blue', avatar: 'Default' }, small: null });
    expect(codex?.portrait).toMatch(AVATAR_ID);
    expect(index?.face('codex')).toBe(codex);
    // Blue comes before Orange by name: it is Claude's starting family too.
    expect(catalog.defaultFace('claude')?.ref).toEqual({ origin: 'built-in', family: 'Blue', avatar: 'Default' });
    expect([catalog.defaultFamily('claude'), catalog.defaultFamily('codex')]).toEqual([{ origin: 'built-in', family: 'Blue' }, { origin: 'built-in', family: 'Blue' }]);
    // The same object each time it is asked, for as long as this catalog stands.
    expect(catalog.defaultFace('codex')).toBe(codex);
    // A family's default is every provider's, named or not, and makes it one any provider may take.
    const orange = catalog.family({ origin: 'built-in', family: 'Orange' });
    expect(orange?.face('codex')?.ref).toEqual({ origin: 'built-in', family: 'Orange', avatar: 'Default' });
    expect(orange?.face('gemini')).toBe(orange?.face('codex'));
    expect([orange?.usableFor('codex'), orange?.usableFor('fixture')]).toEqual([true, true]);
  });

  it('is the small and the portrait the listing shows, each an id the catalog serves', async () => {
    const catalog = await catalogOf({ 'Orange/family.json': manifest({ defaultFor: ['claude'] }), 'Orange/Default/portrait.png': SQUARE, 'Orange/Default/small.webp': SMALL });
    const face = catalog.defaultFace('claude');
    expect(catalog.file(face?.portrait ?? '')).toMatchObject({ origin: 'built-in', mediaType: 'image/png', width: 8, height: 8, bytes: SQUARE.length, path: path.join(BUILT_IN, 'Orange', 'Default', 'portrait.png') });
    expect(catalog.file(face?.small ?? '')).toMatchObject({ mediaType: 'image/webp', width: 4 });
  });

  it('is the Default folder whatever the order the manifest lists, its name’s case aside, the others in the manifest’s order', async () => {
    const catalog = await catalogOf({ 'Orange/family.json': manifest({ defaultFor: ['claude'], avatars: [{ folder: 'Zed' }, { folder: 'default' }] }), 'Orange/Alpha/portrait.png': SQUARE, 'Orange/Zed/portrait.png': SQUARE, 'Orange/default/portrait.png': SQUARE });
    expect(catalog.defaultFace('claude')?.ref.avatar).toBe('default');
    expect(catalog.listing.roots[0]?.families[0]?.avatars.map((avatar) => [avatar.folder, avatar.fallback])).toEqual([['default', true], ['Zed', false], ['Alpha', false]]);
  });

  it('is the folder spelled Default before another case of it, which stands as an avatar of its own', async () => {
    const catalog = await catalogOf({ 'Orange/family.json': manifest({ defaultFor: ['claude'] }), 'Orange/default/portrait.png': SQUARE, 'Orange/Default/portrait.png': SQUARE, 'Orange/Op/portrait.png': SQUARE });
    const orange = catalog.listing.roots[0]?.families[0];
    expect(orange?.avatars.map((avatar) => [avatar.folder, avatar.fallback])).toEqual([['Default', true], ['default', false], ['Op', false]]);
    expect(catalog.defaultFace('claude')?.ref.avatar).toBe('Default');
  });

  it('is never a user family’s starting family or face, which the tab shows and nothing follows; its default stands once it is chosen', async () => {
    const catalog = await catalogOf({}, { 'Mine/family.json': manifest({ defaultFor: ['claude'] }), 'Mine/Me/portrait.png': SQUARE, 'Mine/Default/portrait.png': SQUARE });
    expect(catalog.defaultFace('claude')).toBeNull();
    expect(catalog.defaultFamily('claude')).toBeNull();
    const mine = catalog.listing.roots[1]?.families[0];
    expect([mine?.defaultFor, mine?.avatars.map((avatar) => [avatar.folder, avatar.fallback])]).toEqual([['claude'], [['Default', true], ['Me', false]]]);
    expect(catalog.family({ origin: 'user', family: 'Mine' })?.face('claude')?.ref).toEqual({ origin: 'user', family: 'Mine', avatar: 'Default' });
  });

  it('is none for a provider no built-in family names, one this build does not register, and a Default with no usable portrait', async () => {
    const catalog = await catalogOf({ 'Orange/family.json': manifest({ defaultFor: ['claude', 'gemini'] }), 'Orange/Default/small.webp': SMALL });
    expect(catalog.defaultFace('claude')).toBeNull();
    expect(catalog.defaultFace('codex')).toBeNull();
    expect(catalog.defaultFace('fixture')).toBeNull();
    expect(catalog.defaultFace('gemini')).toBeNull();
    expect(catalog.listing.roots[0]?.families[0]?.unknownProviders).toEqual(['gemini']);
    expect(catalog.listing.roots[0]?.families[0]?.avatars.map((avatar) => avatar.fallback)).toEqual([false]);
    expect(catalog.family({ origin: 'built-in', family: 'Orange' })?.usableFor('claude')).toBe(false);
  });

  it('is none for a family with no Default to draw, which says so, and none of its other avatars stands in for it', async () => {
    const catalog = await catalogOf({
      'Blue/family.json': manifest({ defaultFor: ['codex'], avatars: [{ folder: 'Lu', matches: ['*luna*'] }] }),
      'Blue/Lu/portrait.png': SQUARE,
      'Orange/family.json': manifest({ defaultFor: ['claude'] }),
      'Orange/Default/small.webp': SMALL,
      'Orange/Op/portrait.png': SQUARE,
    });
    const [blue, orange] = catalog.listing.roots[0]?.families ?? [];
    expect(blue?.problems).toEqual([{ kind: 'no-default', path: 'Blue' }]);
    expect(orange?.problems).toEqual([{ kind: 'no-default', path: 'Orange' }]);
    expect(blue?.avatars.map((avatar) => [avatar.folder, avatar.fallback])).toEqual([['Lu', false]]);
    expect(orange?.avatars.map((avatar) => [avatar.folder, avatar.fallback])).toEqual([['Default', false], ['Op', false]]);
    expect([catalog.defaultFace('codex'), catalog.defaultFace('claude')]).toEqual([null, null]);
    for (const family of ['Blue', 'Orange']) {
      const index = catalog.family({ origin: 'built-in', family });
      expect([index?.face('codex'), index?.usableFor('codex')], family).toEqual([null, false]);
    }
    // Its avatars are still listed, each still the avatar of its reference.
    expect(catalog.byRef({ origin: 'built-in', family: 'Blue', avatar: 'Lu' })?.ref.avatar).toBe('Lu');
  });

  it('passes over a family with no Default to draw for the next built-in family naming the provider its starting family', async () => {
    const catalog = await catalogOf({
      'Amber/family.json': manifest({ defaultFor: ['claude'] }),
      'Amber/Op/portrait.png': SQUARE,
      'Blue/family.json': manifest({ defaultFor: ['claude'] }),
      'Blue/Default/portrait.png': SQUARE,
    });
    expect(catalog.defaultFamily('claude')).toEqual({ origin: 'built-in', family: 'Blue' });
    expect(catalog.defaultFace('claude')?.ref).toEqual({ origin: 'built-in', family: 'Blue', avatar: 'Default' });
  });
});

describe('the match entries (M104, V5; C2)', () => {
  it('reach each avatar of the listing structured, in the manifest’s order, a provider id cleaned for display', async () => {
    const catalog = await catalogOf({
      'Orange/family.json': manifest({ avatars: [{ folder: 'Op', matches: ['*opus*', { provider: 'claude', key: 'claude-opus-5' }, { provider: ' codex', key: 'gpt-6-*' }] }] }),
      'Orange/Op/portrait.png': SQUARE,
      'Orange/Plain/portrait.png': SQUARE,
    });
    expect(catalog.listing.roots[0]?.families[0]?.avatars.map((avatar) => [avatar.folder, avatar.matches])).toEqual([
      ['Op', [{ provider: null, key: '*opus*' }, { provider: 'claude', key: 'claude-opus-5' }, { provider: 'codex', key: 'gpt-6-*' }]],
      ['Plain', []],
    ]);
  });
});

describe('an avatar by its reference (M103, V3; C11)', () => {
  it('is the avatar of that root, family and folder, the same object while the catalog stands, the face’s own for the face', async () => {
    const catalog = await catalogOf(
      { 'Orange/family.json': manifest({ defaultFor: ['claude'] }), 'Orange/Default/portrait.png': SQUARE, 'Orange/Op/portrait.png': SQUARE, 'Orange/Op/small.webp': SMALL },
      { 'Orange/Op/portrait.png': SQUARE },
    );
    const op = catalog.byRef({ origin: 'built-in', family: 'Orange', avatar: 'Op' });
    expect(op).toMatchObject({ ref: { origin: 'built-in', family: 'Orange', avatar: 'Op' }, portrait: expect.stringMatching(AVATAR_ID) as string, small: expect.stringMatching(AVATAR_ID) as string });
    expect(catalog.byRef({ origin: 'built-in', family: 'Orange', avatar: 'Op' })).toBe(op);
    // The user's family of the same name is another avatar, with its own file.
    expect(catalog.byRef({ origin: 'user', family: 'Orange', avatar: 'Op' })?.portrait).not.toBe(op?.portrait);
    expect(catalog.byRef({ origin: 'built-in', family: 'Orange', avatar: 'Default' })).toBe(catalog.defaultFace('claude'));
  });

  it('is none for a name the scan did not list, in another case, and for an avatar with no usable portrait', async () => {
    const catalog = await catalogOf({ 'Orange/Op/portrait.png': SQUARE, 'Orange/Sketch/small.webp': SMALL });
    expect(catalog.byRef({ origin: 'built-in', family: 'Orange', avatar: 'Gone' })).toBeNull();
    expect(catalog.byRef({ origin: 'built-in', family: 'Blue', avatar: 'Op' })).toBeNull();
    expect(catalog.byRef({ origin: 'built-in', family: 'orange', avatar: 'Op' })).toBeNull();
    expect(catalog.byRef({ origin: 'user', family: 'Orange', avatar: 'Op' })).toBeNull();
    expect(catalog.byRef({ origin: 'built-in', family: 'Orange', avatar: 'Sketch' })).toBeNull();
  });
});

describe('ids (V6, V16; C60)', () => {
  it('are opaque, within the route’s alphabet, and name no path', async () => {
    const catalog = await catalogOf({ 'Orange/Op 5.5 #1%?/portrait.png': SQUARE });
    const id = catalog.listing.roots[0]?.families[0]?.avatars[0]?.files[0]?.id ?? '';
    expect(id).toMatch(AVATAR_ID);
    expect(JSON.stringify(catalog.listing)).not.toContain(BUILT_IN);
  });

  it('stay for a file unchanged, and change with its size, its time, its path or its root', () => {
    const id = avatarId('built-in', 'Orange/Op/portrait.png', 100, 5);
    expect(avatarId('built-in', 'Orange/Op/portrait.png', 100, 5)).toBe(id);
    expect(new Set([id, avatarId('built-in', 'Orange/Op/portrait.png', 101, 5), avatarId('built-in', 'Orange/Op/portrait.png', 100, 6), avatarId('built-in', 'Orange/Op/small.png', 100, 5), avatarId('user', 'Orange/Op/portrait.png', 100, 5)]).size).toBe(5);
  });

  it('answer no file for an id the catalog did not mint', async () => {
    const catalog = await catalogOf({ 'Orange/Op/portrait.png': SQUARE });
    expect(catalog.file('0'.repeat(32))).toBeUndefined();
  });
});

describe('both roots together (V15; C20, C22, C37)', () => {
  it('keep a user family named like a built-in one beside it, each with its origin, never merged', async () => {
    const catalog = await catalogOf({ 'Orange/Op/portrait.png': SQUARE }, { 'Orange/Mine/portrait.png': SQUARE });
    expect(catalog.listing.roots.map((root) => [root.origin, root.families.map((family) => [family.origin, family.folder, family.avatars.map((entry) => entry.folder)])])).toEqual([
      ['built-in', [['built-in', 'Orange', ['Op']]]],
      ['user', [['user', 'Orange', ['Mine']]]],
    ]);
    const [builtIn, user] = catalog.listing.roots.map((root) => root.families[0]?.avatars[0]?.files[0]?.id);
    expect(builtIn).not.toBe(user);
  });

  it('count families, avatars and problems for the log line, which names nothing', async () => {
    const catalog = await catalogOf({ 'Orange/Op/portrait.png': SQUARE, 'Orange/Fa/portrait.png': SQUARE, 'Blue/Lu/portrait.png': SQUARE }, { 'Secret Family/Private/portrait.webp': SQUARE });
    const line = countsLine(catalog.counts);
    // Each family's file problems, and the three families' want of a Default.
    expect(line).toBe('[avatars] 2 built-in families, 3 avatars; 1 user family, 1 avatar, 5 problems');
    expect(line).not.toMatch(/Secret|Private|Orange/);
  });
});

describe('the families fat-g ships (V25; C42, C71)', () => {
  const CLAUDE = ['Default', 'Fable', 'Opus', 'Sonnet', 'Haiku'];
  const CODEX = ['Default', 'Astra', 'Sol', 'Terra', 'Luna'];
  /** The MTX art, each provider's in a family of its own, its Default code rain in the provider's colour. */
  const CLAUDE_MTX = ['Default', 'MTX-Fa', 'MTX-Op', 'MTX-So', 'MTX-Ha'];
  const CODEX_MTX = ['Default', 'MTX-Ast', 'MTX-Sol', 'MTX-Te', 'MTX-Lu'];
  /** The shipped families share their placement, with the family's own version effect. */
  const FLAT = { effect: 'plain', size: 16, textColor: '#ffffff', effectColor: '#000000', effectOpacity: 100, glowStrength: 100, backdrop: 'none', backdropColor: '#000000', backdropStrength: 75, position: 'top-right' };
  const FAMILY_LOOKS: Readonly<Record<string, typeof FLAT>> = {
    'Claude Anime': { ...FLAT, effect: 'outline', effectOpacity: 70 },
    'Claude Gradient': { ...FLAT, effect: 'glow', effectColor: '#ff7300', glowStrength: 200 },
    'Claude Lightning': { ...FLAT, effect: 'outline' },
    'Claude MTX': { ...FLAT, effect: 'outline' },
    'Codex Anime': { ...FLAT, effect: 'outline', effectOpacity: 70 },
    'Codex Gradient': FLAT,
    'Codex Lightning': { ...FLAT, effect: 'chip', size: 14, effectColor: '#001124' },
    'Codex MTX': { ...FLAT, effect: 'outline' },
  };

  it('are the Anime, Gradient, Lightning and MTX families of each provider, each led by its Default, the Lightning ones the providers’ starting families', async () => {
    const root = path.resolve(import.meta.dirname, '../../../assets/avatars');
    const catalog = buildCatalog([await scanRoot('built-in', root, nodeAvatarFs)], KNOWN);
    const families = catalog.listing.roots[0]?.families ?? [];
    expect(families.map((family) => [family.folder, family.avatars.map((entry) => entry.folder)])).toEqual([
      ['Claude Anime', CLAUDE],
      ['Claude Gradient', CLAUDE],
      ['Claude Lightning', CLAUDE],
      ['Claude MTX', CLAUDE_MTX],
      ['Codex Anime', CODEX],
      ['Codex Gradient', CODEX],
      ['Codex Lightning', CODEX],
      ['Codex MTX', CODEX_MTX],
    ]);
    for (const family of families) {
      expect(family.problems, family.folder).toEqual([]);
      expect([family.author, family.licence]).toEqual([null, null]);
      // The family layer is its Default's style; each version stays at the top right,
      // out of the marks' way at the bottom (decision 0032).
      expect(mergeVersionStyles([family.overlay?.version]).look, family.folder).toEqual(FAMILY_LOOKS[family.folder]);
      expect(mergeEffortStyles([family.overlay?.effort]), family.folder).toEqual({ show: true, look: DEFAULT_EFFORT_LOOK });
      expect(catalog.layers({ origin: 'built-in', family: family.folder, avatar: 'Default' }), family.folder).toEqual([family.overlay, FAMILY_DEFAULT_LAYER]);
      expect(family).not.toHaveProperty('name');
      for (const avatar of family.avatars) {
        expect(avatar.problems, `${family.folder}/${avatar.folder}`).toEqual([]);
        expect(avatar.files.map((file) => [file.role, file.format, file.width]), `${family.folder}/${avatar.folder}`).toEqual([['portrait', 'webp', 512], ['small', 'webp', 64]]);
        // The art spells the model's name and no version: each says the version alone, as the Default style
        // sets it, with no override; the Default says the name too, whatever the style (the maintainer).
        const drawn = resolveOverlay(catalog.layers({ origin: 'built-in', family: family.folder, avatar: avatar.folder }), { name: 'Mythos', version: '1' })?.text;
        expect([drawn?.name, drawn?.version, drawn?.look], `${family.folder}/${avatar.folder}`).toEqual([avatar.folder === 'Default' ? 'Mythos' : null, '1', FAMILY_LOOKS[family.folder]]);
        if (avatar.folder !== 'Default') expect(avatar.overlay ?? {}, `${family.folder}/${avatar.folder}`).toEqual({});
      }
      expect(family.overlay?.version?.parts, family.folder).toEqual({ name: false, version: true });
    }
    // Each named avatar matches the model it is named after, whatever its version, by key or resolved id;
    // each Default none (M104, C27).
    const claude = [['Default', []], ['Fable', [{ provider: null, key: '*fable*' }]], ['Opus', [{ provider: null, key: '*opus*' }]], ['Sonnet', [{ provider: null, key: '*sonnet*' }]], ['Haiku', [{ provider: null, key: '*haiku*' }]]];
    const codex = [['Default', []], ['Astra', [{ provider: null, key: '*-astra*' }]], ['Sol', [{ provider: null, key: '*-sol*' }]], ['Terra', [{ provider: null, key: '*-terra*' }]], ['Luna', [{ provider: null, key: '*-luna*' }]]];
    // The MTX avatars match as the others do, under their own folder names.
    const mtx = (entries: typeof claude, folders: readonly string[]) => entries.map(([, matches], index) => [folders[index], matches]);
    expect(families.map((family) => family.avatars.map((entry) => [entry.folder, entry.matches]))).toEqual([claude, claude, claude, mtx(claude, CLAUDE_MTX), codex, codex, codex, mtx(codex, CODEX_MTX)]);
    // Each family's default is its Default folder.
    expect(families.map((family) => family.avatars.filter((entry) => entry.fallback).map((entry) => entry.folder))).toEqual(families.map(() => ['Default']));
    // Only the Lightning families declare themselves as the providers' starting families.
    expect(families.map((family) => family.defaultFor)).toEqual([[], [], ['claude'], [], [], [], ['codex'], []]);
    expect(catalog.defaultFace('claude')?.ref).toEqual({ origin: 'built-in', family: 'Claude Lightning', avatar: 'Default' });
    expect(catalog.defaultFace('codex')?.ref).toEqual({ origin: 'built-in', family: 'Codex Lightning', avatar: 'Default' });
  });

  // Decisions 0031, 0032: the models as the fixtures of both CLIs list them, with no override, drawn
  // from each provider's active family as shipped, with the overlay their providers' rules give them.
  it('draw from each provider’s active family for the models each CLI lists, with no override', async () => {
    const catalog = buildCatalog([await scanRoot('built-in', path.resolve(import.meta.dirname, '../../../assets/avatars'), nodeAvatarFs)], KNOWN);
    const labels: Readonly<Record<string, (id: string) => ModelLabel>> = { claude: claudeModelLabel, codex: codexModelLabel };
    const active: Record<string, FamilyRef> = {};
    const resolver = createAvatarResolver({
      avatars: { assigned: (ref) => catalog.byRef(ref), defaultFace: (id) => catalog.defaultFace(id), family: (ref) => catalog.family(ref), defaultFamily: (id) => catalog.defaultFamily(id), layers: (ref) => catalog.layers(ref) },
      preferences: () => ({ assignments: {}, active }),
      label: (providerId, id) => labels[providerId]?.(id) ?? NO_LABEL,
    });
    const fixture = (file: string): unknown => JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../tests/fixtures', file), 'utf8'));
    const claude = (fixture('claude/models.json') as { models: { value: string; resolvedModel: string }[] }).models.map((entry) => ({ key: entry.value, resolvedId: entry.resolvedModel }));
    const codex = (fixture('codex/model-list.json') as { data: { id: string; model: string }[] }).data.map((entry) => ({ key: entry.id, resolvedId: entry.model }));
    const drawn = (providerId: string, models: readonly { key: string; resolvedId: string }[]) => models.map(({ key, resolvedId }) => {
      const avatar = resolver.forModel(providerId, key, resolvedId);
      const said = avatar?.overlay?.text;
      const text = said == null ? null : [said.name, said.version].filter((part) => part !== null).join(' ');
      // Every shipped avatar draws the marks, in fat-g's look: the effort is the session's, given where it is drawn.
      expect(avatar?.overlay?.effort, key).toEqual(DEFAULT_EFFORT_LOOK);
      return [key, avatar?.ref.family, avatar?.ref.avatar, avatar?.source, text];
    });
    // The lettered art says the version alone; the Default says the model's name too.
    expect(drawn('claude', claude)).toEqual([
      ['default', 'Claude Lightning', 'Opus', 'match', '5'],
      ['opus[1m]', 'Claude Lightning', 'Opus', 'match', '5'],
      ['claude-fable-5-1[1m]', 'Claude Lightning', 'Fable', 'match', '5.1'],
      ['sonnet', 'Claude Lightning', 'Sonnet', 'match', '5'],
      ['haiku', 'Claude Lightning', 'Haiku', 'match', '4.5'],
    ]);
    expect(drawn('codex', codex)).toEqual([
      ['gpt-6-astra', 'Codex Lightning', 'Astra', 'match', '6'],
      ['gpt-6-sol', 'Codex Lightning', 'Sol', 'match', '6'],
      ['gpt-6-luna', 'Codex Lightning', 'Luna', 'match', '6'],
      ['gpt-reserve', 'Codex Lightning', 'Default', 'family-face', null],
      ['gpt-5.6-sol', 'Codex Lightning', 'Sol', 'match', '5.6'],
      ['gpt-5.6-terra', 'Codex Lightning', 'Terra', 'match', '5.6'],
      ['gpt-5.6-luna', 'Codex Lightning', 'Luna', 'match', '5.6'],
      ['gpt-5.5', 'Codex Lightning', 'Default', 'family-face', '5.5'],
      ['codex-auto-review', 'Codex Lightning', 'Default', 'family-face', null],
    ]);
    // One look within each family, the Default's as the others'.
    const look = (providerId: string, key: string, resolvedId = key) => resolver.forModel(providerId, key, resolvedId)?.overlay?.text?.look;
    expect(look('claude', 'sonnet', 'claude-sonnet-5')).toEqual(FAMILY_LOOKS['Claude Lightning']);
    expect(look('codex', 'gpt-6-sol')).toEqual(FAMILY_LOOKS['Codex Lightning']);
    expect(look('codex', 'gpt-5.5')).toEqual(FAMILY_LOOKS['Codex Lightning']);
    // An explicit Gradient choice still selects that family's own art and style.
    active['claude'] = { origin: 'built-in', family: 'Claude Gradient' };
    active['codex'] = { origin: 'built-in', family: 'Codex Gradient' };
    expect(look('claude', 'sonnet', 'claude-sonnet-5')).toEqual(FAMILY_LOOKS['Claude Gradient']);
    expect(look('codex', 'gpt-6-sol')).toEqual(FAMILY_LOOKS['Codex Gradient']);
    expect(drawn('claude', claude).slice(2, 4)).toEqual([
      ['claude-fable-5-1[1m]', 'Claude Gradient', 'Fable', 'match', '5.1'],
      ['sonnet', 'Claude Gradient', 'Sonnet', 'match', '5'],
    ]);
    expect(drawn('codex', codex).slice(0, 4)).toEqual([
      ['gpt-6-astra', 'Codex Gradient', 'Astra', 'match', '6'],
      ['gpt-6-sol', 'Codex Gradient', 'Sol', 'match', '6'],
      ['gpt-6-luna', 'Codex Gradient', 'Luna', 'match', '6'],
      ['gpt-reserve', 'Codex Gradient', 'Default', 'family-face', null],
    ]);
    // And an Anime choice its own.
    active['claude'] = { origin: 'built-in', family: 'Claude Anime' };
    active['codex'] = { origin: 'built-in', family: 'Codex Anime' };
    expect(look('claude', 'sonnet', 'claude-sonnet-5')).toEqual(FAMILY_LOOKS['Claude Anime']);
    expect(look('codex', 'gpt-6-sol')).toEqual(FAMILY_LOOKS['Codex Anime']);
    expect(drawn('claude', claude).slice(2, 4)).toEqual([
      ['claude-fable-5-1[1m]', 'Claude Anime', 'Fable', 'match', '5.1'],
      ['sonnet', 'Claude Anime', 'Sonnet', 'match', '5'],
    ]);
    expect(drawn('codex', codex).slice(2, 4)).toEqual([
      ['gpt-6-luna', 'Codex Anime', 'Luna', 'match', '6'],
      ['gpt-reserve', 'Codex Anime', 'Default', 'family-face', null],
    ]);
    // And an MTX choice its own, an unmatched model drawing that provider's Default.
    active['claude'] = { origin: 'built-in', family: 'Claude MTX' };
    active['codex'] = { origin: 'built-in', family: 'Codex MTX' };
    expect(look('claude', 'sonnet', 'claude-sonnet-5')).toEqual(FAMILY_LOOKS['Claude MTX']);
    expect(look('codex', 'gpt-6-sol')).toEqual(FAMILY_LOOKS['Codex MTX']);
    expect(drawn('claude', claude).slice(2, 4)).toEqual([
      ['claude-fable-5-1[1m]', 'Claude MTX', 'MTX-Fa', 'match', '5.1'],
      ['sonnet', 'Claude MTX', 'MTX-So', 'match', '5'],
    ]);
    expect(drawn('codex', codex).slice(2, 4)).toEqual([
      ['gpt-6-luna', 'Codex MTX', 'MTX-Lu', 'match', '6'],
      ['gpt-reserve', 'Codex MTX', 'Default', 'family-face', null],
    ]);
  });
});
