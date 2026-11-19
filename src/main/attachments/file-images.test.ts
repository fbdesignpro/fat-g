// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, SESSION } from '../files/test-support';
import { pathLib } from '../files/confine';
import { pngBytes } from '../images/test-support';
import { createAttachmentSource } from '../media/attachments';
import { createImageFileSource } from '../media/files';
import { regularOwnedFile } from '../storage/owned-file';
import { createAttachmentImageFiles } from './file-images';
import { createBlobFiles, sha256 } from './files';

const PNG = pngBytes(64, 32);
const HASH = sha256(PNG);
const HELD = { mediaType: 'image/png' as const, bytes: PNG.length, width: 64, height: 32 };

describe.each(['win32', 'darwin', 'linux'])('an attachment an agent reads, on %s', (platform) => {
  const paths = pathLib(platform);
  const data = platform === 'win32' ? 'C:\\home\\fat-g' : '/home/fat-g';
  const root = paths.join(data, 'attachments');
  const file = paths.join(root, `${HASH}.png`);
  const setup = () => {
    let known = true;
    let located: string | null = file;
    const image = (hash: string) => known && hash === HASH ? HELD : null;
    const read = vi.fn(() => Promise.resolve(PNG));
    const source = createAttachmentSource({ image, read });
    const owned = createAttachmentImageFiles({ root, platform, image, source, locate: () => located });
    const h = harness({ platform, roots: [paths.resolve(data, '..', 'project')], tree: {}, refused: [data], owned });
    return { ...h, read, forget: () => { known = false; }, locate: (value: string | null) => { located = value; } };
  };

  it('previews the known attachment through its owning source, without asking the general file system about app data', async () => {
    const h = setup();
    const first = await h.reader.read({ sessionId: SESSION, target: file });
    expect(first).toMatchObject({ outcome: 'image', path: file, width: 64, height: 32 });
    if (first?.outcome !== 'image') throw new Error('image was not admitted');
    expect(await h.reader.read({ sessionId: SESSION, target: file })).toEqual(first);
    expect(await createImageFileSource(h.images).serve(first.id)).toMatchObject({ status: 200, contentType: 'image/png', body: PNG });
    expect(await h.images.serve(first.id, SESSION)).toMatchObject({ ok: true, bytes: PNG });
    expect(await h.images.serve(first.id, 'another-session')).toEqual({ ok: false, kind: 'id' });
    expect(h.read).toHaveBeenCalledWith(HASH, 'image/png', PNG.length);
    expect(h.asked()).toEqual([]);
  });

  it('opens and reveals the same checked file from path references and local file URLs', async () => {
    const h = setup();
    const url = platform === 'win32' ? `file:///${file.replaceAll('\\', '/')}` : `file://${file}`;
    expect(await h.reader.read({ sessionId: SESSION, target: url })).toMatchObject({ outcome: 'image', path: file });
    expect(await h.reader.place({ sessionId: SESSION, target: file })).toEqual({ ok: true, kind: 'file', path: file });
    expect(await h.reader.locate({ sessionId: SESSION, path: file })).toEqual({ ok: true, path: file });
    expect(await h.reader.read({ sessionId: 'unlisted', target: file })).toBeNull();
    // Visible text polling never acquires this image exception.
    expect(await h.reader.refresh({ sessionId: SESSION, path: file, revision: null })).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.asked()).toEqual([]);
  });

  it('keeps arbitrary app data, unknown blobs, wrong extensions and nested paths refused before any file read', async () => {
    const h = setup();
    const targets = [
      paths.join(data, 'preferences.json'), paths.join(data, 'private.png'),
      paths.join(root, `${'f'.repeat(64)}.png`), paths.join(root, `${HASH}.jpg`),
      paths.join(root, 'nested', `${HASH}.png`), paths.join(data, 'other', `${HASH}.png`),
      paths.join(root, '.stage-image.png'),
    ];
    for (const target of targets) expect(await h.reader.read({ sessionId: SESSION, target })).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.asked()).toEqual([]);
  });

  it('rechecks ownership, location and session on every serving and refuses network redirection before reading bytes', async () => {
    const h = setup();
    const first = await h.reader.read({ sessionId: SESSION, target: file });
    if (first?.outcome !== 'image') throw new Error('image was not admitted');
    h.read.mockClear();
    h.locate(platform === 'win32' ? '\\\\server\\share\\image.png' : '//server/share/image.png');
    expect(await h.images.serve(first.id)).toEqual({ ok: false, kind: 'unavailable' });
    expect(h.read).not.toHaveBeenCalled();
    h.locate(null);
    expect(await h.reader.read({ sessionId: SESSION, target: file })).toEqual({ outcome: 'refused', why: 'no-answer' });
    expect(await h.reader.locate({ sessionId: SESSION, path: file })).toEqual({ ok: false, why: 'no-answer' });
    h.forget();
    expect(await h.images.serve(first.id)).toEqual({ ok: false, kind: 'changed' });
    expect(await h.reader.read({ sessionId: SESSION, target: file })).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.asked()).toEqual([]);
  });

  it('drops bytes if the store removes the image while its read is in flight', async () => {
    const h = setup();
    h.read.mockImplementationOnce(() => { h.forget(); return Promise.resolve(PNG); });
    expect(await h.reader.read({ sessionId: SESSION, target: file })).toEqual({ outcome: 'refused', why: 'no-answer' });
  });
});

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

it('uses real blob hash checks and refuses a changed file or an attachment replaced by a link', async () => {
  const data = mkdtempSync(path.join(tmpdir(), 'fatg-image-reference-'));
  directories.push(data);
  const blobs = createBlobFiles(path.join(data, 'attachments'));
  await blobs.write(HASH, 'image/png', PNG);
  const file = blobs.pathOf(HASH, 'image/png');
  const image = (hash: string) => hash === HASH ? HELD : null;
  const source = createAttachmentSource({ image, read: (hash, mediaType, bytes) => blobs.read(hash, mediaType, bytes) });
  const owned = createAttachmentImageFiles({ root: blobs.root, platform: process.platform, image, source, locate: () => regularOwnedFile(blobs.root, file) });
  const h = harness({ platform: process.platform, tree: {}, roots: [path.join(data, 'project')], refused: [data], owned });
  expect(await h.reader.read({ sessionId: SESSION, target: file })).toMatchObject({ outcome: 'image' });
  const changed = Buffer.from(PNG);
  changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
  writeFileSync(file, changed);
  expect(await h.reader.read({ sessionId: SESSION, target: file })).toEqual({ outcome: 'refused', why: 'no-answer' });
  rmSync(file);
  const elsewhere = path.join(data, 'elsewhere');
  mkdirSync(elsewhere);
  const other = path.join(elsewhere, path.basename(file));
  writeFileSync(other, PNG);
  symlinkSync(elsewhere, path.join(blobs.root, 'redirected'), 'junction');
  // A valid hash elsewhere still cannot acquire ownership through a descendant link.
  expect(await owned.read(path.join(blobs.root, 'redirected', path.basename(file)))).toBeNull();
  // And a final link to identical bytes is refused by the existing owned-file check.
  symlinkSync(other, file, 'file');
  expect(await h.reader.read({ sessionId: SESSION, target: file })).toEqual({ outcome: 'refused', why: 'no-answer' });
});
