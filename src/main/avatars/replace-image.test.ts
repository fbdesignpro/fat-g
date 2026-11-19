// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An avatar's image replaced (decision 0036): the new PNGs written beside the old, the old sent to the
// system's trash, the new moved into place as `<role>.png`; checked as a save is, judged by headers.
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReplaceImageRequest } from '@shared/contracts/avatar-family';
import { MANIFEST_VERSION } from '@shared/contracts/avatars';
import { apngBytes as apngBuffer, pngBytes as pngBuffer, webpBytes } from '../images/test-support';
import { nodeAvatarFs } from './fs';
import { createAvatarService } from './service';
import { avatarStandIn } from './test-support';

const BUILT_IN = path.resolve('/built-in');
const USER = path.resolve('/user');
const FAMILY = { origin: 'user', family: 'Planets' } as const;
const at = (...parts: string[]): string => path.join(USER, 'Planets', ...parts);
const png = (side: number, colour: readonly [number, number, number] = [255, 0, 0]): Uint8Array<ArrayBuffer> => new Uint8Array(pngBuffer(side, side, colour, colour));
const manifest = JSON.stringify({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, provider: 'any', avatars: [{ folder: 'Sun', matches: ['*-sol*'] }] });
const oldPortrait = webpBytes('VP8L', 512, 512);
const oldSmall = png(64, [0, 0, 255]);

function setup(trashing?: (file: string) => Promise<void>) {
  const standIn = avatarStandIn({
    [at('family.json')]: new TextEncoder().encode(manifest),
    [at('Default', 'portrait.png')]: png(512),
    [at('Sun', 'Portrait.WEBP')]: oldPortrait,
    [at('Sun', 'small.png')]: oldSmall,
    [path.join(BUILT_IN, 'Original', 'Default', 'portrait.png')]: png(512),
  });
  const trashed: string[] = [];
  const trash = vi.fn(trashing ?? ((file: string) => { trashed.push(file); standIn.remove(file); return Promise.resolve(); }));
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createAvatarService({ roots: { builtIn: BUILT_IN, user: USER }, fs: standIn.fs, trash, providers: ['claude'], log });
  const replace = async (change: Partial<ReplaceImageRequest> = {}) => {
    await service.scan();
    return service.replaceImage({ ref: FAMILY, avatar: 'Sun', portrait: png(512, [0, 255, 0]), small: png(64, [0, 255, 0]), ...change });
  };
  const writes = () => standIn.calls.filter((call) => ['writeNewFile', 'moveFile', 'writeText'].includes(call.op));
  return { standIn, service, trash, trashed, log, replace, writes };
}

