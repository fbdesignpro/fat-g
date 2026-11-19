// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The avatar overlay (decision 0032): over an avatar at the column and capsule sizes, a model's short
// name and version drawn as text, and the session's effort drawn as marks, instead of baked into the
// image. Its look is a style in two layers, both from the family's own `family.json` — the family's,
// then the avatar's — each later one winning field by field over fat-g's defaults. The version and the
// effort are styled apart; in the version's, a layer that names a preset first replaces the look
// gathered so far with the preset's, then its own fields adjust it. A fast session's lightning bolt is
// drawn in the marks' look, at a place of its own.
//
// Every value is one of a closed set, a bounded integer or a hex colour: a manifest comes from any
// folder, so nothing of it reaches the page as a CSS string. The texts are drawn as text nodes alone,
// and the effort and the speed are the session's, given where the avatar is drawn: never part of the style.
//
// Renderer-safe: types, bounds, schemas and pure helpers.
import { z } from 'zod';

// ── The version text ──────────────────────────────────────────────────────────────────────────

export const OVERLAY_PRESETS = ['badge', 'glow', 'band', 'chip'] as const;
export type OverlayPreset = (typeof OVERLAY_PRESETS)[number];
export const OVERLAY_EFFECTS = ['plain', 'outline', 'glow', 'chip'] as const;
export type OverlayEffect = (typeof OVERLAY_EFFECTS)[number];
export const OVERLAY_BACKDROPS = ['none', 'shade'] as const;
export type OverlayBackdrop = (typeof OVERLAY_BACKDROPS)[number];
/** The eight places on the avatar's edge, row by row; the centre is not one yet. */
export const OVERLAY_POSITIONS = ['top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;
export type OverlayPosition = (typeof OVERLAY_POSITIONS)[number];
/** The type's height as a percentage of the avatar's width. */
export const OVERLAY_SIZE = { min: 6, max: 40 } as const;
export const OVERLAY_STRENGTH = { min: 0, max: 100 } as const;
/** The glow's reach, as a percentage of fat-g's own: 0 draws none, 200 twice as far; offered in steps of 25. */
export const GLOW_STRENGTH = { min: 0, max: 200, step: 25 } as const;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The version's look as drawn: every field settled. */
export interface VersionLook {
  readonly effect: OverlayEffect;
  readonly size: number;
  readonly textColor: string;
  readonly effectColor: string;
  /** The effect colour's opacity, from 0 to 100; the text stays opaque. */
  readonly effectOpacity: number;
  /** How far the glow reaches (GLOW_STRENGTH); the glow effect's alone. */
  readonly glowStrength: number;
  readonly backdrop: OverlayBackdrop;
  readonly backdropColor: string;
  readonly backdropStrength: number;
  readonly position: OverlayPosition;
}

/** Which texts are drawn. */
export interface OverlayParts {
  readonly version?: boolean;
  readonly name?: boolean;
}

/** One layer of the version's style: any field, or none. */
export interface VersionStyle extends Partial<VersionLook> {
  readonly preset?: OverlayPreset;
  readonly parts?: OverlayParts;
}

// ── The effort marks ──────────────────────────────────────────────────────────────────────────

/** The four edges the marks stand on: a row along the top or the bottom, a column along a side. */
export const EFFORT_POSITIONS = ['top', 'bottom', 'left', 'right'] as const;
export type EffortPosition = (typeof EFFORT_POSITIONS)[number];
export const EFFORT_EFFECTS = ['plain', 'outline', 'glow'] as const;
export type EffortEffect = (typeof EFFORT_EFFECTS)[number];
/** A mark's diameter, and the gap between two, as percentages of the avatar's width. */
export const EFFORT_SIZE = { min: 3, max: 15 } as const;
export const EFFORT_SPACING = { min: 0, max: 10 } as const;

/** The marks' look as drawn: every field settled. */
export interface EffortLook {
  readonly position: EffortPosition;
  /**
   * Where a fast session's lightning bolt stands: one of the version's eight places. The bolt takes the
   * rest of this look — a starburst's size, the colour, effect and shade — whether or not the marks show.
   */
  readonly fastPosition: OverlayPosition;
  readonly size: number;
  readonly spacing: number;
  readonly color: string;
  readonly effect: EffortEffect;
  readonly effectColor: string;
  /** The effect colour's opacity, from 0 to 100; the marks stay opaque. */
  readonly effectOpacity: number;
  /** How far the glow reaches (GLOW_STRENGTH); the glow effect's alone. */
  readonly glowStrength: number;
  readonly backdrop: OverlayBackdrop;
  readonly backdropColor: string;
  readonly backdropStrength: number;
}

/** One layer of the marks' style: any field, or none. */
export interface EffortStyle extends Partial<EffortLook> {
  readonly show?: boolean;
}

/**
 * fat-g's marks: white, outlined in black, centred along the bottom; the fast bolt at the top left, a
 * corner no preset gives the version (the top right, the bottom, the bottom right) and the marks never take.
 */
export const DEFAULT_EFFORT_LOOK: EffortLook = { position: 'bottom', fastPosition: 'top-left', size: 7, spacing: 2, color: '#ffffff', effect: 'outline', effectColor: '#000000', effectOpacity: 100, glowStrength: 100, backdrop: 'none', backdropColor: '#000000', backdropStrength: 60 };

/** How an effort is drawn: so many marks of one shape. */
export interface EffortMarks {
  readonly count: number;
  readonly shape: 'dot' | 'star';
}

/**
 * The marks of each effort, by the normalized id every provider's catalog gives it — never by its
 * place in a model's list, so Medium is two dots on every model: Low to Max one dot to five, Ultra
 * five starbursts. An id not here draws none.
 */
const MARKS: Readonly<Record<string, EffortMarks>> = {
  low: { count: 1, shape: 'dot' },
  medium: { count: 2, shape: 'dot' },
  high: { count: 3, shape: 'dot' },
  xhigh: { count: 4, shape: 'dot' },
  max: { count: 5, shape: 'dot' },
  ultra: { count: 5, shape: 'star' },
};

/** The efforts that have marks, lightest first. */
export const MARKED_EFFORTS = Object.keys(MARKS);

export function effortMarks(effort: string | null | undefined): EffortMarks | null {
  return effort != null && Object.hasOwn(MARKS, effort) ? (MARKS[effort] ?? null) : null;
}

// ── The layers ────────────────────────────────────────────────────────────────────────────────

/** One layer of the overlay, the family's or an avatar's: the version's style and the marks'. */
export interface OverlayLayer {
  readonly version?: VersionStyle;
  readonly effort?: EffortStyle;
}

/** What an avatar's overlay draws; the effort marks' count is the session's, given where it is drawn. */
export interface ResolvedOverlay {
  /** The texts and their look; null where the style hides them or no text is left. */
  readonly text: { readonly name: string | null; readonly version: string | null; readonly look: VersionLook } | null;
  /** The marks' look; null where the style hides them. */
  readonly effort: EffortLook | null;
  /** The fast bolt's look: the marks', whether or not they show, drawn where the session is fast. */
  readonly fast: EffortLook;
}

const colour = z.string().regex(HEX);
const size = z.number().int().min(OVERLAY_SIZE.min).max(OVERLAY_SIZE.max);
const strength = z.number().int().min(OVERLAY_STRENGTH.min).max(OVERLAY_STRENGTH.max);
const glow = z.number().int().min(GLOW_STRENGTH.min).max(GLOW_STRENGTH.max);
const markSize = z.number().int().min(EFFORT_SIZE.min).max(EFFORT_SIZE.max);
const spacing = z.number().int().min(EFFORT_SPACING.min).max(EFFORT_SPACING.max);

/** A version style as a window sends one: every field checked, nothing else accepted. */
export const VersionStyleSchema: z.ZodType<VersionStyle> = z.strictObject({
  preset: z.enum(OVERLAY_PRESETS).optional(),
  parts: z.strictObject({ version: z.boolean().optional(), name: z.boolean().optional() }).optional(),
  effect: z.enum(OVERLAY_EFFECTS).optional(),
  size: size.optional(),
  textColor: colour.optional(),
  effectColor: colour.optional(),
  effectOpacity: strength.optional(),
  glowStrength: glow.optional(),
  backdrop: z.enum(OVERLAY_BACKDROPS).optional(),
  backdropColor: colour.optional(),
  backdropStrength: strength.optional(),
  position: z.enum(OVERLAY_POSITIONS).optional(),
});

/** An effort style as a window sends one. */
export const EffortStyleSchema: z.ZodType<EffortStyle> = z.strictObject({
  show: z.boolean().optional(),
  position: z.enum(EFFORT_POSITIONS).optional(),
  fastPosition: z.enum(OVERLAY_POSITIONS).optional(),
  size: markSize.optional(),
  spacing: spacing.optional(),
  color: colour.optional(),
  effect: z.enum(EFFORT_EFFECTS).optional(),
  effectColor: colour.optional(),
  effectOpacity: strength.optional(),
  glowStrength: glow.optional(),
  backdrop: z.enum(OVERLAY_BACKDROPS).optional(),
  backdropColor: colour.optional(),
  backdropStrength: strength.optional(),
});

export const OverlayLayerSchema: z.ZodType<OverlayLayer> = z.strictObject({ version: VersionStyleSchema.optional(), effort: EffortStyleSchema.optional() });

/** Each field's own check, by which a file's style is read field by field. */
const VERSION_FIELDS = {
  preset: z.enum(OVERLAY_PRESETS),
  effect: z.enum(OVERLAY_EFFECTS),
  size,
  textColor: colour,
  effectColor: colour,
  effectOpacity: strength,
  glowStrength: glow,
  backdrop: z.enum(OVERLAY_BACKDROPS),
  backdropColor: colour,
  backdropStrength: strength,
  position: z.enum(OVERLAY_POSITIONS),
} as const;

const EFFORT_FIELDS = {
  show: z.boolean(),
  position: z.enum(EFFORT_POSITIONS),
  fastPosition: z.enum(OVERLAY_POSITIONS),
  size: markSize,
  spacing,
  color: colour,
  effect: z.enum(EFFORT_EFFECTS),
  effectColor: colour,
  effectOpacity: strength,
  glowStrength: glow,
  backdrop: z.enum(OVERLAY_BACKDROPS),
  backdropColor: colour,
  backdropStrength: strength,
} as const;

const plain = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

function readFields(raw: Readonly<Record<string, unknown>>, fields: Readonly<Record<string, z.ZodType>>, style: Record<string, unknown>, dropped: string[], at: string): void {
  for (const [field, schema] of Object.entries(fields)) {
    if (!(field in raw)) continue;
    const read = schema.safeParse(raw[field]);
    if (read.success) style[field] = read.data;
    else dropped.push(`${at}${field}`);
  }
}

function readVersion(raw: Readonly<Record<string, unknown>>, dropped: string[], at: string): VersionStyle {
  const style: Record<string, unknown> = {};
  readFields(raw, VERSION_FIELDS, style, dropped, at);
  if ('parts' in raw) {
    const parts = raw['parts'];
    if (!plain(parts)) dropped.push(`${at}parts`);
    else {
      const kept: Record<string, boolean> = {};
      for (const part of ['version', 'name'] as const) {
        if (!(part in parts)) continue;
        if (typeof parts[part] === 'boolean') kept[part] = parts[part];
        else dropped.push(`${at}parts.${part}`);
      }
      style['parts'] = kept;
    }
  }
  return style;
}

/**
 * A layer as a file holds it: each known field kept when it is of its form, dropped when not, and
 * named in `dropped` by its path under the layer (`version.size`; empty for the layer itself); a field
 * this build does not know is skipped without a word.
 */
export function readOverlayLayer(raw: unknown): { readonly layer: OverlayLayer; readonly dropped: readonly string[] } {
  if (!plain(raw)) return { layer: {}, dropped: raw === undefined ? [] : [''] };
  const dropped: string[] = [];
  const layer: { version?: VersionStyle; effort?: EffortStyle } = {};
  if ('version' in raw) {
    if (plain(raw['version'])) layer.version = readVersion(raw['version'], dropped, 'version.');
    else dropped.push('version');
  }
  if ('effort' in raw) {
    if (plain(raw['effort'])) {
      const style: Record<string, unknown> = {};
      readFields(raw['effort'], EFFORT_FIELDS, style, dropped, 'effort.');
      layer.effort = style;
    } else dropped.push('effort');
  }
  return { layer, dropped };
}

/** Each preset's look in full. */
export const PRESET_LOOKS: Readonly<Record<OverlayPreset, VersionLook>> = {
  badge: { effect: 'outline', size: 22, textColor: '#ffffff', effectColor: '#000000', effectOpacity: 100, glowStrength: 100, backdrop: 'none', backdropColor: '#000000', backdropStrength: 75, position: 'top-right' },
  glow: { effect: 'glow', size: 24, textColor: '#ffffff', effectColor: '#7fc4ff', effectOpacity: 100, glowStrength: 100, backdrop: 'none', backdropColor: '#000000', backdropStrength: 75, position: 'top-right' },
  band: { effect: 'plain', size: 17, textColor: '#ffffff', effectColor: '#000000', effectOpacity: 100, glowStrength: 100, backdrop: 'shade', backdropColor: '#000000', backdropStrength: 75, position: 'bottom' },
  chip: { effect: 'chip', size: 14, textColor: '#000000', effectColor: '#ffffff', effectOpacity: 100, glowStrength: 100, backdrop: 'none', backdropColor: '#000000', backdropStrength: 75, position: 'bottom-right' },
};

/** Where every version style starts: the badge, the version alone. */
const DEFAULT_PARTS: Required<OverlayParts> = { version: true, name: false };

export const VERSION_LOOK_FIELDS = ['effect', 'size', 'textColor', 'effectColor', 'effectOpacity', 'glowStrength', 'backdrop', 'backdropColor', 'backdropStrength', 'position'] as const;
export const EFFORT_LOOK_FIELDS = ['position', 'fastPosition', 'size', 'spacing', 'color', 'effect', 'effectColor', 'effectOpacity', 'glowStrength', 'backdrop', 'backdropColor', 'backdropStrength'] as const;

/**
 * What a family's `family.json` is made with where it has none: fat-g's defaults written out whole,
 * so that whoever opens the file sees every field it may change.
 */
export const SEEDED_OVERLAY: Required<OverlayLayer> = {
  version: { parts: DEFAULT_PARTS, ...PRESET_LOOKS.badge },
  effort: { show: true, ...DEFAULT_EFFORT_LOOK },
};

/** The version's layers merged, in order: a later field wins, and a later preset replaces the look before it. */
export function mergeVersionStyles(layers: readonly (VersionStyle | undefined)[]): { readonly look: VersionLook; readonly parts: Required<OverlayParts> } {
  let look: VersionLook = PRESET_LOOKS.badge;
  let parts = DEFAULT_PARTS;
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (layer.preset !== undefined) look = PRESET_LOOKS[layer.preset];
    const own: Partial<Record<(typeof VERSION_LOOK_FIELDS)[number], unknown>> = {};
    for (const field of VERSION_LOOK_FIELDS) if (layer[field] !== undefined) own[field] = layer[field];
    look = { ...look, ...own } as VersionLook;
    if (layer.parts !== undefined) parts = { ...parts, ...layer.parts };
  }
  return { look, parts };
}

