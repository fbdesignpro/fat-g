// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { memo, useContext } from 'react';
import type { ConversationItem } from '@shared/contracts/conversation';
import { planOf } from '@shared/contracts/interaction';
import { PLAN_OUTCOME_WORDS } from '@shared/contracts/plans';
import { openPlan } from '../artifacts/opener';
import { formatDateTime, formatTimeOfDay } from '../ui/format';
import { LightBulbIcon } from '../ui/icons';
import { CardContext } from './InteractionCard';
import { PLAN_PAGE_WORDS } from './plan-words';
import { MISSING, planName, usePlanInfo } from './plans-store';
import { REVIEW_WORDS, reviewPhrase } from './review-words';
import { usePlanReviews } from './reviews-store';
import styles from './Chat.module.css';

const DAY_MS = 86_400_000;

export interface PlanLineProps {
  readonly item: ConversationItem;
  /** The element's id: what the list names as its current entry. */
  readonly id?: string;
  /** The keyboard's current entry: its own button is a stop in the tab order only then. */
  readonly current?: boolean;
  readonly times?: { readonly today: number } | null;
}

/**
 * A plan's line in the chat (docs/planning/_archive/M22b.md, Design 7; C17, C23, C74): one row of the list,
 * slightly indented, an entry the keyboard stops at as a message is. Its box — a light bulb and
 * "Plan: <title>", with its version where the plan has more than one — is a button that opens its tab
 * (M22e), inverted as the panel's is; while Codex writes the plan it is dashed in the page's own
 * colours and says "being written…" (the maintainer). Beside it, when it was made,
 * "brought" for one brought into the chat, and what became of its decision in words. It holds no
 * control of the decision: the panel in the input's place does, and the tab shows the text. Nothing
 * of the plan's text is drawn here.
 */
export const PlanLine = memo(function PlanLine({ item, id, current = false, times = null }: PlanLineProps) {
  const body = planOf(item);
  const scope = useContext(CardContext);
  const info = usePlanInfo(body?.planId ?? '');
  const reviews = usePlanReviews(body?.planId ?? '');
  if (body === null) return null;
  const removed = info === MISSING;
  const title = removed ? PLAN_PAGE_WORDS.removed : info?.title ?? PLAN_PAGE_WORDS.untitled;
  const version = removed ? undefined : info?.versions.find((entry) => entry.version === body.version);
  const several = !removed && (info?.versions.length ?? 0) > 1;
  const at = version?.at ?? item.time.receivedAt;
  const today = at !== null && times !== null && at >= times.today && at < times.today + DAY_MS;
  const outcome = PLAN_OUTCOME_WORDS[body.outcome];
  // Its own version's reviews, the newest first (M22e, C12): one phrase, and how many more; none once the plan is gone (0029).
  const ofVersion = removed ? [] : (reviews ?? []).filter((review) => review.version === body.version);
  const newest = ofVersion[0];
  const writing = body.outcome === 'writing';
  return (
    <article id={id} className={styles.planLine} data-plan-line={body.planId} data-outcome={body.outcome} data-came={body.came} data-current={current ? '' : undefined} aria-label={PLAN_PAGE_WORDS.plan}>
      {/* Its button says "Plan: <title>", so no label stands before it (M22e). */}
      <button
        type="button"
        className={styles.planBox}
        data-writing={writing ? '' : undefined}
        tabIndex={current ? 0 : -1}
        disabled={removed || scope === null}
        onClick={() => { if (scope !== null) openPlan(scope.sessionId, body.planId, title, body.version); }}
      >
        <LightBulbIcon />
        <span className={styles.planBoxName}>{several ? PLAN_PAGE_WORDS.titled(planName(info), body.version) : planName(info)}</span>
        {writing && <span className={styles.planBoxWriting}>{PLAN_PAGE_WORDS.writing}</span>}
      </button>
      {times !== null && at !== null && <time className={styles.time} dateTime={new Date(at).toISOString()} title={formatDateTime(at)}>{today ? formatTimeOfDay(at) : formatDateTime(at)}</time>}
      {body.came === 'brought' && <span className={styles.planMeta}>{PLAN_PAGE_WORDS.brought}</span>}
      {outcome !== null && <span className={styles.planOutcome} data-plan-outcome={body.outcome}>{outcome}</span>}
      {newest !== undefined && (
        <span className={styles.planMeta} data-plan-review={newest.reviewId}>
          {reviewPhrase(newest)}{ofVersion.length > 1 ? ` ${REVIEW_WORDS.andMore(ofVersion.length - 1)}` : ''}
        </span>
      )}
    </article>
  );
});
