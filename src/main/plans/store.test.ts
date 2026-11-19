// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The plan store (docs/planning/_archive/M22b.md, Design 2; V2; C16, C18, C19, C59, C60, C62, C63): its record
// under the version envelope, whole versions and drafts, reads by range, and every write and
// removal stopped at each of its steps, as a crash would, then finished, lifted or cleaned at the
// next launch with nothing brought back.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROGRESS_WRITE_MS } from '@shared/contracts/chat';
import { PLAN_FILE } from './format';
import { createPlanStore, PlanStorageFailure, type PlanStore, type VersionSource } from './store';

const SOURCE: VersionSource = { sessionId: 's-1', turnId: 't-1', providerId: 'example', instanceId: 'example', model: 'model-a', cause: 'plan-turn', revises: null };
const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };

let dir: string;
let clock: number;
let ids: number;

beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'fatg-plans-')), 'plans');
  clock = 1_000;
  ids = 0;
});
afterEach(() => rmSync(path.dirname(dir), { recursive: true, force: true }));

function open(hook?: (point: string) => void, listed: ReadonlySet<string> | null = new Set(['project-1'])): PlanStore {
  const store = createPlanStore({ dir, now: () => clock, newId: () => `plan-${(ids += 1)}`, log: QUIET, ...(hook === undefined ? {} : { hook }) });
  store.recover(listed);
  return store;
}

const record = (planId: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(dir, planId, PLAN_FILE), 'utf8')) as Record<string, unknown>;
const files = (planId: string): string[] => readdirSync(path.join(dir, planId)).sort();
const target = (planId: string | null = null) => ({ planId, projectId: 'project-1', title: 'A plan' });
/** Stops a write at its named step, the n-th time it is reached, as a crash would. */
const crashAt = (point: string, times = 1) => (reached: string): void => { if (reached === point && (times -= 1) === 0) throw new Error(`crash at ${point}`); };

describe('a whole version (C16, C62)', () => {
  it('is its file, then the record that lists it complete, with its length and hash', () => {
    const store = open();
    const made = store.write(target(), SOURCE, '# Plan\n\n1. Do it.');
    expect(made).toMatchObject({ planId: 'plan-1', version: 1, length: 17 });
    expect(made.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(files('plan-1')).toEqual(['plan.json', 'v1.md']);
    expect(record('plan-1')).toMatchObject({ schemaVersion: 3, minReaderVersion: 3, id: 'plan-1', projectId: 'project-1', title: 'A plan', versions: [{ version: 1, state: 'complete', length: 17, hash: made.hash, cause: 'plan-turn', revises: null, sessionId: 's-1', providerId: 'example', model: 'model-a' }] });
    // Its workflow, made with it (decision 0029): ready on the version that came whole, its maker taking part.
    expect(record('plan-1')['workflow']).toEqual({ state: 'ready', revision: 2, version: 1, participants: ['s-1'], operation: null });
    expect(store.read('plan-1', 1, 0, 100)).toEqual({ state: 'complete', text: '# Plan\n\n1. Do it.', start: 0, length: 17, hash: made.hash });
  });

  it('chains: a plan’s next version is its highest number plus one, with how it came about', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    clock += 10;
    const second = store.write(target('plan-1'), { ...SOURCE, cause: 'feedback', revises: 1 }, 'two');
    expect(second.version).toBe(2);
    expect(store.get('plan-1')?.versions.map((version) => [version.version, version.cause, version.revises])).toEqual([[1, 'plan-turn', null], [2, 'feedback', 1]]);
    expect(() => store.write(target('no-such-plan'), SOURCE, 'x')).toThrow(PlanStorageFailure);
  });

  it('keeps a plan of 1 MiB and one of 4 MiB whole, read by ranges, with the hash of all of it', () => {
    const store = open();
    for (const units of [1024 * 1024, 4 * 1024 * 1024]) {
      const text = 'é'.repeat(units / 2) + 'x'.repeat(units / 2);
      const made = store.write(target(), SOURCE, text);
      expect(made.length).toBe(units);
      let read = '';
      for (let start = 0; start < units; start += 1024 * 1024) read += store.read(made.planId, 1, start, 1024 * 1024)?.text ?? '';
      expect(read === text).toBe(true);
      expect(store.read(made.planId, 1, 0, 1)?.hash).toBe(made.hash);
    }
  });
});

