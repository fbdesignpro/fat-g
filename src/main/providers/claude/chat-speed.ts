// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The speed a Claude turn ran at (decision 0020; models research §6), read beside the mapper, since
// only the session knows it asked for fast mode. Claude 2.1.302 says it in two frames: a turn's
// `result` carries `usage.speed` — `fast`, or `standard` where fast mode was asked for and not served
// — and `fast_mode_state` (`cooldown` while fast mode is paused after a rate limit); a
// `rate_limit_event` before it says why extra usage, which fast mode is billed as, was refused
// (`overageDisabledReason`, e.g. `out_of_credits`). `usage.service_tier` says `standard` either way.

/** Ids alone pass, short and plain: what the page words, or shows as it is where it has no words for it. */
const REASON = /^[\w.-]{1,64}$/;
const reasonOf = (value: unknown): string | null => (typeof value === 'string' && REASON.test(value) ? value : null);
const objectOf = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null);

/**
 * What a `rate_limit_event` says of extra usage: the reason it was refused, `null` where it is
 * allowed, and `undefined` for any other frame, which changes nothing.
 */
export function overageReason(frame: unknown): string | null | undefined {
  const raw = objectOf(frame);
  if (raw?.['type'] !== 'rate_limit_event') return undefined;
  const info = objectOf(raw['rate_limit_info']);
  if (info === null) return undefined;
  if (info['overageStatus'] !== 'rejected') return null;
  return reasonOf(info['overageDisabledReason']) ?? 'overage_rejected';
}

/**
 * The speed a turn's `result` says it ran at, with the reason where it ran at standard speed: fast
 * mode paused (`cooldown`), else extra usage refused as the last rate-limit frame said; null for a
 * frame that is no `result` or names no speed.
 */
export function servedSpeed(frame: unknown, overage: string | null): { readonly served: 'fast' | 'standard'; readonly reason: string | null } | null {
  const raw = objectOf(frame);
  if (raw?.['type'] !== 'result') return null;
  const speed = objectOf(raw['usage'])?.['speed'];
  if (speed !== 'fast' && speed !== 'standard') return null;
  if (speed === 'fast') return { served: 'fast', reason: null };
  return { served: 'standard', reason: raw['fast_mode_state'] === 'cooldown' ? 'cooldown' : overage };
}
