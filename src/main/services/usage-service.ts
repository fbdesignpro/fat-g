// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AccountInfo } from '@shared/contracts/account';
import { FIRST_INSTANCE_ID, type InstanceId, type InstanceRef } from '@shared/contracts/instances';
import type { ProviderActionResult, ProviderDescriptor, ProviderInstallation } from '@shared/contracts/provider';
import type { ProviderSnapshot, ProviderStatus } from '@shared/contracts/status';
import type { AgentProvider, ProviderErrorReason, ProviderEvent } from '@shared/provider-kit/provider';
import { POLL_INTERVAL_SEC } from '@shared/contracts/prefs';
import type { AppStateStore } from '../state/app-state-store';

const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * The wake's recovery window (decision 0001's wake amendment). A machine that has just woken
 * answers before its network does: the CLI then reports no allocations, or nothing at all, and
 * neither is the account's word. For this long after a wake, such an answer leaves the readings on
 * screen, marked `waking`, and the next read comes on this cadence — under the 60 s floor, which
 * spaces the reads that trust their answer — before falling back to the floor itself. When the
 * window closes, the answer stands as it would have without a wake.
 */
const WAKE_WINDOW_MS = 5 * 60_000;
const WAKE_RETRY_MS: readonly number[] = [10_000, 20_000, 40_000];

/** One instance's runtime (M14b, C7): `id` is its provider's, and the pair names the job and the snapshot. */
export interface UsageAttachment {
  readonly id: string;
  /** The provider's first instance when none is named. */
  readonly instanceId?: InstanceId;
  readonly generation: number;
  readonly provider: AgentProvider;
  readonly descriptor: ProviderDescriptor;
  readonly installation: ProviderInstallation;
}

/**
 * How a read ended, for the catalog (M13, C73): with an account (the usage-only answers included), or
 * without one because the CLI is signed out or on an API key or a cloud provider; 'other' is a
 * failure, or an answer that says neither.
 */
export type UsageReadOutcome = 'account' | 'signed-out' | 'api-key' | 'cloud-provider' | 'other';

export interface UsageReadEnd {
  /** The user's Refresh asked for this read (C92). */
  readonly byRefresh: boolean;
  readonly outcome: UsageReadOutcome;
  /** When the read began: a model report that arrived since came with it (C92). */
  readonly startedAt: number;
}

export interface UsageServiceOptions {
  readonly store: AppStateStore;
  readonly pollIntervalSec: () => number;
  readonly now?: () => number;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
  /** Explicit test/smoke policy. Production uses the fixed one-minute floor. */
  readonly minimumPollIntervalSec?: number;
  /** After each read that ran to its end in the runtime that started it (the catalog's re-read, M13). */
  readonly onReadEnd?: (ref: InstanceRef, end: UsageReadEnd) => void;
}

export interface UsageService {
  attach(attachment: UsageAttachment): void;
  detach(ref: InstanceRef): void;
  /** Detaches, and forgets the instance: it was removed (M14b, C23). */
  forget(ref: InstanceRef): void;
  refresh(ref: InstanceRef): ProviderActionResult;
  preferencesChanged(): void;
  suspend(): void;
  /** Revalidates on wake or unlock, even without a preceding suspend event. */
  resume(): void;
  stop(): void;
}

interface Job {
  /** The provider's id and the instance's: each instance has its own last start, so the floors hold per instance. */
  readonly ref: InstanceRef;
  runtime?: UsageAttachment;
  epoch: number;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  staleTimer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  inFlight: boolean;
  pending: boolean;
  /** A Refresh asked for this read: taken by the read it starts, or by the one it joined when it ends. */
  byRefresh: boolean;
  failures: number;
  /**
   * The wake's recovery window, while one is open: when it ends, and how many reads it has already
   * asked for — the count picks the next delay, and says the floor no longer holds (its first read
   * still waits for it, so an unlock never reads twice in a minute).
   */
  wake: { readonly until: number; tries: number } | null;
  lastStart: number | null;
  lastCompletion: number | null;
}

function sameAccount(a: AccountInfo, b: AccountInfo): boolean {
  return a.authKind === b.authKind && a.plan === b.plan && a.email === b.email && a.organization === b.organization;
}

