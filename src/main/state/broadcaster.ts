// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What each window is told about, and when. Both broadcasters are the same coalescing loop
// (push.ts) with a different answer to "what does this kind of window get?".
import type { PreferencesStore } from '../prefs/store';
import type { AppStateStore } from './app-state-store';
import { projectForWindow } from './projection';
import { startCoalescedPush, type BroadcastTarget } from './push';

export type { BroadcastTarget } from './push';
export { PUSH_DELAY_MS as BROADCAST_DELAY_MS } from './push';

export interface BroadcasterOptions {
  readonly targets: () => Iterable<BroadcastTarget>;
  readonly delayMs?: number;
  readonly log?: Pick<Console, 'error'>;
}

/** App state goes to every window, projected for the kind of window it is going to. */
export function startStateBroadcaster({ store, ...options }: BroadcasterOptions & { store: AppStateStore }): () => void {
  return startCoalescedPush({
    channel: 'state:snapshot',
    subscribe: (listener) => store.subscribe(listener),
    payloadFor: (kind) => projectForWindow(kind, store.getSnapshot()),
    ...options,
  });
}

/**
 * Preferences go to the Main window and nowhere else. The Pet window is always on top and appears
 * in screen shares, and `providers[id].executablePath` is a path with the user's name in it — so
 * rather than redacting preferences for the Pet, it simply never receives them. Its UI audio cues
 * are requests by fixed name, played by Main; no audio preferences need a Pet projection (0034).
 */
export function startPrefsBroadcaster({ prefs, ...options }: BroadcasterOptions & { prefs: PreferencesStore }): () => void {
  return startCoalescedPush({
    channel: 'prefs:changed',
    subscribe: (listener) => prefs.subscribe(listener),
    payloadFor: (kind) => (kind === 'main' ? prefs.getSnapshot() : null),
    ...options,
  });
}
