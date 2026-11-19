// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16, V3 (docs/planning/_archive/M23.md; C6, C8, C10, C11, C85): the active images' folder — a file written
// once under its hash through a temporary name, the same bytes kept as one file, a read that serves
// only the file the store names and only as it was written, the unlink, and the sweep at an open.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobHashOfPath, type BlobIo, blobName, createBlobFiles, nodeBlobIo, sha256 } from './files';
import { gifBytes, pngBytes } from '../images/test-support';

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-attachments-'));
  root = path.join(dir, 'attachments');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

const png = pngBytes(8, 8);
const hash = sha256(png);

describe('a write (V16; C85)', () => {
  it('writes the bytes under their hash and the ending their signature gives, through a temporary file renamed over', async () => {
    const renames: [string, string][] = [];
    const io: BlobIo = { ...nodeBlobIo, rename: async (from, to) => { renames.push([path.basename(from), path.basename(to)]); await nodeBlobIo.rename(from, to); } };
    const blobs = createBlobFiles(root, io);
    await blobs.write(hash, 'image/png', png);
    expect(readdirSync(root)).toEqual([`${hash}.png`]);
    expect(readFileSync(path.join(root, `${hash}.png`)).equals(png)).toBe(true);
    expect(renames).toHaveLength(1);
    expect(renames[0]?.[0]).toMatch(/^\.stage-[0-9a-f-]+\.tmp$/);
    expect(renames[0]?.[1]).toBe(blobName(hash, 'image/png'));
  });

  it('keeps one file for the same bytes staged twice, and never writes over a valid one', async () => {
    const writes: string[] = [];
    const io: BlobIo = { ...nodeBlobIo, writeFile: async (file, bytes) => { writes.push(path.basename(file)); await nodeBlobIo.writeFile(file, bytes); } };
    const blobs = createBlobFiles(root, io);
    await blobs.write(hash, 'image/png', png);
    await blobs.write(hash, 'image/png', png);
    // Two stagings side by side: one file, and nothing left behind.
    await Promise.all([blobs.write(hash, 'image/png', png), blobs.write(hash, 'image/png', png)]);
    expect(readdirSync(root)).toEqual([`${hash}.png`]);
    expect(writes.length).toBeLessThanOrEqual(3);
  });

  it('leaves no temporary file when the rename fails, and rejects', async () => {
    const io: BlobIo = { ...nodeBlobIo, rename: () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) };
    await expect(createBlobFiles(root, io).write(hash, 'image/png', png)).rejects.toThrow('busy');
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a name that is no hash, before any path is made of it', async () => {
    await expect(createBlobFiles(root).write('../records', 'image/png', png)).rejects.toThrow();
    expect(createBlobFiles(root).remove('..\\records.json', 'image/png')).toBe(false);
  });
});

describe('a read for the media route (V3; C10, C11)', () => {
  it('answers the file the store names, as it was written', async () => {
    const blobs = createBlobFiles(root);
    await blobs.write(hash, 'image/png', png);
    expect(Buffer.from((await blobs.read(hash, 'image/png', png.length)) ?? []).equals(png)).toBe(true);
    expect(blobs.holds(hash, 'image/png', png.length)).toBe(true);
  });

  it('answers nothing for a file that changed, a size the store does not name, a missing file or another ending', async () => {
    const blobs = createBlobFiles(root);
    await blobs.write(hash, 'image/png', png);
    expect(await blobs.read(hash, 'image/png', png.length + 1)).toBeNull();
    expect(await blobs.read(hash, 'image/gif', png.length)).toBeNull();
    // The same length, other bytes: read to check, never served.
    const changed = Buffer.from(png);
    changed.writeUInt8(changed.readUInt8(changed.length - 1) ^ 0xff, changed.length - 1);
    writeFileSync(path.join(root, `${hash}.png`), changed);
    expect(await blobs.read(hash, 'image/png', png.length)).toBeNull();
    rmSync(path.join(root, `${hash}.png`));
    expect(await blobs.read(hash, 'image/png', png.length)).toBeNull();
    expect(blobs.holds(hash, 'image/png', png.length)).toBe(false);
  });

  it('answers nothing for a link in the file’s place (V3)', async (context) => {
    const blobs = createBlobFiles(root);
    mkdirSync(root, { recursive: true });
    const elsewhere = path.join(dir, 'elsewhere.png');
    writeFileSync(elsewhere, png);
    try {
      symlinkSync(elsewhere, path.join(root, `${hash}.png`), 'file');
    } catch {
      // Windows grants a link only to an administrator or in developer mode: nothing to check here then.
      context.skip();
      return;
    }
    expect(await blobs.read(hash, 'image/png', png.length)).toBeNull();
    expect(blobs.holds(hash, 'image/png', png.length)).toBe(false);
  });
});

