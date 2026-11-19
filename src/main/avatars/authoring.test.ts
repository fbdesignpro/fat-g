// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0031: a family's family.json written — made with fat-g's defaults where a family holding
// avatars has none, opened as the editor edits it, and saved from a draft and the revision it was made
// from — on the recording stand-in: what is kept of the file, what is refused, and what is never
// written.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FamilyDraft, SaveFamilyRequest } from '@shared/contracts/avatar-family';
import { SEEDED_OVERLAY } from '@shared/contracts/avatar-overlay';
import { MANIFEST_VERSION } from '@shared/contracts/avatars';
import { pngBytes } from '../images/test-support';
import { openFamily, revisionOf, saveFamily, seededManifest, seedMissing } from './authoring';
import { buildCatalog } from './catalog';
import type { AvatarFs } from './fs';
import { parseManifest } from './manifest';
import { scanRoot } from './scan';
import { avatarStandIn, type AvatarStandIn, type StandInNode } from './test-support';

const USER = path.resolve('/user');
const SQUARE = pngBytes(8, 8);
const KNOWN = new Set(['claude', 'codex']);
const at = (...parts: string[]): string => path.join(USER, ...parts);
const encode = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const v3 = (body: object): Uint8Array => encode({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, ...body });
const writes = (standIn: AvatarStandIn) => standIn.calls.filter((call) => call.op === 'writeText');

/** The user root's scan and one of its families, as the service holds them. */
async function scanned(standIn: AvatarStandIn, folder: string, fs: AvatarFs = standIn.fs) {
  const root = await scanRoot('user', USER, fs);
  const family = root.families.find((candidate) => candidate.folder === folder);
  if (family === undefined) throw new Error(`no family ${folder}`);
  return { root, family };
}

