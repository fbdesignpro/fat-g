// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V15, V6 (docs/planning/_archive/M102.md, Design 5; C22, C57, C60): the avatar service — the empty catalog
// before the first scan lands, the catalog after it, one line of counts per scan, subscribers told
// when a catalog replaces the last, a Rescan's new ids, and presses coalesced so that at most one scan
// runs and one waits. Decision 0031: a family's family.json made in a root fat-g may write, and the
// family editor's open and save, in one queue with the scans.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { type FamilyDraft } from '@shared/contracts/avatar-family';
import { MANIFEST_VERSION } from '@shared/contracts/avatars';
import { pngBytes } from '../images/test-support';
import type { AvatarFs } from './fs';
import { type AvatarServiceOptions, createAvatarService } from './service';
import { avatarStandIn, type StandInNode } from './test-support';

const BUILT_IN = path.resolve('/built-in');
const USER = path.resolve('/user');
const SQUARE = pngBytes(8, 8);
const encode = (body: object): Uint8Array => new TextEncoder().encode(JSON.stringify({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, ...body }));
const manifest = encode({ defaultFor: ['claude'] });

function setup(fs?: AvatarFs, more: Readonly<Record<string, StandInNode>> = {}, writable?: AvatarServiceOptions['writable']) {
  const standIn = avatarStandIn({ [path.join(BUILT_IN, 'Orange', 'family.json')]: manifest, [path.join(BUILT_IN, 'Orange', 'Default', 'portrait.png')]: SQUARE, ...more });
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createAvatarService({ roots: { builtIn: BUILT_IN, user: USER }, ...(writable === undefined ? {} : { writable }), fs: fs ?? standIn.fs, providers: ['claude', 'codex'], log });
  return { standIn, log, service };
}

describe('the catalog over time (V15, V6; C57)', () => {
  it('is empty before the first scan lands, and the scan’s once it has', async () => {
    const { service, log } = setup();
    expect(service.defaultFace('claude')).toBeNull();
    expect(service.listing().roots.map((root) => [root.origin, root.families.length])).toEqual([['built-in', 0], ['user', 0]]);
    const scanned = service.scan();
    expect(service.defaultFace('claude')).toBeNull();
    await scanned;
    expect(service.defaultFace('claude')?.ref).toEqual({ origin: 'built-in', family: 'Orange', avatar: 'Default' });
    expect(service.listing().roots[1]).toEqual({ origin: 'user', families: [], problems: [] });
    expect(log.info).toHaveBeenCalledExactlyOnceWith('[avatars] 1 built-in family, 1 avatar; 0 user families, 0 avatars, 0 problems');
  });

  it('tells its subscribers when a catalog lands, and a Rescan after a file changed gives it a new id', async () => {
    const { service, standIn } = setup();
    const told = vi.fn();
    service.subscribe(told);
    await service.scan();
    const before = service.defaultFace('claude');
    // The file replaced by another of a new modification time.
    standIn.set(path.join(BUILT_IN, 'Orange', 'Default', 'portrait.png'), { bytes: pngBytes(16, 16), mtimeMs: 2000 });
    await service.scan();
    const after = service.defaultFace('claude');
    expect(told).toHaveBeenCalledTimes(2);
    expect(after?.portrait).not.toBe(before?.portrait);
    // The old id is the old catalog's: this one answers it with no file.
    expect(service.file(before?.portrait ?? '')).toBeUndefined();
    expect(service.file(after?.portrait ?? '')).toMatchObject({ width: 16 });
  });

  it('keeps an id for a file unchanged across a Rescan', async () => {
    const { service } = setup();
    await service.scan();
    const before = service.defaultFace('claude')?.portrait;
    await service.scan();
    expect(service.defaultFace('claude')?.portrait).toBe(before);
  });
});

describe('Rescan pressed while a scan runs (V15; C57)', () => {
  it('runs one more scan after it, which further presses join: at most one runs and one waits', async () => {
    const { standIn } = setup();
    let lists = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The built-in root's listing waits until released, the first time.
    const slow: AvatarFs = { ...standIn.fs, list: async (folder) => { if (folder === BUILT_IN && (lists += 1) === 1) await gate; return standIn.fs.list(folder); } };
    const { service } = setup(slow);
    const first = service.scan();
    const second = service.scan();
    const third = service.scan();
    expect(third).toBe(second);
    release();
    await Promise.all([first, second, third]);
    expect(lists).toBe(2);
    await service.idle();
  });
});

