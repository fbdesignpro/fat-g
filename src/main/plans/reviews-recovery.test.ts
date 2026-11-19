// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A plan's reviews in the plan store (docs/planning/_archive/M22e.md, Design 2; V2; C6, C27, C35, C36, C45, C49, C51,
// C52): written whole at each change, marked stale by a newer complete version alone, removed with
// their plan and by nothing else, counted in Storage — and at a launch kept, ended where they ran,
// their integrations settled from `plan.json` alone, with a crash at each point between.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reviewFile } from './review-format';
import { sampleReview } from './review-test-support';
import { createPlanStore, PlanStorageFailure, type PlanStore, type VersionSource } from './store';

const SOURCE: VersionSource = { sessionId: 's-1', turnId: 't-1', providerId: 'example', instanceId: 'example', model: 'model-a', cause: 'plan-turn', revises: null };
const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };

let dir: string;
let clock: number;
let ids: number;

beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'fatg-reviews-')), 'plans');
  clock = 1_000;
  ids = 0;
});
afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

function open(hook?: (point: string) => void, listed: ReadonlySet<string> | null = new Set(['project-1'])): PlanStore {
  const store = createPlanStore({ dir, now: () => clock, newId: () => `plan-${(ids += 1)}`, log: QUIET, ...(hook === undefined ? {} : { hook }) });
  store.recover(listed);
  return store;
}
const target = (planId: string | null = null) => ({ planId, projectId: 'project-1', title: 'A plan' });
const reviewPath = (planId: string, reviewId: string): string => path.join(dir, planId, 'reviews', reviewFile(reviewId));
const onDisk = (planId: string, reviewId: string): Record<string, unknown> => JSON.parse(readFileSync(reviewPath(planId, reviewId), 'utf8')) as Record<string, unknown>;
const crashAt = (point: string, times = 1) => (reached: string): void => { if (reached === point && (times -= 1) === 0) throw new Error(`crash at ${point}`); };
/** A plan of one complete version, and a review of it with nothing running. */
function planWithReview(store: PlanStore, patch: Parameters<typeof sampleReview>[0] = {}) {
  const made = store.write(target(), SOURCE, 'one');
  return store.createReview(sampleReview({ planId: made.planId, hash: made.hash, turns: [sampleReview().turns[0]!], integrations: [], ...patch }));
}

