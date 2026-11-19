// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V29: the limiter (docs/planning/_archive/M12.md, C85), with the file system replaced and the clock faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLookups, LOOKUP_DEADLINE_MS, LOOKUP_SLOTS, type LookupFs } from './lookup';

interface Call {
  readonly path: string;
  resolve(value: string): void;
  reject(error: unknown): void;
}

/** Every call waits until the test settles it. */
function controlledFs() {
  const calls: Call[] = [];
  const fs: LookupFs = {
    realpath: (path) => new Promise<string>((resolve, reject) => { calls.push({ path, resolve, reject }); }),
    stat: (path) => new Promise((resolve, reject) => { calls.push({ path, resolve: () => resolve({ isDirectory: () => true }), reject }); }),
  };
  return { fs, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the lookup limiter (V29)', () => {
  it('runs at most two at a time: a third waits for a free slot', async () => {
    const { fs, calls } = controlledFs();
    const lookups = createLookups({ fs });
    const answers = ['A:\\one', 'A:\\two', 'A:\\three'].map((path) => lookups.realpath(path));
    await vi.advanceTimersByTimeAsync(0);
    expect(LOOKUP_SLOTS).toBe(2);
    expect(calls.map((call) => call.path)).toEqual(['A:\\one', 'A:\\two']);
    calls[0]?.resolve('A:\\One');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.path)).toEqual(['A:\\one', 'A:\\two', 'A:\\three']);
    calls[1]?.resolve('A:\\Two');
    calls[2]?.resolve('A:\\Three');
    expect(await Promise.all(answers)).toEqual(['A:\\One', 'A:\\Two', 'A:\\Three']);
  });

  it('counts a lookup past its deadline as not answered, while its slot stays taken until the call returns', async () => {
    const { fs, calls } = controlledFs();
    const lookups = createLookups({ fs });
    const hung = [lookups.folder('N:\\one'), lookups.folder('N:\\two')];
    await vi.advanceTimersByTimeAsync(LOOKUP_DEADLINE_MS);
    expect(await Promise.all(hung)).toEqual(['no-answer', 'no-answer']);

    // Both calls are still running: a new lookup gets no slot.
    const next = lookups.realpath('C:\\local');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    calls[0]?.reject(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.path)).toEqual(['N:\\one', 'N:\\two', 'C:\\local']);
    calls[2]?.resolve('C:\\Local');
    expect(await next).toBe('C:\\Local');
  });

  it('counts the deadline from when a lookup was asked, waiting included', async () => {
    const { fs, calls } = controlledFs();
    const lookups = createLookups({ fs });
    void lookups.realpath('N:\\one');
    void lookups.realpath('N:\\two');
    const queued = lookups.realpath('C:\\third');
    await vi.advanceTimersByTimeAsync(LOOKUP_DEADLINE_MS);
    expect(await queued).toBeNull();
    // Nobody waits for it any more, so it never takes a slot.
    calls[0]?.resolve('N:\\One');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.path)).toEqual(['N:\\one', 'N:\\two']);
  });

  it('looks up one path asked twice only once', async () => {
    const { fs, calls } = controlledFs();
    const lookups = createLookups({ fs });
    const first = lookups.realpath('C:\\Code');
    const second = lookups.realpath('C:\\Code');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    calls[0]?.resolve('C:\\code');
    expect([await first, await second]).toEqual(['C:\\code', 'C:\\code']);
  });

  it('answers a failed real path with null, and a missing folder as missing', async () => {
    const { fs, calls } = controlledFs();
    const lookups = createLookups({ fs });
    const real = lookups.realpath('C:\\gone');
    const folder = lookups.folder('C:\\gone');
    await vi.advanceTimersByTimeAsync(0);
    for (const call of calls) call.reject(Object.assign(new Error('x'), { code: 'ENOENT' }));
    expect([await real, await folder]).toEqual([null, 'missing']);
  });
});