describe('a draft (C59)', () => {
  it('is listed drafting, appended with a running hash, written at the progress interval and renamed where the completed text is the same', () => {
    const store = open();
    const { planId, version } = store.begin(target(), SOURCE);
    expect(record(planId)).toMatchObject({ versions: [{ version: 1, state: 'drafting', length: 0 }] });
    store.append(planId, version, '# Pl');
    // Not on the disk yet, and readable all the same.
    expect(readFileSync(path.join(dir, planId, 'v1.draft.md'), 'utf8')).toBe('');
    expect(store.read(planId, version, 0, 100)?.text).toBe('# Pl');
    clock += PROGRESS_WRITE_MS;
    store.append(planId, version, 'an');
    expect(readFileSync(path.join(dir, planId, 'v1.draft.md'), 'utf8')).toBe('# Plan');
    expect(store.writing(planId)).toBe(true);
    const done = store.complete(planId, version, '# Plan', 'Plan');
    expect(files(planId)).toEqual(['plan.json', 'v1.md']);
    expect(record(planId)).toMatchObject({ title: 'Plan', versions: [{ state: 'complete', length: 6, hash: done.hash }] });
    expect(store.writing(planId)).toBe(false);
  });

  it('gives way to the completed text where its deltas differ, the draft deleted', () => {
    const store = open();
    const { planId, version } = store.begin(target(), SOURCE);
    store.append(planId, version, 'drafted text');
    store.complete(planId, version, 'completed text', 'A plan');
    expect(files(planId)).toEqual(['plan.json', 'v1.md']);
    expect(store.read(planId, version, 0, 100)?.text).toBe('completed text');
  });

  it('is unfinished at a Stop or a loss, kept with all it received, and found drafting at a launch is unfinished too', () => {
    const store = open();
    const first = store.begin(target(), SOURCE);
    store.append(first.planId, first.version, 'half a plan');
    store.unfinish(first.planId, first.version);
    expect(record(first.planId)).toMatchObject({ versions: [{ state: 'unfinished', length: 11 }] });
    expect(store.read(first.planId, 1, 0, 100)).toMatchObject({ state: 'unfinished', text: 'half a plan' });
    const second = store.begin(target(), SOURCE);
    store.append(second.planId, second.version, 'cut short');
    // fat-g ends with it open: what was flushed is what the next launch finds.
    store.flush();
    const again = open();
    expect(again.get(second.planId)?.versions[0]).toMatchObject({ state: 'unfinished', length: 9 });
    expect(again.read(second.planId, 1, 0, 100)?.text).toBe('cut short');
  });
});

