// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '@shared/contracts/account';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { AgentProvider, ProviderEvent } from '@shared/provider-kit/provider';
import type { UsageSnapshot } from '@shared/contracts/usage';
import { createAppStateStore } from '../state/app-state-store';
import { sampleProvider, sampleWindow } from '../../../tests/support/app-state';
import { createUsageService, type UsageReadEnd } from './usage-service';

/** A provider's first instance: the one every provider has. */
const first = (providerId: string) => ({ providerId, instanceId: 'default' });

const START = 1_578_924_800_000;
const account: AccountInfo = { authKind: 'subscription', plan: 'pro', email: 'person@example.test' };
const descriptor: ProviderDescriptor = {
  id: 'codex',
  displayName: 'Codex',
  installGuidance: 'Install Codex.',
  loginCommand: 'codex login',
  minPollIntervalSec: 60,
  capabilities: { account: true, usage: 'poll+push', sessions: false, history: false, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null },
};
const installation = { source: 'path', version: '0.155.1' } as const;

afterEach(() => vi.useRealTimers());

function setup(provider: AgentProvider, pollIntervalSec = () => 60) {
  const store = createAppStateStore();
  store.updateProviders(() => [sampleProvider({
    id: 'codex',
    displayName: 'Codex',
    descriptor,
    installation,
    status: { kind: 'detecting' },
    account: null,
    usage: null,
    asOf: null,
  })]);
  const service = createUsageService({ store, pollIntervalSec });
  service.attach({ id: 'codex', generation: 1, provider, descriptor, installation });
  return { service, store };
}

function fakeProvider(options: {
  account?: AgentProvider['getAccount'];
  usage?: AgentProvider['getUsage'];
} = {}) {
  let listener: ((event: ProviderEvent) => void) | undefined;
  const provider: AgentProvider = {
    descriptor,
    detect: vi.fn(async () => ({ kind: 'found', installation } as const)),
    getAccount: options.account ?? vi.fn(async () => ({ kind: 'account', account } as const)),
    getUsage: options.usage ?? vi.fn(async () => ({ kind: 'usage', usage: usage(20) } as const)),
    subscribe(next) { listener = next; return () => { if (listener === next) listener = undefined; }; },
    dispose: vi.fn(async () => undefined),
  };
  return { provider, emit: (event: ProviderEvent) => listener?.(event) };
}

