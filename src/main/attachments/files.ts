// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The active images' folder (docs/planning/_archive/M23.md, Design 2, 3; C6, C8, C10, C11, C85; decision 0030):
// `attachments/` in fat-g's data folder, each image a file named by the SHA-256 of its bytes and the
// ending its signature gives. A file is written once, through a temporary name renamed over at the
// end, and never renamed, moved or rewritten after: it goes when the conversation store says its
// last use went, by an unlink (C6), which leaves its bytes to the drive as any deletion does.
//
// The one module that touches that folder's files. It reads no path a page or a provider gave: a
// file is named by its hash and media type alone, which main checked. Electron-free, with its file
// system a parameter, so its failures are tested in plain Node.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENT_EXTENSIONS, type AttachmentMediaType, isAttachmentHash } from '@shared/contracts/attachments';
import { errorCode } from '../storage/json-file';

/** What a file is, as `lstat` says: never followed through a link. */
export interface BlobStat {
  readonly size: number;
  readonly file: boolean;
  readonly link: boolean;
}

export interface BlobIo {
  mkdir(dir: string): void;
  /** The names in a folder; none where it is not there. */
  list(dir: string): readonly string[];
  /** What is at the path, without following a link; null where nothing is. */
  lstat(file: string): BlobStat | null;
  readFile(file: string): Promise<Uint8Array>;
  writeFile(file: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file; one that is not there is no failure. */
  remove(file: string): void;
  removeAsync(file: string): Promise<void>;
}

export const nodeBlobIo: BlobIo = {
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  list(dir) {
    try {
      return readdirSync(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  },
  lstat(file) {
    try {
      const stat = lstatSync(file);
      return { size: stat.size, file: stat.isFile(), link: stat.isSymbolicLink() };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
  readFile: async (file) => new Uint8Array(await readFile(file)),
  writeFile: (file, bytes) => writeFile(file, bytes, { flag: 'wx' }),
  rename,
  remove: (file) => rmSync(file, { force: true }),
  removeAsync: (file) => rm(file, { force: true }),
};

/** An image's file name: its hash and the ending its signature gives (C85). */
export function blobName(hash: string, mediaType: AttachmentMediaType): string {
  return `${hash}.${ATTACHMENT_EXTENSIONS[mediaType]}`;
}

/** A name the folder holds an image under: a hash and one of the four endings. */
const BLOB_NAME = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
/** A temporary file of a write a crash cut short. */
const TEMP_NAME = /^\.stage-[0-9a-f-]{1,64}\.tmp$/;

/**
 * The image a path names (C25): only a file directly in the active images' folder, named as fat-g
 * names one. Null for any other path — one fat-g never wrote — which is never opened. What a
 * provider's history returns of an image it was sent is matched by this, and by nothing read.
 */
export function blobHashOfPath(root: string, file: string, paths: path.PlatformPath = path): { readonly hash: string; readonly mediaType: AttachmentMediaType } | null {
  if (!paths.isAbsolute(file)) return null;
  const relative = paths.relative(root, file);
  if (relative === '' || relative.includes('/') || relative.includes('\\') || relative.startsWith('..')) return null;
  const match = BLOB_NAME.exec(relative);
  const mediaType = match === null ? undefined : EXTENSION_TYPES[match[2] ?? ''];
  return match === null || mediaType === undefined ? null : { hash: match[1] ?? '', mediaType };
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface BlobFiles {
  /** The folder, in fat-g's data folder. */
  readonly root: string;
  /** The path of an image's file, built from its hash and type alone (C21, C24): what main hands a CLI that reads a path. */
  pathOf(hash: string, mediaType: AttachmentMediaType): string;
  /**
   * Writes an image's bytes under their hash (C85): a temporary file, then renamed over. Where a file
   * of that name already holds those same bytes it is kept, and nothing is written over it. Rejects
   * where nothing could be written; a temporary file it leaves is the next open's to remove.
   */
  write(hash: string, mediaType: AttachmentMediaType, bytes: Uint8Array): Promise<void>;
  /**
   * An image's bytes, for the media route (C10, C11): only a regular file — no link — of the size the
   * store names, whose bytes hash to its name. Null for anything else: a missing file, a changed one,
   * one replaced by a link. Never a path from a request.
   */
  read(hash: string, mediaType: AttachmentMediaType, bytes: number): Promise<Uint8Array | null>;
  /** Whether the file of a held image is there, as a regular file of its size (C8). */
  holds(hash: string, mediaType: AttachmentMediaType, bytes: number): boolean;
  /** Unlinks an image whose last use went (C6). False where it could not: the next open's sweep finishes it. */
  remove(hash: string, mediaType: AttachmentMediaType): boolean;
  /**
   * At a compatible store's open (C6): every temporary file a crash left, and every image file the
   * store names no image for, is removed. A name of any other shape is left as it is. Answers how many went.
   */
  sweep(known: (hash: string, mediaType: AttachmentMediaType) => boolean): number;
  /** The folder's images, counted and measured (C12); null where they could not be. */
  measure(): { readonly count: number; readonly bytes: number } | null;
}

const EXTENSION_TYPES: Readonly<Record<string, AttachmentMediaType>> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function createBlobFiles(root: string, io: BlobIo = nodeBlobIo): BlobFiles {
  const fileOf = (hash: string, mediaType: AttachmentMediaType): string => {
    // The store checked the hash; this checks it again, since a path is made of it.
    if (!isAttachmentHash(hash)) throw new Error('not an image hash');
    return path.join(root, blobName(hash, mediaType));
  };

  /** Whether the file at `file` is a regular one holding exactly these bytes' hash and size. */
  async function verified(file: string, hash: string, bytes: number): Promise<Uint8Array | null> {
    const stat = io.lstat(file);
    if (stat === null || !stat.file || stat.link || stat.size !== bytes) return null;
    const content = await io.readFile(file);
    return content.byteLength === bytes && sha256(content) === hash ? content : null;
  }

  return {
    root,

    pathOf: fileOf,

    async write(hash, mediaType, bytes) {
      const file = fileOf(hash, mediaType);
      io.mkdir(root);
      // The same bytes staged again, or by a staging that ran beside this one: one file (C85).
      if (await verified(file, hash, bytes.byteLength).catch(() => null) !== null) return;
      const temp = path.join(root, `.stage-${randomUUID()}.tmp`);
      await io.writeFile(temp, bytes);
      try {
        // A staging beside this one may have finished meanwhile: its file is the same bytes, and stays.
        if (await verified(file, hash, bytes.byteLength).catch(() => null) !== null) { await io.removeAsync(temp); return; }
        await io.rename(temp, file);
      } catch (error) {
        await io.removeAsync(temp).catch(() => undefined);
        throw error;
      }
    },

    async read(hash, mediaType, bytes) {
      try {
        return await verified(fileOf(hash, mediaType), hash, bytes);
      } catch {
        return null;
      }
    },

    holds(hash, mediaType, bytes) {
      try {
        const stat = io.lstat(fileOf(hash, mediaType));
        return stat !== null && stat.file && !stat.link && stat.size === bytes;
      } catch {
        return false;
      }
    },

    remove(hash, mediaType) {
      try {
        io.remove(fileOf(hash, mediaType));
        return true;
      } catch {
        return false;
      }
    },

    sweep(known) {
      let removed = 0;
      let names: readonly string[];
      try { names = io.list(root); } catch { return 0; }
      for (const name of names) {
        const blob = BLOB_NAME.exec(name);
        const unknown = blob !== null && !known(blob[1] ?? '', EXTENSION_TYPES[blob[2] ?? ''] ?? 'image/png');
        if (!TEMP_NAME.test(name) && !unknown) continue;
        try { io.remove(path.join(root, name)); removed += 1; } catch { /* the next open's */ }
      }
      return removed;
    },

    measure() {
      try {
        let count = 0;
        let bytes = 0;
        for (const name of io.list(root)) {
          if (!BLOB_NAME.test(name)) continue;
          const stat = io.lstat(path.join(root, name));
          if (stat === null || !stat.file) continue;
          count += 1;
          bytes += stat.size;
        }
        return { count, bytes };
      } catch {
        return null;
      }
    },
  };
}