describe('the unlink and the sweep (V16; C6)', () => {
  it('unlinks an image, and answers false where it could not', async () => {
    const blobs = createBlobFiles(root);
    await blobs.write(hash, 'image/png', png);
    expect(blobs.remove(hash, 'image/png')).toBe(true);
    expect(readdirSync(root)).toEqual([]);
    // One that is gone already is no failure.
    expect(blobs.remove(hash, 'image/png')).toBe(true);
    const failing = createBlobFiles(root, { ...nodeBlobIo, remove: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
    expect(failing.remove(hash, 'image/png')).toBe(false);
  });

  it('removes temporary files and images no row names, and leaves every other name as it is', async () => {
    const blobs = createBlobFiles(root);
    const gif = gifBytes(3, 3);
    await blobs.write(hash, 'image/png', png);
    await blobs.write(sha256(gif), 'image/gif', gif);
    writeFileSync(path.join(root, '.stage-0123abcd.tmp'), 'cut short');
    writeFileSync(path.join(root, 'notes.txt'), 'someone else’s');
    writeFileSync(path.join(root, `${'a'.repeat(64)}.png`), png);
    const removed = blobs.sweep((candidate, mediaType) => candidate === hash && mediaType === 'image/png');
    expect(removed).toBe(3);
    expect(readdirSync(root).sort()).toEqual([`${hash}.png`, 'notes.txt']);
    // An image named under another ending than its row's is not the row's.
    expect(blobs.sweep((candidate, mediaType) => candidate === hash && mediaType === 'image/gif')).toBe(1);
  });

  it('sweeps nothing where the folder is not there', () => {
    expect(createBlobFiles(root).sweep(() => false)).toBe(0);
  });

  it('counts and measures the images alone (C12)', async () => {
    const blobs = createBlobFiles(root);
    expect(blobs.measure()).toEqual({ count: 0, bytes: 0 });
    await blobs.write(hash, 'image/png', png);
    writeFileSync(path.join(root, '.stage-1.tmp'), 'x');
    expect(blobs.measure()).toEqual({ count: 1, bytes: png.length });
  });
});

describe('a path a provider’s history names (V5; C25)', () => {
  it('names an image only for a file directly in the folder, named as fat-g names one', () => {
    expect(blobHashOfPath(root, path.join(root, `${hash}.png`))).toEqual({ hash, mediaType: 'image/png' });
    expect(blobHashOfPath(root, path.join(root, `${hash}.jpg`))).toEqual({ hash, mediaType: 'image/jpeg' });
    expect(blobHashOfPath(root, path.join(root, 'sub', `${hash}.png`))).toBeNull();
    expect(blobHashOfPath(root, path.join(dir, `${hash}.png`))).toBeNull();
    expect(blobHashOfPath(root, path.join(root, '..', 'attachments-other', `${hash}.png`))).toBeNull();
    expect(blobHashOfPath(root, path.join(root, `${hash}.bmp`))).toBeNull();
    expect(blobHashOfPath(root, `${hash}.png`)).toBeNull();
    expect(blobHashOfPath(root, path.join(root, `${hash.toUpperCase()}.png`))).toBeNull();
  });
});
