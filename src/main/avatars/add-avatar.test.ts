// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Add avatar (decision 0036): a new avatar's folder, its two PNGs and its entry written at once, from
// the revision the editor holds; checked as a save is, and judged by headers alone.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AddAvatarRequest } from '@shared/contracts/avatar-family';
import { MANIFEST_VERSION } from '@shared/contracts/avatars';
import { apngBytes as apngBuffer, pngBytes as pngBuffer, webpBytes as webpBuffer } from '../images/test-support';
import { nodeAvatarFs } from './fs';
import { createAvatarService } from './service';
import { avatarStandIn } from './test-support';

const BUILT_IN = path.resolve('/built-in');
const USER = path.resolve('/user');
const FAMILY = { origin: 'user', family: 'Planets' } as const;
const at = (...parts: string[]): string => path.join(USER, 'Planets', ...parts);
/** The images as the request's schema gives them: views of their own buffers. */
const pngBytes = (width: number, height: number): Uint8Array<ArrayBuffer> => new Uint8Array(pngBuffer(width, height));
const apngBytes = (width: number, height: number): Uint8Array<ArrayBuffer> => new Uint8Array(apngBuffer(width, height));
const webpBytes = (kind: 'VP8L', width: number, height: number): Uint8Array<ArrayBuffer> => new Uint8Array(webpBuffer(kind, width, height));
const portrait = pngBytes(512, 512);
const small = pngBytes(64, 64);
const manifest = JSON.stringify({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, provider: 'any', future: { keep: true }, defaultFor: ['claude'], avatars: [{ folder: 'Sun', matches: ['*-sol*'], note: 'kept' }, { folder: 'Gone', matches: ['gone'] }] });
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function setup() {
  const standIn = avatarStandIn({
    [at('family.json')]: encode(manifest),
    [at('Default', 'portrait.png')]: portrait,
    [at('Sun', 'portrait.png')]: portrait,
    [path.join(BUILT_IN, 'Original', 'Default', 'portrait.png')]: portrait,
  });
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createAvatarService({ roots: { builtIn: BUILT_IN, user: USER }, fs: standIn.fs, providers: ['claude', 'codex'], log });
  const request = async (change: Partial<AddAvatarRequest> = {}): Promise<AddAvatarRequest> => {
    await service.scan();
    const opened = await service.openFamily(change.ref ?? FAMILY);
    return { ref: FAMILY, revision: opened?.revision ?? null, name: 'Moon', matches: ['*-luna*', { provider: 'codex', key: 'gpt-6-luna' }], portrait, small, ...change };
  };
  const writes = () => standIn.calls.filter((call) => ['createExclusiveFolder', 'writeNewFile', 'writeText', 'removeCopy'].includes(call.op));
  return { standIn, service, log, request, writes };
}

