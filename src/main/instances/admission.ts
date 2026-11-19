// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What an added instance must pass each time its runtime starts (docs/planning/_archive/M14b.md, Design 5;
// C37, C59, C72), and what a picked folder must pass before it is stored (C15). One gathering of
// what a folder is judged against serves both, so a start checks exactly what the picker did.
//
// The relation between an account's folder and a project, the data folder or the first instance's
// folder can be made after both sides were accepted: by a hand-edited file, by a link that now
// leads elsewhere, or by a launch whose inherited variable names the folder. So it is checked again
// at each start, and an instance that fails launches nothing.
import type { FolderRefusal, InstanceEntry } from '@shared/contracts/instances';
import type { InstanceSupport } from '@shared/provider-kit/provider';
import type { Lookups } from '../records/lookup';
import { checkInstanceFolder, defaultFolder, inheritedFolder, type Environment, type FolderSurroundings } from './folders';

/** Whether an added instance may start, as far as its folder goes. */
export type InstanceStart =
  | { readonly kind: 'admitted' }
  /** The folder is gone, or is not a folder (C37). Remove is the remedy. */
  | { readonly kind: 'folder-missing' }
  /** The check did not answer (C72): nothing is known, so nothing is launched, and it can be tried again. */
  | { readonly kind: 'folder-unchecked' }
  /** A rule of C15 fails (C59). Remove is the remedy. */
  | { readonly kind: 'folder-refused'; readonly refusal: FolderRefusal };

/**
 * The folder's own state first, then the rules. A folder that is gone is said to be gone, whatever
 * else is true of its path.
 */
export async function admitInstance(folder: string, surroundings: FolderSurroundings, platform: string, lookups: Lookups): Promise<InstanceStart> {
  const state = await lookups.folder(folder);
  if (state === 'missing') return { kind: 'folder-missing' };
  if (state === 'no-answer') return { kind: 'folder-unchecked' };
  const refusal = await checkInstanceFolder(folder, surroundings, platform, lookups);
  return refusal === null ? { kind: 'admitted' } : { kind: 'folder-refused', refusal };
}

export interface InstanceGuardOptions {
  readonly platform: string;
  readonly lookups: Lookups;
  /** fat-g's own environment: where an inherited variable is read from, by name. */
  readonly env: Environment;
  readonly home: string;
  /** fat-g's data folder. */
  readonly dataFolder: string;
  /** A provider's declaration, or none for a module that has one instance. */
  readonly support: (providerId: string) => InstanceSupport | undefined;
  /** The provider's added instances as the preferences hold them, in stored order. */
  readonly instances: (providerId: string) => readonly InstanceEntry[];
  /** Every project's roots, hidden projects included. */
  readonly projects: () => readonly { readonly id: string; readonly roots: readonly string[] }[];
}

export interface InstanceGuard {
  /**
   * A folder picked for a new account of the provider (C15): judged against every added instance
   * of it. Null when it passes, and for a provider that declares no instances.
   */
  checkPicked(providerId: string, folder: string): Promise<FolderRefusal | null>;
  /**
   * An added instance about to start (C59), by its key. It is judged against the instances stored
   * before it, so of two entries that name one folder the earlier one runs and the later is refused,
   * as with a repeated id or label (C66).
   */
  admit(providerId: string, key: string): Promise<InstanceStart>;
}

export function createInstanceGuard(options: InstanceGuardOptions): InstanceGuard {
  const { platform, lookups, env, home, dataFolder } = options;
  const surroundings = (support: InstanceSupport, others: readonly InstanceEntry[]): FolderSurroundings => ({
    others: others.flatMap((entry) => (entry.folder === null ? [] : [{ key: entry.key, folder: entry.folder }])),
    defaultFolder: defaultFolder(support, home, platform),
    inheritedFolder: inheritedFolder(support, env, platform),
    projects: options.projects(),
    dataFolder,
  });
  return {
    async checkPicked(providerId, folder) {
      const support = options.support(providerId);
      if (support === undefined) return null;
      return checkInstanceFolder(folder, surroundings(support, options.instances(providerId)), platform, lookups);
    },
    async admit(providerId, key) {
      const support = options.support(providerId);
      const entries = options.instances(providerId);
      const index = entries.findIndex((entry) => entry.key === key);
      const folder = entries[index]?.folder ?? null;
      // No declaration, no such entry or no folder: the preferences' own admission has already
      // blocked it, and there is no folder to launch with.
      if (support === undefined || folder === null) return { kind: 'folder-missing' };
      return admitInstance(folder, surroundings(support, entries.slice(0, index)), platform, lookups);
    },
  };
}
