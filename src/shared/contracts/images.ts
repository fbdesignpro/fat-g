// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What every image fat-g reads shares (docs/planning/_archive/M102.md, Design 1; M102, C50): the one bound on
// an image's bytes and pixels, the four formats and the signatures that tell them. Moved from the
// attachments contract, which imports them back under its own names: decision 0030 took the bounds
// from M23's spikes of what the CLIs accept, and no other bound on an image is fat-g's.
//
// Renderer-safe: constants and one pure function.

/** The four formats fat-g reads, told by their bytes' signature and never by a name or a type given. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

const MIB = 1024 * 1024;
/** One image, in bytes (C50). */
export const MAX_IMAGE_BYTES = 5 * MIB;
/** A side, in pixels: at least one, at most this (C50). */
export const MAX_IMAGE_SIDE = 8000;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean => bytes.length >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte);
const asciiAt = (bytes: Uint8Array, at: number, text: string): boolean => bytes.length >= at + text.length && [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));

/**
 * The format a signature says: one of the four, or null. What main's header reader begins with, and
 * the page's first look at a dropped or pasted file, so that bytes no image's are not handed over to
 * be refused; main's check of the whole header is the authority.
 */
export function imageSignature(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif';
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';
  return null;
}

/** How many of a file's first bytes the signature is told by. */
export const SIGNATURE_BYTES = 12;
