// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The single source of truth for what windows display. Main-process only, and Electron-free so it
// is testable in plain Node. Every change produces a NEW snapshot with seq + 1; a snapshot is never
// mutated after it has been handed out, because windows may still be holding it.
import { DEFAULT_THEME } from '@shared/contracts/appearance';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { CatalogState } from '@shared/contracts/catalog';
import type { PetSize } from '@shared/contracts/pet';
import type { ConversationsState } from '@shared/contracts/conversation';
import type { RecordsState } from '@shared/contracts/projects';
import type { SessionsState } from '@shared/contracts/sessions';
import type { ProviderSnapshot } from '@shared/contracts/status';

export type AppStateListener = (snapshot: AppStateSnapshot) => void;

export interface AppStateStore {
  getSnapshot(): AppStateSnapshot;
  /**
   * Replaces the provider list with `recipe(current)`. Returning the very same array means "no
   * change": seq stays put and nobody is notified.
   */
  updateProviders(recipe: (providers: readonly ProviderSnapshot[]) => readonly ProviderSnapshot[]): void;
  setProviderDiscovery(discovery: NonNullable<AppStateSnapshot['providerDiscovery']>): void;
  /** Sets how the windows look. The same values again are no change. */
  setAppearance(appearance: AppStateSnapshot['appearance']): void;
  /** Replaces the projects and the records file's status (src/main/state/records.ts). */
  setRecords(records: RecordsState): void;
  /** Replaces the catalog (src/main/services/catalog-service.ts). The same object again is no change. */
  setCatalog(catalog: CatalogState): void;
  /** Replaces the sessions (src/main/sessions/service.ts). The same object again is no change (M14, C24). */
  setSessions(sessions: SessionsState): void;
  /** Replaces the conversation store's status and its detached count (src/main/state/conversations.ts). The same object again is no change. */
  setConversations(conversations: ConversationsState): void;
  /** Whether main is asking to quit (src/main/app/quit-gate.ts). The same answer again is no change. */
  setQuitQuestion(asked: boolean): void;
  /** The Main window's zoom in percent (src/main/windows/zoom.ts). The same value again is no change. */
  setZoom(percent: number): void;
  /** The size the Pet draws its capsules at (src/main/state/appearance.ts). The same value again is no change. */
  setPetSize(size: PetSize): void;
  /** Called after every change with the new snapshot. Returns the function that unsubscribes. */
  subscribe(listener: AppStateListener): () => void;
}

export function createAppStateStore(initial: { readonly appearance?: AppStateSnapshot['appearance'] } = {}): AppStateStore {
  let snapshot: AppStateSnapshot = { seq: 0, appearance: initial.appearance ?? { theme: DEFAULT_THEME }, providers: [] };
  const listeners = new Set<AppStateListener>();

  const replace = (change: Partial<Omit<AppStateSnapshot, 'seq'>>): void => {
    snapshot = { ...snapshot, ...change, seq: snapshot.seq + 1 };
    for (const listener of listeners) listener(snapshot);
  };

  return {
    getSnapshot: () => snapshot,
    setProviderDiscovery(providerDiscovery) { replace({ providerDiscovery }); },

    updateProviders(recipe) {
      const providers = recipe(snapshot.providers);
      if (providers === snapshot.providers) return;
      replace({ providers });
    },

    setAppearance(appearance) {
      const { theme, flash } = appearance;
      const before = snapshot.appearance.flash;
      const sameFlash = flash === undefined ? before === undefined : before !== undefined && flash.enabled === before.enabled && flash.speed === before.speed && flash.seconds === before.seconds;
      if (theme === snapshot.appearance.theme && sameFlash) return;
      replace({ appearance: flash === undefined ? { theme } : { theme, flash: { enabled: flash.enabled, speed: flash.speed, seconds: flash.seconds } } });
    },

    setRecords(records) {
      replace({ records });
    },

    setCatalog(catalog) {
      if (catalog === snapshot.catalog) return;
      replace({ catalog });
    },

    setSessions(sessions) {
      if (sessions === snapshot.sessions) return;
      replace({ sessions });
    },

    setConversations(conversations) {
      if (conversations === snapshot.conversations) return;
      replace({ conversations });
    },

    setQuitQuestion(asked) {
      if (asked === (snapshot.quitQuestion ?? false)) return;
      replace({ quitQuestion: asked });
    },

    setZoom(percent) {
      if (percent === snapshot.zoom) return;
      replace({ zoom: percent });
    },

    setPetSize(size) {
      if (size === snapshot.petSize) return;
      replace({ petSize: size });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
