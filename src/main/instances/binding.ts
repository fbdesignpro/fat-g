// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session and its account's folder (docs/planning/_archive/M14b.md, Design 8; C61, C62, C65). A provider's
// session lives in the configuration folder its CLI ran with, so a session's record stores that
// folder with its reference, and the session is held back when its instance has another folder now:
// the inherited variable changed between launches, or a stored folder was edited by hand. Started
// there, the CLI would not find the session, or would continue it as another account.
//
// Compared as two roots are (M12, C78): on the real paths when both answer, else on the stored
// paths under the OS's usual rules. Nothing here opens, lists or writes a folder (S6).
import { FIRST_INSTANCE_ID, type InstanceRef } from '@shared/contracts/instances';
import type { InstanceSupport } from '@shared/provider-kit/provider';
import type { Lookups } from '../records/lookup';
import { comparable, normalizeRoot } from '../records/paths';
import { type Environment, firstFolder } from './folders';

/** `unknown`: no comparison has answered yet, or the instance has no folder to compare with. */
export type Binding = 'bound' | 'moved' | 'unknown';

export interface InstanceFolderOptions {
  readonly platform: string;
  /** fat-g's own environment: where an inherited variable is read from, by name. */
  readonly env: Environment;
  readonly home: string;
  /** A provider's declaration, or none for a module that has one instance. */
  readonly support: (providerId: string) => InstanceSupport | undefined;
  /** An added instance's folder as the preferences hold it; null for one they do not hold. */
  readonly added: (ref: InstanceRef) => string | null;
}

/**
 * The configuration folder an instance has now, as a root is stored (C61): an added instance's own
 * folder, and for the first instance the one the inherited variable names, else the declared default.
 * Null for a provider that declares no instances, and for an instance that is not configured.
 */
export function instanceFolders(options: InstanceFolderOptions): (ref: InstanceRef) => string | null {
  const { platform, env, home } = options;
  return (ref) => {
    const support = options.support(ref.providerId);
    if (support === undefined) return null;
    if (ref.instanceId === FIRST_INSTANCE_ID) return firstFolder(support, env, home, platform);
    const folder = options.added(ref);
    return folder === null ? null : normalizeRoot(folder, platform);
  };
}

/** Whether two configuration folders are one folder: by real path, else as stored. */
export async function sameFolder(a: string, b: string, platform: string, lookups: Pick<Lookups, 'realpath'>): Promise<boolean> {
  if (a === b) return true;
  const [realA, realB] = await Promise.all([lookups.realpath(a), lookups.realpath(b)]);
  if (realA !== null && realB !== null) return realA === realB;
  return comparable(a, platform) === comparable(b, platform);
}

export interface FolderBindingOptions {
  readonly platform: string;
  readonly lookups: Pick<Lookups, 'realpath'>;
  /** The folder an instance has now (`instanceFolders`). */
  readonly folderOf: (ref: InstanceRef) => string | null;
}

export interface FolderBinding {
  /** The folder to store with a session's reference: the one its instance has now. */
  current(ref: InstanceRef): string | null;
  /**
   * Compares a session's stored folder with its instance's, now. What a change to a session awaits,
   * and what M15's gate asks before a start, a resume or a history read (C65). A session that stored
   * none is bound: it has no reference, and starts wherever its instance then points.
   */
  check(ref: InstanceRef, stored: string | null): Promise<Binding>;
  /** What the last comparison said, with nothing awaited: `unknown` until one has answered. */
  last(ref: InstanceRef, stored: string | null): Binding;
  /** Forgets every answer: the instances changed, or a link may lead elsewhere. */
  reset(): void;
}

export function createFolderBinding(options: FolderBindingOptions): FolderBinding {
  const { platform, lookups, folderOf } = options;
  const answers = new Map<string, Binding>();
  const pending = new Map<string, Promise<Binding>>();
  let generation = 0;

  // The instance is not part of the key: the two folders alone decide the answer.
  const key = (stored: string, current: string): string => `${stored}\n${current}`;

  return {
    current: folderOf,

    check(ref, stored) {
      if (stored === null) return Promise.resolve('bound');
      const current = folderOf(ref);
      // No folder to compare with: the instance is not configured, which holds its sessions by itself.
      if (current === null) return Promise.resolve('unknown');
      const id = key(stored, current);
      const running = pending.get(id);
      if (running !== undefined) return running;
      const asked = generation;
      const comparison = sameFolder(stored, current, platform, lookups).then((same): Binding => {
        const answer: Binding = same ? 'bound' : 'moved';
        if (asked === generation) answers.set(id, answer);
        return answer;
      });
      pending.set(id, comparison);
      void comparison.finally(() => {
        if (pending.get(id) === comparison) pending.delete(id);
      });
      return comparison;
    },

    last(ref, stored) {
      if (stored === null) return 'bound';
      const current = folderOf(ref);
      if (current === null) return 'unknown';
      if (stored === current) return 'bound';
      return answers.get(key(stored, current)) ?? 'unknown';
    },

    reset() {
      generation += 1;
      answers.clear();
      pending.clear();
    },
  };
}
