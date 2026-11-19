// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { sampleProvider } from '../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../tests/support/catalog';
import { PreferencesPatchSchema, PreferencesSchema } from './prefs';
import { type SavedPreset, savedPresetProblem } from './saved-presets';

const ID = '11111111-2222-4333-8444-555555555555';
const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const preset: SavedPreset = { name: 'Careful', providerId: 'claude', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null };

describe('saved presets', () => {
  it('normalizes names, omits malformed entries, and projects no unknown fields', () => {
    const values = PreferencesSchema.parse({ presets: {
      [ID]: { ...preset, name: '  Careful\n review\u0000 ', future: { private: true } },
      [WORK]: { ...preset, effort: 42 },
      invalidId: preset,
    } });
    expect(values.presets).toEqual({ [ID]: { ...preset, name: 'Careful review' } });
    expect(PreferencesSchema.parse({ presets: 'broken' }).presets).toEqual({});
  });

  it('accepts only bounded, named selections and explicit deletes through IPC', () => {
    expect(PreferencesPatchSchema.parse({ presets: { [ID]: preset, [WORK]: null } }).presets).toEqual({ [ID]: preset, [WORK]: null });
    for (const invalid of [{ ...preset, name: ' \n ' }, { ...preset, instanceId: 'anything' }, { ...preset, model: 'bad key' }, { ...preset, effort: 'x'.repeat(129) }, { ...preset, name: 'x'.repeat(4097) }, { ...preset, future: true }]) {
      expect(PreferencesPatchSchema.safeParse({ presets: { [ID]: invalid } }).success).toBe(false);
    }
    expect(PreferencesPatchSchema.safeParse({ presets: { invalidId: preset } }).success).toBe(false);
  });

  it('applies the 18-character name limit to stored presets and IPC writes', () => {
    for (const cluster of ['x', '👩‍💻']) {
      const name = cluster.repeat(19);
      const shortened = `${cluster.repeat(17)}…`;
      expect(PreferencesSchema.parse({ presets: { [ID]: { ...preset, name } } }).presets[ID]?.name).toBe(shortened);
      expect(PreferencesPatchSchema.parse({ presets: { [ID]: { ...preset, name } } }).presets?.[ID]?.name).toBe(shortened);
    }
  });

  it('checks each account’s own list and reports missing, hidden and unsupported combinations without changing them', () => {
    const providers = [sampleProvider(), sampleProvider({ instanceId: WORK, label: 'Work' })];
    const catalog = sampleCatalog(['claude'], { providers: [sampleCatalogProvider(), sampleCatalogProvider({ instanceId: WORK, models: [sampleModel({ efforts: [] })] })] });
    expect(savedPresetProblem(preset, catalog, providers)).toBeNull();
    expect(savedPresetProblem({ ...preset, instanceId: WORK }, catalog, providers)).toContain('Effort');
    expect(savedPresetProblem({ ...preset, instanceId: WORK, effort: null }, catalog, providers)).toBeNull();
    expect(savedPresetProblem({ ...preset, model: 'gone' }, catalog, providers)).toContain('Model');
    expect(savedPresetProblem(preset, sampleCatalog(['claude'], { providers: [sampleCatalogProvider({ models: [sampleModel({ hidden: true })] })] }), providers)).toContain('Model');
    expect(savedPresetProblem(preset, undefined, providers)).toContain('Model');
    expect(savedPresetProblem({ ...preset, instanceId: WORK }, catalog, [providers[0]!])).toContain('Account');
    expect(savedPresetProblem(preset, catalog, [sampleProvider({ status: { kind: 'disabled' } })])).toContain('Provider');
    expect(savedPresetProblem(preset, catalog, [sampleProvider({ status: { kind: 'not-installed', overrideInvalid: false } })])).toContain('ready');
    // The speed tier (decision 0016): one the model lists, asked of an account that can ask.
    expect(savedPresetProblem({ ...preset, speed: 'priority' }, catalog, providers)).toBeNull();
    expect(savedPresetProblem({ ...preset, speed: 'fast' }, catalog, providers)).toBe('Speed is not offered for this model.');
    const unable = sampleCatalog(['claude'], { providers: [sampleCatalogProvider({ speedTierRequest: { possible: false, reason: null } })] });
    expect(savedPresetProblem({ ...preset, speed: 'priority' }, unable, providers)).toBe('This account cannot ask for that speed.');
    expect(preset).toEqual({ name: 'Careful', providerId: 'claude', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null });
  });
});
