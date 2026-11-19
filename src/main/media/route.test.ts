// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3 (docs/planning/_archive/M23.md; C10, C11) and V22 (docs/planning/_archive/M102.md; C59, C60, C62): the confined
// media route — an address of one shape, a method of one kind, a source that answers by its own rule
// with its own cache policy, and an image served only as the store names it and the folder still holds
// it, whatever the request says; with the avatars source beside the attachments', each its own ids alone.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentMediaType } from '@shared/contracts/attachments';
import { createBlobFiles, sha256 } from '../attachments/files';
import { buildCatalog } from '../avatars/catalog';
import { scanRoot } from '../avatars/scan';
import { avatarStandIn } from '../avatars/test-support';
import { gifBytes, jpegBytes, pngBytes, webpBytes } from '../images/test-support';
import { ATTACHMENTS_SOURCE, createAttachmentSource, type HeldImage } from './attachments';
import { createAvatarSource } from './avatars';
import { createMediaRoute, mediaHeaders, parseMediaAddress } from './route';

const HASH = 'a'.repeat(64);

describe('an address (V3; C10)', () => {
  it('names a source and an id, and nothing else', () => {
    expect(parseMediaAddress(`app://media/attachments/${HASH}`)).toEqual({ source: 'attachments', id: HASH });
  });

  it.each([
    ['another host', `app://fatg/attachments/${HASH}`],
    ['another scheme', `https://media/attachments/${HASH}`],
    ['a path inside the id', `app://media/attachments/${HASH}/more`],
    ['no id', 'app://media/attachments'],
    ['a dot segment', `app://media/attachments/../records.json`],
    ['an encoded dot segment', `app://media/attachments/%2e%2e%2frecords.json`],
    ['an encoded character', `app://media/attachments/${HASH.slice(1)}%61`],
    ['a backslash', `app://media/attachments/..\\records.json`],
    ['a query', `app://media/attachments/${HASH}?x=1`],
    ['a fragment', `app://media/attachments/${HASH}#x`],
    ['a port', `app://media:80/attachments/${HASH}`],
    ['credentials', `app://user:pass@media/attachments/${HASH}`],
    ['an uppercase id', `app://media/attachments/${HASH.toUpperCase()}`],
    ['no address at all', 'not an address'],
  ])('refuses %s', (_name, url) => {
    expect(parseMediaAddress(url)).toBeNull();
  });
});

