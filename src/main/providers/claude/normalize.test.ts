// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOUR_MS, WEEK_MS } from '@shared/contracts/time';
import { checkSessionAccount, interpretAuthStatus, normalizeUsage } from './normalize';

const fixture = (name: string): unknown => JSON.parse(readFileSync(path.resolve('tests/fixtures/claude', name), 'utf8'));
const windowsOf = (value: unknown) => {
  const result = normalizeUsage(value);
  if (result.kind !== 'usage') throw new Error(`expected usage, got ${result.kind}`);
  return result.usage.windows;
};

describe('claude auth status', () => {
  const synthetic = fixture('auth-status-synthetic.json') as { cases: { name: string; exitCode: number | null; payload: unknown; expected: unknown }[] };
  it.each(synthetic.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const stdout = typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload);
    expect(interpretAuthStatus(entry.exitCode, stdout)).toEqual(entry.expected);
  });

  it('keeps only bounded, reviewed identity from the captured S1 status', () => {
    const { _fixture: _meta, ...captured } = fixture('auth-status-logged-in.json') as Record<string, unknown>;
    const result = interpretAuthStatus(0, JSON.stringify(captured));
    expect(result).toEqual({ kind: 'account', account: { authKind: 'subscription', plan: 'max', email: 'user@example.com', organization: 'Example Org' } });
    expect(JSON.stringify(result)).not.toMatch(/orgId|0000-|configDirectory|projects|analytics|\\\\/);
  });

  it.each([
    ['display-string plan', { subscriptionType: 'Claude Max' }, {}],
    ['oversized email', { email: `${'x'.repeat(320)}@example.test` }, {}],
    ['email without @', { email: 'not-an-email' }, {}],
    ['control characters', { orgName: 'Org\u0007' }, {}],
    ['oversized organization', { orgName: 'o'.repeat(129) }, {}],
    ['non-string identity', { email: 42, orgName: ['x'], subscriptionType: { slug: 'max' } }, {}],
    ['future plan slug', { subscriptionType: 'team_premium' }, { plan: 'team_premium' }],
  ])('drops invalid identity fields: %s', (_name, fields, kept) => {
    const payload = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', ...fields };
    expect(interpretAuthStatus(0, JSON.stringify(payload))).toEqual({ kind: 'account', account: { authKind: 'subscription', ...kept } });
  });
});

