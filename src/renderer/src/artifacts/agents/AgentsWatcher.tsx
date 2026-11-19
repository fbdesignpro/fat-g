// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect } from 'react';
import { useGrantsStore } from '../../chat/grants-store';
import { useAppState } from '../../state/store';
import { AGENTS_KIND } from '../opener';
import { openTab } from '../tabs-store';

/**
 * Opens a session's Sub-agents tab by itself (docs/planning/_archive/M100.md, round 8; C78;
 * docs/planning/_archive/M106.md, Design 7; C1, C2): for every listed session whose summary lists a sub-agent,
 * running or finished — a session that had one lists it from launch on (C26) — and for the selected
 * session with a live grant, the grants the page holds being the selected session's alone
 * (src/renderer/src/chat/grants-store.ts). A grant already ended when it is first read, one of a run
 * before, opens nothing: it is listed in the tab, which a sub-agent or a live grant opens.
 *
 * The tab goes first in the session's row and takes the view only where the session shows no other
 * tab; the one being read stays shown. It is never closed: the kind's tabs do not close, and it goes
 * with its session. Opening it again at each change changes nothing (`openTab` on an open tab, not
 * selected), so nothing of what was seen is kept here. The kinds are registered before this runs
 * (useArtifactKinds); should they not be, the next change opens it.
 */
export function AgentsWatcher() {
  const sessions = useAppState((state) => state.snapshot?.sessions?.sessions);
  const grants = useGrantsStore();

  useEffect(() => {
    for (const entry of sessions ?? []) if (entry.summary.agents.length > 0) open(entry.record.id);
  }, [sessions]);

  useEffect(() => {
    if (grants.sessionId !== null && grants.grants.some((grant) => grant.live)) open(grants.sessionId);
  }, [grants]);

  return null;
}

const open = (sessionId: string): void => { openTab(sessionId, AGENTS_KIND, null, { select: false, first: true }); };