describe('a family’s family.json made where it has none (decision 0031)', () => {
  const MINE = path.join(USER, 'Mine', 'Me', 'portrait.png');
  const MINE_DEFAULT = path.join(USER, 'Mine', 'Default', 'portrait.png');
  const BARE = path.join(BUILT_IN, 'Bare', 'One', 'portrait.png');

  it('is made in the user’s folder, then read: its family listed with the defaults written, its Default its default and no entry of it', async () => {
    const { service, standIn, log } = setup(undefined, { [MINE]: SQUARE, [MINE_DEFAULT]: SQUARE });
    await service.scan();
    const written = standIn.text(path.join(USER, 'Mine', 'family.json'));
    expect(JSON.parse(written ?? '{}')).toMatchObject({ schemaVersion: MANIFEST_VERSION, avatars: [{ folder: 'Me', matches: [] }] });
    expect((JSON.parse(written ?? '{}') as { avatars: unknown[] }).avatars).toHaveLength(1);
    const family = service.listing().roots[1]?.families[0];
    expect(family?.problems).toEqual([]);
    expect(family?.avatars.map((avatar) => [avatar.folder, avatar.fallback])).toEqual([['Default', true], ['Me', false]]);
    expect(family?.overlay?.effort).toMatchObject({ show: true, position: 'bottom' });
    expect(log.info).toHaveBeenCalledWith('[avatars] 1 family.json made with the defaults');
    // Once made, the next scan writes nothing.
    const writes = standIn.calls.filter((call) => call.op === 'writeText').length;
    await service.scan();
    expect(standIn.calls.filter((call) => call.op === 'writeText')).toHaveLength(writes);
  });

  it('is never made in fat-g’s own art unless the root is told writable, as a development run is', async () => {
    const shipped = setup(undefined, { [BARE]: SQUARE });
    await shipped.service.scan();
    expect(shipped.standIn.calls.filter((call) => call.op === 'writeText')).toEqual([]);
    expect(shipped.service.listing().roots[0]?.families.map((family) => family.folder)).toEqual(['Bare', 'Orange']);
    const development = setup(undefined, { [BARE]: SQUARE }, { builtIn: true });
    await development.service.scan();
    expect(development.standIn.text(path.join(BUILT_IN, 'Bare', 'family.json'))).toContain('"folder": "One"');
  });

  it('is not made in the user’s folder when it is told not to be written', async () => {
    const { service, standIn } = setup(undefined, { [MINE]: SQUARE }, { user: false });
    await service.scan();
    expect(standIn.calls.filter((call) => call.op === 'writeText')).toEqual([]);
  });
});

describe('opening a family content folder', () => {
  const ref = { origin: 'built-in', family: 'Orange' } as const;
  const folder = path.join(BUILT_IN, 'Orange');

  it('answers only a listed family’s real folder, without reading content or writing files', async () => {
    const { service, standIn } = setup();
    expect(await service.familyFolder(ref)).toBeNull();
    await service.scan();
    standIn.calls.length = 0;
    expect(await service.familyFolder(ref)).toBe(folder);
    expect(standIn.calls.every((call) => call.op === 'lstat' || call.op === 'realpath')).toBe(true);
    expect(await service.familyFolder({ ...ref, family: '..' })).toBeNull();
    expect(await service.familyFolder({ ...ref, family: 'Gone' })).toBeNull();
  });

  it.each(['missing', 'file', 'link', 'outside', 'nested', 'root link', 'root moved', 'unreadable'] as const)('refuses a family changed since the scan: %s', async (change) => {
    const { service, standIn } = setup();
    await service.scan();
    if (change === 'missing') standIn.remove(folder);
    if (change === 'file') standIn.set(folder, SQUARE);
    if (change === 'link') standIn.set(folder, { link: '/private' });
    if (change === 'outside') standIn.real.set(folder, path.resolve('/private'));
    if (change === 'nested') standIn.real.set(folder, path.join(folder, 'nested'));
    if (change === 'root link') standIn.set(BUILT_IN, { link: '/private' });
    if (change === 'root moved') standIn.real.set(BUILT_IN, path.resolve('/private'));
    if (change === 'unreadable') standIn.failing.set(folder, 'EACCES');
    expect(await service.familyFolder(ref)).toBeNull();
  });
});

