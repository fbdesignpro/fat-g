// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, useRef, useState } from 'react';
import type { ReviewView } from '@shared/contracts/review';
import type { SessionEntry } from '@shared/contracts/sessions';
import { openPlan } from '../artifacts/opener';
import { invoke } from '../ipc/client';
import { selectSession } from '../sessions/select';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import { useFootFocus } from './foot-focus';
import { IntegratePopup } from './IntegratePopup';
import { MISSING, type PlanInfo, usePlanInfo } from './plans-store';
import { pendingAsk } from './review-context';
import { reviewCloseText, REVIEW_WORDS, reviewRefusalText } from './review-words';
import styles from './Chat.module.css';

export interface ReviewPanelProps {
  readonly entry: SessionEntry;
  readonly review: ReviewView;
  readonly providerName: string;
  readonly title: string;
}

/**
 * The review in the reviewer's foot (docs/planning/_archive/M22e.md, Design 6; C8, C29, C31, C44; decision
 * 0029), in the toolbar's and the input's place for as long as the review is open: a review is a hard
 * stop on its plan (the maintainer), which goes on or is cancelled, and is never hidden.
 * While a turn of it runs, or its reviewer asks a question, it says so; once a round is live, a line
 * of how many findings are accepted, refused and undecided and how many notes are written, then one
 * action:
 *
 *   every finding decided, N accepted   Integrate N findings — disabled at none, saying why
 *   some undecided, a note written      Send notes, a turn of this session on its account
 *   some undecided, no note             Integrate, disabled, saying how many wait
 *   no finding, or every one refused    Take me back to the plan, in green
 *
 * The last (the maintainer) concludes the review with no change — main marks the
 * reviewer's chat Done — then selects the chat where the plan's decision stands and opens its tab
 * there. The plan's decision stays the user's to take. Cancel review, beside each, stops what of the
 * review runs, closes it and readies the plan in every chat. It takes no focus as it comes, and
 * Escape decides nothing.
 */
