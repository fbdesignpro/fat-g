// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A review's record (docs/planning/_archive/M22e.md, Design 2; V2; C6, C24, C29, C30, C49, C51): under the version
// envelope, a newer file refused, unknown fields kept at every level, and each field checked —
// one this build cannot take makes the record one it cannot write back whole.
import { describe, expect, it } from 'vitest';
import { readReviewFile, REVIEW_MIN_READER_VERSION, REVIEW_SCHEMA_VERSION, reviewDocument } from './review-format';
import { SAMPLE_FINDING as FINDING, sampleReview } from './review-test-support';

describe('the review record (C6; decision 0014)', () => {
  it('writes and reads back every field, under its envelope', () => {
    const review = sampleReview();
    const document = reviewDocument(review);
    expect(document).toMatchObject({ schemaVersion: REVIEW_SCHEMA_VERSION, minReaderVersion: REVIEW_MIN_READER_VERSION, id: 'review-1', planId: 'plan-1' });
    expect(readReviewFile(JSON.parse(JSON.stringify(document)))).toEqual({ kind: 'ok', review });
  });

  it('keeps what this build does not know: the record’s, each turn’s, round’s and integration’s', () => {
    const document = reviewDocument(sampleReview()) as Record<string, unknown> & { turns: Record<string, unknown>[]; rounds: Record<string, unknown>[]; integrations: Record<string, unknown>[] };
    const later = { ...document, later: 1, turns: document.turns.map((turn) => ({ ...turn, later: 2 })), rounds: document.rounds.map((round) => ({ ...round, later: 3 })), integrations: document.integrations.map((one) => ({ ...one, later: 4 })) };
    const reading = readReviewFile(later);
    expect(reading.kind).toBe('ok');
    if (reading.kind !== 'ok') return;
    expect(reviewDocument(reading.review)).toMatchObject({ later: 1, turns: [{ later: 2 }, { later: 2 }], rounds: [{ later: 3 }], integrations: [{ later: 4 }] });
  });

  it('refuses a newer file and an older one, and reads what is no review’s as corrupt', () => {
    const document = reviewDocument(sampleReview());
    expect(REVIEW_SCHEMA_VERSION).toBe(2);
    expect(readReviewFile({ ...document, schemaVersion: 3, minReaderVersion: 3 }).kind).toBe('refused');
    expect(readReviewFile({ ...document, schemaVersion: 3, minReaderVersion: 2 }).kind).toBe('ok');
    // Version 1 (M22e) held a panel and no closing: refused as older (decision 0014).
    expect(readReviewFile({ ...document, schemaVersion: 1, minReaderVersion: 1 }).kind).toBe('refused');
    expect(readReviewFile('{').kind).toBe('corrupt');
    expect(readReviewFile({ ...document, state: 'somewhere' }).kind).toBe('corrupt');
    expect(readReviewFile({ ...document, marks: { 'T9.1': { mark: 'accepted', note: '', revised: false } } }).kind).toBe('corrupt');
  });

  it('says how a closed review closed, and nothing for any other (decision 0029)', () => {
    const closed = sampleReview({ state: 'closed', closed: 'handed', endedAt: 40 });
    expect(readReviewFile(JSON.parse(JSON.stringify(reviewDocument(closed))))).toEqual({ kind: 'ok', review: closed });
    const document = reviewDocument(sampleReview());
    expect(readReviewFile({ ...document, state: 'closed', closed: null }).kind).toBe('corrupt');
    expect(readReviewFile({ ...document, closed: 'cancelled' }).kind).toBe('corrupt');
    expect(readReviewFile({ ...document, state: 'closed', closed: 'somehow' }).kind).toBe('corrupt');
  });

  it('reads a round’s findings of any length and number, refuses one that is no finding, and a note of 2,001 units (C4, C30)', () => {
    const document = reviewDocument(sampleReview()) as Record<string, unknown> & { rounds: Record<string, unknown>[] };
    // The maintainer: no length or count a round is refused for.
    const many = Array.from({ length: 40 }, (_, n) => ({ ...FINDING, id: `T1.${n + 1}`, correction: 'x'.repeat(5_000) }));
    const read = readReviewFile({ ...document, rounds: [{ ...document.rounds[0], appraisal: 'y'.repeat(5_000), findings: many }] });
    expect(read.kind === 'ok' && read.review.rounds[0]?.findings).toHaveLength(40);
    const { correction: _correction, ...broken } = FINDING;
    expect(readReviewFile({ ...document, rounds: [{ ...document.rounds[0], findings: [broken] }] }).kind).toBe('corrupt');
    expect(readReviewFile({ ...document, marks: { 'T1.1': { mark: 'open', note: 'x'.repeat(2_001), revised: false } } }).kind).toBe('corrupt');
    expect(readReviewFile({ ...document, marks: { 'T1.1': { mark: 'open', note: 'x'.repeat(2_000), revised: false } } }).kind).toBe('ok');
  });
});