describe('the route (V3; C10, C11)', () => {
  const serve = vi.fn(() => Promise.resolve({ status: 200 as const, body: new Uint8Array([1]), contentType: 'image/png' }));
  const route = createMediaRoute([{ name: 'attachments', cache: 'no-store', serve }]);
  beforeEach(() => { serve.mockClear(); });

  it('asks the source named, by the id alone, and answers with its cache policy', async () => {
    expect(await route({ method: 'GET', url: `app://media/attachments/${HASH}` })).toMatchObject({ status: 200, cache: 'no-store' });
    expect(serve).toHaveBeenCalledWith(HASH);
  });

  it('refuses another method, an address of another shape and an unknown source before any source is asked', async () => {
    expect(await route({ method: 'POST', url: `app://media/attachments/${HASH}` })).toEqual({ status: 404, kind: 'method' });
    expect(await route({ method: 'HEAD', url: `app://media/attachments/${HASH}` })).toEqual({ status: 404, kind: 'method' });
    expect(await route({ method: 'GET', url: `app://media/attachments/..%5Crecords.json` })).toEqual({ status: 404, kind: 'address' });
    expect(await route({ method: 'GET', url: `app://media/portraits/${HASH}` })).toEqual({ status: 404, kind: 'source' });
    expect(serve).not.toHaveBeenCalled();
  });

  it('answers a source that throws as unavailable', async () => {
    const failing = createMediaRoute([{ name: 'attachments', cache: 'no-store', serve: () => Promise.reject(new Error('no')) }]);
    expect(await failing({ method: 'GET', url: `app://media/attachments/${HASH}` })).toEqual({ status: 404, kind: 'unavailable' });
  });

  it('serves with the signature’s type, nosniff, no Range and no cache (C11)', () => {
    const headers = mediaHeaders('image/webp', 'no-store');
    expect(headers).toMatchObject({ 'content-type': 'image/webp', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('accept-ranges');
  });
});

describe('the attachments source (V3; C10, C11, C85)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fatg-media-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  /** A source over a folder holding these images, each named by a row of what its header says. */
  async function sourceOf(images: readonly { readonly bytes: Uint8Array; readonly mediaType: AttachmentMediaType; readonly width: number; readonly height: number }[], read?: (hash: string) => void) {
    const blobs = createBlobFiles(path.join(dir, 'attachments'));
    const rows = new Map<string, HeldImage>();
    for (const image of images) {
      const hash = sha256(image.bytes);
      await blobs.write(hash, image.mediaType, image.bytes);
      rows.set(hash, { mediaType: image.mediaType, bytes: image.bytes.byteLength, width: image.width, height: image.height });
    }
    return { blobs, rows, source: createAttachmentSource({ image: (hash) => rows.get(hash) ?? null, read: (hash, mediaType, bytes) => { read?.(hash); return blobs.read(hash, mediaType, bytes); } }) };
  }

  it('serves each of the four types by its signature', async () => {
    const images = [
      { bytes: pngBytes(4, 3), mediaType: 'image/png' as const, width: 4, height: 3 },
      { bytes: jpegBytes(5, 6), mediaType: 'image/jpeg' as const, width: 5, height: 6 },
      { bytes: gifBytes(7, 8), mediaType: 'image/gif' as const, width: 7, height: 8 },
      { bytes: webpBytes('VP8L', 9, 10), mediaType: 'image/webp' as const, width: 9, height: 10 },
    ];
    const { source } = await sourceOf(images);
    expect(source.name).toBe(ATTACHMENTS_SOURCE);
    for (const image of images) {
      const answer = await source.serve(sha256(image.bytes));
      expect(answer).toMatchObject({ status: 200, contentType: image.mediaType });
      if (answer.status === 200) expect(Buffer.from(answer.body).equals(Buffer.from(image.bytes))).toBe(true);
    }
  });

  it('answers 404 for an id that is no hash and a hash the store names not, opening no file', async () => {
    const reads: string[] = [];
    const { source } = await sourceOf([], (hash) => reads.push(hash));
    expect(await source.serve('records')).toEqual({ status: 404, kind: 'id' });
    expect(await source.serve(HASH)).toEqual({ status: 404, kind: 'id' });
    expect(reads).toEqual([]);
  });

  it('reads a changed file to check it, and never serves it: other bytes, other pixels, another type', async () => {
    const png = pngBytes(4, 4);
    const hash = sha256(png);
    const { rows, source } = await sourceOf([{ bytes: png, mediaType: 'image/png', width: 4, height: 4 }]);
    // Same size, other bytes.
    const swapped = Buffer.from(png);
    swapped.writeUInt8(swapped.readUInt8(swapped.length - 5) ^ 1, swapped.length - 5);
    writeFileSync(path.join(dir, 'attachments', `${hash}.png`), swapped);
    expect(await source.serve(hash)).toEqual({ status: 404, kind: 'unavailable' });
    // The bytes as written, but a row that says other pixels: the header disagrees.
    writeFileSync(path.join(dir, 'attachments', `${hash}.png`), png);
    rows.set(hash, { mediaType: 'image/png', bytes: png.length, width: 5, height: 4 });
    expect(await source.serve(hash)).toEqual({ status: 404, kind: 'changed' });
    // A file gone.
    rmSync(path.join(dir, 'attachments', `${hash}.png`));
    rows.set(hash, { mediaType: 'image/png', bytes: png.length, width: 4, height: 4 });
    expect(await source.serve(hash)).toEqual({ status: 404, kind: 'unavailable' });
  });

  it('answers 404 while the store cannot say', async () => {
    const source = createAttachmentSource({ image: () => { throw new Error('closed'); }, read: () => Promise.resolve(null) });
    expect(await source.serve(HASH)).toEqual({ status: 404, kind: 'id' });
  });
});

describe('both sources registered (V22; M102, C59, C60, C62)', () => {
  const AVATARS = path.resolve('/avatars-root');

  it('serves an avatar’s new ids after a Rescan and an attachment’s hash still, each source its own ids alone, each with its own headers', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fatg-media-both-'));
    try {
      // An attachment, kept by the store under its hash.
      const blobs = createBlobFiles(path.join(dir, 'attachments'));
      const attachment = pngBytes(5, 5);
      const hash = sha256(attachment);
      await blobs.write(hash, 'image/png', attachment);
      const attachments = createAttachmentSource({ image: (id) => (id === hash ? { mediaType: 'image/png', bytes: attachment.length, width: 5, height: 5 } : null), read: (id, mediaType, bytes) => blobs.read(id, mediaType, bytes) });
      // An avatar, scanned, then changed and scanned again.
      const standIn = avatarStandIn({ [path.join(AVATARS, 'Orange', 'Op', 'portrait.png')]: pngBytes(8, 8) });
      const scan = async () => buildCatalog([await scanRoot('user', AVATARS, standIn.fs)], new Set());
      let catalog = await scan();
      const idOf = () => catalog.listing.roots[0]?.families[0]?.avatars[0]?.files[0]?.id ?? '';
      const route = createMediaRoute([attachments, createAvatarSource({ file: (id) => catalog.file(id), fs: standIn.fs })]);
      const old = idOf();
      standIn.set(path.join(AVATARS, 'Orange', 'Op', 'portrait.png'), { bytes: pngBytes(16, 16), mtimeMs: 9000 });
      catalog = await scan();
      const fresh = idOf();
      expect(fresh).not.toBe(old);
      expect(await route({ method: 'GET', url: `app://media/avatars/${fresh}` })).toMatchObject({ status: 200, contentType: 'image/png', cache: 'immutable' });
      expect(await route({ method: 'GET', url: `app://media/avatars/${old}` })).toEqual({ status: 404, kind: 'id' });
      expect(await route({ method: 'GET', url: `app://media/attachments/${hash}` })).toMatchObject({ status: 200, contentType: 'image/png', cache: 'no-store' });
      // Each source answers its own ids alone: neither takes the other's.
      expect(await route({ method: 'GET', url: `app://media/avatars/${hash}` })).toEqual({ status: 404, kind: 'id' });
      expect(await route({ method: 'GET', url: `app://media/attachments/${fresh}` })).toEqual({ status: 404, kind: 'id' });
      expect(mediaHeaders('image/png', 'no-store')).toEqual({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox" });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
