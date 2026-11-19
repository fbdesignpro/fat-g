// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import { planTurnBlocked } from '@shared/contracts/plans';
import type { SessionEntry } from '@shared/contracts/sessions';
import { sessionAccount } from '../session-area/selected';
import { useAppState } from '../state/store';
import { type TipClear, type TipSide, Tooltip, useTooltip } from '../ui/Tooltip';
import { newSideQuestion } from './aside-actions';
import { useAsides } from './asides-store';
import { PLAN_PENDING_TEXT, runningWords } from './card-words';
import { useFootFocus } from './foot-focus';
import { PlanReview } from './PlanReview';
import { REVIEW_AVAILABLE } from './review-availability';
import { choosePlan } from './composer/composer-store';
import { usePromptType } from './prompt-type-store';
import styles from './Chat.module.css';

export const TOOLBAR_WORDS = {
  label: 'Session actions',
  plan: 'Plan',
  /** The Plan button's tooltip, where the chat takes a plan turn. */
  planTip: 'Enter plan mode: the agent looks into the project and proposes a plan, changing nothing until you approve it.',
  review: 'Review',
  /** What a button no milestone has wired yet says, on hover and on focus (M100, C38). */
  later: 'Not available yet: this comes in a later version of fat-g.',
  sideQuestion: 'Side question',
} as const;

const TOOL = '[data-tool]';

/** Plan's tooltips stand above the chat's status bar, not over it (the maintainer). */
const aboveStatusBar: TipClear = (target) => target.closest('[data-prompt-area]')?.querySelector('[data-status-bar]') ?? null;

/**
 * The prompt-type bar (docs/planning/_archive/M100.md, Design 7; C37–C39, C58), under the status bar: what
 * kind of prompt the next one is, and the session's other interactions. Plan, Review
 * and Side question run from the left, with the permission mode sharing the row at the right.
 *
 * Plan is pressable: its state is the session's for the run, kept in the page, and the next prompt
 * is a plan turn while it is pressed (M22b, C1). Where the chat's mode, or its account's CLI, takes
 * no plan turn it is announced as unavailable, still reachable, its tooltip saying why (C5, C13,
 * C70), and drawn unpressed as every unavailable button is (the maintainer's review): the
 * next prompt is no plan turn there. The choice is kept as the user left it, and shows again where
 * the chat plans. A successful Execute plan or Cancel releases Plan for normal follow-ups.
 * Review opens the project's plans directly (M22b, C64, C67).
 * Spec sheet is deferred until its workflow is implemented.
 *
 * Side question opens a new, empty tab directly, with the focus in its field. It is shown only
 * where the session's provider offers its interaction.
 *
 * To the keyboard the actions are one stop, with Left and Right among them (M20b, C67). On narrow
 * columns the actions scroll horizontally, keeping the mode reachable on the same row.
 */
