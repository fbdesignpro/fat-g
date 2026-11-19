// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { DiscoveredProvider, ProviderDiscoveryState } from '@shared/contracts/provider-discovery';
import { project, recordsState } from '../test/records';
import { firstRunGuide } from './first-run';

const provider = (overrides: Partial<DiscoveredProvider> = {}): DiscoveredProvider =>
  ({ id: 'claude', displayName: 'Claude', presence: 'missing', enabled: false, overrideInvalid: false, checkFailed: false, ...overrides });
const discovery = (...providers: DiscoveredProvider[]): ProviderDiscoveryState => ({ checking: false, providers, notice: null, historyIssue: null });
const NONE = recordsState([]);
const ONE = recordsState([project('Calamari')]);
const USABLE = provider({ presence: 'present', enabled: true });

describe('the first-run guide', () => {
  it('says nothing before discovery arrives, or while every provider has its first check', () => {
    expect(firstRunGuide(undefined, NONE)).toBeNull();
    expect(firstRunGuide(discovery(provider({ presence: 'checking' }), provider({ id: 'codex', presence: 'checking' })), NONE)).toBeNull();
    expect(firstRunGuide(discovery(), NONE)).toBeNull();
  });

  it('asks for a provider while none is detected and switched on, with or without projects', () => {
    const missing = discovery(provider(), provider({ id: 'codex', presence: 'unknown', checkFailed: true }));
    expect(firstRunGuide(missing, ONE)).toEqual({ kind: 'no-provider', providers: missing.providers, checking: false });
    const off = discovery(provider({ presence: 'present', enabled: false }), provider({ id: 'codex', presence: 'checking' }));
    expect(firstRunGuide(off, NONE)?.kind).toBe('no-provider');
    expect(firstRunGuide({ ...missing, checking: true }, undefined)).toEqual({ kind: 'no-provider', providers: missing.providers, checking: true });
  });

  it('points at Add project once a provider can be used and no project exists', () => {
    expect(firstRunGuide(discovery(provider(), USABLE), NONE)).toEqual({ kind: 'add-project' });
    // A switched-on provider checked again still counts, so a recheck shows no other guide.
    expect(firstRunGuide(discovery(provider({ presence: 'checking', enabled: true })), NONE)).toEqual({ kind: 'add-project' });
  });

  it('says nothing once a project exists, or while the records are refused or not read', () => {
    expect(firstRunGuide(discovery(USABLE), ONE)).toBeNull();
    expect(firstRunGuide(discovery(USABLE), recordsState([], { kind: 'refused', cause: 'unreadable' }))).toBeNull();
    expect(firstRunGuide(discovery(USABLE), undefined)).toBeNull();
  });
});
