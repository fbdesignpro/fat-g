// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An added image made into a new avatar's two PNGs (decision 0036): decoded and encoded by Chromium,
// stood in for here, and scaled by the resampler, whose own tests are lanczos.test.ts'.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { prepareAvatarImage, prepareSmallImage, WORKING_SIDE_MAX } from './avatar-image';
import { resampleSquare } from './lanczos';

vi.mock('./lanczos', () => ({ resampleSquare: vi.fn((_pixels: Uint8ClampedArray, _side: number, target: number) => Promise.resolve(new Uint8ClampedArray(target * target * 4))) }));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [...'RIFF'].map((char) => char.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((char) => char.charCodeAt(0)));
const GIF = [...'GIF89a'].map((char) => char.charCodeAt(0));
const fileOf = (signature: readonly number[], size = 64): File => {
  const bytes = new Uint8Array(Math.max(size, signature.length));
  bytes.set(signature);
  return new File([bytes], 'image');
};

let decoded: { width: number; height: number };
let encoded: number[];
let drawn: number[];
const close = vi.fn();
const bitmap = vi.fn();

beforeEach(() => {
  decoded = { width: 512, height: 512 };
  encoded = [];
  drawn = [];
  close.mockClear();
  bitmap.mockReset();
  bitmap.mockImplementation((_source: unknown, options?: ImageBitmapOptions) => Promise.resolve(options?.resizeWidth === undefined ? { ...decoded, close } : { width: options.resizeWidth, height: options.resizeHeight, close }));
  vi.mocked(resampleSquare).mockClear();
  vi.stubGlobal('createImageBitmap', bitmap);
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return {
        drawImage: () => { drawn.push(this.width); },
        getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: () => undefined,
      };
    }
    convertToBlob() {
      encoded.push(this.width);
      return Promise.resolve(new Blob([new Uint8Array([this.width % 256, 0x50])], { type: 'image/png' }));
    }
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('prepareAvatarImage (decision 0036)', () => {
  it('keeps a PNG of 512 px byte for byte, and makes its 64 px small', async () => {
    const file = fileOf(PNG);
    const prepared = await prepareAvatarImage(file);
    expect(prepared).toMatchObject({ kind: 'prepared', sourceSide: 512, portraitSide: 512 });
    if (prepared.kind !== 'prepared') throw new Error('refused');
    expect(prepared.portrait).toEqual(new Uint8Array(await file.arrayBuffer()));
    expect(encoded).toEqual([64]);
    expect(vi.mocked(resampleSquare).mock.calls.map(([, side, target]) => [side, target])).toEqual([[512, 64]]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('scales a larger image down to 512 px, and the small from the image itself', async () => {
    decoded = { width: 1500, height: 1500 };
    const prepared = await prepareAvatarImage(fileOf(JPEG));
    expect(prepared).toMatchObject({ kind: 'prepared', sourceSide: 1500, portraitSide: 512 });
    expect(vi.mocked(resampleSquare).mock.calls.map(([, side, target]) => [side, target])).toEqual([[1500, 512], [1500, 64]]);
    expect(encoded).toEqual([512, 64]);
    expect(drawn).toEqual([1500]);
  });

  it('scales up nothing: a smaller WebP is a PNG of its own side', async () => {
    decoded = { width: 300, height: 300 };
    const prepared = await prepareAvatarImage(fileOf(WEBP));
    expect(prepared).toMatchObject({ kind: 'prepared', sourceSide: 300, portraitSide: 300 });
    expect(vi.mocked(resampleSquare).mock.calls.map(([, side, target]) => [side, target])).toEqual([[300, 300], [300, 64]]);
    expect(encoded).toEqual([300, 64]);
  });

  it('brings an image past the working side to it first, by Chromium', async () => {
    decoded = { width: 6000, height: 6000 };
    expect(await prepareAvatarImage(fileOf(PNG))).toMatchObject({ kind: 'prepared', sourceSide: 6000, portraitSide: 512 });
    expect(bitmap).toHaveBeenLastCalledWith(expect.anything(), { resizeWidth: WORKING_SIDE_MAX, resizeHeight: WORKING_SIDE_MAX, resizeQuality: 'high' });
    expect(drawn).toEqual([WORKING_SIDE_MAX]);
    expect(vi.mocked(resampleSquare).mock.calls.map(([, side, target]) => [side, target])).toEqual([[WORKING_SIDE_MAX, 512], [WORKING_SIDE_MAX, 64]]);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a GIF', () => fileOf(GIF), 'unsupported'],
    ['bytes no image’s', () => fileOf([1, 2, 3]), 'unsupported'],
    ['an empty file', () => new File([], 'empty.png'), 'unreadable'],
    ['a file past 5 MiB', () => fileOf(PNG, MAX_IMAGE_BYTES + 1), 'too-large'],
  ] as const)('refuses %s unread', async (_name, made, reason) => {
    expect(await prepareAvatarImage(made())).toEqual({ kind: 'refused', reason });
    expect(bitmap).not.toHaveBeenCalled();
  });

  it.each([
    [{ width: 600, height: 500 }, 'not-square'],
    [{ width: 32, height: 32 }, 'too-small'],
    [{ width: 9000, height: 9000 }, 'too-large'],
  ] as const)('refuses an image of %o', async (size, reason) => {
    decoded = size;
    expect(await prepareAvatarImage(fileOf(PNG))).toEqual({ kind: 'refused', reason, ...size });
    expect(encoded).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('makes a small version alone, scaling nothing else', async () => {
    decoded = { width: 1500, height: 1500 };
    const small = await prepareSmallImage(fileOf(PNG));
    expect(small.kind === 'prepared' ? [small.small.byteLength > 0, small.sourceSide] : small).toEqual([true, 1500]);
    expect(Object.keys(small)).not.toContain('portrait');
    expect(vi.mocked(resampleSquare).mock.calls.map(([, side, target]) => [side, target])).toEqual([[1500, 64]]);
    expect(encoded).toEqual([64]);
    decoded = { width: 600, height: 500 };
    expect(await prepareSmallImage(fileOf(PNG))).toEqual({ kind: 'refused', reason: 'not-square', width: 600, height: 500 });
  });

  it('refuses an image Chromium cannot decode', async () => {
    bitmap.mockRejectedValueOnce(new Error('undecodable'));
    expect(await prepareAvatarImage(fileOf(PNG))).toEqual({ kind: 'refused', reason: 'unreadable' });
  });
});