export function ReviewPanel({ entry, review, providerName, title }: ReviewPanelProps) {
  const foot = useFootFocus();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const action = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  const round = review.rounds.at(-1);
  const marks = Object.values(round?.marks ?? {});
  const undecided = marks.filter((mark) => mark === 'open').length;
  const accepted = marks.filter((mark) => mark === 'accepted').length;
  const refused = marks.filter((mark) => mark === 'rejected').length;
  const notes = Object.values(round?.notes ?? {}).filter((note) => note !== '').length;
  const noted = notes > 0;
  const waiting = busy || undefined;
  const info = usePlanInfo(review.planId);
  const running = entry.summary.status === 'running' || review.turns.some((turn) => turn.outcome === 'waiting');
  const asking = pendingAsk(review) !== undefined;

  const send = (): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    invoke('reviews:send', { reviewId: review.reviewId }).then(
      (answer) => { if (answer.status !== 'sent') setProblem(reviewRefusalText(answer.reason, providerName)); },
      () => { setProblem(REVIEW_WORDS.sendFailed); },
    ).finally(() => { setBusy(false); });
  };

  const cancel = (): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    invoke('reviews:close', { reviewId: review.reviewId, as: 'cancel' }).then(
      (answer) => { if (answer.status !== 'closed') setProblem(reviewCloseText(answer.reason)); },
      () => { setProblem(REVIEW_WORDS.closeFailed); },
    ).finally(() => { setBusy(false); });
  };

  const back = (): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const target = planChat(review, info);
    invoke('reviews:close', { reviewId: review.reviewId, as: 'conclude' }).then(
      async (answer) => {
        if (answer.status !== 'closed') { setProblem(reviewCloseText(answer.reason)); return; }
        if (target === entry.record.id) return;
        // Main marked this chat Done, which let go of the selection: the plan's chat takes it, its tab open.
        await selectSession(target).catch(() => undefined);
        openPlan(target, review.planId, title, review.version);
      },
      () => { setProblem(REVIEW_WORDS.closeFailed); },
    ).finally(() => { setBusy(false); });
  };

  const cancelButton = <button type="button" className={styles.button} data-review-cancel="" aria-disabled={waiting} onClick={cancel}>{REVIEW_WORDS.cancelReview}</button>;
  const frame = (children: ReactNode) => (
    <div className={styles.reviewPanel} role="group" aria-label={REVIEW_WORDS.panel} data-review-panel={review.reviewId} ref={foot}>
      {children}
      {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
    </div>
  );

  // A turn of it runs, or its reviewer asks: the review goes on, or is cancelled.
  if (running || asking || round === undefined) {
    return frame(
      <>
        <p className={styles.reviewCounts} data-review-counts="" role="status">{asking ? REVIEW_WORDS.asked : REVIEW_WORDS.running}</p>
        <div className={styles.planPanelActions}>{cancelButton}</div>
      </>,
    );
  }

  // Nothing to change: the way back to the plan, the review concluded.
  if (review.concludable) {
    return frame(
      <>
        <p className={styles.reviewCounts} data-review-counts="">{round.findings.length === 0 ? REVIEW_WORDS.clean : REVIEW_WORDS.allRefused}</p>
        <div className={styles.planPanelActions}>
          <button type="button" className={`${styles.button} ${styles.reviewBack}`} data-review-back="" aria-disabled={waiting} onClick={back}>{REVIEW_WORDS.backToPlan}</button>
          {cancelButton}
        </div>
      </>,
    );
  }

  // Disabled with its reason, still reachable (C8): the tooltip says why.
  const why = undecided === 0 && accepted === 0 ? REVIEW_WORDS.integrateNone : undecided > 0 && !noted ? REVIEW_WORDS.waiting(undecided) : null;
  return frame(
    <>
      {/* What the user has decided so far, above the action it leads to: no announcement, as it changes at each mark. */}
      <p className={styles.reviewCounts} data-review-counts="">{REVIEW_WORDS.counts(accepted, refused, undecided, notes)}</p>
      <div className={styles.planPanelActions}>
        {undecided === 0 && accepted > 0 ? (
          <IntegratePopup entry={entry} review={review} providerName={providerName} title={title} accepted={accepted} />
        ) : undecided > 0 && noted ? (
          <>
            <button ref={action} type="button" className={styles.button} data-primary="" data-review-send="" aria-disabled={waiting} {...tooltip.targetProps} onClick={send}>{REVIEW_WORDS.sendNotes}</button>
            <Tooltip id={tooltip.id} open={tooltip.open} anchor={action}>{REVIEW_WORDS.sendNotesTip}</Tooltip>
          </>
        ) : (
          <>
            <button ref={action} type="button" className={styles.button} data-primary="" data-review-integrate="" aria-disabled="true" {...tooltip.targetProps}>
              {undecided === 0 ? REVIEW_WORDS.integrate(0) : REVIEW_WORDS.integrateLater}
            </button>
            <Tooltip id={tooltip.id} open={tooltip.open} anchor={action}>{why}</Tooltip>
          </>
        )}
        {cancelButton}
      </div>
      {why !== null && <p className={styles.status} data-review-why="">{why}</p>}
    </>,
  );
}

/**
 * The chat to go back to from a review that changes nothing: the one it started from while it takes
 * part in the plan still, else another that does, else the version's own chat; the one it started
 * from where the plan is not read.
 */
function planChat(review: ReviewView, info: PlanInfo | typeof MISSING | undefined): string {
  if (info === undefined || info === MISSING) return review.startedFrom;
  const taking = info.workflow.participants;
  if (taking.includes(review.startedFrom)) return review.startedFrom;
  return taking[0] ?? info.versions.find((one) => one.version === review.version)?.sessionId ?? review.startedFrom;
}
