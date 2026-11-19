// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The conversation store's files, as files (docs/planning/_archive/M18.md, Design 2, 8, 9; C23, C40, C41;
// docs/planning/_archive/M23.md, Design 2; C84, C90): the one module of the store that touches the file system
// for its database. It makes the data folder, measures the store, moves a refused store aside with
// its images as one generation, and lists and removes the generations Start fresh set aside. It opens
// no database: that is open.ts, through SQLite alone. The active images are attachments/files.ts's.
//
// Everything it touches is in fat-g's data folder, and a removal takes only a name Start fresh gave
// a store (C41): never a path, and never another file.
//
// A generation (M23, C84) is the database, its two sidecars and its images' folder, moved aside
// together under one dated name. Their renames are four steps, and a crash between two would leave
// the old images in the active folder beside no database that names them — which the next open's
// sweep would take for unreferenced. So the move is announced first, by a marker in the data folder
// that holds the generation's stamp and nothing else; while it stands, no store is opened and no
// folder is swept, and the next launch finishes the move before anything else.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { SET_ASIDE_STORE } from '@shared/contracts/conversation';
import { errorCode } from '../storage/json-file';
import { MAX_SUFFIX, setAsideStamp } from '../storage/set-aside';
import { SIDECAR_ENDINGS, STORE_FILE, storeFiles } from './format';

export interface StoreFilesIo {
  mkdir(dir: string): void;
  /** A file's size in bytes, or null when nothing is at the path. Throws for any other failure. */
  size(file: string): number | null;
  list(dir: string): readonly string[];
  remove(file: string): void;
  /** Whether anything is at the path, a folder included. */
  exists(file: string): boolean;
  /** A folder's files, measured flat: null when it is not there. */
  folderBytes(dir: string): number | null;
  /** A folder and what it holds. One that is not there is no failure. */
  removeTree(dir: string): void;
  rename(from: string, to: string): void;
  /** The marker's text, written and flushed to the disk before this returns. */
  writeDurable(file: string, text: string): void;
  readText(file: string): string;
}