/** The marks' layers merged, in order: a later field wins. */
export function mergeEffortStyles(layers: readonly (EffortStyle | undefined)[]): { readonly look: EffortLook; readonly show: boolean } {
  let look: EffortLook = DEFAULT_EFFORT_LOOK;
  let show = true;
  for (const layer of layers) {
    if (layer === undefined) continue;
    const own: Partial<Record<(typeof EFFORT_LOOK_FIELDS)[number], unknown>> = {};
    for (const field of EFFORT_LOOK_FIELDS) if (layer[field] !== undefined) own[field] = layer[field];
    look = { ...look, ...own } as EffortLook;
    if (layer.show !== undefined) show = layer.show;
  }
  return { look, show };
}

/**
 * The Family default's texts, fixed: it stands for any model no avatar suits, so it always says the
 * model's short name and version, whatever the Default style's Name and Version — which its other
 * avatars inherit, this layer being the Default folder's alone.
 */
export const FAMILY_DEFAULT_LAYER: OverlayLayer = { version: { parts: { name: true, version: true } } };

/** An avatar's layers: its family's, then its own; for the family's `Default` folder, the fixed texts. */
export function avatarLayers(family: OverlayLayer | undefined, own: OverlayLayer | undefined, isDefault: boolean): readonly (OverlayLayer | undefined)[] {
  return isDefault ? [family, FAMILY_DEFAULT_LAYER] : [family, own];
}

