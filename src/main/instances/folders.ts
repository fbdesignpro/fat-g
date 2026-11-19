// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An account's folder (docs/planning/_archive/M14b.md, Design 5; C4, C15, C58, C61). A CLI keeps an account's
// login, settings and conversations in its configuration folder, so fat-g asks two things of one and
// no more (S6): its real path, and whether it is there. Both go through the lookups' limiter
// (src/main/records/lookup.ts); nothing here opens, lists or writes a folder.
//
// Folders are compared as two roots are (M12, C78): on the real paths the OS reports when both
// answer, else on the stored paths under the OS's usual rules.
import path from 'node:path';
import type { FolderRefusal } from '@shared/contracts/instances';
import type { RootRelation } from '@shared/contracts/projects';
import type { InstanceSupport } from '@shared/provider-kit/provider';
import type { Lookups } from '../records/lookup';
import { comparable, isAbsoluteRoot, normalizeRoot, relationOf, type Relation } from '../records/paths';

export type Environment = Readonly<Record<string, string | undefined>>;

const lib = (platform: string): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix);

/** The folder the inherited variable names, when it names an absolute one. Names fold on Windows, as in a child's environment. */
export function inheritedFolder(support: InstanceSupport, env: Environment, platform: string): string | null {
  const fold = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  const wanted = fold(support.variable);
  // The canonical spelling wins among duplicates, as the process layer's sanitizer has it.
  const name = Object.keys(env).sort().reverse().filter((key) => fold(key) === wanted).at(-1);
  const value = name === undefined ? undefined : env[name];
  return value !== undefined && isAbsoluteRoot(value, platform) ? normalizeRoot(value, platform) : null;
}

/** The CLI's documented default folder, under the home folder. */
export function defaultFolder(support: InstanceSupport, home: string, platform: string): string | null {
  return normalizeRoot(lib(platform).join(home, ...support.defaultFolder), platform);
}

/**
 * The folder the first instance runs in (C4, C61): the one the inherited variable names, else the
 * declared default. It is compared and stored with a session's reference; it is never set on a
 * child, since the first instance sets nothing.
 */
export function firstFolder(support: InstanceSupport, env: Environment, home: string, platform: string): string | null {
  return inheritedFolder(support, env, platform) ?? defaultFolder(support, home, platform);
}

/** What a folder is judged against. Every path is as stored; the comparison asks for the real ones. */
export interface FolderSurroundings {
  /** The other added instances of the same provider that name a folder. */
  readonly others: readonly { readonly key: string; readonly folder: string }[];
  readonly defaultFolder: string | null;
  readonly inheritedFolder: string | null;
  readonly projects: readonly { readonly id: string; readonly roots: readonly string[] }[];
  readonly dataFolder: string;
}

/**
 * The first rule of C15 that `folder` fails, or null. The first three ask whether it is that very
 * folder; a project's root and the data folder also refuse a folder inside or around them.
 */
export async function checkInstanceFolder(folder: string, surroundings: FolderSurroundings, platform: string, lookups: Lookups): Promise<FolderRefusal | null> {
  const stored = [
    folder,
    ...surroundings.others.map((other) => other.folder),
    ...[surroundings.defaultFolder, surroundings.inheritedFolder].filter((value): value is string => value !== null),
    ...surroundings.projects.flatMap((project) => project.roots),
    surroundings.dataFolder,
  ];
  const unique = [...new Set(stored)];
  const answers = await Promise.all(unique.map((entry) => lookups.realpath(entry)));
  const real = new Map(unique.map((entry, index) => [entry, answers[index] ?? null]));
  const sep = platform === 'win32' ? '\\' : '/';
  /** Where `folder` stands to `other`: the same folder, inside it, around it, or apart. */
  const stands = (other: string): Relation => {
    const realFolder = real.get(folder) ?? null;
    const realOther = real.get(other) ?? null;
    if (realFolder !== null && realOther !== null) return relationOf(realOther, realFolder, sep);
    return relationOf(comparable(other, platform), comparable(folder, platform), sep);
  };
  const overlap = (other: string): RootRelation | null => {
    const relation = stands(other);
    return relation === 'apart' ? null : relation;
  };

  const twin = surroundings.others.find((other) => stands(other.folder) === 'same');
  if (twin !== undefined) return { rule: 'other-instance', key: twin.key };
  if (surroundings.defaultFolder !== null && stands(surroundings.defaultFolder) === 'same') return { rule: 'default-folder' };
  if (surroundings.inheritedFolder !== null && stands(surroundings.inheritedFolder) === 'same') return { rule: 'inherited-folder' };
  for (const project of surroundings.projects) {
    for (const root of project.roots) {
      const relation = overlap(root);
      if (relation !== null) return { rule: 'project', projectId: project.id, relation };
    }
  }
  const relation = overlap(surroundings.dataFolder);
  return relation === null ? null : { rule: 'data-folder', relation };
}

/** Every added account's folder, by provider and key, of the providers that declare instances (C58). */
export function addedFolders(
  definitions: readonly { readonly descriptor: { readonly id: string }; readonly instances?: InstanceSupport }[],
  instances: Readonly<Record<string, { readonly added: readonly { readonly key: string; readonly folder: string | null }[] }>>,
): { providerId: string; key: string; folder: string }[] {
  return definitions.flatMap((definition) => {
    if (definition.instances === undefined) return [];
    const providerId = definition.descriptor.id;
    return (instances[providerId]?.added ?? []).flatMap((entry) => (entry.folder === null ? [] : [{ providerId, key: entry.key, folder: entry.folder }]));
  });
}