function usage(usedPercent: number): UsageSnapshot {
  return { windows: [sampleWindow({ id: 'codex:primary', usedPercent, resetsAt: START + 3_600_000 })] };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('UsageService', () => {
  it('reads account before usage, publishes a complete refresh, and keeps push freshness conservative', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const order: string[] = [];
    const fake = fakeProvider({
      account: vi.fn(async () => { order.push('account'); return { kind: 'account', account } as const; }),
      usage: vi.fn(async () => { order.push('usage'); return { kind: 'usage', usage: usage(20) } as const; }),
    });
    const { service, store } = setup(fake.provider);
    await settle();

    expect(order).toEqual(['account', 'usage']);
    expect(store.getSnapshot().providers[0]).toMatchObject({
      status: { kind: 'ok' }, account, usage: usage(20), asOf: START, refreshing: false,
      nextRefreshAt: START + 60_000,
    });

    vi.setSystemTime(START + 10_000);
    fake.emit({ type: 'usage', usage: usage(31) });
    expect(store.getSnapshot().providers[0]).toMatchObject({ usage: usage(31), asOf: START });

    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('becomes stale on its own deadline while a later read is still hung', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let reads = 0;
    const fake = fakeProvider({
      account: vi.fn(async (): ReturnType<AgentProvider['getAccount']> => {
        reads += 1;
        if (reads === 1) return { kind: 'account', account } as const;
        return new Promise(() => {});
      }),
    });
    const { service, store } = setup(fake.provider);
    await settle();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getSnapshot().providers[0]?.refreshing).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'stale' }, asOf: START, usage: usage(20) });

    service.stop();
    expect(store.getSnapshot().providers[0]?.refreshing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs transient failures off to the fifteen-minute cap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const getAccount = vi.fn(async () => ({ kind: 'error', reason: 'temporarily-unavailable' } as const));
    const fake = fakeProvider({ account: getAccount });
    const { service, store } = setup(fake.provider);
    await settle();

    const expectedDelays = [60_000, 120_000, 240_000, 480_000, 900_000, 900_000];
    for (const delay of expectedDelays) {
      const provider = store.getSnapshot().providers[0]!;
      expect(provider.nextRefreshAt! - Date.now()).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(getAccount).toHaveBeenCalledTimes(expectedDelays.length + 1);
    service.stop();
  });

  it('drops late results, and reads a replacement at once (M13, C97)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let resolveOld!: (value: { kind: 'account'; account: AccountInfo }) => void;
    const oldAccount = new Promise<{ kind: 'account'; account: AccountInfo }>((resolve) => { resolveOld = resolve; });
    const old = fakeProvider({ account: vi.fn(() => oldAccount) });
    const { service, store } = setup(old.provider);
    await settle();

    const replacement = fakeProvider({ usage: vi.fn(async () => ({ kind: 'usage', usage: usage(77) } as const)) });
    service.attach({ id: 'codex', generation: 2, provider: replacement.provider, descriptor, installation });
    resolveOld({ kind: 'account', account });
    await settle();

    expect(replacement.provider.getAccount).toHaveBeenCalledOnce();
    expect(old.provider.getUsage).not.toHaveBeenCalled();
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'ok' }, usage: usage(77), asOf: START });

    old.emit({ type: 'usage', usage: usage(99) });
    expect(store.getSnapshot().providers[0]?.usage).toEqual(usage(77));
    service.stop();
  });

  it.each(['unsupported-cli-version', 'usage-unavailable'] as const)('keeps a validated account without usage or freshness for usage-level %s (outcome C)', async (reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let unsupported = false;
    const fake = fakeProvider({
      usage: vi.fn(async () => unsupported ? { kind: 'not-applicable', reason } as const : { kind: 'usage', usage: usage(20) } as const),
    });
    const { service, store } = setup(fake.provider);
    await settle();
    unsupported = true;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(store.getSnapshot().providers[0]).toMatchObject({
      status: { kind: 'not-applicable', reason }, account, usage: null, asOf: null, nextRefreshAt: START + 120_000,
    });
    // An ordinary interval, not error backoff: this is a completed read.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(3);
    service.stop();
  });

  it.each(['api-key', 'cloud-provider'] as const)('clears the contradicted account for a usage-level %s answer', async (reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fake = fakeProvider({ usage: vi.fn(async () => ({ kind: 'not-applicable', reason } as const)) });
    const { service, store } = setup(fake.provider);
    await settle();
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'not-applicable', reason }, account: null, usage: null, asOf: null });
    service.stop();
  });

  it('shows the account just validated on a usage-only failure, keeping readings only for the same account', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let current: AccountInfo = account;
    let fail = false;
    const fake = fakeProvider({
      account: vi.fn(async () => ({ kind: 'account', account: current } as const)),
      usage: vi.fn(async () => fail ? { kind: 'error', reason: 'temporarily-unavailable' } as const : { kind: 'usage', usage: usage(20) } as const),
    });
    const { service, store } = setup(fake.provider);
    await settle();
    fail = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getSnapshot().providers[0]).toMatchObject({
      status: { kind: 'error', message: 'Usage is temporarily unavailable.' }, account, usage: usage(20), asOf: START,
    });

    current = { authKind: 'subscription', plan: 'max', email: 'other@example.test' };
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'error' }, account: current, usage: null, asOf: null });
    service.stop();
  });

  it('shows a distinct message for an unconfirmed cleanup and keeps retrying only through the provider', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fake = fakeProvider({ account: vi.fn(async () => ({ kind: 'error', reason: 'cleanup-failed' } as const)) });
    const { service, store } = setup(fake.provider);
    await settle();
    const status = store.getSnapshot().providers[0]?.status;
    expect(status).toEqual({ kind: 'error', message: 'The CLI process cleanup could not be confirmed. Reconnect to check again; restart fat-g if it stays blocked.' });
    expect(fake.provider.getUsage).not.toHaveBeenCalled();
    service.stop();
  });

  it('cancels timers and ignores pushes while suspended, then schedules one eligible resume read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fake = fakeProvider();
    const { service, store } = setup(fake.provider);
    await settle();

    service.suspend();
    fake.emit({ type: 'usage', usage: usage(88) });
    expect(store.getSnapshot().providers[0]).toMatchObject({ usage: usage(20), nextRefreshAt: null, refreshing: false });
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    service.resume();
    await settle();
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(2);
    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes on an unpaired wake and coalesces unlocks during and just after the read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let finish!: (result: { kind: 'usage'; usage: UsageSnapshot }) => void;
    const getUsage = vi.fn<AgentProvider['getUsage']>()
      .mockResolvedValueOnce({ kind: 'usage', usage: usage(20) })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ kind: 'usage', usage: usage(40) });
    const fake = fakeProvider({ usage: getUsage });
    const { service, store } = setup(fake.provider, () => 300);
    await settle();
    // A wall-clock jump models sleep without running any timers or receiving suspend.
    vi.setSystemTime(START + 3_600_000);
    service.resume();
    await settle();
    service.resume(); // unlock while the wake read is still pending
    expect(getUsage).toHaveBeenCalledTimes(2);
    // The wake's own word, from its first read: these readings are from before the sleep (0001's wake amendment).
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'waking' }, usage: usage(20), refreshing: true });
    finish({ kind: 'usage', usage: usage(40) });
    await settle();
    service.resume(); // another notification just after the answer
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUsage).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'ok' }, usage: usage(40), nextRefreshAt: START + 3_900_000 });
    service.stop();
    service.resume();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the floor on a short sleep and marks the readings while a wake read hangs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const getUsage = vi.fn<AgentProvider['getUsage']>()
      .mockResolvedValueOnce({ kind: 'usage', usage: usage(20) })
      .mockImplementation(() => new Promise(() => {}));
    const { service, store } = setup(fakeProvider({ usage: getUsage }).provider);
    await settle();
    service.suspend();
    vi.setSystemTime(START + 10_000);
    service.resume();
    service.resume();
    expect(store.getSnapshot().providers[0]?.nextRefreshAt).toBe(START + 60_000);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(getUsage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(getUsage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'waking' }, usage: usage(20), asOf: START, refreshing: true });
    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores the freshness deadline against wall time when a wake starts no read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const getUsage = vi.fn<AgentProvider['getUsage']>()
      .mockResolvedValueOnce({ kind: 'usage', usage: usage(20) })
      .mockImplementation(() => new Promise(() => {}));
    const { service, store } = setup(fakeProvider({ usage: getUsage }).provider);
    await settle();
    // A short sleep: the clock moves, no timer runs, no suspend arrives. The last read is inside the
    // floor, so the unlock asks for nothing, and no recovery window speaks for the readings. The
    // freshness deadline is what it puts right: twice the interval after the reading, by wall time.
    vi.setSystemTime(START + 30_000);
    service.resume();
    await settle();
    expect(getUsage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000); // the regular poll, which this provider never answers
    expect(getUsage).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'ok' }, asOf: START });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'stale' }, usage: usage(20), asOf: START });
    service.stop();
  });

  it.each([true, false])('discards an interrupted pre-sleep answer after the wake answer (suspend received: %s)', async (receivedSuspend) => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let finishOld!: (result: { kind: 'usage'; usage: UsageSnapshot }) => void;
    let oldSignal: AbortSignal | undefined;
    const getUsage = vi.fn<AgentProvider['getUsage']>()
      .mockImplementationOnce((signal) => {
        oldSignal = signal;
        return new Promise((resolve) => { finishOld = resolve; });
      })
      .mockResolvedValue({ kind: 'usage', usage: usage(40) });
    const { service, store } = setup(fakeProvider({ usage: getUsage }).provider);
    await settle();
    if (receivedSuspend) service.suspend();
    vi.setSystemTime(START + 3_600_000);
    service.resume();
    expect(oldSignal?.aborted).toBe(true);
    await settle();
    finishOld({ kind: 'usage', usage: usage(0) });
    await settle();
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'ok' }, usage: usage(40), asOf: START + 3_600_000 });
    service.stop();
  });

  it('recovers a failed wake read on the window cadence, then restores normal error backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const getUsage = vi.fn<AgentProvider['getUsage']>()
      .mockResolvedValueOnce({ kind: 'usage', usage: usage(20) })
      .mockResolvedValue({ kind: 'error', reason: 'temporarily-unavailable' });
    const { service, store } = setup(fakeProvider({ usage: getUsage }).provider, () => 300);
    await settle();
    service.suspend();
    const woke = START + 3_600_000;
    vi.setSystemTime(woke);
    service.resume();
    await settle();
    // The readings stay, said to be the sleep's, and the next read is the window's 10 s — not the
    // poll interval, and not the 60 s floor, which only spaces reads that trust their answer.
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'waking' }, usage: usage(20), asOf: START, nextRefreshAt: woke + 10_000 });
    for (const [due, next] of [[10_000, 20_000], [30_000, 40_000], [70_000, 60_000], [130_000, 60_000]] as const) {
      await vi.advanceTimersByTimeAsync(woke + due - Date.now());
      expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'waking' }, nextRefreshAt: woke + due + next });
    }
    expect(getUsage).toHaveBeenCalledTimes(6);
    // The window closes five minutes after the wake: the first answer after it is the account's own
    // word again — historical readings, and the error backoff from one counted failure.
    await vi.advanceTimersByTimeAsync(woke + 310_000 - Date.now());
    expect(getUsage).toHaveBeenCalledTimes(9);
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'stale' }, usage: usage(20), nextRefreshAt: woke + 310_000 + 300_000 });
    service.stop();
  });
});

