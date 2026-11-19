// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16 (docs/planning/_archive/M23.md; C1–C3) and V21 (docs/planning/_archive/M102.md; C50, C52–C54): the one
// header reader — each format's size and whether it moves, each refusal with its reason, nothing read
// past the bytes given, and no bound applied: each caller applies its own.
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { readImageHeader } from './headers';
import { apngBytes, gifBytes, jpegBytes, pngBytes, pngWithChunks, pngWithoutData, webpBytes } from './test-support';

describe('each format’s size, from its own header (V16, V21; C52)', () => {
  it('reads a PNG’s IHDR, and a still PNG as still', () => {
    expect(readImageHeader(pngBytes(1200, 800))).toEqual({ kind: 'image', mediaType: 'image/png', width: 1200, height: 800, animation: 'still' });
  });

  it('walks a JPEG’s segments to its start of frame, of any frame kind that carries a size', () => {
    expect(readImageHeader(jpegBytes(640, 480))).toEqual({ kind: 'image', mediaType: 'image/jpeg', width: 640, height: 480, animation: 'still' });
    // Progressive, and a lossless one.
    expect(readImageHeader(jpegBytes(33, 17, 0xc2))).toMatchObject({ width: 33, height: 17 });
    expect(readImageHeader(jpegBytes(33, 17, 0xc3))).toMatchObject({ width: 33, height: 17 });
    // Fill bytes before a marker, and a restart marker with no segment.
    const bytes = jpegBytes(9, 7);
    const padded = Buffer.concat([bytes.subarray(0, 2), Buffer.from([0xff, 0xff, 0xd0]), bytes.subarray(2)]);
    expect(readImageHeader(padded)).toMatchObject({ width: 9, height: 7 });
  });

  it('reads a GIF’s logical screen descriptor, of both versions, leaving its frames unwalked', () => {
    expect(readImageHeader(gifBytes(320, 200))).toEqual({ kind: 'image', mediaType: 'image/gif', width: 320, height: 200, animation: 'undecided' });
    expect(readImageHeader(gifBytes(1, 1, '87a'))).toMatchObject({ width: 1, height: 1 });
  });

  it('reads a WebP’s VP8, VP8L and VP8X chunks: lossy, lossless and extended', () => {
    expect(readImageHeader(webpBytes('VP8 ', 400, 300))).toEqual({ kind: 'image', mediaType: 'image/webp', width: 400, height: 300, animation: 'still' });
    expect(readImageHeader(webpBytes('VP8L', 4000, 16))).toMatchObject({ width: 4000, height: 16, animation: 'still' });
    expect(readImageHeader(webpBytes('VP8X', 8000, 8000))).toMatchObject({ width: 8000, height: 8000, animation: 'still' });
  });

  it('applies no bound: a side past 8000 pixels and bytes past 5 MiB are the callers’ to judge (C50, C52)', () => {
    expect(readImageHeader(pngBytes(8001, 1))).toMatchObject({ kind: 'image', width: 8001 });
    expect(readImageHeader(webpBytes('VP8X', 1, 9000))).toMatchObject({ kind: 'image', height: 9000 });
    expect(readImageHeader(Buffer.concat([gifBytes(10, 10), Buffer.alloc(MAX_IMAGE_BYTES)]))).toMatchObject({ kind: 'image' });
  });
});

describe('animation (V21; C52, C53)', () => {
  it('says an APNG moves: its acTL before its first IDAT', () => {
    expect(readImageHeader(apngBytes(16, 16))).toMatchObject({ kind: 'image', width: 16, animation: 'animated' });
  });

  it('says an APNG whose acTL comes past a prefix is undecided there, and moves when read whole', () => {
    const late = apngBytes(16, 16, 70 * 1024);
    const prefix = late.subarray(0, 64 * 1024);
    expect(readImageHeader(prefix, false)).toMatchObject({ kind: 'image', width: 16, animation: 'undecided' });
    expect(readImageHeader(late)).toMatchObject({ animation: 'animated' });
    // A still PNG with the same profile chunk: undecided from the prefix, still when whole.
    const still = pngWithChunks(16, 16, [{ name: 'iCCP', bytes: 70 * 1024 }]);
    expect(readImageHeader(still.subarray(0, 64 * 1024), false)).toMatchObject({ animation: 'undecided' });
    expect(readImageHeader(still)).toMatchObject({ animation: 'still' });
  });

  it('decides from a prefix whenever the chunks it holds reach an acTL or an IDAT', () => {
    expect(readImageHeader(apngBytes(16, 16, 1000).subarray(0, 64 * 1024), false)).toMatchObject({ animation: 'animated' });
    expect(readImageHeader(pngBytes(16, 16), false)).toMatchObject({ animation: 'still' });
  });

  it('says a WebP moves by VP8X’s animation flag alone', () => {
    expect(readImageHeader(webpBytes('VP8X', 64, 64, 0x02))).toMatchObject({ kind: 'image', width: 64, animation: 'animated' });
    // Alpha and a profile, with no animation.
    expect(readImageHeader(webpBytes('VP8X', 64, 64, 0x10 | 0x20))).toMatchObject({ animation: 'still' });
  });
});

