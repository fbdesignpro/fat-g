// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ProviderDiscovery } from './provider-discovery';
import type { ProviderPresence, ProviderDiscoveryState } from '@shared/contracts/provider-discovery';
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import { defaultPreferences, type PreferencesSnapshot } from '@shared/contracts/prefs';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { AgentProvider, ProviderDefinition } from '@shared/provider-kit/provider';
import type { ProviderAdmission } from '../prefs/compatibility';
import type { PreferencesStore } from '../prefs/store';
import { sampleCatalogDefaults } from '../../../tests/support/catalog';
import { createAppStateStore } from '../state/app-state-store';
import type { CatalogService } from './catalog-service';
import type { UsageService } from './usage-service';
import { createProviderRegistry } from './provider-registry';

/** A provider's first instance: the one every provider has. */
const firstOf = (providerId: string) => ({ providerId, instanceId: 'default' });

const descriptor: ProviderDescriptor = {
  id: 'codex', displayName: 'Codex', installGuidance: 'Install Codex.',
  loginCommand: 'codex login', minPollIntervalSec: 60,
  capabilities: { account: true, usage: 'poll+push', sessions: false, history: false, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null },
};
const installation = { source: 'path', version: '0.155.1' } as const;

function preferences(initial: ProviderAdmission) {
  let admission = initial;
  let snapshot = makeSnapshot(initial);
  const listeners = new Set<(value: PreferencesSnapshot) => void>();
  const store: PreferencesStore = {
    getSnapshot: () => snapshot,
    getProviderAdmission: () => admission,
    getInstanceAdmission: () => (admission.kind === 'blocked' ? admission : { ...admission, folder: null }),
    isWritable: () => true,
    patch: vi.fn(() => snapshot),
    noteModelUse: vi.fn(),
    addInstance: vi.fn(() => ({ status: 'refused', reason: 'preferences-blocked' }) as const),
    removeInstance: vi.fn(() => ({ status: 'refused', reason: 'unknown-instance' }) as const),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    flushSync: vi.fn(),
    startFresh: vi.fn(() => Promise.resolve({ status: 'refused', reason: 'not-refused' } as const)),
    retry: vi.fn(() => ({ status: 'refused', reason: 'not-refused' }) as const),
    dispose: vi.fn(),
  };
  return {
    store,
    set(next: ProviderAdmission, pollIntervalSec = snapshot.values.usage.pollIntervalSec) {
      admission = next;
      snapshot = makeSnapshot(next, snapshot.rev + 1, pollIntervalSec);
      for (const listener of listeners) listener(snapshot);
    },
  };
}

function makeSnapshot(admission: ProviderAdmission, rev = 0, pollIntervalSec = 300): PreferencesSnapshot {
  const values = defaultPreferences();
  const provider = admission.kind === 'blocked' ? { enabled: true, executablePath: null, permissionMode: null } : admission.preferences;
  return {
    rev,
    values: { ...values, usage: { pollIntervalSec }, providers: { codex: provider } },
    status: { kind: 'ok' },
    providerIssues: {},
    instances: {},
  };
}

function usageService(): UsageService {
  return {
    attach: vi.fn(), detach: vi.fn(), forget: vi.fn(), refresh: vi.fn(() => ({ status: 'accepted' } as const)),
    preferencesChanged: vi.fn(), suspend: vi.fn(), resume: vi.fn(), stop: vi.fn(),
  };
}

function catalogService(order: string[] = []): Pick<CatalogService, 'attach' | 'detach' | 'stop' | 'setInstances'> {
  return {
    setInstances: vi.fn(),
    attach: vi.fn(() => { order.push('catalog.attach'); }),
    detach: vi.fn(() => { order.push('catalog.detach'); }),
    stop: vi.fn(() => { order.push('catalog.stop'); }),
  };
}

