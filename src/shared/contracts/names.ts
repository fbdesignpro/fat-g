// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The one rule for names fat-g stores — projects now, sessions from M14 (decision 0011, item 6).
// Main applies it on every change and when reading the file; the page applies it only to check and
// preview, so what main saves is what is shown (docs/planning/_archive/M12.md, C16). The catalog cleans the
// names and descriptions the CLIs and the override hold with the same rule, at its own lengths
// (docs/planning/_archive/M13.md, C9).

/** The longest project name, in grapheme clusters: what a reader sees as one character. */
export const NAME_MAX_GRAPHEMES = 60;
/** Session titles have room to wrap in the heading; capsules fit them to their own width. */
export const SESSION_NAME_MAX_GRAPHEMES = 160;
/** Preset names share the compact model capsules. */
export const PRESET_NAME_MAX_GRAPHEMES = 18;
export const NAME_ELLIPSIS = '…';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function cleanText(value: string): string {
  return value.replace(/\s+/gu, ' ').replace(/\p{Cc}/gu, '').replace(/ {2,}/g, ' ');
}

/**
 * Every run of whitespace — tabs and line breaks included — becomes one space; the remaining control
 * characters go; the ends are trimmed. A text longer than `max` grapheme clusters keeps its first
 * `max - 1`, followed by "…". An empty result means no text.
 */
export function normalizeText(value: string, max: number): string {
  const cleaned = cleanText(value).trim();
  const clusters = [...graphemes.segment(cleaned)];
  if (clusters.length <= max) return cleaned;
  return `${clusters
    .slice(0, max - 1)
    .map((cluster) => cluster.segment)
    .join('')}${NAME_ELLIPSIS}`;
}

/** A name: `normalizeText` at 60 grapheme clusters. */
export function normalizeName(value: string): string {
  return normalizeText(value, NAME_MAX_GRAPHEMES);
}

/** A session title, with the same cleaning and Unicode boundaries as a project's name. */
export function normalizeSessionName(value: string): string {
  return normalizeText(value, SESSION_NAME_MAX_GRAPHEMES);
}

/** A preset name uses the shared cleaning rule, at 18 visible characters. */
export function normalizePresetName(value: string): string {
  return normalizeText(value, PRESET_NAME_MAX_GRAPHEMES);
}

/** Cap typed or pasted preset names without splitting Unicode or removing the space being typed. */
export function limitPresetNameInput(value: string): string {
  return [...graphemes.segment(cleanText(value).trimStart())].slice(0, PRESET_NAME_MAX_GRAPHEMES).map((cluster) => cluster.segment).join('');
}
