// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Add avatar (decision 0036): a new avatar of a listed family, made of the two PNGs the page scaled
// from an image the user dropped or chose. Nothing is decoded here: both are judged by their headers
// alone, with the one header reader. The family is checked as a save checks it — the root writable,
// its folder no link and one name inside its root's real path, its file no link, read again, of the
// revision the editor holds and not refused. The name is checked again and must be no entry's of the
// family's folder nor its file's, in any case. The folder is then reserved exclusively, its two files
// written without overwriting anything, and `family.json` written with the new entry last, as a save
// writes it. A failure after the folder is reserved removes that folder alone.
//
// Electron-free: the file system is a parameter (fs.ts).
import path from 'node:path';
import { ADDED_PORTRAIT_SIDE, ADDED_SMALL_SIDE, type AddAvatarRequest, type FamilyLock, isNewAvatarName } from '@shared/contracts/avatar-family';
import { LICENSE_FILE, MANIFEST_FILE, MANIFEST_MAX_BYTES } from '@shared/contracts/avatars';
import { locate, manifestAdding, readCurrent, revisionOf } from './authoring';
import { checked } from './copy-family';
import { stillPng } from './added-images';
import type { AvatarFs } from './fs';
import type { ScannedFamily, ScannedRoot } from './scan';

export type AddResult =
  | { readonly kind: 'added'; readonly folder: string }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'locked'; readonly lock: FamilyLock }
  | { readonly kind: 'taken' | 'invalid' | 'failed' };

/** The role files Add avatar writes: PNGs always, the page having made them. */
export const ADDED_PORTRAIT_FILE = 'portrait.png';
export const ADDED_SMALL_FILE = 'small.png';


const folded = (name: string): string => name.toLowerCase();

export async function addAvatar(root: ScannedRoot, family: ScannedFamily, writable: boolean, fs: AvatarFs, request: AddAvatarRequest): Promise<AddResult> {
  if (!writable) return { kind: 'locked', lock: { kind: 'packaged' } };
  const located = await locate(root, family, fs);
  if (located === null) return { kind: 'locked', lock: { kind: 'link' } };
  const current = await readCurrent(located.file, fs);
  if (current.link) return { kind: 'locked', lock: { kind: 'link' } };
  if ((current.bytes === null ? null : revisionOf(current.bytes)) !== request.revision) return { kind: 'conflict' };
  if (current.reading.kind === 'refused') return { kind: 'locked', lock: { kind: 'manifest', cause: current.reading.cause, field: current.reading.field } };
  if (!isNewAvatarName(request.name) || !stillPng(request.portrait, ADDED_SMALL_SIDE, ADDED_PORTRAIT_SIDE) || !stillPng(request.small, ADDED_SMALL_SIDE, ADDED_SMALL_SIDE)) return { kind: 'invalid' };

  // Taken: any entry of the folder as it is now, any folder the file names, and the family's own files' names.
  let present: readonly string[];
  try {
    present = (await fs.list(located.folder)).map((entry) => entry.name);
  } catch {
    return { kind: 'failed' };
  }
  const listed = current.reading.kind === 'applied' ? (current.reading.manifest.avatars ?? []).map((entry) => entry.folder) : [];
  const name = folded(request.name);
  if ([...present, ...listed, MANIFEST_FILE, LICENSE_FILE].some((other) => folded(other) === name)) return { kind: 'taken' };

  const text = manifestAdding(current, family.avatars.map((avatar) => avatar.folder), { folder: request.name, matches: request.matches, overlay: {} });
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) return { kind: 'invalid' };

  const folder = path.join(located.folder, request.name);
  try {
    if (!await fs.createExclusiveFolder(folder)) return { kind: 'taken' };
  } catch {
    return { kind: 'failed' };
  }
  try {
    await checked(located.folder, [request.name], 'folder', fs);
    await fs.writeNewFile(path.join(folder, ADDED_PORTRAIT_FILE), request.portrait);
    await fs.writeNewFile(path.join(folder, ADDED_SMALL_FILE), request.small);
    await fs.writeText(located.file, text);
    return { kind: 'added', folder: request.name };
  } catch {
    try {
      // Delete only the folder this call reserved, still at the same real location.
      await checked(located.folder, [request.name], 'folder', fs);
      await fs.removeCopy(folder);
    } catch { /* A changed or inaccessible folder is left alone. */ }
    return { kind: 'failed' };
  }
}
