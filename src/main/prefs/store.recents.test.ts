// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPreferences, PreferencesPatchSchema } from '@shared/contracts/prefs';
import { readRecentModels } from '@shared/contracts/recent-models';
import type { ModelPreset } from '@shared/contracts/presets';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from './store';

const selection = (model = 'sample-1'): ModelPreset => ({ providerId: 'codex', instanceId: 'default', model, effort: 'high', speed: null });
let dir: string;
let store: PreferencesStore;
const file = () => path.join(dir, PREFERENCES_FILE);
const open = () => createPreferencesStore({ dir, providerIds: ['codex'], writeDelayMs: 60_000 });
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'fatg-recents-')); });
afterEach(() => { store?.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe('recent model use in preferences', () => {
  it('clears recent combinations through preferences while preserving saved presets and other fields', () => {
    const presetId = '11111111-2222-4333-8444-555555555555';
    store = open();
    store.patch({ presets: { [presetId]: { ...selection(), name: 'Saved' } } });
    store.noteModelUse(selection());
    store.patch({ clearRecentModels: true });
    expect(store.getSnapshot().values.recentModels).toEqual([]);
    expect(store.getSnapshot().values.presets[presetId]?.name).toBe('Saved');
    store.flushSync();
    store.dispose();
    store = open();
    expect(store.getSnapshot().values.recentModels).toEqual([]);
    expect(store.getSnapshot().values.presets[presetId]?.name).toBe('Saved');
    store.noteModelUse(selection());
    expect(store.getSnapshot().values.recentModels).toEqual([selection()]);
  });
  it('merges exact uses, caps the list at twelve, and persists independently of saved presets', () => {
    store = open();
    expect(store.getSnapshot().values.recentModels).toEqual([]);
    for (let i = 0; i < 14; i += 1) store.noteModelUse(selection(`model-${i}`));
    store.noteModelUse(selection('model-5'));
    store.noteModelUse({ ...selection('model-5'), effort: 'low' });
    store.noteModelUse({ ...selection('model-5'), instanceId: '11111111-2222-4333-8444-555555555555' });
    const recent = store.getSnapshot().values.recentModels;
    expect(recent).toHaveLength(12);
    expect(recent.slice(0, 4)).toEqual([
      { ...selection('model-5'), instanceId: '11111111-2222-4333-8444-555555555555' },
      { ...selection('model-5'), effort: 'low' }, selection('model-5'), selection('model-13'),
    ]);
    expect(recent.some((entry) => entry.model === 'model-0')).toBe(false);
    const revision = store.getSnapshot().rev;
    store.noteModelUse(recent[0]!);
    expect(store.getSnapshot().rev).toBe(revision);
    store.patch({ audio: { muted: true } });
    store.flushSync();
    store.dispose();
    store = open();
    expect(store.getSnapshot().values.recentModels).toEqual(recent);
    expect(store.getSnapshot().values.presets).toEqual({});
    expect(PreferencesPatchSchema.safeParse({ recentModels: [] }).success).toBe(false);
  });

  it('records the speed tier in force with the effort: Fast and standard are two entries (decision 0016)', () => {
    store = open();
    store.noteModelUse(selection());
    store.noteModelUse({ ...selection(), speed: 'priority' });
    store.noteModelUse(selection());
    expect(store.getSnapshot().values.recentModels).toEqual([selection(), { ...selection(), speed: 'priority' }]);
    store.flushSync();
    store.dispose();
    store = open();
    expect(store.getSnapshot().values.recentModels).toEqual([selection(), { ...selection(), speed: 'priority' }]);
    // An entry of an older revision, with no speed tier, is no selection.
    expect(readRecentModels([{ providerId: 'codex', instanceId: 'default', model: 'sample-1', effort: 'high' }])).toEqual([]);
  });

  it('preserves unknown fields and malformed entries without exposing them in the snapshot', () => {
    const invalid = { future: ['keep'] };
    writeFileSync(file(), JSON.stringify({ ...defaultPreferences(), schemaVersion: 24, minReaderVersion: 23, futureTop: true, recentModels: [null, invalid, { ...selection(), future: true }, selection(), { ...selection('other'), effort: null }] }));
    store = open();
    expect(store.getSnapshot().values.recentModels).toEqual([selection(), { ...selection('other'), effort: null }]);
    store.noteModelUse(selection());
    store.flushSync();
    const disk = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
    expect(disk['futureTop']).toBe(true);
    expect([disk['schemaVersion'], disk['minReaderVersion']]).toEqual([24, 23]);
    expect(disk['recentModels']).toEqual([{ ...selection(), future: true }, null, invalid, { ...selection('other'), effort: null }]);
    expect(readRecentModels('invalid')).toEqual([]);
    expect(readRecentModels([{ ...selection(), effort: 42 }, selection()])).toEqual([selection()]);
  });

  it('refuses revision twelve unchanged and does not write history into a blocked file', () => {
    const original = JSON.stringify({ ...defaultPreferences(), schemaVersion: 12, minReaderVersion: 12 });
    writeFileSync(file(), original);
    store = open();
    expect(store.getSnapshot().status).toMatchObject({ kind: 'read-only', reason: 'incompatible' });
    store.noteModelUse(selection());
    store.patch({ clearRecentModels: true });
    store.flushSync();
    expect(readFileSync(file(), 'utf8')).toBe(original);
  });
});
