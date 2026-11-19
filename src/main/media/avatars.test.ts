// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16 (docs/planning/_archive/M102.md, Design 6; C59–C62): the media route's avatar source — an earlier scan's
// id, an id of another shape, a file replaced by a link, grown past the bound, changed in type or
// pixels, or moved outside its root after the scan, each answered 404 with its kind and nothing
// served; folders of any name served by their ids; the avatars' cache policy on the answer.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { type AvatarCatalog, buildCatalog } from '../avatars/catalog';
import { nodeAvatarFs } from '../avatars/fs';
import { scanRoot } from '../avatars/scan';
import { avatarStandIn, type AvatarStandIn } from '../avatars/test-support';
import { apngBytes, pngBytes, webpBytes } from '../images/test-support';
import { AVATARS_SOURCE, createAvatarSource } from './avatars';
import { createMediaRoute, mediaHeaders } from './route';

const ROOT = path.resolve('/avatars-root');
const PORTRAIT = pngBytes(8, 8);
const SMALL = webpBytes('VP8L', 4, 4);

/** A catalog of the stand-in's root, and the ids of the one avatar's files, by role. */
async function catalogOf(standIn: AvatarStandIn): Promise<{ readonly catalog: AvatarCatalog; readonly ids: Record<string, string> }> {
  const catalog = buildCatalog([await scanRoot('user', ROOT, standIn.fs)], new Set(['claude']));
  const files = catalog.listing.roots[0]?.families.flatMap((family) => family.avatars.flatMap((avatar) => avatar.files.map((file) => [`${family.folder}/${avatar.folder}/${file.role}`, file.id] as const))) ?? [];
  return { catalog, ids: Object.fromEntries(files) };
}

function setup(names: readonly string[] = ['Orange/Op']) {
  const standIn = avatarStandIn();
  for (const name of names) {
    standIn.set(path.join(ROOT, ...name.split('/'), 'portrait.png'), PORTRAIT);
    standIn.set(path.join(ROOT, ...name.split('/'), 'small.webp'), SMALL);
  }
  return standIn;
}

