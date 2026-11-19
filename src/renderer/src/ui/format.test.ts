// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { compactCountdown, formatAgo, formatDayTime, relativeTime } from './format';

const NOW = Date.UTC(2020, 1, 6, 12, 0, 0);
const after = (seconds: number): number => NOW + seconds * 1000;

// M100 (C85): the usage bar's countdown says the same distance as the panel's "in …", with nothing between its parts and no "m" after an hour's minutes, which are always two digits.
describe('compactCountdown', () => {
  it.each([
    [5 * 86_400 + 5 * 3600 + 59 * 60, '5d5h', 'in 5d 5h'],
    [3 * 3600 + 32 * 60 + 59, '3h32', 'in 3h 32m'],
    [19 * 3600 + 60, '19h01', 'in 19h 1m'],
    [32 * 60, '32m', 'in 32m'],
    [59, '0m', 'in 0m'],
    [0, 'now', 'now'],
    [-3600, 'now', 'now'],
  ])('says %s seconds ahead as %s, as relativeTime says %s', (seconds, compact, relative) => {
    expect(compactCountdown(after(seconds), NOW)).toBe(compact);
    expect(relativeTime(after(seconds), NOW)).toBe(relative);
  });

  it('rounds a fraction of a second up, like relativeTime', () => {
    expect(compactCountdown(NOW + 500, NOW)).toBe('0m');
    expect(compactCountdown(NOW + 60_001, NOW)).toBe('1m');
    expect(compactCountdown(NOW + 3_600_500, NOW)).toBe('1h00');
  });
});

// An answer's foot (the maintainer): how long ago it started or completed, in whole units.
describe('formatAgo', () => {
  it.each([
    [0, 'just now'],
    [59, 'just now'],
    [60, '1 minute ago'],
    [5 * 60 + 30, '5 minutes ago'],
    [3600, '1 hour ago'],
    [23 * 3600 + 59 * 60, '23 hours ago'],
    [86_400, '1 day ago'],
    [3 * 86_400 + 3600, '3 days ago'],
    [-30, 'just now'],
  ])('says %s seconds ago as %s', (seconds, said) => {
    expect(formatAgo(NOW - seconds * 1000, NOW)).toBe(said);
  });
});

// An answer's foot (the maintainer): a date of this year needs no year.
describe('formatDayTime', () => {
  it('says the year only of a date in another year than now', () => {
    const now = new Date(2020, 1, 21, 9, 0).getTime();
    expect(formatDayTime(new Date(2020, 1, 19, 8, 53).getTime(), now)).not.toContain('2020');
    expect(formatDayTime(new Date(2020, 1, 19, 8, 53).getTime(), now)).toContain('19');
    expect(formatDayTime(new Date(2025, 11, 31, 23, 5).getTime(), now)).toContain('2025');
  });
});
