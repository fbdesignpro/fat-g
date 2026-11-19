// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Named selections stored in preferences, independent of the flows that will use them later.
import { z } from 'zod';
import type { CatalogState } from './catalog';
import { normalizePresetName } from './names';
import { checkPreset, ModelPresetSchema, presetOffer, type ModelPreset } from './presets';
import { sameInstance } from './instances';
import type { ProviderSnapshot } from './status';

export const SavedPresetSchema = ModelPresetSchema.extend({
  name: z.string().max(4096).transform(normalizePresetName).refine((name) => name.length > 0, 'a preset needs a name'),
});
export type SavedPreset = z.infer<typeof SavedPresetSchema>;
export type SavedPresets = Readonly<Record<string, SavedPreset>>;

/** Recent choices first; never-used entries retain their saved order. */
export function orderedPresetIds(presets: SavedPresets, recency: readonly string[]): string[] {
  return [...new Set([...recency, ...Object.keys(presets)])].filter((id) => presets[id] !== undefined);
}

/** One choice is merged in main, so simultaneous clicks cannot overwrite another choice. */
export function useSavedPreset(presets: SavedPresets, recency: readonly string[], used?: string): string[] {
  return [...new Set([...(used !== undefined && presets[used] !== undefined ? [used] : []), ...recency])]
    .filter((id) => presets[id] !== undefined);
}

/** Invalid entries have no effect. Unknown fields remain in main's retained document alone. */
export function readSavedPresets(raw: Readonly<Record<string, unknown>>): SavedPresets {
  const entries: [string, SavedPreset][] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (!z.guid().safeParse(id).success) continue;
    const parsed = SavedPresetSchema.strip().safeParse(value);
    if (parsed.success) entries.push([id, parsed.data]);
  }
  return Object.fromEntries(entries);
}

/** A set replaces the known selection; null removes it. An unrelated entry is never replaced. */
export function mergeSavedPresets(current: SavedPresets, patch: Readonly<Record<string, SavedPreset | null>> | undefined): SavedPresets {
  const next = { ...current };
  for (const [id, preset] of Object.entries(patch ?? {})) {
    if (preset === null) delete next[id];
    else next[id] = preset;
  }
  return next;
}

/** Availability is live, never saved, and never substitutes another model, account, effort or speed. */
export function savedPresetProblem(preset: ModelPreset, catalog: CatalogState | undefined, providers: readonly ProviderSnapshot[]): string | null {
  const offer = presetOffer(providers.map((provider) => provider.id), providers);
  const check = checkPreset(catalog, offer, preset);
  if (!check.ok) {
    switch (check.reason) {
      case 'provider-not-offered': return 'Provider not available.';
      case 'provider-unavailable': return 'Provider is off or not available.';
      case 'instance-unavailable': return 'Account is off or not available.';
      case 'model-not-listed': return 'Model is hidden or not listed by this account.';
      case 'effort-not-listed': return 'Effort is not offered for this model.';
      case 'speed-not-listed': return 'Speed is not offered for this model.';
      case 'speed-unavailable': return 'This account cannot ask for that speed.';
    }
  }
  const provider = providers.find((entry) => sameInstance({ providerId: entry.id, instanceId: entry.instanceId }, preset));
  if (provider === undefined) return 'Account not available.';
  switch (provider.status.kind) {
    case 'blocked': case 'detecting': case 'not-installed': case 'not-logged-in': return 'Account is not ready.';
    case 'disabled': return 'Account is off.';
    case 'ok': case 'stale': case 'waking': case 'error': case 'not-applicable': return null;
  }
}