describe('the record (C16; decision 0014)', () => {
  it('keeps the fields this build does not know, the plan’s and each version’s', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    const document = record('plan-1');
    const versions = document['versions'] as Record<string, unknown>[];
    writeFileSync(path.join(dir, 'plan-1', PLAN_FILE), JSON.stringify({ ...document, later: ['kept'], versions: versions.map((version) => ({ ...version, annotation: { by: 'later' } })) }));
    const again = open();
    again.write(target('plan-1'), SOURCE, 'two');
    expect(record('plan-1')).toMatchObject({ later: ['kept'], versions: [{ version: 1, annotation: { by: 'later' } }, { version: 2 }] });
  });

  it('is at schema 3, and keeps a version an integration made with its review, its integration and its findings (M22e, C35)', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    const integration = { reviewId: 'review-1', integrationId: 'integration-1', findings: ['T1.1', 'T2.3'] };
    store.write(target('plan-1'), { ...SOURCE, cause: 'integration', revises: 1, integration }, 'two');
    expect(record('plan-1')).toMatchObject({ schemaVersion: 3, minReaderVersion: 3, versions: [{ version: 1, cause: 'plan-turn' }, { version: 2, cause: 'integration', revises: 1, integration }] });
    expect((record('plan-1')['versions'] as Record<string, unknown>[])[0]).not.toHaveProperty('integration');
    expect(open().get('plan-1')?.versions[1]).toMatchObject({ cause: 'integration', integration });
    // An integration's cause with no review named, or a review named on another cause, is no record this build takes.
    const document = record('plan-1');
    const versions = document['versions'] as Record<string, unknown>[];
    writeFileSync(path.join(dir, 'plan-1', PLAN_FILE), JSON.stringify({ ...document, versions: [versions[0], { ...versions[1], integration: undefined }] }));
    expect(open().get('plan-1')).toBeNull();
  });

  it('refuses a schema-2 record as older, and leaves its folder whole, its reviews included (decision 0014; decision 0029)', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    const { workflow: _workflow, ...before } = record('plan-1');
    const older = JSON.stringify({ ...before, schemaVersion: 2, minReaderVersion: 2 });
    writeFileSync(path.join(dir, 'plan-1', PLAN_FILE), older);
    mkdirSync(path.join(dir, 'plan-1', 'reviews'));
    writeFileSync(path.join(dir, 'plan-1', 'reviews', 'review-1.json'), '{"kept": true}');
    const again = open();
    expect(again.all()).toEqual([]);
    expect(readFileSync(path.join(dir, 'plan-1', PLAN_FILE), 'utf8')).toBe(older);
    expect(files('plan-1')).toEqual(['plan.json', 'reviews', 'v1.md']);
    expect(readFileSync(path.join(dir, 'plan-1', 'reviews', 'review-1.json'), 'utf8')).toBe('{"kept": true}');
  });

  it('refuses a newer one, and one it cannot read, leaving each as it is and listing neither', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    store.write(target(), SOURCE, 'two');
    const newer = JSON.stringify({ ...record('plan-1'), schemaVersion: 4, minReaderVersion: 4 });
    writeFileSync(path.join(dir, 'plan-1', PLAN_FILE), newer);
    writeFileSync(path.join(dir, 'plan-2', PLAN_FILE), '{ not json');
    const again = open();
    expect(again.all()).toEqual([]);
    expect(readFileSync(path.join(dir, 'plan-1', PLAN_FILE), 'utf8')).toBe(newer);
    expect(files('plan-1')).toEqual(['plan.json', 'v1.md']);
    expect(readFileSync(path.join(dir, 'plan-2', PLAN_FILE), 'utf8')).toBe('{ not json');
  });
});

