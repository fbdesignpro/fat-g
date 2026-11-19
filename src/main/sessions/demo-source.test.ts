// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The demo source (docs/planning/_archive/M14.md, V5; C27–C29), with a replaced clock and timer, on the real
// session service and records store: what it sends is what the service takes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogState } from '@shared/contracts/catalog';
import type { ModelPreset } from '@shared/contracts/presets';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../tests/support/catalog';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { createAppStateStore } from '../state/app-state-store';
import { createDemoSource, DEMO_FRAMES, DEMO_PHASE, type DemoSource } from './demo-source';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const OTHER = '9b2d6c1e-4f3a-4e8b-8c7d-6a5b4c3d2e1f';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-01-22T13:23:00.000Z');

let dir: string;
let file: string;
let clock: number;
let records: RecordsStore;
let service: SessionService;
let demo: DemoSource;
let scheduled: (() => void) | null;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const timers = { setInterval: vi.fn((run: () => void, _ms: number) => { scheduled = run; return 1; }), clearInterval: vi.fn(() => { scheduled = null; }) };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-demo-'));
  file = path.join(dir, RECORDS_FILE);
  clock = AT;
  scheduled = null;
  for (const spy of [...Object.values(log), ...Object.values(timers)]) spy.mockClear();
});
afterEach(async () => {
  demo?.stop();
  // A record write still under way would make the folder again once it is removed.
  await service?.settled();
  service?.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const project = (id = PROJECT, name = 'fat-g', providers = ['codex']) => ({ id, name, color: 'teal', hidden: false, providers, roots: [{ path: `D:\\Code\\${name}` }] });
const session = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: null, nameSource: null,
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null, ...overrides,
});
const place = (sessions: unknown[], projects: unknown[] = [project()]) => writeFileSync(file, JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects, sessions }));
const CATALOG: CatalogState = { ...sampleCatalog([]), providers: [sampleCatalogProvider({ id: 'codex', models: [sampleModel({ key: 'gpt-6-sol', listedDefault: true, listedDefaultEffort: 'low' })] })] };

function open(seed?: { catalog?: () => CatalogState | undefined }) {
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', now: () => clock, log });
  service = createSessionService({ records, store: createAppStateStore(), now: () => clock, platform: 'win32', log });
  const create = vi.fn((projectId: string, preset: ModelPreset) => service.create(projectId, preset));
  demo = createDemoSource({
    sessions: () => service.snapshot(),
    ...(seed === undefined ? {} : { seed: {
      projects: () => records.getView().projects.flatMap((entry) => (entry.kind === 'project' ? [{ id: entry.id, providers: entry.providers, sessions: entry.sessions }] : [])),
      catalog: seed.catalog ?? (() => CATALOG),
      create,
    } }),
    stepMs: 100,
    timers,
    log,
  });
  service.attach(demo);
  return { create };
}

const summary = (n: number) => service.snapshot().sessions.find((entry) => entry.record.id === S(n))?.summary;
/** One frame, a second later. */
const step = (): void => { clock += 1000; scheduled?.(); };
const shape = (n: number): string => {
  const state = summary(n);
  if (state === undefined) return 'gone';
  return [state.status, state.attention === null ? '-' : `${state.attention.kind}×${state.attention.count}`, state.action?.label ?? '-', `${state.activeWorkers}/${state.agents.length}`].join(' | ');
};
const settle = async (): Promise<void> => {
  await service.settled();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.settled();
};
/**
 * A seed makes its three records one after the other, each a write of its own, and names each with
 * another: six writes to disk, which a slow machine does not finish inside `waitFor`'s own second.
 */
const seeded = (count: number) => vi.waitFor(async () => {
  await settle();
  expect(records.getView().sessions.filter((entry) => entry.name !== null)).toHaveLength(count);
}, { timeout: 4_000 });

