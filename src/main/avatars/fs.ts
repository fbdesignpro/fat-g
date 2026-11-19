// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The avatars' file system (docs/planning/_archive/M102.md, Design 3; C21, C40, C58, C61): what the scanner,
// the manifest reader and the media route's avatar source ask of a path, behind an interface, so that
// their tests run on a stand-in that records every call (V15, V16). This is the one file of
// src/main/avatars that imports a file-system module, and the pinned lists in
// tests/architecture/instance-reach.test.ts and records-reach.test.ts name it.
//
// Nothing here decides anything. Nothing is followed: a link is told as one, and a list or a stat
// never goes through it. Writes: the user's folder, made empty where it is missing, when the user
// presses Show avatars folder (C40); and a family's `family.json`, replaced whole by a temp file
// renamed over it, which authoring.ts decides; the built-in family's files in a new user family at
// Make a copy, reserved exclusively and removed only if that copy fails (decision 0031); a new
// avatar's folder and its two PNGs at Add avatar, or a new family from an image, the same way (add-avatar.ts; decision 0036); and an
// image replaced, written beside the old under a new name and moved into its place once the old has
// gone to the system's trash, which the service is handed (replace-image.ts; decision 0036).
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { writeFileAtomic } from '../storage/atomic-write';

/** What an entry is, without following it (C58). */
export type AvatarEntryKind = 'file' | 'folder' | 'link' | 'other';

export interface AvatarEntry {
  readonly name: string;
  readonly kind: AvatarEntryKind;
}

export interface AvatarStat {
  readonly kind: AvatarEntryKind;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface AvatarFs {
  /** A folder's entries, each with its kind, no link followed. */
  list(folder: string): Promise<readonly AvatarEntry[]>;
  /** What is at a path, a link told as one and not followed. */
  lstat(path: string): Promise<AvatarStat>;
  realpath(path: string): Promise<string>;
  /** A file's first `bytes` bytes, or all of a shorter one. */
  readPrefix(path: string, bytes: number): Promise<Uint8Array>;
  /** A file whole, or null for one longer than `bound`: no more than `bound` and one bytes are read. */
  readWhole(path: string, bound: number): Promise<Uint8Array | null>;
  /** The folder and any missing above it, nothing in it (C40). */
  createFolder(folder: string): Promise<void>;
  /** A file's text replaced whole, or written where there is none: a reader sees the old or the new. */
  writeText(path: string, text: string): Promise<void>;
  /** Reserve a new copy's folder without ever merging with an existing one. False if it exists. */
  createExclusiveFolder(folder: string): Promise<boolean>;
  /** A copied role, manifest or licence, created exclusively. Never overwrites an existing file. */
  writeNewFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Remove only a newly reserved copy after a failed write, checked by the caller. */
  removeCopy(folder: string): Promise<void>;
  /** A file this adapter wrote moved into its place in the same folder, replacing what may be there. */
  moveFile(from: string, to: string): Promise<void>;
}

function kindOf(entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): AvatarEntryKind {
  if (entry.isSymbolicLink()) return 'link';
  if (entry.isFile()) return 'file';
  return entry.isDirectory() ? 'folder' : 'other';
}

/** Up to `limit` bytes from a file's start. */
async function readUpTo(path: string, limit: number): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(limit);
    let filled = 0;
    while (filled < limit) {
      const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

export const nodeAvatarFs: AvatarFs = {
  async list(folder) {
    return (await readdir(folder, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
  },
  async lstat(path) {
    const stats = await lstat(path);
    return { kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs };
  },
  realpath: (path) => realpath(path),
  readPrefix: (path, bytes) => readUpTo(path, bytes),
  async readWhole(path, bound) {
    const bytes = await readUpTo(path, bound + 1);
    return bytes.byteLength > bound ? null : bytes;
  },
  async createFolder(folder) {
    await mkdir(folder, { recursive: true });
  },
  writeText: (path, text) => writeFileAtomic(path, text),
  async createExclusiveFolder(folder) {
    try { await mkdir(folder); return true; }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
      throw error;
    }
  },
  async writeNewFile(path, bytes) { await writeFile(path, bytes, { flag: 'wx' }); },
  async removeCopy(folder) { await rm(folder, { recursive: true, force: true }); },
  async moveFile(from, to) { await rename(from, to); },
};
