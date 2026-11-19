// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '@shared/contracts/sessions';
import { sessionEntry, sessionsState, SUMMARIES } from '../../../tests/support/sessions';
import { createAppStateStore } from '../state/app-state-store';
import { followAttentionIcon } from './attention-icon';

function setup(entries: SessionEntry[] = []) {
  const store = createAppStateStore();
  const set = (next: SessionEntry[], selected: string | null = null): void => { store.setSessions(sessionsState(next, selected)); };
  set(entries);
  const paint = vi.fn();
  const stop = followAttentionIcon(store, paint);
  return { store, set, paint, stop };
}

describe('the application attention icon', () => {
  it('starts from current attention, keeps it until the last session clears, and restores normal', () => {
    const ready = sessionEntry('Ready', SUMMARIES.ready);
    const asking = sessionEntry('Question', SUMMARIES.questions);
    const { set, paint } = setup([ready, asking]);
    expect(paint.mock.calls).toEqual([[true]]);
    set([sessionEntry('Ready', SUMMARIES.readyAcknowledged), asking], ready.record.id);
    expect(paint).toHaveBeenCalledTimes(1);
    // Selecting a blocking decision leaves its attention lit, as main's summaries specify.
    set([asking], asking.record.id);
    expect(paint).toHaveBeenCalledTimes(1);
    set([sessionEntry('Question', SUMMARIES.runningThinking)]);
    expect(paint.mock.calls).toEqual([[true], [false]]);
    set([sessionEntry('Error', SUMMARIES.error)]);
    set([]);
    expect(paint.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it.each(['question', 'approval', 'plan', 'review', 'ready', 'error', 'stopped'] as const)('includes unacknowledged %s attention', (kind) => {
    const { paint } = setup([sessionEntry('Notice', { ...SUMMARIES.idle, attention: { kind, count: 1, acknowledged: false } })]);
    expect(paint).toHaveBeenLastCalledWith(true);
  });

  it('ignores acknowledged, shelved and completed notices and waits on another chat', () => {
    const { paint, set } = setup([
      sessionEntry('Seen', SUMMARIES.readyAcknowledged),
      sessionEntry('Shelved', SUMMARIES.ready, { shelvedAt: 1 }),
      sessionEntry('Completed', SUMMARIES.error, { completedAt: 1 }),
      sessionEntry('Waiting', { ...SUMMARIES.ready, planWait: 'review' }),
    ]);
    expect(paint.mock.calls).toEqual([[false]]);
    // An own approval still takes precedence over that plan wait.
    set([sessionEntry('Approval', { ...SUMMARIES.approval, planWait: 'review' })]);
    expect(paint).toHaveBeenLastCalledWith(true);
  });

  it('does no image work on streaming/unrelated changes and unsubscribes on close', () => {
    const { store, set, paint, stop } = setup();
    store.setZoom(125);
    set([sessionEntry('Working', SUMMARIES.runningThinking)]);
    set([sessionEntry('Working', SUMMARIES.runningSentence)]);
    expect(paint.mock.calls).toEqual([[false]]);
    stop();
    set([sessionEntry('Question', SUMMARIES.questions)]);
    expect(paint).toHaveBeenCalledTimes(1);
  });
});
