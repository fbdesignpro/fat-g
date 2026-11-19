// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The reviews the page has read (docs/planning/_archive/M22e.md, Design 5–8; C7, C8, C12, C44): a session's own
// review, as `reviews:read` answered it for the reviewer's chat, and a plan's reviews, as its line and
// its tab name them. Read once for a session or a plan the page shows, and again at each push that
// names it, which carries ids alone. Kept in the page for the run: nothing of it is written.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { ReviewMark, ReviewPush, ReviewSummary, ReviewView } from '@shared/contracts/review';
import { invoke, subscribe } from '../ipc/client';

interface ReviewsState {
  /** A session's own review, or null for one that is no reviewer. */
  readonly bySession: Readonly<Record<string, ReviewView | null>>;
  /** A plan's reviews, the newest first. */
  readonly byPlan: Readonly<Record<string, readonly ReviewSummary[]>>;
  /** What the last write of a review's said where it was refused, by review: under its list. */
  readonly problems: Readonly<Record<string, string>>;
}

export const useReviews = create<ReviewsState>()(() => ({ bySession: {}, byPlan: {}, problems: {} }));

/** The marks main gave back for a review's latest round (C28): drawn at once, before the push's read. */
export function applyMarks(sessionId: string, reviewId: string, marks: Readonly<Record<string, ReviewMark>>): void {
  useReviews.setState((state) => {
    const review = state.bySession[sessionId];
    if (review === null || review === undefined || review.reviewId !== reviewId) return state;
    const rounds = review.rounds.map((round, n) => (n === review.rounds.length - 1 ? { ...round, marks: { ...round.marks, ...marks } } : round));
    return { bySession: { ...state.bySession, [sessionId]: { ...review, rounds } } };
  });
}

export function setReviewProblem(reviewId: string, problem: string | null): void {
  useReviews.setState((state) => {
    if (problem === null) {
      if (state.problems[reviewId] === undefined) return state;
      const { [reviewId]: _gone, ...rest } = state.problems;
      return { problems: rest };
    }
    return { problems: { ...state.problems, [reviewId]: problem } };
  });
}

export const useReviewProblem = (reviewId: string): string | null => useReviews((state) => state.problems[reviewId] ?? null);

/** The reads in flight, by key: one at a time for each, and a later ask reads again once it answers. */
const reading = new Map<string, boolean>();

function once(key: string, read: () => Promise<void>): void {
  if (reading.has(key)) { reading.set(key, true); return; }
  reading.set(key, false);
  void read().catch(() => undefined).finally(() => {
    const again = reading.get(key) === true;
    reading.delete(key);
    if (again) once(key, read);
  });
}

/** Reads a session's own review again. */
export function readSessionReview(sessionId: string): void {
  once(`s:${sessionId}`, async () => {
    const answer = await invoke('reviews:read', { sessionId });
    if (answer.status !== 'session') return;
    useReviews.setState((state) => ({ bySession: { ...state.bySession, [sessionId]: answer.review } }));
  });
}

/** Reads a plan's reviews again. */
export function readPlanReviews(planId: string): void {
  once(`p:${planId}`, async () => {
    const answer = await invoke('reviews:read', { planId });
    if (answer.status !== 'listed') return;
    useReviews.setState((state) => ({ byPlan: { ...state.byPlan, [planId]: answer.reviews } }));
  });
}

/** A push named a review (C44): what the page holds of its session and its plan is read again. */
export function reviewChanged(push: ReviewPush): void {
  const { bySession, byPlan } = useReviews.getState();
  if (bySession[push.sessionId] !== undefined) readSessionReview(push.sessionId);
  if (byPlan[push.planId] !== undefined) readPlanReviews(push.planId);
}

/** A plan changed (M22b, C25): a version that makes its reviews stale says so in its line and its tab. */
export function planReviewsChanged(planId: string): void {
  if (useReviews.getState().byPlan[planId] !== undefined) readPlanReviews(planId);
  for (const [sessionId, review] of Object.entries(useReviews.getState().bySession)) if (review?.planId === planId) readSessionReview(sessionId);
}

/** Every push of a review, and of a plan, keeps what the page holds current: subscribed once for the page. */
let following = false;
function follow(): void {
  if (following || typeof window === 'undefined' || (window as { fatg?: unknown }).fatg === undefined) return;
  following = true;
  subscribe('reviews:changed', reviewChanged);
  subscribe('plans:changed', (push) => { if (push.partial === undefined) planReviewsChanged(push.planId); });
}

/** A session's own review: read once where it is not held yet. Undefined until the first read answers. */
export function useSessionReview(sessionId: string): ReviewView | null | undefined {
  const review = useReviews((state) => state.bySession[sessionId]);
  useEffect(() => { follow(); if (review === undefined) readSessionReview(sessionId); }, [sessionId, review]);
  return review;
}

/** A plan's reviews: read once where they are not held yet. */
export function usePlanReviews(planId: string): readonly ReviewSummary[] | undefined {
  const reviews = useReviews((state) => (planId === '' ? undefined : state.byPlan[planId]));
  useEffect(() => { follow(); if (reviews === undefined && planId !== '') readPlanReviews(planId); }, [planId, reviews]);
  return reviews;
}

/** For tests: nothing held, and the pushes followed again. */
export function resetReviews(): void {
  reading.clear();
  following = false;
  useReviews.setState({ bySession: {}, byPlan: {}, problems: {} });
}
