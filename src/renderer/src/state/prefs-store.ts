// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Main window's mirror of the preferences main holds. Changes go the other way as a patch;
// the answer (and the push that follows it) is what updates this store, so the window never
// guesses what was saved — clamping, for one, can change it.
import { create } from 'zustand';
import type { PreferencesPatch, PreferencesSnapshot } from '@shared/contracts/prefs';
import type { IpcErrorCode } from '@shared/ipc/result';
import { invoke, IpcError, subscribe } from '../ipc/client';

export interface PreferencesView {
  /** The latest snapshot from main, or null until the first one arrives. */
  readonly snapshot: PreferencesSnapshot | null;
  /** Why the last read or write failed, if it did. Cleared by the next snapshot. */
  readonly error: IpcErrorCode | null;
  /** True while a change is on its way to main. */
  readonly saving: boolean;
}

export const usePrefs = create<PreferencesView>()(() => ({ snapshot: null, error: null, saving: false }));

/** `rev` plays the part `seq` plays for app state: a fetch and a push can arrive in either order. */
export function isNewerPrefs(current: PreferencesSnapshot | null, incoming: PreferencesSnapshot): boolean {
  return current === null || incoming.rev > current.rev;
}

function apply(incoming: PreferencesSnapshot): void {
  usePrefs.setState((state) => (isNewerPrefs(state.snapshot, incoming) ? { snapshot: incoming, error: null } : state));
}

function fail(error: unknown): void {
  usePrefs.setState({ error: error instanceof IpcError ? error.code : 'unavailable' });
}

/** Subscribe first, then fetch — see the app-state store for why. Called once, by the entry file. */
export function connectPrefs(): () => void {
  const unsubscribe = subscribe('prefs:changed', apply);
  invoke('prefs:get', null).then(apply, fail);
  return unsubscribe;
}

/**
 * Asks main to change something. The result is applied here, so what the screen shows is what was
 * actually saved: a patch of `5` comes back as the clamped `60`, and a read-only file comes back
 * unchanged.
 *
 * Resolves with `session-running` when main refused the whole patch because it would end the
 * runtime of a running session (M15, C18): the caller says so where the change was asked.
 */
export async function patchPrefs(patch: PreferencesPatch): Promise<'session-running' | null> {
  usePrefs.setState({ saving: true });
  try {
    const answer = await invoke('prefs:patch', patch);
    apply(answer);
    return answer.refused ?? null;
  } catch (error) {
    fail(error);
    return null;
  } finally {
    usePrefs.setState({ saving: false });
  }
}
