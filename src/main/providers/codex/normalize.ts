// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { AccountResult } from '@shared/provider-kit/provider';
import { MINUTE_MS, toEpochMs } from '@shared/contracts/time';
import { severityFromPercent, usageWindowKindFromDurationMins, usageWindowLabelFromDurationMins, type UsageSnapshot, type UsageWindow } from '@shared/contracts/usage';
import { AccountResponseSchema, ApiKeyAccountSchema, BedrockAccountSchema, ChatGptAccountSchema, RateLimitsEnvelopeSchema } from './schemas';

export interface NormalizedBucket {
  readonly id: string;
  readonly windows: readonly UsageWindow[];
}

export type UsageNormalization =
  | { readonly ok: true; readonly buckets: readonly NormalizedBucket[]; readonly usage: UsageSnapshot }
  | { readonly ok: false };

export function normalizeAccount(value: unknown): AccountResult {
  const envelope = AccountResponseSchema.safeParse(value);
  if (!envelope.success) return { kind: 'error', reason: 'unsupported-data' };
  const account = envelope.data.account;
  if (account === null) return envelope.data.requiresOpenaiAuth ? { kind: 'not-logged-in' } : { kind: 'not-applicable', reason: 'cloud-provider' };

  const chatgpt = ChatGptAccountSchema.safeParse(account);
  if (chatgpt.success) {
    return {
      kind: 'account',
      account: {
        authKind: 'subscription',
        ...(chatgpt.data.planType ? { plan: chatgpt.data.planType } : {}),
        ...(chatgpt.data.email ? { email: chatgpt.data.email } : {}),
      },
    };
  }
  if (ApiKeyAccountSchema.safeParse(account).success) return { kind: 'not-applicable', reason: 'api-key' };
  if (BedrockAccountSchema.safeParse(account).success) return { kind: 'not-applicable', reason: 'cloud-provider' };
  return { kind: 'error', reason: 'unsupported-data' };
}

export function normalizeRateLimits(value: unknown): UsageNormalization {
  const envelope = RateLimitsEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { ok: false };
  const raw = envelope.data as Record<string, unknown>;
  const mapValue = raw['rateLimitsByLimitId'];
  let buckets: NormalizedBucket[];
  if (mapValue !== undefined && mapValue !== null) {
    if (!plain(mapValue)) return { ok: false };
    buckets = [];
    for (const [id, bucket] of Object.entries(mapValue)) {
      const normalized = normalizeBucket(bucket, id);
      if (normalized !== null) buckets.push(normalized);
    }
  } else {
    const legacy = raw['rateLimits'];
    if (legacy === undefined || legacy === null) buckets = [];
    else {
      const bucket = normalizeBucket(legacy);
      if (bucket === null) return { ok: false };
      buckets = [bucket];
    }
  }
  const windows = buckets.flatMap((bucket) => bucket.windows);
  return { ok: true, buckets, usage: { windows } };
}

/** The notification wraps exactly one bucket in `rateLimits`. */
export function normalizeRateLimitPush(value: unknown): NormalizedBucket | null {
  if (!plain(value)) return null;
  return normalizeBucket(value['rateLimits']);
}

function normalizeBucket(value: unknown, mapId?: string): NormalizedBucket | null {
  if (!plain(value)) return null;
  const wireId = value['limitId'];
  const id = safeId(mapId) ?? safeId(wireId);
  if (id === null) return null;
  const scope = safeLabel(value['limitName']) ?? safeLabel(value['normalModelSlug']) ?? (id === 'codex' ? undefined : id);
  const windows: UsageWindow[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const raw = value[slot];
    if (raw === null || raw === undefined || !plain(raw)) continue;
    const minutes = duration(raw['windowDurationMins']);
    const usedPercent = percent(raw['usedPercent']);
    const resetsAt = epoch(raw['resetsAt']);
    const kind = usageWindowKindFromDurationMins(minutes);
    windows.push({
      id: `${id}:${slot}`,
      kind,
      label: usageWindowLabelFromDurationMins(minutes),
      durationMs: minutes === null ? null : minutes * MINUTE_MS,
      usedPercent,
      resetsAt,
      severity: severityFromPercent(usedPercent),
      ...(scope === undefined ? {} : { scope }),
    });
  }
  return { id, windows };
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 5_256_000 ? value : null;
}

function epoch(value: unknown): number | null {
  const result = typeof value === 'number' ? toEpochMs(value) : null;
  return result !== null && result <= 8_640_000_000_000_000 ? result : null;
}

function safeId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
