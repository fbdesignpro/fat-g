// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
// M14b, V4, V14 and V23 (C6, C7, C10, C17, C22, C23, C59, C60, C69, C72): one runtime per instance. The
// preferences are the real store on a throwaway folder; the processes, the usage service and the
// catalog are doubles that record what the registry asked of them.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceRef } from '@shared/contracts/instances';
import { defaultPreferences } from '@shared/contracts/prefs';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { ProviderStatus } from '@shared/contracts/status';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { InstanceEnvironment } from '@shared/provider-kit/process';
import type { AgentProvider, InstanceSupport, ProviderDefinition } from '@shared/provider-kit/provider';
import { sampleCatalogDefaults } from '../../../tests/support/catalog';
import type { InstanceStart } from '../instances/admission';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from '../prefs/store';
import { createAppStateStore } from '../state/app-state-store';
import type { CatalogService } from './catalog-service';
import { createProviderRegistry, type ProviderRegistry } from './provider-registry';
import type { UsageService } from './usage-service';

const descriptor: ProviderDescriptor = {
  id: 'codex', displayName: 'Codex', installGuidance: 'Install Codex.', loginCommand: 'codex login', minPollIntervalSec: 60,
  capabilities: { account: true, usage: 'poll+push', sessions: false, history: false, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null },
};
const installation = { source: 'path', version: '0.155.1' } as const;
const support: InstanceSupport = { variable: 'VENDOR_HOME', defaultFolder: ['.vendor'], withhold: { names: ['VENDOR_TOKEN'], prefixes: ['VENDOR_BACKEND_'] } };
const environment = { removePrefixes: ['VENDOR_SESSION_'] };

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const A = uuid(1);
const B = uuid(2);
const FOLDER_A = 'D:\\accounts\\work';
const FOLDER_B = 'D:\\accounts\\side';
const work = (extra: Record<string, unknown> = {}) => ({ id: A, label: 'Work', folder: FOLDER_A, enabled: true, ...extra });
const side = (extra: Record<string, unknown> = {}) => ({ id: B, label: 'Side', folder: FOLDER_B, enabled: true, ...extra });
const ref = (instanceId: string): InstanceRef => ({ providerId: 'codex', instanceId });
const FIRST = ref('default');

interface Made {
  readonly instance: InstanceEnvironment | undefined;
  readonly context: ProviderContext;
  readonly provider: AgentProvider;
}

