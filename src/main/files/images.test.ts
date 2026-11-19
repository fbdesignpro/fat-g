// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0022, item 15: an image file, read wherever it lies on this machine's own disks — an image an
// agent read, or one a reference names — on the file system stand-in that records every call, with
// each system's path rules on every system. A refusal of the first confinement asks the file system
// nothing; what passes is named by an id for the run, and every serving of the id checks the file again.
import { describe, expect, it } from 'vitest';
import type { FileReadAnswer } from '@shared/contracts/files';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { gifBytes, pngBytes, webpBytes } from '../images/test-support';
import { MAX_IMAGE_FILES } from './images';
import { harness, SESSION } from './test-support';

const PLATFORMS = ['win32', 'darwin', 'linux'] as const;
const on = (platform: string) => (...parts: string[]): string => (platform === 'win32' ? `C:\\${parts.join('\\')}` : `/${parts.join('/')}`);
const OTHER_SESSION = '3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a99';
const PNG = pngBytes(64, 32);

describe.each(PLATFORMS)('an image file, on %s (decision 0022, item 15)', (platform) => {
  const abs = on(platform);
  const root = abs('proj');
  const config = abs('home', '.codex');
  // A share's path is Windows's: elsewhere a leading `//` is the root's, a path on this machine.
  const share = platform === 'win32' ? '\\\\server\\share\\shot.png' : null;
  const tree = {
    [abs('proj', 'docs', 'diagram.png')]: PNG,
    [abs('tmp', 'fable-crop-a.png')]: PNG,
    [abs('tmp', 'fable-crop-b.WEBP')]: webpBytes('VP8L', 40, 40),
    [abs('tmp', 'notes.txt')]: 'not an image\n',
    [abs('tmp', 'fake.png')]: 'plain text under an image’s name',
    [abs('tmp', 'huge.png')]: { size: MAX_IMAGE_BYTES + 1 },
    [abs('tmp', 'wide.gif')]: gifBytes(8001, 10),
    [abs('tmp', 'folder.png')]: { folder: true },
    [abs('tmp', 'into-config.png')]: { link: abs('home', '.codex', 'generated.png') },
    [abs('home', '.codex', 'generated.png')]: PNG,
  } as const;
  const make = () => harness({ platform, tree, roots: [root], refused: [config] });
  const read = (h: ReturnType<typeof make>, target: string, sessionId = SESSION): Promise<FileReadAnswer | null> => h.reader.read({ sessionId, target });

  it('reads one outside the project’s folders, and names it by an id for the run: the same one for the same file of a session', async () => {
    const h = make();
    const first = await read(h, abs('tmp', 'fable-crop-a.png'));
    expect(first).toEqual({ outcome: 'image', path: abs('tmp', 'fable-crop-a.png'), id: '1'.padStart(32, '0'), width: 64, height: 32 });
    expect(await read(h, abs('tmp', 'fable-crop-a.png'))).toEqual(first);
    // Its name in any letter case, and a relative one inside the project, as any reference.
    expect(await read(h, abs('tmp', 'fable-crop-b.WEBP'))).toMatchObject({ outcome: 'image', width: 40, height: 40 });
    expect(await read(h, 'docs/diagram.png')).toMatchObject({ outcome: 'image', path: abs('proj', 'docs', 'diagram.png') });
  });

  it('gives another session another id for the same file, and serves an id to its own session alone', async () => {
    const h = make();
    const mine = await h.images.admit(SESSION, abs('tmp', 'fable-crop-a.png'));
    const theirs = await h.images.admit(OTHER_SESSION, abs('tmp', 'fable-crop-a.png'));
    expect(mine.ok && theirs.ok && mine.image.id !== theirs.image.id).toBe(true);
    if (!mine.ok) return;
    expect(await h.images.serve(mine.image.id, SESSION)).toMatchObject({ ok: true, mediaType: 'image/png' });
    expect(await h.images.serve(mine.image.id, OTHER_SESSION)).toEqual({ ok: false, kind: 'id' });
    // The other session is not listed: its id serves nothing, by the route or by Copy.
    if (theirs.ok) expect(await h.images.serve(theirs.image.id)).toEqual({ ok: false, kind: 'id' });
  });

  it('gives edited pixels a new preview address even when the path and dimensions are unchanged', async () => {
    const h = make();
    const file = abs('tmp', 'fable-crop-a.png');
    const first = await h.images.admit(SESSION, file);
    if (!first.ok) throw new Error('not admitted');
    const replacement = pngBytes(64, 32, [0, 255, 0], [255, 0, 255]);
    h.set(file, replacement);
    expect(await h.images.serve(first.image.id)).toEqual({ ok: false, kind: 'changed' });
    const next = await h.images.admit(SESSION, file);
    if (!next.ok) throw new Error('not admitted');
    expect(next.image.id).not.toBe(first.image.id);
    expect(next.image).toMatchObject({ path: file, width: 64, height: 32 });
    const served = await h.images.serve(next.image.id);
    expect(served.ok && Buffer.from(served.bytes).equals(replacement)).toBe(true);
    expect(await h.images.admit(SESSION, file)).toEqual(next);
  });

  it('refuses a share’s or a device’s path, and one inside a folder fat-g never reads, before the file system is asked anything', async () => {
    const h = make();
    h.asked();
    if (share !== null) expect(await read(h, share)).toEqual({ outcome: 'refused', why: 'outside' });
    if (platform === 'win32') expect(await read(h, '\\\\?\\C:\\tmp\\fable-crop-a.png')).toEqual({ outcome: 'refused', why: 'outside' });
    expect(await read(h, abs('home', '.codex', 'generated.png'))).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.asked()).toEqual([]);
  });

  it('refuses a link that leads into a folder fat-g never reads, by its real path, and reads none of it', async () => {
    const h = make();
    h.asked();
    expect(await read(h, abs('tmp', 'into-config.png'))).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.asked().filter((call) => call.startsWith('read '))).toEqual([]);
  });

  it('refuses outside the project’s folders one that is too large, none of whose bytes is read, one past 8,000 pixels a side, and one that is no image', async () => {
    const h = make();
    h.asked();
    expect(await read(h, abs('tmp', 'huge.png'))).toEqual({ outcome: 'refused', why: 'not-image' });
    expect(h.asked().filter((call) => call.startsWith('read '))).toEqual([]);
    expect(await read(h, abs('tmp', 'wide.gif'))).toEqual({ outcome: 'refused', why: 'not-image' });
    expect(await read(h, abs('tmp', 'fake.png'))).toEqual({ outcome: 'refused', why: 'not-image' });
  });

  it('reads no other kind of file outside the project’s folders, and opens no folder there by an image’s name', async () => {
    const h = make();
    h.asked();
    expect(await read(h, abs('tmp', 'notes.txt'))).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.asked()).toEqual([]);
    expect(await read(h, abs('tmp', 'folder.png'))).toEqual({ outcome: 'refused', why: 'outside' });
    expect(await h.reader.place({ sessionId: SESSION, target: abs('tmp', 'folder.png') })).toEqual({ ok: false, why: 'outside' });
  });

  it('places one for its reference’s menu, and Show in folder, by its real path; never another kind of file outside', async () => {
    const h = make();
    expect(await h.reader.place({ sessionId: SESSION, target: abs('tmp', 'fable-crop-a.png') })).toEqual({ ok: true, kind: 'file', path: abs('tmp', 'fable-crop-a.png') });
    expect(await h.reader.locate({ sessionId: SESSION, path: abs('tmp', 'fable-crop-a.png') })).toEqual({ ok: true, path: abs('tmp', 'fable-crop-a.png') });
    expect(await h.reader.locate({ sessionId: SESSION, path: abs('tmp', 'notes.txt') })).toEqual({ ok: false, why: 'outside' });
    if (share !== null) expect(await h.reader.locate({ sessionId: SESSION, path: share })).toEqual({ ok: false, why: 'outside' });
    expect(await h.reader.locate({ sessionId: SESSION, path: abs('tmp', 'into-config.png') })).toEqual({ ok: false, why: 'outside' });
  });

  it('serves an id’s file checked again: changed in size or type, gone, or turned into a link elsewhere, it serves nothing', async () => {
    const h = make();
    const admitted = await h.images.admit(SESSION, abs('tmp', 'fable-crop-a.png'));
    if (!admitted.ok) throw new Error('not admitted');
    const { id } = admitted.image;
    const served = await h.images.serve(id);
    expect(served).toMatchObject({ ok: true, mediaType: 'image/png' });
    expect(served.ok && Buffer.from(served.bytes).equals(PNG)).toBe(true);
    h.set(abs('tmp', 'fable-crop-a.png'), pngBytes(65, 32));
    expect(await h.images.serve(id)).toEqual({ ok: false, kind: 'changed' });
    h.set(abs('tmp', 'fable-crop-a.png'), { link: abs('proj', 'docs', 'diagram.png') });
    expect(await h.images.serve(id)).toEqual({ ok: false, kind: 'changed' });
    h.remove(abs('tmp', 'fable-crop-a.png'));
    expect(await h.images.serve(id)).toEqual({ ok: false, kind: 'unavailable' });
    expect(await h.images.serve('f'.repeat(32))).toEqual({ ok: false, kind: 'id' });
    // Read again once it is back: changed content gets a new preview address.
    h.set(abs('tmp', 'fable-crop-a.png'), pngBytes(65, 32));
    const next = await read(h, abs('tmp', 'fable-crop-a.png'));
    expect(next).toMatchObject({ outcome: 'image', width: 65 });
    if (next?.outcome !== 'image') throw new Error('not admitted');
    expect(next.id).not.toBe(id);
    expect(await h.images.serve(next.id)).toMatchObject({ ok: true });
  });

  it(`holds ${MAX_IMAGE_FILES} ids at most: past it, the one named longest ago is forgotten`, async () => {
    const h = make();
    const ids: string[] = [];
    for (let n = 0; n <= MAX_IMAGE_FILES; n += 1) {
      h.set(abs('tmp', 'many', `${n}.png`), PNG);
      const admitted = await h.images.admit(SESSION, abs('tmp', 'many', `${n}.png`));
      if (admitted.ok) ids.push(admitted.image.id);
    }
    expect(ids).toHaveLength(MAX_IMAGE_FILES + 1);
    expect(await h.images.serve(ids[0] ?? '')).toEqual({ ok: false, kind: 'id' });
    expect(await h.images.serve(ids[1] ?? '')).toMatchObject({ ok: true });
  });
});