/** A colour by its six lower-case digits, so `#FFF` and `#ffffff` are one; any other value as it is. */
const settled = (value: unknown): unknown => (typeof value === 'string' && HEX.test(value) ? (value.length === 4 ? `#${[...value.slice(1)].map((digit) => digit + digit).join('')}` : value).toLowerCase() : value);

type MergedVersion = ReturnType<typeof mergeVersionStyles>;
type MergedEffort = ReturnType<typeof mergeEffortStyles>;
const sameVersion = (a: MergedVersion, b: MergedVersion): boolean =>
  a.parts.name === b.parts.name && a.parts.version === b.parts.version && VERSION_LOOK_FIELDS.every((field) => settled(a.look[field]) === settled(b.look[field]));
const sameEffort = (a: MergedEffort, b: MergedEffort): boolean => a.show === b.show && EFFORT_LOOK_FIELDS.every((field) => settled(a.look[field]) === settled(b.look[field]));

/** A style's part with one field gone; undefined when none is left. */
function omitted<T extends object>(part: T, field: string): T | undefined {
  const rest: Record<string, unknown> = { ...(part as Record<string, unknown>) };
  delete rest[field];
  return Object.keys(rest).length > 0 ? (rest as T) : undefined;
}

/**
 * A layer's overrides: the fields that change something over the layers under it, each other one
 * taken away in turn. A field equal to what it inherits overrides nothing, so one that a change below
 * has come to agree with ends there, and the layer follows the layers under it in that field from then
 * on. The style is compared whole, not as drawn: the look of a hidden text stays, to show with it again.
 */