let dir: string;
let prefs: PreferencesStore;
let registry: ProviderRegistry | undefined;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fatg-registry-instances-')); });
afterEach(() => {
  registry?.stop();
  registry = undefined;
  prefs.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface Options {
  /** The `codex` entry of the preferences file. */
  readonly entry?: Record<string, unknown>;
  /** A module that declares no instances. */
  readonly plain?: boolean;
  /** What the guard answers for an entry's key; every folder is admitted otherwise. */
  readonly guard?: (key: string) => InstanceStart | Promise<InstanceStart>;
  /** Whether the scope of this folder (`undefined` for the first instance) confirms its cleanup. */
  readonly cleanup?: (folder: string | undefined) => boolean;
  readonly detect?: (folder: string | undefined) => ReturnType<AgentProvider['detect']>;
}

function harness(options: Options = {}) {
  writeFileSync(path.join(dir, PREFERENCES_FILE), JSON.stringify({ ...defaultPreferences(), providers: { codex: options.entry ?? {} } }), 'utf8');
  let made = 100;
  prefs = createPreferencesStore({ dir, providerIds: ['codex'], log: { warn: vi.fn(), error: vi.fn() }, platform: 'win32', writeDelayMs: 10_000, newId: () => uuid(made += 1) });
  const store = createAppStateStore();
  const usage: UsageService = {
    attach: vi.fn(), detach: vi.fn(), forget: vi.fn(), refresh: vi.fn(() => ({ status: 'accepted' } as const)),
    preferencesChanged: vi.fn(), suspend: vi.fn(), resume: vi.fn(), stop: vi.fn(),
  };
  const catalog: Pick<CatalogService, 'attach' | 'detach' | 'stop' | 'setInstances'> = { attach: vi.fn(), detach: vi.fn(), stop: vi.fn(), setInstances: vi.fn() };
  const scopes: Made[] = [];
  const createContext = vi.fn((_environment?: unknown, instance?: InstanceEnvironment): ProviderContext => {
    const folder = instance?.folder;
    const provider: AgentProvider = {
      descriptor,
      detect: vi.fn(async () => options.detect?.(folder) ?? ({ kind: 'found', installation } as const)),
      getAccount: vi.fn(async () => ({ kind: 'not-logged-in' } as const)),
      getUsage: vi.fn(async () => ({ kind: 'empty' } as const)),
      dispose: vi.fn(async () => undefined),
    };
    const context: ProviderContext = {
      probeDirectory: 'C:\\probe',
      logger: { record: vi.fn() },
      processes: {
        resolve: vi.fn(), spawn: vi.fn(), run: vi.fn(), supervise: vi.fn(), open: vi.fn(), openProcess: vi.fn(),
        recheck: vi.fn(async () => ({ ok: false })),
        dispose: vi.fn(async () => ({ ok: options.cleanup?.(folder) ?? true })),
      },
    };
    scopes.push({ instance, context, provider });
    return context;
  });
  const definition: ProviderDefinition = {
    descriptor, catalogDefaults: sampleCatalogDefaults(), installationGuide: 'https://example.test/codex',
    executableNames: ['codex'], installDirectoryHints: [], environment,
    ...(options.plain === true ? {} : { instances: support }),
    factory: (context) => {
      const scope = scopes.find((candidate) => candidate.context === context);
      if (scope === undefined) throw new Error('unknown scope');
      return scope.provider;
    },
  };
  const admit = vi.fn(async (_providerId: string, key: string): Promise<InstanceStart> => options.guard?.(key) ?? { kind: 'admitted' });
  const log = { info: vi.fn(), warn: vi.fn() };
  registry = createProviderRegistry({
    definitions: [definition], store, prefs, usage, catalog, createContext, knownDirectories: () => [],
    guard: { admit }, startedWithout: () => ['VENDOR_BACKEND_URL', 'VENDOR_TOKEN'], log,
  });
  const snapshots = () => store.getSnapshot().providers;
  const status = (instanceId: string) => snapshots().find((provider) => provider.instanceId === instanceId)?.status;
  /** The scopes made for a folder (`undefined` for the first instance), in order. */
  const scopesOf = (folder: string | undefined) => scopes.filter((scope) => scope.instance?.folder === folder);
  const attached = () => vi.mocked(usage.attach).mock.calls.map(([attachment]) => attachment.instanceId);
  return { store, usage, catalog, createContext, scopes, scopesOf, admit, log, snapshots, status, attached, registry };
}
const settled = (check: () => void) => vi.waitFor(check, { timeout: 2000 });

describe('one runtime per instance (C7)', () => {
  it('starts the first instance as the provider always was, and each added one in a scope of its own', async () => {
    const h = harness({ entry: { label: 'Personal', instances: [work(), side()] } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(3));

    // The first instance sets nothing; an added one's scope sets the variable to its folder and withholds what the module names.
    expect(h.createContext.mock.calls).toEqual([
      [environment, undefined],
      [environment, { variable: 'VENDOR_HOME', folder: FOLDER_A, withhold: support.withhold }],
      [environment, { variable: 'VENDOR_HOME', folder: FOLDER_B, withhold: support.withhold }],
    ]);
    expect(new Set(h.scopes.map((scope) => scope.context)).size).toBe(3);
    expect(h.attached()).toEqual(['default', A, B]);
    expect(vi.mocked(h.catalog.attach).mock.calls.map(([attachment]) => attachment.instanceId)).toEqual(['default', A, B]);
    expect(h.catalog.setInstances).toHaveBeenLastCalledWith([FIRST, ref(A), ref(B)]);
    expect(h.admit.mock.calls).toEqual([['codex', A], ['codex', B]]);

    // One snapshot each, in order, with its label; an added one names what it was started without.
    expect(h.snapshots().map((provider) => [provider.id, provider.instanceId, provider.label, provider.instanceVariable, provider.startedWithout])).toEqual([
      ['codex', 'default', 'Personal', 'VENDOR_HOME', []],
      ['codex', A, 'Work', 'VENDOR_HOME', ['VENDOR_BACKEND_URL', 'VENDOR_TOKEN']],
      ['codex', B, 'Side', 'VENDOR_HOME', ['VENDOR_BACKEND_URL', 'VENDOR_TOKEN']],
    ]);
    // A folder is never in the app state (C19).
    expect(JSON.stringify(h.store.getSnapshot())).not.toMatch(/accounts/);
    expect(h.log.info).toHaveBeenCalledExactlyOnceWith('[providers] codex: 3 instances');
  });

  it('shows a first instance with no label as "Default"', async () => {
    const h = harness();
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledOnce());
    expect(h.snapshots().map((provider) => provider.label)).toEqual(['Default']);
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it('gives a module with no declaration one instance, whatever its entry holds (C5)', async () => {
    const h = harness({ plain: true, entry: { instances: [work()] } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledOnce());
    expect(h.createContext.mock.calls).toEqual([[environment, undefined]]);
    expect(h.snapshots().map((provider) => [provider.instanceId, provider.instanceVariable])).toEqual([['default', null]]);
    expect(h.registry.hasInstance(ref(A))).toBe(false);
  });

  it('keeps the others reading when one instance fails to start', async () => {
    const h = harness({ entry: { instances: [work(), side()] }, detect: async (folder) => (folder === FOLDER_A ? { kind: 'error', reason: 'probe-failed' } : { kind: 'found', installation }) });
    h.registry.start();
    await settled(() => expect(h.status(A)).toEqual({ kind: 'error', message: 'The CLI version check failed.' }));
    await settled(() => expect(h.attached()).toEqual(['default', B]));
    expect(h.status('default')).toEqual({ kind: 'detecting' });
  });

  it('keeps the others reading when one instance’s cleanup cannot be confirmed, and blocks that one alone', async () => {
    const h = harness({ entry: { instances: [work(), side()] }, cleanup: (folder) => folder !== FOLDER_A });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(3));
    vi.mocked(h.usage.detach).mockClear(); // every start detaches first
    // A switch of its own replaces its runtime; the old one cannot be confirmed gone.
    prefs.patch({ providers: { codex: { instances: { [A]: { enabled: false } } } } });
    await settled(() => expect(h.status(A)).toEqual({ kind: 'error', message: 'The previous CLI process could not be stopped safely.' }));
    prefs.patch({ providers: { codex: { instances: { [A]: { enabled: true } } } } });
    await Promise.resolve();
    // Nothing new starts for it, and nothing of the others was touched.
    expect(h.scopesOf(FOLDER_A)).toHaveLength(1);
    expect(h.scopesOf(FOLDER_B)).toHaveLength(1);
    expect(h.scopesOf(undefined)).toHaveLength(1);
    expect(h.usage.detach).not.toHaveBeenCalledWith(ref(B));
    // The others can still be replaced.
    expect(h.registry.redetect(ref(B))).toEqual({ status: 'accepted' });
    await settled(() => expect(h.scopesOf(FOLDER_B)).toHaveLength(2));
    expect(h.scopesOf(FOLDER_A)).toHaveLength(1);
  });

  it('refuses the ninth instance: the entry past the cap is blocked and launches nothing (C10)', async () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({ id: uuid(index + 1), label: `Account ${index + 1}`, folder: `D:\\accounts\\${index + 1}`, enabled: true }));
    const h = harness({ entry: { instances: entries } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(8));
    expect(h.createContext).toHaveBeenCalledTimes(8);
    expect(h.snapshots()).toHaveLength(9);
    expect(h.status(uuid(8))).toEqual({ kind: 'blocked', reason: 'invalid-instance', issue: 'over-limit' });
    expect(prefs.addInstance('codex', { label: 'One more', folder: 'D:\\accounts\\9' })).toEqual({ status: 'refused', reason: 'limit' });
  });

  it('lists an entry it cannot use, blocked, and launches nothing for it (C16, C66)', async () => {
    const h = harness({ entry: { instances: [{ label: 'No id', folder: FOLDER_A, enabled: true }, side({ folder: 'relative' })] } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledOnce());
    const [, noId, relative] = h.snapshots();
    expect(noId).toMatchObject({ label: 'No id', status: { kind: 'blocked', reason: 'invalid-instance', issue: 'invalid-id' } });
    // Named by its run key, which is no id the file holds.
    expect(noId?.instanceId).toBe(prefs.getSnapshot().instances['codex']?.added[0]?.key);
    expect(relative).toMatchObject({ instanceId: B, label: 'Side', status: { kind: 'blocked', reason: 'invalid-instance', issue: 'invalid-folder' } });
    expect(h.createContext).toHaveBeenCalledOnce();
    expect(h.admit).not.toHaveBeenCalled();
    expect(h.registry.refresh(ref(B))).toEqual({ status: 'refused', reason: 'preferences-blocked' });
  });
});

describe('what each action reaches (C17, C22, C60)', () => {
  const started = async () => {
    const h = harness({ entry: { instances: [work(), side()] } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(3));
    return h;
  };
  const counts = (h: Awaited<ReturnType<typeof started>>) => [h.scopesOf(undefined).length, h.scopesOf(FOLDER_A).length, h.scopesOf(FOLDER_B).length];

  it('starts an added instance at once when it is saved, and replaces nothing else (C22)', async () => {
    const h = harness();
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledOnce());
    const saved = prefs.addInstance('codex', { label: 'Work', folder: FOLDER_A });
    if (saved.status !== 'saved') throw new Error('not saved');
    await settled(() => expect(h.attached()).toEqual(['default', saved.id]));
    expect(h.createContext).toHaveBeenLastCalledWith(environment, { variable: 'VENDOR_HOME', folder: FOLDER_A, withhold: support.withhold });
    expect(h.scopesOf(undefined)).toHaveLength(1);
    expect(h.snapshots().map((provider) => provider.label)).toEqual(['Default', 'Work']);
    expect(h.catalog.setInstances).toHaveBeenLastCalledWith([FIRST, ref(saved.id)]);
    expect(h.log.info).toHaveBeenCalledExactlyOnceWith('[providers] codex: 2 instances');
  });

  it('the provider’s switch ends every instance’s runtime, and starts every one again', async () => {
    const h = await started();
    prefs.patch({ providers: { codex: { enabled: false } } });
    await settled(() => expect(h.snapshots().map((provider) => provider.status.kind)).toEqual(['disabled', 'disabled', 'disabled']));
    for (const scope of h.scopes) expect(scope.context.processes.dispose).toHaveBeenCalledOnce();
    expect(counts(h)).toEqual([1, 1, 1]);
    prefs.patch({ providers: { codex: { enabled: true } } });
    await settled(() => expect(counts(h)).toEqual([2, 2, 2]));
  });

  it('a change of the provider’s executable replaces every instance’s runtime, each with the new one', async () => {
    const h = await started();
    prefs.patch({ providers: { codex: { executablePath: 'C:\\bin\\codex.exe' } } });
    await settled(() => expect(counts(h)).toEqual([2, 2, 2]));
    for (const scope of h.scopes.slice(3)) expect(scope.provider.detect).toHaveBeenCalledWith({ override: 'C:\\bin\\codex.exe', knownDirs: [] }, expect.any(AbortSignal));
  });

  it('an instance’s own switch and its Redetect replace its own runtime alone', async () => {
    const h = await started();
    prefs.patch({ providers: { codex: { instances: { [A]: { enabled: false } } } } });
    await settled(() => expect(h.status(A)).toEqual({ kind: 'disabled' }));
    expect(h.scopesOf(FOLDER_A)[0]?.context.processes.dispose).toHaveBeenCalledOnce();
    expect(h.scopesOf(FOLDER_B)[0]?.context.processes.dispose).not.toHaveBeenCalled();
    expect(h.scopesOf(undefined)[0]?.context.processes.dispose).not.toHaveBeenCalled();
    expect(h.registry.refresh(ref(A))).toEqual({ status: 'refused', reason: 'disabled' });
    expect(h.registry.redetect(ref(A))).toEqual({ status: 'refused', reason: 'disabled' });

    expect(h.registry.redetect(ref(B))).toEqual({ status: 'accepted' });
    await settled(() => expect(counts(h)).toEqual([1, 1, 2]));
    expect(h.registry.redetect(FIRST)).toEqual({ status: 'accepted' });
    await settled(() => expect(counts(h)).toEqual([2, 1, 2]));
  });

  it('a Refresh reads one instance, at once, and replaces nothing', async () => {
    const h = await started();
    expect(h.registry.refresh(ref(B))).toEqual({ status: 'accepted' });
    expect(h.usage.refresh).toHaveBeenCalledExactlyOnceWith(ref(B));
    expect(counts(h)).toEqual([1, 1, 1]);
    expect(h.registry.refresh(ref(uuid(9)))).toEqual({ status: 'refused', reason: 'not-ready' });
    expect(h.registry.redetect(ref(uuid(9)))).toEqual({ status: 'refused', reason: 'not-ready' });
  });

  it('a rename replaces nothing: the snapshot’s label changes', async () => {
    const h = await started();
    vi.mocked(h.usage.detach).mockClear(); // every start detaches first
    prefs.patch({ providers: { codex: { label: 'Personal', instances: { [A]: { label: 'Day job' } } } } });
    await settled(() => expect(h.snapshots().map((provider) => provider.label)).toEqual(['Personal', 'Day job', 'Side']));
    expect(counts(h)).toEqual([1, 1, 1]);
    expect(h.usage.detach).not.toHaveBeenCalledWith(ref(A));
    // What the snapshot held is kept: only the label moved.
    expect(h.snapshots()[1]).toMatchObject({ instanceId: A, installation, status: { kind: 'detecting' } });
  });

  it('says which instances an action reaches', async () => {
    const h = await started();
    for (const action of ['provider-switch', 'provider-executable'] as const) expect(h.registry.reachOf(action, ref(A))).toEqual([FIRST, ref(A), ref(B)]);
    for (const action of ['instance-switch', 'redetect', 'remove'] as const) expect(h.registry.reachOf(action, ref(A))).toEqual([ref(A)]);
    expect(h.registry.reachOf('remove', ref(uuid(9)))).toEqual([]);
  });
});

describe('Remove (C23, C69)', () => {
  it('ends the instance’s runtime with its tree confirmed gone, and the slot goes with its entry', async () => {
    const h = harness({ entry: { instances: [work(), side()] } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(3));

    expect(await h.registry.end(ref(A))).toEqual({ confirmed: true });
    expect(h.scopesOf(FOLDER_A)[0]?.provider.dispose).toHaveBeenCalledOnce();
    expect(h.scopesOf(FOLDER_A)[0]?.context.processes.dispose).toHaveBeenCalledOnce();
    // It starts nothing again by itself while its entry is still there.
    await Promise.resolve();
    expect(h.scopesOf(FOLDER_A)).toHaveLength(1);
    expect(h.status(A)).toEqual({ kind: 'disabled' });

    expect(prefs.removeInstance('codex', A)).toEqual({ status: 'removed' });
    await settled(() => expect(h.snapshots().map((provider) => provider.instanceId)).toEqual(['default', B]));
    expect(h.usage.forget).toHaveBeenCalledExactlyOnceWith(ref(A));
    expect(h.catalog.setInstances).toHaveBeenLastCalledWith([FIRST, ref(B)]);
    expect(h.registry.hasInstance(ref(A))).toBe(false);
    // The others were not touched.
    expect(h.scopesOf(undefined)[0]?.context.processes.dispose).not.toHaveBeenCalled();
    expect(h.scopesOf(FOLDER_B)[0]?.context.processes.dispose).not.toHaveBeenCalled();
    expect(h.log.info).toHaveBeenLastCalledWith('[providers] codex: 2 instances');
  });

  it('says so when the tree cannot be confirmed gone: the instance reads as after an unconfirmed cleanup, and only a Redetect checks again', async () => {
    const h = harness({ entry: { instances: [work()] }, cleanup: (folder) => folder !== FOLDER_A });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(2));

    expect(await h.registry.end(ref(A))).toEqual({ confirmed: false });
    expect(h.status(A)).toEqual({ kind: 'error', message: 'The previous CLI process could not be stopped safely.' });
    // The entry stays, since nothing removed it, and so does the instance.
    expect(prefs.getSnapshot().instances['codex']?.added.map((entry) => entry.id)).toEqual([A]);
    expect(h.registry.hasInstance(ref(A))).toBe(true);
    expect(h.registry.redetect(ref(A))).toEqual({ status: 'accepted' });
    await settled(() => expect(h.status(A)).toEqual({ kind: 'error', message: 'The previous CLI process could not be confirmed stopped. Restart fat-g to continue.' }));
    expect(h.scopesOf(FOLDER_A)).toHaveLength(1);
  });

  it('starts an ended instance again on a Redetect, when nothing removed its entry', async () => {
    const h = harness({ entry: { instances: [work()] } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(2));
    await h.registry.end(ref(A));
    expect(h.registry.redetect(ref(A))).toEqual({ status: 'accepted' });
    await settled(() => expect(h.scopesOf(FOLDER_A)).toHaveLength(2));
  });

  it('never ends the first instance, nor one it does not know', async () => {
    const h = harness();
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledOnce());
    expect(await h.registry.end(FIRST)).toEqual({ confirmed: false });
    expect(await h.registry.end(ref(A))).toEqual({ confirmed: false });
    expect(h.scopes[0]?.context.processes.dispose).not.toHaveBeenCalled();
  });

  it('drops an entry that goes while it runs once its runtime has ended', async () => {
    const h = harness({ entry: { instances: [work(), side()] } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(3));
    // Removed from the file without the registry being asked to end it first.
    prefs.removeInstance('codex', B);
    await settled(() => expect(h.snapshots().map((provider) => provider.instanceId)).toEqual(['default', A]));
    expect(h.scopesOf(FOLDER_B)[0]?.context.processes.dispose).toHaveBeenCalledOnce();
    expect(h.scopesOf(FOLDER_A)[0]?.context.processes.dispose).not.toHaveBeenCalled();
  });
});

describe('an added instance’s folder, at each start (C37, C59, C72)', () => {
  const refusals: [string, InstanceStart, ProviderStatus, string][] = [
    ['is missing', { kind: 'folder-missing' }, { kind: 'blocked', reason: 'folder-missing' }, '[providers] an instance was blocked (folder-missing)'],
    ['fails a rule', { kind: 'folder-refused', refusal: { rule: 'project', projectId: 'p1', relation: 'inside' } }, { kind: 'blocked', reason: 'folder-refused', rule: 'project' }, '[providers] an instance was blocked (folder-refused: project)'],
    ['could not be checked', { kind: 'folder-unchecked' }, { kind: 'error', message: 'The account’s folder could not be checked.' }, '[providers] an instance was blocked (folder-unchecked)'],
  ];
  it.each(refusals)('launches nothing for an instance whose folder %s, blocks it alone, and logs the kind', async (_name, start, status, line) => {
    const h = harness({ entry: { instances: [work(), side()] }, guard: (key) => (key === A ? start : { kind: 'admitted' }) });
    h.registry.start();
    await settled(() => expect(h.attached()).toEqual(['default', B]));
    expect(h.status(A)).toEqual(status);
    expect(h.scopesOf(FOLDER_A)).toHaveLength(0);
    expect(h.createContext).toHaveBeenCalledTimes(2);
    expect(h.log.warn).toHaveBeenCalledExactlyOnceWith(line);
  });

  it('asks again on a Redetect: a folder that could not be checked, and now can, starts', async () => {
    let answers = 0;
    const h = harness({ entry: { instances: [work()] }, guard: () => ((answers += 1) === 1 ? { kind: 'folder-unchecked' } : { kind: 'admitted' }) });
    h.registry.start();
    await settled(() => expect(h.status(A)?.kind).toBe('error'));
    expect(h.registry.redetect(ref(A))).toEqual({ status: 'accepted' });
    await settled(() => expect(h.attached()).toEqual(['default', A]));
    expect(h.scopesOf(FOLDER_A)).toHaveLength(1);
  });

  it('takes a guard that fails as a check with no answer', async () => {
    const h = harness({ entry: { instances: [work()] }, guard: () => Promise.reject(new Error('EIO: D:\\accounts\\work')) });
    h.registry.start();
    await settled(() => expect(h.status(A)).toEqual({ kind: 'error', message: 'The account’s folder could not be checked.' }));
    expect(h.scopesOf(FOLDER_A)).toHaveLength(0);
  });

  it('never checks the first instance’s folder: it sets none', async () => {
    const h = harness({ entry: { instances: [work()] } });
    h.registry.start();
    await settled(() => expect(h.usage.attach).toHaveBeenCalledTimes(2));
    expect(h.admit.mock.calls).toEqual([['codex', A]]);
  });
});

describe('the log (V14, C49)', () => {
  it('holds counts and kinds: never a label, a folder or an instance id', async () => {
    const h = harness({ entry: { label: 'Personal', instances: [work(), side()] }, guard: (key) => (key === B ? { kind: 'folder-refused', refusal: { rule: 'other-instance', key: A } } : { kind: 'admitted' }) });
    h.registry.start();
    await settled(() => expect(h.attached()).toEqual(['default', A]));
    const saved = prefs.addInstance('codex', { label: 'Third one', folder: 'D:\\accounts\\third' });
    if (saved.status !== 'saved') throw new Error('not saved');
    await settled(() => expect(h.attached()).toEqual(['default', A, saved.id]));
    await h.registry.end(ref(A));
    prefs.removeInstance('codex', A);
    await settled(() => expect(h.snapshots()).toHaveLength(3));

    const lines = [...h.log.info.mock.calls, ...h.log.warn.mock.calls].map(([line]) => String(line));
    expect(lines).toEqual([
      '[providers] codex: 3 instances',
      '[providers] codex: 4 instances',
      '[providers] codex: 3 instances',
      '[providers] an instance was blocked (folder-refused: other-instance)',
    ]);
    expect(lines.join('\n')).not.toMatch(/Personal|Work|Side|Third|accounts|0000-4000/);
  });
});
