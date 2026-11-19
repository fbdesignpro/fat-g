// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, WEEK_MS, parseIsoToEpochMs, toEpochMs } from './time';

describe('duration constants', () => {
  it('build up from the minute', () => {
    expect([MINUTE_MS, HOUR_MS, DAY_MS, WEEK_MS]).toEqual([60_000, 3_600_000, 86_400_000, 604_800_000]);
  });
});

describe('toEpochMs', () => {
  it('reads Codex resetsAt (epoch seconds) as seconds', () => {
    // tests/fixtures/codex/rate-limits-weekly-only.json
    expect(toEpochMs(1580138963)).toBe(1_580_138_963_000);
  });

  it('leaves millisecond timestamps alone', () => {
    expect(toEpochMs(1_580_138_963_000)).toBe(1_580_138_963_000);
  });

  it('rounds fractional seconds to whole milliseconds', () => {
    expect(toEpochMs(1580138963.2507)).toBe(1_580_138_963_251);
  });

  it.each([null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY])('treats %s as missing', (value) => {
    expect(toEpochMs(value)).toBeNull();
  });
});

describe('parseIsoToEpochMs', () => {
  it('reads Claude resets_at, microseconds and offset included', () => {
    // tests/fixtures/claude/usage-max-full.json — microseconds truncate to milliseconds.
    expect(parseIsoToEpochMs('2020-01-12T17:50:00.118418+00:00')).toBe(Date.UTC(2020, 0, 12, 17, 50, 0, 118));
  });

  it('honours non-UTC offsets and Z', () => {
    expect(parseIsoToEpochMs('2020-01-12T13:50:00-04:00')).toBe(Date.UTC(2020, 0, 12, 17, 50));
    expect(parseIsoToEpochMs('2020-01-12T17:50:00Z')).toBe(Date.UTC(2020, 0, 12, 17, 50));
    expect(parseIsoToEpochMs('2020-01-12T17:50Z')).toBe(Date.UTC(2020, 0, 12, 17, 50));
  });

  it.each([
    ['no offset (would be read as local time)', '2020-01-12T17:50:00'],
    ['date only', '2020-01-12'],
    ['a loose format Date.parse would accept', 'Jan 12 2020 17:50:00 GMT'],
    ['an impossible month', '2020-13-01T00:00:00Z'],
    ['an impossible hour', '2020-01-12T25:00:00Z'],
    ['empty', ''],
    ['garbage', 'soon'],
  ])('rejects %s', (_name, value) => {
    expect(parseIsoToEpochMs(value)).toBeNull();
  });

  it.each([null, undefined])('treats %s as missing', (value) => {
    expect(parseIsoToEpochMs(value)).toBeNull();
  });
});