export function overridesOf(layer: OverlayLayer, below: readonly (OverlayLayer | undefined)[]): OverlayLayer {
  const versions = below.map((under) => under?.version);
  let version: VersionStyle | undefined = layer.version;
  if (version !== undefined) {
    const wanted = mergeVersionStyles([...versions, version]);
    const alike = (candidate: VersionStyle | undefined): boolean => sameVersion(mergeVersionStyles([...versions, candidate]), wanted);
    for (const part of ['name', 'version'] as const) {
      const parts: OverlayParts | undefined = version?.parts;
      if (version === undefined || parts?.[part] === undefined) continue;
      const rest: OverlayParts | undefined = omitted(parts, part);
      const candidate: VersionStyle | undefined = rest === undefined ? omitted(version, 'parts') : { ...version, parts: rest };
      if (alike(candidate)) version = candidate;
    }
    for (const field of [...VERSION_LOOK_FIELDS, 'preset'] as const) {
      if (version === undefined || version[field] === undefined) continue;
      const candidate: VersionStyle | undefined = omitted(version, field);
      if (alike(candidate)) version = candidate;
    }
  }
  const efforts = below.map((under) => under?.effort);
  let effort: EffortStyle | undefined = layer.effort;
  if (effort !== undefined) {
    const wanted = mergeEffortStyles([...efforts, effort]);
    for (const field of ['show', ...EFFORT_LOOK_FIELDS] as const) {
      if (effort === undefined || effort[field] === undefined) continue;
      const candidate: EffortStyle | undefined = omitted(effort, field);
      if (sameEffort(mergeEffortStyles([...efforts, candidate]), wanted)) effort = candidate;
    }
  }
  return { ...(version !== undefined && Object.keys(version).length > 0 ? { version } : {}), ...(effort !== undefined && Object.keys(effort).length > 0 ? { effort } : {}) };
}