// Decision 0001's wake amendment: a machine that has just woken answers before its network does.
describe('the wake recovery window', () => {
  const unavailable = { kind: 'not-applicable', reason: 'usage-unavailable' } as const;

  /** A good read, then a sleep of an hour, then whatever the provider is given to answer. */
  async function slept(usageResult: AgentProvider['getUsage'], pollIntervalSec = () => 300) {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const getUsage = vi.fn<AgentProvider['getUsage']>()
      .mockResolvedValueOnce({ kind: 'usage', usage: usage(20) })
      .mockImplementation(usageResult);
    const fake = fakeProvider({ usage: getUsage });
    const { service, store } = setup(fake.provider, pollIntervalSec);
    await settle();
    service.suspend();
    const woke = START + 3_600_000;
    vi.setSystemTime(woke);
    service.resume();
    await settle();
    return { service, store, getUsage, woke, provider: () => store.getSnapshot().providers[0] };
  }

  it('keeps the readings when the CLI reports no allocations right after a wake, and asks again at once', async () => {
    const h = await slept(async () => unavailable);
    expect(h.provider()).toMatchObject({ status: { kind: 'waking' }, account, usage: usage(20), asOf: START, nextRefreshAt: h.woke + 10_000 });
    // A reading inside the window ends it: fresh figures, the regular schedule, nothing historical.
    h.getUsage.mockResolvedValue({ kind: 'usage', usage: usage(55) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.provider()).toMatchObject({ status: { kind: 'ok' }, usage: usage(55), asOf: h.woke + 10_000, nextRefreshAt: h.woke + 310_000 });
    h.service.stop();
  });

  it('lets "no allocations" stand once the window has closed, with the account-only panel', async () => {
    const h = await slept(async () => unavailable);
    await vi.advanceTimersByTimeAsync(310_000);
    expect(h.provider()).toMatchObject({ status: unavailable, account, usage: null, asOf: null });
    expect(h.provider()?.nextRefreshAt).toBe(h.woke + 310_000 + 300_000);
    h.service.stop();
  });

  it.each([
    ['an API key', { kind: 'not-applicable', reason: 'api-key' }],
    ['a CLI without the usage interface', { kind: 'not-applicable', reason: 'unsupported-cli-version' }],
  ] as const)('settles at once on an answer the network cannot explain: %s', async (_name, result) => {
    const h = await slept(async () => result);
    expect(h.provider()).toMatchObject({ status: result, usage: null, asOf: null });
    expect(h.provider()?.nextRefreshAt).toBe(h.woke + 300_000);
    h.service.stop();
  });

  it('gives no grace when the readings belong to another account', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const other = { ...account, email: 'someone.else@example.test' };
    const getAccount = vi.fn<AgentProvider['getAccount']>()
      .mockResolvedValueOnce({ kind: 'account', account })
      .mockResolvedValue({ kind: 'account', account: other });
    const getUsage = vi.fn<AgentProvider['getUsage']>()
      .mockResolvedValueOnce({ kind: 'usage', usage: usage(20) })
      .mockResolvedValue(unavailable);
    const { service, store } = setup(fakeProvider({ account: getAccount, usage: getUsage }).provider, () => 300);
    await settle();
    service.suspend();
    vi.setSystemTime(START + 3_600_000);
    service.resume();
    await settle();
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: unavailable, account: other, usage: null, asOf: null });
    service.stop();
  });

  it('is never extended by a second notification, and is closed by a suspend', async () => {
    const h = await slept(async () => unavailable);
    await vi.advanceTimersByTimeAsync(240_000);
    h.service.resume(); // an unlock four minutes in: the same window, not a new five minutes
    await settle();
    expect(h.provider()).toMatchObject({ status: { kind: 'waking' }, usage: usage(20) });
    await vi.advanceTimersByTimeAsync(h.woke + 370_000 - Date.now());
    expect(h.provider()).toMatchObject({ status: unavailable, usage: null });
    h.service.suspend();
    expect(h.provider()).toMatchObject({ nextRefreshAt: null, refreshing: false });
    expect(vi.getTimerCount()).toBe(0);
    h.service.stop();
  });
});

