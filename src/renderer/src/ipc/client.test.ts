// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { invoke, IpcError, subscribe } from './client';

let bridge: FakeBridge;
beforeEach(() => {
  bridge = installFakeBridge();
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof IpcError ? error.code : `not an IpcError: ${String(error)}`;
  }
}

describe('invoke', () => {
  it('unwraps a successful envelope', async () => {
    const snapshot = sampleSnapshot(4);
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: snapshot }));
    await expect(invoke('state:getSnapshot', null)).resolves.toBe(snapshot);
  });

  it('throws an IpcError carrying main’s code for a refusal', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: false, error: 'forbidden' }));
    expect(await codeOf(invoke('state:getSnapshot', null))).toBe('forbidden');
  });

  it('turns an Electron-level rejection into "unavailable"', async () => {
    bridge.setInvoke(() => Promise.reject(new Error("Error invoking remote method 'state:getSnapshot': reply was never sent")));
    expect(await codeOf(invoke('state:getSnapshot', null))).toBe('unavailable');
  });
});

describe('subscribe', () => {
  it('delivers pushes and stops after the returned function is called', () => {
    const listener = vi.fn();
    const stop = subscribe('state:snapshot', listener);

    bridge.push('state:snapshot', sampleSnapshot(1));
    stop();
    bridge.push('state:snapshot', sampleSnapshot(2));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(bridge.listenerCount('state:snapshot')).toBe(0);
  });
});
