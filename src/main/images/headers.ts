// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An image's header, read without decoding it (docs/planning/_archive/M23.md, Design 2; C1–C3; M102,
// Design 2; C50, C52, C53): the signature says the format, and the format's own header gives the size
// in pixels — PNG's IHDR, JPEG's start-of-frame, found by a bounded walk of its segments, GIF's logical
// screen descriptor, and WebP's VP8, VP8L or VP8X chunk — and whether it moves: a PNG's chunks walked
// to an `acTL` before its first `IDAT`, WebP's animation flag. Every offset and length is checked
// against the bytes given: nothing past them is read, no decoder runs and nothing is re-encoded.
//
// The one reader of every image fat-g reads (C50): it applies no bound, and each caller applies its
// own — the attachments theirs (attachments/headers.ts), the avatars theirs (avatars/scan.ts).
//
// Pure: bytes in, an answer out.
import { imageSignature, type ImageMediaType } from '@shared/contracts/images';

/**
 * Whether an image moves (C52): `undecided` where the bytes given do not say — a GIF, whose frames are
 * not walked, or a PNG whose chunks run past a prefix before they reach an `IDAT`.
 */
export type Animation = 'still' | 'animated' | 'undecided';

export type HeaderReading =
  | { readonly kind: 'image'; readonly mediaType: ImageMediaType; readonly width: number; readonly height: number; readonly animation: Animation }
  /** `unsupported`: no signature of the four. `damaged`: the header could not be read whole, or a side is zero. */
  | { readonly kind: 'refused'; readonly reason: 'unsupported' | 'damaged' };

const starts = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);
const ascii = (bytes: Uint8Array, at: number, text: string): boolean => bytes.length >= at + text.length && [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));
const u16be = (bytes: Uint8Array, at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
const u16le = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u24le = (bytes: Uint8Array, at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16);
const u32be = (bytes: Uint8Array, at: number): number => (((bytes[at] ?? 0) << 24) >>> 0) + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));

type Read = { readonly width: number; readonly height: number; readonly animation: Animation } | 'damaged';

/** Where a PNG's first chunk after IHDR starts: the signature, IHDR's length and type, its 13 bytes and its 4 check bytes. */
const PNG_AFTER_IHDR = 8 + 8 + 13 + 4;

/**
 * PNG: the IHDR chunk comes first, 13 bytes long, and is read whole with its check bytes. Then the
 * chunks — a length, a type, the data, a check — are walked to an `acTL`, which says it moves, or an
 * `IDAT`, which says it does not (C52, C53). A chunk that runs past the bytes given leaves it
 * undecided when they are a prefix, and makes the file damaged when they are the whole of it, as a
 * file that reaches its end with no `IDAT` is.
 */
function png(bytes: Uint8Array, whole: boolean): Read {
  if (bytes.length < PNG_AFTER_IHDR) return 'damaged';
  if (u32be(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) return 'damaged';
  const size = { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  const past = (): Read => (whole ? 'damaged' : { ...size, animation: 'undecided' });
  let at = PNG_AFTER_IHDR;
  for (;;) {
    if (at + 8 > bytes.length) return past();
    const end = at + 12 + u32be(bytes, at);
    if (ascii(bytes, at + 4, 'acTL')) return { ...size, animation: 'animated' };
    if (ascii(bytes, at + 4, 'IDAT')) return whole && end > bytes.length ? 'damaged' : { ...size, animation: 'still' };
    // The image's end, with no image data before it.
    if (ascii(bytes, at + 4, 'IEND')) return 'damaged';
    if (end > bytes.length) return past();
    at = end;
  }
}

/** The start-of-frame markers that carry a frame's size: every SOFn but DHT (C4), JPG (C8) and DAC (CC). */
const isStartOfFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * JPEG: from the start of image, segment by segment to the first start of frame. A marker with no
 * length is stepped over; a segment's length never points past the bytes; the scan's start, or the
 * image's end, before any frame is a header that cannot be read. A JPEG does not move.
 */
function jpeg(bytes: Uint8Array): Read {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return 'damaged';
    // Fill bytes before a marker.
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) return 'damaged';
    const marker = bytes[at] ?? 0;
    at += 1;
    // Markers with no segment: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // The image's end, or its scan, with no frame before it.
    if (marker === 0xd9 || marker === 0xda || marker === 0xd8) return 'damaged';
    if (at + 2 > bytes.length) return 'damaged';
    const length = u16be(bytes, at);
    if (length < 2 || at + length > bytes.length) return 'damaged';
    if (isStartOfFrame(marker)) {
      // Precision (1), then the height and the width, each two bytes.
      if (length < 7) return 'damaged';
      return { width: u16be(bytes, at + 5), height: u16be(bytes, at + 3), animation: 'still' };
    }
    at += length;
  }
  return 'damaged';
}

