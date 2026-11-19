// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The reviews' eight channels (docs/planning/_archive/M22e.md, Design 8; C14, C16, C44; decision 0029). A start
// names a session, a plan, its version and its workflow's revision; a mark names a review and a finding or a tier; a note a
// finding and its text; Send notes, a close — cancelled or concluded — and a read a review — or a read a plan or a session;
// Explain a finding and where its row lies; Integrate a target. Everything else is main's: whether a
// review can start, what a round holds, which route a target takes, and what each prompt sends.
//
// What main says of each is its outcome's kind, counted (C16): never a finding, an appraisal, a note,
// a title, an id or a path. The eight are the Main window's only: a review is the user's own, and the
// Pet, which shows on screen shares, is refused each as `forbidden`, by the contract.
import type { ReviewService } from '../../sessions/reviews';
import type { InvokeHandlers } from '../dispatch';
import { createKindCounts, type KindCounts } from './counts';

export interface ReviewHandlerDeps {
  readonly reviews: Pick<ReviewService, 'start' | 'mark' | 'note' | 'send' | 'explain' | 'integrate' | 'close' | 'read'>;
  readonly counts?: KindCounts;
}

type Channels = 'reviews:start' | 'reviews:mark' | 'reviews:note' | 'reviews:send' | 'reviews:explain' | 'reviews:integrate' | 'reviews:close' | 'reviews:read';

export function reviewHandlers(deps: ReviewHandlerDeps): Pick<InvokeHandlers, Channels> {
  const counts = deps.counts ?? createKindCounts();
  /** An outcome's kind: what it did, or why it did not. */
  const said = <const T extends { readonly status: string; readonly reason?: string }>(what: string, answer: T): T => {
    counts.add(answer.status === 'refused' ? `${what}:refused:${answer.reason ?? ''}` : `${what}:${answer.status}`);
    return answer;
  };
  return {
    'reviews:start': async (request) => said('start', await deps.reviews.start(request)),
    'reviews:mark': (request) => said('mark', deps.reviews.mark(request)),
    'reviews:note': (request) => said('note', deps.reviews.note(request)),
    'reviews:send': async (request) => said('send', await deps.reviews.send(request)),
    'reviews:explain': async (request) => said('explain', await deps.reviews.explain(request)),
    'reviews:integrate': async (request) => said(`integrate:${'preset' in request.target ? 'new' : 'listed'}`, await deps.reviews.integrate(request)),
    'reviews:close': async (request) => said(`close:${request.as}`, await deps.reviews.close(request)),
    'reviews:read': (request) => said(`read:${'reviewId' in request ? 'review' : 'planId' in request ? 'plan' : 'session'}`, deps.reviews.read(request)),
  };
}
