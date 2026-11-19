// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An avatar's image replaced (decision 0036): its main image with its small, or its small alone, by
// the PNGs the page scaled from an image the user dropped or chose. Nothing is decoded here: both are
// judged by their headers alone, with the one header reader. The family is checked as a save checks
// it — the root writable, its folder no link and one name inside its root's real path — and the
// avatar's folder must be one the scan lists in it, its own real path unchanged. `family.json` is not
// touched.
//
// Each new file is written beside the old under a name of its own, never over anything; then, a role at
// a time, every file of its role — `portrait.webp` as well as `portrait.png`, in any case — goes to the
// system's trash, from where the user can bring it back, and the new one is moved into its place as
// `<role>.png`. A failure removes the new files not yet in place and leaves the rest as it stands.
//
// Electron-free: the file system and the trash are parameters.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ADDED_PORTRAIT_SIDE, ADDED_SMALL_SIDE, type FamilyLock, type ReplaceImageRequest } from '@shared/contracts/avatar-family';
import { type AvatarRole, roleFileOf } from '@shared/contracts/avatars';
import { locate } from './authoring';
import { checked } from './copy-family';
import { stillPng } from './added-images';
import type { AvatarFs } from './fs';
import type { ScannedFamily, ScannedRoot } from './scan';

export type ReplaceResult =
  | { readonly kind: 'replaced' }
  | { readonly kind: 'locked'; readonly lock: FamilyLock }
  | { readonly kind: 'missing' | 'invalid' | 'failed' };

/** Moves a file to the system's trash, from where the user can restore it. */
export type Trash = (file: string) => Promise<void>;


export async function replaceImage(root: ScannedRoot, family: ScannedFamily, writable: boolean, fs: AvatarFs, trash: Trash, request: ReplaceImageRequest): Promise<ReplaceResult> {
  if (!writable) return { kind: 'locked', lock: { kind: 'packaged' } };
  if (!family.avatars.some((avatar) => avatar.folder === request.avatar)) return { kind: 'missing' };
  if ((request.portrait !== null && !stillPng(request.portrait, ADDED_SMALL_SIDE, ADDED_PORTRAIT_SIDE)) || !stillPng(request.small, ADDED_SMALL_SIDE, ADDED_SMALL_SIDE)) return { kind: 'invalid' };
  const located = await locate(root, family, fs);
  if (located === null) return { kind: 'locked', lock: { kind: 'link' } };
  let folder: string;
  try {
    folder = await checked(located.folder, [request.avatar], 'folder', fs);
  } catch {
    return { kind: 'missing' };
  }

  const writes: { readonly role: AvatarRole; readonly bytes: Uint8Array; readonly fresh: string }[] = [];
  const suffix = randomBytes(6).toString('hex');
  for (const [role, bytes] of [['portrait', request.portrait], ['small', request.small]] as const) {
    if (bytes !== null) writes.push({ role, bytes, fresh: path.join(folder, `.fat-g-new-${role}-${suffix}.png`) });
  }
  const removeFresh = async (): Promise<void> => {
    for (const write of writes) {
      try { await fs.removeCopy(write.fresh); } catch { /* Left for the user's own cleaning. */ }
    }
  };

  // The new files, written beside the old, then the old ones found: a link where a role file stands is refused.
  let old: readonly { readonly role: AvatarRole; readonly file: string }[];
  try {
    for (const write of writes) await fs.writeNewFile(write.fresh, write.bytes);
    const entries = await fs.list(folder);
    const roles = new Set(writes.map((write) => write.role));
    const found = entries.flatMap((entry) => {
      const role = roleFileOf(entry.name)?.role;
      return role !== undefined && roles.has(role) ? [{ role, entry }] : [];
    });
    if (found.some(({ entry }) => entry.kind !== 'file')) throw new Error('a role file that is no file');
    old = found.map(({ role, entry }) => ({ role, file: path.join(folder, entry.name) }));
  } catch {
    await removeFresh();
    return { kind: 'failed' };
  }

  // A role at a time, the main image first: its old files to the trash, then its new one into place. The
  // first that fails stops the replace there, a role already replaced standing so.
  for (const write of writes) {
    try {
      for (const each of old.filter((file) => file.role === write.role)) await trash(each.file);
      await fs.moveFile(write.fresh, path.join(folder, `${write.role}.png`));
    } catch {
      await removeFresh();
      return { kind: 'failed' };
    }
  }
  return { kind: 'replaced' };
}
