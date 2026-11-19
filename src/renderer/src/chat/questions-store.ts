// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The selected session's workers' questions that wait for an answer, in the page (docs/planning/_archive/
// M21.md, Design 7; C42, C73, C76): each pending item by its worker and its id, as the session's
// last read listed them and as its workers' pushes have changed them since. A worker's items are in
// none of the chat's pages, so this is what a worker's row reads "waits for your answer" from.
//
// A worker's approvals that wait for a decision are listed with them (docs/planning/_archive/M22.md, Design
// 10; C36): each entry says which of the two it is, and its row then reads "waits for your approval".
//
// It holds ids alone: no question, no option, no answer and nothing of a request. Held as the chat's
// asides are, in the page's memory for the run; set by the chat's own read, and by each interaction
// push of a worker's, which the chat's list passes — the item is added while it reads pending and
// removed at any other outcome, so a worker with two questions keeps its row until both are settled.
import { create } from 'zustand';
import type { WaitingQuestion } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { approvalOf } from '@shared/contracts/interaction';

export interface WaitingState {
  /** The session these are of, or null before any read. */
  readonly sessionId: string | null;
  readonly waiting: readonly WaitingQuestion[];
}

const NOTHING: WaitingState = { sessionId: null, waiting: [] };

export const useWaiting = create<WaitingState>()(() => NOTHING);

const same = (a: readonly WaitingQuestion[], b: readonly WaitingQuestion[]): boolean =>
  a.length === b.length && a.every((entry, index) => entry.itemId === b[index]?.itemId && entry.workerId === b[index]?.workerId && entry.kind === b[index]?.kind);

/** What a read of the session's chat listed. Nothing changes, and nothing is drawn again, for a list that reads the same. */
export function setWaiting(sessionId: string, waiting: readonly WaitingQuestion[]): void {
  useWaiting.setState((held) => (held.sessionId === sessionId && same(held.waiting, waiting) ? held : { sessionId, waiting }));
}

/**
 * A worker's interaction item, as a push carried it (C73): listed while it reads pending, and not
 * otherwise. Answers whether it was added: a question, or an approval (M22, C36), that was not
 * waiting before, and is now.
 */
export function noteWorkerQuestion(sessionId: string, item: Pick<ConversationItem, 'id' | 'workerId' | 'interaction'>): boolean {
  const { workerId } = item;
  if (workerId === null || item.interaction === null) return false;
  const held = useWaiting.getState();
  const listed = held.sessionId === sessionId ? held.waiting : [];
  const was = listed.some((entry) => entry.itemId === item.id);
  const pending = item.interaction.outcome === 'pending';
  if (was === pending) return false;
  const kind = approvalOf(item) === null ? 'question' : 'approval';
  useWaiting.setState({ sessionId, waiting: pending ? [...listed, { workerId, itemId: item.id, kind }] : listed.filter((entry) => entry.itemId !== item.id) });
  return pending;
}

/** Another session is shown, or none: nothing of the last one's stays. */
export function clearWaiting(sessionId: string): void {
  useWaiting.setState((held) => (held.sessionId === sessionId ? NOTHING : held));
}

/**
 * What of this worker's waits for the user, in the session whose reads are held: a question while
 * any question of its is listed, else an approval while one of those is (M22, C36), else null.
 */
export function useWorkerWaits(sessionId: string | null, workerId: string | null): WaitingQuestion['kind'] | null {
  return useWaiting((state) => {
    if (sessionId === null || workerId === null || state.sessionId !== sessionId) return null;
    const own = state.waiting.filter((entry) => entry.workerId === workerId);
    if (own.length === 0) return null;
    return own.some((entry) => entry.kind === 'question') ? 'question' : 'approval';
  });
}

/** For tests: nothing held. */
export function resetWaiting(): void {
  useWaiting.setState(NOTHING);
}