describe('a crash (C62)', () => {
  it('before a new plan’s first record leaves nothing: its folder is deleted at the next launch', () => {
    const store = open(crashAt('record'));
    expect(() => store.write(target(), SOURCE, 'text')).toThrow();
    expect(files('plan-1')).toEqual(['v1.md']);
    expect(open().all()).toEqual([]);
    expect(existsSync(path.join(dir, 'plan-1'))).toBe(false);
  });

  it('before a version’s record leaves the plan as it was: the unnamed file is deleted, nothing is listed of it', () => {
    open().write(target(), SOURCE, 'one');
    const store = open(crashAt('record'));
    expect(() => store.write(target('plan-1'), SOURCE, 'two')).toThrow();
    const again = open();
    expect(again.get('plan-1')?.versions.map((version) => version.version)).toEqual([1]);
    expect(files('plan-1')).toEqual(['plan.json', 'v1.md']);
  });

  it('between a draft’s rename and its record leaves it unfinished with the text that is there', () => {
    const store = open(crashAt('record', 2));
    const { planId, version } = store.begin(target(), SOURCE);
    store.append(planId, version, 'whole');
    expect(() => store.complete(planId, version, 'whole', 'A plan')).toThrow();
    const again = open();
    expect(again.get(planId)?.versions[0]).toMatchObject({ state: 'unfinished', length: 5 });
    expect(files(planId)).toEqual(['plan.json', 'v1.draft.md']);
  });

  it('in a plan’s removal: before its mark the plan stays; after it the removal is finished', () => {
    open().write(target(), SOURCE, 'one');
    expect(() => open(crashAt('mark')).remove('plan-1')).toThrow();
    expect(open().get('plan-1')).not.toBeNull();
    // The folder renamed, then the crash: the mark is finished at the next launch.
    expect(open(crashAt('delete')).remove('plan-1')).toBe('removed');
    expect(readdirSync(dir)).toEqual(['.removing-plan-1']);
    expect(open().get('plan-1')).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('in a project’s removal, at each of its points, is finished where the project is gone and lifted where it is still listed', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    store.write(target(), SOURCE, 'two');
    store.write({ ...target(), projectId: 'project-2' }, SOURCE, 'other');
    // Its mark written, its records write not: the project is still listed, and the mark is lifted.
    expect(store.markProject('project-1')).toEqual(['plan-1', 'plan-2']);
    expect(store.list('project-1')).toEqual([]);
    expect(open().list('project-1').map((plan) => plan.id).sort()).toEqual(['plan-1', 'plan-2']);
    expect(readdirSync(dir).some((entry) => entry.endsWith('.json'))).toBe(false);
    // Its records write landed, then the crash: the project is gone, and the removal is finished.
    open().markProject('project-1');
    const gone = open(undefined, new Set(['project-2']));
    expect(gone.all().map((plan) => plan.id)).toEqual(['plan-3']);
    expect(readdirSync(dir).sort()).toEqual(['plan-3']);
  });

  it('in the middle of a project’s deletions is finished at the next launch, and never folder by folder as two plans’ removals', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    store.write(target(), SOURCE, 'two');
    const crashing = open(crashAt('project-delete', 2));
    crashing.markProject('project-1');
    expect(() => crashing.finishProject('project-1')).toThrow();
    // One folder gone, the other and the mark still there: the next launch reads the mark, not the folders.
    expect(readdirSync(dir).sort()).toEqual(['.removing-project-1.json', 'plan-2']);
    open(undefined, new Set());
    expect(readdirSync(dir)).toEqual([]);
  });

  it('deletes nothing of a project’s mark while the records cannot be read, and lists none of its plans meanwhile', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    store.markProject('project-1');
    const unread = open(undefined, null);
    expect(unread.all()).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(['.removing-project-1.json', 'plan-1']);
    // Read again once they can be: a project still listed gets its plans back.
    expect(open().all().map((plan) => plan.id)).toEqual(['plan-1']);
  });

  it('a project’s removal with no plan is a mark and nothing else, and one with no chat at all takes its plans', () => {
    const store = open();
    expect(store.markProject('project-9')).toEqual([]);
    store.finishProject('project-9');
    expect(readdirSync(dir)).toEqual([]);
    store.write(target(), SOURCE, 'one');
    store.markProject('project-1');
    store.finishProject('project-1');
    expect(store.all()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('cleans what no record names: a stray file, a folder with no record, a temporary write', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    writeFileSync(path.join(dir, 'plan-1', 'v7.md'), 'stray');
    writeFileSync(path.join(dir, 'plan-1', 'plan.json.tmp'), '{}');
    mkdirSync(path.join(dir, 'plan-9'));
    writeFileSync(path.join(dir, 'stray.txt'), 'x');
    open();
    expect(files('plan-1')).toEqual(['plan.json', 'v1.md']);
    expect(readdirSync(dir)).toEqual(['plan-1']);
  });
});

describe('the registry (C18, C21, C63)', () => {
  it('lists a project’s plans newest first, from the plans’ folder alone', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    clock += 100;
    store.write(target(), SOURCE, 'two');
    clock += 100;
    store.write(target('plan-1'), SOURCE, 'one, again');
    expect(store.list('project-1').map((plan) => plan.id)).toEqual(['plan-1', 'plan-2']);
    expect(open().list('project-1').map((plan) => plan.id)).toEqual(['plan-1', 'plan-2']);
    expect(store.list('project-2')).toEqual([]);
  });

  it('removes a plan with everything in its folder, and not while a version of it is written', () => {
    const store = open();
    const { planId } = store.begin(target(), SOURCE);
    expect(store.remove(planId)).toBe('writing');
    store.unfinish(planId, 1);
    expect(store.remove(planId)).toBe('removed');
    expect(existsSync(path.join(dir, planId))).toBe(false);
    expect(store.remove(planId)).toBe('unknown');
  });

  it('counts the plans and their size, and those whose project is no longer listed', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    store.write({ ...target(), projectId: 'gone' }, SOURCE, 'two');
    const storage = store.storage(new Set(['project-1']));
    expect(storage).toMatchObject({ count: 2, reviews: 0, orphans: 1 });
    expect(storage.bytes).toBeGreaterThan(0);
    expect(store.storage(null).orphans).toBe(0);
  });
});

