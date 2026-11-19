// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
// V37, V38, V42, V45, V12, V15 (docs/planning/_archive/M13.md, Design 5): the catalog in main.
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Assignments, AvatarSource, ResolvedAvatar } from '@shared/contracts/avatars';
import type { ModelReport, ReportedModel } from '@shared/contracts/catalog';
import type { AgentProvider, ProviderDefinition, ProviderEvent } from '@shared/provider-kit/provider';
import { sampleProvider, sampleWindow } from '../../../tests/support/app-state';
import { sampleCatalogDefaults } from '../../../tests/support/catalog';
import { createAvatarResolver } from '../avatars/assignments';
import { InvalidProviderDefaults } from '../catalog/defaults';
import type { OverrideIo } from '../catalog/override';
import { createAppStateStore } from '../state/app-state-store';
import { type CatalogServiceOptions, createCatalogService, MODEL_REREAD_MS } from './catalog-service';
import { createUsageService } from './usage-service';

/** A provider's first instance: the one every provider has. */
const first = (providerId: string) => ({ providerId, instanceId: 'default' });

const DIR = 'C:\\Users\\someone\\AppData\\Roaming\\fat-g';
const FILE = path.join(DIR, 'catalog.json');
const START = 1_578_924_800_000;

function definition(id: string): ProviderDefinition {
  return {
    descriptor: {
      id, displayName: id, installGuidance: '', loginCommand: '', minPollIntervalSec: 60,
      capabilities: { account: true, usage: 'poll', sessions: false, history: false, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null },
    },
    catalogDefaults: sampleCatalogDefaults(),
    installationGuide: `https://example.test/${id}`,
    executableNames: [id], installDirectoryHints: [], factory: vi.fn(),
  };
}

/** A runtime whose events the test sends; `asks` counts the model reads the service asked for. */
function fakeProvider(canAsk = true) {
  // A set, as the adapters keep: the catalog and the usage service each subscribe.
  const listeners = new Set<(event: ProviderEvent) => void>();
  const provider: AgentProvider = {
    descriptor: definition('codex').descriptor,
    detect: vi.fn(), getAccount: vi.fn(), getUsage: vi.fn(), dispose: vi.fn(),
    subscribe(next) { listeners.add(next); return () => listeners.delete(next); },
    ...(canAsk ? { reportModels: vi.fn(async () => undefined) } : {}),
  };
  return { provider, emit: (event: ProviderEvent) => { for (const listener of listeners) listener(event); }, subscribed: () => listeners.size > 0 };
}

