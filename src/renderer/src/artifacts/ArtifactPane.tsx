// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useCallback, useId } from 'react';
import type { TabKind } from './tab-kind';
import { TabList } from './TabList';
import { closeTab, selectTab, type SessionTabs, setTitle, setViewState, useTabs } from './tabs-store';
import { useTabsSession } from './useArtifactKinds';
import styles from './ArtifactPane.module.css';

/**
 * The artifact pane (docs/planning/_archive/M19b.md, Design 1–3; C3–C14): at its top rows of text tabs
 * on the grid, and under them the selected tab's body, framed unless its kind opts out. With no tab it shows nothing,
 * and the session window does not draw it (docs/planning/_archive/M100.md, Design 8; C43).
 *
 * Tabs are a session's (C6): it shows the selected session's, and another session's when that one
 * is selected. While no session is selected, or a chat without a session is shown, it shows nothing
 * and every session's tabs are kept. Registering the page's kinds and dropping the tabs of a session
 * no longer listed are the session window's, which is always there (useArtifactKinds; M100, C59).
 *
 * It names no kind (C4): it is given the page's kinds, and draws a tab's body with the kind the tab
 * names. Only the selected tab's body is drawn (C5).
 *
 * The pane never scrolls (C13): its rows scroll within themselves past three, and a body scrolls as
 * its kind has it. Opening or selecting a tab moves no focus: nothing here calls for it (C12).
 */
export function ArtifactPane({ kinds }: { readonly kinds: readonly TabKind[] }) {
  const sessionId = useTabsSession();
  const held = useTabs((state) => (sessionId === null ? undefined : state.sessions[sessionId]));
  if (sessionId === null || held === undefined || held.tabs.length === 0) return null;
  return <Shown sessionId={sessionId} held={held} kinds={kinds} />;
}

function Shown({ sessionId, held, kinds }: { readonly sessionId: string; readonly held: SessionTabs; readonly kinds: readonly TabKind[] }) {
  const paneId = useId();
  const tab = held.tabs.find((candidate) => candidate.id === held.selected) ?? held.tabs[0];
  const tabId = tab?.id ?? '';
  const changeViewState = useCallback((next: unknown) => setViewState(sessionId, tabId, next), [sessionId, tabId]);
  const changeTitle = useCallback((title: string) => setTitle(sessionId, tabId, title), [sessionId, tabId]);
  if (tab === undefined) return null;
  const kind = kinds.find((candidate) => candidate.id === tab.kind);
  const panelId = `${paneId}panel`;
  const domId = (candidate: { readonly serial: number }): string => `${paneId}tab${candidate.serial}`;
  return (
    <div className={styles.pane} data-artifact-pane={sessionId}>
      <TabList tabs={held.tabs} selected={tab.id} panelId={panelId} domId={domId} onSelect={(id) => selectTab(sessionId, id)} onClose={(id) => closeTab(sessionId, id)} />
      <div className={styles.body} role="tabpanel" id={panelId} aria-labelledby={domId(tab)} data-frameless={kind?.framed === false ? '' : undefined}>
        {/* Keyed by its session and its tab: another tab's body starts from nothing of this one's. */}
        {kind !== undefined && <kind.Body key={`${sessionId}\u0000${tab.id}`} sessionId={sessionId} reference={tab.reference} viewState={tab.viewState} setViewState={changeViewState} setTitle={changeTitle} />}
      </div>
    </div>
  );
}
