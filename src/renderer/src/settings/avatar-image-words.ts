// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ImageRefused } from './avatar-image';
import { EDITOR_WORDS } from './family-editor-words';

/** Image refusals shared by the family and avatar drop flows. */
export function refusalWords(refused: ImageRefused): string {
  return refused.reason === 'not-square' && refused.width !== undefined && refused.height !== undefined
    ? EDITOR_WORDS.notSquare(refused.width, refused.height) : EDITOR_WORDS.imageRefusals[refused.reason];
}
