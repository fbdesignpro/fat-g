// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { MAX_RECENT_MODELS, modelSelectionKey } from '@shared/contracts/recent-models';
import { ModelPresetSchema, type ModelPreset } from '@shared/contracts/presets';

/** Move one use, retaining its unknown fields and unrelated malformed entries on disk. */
export function useRecentModel(raw: unknown, used: ModelPreset): unknown[] {
  const entries: unknown[] = Array.isArray(raw) ? raw : [];
  const key = modelSelectionKey(used);
  const matches = (value: unknown): boolean => {
    const parsed = ModelPresetSchema.strip().safeParse(value);
    return parsed.success && modelSelectionKey(parsed.data) === key;
  };
  const previous = entries.find(matches);
  const first = typeof previous === 'object' && previous !== null ? { ...previous, ...used } : used;
  const seen = new Set<string>();
  return [first, ...entries.filter((value) => !matches(value))].filter((value) => {
    const parsed = ModelPresetSchema.strip().safeParse(value);
    if (!parsed.success) return true;
    const selection = modelSelectionKey(parsed.data);
    if (seen.has(selection) || seen.size === MAX_RECENT_MODELS) return false;
    seen.add(selection);
    return true;
  });
}
