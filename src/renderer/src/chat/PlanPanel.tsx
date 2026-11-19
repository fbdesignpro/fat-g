// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useId, useRef, useState } from 'react';
import { modeOf } from '@shared/contracts/permissions';
import { MAX_FEEDBACK_TEXT, planTurnBlocked, type PlanDecideRequest, type PlanDecideResult } from '@shared/contracts/plans';
import type { SessionEntry } from '@shared/contracts/sessions';
import { type WorkflowView, WORKFLOW_WORDS } from '@shared/contracts/workflow';
import { openPlan } from '../artifacts/opener';
import { invoke } from '../ipc/client';
import { sessionAccount, usePermissions } from '../session-area/selected';
import { useAppState } from '../state/store';
import { LightBulbIcon, TrashIcon } from '../ui/icons';
import { NameTip, useNameTip } from '../ui/Tooltip';
import { useFootFocus } from './foot-focus';
import { choosePlan } from './composer/composer-store';
import { planDecideText, PLAN_PAGE_WORDS } from './plan-words';
import { MISSING, planName, usePlanInfo } from './plans-store';
import { focusPrompt } from './prompt-focus';
import { ReviewPopup } from './ReviewPopup';
import { REVIEW_AVAILABLE } from './review-availability';
import styles from './Chat.module.css';

export interface PlanPanelProps {
  readonly entry: SessionEntry;
  /** The plan's workflow, ready on the version every decision stands on. */
  readonly workflow: WorkflowView & { readonly version: number };
  /** The chat's turn holds the plan's request on that version: its decision is taken while the turn runs. */
  readonly holdsRequest: boolean;
  readonly providerName: string;
}

/**
 * The decision on a plan (docs/planning/_archive/M22b.md, Design 7; C11, C12, C15, C24, C58, C72; decision
 * 0029), in place of the prompt-type bar and the input while the chat takes part in a plan that is
 * ready. It stands on the plan's workflow, shared by every chat taking part, and so on its latest
 * complete version whichever chat wrote it. Two columns, as the maintainer's reference has them
 *. On the left the plan's box — a light bulb and "Plan: <title> (v<n>)", the version the
 * decision stands on, inverted as its line in the chat is — a button that opens its tab; under it
 * "Send feedback / notes & update plan:", a text area with its own Send — disabled with its reason
 * where the chat's mode, or its account's CLI, takes no plan turn now (C72). On the right Leave plan
 * mode, keep plan, which takes this chat out and keeps the plan for the others, beside a trash button,
 * Discard plan — the plan discarded in every chat, and deleted; then Review by model; then Execute,
 * which runs under the chat's own mode, named in the menu above, where it may change while the plan
 * is ready.
 *
 * Each decision names the plan and the workflow's revision it was drawn from: one another chat's
 * decision overtook is refused, and the panel shows where the plan stands now. Nothing is focused
 * when it comes, and Escape does nothing here: the decision is the user's, and no key takes it.
 */
