// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from 'react';
import type { PlanSummary } from '@shared/contracts/plans';
import { openPlan } from '../artifacts/opener';
import { invoke, subscribe } from '../ipc/client';
import { useAppState } from '../state/store';
import { menuStyles, Popup } from '../ui/Popup';
import { formatDateTime } from '../ui/format';
import { useMenu } from '../ui/useMenu';
import { planBringText, PLAN_PAGE_WORDS } from './plan-words';
import { usePlans } from './plans-store';
import styles from './Chat.module.css';

export interface PlanReviewProps {
  readonly sessionId: string;
  readonly projectId: string;
  readonly providerName: string;
  /** Why the chat cannot take a plan now, in words, or null: a decision waits, a turn runs. Said in the list, which still shows the plans. */
  readonly blocked: string | null;
  /** The toolbar's own: the button is one of its stops. */
  readonly tool: { readonly 'data-tool': string; readonly tabIndex: number; readonly onFocus: () => void };
  /** Said under the bar: why a plan was not brought. */
  readonly onProblem: (text: string | null) => void;
}

/**
 * The toolbar's Review menu (docs/planning/_archive/M22b.md, Design 7; C64, C67) opens
 * the project's plans directly, newest first, each row naming its title, when its
 * latest complete version came, its provider and model, and the chat that made it — named, or said
 * removed. Choosing one brings that version into this chat, on either provider (C64), where main
 * opens its line and the page its tab. Where the chat cannot take a plan now, the list says why and
 * its rows do nothing. The list is read each time it opens: main's registry is read from the plan
 * store, so a plan stays listed when every chat that made it is gone (C63). The button is unavailable
 * until a complete version exists in this project; plan pushes and removals refresh that check.
 */
export function PlanReview({ sessionId, projectId, providerName, blocked, tool, onProblem }: PlanReviewProps) {
  const { open, close, button, menu, buttonProps, menuProps } = useMenu();
  const [plans, setPlans] = useState<readonly PlanSummary[] | 'failed' | null>(null);
  const [availability, setAvailability] = useState<{ readonly projectId: string; readonly reason: string | null }>({ projectId, reason: PLAN_PAGE_WORDS.listLoading });
  const listRevision = usePlans((state) => state.listRevision);
  const listRequest = useRef(0);
  const providers = useAppState((state) => state.snapshot?.providers);
  const reason = availability.projectId === projectId ? availability.reason : PLAN_PAGE_WORDS.listLoading;
  // A failed check keeps the existing menu reachable, so the user can retry its list.
  const disabled = reason !== null && reason !== PLAN_PAGE_WORDS.listFailed;

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      const request = ++listRequest.current;
      invoke('plans:list', { projectId }).then(
        (answer) => {
          if (active && request === listRequest.current) setAvailability({ projectId, reason: unavailableReason(answer.plans) });
        },
        () => { if (active && request === listRequest.current) setAvailability({ projectId, reason: PLAN_PAGE_WORDS.listFailed }); },
      );
    };
    const unsubscribe = subscribe('plans:changed', (push) => { if (push.partial === undefined) refresh(); });
    refresh();
    return () => { active = false; listRequest.current += 1; unsubscribe(); };
  }, [projectId, listRevision]);

  useEffect(() => { if (disabled && open) close(true); }, [disabled, open, close]);

  // A closed list is read afresh on its next opening.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setPlans(null);
  }
  const listed = plans !== null && plans !== 'failed' ? plans : null;
  // Once loaded, the list focuses its first row, or the list itself.
  useEffect(() => {
    if (!open || plans === null) return;
    (menu.current?.querySelector<HTMLElement>('[role="menuitem"]') ?? menu.current)?.focus();
  }, [open, plans, menu]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const request = ++listRequest.current;
    invoke('plans:list', { projectId }).then((answer) => {
      if (!active) return;
      setPlans(answer.plans);
      if (request === listRequest.current) setAvailability({ projectId, reason: unavailableReason(answer.plans) });
    }, () => { if (active) setPlans('failed'); });
    return () => { active = false; };
  }, [open, projectId]);

  const bring = (plan: PlanSummary): void => {
    if (plan.complete === null || blocked !== null) return;
    const { version, hash } = plan.complete;
    close(true);
    onProblem(null);
    invoke('plans:bring', { sessionId, planId: plan.planId, version, hash }).then(
      (answer) => {
        if (answer.status === 'brought') { openPlan(sessionId, plan.planId, plan.title, version); return; }
        onProblem(planBringText(answer.reason, providerName));
      },
      () => { onProblem(PLAN_PAGE_WORDS.bringFailed); },
    );
  };

  const providerOf = (id: string): string => providers?.find((provider) => provider.id === id)?.displayName ?? id;
  return (
    <>
      <button
        {...buttonProps} {...tool} type="button" className={styles.promptToolButton}
        aria-disabled={disabled || undefined} title={reason ?? undefined}
        onClick={(event) => { if (!disabled) buttonProps.onClick(event); }}
        onKeyDown={(event) => { if (!disabled) buttonProps.onKeyDown(event); }}
      >
        <span aria-hidden="true" data-action-prefix="">// </span><span data-action-label="">{PLAN_PAGE_WORDS.reviewMenu}</span>
      </button>
      {open && (
        // Place the loaded list again so a long list opens above the button at the window's foot.
        <Popup key={plans === null ? 'loading' : 'listed'} anchor={button} align="end">
          <div {...menuProps} aria-label={PLAN_PAGE_WORDS.list} className={`${menuStyles.menu} ${styles.planList}`}>
            {blocked !== null && <p className={menuStyles.menuNote} role="note">{blocked}</p>}
            {plans === null && <p className={menuStyles.menuNote} role="status">{PLAN_PAGE_WORDS.listLoading}</p>}
            {plans === 'failed' && <p className={menuStyles.menuNote} role="status">{PLAN_PAGE_WORDS.listFailed}</p>}
            {listed !== null && listed.length === 0 && <p className={menuStyles.menuNote}>{PLAN_PAGE_WORDS.listEmpty}</p>}
            {listed?.map((plan) => {
              const shown = plan.complete ?? plan.latest;
              return (
                <button
                  key={plan.planId}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={menuStyles.item}
                  data-plan-row={plan.planId}
                  aria-disabled={plan.complete === null || blocked !== null || undefined}
                  onClick={() => bring(plan)}
                >
                  <span>{plan.title}</span>
                  <small className={menuStyles.note}>
                    {[formatDateTime(shown.at), PLAN_PAGE_WORDS.madeBy(providerOf(shown.providerId), shown.model), PLAN_PAGE_WORDS.madeIn(shown.chat), ...(plan.complete === null ? [PLAN_PAGE_WORDS.unfinished] : [])].join(' · ')}
                  </small>
                </button>
              );
            })}
          </div>
        </Popup>
      )}
    </>
  );
}

function unavailableReason(plans: readonly PlanSummary[]): string | null {
  return plans.some((plan) => plan.complete !== null) ? null : plans.length === 0 ? PLAN_PAGE_WORDS.listEmpty : PLAN_PAGE_WORDS.listNoComplete;
}
