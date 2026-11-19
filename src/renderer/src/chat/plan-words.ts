// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for a plan in the chat (docs/planning/_archive/M22b.md, Design 7; C21, C23–C25, C64, C67,
// C72, C73): its line, the decision's panel, Review existing plan and the plan's tab. No text of a
// plan's is here: a plan is named by its title, which main gives.
import { MAX_FEEDBACK_TEXT, type PlanBringRefusal, type PlanDecideRefusal, planNamed } from '@shared/contracts/plans';
import type { SendRefusal } from '@shared/contracts/chat';
import type { SendBlock } from '@shared/contracts/sessions';
import { PLAN_PENDING_TEXT, sendRefusalText } from './card-words';

export const PLAN_PAGE_WORDS = {
  plan: 'Plan',
  /** A plan main no longer holds (C18, C73): removed. */
  removed: 'A removed plan',
  untitled: 'Plan',
  /** A plan named on a button or a tab (M22e): "Plan: <title>", never "Plan: Plan: …". */
  named: planNamed,
  /** A plan prompt's fold of the text it carried, beside the plan's own button. */
  sentText: (version: number): string => `Plan as sent · v${version}`,
  /** A plan feedback's fold of fat-g's request with the user's words, as sent (the maintainer). */
  feedbackSent: 'Feedback as sent',
  version: (version: number): string => `v${version}`,
  /** A plan's name with the version it stands on, in its box (the maintainer). */
  titled: (name: string, version: number): string => `${name} (v${version})`,
  /** A plan's line while Codex writes it, after its name in the dashed box. */
  writing: 'being written…',
  brought: 'brought',
  /** The decision panel (C24). */
  panel: 'Plan decision',
  execute: 'Execute',
  /** Discards the plan in every chat (the maintainer): it is then deleted. The trash button's name. */
  cancel: 'Discard plan',
  /** Takes this chat out of the plan and keeps it for the others, and in Review existing plan. */
  leave: 'Leave plan mode, keep plan',
  feedbackLabel: 'Send feedback / notes & update plan:',
  sendFeedback: 'Send',
  /** A feedback past what fat-g sends (the maintainer): kept whole in its field, and said, never cut. */
  feedbackTooLong: (over: number): string => `This is ${over.toLocaleString('en')} characters longer than the ${MAX_FEEDBACK_TEXT.toLocaleString('en')} fat-g sends. Shorten it to send it.`,
  /** Execute is not offered under a mode that reads only (C81): what to do instead (decision 0029). */
  readsOnly: (mode: string): string => `${mode} can’t carry out a plan. To execute it, choose a mode that acts in the menu above.`,
  /** Review by model, drawn for M22e (S3, C24). */
  review: 'Review by model',
  reviewLater: 'Review by model comes in a later version of fat-g.',
  /** Review existing plan (C64, C67). */
  reviewMenu: 'Review',
  reviewExisting: 'Review existing plan',
  list: 'This project’s plans',
  listEmpty: 'This project has no plan yet.',
  listNoComplete: 'This project has no complete plan to review yet.',
  listFailed: 'fat-g could not list this project’s plans.',
  listLoading: 'Reading the plans…',
  madeBy: (provider: string, model: string): string => `${provider}, ${model}`,
  madeIn: (chat: string | null): string => (chat === null ? 'its chat was removed' : chat === '' ? 'in an unnamed chat' : `in ${chat}`),
  unfinished: 'unfinished',
  failed: 'fat-g could not take the decision.',
  bringFailed: 'fat-g could not bring the plan into this chat.',
} as const;

/** Why a decision was not taken, in fat-g's words (C12, C72): the line's push says what it became. */
export function planDecideText(reason: PlanDecideRefusal | SendRefusal | SendBlock, provider: string): string {
  if (reason === 'unknown-item' || reason === 'not-pending') return 'This plan’s decision was taken already, or work continued without one.';
  if (reason === 'unknown-plan') return 'This plan was removed.';
  if (reason === 'not-participant') return 'This chat no longer takes part in this plan.';
  if (reason === 'stale' || reason === 'locked') return 'Another chat’s decision on this plan came first, or a review or a revision holds it: the panel shows where it stands now.';
  if (reason === 'unknown-session') return 'This session is no longer listed.';
  if (reason === 'busy') return 'This session is being removed, or fat-g is closing, so nothing was decided.';
  if (reason === 'reads-only') return 'This chat’s mode can’t carry out a plan.';
  return sendRefusalText(reason, provider);
}

/** Why a plan was not brought into the chat, in fat-g's words (C64). */
const BRING_WORDS: Readonly<Partial<Record<PlanBringRefusal, string>>> = {
  'unknown-plan': 'This plan was removed.',
  'other-project': 'This plan is another project’s.',
  'not-complete': 'This plan has no complete version to bring.',
  stale: 'This plan changed since the list was read: open the list again.',
  'plan-pending': PLAN_PENDING_TEXT,
  'unknown-session': 'This session is no longer listed.',
};

export function planBringText(reason: PlanBringRefusal | SendRefusal | SendBlock, provider: string): string {
  const own = (BRING_WORDS as Readonly<Record<string, string | undefined>>)[reason];
  return own ?? sendRefusalText(reason as SendRefusal | SendBlock, provider);
}
