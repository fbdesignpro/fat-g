// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';
import { defaultPreferences, type Preferences, type PreferencesSnapshot } from '@shared/contracts/prefs';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { connectPrefs, isNewerPrefs, patchPrefs, usePrefs } from './prefs-store';

let bridge: FakeBridge;

const snapshotWith = (rev: number, values: Partial<Preferences> = {}): PreferencesSnapshot => ({
  rev,
  values: { ...defaultPreferences(), ...values },
  status: { kind: 'ok' },
  providerIssues: {},
  instances: {},
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const rev = () => usePrefs.getState().snapshot?.rev ?? null;

beforeEach(() => {
  bridge = installFakeBridge();
  usePrefs.setState({ snapshot: null, error: null, saving: false });
});

describe('isNewerPrefs', () => {
  it('accepts anything when nothing is held, then only a higher rev', () => {
    expect(isNewerPrefs(null, snapshotWith(0))).toBe(true);
    expect(isNewerPrefs(snapshotWith(2), snapshotWith(3))).toBe(true);
    expect(isNewerPrefs(snapshotWith(2), snapshotWith(2))).toBe(false);
    expect(isNewerPrefs(snapshotWith(2), snapshotWith(1))).toBe(false);
  });
});

describe('connectPrefs', () => {
  it('subscribes before it fetches', () => {
    connectPrefs();
    expect(bridge.calls).toEqual(['on:prefs:changed', 'invoke:prefs:get']);
  });

  it('shows what main sent back', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: snapshotWith(0) }));
    connectPrefs();
    await flush();
    expect(usePrefs.getState().snapshot?.values.privacy.maskEmail).toBe(true);
  });

  it('applies a newer push and ignores a stale one', () => {
    connectPrefs();
    bridge.push('prefs:changed', snapshotWith(4));
    bridge.push('prefs:changed', snapshotWith(3));
    expect(rev()).toBe(4);
  });

  it('reports a failure, then clears it when something arrives', async () => {
    bridge.setInvoke(() => Promise.reject(new Error('window closing')));
    connectPrefs();
    await flush();
    expect(usePrefs.getState().error).toBe('unavailable');

    bridge.push('prefs:changed', snapshotWith(1));
    expect(usePrefs.getState().error).toBeNull();
  });

  it('reports main’s refusal code — the Pet window would get this one', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: false, error: 'forbidden' }));
    connectPrefs();
    await flush();
    expect(usePrefs.getState().error).toBe('forbidden');
  });

  it('stops listening when disconnected', () => {
    connectPrefs()();
    bridge.push('prefs:changed', snapshotWith(1));
    expect(rev()).toBeNull();
  });
});

describe('patchPrefs', () => {
  it('shows what was actually saved, not what was asked for', async () => {
    // Main clamps: the window must not keep showing the 5 it sent.
    bridge.setInvoke(() =>
      Promise.resolve({ ok: true, value: snapshotWith(1, { usage: { pollIntervalSec: 60 } }) }),
    );

    await patchPrefs({ usage: { pollIntervalSec: 5 } });

    expect(usePrefs.getState().snapshot?.values.usage.pollIntervalSec).toBe(60);
  });

  it('flags that it is saving, and stops when it is done', async () => {
    let finish = (_value: unknown): void => undefined;
    bridge.setInvoke(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const pending = patchPrefs({ audio: { muted: true } });
    expect(usePrefs.getState().saving).toBe(true);

    finish({ ok: true, value: snapshotWith(1) });
    await pending;
    expect(usePrefs.getState().saving).toBe(false);
  });

  it('surfaces a refusal and stops saving', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: false, error: 'bad-request' }));

    await patchPrefs({ audio: { muted: true } });

    expect(usePrefs.getState()).toMatchObject({ error: 'bad-request', saving: false });
  });

  it('keeps a snapshot that arrived while the patch was in flight, if it is newer', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: snapshotWith(1) }));
    connectPrefs();
    bridge.push('prefs:changed', snapshotWith(5));

    await patchPrefs({ audio: { muted: true } });

    expect(rev()).toBe(5);
  });
});
