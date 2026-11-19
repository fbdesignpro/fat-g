// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Pure, fixture-driven projections from Claude's wire data into app contracts. Every normalized
// object is built field by field from reviewed, bounded values: codenames, session totals,
// behaviors, spend, credits, breakdowns and raw IDs are dropped, never spread.
import type { AccountInfo } from '@shared/contracts/account';
import { HOUR_MS, WEEK_MS, parseIsoToEpochMs } from '@shared/contracts/time';
import { severityFromPercent, type Severity, type UsageSnapshot, type UsageWindow } from '@shared/contracts/usage';
import type { AccountResult } from '@shared/provider-kit/provider';
import { API_KEY_SOURCES, AuthStatusSchema, CLOUD_API_PROVIDERS, FIRST_PARTY_PROVIDER, SessionAccountSchema, UsageEnvelopeSchema, classifyAuth, type AuthStatus } from './schemas';

/**
 * `claude auth status`: exit 0 is signed in, 1 is the documented signed-out status. A valid payload
 * naming API-key or cloud authentication wins; any other exit or process failure is transient —
 * never labelled a logout.
 */
export function interpretAuthStatus(code: number | null, stdout: string): AccountResult {
  if (code !== 0 && code !== 1) return { kind: 'error', reason: 'temporarily-unavailable' };
  const parsed = AuthStatusSchema.safeParse(parseJson(stdout));
  if (!parsed.success) return code === 1 ? { kind: 'not-logged-in' } : { kind: 'error', reason: 'unsupported-data' };
  const status = parsed.data;
  const auth = classifyAuth(status);
  if (auth === 'api-key' || auth === 'cloud-provider') return { kind: 'not-applicable', reason: auth };
  if (code === 1 || !status.loggedIn || auth === 'signed-out') return { kind: 'not-logged-in' };
  if (auth === 'subscription') return { kind: 'account', account: subscriptionAccount(status) };
  return { kind: 'error', reason: 'unsupported-data' };
}

/** Plan slug, email and organization name only — no org ID, directories, token source or analytics. */
export function subscriptionAccount(status: AuthStatus): AccountInfo {
  const plan = slug(status.subscriptionType);
  const email = emailAddress(status.email);
  const organization = label(status.orgName, 128);
  return {
    authKind: 'subscription',
    ...(plan === undefined ? {} : { plan }),
    ...(email === undefined ? {} : { email }),
    ...(organization === undefined ? {} : { organization }),
  };
}

export type SessionAccountCheck =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'not-applicable'; readonly reason: 'api-key' | 'cloud-provider' }
  | { readonly kind: 'unsupported' };

/**
 * The session's second guard, before any usage request: the `account` in the CLI's `initialize`
 * reply must still describe a first-party account. Its display-string plan ("Claude Max") never replaces the auth-status slug.
 */
export function checkSessionAccount(value: unknown): SessionAccountCheck {
  const parsed = SessionAccountSchema.safeParse(value);
  if (!parsed.success) return { kind: 'unsupported' };
  const { apiProvider, apiKeySource } = parsed.data;
  if (apiProvider !== undefined && CLOUD_API_PROVIDERS.has(apiProvider)) return { kind: 'not-applicable', reason: 'cloud-provider' };
  if (apiKeySource !== undefined && API_KEY_SOURCES.has(apiKeySource)) return { kind: 'not-applicable', reason: 'api-key' };
  return apiProvider === FIRST_PARTY_PROVIDER ? { kind: 'eligible' } : { kind: 'unsupported' };
}

export type UsageNormalization =
  | { readonly kind: 'usage'; readonly usage: UsageSnapshot }
  /** A recognized response without allocations: neutral, not a broken meter or an old CLI. */
  | { readonly kind: 'usage-unavailable' }
  | { readonly kind: 'unsupported-data' };

const FIVE_HOURS_MS = 5 * HOUR_MS;

/**
 * `rate_limits.limits[]` is authoritative when it is an array — even an empty one — and keeps the
 * server's order. Only when it is null or absent do the named windows apply: 5-hour, weekly, then
 * model-scoped rows. Unexplained named or codename keys are never rendered.
 */
