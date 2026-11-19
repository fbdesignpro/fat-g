// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ConversationItem } from '@shared/contracts/conversation';
import { questionOf } from '@shared/contracts/interaction';
import { drawsEntry, shownRole } from './window';

export interface Speaker {
  readonly role: 'user' | 'assistant' | 'notice';
  readonly model: string | null;
  /** A user's message that is the answer to an async question's card, sent as a prompt (M21, C26). */
  readonly answer?: boolean;
  /** Sent into an existing turn, as recorded by the message's delivery state. */
  readonly interactive?: boolean;
  /** Sent to the CLI, which has not yet confirmed the model received it. */
  readonly pendingReceipt?: boolean;
  /** The CLI confirmed that this message joined the running turn. */
  readonly received?: boolean;
  /** Accepted from the session's queue. */
  readonly fromQueue?: boolean;
}

/**
 * The user's messages that answer an async question's card: an answered card's outcome and its
 * answering message are written in one step at the same time, so the message taken at the card's
 * `settledAt` is its answer — wherever that message stands, a steer moved to a later turn included.
 */
function answerTimes(entries: readonly (readonly ConversationItem[])[]): ReadonlySet<number> {
  const times = new Set<number>();
  for (const entry of entries) {
    for (const item of entry) {
      const question = questionOf(item);
      if (question !== null && question.mode === 'async' && question.outcome === 'answered' && question.settledAt !== null) times.add(question.settledAt);
    }
  }
  return times;
}

/** Visible runs use identity, never labels: a user may choose the same name as a model. */
export function speakerRuns(entries: readonly (readonly ConversationItem[])[], defaultModel: string): ReadonlyMap<string, Speaker> {
  const bars = new Map<string, Speaker>();
  let previous = '';
  let previousRole = '';
  let previousModel = defaultModel;
  let turn: string | null = null;
  const answers = answerTimes(entries);
  for (const entry of entries) {
    const first = entry[0];
    if (first === undefined || !drawsEntry(entry)) continue;
    const role = shownRole(first) ?? 'assistant';
    const model: string | null = role !== 'assistant' ? null : first.model ?? (turn === first.turnId && previousRole === 'assistant' ? previousModel : defaultModel);
    const answer = role === 'user' && first.kind === 'message' && first.time.receivedAt !== null && answers.has(first.time.receivedAt);
    const interactive = role === 'user' && first.delivery != null && first.delivery.state !== 'next-prompt' && first.delivery.state !== 'not-sent';
    const pendingReceipt = interactive && first.delivery?.state === 'sent';
    const received = interactive && first.delivery?.state === 'taken';
    const fromQueue = role === 'user' && first.fromQueue === true;
    const identity = JSON.stringify([first.turnId, role, model, answer, interactive, pendingReceipt, received, fromQueue]);
    if (identity !== previous) bars.set(first.id, { role, model, ...(answer ? { answer } : {}), ...(interactive ? { interactive } : {}), ...(pendingReceipt ? { pendingReceipt } : {}), ...(received ? { received } : {}), ...(fromQueue ? { fromQueue } : {}) });
    turn = first.turnId;
    previous = identity;
    previousRole = role;
    if (model !== null) previousModel = model;
  }
  return bars;
}

export interface SpeakerTimer {
  readonly turnId?: string;
  readonly running: boolean;
  readonly since: number | null;
  readonly elapsedMs: number | null;
}