describe('the family editor’s open and save (decision 0031)', () => {
  const PLANETS = { origin: 'user', family: 'Planets' } as const;
  const tree = {
    [path.join(USER, 'Planets', 'family.json')]: encode({ avatars: [{ folder: 'Sun', matches: ['*-sol*'] }] }),
    [path.join(USER, 'Planets', 'Sun', 'portrait.png')]: SQUARE,
    [path.join(USER, 'Planets', 'Moon', 'portrait.png')]: SQUARE,
  };

  it('opens a listed family as its file holds it, and none for one the scan did not list', async () => {
    const { service } = setup(undefined, tree);
    await service.scan();
    const source = await service.openFamily(PLANETS);
    expect(source).toMatchObject({ ref: PLANETS, lock: null, revision: expect.stringMatching(/^[0-9a-f]{64}$/) as string, missing: [] });
    expect(source?.draft.avatars.map((avatar) => avatar.folder)).toEqual(['Sun', 'Moon']);
    expect(await service.openFamily({ origin: 'user', family: 'Gone' })).toBeNull();
    // fat-g's own art, not writable here, opens locked.
    expect((await service.openFamily({ origin: 'built-in', family: 'Orange' }))?.lock).toEqual({ kind: 'packaged' });
  });

  it('saves a draft, then scans again before it answers: the catalog follows the file', async () => {
    const { service, standIn } = setup(undefined, tree);
    await service.scan();
    const told = vi.fn();
    service.subscribe(told);
    const source = await service.openFamily(PLANETS);
    const draft: FamilyDraft = { ...(source?.draft as FamilyDraft), avatars: [{ folder: 'Moon', matches: ['*-luna*'], overlay: { effort: { position: 'top' } } }, { folder: 'Sun', matches: [], overlay: {} }] };
    expect(await service.saveFamily({ ref: PLANETS, revision: source?.revision ?? null, draft })).toEqual({ kind: 'saved' });
    expect(told).toHaveBeenCalledOnce();
    const family = service.listing().roots[1]?.families.find((candidate) => candidate.folder === 'Planets');
    expect(family?.avatars.map((avatar) => [avatar.folder, avatar.matches, avatar.overlay])).toEqual([
      ['Moon', [{ provider: null, key: '*-luna*' }], { effort: { position: 'top' } }],
      ['Sun', [], undefined],
    ]);
    expect(service.family(PLANETS)?.match('codex', { key: 'gpt-6-luna', resolvedId: null })?.ref.avatar).toBe('Moon');
    expect(JSON.parse(standIn.text(path.join(USER, 'Planets', 'family.json')) ?? '{}')).toMatchObject({ schemaVersion: MANIFEST_VERSION });
  });

  it('answers missing for a family the scan does not list, and conflict for a stale revision, writing nothing', async () => {
    const { service, standIn } = setup(undefined, tree);
    await service.scan();
    const source = await service.openFamily(PLANETS);
    const draft = source?.draft as FamilyDraft;
    expect(await service.saveFamily({ ref: { origin: 'user', family: 'Gone' }, revision: null, draft })).toEqual({ kind: 'missing' });
    expect(await service.saveFamily({ ref: PLANETS, revision: '0'.repeat(64), draft })).toEqual({ kind: 'conflict' });
    expect(standIn.calls.filter((call) => call.op === 'writeText')).toEqual([]);
  });

  it('never saves while a scan reads: a save asked during a scan waits for it', async () => {
    const { standIn } = setup(undefined, tree);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let lists = 0;
    const order: string[] = [];
    const slow: AvatarFs = {
      ...standIn.fs,
      list: async (folder) => { if (folder === USER && (lists += 1) === 2) { order.push('scan waits'); await gate; order.push('scan goes on'); } return standIn.fs.list(folder); },
      writeText: async (target, text) => { order.push('write'); await standIn.fs.writeText(target, text); },
    };
    // A service over the first one's files, its user root's second listing held until released.
    const { service } = setup(slow);
    await service.scan();
    const source = await service.openFamily(PLANETS);
    const scanning = service.scan();
    await vi.waitFor(() => expect(order).toEqual(['scan waits']));
    const saving = service.saveFamily({ ref: PLANETS, revision: source?.revision ?? null, draft: source?.draft as FamilyDraft });
    await Promise.resolve();
    expect(order).toEqual(['scan waits']);
    release();
    await scanning;
    expect(await saving).toEqual({ kind: 'saved' });
    expect(order.slice(0, 3)).toEqual(['scan waits', 'scan goes on', 'write']);
  });
});
