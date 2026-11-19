// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeAccount, normalizeRateLimitPush, normalizeRateLimits } from './normalize';

const accountFixture: unknown = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/codex/account-chatgpt.json', import.meta.url), 'utf8'));
const usageFixture: unknown = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/codex/rate-limits-weekly-only.json', import.meta.url), 'utf8'));

describe('Codex account normalization', () => {
  it('exposes only reviewed ChatGPT identity fields', () => {
    const result = normalizeAccount(accountFixture);
    expect(result).toEqual({ kind: 'account', account: { authKind: 'subscription', plan: 'prolite', email: 'user@example.com' } });
    expect(JSON.stringify(result)).not.toContain('_fixture');
  });

  it.each([
    [{ account: null, requiresOpenaiAuth: true }, { kind: 'not-logged-in' }],
    [{ account: null, requiresOpenaiAuth: false }, { kind: 'not-applicable', reason: 'cloud-provider' }],
    [{ account: { type: 'apiKey' }, requiresOpenaiAuth: true }, { kind: 'not-applicable', reason: 'api-key' }],
    [{ account: { type: 'amazonBedrock', credentialSource: 'awsManaged' }, requiresOpenaiAuth: false }, { kind: 'not-applicable', reason: 'cloud-provider' }],
  ])('maps %j safely', (wire, expected) => {
    expect(normalizeAccount(wire)).toEqual(expected);
  });

  it('does not guess when account discriminators are unknown', () => {
    expect(normalizeAccount({ account: { type: 'future', email: 'private@example.test' }, requiresOpenaiAuth: true })).toEqual({
      kind: 'error', reason: 'unsupported-data',
    });
  });
});

describe('Codex rate-limit normalization', () => {
  it('uses duration rather than primary position and discards credits and account ids', () => {
    const result = normalizeRateLimits(usageFixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.windows).toEqual([
      {
        id: 'codex:primary',
        kind: 'weekly',
        label: 'Weekly',
        durationMs: 604_800_000,
        usedPercent: 91,
        resetsAt: 1_580_138_963_000,
        severity: 'critical',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('RateLimitResetCredit');
    expect(JSON.stringify(result)).not.toContain('00000000-0000');
  });

  it('prefers every multi-bucket entry without duplicating the legacy view', () => {
    const result = normalizeRateLimits({
      rateLimits: { limitId: 'legacy', primary: { usedPercent: 99, windowDurationMins: 300 } },
      rateLimitsByLimitId: {
        codex: { limitId: 'ignored-in-favour-of-map-key', primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_578_924_800 } },
        model: { limitId: 'model', limitName: 'Fable', primary: { usedPercent: 44, windowDurationMins: 10_080 }, secondary: { usedPercent: 12, windowDurationMins: 75 } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.windows.map((window) => [window.id, window.kind, window.usedPercent, window.scope])).toEqual([
      ['codex:primary', 'rolling-5h', 0, undefined],
      ['model:primary', 'weekly', 44, 'Fable'],
      ['model:secondary', 'other', 12, 'Fable'],
    ]);
  });

  it('treats an explicit empty map as authoritative and a malformed map as failure', () => {
    expect(normalizeRateLimits({ rateLimitsByLimitId: {}, rateLimits: { limitId: 'legacy', primary: { usedPercent: 1 } } })).toMatchObject({
      ok: true, usage: { windows: [] },
    });
    expect(normalizeRateLimits({ rateLimitsByLimitId: [], rateLimits: { limitId: 'legacy' } })).toEqual({ ok: false });
  });

  it('keeps a valid sibling while bad values become unknown rather than zero', () => {
    const result = normalizeRateLimits({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: null, windowDurationMins: -1, resetsAt: Number.POSITIVE_INFINITY },
        secondary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_578_924_800_000 },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.windows[0]).toMatchObject({ usedPercent: null, durationMs: null, resetsAt: null, kind: 'other' });
    expect(result.usage.windows[1]).toMatchObject({ usedPercent: 0, durationMs: 18_000_000, kind: 'rolling-5h' });
  });

  it('normalizes a partial push without interpreting unrelated metadata', () => {
    expect(normalizeRateLimitPush({ rateLimits: { limitId: 'codex', primary: { usedPercent: 31, windowDurationMins: 300 }, secondary: null }, accountId: 'private' }))
      .toEqual({ id: 'codex', windows: [expect.objectContaining({ id: 'codex:primary', usedPercent: 31, kind: 'rolling-5h' })] });
    expect(normalizeRateLimitPush({ rateLimits: { primary: { usedPercent: 1 } } })).toBeNull();
  });
});
