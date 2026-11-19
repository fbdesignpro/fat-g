// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from 'react';
import { planOf } from '@shared/contracts/interaction';
import { planChanged } from '../../chat/plans-store';
import { subscribe } from '../../ipc/client';
import { openPlan, PLAN_KIND } from '../opener';
import { tabId, useTabs } from '../tabs-store';
import type { PlanViewState } from './PlanBody';

/**
 * A plan's newer complete version (docs/planning/_archive/M22e.md, Design 7; C11; decision 0029): every tab
 * showing an earlier version of its plan moves to it, in every session, and none is selected by it —
 * but a tab whose version the user chose in its chooser, which stays as chosen. The chat's own push
 * reaches the shown session alone, and a version made by another chat arrives in another.
 */
function followNewest(planId: string, version: number): void {
  const id = tabId(PLAN_KIND, planId);
  for (const [sessionId, held] of Object.entries(useTabs.getState().sessions)) {
    const state = held.tabs.find((tab) => tab.id === id)?.viewState as PlanViewState | null | undefined;
    if (state?.version !== undefined && state.pinned !== true && state.version < version) openPlan(sessionId, planId, null, version, false);
  }
}

/**
 * Opens a plan's tab by itself (docs/planning/_archive/M22b.md, Design 7; C25): when a plan's line arrives in
 * the chat — a plan proposed, its next version, or a plan brought in — selected, at the version the
 * line stands on. A line arrives by the chat's push, which is the shown session's alone. Each live
 * line opens its tab once here. Separately, PlanPanel selects it when the completed plan's decision
 * appears, including for a line read after returning to a chat or restarting.
 *
 * And it keeps what the page holds of each plan current (C25): a plans' push names the plan, which is
 * read again, and so does a push of one of its lines, whose decision says which chats wait on it.
 * A newer complete version moves every tab of its plan that follows it (M22e, C11; decision 0029).
 */
export function PlanWatcher() {
  const opened = useRef(new Set<string>());

  useEffect(() => subscribe('plans:changed', (push) => {
    planChanged(push.planId);
    if (push.state === 'complete' && push.partial === undefined) followNewest(push.planId, push.version);
  }), []);

  useEffect(() => subscribe('chat:message', (push) => {
    if (!('item' in push) || push.asideId !== undefined || push.workerId !== undefined) return;
    const body = planOf(push.item);
    if (body === null) return;
    // A decision taken or settled: the tab's line of who waits on the plan, read again.
    planChanged(body.planId);
    if ((body.outcome !== 'writing' && body.outcome !== 'pending') || opened.current.has(push.item.id)) return;
    if (openPlan(push.sessionId, body.planId, null, body.version)) opened.current.add(push.item.id);
  }), []);

  return null;
}
