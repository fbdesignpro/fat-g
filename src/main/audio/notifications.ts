// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { NotificationAudioEvent } from '@shared/contracts/audio';
import type { SessionSummary, TurnOutcome } from '@shared/contracts/sessions';

export function allowsReady(summary: Pick<SessionSummary, 'status' | 'attention' | 'planWait'> | undefined, openQuestion: boolean, reviewing: boolean): boolean {
  return summary !== undefined && summary.status !== 'running' && summary.attention?.kind === 'ready'
    && summary.planWait === undefined && !openQuestion && !reviewing;
}

/** Live domain hooks only. No content, snapshots, account state or durable bookkeeping. */
export function createAudioNotifications(options: {
  readonly emit: (event: NotificationAudioEvent) => void;
  readonly canReady: (sessionId: string, turnId: string) => boolean;
  readonly active: () => boolean;
  readonly defer?: (work: () => void) => void;
}) {
  const requests = new Map<string, Set<string>>();
  const ended = new Map<string, Set<string>>();
  const plans = new Map<string, number>();
  const reviews = new Map<string, number>();
  const once = (map: Map<string, Set<string>>, owner: string, id: string): boolean => {
    const seen = map.get(owner) ?? new Set<string>();
    if (seen.has(id)) return false;
    seen.add(id); map.set(owner, seen); return true;
  };
  return {
    request(sessionId: string, itemId: string, kind: 'question' | 'approval'): void {
      if (once(requests, sessionId, `${kind}:${itemId}`) && options.active()) options.emit(kind);
    },
    plan(planId: string, version: number): void {
      if ((plans.get(planId) ?? 0) >= version) return;
      plans.set(planId, version);
      if (options.active()) options.emit('planReady');
    },
    review(reviewId: string, round: number): void {
      if ((reviews.get(reviewId) ?? 0) >= round) return;
      reviews.set(reviewId, round);
      if (options.active()) options.emit('reviewReady');
    },
    ended(sessionId: string, turnId: string, outcome: TurnOutcome): void {
      if (!once(ended, sessionId, turnId) || (outcome !== 'completed' && outcome !== 'failed')) return;
      // The runtime records review/workflow results after the session's end in the same stack.
      (options.defer ?? queueMicrotask)(() => {
        if (!options.active() || !ended.get(sessionId)?.has(turnId)) return;
        if (outcome === 'failed') options.emit('error');
        else if (options.canReady(sessionId, turnId)) options.emit('turnFinished');
      });
    },
    forgetSession(sessionId: string): void { requests.delete(sessionId); ended.delete(sessionId); },
    forgetPlan(planId: string): void { plans.delete(planId); },
  };
}
