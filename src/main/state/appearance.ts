// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The saved appearance, carried into the app state so that both windows follow it — the Pet
// included, which may not read preferences. A read-only or unavailable preferences file gives
// default values (src/main/prefs/compatibility.ts), so the windows are then light (C10).
import type { PreferencesStore } from '../prefs/store';
import type { AppStateStore } from './app-state-store';

/** Starts following; returns the function that stops. */
export function followAppearance(prefs: PreferencesStore, store: AppStateStore): () => void {
  const apply = (): void => {
    const { theme, flash } = prefs.getSnapshot().values.appearance;
    store.setAppearance({ theme, flash });
  };
  apply();
  return prefs.subscribe(apply);
}

/**
 * The size the Pet draws its capsules at, carried into the app state for the Pet's view
 * (src/main/state/pet-view.ts). Only a change of the saved value counts: the Pet's own toggle sets
 * the app state's at once as well (`pet:setSize`), so a read-only file, which keeps the saved value,
 * still lets the Pet change size for this run.
 */
export function followPetSize(prefs: PreferencesStore, store: AppStateStore): () => void {
  let saved = prefs.getSnapshot().values.windows.pet.size;
  store.setPetSize(saved);
  return prefs.subscribe((snapshot) => {
    const next = snapshot.values.windows.pet.size;
    if (next === saved) return;
    saved = next;
    store.setPetSize(next);
  });
}
