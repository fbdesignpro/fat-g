// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The pane's housekeeping, kept apart from the pane itself (docs/planning/_archive/M100.md, Design 8; C59): the
// session window, which is always there, registers the page's kinds and lets a session that is no
// longer listed take its tabs with it, whatever the pane shows. The pane is drawn only while the
// shown session has a tab, so it could not do either itself: the first tab could never open.
import { useEffect, useLayoutEffect } from 'react';
import { useShownChat } from '../session-area/selected';
import { useAppState } from '../state/store';
import type { TabKind } from './tab-kind';
import { keepSessions, registerKinds, useTabs } from './tabs-store';

/**
 * The page's kinds, by id — what the opener opens a tab by — and, at each snapshot, the tabs of every
 * session no longer listed go. The kinds are registered in a layout effect, which runs before every
 * passive one: a kind's watcher, drawn under the window, opens its first tab in a passive effect
 * (docs/planning/_archive/M100.md, round 8; C78), and a kind not yet registered would not open.
 */
export function useArtifactKinds(kinds: readonly TabKind[]): void {
  const listed = useAppState((state) => state.snapshot?.sessions?.sessions);
  useLayoutEffect(() => { registerKinds(kinds); }, [kinds]);
  useEffect(() => {
    if (listed !== undefined) keepSessions(new Set(listed.map((entry) => entry.record.id)));
  }, [listed]);
}

/**
 * The session whose tabs the pane shows (M19b, C6): the selected one, and none while a chat without
 * a session is shown in its place. Its tabs are kept meanwhile.
 */
export function useTabsSession(): string | null {
  const shown = useShownChat();
  return shown.kind === 'session' ? shown.entry.record.id : null;
}

/** Whether the shown session has a tab open: the session window is split while it does (C43). */
export function useHasTabs(): boolean {
  const sessionId = useTabsSession();
  return useTabs((state) => sessionId !== null && (state.sessions[sessionId]?.tabs.length ?? 0) > 0);
}
