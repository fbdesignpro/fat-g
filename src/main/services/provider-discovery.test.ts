// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleProvider } from '../../../tests/support/app-state';
import type { ProviderDefinition } from '@shared/provider-kit/provider';
import type { ExecutablePresence } from '@shared/contracts/provider-discovery';
import type { ProviderPreferenceIssue } from '@shared/contracts/prefs';
import type { ProviderAdmission } from '../prefs/compatibility';
import { createAppStateStore } from '../state/app-state-store';
import type { DiscoveryHistory } from '../storage/provider-discovery-history';
import { createProviderDiscovery, DISCOVERY_COOLDOWN_MS, DISCOVERY_DEADLINE_MS } from './provider-discovery';

const installed = { kind: 'present', overrideInvalid: false } as const;
const missing = { kind: 'missing', overrideInvalid: false } as const;
const unknown = { kind: 'unknown', overrideInvalid: false } as const;
const controls = { enabled: true, executablePath: null, permissionMode: null };
const enabled: ProviderAdmission = { kind: 'enabled', preferences: controls };
function setup(history: Partial<DiscoveryHistory> = {}, ids = ['claude', 'codex', 'third']) {
  const admissions = new Map(ids.map((id) => [id, enabled]));
  const issues: Record<string, ProviderPreferenceIssue> = {};
  const listeners = new Set<() => void>();
  const factory = vi.fn(() => { throw new Error('Discovery must never construct a runtime'); });
  const definitions: ProviderDefinition[] = ids.map((id) => ({
    descriptor: { ...sampleProvider().descriptor, id, displayName: id }, catalogDefaults: {}, installationGuide: 'https://example.test/install',
    executableNames: [id], installDirectoryHints: [], factory,
  }));
  const resolve = vi.fn((_request: unknown): Promise<ExecutablePresence> => Promise.resolve(installed));
  const save = vi.fn(() => Promise.resolve(true));
  const store = createAppStateStore();
  let time = 0;
  const discovery = createProviderDiscovery({
    definitions, store, resolve, cwd: '/probe', knownDirectories: () => ['/known'], now: () => time,
    prefs: { getSnapshot: () => ({ providerIssues: issues }), getProviderAdmission: (id) => admissions.get(id)!, subscribe(listener) { const notify = () => listener({} as never); listeners.add(notify); return () => listeners.delete(notify); } },
    history: { acknowledged: false, providers: {}, unavailable: false, save, ...history },
  });
  return { discovery, resolve, save, store, factory, admissions, issues,
    change(id: string, admission: ProviderAdmission) { admissions.set(id, admission); for (const listener of listeners) listener(); },
    advance() { time += DISCOVERY_COOLDOWN_MS; },
  };
}
afterEach(() => vi.useRealTimers());

