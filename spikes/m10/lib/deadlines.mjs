// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M10 spike helpers: every wait on a CLI has a deadline, and the values sit here (C59).
// Plain Node. Not application code: the app's own deadlines live in src/main/providers.

/** The four waits of C59. Self-tests pass shorter values through `deadlines(overrides)`. */
export const DEADLINES = Object.freeze({
  /** Spawn to handshake complete. */
  startup: 30_000,
  /** Every other request and its reply. */
  request: 15_000,
  /** First prompt to the last frame the success condition needs. */
  scenario: 240_000,
  /** Stdin closed to tree confirmed gone. */
  shutdown: 20_000,
});

/** Teardown steps inside the shutdown wait (Design 1). */
export const TEARDOWN = Object.freeze({ interruptGrace: 2_000, stdinGrace: 3_000 });

/** A process listing that takes longer than this counts as "cannot confirm" (risk 7). */
export const LISTING_TIMEOUT = 10_000;

/**
 * One invocation is one run. The budget ends it through the same path as Ctrl+C, well inside the
 * 10-minute limit of an agent's shell tool, so the spike always finishes its own cleanup.
 */
export const INVOCATION_BUDGET = 480_000;

export const EXIT = Object.freeze({
  happened: 0,
  error: 1,
  cliMissing: 2,
  cleanupUnconfirmed: 3,
  recordedRunning: 4,
  runCap: 5,
  didNotHappen: 10,
  timedOut: 11,
  notRun: 12,
  void: 13,
  cancelled: 130,
});

export function deadlines(overrides = {}) {
  const merged = { ...DEADLINES, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (!(name in DEADLINES) || !Number.isInteger(value) || value <= 0) throw new Error(`bad deadline ${name}`);
  }
  return Object.freeze(merged);
}

/** A wait that expired. `wait` is one of the four names above. */
export class DeadlineExpired extends Error {
  constructor(wait, ms) {
    super(`the ${wait} wait expired after ${ms} ms`);
    this.name = 'DeadlineExpired';
    this.wait = wait;
    this.ms = ms;
  }
}

/** The run was cancelled (Ctrl+C or the invocation budget). */
export class Cancelled extends Error {
  constructor(reason) {
    super(`cancelled: ${reason}`);
    this.name = 'Cancelled';
    this.reason = reason;
  }
}

/**
 * Races `promise` against the named wait and an optional cancellation signal. Leaves no timer or
 * listener behind, whichever settles first.
 */
export function within(promise, wait, ms, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, new Cancelled(signal.reason ?? 'aborted'));
    const timer = setTimeout(() => finish(reject, new DeadlineExpired(wait, ms)), ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves true if `promise` settles within `ms`, false otherwise. Never rejects. */
export async function settlesWithin(promise, ms) {
  let timer;
  const result = await Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
  ]);
  clearTimeout(timer);
  return result;
}