describe('an avatar’s image replaced (decision 0036)', () => {
  it('sends the old main image and small to the trash, whatever their format and case, and puts the new PNGs in their place', async () => {
    const { standIn, trashed, log, replace } = setup();
    const answer = await replace();
    expect(answer.kind).toBe('replaced');
    expect(trashed).toEqual([at('Sun', 'Portrait.WEBP'), at('Sun', 'small.png')]);
    expect(await standIn.fs.readWhole(at('Sun', 'portrait.png'), 1e6)).toEqual(png(512, [0, 255, 0]));
    expect(await standIn.fs.readWhole(at('Sun', 'small.png'), 1e6)).toEqual(png(64, [0, 255, 0]));
    expect(standIn.paths().filter((file) => file.startsWith(at('Sun')) && file !== at('Sun'))).toEqual([at('Sun', 'portrait.png'), at('Sun', 'small.png')]);
    if (answer.kind !== 'replaced') throw new Error('not replaced');
    const sun = answer.listing.roots[1]?.families[0]?.avatars.find((avatar) => avatar.folder === 'Sun');
    expect(sun?.files.map((file) => `${file.role} ${file.format} ${file.width}`)).toEqual(['portrait png 512', 'small png 64']);
    expect(standIn.text(at('family.json'))).toBe(manifest);
    expect(log.info.mock.calls.flat().join(' ')).not.toMatch(/Sun|Planets/);
  });

  it('replaces a small alone, and adds one where there was none', async () => {
    const { standIn, trashed, replace } = setup();
    expect((await replace({ portrait: null })).kind).toBe('replaced');
    expect(trashed).toEqual([at('Sun', 'small.png')]);
    expect(await standIn.fs.readWhole(at('Sun', 'Portrait.WEBP'), 1e6)).toEqual(oldPortrait);
    standIn.remove(at('Sun', 'small.png'));
    trashed.length = 0;
    expect((await replace({ portrait: null })).kind).toBe('replaced');
    expect(trashed).toEqual([]);
    expect(await standIn.fs.readWhole(at('Sun', 'small.png'), 1e6)).toEqual(png(64, [0, 255, 0]));
  });

  it('replaces the Family default’s images too', async () => {
    const { standIn, replace } = setup();
    expect((await replace({ avatar: 'Default', portrait: png(300), small: png(64) })).kind).toBe('replaced');
    expect(await standIn.fs.readWhole(at('Default', 'portrait.png'), 1e6)).toEqual(png(300));
  });

  it('leaves the old files where the trash will not take them, removing the new ones', async () => {
    const { standIn, replace } = setup(() => Promise.reject(new Error('no trash here')));
    expect(await replace()).toEqual({ kind: 'failed' });
    expect(await standIn.fs.readWhole(at('Sun', 'Portrait.WEBP'), 1e6)).toEqual(oldPortrait);
    expect(await standIn.fs.readWhole(at('Sun', 'small.png'), 1e6)).toEqual(oldSmall);
    expect(standIn.paths().filter((file) => file.includes('.fat-g-new-'))).toEqual([]);
  });

  it.each([
    ['a WebP main image', { portrait: new Uint8Array(webpBytes('VP8L', 512, 512)) }],
    ['a main image over 512 px', { portrait: png(600) }],
    ['an animated main image', { portrait: new Uint8Array(apngBuffer(512, 512)) }],
    ['a small of another side', { small: png(32) }],
  ])('refuses %s, writing nothing', async (_name, change) => {
    const { trash, replace, writes } = setup();
    expect(await replace(change)).toEqual({ kind: 'invalid' });
    expect(writes()).toEqual([]);
    expect(trash).not.toHaveBeenCalled();
  });

  it('refuses fat-g’s own art, an avatar or family no longer listed, and a linked folder, writing nothing', async () => {
    const { standIn, trash, replace, writes } = setup();
    expect(await replace({ ref: { origin: 'built-in', family: 'Original' }, avatar: 'Default' })).toEqual({ kind: 'locked', lock: { kind: 'packaged' } });
    expect(await replace({ avatar: 'Moon' })).toEqual({ kind: 'missing' });
    expect(await replace({ ref: { origin: 'user', family: 'Elsewhere' } })).toEqual({ kind: 'missing' });
    // An avatar's folder swapped for a link elsewhere, then the family's.
    standIn.real.set(at('Sun'), path.resolve('/elsewhere/Sun'));
    expect(await replace()).toEqual({ kind: 'missing' });
    standIn.real.clear();
    standIn.real.set(at(), path.resolve('/elsewhere/Planets'));
    expect(await replace()).toEqual({ kind: 'locked', lock: { kind: 'link' } });
    expect(writes()).toEqual([]);
    expect(trash).not.toHaveBeenCalled();
  });

  it('works on the real file system, with a trash that moves the old file aside', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fatg-avatar-replace-'));
    try {
      const user = path.join(root, 'user');
      const bin = path.join(root, 'bin');
      await mkdir(path.join(user, 'Planets', 'Default'), { recursive: true });
      await mkdir(path.join(user, 'Planets', 'Sun'));
      await mkdir(path.join(root, 'built-in'));
      await mkdir(bin);
      await writeFile(path.join(user, 'Planets', 'Default', 'portrait.png'), png(512));
      await writeFile(path.join(user, 'Planets', 'Sun', 'portrait.png'), png(512));
      await writeFile(path.join(user, 'Planets', 'family.json'), manifest);
      const trash = async (file: string): Promise<void> => { await writeFile(path.join(bin, path.basename(file)), await readFile(file)); await rm(file); };
      const service = createAvatarService({ roots: { builtIn: path.join(root, 'built-in'), user }, fs: nodeAvatarFs, trash, providers: ['claude'], log: { info: vi.fn(), warn: vi.fn() } });
      await service.scan();
      expect((await service.replaceImage({ ref: FAMILY, avatar: 'Sun', portrait: png(256, [0, 255, 0]), small: png(64, [0, 255, 0]) })).kind).toBe('replaced');
      expect(await readFile(path.join(user, 'Planets', 'Sun', 'portrait.png'))).toEqual(Buffer.from(png(256, [0, 255, 0])));
      expect(await readFile(path.join(bin, 'portrait.png'))).toEqual(Buffer.from(png(512)));
      expect((await readdir(path.join(user, 'Planets', 'Sun'))).sort()).toEqual(['portrait.png', 'small.png']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