/**
 * What an avatar draws over it: the layers merged, then the texts its parts ask for, the marks' look,
 * and the fast bolt's — the marks' look whatever their `show`, so a style that hides the text and the
 * marks still has the bolt to draw for a fast session.
 */
export function resolveOverlay(layers: readonly (OverlayLayer | undefined)[], texts: { readonly name: string | null; readonly version: string | null }): ResolvedOverlay {
  const version = mergeVersionStyles(layers.map((layer) => layer?.version));
  const name = version.parts.name ? texts.name : null;
  const number = version.parts.version ? texts.version : null;
  const text = name === null && number === null ? null : { name, version: number, look: version.look };
  const marks = mergeEffortStyles(layers.map((layer) => layer?.effort));
  return { text, effort: marks.show ? marks.look : null, fast: marks.look };
}

/** Whether two overlays draw the same. */
export function sameOverlay(a: ResolvedOverlay | null | undefined, b: ResolvedOverlay | null | undefined): boolean {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  const sameText = a.text === null || b.text === null
    ? a.text === b.text
    : a.text.name === b.text.name && a.text.version === b.text.version && VERSION_LOOK_FIELDS.every((field) => a.text?.look[field] === b.text?.look[field]);
  const sameEffort = a.effort === null || b.effort === null ? a.effort === b.effort : EFFORT_LOOK_FIELDS.every((field) => a.effort?.[field] === b.effort?.[field]);
  const sameFast = EFFORT_LOOK_FIELDS.every((field) => a.fast[field] === b.fast[field]);
  return sameText && sameEffort && sameFast;
}

