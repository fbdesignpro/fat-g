// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Reset runs synchronously immediately after the process lock, before Electron can open its profile.
import { constants, lstatSync, openSync, readdirSync, realpathSync, rmdirSync, unlinkSync, fstatSync, readSync, writeFileSync, writeSync, fsyncSync, closeSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DataResetInfo, DataResetResult } from '@shared/contracts/data-reset';
import { plainObject, readEnvelope } from '../storage/envelope';
import { errorCode } from '../storage/json-file';

export const DATA_RESET_FILE = 'reset-on-next-start.json';
// Live Electron/Chromium process locks, not configuration. Never remove them while holding the lock.
const RUNTIME_LOCK_FILES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']);
const SQLITE_CONTENT = /^conversations(?:\.set-aside\.[a-zA-Z0-9-]+)?\.sqlite(?:-(?:wal|shm|journal))?$/;
interface ResetStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly nlink: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
// NTFS file ids can exceed Number.MAX_SAFE_INTEGER. Never round identity comparisons.
const nativeStat = (stat: BigIntStats): ResetStat => ({
  dev: stat.dev, ino: stat.ino, size: Number(stat.size), nlink: Number(stat.nlink),
  isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(), isSymbolicLink: () => stat.isSymbolicLink(),
});
const sameFile = (a: ResetStat, b: ResetStat): boolean => a.dev === b.dev && a.ino === b.ino;

export interface DataResetIo {
  lstat(file: string): ResetStat;
  realpath(file: string): string;
  readdir(folder: string): string[];
  unlink(file: string): void;
  rmdir(folder: string): void;
  open(file: string, flags: string | number, mode?: number): number;
  fstat(fd: number): ResetStat;
  read(fd: number): string;
  writeText(fd: number, text: string): void;
  write(fd: number, bytes: Uint8Array, offset: number, length: number, position: number): number;
  sync(fd: number): void;
  close(fd: number): void;
}
const nodeIo: DataResetIo = {
  lstat: (file) => nativeStat(lstatSync(file, { bigint: true })), realpath: realpathSync, readdir: readdirSync, unlink: unlinkSync, rmdir: rmdirSync,
  open: openSync, fstat: (fd) => nativeStat(fstatSync(fd, { bigint: true })),
  read: (fd) => {
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 4096) throw new Error('oversized-reset-request');
    return bytes.subarray(0, count).toString('utf8');
  },
  writeText: (fd, text) => writeFileSync(fd, text, 'utf8'),
  write: writeSync, sync: fsyncSync, close: closeSync,
};
type Request = { readonly id: string; readonly stat: ResetStat };

