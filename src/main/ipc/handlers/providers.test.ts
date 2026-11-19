// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from '../../prefs/store';
import type { InstanceRef } from '@shared/contracts/instances';
import type { ProviderRegistry, RegistryAction } from '../../services/provider-registry';
import { dispatchInvoke, type DispatchDeps } from '../dispatch';
import { providerHandlers } from './providers';

let dir: string;
let prefs: PreferencesStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-provider-ipc-'));
  prefs = createPreferencesStore({ dir, providerIds: ['codex'], writeDelayMs: 10_000, log: { warn: vi.fn(), error: vi.fn() } });
});
afterEach(() => {
  prefs.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function registry(): ProviderRegistry {
  return {
    start: vi.fn(), stop: vi.fn(), has: vi.fn((id) => id === 'codex'), hasInstance: vi.fn((ref: InstanceRef) => ref.providerId === 'codex'),
    refresh: vi.fn(() => ({ status: 'accepted' } as const)), redetect: vi.fn(() => ({ status: 'accepted' } as const)),
    reachOf: vi.fn((_action: RegistryAction, ref: InstanceRef) => [ref]), end: vi.fn(() => Promise.resolve({ confirmed: true })),
    hasRuntime: vi.fn(() => true), facet: vi.fn(() => undefined), executableOffPath: vi.fn(() => null), onRuntimeChanged: vi.fn(() => () => undefined), quiesce: vi.fn(), dispose: vi.fn(() => Promise.resolve()),
  };
}

const dispatchDeps: DispatchDeps = {
  origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }),
  log: { warn: vi.fn(), error: vi.fn() },
  detail: 'kinds',
};
const call = (windowKind: 'main' | 'pet', request: unknown) => ({
  windowKind,
  sender: { frameUrl: `app://fatg/${windowKind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true },
  request,
});

describe('provider IPC handlers', () => {
  it('routes known actions and reports unknown provider IDs as bad requests', async () => {
    const providers = registry();
    const handlers = providerHandlers({ registry: providers, prefs, pickExecutable: vi.fn(), platform: 'win32' });
    expect(await handlers['providers:refresh']({ providerId: 'codex', instanceId: 'default' }, { windowKind: 'main' })).toEqual({ status: 'accepted' });
    expect(providers.refresh).toHaveBeenCalledWith({ providerId: 'codex', instanceId: 'default' });

    const result = await dispatchInvoke(
      'providers:redetect', INVOKE_SPECS['providers:redetect'], handlers['providers:redetect'],
      call('main', { providerId: 'unknown', instanceId: 'default' }), dispatchDeps,
    );
    expect(result).toEqual({ ok: false, error: 'bad-request' });
    expect(providers.redetect).not.toHaveBeenCalled();
  });

  // M14b, V8 (C21): refresh and redetect name an instance, and reach it alone.
  describe('refresh and redetect name an instance', () => {
    const ADDED = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
    const dispatch = (channel: 'providers:refresh' | 'providers:redetect', providers: ProviderRegistry, request: unknown) =>
      dispatchInvoke(channel, INVOKE_SPECS[channel], providerHandlers({ registry: providers, prefs, pickExecutable: vi.fn(), platform: 'win32' })[channel], call('main', request), dispatchDeps);

    it.each(['providers:refresh', 'providers:redetect'] as const)('%s reaches the named instance only', async (channel) => {
      const providers = registry();
      expect(await dispatch(channel, providers, { providerId: 'codex', instanceId: ADDED })).toEqual({ ok: true, value: { status: 'accepted' } });
      const reached = channel === 'providers:refresh' ? providers.refresh : providers.redetect;
      expect(reached).toHaveBeenCalledExactlyOnceWith({ providerId: 'codex', instanceId: ADDED });
      expect(channel === 'providers:refresh' ? providers.redetect : providers.refresh).not.toHaveBeenCalled();
    });

    it.each([
      ['no instance', { providerId: 'codex' }],
      ['an instance id that is neither the first’s nor a UUID', { providerId: 'codex', instanceId: 'work' }],
      ['an extra field', { providerId: 'codex', instanceId: 'default', folder: 'D:\\accounts\\work' }],
      ['an instance the provider does not have', { providerId: 'codex', instanceId: ADDED }],
      ['an unknown provider', { providerId: 'gemini', instanceId: 'default' }],
    ])('refuses %s as a bad request', async (_name, request) => {
      const providers = { ...registry(), hasInstance: vi.fn((ref: InstanceRef) => ref.providerId === 'codex' && ref.instanceId === 'default') };
      for (const channel of ['providers:refresh', 'providers:redetect'] as const) {
        expect(await dispatch(channel, providers, request)).toEqual({ ok: false, error: 'bad-request' });
      }
      expect(providers.refresh).not.toHaveBeenCalled();
      expect(providers.redetect).not.toHaveBeenCalled();
    });
  });

  it.each(['providers:refresh', 'providers:redetect', 'providers:pickExecutable'] as const)('refuses the Pet window on %s', async (channel) => {
    const handlers = providerHandlers({ registry: registry(), prefs, pickExecutable: vi.fn(), platform: 'win32' });
    const result = await dispatchInvoke(channel, INVOKE_SPECS[channel], handlers[channel] as never, call('pet', { providerId: 'codex' }), dispatchDeps);
    expect(result).toEqual({ ok: false, error: 'forbidden' });
  });

  it('allows only one picker and leaves cancellation unchanged', async () => {
    let finish!: (value: string | null) => void;
    const pick = vi.fn(() => new Promise<string | null>((resolve) => { finish = resolve; }));
    const handlers = providerHandlers({ registry: registry(), prefs, pickExecutable: pick, platform: 'win32' });
    const first = handlers['providers:pickExecutable']({ providerId: 'codex' }, { windowKind: 'main' });
    await Promise.resolve();
    await expect(handlers['providers:pickExecutable']({ providerId: 'codex' }, { windowKind: 'main' }))
      .resolves.toEqual({ status: 'refused', reason: 'busy' });
    finish(null);
    await expect(first).resolves.toEqual({ status: 'cancelled' });
    expect(prefs.getSnapshot().values.providers['codex']?.executablePath ?? null).toBeNull();
  });

  it('discards a stale selection if the override changed while the picker was open', async () => {
    let finish!: (value: string | null) => void;
    const handlers = providerHandlers({
      registry: registry(), prefs,
      pickExecutable: () => new Promise<string | null>((resolve) => { finish = resolve; }), platform: 'win32',
    });
    const pending = handlers['providers:pickExecutable']({ providerId: 'codex' }, { windowKind: 'main' });
    await Promise.resolve();
    prefs.patch({ providers: { codex: { executablePath: 'C:\\newer\\codex.exe' } } });
    finish('C:\\stale\\codex.exe');

    await expect(pending).resolves.toEqual({ status: 'refused', reason: 'stale-selection' });
    expect(prefs.getSnapshot().values.providers['codex']?.executablePath).toBe('C:\\newer\\codex.exe');
  });

  it('saves only an absolute selected path and never enables a disabled provider', async () => {
    prefs.patch({ providers: { codex: { enabled: false } } });
    const selected = providerHandlers({
      registry: registry(), prefs, pickExecutable: vi.fn(async () => 'C:\\tools\\codex.exe'), platform: 'win32',
    });
    await expect(selected['providers:pickExecutable']({ providerId: 'codex' }, { windowKind: 'main' }))
      .resolves.toEqual({ status: 'selected' });
    expect(prefs.getSnapshot().values.providers['codex']).toEqual({ enabled: false, executablePath: 'C:\\tools\\codex.exe', permissionMode: null });

    const relative = providerHandlers({
      registry: registry(), prefs, pickExecutable: vi.fn(async () => 'codex.exe'), platform: 'win32',
    });
    await expect(relative['providers:pickExecutable']({ providerId: 'codex' }, { windowKind: 'main' }))
      .resolves.toEqual({ status: 'refused', reason: 'unsupported-path' });
  });

  it('does not open a picker or write when preferences are incompatible', async () => {
    prefs.dispose();
    writeFileSync(path.join(dir, PREFERENCES_FILE), JSON.stringify({ schemaVersion: 99, minReaderVersion: 99 }), 'utf8');
    prefs = createPreferencesStore({ dir, providerIds: ['codex'], log: { warn: vi.fn(), error: vi.fn() } });
    const pick = vi.fn(async () => 'C:\\tools\\codex.exe');
    const handler = providerHandlers({ registry: registry(), prefs, pickExecutable: pick, platform: 'win32' });

    await expect(handler['providers:pickExecutable']({ providerId: 'codex' }, { windowKind: 'main' }))
      .resolves.toEqual({ status: 'refused', reason: 'preferences-blocked' });
    expect(pick).not.toHaveBeenCalled();
  });
});

describe('discovery IPC', () => {
  it('resolves a manual scan and acknowledges the exact notice revision', async () => {
    const discovery = { scan: vi.fn(() => Promise.resolve()), acknowledge: vi.fn(() => Promise.resolve(true)) };
    const handlers = providerHandlers({ registry: registry(), prefs, pickExecutable: async () => null, discovery });
    await handlers['providers:discover'](null, { windowKind: 'main' });
    expect(discovery.scan).toHaveBeenCalledWith(true);
    expect(await handlers['providers:acknowledgeDiscovery']({ revision: 3 }, { windowKind: 'main' })).toBe(true);
    expect(discovery.acknowledge).toHaveBeenCalledWith(3);
    for (const channel of ['providers:discover', 'providers:acknowledgeDiscovery'] as const) {
      const request = channel === 'providers:discover' ? null : { revision: 3 };
      expect(INVOKE_SPECS[channel].from).toEqual(['main']);
      expect(await dispatchInvoke(channel, INVOKE_SPECS[channel], handlers[channel] as never, call('pet', request), dispatchDeps)).toMatchObject({ ok: false });
    }
    for (const request of [{ revision: 0 }, { revision: 1, extra: true }, { revision: 1.1 }, null]) expect(INVOKE_SPECS['providers:acknowledgeDiscovery'].request.safeParse(request).success).toBe(false);
  });
});
