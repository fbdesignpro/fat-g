// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_INSTALL_ENTRIES, readInstallChildren } from './install-children';

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fatg-install-children-'));
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('bounded runtime folder metadata', () => {
  it('reads matching immediate directories only, never files, nested directories or links', async () => {
    const root = await temporary();
    await mkdir(path.join(root, '2.1.100'));
    await mkdir(path.join(root, 'logs', '2.1.101'), { recursive: true });
    await mkdir(path.join(root, '2.1.102.tmp'));
    await writeFile(path.join(root, '2.1.103'), 'not a directory');
    await symlink(path.join(root, 'logs'), path.join(root, '2.1.104'), process.platform === 'win32' ? 'junction' : 'dir');
    const versions = await readInstallChildren(root, 'version');
    expect(versions.map(({ name }) => name)).toEqual(['2.1.100']);
    expect(versions.every(({ modifiedAt }) => Number.isFinite(modifiedAt))).toBe(true);
    expect(await readInstallChildren(path.join(root, '2.1.104'), 'version')).toEqual([]);
    await mkdir(path.join(root, 'abcdef0123456789'));
    expect((await readInstallChildren(root, 'hash')).map(({ name }) => name)).toEqual(['abcdef0123456789']);
  });
  it('bounds all directory entries, including unrelated files, and closes the handle on refusal', async () => {
    const root = await temporary();
    for (let i = 0; i <= MAX_INSTALL_ENTRIES; i++) await writeFile(path.join(root, `entry-${i}`), '');
    await expect(readInstallChildren(root, 'hash')).rejects.toThrow('installation-directory-limit');
    await rm(root, { recursive: true });
  });
});
