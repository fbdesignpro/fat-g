// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { pngBytes } from '../images/test-support';
import { IMAGE_REFRESH_SETTLE_MS } from './images';
import { harness, SESSION } from './test-support';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each(['win32', 'darwin', 'linux'])('visible image metadata checks on %s', (platform) => {
  const file = platform === 'win32' ? 'C:\\tmp\\preview.png' : '/tmp/preview.png';
  const original = pngBytes(64, 32);
  const changed = pngBytes(64, 32, [0, 255, 0], [255, 0, 255]);
  const make = () => harness({ platform, tree: { [file]: original }, roots: [] });
  const open = async (h: ReturnType<typeof make>) => {
    const read = await h.images.admit(SESSION, file);
    if (!read.ok) throw new Error('image not admitted');
    h.calls.length = 0;
    return { sessionId: SESSION, path: file, id: read.image.id };
  };
  const settle = async (pending: ReturnType<ReturnType<typeof make>['images']['refresh']>) => {
    await vi.advanceTimersByTimeAsync(IMAGE_REFRESH_SETTLE_MS);
    return pending;
  };

  it('checks unchanged metadata and confinement without reading bytes or listing folders', async () => {
    const h = make();
    const request = await open(h);
    expect(await h.images.refresh(request)).toEqual({ outcome: 'unchanged' });
    expect(h.calls.some(({ op }) => op === 'stat')).toBe(true);
    expect(h.calls.some(({ op }) => op === 'realpath')).toBe(true);
    expect(h.calls.filter(({ op }) => op === 'read' || op === 'list')).toEqual([]);
  });

  it('does not claim a content update for a timestamp-only save, and remembers its new metadata', async () => {
    const h = make();
    const request = await open(h);
    h.mtimes.set(file, 10);
    expect(await settle(h.images.refresh(request))).toEqual({ outcome: 'unchanged' });
    expect(h.calls.filter(({ op }) => op === 'read')).toHaveLength(1);
    h.calls.length = 0;
    expect(await h.images.refresh(request)).toEqual({ outcome: 'unchanged' });
    expect(h.calls.filter(({ op }) => op === 'read')).toEqual([]);
  });

  it('rereads stable changed pixels and returns a new id with the same path and dimensions', async () => {
    const h = make();
    const request = await open(h);
    h.set(file, changed);
    h.mtimes.set(file, 1);
    const answer = await settle(h.images.refresh(request));
    expect(answer).toMatchObject({ outcome: 'image', path: file, width: 64, height: 32 });
    if (answer?.outcome !== 'image') throw new Error('no replacement');
    expect(answer.id).not.toBe(request.id);
    expect(await h.images.serve(answer.id, SESSION)).toMatchObject({ ok: true, bytes: changed });
    h.calls.length = 0;
    // A link or another thumbnail can have advanced the main-owned revision already.
    expect(await h.images.refresh(request)).toMatchObject({ outcome: 'image', id: answer.id });
    expect(h.calls.filter(({ op }) => op === 'read')).toEqual([]);
    expect(await h.images.refresh({ ...request, id: answer.id })).toEqual({ outcome: 'unchanged' });
  });

  it('detects a size-only change', async () => {
    const h = make();
    const request = await open(h);
    h.set(file, Buffer.concat([original, Buffer.from('extra')]));
    expect(await settle(h.images.refresh(request))).toMatchObject({ outcome: 'image' });
  });

  it('does not read a file while its save is still changing', async () => {
    const h = make();
    const request = await open(h);
    h.mtimes.set(file, 1);
    const pending = h.images.refresh(request);
    await vi.advanceTimersByTimeAsync(0);
    h.mtimes.set(file, 2);
    expect(await settle(pending)).toEqual({ outcome: 'retry' });
    expect(h.calls.filter(({ op }) => op === 'read')).toEqual([]);
  });

  it('discards a read whose metadata changes while its bytes are read', async () => {
    const h = make();
    const request = await open(h);
    h.mtimes.set(file, 1);
    const read = h.fs.read.bind(h.fs);
    vi.spyOn(h.fs, 'read').mockImplementation(async (path, bound) => {
      const bytes = await read(path, bound);
      h.mtimes.set(file, 2);
      return bytes;
    });
    expect(await settle(h.images.refresh(request))).toEqual({ outcome: 'retry' });
  });

  it('keeps the known reference through deletion and access failures, and recovers after recreation', async () => {
    const h = make();
    const request = await open(h);
    h.remove(file);
    expect(await h.images.refresh(request)).toEqual({ outcome: 'refused', why: 'not-found' });
    h.set(file, changed);
    h.mtimes.set(file, 1);
    h.failing.set(file, 'EACCES');
    expect(await h.images.refresh(request)).toEqual({ outcome: 'refused', why: 'no-answer' });
    h.failing.clear();
    expect(await settle(h.images.refresh(request))).toMatchObject({ outcome: 'image' });
  });

  it('rechecks excluded folders before metadata, including an unchanged revision', async () => {
    const h = make();
    const request = await open(h);
    h.refused.push(file);
    expect(await h.images.refresh(request)).toEqual({ outcome: 'refused', why: 'outside' });
    expect(h.calls).toEqual([]);
  });

  it('refuses a redirected file and oversized bytes before any image read', async () => {
    const h = make();
    const request = await open(h);
    const other = platform === 'win32' ? 'C:\\other.png' : '/other.png';
    h.set(other, original);
    h.set(file, { link: other });
    expect(await h.images.refresh(request)).toEqual({ outcome: 'refused', why: 'outside' });
    h.set(file, { size: MAX_IMAGE_BYTES + 1 });
    expect(await h.images.refresh(request)).toEqual({ outcome: 'refused', why: 'not-image' });
    expect(h.calls.filter(({ op }) => op === 'read')).toEqual([]);
  });

  it('admits no new path, name lookup or other session through polling', async () => {
    const h = make();
    const request = await open(h);
    expect(await h.images.refresh({ ...request, sessionId: 'another' })).toBeNull();
    expect(await h.images.refresh({ ...request, path: 'preview.png' })).toBeNull();
    expect(await h.images.refresh({ ...request, path: `${file}.png` })).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('bounds an unresponsive metadata lookup without reading bytes', async () => {
    const h = make();
    const request = await open(h);
    h.hung.add(file);
    const pending = h.images.refresh(request);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ outcome: 'refused', why: 'no-answer' });
    expect(h.calls.filter(({ op }) => op === 'read')).toEqual([]);
  });

  it('does not reread an immutable owned attachment during a metadata check', async () => {
    const read = vi.fn(() => Promise.resolve(original));
    const h = harness({ platform, tree: {}, roots: [], refused: [file], owned: { owns: (path) => path === file, read } });
    const request = await open(h);
    read.mockClear();
    expect(await h.images.refresh(request)).toEqual({ outcome: 'unchanged' });
    expect(read).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });
});