export function PlanPanel({ entry, workflow, holdsRequest, providerName }: PlanPanelProps) {
  const { record } = entry;
  const { planId, version } = workflow;
  const info = usePlanInfo(planId);
  const permissions = usePermissions(record.providerId);
  const providers = useAppState((state) => state.snapshot?.providers);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const foot = useFootFocus();
  const feedbackId = useId();
  const discard = useRef<HTMLButtonElement>(null);
  const discardTip = useNameTip();
  // Show the plan when its decision appears, and again when a newer version replaces it, including
  // after returning to a chat or restarting. Only the decision's identity triggers this, so later
  // renders leave the user's tab choice alone.
  useEffect(() => { openPlan(record.id, planId, null, version); }, [record.id, planId, version]);
  const title = info === MISSING ? PLAN_PAGE_WORDS.removed : info?.title ?? PLAN_PAGE_WORDS.untitled;
  const mode = entry.mode === null ? null : modeOf(permissions, entry.mode.id)?.label ?? entry.mode.id;
  const { account } = sessionAccount(providers, record);
  // Feedback is a plan turn (C15): where the chat's mode, or the account's CLI, takes none, it waits — Execute does not.
  const capability = providers?.find((provider) => provider.id === record.providerId)?.descriptor.capabilities.plans;
  const feedbackBlocked = planTurnBlocked(capability, entry.mode?.id ?? null, account?.plans, providerName);
  // A request's decision is taken while its turn runs (C11); any other waits for the turn's end (C24).
  const waitsTurn = !holdsRequest && entry.summary.status === 'running';
  // A mode that reads only carries out no plan (C81): Execute is not offered there.
  const readsOnly = entry.mode !== null && modeOf(permissions, entry.mode.id)?.reading === true;
  // Work on the plan under way — a review being made, a request being retired — holds every decision a moment.
  const held = workflow.busy !== null;

  const decide = (decision: 'feedback' | 'execute' | 'cancel' | 'leave'): void => {
    if (busy || held) return;
    setBusy(true);
    setProblem(null);
    const base = { sessionId: record.id, planId, revision: workflow.revision };
    const request: PlanDecideRequest = decision === 'feedback' ? { ...base, decision, text: feedback } : { ...base, decision };
    invoke('plans:decide', request).then(
      (answer: PlanDecideResult) => {
        if (answer.status === 'decided') {
          if (decision === 'feedback') setFeedback('');
          // Execute, Discard and Leave end the planning choice, including the draft kept for the next prompt.
          if (decision !== 'feedback') choosePlan(record.id, false);
          // The composer comes back in the panel's place and takes the keyboard (C24), as after a question's answer (M100b, C61).
          focusPrompt(record.id);
          return;
        }
        setProblem(planDecideText(answer.reason, providerName));
      },
      () => { setProblem(PLAN_PAGE_WORDS.failed); },
    ).finally(() => { setBusy(false); });
  };

  // A feedback past the bound stays whole in its field, said, and is not sent until it fits (the maintainer).
  const over = feedback.length - MAX_FEEDBACK_TEXT;
  const canFeedback = feedbackBlocked === null && feedback.trim() !== '' && over <= 0;
  const described = [...(over > 0 ? [`${feedbackId}-over`] : []), ...(feedbackBlocked === null ? [] : [`${feedbackId}-why`])].join(' ');
  // A decision on its way makes no button disabled, only said unavailable: a disabled button drops the focus to the page's body,
  // where the panel could not hand it on (as the question card's buttons, M100b).
  const waiting = busy || held || undefined;
  return (
    <div className={styles.planPanel} role="group" aria-label={PLAN_PAGE_WORDS.panel} data-plan-panel={planId} data-plan-version={version} ref={foot}>
      <div className={styles.planPanelMain}>
        <button type="button" className={styles.planBox} data-plan-open="" disabled={info === MISSING} onClick={() => openPlan(record.id, planId, title, version)}>
          <LightBulbIcon />
          <span className={styles.planBoxName}>{PLAN_PAGE_WORDS.titled(planName(info), version)}</span>
        </button>
        <label className={styles.planFeedbackLabel} htmlFor={feedbackId}>{PLAN_PAGE_WORDS.feedbackLabel}</label>
        <div className={`${styles.inputBox} ${styles.planFeedbackBox}`}>
          <textarea
            id={feedbackId}
            className={styles.input}
            value={feedback}
            aria-describedby={described === '' ? undefined : described}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <div className={styles.inputFoot}>
            <span />
            <button type="button" className={styles.button} data-plan-feedback="" disabled={!canFeedback || waitsTurn} aria-disabled={waiting} onClick={() => decide('feedback')}>{PLAN_PAGE_WORDS.sendFeedback}</button>
          </div>
        </div>
        {held && <p className={styles.status} role="status" data-plan-busy={workflow.busy ?? undefined}>{workflow.busy === 'starting' ? WORKFLOW_WORDS.starting : workflow.busy === 'cancelling' ? WORKFLOW_WORDS.cancelling : WORKFLOW_WORDS.retiring}</p>}
        {readsOnly && mode !== null && <p id={`${feedbackId}-execute`} className={styles.status} data-plan-reads-only="">{PLAN_PAGE_WORDS.readsOnly(mode)}</p>}
        {over > 0 && <p id={`${feedbackId}-over`} className={styles.problem} data-plan-feedback-over="">{PLAN_PAGE_WORDS.feedbackTooLong(over)}</p>}
        {feedbackBlocked !== null && <p id={`${feedbackId}-why`} className={styles.status}>{feedbackBlocked}</p>}
        {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
      </div>
      <div className={styles.planPanelSide}>
        <div className={styles.planPanelSideTop}>
          <button type="button" className={`${styles.button} ${styles.planLeave}`} data-plan-leave="" aria-disabled={waiting} onClick={() => decide('leave')}>{PLAN_PAGE_WORDS.leave}</button>
          <button ref={discard} type="button" className={`${styles.button} ${styles.planDiscard}`} data-plan-cancel="" aria-label={PLAN_PAGE_WORDS.cancel} aria-disabled={waiting} {...discardTip.targetProps} onClick={() => decide('cancel')}><TrashIcon /></button>
          <NameTip open={discardTip.open} anchor={discard}>{PLAN_PAGE_WORDS.cancel}</NameTip>
        </div>
        {/* Review by model (M22e, C1): the plan's version sent to a reviewer on the preset the user chooses, the chat's to start with. */}
        {REVIEW_AVAILABLE && <ReviewPopup entry={entry} planId={planId} version={version} revision={workflow.revision} title={title} providerName={providerName} />}
        <button type="button" className={`${styles.button} ${styles.planExecute}`} data-plan-execute="" disabled={waitsTurn || readsOnly} aria-disabled={waiting} aria-describedby={readsOnly ? `${feedbackId}-execute` : undefined} onClick={() => decide('execute')}>{PLAN_PAGE_WORDS.execute}</button>
      </div>
    </div>
  );
}
