// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Pure time helpers shared by provider normalization (main) and countdowns (renderer).
// Every timestamp in the app's state is epoch milliseconds — a number, never a Date — because
// snapshots cross the process boundary by structured clone.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;

/**
 * Below this, a numeric timestamp is taken to be in seconds. 1e11 s is the year 5138 and 1e11 ms
 * is March 1973, so no plausible value of either unit lands on the wrong side.
 */
const SECONDS_CUTOFF = 1e11;

/** Normalizes an epoch timestamp that may be in seconds (Codex `resetsAt`) or milliseconds. */
export function toEpochMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value < SECONDS_CUTOFF ? value * 1000 : value);
}

/**
 * ISO 8601 date-time with an explicit offset and fractional seconds of any precision — Claude's
 * usage response sends `2020-01-12T17:50:00.118418+00:00`. A value without an offset is rejected
 * rather than guessed: `Date.parse` would silently read it as local time.
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseIsoToEpochMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
