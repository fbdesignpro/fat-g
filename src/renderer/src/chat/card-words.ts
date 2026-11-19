// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for a question's card (docs/planning/_archive/M21.md, Design 7; C37–C46, C74): who asks and
// how, what its fields are called, what it says of an answer it cannot take, and the line a raised
// question posts. An outcome's words are the contract's (`outcomeWords`), which main's tests share.
// None of it is the question's own text: that is the conversation's, and is drawn as it came.
//
// A Send's refusals are worded here too, for the input row, a card's answer and an aside's question
// alike: the two that a change of mode and a sandbox setup add among them (docs/planning/_archive/M22.md,
// Design 3, 7; C62, C90). An approval's card has its own words, in approval-words.ts.
import { COMPOSER_WORDS } from '@shared/contracts/composer';
import { type AnswerRefusal, blockWords, CHAT_LINES, type SendRefusal } from '@shared/contracts/chat';
import { type InteractionAnswer, type InteractionMode, type InteractionOutcome, type InteractionQuestion, NO_ANSWER } from '@shared/contracts/interaction';
import { MODE_WORDS } from '@shared/contracts/permissions';
import type { SendBlock } from '@shared/contracts/sessions';

export const CARD_WORDS = {
  /** A worker's card names it so, with its label where it has one (C37). */
  subAgent: 'Sub-agent',
  /** The field beside a question's options (C37). */
  somethingElse: 'Something else',
  /** The field of a question that has no options. */
  answer: 'Your answer',
  /** A secret's field (C44): what is typed is masked, and never kept. */
  secret: 'Your answer, hidden as you type',
  /**
   * The foot's two buttons (M100b, C41): "all" where the request has several questions, since each
   * sends or declines every one of them. Decline declines the whole request to the CLI on a blocking
   * card, and folds an async one away (C21, C32).
   */
  submit: (count: number): string => (count === 1 ? 'Submit' : 'Submit all'),
  decline: (count: number): string => (count === 1 ? 'Decline' : 'Decline all'),
  /** The header (M100b, C3): the request's number of questions, with an initial capital. */
  count: (count: number): string => (count === 1 ? '1 Question' : `${count} Questions`),
  showAnswers: 'Show questions and answers',
  hideAnswers: 'Hide questions and answers',
  /** A settled card's header (M100b, C64): its count, and how it ended in a word or two — never a time out, which no provider gives. */
  settled: (count: number, outcome: InteractionOutcome): string => {
    const end = { answered: 'Answered', dismissed: 'Declined', passed: 'Passed over', withdrawn: 'Withdrawn', dropped: 'Not answered', pending: null, open: null }[outcome];
    return end === null ? CARD_WORDS.count(count) : `${CARD_WORDS.count(count)} — ${end}`;
  },
  /** The stepper (M100b, C51): its group's name, a question's box by what it shows, and its two buttons. */
  placeName: (at: number, of: number): string => `Question ${at} of ${of}`,
  boxName: (at: number, box: 'answered' | 'seen' | 'unseen'): string => `Question ${at}: ${box === 'answered' ? 'answered' : box === 'seen' ? 'not answered' : 'not seen yet'}`,
  previous: 'Previous',
  next: 'Next',
  /** Under a question whose options may each be chosen (M100b, C49): what tells it from a single choice. */
  several: 'Choose one or more',
  /** A question cut at its bounds (C46): it is answered all the same. */
  cut: 'This question was shortened to fit; something else stands for the options not shown.',
  /** A secret's answer, as a settled card shows it (C44). */
  secretGiven: 'A secret answer was given',
  /** A question left without an answer (C45; M100b, C30): what was sent for it, and what a settled card shows. */
  notAnswered: NO_ANSWER,
  /** A card with nothing chosen and nothing typed (M100b, C30): Decline stands for none. */
  nothing: 'Choose or type an answer first.',
  /** Under an async card's Submit while its turn runs and takes a message (M23, C45). */
  intoTurn: (provider: string): string => `${provider} is still working: Submit sends your answer while it prepares its reply.`,
  failed: 'fat-g could not send the answer.',
  dismissFailed: 'fat-g could not decline the question.',
  /** A worker's row in the chat, while a question of its waits (C42). */
  rowWaits: 'waits for your answer',
  /** The same row, while an approval of its waits and no question does (M22, C36). */
  rowWaitsApproval: 'waits for your approval',
} as const;

/** Who asks, in a worker's tab (C37): "Sub-agent", with its label. */
export function subAgentName(label: string | null): string {
  return label === null || label === '' ? CARD_WORDS.subAgent : `${CARD_WORDS.subAgent} ${label}`;
}

/** The card's head line (C37): who asks, and the mode in words. A blocking question that is settled is asked no more. */
export function headWords(who: string, mode: InteractionMode, waiting: boolean): string {
  if (mode === 'async') return `${who} asked a question and went on`;
  return waiting ? `${who} asks a question` : `${who} asked a question`;
}