describe('the script (V5; C28)', () => {
  it('takes one session through every state, then starts over at a new turn', () => {
    place([session(1)]);
    open();
    demo.start();
    const seen = [shape(1)];
    for (let frame = 1; frame < DEMO_FRAMES + 2; frame += 1) { step(); seen.push(shape(1)); }
    expect(seen).toEqual([
      'not-started | - | - | 0/0', // 1. nothing
      'running | - | Thinking… | 0/0', // 2. a turn starts
      'running | - | Reading notes.txt | 0/0', // 3. a file…
      'running | - | I’ll read sample.txt to find the cat’s name, then compare i… | 0/0', // …then a provider's sentence, at the clamp
      'running | - | I’ll read sample.txt to find the cat’s name, then compare i… | 3/3', // 4. three workers…
      'running | - | I’ll read sample.txt to find the cat’s name, then compare i… | 1/3', // …then two end
      'running | question×1 | Asking a question | 1/3', // 5. a question…
      'running | question×3 | Asking a question | 1/3', // …then a second, of two questions (M100b, C24)
      'running | - | Waiting for a sub-agent | 1/3', // 6. answered; the turn ends with a worker running
      'not-started | ready×1 | - | 0/3', // 7. the last worker ends: READY
      // The finished workers stay listed across the turns that follow (M106, C26).
      'running | approval×1 | Waiting for your approval | 0/3', // 8. another turn, an approval…
      'running | - | Using a tool | 0/3', // …then answered
      'not-started | error×1 | - | 0/3', // 9. the turn fails: ERROR
      'not-started | error×1 | - | 0/3', // 10. a pause
      'running | - | Thinking… | 0/3', // then step 2 again
      'running | - | Reading notes.txt | 0/3',
    ]);
    // Nothing it sent was refused or discarded.
    expect(log.warn).not.toHaveBeenCalled();
  });

  // M106 (V10; C39): the rows are drawn with the session’s avatar by resolution, and one assumed.
  it('names the session’s own model on two of its three workers, and none on the third', () => {
    place([session(1)]);
    open();
    demo.start();
    for (let frame = 0; frame < DEMO_FRAMES && (summary(1)?.agents.length ?? 0) < 3; frame += 1) step();
    expect(summary(1)?.agents.map((agent) => [agent.label, agent.model])).toEqual([['Explore the login flow', 'gpt-6-sol'], ['Run the test suite', 'gpt-6-sol'], ['Check the release notes', null]]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reaches every state a capsule can show', () => {
    place([session(1)]);
    open();
    demo.start();
    const statuses = new Set<string>();
    const attention = new Set<string>();
    let workers = false;
    let failedWorker = false;
    let waiting = false;
    for (let frame = 0; frame < DEMO_FRAMES + 2; frame += 1) {
      const state = summary(1);
      statuses.add(state?.status ?? '');
      if (state?.attention != null) attention.add(state.attention.kind);
      workers ||= (state?.activeWorkers ?? 0) > 1;
      failedWorker ||= state?.agents.some((agent) => agent.state === 'failed') ?? false;
      waiting ||= state?.action?.kind === 'waiting';
      step();
    }
    expect(statuses).toEqual(new Set(['not-started', 'running']));
    expect(attention).toEqual(new Set(['question', 'ready', 'approval', 'error']));
    expect([workers, failedWorker, waiting]).toEqual([true, true, true]);
  });

  it('starts each session at a different frame, shown at once, so the list is out of phase', () => {
    place([session(1), session(2), session(3), session(4)]);
    open();
    demo.start();
    const shapes = [1, 2, 3, 4].map(shape);
    expect(new Set(shapes).size).toBe(4);
    expect(shapes[0]).toBe('not-started | - | - | 0/0');
    // The second is DEMO_PHASE frames in: its sentence is up.
    expect(DEMO_PHASE).toBe(3);
    expect(shapes[1]).toBe('running | - | I’ll read sample.txt to find the cat’s name, then compare i… | 0/0');
    expect(shapes[2]).toBe('running | question×1 | Asking a question | 1/3');
    expect(shapes[3]).toBe('not-started | ready×1 | - | 0/3');
    step();
    expect(new Set([1, 2, 3, 4].map(shape)).size).toBe(4);
  });

  it('leaves a completed session alone, and one completed on the way from then on', async () => {
    place([session(1, { completedAt: AT - 100 }), session(2)]);
    open();
    demo.start();
    for (let frame = 0; frame < 4; frame += 1) step();
    expect(shape(1)).toBe('not-started | - | - | 0/0');
    expect(records.getSession(S(1))?.completedAt).toBe(AT - 100);
    // Session 2 is between turns only at its READY and ERROR frames; walk there, then complete it.
    while (summary(2)?.status === 'running' || summary(2)?.attention === null) step();
    expect(await service.complete(S(2))).toEqual({ status: 'saved' });
    const before = shape(2);
    for (let frame = 0; frame < DEMO_FRAMES; frame += 1) step();
    await settle();
    expect(shape(2)).toBe(before);
    expect(records.getSession(S(2))?.completedAt).not.toBeNull();
  });

  it('writes what any source’s turns write — the last turn and the last-active time — and no reference', async () => {
    place([session(1)]);
    open();
    demo.start();
    step();
    await settle();
    expect(records.getSession(S(1))).toMatchObject({ reference: null, folder: null, lastTurn: { startedAt: AT + 1000, endedAt: null, outcome: null }, lastActiveAt: AT + 1000 });
    for (let frame = 0; frame < DEMO_FRAMES; frame += 1) step();
    await settle();
    expect(readFileSync(file, 'utf8')).not.toMatch(/"reference": "|"folder": "/);
  });
});

describe('without seed (V5; C28)', () => {
  it('creates no record, in a project with sessions or without', async () => {
    place([session(1)], [project(), project(OTHER, 'website')]);
    const before = readFileSync(file, 'utf8');
    open();
    demo.start();
    await settle();
    expect(records.getView().sessions).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(JSON.parse(before));
  });
});

describe('with seed (V5; C29)', () => {
  it('adds three sessions to a project that has none, with the default preset and fixed names of the lowest rank, and none to one with sessions', async () => {
    place([session(1)], [project(), project(OTHER, 'website')]);
    const { create } = open({});
    demo.start();
    await seeded(3);
    const added = records.getView().sessions.filter((entry) => entry.projectId === OTHER);
    expect(added.map((entry) => [entry.name, entry.nameSource, entry.providerId, entry.instanceId, entry.model, entry.effort, entry.reference])).toEqual([
      ['Create plan', 'first-message', 'codex', 'default', 'gpt-6-sol', 'low', null],
      ['Fix login', 'first-message', 'codex', 'default', 'gpt-6-sol', 'low', null],
      ['Review the notes', 'first-message', 'codex', 'default', 'gpt-6-sol', 'low', null],
    ]);
    expect(records.getView().sessions.filter((entry) => entry.projectId === PROJECT)).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(3);
    // Each is selected as it is created, as Start session's is: the last one made stays selected (C122).
    expect(service.snapshot().selectedId).toBe(added[0]?.id);
    // And never again, now that it has some.
    for (let frame = 0; frame < 5; frame += 1) step();
    await settle();
    expect(create).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('[sessions] demo source on (seed)');
  });

  it('reports each seeded session’s generated title at the next frame, which replaces its first-prompt name (M26)', async () => {
    place([], [project()]);
    open({});
    demo.start();
    await seeded(3);
    step();
    await settle();
    expect(records.getView().sessions.map((entry) => [entry.name, entry.nameSource])).toEqual([
      ['Plan the next release', 'generated'],
      ['Fix the login form', 'generated'],
      ['Review the meeting notes', 'generated'],
    ]);
  });

  it('waits for a provider of the project to report its models', async () => {
    place([], [project()]);
    let catalog: CatalogState = { ...CATALOG, providers: CATALOG.providers.map((provider) => ({ ...provider, source: { kind: 'none' }, models: [] })) };
    const { create } = open({ catalog: () => catalog });
    demo.start();
    step();
    await settle();
    expect(create).not.toHaveBeenCalled();
    catalog = CATALOG;
    step();
    await seeded(3);
    expect(records.getView().sessions).toHaveLength(3);
  });

  // M14b, V9 (C31): an added account is the user's to start a session on.
  it('seeds on the provider’s first instance, whatever an added one lists, and waits when only an added one has reported', async () => {
    place([], [project()]);
    const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
    const work = sampleCatalogProvider({ id: 'codex', instanceId: WORK, models: [sampleModel({ key: 'gpt-6-team', listedDefault: true, listedDefaultEffort: 'low' })] });
    const silent = CATALOG.providers.map((provider) => ({ ...provider, source: { kind: 'none' as const }, models: [] }));
    // The added account's entry comes first here, and it alone lists a model.
    let catalog: CatalogState = { ...CATALOG, providers: [work, ...silent] };
    const { create } = open({ catalog: () => catalog });
    demo.start();
    step();
    await settle();
    expect(create).not.toHaveBeenCalled();
    catalog = { ...CATALOG, providers: [work, ...CATALOG.providers] };
    step();
    await seeded(3);
    expect(records.getView().sessions.map((entry) => [entry.instanceId, entry.model])).toEqual([['default', 'gpt-6-sol'], ['default', 'gpt-6-sol'], ['default', 'gpt-6-sol']]);
  });

  it('drives the sessions it added like any others', async () => {
    place([], [project()]);
    open({});
    demo.start();
    await seeded(3);
    for (let frame = 0; frame < 3; frame += 1) step();
    expect(service.runningCount()).toBeGreaterThan(0);
    await settle();
  });
});

describe('the timer (V5)', () => {
  it('runs one interval of the step length, stops with the source, and is held by pause', () => {
    place([session(1)]);
    open();
    expect(timers.setInterval).not.toHaveBeenCalled();
    demo.start();
    demo.start();
    expect(timers.setInterval.mock.calls.map(([, ms]) => ms)).toEqual([100]);
    demo.pause();
    expect(scheduled).toBeNull();
    const held = shape(1);
    step();
    expect(shape(1)).toBe(held);
    demo.resume();
    step();
    expect(shape(1)).not.toBe(held);
    demo.stop();
    expect(scheduled).toBeNull();
    demo.resume();
    expect(scheduled).toBeNull();
    expect(log.info).toHaveBeenCalledWith('[sessions] demo source on');
  });

  it('sends nothing once the service has ended the turns for a quit', async () => {
    place([session(1)]);
    open();
    demo.start();
    step();
    await service.endRunningTurns();
    const stopped = shape(1);
    step();
    step();
    expect(shape(1)).toBe(stopped);
    expect(stopped).toBe('not-started | stopped×1 | - | 0/0');
  });
});

describe('what it reaches (V5; C28)', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, 'demo-source.ts'), 'utf8');

  it('starts nothing and reads nothing: no process, no file system, no environment, no store', () => {
    expect(source).not.toMatch(/child_process|node:fs|node:path|electron|process\.env|records\/store|spawn\(|ctx\.processes/);
    expect([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort()).toEqual([
      './source', '@shared/contracts/catalog', '@shared/contracts/instances', '@shared/contracts/presets', '@shared/contracts/sessions',
    ]);
  });

  it('sends no reference: a demo turn is never a real one', () => {
    expect(source).not.toMatch(/reference-set/);
  });
});