export function normalizeUsage(value: unknown): UsageNormalization {
  const envelope = UsageEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { kind: 'unsupported-data' };
  if (envelope.data.rate_limits_available === false) return { kind: 'usage-unavailable' };
  const limits = envelope.data.rate_limits;
  if (limits === null) return { kind: 'usage-unavailable' };
  if (!plain(limits)) return { kind: 'unsupported-data' };
  const rows = limits['limits'];
  let windows: UsageWindow[];
  if (Array.isArray(rows)) windows = rows.flatMap((row) => limitRow(row) ?? []);
  else if (rows === null || rows === undefined) windows = namedWindows(limits);
  else return { kind: 'unsupported-data' };
  // Stable IDs must be unique within one snapshot: a later duplicate identity is skipped.
  const seen = new Set<string>();
  const unique = windows.filter((window) => {
    if (seen.has(window.id)) return false;
    seen.add(window.id);
    return true;
  });
  return { kind: 'usage', usage: { windows: unique } };
}

function limitRow(row: unknown): UsageWindow | null {
  if (!plain(row)) return null;
  const usedPercent = percent(row['percent']);
  const common = {
    usedPercent,
    resetsAt: parseIsoToEpochMs(typeof row['resets_at'] === 'string' ? row['resets_at'] : null),
    severity: providerSeverity(row['severity']) ?? severityFromPercent(usedPercent),
    ...(typeof row['is_active'] === 'boolean' ? { isBinding: row['is_active'] } : {}),
  };
  switch (row['kind']) {
    case 'session': return { id: 'five-hour', kind: 'rolling-5h', label: '5-hour', durationMs: FIVE_HOURS_MS, ...common };
    case 'weekly_all': return { id: 'weekly', kind: 'weekly', label: 'Weekly', durationMs: WEEK_MS, ...common };
    case 'weekly_scoped': {
      const scope = plain(row['scope']) ? row['scope'] : {};
      const model = plain(scope['model']) ? scope['model'] : {};
      const identity = modelIdentity(model['id'], model['display_name'], scope['surface']);
      return identity === null ? null : { id: identity.id, kind: 'weekly-model', label: 'Weekly', durationMs: WEEK_MS, scope: identity.name, ...common };
    }
    default: return null; // an unknown kind waits until its meaning and identity are understood
  }
}

function namedWindows(limits: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const fiveHour = namedWindow(limits['five_hour']);
  if (fiveHour !== null) windows.push({ id: 'five-hour', kind: 'rolling-5h', label: '5-hour', durationMs: FIVE_HOURS_MS, ...fiveHour });
  const weekly = namedWindow(limits['seven_day']);
  if (weekly !== null) windows.push({ id: 'weekly', kind: 'weekly', label: 'Weekly', durationMs: WEEK_MS, ...weekly });
  const scoped = limits['model_scoped'];
  for (const row of Array.isArray(scoped) ? scoped : []) {
    if (!plain(row)) continue;
    const identity = modelIdentity(row['id'], row['display_name'], undefined);
    const reading = namedWindow(row);
    if (identity !== null && reading !== null) windows.push({ id: identity.id, kind: 'weekly-model', label: 'Weekly', durationMs: WEEK_MS, scope: identity.name, ...reading });
  }
  return windows;
}

function namedWindow(entry: unknown): Pick<UsageWindow, 'usedPercent' | 'resetsAt' | 'severity'> | null {
  if (!plain(entry)) return null;
  const usedPercent = percent(entry['utilization']);
  return { usedPercent, resetsAt: parseIsoToEpochMs(typeof entry['resets_at'] === 'string' ? entry['resets_at'] : null), severity: severityFromPercent(usedPercent) };
}

/** Stable, deterministic ID from a bounded model identifier (or its name) and any surface. */
function modelIdentity(id: unknown, displayName: unknown, surface: unknown): { id: string; name: string } | null {
  const name = label(displayName, 64);
  if (name === undefined) return null; // a model window nobody can name is skipped
  const model = canonical(label(id, 64) ?? name);
  if (model === '') return null;
  const place = canonical(label(surface, 64) ?? '');
  return { id: `weekly-model:${model}${place === '' ? '' : `:${place}`}`, name };
}

function canonical(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function providerSeverity(value: unknown): Severity | null {
  switch (value) {
    case 'normal': return 'normal';
    case 'warning': return 'warning';
    case 'critical':
    case 'error': return 'critical';
    default: return null;
  }
}

/** 0–100 or null ("no data"). Never coerced to 0, which would read as "nothing used". */
function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function slug(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value) ? value : undefined;
}

function emailAddress(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value) ? value : undefined;
}

/** A short display string without control characters. */
function label(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  return trimmed.length > 0 && trimmed.length <= max && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : undefined;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text.trim()) as unknown; } catch { return undefined; }
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