describe('the file made where a family has none', () => {
  it('holds fat-g’s defaults whole, at version 7, the avatars but the Default in name order with no match, as 2-space JSON with a final newline', () => {
    // The Default's style is the family's: it is no entry of the file. Where both `Default` and another
    // case of it stand, `Default` is the default and the other an avatar like the others.
    const text = seededManifest(['Ann', 'Default', 'Me', 'default']);
    expect(JSON.parse(text)).toEqual({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, provider: 'any', overlay: SEEDED_OVERLAY, avatars: [{ folder: 'Ann', matches: [] }, { folder: 'Me', matches: [] }, { folder: 'default', matches: [] }] });
    // Alone, another case of it is the default.
    expect((JSON.parse(seededManifest(['Ann', 'default'])) as { avatars: unknown[] }).avatars).toEqual([{ folder: 'Ann', matches: [] }]);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text).toContain('\n  "schemaVersion": 7,');
    expect(parseManifest(encode(text))).toMatchObject({ kind: 'applied' });
  });

  it('is written for a family holding an avatar and no file, in its own folder', async () => {
    const standIn = avatarStandIn({ [at('Mine', 'Me', 'portrait.png')]: SQUARE, [at('Mine', 'Ann', 'portrait.png')]: SQUARE, [at('Mine', 'Default', 'portrait.png')]: SQUARE });
    const root = await scanRoot('user', USER, standIn.fs);
    expect(await seedMissing(root, standIn.fs)).toBe(1);
    expect(writes(standIn).map((call) => call.path)).toEqual([at('Mine', 'family.json')]);
    expect(standIn.text(at('Mine', 'family.json'))).toBe(seededManifest(['Ann', 'Me']));
    expect((JSON.parse(standIn.text(at('Mine', 'family.json')) ?? '{}') as { avatars: { folder: string }[] }).avatars.map((avatar) => avatar.folder)).toEqual(['Ann', 'Me']);
    // Read again, the family is its file's.
    expect((await scanRoot('user', USER, standIn.fs)).families[0]?.manifest).toMatchObject({ kind: 'applied' });
  });

  it.each<[string, Readonly<Record<string, StandInNode>>]>([
    ['a family with a file it uses', { [at('Mine', 'family.json')]: v3({}), [at('Mine', 'Me', 'portrait.png')]: SQUARE }],
    ['a family whose file it refuses', { [at('Mine', 'family.json')]: encode({ schemaVersion: 2, minReaderVersion: 2 }), [at('Mine', 'Me', 'portrait.png')]: SQUARE }],
    ['a family whose file is not JSON', { [at('Mine', 'family.json')]: encode('{'), [at('Mine', 'Me', 'portrait.png')]: SQUARE }],
    ['a family whose file is a link', { [at('Mine', 'family.json')]: { link: '/elsewhere/family.json' }, [at('Mine', 'Me', 'portrait.png')]: SQUARE }],
    ['a family with no avatar', { [at('Mine', 'notes.txt')]: encode('notes'), [at('Empty')]: { folder: true } }],
    ['a linked family', { [at('Mine')]: { link: '/elsewhere/Mine' } }],
  ])('is not written for %s', async (_name, tree) => {
    const standIn = avatarStandIn(tree);
    const root = await scanRoot('user', USER, standIn.fs);
    expect(await seedMissing(root, standIn.fs)).toBe(0);
    expect(writes(standIn)).toEqual([]);
  });

  it('is not written over a file the scan did not take for the manifest, as a Family.json on a system that keeps one case', async () => {
    const standIn = avatarStandIn({ [at('Mine', 'Family.json')]: encode('{"mine": true}'), [at('Mine', 'Me', 'portrait.png')]: SQUARE });
    // The system answers for family.json what it holds as Family.json.
    const folded: AvatarFs = { ...standIn.fs, lstat: (target) => standIn.fs.lstat(target.replace(/family\.json$/, 'Family.json')) };
    const root = await scanRoot('user', USER, folded);
    expect(root.families[0]?.manifest).toEqual({ kind: 'none' });
    expect(await seedMissing(root, folded)).toBe(0);
    expect(writes(standIn)).toEqual([]);
    expect(standIn.text(at('Mine', 'Family.json'))).toBe('{"mine": true}');
  });

  it('is not written where the family’s folder has become a link, or its real path left the root', async () => {
    const swapped = avatarStandIn({ [at('Mine', 'Me', 'portrait.png')]: SQUARE });
    const before = await scanRoot('user', USER, swapped.fs);
    swapped.remove(at('Mine'));
    swapped.set(at('Mine'), { link: '/elsewhere' });
    expect(await seedMissing(before, swapped.fs)).toBe(0);
    const moved = avatarStandIn({ [at('Mine', 'Me', 'portrait.png')]: SQUARE });
    moved.real.set(at('Mine'), path.resolve('/elsewhere/Mine'));
    expect(await seedMissing(await scanRoot('user', USER, moved.fs), moved.fs)).toBe(0);
    expect([...writes(swapped), ...writes(moved)]).toEqual([]);
  });

  it('leaves the family as its folders when the write fails, and goes on to the next', async () => {
    const standIn = avatarStandIn({ [at('A', 'Me', 'portrait.png')]: SQUARE, [at('B', 'Me', 'portrait.png')]: SQUARE });
    const root = await scanRoot('user', USER, standIn.fs);
    const refusing: AvatarFs = { ...standIn.fs, writeText: (target, text) => (target === at('A', 'family.json') ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) : standIn.fs.writeText(target, text)) };
    expect(await seedMissing(root, refusing)).toBe(1);
    expect(standIn.text(at('B', 'family.json'))).toBeDefined();
    expect(standIn.text(at('A', 'family.json'))).toBeUndefined();
  });

  it('writes nothing for a root that could not be read', async () => {
    const standIn = avatarStandIn();
    expect(await seedMissing({ origin: 'user', realRoot: null, families: [], problems: [] }, standIn.fs)).toBe(0);
  });
});

