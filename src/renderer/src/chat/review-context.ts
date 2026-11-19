// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a reviewer's chat hands its messages (docs/planning/_archive/M22e.md, Design 4, 5; C5, C7, C55): the
// session's review as main answered it, so that a round's answer draws its list where its block was
// and an answer, a prompt or a card that brought no round says so from the record.
import { createContext } from 'react';
import { readFindings, type ReviewTurnView, type ReviewView } from '@shared/contracts/review';
import { blockProblemWords, REVIEW_WORDS } from './review-words';

export interface ReviewScope {
  readonly review: ReviewView;
  readonly sessionId: string;
  readonly providerName: string;
  /** The plan's title, as the page holds it. */
  readonly title: string;
}

export const ReviewContext = createContext<ReviewScope | null>(null);

/** A turn that asked, whose card no answer has carried on yet (C49). */
export const pendingAsk = (review: ReviewView): ReviewTurnView | undefined => review.turns.find((turn) => turn.outcome === 'asked' && !review.turns.some((other) => other.continues === turn.turnId));

/** The item's text, and whether it was cut at the length a message keeps: what an answer's block is read again from. */
export interface NoticeAnswer {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * Why an answer's findings block was refused, read again from its text (the maintainer):
 * null where the record holds another reason, or where the text reads otherwise now — a block an
 * earlier build refused for what this one takes — and the kind's words stand.
 */
function problemOf(review: ReviewView, turn: ReviewTurnView, answer: NoticeAnswer | undefined): string | null {
  if (answer === undefined || turn.reason !== 'invalid') return null;
  const read = readFindings(answer.text, review.instruction);
  return read.verdict === 'invalid' ? blockProblemWords(read.problem, read.setAside, review.instruction, answer.cut) : null;
}

/**
 * The one line the record says under an item of the reviewer's chat (C55), or null: under an answer
 * that brought no round, under the message whose card the review waits on, and under the prompt of
 * a first turn that ended with no answer. Never a text of the model's but a finding's id. An answer
 * whose block was refused says what was wrong with it, read again from `answer`.
 */
export function reviewNotice(review: ReviewView, itemId: string, answer?: NoticeAnswer): string | null {
  for (const turn of review.turns) {
    if (turn.answerId === itemId) {
      if (turn.outcome === 'asked') return pendingAsk(review) === turn ? REVIEW_WORDS.waitsOnAnswer : null;
      const problem = problemOf(review, turn, answer);
      if (turn.outcome === 'no-round') return problem === null ? REVIEW_WORDS.noRound : REVIEW_WORDS.noRoundBecause(problem);
      if (turn.outcome === 'failed' && turn.reason !== null) return problem === null ? REVIEW_WORDS.failed(turn.reason) : REVIEW_WORDS.failedBecause(problem);
    }
    if (turn.promptId === itemId && turn.answerId === null && turn.outcome === 'failed' && turn.reason !== null) return REVIEW_WORDS.failed(turn.reason);
  }
  return null;
}
