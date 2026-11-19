// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A new family from a prepared image (decision 0036). Reserve a user folder exclusively,
// write its Default and optional matched avatar, then its manifest. On failure remove only
// that reserved folder, checked again for links. Image decoding stays in the renderer.
import path from 'node:path';
import { ADDED_PORTRAIT_SIDE, ADDED_SMALL_SIDE, CreateFamilyRequestSchema, type CreateFamilyAnswer, type CreateFamilyRequest } from '@shared/contracts/avatar-family';
import { MANIFEST_FILE, type FamilyRef } from '@shared/contracts/avatars';
import { errorCode } from '../storage/json-file';
import { stillPng } from './added-images';
import { seededManifest } from './authoring';
import { checked } from './copy-family';
import type { AvatarFs } from './fs';

type CreateResult = { readonly kind: 'created'; readonly ref: FamilyRef }
  | Exclude<CreateFamilyAnswer, { readonly kind: 'created' }>;

export async function createFamily(userRoot: string, fs: AvatarFs, request: CreateFamilyRequest): Promise<CreateResult> {
  if (!CreateFamilyRequestSchema.safeParse(request).success
    || !stillPng(request.portrait, ADDED_SMALL_SIDE, ADDED_PORTRAIT_SIDE)
    || !stillPng(request.small, ADDED_SMALL_SIDE, ADDED_SMALL_SIDE)) return { kind: 'invalid' };
  let destination: string | null = null;
  try {
    try { await fs.lstat(userRoot); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; await fs.createFolder(userRoot); }
    if ((await fs.lstat(userRoot)).kind !== 'folder') return { kind: 'unavailable' };
    const root = await fs.realpath(userRoot);
    if ((await fs.list(root)).some((entry) => entry.name.toLowerCase() === request.name.toLowerCase())) return { kind: 'taken' };
    const candidate = path.join(root, request.name);
    if (!await fs.createExclusiveFolder(candidate)) return { kind: 'taken' };
    destination = candidate;
    const folders = request.avatar === null ? ['Default'] : ['Default', request.avatar.name];
    for (const folder of folders) {
      await checked(root, [request.name], 'folder', fs);
      if (!await fs.createExclusiveFolder(path.join(destination, folder))) throw new Error('avatar folder exists');
      const target = await checked(destination, [folder], 'folder', fs);
      await fs.writeNewFile(path.join(target, 'portrait.png'), request.portrait);
      await fs.writeNewFile(path.join(target, 'small.png'), request.small);
    }
    const manifest = JSON.parse(seededManifest(folders)) as Record<string, unknown>;
    manifest['avatars'] = request.avatar === null ? [] : [{ folder: request.avatar.name, matches: request.avatar.matches }];
    await checked(root, [request.name], 'folder', fs);
    await fs.writeNewFile(path.join(destination, MANIFEST_FILE), new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    return { kind: 'created', ref: { origin: 'user', family: request.name } };
  } catch {
    if (destination !== null) {
      try {
        await checked(path.dirname(destination), [path.basename(destination)], 'folder', fs);
        await fs.removeCopy(destination);
      } catch { /* Leave a changed or inaccessible directory alone. */ }
    }
    return { kind: 'failed' };
  }
}
