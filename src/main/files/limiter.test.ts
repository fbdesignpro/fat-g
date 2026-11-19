// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5 (docs/planning/_archive/M19b.md; C34): the read limiter — two calls at a time, one deadline for a whole
// read, counted from when it was asked — with the clock faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReadLimiter, READ_DEADLINE_MS, READ_SLOTS } from './limiter';

interface Held {
  readonly name: string;
  resolve(value: string): void;
  reject(error: unknown): void;
}

/** Calls that wait until the test settles them. */
function held() {
  const calls: Held[] = [];
  const call = (name: string) => () => new Promise<string>((resolve, reject) => { calls.push({ name, resolve, reject }); });
  return { calls, call };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the read limiter (C34)', () => {
  it('runs two calls at a time, across reads: a third waits for a free slot', async () => {
    const { calls, call } = held();
    const limiter = createReadLimiter();
    const answers = ['one', 'two', 'three'].map((name) => limiter.begin().run(call(name)));
    await vi.advanceTimersByTimeAsync(0);
    expect(READ_SLOTS).toBe(2);
    expect(calls.map((entry) => entry.name)).toEqual(['one', 'two']);
    calls[0]?.resolve('ONE');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((entry) => entry.name)).toEqual(['one', 'two', 'three']);
    calls[1]?.reject(Object.assign(new Error('x'), { code: 'EIO' }));
    calls[2]?.resolve('THREE');
    expect(await Promise.all(answers)).toEqual([
      { answered: true, ok: true, value: 'ONE' },
      { answered: true, ok: false, error: expect.objectContaining({ code: 'EIO' }) as unknown },
      { answered: true, ok: true, value: 'THREE' },
    ]);
  });

  it('gives one deadline to a whole read, counted from when it began', async () => {
    const { calls, call } = held();
    const clock = createReadLimiter().begin();
    const first = clock.run(call('stat'));
    await vi.advanceTimersByTimeAsync(4000);
    calls[0]?.resolve('done');
    expect(await first).toEqual({ answered: true, ok: true, value: 'done' });
    expect(clock.expired()).toBe(false);
    // The second call of the same read has what is left of the ten seconds, not ten of its own.
    const second = clock.run(call('read'));
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 4000);
    expect(await second).toEqual({ answered: false });
    expect(clock.expired()).toBe(true);
    // And one asked after the deadline is not answered either.
    const third = clock.run(call('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await third).toEqual({ answered: false });
  });

  it('keeps a call’s slot until it returns, whatever its read was told', async () => {
    const { calls, call } = held();
    const limiter = createReadLimiter();
    const hung = [limiter.begin().run(call('n1')), limiter.begin().run(call('n2'))];
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect(await Promise.all(hung)).toEqual([{ answered: false }, { answered: false }]);
    // Both calls are still running: a new read's call gets no slot.
    const next = limiter.begin().run(call('local'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    calls[0]?.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((entry) => entry.name)).toEqual(['n1', 'n2', 'local']);
    calls[2]?.resolve('LOCAL');
    expect(await next).toEqual({ answered: true, ok: true, value: 'LOCAL' });
  });

  it('never starts a call whose read gave up while it waited for a slot', async () => {
    const { calls, call } = held();
    const limiter = createReadLimiter();
    void limiter.begin().run(call('n1'));
    void limiter.begin().run(call('n2'));
    const queued = limiter.begin().run(call('third'));
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect(await queued).toEqual({ answered: false });
    calls[0]?.resolve('x');
    calls[1]?.resolve('y');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((entry) => entry.name)).toEqual(['n1', 'n2']);
  });

  it('does not share a call between two reads of one path: each asks', async () => {
    const { calls, call } = held();
    const limiter = createReadLimiter();
    const answers = [limiter.begin().run(call('same')), limiter.begin().run(call('same'))];
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    for (const entry of calls) entry.resolve('text');
    expect(await Promise.all(answers)).toHaveLength(2);
  });

  it('answers a call that throws at once as a failure, and frees its slot', async () => {
    const limiter = createReadLimiter();
    const thrown = limiter.begin().run<string>(() => { throw Object.assign(new Error('bad'), { code: 'EINVAL' }); });
    await vi.advanceTimersByTimeAsync(0);
    expect(await thrown).toMatchObject({ answered: true, ok: false });
    const after = limiter.begin().run(() => Promise.resolve('ok'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await after).toEqual({ answered: true, ok: true, value: 'ok' });
  });
});