describe('the workflow (decision 0029)', () => {
  it('is its maker’s writing while its first version drafts, and ready on it, in the same write, once it completes', () => {
    const store = open();
    const { planId, version } = store.begin(target(), SOURCE);
    expect(record(planId)['workflow']).toEqual({
      state: 'revising', revision: 1, version: null, participants: ['s-1'],
      operation: { id: planId, kind: 'revision', sessionId: 's-1', version: null, hash: null, turns: ['t-1'], reviewId: null, at: 1_000 },
    });
    store.complete(planId, version, '# Plan', 'Plan');
    expect(record(planId)['workflow']).toEqual({ state: 'ready', revision: 2, version: 1, participants: ['s-1'], operation: null });
  });

  it('readies a revision on the version it wrote, its writer taking part, and leaves any other operation’s state alone', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    store.setWorkflow('plan-1', (plan) => ({ ...plan.workflow, state: 'revising', operation: { id: 'op-1', kind: 'revision', sessionId: 's-2', version: 1, hash: null, turns: ['t-2'], reviewId: null, at: 5, unknown: {} } }));
    store.write(target('plan-1'), { ...SOURCE, sessionId: 's-2', turnId: 't-2', cause: 'feedback', revises: 1 }, 'two');
    expect(store.get('plan-1')?.workflow).toMatchObject({ state: 'ready', version: 2, participants: ['s-1', 's-2'], operation: null });
    store.setWorkflow('plan-1', (plan) => ({ ...plan.workflow, state: 'implementing', operation: { id: 'op-2', kind: 'implementation', sessionId: 's-1', version: 2, hash: null, turns: ['t-3'], reviewId: null, at: 6, unknown: {} } }));
    store.write(target('plan-1'), SOURCE, 'three');
    expect(store.get('plan-1')?.workflow).toMatchObject({ state: 'implementing', version: 2 });
  });

  it('writes a change of it whole, keeps what this build does not know at each level, and reads it back after a restart', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    const document = record('plan-1') as Record<string, unknown> & { workflow: Record<string, unknown> };
    const operation = { id: 'op-1', kind: 'review', sessionId: 's-9', version: 1, hash: null, turns: [], reviewId: 'review-1', at: 7, later: 'op' };
    writeFileSync(path.join(dir, 'plan-1', PLAN_FILE), JSON.stringify({ ...document, workflow: { ...document.workflow, state: 'reviewing', operation, later: 'workflow' } }));
    const again = open();
    expect(again.get('plan-1')?.workflow).toMatchObject({ state: 'reviewing', operation: { kind: 'review', reviewId: 'review-1', unknown: { later: 'op' } }, unknown: { later: 'workflow' } });
    again.setWorkflow('plan-1', (plan) => ({ ...plan.workflow, participants: [...plan.workflow.participants, 's-3'] }));
    expect(record('plan-1')['workflow']).toMatchObject({ participants: ['s-1', 's-3'], later: 'workflow', operation: { later: 'op' } });
    // A change that changes nothing writes nothing; one of a plan not held is refused.
    expect(again.setWorkflow('plan-1', () => null)).toBe(again.get('plan-1'));
    expect(() => again.setWorkflow('plan-9', (plan) => plan.workflow)).toThrow(PlanStorageFailure);
  });

  it('reads a workflow that does not hold together as corrupt, leaving it as it is', () => {
    const store = open();
    store.write(target(), SOURCE, 'one');
    const document = record('plan-1') as Record<string, unknown> & { workflow: Record<string, unknown> };
    for (const workflow of [
      // An operation in `ready`, none in `reviewing`, a version that is no complete one of its own, an unknown state.
      { ...document.workflow, operation: { id: 'op', kind: 'review', sessionId: 's', version: 1, hash: null, turns: [], reviewId: null, at: 1 } },
      { ...document.workflow, state: 'reviewing' },
      { ...document.workflow, version: 4 },
      { ...document.workflow, state: 'somewhere' },
    ]) {
      const written = JSON.stringify({ ...document, workflow });
      writeFileSync(path.join(dir, 'plan-1', PLAN_FILE), written);
      expect(open().get('plan-1')).toBeNull();
      expect(readFileSync(path.join(dir, 'plan-1', PLAN_FILE), 'utf8')).toBe(written);
    }
  });
});
