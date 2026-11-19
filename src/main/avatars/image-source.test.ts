// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Browse for an avatar's image (decision 0036): the chooser opens where the last image came from —
// chosen, or dropped, as the preload tells — and the page gets the image's name and bytes, never its path.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { createImageSource } from './image-source';
import { avatarStandIn } from './test-support';

const PICTURES = path.resolve('/pictures');
const DOWNLOADS = path.resolve('/downloads');

function setup(answers: (string | null)[]) {
  const standIn = avatarStandIn({
    [path.join(PICTURES, 'sun.png')]: new Uint8Array([1, 2, 3]),
    [path.join(DOWNLOADS, 'moon.webp')]: new Uint8Array([4]),
    [path.join(DOWNLOADS, 'huge.png')]: new Uint8Array(MAX_IMAGE_BYTES + 1),
    [path.join(DOWNLOADS, 'empty.png')]: new Uint8Array(0),
  });
  const pick = vi.fn((_folder: string | undefined) => Promise.resolve(answers.shift() ?? null));
  return { source: createImageSource({ pick, fs: standIn.fs }), pick };
}

describe('Browse (decision 0036)', () => {
  it('opens where the system remembers at first, then at the folder of the image chosen, and answers its name and bytes alone', async () => {
    const { source, pick } = setup([path.join(PICTURES, 'sun.png'), path.join(DOWNLOADS, 'moon.webp')]);
    expect(await source.choose()).toEqual({ kind: 'chosen', name: 'sun.png', bytes: new Uint8Array([1, 2, 3]) });
    expect(await source.choose()).toEqual({ kind: 'chosen', name: 'moon.webp', bytes: new Uint8Array([4]) });
    expect(pick.mock.calls.map(([folder]) => folder)).toEqual([undefined, PICTURES]);
    expect(source.lastFolder()).toBe(DOWNLOADS);
  });

  it('opens at the folder a dropped image came from', async () => {
    const { source, pick } = setup([null]);
    source.noteDropped(path.join(DOWNLOADS, 'moon.webp'));
    source.noteDropped('relative/elsewhere.png');
    expect(await source.choose()).toEqual({ kind: 'cancelled' });
    expect(pick).toHaveBeenCalledExactlyOnceWith(DOWNLOADS);
  });

  it('refuses an image past the one bound, an empty file and one it cannot read, but keeps their folder', async () => {
    const { source, pick } = setup([path.join(DOWNLOADS, 'huge.png'), path.join(DOWNLOADS, 'empty.png'), path.join(PICTURES, 'gone.png')]);
    expect(await source.choose()).toEqual({ kind: 'refused', reason: 'too-large' });
    expect(await source.choose()).toEqual({ kind: 'refused', reason: 'unreadable' });
    expect(await source.choose()).toEqual({ kind: 'refused', reason: 'unreadable' });
    expect(pick.mock.calls.map(([folder]) => folder)).toEqual([undefined, DOWNLOADS, DOWNLOADS]);
    expect(source.lastFolder()).toBe(PICTURES);
  });
});
