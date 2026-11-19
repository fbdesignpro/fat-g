// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for a review on the page (docs/planning/_archive/M22e.md, Design 3–7; C1, C5, C8, C9, C12, C21,
// C28, C30, C31, C33, C34, C55): the Review popup, the findings list and its controls, the notices
// drawn from the record, the triage panel, the target popup, and the line's and the tab's review
// state. No text of a model's is here, and no finding's: those are the record's, drawn as they are.
import type { SendRefusal } from '@shared/contracts/chat';
import { type BlockProblem, MARK_WORDS, type ReviewCloseRefusal, type ReviewIntegrateRefusal, type ReviewReason, type ReviewSendRefusal, type ReviewStartRefusal, type ReviewSummary, type ReviewWriteRefusal, type SetAside, TIER_NAMES, type Tier } from '@shared/contracts/review';
import { planNamed } from '@shared/contracts/plans';
import type { SendBlock } from '@shared/contracts/sessions';
import { sendRefusalText } from './card-words';

export const REVIEW_WORDS = {
  // ── The Review popup (C1) ──
  review: 'Review by model',
  popup: 'Choose model to use for plan review',
  plan: (title: string, version: number): string => `${planNamed(title)} · v${version}`,
  cost: 'The review is a session of its own, uses the selected account’s usage and runs in its provider’s reading mode. Your CLI’s rules and any allowed MCP tools or hooks still apply.',
  start: 'Start review',
  cancel: 'Cancel',
  starting: 'Starting the review…',
  // Why it cannot start (C1, C52).
  notConnected: 'This chat’s account is not connected.',
  noReadingMode: (provider: string): string => `${provider} lists no reading mode, so no review can run.`,
  readingUnavailable: (provider: string): string => `${provider}’s reading mode is not available to this account.`,
  stale: (version: number): string => `This version has been replaced by v${version}: review that one.`,
  inFlight: 'A review is being started.',
  // The reviewer's first prompt, folded to one line (C53), the plan by its name: "Plan: <title>".
  request: (name: string, version: number): string => `Review request for ${name} · v${version}`,
  // A Send notes prompt, folded to one line naming the findings it sent notes on (C31).
  notesSent: (ids: readonly string[]): string => (ids.length === 0 ? 'Review notes' : `Review notes: ${ids.join(', ')}`),
  // An integration's prompt, folded to one line naming the findings it sent (the maintainer).
  planFeedback: (accepted: readonly string[], refused: readonly string[]): string => {
    const parts = [...(accepted.length === 0 ? [] : [`${accepted.join(', ')} accepted`]), ...(refused.length === 0 ? [] : [`${refused.join(', ')} refused`])];
    return parts.length === 0 ? 'Plan feedback' : `Plan feedback: ${parts.join('; ')}`;
  },

  // ── The findings list (C7, C28, C30, C33, C34) ──
  list: 'Review findings',
  tier: (tier: number): string => `T${tier} ${TIER_NAMES[tier as Tier] ?? ''}`.trim(),
  acceptAll: 'Accept all',
  refuseAll: 'Refuse all',
  acceptAllLabel: (tier: number): string => `Accept all of T${tier}`,
  refuseAllLabel: (tier: number): string => `Refuse all of T${tier}`,
  accept: (id: string): string => `Accept ${id}`,
  refuse: (id: string): string => `Refuse ${id}`,
  explain: (id: string): string => `Explain ${id}`,
  note: (id: string): string => `Note on ${id}`,
  noteField: (id: string): string => `Your note on ${id}`,
  noteSaving: 'Saving the note…',
  revised: 'revised',
  example: 'Example',
  description: 'Description',
  correction: 'Correction',
  anchor: (heading: string, quote: string): string => `${heading} — “${quote}”`,
  markWords: MARK_WORDS,
  integratingIn: (chat: string | null): string => (chat === null ? 'Being integrated in a chat that was removed' : `Being integrated in ${chat === '' ? 'an unnamed chat' : chat}`),
  staleList: (version: number): string => `This review is of an earlier version: v${version} replaced it.`,
  // The findings its answer set aside (the maintainer): those left out, and those that stand as the round before had them.
  leftOut: (entries: readonly SetAside[]): string => `Left out: ${entries.map(setAsideWords).join('; ')}.`,
  keptAsBefore: (ids: readonly string[]): string => `${listed(ids)} could not be read in this answer and ${ids.length === 1 ? 'stands' : 'stand'} as in the round before.`,
  writeFailed: 'fat-g could not save that.',
  notFound: (version: number): string => `The passage was not found in v${version}.`,

  // ── A round's block while its turn waits: never its half-written JSON ──
  creating: 'Creating the review…',
  updating: 'Updating the review…',

  // ── Notices drawn from the record (C5, C55) ──
  waitsOnAnswer: 'The review waits on the answer to this question.',
  noRound: 'No updated review came with this answer: the review above still stands.',
  noRoundBecause: (problem: string): string => `No updated review came with this answer (${problem}): the review above still stands.`,
  failed: (reason: ReviewReason): string => `The review failed: ${FAILURE_WORDS[reason]}`,
  failedBecause: (problem: string): string => `The review failed: ${problem}`,

  // ── Announcements (C21) ──
  arrived: 'The review’s findings arrived.',
  roundArrived: 'An updated review arrived.',
  failedSaid: 'The review failed.',
  noRoundSaid: 'The answer brought no updated review.',
  askedSaid: 'The reviewer asks a question before its review.',

  // ── The triage panel (C8, C31) ──
  panel: 'Review decision',
  counts: (accepted: number, refused: number, undecided: number, notes: number): string => `${accepted} accepted · ${refused} refused · ${undecided} undecided · ${notes === 1 ? '1 note' : `${notes} notes`}`,
  integrate: (count: number): string => (count === 1 ? 'Integrate 1 finding' : `Integrate ${count} findings`),
  integrateNone: 'No finding is accepted: accept one to integrate.',
  waiting: (count: number): string => (count === 1 ? '1 finding waits for a decision' : `${count} findings wait for a decision`),
  sendNotes: 'Send notes',
  sendNotesTip: 'Sends your notes to the reviewer as a new message, using this session’s account.',
  integrateLater: 'Integrate',
  sendFailed: 'fat-g could not send the notes.',
  // A round with no finding (the maintainer): one press closes the review and goes back to its plan.
  clean: 'No findings: the plan passes this review.',
  backToPlan: 'Great! Take me back to the plan',
  // Every finding refused (decision 0029): the same way back, the plan unchanged.
  allRefused: 'Every finding is refused: the plan stays as it is.',
  // A review is a hard stop (the maintainer): it goes on or is cancelled, and is never hidden.
  cancelReview: 'Cancel review',
  running: 'The review is running.',
  asked: 'The reviewer asks a question above: answer it to go on.',
  closeFailed: 'fat-g could not close the review.',

  // ── The target popup (C9, C10, C14) ──
  targets: 'Integrate using…',
  usingOwn: 'The chat that created the plan',
  usingNew: 'A new chat',
  /** The window choosing a new chat's model, which integrates (one way: the target popup is gone). */
  integrateNew: 'Choose model for the new chat',
  sends: (title: string, version: number, count: number, notes: number, account: string | null): string =>
    `Sends ${title} v${version}, ${count === 1 ? '1 finding' : `${count} findings`}${notes === 0 ? '' : notes === 1 ? ' and 1 note' : ` and ${notes} notes`} to that chat${account === null || account === '' ? '' : ` on ${account}`}, spending its usage.`,
  over: (excess: number): string => `The findings and notes are ${excess.toLocaleString('en')} units over what an integration takes.`,
  integrateAction: 'Integrate',
  integrateFailed: 'fat-g could not send the integration.',

  // ── The line and the tab (C12) ──
  reviewing: 'reviewing',
  reviewed: (accepted: number, waiting: number): string => `reviewed: ${accepted} accepted${waiting === 0 ? '' : `, ${waiting} wait`}`,
  reviewedClean: 'reviewed: no findings',
  integrating: 'integrating',
  reviewFailed: 'review failed',
  reviewCancelled: 'review cancelled',
  reviewStale: 'review stale',
  andMore: (count: number): string => `and ${count} more`,
  sessionRemoved: 'its session was removed',
} as const;

