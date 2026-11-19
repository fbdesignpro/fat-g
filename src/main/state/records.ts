// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The records, carried into the app state for the Main window (M12, C52): the store's view, with
// each root's missing mark joined in from the root check. As followAppearance does for the theme.
//
// The roots are checked at start, after each change, and when the project dialog asks — always on a
// later turn, after the request that caused it has answered (C29).
import type { ProjectEntryView, RecordsState } from '@shared/contracts/projects';
import type { Lookups } from '../records/lookup';
import { createRootCheck, type RootCheck } from '../records/root-check';
import type { RecordsStore, RecordsView } from '../records/store';
import type { AppStateStore } from './app-state-store';

export interface RecordsFollower {
  /** Checks these roots on a later turn. */
  checkRoots(roots: readonly string[]): void;
  /** Whether a root was found missing at its last check (M15, C30): what the gate reads. */
  isMissing(root: string): boolean;
  /** Told when a root's missing mark changes (M15, C126). Returns the function that stops it. */
  onMissingChanged(listener: () => void): () => void;
  stop(): void;
}

export interface FollowRecordsOptions {
  readonly records: RecordsStore;
  readonly store: AppStateStore;
  readonly lookups: Lookups;
  /** When a check runs: on a later turn, by default. */
  readonly later?: (run: () => void) => void;
}

export function followRecords({ records, store, lookups, later = (run) => setTimeout(run, 0) }: FollowRecordsOptions): RecordsFollower {
  const apply = (): void => store.setRecords(recordsState(records.getView(), check));
  const listeners = new Set<() => void>();
  const check: RootCheck = createRootCheck(lookups, () => {
    apply();
    for (const listener of [...listeners]) listener();
  });
  const checkRoots = (roots: readonly string[]): void => {
    later(() => void check.check(roots));
  };

  apply();
  checkRoots(records.allRoots());
  const unsubscribe = records.subscribe(() => {
    apply();
    checkRoots(records.allRoots());
  });
  return {
    checkRoots,
    isMissing: (root) => check.isMissing(root),
    onMissingChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: unsubscribe,
  };
}

export function recordsState(view: RecordsView, check: Pick<RootCheck, 'isMissing'>): RecordsState {
  return {
    status: view.status,
    projects: view.projects.map((entry): ProjectEntryView =>
      entry.kind === 'unreadable' ? entry : { ...entry, roots: entry.roots.map((root) => ({ ...root, missing: check.isMissing(root.path) })) },
    ),
  };
}