// M13 (C69, C73): how each read ended, for the catalog.
describe('the read-end hook', () => {
  function hooked(provider: AgentProvider) {
    const store = createAppStateStore();
    store.updateProviders(() => [sampleProvider({ id: 'codex', displayName: 'Codex', descriptor, installation, status: { kind: 'detecting' }, account: null, usage: null, asOf: null })]);
    const onReadEnd = vi.fn<(ref: { providerId: string; instanceId: string }, end: UsageReadEnd) => void>();
    const service = createUsageService({ store, pollIntervalSec: () => 60, onReadEnd });
    service.attach({ id: 'codex', generation: 1, provider, descriptor, installation });
    return { service, onReadEnd };
  }

  it.each([
    ['an account and usage', { kind: 'account', account }, { kind: 'usage', usage: usage(1) }, 'account'],
    ['an account and no usage interface', { kind: 'account', account }, { kind: 'not-applicable', reason: 'unsupported-cli-version' }, 'account'],
    ['an account and no allocations', { kind: 'account', account }, { kind: 'not-applicable', reason: 'usage-unavailable' }, 'account'],
    ['an account and a usage error', { kind: 'account', account }, { kind: 'error', reason: 'temporarily-unavailable' }, 'account'],
    ['an account the usage read shows is an API key', { kind: 'account', account }, { kind: 'not-applicable', reason: 'api-key' }, 'api-key'],
    ['an account the usage read shows is a cloud provider', { kind: 'account', account }, { kind: 'not-applicable', reason: 'cloud-provider' }, 'cloud-provider'],
    ['a signed-out CLI', { kind: 'not-logged-in' }, undefined, 'signed-out'],
    ['an API key', { kind: 'not-applicable', reason: 'api-key' }, undefined, 'api-key'],
    ['a cloud provider', { kind: 'not-applicable', reason: 'cloud-provider' }, undefined, 'cloud-provider'],
    ['an account read the CLI does not support', { kind: 'not-applicable', reason: 'unsupported-cli-version' }, undefined, 'other'],
    ['an account read that failed', { kind: 'error', reason: 'temporarily-unavailable' }, undefined, 'other'],
  ] as const)('says a read with %s ended as %s', async (_name, accountResult, usageResult, outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fake = fakeProvider({ account: vi.fn(async () => accountResult), usage: vi.fn(async () => usageResult ?? { kind: 'empty' } as const) });
    const { service, onReadEnd } = hooked(fake.provider);
    await settle();
    expect(onReadEnd).toHaveBeenCalledExactlyOnceWith(first('codex'), { byRefresh: false, outcome, startedAt: START });
    service.stop();
  });

  it('marks the read a Refresh asked for, and only that one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const { service, onReadEnd } = hooked(fakeProvider().provider);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000); // a poll
    vi.setSystemTime(START + 120_000);
    expect(service.refresh(first('codex'))).toEqual({ status: 'accepted' });
    await settle();
    await vi.advanceTimersByTimeAsync(60_000); // the poll after it
    expect(onReadEnd.mock.calls.map(([, end]) => end.byRefresh)).toEqual([false, false, true, false]);
    service.stop();
  });

  it('marks a read a Refresh joined, adds no read for it, and drops the mark with a detach (M13, C97)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const finishes: (() => void)[] = [];
    const fake = fakeProvider({ account: vi.fn(() => new Promise<{ kind: 'not-logged-in' }>((resolve) => { finishes.push(() => resolve({ kind: 'not-logged-in' })); })) });
    const { service, onReadEnd } = hooked(fake.provider);
    await settle();
    // Two Refreshes while the first read is under way: both join it.
    expect(service.refresh(first('codex'))).toEqual({ status: 'accepted' });
    expect(service.refresh(first('codex'))).toEqual({ status: 'accepted' });
    finishes.shift()?.();
    await settle();
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(1);
    expect(onReadEnd.mock.calls.map(([, end]) => end.byRefresh)).toEqual([true]);
    // A Refresh starts a read at once, a second joins it, and a detach takes the mark away.
    expect(service.refresh(first('codex'))).toEqual({ status: 'accepted' });
    expect(service.refresh(first('codex'))).toEqual({ status: 'accepted' });
    service.detach(first('codex'));
    service.attach({ id: 'codex', generation: 2, provider: fake.provider, descriptor, installation });
    for (const finish of finishes.splice(0)) finish();
    await settle();
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(3);
    expect(onReadEnd.mock.calls.map(([, end]) => end.byRefresh)).toEqual([true, false]);
    service.stop();
  });

  it('says nothing of a read its runtime no longer owns', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    let finish!: () => void;
    const fake = fakeProvider({ account: vi.fn(() => new Promise<{ kind: 'not-logged-in' }>((resolve) => { finish = () => resolve({ kind: 'not-logged-in' }); })) });
    const { service, onReadEnd } = hooked(fake.provider);
    await settle();
    service.detach(first('codex'));
    finish();
    await settle();
    expect(onReadEnd).not.toHaveBeenCalled();
    service.stop();
  });

  it('keeps the poll going when the hook throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const store = createAppStateStore();
    store.updateProviders(() => [sampleProvider({ id: 'codex', displayName: 'Codex', descriptor, installation })]);
    const service = createUsageService({ store, pollIntervalSec: () => 60, onReadEnd: () => { throw new Error('catalog'); } });
    const fake = fakeProvider();
    service.attach({ id: 'codex', generation: 1, provider: fake.provider, descriptor, installation });
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(2);
    service.stop();
  });

  it('ignores a models event, which is the catalog’s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fake = fakeProvider();
    const { service } = hooked(fake.provider);
    await settle();
    expect(() => fake.emit({ type: 'models', report: { models: [], speedTierReason: null, dropped: 0 } })).not.toThrow();
    service.stop();
  });
});

