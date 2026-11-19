// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for an image's tab (docs/planning/_archive/M23.md, Design 4; C8, C27): its title, what its
// toggle is called, and what it says of an image whose file fat-g no longer holds.
import { ATTACHMENT_WORDS } from '@shared/contracts/attachments';

export const IMAGE_WORDS = {
  /** A tab's title before its body names it. */
  title: 'Image',
  /** An image with no name, by its place among its message's images (C27). */
  numbered: (ordinal: number): string => `Image ${ordinal}`,
  /** The toggle's name, pressed while the image is at its actual size (C27). */
  actual: 'Show at actual size',
  /** Its tooltip while pressed: what a press then does. */
  fit: 'Fit to the pane',
  unavailable: ATTACHMENT_WORDS.unavailable,
  refreshFailedTip: 'Could not refresh this image. The last displayed version is still shown. Retrying automatically.',
} as const;
