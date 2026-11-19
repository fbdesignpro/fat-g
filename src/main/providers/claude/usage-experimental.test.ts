// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessFailure } from '@shared/provider-kit/process';
import type { ControlClient, ControlReply } from './control-client';
import { readExperimentalUsage } from './usage-experimental';

afterEach(() => vi.useRealTimers());
const client = (answer: (signal: AbortSignal) => Promise<ControlReply>) => {
  const request = vi.fn((_subtype: string, _payload: unknown, signal: AbortSignal) => answer(signal));
  return { request: request as unknown as ControlClient['request'], calls: request.mock.calls };
};

describe('experimental usage seam', () => {
  it('sends get_usage exactly once, with skip_behaviors', async () => {
    const c = client(() => Promise.resolve({ kind: 'success', value: { rate_limits: null } }));
    expect(await readExperimentalUsage(c, new AbortController().signal, 1000)).toEqual({ kind: 'available', value: { rate_limits: null } });
    expect(c.calls.map(([subtype, payload]) => [subtype, payload])).toEqual([['get_usage', { skip_behaviors: true }]]);
  });

  it.each(['Unsupported control request subtype: get_usage', 'Unsupported control request subtype'])('reports outcome C for the exact CLI rejection %j', async (error) => {
    expect(await readExperimentalUsage(client(() => Promise.resolve({ kind: 'error', error })), new AbortController().signal, 1000)).toEqual({ kind: 'missing' });
  });

  it.each([
    'Unsupported control request subtype: get_context_usage',
    'Error: Unsupported control request subtype: get_usage',
    'unsupported control request subtype: get_usage',
    'Unsupported control request subtype: get_usage ',
    'rate limited',
    '',
  ])('treats any other rejection (%j) as transient, never as an old CLI', async (error) => {
    expect(await readExperimentalUsage(client(() => Promise.resolve({ kind: 'error', error })), new AbortController().signal, 1000)).toEqual({ kind: 'failed' });
  });

  it('treats a transport failure as transient', async () => {
    expect(await readExperimentalUsage(client(() => Promise.reject(new ProcessFailure('transport-closed'))), new AbortController().signal, 1000)).toEqual({ kind: 'failed' });
  });

  it('times out by aborting its own request, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    let seen!: AbortSignal;
    const c = client((signal) => { seen = signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ProcessFailure('aborted')))); });
    const reading = readExperimentalUsage(c, new AbortController().signal, 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await reading).toEqual({ kind: 'failed' });
    expect(seen.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('follows session teardown: an abort ends the wait, and an aborted session never sends', async () => {
    const controller = new AbortController();
    const c = client((signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ProcessFailure('aborted')))));
    const reading = readExperimentalUsage(c, controller.signal, 10_000);
    controller.abort();
    expect(await reading).toEqual({ kind: 'failed' });
    const unused = client(() => Promise.resolve({ kind: 'success', value: {} }));
    expect(await readExperimentalUsage(unused, controller.signal, 10_000)).toEqual({ kind: 'failed' });
    expect(unused.calls).toHaveLength(0);
  });
});