function files(initial: Record<string, string> = {}) {
  const stored = new Map(Object.entries(initial));
  const io: OverrideIo = {
    size(file) {
      const text = stored.get(file);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file, stat '${file}'`), { code: 'ENOENT' });
      return Buffer.byteLength(text);
    },
    readText(file) {
      const text = stored.get(file);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
  };
  return { io, set: (text: string) => stored.set(FILE, text) };
}

function setup(options: { ids?: string[]; override?: string; io?: OverrideIo; avatar?: (providerId: string, key: string) => ResolvedAvatar | null; label?: CatalogServiceOptions['label']; smallModelVersion?: ProviderDefinition['smallModelVersion'] } = {}) {
  let now = START;
  const store = createAppStateStore();
  const disk = files(options.override === undefined ? {} : { [FILE]: options.override });
  const log = { info: vi.fn(), warn: vi.fn() };
  const service = createCatalogService({
    definitions: (options.ids ?? ['claude', 'codex']).map((id) => ({ ...definition(id), ...(options.smallModelVersion === undefined ? {} : { smallModelVersion: options.smallModelVersion }) })), store, dir: DIR, now: () => now, log, io: options.io ?? disk.io,
    ...(options.avatar === undefined ? {} : { avatar: options.avatar }),
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  const provider = (id: string) => {
    const entry = store.getSnapshot().catalog?.providers.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new Error(`no ${id}`);
    return entry;
  };
  /**
   * One usage read of `id` that ends as `outcome`: `during` runs between its start and its end, as
   * a model report sent by the read itself would (Claude's usage session).
   */
  const read = (id: string, outcome: Outcome, options: { byRefresh?: boolean; during?: () => void } = {}) => {
    const startedAt = now;
    now += 1000;
    options.during?.();
    now += 1000;
    service.readEnded(first(id), { outcome, byRefresh: options.byRefresh ?? false, startedAt });
  };
  return { service, store, disk, log, provider, read, advance: (ms: number) => { now += ms; }, seq: () => store.getSnapshot().seq };
}

const row = (key: string, extra: Partial<ReportedModel> = {}): ReportedModel => ({
  key, resolvedId: key, name: key.toUpperCase(), description: null, efforts: ['low'], listedDefaultEffort: null, listedDefault: false, hidden: false, speedTiers: [], ...extra,
});
const report = (...models: ReportedModel[]): ModelReport => ({ models, speedTierReason: null, dropped: 0 });
const models = (event: ModelReport): ProviderEvent => ({ type: 'models', report: event });
const keys = (entry: { models: readonly { key: string }[] }) => entry.models.map((model) => model.key);
type Outcome = 'account' | 'signed-out' | 'api-key' | 'cloud-provider' | 'other';

describe('the catalog at start (C19, C43)', () => {
  it('is in the app state before any window opens: one entry per provider, in registry order, listing no model until its CLI reports (C75, C76)', () => {
    const h = setup();
    expect(h.store.getSnapshot().catalog?.providers.map((entry) => [entry.id, entry.source.kind])).toEqual([['claude', 'none'], ['codex', 'none']]);
    expect(keys(h.provider('codex'))).toEqual([]);
    expect(h.store.getSnapshot().catalog?.override).toEqual({ kind: 'none', path: FILE });
  });

  it('stops the start when a provider’s defaults fail the contract (C24)', () => {
    const broken = { ...definition('codex'), catalogDefaults: { models: 'none' } };
    expect(() => createCatalogService({ definitions: [broken], store: createAppStateStore(), dir: DIR, io: files().io, log: { info: vi.fn(), warn: vi.fn() } })).toThrow(InvalidProviderDefaults);
  });
});

describe('reports per runtime (V37; C32, C80, C95)', () => {
  it('refreshes the automatic small-model choice per account on reports and removes it when that runtime detaches', () => {
    const h = setup({ smallModelVersion: (id) => id.startsWith('small-') ? id.slice(6).split('.').map(Number) : null });
    expect(h.provider('codex').smallModel).toBeUndefined();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('small-6.9'), row('large-7.0'))));
    expect(h.provider('codex').smallModel).toBe('small-6.9');
    expect(h.provider('claude').smallModel).toBeUndefined();
    codex.emit(models(report(row('small-6.9'), row('small-6.10'), { ...row('small-7.0'), hidden: true })));
    expect(h.provider('codex').smallModel).toBe('small-6.10');
    h.service.detach(first('codex'));
    expect(h.provider('codex').smallModel).toBeUndefined();
  });

  it('takes a report as the list, and a newer one in its place', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'), row('b'))));
    expect(h.provider('codex').source).toEqual({ kind: 'report', at: START });
    expect(keys(h.provider('codex'))).toEqual(['a', 'b']);
    h.advance(1000);
    codex.emit(models(report(row('c'))));
    expect(keys(h.provider('codex'))).toEqual(['c']);
    expect(h.provider('codex').source).toEqual({ kind: 'report', at: START + 1000 });
    expect(h.log.info).toHaveBeenLastCalledWith('[catalog] codex reported 1 models, 0 hidden, 0 dropped');
  });

  it('leaves seq where it was for an equal report, and keeps the time the list was first reported', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'))));
    const seq = h.seq();
    h.advance(60_000);
    codex.emit(models({ ...report(row('a')), dropped: 3 }));
    expect(h.seq()).toBe(seq);
    expect(h.provider('codex').source).toEqual({ kind: 'report', at: START });
  });

  it('drops the report on detach, and changes nothing when none is held', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    const before = h.seq();
    h.service.detach(first('codex'));
    expect(h.seq()).toBe(before);
    h.service.attach({ id: 'codex', generation: 2, provider: codex.provider });
    codex.emit(models(report(row('a'))));
    h.service.detach(first('codex'));
    expect(h.provider('codex').source).toEqual({ kind: 'none' });
    expect(codex.subscribed()).toBe(false);
  });

  it('ignores an event from an earlier runtime', () => {
    const h = setup();
    const first = fakeProvider();
    const second = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: first.provider });
    h.service.attach({ id: 'codex', generation: 2, provider: second.provider });
    first.emit(models(report(row('stale'))));
    expect(h.provider('codex').source.kind).toBe('none');
    second.emit(models(report(row('fresh'))));
    expect(keys(h.provider('codex'))).toEqual(['fresh']);
  });

  it('never takes a report with no model, nor one that fails the contract', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'))));
    codex.emit(models(report()));
    codex.emit(models(report(row('bad key'))));
    expect(keys(h.provider('codex'))).toEqual(['a']);
    expect(h.log.warn).toHaveBeenCalledWith('[catalog] codex sent a model report fat-g refused');
  });

  it('lists no model for a provider that is never attached, as a disabled one is', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'))));
    expect(h.provider('claude').source.kind).toBe('none');
  });
});

describe('the account changing (V38, C91)', () => {
  it.each(['signed-out', 'api-key', 'cloud-provider'] as const)('a read that ends %s after a signed-in one drops the list from before, asks for a fresh one, and takes it', (outcome) => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    h.read('codex', 'account', { during: () => codex.emit(models(report(row('a')))) });
    h.read('codex', outcome);
    expect(h.provider('codex').source.kind).toBe('none');
    expect(codex.provider.reportModels).toHaveBeenCalledOnce();
    codex.emit(models(report(row('b'))));
    expect(keys(h.provider('codex'))).toEqual(['b']);
  });

  it('keeps a list that arrived during the read that saw the change: it is the account now', () => {
    const h = setup();
    const claude = fakeProvider();
    h.service.attach({ id: 'claude', generation: 1, provider: claude.provider });
    h.read('claude', 'api-key', { during: () => claude.emit(models(report(row('opus')))) });
    h.read('claude', 'account', { during: () => claude.emit(models(report(row('sonnet')))) });
    expect(keys(h.provider('claude'))).toEqual(['sonnet']);
    expect(claude.provider.reportModels).not.toHaveBeenCalled();
  });

  it('asks nothing more while the account stays as it is, and a failed read changes nothing', () => {
    const h = setup();
    const claude = fakeProvider();
    h.service.attach({ id: 'claude', generation: 1, provider: claude.provider });
    h.read('claude', 'api-key');
    claude.emit(models(report(row('opus'))));
    h.read('claude', 'api-key');
    h.read('claude', 'other');
    h.read('claude', 'api-key');
    expect(claude.provider.reportModels).toHaveBeenCalledOnce();
    expect(keys(h.provider('claude'))).toEqual(['opus']);
  });

  it('keeps the list through a read that found usage unsupported or unavailable, which ends with an account', () => {
    const h = setup();
    const claude = fakeProvider();
    h.service.attach({ id: 'claude', generation: 1, provider: claude.provider });
    h.read('claude', 'account', { during: () => claude.emit(models(report(row('opus')))) });
    h.read('claude', 'account');
    expect(keys(h.provider('claude'))).toEqual(['opus']);
  });

  it('takes the latest report, whenever it arrives', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    h.read('codex', 'account', { during: () => codex.emit(models(report(row('a')))) });
    h.read('codex', 'signed-out');
    codex.emit(models(report(row('late'))));
    codex.emit(models(report(row('fresh'))));
    expect(keys(h.provider('codex'))).toEqual(['fresh']);
  });
});

describe('the re-read (V45, C92)', () => {
  it('asks nothing after a read that reported by itself, whatever else asked for it', () => {
    const h = setup();
    const claude = fakeProvider();
    h.service.attach({ id: 'claude', generation: 1, provider: claude.provider });
    h.read('claude', 'account', { during: () => claude.emit(models(report(row('opus')))) });
    h.read('claude', 'account', { byRefresh: true, during: () => claude.emit(models(report(row('opus')))) });
    expect(claude.provider.reportModels).not.toHaveBeenCalled();
  });

  it('asks once after the first read of a runtime that did not report, and not again within the hour', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    h.read('codex', 'account');
    h.read('codex', 'account');
    expect(codex.provider.reportModels).toHaveBeenCalledOnce();
    expect(vi.mocked(codex.provider.reportModels ?? vi.fn()).mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('follows a polled read only once the last answer is an hour old', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    h.read('codex', 'account', { during: () => codex.emit(models(report(row('a')))) }); // the adapter's own read on ready answered
    // Each read takes two seconds: this one ends two seconds short of the hour since the answer.
    h.advance(MODEL_REREAD_MS - 5000);
    h.read('codex', 'account');
    expect(codex.provider.reportModels).not.toHaveBeenCalled();
    h.advance(2000);
    h.read('codex', 'account');
    h.read('codex', 'account');
    expect(codex.provider.reportModels).toHaveBeenCalledOnce();
  });

  it('counts an equal answer as an answer', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'))));
    h.advance(MODEL_REREAD_MS - 1000);
    codex.emit(models(report(row('a'))));
    h.advance(5000);
    h.read('codex', 'account');
    expect(codex.provider.reportModels).not.toHaveBeenCalled();
  });

  it('asks after every read a Refresh caused that did not report, whatever the hour', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    h.read('codex', 'account', { during: () => codex.emit(models(report(row('a')))) });
    h.read('codex', 'account', { byRefresh: true });
    h.read('codex', 'account');
    h.read('codex', 'account', { byRefresh: true });
    expect(codex.provider.reportModels).toHaveBeenCalledTimes(2);
  });

  it('asks nothing after a read that failed, nor after detach', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    h.read('codex', 'other', { byRefresh: true });
    h.service.detach(first('codex'));
    h.read('codex', 'account', { byRefresh: true });
    expect(codex.provider.reportModels).not.toHaveBeenCalled();
  });

  it('asks a signed-out or API-key Claude for its models, which no usage session reports (C90)', () => {
    const h = setup();
    const claude = fakeProvider();
    h.service.attach({ id: 'claude', generation: 1, provider: claude.provider });
    h.read('claude', 'signed-out');
    expect(claude.provider.reportModels).toHaveBeenCalledOnce();
  });

  it('asks nothing of a provider that offers no way to ask', () => {
    const h = setup();
    const plain = fakeProvider(false);
    h.service.attach({ id: 'claude', generation: 1, provider: plain.provider });
    expect(() => h.read('claude', 'api-key', { byRefresh: true })).not.toThrow();
    expect(plain.provider.reportModels).toBeUndefined();
  });
});

describe('the override and Reload (V12, V15; C43, C52)', () => {
  const valid = (models: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, providers: { codex: { models } } });

  it('is applied in the first snapshot, and again over each report, with its counts', () => {
    const h = setup({ override: valid({ astra: { hidden: true }, local: { name: 'Local' } }) });
    // No report yet: nothing to adjust, so nothing listed and nothing counted (C94).
    expect(keys(h.provider('codex'))).toEqual([]);
    expect(h.store.getSnapshot().catalog?.override).toEqual({ kind: 'applied', path: FILE, changed: 0, added: 0, hidden: 0, unknownProviders: [] });
    expect(keys(h.provider('claude'))).toEqual([]);
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('astra'), row('sol'))));
    expect(h.provider('codex').models.map((model) => [model.key, model.origin, model.hidden])).toEqual([['astra', 'reported', true], ['sol', 'reported', false], ['local', 'override', false]]);
    expect(h.store.getSnapshot().catalog?.override).toMatchObject({ kind: 'applied', changed: 0, added: 1, hidden: 1 });
    // Disabled: its report goes, and the file's models with it (C95).
    h.service.detach(first('codex'));
    expect(keys(h.provider('codex'))).toEqual([]);
    expect(h.store.getSnapshot().catalog?.override).toMatchObject({ kind: 'applied', changed: 0, added: 0, hidden: 0 });
  });

  it('applies a changed file on Reload, reports a newly broken one while the list stays usable, and ignores the disk until then', () => {
    const h = setup({ override: valid({ local: {} }) });
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('astra'))));
    h.disk.set(valid({ other: {} }));
    expect(keys(h.provider('codex'))).toEqual(['astra', 'local']); // no Reload yet
    expect(h.service.reload()).toMatchObject({ kind: 'applied', added: 1 });
    expect(keys(h.provider('codex'))).toEqual(['astra', 'other']);
    h.disk.set('{ not json');
    expect(h.service.reload()).toEqual({ kind: 'ignored', path: FILE, cause: 'not-json', field: null });
    expect(keys(h.provider('codex'))).toEqual(['astra']);
    expect(h.store.getSnapshot().catalog?.override.kind).toBe('ignored');
  });

  it('logs counts and kinds only: never the path, a value or an error’s message (V15)', () => {
    const busy: OverrideIo = {
      size: () => { throw Object.assign(new Error(`EBUSY: resource busy or locked, stat '${FILE}'`), { code: 'EBUSY' }); },
      readText: () => '',
    };
    const h = setup({ override: valid({ 'secret-project-model': { name: 'Someone’s private name' } }) });
    const locked = setup({ io: busy });
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('astra'))));
    h.service.reload(); // counted over the report, which the file's model is added to
    h.disk.set(JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, providers: { codex: { models: { x: { hidden: 'Someone' } } } } }));
    h.service.reload();
    const lines = [...h.log.info.mock.calls, ...h.log.warn.mock.calls, ...locked.log.info.mock.calls, ...locked.log.warn.mock.calls].map((call) => call.join(' '));
    expect(lines).toEqual(expect.arrayContaining([
      '[catalog] override applied: 0 changed, 1 added, 0 hidden',
      '[catalog] override ignored (invalid)',
      '[catalog] override could not be read (EBUSY)',
    ]));
    expect(lines.join('\n')).not.toMatch(/someone|Someone|secret|AppData|catalog\.json/);
    expect(locked.store.getSnapshot().catalog?.override).toEqual({ kind: 'ignored', path: FILE, cause: 'unreadable', field: null });
  });
});

// V45 (C26, C92, C97): the usage service's reads, as the catalog sees them, with a replaced clock.
describe('the re-read, driven by real usage reads (V45)', () => {
  /** A Codex-like runtime whose account read takes `readMs`, and whose own read on connect may answer. */
  function wired(options: { readMs?: number; answersOnConnect?: boolean } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const store = createAppStateStore();
    store.updateProviders(() => [sampleProvider({ id: 'codex', displayName: 'Codex', status: { kind: 'detecting' }, account: null, usage: null, asOf: null })]);
    const catalog = createCatalogService({ definitions: [definition('codex')], store, dir: DIR, io: files().io, log: { info: vi.fn(), warn: vi.fn() } });
    const usage = createUsageService({ store, pollIntervalSec: () => 60, onReadEnd: (id, end) => catalog.readEnded(id, end) });
    const fake = fakeProvider();
    let first = options.answersOnConnect ?? true;
    fake.provider.getAccount = vi.fn(async () => {
      // The adapter's own read on connect answers while the first usage read is under way.
      if (first) fake.emit(models(report(row('a'))));
      first = false;
      if (options.readMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.readMs));
      return { kind: 'account', account: { authKind: 'subscription' } } as const;
    });
    fake.provider.getUsage = vi.fn(async () => ({ kind: 'usage', usage: { windows: [sampleWindow()] } }) as const);
    const attachment = { id: 'codex', generation: 1, provider: fake.provider };
    catalog.attach(attachment);
    usage.attach({ ...attachment, descriptor: fake.provider.descriptor, installation: { source: 'path', version: '0.155.1' } });
    const asks = () => vi.mocked(fake.provider.reportModels ?? vi.fn()).mock.calls.length;
    const done = () => { usage.stop(); catalog.stop(); vi.useRealTimers(); };
    const reads = () => vi.mocked(fake.provider.getAccount).mock.calls.length;
    return { usage, asks, reads, done };
  }

  it('follows a Refresh with one model read, and the ordinary poll after it with none', async () => {
    const w = wired({ readMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000); // the first read, answered by the adapter's own model read
    expect(w.asks()).toBe(0);
    await vi.advanceTimersByTimeAsync(57_000); // the next poll is not due yet
    expect(w.usage.refresh(first('codex'))).toEqual({ status: 'accepted' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.asks()).toBe(1);
    await vi.advanceTimersByTimeAsync(65_000); // the ordinary poll
    expect(w.asks()).toBe(1);
    w.done();
  });

  it('follows polled reads with a model read only once the last answer is an hour old', async () => {
    const w = wired();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MODEL_REREAD_MS - 60_000);
    expect(w.asks()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.asks()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(w.asks()).toBe(1);
    w.done();
  });

  it('asks once after the adapter’s own read failed, and not again within the hour', async () => {
    const w = wired({ answersOnConnect: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.asks()).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(w.asks()).toBe(1);
    w.done();
  });

  it('lets two Refreshes during one read share it and one model read (C97)', async () => {
    const w = wired({ readMs: 5000 });
    await vi.advanceTimersByTimeAsync(10_000); // the first read, answered by the adapter's own model read
    expect(w.usage.refresh(first('codex'))).toEqual({ status: 'accepted' });
    expect(w.usage.refresh(first('codex'))).toEqual({ status: 'accepted' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.reads()).toBe(2);
    expect(w.asks()).toBe(1);
    w.done();
  });

  it('gives two Refreshes one after the other two reads and two model reads, the floor notwithstanding', async () => {
    const w = wired({ readMs: 5000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.usage.refresh(first('codex'))).toEqual({ status: 'accepted' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.asks()).toBe(1);
    expect(w.usage.refresh(first('codex'))).toEqual({ status: 'accepted' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.reads()).toBe(3);
    expect(w.asks()).toBe(2);
    w.done();
  });
});

// M14b, V7 (C20): one entry per instance. The presentation, the effort labels and the override are
// the provider's; the report is the instance's own.
describe('one entry per instance (M14b, C20)', () => {
  const ADDED = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const added = { providerId: 'codex', instanceId: ADDED };
  const entries = (h: ReturnType<typeof setup>) => h.store.getSnapshot().catalog?.providers ?? [];
  const entry = (h: ReturnType<typeof setup>, instanceId: string) => {
    const found = entries(h).find((candidate) => candidate.id === 'codex' && candidate.instanceId === instanceId);
    if (found === undefined) throw new Error(`no codex ${instanceId}`);
    return found;
  };
  const valid = (models: Record<string, unknown>) => JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, providers: { codex: { models } } });

  it('has each provider’s first instance from the start, and follows the list the registry gives, in its order', () => {
    const h = setup();
    expect(entries(h).map((item) => [item.id, item.instanceId])).toEqual([['claude', 'default'], ['codex', 'default']]);
    const seq = h.seq();
    h.service.setInstances([first('claude'), first('codex'), added]);
    expect(entries(h).map((item) => [item.id, item.instanceId, item.source.kind])).toEqual([['claude', 'default', 'none'], ['codex', 'default', 'none'], ['codex', ADDED, 'none']]);
    expect(h.seq()).toBe(seq + 1);
    // The same list again changes nothing; a provider it does not know is left out.
    h.service.setInstances([first('claude'), first('codex'), added, { providerId: 'gemini', instanceId: 'default' }]);
    expect(h.seq()).toBe(seq + 1);
  });

  it('gives an added instance its provider’s look and labels, and a report of its own: two accounts differ in their models and in one model’s levels', () => {
    const h = setup();
    h.service.setInstances([first('claude'), first('codex'), added]);
    const personal = fakeProvider();
    const workAccount = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: personal.provider });
    h.service.attach({ id: 'codex', instanceId: ADDED, generation: 1, provider: workAccount.provider });
    personal.emit(models(report(row('sol', { efforts: ['low', 'high'] }), row('luna'))));
    workAccount.emit(models(report(row('sol', { efforts: ['low'] }))));

    expect(keys(entry(h, 'default'))).toEqual(['sol', 'luna']);
    expect(keys(entry(h, ADDED))).toEqual(['sol']);
    expect(entry(h, 'default').models[0]?.efforts.map((effort) => effort.id)).toEqual(['low', 'high']);
    expect(entry(h, ADDED).models[0]?.efforts.map((effort) => effort.id)).toEqual(['low']);
    // The provider's: the look, and the label of a level both list.
    expect(entry(h, ADDED).presentation).toEqual(entry(h, 'default').presentation);
    expect(entry(h, ADDED).models[0]?.efforts[0]).toEqual(entry(h, 'default').models[0]?.efforts[0]);
    // Counts and kinds in the log: a provider's id, never an instance's.
    expect(h.log.info).toHaveBeenLastCalledWith('[catalog] codex reported 1 models, 0 hidden, 0 dropped');
    expect(JSON.stringify(h.log.info.mock.calls)).not.toContain(ADDED);
  });

  it('keeps one instance’s report when the other’s goes', () => {
    const h = setup();
    h.service.setInstances([first('claude'), first('codex'), added]);
    const personal = fakeProvider();
    const workAccount = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: personal.provider });
    h.service.attach({ id: 'codex', instanceId: ADDED, generation: 1, provider: workAccount.provider });
    personal.emit(models(report(row('a'))));
    workAccount.emit(models(report(row('b'))));
    h.service.detach(added);
    expect(keys(entry(h, 'default'))).toEqual(['a']);
    expect(entry(h, ADDED).source).toEqual({ kind: 'none' });
    // A late event of the detached runtime is not taken.
    workAccount.emit(models(report(row('late'))));
    expect(entry(h, ADDED).source).toEqual({ kind: 'none' });
    // The instance removed: its entry goes, the other's stays as it is.
    h.service.setInstances([first('claude'), first('codex')]);
    expect(entries(h).map((item) => item.instanceId)).toEqual(['default', 'default']);
    expect(keys(entry(h, 'default'))).toEqual(['a']);
  });

  it('applies the provider’s override to each instance’s list, and counts what it did over both', () => {
    const h = setup({ override: valid({ sol: { hidden: true }, local: { name: 'Local' } }) });
    h.service.setInstances([first('claude'), first('codex'), added]);
    const personal = fakeProvider();
    const workAccount = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: personal.provider });
    h.service.attach({ id: 'codex', instanceId: ADDED, generation: 1, provider: workAccount.provider });
    personal.emit(models(report(row('sol'), row('luna'))));
    expect(h.store.getSnapshot().catalog?.override).toMatchObject({ kind: 'applied', added: 1, hidden: 1 });
    workAccount.emit(models(report(row('sol'))));
    expect(entry(h, 'default').models.map((model) => [model.key, model.hidden])).toEqual([['sol', true], ['luna', false], ['local', false]]);
    expect(entry(h, ADDED).models.map((model) => [model.key, model.hidden])).toEqual([['sol', true], ['local', false]]);
    expect(h.store.getSnapshot().catalog?.override).toMatchObject({ kind: 'applied', added: 2, hidden: 2 });
  });

  it('asks the runtime of the instance whose read ended, and no other', () => {
    const h = setup();
    h.service.setInstances([first('claude'), first('codex'), added]);
    const personal = fakeProvider();
    const workAccount = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: personal.provider });
    h.service.attach({ id: 'codex', instanceId: ADDED, generation: 1, provider: workAccount.provider });
    h.service.readEnded(added, { outcome: 'account', byRefresh: false, startedAt: START });
    expect(workAccount.provider.reportModels).toHaveBeenCalledOnce();
    expect(personal.provider.reportModels).not.toHaveBeenCalled();
  });
});

describe('each model’s avatar (M102, V6; C29, C57)', () => {
  it('is none before the avatars’ scan lands, and its provider’s face once it has, asked by provider and key', () => {
    let faces = new Map<string, ResolvedAvatar>();
    const asked: string[] = [];
    const h = setup({ avatar: (providerId, key) => { asked.push(`${providerId}:${key}`); return faces.get(providerId) ?? null; } });
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'), row('b'))));
    expect(h.provider('codex').models.map((model) => model.avatar)).toEqual([null, null]);
    const face: ResolvedAvatar = { ref: { origin: 'built-in', family: 'Blue', avatar: 'Default' }, portrait: 'c'.repeat(32), small: 'd'.repeat(32) };
    faces = new Map([['codex', face]]);
    const seq = h.seq();
    h.service.avatarsChanged();
    expect(h.seq()).toBeGreaterThan(seq);
    expect(h.provider('codex').models.map((model) => model.avatar)).toEqual([face, face]);
    expect(asked).toContain('codex:b');
  });

  it('is none for every model where no resolver is given', () => {
    const h = setup();
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'))));
    expect(h.provider('codex').models[0]?.avatar).toBeNull();
  });

  // M103 (V3; C10, C12, C14): with the resolver, each model carries its own assignment, the others the face.
  it('passes the resolved id to the avatar resolver again when an alias changes version', () => {
    const avatar = vi.fn(() => null);
    const h = setup({ avatar });
    const runtime = fakeProvider();
    h.service.attach({ id: 'claude', generation: 1, provider: runtime.provider });
    runtime.emit(models(report(row('opus', { resolvedId: 'claude-opus-5-5' }))));
    expect(avatar).toHaveBeenLastCalledWith('claude', 'opus', 'claude-opus-5-5');
    runtime.emit(models(report(row('opus', { resolvedId: 'claude-opus-6' }))));
    expect(avatar).toHaveBeenLastCalledWith('claude', 'opus', 'claude-opus-6');
  });

  it('is each model’s own assignment, else the face, and follows a change of the assignments', () => {
    const face: ResolvedAvatar = { ref: { origin: 'built-in', family: 'Blue', avatar: 'Default' }, portrait: 'c'.repeat(32), small: null };
    const op: ResolvedAvatar = { ref: { origin: 'user', family: 'Mine', avatar: 'Op' }, portrait: 'e'.repeat(32), small: null };
    let assignments: Assignments = { codex: { b: op.ref } };
    const resolver = createAvatarResolver({
      // Families whose files hide the version and the marks: no text and no marks are drawn, the fast
      // marker's look standing ready for a session that asks for a faster tier (decision 0032).
      avatars: { defaultFace: () => face, assigned: (ref) => (ref.avatar === 'Op' ? op : null), family: () => undefined, defaultFamily: () => null, layers: () => [{ version: { parts: { name: false, version: false } }, effort: { show: false } }] },
      preferences: () => ({ assignments, active: {} }),
    });
    const h = setup({ avatar: (providerId, key) => resolver.forModel(providerId, key) });
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'), row('b'))));
    const drawn = (avatar: ResolvedAvatar, source: AvatarSource): ResolvedAvatar => ({ ...avatar, source, overlay: { text: null, effort: null, fast: expect.objectContaining({ fastPosition: 'top-left' }) as never } });
    expect(h.provider('codex').models.map((model) => model.avatar)).toEqual([drawn(face, 'built-in-face'), drawn(op, 'override')]);
    assignments = { codex: { a: op.ref } };
    h.service.avatarsChanged();
    expect(h.provider('codex').models.map((model) => model.avatar)).toEqual([drawn(op, 'override'), drawn(face, 'built-in-face')]);
  });

  // Decision 0032: each model carries what its provider reads of its identifiers, the overlay's default texts.
  it('carries each model’s version and short name, as its provider reads them', () => {
    const h = setup({ label: (_providerId, model) => ({ version: model.resolvedId === 'gpt-6.1-sol' ? '6.1' : null, name: model.key === 'a' ? 'A' : null }) });
    const codex = fakeProvider();
    h.service.attach({ id: 'codex', generation: 1, provider: codex.provider });
    codex.emit(models(report(row('a'), row('b', { resolvedId: 'gpt-6.1-sol' }))));
    expect(h.provider('codex').models.map((model) => model.label)).toEqual([{ version: null, name: 'A' }, { version: '6.1', name: null }]);
  });
});
