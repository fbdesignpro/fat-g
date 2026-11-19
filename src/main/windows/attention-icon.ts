// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { isActive, unseenAttention } from '@shared/contracts/sessions';
import type { AppStateStore } from '../state/app-state-store';

/** Follow the same unacknowledged attention the active capsules show; repaint only on transitions. */
export function followAttentionIcon(store: Pick<AppStateStore, 'getSnapshot' | 'subscribe'>, paint: (attention: boolean) => void): () => void {
  let previous: boolean | undefined;
  const apply = (): void => {
    const attention = store.getSnapshot().sessions?.sessions.some(({ record, summary }) => isActive(record) && unseenAttention(summary)) ?? false;
    if (attention === previous) return;
    previous = attention;
    paint(attention);
  };
  apply();
  return store.subscribe(apply);
}
