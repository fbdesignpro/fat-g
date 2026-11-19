// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { PreferencesStore } from '../../prefs/store';
import type { InvokeHandlers } from '../dispatch';
import { patchReachesRunning, type ReachesRunning } from './guards';

export function prefsHandlers(store: PreferencesStore, reachesRunning: ReachesRunning = () => false): Pick<InvokeHandlers, 'prefs:get' | 'prefs:patch' | 'prefs:startFresh' | 'prefs:retry'> {
  return {
    'prefs:get': () => store.getSnapshot(),
    // A patch against a read-only file is refused by the store, which answers with the unchanged
    // snapshot; the settings screen reads `status` and disables its controls rather than guessing.
    'prefs:patch': (patch) => {
      // A switch or an executable that would end the runtime of a running session (M15, C18): the
      // patch is refused whole, and the answer says why.
      if (patchReachesRunning(patch, store.getSnapshot(), reachesRunning)) return { ...store.getSnapshot(), refused: 'session-running' };
      return store.patch(patch);
    },
    // Settings' note for a refused file (M12, C64, C81). The new snapshot reaches the window by push,
    // and the provider registry admits the providers again from it.
    'prefs:startFresh': () => store.startFresh(),
    'prefs:retry': () => store.retry(),
  };
}
