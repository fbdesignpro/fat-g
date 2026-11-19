// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The resampler of an added avatar (decision 0036): Lanczos 3 over premultiplied colour, as Pillow's
// `LANCZOS` scales fat-g's own art. The references are Pillow 12.2's, of the pattern below.
import { describe, expect, it } from 'vitest';
import { resampleSquare } from './lanczos';

function image(side: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) data.set(pixel(x, y), (y * side + x) * 4);
  return data;
}

/** The pattern Pillow was given: three ramps that wrap, and every fifth diagonal half transparent. */
const PATTERN = image(16, (x, y) => [(x * 16 + y * 3) % 256, (y * 16 + x * 5) % 256, ((x ^ y) * 17) % 256, (x + y) % 5 === 0 ? 128 : 255]);

/** `Image.resize((side, side), Image.Resampling.LANCZOS)` of the pattern, in Pillow 12.2. */
const PILLOW: Readonly<Record<number, readonly number[]>> = {
  6: [16, 19, 14, 241, 57, 30, 58, 219, 102, 44, 110, 240, 143, 57, 143, 219, 187, 70, 195, 241, 227, 84, 238, 214, 22, 58, 58, 219, 66, 74, 59, 237, 109, 86, 68, 222, 151, 99, 190, 238, 195, 113, 188, 221, 244, 126, 197, 239, 33, 105, 111, 238, 73, 116, 68, 222, 118, 131, 33, 237, 156, 142, 206, 222, 214, 154, 191, 238, 167, 166, 143, 218, 39, 145, 143, 218, 81, 157, 191, 238, 125, 168, 206, 222, 163, 186, 33, 237, 226, 210, 68, 222, 175, 233, 111, 238, 49, 189, 197, 239, 90, 207, 188, 221, 132, 229, 190, 238, 174, 222, 68, 222, 228, 197, 59, 237, 90, 119, 58, 219, 56, 234, 238, 214, 97, 215, 195, 241, 142, 122, 143, 219, 181, 60, 110, 240, 236, 24, 58, 219, 79, 22, 14, 241],
  4: [28, 32, 32, 231, 91, 51, 86, 229, 157, 72, 170, 230, 223, 91, 218, 228, 40, 93, 86, 229, 100, 110, 59, 230, 174, 131, 188, 229, 206, 156, 170, 230, 53, 161, 170, 230, 112, 191, 188, 229, 194, 213, 59, 230, 174, 209, 86, 229, 64, 223, 218, 228, 123, 180, 170, 230, 209, 108, 86, 229, 132, 57, 32, 231],
};

describe('resampleSquare (decision 0036)', () => {
  it.each([6, 4])('scales as Pillow’s LANCZOS does, to within its 8-bit rounding: 16 px to %i', async (side) => {
    const ours = [...await resampleSquare(PATTERN, 16, side)];
    const theirs = PILLOW[side] ?? [];
    expect(ours).toHaveLength(theirs.length);
    const furthest = Math.max(...ours.map((value, index) => Math.abs(value - (theirs[index] ?? 0))));
    expect(furthest).toBeLessThanOrEqual(2);
  });

  it('gives the same pixels at the same side', async () => {
    const result = await resampleSquare(PATTERN, 16, 16);
    expect([...result]).toEqual([...PATTERN]);
    expect(result).not.toBe(PATTERN);
  });

  it('keeps a flat colour flat', async () => {
    const result = await resampleSquare(image(64, () => [200, 100, 50, 255]), 64, 8);
    for (let at = 0; at < result.length; at += 4) expect([...result.subarray(at, at + 4)]).toEqual([200, 100, 50, 255]);
  });

  it('bleeds no colour out of transparent pixels', async () => {
    // Opaque red at the left, a fully transparent green at the right.
    const result = await resampleSquare(image(16, (x) => (x < 8 ? [255, 0, 0, 255] : [0, 255, 0, 0])), 16, 4);
    for (let at = 0; at < result.length; at += 4) {
      if ((result[at + 3] ?? 0) === 0) continue;
      expect(result[at]).toBe(255);
      expect(result[at + 1]).toBe(0);
    }
    // The left column opaque, the right one transparent.
    expect(result[3]).toBe(255);
    expect(result[15]).toBe(0);
  });

  it('averages a fine checkerboard to its middle grey', async () => {
    const result = await resampleSquare(image(64, (x, y) => ((x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255])), 64, 8);
    for (let at = 0; at < result.length; at += 4) {
      expect(Math.abs((result[at] ?? 0) - 127.5)).toBeLessThanOrEqual(1);
      expect(result[at + 3]).toBe(255);
    }
  });

  it('holds the ringing of a hard edge within 0 and 255', async () => {
    const result = await resampleSquare(image(48, (x) => (x < 24 ? [0, 0, 0, 255] : [255, 255, 255, 255])), 48, 10);
    expect(result.every((value) => value >= 0 && value <= 255)).toBe(true);
    expect(result[0]).toBe(0);
    expect(result[(10 - 1) * 4]).toBe(255);
  });

  it('refuses pixels that are not a square of the side given', async () => {
    await expect(resampleSquare(new Uint8ClampedArray(10), 16, 4)).rejects.toThrow();
  });
});
