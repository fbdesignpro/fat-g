// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, link, lstat, unlink, rename } from 'node:fs/promises';
import { rmSync, readdirSync, openSync, readSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataReset, DATA_RESET_FILE } from './data-reset';

const folders: string[] = [];
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'fatg-reset-'));
  folders.push(base);
  const folder = path.join(base, 'data');
  const outside = path.join(base, 'project');
  await mkdir(folder); await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'user project');
  return { folder, outside, reset: createDataReset(folder), marker: path.join(folder, DATA_RESET_FILE) };
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('full-data reset', () => {
  it('schedules durably without deleting anything, then consumes exactly once before startup', async () => {
    const f = await fixture();
    await writeFile(path.join(f.folder, 'preferences.json'), 'old preferences');
    await mkdir(path.join(f.folder, 'avatars')); await writeFile(path.join(f.folder, 'avatars', 'custom.png'), 'custom image');
    await mkdir(path.join(f.folder, 'unknown')); await writeFile(path.join(f.folder, 'unknown', 'backup'), 'old backup');
    expect(await f.reset.schedule()).toEqual({ status: 'scheduled' });
    expect(await readFile(path.join(f.folder, 'preferences.json'), 'utf8')).toBe('old preferences');
    expect(JSON.parse(await readFile(f.marker, 'utf8'))).toMatchObject({ schemaVersion: 1, minReaderVersion: 1, scope: 'all' });
    expect(createDataReset(f.folder).consume()).toBe('reset');
    expect(await readdir(f.folder)).toEqual([]);
    expect(await readFile(path.join(f.outside, 'keep.txt'), 'utf8')).toBe('user project');
    expect(createDataReset(f.folder).consume()).toBe('none');
  });
  it('does not enumerate or alter anything without a reset request', async () => {
    const f = await fixture();
    const enumerate = vi.fn((folder: string) => readdirSync(folder));
    expect(createDataReset(f.folder, { readdir: enumerate }).consume()).toBe('none');
    expect(enumerate).not.toHaveBeenCalled();
    expect(createDataReset(path.join(f.folder, 'missing')).consume()).toBe('none');
  });
  it('unlinks junctions/symlinks without following them and preserves live singleton entries', async () => {
    const f = await fixture();
    await symlink(f.outside, path.join(f.folder, 'avatars'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) await writeFile(path.join(f.folder, name), 'lock');
    await f.reset.schedule();
    expect(f.reset.consume()).toBe('reset');
    expect((await readdir(f.folder)).sort()).toEqual(['SingletonCookie', 'SingletonLock', 'SingletonSocket', 'lockfile']);
    expect(await readFile(path.join(f.outside, 'keep.txt'), 'utf8')).toBe('user project');
  });
  it.runIf(process.platform === 'win32')('preserves case-renamed pending requests until the last deletion', async () => {
    const f = await fixture();
    await f.reset.schedule();
    await rename(f.marker, path.join(f.folder, DATA_RESET_FILE.toUpperCase()));
    await writeFile(path.join(f.folder, 'LOCKFILE'), 'live lock');
    await writeFile(path.join(f.folder, 'old'), 'old data');
    expect(f.reset.consume()).toBe('reset');
    expect(await readdir(f.folder)).toEqual(['LOCKFILE']);
  });
  it.skipIf(process.platform === 'win32')('accepts native POSIX filenames containing a backslash', async () => {
    const f = await fixture();
    await writeFile(path.join(f.folder, 'custom\\name.wav'), 'sound');
    await f.reset.schedule();
    expect(f.reset.consume()).toBe('reset');
    expect(await readdir(f.folder)).toEqual([]);
  });
  it('refuses linked roots and linked requests before opening their contents', async () => {
    const f = await fixture();
    const linked = path.join(path.dirname(f.folder), 'linked');
    await symlink(f.folder, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await createDataReset(linked).info()).available).toBe(false);
    await f.reset.schedule();
    expect(createDataReset(linked).consume()).toBe('failed');
    await unlink(f.marker);
    await symlink(path.join(f.outside, 'keep.txt'), f.marker, process.platform === 'win32' ? 'file' : undefined);
    const opener = vi.fn(openSync);
    expect(createDataReset(f.folder, { open: opener }).consume()).toBe('failed');
    expect(opener).not.toHaveBeenCalled();
    expect(await readFile(path.join(f.outside, 'keep.txt'), 'utf8')).toBe('user project');
  });
  it.each(['not json', '{}', 'x'.repeat(4097), '{"schemaVersion":2,"minReaderVersion":2,"scope":"all"}', '{"schemaVersion":1,"minReaderVersion":1,"scope":"outside","id":"00000000-0000-0000-0000-000000000000"}'])('leaves invalid/incompatible requests and all data unchanged', async (text) => {
    const f = await fixture();
    await writeFile(f.marker, text); await writeFile(path.join(f.folder, 'keep'), 'unchanged');
    expect(f.reset.consume()).toBe('failed');
    expect(await f.reset.schedule()).toEqual({ status: 'failed' });
    expect(await readFile(f.marker, 'utf8')).toBe(text);
    expect(await readFile(path.join(f.folder, 'keep'), 'utf8')).toBe('unchanged');
  });
  it('preserves compatible future metadata when reusing an already scheduled request', async () => {
    const f = await fixture();
    await f.reset.schedule();
    const value: unknown = JSON.parse(await readFile(f.marker, 'utf8'));
    const original = JSON.stringify({ ...(value as Record<string, unknown>), schemaVersion: 2, minReaderVersion: 1, future: { keep: true } });
    await writeFile(f.marker, original);
    expect(await f.reset.schedule()).toEqual({ status: 'scheduled' });
    expect(await readFile(f.marker, 'utf8')).toBe(original);
    expect(f.reset.consume()).toBe('reset');
  });
  it('refuses hard-linked request files and removes an incomplete request after a flush failure', async () => {
    const f = await fixture();
    await f.reset.schedule();
    await link(f.marker, path.join(f.outside, 'request-copy'));
    expect(f.reset.consume()).toBe('failed');
    expect(await readFile(f.marker, 'utf8')).toBe(await readFile(path.join(f.outside, 'request-copy'), 'utf8'));
    const g = await fixture();
    await writeFile(path.join(g.folder, 'keep'), 'existing data');
    expect(await createDataReset(g.folder, { sync: () => { throw new Error('flush failed'); } }).schedule()).toEqual({ status: 'failed' });
    expect(await readdir(g.folder)).toEqual(['keep']);
  });
  it('retains its marker after partial failure and safely resumes next launch', async () => {
    const f = await fixture();
    await writeFile(path.join(f.folder, 'preferences.json'), 'old');
    await mkdir(path.join(f.folder, 'plans')); await writeFile(path.join(f.folder, 'plans', 'text'), 'plan');
    await f.reset.schedule();
    let removed = 0;
    const remove = (file: string): void => { if (++removed === 2) throw Object.assign(new Error(), { code: 'EBUSY' }); unlinkSync(file); };
    expect(createDataReset(f.folder, { unlink: remove }).consume()).toBe('failed');
    expect(await lstat(f.marker)).toBeTruthy();
    expect(removed).toBe(2);
    expect(createDataReset(f.folder).consume()).toBe('reset');
    expect(await readdir(f.folder)).toEqual([]);
  });
  it('overwrites conversation databases before unlink, without modifying hard-linked outside copies', async () => {
    const f = await fixture();
    const database = path.join(f.folder, 'conversations.sqlite');
    await writeFile(database, 'private conversation');
    const held = openSync(database, 'r');
    await f.reset.schedule();
    const captured: Buffer[] = [];
    const remove = (file: string): void => {
      if (file === database) { const buf = Buffer.alloc(20); readSync(held, buf, 0, 20, 0); captured.push(buf); closeSync(held); }
      unlinkSync(file);
    };
    expect(createDataReset(f.folder, { unlink: remove }).consume()).toBe('reset');
    expect(captured[0]).toEqual(Buffer.alloc(20));
    const g = await fixture();
    await link(path.join(g.outside, 'keep.txt'), path.join(g.folder, 'conversations.sqlite'));
    await g.reset.schedule();
    expect(g.reset.consume()).toBe('reset');
    expect(await readFile(path.join(g.outside, 'keep.txt'), 'utf8')).toBe('user project');
  });
  it('refuses a directory whose real path escapes the admitted root', async () => {
    const f = await fixture();
    const nested = path.join(f.folder, 'nested'); await mkdir(nested); await writeFile(path.join(nested, 'keep'), 'old');
    await f.reset.schedule();
    const resolve = (file: string) => file === nested ? f.outside : realpathSync(file);
    expect(createDataReset(f.folder, { realpath: resolve }).consume()).toBe('failed');
    expect(await readFile(path.join(nested, 'keep'), 'utf8')).toBe('old');
    expect(await lstat(f.marker)).toBeTruthy();
  });
  it('refuses filesystem roots and handles write failure without arming a reset', async () => {
    expect((await createDataReset(path.parse(process.cwd()).root).info()).available).toBe(false);
    const f = await fixture();
    const fail = vi.fn(() => { throw Object.assign(new Error(), { code: 'EACCES' }); });
    expect(await createDataReset(f.folder, { open: fail }).schedule()).toEqual({ status: 'failed' });
    expect(await readdir(f.folder)).toEqual([]);
  });
});