describe('a family opened for the editor', () => {
  const file = {
    overlay: { version: { preset: 'glow', size: 99 }, effort: { position: 'top' } },
    avatars: [
      { folder: 'Sun', matches: ['*-sol*', { provider: 'codex', key: 'gpt-6-sol', weight: 2 }], overlay: { effort: { color: '#ff0000' } } },
      { folder: 'Gone', matches: ['*-gone*'] },
      { folder: 'Sun', matches: ['twice'] },
    ],
    defaultFor: ['codex', 'gemini'],
  };
  const tree = { [at('Planets', 'family.json')]: v3(file), [at('Planets', 'Sun', 'portrait.png')]: SQUARE, [at('Planets', 'Moon', 'portrait.png')]: SQUARE };

  it('is the file as read field by field: its entries in its order, then the folders it does not list; the missing named', async () => {
    const standIn = avatarStandIn(tree);
    const { root, family } = await scanned(standIn, 'Planets');
    const source = await openFamily(root, family, true, standIn.fs);
    expect(source).toEqual({
      ref: { origin: 'user', family: 'Planets' },
      lock: null,
      revision: createHash('sha256').update(v3(file)).digest('hex'),
      draft: {
        provider: 'any',
        overlay: { version: { preset: 'glow' }, effort: { position: 'top' } },
        avatars: [
          { folder: 'Sun', matches: ['*-sol*', { provider: 'codex', key: 'gpt-6-sol' }], overlay: { effort: { color: '#ff0000' } } },
          { folder: 'Gone', matches: ['*-gone*'], overlay: {} },
          { folder: 'Moon', matches: [], overlay: {} },
        ],
      },
      missing: ['Gone'],
    });
    expect(writes(standIn)).toEqual([]);
  });

  it('is its folders with fat-g’s defaults, and no revision, where it has no file', async () => {
    const standIn = avatarStandIn({ [at('Planets', 'Sun', 'portrait.png')]: SQUARE, [at('Planets', 'Default', 'portrait.png')]: SQUARE });
    const { root, family } = await scanned(standIn, 'Planets');
    expect(await openFamily(root, family, true, standIn.fs)).toEqual({ ref: { origin: 'user', family: 'Planets' }, lock: null, revision: null, draft: { provider: 'any', overlay: SEEDED_OVERLAY, avatars: [{ folder: 'Sun', matches: [], overlay: {} }] }, missing: [] });
  });

  it('keeps its Default apart, its style the family’s: no entry of the draft, whether the file lists it or not', async () => {
    const standIn = avatarStandIn({
      [at('Planets', 'family.json')]: v3({ overlay: { version: { preset: 'band' } }, avatars: [{ folder: 'Default', matches: ['*'], overlay: { version: { preset: 'chip' } } }, { folder: 'Sun' }] }),
      [at('Planets', 'Default', 'portrait.png')]: SQUARE,
      [at('Planets', 'Sun', 'portrait.png')]: SQUARE,
    });
    const { root, family } = await scanned(standIn, 'Planets');
    const source = await openFamily(root, family, true, standIn.fs);
    expect(source.draft).toEqual({ provider: 'any', overlay: { version: { preset: 'band' } }, avatars: [{ folder: 'Sun', matches: [], overlay: {} }] });
    expect(source.missing).toEqual([]);
  });

  it('is locked where fat-g may not write its root, as fat-g’s own art in an installed copy', async () => {
    const standIn = avatarStandIn(tree);
    const { root, family } = await scanned(standIn, 'Planets');
    expect((await openFamily(root, family, false, standIn.fs)).lock).toEqual({ kind: 'packaged' });
  });

  it('is locked with the cause where fat-g refuses its file, which it shows as its folders', async () => {
    const standIn = avatarStandIn({ [at('Planets', 'family.json')]: encode({ schemaVersion: 2, minReaderVersion: 2, avatars: [{ folder: 'Sun', matches: ['x'] }] }), [at('Planets', 'Sun', 'portrait.png')]: SQUARE });
    const { root, family } = await scanned(standIn, 'Planets');
    const source = await openFamily(root, family, true, standIn.fs);
    expect(source.lock).toEqual({ kind: 'manifest', cause: 'older', field: null });
    expect(source.draft.avatars).toEqual([{ folder: 'Sun', matches: [], overlay: {} }]);
    expect(source.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is locked where its folder or its file is a link', async () => {
    const linkedFile = avatarStandIn({ [at('Planets', 'family.json')]: { link: '/elsewhere/family.json' }, [at('Planets', 'Sun', 'portrait.png')]: SQUARE });
    const one = await scanned(linkedFile, 'Planets');
    expect((await openFamily(one.root, one.family, true, linkedFile.fs)).lock).toEqual({ kind: 'link' });
    const moved = avatarStandIn(tree);
    moved.real.set(at('Planets'), path.resolve('/elsewhere/Planets'));
    const two = await scanned(moved, 'Planets');
    expect((await openFamily(two.root, two.family, true, moved.fs)).lock).toEqual({ kind: 'link' });
  });
});

describe('a draft saved', () => {
  const raw = {
    schemaVersion: MANIFEST_VERSION,
    minReaderVersion: MANIFEST_VERSION,
    name: 'An old name',
    author: 'Someone',
    future: { x: 1 },
    overlay: { version: { preset: 'glow', font: 'serif' }, effort: { size: 5 }, glitter: true },
    avatars: [
      { folder: 'Sun', matches: ['*-sol*'], mood: 'warm', overlay: { version: { size: 20 }, sparkle: 1 } },
      { folder: 'Gone', matches: ['*-gone*'], kept: true },
    ],
    defaultFor: ['codex', 'gemini'],
    // An earlier draft of the format's faces: a field fat-g no longer knows, kept as it is.
    defaultFaces: { codex: 'Sun' },
  };
  const tree = { [at('Planets', 'family.json')]: encode(raw), [at('Planets', 'Sun', 'portrait.png')]: SQUARE, [at('Planets', 'Moon', 'portrait.png')]: SQUARE, [at('Planets', 'Default', 'portrait.png')]: SQUARE };
  const REF = { origin: 'user', family: 'Planets' } as const;

  async function opened(standIn: AvatarStandIn, writable = true) {
    const { root, family } = await scanned(standIn, 'Planets');
    const source = await openFamily(root, family, writable, standIn.fs);
    const save = (draft: FamilyDraft, revision: string | null = source.revision): ReturnType<typeof saveFamily> => {
      const request: SaveFamilyRequest = { ref: REF, revision, draft };
      return saveFamily(root, family, writable, standIn.fs, request);
    };
    return { source, save };
  }

  it('replaces only what the editor edits, keeping every field fat-g does not know, at every level, in its place', async () => {
    const standIn = avatarStandIn(tree);
    const { save } = await opened(standIn);
    const draft: FamilyDraft = {
      provider: 'codex',
      overlay: { version: { preset: 'chip', effectOpacity: 70 } },
      avatars: [
        { folder: 'Moon', matches: [{ provider: 'codex', key: 'gpt-6-luna' }], overlay: { effort: { position: 'top' } } },
        { folder: 'Sun', matches: [], overlay: {} },
        { folder: 'Gone', matches: ['*-gone*'], overlay: {} },
      ],
    };
    expect(await save(draft)).toEqual({ kind: 'saved' });
    const text = standIn.text(at('Planets', 'family.json')) ?? '';
    expect(text.endsWith('\n')).toBe(true);
    const written = JSON.parse(text) as Record<string, unknown>;
    expect(written).toEqual({
      schemaVersion: MANIFEST_VERSION,
      minReaderVersion: MANIFEST_VERSION,
      name: 'An old name',
      author: 'Someone',
      future: { x: 1 },
      // The version's unknown field kept beside the draft's; the marks' known fields gone with the draft's none.
      overlay: { version: { font: 'serif', preset: 'chip', effectOpacity: 70 }, glitter: true },
      avatars: [
        { folder: 'Moon', matches: [{ provider: 'codex', key: 'gpt-6-luna' }], overlay: { effort: { position: 'top' } } },
        // No match and no layer of its own: only what fat-g does not know is left.
        { folder: 'Sun', mood: 'warm', overlay: { sparkle: 1 } },
        { folder: 'Gone', matches: ['*-gone*'], kept: true },
      ],
      // What the editor does not edit is the file's, and stays: the starting family's providers, set by hand.
      defaultFor: ['codex', 'gemini'],
      defaultFaces: { codex: 'Sun' },
      provider: 'codex',
    });
    expect(Object.keys(written)).toEqual(['schemaVersion', 'minReaderVersion', 'name', 'author', 'future', 'overlay', 'avatars', 'defaultFor', 'defaultFaces', 'provider']);
    // Read again, it is what was saved, at a new revision.
    const again = await opened(standIn);
    expect(again.source.draft).toEqual(draft);
    expect(again.source.revision).toBe(revisionOf(encode(text)));
  });

  it('writes the draft’s order, the starting family’s providers kept, its Default its default whatever the order', async () => {
    const standIn = avatarStandIn(tree);
    const { source, save } = await opened(standIn);
    expect(source.draft.avatars.map((avatar) => avatar.folder)).toEqual(['Sun', 'Gone', 'Moon']);
    const moon = source.draft.avatars.find((avatar) => avatar.folder === 'Moon');
    expect(await save({ ...source.draft, avatars: [moon as FamilyDraft['avatars'][number], ...source.draft.avatars.filter((avatar) => avatar.folder !== 'Moon')] })).toEqual({ kind: 'saved' });
    const written = JSON.parse(standIn.text(at('Planets', 'family.json')) ?? '{}') as { avatars: { folder: string }[]; defaultFor: string[] };
    expect([written.avatars.map((avatar) => avatar.folder), written.defaultFor]).toEqual([['Moon', 'Sun', 'Gone'], ['codex', 'gemini']]);
    // Scanned again, the Default is still the family's default, listed first, Moon after it.
    const { root } = await scanned(standIn, 'Planets');
    const catalog = buildCatalog([root], KNOWN);
    expect(catalog.family({ origin: 'user', family: 'Planets' })?.face('claude')?.ref.avatar).toBe('Default');
    expect(catalog.listing.roots[0]?.families[0]?.avatars.map((avatar) => avatar.folder)).toEqual(['Default', 'Moon', 'Sun']);
  });

  // Decision 0032: the fast bolt's place, a field of the marks' style, added at the same version.
  it('opens a file without the fast bolt’s place with none set, and writes and reads one back beside the marks’ unknown fields', async () => {
    const standIn = avatarStandIn({ ...tree, [at('Planets', 'family.json')]: encode({ ...raw, overlay: { ...raw.overlay, effort: { size: 5, twinkle: true } } }) });
    const { source, save } = await opened(standIn);
    expect(source.draft.overlay.effort).toEqual({ size: 5 });
    const draft: FamilyDraft = {
      provider: source.draft.provider,
      overlay: { ...source.draft.overlay, effort: { size: 5, fastPosition: 'bottom-right' } },
      avatars: source.draft.avatars.map((avatar) => (avatar.folder === 'Sun' ? { ...avatar, overlay: { ...avatar.overlay, effort: { fastPosition: 'left' } } } : avatar)),
    };
    expect(await save(draft)).toEqual({ kind: 'saved' });
    const written = JSON.parse(standIn.text(at('Planets', 'family.json')) ?? '{}') as { schemaVersion: number; minReaderVersion: number; overlay: unknown; avatars: { folder: string; overlay?: unknown }[] };
    expect([written.schemaVersion, written.minReaderVersion]).toEqual([MANIFEST_VERSION, MANIFEST_VERSION]);
    expect(written.overlay).toEqual({ version: { preset: 'glow', font: 'serif' }, effort: { twinkle: true, size: 5, fastPosition: 'bottom-right' }, glitter: true });
    expect(written.avatars.find((entry) => entry.folder === 'Sun')?.overlay).toEqual({ version: { size: 20 }, effort: { fastPosition: 'left' }, sparkle: 1 });
    expect((await opened(standIn)).source.draft).toEqual(draft);
  });

  it('keeps an entry the file holds for its Default as written, first, never read', async () => {
    const withDefault = { ...raw, avatars: [raw.avatars[0], { folder: 'Default', matches: ['*'], mood: 'calm', overlay: { version: { preset: 'chip' } } }, raw.avatars[1]] };
    const standIn = avatarStandIn({ ...tree, [at('Planets', 'family.json')]: encode(withDefault) });
    const { source, save } = await opened(standIn);
    expect(source.draft.avatars.map((avatar) => avatar.folder)).toEqual(['Sun', 'Gone', 'Moon']);
    expect(await save({ ...source.draft, overlay: { version: { preset: 'band' } } })).toEqual({ kind: 'saved' });
    const written = JSON.parse(standIn.text(at('Planets', 'family.json')) ?? '{}') as { avatars: Record<string, unknown>[]; overlay: unknown };
    expect(written.avatars.map((avatar) => avatar['folder'])).toEqual(['Default', 'Sun', 'Gone', 'Moon']);
    expect(written.avatars[0]).toEqual({ folder: 'Default', matches: ['*'], mood: 'calm', overlay: { version: { preset: 'chip' } } });
    // The Default's style is the family's, which the draft set.
    expect(written.overlay).toMatchObject({ version: { preset: 'band' } });
  });

  it('removes an entry whose folder is gone, and its every field, when the draft leaves it out', async () => {
    const standIn = avatarStandIn(tree);
    const { source, save } = await opened(standIn);
    expect(await save({ ...source.draft, avatars: source.draft.avatars.filter((avatar) => avatar.folder !== 'Gone') })).toEqual({ kind: 'saved' });
    expect(standIn.text(at('Planets', 'family.json'))).not.toContain('Gone');
  });

  it('writes a file where there was none, from a draft with no revision', async () => {
    const standIn = avatarStandIn({ [at('Planets', 'Sun', 'portrait.png')]: SQUARE });
    const { source, save } = await opened(standIn);
    expect(source.revision).toBeNull();
    expect(await save(source.draft)).toEqual({ kind: 'saved' });
    expect(JSON.parse(standIn.text(at('Planets', 'family.json')) ?? '{}')).toEqual({
      schemaVersion: MANIFEST_VERSION,
      minReaderVersion: MANIFEST_VERSION,
      provider: 'any',
      overlay: SEEDED_OVERLAY,
      avatars: [{ folder: 'Sun' }],
    });
  });

  it('is a conflict, writing nothing, where the file changed since the draft was made', async () => {
    const standIn = avatarStandIn(tree);
    const { source, save } = await opened(standIn);
    standIn.set(at('Planets', 'family.json'), encode({ ...raw, author: 'Someone else' }));
    expect(await save(source.draft)).toEqual({ kind: 'conflict' });
    // A file made since a draft of none, and one removed since a draft of one.
    expect(await save(source.draft, null)).toEqual({ kind: 'conflict' });
    standIn.remove(at('Planets', 'family.json'));
    expect(await save(source.draft)).toEqual({ kind: 'conflict' });
    expect(writes(standIn)).toEqual([]);
  });

  it('is locked, writing nothing, where fat-g may not write the root', async () => {
    const standIn = avatarStandIn(tree);
    const { source, save } = await opened(standIn, false);
    expect(await save(source.draft)).toEqual({ kind: 'locked', lock: { kind: 'packaged' } });
    expect(writes(standIn)).toEqual([]);
  });

  it('is locked, writing nothing, where the file is now one fat-g refuses', async () => {
    const refused = encode({ schemaVersion: 2, minReaderVersion: 2 });
    const standIn = avatarStandIn({ ...tree, [at('Planets', 'family.json')]: refused });
    const { source, save } = await opened(standIn);
    expect(await save(source.draft, revisionOf(refused))).toEqual({ kind: 'locked', lock: { kind: 'manifest', cause: 'older', field: null } });
    expect(writes(standIn)).toEqual([]);
  });

  it('is locked, writing nothing, where the family’s folder or its file has become a link, or its real path left the root', async () => {
    const linkedFolder = avatarStandIn(tree);
    const one = await opened(linkedFolder);
    linkedFolder.remove(at('Planets'));
    linkedFolder.set(at('Planets'), { link: '/elsewhere/Planets' });
    expect(await one.save(one.source.draft)).toEqual({ kind: 'locked', lock: { kind: 'link' } });
    const linkedFile = avatarStandIn(tree);
    const two = await opened(linkedFile);
    linkedFile.set(at('Planets', 'family.json'), { link: '/elsewhere/family.json' });
    expect(await two.save(two.source.draft)).toEqual({ kind: 'locked', lock: { kind: 'link' } });
    const moved = avatarStandIn(tree);
    const three = await opened(moved);
    moved.real.set(at('Planets'), path.resolve('/elsewhere/Planets'));
    expect(await three.save(three.source.draft)).toEqual({ kind: 'locked', lock: { kind: 'link' } });
    expect([...writes(linkedFolder), ...writes(linkedFile), ...writes(moved)]).toEqual([]);
  });

  it.each<[string, (draft: FamilyDraft) => FamilyDraft, string]>([
    ['a folder neither scanned nor listed', (draft) => ({ ...draft, avatars: [...draft.avatars, { folder: 'Mars', matches: [], overlay: {} }] }), 'avatars.3.folder'],
    ['a path for a folder', (draft) => ({ ...draft, avatars: [{ folder: '../Other', matches: [], overlay: {} }] }), 'avatars.0.folder'],
    ['a folder twice', (draft) => ({ ...draft, avatars: [...draft.avatars, { folder: 'Sun', matches: [], overlay: {} }] }), 'avatars.3.folder'],
    ['the Default, whose style is the family’s', (draft) => ({ ...draft, avatars: [...draft.avatars, { folder: 'Default', matches: [], overlay: {} }] }), 'avatars.3.folder'],
    ['the Default in another case', (draft) => ({ ...draft, avatars: [{ folder: 'DEFAULT', matches: ['*'], overlay: {} }, ...draft.avatars] }), 'avatars.0.folder'],
  ])('is invalid, writing nothing, for %s', async (_name, change, field) => {
    const standIn = avatarStandIn(tree);
    const { source, save } = await opened(standIn);
    expect(await save(change(source.draft))).toEqual({ kind: 'invalid', field });
    expect(writes(standIn)).toEqual([]);
  });

  it('fails where the write does, the file standing as it was', async () => {
    const standIn = avatarStandIn(tree);
    const { root, family } = await scanned(standIn, 'Planets');
    const source = await openFamily(root, family, true, standIn.fs);
    const failing: AvatarFs = { ...standIn.fs, writeText: () => Promise.reject(Object.assign(new Error('EBUSY'), { code: 'EBUSY' })) };
    expect(await saveFamily(root, family, true, failing, { ref: REF, revision: source.revision, draft: source.draft })).toEqual({ kind: 'failed' });
    expect(standIn.text(at('Planets', 'family.json'))).toBe(JSON.stringify(raw));
  });
});
