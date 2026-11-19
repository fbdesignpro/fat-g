// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Each chat's part in its plan's shared workflow (decision 0029), as `plans:workflow` answered it: the
// one source of what a chat's foot draws for a plan — its decision panel, what holds the plan now, or
// the line a plan carried out left — never the newest plan line of its own conversation. Read once
// for a chat the page shows, and again at each workflow push that names it or its plan, which
// carries ids alone. Kept in the page for the run: nothing of it is written.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { SessionWorkflow, WorkflowPush } from '@shared/contracts/workflow';
import { invoke, subscribe } from '../ipc/client';
import { planChanged } from './plans-store';

interface WorkflowsState {
  /** A chat's part, or null for none. */
  readonly bySession: Readonly<Record<string, SessionWorkflow | null>>;
}

export const useWorkflows = create<WorkflowsState>()(() => ({ bySession: {} }));

/** The reads in flight, by chat: one at a time for each, and a later ask reads again once it answers. */
const reading = new Map<string, boolean>();

export function readSessionWorkflow(sessionId: string): void {
  if (reading.has(sessionId)) { reading.set(sessionId, true); return; }
  reading.set(sessionId, false);
  void invoke('plans:workflow', { sessionId }).then(
    (answer) => {
      if (answer.status === 'read') useWorkflows.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: answer.workflow } }));
    },
    () => undefined,
  ).finally(() => {
    const again = reading.get(sessionId) === true;
    reading.delete(sessionId);
    if (again) readSessionWorkflow(sessionId);
  });
}

/** A workflow changed: each chat the page holds that it names, or whose part names its plan, is read again, and the plan's own read too. */
export function workflowChanged(push: WorkflowPush): void {
  const held = useWorkflows.getState().bySession;
  const named = new Set(push.sessionIds);
  for (const [sessionId, part] of Object.entries(held)) {
    if (named.has(sessionId) || (part?.kind === 'plan' && part.workflow.planId === push.planId)) readSessionWorkflow(sessionId);
  }
  planChanged(push.planId);
}

/** Every workflow push keeps what the page holds current: subscribed once for the page. */
let following = false;
function follow(): void {
  if (following || typeof window === 'undefined' || (window as { fatg?: unknown }).fatg === undefined) return;
  following = true;
  subscribe('plans:workflowChanged', workflowChanged);
}

/** A chat's part in its plan's workflow: read once where it is not held yet. Undefined until the first read answers. */
export function useSessionWorkflow(sessionId: string): SessionWorkflow | null | undefined {
  const part = useWorkflows((state) => state.bySession[sessionId]);
  useEffect(() => { follow(); if (part === undefined) readSessionWorkflow(sessionId); }, [sessionId, part]);
  return part;
}

/** For tests: nothing held, and the pushes followed again. */
export function resetWorkflows(): void {
  reading.clear();
  following = false;
  useWorkflows.setState({ bySession: {} });
}
