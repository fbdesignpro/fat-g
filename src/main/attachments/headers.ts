// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An attachment's header (docs/planning/_archive/M23.md, Design 2; C1–C3, C9; M102, C50, C52): the one
// header reader (src/main/images/headers.ts), then the attachments' bound — 5 MiB, and 8000 pixels a
// side. Read as M23 read it, its header alone: what comes after the header is not judged, and an
// animated GIF, PNG or WebP is taken as it is (decision 0030), so the reader's animation is ignored.
//
// Pure: bytes in, an answer out. Main alone calls it, on bytes the page handed over and on the files
// the media route serves.
import { type AttachmentMediaType, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from '@shared/contracts/attachments';
import { readImageHeader } from '../images/headers';

export type AttachmentHeaderReading =
  | { readonly kind: 'image'; readonly mediaType: AttachmentMediaType; readonly width: number; readonly height: number }
  /** `unsupported`: no signature of the four (C1). `damaged`: the header could not be read whole, or a side is zero (C2). `too-large`: past a bound (C9). */
  | { readonly kind: 'refused'; readonly reason: 'unsupported' | 'damaged' | 'too-large' };

/**
 * An image's format and size, read from its bytes alone (C1–C3, C9): refused as unsupported without
 * one of the four signatures, as damaged where its header cannot be read whole or a side is zero, and
 * as too large past 5 MiB or 8000 pixels a side. Nothing else of the bytes is judged.
 */
export function readAttachmentHeader(bytes: Uint8Array): AttachmentHeaderReading {
  // As a prefix: the header alone is judged, as before the reader was shared.
  const reading = readImageHeader(bytes, false);
  if (reading.kind === 'refused') return reading;
  if (bytes.byteLength > MAX_IMAGE_BYTES || reading.width > MAX_IMAGE_SIDE || reading.height > MAX_IMAGE_SIDE) return { kind: 'refused', reason: 'too-large' };
  return { kind: 'image', mediaType: reading.mediaType, width: reading.width, height: reading.height };
}