export function createUsageService(options: UsageServiceOptions): UsageService {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const jobs = new Map<string, Job>();
  let suspended = false;
  let stopped = false;

  const keyOf = (ref: InstanceRef): string => `${ref.providerId}\u0000${ref.instanceId}`;

  function jobFor(ref: InstanceRef): Job {
    let job = jobs.get(keyOf(ref));
    if (job === undefined) {
      job = { ref: { providerId: ref.providerId, instanceId: ref.instanceId }, epoch: 0, inFlight: false, pending: false, byRefresh: false, failures: 0, wake: null, lastStart: null, lastCompletion: null };
      jobs.set(keyOf(ref), job);
    }
    return job;
  }

  /** The regular schedule: the user's poll interval, never below the floor. */
  function interval(job: Job): number {
    return Math.max(floor(job), options.pollIntervalSec() * 1000);
  }

  /**
   * The least time between two reads' starts (decision 0001: the CLI caches usage for about a minute).
   * A read the provider asks for — a reconnect, an account change — waits for this and no longer; the
   * user's poll interval only spaces the regular schedule. The user is not held by it: a new runtime's
   * first read and a Refresh run at once (M13, C97).
   */
  function floor(job: Job): number {
    return Math.max(options.minimumPollIntervalSec ?? POLL_INTERVAL_SEC.min, job.runtime?.descriptor.minPollIntervalSec ?? 0) * 1000;
  }

  function retryDelay(job: Job): number {
    const base = interval(job);
    const cap = Math.max(base, MAX_BACKOFF_MS);
    return Math.min(cap, base * 2 ** Math.min(Math.max(0, job.failures - 1), 20));
  }

  function snapshotOf(job: Job): ProviderSnapshot | undefined {
    return options.store.getSnapshot().providers.find((value) => value.id === job.ref.providerId && value.instanceId === job.ref.instanceId);
  }

  /** Whether a wake's recovery window is open for this job. */
  function inWakeWindow(job: Job): boolean {
    return job.wake !== null && now() < job.wake.until;
  }

  /**
   * The grace is for the readings on screen: it holds while they are still that same account's. An
   * account that has changed settles at once — those readings were someone else's.
   */
  function wakeHolds(job: Job, fresh: AccountInfo): boolean {
    if (!inWakeWindow(job)) return false;
    const value = snapshotOf(job);
    return value !== undefined && value.account !== null && sameAccount(value.account, fresh);
  }

  /** The window's own spacing, counted from the read that just ended; after its list, the floor. */
  function wakeDelay(job: Job, wake: { readonly until: number; tries: number }): number {
    const delay = WAKE_RETRY_MS[wake.tries] ?? floor(job);
    wake.tries += 1;
    return delay;
  }

  function clearSchedule(job: Job): void {
    if (job.timer !== undefined) clearTimer(job.timer);
    if (job.staleTimer !== undefined) clearTimer(job.staleTimer);
    job.timer = undefined;
    job.staleTimer = undefined;
  }

  function publish(ref: InstanceRef, recipe: (current: ProviderSnapshot) => ProviderSnapshot): void {
    options.store.updateProviders((providers) => {
      let changed = false;
      const next = providers.map((provider) => {
        if (provider.id !== ref.providerId || provider.instanceId !== ref.instanceId) return provider;
        const value = recipe(provider);
        changed ||= value !== provider;
        return value;
      });
      return changed ? next : providers;
    });
  }

  function schedule(job: Job, dueAt: number): void {
    if (stopped || suspended || job.runtime === undefined) return;
    if (job.timer !== undefined) clearTimer(job.timer);
    const epoch = job.epoch;
    const delay = Math.max(0, dueAt - now());
    job.timer = setTimer(() => {
      job.timer = undefined;
      if (job.epoch === epoch) void begin(job);
    }, delay);
    publish(job.ref, (current) => ({ ...current, nextRefreshAt: dueAt }));
  }

  function scheduleStale(job: Job, asOf: number): void {
    if (job.staleTimer !== undefined) clearTimer(job.staleTimer);
    const epoch = job.epoch;
    const dueAt = asOf + interval(job) * 2;
    job.staleTimer = setTimer(() => {
      job.staleTimer = undefined;
      if (job.epoch !== epoch || job.runtime === undefined || suspended || stopped) return;
      publish(job.ref, (current) => current.usage === null || current.asOf !== asOf || current.status.kind === 'waking' ? current : { ...current, status: { kind: 'stale' } });
    }, Math.max(0, dueAt - now()));
  }

  /**
   * Who may read without waiting out the floor, beside a runtime's first read: the user's Refresh
   * (M13, C97), and a wake's recovery once one read has come back unsettled — that answer was the
   * network's, not the CLI's cache, so the next one need not wait a minute for it. The window's
   * first read does wait, so an unlock never reads twice within a minute.
   */
  function unfloored(job: Job, byRefresh: boolean): boolean {
    return byRefresh || (job.wake !== null && job.wake.tries > 0 && inWakeWindow(job));
  }

  function request(job: Job, byRefresh = false): ProviderActionResult {
    if (stopped || suspended || job.runtime === undefined) return { status: 'refused', reason: 'not-ready' };
    // Recorded before the read starts: `begin` below takes it at once, or the read under way at its end.
    if (byRefresh) job.byRefresh = true;
    if (job.inFlight) {
      // A Refresh joins the read under way, whose answer is fresh enough (C97); the provider's own
      // triggers ask for one more after it.
      if (byRefresh) return { status: 'accepted' };
      job.pending = true;
      return { status: 'deferred' };
    }
    const earliest = unfloored(job, byRefresh) || job.lastStart === null ? now() : job.lastStart + floor(job);
    if (now() < earliest) {
      job.pending = true;
      schedule(job, earliest);
      return { status: 'deferred' };
    }
    void begin(job);
    return { status: 'accepted' };
  }

  async function begin(job: Job): Promise<void> {
    const runtime = job.runtime;
    if (runtime === undefined || stopped || suspended || job.inFlight) return;
    const earliest = unfloored(job, job.byRefresh) || job.lastStart === null ? now() : job.lastStart + floor(job);
    if (now() < earliest) {
      schedule(job, earliest);
      return;
    }
    if (job.timer !== undefined) clearTimer(job.timer);
    job.timer = undefined;
    job.pending = false;
    const byRefresh = job.byRefresh;
    job.byRefresh = false;
    job.inFlight = true;
    const startedAt = now();
    job.lastStart = startedAt;
    const epoch = job.epoch;
    const controller = new AbortController();
    job.controller = controller;
    const waking = inWakeWindow(job);
    publish(job.ref, (current) => ({
      ...current,
      refreshing: true,
      nextRefreshAt: null,
      // From the wake's first read, not once it comes back empty: the readings it holds are from
      // before the sleep, and nothing else in the block says so.
      ...(waking && (current.usage?.windows.length ?? 0) > 0 ? { status: { kind: 'waking' } as const } : {}),
    }));

    let completed = false;
    let outcome: UsageReadOutcome = 'other';
    // The read left the usage unsettled — no allocations, or no answer. Inside the window it keeps
    // the window open and the readings on screen; outside it, it is the account's word.
    let unresolved = false;
    const failed = (message: string, graced = inWakeWindow(job)): void => {
      unresolved = true;
      fail(job, message, graced);
    };
    try {
      const account = await runtime.provider.getAccount(controller.signal);
      if (!current(job, runtime, epoch)) return;
      switch (account.kind) {
        case 'account': {
          outcome = 'account';
          const usage = await runtime.provider.getUsage(controller.signal);
          if (!current(job, runtime, epoch)) return;
          if (usage.kind === 'usage') {
            const at = now();
            completed = true;
            job.failures = 0;
            publish(job.ref, (value) => ({
              ...value,
              status: { kind: 'ok' },
              account: account.account,
              usage: usage.usage,
              asOf: at,
            }));
            scheduleStale(job, at);
          } else if (usage.kind === 'not-applicable') {
            job.failures = 0;
            const status: ProviderStatus = { kind: 'not-applicable', reason: usage.reason };
            if (usage.reason === 'api-key' || usage.reason === 'cloud-provider') outcome = usage.reason;
            // "No allocations" from a CLI whose network may not be back yet is no answer at all
            // (0001's wake amendment): the account's identity is taken, the readings stay.
            if (usage.reason === 'usage-unavailable' && wakeHolds(job, account.account)) {
              unresolved = true;
              publish(job.ref, (value) => ({ ...value, status: { kind: 'waking' }, account: account.account }));
              break;
            }
            completed = true;
            // An API-key or cloud answer contradicts the account just validated, so it goes. A CLI
            // without the usage interface, or one reporting no allocations, leaves an account-only
            // panel: identity and plan stay, readings and freshness do not.
            publish(job.ref, (value) => usage.reason === 'api-key' || usage.reason === 'cloud-provider'
              ? cleared(value, status)
              : { ...value, status, account: account.account, usage: null, asOf: null });
          } else {
            // The account was validated this poll; earlier readings survive only for that account.
            publish(job.ref, (value) => value.account !== null && sameAccount(value.account, account.account)
              ? { ...value, account: account.account }
              : { ...value, account: account.account, usage: null, asOf: null });
            failed(usage.kind === 'empty' ? 'Usage data is not available yet.' : errorMessage(usage.reason), wakeHolds(job, account.account));
          }
          break;
        }
        case 'not-logged-in':
          outcome = 'signed-out';
          completed = true;
          job.failures = 0;
          publish(job.ref, (value) => cleared(value, { kind: 'not-logged-in' }));
          break;
        case 'not-applicable':
          if (account.reason === 'api-key' || account.reason === 'cloud-provider') outcome = account.reason;
          completed = true;
          job.failures = 0;
          publish(job.ref, (value) => cleared(value, { kind: 'not-applicable', reason: account.reason }));
          break;
        case 'error':
          failed(errorMessage(account.reason));
          break;
      }
    } catch {
      if (current(job, runtime, epoch)) failed('Usage is temporarily unavailable.');
    } finally {
      if (current(job, runtime, epoch)) {
        job.inFlight = false;
        job.controller = undefined;
        job.lastCompletion = now();
        publish(job.ref, (value) => ({ ...value, refreshing: false }));
        // A Refresh that joined this read makes it a Refresh's read.
        const refreshed = byRefresh || job.byRefresh;
        job.byRefresh = false;
        // An answer that settled the usage closes the window, as does its end: then this read's
        // answer stands, and the schedule is the one it would have had without a wake.
        if (!unresolved || !inWakeWindow(job)) job.wake = null;
        const regularDue = now() + (job.wake !== null ? wakeDelay(job, job.wake) : completed ? interval(job) : retryDelay(job));
        if (job.pending) {
          const earliestPending = (job.lastStart ?? now()) + floor(job);
          schedule(job, Math.max(now(), earliestPending));
        } else {
          schedule(job, regularDue);
        }
        try { options.onReadEnd?.(job.ref, { byRefresh: refreshed, outcome, startedAt }); } catch { /* isolate the catalog from the poll */ }
      }
    }
  }

  /**
   * A read that did not settle the usage. Inside a wake's recovery window it is not the account's
   * word yet: the readings stay as they are under `waking`, the failure is not counted — the
   * window's own cadence spaces the next read — and only the window's close lets it stand.
   */
  function fail(job: Job, message: string, graced: boolean): void {
    if (graced) {
      publish(job.ref, (value) => ({ ...value, status: { kind: 'waking' } }));
      return;
    }
    job.failures += 1;
    publish(job.ref, (value) => {
      const stale = value.usage !== null && value.asOf !== null && now() - value.asOf >= interval(job) * 2;
      return { ...value, status: stale ? { kind: 'stale' } : { kind: 'error', message } };
    });
  }

  function cleared(value: ProviderSnapshot, status: ProviderStatus): ProviderSnapshot {
    return { ...value, status, account: null, usage: null, asOf: null };
  }

  function errorMessage(reason: ProviderErrorReason): string {
    switch (reason) {
      case 'temporarily-unavailable': return 'Usage is temporarily unavailable.';
      case 'unsupported-data': return 'This CLI returned data fat-g does not understand.';
      // Distinct on purpose: retries launch nothing until a reconnect proves the old child gone.
      case 'cleanup-failed': return 'The CLI process cleanup could not be confirmed. Reconnect to check again; restart fat-g if it stays blocked.';
    }
  }

  function current(job: Job, runtime: UsageAttachment, epoch: number): boolean {
    return !stopped && !suspended && job.runtime === runtime && job.epoch === epoch;
  }

  function onEvent(job: Job, runtime: UsageAttachment, event: ProviderEvent): void {
    if (!current(job, runtime, job.epoch)) return;
    switch (event.type) {
      case 'usage':
        publish(job.ref, (value) => value.account?.authKind !== 'subscription' ? value : { ...value, usage: event.usage });
        break;
      case 'invalidate':
        publish(job.ref, (value) => ({ ...value, status: { kind: 'detecting' }, account: null, usage: null, asOf: null }));
        request(job);
        break;
      case 'connection':
        if (event.state === 'disconnected') {
          publish(job.ref, (value) => ({ ...value, status: { kind: 'error', message: 'The CLI connection was interrupted; reconnecting.' } }));
        } else {
          request(job);
        }
        break;
      case 'models':
        // The catalog's (src/main/services/catalog-service.ts), which subscribes on its own.
        break;
    }
  }

  function cancelRead(job: Job): void {
    job.epoch += 1;
    job.controller?.abort();
    job.controller = undefined;
    job.inFlight = false;
    job.pending = false;
    job.byRefresh = false;
    job.wake = null;
    clearSchedule(job);
    publish(job.ref, (value) => ({ ...value, refreshing: false, nextRefreshAt: null }));
  }

  function detach(job: Job): void {
    job.epoch += 1;
    job.controller?.abort();
    job.controller = undefined;
    job.unsubscribe?.();
    job.unsubscribe = undefined;
    job.runtime = undefined;
    job.inFlight = false;
    job.pending = false;
    job.byRefresh = false;
    job.failures = 0;
    job.wake = null;
    clearSchedule(job);
    publish(job.ref, (value) => value.refreshing || value.nextRefreshAt !== null
      ? { ...value, refreshing: false, nextRefreshAt: null }
      : value);
  }

  return {
    attach(runtime) {
      if (stopped) return;
      const job = jobFor({ providerId: runtime.id, instanceId: runtime.instanceId ?? FIRST_INSTANCE_ID });
      detach(job);
      // At start, when enabled, on Redetect or a changed executable: know where it stands at once
      // (C97). A late result of the runtime before is still dropped: the epoch moved on.
      job.lastStart = null;
      job.runtime = runtime;
      job.unsubscribe = runtime.provider.subscribe?.((event) => {
        if (job.runtime === runtime) onEvent(job, runtime, event);
      });
      request(job);
    },
    detach(ref) {
      const job = jobs.get(keyOf(ref));
      if (job !== undefined) detach(job);
    },
    forget(ref) {
      const job = jobs.get(keyOf(ref));
      if (job === undefined) return;
      detach(job);
      jobs.delete(keyOf(ref));
    },
    refresh(ref) {
      const job = jobs.get(keyOf(ref));
      return job === undefined ? { status: 'refused', reason: 'not-ready' } : request(job, true);
    },
    preferencesChanged() {
      for (const job of jobs.values()) {
        if (job.runtime === undefined || job.inFlight || suspended || stopped) continue;
        // A wake's recovery owns its timer: a changed poll interval waits for the window to close.
        if (inWakeWindow(job)) continue;
        const base = job.lastCompletion ?? job.lastStart ?? now();
        const delay = job.failures === 0 ? interval(job) : retryDelay(job);
        const due = Math.max(base + delay, (job.lastStart ?? 0) + interval(job));
        schedule(job, due <= now() ? now() : due);
        const snapshot = snapshotOf(job);
        if (snapshot?.asOf !== null && snapshot?.asOf !== undefined) scheduleStale(job, snapshot.asOf);
      }
    },
    suspend() {
      if (suspended || stopped) return;
      suspended = true;
      for (const job of jobs.values()) cancelRead(job);
    },
    resume() {
      if (stopped) return;
      const wasSuspended = suspended;
      suspended = false;
      for (const job of jobs.values()) {
        if (job.runtime === undefined) continue;
        // Without suspend, a pre-sleep read may still be pending. Its deadline is much shorter
        // than the poll floor: abandon it before accepting another answer after a long sleep.
        if (job.inFlight && job.lastStart !== null && now() >= job.lastStart + floor(job)) cancelRead(job);
        // Sleep paused the freshness timer too. Restore it against wall time, so old readings
        // become historical even when the wake read is slow or the network is still returning.
        const snapshot = snapshotOf(job);
        if (snapshot?.asOf !== null && snapshot?.asOf !== undefined) scheduleStale(job, snapshot.asOf);
        // Resume and unlock commonly arrive together. Join an active read, and leave a recent
        // successful read alone; neither event should queue another poll behind that read.
        if (job.inFlight || (!wasSuspended && job.failures === 0 && job.lastCompletion !== null && job.lastStart !== null && now() < job.lastStart + floor(job))) continue;
        job.failures = 0;
        // One window per wake: a second notification just after the first does not extend it.
        if (!inWakeWindow(job)) job.wake = { until: now() + WAKE_WINDOW_MS, tries: 0 };
        request(job);
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const job of jobs.values()) detach(job);
    },
  };
}
