// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Normalized usage allocations: what every provider's rate-limit data is converted into. Providers
// normalize (M6/M7); windows only ever see these shapes.

/**
 * What kind of limit a window is. Derived from the window's length or the provider's own label,
 * never from its position in a response: S1 found Codex's `primary` window can be the weekly one.
 */
export type UsageWindowKind = 'rolling-5h' | 'weekly' | 'weekly-model' | 'other';

export type Severity = 'normal' | 'warning' | 'critical';

export interface UsageWindow {
  /** Stable within one provider across refreshes, e.g. `weekly` or `weekly-model:fable`. */
  readonly id: string;
  readonly kind: UsageWindowKind;
  /** Short human label, e.g. "5-hour" or "Weekly · Fable". */
  readonly label: string;
  /** Length of the window, or null when the provider does not say. */
  readonly durationMs: number | null;
  /** 0–100. `null` means "no data" — never coerce it to 0, which would read as "nothing used". */
  readonly usedPercent: number | null;
  /** When the window resets (epoch ms), or null when unknown. */
  readonly resetsAt: number | null;
  /** What the window is limited to, e.g. the model name of a `weekly-model` window. */
  readonly scope?: string;
  readonly severity: Severity;
  /** The limit currently constraining the user (Claude's `is_active`) — what compact views headline. */
  readonly isBinding?: boolean;
}

export interface UsageSnapshot {
  /** In the provider's own order (Claude's `limits[]` is already server-ordered). */
  readonly windows: readonly UsageWindow[];
}

/** Classifies a window by its length in minutes, as Codex reports it (`windowDurationMins`). */
export function usageWindowKindFromDurationMins(minutes: number | null | undefined): UsageWindowKind {
  if (minutes === 300) return 'rolling-5h';
  if (minutes === 10_080) return 'weekly';
  return 'other';
}

/**
 * A window's short name, from its length in minutes, for providers that give only a length (Codex):
 * the lengths a plan has a word for get it, every other length — and a length the provider does not
 * give — gets the bare word "Limit". Never the count of minutes: a number of minutes reads as a
 * number with no meaning and the bar's label column cuts it off (the maintainer, on a
 * second Codex account whose window is a month long). The longest of these words sizes that column
 * (control-bar/UsageBlock.module.css).
 */
export function usageWindowLabelFromDurationMins(minutes: number | null | undefined): string {
  if (minutes === 300) return '5-hour';
  if (minutes === 10_080) return 'Weekly';
  if (minutes === 43_200) return 'Monthly';
  return 'Limit';
}

/** For providers that report a bare percentage (Codex). Claude grades severity itself (mapped in M7). */
export const SEVERITY_THRESHOLDS = { warning: 75, critical: 90 } as const;

export function severityFromPercent(usedPercent: number | null): Severity {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return 'normal';
  if (usedPercent >= SEVERITY_THRESHOLDS.critical) return 'critical';
  if (usedPercent >= SEVERITY_THRESHOLDS.warning) return 'warning';
  return 'normal';
}
