// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { SEVERITY_THRESHOLDS, severityFromPercent, usageWindowKindFromDurationMins, usageWindowLabelFromDurationMins } from './usage';

describe('usageWindowKindFromDurationMins', () => {
  it.each([
    [300, 'rolling-5h'],
    [10_080, 'weekly'],
    [1_440, 'other'],
    [301, 'other'],
    [null, 'other'],
    [undefined, 'other'],
  ] as const)('%s minutes → %s', (minutes, kind) => {
    expect(usageWindowKindFromDurationMins(minutes)).toBe(kind);
  });
});

describe('usageWindowLabelFromDurationMins', () => {
  it.each([
    [300, '5-hour'],
    [10_080, 'Weekly'],
    [43_200, 'Monthly'],
    [60, 'Limit'],
    [1_440, 'Limit'],
    [4_320, 'Limit'],
    [90, 'Limit'],
    [null, 'Limit'],
    [undefined, 'Limit'],
  ] as const)('%s minutes → %s', (minutes, label) => {
    expect(usageWindowLabelFromDurationMins(minutes)).toBe(label);
  });

  it('never writes a count of minutes', () => {
    for (const minutes of [1, 60, 300, 1_440, 4_320, 10_080, 43_200, 91]) {
      expect(usageWindowLabelFromDurationMins(minutes)).not.toMatch(/[0-9]{2}/);
    }
  });
});

describe('severityFromPercent', () => {
  it.each([
    [0, 'normal'],
    [SEVERITY_THRESHOLDS.warning - 0.5, 'normal'],
    [SEVERITY_THRESHOLDS.warning, 'warning'],
    [SEVERITY_THRESHOLDS.critical - 0.5, 'warning'],
    [SEVERITY_THRESHOLDS.critical, 'critical'],
    [91, 'critical'], // tests/fixtures/codex/rate-limits-weekly-only.json
    [100, 'critical'],
    [140, 'critical'], // over-limit values are possible and must not wrap
  ] as const)('%s%% → %s', (percent, severity) => {
    expect(severityFromPercent(percent)).toBe(severity);
  });

  it('treats "no data" as normal rather than guessing', () => {
    expect(severityFromPercent(null)).toBe('normal');
    expect(severityFromPercent(Number.NaN)).toBe('normal');
  });
});
