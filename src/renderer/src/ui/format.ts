// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/** "44%", or an em dash for "no data" — never "0%", which would read as "nothing used". */
export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`;
}

/** A used percentage within 0–100, for a meter and its fill. Anything out of range is clamped. */
export function clampPercent(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** The share that remains of a window, from the share used: 100 less it, clamped (M100, C55, C56). */
export function remainingPercent(usedPercent: number): number {
  return 100 - clampPercent(usedPercent);
}

/** How far `at` is ahead of `now`, in whole days, hours and minutes; all zero once it has passed. */
function timeAhead(at: number, now: number): { readonly seconds: number; readonly days: number; readonly hours: number; readonly minutes: number } {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return { seconds, days: Math.floor(seconds / 86_400), hours: Math.floor((seconds % 86_400) / 3600), minutes: Math.floor((seconds % 3600) / 60) };
}

/** "in 2h 3m", "in 5d 2h", "now" — how far `at` is ahead of `now`. */
export function relativeTime(at: number, now: number): string {
  const { seconds, days, hours, minutes } = timeAhead(at, now);
  if (seconds === 0) return 'now';
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  return `in ${minutes}m`;
}

/**
 * "5d5h", "3h32", "19h01", "32m", "now" — the same distance as `relativeTime`, with nothing between its
 * parts and, under a day, no unit after the minutes, always two digits, which the hour's "h" makes plain: a usage bar's
 * column says when its window resets in it (M100, C85).
 */
export function compactCountdown(at: number, now: number): string {
  const { seconds, days, hours, minutes } = timeAhead(at, now);
  if (seconds === 0) return 'now';
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}`;
  return `${minutes}m`;
}

/** In the user's own locale and time zone. */
export function formatDateTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
}

const DAY_TIME = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const DAY_TIME_YEAR = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** A day and its time, in the user's own locale and time zone: its year only where it is not the year of `now` (the maintainer). */
export function formatDayTime(at: number, now: number): string {
  return (new Date(at).getFullYear() === new Date(now).getFullYear() ? DAY_TIME : DAY_TIME_YEAR).format(new Date(at));
}

const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/** A time of day, to the minute, in the user's own locale and time zone (M19, C42). */
export function formatTimeOfDay(at: number): string {
  return TIME_OF_DAY.format(new Date(at));
}

/** The start of the local day `at` falls in, in milliseconds since the epoch. */
export function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** How long something took (M19, C43): "under 1 s", "12 s", "2 min 5 s", "1 h 2 min". */
export function formatElapsed(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 1) return 'under 1 s';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** How long ago `at` was, in whole units: "just now" under a minute, "1 minute ago", "5 hours ago", "3 days ago". */
export function formatAgo(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  const count = (value: number, unit: string): string => `${value} ${unit}${value === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return count(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? count(hours, 'hour') : count(Math.floor(hours / 24), 'day');
}

/** A time of day with seconds, in the user's own locale and time zone. */
export function formatTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(at));
}

/** When a usage window resets, relative and absolute. */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return 'Reset time unknown';
  return `${resetsAt <= now ? 'Reset pending' : `Resets ${relativeTime(resetsAt, now)}`} · ${formatDateTime(resetsAt)}`;
}

/** A size on disk, in steps of 1024: "512 B", "12.3 KB", "4.5 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'TB'}`;
}