describe('Add avatar (decision 0036)', () => {
  it('writes the folder, both PNGs and the entry last, keeps what the file held, and answers the family read again with the listing', async () => {
    const { service, standIn, log, request } = setup();
    const answer = await service.addAvatar(await request());
    expect(answer).toMatchObject({ kind: 'added', folder: 'Moon' });
    if (answer.kind !== 'added') throw new Error('not added');
    expect(await standIn.fs.readWhole(at('Moon', 'portrait.png'), 1e6)).toEqual(portrait);
    expect(await standIn.fs.readWhole(at('Moon', 'small.png'), 1e6)).toEqual(small);
    const written = JSON.parse(standIn.text(at('family.json')) ?? '') as Record<string, unknown>;
    expect(written).toMatchObject({ future: { keep: true }, defaultFor: ['claude'] });
    expect(written['avatars']).toEqual([
      { folder: 'Sun', matches: ['*-sol*'], note: 'kept' },
      { folder: 'Gone', matches: ['gone'] },
      { folder: 'Moon', matches: ['*-luna*', { provider: 'codex', key: 'gpt-6-luna' }] },
    ]);
    expect(answer.source.draft.avatars.map((avatar) => avatar.folder)).toEqual(['Sun', 'Gone', 'Moon']);
    expect(answer.source.missing).toEqual(['Gone']);
    expect(answer.source.revision).not.toBeNull();
    const listed = answer.listing.roots[1]?.families.find((family) => family.folder === 'Planets');
    expect(listed?.avatars.map((avatar) => avatar.folder)).toContain('Moon');
    expect(listed?.avatars.find((avatar) => avatar.folder === 'Moon')?.files.map((file) => file.width)).toEqual([512, 64]);
    expect(log.info.mock.calls.flat().join(' ')).not.toMatch(/Moon|Planets/);
    // The answer's revision is the file's now: a save made from it is no conflict.
    expect(await service.saveFamily({ ref: FAMILY, revision: answer.source.revision, draft: answer.source.draft })).toEqual({ kind: 'saved' });
  });

  it('takes a portrait smaller than 512 px, and a family with no file yet', async () => {
    const { service, standIn, request } = setup();
    const ready = await request({ revision: null, portrait: pngBytes(200, 200), matches: [] });
    standIn.remove(at('family.json'));
    expect(await service.addAvatar(ready)).toMatchObject({ kind: 'added' });
    const written = JSON.parse(standIn.text(at('family.json')) ?? '') as { avatars: unknown[]; schemaVersion: number };
    expect(written.schemaVersion).toBe(MANIFEST_VERSION);
    expect(written.avatars).toEqual([{ folder: 'Sun' }, { folder: 'Moon' }]);
  });

  it('refuses an add made from another revision as a conflict, writing nothing', async () => {
    const { service, writes, request } = setup();
    expect(await service.addAvatar(await request({ revision: 'a'.repeat(64) }))).toEqual({ kind: 'conflict' });
    expect(writes()).toEqual([]);
  });

  it.each([
    ['a folder of the family in another case', 'sun'],
    ['an entry of the file whose folder is gone', 'GONE'],
    ['the family file', 'Family.json'],
    ['a file of the folder', 'notes.txt'],
  ])('refuses the name of %s as taken, writing nothing', async (_name, name) => {
    const { service, standIn, writes, request } = setup();
    standIn.set(at('notes.txt'), encode('notes'));
    expect(await service.addAvatar(await request({ name }))).toEqual({ kind: 'taken' });
    expect(writes()).toEqual([]);
  });

  it('answers taken where the folder appears between the check and the reserve, writing nothing in it', async () => {
    const { service, standIn, writes, request } = setup();
    const ready = await request();
    const fs = standIn.fs;
    const create = fs.createExclusiveFolder.bind(fs);
    fs.createExclusiveFolder = async (folder) => { standIn.set(path.join(folder, 'theirs.txt'), encode('theirs')); return create(folder); };
    expect(await service.addAvatar(ready)).toEqual({ kind: 'taken' });
    expect(writes().filter((call) => call.op !== 'createExclusiveFolder')).toEqual([]);
    expect(standIn.text(at('Moon', 'theirs.txt'))).toBe('theirs');
  });

  it.each([
    ['a WebP portrait', { portrait: webpBytes('VP8L', 512, 512) }],
    ['a portrait over 512 px', { portrait: pngBytes(600, 600) }],
    ['a portrait under 64 px', { portrait: pngBytes(32, 32) }],
    ['a portrait that is not square', { portrait: pngBytes(512, 500) }],
    ['an animated portrait', { portrait: apngBytes(512, 512) }],
    ['a small of another side', { small: pngBytes(32, 32) }],
    ['bytes no image', { small: new Uint8Array(encode('not an image')) }],
  ])('refuses %s, writing nothing', async (_name, change) => {
    const { service, writes, request } = setup();
    expect(await service.addAvatar(await request(change))).toEqual({ kind: 'invalid' });
    expect(writes()).toEqual([]);
  });

  it('refuses fat-g’s own art, a family no longer listed, a linked folder and a refused file', async () => {
    const { service, standIn, writes, request } = setup();
    expect(await service.addAvatar(await request({ ref: { origin: 'built-in', family: 'Original' } }))).toEqual({ kind: 'locked', lock: { kind: 'packaged' } });
    expect(await service.addAvatar(await request({ ref: { origin: 'user', family: 'Elsewhere' } }))).toEqual({ kind: 'missing' });
    const ready = await request();
    standIn.real.set(at(), path.resolve('/elsewhere/Planets'));
    expect(await service.addAvatar(ready)).toEqual({ kind: 'locked', lock: { kind: 'link' } });
    standIn.real.clear();
    standIn.set(at('family.json'), encode('{"schemaVersion":99,"minReaderVersion":99}'));
    expect(await service.addAvatar(await request())).toMatchObject({ kind: 'locked', lock: { kind: 'manifest' } });
    expect(writes()).toEqual([]);
  });

  it.each(['an image', 'the family file'])('removes only its own folder when writing %s fails, and leaves the file as it was', async (which) => {
    const { service, standIn, request } = setup();
    const ready = await request();
    if (which === 'an image') standIn.failing.set(at('Moon', 'small.png'), 'ENOSPC');
    else standIn.fs.writeText = () => Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    expect(await service.addAvatar(ready)).toEqual({ kind: 'failed' });
    expect(standIn.paths().some((file) => file.startsWith(at('Moon')))).toBe(false);
    expect(standIn.text(at('family.json'))).toBe(manifest);
  });

  it('writes through the real file system adapter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fatg-avatar-add-'));
    try {
      const builtIn = path.join(root, 'built-in');
      const user = path.join(root, 'user');
      await mkdir(path.join(user, 'Planets', 'Default'), { recursive: true });
      await mkdir(builtIn);
      await writeFile(path.join(user, 'Planets', 'Default', 'portrait.png'), portrait);
      await writeFile(path.join(user, 'Planets', 'family.json'), manifest);
      const service = createAvatarService({ roots: { builtIn, user }, fs: nodeAvatarFs, providers: ['claude'], log: { info: vi.fn(), warn: vi.fn() } });
      await service.scan();
      const revision = (await service.openFamily(FAMILY))?.revision ?? null;
      const request: AddAvatarRequest = { ref: FAMILY, revision, name: 'Moon', matches: ['moon'], portrait, small };
      expect(await service.addAvatar(request)).toMatchObject({ kind: 'added', folder: 'Moon' });
      expect(await readFile(path.join(user, 'Planets', 'Moon', 'portrait.png'))).toEqual(Buffer.from(portrait));
      expect(await readFile(path.join(user, 'Planets', 'Moon', 'small.png'))).toEqual(Buffer.from(small));
      expect(await readFile(path.join(user, 'Planets', 'family.json'), 'utf8')).toContain('"folder": "Moon"');
      const again = (await service.openFamily(FAMILY))?.revision ?? null;
      expect(await service.addAvatar({ ...request, revision: again, name: 'MOON' })).toEqual({ kind: 'taken' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
