// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPreferences } from '@shared/contracts/prefs';
import type { SavedPreset } from '@shared/contracts/saved-presets';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from './store';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const preset: SavedPreset = { name: 'Careful', providerId: 'codex', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null };
let dir: string;
let store: PreferencesStore;
const file = () => path.join(dir, PREFERENCES_FILE);
const disk = () => JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fatg-presets-')); });
afterEach(() => { store?.dispose(); rmSync(dir, { recursive: true, force: true }); });
const open = () => createPreferencesStore({ dir, providerIds: ['codex'], writeDelayMs: 60_000 });

describe('presets in preferences', () => {
  it('merges selections into one recency order, persists it, and removes deleted ids', () => {
    store = open();
    store.patch({ presets: { [ID]: preset, [OTHER]: { ...preset, name: 'Other' } } });
    store.patch({ usePreset: ID });
    store.patch({ usePreset: OTHER });
    store.patch({ usePreset: ID });
    store.flushSync();
    expect(disk()['presetRecency']).toEqual([ID, OTHER]);
    store.dispose();
    store = open();
    expect(store.getSnapshot().values.presetRecency).toEqual([ID, OTHER]);
    store.patch({ presets: { [ID]: null } });
    store.patch({ usePreset: ID });
    store.flushSync();
    expect(disk()['presetRecency']).toEqual([OTHER]);
  });
  it('creates, edits and deletes one entry at a time, keeping unavailable selections across a restart', () => {
    store = open();
    store.patch({ presets: { [ID]: preset, [OTHER]: { ...preset, name: 'Other', model: 'missing-model', instanceId: OTHER } } });
    store.flushSync();
    store.dispose();
    store = open();
    expect(store.getSnapshot().values.presets[OTHER]?.model).toBe('missing-model');
    store.patch({ presets: { [ID]: { ...preset, name: '  Renamed\n preset ', effort: null } } });
    store.flushSync();
    expect(store.getSnapshot().values.presets[ID]).toEqual({ ...preset, name: 'Renamed preset', effort: null });
    store.patch({ presets: { [ID]: null } });
    store.flushSync();
    expect(disk()['presets']).toEqual({ [OTHER]: { ...preset, name: 'Other', model: 'missing-model', instanceId: OTHER } });
  });

  it('keeps a preset’s speed tier across a restart, and reads an entry with none as no preset (decision 0016)', () => {
    store = open();
    store.patch({ presets: { [ID]: { ...preset, speed: 'priority' } } });
    store.flushSync();
    expect(disk()['presets']).toEqual({ [ID]: { ...preset, speed: 'priority' } });
    store.dispose();
    store = open();
    expect(store.getSnapshot().values.presets[ID]?.speed).toBe('priority');
    const { speed: _speed, ...older } = preset;
    writeFileSync(file(), JSON.stringify({ ...defaultPreferences(), presets: { [ID]: older } }));
    store.dispose();
    store = open();
    expect(store.getSnapshot().values.presets).toEqual({});
  });

  it('persists preset names at 18 characters without splitting emoji', () => {
    store = open();
    store.patch({ presets: { [ID]: { ...preset, name: '👩‍💻'.repeat(19) } } });
    store.flushSync();
    const saved = { ...preset, name: `${'👩‍💻'.repeat(17)}…` };
    expect(disk()['presets']).toEqual({ [ID]: saved });
    store.dispose();
    store = open();
    expect(store.getSnapshot().values.presets).toEqual({ [ID]: saved });
  });

  it('preserves unknown fields on edited entries and unrelated entries while projecting only known data', () => {
    const untouched = { future: ['keep'], providerId: 'future-provider' };
    writeFileSync(file(), JSON.stringify({ ...defaultPreferences(), futureTop: true, presets: { [ID]: { ...preset, future: { keep: true } }, [OTHER]: untouched } }));
    store = open();
    expect(store.getSnapshot().values.presets).toEqual({ [ID]: preset });
    store.patch({ presets: { [ID]: { ...preset, name: 'Edited' } }, audio: { muted: true } });
    store.flushSync();
    expect(disk()).toMatchObject({ futureTop: true, presets: { [ID]: { ...preset, name: 'Edited', future: { keep: true } }, [OTHER]: untouched } });
    expect(JSON.stringify(store.getSnapshot().values.presets)).not.toContain('future');
  });

  it('refuses the prior format and leaves it byte-for-byte unchanged when a preset write is attempted', () => {
    const original = JSON.stringify({ ...defaultPreferences(), schemaVersion: 11, minReaderVersion: 11 });
    writeFileSync(file(), original);
    store = open();
    expect(store.getSnapshot().status).toMatchObject({ kind: 'read-only', reason: 'incompatible' });
    store.patch({ presets: { [ID]: preset } });
    store.flushSync();
    expect(readFileSync(file(), 'utf8')).toBe(original);
  });
});