const FAILURE_WORDS: Readonly<Record<ReviewReason, string>> = {
  'no-block': 'no findings block',
  several: 'more than one findings block',
  invalid: 'the findings block does not match fat-g’s form',
  // What an earlier build said, kept for the records that hold it: no block is refused for a length now.
  'over-bound': 'a finding was longer than fat-g took then',
  'no-answer': 'no answer came',
  'turn-failed': 'its reply failed',
  stopped: 'its reply was stopped',
  interrupted: 'fat-g was closed while it ran',
  refused: 'its prompt was not sent',
};

/** "T3.4", "T3.4 and T5.1", "T1.1, T3.4 and T5.1". */
function listed(ids: readonly string[]): string {
  return ids.length <= 1 ? ids.join('') : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1) ?? ''}`;
}

/**
 * A finding its answer set aside, and why (the maintainer): by its id where it gave one
 * that reads, else by its place in the list. Nothing of the model's text but that id.
 */
function setAsideWords(one: SetAside): string {
  const name = one.id ?? `finding ${one.position}`;
  switch (one.problem) {
    case 'not-finding': return `${name} is not a finding`;
    case 'id': return `${name} has no id like T1.1`;
    case 'tier': return `${name}’s tier is not the one its id names`;
    case 'category': return `${name} has no category fat-g knows`;
    case 'repeated': return `${name} is given twice, and the first is shown`;
    case 'title':
    case 'example':
    case 'description':
    case 'correction':
      return `${name} has no ${one.problem}`;
  }
}

/**
 * Why a findings block brought no round, as its answer reads now (the maintainer): what
 * a failed review, or an answer that brought no updated one, says in place of the kind alone. `cut`:
 * the answer was cut at the length a message keeps, which is what left its block unreadable.
 */
export function blockProblemWords(problem: BlockProblem, setAside: readonly SetAside[], version: number, cut: boolean): string {
  switch (problem) {
    case 'json': return cut ? 'the answer was cut at the length fat-g keeps, and its findings block with it' : 'the findings block is not valid JSON';
    case 'shape': return 'the findings block is not a JSON object';
    case 'version': return `the findings block is not of version ${version}, the one fat-g asked for`;
    case 'issues': return 'the findings block has no list of findings';
    case 'none-read': return `none of its findings could be read: ${setAside.map(setAsideWords).join('; ')}`;
  }
}

/** One phrase for a review on its plan's line (C12): its state, the newest first. */
export function reviewPhrase(review: ReviewSummary): string {
  if (review.staleBy !== null) return REVIEW_WORDS.reviewStale;
  if (review.integrating) return REVIEW_WORDS.integrating;
  if (review.state === 'running') return REVIEW_WORDS.reviewing;
  if (review.state === 'failed') return REVIEW_WORDS.reviewFailed;
  if (review.closed === 'cancelled') return REVIEW_WORDS.reviewCancelled;
  if (review.findings === 0) return REVIEW_WORDS.reviewedClean;
  return REVIEW_WORDS.reviewed(review.accepted, review.waiting);
}

type Refusal = ReviewStartRefusal | ReviewWriteRefusal | ReviewSendRefusal | ReviewIntegrateRefusal | SendRefusal | SendBlock | 'unknown-finding' | 'unknown-review';

const REFUSAL_WORDS: Readonly<Partial<Record<Refusal, string>>> = {
  'not-pending': 'This plan’s decision no longer waits in this chat.',
  locked: 'Another chat’s decision on this plan came first, or a review or a revision holds it.',
  'not-complete': 'This version of the plan is not complete.',
  stale: 'The plan has a newer version since: review that one.',
  'mode-unavailable': 'The reading mode is not available to this account.',
  'unknown-review': 'This review is no longer held by fat-g.',
  'unknown-finding': 'This finding is no longer in the review.',
  'not-live': 'This review can no longer be changed.',
  'all-decided': 'Every finding is decided: integrate them instead.',
  'no-note': 'Write a note on a finding first.',
  'turn-waiting': 'The reviewer is still working or waiting for an answer.',
  undecided: 'Some findings still wait for a decision.',
  'none-accepted': 'No finding is accepted.',
  integrating: 'This review is being integrated already.',
  'too-long': 'The findings and notes are longer than an integration takes.',
  unavailable: 'That chat cannot take the integration now.',
  // The chosen preset, as a new chat's start refuses it (decision 0016).
  'provider-not-offered': 'This project is not set up for that provider.',
  'provider-unavailable': 'That provider is switched off in Settings.',
  'instance-unavailable': 'That account is switched off or no longer set up in Settings.',
  'model-not-listed': 'That model is no longer listed.',
  'effort-not-listed': 'That model no longer has this effort level.',
  'speed-not-listed': 'That model no longer has this speed.',
  'speed-unavailable': 'fat-g cannot ask that account for this speed.',
};

/** Why a review was not closed, in fat-g's words (decision 0029). */
export function reviewCloseText(reason: ReviewCloseRefusal): string {
  switch (reason) {
    case 'unknown-review': return 'This review is no longer held by fat-g.';
    case 'not-open': return 'This review is closed already.';
    case 'not-concludable': return 'A finding is still open or accepted.';
    case 'busy': return 'The review is being closed, or fat-g is closing.';
    case 'storage-failed': return REVIEW_WORDS.closeFailed;
  }
}

/** Why a review's action was refused, in fat-g's words: the send's own as a send's. */
export function reviewRefusalText(reason: Refusal, provider: string): string {
  return REFUSAL_WORDS[reason] ?? sendRefusalText(reason as SendRefusal | SendBlock, provider);
}
