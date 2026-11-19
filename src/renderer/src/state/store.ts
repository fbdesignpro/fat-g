// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The window's mirror of main's app state. Read-only here: windows render snapshots and ask main
// to act. Zustand keeps React subscriptions cheap and lets non-React code read the state too.
import { create } from 'zustand';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { IpcErrorCode } from '@shared/ipc/result';
import { invoke, IpcError, subscribe } from '../ipc/client';

export interface AppStateView {
  /** The latest snapshot from main, or null until the first one arrives. */
  readonly snapshot: AppStateSnapshot | null;
  /** Why the initial fetch failed, if it did. Cleared by the next snapshot. */
  readonly error: IpcErrorCode | null;
}

export const useAppState = create<AppStateView>()(() => ({ snapshot: null, error: null }));

/** Applies a snapshot only if it is newer than the one held: fetches and pushes race. */
export function isNewer(current: AppStateSnapshot | null, incoming: AppStateSnapshot): boolean {
  return current === null || incoming.seq > current.seq;
}

function apply(incoming: AppStateSnapshot): void {
  useAppState.setState((state) => (isNewer(state.snapshot, incoming) ? { snapshot: incoming, error: null } : state));
}

/**
 * Starts mirroring main's state: subscribe FIRST, then fetch. Fetching first leaves a gap in which
 * a push can land before the listener exists and be lost; this order can only race, and isNewer()
 * settles races. The fetch also covers pushes sent before the page had loaded, which Electron drops.
 *
 * Called once per page, from its entry file. Returns the function that stops listening.
 */
export function connectAppState(): () => void {
  const unsubscribe = subscribe('state:snapshot', apply);
  invoke('state:getSnapshot', null).then(apply, (error: unknown) => {
    useAppState.setState({ error: error instanceof IpcError ? error.code : 'unavailable' });
  });
  return unsubscribe;
}
