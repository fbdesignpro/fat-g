// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where a path stands to the folders that decide a read (docs/planning/_archive/M19b.md, Design 7; C26–C28,
// C51; decision 0022). Pure: paths are compared as stored paths are (M12, C78), with the platform a
// parameter, and nothing here asks the file system anything.
//
// A read is confined twice by the reader. Here are the two comparisons both use: inside a trusted
// root, and inside none of the folders fat-g never reads — each provider's configuration folder,
// each added account's, and fat-g's own data folder (decisions 0004, 0017). An image is confined by
// the second and by this machine's own disks instead of a root (decision 0022, item 15).
import path from 'node:path';
import type { InstanceSupport } from '@shared/provider-kit/provider';
import { addedFolders, defaultFolder, type Environment, inheritedFolder } from '../instances/folders';
import { comparable, isAbsoluteRoot, relationOf } from '../records/paths';

export const pathLib = (platform: string): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix);

/**
 * Whether a path names this machine's own disks (decision 0022, item 15): absolute, and no share's or
 * device's — `\\server\share`, `\\?\…` or `\\.\…` on Windows, `//host/…` elsewhere — so that a read
 * of an image outside the project's folders reaches no other machine.
 */
export function isLocalPath(candidate: string, platform: string): boolean {
  return isAbsoluteRoot(candidate, platform) && !(platform === 'win32' ? /^[\\/]{2}/ : /^\/\//).test(candidate);
}

/** Whether `candidate` is `folder` itself or lies inside it. Both are absolute and resolved. */
export function within(folder: string, candidate: string, platform: string): boolean {
  const relation = relationOf(comparable(folder, platform), comparable(candidate, platform), platform === 'win32' ? '\\' : '/');
  return relation === 'same' || relation === 'inside';
}

/** The first of `roots` that holds `candidate`, or null. */
export function admittingRoot(candidate: string, roots: readonly string[], platform: string): string | null {
  return roots.find((root) => within(root, candidate, platform)) ?? null;
}

/** Whether `candidate` lies inside any of `folders`. */
export function insideAny(candidate: string, folders: readonly string[], platform: string): boolean {
  return folders.some((folder) => within(folder, candidate, platform));
}

export interface RefusedFolderSources {
  readonly definitions: readonly { readonly descriptor: { readonly id: string }; readonly instances?: InstanceSupport }[];
  /** The preferences' instances, read at each call: an account can be added during the run. */
  readonly instances: Readonly<Record<string, { readonly added: readonly { readonly key: string; readonly folder: string | null }[] }>>;
  readonly env: Environment;
  readonly home: string;
  readonly dataFolder: string;
  readonly platform: string;
}

/**
 * The folders no read may enter, whichever root holds them (C28): each registered provider's
 * default configuration folder and the one its variable names, each added account's, and fat-g's
 * data folder. Under a root that is the home folder these alone are refused (C51).
 */
export function refusedFolders({ definitions, instances, env, home, dataFolder, platform }: RefusedFolderSources): string[] {
  const providers = definitions.flatMap((definition) => (definition.instances === undefined
    ? []
    : [defaultFolder(definition.instances, home, platform), inheritedFolder(definition.instances, env, platform)]));
  const all = [...providers, ...addedFolders(definitions, instances).map((entry) => entry.folder), dataFolder];
  return [...new Set(all.filter((folder): folder is string => folder !== null && folder !== ''))];
}