// V44 (M13, C97): with the default five-minute poll interval. Enabled again soon after being disabled,
// a provider showed "Detecting CLI" for up to five minutes before round 2; it now reads at once, and
// since round 4 so does a Refresh. The provider's own triggers, a reconnect or an account change, wait
// for the one-minute floor.
describe('the first read of a new runtime and a Refresh at once, and the floor for the provider’s own triggers', () => {
  const POLL = 300;
  function polled() {
    const store = createAppStateStore();
    store.updateProviders(() => [sampleProvider({ id: 'codex', displayName: 'Codex', descriptor, installation, status: { kind: 'detecting' }, account: null, usage: null, asOf: null })]);
    const service = createUsageService({ store, pollIntervalSec: () => POLL });
    return { store, service };
  }

  it('reads a provider attached again within the poll interval at once, and then keeps the interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fake = fakeProvider();
    const { store, service } = polled();
    service.attach({ id: 'codex', generation: 1, provider: fake.provider, descriptor, installation });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    service.detach(first('codex')); // disabled
    service.attach({ id: 'codex', generation: 2, provider: fake.provider, descriptor, installation }); // enabled again
    await settle();
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().providers[0]).toMatchObject({ status: { kind: 'ok' }, asOf: START + 5000, nextRefreshAt: START + 5000 + POLL * 1000 });
    service.stop();
  });

  it('reads a Refresh at once, holds the provider’s own triggers to the floor, and keeps the interval for the poll (C97)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const fake = fakeProvider();
    const { store, service } = polled();
    service.attach({ id: 'codex', generation: 1, provider: fake.provider, descriptor, installation });
    await settle();
    expect(store.getSnapshot().providers[0]?.nextRefreshAt).toBe(START + POLL * 1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.refresh(first('codex'))).toEqual({ status: 'accepted' });
    await settle();
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().providers[0]?.nextRefreshAt).toBe(START + 10_000 + POLL * 1000);
    // A reconnect ten seconds later waits for the floor since that Refresh began.
    await vi.advanceTimersByTimeAsync(10_000);
    fake.emit({ type: 'connection', state: 'ready' });
    expect(store.getSnapshot().providers[0]?.nextRefreshAt).toBe(START + 70_000);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.provider.getAccount).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().providers[0]?.nextRefreshAt).toBe(START + 70_000 + POLL * 1000);
    service.stop();
  });

  it('keeps a provider’s own longer floor for its own triggers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const slow = { ...descriptor, minPollIntervalSec: 120 };
    const fake = fakeProvider();
    const { store, service } = polled();
    service.attach({ id: 'codex', generation: 1, provider: fake.provider, descriptor: slow, installation });
    await settle();
    fake.emit({ type: 'connection', state: 'ready' });
    expect(store.getSnapshot().providers[0]?.nextRefreshAt).toBe(START + 120_000);
    service.stop();
  });
});

