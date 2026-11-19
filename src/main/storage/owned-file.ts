// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** A main-generated path under an owned store, with no redirected descendant or final symlink. */
export function regularOwnedFile(root: string, file: string): string | null {
  try {
    const relative = path.relative(root, file);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    if (!lstatSync(file).isFile()) return null;
    const real = realpathSync(file);
    return real === path.join(realpathSync(root), relative) ? real : null;
  } catch { return null; }
}