describe('an avatar served by its id (V16; C59, C60, C62)', () => {
  it('answers each of an avatar’s files with its bytes and the type its signature gave', async () => {
    const standIn = setup();
    const { catalog, ids } = await catalogOf(standIn);
    const source = createAvatarSource({ file: (id) => catalog.file(id), fs: standIn.fs });
    expect([source.name, source.cache]).toEqual([AVATARS_SOURCE, 'immutable']);
    const portrait = await source.serve(ids['Orange/Op/portrait'] ?? '');
    expect(portrait).toMatchObject({ status: 200, contentType: 'image/png' });
    if (portrait.status === 200) expect(Buffer.from(portrait.body).equals(PORTRAIT)).toBe(true);
    expect(await source.serve(ids['Orange/Op/small'] ?? '')).toMatchObject({ status: 200, contentType: 'image/webp' });
  });

  it('serves folders named with spaces, #, %, ? and letters beyond ASCII by their ids alone', async () => {
    const names = ['Fam ily/A vatar', 'Fam#1/Av#2', 'Fam%25/Av%2F', 'Fam?/Av?', 'Fämïly/Ävätär 名前'];
    const standIn = setup(names);
    const { catalog, ids } = await catalogOf(standIn);
    const route = createMediaRoute([createAvatarSource({ file: (id) => catalog.file(id), fs: standIn.fs })]);
    for (const name of names) {
      const id = ids[`${name}/portrait`] ?? '';
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(await route({ method: 'GET', url: `app://media/avatars/${id}` }), name).toMatchObject({ status: 200, cache: 'immutable' });
    }
  });

  it('carries the avatars’ cache policy in its headers, and the attachments’ no-store stands', () => {
    expect(mediaHeaders('image/webp', 'immutable')).toMatchObject({ 'content-type': 'image/webp', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'; sandbox" });
    expect(mediaHeaders('image/png', 'no-store')['cache-control']).toBe('no-store');
    expect(Object.keys(mediaHeaders('image/png', 'immutable')).map((key) => key.toLowerCase())).not.toContain('accept-ranges');
  });
});

describe('a refusal, with nothing served (V16; C60, C61)', () => {
  it('answers an id of another shape, and one this scan did not mint, without asking the file system', async () => {
    const standIn = setup();
    const { catalog } = await catalogOf(standIn);
    const source = createAvatarSource({ file: (id) => catalog.file(id), fs: standIn.fs });
    const asked = standIn.calls.length;
    for (const id of ['records', 'A'.repeat(32), '0'.repeat(31), '0'.repeat(64), '0'.repeat(32)]) expect(await source.serve(id), id).toEqual({ status: 404, kind: 'id' });
    expect(standIn.calls.length).toBe(asked);
  });

  it('answers an earlier scan’s id once a Rescan’s catalog stands, and the new id serves', async () => {
    const standIn = setup();
    let current = await catalogOf(standIn);
    const source = createAvatarSource({ file: (id) => current.catalog.file(id), fs: standIn.fs });
    const old = current.ids['Orange/Op/portrait'] ?? '';
    standIn.set(path.join(ROOT, 'Orange', 'Op', 'portrait.png'), { bytes: pngBytes(16, 16), mtimeMs: 5000 });
    current = await catalogOf(standIn);
    expect(await source.serve(old)).toEqual({ status: 404, kind: 'id' });
    expect(await source.serve(current.ids['Orange/Op/portrait'] ?? '')).toMatchObject({ status: 200 });
  });

  it.each([
    ['replaced by a link', (standIn: AvatarStandIn, file: string) => { standIn.set(file, { link: '/elsewhere/portrait.png' }); }],
    ['grown past the bound', (standIn: AvatarStandIn, file: string) => { standIn.set(file, new Uint8Array(MAX_IMAGE_BYTES + 1)); }],
    ['changed in type, at the same size', (standIn: AvatarStandIn, file: string) => { const other = Buffer.from(PORTRAIT); other.write('GIF89a', 0, 'ascii'); standIn.set(file, other); }],
    ['changed in pixels, at the same size', (standIn: AvatarStandIn, file: string) => { const other = Buffer.from(PORTRAIT); other.writeUInt32BE(9, 16); standIn.set(file, other); }],
    ['made to move', (standIn: AvatarStandIn, file: string) => { standIn.set(file, apngBytes(8, 8).subarray(0, PORTRAIT.length)); }],
    ['moved outside its root by a link above it', (standIn: AvatarStandIn, file: string) => { standIn.real.set(path.resolve(file), path.resolve('/elsewhere/portrait.png')); }],
  ])('answers a file %s since the scan as changed', async (_name, change) => {
    const standIn = setup();
    const { catalog, ids } = await catalogOf(standIn);
    const source = createAvatarSource({ file: (id) => catalog.file(id), fs: standIn.fs });
    change(standIn, path.join(ROOT, 'Orange', 'Op', 'portrait.png'));
    expect(await source.serve(ids['Orange/Op/portrait'] ?? '')).toEqual({ status: 404, kind: 'changed' });
  });

  it('answers a file gone, or one the system will not hand over, as unavailable', async () => {
    const standIn = setup();
    const { catalog, ids } = await catalogOf(standIn);
    const source = createAvatarSource({ file: (id) => catalog.file(id), fs: standIn.fs });
    standIn.failing.set(path.join(ROOT, 'Orange', 'Op', 'small.webp'), 'EACCES');
    expect(await source.serve(ids['Orange/Op/small'] ?? '')).toEqual({ status: 404, kind: 'unavailable' });
    standIn.remove(path.join(ROOT, 'Orange', 'Op', 'portrait.png'));
    expect(await source.serve(ids['Orange/Op/portrait'] ?? '')).toEqual({ status: 404, kind: 'unavailable' });
  });
});

describe('on the real file system (V16; C58, C61)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fatg-avatars-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('serves a file of a folder of any name the system allows, and nothing once a folder above it links elsewhere', async () => {
    const root = path.join(dir, 'avatars');
    const outside = path.join(dir, 'outside');
    const avatarFolder = path.join(root, 'Fam #1 %', 'Ävätär 名前');
    mkdirSync(avatarFolder, { recursive: true });
    mkdirSync(path.join(outside, 'Ävätär 名前'), { recursive: true });
    writeFileSync(path.join(avatarFolder, 'Portrait.PNG'), PORTRAIT);
    writeFileSync(path.join(outside, 'Ävätär 名前', 'Portrait.PNG'), PORTRAIT);
    let catalog = buildCatalog([await scanRoot('user', root, nodeAvatarFs)], new Set());
    const source = createAvatarSource({ file: (id) => catalog.file(id), fs: nodeAvatarFs });
    const id = catalog.listing.roots[0]?.families[0]?.avatars[0]?.files[0]?.id ?? '';
    expect(await source.serve(id)).toMatchObject({ status: 200, contentType: 'image/png' });
    // The family's folder swapped for a link (a junction on Windows) to a folder outside the root.
    rmSync(path.join(root, 'Fam #1 %'), { recursive: true, force: true });
    symlinkSync(outside, path.join(root, 'Fam #1 %'), 'junction');
    expect(await source.serve(id)).toEqual({ status: 404, kind: 'changed' });
    // And a scan now follows it nowhere: a link at the root is passed over.
    catalog = buildCatalog([await scanRoot('user', root, nodeAvatarFs)], new Set());
    expect(catalog.listing.roots[0]?.families).toEqual([]);
  });
});
