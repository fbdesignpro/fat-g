// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Synthetic images for the tests of the images' reader, the attachments and the avatars
// (docs/planning/_archive/M23.md, V16; C70; M102, V21): drawn from a formula, never anyone's picture.
// A PNG is a whole image a browser draws; the other three are headers whole enough for main's reader,
// which decodes nothing. Not a test, and it imports no test library: the runtime-dependencies test
// reads this file as source.
import { deflateSync } from 'node:zlib';

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let bit = 0; bit < 8; bit += 1) c = (c >>> 1) ^ ((c & 1) !== 0 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(name: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(name, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(name, 'ascii'), Buffer.from(data)])), 8 + data.length);
  return out;
}

/** An 8-bit RGB PNG, whole: its left half `left` and its right half `right`. */
export function pngBytes(width: number, height: number, left: readonly [number, number, number] = [255, 0, 0], right: readonly [number, number, number] = [0, 0, 255]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    const colour = x < width / 2 ? left : right;
    row[1 + x * 3] = colour[0];
    row[2 + x * 3] = colour[1];
    row[3 + x * 3] = colour[2];
  }
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array(0))]);
}

/** The bytes from a PNG's signature through its IHDR: what the chunks below are put after. */
const PNG_HEAD = 8 + 25;

/**
 * A PNG with `chunks` put between its IHDR and its IDAT (M102, V21): an `acTL` makes it an APNG, a
 * large `iCCP` pushes its IDAT past the scan's first 64 KiB.
 */
export function pngWithChunks(width: number, height: number, chunks: readonly { readonly name: string; readonly bytes: number }[]): Buffer {
  const whole = pngBytes(width, height);
  return Buffer.concat([whole.subarray(0, PNG_HEAD), ...chunks.map((extra) => chunk(extra.name, Buffer.alloc(extra.bytes, 7))), whole.subarray(PNG_HEAD)]);
}

/** An animated PNG: its `acTL` before its first IDAT, after `before` bytes of a profile chunk (M102, V21). */
export function apngBytes(width: number, height: number, before = 0): Buffer {
  return pngWithChunks(width, height, [...(before > 0 ? [{ name: 'iCCP', bytes: before }] : []), { name: 'acTL', bytes: 8 }]);
}

/** A PNG whose chunks reach its end with no IDAT: its IHDR and its IEND alone (M102, V21). */
export function pngWithoutData(width: number, height: number): Buffer {
  const whole = pngBytes(width, height);
  return Buffer.concat([whole.subarray(0, PNG_HEAD), chunk('IEND', new Uint8Array(0))]);
}

/** A JPEG's start: SOI, an APP0 segment, and a baseline start of frame with the size. */
export function jpegBytes(width: number, height: number, frame = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, frame, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** A GIF's header and logical screen descriptor, and a trailer. */
export function gifBytes(width: number, height: number, version: '87a' | '89a' = '89a'): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  return Buffer.concat([Buffer.from(`GIF${version}`, 'ascii'), screen, Buffer.from([0x3b])]);
}

/** A WebP's RIFF header and its first chunk, of one of the three kinds, with the size; VP8X's `flags`, 0x02 for an animated one (M102, V21). */
export function webpBytes(kind: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number, flags = 0): Buffer {
  let data: Buffer;
  if (kind === 'VP8 ') {
    data = Buffer.alloc(10);
    data.set([0x9d, 0x01, 0x2a], 3);
    data.writeUInt16LE(width & 0x3fff, 6);
    data.writeUInt16LE(height & 0x3fff, 8);
  } else if (kind === 'VP8L') {
    data = Buffer.alloc(5);
    data[0] = 0x2f;
    const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    data.writeUInt32LE(bits >>> 0, 1);
  } else {
    data = Buffer.alloc(10);
    data[0] = flags;
    data.writeUIntLE(width - 1, 4, 3);
    data.writeUIntLE(height - 1, 7, 3);
  }
  const head = Buffer.alloc(8);
  head.write(kind, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), head, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
