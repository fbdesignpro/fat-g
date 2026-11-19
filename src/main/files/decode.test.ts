// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5 (docs/planning/_archive/M19b.md; C30): whether a file's bytes are text.
import { describe, expect, it } from 'vitest';
import { decodeText } from './decode';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
function utf16(text: string, order: 'le' | 'be', mark = true): Uint8Array {
  // By unit, not by character: a character outside the first plane is two.
  const units = [...(mark ? [0xfeff] : []), ...Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))];
  return Uint8Array.from(units.flatMap((unit) => (order === 'le' ? [unit & 0xff, unit >> 8] : [unit >> 8, unit & 0xff])));
}
const SAMPLE = 'Tides — héllo ✓ 潮 \u{1f30a}\nsecond line\r\n';

describe('a file’s bytes as text (C30)', () => {
  it('decodes UTF-8, with and without its mark, and the mark is no part of the text', () => {
    expect(decodeText(utf8(SAMPLE))).toBe(SAMPLE);
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(SAMPLE)]))).toBe(SAMPLE);
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf]))).toBe('');
  });

  it('decodes UTF-16 of both orders where a mark says so, without the mark', () => {
    expect(decodeText(utf16(SAMPLE, 'le'))).toBe(SAMPLE);
    expect(decodeText(utf16(SAMPLE, 'be'))).toBe(SAMPLE);
    expect(decodeText(utf16('', 'le'))).toBe('');
    expect(decodeText(utf16('', 'be'))).toBe('');
  });

  it('gives an empty file as an empty text', () => {
    expect(decodeText(new Uint8Array(0))).toBe('');
  });

  it('keeps a file’s own line breaks and its tabs', () => {
    expect(decodeText(utf8('a\r\n\tb\rc\n'))).toBe('a\r\n\tb\rc\n');
  });

  it.each([
    ['invalid UTF-8', new Uint8Array([0x61, 0xff, 0x62])],
    ['a cut UTF-8 sequence', new Uint8Array([0x61, 0xe2, 0x9c])],
    ['an overlong UTF-8 form', new Uint8Array([0xc0, 0xaf])],
    ['a U+0000', new Uint8Array([0x61, 0x00, 0x62])],
    ['UTF-16 without a mark, which holds zeros', utf16('plain', 'le', false)],
    ['UTF-16 of an odd length', new Uint8Array([...utf16('ab', 'le'), 0x61])],
    ['UTF-16 with half a pair', new Uint8Array([0xff, 0xfe, 0x00, 0xd8, 0x61, 0x00])],
    ['UTF-16 that holds a U+0000', utf16('a\0b', 'be')],
    ['a UTF-32 mark', new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00])],
    ['an image’s first bytes', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ])('says %s is not text', (_name, bytes) => {
    expect(decodeText(bytes)).toBeNull();
  });
});
