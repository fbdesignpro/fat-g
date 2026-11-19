// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AtomicWriteIo,
  type AtomicWriteIoSync,
  nodeIo,
  nodeIoSync,
  RETRY_DELAYS_MS,
  writeFileAtomic,
  writeFileAtomicSync,
} from './atomic-write';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-atomic-'));
  file = path.join(dir, 'preferences.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
const ok = (): Promise<void> => Promise.resolve();

/**
 * A working fake; each test breaks the part it cares about. The mocks come back as plain values so
 * assertions never reach through the object, which would be an unbound method reference.
 */
function fakeIo(behaviour: { writeAndSync?: AtomicWriteIo['writeAndSync']; rename?: AtomicWriteIo['rename'] } = {}) {
  const writeAndSync = vi.fn(behaviour.writeAndSync ?? ok);
  const rename = vi.fn(behaviour.rename ?? ok);
  const remove = vi.fn(ok);
  const sleep = vi.fn(ok);
  const io: AtomicWriteIo = { writeAndSync, rename, remove, sleep };
  return { io, writeAndSync, rename, remove, sleep };
}

describe('writeFileAtomic (real file system)', () => {
  it('creates the file', async () => {
    await writeFileAtomic(file, '{"hello":true}');
    expect(readFileSync(file, 'utf8')).toBe('{"hello":true}');
  });

  it('replaces an existing file', async () => {
    writeFileSync(file, 'old');
    await writeFileAtomic(file, 'new');
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  it('leaves no temp file behind', async () => {
    await writeFileAtomic(file, 'x');
    expect(readdirSync(dir)).toEqual(['preferences.json']);
  });

  it('survives a leftover temp file from a previous crash', async () => {
    writeFileSync(`${file}.tmp`, 'junk from a crash');
    await writeFileAtomic(file, 'fresh');
    expect(readFileSync(file, 'utf8')).toBe('fresh');
    expect(readdirSync(dir)).toEqual(['preferences.json']);
  });

  it('writes through the node implementation with fsync', async () => {
    await nodeIo.writeAndSync(file, 'synced');
    expect(readFileSync(file, 'utf8')).toBe('synced');
  });
});

describe('writeFileAtomic (retries)', () => {
  it('retries a rename the platform briefly refuses, then succeeds', async () => {
    let attempts = 0;
    const { io, sleep, remove } = fakeIo({
      rename: () => {
        attempts += 1;
        return attempts < 3 ? Promise.reject(errno('EPERM')) : ok();
      },
    });

    await writeFileAtomic(file, 'x', io);

    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, RETRY_DELAYS_MS[0]);
    expect(sleep).toHaveBeenNthCalledWith(2, RETRY_DELAYS_MS[1]);
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries %s', async (code) => {
    let attempts = 0;
    const { io } = fakeIo({
      rename: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(errno(code)) : ok();
      },
    });

    await writeFileAtomic(file, 'x', io);
    expect(attempts).toBe(2);
  });

  it('gives up after the last delay and cleans the temp file away', async () => {
    const { io, rename, remove } = fakeIo({ rename: () => Promise.reject(errno('EPERM')) });

    await expect(writeFileAtomic(file, 'x', io)).rejects.toThrow('EPERM');
    expect(rename).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(remove).toHaveBeenCalledWith(`${file}.tmp`);
  });

  it('does not retry an error that will not fix itself', async () => {
    const { io, rename, sleep, remove } = fakeIo({ rename: () => Promise.reject(errno('ENOSPC')) });

    await expect(writeFileAtomic(file, 'x', io)).rejects.toThrow('ENOSPC');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('does not swallow a failure to write the temp file', async () => {
    const { io, rename } = fakeIo({ writeAndSync: () => Promise.reject(errno('ENOSPC')) });

    await expect(writeFileAtomic(file, 'x', io)).rejects.toThrow('ENOSPC');
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('writeFileAtomicSync (what runs on quit)', () => {
  it('matches the async version on the real file system', () => {
    writeFileSync(file, 'old');
    writeFileAtomicSync(file, 'saved on quit');
    expect(readFileSync(file, 'utf8')).toBe('saved on quit');
    expect(readdirSync(dir)).toEqual(['preferences.json']);
  });

  it('creates the file through the node implementation with fsync', () => {
    const nested = path.join(dir, 'nested');
    mkdirSync(nested);
    nodeIoSync.writeAndSync(path.join(nested, 'f'), 'synced');
    expect(readFileSync(path.join(nested, 'f'), 'utf8')).toBe('synced');
  });

  it('retries, then gives up and cleans up', () => {
    const rename = vi.fn(() => {
      throw errno('EBUSY');
    });
    const remove = vi.fn();
    const sleep = vi.fn();
    const io: AtomicWriteIoSync = { writeAndSync: vi.fn(), rename, remove, sleep };

    expect(() => writeFileAtomicSync(file, 'x', io)).toThrow('EBUSY');
    expect(rename).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(sleep).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length);
    expect(remove).toHaveBeenCalledWith(`${file}.tmp`);
  });

  it('blocks rather than awaiting, since there is no event loop left', () => {
    const started = Date.now();
    nodeIoSync.sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
