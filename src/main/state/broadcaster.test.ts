// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { PreferencesSnapshot } from '@shared/contracts/prefs';
import type { PushChannel, WindowKind } from '@shared/ipc/channels';
import { SAMPLE_EMAIL, sampleSnapshot } from '../../../tests/support/app-state';
import { createPreferencesStore, type PreferencesStore } from '../prefs/store';
import { createAppStateStore } from './app-state-store';
import { startPrefsBroadcaster, startStateBroadcaster } from './broadcaster';
import type { BroadcastTarget } from './push';

interface Received {
  readonly channel: PushChannel;
  readonly payload: unknown;
}

interface FakeWindow extends BroadcastTarget {
  readonly received: Received[];
  alive: boolean;
}

function fakeWindow(kind: WindowKind): FakeWindow {
  const received: Received[] = [];
  const window: FakeWindow = {
    kind,
    received,
    alive: true,
    isAlive: () => window.alive,
    send: (channel, payload) => {
      received.push({ channel, payload });
    },
  };
  return window;
}

const states = (window: FakeWindow): AppStateSnapshot[] =>
  window.received.filter((entry) => entry.channel === 'state:snapshot').map((entry) => entry.payload as AppStateSnapshot);
const prefsOf = (window: FakeWindow): PreferencesSnapshot[] =>
  window.received.filter((entry) => entry.channel === 'prefs:changed').map((entry) => entry.payload as PreferencesSnapshot);

const log = { error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  log.error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

function setupState(targets: BroadcastTarget[]) {
  const store = createAppStateStore();
  const stop = startStateBroadcaster({ store, targets: () => targets, delayMs: 16, log });
  return { store, stop };
}

describe('app state', () => {
  it('coalesces a burst of changes into one push per window, carrying the latest state', () => {
    const main = fakeWindow('main');
    const { store } = setupState([main]);

    store.updateProviders(() => sampleSnapshot().providers);
    store.updateProviders((providers) => [...providers]);
    store.updateProviders((providers) => [...providers]);
    expect(main.received).toHaveLength(0); // nothing until the flush

    vi.advanceTimersByTime(16);
    expect(states(main).map((snapshot) => snapshot.seq)).toEqual([3]);
  });

  it('keeps pushing during a continuous stream of changes instead of waiting for it to end', () => {
    const main = fakeWindow('main');
    const { store } = setupState([main]);

    // 100 ms of changes, one every 5 ms. A debounce would send nothing until the stream stopped;
    // coalescing sends roughly every 16 ms throughout.
    for (let i = 0; i < 20; i += 1) {
      store.updateProviders((providers) => [...providers]);
      vi.advanceTimersByTime(5);
    }
    expect(main.received.length).toBeGreaterThanOrEqual(4);
  });

  it('sends every window its own projection', () => {
    const main = fakeWindow('main');
    const pet = fakeWindow('pet');
    const { store } = setupState([main, pet]);

    store.updateProviders(() => sampleSnapshot().providers);
    vi.advanceTimersByTime(16);

    expect(JSON.stringify(states(main))).toContain(SAMPLE_EMAIL);
    expect(JSON.stringify(states(pet))).not.toContain(SAMPLE_EMAIL);
    expect(states(pet)[0]?.seq).toBe(states(main)[0]?.seq);
  });

  it('skips windows that are closing or gone', () => {
    const main = fakeWindow('main');
    const pet = fakeWindow('pet');
    pet.alive = false;
    const { store } = setupState([main, pet]);

    store.updateProviders(() => []);
    store.updateProviders(() => sampleSnapshot().providers);
    vi.advanceTimersByTime(16);

    expect(main.received).toHaveLength(1);
    expect(pet.received).toHaveLength(0);
  });

  it('keeps updating the other windows when one of them throws', () => {
    const broken: BroadcastTarget = {
      kind: 'pet',
      isAlive: () => true,
      send: () => {
        throw new Error('Object has been destroyed');
      },
    };
    const main = fakeWindow('main');
    const { store } = setupState([broken, main]);

    store.updateProviders(() => sampleSnapshot().providers);
    vi.advanceTimersByTime(16);

    expect(main.received).toHaveLength(1);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('stops pushing once stopped, including a flush that was already scheduled', () => {
    const main = fakeWindow('main');
    const { store, stop } = setupState([main]);

    store.updateProviders(() => sampleSnapshot().providers);
    stop();
    vi.advanceTimersByTime(100);
    store.updateProviders(() => []);
    vi.advanceTimersByTime(100);

    expect(main.received).toHaveLength(0);
  });
});

describe('preferences', () => {
  let dir: string;
  let prefs: PreferencesStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fatg-prefs-push-'));
    prefs = createPreferencesStore({ dir, providerIds: ['claude'], writeDelayMs: 10_000, log: { warn: vi.fn(), error: vi.fn() } });
  });
  afterEach(() => {
    prefs.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reaches the Main window', () => {
    const main = fakeWindow('main');
    startPrefsBroadcaster({ prefs, targets: () => [main], delayMs: 16, log });

    prefs.patch({ privacy: { maskEmail: false } });
    vi.advanceTimersByTime(16);

    expect(prefsOf(main)).toHaveLength(1);
    expect(prefsOf(main)[0]?.values.privacy.maskEmail).toBe(false);
  });

  it('never reaches the Pet window', () => {
    const main = fakeWindow('main');
    const pet = fakeWindow('pet');
    startPrefsBroadcaster({ prefs, targets: () => [main, pet], delayMs: 16, log });

    prefs.patch({ providers: { claude: { executablePath: 'C:\\Users\\someone\\bin\\claude.exe' } } });
    vi.advanceTimersByTime(16);

    expect(prefsOf(main)).toHaveLength(1);
    expect(pet.received).toHaveLength(0);
  });

  it('coalesces a burst into one push carrying the latest values', () => {
    const main = fakeWindow('main');
    startPrefsBroadcaster({ prefs, targets: () => [main], delayMs: 16, log });

    prefs.patch({ usage: { pollIntervalSec: 600 } });
    prefs.patch({ usage: { pollIntervalSec: 900 } });
    prefs.patch({ audio: { muted: true } });
    vi.advanceTimersByTime(16);

    expect(prefsOf(main)).toHaveLength(1);
    expect(prefsOf(main)[0]?.values).toMatchObject({ usage: { pollIntervalSec: 900 }, audio: { muted: true } });
  });
});

describe('the two together', () => {
  it('send on their own channels, and the Pet only ever hears about app state', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fatg-prefs-both-'));
    const prefs = createPreferencesStore({ dir, writeDelayMs: 10_000, log: { warn: vi.fn(), error: vi.fn() } });
    const main = fakeWindow('main');
    const pet = fakeWindow('pet');
    const targets = () => [main, pet];

    try {
      const store = createAppStateStore();
      startStateBroadcaster({ store, targets, delayMs: 16, log });
      startPrefsBroadcaster({ prefs, targets, delayMs: 16, log });

      store.updateProviders(() => sampleSnapshot().providers);
      prefs.patch({ audio: { muted: true } });
      vi.advanceTimersByTime(16);

      expect(main.received.map((entry) => entry.channel).sort()).toEqual(['prefs:changed', 'state:snapshot']);
      expect(pet.received.map((entry) => entry.channel)).toEqual(['state:snapshot']);
    } finally {
      prefs.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