export function Toolbar({ sessionId, entry, providerName = '', onProblem, modeControl }: {
  readonly sessionId: string;
  /** The session's entry (M22b): what says whether it takes a plan turn now, and whose project's plans Review lists. */
  readonly entry?: SessionEntry;
  readonly providerName?: string;
  /** Said under the bar: why a plan was not brought into the chat. */
  readonly onProblem?: (text: string | null) => void;
  readonly modeControl?: ReactNode;
}) {
  const foot = useFootFocus();
  const mine = useAsides((state) => state.sessionId === sessionId);
  const offered = useAsides((state) => state.asking !== 'none');
  const problem = useAsides((state) => state.problem);
  const plan = usePromptType(sessionId) === 'plan';
  const providers = useAppState((state) => state.snapshot?.providers);
  // Why the chat takes no plan turn now (M22b, C5, C13, C70), or null: its provider's word for its mode, and its account's CLI's.
  const capability = entry === undefined ? undefined : providers?.find((provider) => provider.id === entry.record.providerId)?.descriptor.capabilities.plans;
  const planBlocked = entry === undefined ? null : planTurnBlocked(capability, entry.mode?.id ?? null, sessionAccount(providers, entry.record).account?.plans, providerName);
  // Why a plan cannot be brought in now (C64): a decision waits, or a turn runs.
  const reviewBlocked = entry === undefined ? null : entry.planPending === true ? PLAN_PENDING_TEXT : entry.summary.status === 'running' ? runningWords(providerName) : null;
  const reviews = entry !== undefined && capability != null;
  // The button the bar's one stop is on: the last one focused, or the first.
  const [current, setCurrent] = useState('plan');
  const sideQuestion = mine && offered;
  const tools = ['plan', ...(REVIEW_AVAILABLE ? ['review'] : []), ...(sideQuestion ? ['side-question'] : [])];
  const stop = tools.includes(current) ? current : 'plan';

  /** Left and Right move among the bar's buttons, which are one stop together. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const found = [...event.currentTarget.querySelectorAll<HTMLElement>(TOOL)];
    const at = found.findIndex((tool) => tool === document.activeElement);
    if (at === -1 || found.length < 2) return;
    event.preventDefault();
    found[(at + (event.key === 'ArrowRight' ? 1 : -1) + found.length) % found.length]?.focus();
  };

  const tool = (id: string) => ({ 'data-tool': id, tabIndex: id === stop ? 0 : -1, onFocus: () => setCurrent(id) });

  return (
    <div className={styles.promptTypes} ref={foot}>
      <div className={styles.promptControls} data-prompt-controls="">
        <div className={styles.toolbar} role="toolbar" aria-label={TOOLBAR_WORDS.label} onKeyDown={onKeyDown}>
          {planBlocked === null ? (
            <PlanButton {...tool('plan')} pressed={plan} onClick={() => choosePlan(sessionId, !plan)} />
          ) : (
            <LaterButton {...tool('plan')} toggle words={planBlocked} side="above" clear={aboveStatusBar}><PromptActionLabel>{TOOLBAR_WORDS.plan}</PromptActionLabel></LaterButton>
          )}
          {REVIEW_AVAILABLE && (reviews ? (
            <PlanReview sessionId={sessionId} projectId={entry.record.projectId} providerName={providerName} blocked={reviewBlocked} tool={tool('review')} onProblem={(text) => onProblem?.(text)} />
          ) : (
            <LaterButton {...tool('review')}>
              <PromptActionLabel>{TOOLBAR_WORDS.review}</PromptActionLabel>
            </LaterButton>
          ))}
          {sideQuestion && (
            <button onClick={() => newSideQuestion(sessionId)} {...tool('side-question')} type="button" className={styles.promptToolButton}>
              <PromptActionLabel>{TOOLBAR_WORDS.sideQuestion}</PromptActionLabel>
            </button>
          )}
        </div>
        {modeControl}
      </div>
      {mine && problem !== null && <p className={styles.problem} role="status">{problem}</p>}
    </div>
  );
}

/** Decorative slashes stay out of each action's accessible name. */
function PromptActionLabel({ children }: { readonly children: ReactNode }) {
  return <><span aria-hidden="true" data-action-prefix="">// </span><span data-action-label="">{children}</span></>;
}

/** Plan where the chat takes a plan turn: a toggle, its tooltip saying what plan mode is. */
function PlanButton({ pressed, onClick, ...tool }: {
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly 'data-tool': string;
  readonly tabIndex: number;
  readonly onFocus: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  const { onFocus, ...targetProps } = tooltip.targetProps;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.promptToolButton}
        aria-pressed={pressed}
        onClick={onClick}
        {...tool}
        {...targetProps}
        onFocus={() => {
          onFocus();
          tool.onFocus();
        }}
      >
        <PromptActionLabel>{TOOLBAR_WORDS.plan}</PromptActionLabel>
      </button>
      <Tooltip id={tooltip.id} open={tooltip.open} anchor={anchor} side="above" clear={aboveStatusBar}>
        {TOOLBAR_WORDS.planTip}
      </Tooltip>
    </>
  );
}

/**
 * A button no milestone has wired yet (C38, C41): in its place, dimmed, announced as unavailable and
 * still focusable, its tooltip — its description — saying it comes later. A toggle among toggles
 * says it is not pressed.
 */
export function LaterButton({ children, toggle = false, className = styles.promptToolButton, words = TOOLBAR_WORDS.later, label, side, clear, ...tool }: {
  readonly children: ReactNode;
  readonly toggle?: boolean;
  readonly className?: string | undefined;
  readonly words?: string;
  /** Where its tooltip stands; left out, below. */
  readonly side?: TipSide;
  readonly clear?: TipClear;
  readonly label?: string;
  readonly 'data-tool'?: string;
  readonly tabIndex?: number;
  readonly onFocus?: () => void;
  readonly onClick?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  const { onFocus, ...targetProps } = tooltip.targetProps;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={className}
        aria-disabled="true"
        aria-pressed={toggle ? false : undefined}
        aria-label={label}
        {...tool}
        {...targetProps}
        onFocus={() => {
          onFocus();
          tool.onFocus?.();
        }}
      >
        {children}
      </button>
      <Tooltip id={tooltip.id} open={tooltip.open} anchor={anchor} side={side} clear={clear}>
        {words}
      </Tooltip>
    </>
  );
}