function runtime(options: {
  detect?: AgentProvider['detect'];
  dispose?: AgentProvider['dispose'];
  cleanup?: () => Promise<{ ok: boolean }>;
  recheck?: () => Promise<{ ok: boolean }>;
} = {}) {
  const provider: AgentProvider = {
    descriptor,
    detect: options.detect ?? vi.fn(async () => ({ kind: 'found', installation } as const)),
    getAccount: vi.fn(async () => ({ kind: 'not-logged-in' } as const)),
    getUsage: vi.fn(async () => ({ kind: 'empty' } as const)),
    dispose: options.dispose ?? vi.fn(async () => undefined),
  };
  const context: ProviderContext = {
    probeDirectory: 'C:\\probe',
    logger: { record: vi.fn() },
    processes: {
      resolve: vi.fn(), spawn: vi.fn(), run: vi.fn(), supervise: vi.fn(), open: vi.fn(), openProcess: vi.fn(),
      recheck: options.recheck ?? vi.fn(async () => ({ ok: false })),
      dispose: options.cleanup ?? vi.fn(async () => ({ ok: true })),
    },
  };
  return { provider, context };
}

function definition(factory: ProviderDefinition['factory'], environment?: ProviderDefinition['environment']): ProviderDefinition {
  return {
    descriptor, catalogDefaults: sampleCatalogDefaults(), installationGuide: 'https://example.test/codex',
    executableNames: ['codex'], installDirectoryHints: [], factory, ...(environment ? { environment } : {}),
  };
}