// M14b, V4 (C7): one job per instance. Two accounts of one provider each have their own readings,
// their own schedule and their own floor.
describe('one job per instance (M14b, C7)', () => {
  const ADDED = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
  const added = { providerId: 'codex', instanceId: ADDED };
  const POLL = 300;
  function two() {
    const store = createAppStateStore();
    const blank = { id: 'codex', displayName: 'Codex', descriptor, installation, status: { kind: 'detecting' }, account: null, usage: null, asOf: null } as const;
    store.updateProviders(() => [sampleProvider(blank), sampleProvider({ ...blank, instanceId: ADDED, label: 'Work' })]);
    const onReadEnd = vi.fn<(ref: { providerId: string; instanceId: string }, end: UsageReadEnd) => void>();
    const service = createUsageService({ store, pollIntervalSec: () => POLL, onReadEnd });
    const personal = fakeProvider({ usage: vi.fn(async () => ({ kind: 'usage', usage: usage(20) } as const)) });
    const work = fakeProvider({
      account: vi.fn(async () => ({ kind: 'account', account: { authKind: 'subscription', plan: 'plus', email: 'work@example.test' } } as const)),
      usage: vi.fn(async () => ({ kind: 'usage', usage: usage(75) } as const)),
    });
    service.attach({ id: 'codex', generation: 1, provider: personal.provider, descriptor, installation });
    service.attach({ id: 'codex', instanceId: ADDED, generation: 1, provider: work.provider, descriptor, installation });
    const snapshot = (instanceId: string) => store.getSnapshot().providers.find((provider) => provider.instanceId === instanceId);
    return { store, service, personal, work, onReadEnd, snapshot };
  }

  it('reads each instance at once when it starts, into its own snapshot, and says which read ended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const h = two();
    await settle();
    expect(h.snapshot('default')).toMatchObject({ status: { kind: 'ok' }, account: { email: 'person@example.test', plan: 'pro' }, label: 'Default' });
    expect(h.snapshot('default')?.usage?.windows[0]?.usedPercent).toBe(20);
    expect(h.snapshot(ADDED)).toMatchObject({ status: { kind: 'ok' }, account: { email: 'work@example.test', plan: 'plus' }, label: 'Work' });
    expect(h.snapshot(ADDED)?.usage?.windows[0]?.usedPercent).toBe(75);
    expect(h.onReadEnd.mock.calls.map(([ref]) => ref)).toEqual([first('codex'), added]);
    h.service.stop();
  });

  it('holds each instance to its own floor: a Refresh of one neither reads nor delays the other', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const h = two();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    // A Refresh of the added account, at once.
    expect(h.service.refresh(added)).toEqual({ status: 'accepted' });
    await settle();
    expect(h.work.provider.getAccount).toHaveBeenCalledTimes(2);
    expect(h.personal.provider.getAccount).toHaveBeenCalledTimes(1);
    expect(h.snapshot('default')?.nextRefreshAt).toBe(START + POLL * 1000);
    expect(h.snapshot(ADDED)?.nextRefreshAt).toBe(START + 10_000 + POLL * 1000);

    // Each provider's own trigger waits for the floor since its own last start.
    await vi.advanceTimersByTimeAsync(10_000);
    h.personal.emit({ type: 'connection', state: 'ready' });
    h.work.emit({ type: 'connection', state: 'ready' });
    expect(h.snapshot('default')?.nextRefreshAt).toBe(START + 60_000);
    expect(h.snapshot(ADDED)?.nextRefreshAt).toBe(START + 70_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.personal.provider.getAccount).toHaveBeenCalledTimes(2);
    expect(h.work.provider.getAccount).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.work.provider.getAccount).toHaveBeenCalledTimes(3);
    h.service.stop();
  });

  it('revalidates every attached account on wake and leaves detached accounts alone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const h = two();
    await settle();
    h.service.suspend();
    vi.setSystemTime(START + 3_600_000);
    h.service.resume();
    await settle();
    expect(h.personal.provider.getAccount).toHaveBeenCalledTimes(2);
    expect(h.work.provider.getAccount).toHaveBeenCalledTimes(2);
    h.service.detach(added);
    vi.setSystemTime(START + 7_200_000);
    h.service.resume();
    await settle();
    expect(h.personal.provider.getAccount).toHaveBeenCalledTimes(3);
    expect(h.work.provider.getAccount).toHaveBeenCalledTimes(2);
    h.service.stop();
  });

  it('detaches one instance and leaves the other reading; a pushed reading goes to its own snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const h = two();
    await settle();
    h.service.detach(added);
    h.work.emit({ type: 'usage', usage: usage(99) });
    h.personal.emit({ type: 'usage', usage: usage(33) });
    expect(h.snapshot(ADDED)?.usage?.windows[0]?.usedPercent).toBe(75);
    expect(h.snapshot('default')?.usage?.windows[0]?.usedPercent).toBe(33);
    expect(h.service.refresh(added)).toEqual({ status: 'refused', reason: 'not-ready' });
    expect(h.service.refresh(first('codex'))).toEqual({ status: 'accepted' });
    h.service.stop();
  });

  it('forgets a removed instance: its job goes, and a later start of the same id reads at once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const h = two();
    await settle();
    h.service.forget(added);
    expect(h.service.refresh(added)).toEqual({ status: 'refused', reason: 'not-ready' });
    await vi.advanceTimersByTimeAsync(POLL * 1000);
    expect(h.work.provider.getAccount).toHaveBeenCalledTimes(1);
    expect(h.personal.provider.getAccount).toHaveBeenCalledTimes(2);
    h.service.attach({ id: 'codex', instanceId: ADDED, generation: 2, provider: h.work.provider, descriptor, installation });
    await settle();
    expect(h.work.provider.getAccount).toHaveBeenCalledTimes(2);
    h.service.stop();
  });
});
