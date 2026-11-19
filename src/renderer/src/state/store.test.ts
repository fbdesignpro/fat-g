// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { connectAppState, isNewer, useAppState } from './store';

let bridge: FakeBridge;

/** An invoke that resolves only when the test says so. */
function deferredFetch() {
  let resolve: (snapshot: AppStateSnapshot) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  bridge.setInvoke(
    () =>
      new Promise((res, rej) => {
        resolve = (snapshot) => res({ ok: true, value: snapshot });
        reject = rej;
      }),
  );
  return {
    resolve: (snapshot: AppStateSnapshot) => resolve(snapshot),
    reject: (error: unknown) => reject(error),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const seq = () => useAppState.getState().snapshot?.seq ?? null;

beforeEach(() => {
  bridge = installFakeBridge();
  useAppState.setState({ snapshot: null, error: null });
});

describe('isNewer', () => {
  it('accepts anything when nothing is held, then only a higher seq', () => {
    expect(isNewer(null, sampleSnapshot(0))).toBe(true);
    expect(isNewer(sampleSnapshot(5), sampleSnapshot(6))).toBe(true);
    expect(isNewer(sampleSnapshot(5), sampleSnapshot(5))).toBe(false);
    expect(isNewer(sampleSnapshot(5), sampleSnapshot(4))).toBe(false);
  });
});

describe('connectAppState', () => {
  it('subscribes before it fetches, so no push can fall in between', () => {
    deferredFetch();
    connectAppState();
    expect(bridge.calls).toEqual(['on:state:snapshot', 'invoke:state:getSnapshot']);
  });

  it('shows the fetched snapshot', async () => {
    const fetch = deferredFetch();
    connectAppState();
    fetch.resolve(sampleSnapshot(3));
    await flush();
    expect(seq()).toBe(3);
  });

  it('applies newer pushes and ignores stale or repeated ones', () => {
    deferredFetch();
    connectAppState();
    bridge.push('state:snapshot', sampleSnapshot(5));
    bridge.push('state:snapshot', sampleSnapshot(4));
    bridge.push('state:snapshot', sampleSnapshot(5));
    expect(seq()).toBe(5);
    bridge.push('state:snapshot', sampleSnapshot(6));
    expect(seq()).toBe(6);
  });

  it('ignores a fetch that resolves after a newer push already arrived', async () => {
    const fetch = deferredFetch();
    connectAppState();
    bridge.push('state:snapshot', sampleSnapshot(9));
    fetch.resolve(sampleSnapshot(8));
    await flush();
    expect(seq()).toBe(9);
  });

  it('reports a failed fetch, and clears it when a snapshot arrives', async () => {
    const fetch = deferredFetch();
    connectAppState();
    fetch.reject(new Error('window closing'));
    await flush();
    expect(useAppState.getState()).toMatchObject({ snapshot: null, error: 'unavailable' });

    bridge.push('state:snapshot', sampleSnapshot(1));
    expect(useAppState.getState()).toMatchObject({ error: null });
    expect(seq()).toBe(1);
  });

  it('reports main’s refusal code', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: false, error: 'forbidden' }));
    connectAppState();
    await flush();
    expect(useAppState.getState().error).toBe('forbidden');
  });

  it('stops listening when disconnected', () => {
    deferredFetch();
    const disconnect = connectAppState();
    disconnect();
    bridge.push('state:snapshot', sampleSnapshot(1));
    expect(seq()).toBeNull();
    expect(bridge.listenerCount('state:snapshot')).toBe(0);
  });
});