describe('ProviderRegistry', () => {
  it('creates no context, probe, child, or polling job while preferences block admission', async () => {
    const prefs = preferences({ kind: 'blocked', reason: 'preferences-unavailable' });
    const usage = usageService();
    const createContext = vi.fn();
    const factory = vi.fn();
    const store = createAppStateStore();
    const registry = createProviderRegistry({
      definitions: [definition(factory)], store, prefs: prefs.store, usage, catalog: catalogService(), createContext,
      knownDirectories: vi.fn(() => ['C:\\known']),
    });

    registry.start();
    await Promise.resolve();
    expect(createContext).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(usage.attach).not.toHaveBeenCalled();
    expect(store.getSnapshot().providers[0]?.status).toEqual({ kind: 'blocked', reason: 'preferences-unavailable' });
    expect(registry.refresh(firstOf('codex'))).toEqual({ status: 'refused', reason: 'preferences-blocked' });
    expect(registry.redetect(firstOf('codex'))).toEqual({ status: 'refused', reason: 'preferences-blocked' });

    const ready = runtime();
    createContext.mockReturnValue(ready.context);
    factory.mockReturnValue(ready.provider);
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    registry.stop();
  });

  it('coalesces replacements, awaits disposal, and uses the newest override', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    const first = runtime();
    let release!: () => void;
    first.provider.dispose = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const second = runtime();
    const contexts = [first.context, second.context];
    const providers = [first.provider, second.provider];
    const createContext = vi.fn(() => contexts.shift()!);
    const factory = vi.fn(() => providers.shift()!);
    const registry = createProviderRegistry({
      definitions: [definition(factory)], store: createAppStateStore(), prefs: prefs.store, usage, catalog: catalogService(), createContext,
      knownDirectories: () => [],
    });

    registry.start();
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: 'C:\\one.exe', permissionMode: null } });
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: 'C:\\latest.exe', permissionMode: null } });
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    expect(first.context.processes.dispose).toHaveBeenCalledOnce();
    expect(second.provider.detect).toHaveBeenCalledWith(
      { override: 'C:\\latest.exe', knownDirs: [] },
      expect.any(AbortSignal),
    );
    expect(usage.attach).toHaveBeenCalledTimes(2);
    registry.stop();
  });

  it('blocks replacement after an unconfirmed cleanup; preference toggles never recheck', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    const first = runtime({ cleanup: vi.fn(async () => ({ ok: false })) });
    const createContext = vi.fn(() => first.context);
    const factory = vi.fn(() => first.provider);
    const store = createAppStateStore();
    const registry = createProviderRegistry({
      definitions: [definition(factory)], store, prefs: prefs.store, usage, catalog: catalogService(), createContext, knownDirectories: () => [],
    });

    registry.start();
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: 'C:\\other.exe', permissionMode: null } });
    await vi.waitFor(() => expect(store.getSnapshot().providers[0]?.status).toEqual({
      kind: 'error', message: 'The previous CLI process could not be stopped safely.',
    }));
    prefs.set({ kind: 'disabled', preferences: { enabled: false, executablePath: null, permissionMode: null } });
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    await vi.waitFor(() => expect(store.getSnapshot().providers[0]?.status.kind).toBe('error'));
    expect(first.context.processes.recheck).not.toHaveBeenCalled();
    expect(createContext).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    registry.stop();
  });

  it('an explicit Redetect rechecks recorded children and keeps a live tree blocked', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    const first = runtime({ cleanup: vi.fn(async () => ({ ok: false })), recheck: vi.fn(async () => ({ ok: false })) });
    const createContext = vi.fn(() => first.context);
    const store = createAppStateStore();
    const registry = createProviderRegistry({
      definitions: [definition(() => first.provider)], store, prefs: prefs.store, usage, catalog: catalogService(), createContext, knownDirectories: () => [],
    });

    registry.start();
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    expect(registry.redetect(firstOf('codex'))).toEqual({ status: 'accepted' });
    await vi.waitFor(() => expect(store.getSnapshot().providers[0]?.status).toEqual({
      kind: 'error', message: 'The previous CLI process could not be confirmed stopped. Restart fat-g to continue.',
    }));
    expect(first.context.processes.recheck).toHaveBeenCalledOnce();
    expect(createContext).toHaveBeenCalledOnce();
    registry.stop();
  });

  it('an explicit Redetect starts a new generation only after the recorded tree is confirmed gone', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    let exited = false;
    const first = runtime({
      cleanup: vi.fn(async () => ({ ok: exited })),
      recheck: vi.fn(async () => ({ ok: exited })),
    });
    const second = runtime();
    const contexts = [first.context, second.context];
    const providers = [first.provider, second.provider];
    const createContext = vi.fn(() => contexts.shift()!);
    const store = createAppStateStore();
    const registry = createProviderRegistry({
      definitions: [definition(() => providers.shift()!)], store, prefs: prefs.store, usage, catalog: catalogService(), createContext, knownDirectories: () => [],
    });

    registry.start();
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    registry.redetect(firstOf('codex'));
    await vi.waitFor(() => {
      const status = store.getSnapshot().providers[0]?.status;
      expect(status?.kind === 'error' ? status.message : '').toContain('Restart fat-g');
    });
    expect(createContext).toHaveBeenCalledOnce();

    exited = true; // the recorded root exited late and its pipes closed
    registry.redetect(firstOf('codex'));
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledTimes(2));
    expect(createContext).toHaveBeenCalledTimes(2);
    expect(second.provider.detect).toHaveBeenCalledOnce();
    registry.stop();
  });

  it('creates each scope under its provider definition environment policy', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    const one = runtime();
    const createContext = vi.fn(() => one.context);
    const environment = { removePrefixes: ['VENDOR_'], keepNames: ['VENDOR_CONFIG_DIR'] };
    const registry = createProviderRegistry({
      definitions: [definition(() => one.provider, environment)], store: createAppStateStore(), prefs: prefs.store, usage, catalog: catalogService(), createContext, knownDirectories: () => [],
    });

    registry.start();
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    // The first instance's scope: the provider's policy, and no instance part (M14b, C4).
    expect(createContext).toHaveBeenCalledWith(environment, undefined);
    registry.stop();
  });

  it('changes live poll timing without replacing an otherwise unchanged provider', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    const one = runtime();
    const factory = vi.fn(() => one.provider);
    const registry = createProviderRegistry({
      definitions: [definition(factory)], store: createAppStateStore(), prefs: prefs.store, usage, catalog: catalogService(),
      createContext: () => one.context, knownDirectories: () => [],
    });

    registry.start();
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } }, 900);
    expect(usage.preferencesChanged).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    registry.stop();
  });

  // V8 (M13, C31, C34): a model report belongs to the runtime that produced it.
  it('attaches the catalog once a CLI is found and before usage, and detaches it in every replace and in stop', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const order: string[] = [];
    const usage = usageService();
    vi.mocked(usage.attach).mockImplementation(() => { order.push('usage.attach'); });
    const catalog = catalogService(order);
    const one = runtime();
    const registry = createProviderRegistry({
      definitions: [definition(() => one.provider)], store: createAppStateStore(), prefs: prefs.store, usage, catalog,
      createContext: () => one.context, knownDirectories: () => [],
    });

    registry.start();
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    expect(order).toEqual(['catalog.detach', 'catalog.attach', 'usage.attach']);
    expect(catalog.attach).toHaveBeenCalledWith({ id: 'codex', instanceId: 'default', generation: 1, provider: one.provider });

    // Disabled: detached, and nothing is attached again.
    prefs.set({ kind: 'disabled', preferences: { enabled: false, executablePath: null, permissionMode: null } });
    await vi.waitFor(() => expect(catalog.detach).toHaveBeenCalledTimes(2));
    // Blocked, then Redetect once enabled again: each replace detaches.
    prefs.set({ kind: 'blocked', reason: 'invalid-preferences' });
    expect(catalog.detach).toHaveBeenCalledTimes(3);
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    await vi.waitFor(() => expect(catalog.attach).toHaveBeenCalledTimes(2));
    registry.redetect(firstOf('codex'));
    await vi.waitFor(() => expect(catalog.attach).toHaveBeenCalledTimes(3));
    expect(catalog.detach).toHaveBeenCalledTimes(5);

    registry.stop();
    expect(catalog.stop).toHaveBeenCalledOnce();
  });

  it('attaches no catalog for a provider that is not found', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const catalog = catalogService();
    const missing = runtime({ detect: vi.fn(async () => ({ kind: 'not-installed', overrideInvalid: false } as const)) });
    const store = createAppStateStore();
    const registry = createProviderRegistry({
      definitions: [definition(() => missing.provider)], store, prefs: prefs.store, usage: usageService(), catalog,
      createContext: () => missing.context, knownDirectories: () => [],
    });
    registry.start();
    await vi.waitFor(() => expect(store.getSnapshot().providers[0]?.status.kind).toBe('not-installed'));
    expect(catalog.attach).not.toHaveBeenCalled();
    // M15 (C112): no CLI found is no runtime to start a session on.
    expect(registry.hasRuntime(firstOf('codex'))).toBe(false);
    expect(registry.facet(firstOf('codex'))).toBeUndefined();
    registry.stop();
  });

  // M15 (V45, V55; C112, C126): the gate asks whether an instance has a runtime, and hears when that changes.
  it('holds a runtime from the moment the CLI is found until it is replaced, and tells of each change', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    let found!: () => void;
    const one = runtime({ detect: vi.fn(() => new Promise<{ kind: 'found'; installation: typeof installation }>((resolve) => { found = () => resolve({ kind: 'found', installation }); })) });
    const facet = { start: vi.fn(), resume: vi.fn(), history: { read: vi.fn(), onAvailable: vi.fn() } };
    (one.provider as { sessions?: unknown }).sessions = facet;
    const two = runtime();
    const contexts = [one.context, two.context];
    const providers = [one.provider, two.provider];
    const registry = createProviderRegistry({
      definitions: [definition(() => providers.shift()!)], store: createAppStateStore(), prefs: prefs.store, usage, catalog: catalogService(),
      createContext: () => contexts.shift()!, knownDirectories: () => [],
    });
    const told = vi.fn();
    const stopTelling = registry.onRuntimeChanged(told);

    registry.start();
    await vi.waitFor(() => expect(one.provider.detect).toHaveBeenCalled());
    // Detecting: nothing to ask yet.
    expect(registry.hasRuntime(firstOf('codex'))).toBe(false);
    expect(registry.facet(firstOf('codex'))).toBeUndefined();
    expect(told).not.toHaveBeenCalled();
    found();
    await vi.waitFor(() => expect(registry.hasRuntime(firstOf('codex'))).toBe(true));
    expect(registry.facet(firstOf('codex'))).toBe(facet);
    expect(told).toHaveBeenCalledTimes(1);
    expect(registry.hasRuntime({ providerId: 'codex', instanceId: 'other' })).toBe(false);
    expect(registry.hasRuntime(firstOf('claude'))).toBe(false);

    // Disabled: the runtime is gone in the same step, before its disposal has finished.
    prefs.set({ kind: 'disabled', preferences: { enabled: false, executablePath: null, permissionMode: null } });
    expect(registry.hasRuntime(firstOf('codex'))).toBe(false);
    expect(registry.facet(firstOf('codex'))).toBeUndefined();
    expect(told).toHaveBeenCalledTimes(2);

    // Enabled again: a new runtime, which has no session facet of its own here.
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    await vi.waitFor(() => expect(registry.hasRuntime(firstOf('codex'))).toBe(true));
    expect(registry.facet(firstOf('codex'))).toBeUndefined();
    expect(told).toHaveBeenCalledTimes(3);

    stopTelling();
    prefs.set({ kind: 'disabled', preferences: { enabled: false, executablePath: null, permissionMode: null } });
    expect(told).toHaveBeenCalledTimes(3);
    registry.stop();
  });

  // M22 (V15, V18; C43, C60, C72): what an account can use of its provider's modes is its module's to
  // say, and reaches the Main window on the account's snapshot.
  it('puts on an instance’s snapshot which modes it can use and where its sandbox setup stands, again whenever its module says so, and nothing of a runtime that is gone', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const one = runtime();
    const mode = (id: string, available: boolean) => ({ id, available, reason: available ? null : 'needs-setup' as const, setup: !available, records: false, unconfined: false, places: null });
    const world = { modes: [mode('read-only', true), mode('sandbox-ok', false)], setup: { state: 'idle' as 'idle' | 'completed', error: null, readiness: 'not-configured' as 'not-configured' | 'ready' } };
    const listeners = new Set<() => void>();
    const facet = {
      start: vi.fn(), resume: vi.fn(),
      modes: vi.fn(() => world.modes),
      transition: vi.fn(() => 'restart' as const),
      onModesChanged: vi.fn((listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
      sandbox: { state: () => world.setup, act: vi.fn(() => 'started' as const) },
    };
    (one.provider as { sessions?: unknown }).sessions = facet;
    const two = runtime();
    const contexts = [one.context, two.context];
    const providers = [one.provider, two.provider];
    const store = createAppStateStore();
    const registry = createProviderRegistry({
      definitions: [definition(() => providers.shift()!)], store, prefs: prefs.store, usage: usageService(), catalog: catalogService(),
      createContext: () => contexts.shift()!, knownDirectories: () => [],
    });
    const shown = () => store.getSnapshot().providers[0];

    registry.start();
    await vi.waitFor(() => expect(registry.hasRuntime(firstOf('codex'))).toBe(true));
    expect(shown()?.modes).toEqual(world.modes);
    expect(shown()?.sandboxSetup).toEqual({ state: 'idle', error: null, readiness: 'not-configured' });
    // Its module says something changed: a setup's end, a start reply's places.
    world.modes = [mode('read-only', true), mode('sandbox-ok', true)];
    world.setup = { state: 'completed', error: null, readiness: 'ready' };
    for (const listener of [...listeners]) listener();
    expect(shown()?.modes).toEqual(world.modes);
    expect(shown()?.sandboxSetup?.state).toBe('completed');

    // Replaced: the old runtime's word is no longer published, and the new one, which declares none, carries none.
    prefs.set({ kind: 'disabled', preferences: { enabled: false, executablePath: null, permissionMode: null } });
    world.modes = [mode('read-only', false)];
    for (const listener of [...listeners]) listener();
    expect(shown()?.modes).toBeUndefined();
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    await vi.waitFor(() => expect(registry.hasRuntime(firstOf('codex'))).toBe(true));
    expect(shown()?.modes).toBeUndefined();
    expect(shown()?.sandboxSetup).toBeUndefined();
    registry.stop();
  });

  // M15 (V40, V48; C117): the quit stops new work first, and ends the runtimes only after the sessions have had their time.
  it('quiesces without ending a runtime, and disposes what stop ended', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    const catalog = catalogService();
    const one = runtime();
    const createContext = vi.fn(() => one.context);
    const registry = createProviderRegistry({
      definitions: [definition(() => one.provider)], store: createAppStateStore(), prefs: prefs.store, usage, catalog,
      createContext, knownDirectories: () => [],
    });
    registry.start();
    await vi.waitFor(() => expect(registry.hasRuntime(firstOf('codex'))).toBe(true));

    registry.quiesce();
    expect(usage.stop).toHaveBeenCalledOnce();
    expect(catalog.stop).toHaveBeenCalledOnce();
    // Nothing is ended: a session on this runtime may still be stopping its turn.
    expect(one.provider.dispose).not.toHaveBeenCalled();
    expect(one.context.processes.dispose).not.toHaveBeenCalled();
    expect(registry.hasRuntime(firstOf('codex'))).toBe(true);
    // Nothing new starts: a preference change and a Redetect do nothing from here on.
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: 'C:\\other.exe', permissionMode: null } });
    registry.redetect(firstOf('codex'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry.hasRuntime(firstOf('codex'))).toBe(true);
    expect(createContext).toHaveBeenCalledOnce();
    registry.quiesce();
    expect(usage.stop).toHaveBeenCalledOnce();

    await registry.dispose();
    expect(one.provider.dispose).toHaveBeenCalledOnce();
    expect(one.context.processes.dispose).toHaveBeenCalledOnce();
    // Asked again, by stop or by dispose: it is the same ending, not a second one.
    registry.stop();
    await registry.dispose();
    expect(one.provider.dispose).toHaveBeenCalledOnce();
    expect(one.context.processes.dispose).toHaveBeenCalledOnce();
  });

  it('stop quiesces and disposes in one call, as it did before M15', async () => {
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const usage = usageService();
    const one = runtime();
    const registry = createProviderRegistry({
      definitions: [definition(() => one.provider)], store: createAppStateStore(), prefs: prefs.store, usage, catalog: catalogService(),
      createContext: () => one.context, knownDirectories: () => [],
    });
    registry.start();
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    registry.stop();
    expect(usage.stop).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(one.context.processes.dispose).toHaveBeenCalledOnce());
    expect(one.provider.dispose).toHaveBeenCalledOnce();
  });
});

