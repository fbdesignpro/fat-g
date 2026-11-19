// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The plans' channels (docs/planning/_archive/M22b.md, Design 6; C18, C20, C21, C62–C64, C72, C73, C75;
// decision 0029). A read names a plan, a version and a range of its text; a list names a project; a
// removal names a plan, or every plan; a decision names the session, the plan's line and the
// decision, with the user's feedback for one; a plan brought into a chat names the session, the plan,
// the version and the hash the list showed. Everything else is main's: whether the line waits, what
// a decision sends, and what a removal settles first.
//
// Since a plan's workflow is shared by its chats (decision 0029), a decision names the plan and the
// workflow's revision the page drew it from, and the coordinator admits it; `plans:workflow` reads a
// chat's part in its plan's workflow, of ids, states and names alone.
//
// A removal settles every decision that waits on what it removes before anything is deleted (C73):
// a request's through its process, any other's written as cancelled, one after another. A plan with
// a version being written is not removed (C62), and nothing is while the stores cannot be read.
//
// What main says of each is its outcome's kind, counted (C75): never a plan's text, its title, an id
// or a path. The six are the Main window's only: a plan is the user's own, and the Pet, which shows
// on screen shares, is refused each as `forbidden`, by the contract.
import type { PlanRemoveResult } from '@shared/contracts/plans';
import type { PlanStore } from '../../plans/store';
import type { PlanService } from '../../sessions/plans';
import type { SessionRuntime } from '../../sessions/runtime';
import type { WorkflowCoordinator } from '../../sessions/workflow';
import type { InvokeHandlers } from '../dispatch';
import { createKindCounts, type KindCounts } from './counts';

export interface PlanHandlerDeps {
  readonly plans: Pick<PlanService, 'read' | 'list' | 'storage'>;
  readonly store: Pick<PlanStore, 'all' | 'get' | 'writing' | 'remove'>;
  readonly runtime: Pick<SessionRuntime, 'bringPlan' | 'settlePlans'>;
  /** The plans' shared workflow (decision 0029): what takes a decision, and what a chat's part reads. */
  readonly workflow: Pick<WorkflowCoordinator, 'decide' | 'forSession'>;
  /** Whether a session is listed. */
  readonly listedSession: (sessionId: string) => boolean;
  /** The projects the records list, or null while they cannot be read (C21, C62). */
  readonly listed: () => ReadonlySet<string> | null;
  /** Whether the conversation store can be read: a removal settles decisions in its chats. Without it, it can. */
  readonly conversationsReadable?: () => boolean;
  readonly counts?: KindCounts;
}

type Channels = 'plans:read' | 'plans:list' | 'plans:remove' | 'plans:decide' | 'plans:bring' | 'plans:storage' | 'plans:workflow';

export function planHandlers(deps: PlanHandlerDeps): Pick<InvokeHandlers, Channels> {
  const counts = deps.counts ?? createKindCounts();
  /** An outcome's kind: what it did, or why it did not. */
  const said = <const T extends { readonly status: string; readonly reason?: string }>(what: string, answer: T): T => {
    counts.add(answer.status === 'refused' ? `${what}:refused:${answer.reason ?? ''}` : `${what}:${answer.status}`);
    return answer;
  };
  return {
    'plans:read': (request) => said('read', deps.plans.read(request)),
    'plans:list': ({ projectId }) => said('list', { status: 'listed', plans: deps.plans.list(projectId) }),
    'plans:storage': () => deps.plans.storage(deps.listed()),
    async 'plans:remove'(request): Promise<PlanRemoveResult> {
      const planIds = 'all' in request ? deps.store.all().map((plan) => plan.id) : [request.planId];
      if (!('all' in request) && deps.store.get(request.planId) === null) return said('remove', { status: 'refused', reason: 'unknown-plan' });
      // Nothing is settled for a plan that cannot be removed now (C62).
      if (planIds.some((planId) => deps.store.writing(planId))) return said('remove', { status: 'refused', reason: 'writing' });
      if (deps.listed() === null) return said('remove', { status: 'refused', reason: 'records-refused' });
      if (deps.conversationsReadable?.() === false) return said('remove', { status: 'refused', reason: 'conversations-refused' });
      // Every decision that waits on them first, each written before the next (C73).
      const settled = await deps.runtime.settlePlans(planIds);
      let removed = 0;
      for (const planId of planIds) {
        let outcome: ReturnType<PlanStore['remove']>;
        try { outcome = deps.store.remove(planId); } catch { return said('remove', { status: 'refused', reason: 'storage-failed' }); }
        if (outcome === 'removed') removed += 1;
      }
      return said('remove', { status: 'removed', removed, settled });
    },
    async 'plans:decide'(request) {
      return said(`decide:${request.decision}`, await deps.workflow.decide(request));
    },
    'plans:workflow'({ sessionId }) {
      if (!deps.listedSession(sessionId)) return said('workflow', { status: 'refused', reason: 'unknown-session' });
      try { return said('workflow', { status: 'read', workflow: deps.workflow.forSession(sessionId) }); } catch { return said('workflow', { status: 'refused', reason: 'storage-failed' }); }
    },
    async 'plans:bring'({ sessionId, planId, version, hash }) {
      return said('bring', await deps.runtime.bringPlan(sessionId, { planId, version, hash }));
    },
  };
}
