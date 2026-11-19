// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The reader's file system (docs/planning/_archive/M19b.md, Design 7; C25–C30, C55): three questions of a
// path, behind an interface, so that the reader's tests run on a stand-in that records every call
// and touch no disk (V4). This is the one file of src/main/files that imports a file-system
// module, and the pinned list in tests/architecture/instance-reach.test.ts names it.
//
// Nothing here decides anything: which paths may be asked is the reader's (reader.ts), and every
// call goes through the read limiter (limiter.ts). Nothing here writes.
import { open, opendir, stat } from 'node:fs/promises';

export interface FileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

/** One entry of a folder, by its name and kind. A link says that it is one, and is followed by no one. */
export interface FolderEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ReaderFs {
  /** What is at a path, links followed: its kind, size and modification time. */
  stat(path: string): Promise<FileStat>;
  /** A file's bytes from its start, `limit` at most: a file that is longer gives `limit` of them. */
  read(path: string, limit: number): Promise<Uint8Array>;
  /** A folder's entries, `limit` at most, in the order the system gives them. */
  list(path: string, limit: number): Promise<readonly FolderEntry[]>;
}

/** Errors that say nothing is there under that name. */
const GONE = new Set(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EINVAL']);
export const isGone = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && GONE.has(error.code);

export const nodeReaderFs: ReaderFs = {
  stat: (path) => stat(path),
  async read(path, limit) {
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
  },
  async list(path, limit) {
    const entries: FolderEntry[] = [];
    // Leaving the loop closes the folder, at its end or at the limit.
    for await (const entry of await opendir(path)) {
      entries.push(entry);
      if (entries.length >= limit) break;
    }
    return entries;
  },
};