// ── The texts ─────────────────────────────────────────────────────────────────────────────────

/** A model's version and short name as its provider reads them from its identifiers. */
export interface ModelLabel {
  readonly version: string | null;
  readonly name: string | null;
}

export const NO_LABEL: ModelLabel = { version: null, name: null };

/** A provider's text, bounded as a label is: letters, digits and dots, at most 16. */
const PROVIDER_LABEL = /^[A-Za-z0-9.]{1,16}$/;

/** A provider's reading kept only when it is of the bounded form. */
export function boundedLabel(label: ModelLabel): ModelLabel {
  const keep = (value: string | null): string | null => (value !== null && PROVIDER_LABEL.test(value) ? value : null);
  return { version: keep(label.version), name: keep(label.name) };
}

/** A model read by its provider: its resolved id's reading, else its key's where the id gives nothing. */
export function readModelLabel(read: (id: string) => ModelLabel, model: { readonly key: string; readonly resolvedId: string | null }): ModelLabel {
  const byId = model.resolvedId === null ? NO_LABEL : read(model.resolvedId);
  return byId.version !== null || byId.name !== null ? byId : read(model.key);
}

/** A captured word as a label shows it: its first letter upper-cased, the rest as captured. */
export function labelWord(word: string | undefined): string | null {
  return word === undefined || word === '' ? null : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}
