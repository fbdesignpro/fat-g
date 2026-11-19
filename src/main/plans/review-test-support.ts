// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A review's record for the plan store's and the review service's tests (docs/planning/_archive/M22e.md, Design 2):
// one with every field this build writes. Not a test, and it imports no test library.
import type { Finding } from '@shared/contracts/review';
import type { ReviewRecord } from './review-format';

export const SAMPLE_HASH = 'a'.repeat(64);
export const SAMPLE_FINDING: Finding = { id: 'T1.1', tier: 1, category: 'PROD', title: 'A title', example: 'An example.', description: 'A description.', correction: 'A correction.', anchor: { heading: 'Steps', quote: 'add it' } };

/** A review with one round, a mark, a turn of each kind and an integration. */
export function sampleReview(patch: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: 'review-1', planId: 'plan-1', version: 1, hash: SAMPLE_HASH, startedFrom: 'session-a', instruction: 2,
    reviewer: { sessionId: 'session-r', providerId: 'example', instanceId: 'example', model: 'model-a', effort: null },
    startedAt: 10, endedAt: null, state: 'findings', failure: null, staleBy: null, closed: null,
    turns: [
      { turnId: 'turn-1', promptId: 'prompt-1', kind: 'review', at: 10, answerId: 'answer-1', outcome: 'round', reason: null, continues: null, card: null, notes: null, unknown: {} },
      { turnId: 'turn-2', promptId: 'prompt-2', kind: 'notes', at: 20, answerId: null, outcome: 'waiting', reason: null, continues: null, card: null, notes: { 'T1.1': 'Why?' }, unknown: {} },
    ],
    rounds: [{ turnId: 'turn-1', answerId: 'answer-1', appraisal: 'One line.', findings: [SAMPLE_FINDING], revised: [], marks: null, notes: null, unknown: {} }],
    marks: { 'T1.1': { mark: 'accepted', note: '', revised: false } },
    integrations: [{ id: 'integration-1', version: 1, hash: SAMPLE_HASH, round: 'turn-1', accepted: ['T1.1'], notes: {}, instruction: 2, sessionId: 'session-a', route: 'plan-turn', planItem: null, turns: ['turn-9'], card: null, state: 'ended', reason: 'no-plan', produced: null, at: 30, settledAt: 31, unknown: {} }],
    unknown: {},
    ...patch,
  };
}