function discoveryControl(initial: ProviderPresence) {
  let state: ProviderDiscoveryState = { checking: false, historyIssue: null, notice: null, providers: [{ id: 'codex', displayName: 'Codex', presence: initial, enabled: true, overrideInvalid: false, checkFailed: false }] };
  const listeners = new Set<() => void>();
  const discovery: ProviderDiscovery = {
    start: vi.fn(), scan: vi.fn(() => Promise.resolve()), acknowledge: vi.fn(() => Promise.resolve(true)), stop: vi.fn(),
    getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { discovery, set(presence: ProviderPresence) { state = { ...state, providers: state.providers.map((provider) => ({ ...provider, presence })) }; for (const listener of listeners) listener(); } };
}

describe('registry installation availability', () => {
  it('starts no runtime until a CLI is found, then starts once and leaves unchanged results alone', async () => {
    const control = discoveryControl('checking');
    const one = runtime();
    const factory = vi.fn(() => one.provider);
    const createContext = vi.fn(() => one.context);
    const usage = usageService();
    const store = createAppStateStore();
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const registry = createProviderRegistry({ definitions: [definition(factory)], store, prefs: prefs.store, usage, catalog: catalogService(), createContext, knownDirectories: () => [], discovery: control.discovery });
    registry.start();
    control.set('missing');
    await Promise.resolve();
    expect(createContext).not.toHaveBeenCalled();
    expect(store.getSnapshot().providers[0]).toMatchObject({ presence: 'missing', status: { kind: 'not-installed' } });
    control.set('present');
    await vi.waitFor(() => expect(usage.attach).toHaveBeenCalledOnce());
    control.set('present');
    expect(factory).toHaveBeenCalledOnce();
    expect(one.provider.dispose).not.toHaveBeenCalled();
    expect(registry.hasRuntime(firstOf('codex'))).toBe(true);
    await registry.dispose();
  });
  it('holds new work immediately without interrupting a running turn or aside; cleans up when idle', async () => {
    const control = discoveryControl('present');
    const one = runtime();
    let busy = true;
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const registry = createProviderRegistry({ definitions: [definition(() => one.provider)], store: createAppStateStore(), prefs: prefs.store, usage: usageService(), catalog: catalogService(), createContext: () => one.context, knownDirectories: () => [], discovery: control.discovery, busy: () => busy });
    registry.start();
    await vi.waitFor(() => expect(registry.hasRuntime(firstOf('codex'))).toBe(true));
    control.set('missing');
    expect(registry.hasRuntime(firstOf('codex'))).toBe(false);
    expect(one.provider.dispose).not.toHaveBeenCalled();
    prefs.set({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } }, 600);
    await Promise.resolve();
    expect(one.provider.dispose).not.toHaveBeenCalled();
    control.set('present');
    expect(registry.hasRuntime(firstOf('codex'))).toBe(true);
    expect(one.provider.dispose).not.toHaveBeenCalled();
    control.set('missing');
    busy = false;
    control.set('missing');
    await vi.waitFor(() => expect(one.provider.dispose).toHaveBeenCalledOnce());
    await registry.dispose();
  });
  it.each([
    ['known-dir', 'C:\\Local\\Claude-Data\\claude.exe'],
    ['override', 'C:\\tools\\codex.exe'],
    ['path', null],
  ] as const)('keeps the file a %s detection found for a sign-in terminal alone, never in app state', async (source, expected) => {
    const file = 'C:\\Local\\Claude-Data\\claude.exe';
    const one = runtime({ detect: vi.fn(async () => ({ kind: 'found', installation: { source, version: '1.0.0' }, executable: { path: expected ?? file, kind: 'native' } } as const)) });
    const store = createAppStateStore();
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const registry = createProviderRegistry({ definitions: [definition(() => one.provider)], store, prefs: prefs.store, usage: usageService(), catalog: catalogService(), createContext: () => one.context, knownDirectories: () => [] });
    expect(registry.executableOffPath(firstOf('codex'))).toBeNull();
    registry.start();
    await vi.waitFor(() => expect(registry.hasRuntime(firstOf('codex'))).toBe(true));
    expect(registry.executableOffPath(firstOf('codex'))).toBe(expected);
    expect(JSON.stringify(store.getSnapshot())).not.toContain('claude.exe');
    expect(JSON.stringify(store.getSnapshot())).not.toContain('codex.exe');
    await registry.dispose();
  });
  it('a Redetect with no CLI found looks again, and names the preferences only for controls discovery cannot use', async () => {
    const control = discoveryControl('missing');
    const prefs = preferences({ kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } });
    const registry = createProviderRegistry({ definitions: [definition(() => runtime().provider)], store: createAppStateStore(), prefs: prefs.store, usage: usageService(), catalog: catalogService(), createContext: () => runtime().context, knownDirectories: () => [], discovery: control.discovery });
    registry.start();
    expect(registry.redetect(firstOf('codex'))).toEqual({ status: 'accepted' });
    expect(control.discovery.scan).toHaveBeenCalledExactlyOnceWith(true);
    control.set('blocked');
    expect(registry.redetect(firstOf('codex'))).toEqual({ status: 'refused', reason: 'preferences-blocked' });
    expect(control.discovery.scan).toHaveBeenCalledOnce();
    await registry.dispose();
  });
  it('never starts a manually disabled provider when it is rediscovered', async () => {
    const control = discoveryControl('missing');
    const factory = vi.fn(() => runtime().provider);
    const prefs = preferences({ kind: 'disabled', preferences: { enabled: false, executablePath: null, permissionMode: null } });
    const registry = createProviderRegistry({ definitions: [definition(factory)], store: createAppStateStore(), prefs: prefs.store, usage: usageService(), catalog: catalogService(), createContext: () => runtime().context, knownDirectories: () => [], discovery: control.discovery });
    registry.start();
    control.set('present');
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();
    await registry.dispose();
  });
});
