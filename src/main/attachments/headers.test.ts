// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16 (docs/planning/_archive/M23.md; C1–C3, C9) through the shared reader (M102, V21; C50, C52): an
// attachment's header read as M23 read it — each format's size, each refusal with its reason, its
// bound applied, and an animated image still taken.
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES } from '@shared/contracts/attachments';
import { apngBytes, gifBytes, jpegBytes, pngBytes, webpBytes } from '../images/test-support';
import { readAttachmentHeader } from './headers';

describe('each format’s size (V16; C1, C3)', () => {
  it('reads each of the four, and nothing of animation', () => {
    expect(readAttachmentHeader(pngBytes(1200, 800))).toEqual({ kind: 'image', mediaType: 'image/png', width: 1200, height: 800 });
    expect(readAttachmentHeader(jpegBytes(640, 480))).toEqual({ kind: 'image', mediaType: 'image/jpeg', width: 640, height: 480 });
    expect(readAttachmentHeader(gifBytes(320, 200))).toEqual({ kind: 'image', mediaType: 'image/gif', width: 320, height: 200 });
    expect(readAttachmentHeader(webpBytes('VP8 ', 400, 300))).toEqual({ kind: 'image', mediaType: 'image/webp', width: 400, height: 300 });
  });

  it('takes an animated image as it is (M23, C3; M102, C52)', () => {
    expect(readAttachmentHeader(apngBytes(16, 16))).toEqual({ kind: 'image', mediaType: 'image/png', width: 16, height: 16 });
    expect(readAttachmentHeader(webpBytes('VP8X', 16, 16, 0x02))).toEqual({ kind: 'image', mediaType: 'image/webp', width: 16, height: 16 });
  });
});

describe('each refusal, with its reason (V16; C1, C2, C9)', () => {
  it('refuses bytes with no signature of the four as unsupported', () => {
    expect(readAttachmentHeader(Buffer.from('%PDF-1.7 a document'))).toEqual({ kind: 'refused', reason: 'unsupported' });
    expect(readAttachmentHeader(new Uint8Array(0))).toEqual({ kind: 'refused', reason: 'unsupported' });
  });

  it('judges the header alone: cut short it is damaged, whole it is taken whatever follows it', () => {
    const cases: readonly [Buffer, number][] = [[pngBytes(4, 4), 33], [jpegBytes(4, 4), 2 + 18 + 2 + 17], [gifBytes(4, 4), 13], [webpBytes('VP8 ', 4, 4), 30], [webpBytes('VP8L', 4, 4), 25], [webpBytes('VP8X', 4, 4), 30]];
    for (const [whole, length] of cases) {
      for (let cut = 0; cut < length; cut += 1) expect(readAttachmentHeader(whole.subarray(0, cut)).kind).toBe('refused');
      expect(readAttachmentHeader(whole.subarray(0, length))).toMatchObject({ kind: 'image', width: 4, height: 4 });
    }
    expect(readAttachmentHeader(pngBytes(4, 4).subarray(0, 20))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readAttachmentHeader(gifBytes(4, 4).subarray(0, 9))).toEqual({ kind: 'refused', reason: 'damaged' });
  });

  it('refuses a zero side as damaged (C2)', () => {
    expect(readAttachmentHeader(pngBytes(0, 10))).toEqual({ kind: 'refused', reason: 'damaged' });
    expect(readAttachmentHeader(webpBytes('VP8 ', 0, 4))).toEqual({ kind: 'refused', reason: 'damaged' });
  });

  it('refuses past 8000 pixels a side, and past 5 MiB, as too large: nothing is reduced (C2, C9)', () => {
    expect(readAttachmentHeader(pngBytes(8001, 1))).toEqual({ kind: 'refused', reason: 'too-large' });
    expect(readAttachmentHeader(webpBytes('VP8X', 1, 8001))).toEqual({ kind: 'refused', reason: 'too-large' });
    expect(readAttachmentHeader(gifBytes(8000, 8000))).toMatchObject({ kind: 'image' });
    const big = Buffer.concat([gifBytes(10, 10), Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(readAttachmentHeader(big)).toEqual({ kind: 'refused', reason: 'too-large' });
    expect(readAttachmentHeader(Buffer.concat([gifBytes(10, 10), Buffer.alloc(MAX_IMAGE_BYTES - 14)]))).toMatchObject({ kind: 'image' });
  });
});