/** GIF: the logical screen descriptor, which follows the six bytes of its signature. Its frames are not walked. */
function gif(bytes: Uint8Array): Read {
  if (bytes.length < 13) return 'damaged';
  return { width: u16le(bytes, 6), height: u16le(bytes, 8), animation: 'undecided' };
}

/** VP8X's flags: the animation bit (C52). */
const WEBP_ANIMATION = 0x02;

/** WebP: the first chunk after the RIFF header says which kind, and holds the canvas's size; VP8X's flags say whether it moves. */
function webp(bytes: Uint8Array): Read {
  // The RIFF header (12) and the first chunk's header (8).
  if (bytes.length < 20) return 'damaged';
  const data = 20;
  if (ascii(bytes, 12, 'VP8 ')) {
    // A frame tag of three bytes, the start code, then the width and the height in 14 bits each.
    if (bytes.length < data + 10 || !starts(bytes, [0x9d, 0x01, 0x2a], data + 3)) return 'damaged';
    return { width: u16le(bytes, data + 6) & 0x3fff, height: u16le(bytes, data + 8) & 0x3fff, animation: 'still' };
  }
  if (ascii(bytes, 12, 'VP8L')) {
    // Its signature byte, then the width less one and the height less one in 14 bits each.
    if (bytes.length < data + 5 || bytes[data] !== 0x2f) return 'damaged';
    const b1 = bytes[data + 1] ?? 0;
    const b2 = bytes[data + 2] ?? 0;
    const b3 = bytes[data + 3] ?? 0;
    const b4 = bytes[data + 4] ?? 0;
    return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)), animation: 'still' };
  }
  if (ascii(bytes, 12, 'VP8X')) {
    // Flags (1), reserved (3), then the canvas's width less one and height less one in 24 bits each.
    if (bytes.length < data + 10) return 'damaged';
    return { width: 1 + u24le(bytes, data + 4), height: 1 + u24le(bytes, data + 7), animation: ((bytes[data] ?? 0) & WEBP_ANIMATION) !== 0 ? 'animated' : 'still' };
  }
  return 'damaged';
}

const READERS: Readonly<Record<ImageMediaType, (bytes: Uint8Array, whole: boolean) => Read>> = { 'image/png': png, 'image/jpeg': jpeg, 'image/gif': gif, 'image/webp': webp };

/**
 * An image's format, size and animation, read from its bytes alone (C52): refused as unsupported
 * without one of the four signatures, and as damaged where its header cannot be read whole or a side
 * is zero. `whole`: the bytes are the whole file, so a PNG whose chunks run past them, or reach no
 * `IDAT`, is damaged; false for a prefix, where they leave its animation undecided (C53). No bound is
 * applied: each caller applies its own.
 */
export function readImageHeader(bytes: Uint8Array, whole = true): HeaderReading {
  const mediaType = imageSignature(bytes);
  if (mediaType === null) return { kind: 'refused', reason: 'unsupported' };
  const read = READERS[mediaType](bytes, whole);
  if (read === 'damaged' || read.width < 1 || read.height < 1) return { kind: 'refused', reason: 'damaged' };
  return { kind: 'image', mediaType, width: read.width, height: read.height, animation: read.animation };
}