export const nodeStoreFilesIo: StoreFilesIo = {
  mkdir: (dir) => void mkdirSync(dir, { recursive: true }),
  size(file) {
    try {
      return statSync(file).size;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  },
  remove: (file) => rmSync(file),
  exists: (file) => existsSync(file),
  folderBytes(dir) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    return names.reduce((sum, name) => {
      const stat = lstatSync(path.join(dir, name));
      return sum + (stat.isFile() ? stat.size : 0);
    }, 0);
  },
  removeTree: (dir) => rmSync(dir, { recursive: true, force: true }),
  rename: (from, to) => renameSync(from, to),
  writeDurable(file, text) {
    const descriptor = openSync(file, 'w');
    try {
      writeSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  },
  readText: (file) => readFileSync(file, 'utf8'),
};

/** The marker of a generation's move under way (C84): its stamp and attempt alone, no path and no content. */
export const MOVE_MARKER = 'conversations.start-fresh.json';

/** The images' folder a set-aside store's generation holds, by the store's own name. */
export function setAsideFolder(storeName: string): string | null {
  const match = /^conversations\.set-aside\.(.+)\.sqlite$/.exec(storeName);
  return match === null ? null : `${ATTACHMENTS_FOLDER}.set-aside.${match[1] ?? ''}`;
}

/** A name moved aside under a stamp and an attempt, as storage/set-aside.ts names one. */
function asideName(name: string, stamp: string, attempt: number): string {
  // The store's sidecars keep their ending after the main file's: `.sqlite-wal` is one ending.
  const extension = name.startsWith(STORE_FILE) ? name.slice(STORE_FILE.length - '.sqlite'.length) : path.extname(name);
  const base = name.slice(0, name.length - extension.length);
  return `${base}.set-aside.${stamp}${attempt === 1 ? '' : `-${attempt}`}${extension}`;
}

/** What a generation is made of, in the order it moves: the database first, its images last. */
const GENERATION = [...storeFiles(), ATTACHMENTS_FOLDER] as const;

export interface StoreFiles {
  /** Makes the data folder, if it is not there. */
  ensureFolder(): void;
  /** The main file's path. */
  readonly file: string;
  /** The main file's size, or null when there is none: a zero-length file is a store not yet made (C36). */
  mainSize(): number | null;
  /** The store's files together, in bytes; null when they could not be measured. */
  totalSize(): number | null;
  /** The stores set aside, by their main file's name, each with its sidecars' and its images' folder's sizes added (C41, C84). */
  setAside(): readonly { readonly name: string; readonly bytes: number }[];
  /**
   * Removes set-aside generations by name (C90): each one's images' folder first, then its sidecars,
   * and its database last, by whose name it is listed — so a removal that fails or is cut short at any
   * step leaves it listed, and Remove again finishes it. A name that is not a set-aside store's, or a
   * generation whose move has not settled (C84), is not removed. Answers how many went, and how many did not.
   */
  removeSetAside(names: readonly string[]): { readonly removed: number; readonly failed: number };
  /**
   * Finishes a generation's move a crash cut short (C84), before the store is opened: `none` with no
   * move under way, `settled` once it is finished, `failed` where it cannot be — the store is then
   * refused, and nothing is opened or swept.
   */
  settleMove(): 'none' | 'settled' | 'failed';
  /**
   * Moves the refused store and its images aside as one generation (C40, C84), announced by the
   * marker first. A rename that fails moves back what was moved, and rejects. Answers the main file's new path.
   */
  moveAside(now: number): Promise<string>;
}

export function createStoreFiles(dir: string, io: StoreFilesIo = nodeStoreFilesIo): StoreFiles {
  const file = path.join(dir, STORE_FILE);
  const marker = path.join(dir, MOVE_MARKER);
  const sizeOf = (name: string): number => io.size(path.join(dir, name)) ?? 0;

  /** The generation the marker names, or null where there is none; `unreadable` for a marker that cannot be read. */
  function marked(): { readonly stamp: string; readonly attempt: number } | null | 'unreadable' {
    if (!io.exists(marker)) return null;
    try {
      const value = JSON.parse(io.readText(marker)) as unknown;
      if (typeof value !== 'object' || value === null) return 'unreadable';
      const { stamp, attempt } = value as { stamp?: unknown; attempt?: unknown };
      if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(stamp)) return 'unreadable';
      if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_SUFFIX) return 'unreadable';
      return { stamp, attempt };
    } catch {
      return 'unreadable';
    }
  }

  function setAside(): { name: string; bytes: number }[] {
    const names = io.list(dir).filter((name) => SET_ASIDE_STORE.test(name)).sort();
    return names.map((name) => {
      const folder = setAsideFolder(name);
      const images = folder === null ? 0 : io.folderBytes(path.join(dir, folder)) ?? 0;
      return { name, bytes: storeFiles(name).reduce((sum, part) => sum + sizeOf(part), 0) + images };
    });
  }

  return {
    file,
    ensureFolder: () => io.mkdir(dir),
    mainSize: () => io.size(file),
    totalSize() {
      try {
        return storeFiles().reduce((sum, name) => sum + sizeOf(name), 0);
      } catch {
        return null;
      }
    },
    setAside() {
      try {
        return setAside();
      } catch {
        return [];
      }
    },
    removeSetAside(names) {
      let removed = 0;
      let failed = 0;
      let listed: Set<string>;
      try { listed = new Set(setAside().map((entry) => entry.name)); } catch { return { removed: 0, failed: new Set(names).size }; }
      const moving = marked();
      for (const name of new Set(names)) {
        // Only a store this folder lists, under the name Start fresh gave it.
        if (!SET_ASIDE_STORE.test(name) || !listed.has(name)) { failed += 1; continue; }
        // Never a generation still being moved there (C84).
        if (moving === 'unreadable' || (moving !== null && asideName(STORE_FILE, moving.stamp, moving.attempt) === name)) { failed += 1; continue; }
        try {
          // Its images first, then what SQLite kept beside it — its log can hold text the main file
          // does not (C40) — and its database last, which lists it until it goes (C90).
          const folder = setAsideFolder(name);
          if (folder !== null) io.removeTree(path.join(dir, folder));
          for (const ending of SIDECAR_ENDINGS) {
            const sidecar = path.join(dir, `${name}${ending}`);
            if (io.size(sidecar) !== null) io.remove(sidecar);
          }
          io.remove(path.join(dir, name));
          removed += 1;
        } catch {
          failed += 1;
        }
      }
      return { removed, failed };
    },
    settleMove() {
      const moving = marked();
      if (moving === null) return 'none';
      if (moving === 'unreadable') return 'failed';
      try {
        for (const name of GENERATION) {
          const from = path.join(dir, name);
          const to = path.join(dir, asideName(name, moving.stamp, moving.attempt));
          if (!io.exists(from)) continue;
          // Both there: a move this cannot finish without writing over one of them.
          if (io.exists(to)) return 'failed';
          io.rename(from, to);
        }
        io.remove(marker);
        return 'settled';
      } catch {
        return 'failed';
      }
    },
    moveAside(now) {
      // A rejection for a throw: the move is synchronous, and its caller awaits it as Start fresh's.
      return new Promise((resolve) => { resolve(move(now)); });
    },
  };

  /** The move itself (C84): see `moveAside`. */
  function move(now: number): string {
    const stamp = setAsideStamp(now);
    for (let attempt = 1; attempt <= MAX_SUFFIX; attempt += 1) {
      const targets = GENERATION.map((name) => path.join(dir, asideName(name, stamp, attempt)));
      if (targets.some((target) => io.exists(target))) continue;
      io.writeDurable(marker, `${JSON.stringify({ stamp, attempt })}\n`);
      const moved: { readonly from: string; readonly to: string }[] = [];
      try {
        for (const [index, name] of GENERATION.entries()) {
          const from = path.join(dir, name);
          if (!io.exists(from)) continue;
          const to = targets[index] as string;
          io.rename(from, to);
          moved.push({ from, to });
        }
      } catch (error) {
        // Back where they were, last moved first. The marker goes only once all of them are back:
        // otherwise the next launch finishes the move the user chose.
        let back = true;
        for (const { from, to } of moved.reverse()) {
          try { io.rename(to, from); } catch { back = false; }
        }
        if (back) { try { io.remove(marker); } catch { /* the next launch finds nothing to move */ } }
        throw error;
      }
      try { io.remove(marker); } catch { /* the next launch finds nothing left to move */ }
      return targets[0] as string;
    }
    throw Object.assign(new Error('every set-aside name is taken'), { code: 'EEXIST' });
  }
}
