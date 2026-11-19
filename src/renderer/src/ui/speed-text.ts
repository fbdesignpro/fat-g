// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CatalogSpeedTier } from '@shared/contracts/catalog';

/**
 * A speed tier's words wherever it is chosen or shown (decision 0016): the bolt, then the tier's short
 * name, beside the effort and never around the model's name (the maintainer) — the speed
 * is a turn's setting, as the effort is. Reply bars separately show the turn's saved bolts.
 */
export const SPEED_MARK = '⚡';

type Tier = Pick<CatalogSpeedTier, 'id' | 'name'>;

/** A tier's short name: "Fast", and "Ultra" for "Ultra fast", since the effort bar's room is short. */
export function speedName(tier: Tier): string {
  const short = tier.name.replace(/\s+fast$/i, '').trim();
  return short === '' ? tier.name : short;
}

/** "⚡Fast". */
export function speedText(tier: Tier): string {
  return `${SPEED_MARK}${speedName(tier)}`;
}

/** The tier a speed names among a model's, or its id alone where the model no longer lists it; undefined at standard speed. */
export function tierOf(tiers: readonly Tier[] | undefined, speed: string | null): Tier | undefined {
  if (speed === null) return undefined;
  return tiers?.find((tier) => tier.id === speed) ?? { id: speed, name: speed };
}

/** "Extra High - ⚡Fast"; the level alone at standard speed. */
export function withSpeed(effort: string, tier: Tier | undefined): string {
  return tier === undefined ? effort : `${effort} - ${speedText(tier)}`;
}

/** What a tier says of itself on hover and to assistive technology: what it costs, then what its CLI says of it. */
export function speedExplanation(tier: Pick<CatalogSpeedTier, 'warning' | 'description'>): string | undefined {
  const parts = [tier.warning, tier.description ?? undefined].filter((part): part is string => part !== undefined && part !== '');
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** Said in red after the level where the last turn asked for a faster tier and ran at standard speed (the maintainer). */
export const NOT_FAST = 'Not fast';

/** Why a turn ran at standard speed, by the reason id its CLI gave (models research §6). */
const NOT_FAST_REASONS: Readonly<Record<string, string>> = {
  out_of_credits: 'no extra usage is left, which the faster tier is billed as',
  overage_rejected: 'the account refused extra usage, which the faster tier is billed as',
  cooldown: 'fast mode is paused after a rate limit',
  'not-offered': 'this model does not offer that tier on this account',
};

/** The hover note of "Not fast": what was asked, and why it was not served, where the CLI said. */
export function notFastText(tier: Tier, reason: string | null): string {
  const why = reason === null ? null : NOT_FAST_REASONS[reason] ?? reason;
  return `${tier.name} was requested for the last reply, which ran at standard speed${why === null ? '.' : `: ${why}.`}`;
}

/** Why an account's tiers cannot be chosen, in fat-g's words; null where they can. */
export function speedRefusal(request: { readonly possible: boolean; readonly reason: string | null } | undefined): string | null {
  if (request === undefined || request.possible) return null;
  return `fat-g cannot ask this account for a faster tier${request.reason === null ? '' : ` (${request.reason})`}.`;
}
