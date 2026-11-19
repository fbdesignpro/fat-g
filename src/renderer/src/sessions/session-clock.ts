// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The session clock (docs/planning/_archive/M14.md, C51): one interval for the whole page, started by the first
// thing that shows a running time and stopped with the last. Main pushes each timestamp once (C24);
// every elapsed time on screen is derived here, so nothing is pushed per second.
//
// `useClock` (ui/useClock.ts) starts an interval per component and stays the usage panel's alone.
import { useSyncExternalStore } from 'react';
import { formatElapsed } from '@shared/contracts/sessions';

const TICK_MS = 1000;
const listeners = new Set<() => void>();
let timer: number | null = null;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const each of listeners) each();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

const never = (): (() => void) => () => undefined;
const read = (): number => now;

/**
 * The time now, a second at a time, for as long as `running` holds. A component that shows no
 * running time passes false, subscribes to nothing, and keeps no interval alive.
 */
export function useSessionClock(running: boolean): number {
  return useSyncExternalStore(running ? subscribe : never, read);
}

/** How long ago `since` was, as a capsule or a worker row shows it; null when there is nothing to time. */
export function useElapsed(since: number | null, wait?: { readonly ms: number; readonly since: number | null }): string | null {
  const at = useSessionClock(since !== null && wait?.since == null);
  return since === null ? null : formatElapsed(Math.max(0, (wait?.since ?? at) - since - (wait?.ms ?? 0)));
}

const COARSE_MS = 30_000;
const coarseListeners = new Set<() => void>();
let coarseTimer: number | null = null;
let coarseNow = Date.now();

function subscribeCoarse(listener: () => void): () => void {
  coarseListeners.add(listener);
  if (coarseTimer === null) {
    coarseNow = Date.now();
    coarseTimer = window.setInterval(() => {
      coarseNow = Date.now();
      for (const each of coarseListeners) each();
    }, COARSE_MS);
  }
  return () => {
    coarseListeners.delete(listener);
    if (coarseListeners.size === 0 && coarseTimer !== null) {
      window.clearInterval(coarseTimer);
      coarseTimer = null;
    }
  };
}

const readCoarse = (): number => coarseNow;

/**
 * The time now, half a minute at a time: for what says how long ago something was in minutes — an
 * answer's foot (the maintainer) — of which a list may hold hundreds. One interval for
 * the page, as the session clock's, while anything shows such a time.
 */
export function useCoarseClock(): number {
  return useSyncExternalStore(subscribeCoarse, readCoarse);
}

/** How many things are showing a running time right now, and whether the interval runs. For tests. */
export function sessionClockState(): { readonly subscribers: number; readonly ticking: boolean } {
  return { subscribers: listeners.size, ticking: timer !== null };
}
