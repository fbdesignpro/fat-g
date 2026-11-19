// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Writing a file without ever leaving a truncated one behind: write a temp file beside the target,
// flush it to the disk, then rename over the target. Rename is atomic on Windows and POSIX alike,
// so a reader always sees either the whole old file or the whole new one.
//
// Retries exist because on Windows a virus scanner, a backup agent or the search indexer can hold
// the target open for a moment; the rename then fails with EPERM/EACCES/EBUSY and succeeds a few
// milliseconds later. Electron-free and injectable, so both the happy path and the failure paths
// are tested in plain Node.
import { openSync, closeSync, fsyncSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, rename, unlink, writeFile } from 'node:fs/promises';

/** Delays between attempts, in ms. The first attempt is immediate. */
export const RETRY_DELAYS_MS = [10, 25, 60, 150] as const;

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

function isRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && RETRYABLE.has(String(error.code));
}

const tempPathFor = (filePath: string): string => `${filePath}.tmp`;

/** The file-system operations used here, so tests can make them fail. */
export interface AtomicWriteIo {
  /** Write the whole file and flush it to the disk before resolving. */
  writeAndSync(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export const nodeIo: AtomicWriteIo = {
  async writeAndSync(path, data) {
    await writeFile(path, data, 'utf8');
    // Data in the page cache is not data on the disk: a power cut between write and rename would
    // otherwise leave an empty file where the preferences used to be.
    const handle = await open(path, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename,
  async remove(path) {
    await unlink(path).catch(() => undefined);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function writeFileAtomic(filePath: string, data: string, io: AtomicWriteIo = nodeIo): Promise<void> {
  const tempPath = tempPathFor(filePath);
  await io.writeAndSync(tempPath, data);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await io.rename(tempPath, filePath);
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryable(error)) {
        await io.remove(tempPath);
        throw error;
      }
      await io.sleep(delay);
    }
  }
}

// ── The same, synchronously, for `before-quit` ──────────────────────────────────────────────
// The event loop stops right after that event, so the last write cannot be a promise.

export interface AtomicWriteIoSync {
  writeAndSync(path: string, data: string): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
  sleep(ms: number): void;
}

export const nodeIoSync: AtomicWriteIoSync = {
  writeAndSync(path, data) {
    writeFileSync(path, data, 'utf8');
    const fd = openSync(path, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
  remove(path) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone, which is the state we wanted.
    }
  },
  sleep(ms) {
    // There is no event loop left to wait on, so block: a shared buffer nobody will ever notify.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

export function writeFileAtomicSync(filePath: string, data: string, io: AtomicWriteIoSync = nodeIoSync): void {
  const tempPath = tempPathFor(filePath);
  io.writeAndSync(tempPath, data);

  for (let attempt = 0; ; attempt += 1) {
    try {
      io.rename(tempPath, filePath);
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryable(error)) {
        io.remove(tempPath);
        throw error;
      }
      io.sleep(delay);
    }
  }
}

/**
 * A rename, synchronously, with the same retries (M22b, C59, C62): what a scanner or the indexer
 * holds open for a moment on Windows — a folder above all — is renamed a few milliseconds later.
 */
export function renameWithRetrySync(from: string, to: string, io: Pick<AtomicWriteIoSync, 'rename' | 'sleep'> = nodeIoSync): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.rename(from, to);
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryable(error)) throw error;
      io.sleep(delay);
    }
  }
}
