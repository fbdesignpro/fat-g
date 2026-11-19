// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ArtifactPane } from '../artifacts/ArtifactPane';
import { BUILT_IN_KINDS } from '../artifacts/kinds';
import { useArtifactKinds, useHasTabs } from '../artifacts/useArtifactKinds';
import styles from './Shell.module.css';

/**
 * What the chat opens beside itself: the artifact pane (docs/planning/_archive/M19b.md, Design 1), whose rows
 * of buttons act as tabs — a file, a worker, an aside, the session's sub-agents; plans and media as
 * their milestones add a kind each. Tabs stand on the grid above their boxed content beside the
 * chat, a gap between them, and only while the shown session has a tab
 * (docs/planning/_archive/M100.md, Design 8, round 8; C43, C79).
 */
export function ArtifactRegion() {
  return (
    <section className={styles.artifacts} aria-label="Artifacts">
      <ArtifactPane kinds={BUILT_IN_KINDS} />
    </section>
  );
}

/**
 * The page's kinds registered, and a removed session's tabs dropped, whatever the pane shows (C59):
 * called by the session window, which is always there. Whether the window is split: the shown
 * session has a tab open.
 */
export function useArtifactRegion(): boolean {
  useArtifactKinds(BUILT_IN_KINDS);
  return useHasTabs();
}

/** The kinds that open their tabs by themselves, each with what does it (C78). */
const WATCHERS = BUILT_IN_KINDS.flatMap((kind) => (kind.Watcher === undefined ? [] : [{ id: kind.id, Watcher: kind.Watcher }]));

/** Each such kind's watcher, drawn once by the session window, which is always there (round 8; C78). */
export function ArtifactWatchers() {
  return (
    <>
      {WATCHERS.map(({ id, Watcher }) => <Watcher key={id} />)}
    </>
  );
}
