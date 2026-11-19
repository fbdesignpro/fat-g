// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { VersionedInstallDirectory } from '@shared/provider-kit/process';

export interface InstallChild { readonly name: string; readonly modifiedAt: number }
export const MAX_INSTALL_ENTRIES = 128;

export function isInstallChild(name: string, kind: VersionedInstallDirectory['children']): boolean {
  return kind === 'version' ? /^\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(name) : /^[a-f0-9]{8,64}$/i.test(name);
}

/** Metadata alone, one declared runtime directory, no recursion or directory links. */
export async function readInstallChildren(root: string, kind: VersionedInstallDirectory['children']): Promise<InstallChild[]> {
  if (!(await lstat(root)).isDirectory()) return [];
  const children: InstallChild[] = [];
  let count = 0;
  for await (const entry of await opendir(root)) {
    if (++count > MAX_INSTALL_ENTRIES) throw new Error('installation-directory-limit');
    if (!entry.isDirectory() || !isInstallChild(entry.name, kind)) continue;
    try {
      const info = await lstat(path.join(root, entry.name));
      if (info.isDirectory()) children.push({ name: entry.name, modifiedAt: info.mtimeMs });
    } catch (error) {
      // An updater can remove a version between enumeration and stat. Other failures are unknown.
      if (typeof error !== 'object' || error === null || !('code' in error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    }
  }
  return children;
}

export function newestInstallChild(kind: VersionedInstallDirectory['children']): (a: InstallChild, b: InstallChild) => number {
  return (a, b) => {
    if (kind === 'version') {
      const left = a.name.split('.').map(Number);
      const right = b.name.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        const difference = right[i]! - left[i]!;
        if (difference !== 0) return difference;
      }
    } else if (a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
}