describe('SDK accountInfo guard', () => {
  it('accepts the captured first-party account and never uses its display-string plan', () => {
    expect(checkSessionAccount(fixture('account-info.json'))).toEqual({ kind: 'eligible' });
  });
  it.each([
    [{ apiProvider: 'bedrock' }, { kind: 'not-applicable', reason: 'cloud-provider' }],
    [{ apiProvider: 'mantle' }, { kind: 'not-applicable', reason: 'cloud-provider' }],
    [{ apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' }, { kind: 'not-applicable', reason: 'api-key' }],
    [{ apiProvider: 'firstParty', apiKeySource: 'none' }, { kind: 'eligible' }],
    [{ email: 'x@example.test' }, { kind: 'unsupported' }],
    [{ apiProvider: 'orbital' }, { kind: 'unsupported' }],
    [null, { kind: 'unsupported' }],
    ['account', { kind: 'unsupported' }],
  ])('%j', (value, expected) => {
    expect(checkSessionAccount(value)).toEqual(expected);
  });
});

describe('claude usage normalization', () => {
  it('reads the captured S1 response from limits[] in server order, with provider severity and binding', () => {
    expect(windowsOf(fixture('usage-max-full.json'))).toEqual([
      { id: 'five-hour', kind: 'rolling-5h', label: '5-hour', durationMs: 5 * HOUR_MS, usedPercent: 8, resetsAt: Date.parse('2020-01-12T17:50:00.118418+00:00'), severity: 'normal', isBinding: false },
      { id: 'weekly', kind: 'weekly', label: 'Weekly', durationMs: WEEK_MS, usedPercent: 32, resetsAt: Date.parse('2020-01-17T07:00:00.118440+00:00'), severity: 'normal', isBinding: false },
      { id: 'weekly-model:fable', kind: 'weekly-model', label: 'Weekly', durationMs: WEEK_MS, scope: 'Fable', usedPercent: 44, resetsAt: Date.parse('2020-01-17T07:00:00.118619+00:00'), severity: 'normal', isBinding: true },
    ]);
  });

  it('never carries codenames, spend, credits, session totals, behaviors or breakdowns', () => {
    const text = JSON.stringify(normalizeUsage(fixture('usage-max-full.json')));
    for (const leaked of ['tangelo', 'nimbus', 'cinder', 'spend', 'credits', 'CAD', 'breakdown', 'claude_code', 'dollars', 'behaviors', 'session"']) expect(text).not.toContain(leaked);
  });

  it('treats limits[] as authoritative: surfaces, ids, duplicates, unnamed rows, severities and bad values', () => {
    const windows = windowsOf(fixture('usage-model-scoped.json'));
    expect(windows.map((window) => window.id)).toEqual(['weekly', 'five-hour', 'weekly-model:fable', 'weekly-model:claude-fable-5:claude-code', 'weekly-model:opus']);
    expect(new Set(windows.map((window) => window.id)).size).toBe(windows.length);
    expect(windows[0]).toMatchObject({ severity: 'critical', isBinding: true, usedPercent: 91 });
    expect(windows[1]).toMatchObject({ usedPercent: null, resetsAt: null, severity: 'normal', isBinding: false });
    expect(windows[2]).toMatchObject({ scope: 'Fable', severity: 'warning', usedPercent: 77, resetsAt: Date.parse('2020-01-17T07:00:00Z') });
    expect(windows[2]).not.toHaveProperty('isBinding');
    expect(windows[3]).toMatchObject({ scope: 'Fable', severity: 'critical', resetsAt: null });
    expect(windows[4]).toMatchObject({ scope: 'Opus', usedPercent: null, severity: 'normal' });
  });

  it('falls back to the named windows only when limits[] is absent, in 5-hour, weekly, model order', () => {
    const windows = windowsOf(fixture('usage-named-windows-only.json'));
    expect(windows.map((window) => [window.id, window.usedPercent, window.severity])).toEqual([
      ['five-hour', 0, 'normal'], ['weekly', 55.5, 'normal'], ['weekly-model:fable', 44, 'normal'], ['weekly-model:sonnet', null, 'normal'],
    ]);
    expect(windows[1]?.resetsAt).toBeNull();
  });

  it('keeps an empty limits[] authoritative instead of reviving named duplicates', () => {
    const value = { rate_limits_available: true, rate_limits: { limits: [], five_hour: { utilization: 5 }, seven_day: { utilization: 6 } } };
    expect(normalizeUsage(value)).toEqual({ kind: 'usage', usage: { windows: [] } });
  });

  it.each([
    ['rate limits null and unavailable', fixture('usage-rate-limits-null.json')],
    ['available flag false', { rate_limits_available: false, rate_limits: { limits: [{ kind: 'session', percent: 1 }] } }],
    ['rate limits null', { rate_limits: null }],
  ])('reports %s as neutral usage-unavailable', (_name, value) => {
    expect(normalizeUsage(value)).toEqual({ kind: 'usage-unavailable' });
  });

  it.each([
    ['a non-object envelope', 'usage'],
    ['null', null],
    ['missing rate limits', { rate_limits_available: true }],
    ['a malformed limits value', { rate_limits: { limits: { kind: 'session' } } }],
    ['a non-boolean availability flag', { rate_limits_available: 'yes', rate_limits: {} }],
  ])('rejects %s as unsupported data', (_name, value) => {
    expect(normalizeUsage(value)).toEqual({ kind: 'unsupported-data' });
  });

  it.each([
    [-1, null], [0, 0], [100, 100], [100.5, null], [Number.NaN, null], ['50', null], [null, null],
  ])('bounds percent %s to %s', (percent, expected) => {
    expect(windowsOf({ rate_limits: { limits: [{ kind: 'session', percent }] } })[0]?.usedPercent).toBe(expected);
  });

  it.each([
    ['2020-01-12T17:50:00.118418+00:00', Date.parse('2020-01-12T17:50:00.118418+00:00')],
    ['2020-01-12T17:50:00Z', Date.parse('2020-01-12T17:50:00Z')],
    ['2020-01-12T17:50:00', null],
    ['2020-01-12', null],
    [1_578_924_800, null],
  ])('reads reset time %j only with an explicit offset', (resets_at, expected) => {
    expect(windowsOf({ rate_limits: { limits: [{ kind: 'weekly_all', resets_at }] } })[0]?.resetsAt).toBe(expected);
  });

  it('maps every provider severity and falls back to thresholds only when it is missing or unknown', () => {
    const rows = [['normal', 95], ['warning', 10], ['critical', 10], ['error', 10], [undefined, 80], ['mystery', 95]] as const;
    const windows = rows.map(([severity, percent]) => windowsOf({ rate_limits: { limits: [{ kind: 'session', percent, ...(severity ? { severity } : {}) }] } })[0]?.severity);
    expect(windows).toEqual(['normal', 'warning', 'critical', 'critical', 'warning', 'critical']);
  });

  it('builds deterministic, bounded model identities', () => {
    const scoped = (display_name: unknown, id: unknown = null, surface: unknown = null) => ({ kind: 'weekly_scoped', scope: { model: { id, display_name }, surface } });
    const ids = windowsOf({ rate_limits: { limits: [
      scoped('Fable 5 (1M)'), scoped('Ünïcode Model'), scoped('Fable', 'x'.repeat(65)), scoped('   '), scoped('Opus', null, 'Chat'), scoped('!!!'),
    ] } }).map((window) => window.id);
    expect(ids).toEqual(['weekly-model:fable-5-1m', 'weekly-model:ünïcode-model', 'weekly-model:fable', 'weekly-model:opus:chat']);
  });
});
