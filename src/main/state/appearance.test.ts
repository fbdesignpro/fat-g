// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ATTENTION_FLASH } from '@shared/contracts/appearance';
import { defaultPreferences } from '@shared/contracts/prefs';
import { createPreferencesStore, PREFERENCES_FILE, type PreferencesStore } from '../prefs/store';
import { createAppStateStore } from './app-state-store';
import { followAppearance } from './appearance';

let dir: string;
let prefs: PreferencesStore | undefined;
const log = { warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-appearance-'));
});
afterEach(() => {
  prefs?.dispose();
  prefs = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const open = (file?: unknown): PreferencesStore => {
  if (file !== undefined) writeFileSync(path.join(dir, PREFERENCES_FILE), JSON.stringify(file), 'utf8');
  prefs = createPreferencesStore({ dir, writeDelayMs: 10_000, log });
  return prefs;
};

describe('followAppearance', () => {
  it('puts the saved theme in the app state at once, and each change after it', () => {
    const store = createAppStateStore();
    const saved = open({ ...defaultPreferences(), appearance: { theme: 'dark' } });
    followAppearance(saved, store);
    expect(store.getSnapshot().appearance).toEqual({ theme: 'dark', flash: DEFAULT_ATTENTION_FLASH });

    saved.patch({ appearance: { theme: 'light' } });
    expect(store.getSnapshot().appearance).toEqual({ theme: 'light', flash: DEFAULT_ATTENTION_FLASH });
  });

  // The maintainer: the attention flash reaches both windows the theme's way.
  it('puts the attention flash in the app state, and each change of it', () => {
    const store = createAppStateStore();
    const saved = open({ ...defaultPreferences(), appearance: { theme: 'dark', flash: { enabled: false, speed: 'slow', seconds: 10 } } });
    followAppearance(saved, store);
    expect(store.getSnapshot().appearance.flash).toEqual({ enabled: false, speed: 'slow', seconds: 10 });
    const seq = store.getSnapshot().seq;
    saved.patch({ appearance: { flash: { enabled: true } } });
    expect(store.getSnapshot().appearance).toEqual({ theme: 'dark', flash: { enabled: true, speed: 'slow', seconds: 10 } });
    expect(store.getSnapshot().seq).toBe(seq + 1);
  });

  it('ignores preference changes that leave the theme alone', () => {
    const store = createAppStateStore();
    const saved = open();
    followAppearance(saved, store);
    const seq = store.getSnapshot().seq;
    saved.patch({ privacy: { maskEmail: false } });
    expect(store.getSnapshot().seq).toBe(seq);
  });

  // C10: a file this build cannot use gives defaults in memory, so both windows are light.
  it.each([
    ['a newer file', { schemaVersion: 99, minReaderVersion: 99, appearance: { theme: 'dark' } }],
    ['an older file', { ...defaultPreferences(), schemaVersion: 2, minReaderVersion: 2, appearance: { theme: 'dark' } }],
    ['a corrupt file', 'not json'],
  ])('is light when preferences are read-only: %s', (_name, file) => {
    const store = createAppStateStore({ appearance: { theme: 'dark' } });
    const saved = open(file);
    expect(saved.getSnapshot().status.kind).toBe('read-only');
    followAppearance(saved, store);
    expect(store.getSnapshot().appearance).toEqual({ theme: 'light', flash: DEFAULT_ATTENTION_FLASH });
  });

  it('stops following when asked', () => {
    const store = createAppStateStore();
    const saved = open();
    const stop = followAppearance(saved, store);
    stop();
    saved.patch({ appearance: { theme: 'dark' } });
    expect(store.getSnapshot().appearance).toEqual({ theme: 'light', flash: DEFAULT_ATTENTION_FLASH });
  });
});
