// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The artifact pane as the page draws it (docs/planning/_archive/M100.md, Design 8, round 8; C59, C78): the
// session window, always there, registers the page's kinds, drops a removed session's tabs and, where
// asked, draws the watchers of the kinds whose tabs open by themselves; the pane draws the tabs alone.
// Tests that draw the pane by itself take all of it from here.
import { ArtifactPane } from '../artifacts/ArtifactPane';
import type { TabKind } from '../artifacts/tab-kind';
import { useArtifactKinds } from '../artifacts/useArtifactKinds';

/** `watch`: draw the kinds' watchers too, as the session window does; left out, a tab opens at a test's word alone. */
export function PaneWithKinds({ kinds, watch = false }: { readonly kinds: readonly TabKind[]; readonly watch?: boolean }) {
  useArtifactKinds(kinds);
  return (
    <>
      {watch && kinds.map((kind) => (kind.Watcher === undefined ? null : <kind.Watcher key={kind.id} />))}
      <ArtifactPane kinds={kinds} />
    </>
  );
}
