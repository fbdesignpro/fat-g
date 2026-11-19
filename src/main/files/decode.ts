// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Whether a file's bytes are text (docs/planning/_archive/M19b.md, Design 7; C30): they are when they decode
// as UTF-8, or as UTF-16 where a byte-order mark says so, and the decoded text holds no U+0000. The
// mark is no part of the text. Anything else is not text, and the caller sends none of it to the page.

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UTF16 = new TextDecoder('utf-16le', { fatal: true });

/** Each pair of bytes in the other order: big-endian UTF-16 as little-endian. */
function swapped(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let at = 0; at + 1 < bytes.length; at += 2) {
    out[at] = bytes[at + 1] ?? 0;
    out[at + 1] = bytes[at] ?? 0;
  }
  return out;
}

/** The text the bytes are, without its mark, or null when they are not text. An empty file is an empty text. */
export function decodeText(bytes: Uint8Array): string | null {
  const little = bytes[0] === 0xff && bytes[1] === 0xfe;
  const big = bytes[0] === 0xfe && bytes[1] === 0xff;
  try {
    let text: string;
    if (little || big) {
      // Half a unit at the end is no text.
      if (bytes.length % 2 !== 0) return null;
      text = UTF16.decode(big ? swapped(bytes) : bytes);
    } else {
      text = UTF8.decode(bytes);
    }
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}
