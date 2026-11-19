// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The media route's avatar source (docs/planning/_archive/M102.md, Design 6; C59–C62): an avatar's file, by the
// id the current scan minted for it. The id must be one the catalog holds — an earlier scan's is
// refused from the moment a Rescan's catalog stands (C60) — and its file is checked again before it is
// served (C61): a regular file and no link, of the size the scan saw, its real path inside its root's,
// read whole within the one image bound, and its header still the type, the pixels and the stillness
// the scan saw. A file that changed and no longer passes is read to be checked and never served.
// Nothing of the request but its id is used, and no path is read from it.
//
// Electron-free: the catalog's lookup and the file system arrive as options. Its answer is kept by
// Chromium under the id (C62): an unchanged file keeps its id, and a changed one gets a new one.
import path from 'node:path';
import { isAvatarId } from '@shared/contracts/avatars';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import type { AvatarFileEntry } from '../avatars/catalog';
import type { AvatarFs } from '../avatars/fs';
import { readImageHeader } from '../images/headers';
import type { MediaSource, SourceAnswer } from './route';

export const AVATARS_SOURCE = 'avatars';

export interface AvatarSourceOptions {
  /** The current catalog's file for an id, or undefined for one it did not mint. */
  readonly file: (id: string) => AvatarFileEntry | undefined;
  readonly fs: AvatarFs;
}

/** Whether a real path lies inside a root's real path, the root itself excluded. */
function inside(real: string, root: string): boolean {
  const relative = path.relative(root, real);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function createAvatarSource({ file, fs }: AvatarSourceOptions): MediaSource {
  const refuse = (kind: 'id' | 'changed' | 'unavailable'): SourceAnswer => ({ status: 404, kind });
  return {
    name: AVATARS_SOURCE,
    cache: 'immutable',
    async serve(id) {
      if (!isAvatarId(id)) return refuse('id');
      const entry = file(id);
      if (entry === undefined) return refuse('id');
      try {
        // A regular file of the size the scan saw: never a link put in its place (C61).
        const stat = await fs.lstat(entry.path);
        if (stat.kind !== 'file' || stat.size !== entry.bytes) return refuse('changed');
        // Inside its root: a folder above it swapped for a link serves nothing outside (C61).
        if (!inside(await fs.realpath(entry.path), entry.realRoot)) return refuse('changed');
        const bytes = await fs.readWhole(entry.path, MAX_IMAGE_BYTES);
        if (bytes === null || bytes.byteLength !== entry.bytes) return refuse('changed');
        // Its header again, with the one reader: the type, the pixels and the stillness the scan saw.
        const header = readImageHeader(bytes, true);
        if (header.kind !== 'image' || header.mediaType !== entry.mediaType || header.width !== entry.width || header.height !== entry.height || header.animation !== 'still') return refuse('changed');
        return { status: 200, body: bytes, contentType: entry.mediaType };
      } catch {
        return refuse('unavailable');
      }
    },
  };
}
