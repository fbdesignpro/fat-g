// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Whether an instance can be asked for anything (M14, C108; M14b, V9: C25, C29), on a table of the
// statuses a snapshot can carry.
import { describe, expect, it } from 'vitest';
import { sampleProvider } from '../../../tests/support/app-state';
import { availableInstances, unavailable } from './availability';
import type { ProviderStatus } from './status';

const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const snapshot = (id: string, instanceId: string, status: ProviderStatus = { kind: 'ok' }) => sampleProvider({ id, instanceId, status });
const first = (providerId: string) => ({ providerId, instanceId: 'default' });
const work = { providerId: 'codex', instanceId: WORK };

describe('unavailable', () => {
  it('is nothing for an instance that is configured and switched on', () => {
    const snapshots = [snapshot('claude', 'default'), snapshot('codex', 'default'), snapshot('codex', WORK)];
    expect(unavailable(snapshots, first('codex'))).toBeNull();
    expect(unavailable(snapshots, work)).toBeNull();
    // One UUID in another letter case is the same instance.
    expect(unavailable(snapshots, { providerId: 'codex', instanceId: WORK.toUpperCase() })).toBeNull();
  });

  it('says the provider, for one this build does not have or one switched off, whatever its instance', () => {
    expect(unavailable([snapshot('claude', 'default')], first('codex'))).toBe('provider-unavailable');
    expect(unavailable([snapshot('claude', 'default')], work)).toBe('provider-unavailable');
    const off = [snapshot('codex', 'default', { kind: 'disabled' }), snapshot('codex', WORK, { kind: 'disabled' })];
    expect(unavailable(off, first('codex'))).toBe('provider-unavailable');
    expect(unavailable(off, work)).toBe('provider-unavailable');
    expect(unavailable([], first('codex'))).toBe('provider-unavailable');
  });

  it.each<[string, ProviderStatus | null]>([
    ['is not configured', null],
    ['is switched off', { kind: 'disabled' }],
    ['is an entry that cannot be used', { kind: 'blocked', reason: 'invalid-instance', issue: 'duplicate-id' }],
    ['has lost its folder', { kind: 'blocked', reason: 'folder-missing' }],
    ['has a folder that is refused', { kind: 'blocked', reason: 'folder-refused', rule: 'data-folder' }],
  ])('says the instance, for one that %s while its provider is on', (_name, status) => {
    const snapshots = [snapshot('codex', 'default'), ...(status === null ? [] : [snapshot('codex', WORK, status)])];
    expect(unavailable(snapshots, work)).toBe('instance-unavailable');
    expect(unavailable(snapshots, first('codex'))).toBeNull();
  });

  it('keeps another provider’s instance of the same id apart', () => {
    expect(unavailable([snapshot('claude', 'default'), snapshot('codex', 'default'), snapshot('codex', WORK)], { providerId: 'claude', instanceId: WORK })).toBe('instance-unavailable');
  });

  it.each<ProviderStatus>([
    { kind: 'ok' },
    { kind: 'stale' },
    { kind: 'detecting' },
    { kind: 'not-logged-in' },
    { kind: 'not-installed', overrideInvalid: false },
    { kind: 'error', message: 'x' },
    { kind: 'blocked', reason: 'preferences-unavailable' },
    { kind: 'blocked', reason: 'invalid-preferences' },
  ])('holds nothing for an instance that reads $kind: that is its CLI’s state, and the provider’s to show', (status) => {
    const snapshots = [snapshot('codex', 'default', status), snapshot('codex', WORK, status)];
    expect(unavailable(snapshots, first('codex'))).toBeNull();
    expect(unavailable(snapshots, work)).toBeNull();
  });
});

describe('availableInstances', () => {
  it('lists the instances a session can start on, in the app state’s order', () => {
    const snapshots = [
      snapshot('claude', 'default', { kind: 'disabled' }),
      snapshot('claude', WORK, { kind: 'disabled' }),
      snapshot('codex', 'default', { kind: 'not-logged-in' }),
      snapshot('codex', WORK),
      snapshot('codex', '11111111-2222-4333-8444-555555555555', { kind: 'blocked', reason: 'folder-missing' }),
    ];
    expect(availableInstances(snapshots)).toEqual([first('codex'), work]);
    expect(availableInstances([])).toEqual([]);
  });
});
