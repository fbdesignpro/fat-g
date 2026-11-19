// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The lookup of a bare name (docs/planning/_archive/M19b.md, Design 7; C55): a model names a file by its name
// alone, `harbour-log.md` for one that lies in a subfolder, so a name that is no file where it
// resolves is looked up in the project's trusted folders.
//
// The nearest folders first, breadth first from the roots. It follows no link, enters no folder the
// reader refuses (C28), none whose name starts with a dot and no `node_modules`, and stops at 20,000
// entries and at the read's deadline. Only names are read, in folders the reader may read already;
// none is kept, and none is said (C33, C35).
import { comparable } from '../records/paths';
import { pathLib } from './confine';
import type { ReaderFs } from './fs';
import type { ReadClock } from './limiter';

export const WALK_MAX_ENTRIES = 20_000;
/** A dependency's `README.md` makes no name one of several, and the walk reaches the project's own files. */
const PASSED_OVER = 'node_modules';

export type WalkResult =
  | { readonly found: 'one'; readonly path: string }
  | { readonly found: 'several' }
  | { readonly found: 'none' }
  /** A folder's listing did not answer in time, and no file of the name was found before it. */
  | { readonly found: 'no-answer' };

export interface WalkOptions {
  readonly fs: Pick<ReaderFs, 'list'>;
  readonly clock: ReadClock;
  readonly platform: string;
  /** The session's project's roots that are trusted and not marked missing, as stored. */
  readonly roots: readonly string[];
  /** A file's name, with no separator. */
  readonly name: string;
  /** Whether a folder is one no read may enter (C28). */
  readonly refused: (folder: string) => boolean;
  readonly maxEntries?: number;
}

export async function findByName({ fs, clock, platform, roots, name, refused, maxEntries = WALK_MAX_ENTRIES }: WalkOptions): Promise<WalkResult> {
  const p = pathLib(platform);
  const wanted = comparable(name, platform);
  const found: string[] = [];
  let entries = 0;
  let unanswered = false;
  let level = roots.filter((root) => !refused(root));
  // A second file of the name settles it: no more is asked.
  while (level.length > 0 && entries < maxEntries && !unanswered && found.length < 2) {
    const next: string[] = [];
    for (const folder of level) {
      if (entries >= maxEntries || found.length >= 2) break;
      const listed = clock.expired() ? { answered: false as const } : await clock.run(() => fs.list(folder, maxEntries - entries));
      if (!listed.answered) {
        unanswered = true;
        break;
      }
      // A folder that is gone, or that may not be listed, is passed over.
      if (!listed.ok) continue;
      for (const entry of listed.value) {
        entries += 1;
        if (entry.isSymbolicLink()) continue;
        const full = p.join(folder, entry.name);
        if (entry.isFile()) {
          if (comparable(entry.name, platform) === wanted) found.push(full);
        } else if (entry.isDirectory() && !entry.name.startsWith('.') && comparable(entry.name, platform) !== PASSED_OVER && !refused(full)) {
          next.push(full);
        }
      }
    }
    level = next;
  }
  const [first, second] = found;
  if (second !== undefined) return { found: 'several' };
  if (first !== undefined) return { found: 'one', path: first };
  return unanswered ? { found: 'no-answer' } : { found: 'none' };
}
