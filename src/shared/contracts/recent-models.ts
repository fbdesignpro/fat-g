// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { ModelPresetSchema, type ModelPreset } from './presets';

export const MAX_RECENT_MODELS = 12;

/**
 * The selected catalog key matters, even when two keys currently resolve to the same model; so does
 * the speed tier: Fast and standard are two selections (decision 0016).
 */
export const modelSelectionKey = (preset: ModelPreset): string => JSON.stringify([preset.providerId, preset.instanceId, preset.model, preset.effort, preset.speed]);

/** Bad entries have no effect; unknown fields stay in main's retained document alone. */
export function readRecentModels(raw: unknown): ModelPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const models: ModelPreset[] = [];
  for (const value of raw) {
    const parsed = ModelPresetSchema.strip().safeParse(value);
    if (!parsed.success) continue;
    const key = modelSelectionKey(parsed.data);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(parsed.data);
    if (models.length === MAX_RECENT_MODELS) break;
  }
  return models;
}