describe('provider discovery', () => {
  it.each([0, 1, 3])('batches the first scan with %i installed providers, including a third provider', async (count) => {
    const f = setup();
    f.resolve.mockResolvedValue(missing);
    for (let i = 0; i < count; i++) f.resolve.mockResolvedValueOnce(installed);
    f.discovery.start();
    await f.discovery.scan();
    const notice = f.discovery.getSnapshot().notice!;
    expect(notice.initial).toBe(true);
    expect(notice.providers.filter((p) => p.presence === 'present')).toHaveLength(count);
    expect(f.factory).not.toHaveBeenCalled();
    expect(await f.discovery.acknowledge(notice.revision)).toBe(true);
    expect(f.discovery.getSnapshot().notice).toBeNull();
    expect(f.save).toHaveBeenCalledWith({ claude: count > 0, codex: count > 1, third: count > 2 });
    f.discovery.stop();
  });
  it('keeps an unchanged restart quiet and coalesces focus checks with a one-minute cooldown', async () => {
    const f = setup({ acknowledged: true, providers: { claude: true, codex: true, third: true } });
    f.discovery.start();
    await Promise.all([f.discovery.scan(), f.discovery.scan()]);
    await f.discovery.scan();
    expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.discovery.getSnapshot().notice).toBeNull();
    f.advance();
    await Promise.all([f.discovery.scan(), f.discovery.scan()]);
    expect(f.resolve).toHaveBeenCalledTimes(6);
    await f.discovery.scan(true);
    expect(f.resolve).toHaveBeenCalledTimes(9);
    f.discovery.stop();
  });
  it('reports additions and removals once, preserves manual disables and finds a returning CLI', async () => {
    const f = setup({ acknowledged: true, providers: { claude: false, codex: true, third: true } });
    f.admissions.set('claude', { kind: 'disabled', preferences: { ...controls, enabled: false } });
    f.resolve.mockResolvedValueOnce(installed).mockResolvedValueOnce(missing);
    await f.discovery.scan();
    let notice = f.discovery.getSnapshot().notice!;
    expect(notice.initial).toBe(false);
    expect(notice.providers.map((p) => [p.id, p.presence, p.enabled])).toEqual([['claude', 'present', false], ['codex', 'missing', true]]);
    await f.discovery.acknowledge(notice.revision);
    expect(f.discovery.getSnapshot().notice).toBeNull();
    await f.discovery.scan(true);
    notice = f.discovery.getSnapshot().notice!;
    expect(notice.providers.map((p) => p.id)).toEqual(['codex']);
    expect(f.admissions.get('claude')?.kind).toBe('disabled');
    f.discovery.stop();
  });
  it('keeps prior availability on inconclusive checks without announcing removal', async () => {
    const f = setup({ acknowledged: true, providers: { claude: true } }, ['claude']);
    await f.discovery.scan();
    f.resolve.mockResolvedValue(unknown);
    await f.discovery.scan(true);
    expect(f.discovery.getSnapshot().providers[0]).toMatchObject({ presence: 'present', checkFailed: true });
    expect(f.discovery.getSnapshot().notice).toBeNull();
    f.discovery.stop();
  });
  it('does no resolution when preferences block admission', async () => {
    const f = setup({}, ['claude']);
    f.admissions.set('claude', { kind: 'blocked', reason: 'preferences-unavailable' });
    await f.discovery.scan();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.discovery.getSnapshot().notice).toBeNull();
    expect(f.discovery.getSnapshot().providers[0]?.presence).toBe('blocked');
    f.discovery.stop();
  });
  it('does not turn an invalid disabled override into automatic discovery', async () => {
    const f = setup({}, ['claude']);
    f.admissions.set('claude', { kind: 'disabled', preferences: { ...controls, enabled: false } });
    f.issues['claude'] = 'invalid-executable-path';
    await f.discovery.scan();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.discovery.getSnapshot().providers[0]?.presence).toBe('blocked');
    f.discovery.stop();
  });
  it('ignores old override results and rejects stale acknowledgments', async () => {
    const f = setup({}, ['claude']);
    let release!: (value: ExecutablePresence) => void;
    f.resolve.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    f.discovery.start();
    await Promise.resolve();
    f.change('claude', { kind: 'enabled', preferences: { ...controls, executablePath: '/new' } });
    release(missing);
    await vi.waitFor(() => expect(f.discovery.getSnapshot().providers[0]?.presence).toBe('present'));
    expect(f.resolve).toHaveBeenLastCalledWith(expect.objectContaining({ override: '/new' }));
    expect(await f.discovery.acknowledge(999)).toBe(false);
    const revision = f.discovery.getSnapshot().notice!.revision;
    await f.discovery.acknowledge(revision);
    expect(await f.discovery.acknowledge(revision)).toBe(false);
    f.discovery.stop();
  });
  it('does not lose a newer change while an earlier notice is being saved', async () => {
    const f = setup({}, ['claude']);
    await f.discovery.scan();
    const old = f.discovery.getSnapshot().notice!;
    let saved!: (value: boolean) => void;
    f.save.mockImplementationOnce(() => new Promise((resolve) => { saved = resolve; }));
    const acknowledgment = f.discovery.acknowledge(old.revision);
    f.resolve.mockResolvedValue(missing);
    await f.discovery.scan(true);
    saved(true);
    await acknowledgment;
    expect(f.discovery.getSnapshot().notice).toMatchObject({ initial: false, providers: [{ id: 'claude', presence: 'missing' }] });
    expect(f.discovery.getSnapshot().notice!.revision).toBeGreaterThan(old.revision);
    f.discovery.stop();
  });
  it('publishes no late result and starts no deferred lookup after shutdown', async () => {
    const f = setup({}, ['claude']);
    const scan = f.discovery.scan();
    const seq = f.store.getSnapshot().seq;
    f.discovery.stop();
    await scan;
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.store.getSnapshot().seq).toBe(seq);
  });
  it('bounds stalled initial checks and ignores late results and stopped scans', async () => {
    vi.useFakeTimers();
    const f = setup({}, ['claude']);
    let release!: (value: ExecutablePresence) => void;
    f.resolve.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const scan = f.discovery.scan();
    await vi.advanceTimersByTimeAsync(DISCOVERY_DEADLINE_MS);
    await scan;
    expect(f.discovery.getSnapshot().providers[0]?.presence).toBe('unknown');
    release(installed);
    await Promise.resolve();
    expect(f.discovery.getSnapshot().providers[0]?.presence).toBe('unknown');
    f.discovery.stop();
    await f.discovery.scan(true);
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  it('preserves refused history and exposes a failed save without trapping the dialog', async () => {
    const f = setup({ unavailable: true }, ['claude']);
    await f.discovery.scan();
    expect(f.discovery.getSnapshot()).toMatchObject({ notice: null, historyIssue: 'unavailable' });
    expect(f.save).not.toHaveBeenCalled();
    f.discovery.stop();
    const g = setup({}, ['codex']);
    g.save.mockResolvedValue(false);
    await g.discovery.scan();
    await g.discovery.acknowledge(g.discovery.getSnapshot().notice!.revision);
    expect(g.discovery.getSnapshot()).toMatchObject({ notice: null, historyIssue: 'save-failed' });
    g.discovery.stop();
  });
});