/** Electron's fixed userData only. No renderer-provided paths or externally followed links. */
export function createDataReset(folder: string, supplied: Partial<DataResetIo> = {}) {
  const io = { ...nodeIo, ...supplied };
  const marker = path.join(folder, DATA_RESET_FILE);
  const safeName = (name: string): boolean => name !== '.' && name !== '..' && name.length > 0 && path.basename(name) === name && !name.includes('\0');
  const within = (root: string, target: string): boolean => { const relative = path.relative(root, target); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

  function root(): { canonical: string; stat: ResetStat } {
    if (!path.isAbsolute(folder) || path.dirname(folder) === folder) throw new Error('unsafe-reset-root');
    const stat = io.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-reset-root');
    const canonical = io.realpath(folder);
    if (path.dirname(canonical) === canonical) throw new Error('unsafe-reset-root');
    return { canonical, stat };
  }

  function readRequest(): Request | null {
    let stat: ResetStat;
    try { stat = io.lstat(marker); } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error('invalid-reset-request');
    root();
    const fd = io.open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = io.fstat(fd);
      if (!sameFile(stat, opened) || opened.size > 4096) throw new Error('reset-request-changed');
      const value: unknown = JSON.parse(io.read(fd));
      if (readEnvelope(value, 1).kind !== 'ok' || !plainObject(value) || value['scope'] !== 'all'
        || typeof value['id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value['id'])) throw new Error('invalid-reset-request');
      return { id: value['id'], stat };
    } finally { io.close(fd); }
  }

  function info(): DataResetInfo {
    try { root(); readRequest(); return { folder, available: true }; }
    catch { return { folder, available: false }; }
  }

  function schedule(): DataResetResult {
    let created: ResetStat | undefined;
    try {
      root();
      if (readRequest() !== null) return { status: 'scheduled' };
      // Exclusive creation never follows a planted link or replaces an incompatible request.
      const fd = io.open(marker, 'wx', 0o600);
      try {
        created = io.fstat(fd);
        io.writeText(fd, `${JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, scope: 'all', id: randomUUID() })}\n`);
        io.sync(fd);
      } finally { io.close(fd); }
      return { status: 'scheduled' };
    } catch {
      if (created !== undefined) {
        try { if (sameFile(created, io.lstat(marker))) io.unlink(marker); } catch { /* startup refuses an incomplete marker */ }
      }
      return { status: 'failed' };
    }
  }

  function consume(): 'none' | 'reset' | 'failed' {
    try {
      const requested = readRequest();
      if (requested === null) return 'none';
      const admitted = root();
      const assertDirectory = (directory: string, expected?: ResetStat): void => {
        const currentRoot = io.lstat(folder);
        if (!sameFile(currentRoot, admitted.stat) || currentRoot.isSymbolicLink() || io.realpath(folder) !== admitted.canonical) throw new Error('reset-root-changed');
        const stat = io.lstat(directory);
        const canonical = io.realpath(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (expected !== undefined && !sameFile(stat, expected))
          || (canonical !== admitted.canonical && !within(admitted.canonical, canonical))) throw new Error('reset-path-refused');
      };
      const erase = (target: string): void => {
        if (!within(folder, target)) throw new Error('reset-path-refused');
        assertDirectory(path.dirname(target));
        const stat = io.lstat(target);
        if (stat.isSymbolicLink()) { io.unlink(target); return; }
        if (stat.isDirectory()) {
          assertDirectory(target, stat);
          for (const name of io.readdir(target)) {
            if (!safeName(name)) throw new Error('reset-path-refused');
            erase(path.join(target, name));
          }
          assertDirectory(target, stat);
          io.rmdir(target);
          return;
        }
        // Overwrite conversation files first, but never modify a hard-linked outside copy.
        if (stat.isFile() && stat.nlink === 1 && SQLITE_CONTENT.test(path.basename(target))) {
          const fd = io.open(target, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
          try {
            const opened = io.fstat(fd);
            if (!sameFile(stat, opened) || !opened.isFile()) throw new Error('reset-file-changed');
            if (opened.nlink === 1) {
              const zero = Buffer.alloc(1024 * 1024);
              for (let position = 0; position < opened.size;) {
                const written = io.write(fd, zero, 0, Math.min(zero.length, opened.size - position), position);
                if (written === 0) throw new Error('reset-write-failed');
                position += written;
              }
              io.sync(fd);
            }
          } finally { io.close(fd); }
        }
        assertDirectory(path.dirname(target));
        if (!sameFile(stat, io.lstat(target))) throw new Error('reset-file-changed');
        io.unlink(target);
      };
      const isRuntimeLock = (name: string): boolean => [...RUNTIME_LOCK_FILES].some((reserved) => reserved.toLowerCase() === name.toLowerCase());
      // Identify the request by inode, including case-preserving aliases on Windows/macOS.
      const isRequest = (name: string): boolean => sameFile(io.lstat(path.join(folder, name)), requested.stat);
      for (const name of io.readdir(folder)) {
        if (!safeName(name)) throw new Error('reset-path-refused');
        if (!isRuntimeLock(name) && !isRequest(name)) erase(path.join(folder, name));
      }
      assertDirectory(folder, admitted.stat);
      if (io.readdir(folder).some((name) => !isRuntimeLock(name) && !isRequest(name))) throw new Error('reset-not-empty');
      const last = readRequest();
      if (last === null || last.id !== requested.id || !sameFile(last.stat, requested.stat)) throw new Error('reset-request-changed');
      io.unlink(marker); // Last: interrupted resets remain pending and never load partial data.
      return 'reset';
    } catch { return 'failed'; }
  }
  return { info: () => Promise.resolve(info()), schedule: () => Promise.resolve(schedule()), consume };
}
export type DataReset = ReturnType<typeof createDataReset>;
