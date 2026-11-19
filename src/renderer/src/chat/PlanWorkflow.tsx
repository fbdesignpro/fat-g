// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import type { ConversationTurn } from '@shared/contracts/conversation';
import { type SessionWorkflow, type WorkflowView, WORKFLOW_WORDS, workflowChat } from '@shared/contracts/workflow';
import { invoke } from '../ipc/client';
import { selectSession } from '../sessions/select';
import { useFootFocus } from './foot-focus';
import { planDecideText, PLAN_PAGE_WORDS } from './plan-words';
import { reviewCloseText, REVIEW_WORDS } from './review-words';
import styles from './Chat.module.css';

/** A chat named in a workflow's words, as a button that selects it; plain words for one no longer listed. */
function ChatLink({ sessionId, chat, here }: { readonly sessionId: string; readonly chat: string | null; readonly here: string }) {
  if (sessionId === here || chat === null) return <>{workflowChat(chat)}</>;
  return (
    <button type="button" className={styles.inlineButton} data-workflow-chat={sessionId} onClick={() => { void selectSession(sessionId).catch(() => undefined); }}>
      {workflowChat(chat)}
    </button>
  );
}

/**
 * What a chat's plan is when the chat goes on beside it (decision 0029): one line above its composer
 * while another chat carries the plan out, while that implementation is interrupted — with Discard
 * plan, and in the chat that carried it, that its next prompt continues it — and once the plan was
 * implemented and deleted. In the implementing chat, the latter disappears after its first later
 * turn ends. The stored note remains; older pages must not make its dismissed line reappear.
 */
export function PlanStatusLine({ sessionId, part, providerName, turns }: { readonly sessionId: string; readonly part: SessionWorkflow | null | undefined; readonly providerName: string; readonly turns: ReadonlyMap<string, ConversationTurn> | undefined }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [expiredNotice, setExpiredNotice] = useState<string | null>(null);
  const implemented = part?.kind === 'implemented' && part.sessionId === sessionId ? part : null;
  const noticeKey = implemented === null ? null : `${sessionId}:${implemented.at}`;
  const followupEnded = implemented !== null && [...(turns?.values() ?? [])].some((turn) => {
    const { acceptedAt, endReceivedAt } = turn.time;
    // Main's own times alone: an implementation's turn began before its completion note, while a
    // queued follow-up can be accepted in the same millisecond that note was written.
    return turn.state === 'ended' && acceptedAt !== null && acceptedAt >= implemented.at && endReceivedAt !== null && endReceivedAt > implemented.at;
  });
  if (followupEnded && noticeKey !== null && expiredNotice !== noticeKey) setExpiredNotice(noticeKey);
  if (part === null || part === undefined) return null;
  if (part.kind === 'implemented') {
    if (noticeKey !== null && (followupEnded || expiredNotice === noticeKey)) return null;
    return (
      <div className={styles.planStatus} data-plan-status="implemented" role="note">
        <p className={styles.planStatusText}>
          {part.sessionId === sessionId ? WORKFLOW_WORDS.implementedHere : <>{WORKFLOW_WORDS.implementedIn} <ChatLink sessionId={part.sessionId} chat={part.chat} here={sessionId} /></>}
        </p>
      </div>
    );
  }
  if (part.role !== 'participant') return null;
  const { workflow } = part;
  const holder = workflow.holder;
  if (holder === null || (workflow.state !== 'implementing' && workflow.state !== 'interrupted')) return null;
  const mine = holder.sessionId === sessionId;
  const discard = (): void => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    invoke('plans:decide', { sessionId, planId: workflow.planId, revision: workflow.revision, decision: 'cancel' }).then(
      (answer) => { if (answer.status !== 'decided') setProblem(planDecideText(answer.reason, providerName)); },
      () => { setProblem(PLAN_PAGE_WORDS.failed); },
    ).finally(() => { setBusy(false); });
  };
  return (
    <div className={styles.planStatus} data-plan-status={workflow.state} role="note">
      <p className={styles.planStatusText}>
        {workflow.state === 'implementing'
          ? (mine ? WORKFLOW_WORDS.implementingHere : <>{WORKFLOW_WORDS.implementingIn} <ChatLink sessionId={holder.sessionId} chat={holder.chat} here={sessionId} /></>)
          : (mine ? WORKFLOW_WORDS.interruptedHere : <>{WORKFLOW_WORDS.interruptedIn} <ChatLink sessionId={holder.sessionId} chat={holder.chat} here={sessionId} /></>)}
      </p>
      {workflow.state === 'interrupted' && (
        <button type="button" className={styles.button} data-plan-discard="" aria-disabled={busy || workflow.busy !== null || undefined} onClick={discard}>{WORKFLOW_WORDS.discard}</button>
      )}
      {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
    </div>
  );
}

/**
 * What holds a chat's plan, in its composer's place (decision 0029): the plan under review — with its
 * reviewer's chat and Cancel review — another chat writing its next version, or a discard under way.
 * The conversation above stays as it is: reading, selection, copying and navigation are untouched.
 */
export function PlanLock({ sessionId, workflow }: { readonly sessionId: string; readonly workflow: WorkflowView }) {
  const foot = useFootFocus();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const holder = workflow.holder;
  const cancelReview = (): void => {
    if (busy || workflow.reviewId === null) return;
    setBusy(true);
    setProblem(null);
    invoke('reviews:close', { reviewId: workflow.reviewId, as: 'cancel' }).then(
      (answer) => { if (answer.status !== 'closed') setProblem(reviewCloseText(answer.reason)); },
      () => { setProblem(REVIEW_WORDS.writeFailed); },
    ).finally(() => { setBusy(false); });
  };
  const words = workflow.busy === 'cancelling' ? WORKFLOW_WORDS.cancelling
    : workflow.busy === 'starting' ? WORKFLOW_WORDS.starting
      : workflow.state === 'reviewing' ? WORKFLOW_WORDS.underReview
        : workflow.state === 'revising' ? WORKFLOW_WORDS.beingRevised
          : WORKFLOW_WORDS.cancelling;
  return (
    <div className={styles.planLock} role="group" aria-label={PLAN_PAGE_WORDS.panel} data-plan-lock={workflow.state} ref={foot}>
      <p className={styles.planLockText} role="status">{words}</p>
      {holder !== null && (workflow.state === 'reviewing' || workflow.state === 'revising') && holder.sessionId !== sessionId && (
        <span className={styles.planMeta}>
          {workflow.state === 'reviewing' ? WORKFLOW_WORDS.reviewSession : WORKFLOW_WORDS.writer}: <ChatLink sessionId={holder.sessionId} chat={holder.chat} here={sessionId} />
        </span>
      )}
      {workflow.state === 'reviewing' && workflow.reviewId !== null && workflow.busy === null && (
        <button type="button" className={styles.button} data-cancel-review="" aria-disabled={busy || undefined} onClick={cancelReview}>{WORKFLOW_WORDS.cancelReview}</button>
      )}
      {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
    </div>
  );
}
