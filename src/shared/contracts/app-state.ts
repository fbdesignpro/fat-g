// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AttentionFlash, Theme } from './appearance';
import type { CatalogState } from './catalog';
import type { ConversationsState } from './conversation';
import type { PetSize, PetView } from './pet';
import type { RecordsState } from './projects';
import type { SessionsState } from './sessions';
import type { ProviderSnapshot } from './status';
import type { ProviderDiscoveryState } from './provider-discovery';

/**
 * Everything the windows render. Owned by the main process (src/main/state/app-state-store.ts) and
 * pushed whole to every window; windows never mutate it — they ask main to act instead.
 */
export interface AppStateSnapshot {
  /**
   * Goes up by one on every change. A window keeps the highest `seq` it has seen and ignores
   * anything older: an invoke response and a push can arrive in either order.
   */
  readonly seq: number;
  /**
   * How the windows look. The saved preference, carried here because the Pet may not read
   * preferences (src/shared/ipc/contract.ts) yet follows the theme too — and the attention flash,
   * which its capsules draw as the Main window's do; absent until main has read the preferences.
   */
  readonly appearance: { readonly theme: Theme; readonly flash?: AttentionFlash };
  /** In display order. */
  readonly providers: readonly ProviderSnapshot[];
  /** Installation discovery and its notices. Excluded from the mini window's allowlist. */
  readonly providerDiscovery?: ProviderDiscoveryState;
  /**
   * fat-g's projects and the records file's status (M12, C52). The Main window's only: the Pet's
   * projection is built from an allowlist that leaves it out, because root paths hold the user's
   * name and the Pet shows on screen shares (src/main/state/projection.ts).
   */
  readonly records?: RecordsState;
  /**
   * Each provider's models, effort levels and speed tiers, and the override file's status (M13,
   * C50). The Main window's only, set before any window opens: the Pet's projection leaves it out,
   * as it does the records — the override's path holds the user's name.
   */
  readonly catalog?: CatalogState;
  /**
   * fat-g's sessions, each with its live summary, the selected one and the count of entries left
   * without a project (M14, C65). The Main window's only: the Pet's projection leaves it out
   * (decision 0010).
   */
  readonly sessions?: SessionsState;
  /**
   * The conversation store's status, and how many conversations no listed session has (M18, C24,
   * C31): a status and a count, never a name or a text. The Main window's only: the Pet's
   * projection leaves it out.
   */
  readonly conversations?: ConversationsState;
  /**
   * Main is asking whether to quit while a session runs (M14, C100). The Main window's only; a page
   * that reloads reads the question again with its first snapshot.
   */
  readonly quitQuestion?: boolean;
  /**
   * The Main window's zoom in percent (src/shared/contracts/zoom.ts), once its page has loaded. The
   * Main window's only: the Pet keeps its own zoom at 100% and its projection leaves this out.
   */
  readonly zoom?: number;
  /**
   * The size the Pet draws its capsules at: the saved preference, or what the Pet's own toggle set
   * while the file refuses writes. Main's, which builds the Pet's view from it (src/main/state/pet-view.ts).
   */
  readonly petSize?: PetSize;
  /**
   * What the Pet shows (decision 0010): the sessions running or waiting on the user, by an allowlist
   * of what a capsule draws. The Pet's projection alone holds it; the Main window has the sessions.
   */
  readonly pet?: PetView;
}