describe('each refusal, with its reason (V16, V21; C54)', () => {
  it('refuses bytes with no signature of the four as unsupported, an image extension or not', () => {
    expect(readImageHeader(Buffer.from('%PDF-1.7 a document'))).toEqual({ kind: 'refused', reason: 'unsupported' });
    expect(readImageHeader(Buffer.from('BM a bitmap'))).toEqual({ kind: 'refused', reason: 'unsupported' });
    expect(readImageHeader(new Uint8Array(0))).toEqual({ kind: 'refused', reason: 'unsupported' });
  });

  it('refuses a header cut short as damaged, wherever it is cut, a prefix or whole', () => {
    // Each header's whole length: the signature, and everything up to the end of the size it holds.
    const cases: readonly [Buffer, number][] = [[pngBytes(4, 4), 33], [jpegBytes(4, 4), 2 + 18 + 2 + 17], [gifBytes(4, 4), 13], [webpBytes('VP8 ', 4, 4), 30], [webpBytes('VP8L', 4, 4), 25], [webpBytes('VP8X', 4, 4), 30]];
    for (const [whole, length] of cases) {
      // Every cut short of it is refused, and none of them is read past its end.
      for (let cut = 0; cut < length; cut += 1) {
        expect(readImageHeader(whole.subarray(0, cut), false).kind).toBe('refused');
        expect(readImageHeader(whole.subarray(0, cut)).kind).toBe('refused');
      }
      expect(readImageHeader(whole.subarray(0, length), false)).toMatchObject({ kind: 'image', width: 4, height: 4 });
    }
  });

  it('refuses a JPEG whose scan, or end, comes before any frame, and a segment that points past its bytes', () => {
    expect(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x7f, 0xff, 0x00]))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]))).toEqual({ kind: 'refused', reason: 'damaged' });
    // Bytes between segments that are no marker.
    expect(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0x12, 0x34]))).toEqual({ kind: 'refused', reason: 'damaged' });
  });

  it('refuses a PNG whose first chunk is not a whole IHDR, and a WebP of no known kind', () => {
    const png = pngBytes(4, 4);
    const wrongType = Buffer.from(png);
    wrongType.write('IDAT', 12, 'ascii');
    expect(readImageHeader(wrongType)).toEqual({ kind: 'refused', reason: 'damaged' });
    const wrongLength = Buffer.from(png);
    wrongLength.writeUInt32BE(12, 8);
    expect(readImageHeader(wrongLength)).toEqual({ kind: 'refused', reason: 'damaged' });
    const odd = webpBytes('VP8 ', 4, 4);
    odd.write('ALPH', 12, 'ascii');
    expect(readImageHeader(odd)).toEqual({ kind: 'refused', reason: 'damaged' });
  });

  it('refuses a whole PNG whose chunk runs past its end, or that reaches its end with no IDAT, as damaged (C53)', () => {
    // A profile chunk saying it is longer than the file.
    const long = pngWithChunks(8, 8, [{ name: 'iCCP', bytes: 100 }]);
    long.writeUInt32BE(1_000_000, 33);
    expect(readImageHeader(long)).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(long, false)).toMatchObject({ kind: 'image', animation: 'undecided' });
    // Its IDAT cut short.
    const cut = pngBytes(8, 8);
    expect(readImageHeader(cut.subarray(0, cut.length - 20))).toEqual({ kind: 'refused', reason: 'damaged' });
    // No IDAT at all: its IHDR and its IEND, or its IHDR alone.
    expect(readImageHeader(pngWithoutData(8, 8))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(pngWithoutData(8, 8), false)).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(pngBytes(8, 8).subarray(0, 33))).toEqual({ kind: 'refused', reason: 'damaged' });
  });

  it('refuses a zero side as damaged', () => {
    expect(readImageHeader(pngBytes(0, 10))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(gifBytes(10, 0))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(jpegBytes(0, 0))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readImageHeader(webpBytes('VP8 ', 0, 4))).toEqual({ kind: 'refused', reason: 'damaged' });
  });
});