/** What a raised blocking question posts to the chat's status region, once (C43, C74). */
export function raisedWords(who: string): string {
  return `${who} asks a question`;
}

/** An answer as a settled card shows it under its question (C39): the chosen labels and the typed text, each on a line; a secret's as the fact alone. */
export function answerLines(question: Pick<InteractionQuestion, 'options'>, answer: InteractionAnswer | null): string[] {
  if (answer === null) return [CARD_WORDS.notAnswered];
  if (answer.secret) return [CARD_WORDS.secretGiven];
  const lines = [...answer.options.flatMap((place) => { const label = question.options[place]?.label; return label === undefined ? [] : [label]; }), ...(answer.text === null || answer.text === '' ? [] : [answer.text])];
  return lines.length === 0 ? [CARD_WORDS.notAnswered] : lines;
}

function refusalWords(reason: SendRefusal, provider: string): string {
  switch (reason) {
    case 'unconfirmed': return CHAT_LINES.unconfirmed(provider);
    case 'running': return 'This chat is still working. Send again once it has finished.';
    case 'busy': return 'This session is being removed or completed, or fat-g is closing, so nothing was sent.';
    case 'history-loading': return CHAT_LINES.loading;
    case 'storage-failed': return CHAT_LINES.storageFailed;
    case 'unknown-session': return 'This session is no longer listed.';
    case 'changing-mode': return CHANGING_MODE_TEXT;
    case 'setting-up': return `${MODE_WORDS.settingUp(provider)} Send again once it has ended.`;
    case 'plan-pending': return PLAN_PENDING_TEXT;
    case 'plans-unavailable': return `${provider} cannot plan in this chat right now, so nothing was sent.`;
    case 'draft-changed': return 'The message changed while it was being sent, so nothing was sent. Send again.';
    case 'attachment-missing': return 'An image of this message is no longer available, so nothing was sent. Remove it, or attach it again.';
    case 'not-steerable': return `${provider} cannot take a message while working, so nothing was sent. Queue sends it once the current reply and its sub-agents are done.`;
    case 'queue-full': return `${COMPOSER_WORDS.full} Nothing was sent: remove one, or send this once the current reply is done.`;
    case 'skill-unavailable': return COMPOSER_WORDS.skillUnavailable;
    case 'shelved': return 'This session is on the shelf: its queued messages wait until it is unshelved.';
  }
}

/** While a plan's decision waits in the chat (M22b, C56, C58): a prompt and a change of mode each wait for it. */
export const PLAN_PENDING_TEXT = 'A plan holds this chat: decide on it — execute, discard, leave or give feedback — or let its review or revision finish, first.';

/** While a change of the chat's mode is under way (M22, C90): a prompt, a question and a decision each wait for it. */
export const CHANGING_MODE_TEXT = 'This chat’s mode is being changed. Try again once that is done.';

const SEND_OWN: readonly string[] = ['unknown-session', 'running', 'busy', 'unconfirmed', 'history-loading', 'storage-failed', 'changing-mode', 'setting-up', 'plan-pending', 'plans-unavailable', 'draft-changed', 'attachment-missing', 'not-steerable', 'queue-full', 'skill-unavailable', 'shelved'] satisfies readonly SendRefusal[];
const isSendRefusal = (reason: string): reason is SendRefusal => SEND_OWN.includes(reason);

/** Why a Send was refused, in fat-g's words (M15, Design 13): the draft stays. */
export function sendRefusalText(reason: SendRefusal | SendBlock, provider: string): string {
  return isSendRefusal(reason) ? refusalWords(reason, provider) : blockWords(reason, provider).text;
}

/** What an async card's Submit says while a turn runs (C38): Send's own reason. */
export const runningWords = (provider: string): string => refusalWords('running', provider);


/**
 * Why an answer was not taken, in fat-g's words; null for a stale press (C49), which says nothing
 * by itself: the item's push, which main sends at every outcome, brings the card's state.
 */
export function answerRefusalText(reason: AnswerRefusal | SendRefusal | SendBlock, provider: string): string | null {
  if (reason === 'not-pending') return null;
  if (reason === 'unknown-item') return 'This question is no longer part of the conversation.';
  if (reason === 'incomplete') return CARD_WORDS.nothing;
  if (reason === 'mismatch') return 'fat-g could not take this answer as it was given.';
  if (reason === 'too-long') return 'These answers are too long to send as one message. Shorten one, or answer fewer questions at a time.';
  if (reason === 'storage-failed') return 'fat-g could not save your answer, so nothing was sent. Try again.';
  // The send's own reasons, an async card's answer being a prompt, and the two an answer shares with them.
  return sendRefusalText(reason, provider);
}
