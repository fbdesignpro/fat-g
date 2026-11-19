// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Make a copy (decision 0031): only a scanned built-in family, into a new user family. Source
// folders, files and image headers are checked again; no links or unrelated files are copied.
// The destination name is chosen here, never by the page, and reserved without overwriting anything.
import path from 'node:path';
import { AVATAR_NAME_MAX, AVATAR_SCAN_LIMIT, type FamilyRef, LICENSE_FILE, MANIFEST_FILE, MANIFEST_MAX_BYTES } from '@shared/contracts/avatars';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import { readImageHeader } from '../images/headers';
import { errorCode } from '../storage/json-file';
import { seededManifest } from './authoring';
import type { AvatarFs } from './fs';
import { parseManifest } from './manifest';
import type { ScannedFamily, ScannedRoot } from './scan';

type CopyResult = { readonly kind: 'copied'; readonly ref: FamilyRef } | { readonly kind: 'unavailable' | 'failed' };
interface CopyFile { readonly parts: readonly string[]; readonly bytes: Uint8Array }
const MAX_COPY_BYTES = 64 * 1024 * 1024;

/** No component is a path, and a folder or file swapped for a link cannot pass its real-path check. */
export async function checked(root: string, parts: readonly string[], kind: 'folder' | 'file', fs: AvatarFs): Promise<string> {
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))) throw new Error('invalid component');
  const target = path.join(root, ...parts);
  if ((await fs.lstat(target)).kind !== kind || path.relative(target, await fs.realpath(target)) !== '') throw new Error('changed path');
  return target;
}

async function readFile(root: string, parts: readonly string[], bound: number, fs: AvatarFs): Promise<Uint8Array> {
  const file = await checked(root, parts, 'file', fs);
  const bytes = await fs.readWhole(file, bound);
  if (bytes === null) throw new Error('file too large');
  return bytes;
}

export async function copyFamily(root: ScannedRoot, family: ScannedFamily, userRoot: string, fs: AvatarFs): Promise<CopyResult> {
  if (root.origin !== 'built-in' || root.realRoot === null || root.problems.length > 0 || family.problems.length > 0 || family.avatars.some((avatar) => avatar.problems.length > 0)) return { kind: 'unavailable' };
  let destination: string | null = null;
  try {
    const source = await checked(root.realRoot, [family.folder], 'folder', fs);
    const files: CopyFile[] = [];
    // Preserve the manifest's bytes, including unknown fields, and the licence where present.
    try {
      const bytes = await readFile(source, [MANIFEST_FILE], MANIFEST_MAX_BYTES, fs);
      if (parseManifest(bytes).kind !== 'applied') return { kind: 'unavailable' };
      files.push({ parts: [MANIFEST_FILE], bytes });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      files.push({ parts: [MANIFEST_FILE], bytes: new TextEncoder().encode(seededManifest(family.avatars.map((avatar) => avatar.folder))) });
    }
    try { files.push({ parts: [LICENSE_FILE], bytes: await readFile(source, [LICENSE_FILE], MANIFEST_MAX_BYTES, fs) }); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    let total = 0;
    for (const avatar of family.avatars) {
      const folder = await checked(source, [avatar.folder], 'folder', fs);
      for (const file of avatar.files) {
        const name = path.basename(file.path);
        const bytes = await readFile(folder, [name], MAX_IMAGE_BYTES, fs);
        const header = readImageHeader(bytes, true);
        if (bytes.byteLength !== file.bytes || header.kind !== 'image' || header.mediaType !== file.mediaType || header.width !== file.width || header.height !== file.height || header.animation !== 'still') throw new Error('changed image');
        total += bytes.byteLength;
        if (total > MAX_COPY_BYTES) throw new Error('family too large');
        files.push({ parts: [avatar.folder, name], bytes });
      }
    }
    try { await fs.lstat(userRoot); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; await fs.createFolder(userRoot); }
    if ((await fs.lstat(userRoot)).kind !== 'folder') throw new Error('linked user root');
    const targetRoot = await fs.realpath(userRoot);
    const occupied = new Set((await fs.list(targetRoot)).map((entry) => entry.name.toLowerCase()));
    for (let number = 1; number <= AVATAR_SCAN_LIMIT; number += 1) {
      const suffix = number === 1 ? '' : ` (${number})`;
      const name = `Copy of ${family.folder}`.slice(0, AVATAR_NAME_MAX - suffix.length) + suffix;
      if (occupied.has(name.toLowerCase())) continue;
      const candidate = path.join(targetRoot, name);
      if (!await fs.createExclusiveFolder(candidate)) continue;
      destination = candidate;
      const made = new Set<string>();
      for (const file of files) {
        await checked(targetRoot, [name], 'folder', fs);
        const folder = file.parts.length === 2 ? file.parts[0] : undefined;
        if (folder !== undefined) {
          if (!made.has(folder)) {
            if (!await fs.createExclusiveFolder(path.join(destination, folder))) throw new Error('copy folder exists');
            made.add(folder);
          }
          await checked(destination, [folder], 'folder', fs);
        }
        await fs.writeNewFile(path.join(destination, ...file.parts), file.bytes);
      }
      return { kind: 'copied', ref: { origin: 'user', family: name } };
    }
    return { kind: 'failed' };
  } catch {
    if (destination !== null) {
      try {
        // Delete only the directory this call reserved, still at the same real location.
        await checked(path.dirname(destination), [path.basename(destination)], 'folder', fs);
        await fs.removeCopy(destination);
      } catch { /* A changed or inaccessible directory is left alone. */ }
    }
    return { kind: 'failed' };
  }
}
