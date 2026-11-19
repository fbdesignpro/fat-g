// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The plans the page has read (docs/planning/_archive/M22b.md, Design 7; C23, C25, C60, C63): each plan's
// title, its versions and the chats that wait on it, by its id, as `plans:read` answered — and none
// of its text, which the plan tab reads range by range and holds while it is shown. Read once for a
// plan the page names, and again at each push that names it. Kept in the page for the run, as the
// drafts are (chat-store.ts): nothing of it is written.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { PlanRead } from '@shared/contracts/plans';
import { PLAN_KIND } from '../artifacts/opener';
import { closeTab, tabId, useTabs } from '../artifacts/tabs-store';
import { invoke } from '../ipc/client';
import { PLAN_PAGE_WORDS } from './plan-words';

/** What the page holds of a plan: its read but for the text. */
export type PlanInfo = Omit<PlanRead, 'status' | 'text' | 'start' | 'version' | 'length' | 'hash'>;

/** A plan main no longer holds: removed, or never read. */
export const MISSING = 'missing';

/**
 * A plan as its buttons, its prompt's fold and its tab name it (M22e, the maintainer's V6 review):
 * "Plan: <title>", since a title such as "Context" alone does not say it is a plan's. A removed plan,
 * or one not read yet, keeps its own words.
 */
export function planName(info: PlanInfo | typeof MISSING | undefined): string {
  return info === MISSING ? PLAN_PAGE_WORDS.removed : info === undefined ? PLAN_PAGE_WORDS.untitled : PLAN_PAGE_WORDS.named(info.title);
}

interface PlansState {
  readonly infos: Readonly<Record<string, PlanInfo | typeof MISSING>>;
  /** Invalidates visible project lists after local removals, which have no provider push. */
  readonly listRevision: number;
}

export const usePlans = create<PlansState>()(() => ({ infos: {}, listRevision: 0 }));

/** The reads in flight, by plan: one at a time for each, and a later ask reads again once it answers. */
const reading = new Map<string, boolean>();

/** Reads a plan's title, versions and waiting chats again (C25): its first unit of text alone is asked for. */
export function readPlanInfo(planId: string): void {
  if (reading.has(planId)) { reading.set(planId, true); return; }
  reading.set(planId, false);
  const settle = (info: PlanInfo | typeof MISSING | null): void => {
    const again = reading.get(planId) === true;
    reading.delete(planId);
    // A plan the page held is gone — implemented, discarded or removed (decision 0029): its tabs close in every chat.
    const held = usePlans.getState().infos[planId];
    if (info === MISSING && held !== undefined && held !== MISSING) closePlanTabs(planId);
    if (info !== null) usePlans.setState((state) => ({
      infos: { ...state.infos, [planId]: info },
      listRevision: state.listRevision + (info === MISSING && state.infos[planId] !== MISSING ? 1 : 0),
    }));
    if (again) readPlanInfo(planId);
  };
  invoke('plans:read', { planId, start: 0, length: 1 }).then(
    (answer) => {
      if (answer.status !== 'read') { settle(answer.reason === 'storage-failed' ? null : MISSING); return; }
      const { status: _status, text: _text, start: _start, version: _version, length: _length, hash: _hash, ...info } = answer;
      settle(info);
    },
    () => { settle(null); },
  );
}

function closePlanTabs(planId: string): void {
  const id = tabId(PLAN_KIND, planId);
  for (const [sessionId, session] of Object.entries(useTabs.getState().sessions)) if (session.tabs.some((tab) => tab.id === id)) closeTab(sessionId, id);
}

/** A plan the page shows: read once where it is not held yet. */
export function usePlanInfo(planId: string): PlanInfo | typeof MISSING | undefined {
  const info = usePlans((state) => state.infos[planId]);
  useEffect(() => { if (info === undefined && planId !== '') readPlanInfo(planId); }, [planId, info]);
  return info;
}

/** A push named a plan (C25): one the page holds is read again. */
export function planChanged(planId: string): void {
  if (usePlans.getState().infos[planId] !== undefined) readPlanInfo(planId);
}

/** Plans were removed (C21, C73): every plan the page holds is read again, so that the lines and tabs naming a removed one say so. */
export function plansRemoved(): void {
  usePlans.setState((state) => ({ listRevision: state.listRevision + 1 }));
  for (const planId of Object.keys(usePlans.getState().infos)) readPlanInfo(planId);
}

/** For tests: nothing held. */
export function resetPlans(): void {
  reading.clear();
  usePlans.setState({ infos: {}, listRevision: 0 });
}