describe('a review’s record in the store (C6)', () => {
  it('is written whole beside its plan, listed, read and counted, and each change writes it again at once', () => {
    const store = open();
    const review = planWithReview(store);
    expect(readdirSync(path.join(dir, 'plan-1')).sort()).toEqual(['plan.json', 'reviews', 'v1.md']);
    expect(onDisk('plan-1', 'review-1')).toMatchObject({ schemaVersion: 2, id: 'review-1', planId: 'plan-1', state: 'findings', closed: null });
    expect(store.reviews('plan-1')).toEqual([review]);
    expect(store.review('plan-1', 'review-1')).toEqual(review);
    expect(store.allReviews()).toEqual([review]);
    expect(store.storage(null)).toMatchObject({ count: 1, reviews: 1 });
    store.updateReview('plan-1', 'review-1', (held) => ({ ...held, marks: { 'T1.1': { mark: 'rejected', note: 'No.', revised: false } } }));
    expect(onDisk('plan-1', 'review-1')['marks']).toEqual({ 'T1.1': { mark: 'rejected', note: 'No.', revised: false } });
    // A change that changes nothing writes nothing; one of an unknown review, or a second review of one id, is refused.
    expect(store.updateReview('plan-1', 'review-1', () => null)).toBe(store.review('plan-1', 'review-1'));
    expect(() => store.updateReview('plan-1', 'review-9', (held) => held)).toThrow(PlanStorageFailure);
    expect(() => store.createReview(sampleReview())).toThrow(PlanStorageFailure);
    expect(() => store.createReview(sampleReview({ planId: 'plan-9' }))).toThrow(PlanStorageFailure);
  });

  it('is kept whole across a restart, its rounds, marks, notes, closing and integrations', () => {
    const store = open();
    const review = planWithReview(store, { state: 'closed', closed: 'cancelled', marks: { 'T1.1': { mark: 'open', note: 'A note kept.', revised: true } }, integrations: [sampleReview().integrations[0]!] });
    expect(open().review('plan-1', 'review-1')).toEqual(review);
  });

  it('goes with its plan’s removal, its project’s and Remove all, and with nothing else', () => {
    const store = open();
    planWithReview(store);
    store.write(target('plan-1'), SOURCE, 'two');
    expect(store.reviews('plan-1')).toHaveLength(1);
    expect(store.remove('plan-1')).toBe('removed');
    expect(store.reviews('plan-1')).toEqual([]);
    expect(existsSync(path.join(dir, 'plan-1'))).toBe(false);
    planWithReview(store, { planId: 'plan-2' });
    store.markProject('project-1');
    store.finishProject('project-1');
    expect(store.allReviews()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('stale (C36, C52)', () => {
  it('is marked by a newer complete version, after its record, and not by one being written or left unfinished', () => {
    const store = open();
    planWithReview(store);
    const draft = store.begin(target('plan-1'), SOURCE);
    expect(store.review('plan-1', 'review-1')?.staleBy).toBeNull();
    store.append(draft.planId, draft.version, 'half');
    store.unfinish(draft.planId, draft.version);
    expect(store.review('plan-1', 'review-1')?.staleBy).toBeNull();
    const next = store.begin(target('plan-1'), SOURCE);
    store.complete(next.planId, next.version, 'three', 'A plan');
    expect(store.review('plan-1', 'review-1')?.staleBy).toBe(3);
    expect(onDisk('plan-1', 'review-1')['staleBy']).toBe(3);
    // A later version names the first that made it stale, and changes nothing.
    store.write(target('plan-1'), SOURCE, 'four');
    expect(store.review('plan-1', 'review-1')?.staleBy).toBe(3);
  });

  it('is written into a review created on a version a newer complete one has replaced (C52)', () => {
    const store = open();
    const made = store.write(target(), SOURCE, 'one');
    store.write(target('plan-1'), SOURCE, 'two');
    expect(store.createReview(sampleReview({ planId: made.planId, hash: made.hash, integrations: [] })).staleBy).toBe(2);
  });

  it('left unwritten by a crash between the version’s record and the review is mended at the next launch', () => {
    const store = open(crashAt('review', 2));
    planWithReview(store);
    store.write(target('plan-1'), SOURCE, 'two');
    expect(onDisk('plan-1', 'review-1')['staleBy']).toBeNull();
    expect(open().review('plan-1', 'review-1')?.staleBy).toBe(2);
    expect(onDisk('plan-1', 'review-1')['staleBy']).toBe(2);
  });
});

describe('launch recovery (C6, C27, C35, C45, C49)', () => {
  it('keeps `reviews/`, which `plan.json` does not name, and cleans a temporary write in it', () => {
    const store = open();
    planWithReview(store);
    writeFileSync(`${reviewPath('plan-1', 'review-1')}.tmp`, '{}');
    open();
    expect(readdirSync(path.join(dir, 'plan-1', 'reviews'))).toEqual(['review-1.json']);
  });

  it('leaves a review it cannot read, or one a newer reader wrote, as it is, and lists neither', () => {
    const store = open();
    planWithReview(store);
    const newer = JSON.stringify({ ...onDisk('plan-1', 'review-1'), schemaVersion: 3, minReaderVersion: 3 });
    writeFileSync(reviewPath('plan-1', 'review-1'), newer);
    writeFileSync(reviewPath('plan-1', 'review-2'), '{ not json');
    const again = open();
    expect(again.reviews('plan-1')).toEqual([]);
    expect(again.storage(null).reviews).toBe(0);
    expect(readFileSync(reviewPath('plan-1', 'review-1'), 'utf8')).toBe(newer);
    expect(readFileSync(reviewPath('plan-1', 'review-2'), 'utf8')).toBe('{ not json');
  });

  it('ends a review found running, and a turn found waiting or asked, `interrupted`; the rest stands', () => {
    const store = open();
    const [first] = sampleReview().turns;
    planWithReview(store, {
      state: 'running', rounds: [], marks: {},
      turns: [{ ...first!, outcome: 'waiting', answerId: null }, { ...first!, turnId: 'turn-2', outcome: 'asked', card: 'card-1' }, { ...first!, turnId: 'turn-3', outcome: 'round' }],
    });
    clock = 5_000;
    const review = open().review('plan-1', 'review-1');
    expect(review).toMatchObject({ state: 'failed', failure: 'interrupted', endedAt: 5_000 });
    expect(review?.turns.map((turn) => [turn.outcome, turn.reason, turn.card])).toEqual([['failed', 'interrupted', null], ['failed', 'interrupted', null], ['round', null, null]]);
    // A review with its findings keeps them, and a later turn that waited is ended alone.
    rmSync(dir, { recursive: true });
    ids = 0;
    const other = open();
    planWithReview(other, { turns: [first!, { ...first!, turnId: 'turn-2', kind: 'notes', outcome: 'waiting', answerId: null }] });
    expect(open().review('plan-1', 'review-1')).toMatchObject({ state: 'findings', failure: null, turns: [{ outcome: 'round' }, { outcome: 'failed', reason: 'interrupted' }] });
  });

  it('settles an integration found sent from `plan.json`: by the complete version that names it, and else ended `interrupted`', () => {
    const store = open();
    const sent = { ...sampleReview().integrations[0]!, state: 'sent' as const, reason: null, settledAt: null };
    planWithReview(store, { integrations: [sent, { ...sent, id: 'integration-2' }] });
    store.write(target('plan-1'), { ...SOURCE, cause: 'integration', revises: 1, integration: { reviewId: 'review-1', integrationId: 'integration-1', findings: ['T1.1'] } }, 'two');
    clock = 7_000;
    const integrations = open().review('plan-1', 'review-1')?.integrations;
    expect(integrations?.map((one) => [one.id, one.state, one.produced, one.reason, one.settledAt])).toEqual([['integration-1', 'integrated', 2, null, 7_000], ['integration-2', 'ended', null, 'interrupted', 7_000]]);
  });

  it('settles nothing by a drafting or unfinished version that names the integration: a Codex draft’s `begin` and a crash after it (C45)', () => {
    const store = open();
    const sent = { ...sampleReview().integrations[0]!, state: 'sent' as const, reason: null, settledAt: null };
    planWithReview(store, { integrations: [sent] });
    const integration = { reviewId: 'review-1', integrationId: 'integration-1', findings: ['T1.1'] };
    // The draft's record names the integration from its `begin`, then the crash.
    const draft = store.begin(target('plan-1'), { ...SOURCE, cause: 'integration', revises: 1, integration });
    store.append(draft.planId, draft.version, 'half of two');
    store.flush();
    const again = open();
    expect(again.get('plan-1')?.versions[1]).toMatchObject({ state: 'unfinished', cause: 'integration', integration });
    expect(again.review('plan-1', 'review-1')?.integrations[0]).toMatchObject({ state: 'ended', reason: 'interrupted', produced: null });
  });

  it('settles at each crash point of a version’s write: before its record nothing names it, after it the version does', () => {
    const integration = { reviewId: 'review-1', integrationId: 'integration-1', findings: [] };
    const sent = { ...sampleReview().integrations[0]!, state: 'sent' as const, reason: null, settledAt: null };
    // The plan's first write is its first `version` and `record`; the crash falls on the second's.
    for (const point of ['version', 'record']) {
      rmSync(dir, { recursive: true, force: true });
      ids = 0;
      const crashing = open(crashAt(point, 2));
      planWithReview(crashing, { integrations: [sent] });
      expect(() => crashing.write(target('plan-1'), { ...SOURCE, cause: 'integration', revises: 1, integration }, 'two')).toThrow();
      expect(open().review('plan-1', 'review-1')?.integrations[0]?.state, point).toBe('ended');
    }
    // After the record, before the stale mark — the review's own write: integrated, and stale.
    rmSync(dir, { recursive: true, force: true });
    ids = 0;
    const crashing = open(crashAt('review', 2));
    planWithReview(crashing, { integrations: [sent] });
    crashing.write(target('plan-1'), { ...SOURCE, cause: 'integration', revises: 1, integration }, 'two');
    expect(onDisk('plan-1', 'review-1')['staleBy']).toBeNull();
    expect(open().review('plan-1', 'review-1')).toMatchObject({ staleBy: 2, integrations: [{ state: 'integrated', produced: 2 }] });
  });
});
