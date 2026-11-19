// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The check every start takes (decision 0016, item 2): a new chat, a reviewer, a new session an integration makes.
import { describe, expect, it } from 'vitest';
import { sampleProvider } from '../../../tests/support/app-state';
import { sampleCatalog } from '../../../tests/support/catalog';
import { admitPreset, type PresetAdmissionDeps } from './preset-admission';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const PRESET = { providerId: 'codex', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null };
const deps = (patch: Partial<PresetAdmissionDeps> = {}): PresetAdmissionDeps => ({
  project: (id) => (id === PROJECT ? { providers: ['claude', 'codex'] } : undefined),
  hasProvider: () => true,
  catalog: () => sampleCatalog(['claude', 'codex']),
  accounts: () => [sampleProvider(), sampleProvider({ id: 'codex', displayName: 'Codex' })],
  ...patch,
});

describe('admitting a preset', () => {
  it('takes a preset of any provider the project is offered to, its model as the catalog keys it', () => {
    expect(admitPreset(deps(), PROJECT, PRESET)).toEqual({ ok: true, preset: PRESET });
    expect(admitPreset(deps(), PROJECT, { ...PRESET, providerId: 'claude' })).toEqual({ ok: true, preset: { ...PRESET, providerId: 'claude' } });
  });

  it('refuses an unknown project, and a provider this build does not have as not offered', () => {
    expect(admitPreset(deps(), 'aaaaaaaa-0000-4000-8000-000000000000', PRESET)).toEqual({ ok: false, reason: 'unknown-project' });
    expect(admitPreset(deps({ hasProvider: (id) => id !== 'codex' }), PROJECT, PRESET)).toEqual({ ok: false, reason: 'provider-not-offered' });
  });

  it('refuses what a new chat refuses: a model not listed, a level the model lacks, an account not set up', () => {
    expect(admitPreset(deps(), PROJECT, { ...PRESET, model: 'gone' })).toEqual({ ok: false, reason: 'model-not-listed' });
    expect(admitPreset(deps(), PROJECT, { ...PRESET, effort: 'ultra', speed: null })).toEqual({ ok: false, reason: 'effort-not-listed' });
    expect(admitPreset(deps(), PROJECT, { ...PRESET, instanceId: '11111111-2222-4333-8444-555555555555' })).toEqual({ ok: false, reason: 'instance-unavailable' });
  });
});
