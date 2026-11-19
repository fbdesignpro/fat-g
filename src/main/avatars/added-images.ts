// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { readImageHeader } from '../images/headers';

/** Header-only check for the PNGs prepared in the sandboxed renderer. */
export function stillPng(bytes: Uint8Array, least: number, most: number): boolean {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) return false;
  const header = readImageHeader(bytes, true);
  return header.kind === 'image' && header.mediaType === 'image/png' && header.animation === 'still'
    && header.width === header.height && header.width >= least && header.width <= most;
}
