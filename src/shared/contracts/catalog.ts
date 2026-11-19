// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The provider, model and effort catalog (docs/planning/_archive/M13.md, decision 0013): what each provider
// offers, built in main from three layers — the provider module's defaults, the CLI's report, and
// the user's own catalog.json — and carried to the Main window inside the app state. The Pet never
// receives it (src/main/state/projection.ts). The models themselves come only from the user's own
// CLI: no list ships with fat-g (C75).
//
// Renderer-safe: types, schemas, bounds and pure helpers only, importing nothing from main, so main
// and the page resolve a model the same way (C49).
import { z } from 'zod';
import type { ModelLabel } from './avatar-overlay';
import type { ResolvedAvatar } from './avatars';
import { NAME_MAX_GRAPHEMES, normalizeText } from './names';
import { type InstanceId, type InstanceRef, sameInstance } from './instances';
import type { ProviderId } from './provider';

// ── The override file (C35, C36, C41) ──────────────────────────────────────────────────────────

/** The user's override, beside preferences.json in fat-g's data folder. fat-g only ever reads it. */
export const CATALOG_FILE = 'catalog.json';
/** The format this build reads and would write: `schemaVersion` and `minReaderVersion` both 1. */
export const CATALOG_VERSION = 1;
/** A larger file is ignored whole, unread. */
export const CATALOG_MAX_BYTES = 256 * 1024;

// ── Bounds (C9) ───────────────────────────────────────────────────────────────────────────────

export const CATALOG_ID_MAX = 128;
export const CATALOG_NAME_MAX = NAME_MAX_GRAPHEMES;
export const CATALOG_DESCRIPTION_MAX = 200;
export const MAX_MODELS = 200;
export const MAX_EFFORTS = 16;
export const MAX_SPEED_TIERS = 8;

/** A key, a resolved id, an effort id, a tier id or a reason: what a CLI accepts, never prose. */
const ID = /^[A-Za-z0-9._\-:/@[\]]{1,128}$/;

/** The value when it is a bounded id, else null. */
export function catalogId(value: string): string | null {
  return ID.test(value) ? value : null;
}

/** The values once each, when every one is a bounded id and there are at most `max`; else null. */
export function catalogIds(values: readonly string[], max: number): string[] | null {
  const unique = [...new Set(values)];
  return unique.length > max || unique.some((value) => catalogId(value) === null) ? null : unique;
}

/** Cleaned and clamped to 60 grapheme clusters, as a project's name is; null when nothing is left. */
export function catalogName(value: string): string | null {
  const text = normalizeText(value, CATALOG_NAME_MAX);
  return text === '' ? null : text;
}

/** Cleaned and clamped to 200 grapheme clusters; null when nothing is left. */
export function catalogDescription(value: string): string | null {
  const text = normalizeText(value, CATALOG_DESCRIPTION_MAX);
  return text === '' ? null : text;
}

// ── Presentation (C21) ────────────────────────────────────────────────────────────────────────

/**
 * A fallback mark, drawn from path data in the provider's bar colour.
 */
export interface ProviderIcon {
  /** e.g. `0 0 24 24`. */
  readonly viewBox: string;
  /** SVG path data: commands and numbers only. */
  readonly path: string;
}

/**
 * A provider's light stream for the status bar (M100, Design 7): the ground a running bar warms to,
 * and the six tones its rectangles take. The rectangles are composited onto the ground with
 * `plus-lighter`, so the tones add rather than cover — a blue or a green ramp therefore wants less
 * lightness than a warm one for the same field. Which of the twelve rectangles takes which tone is
 * the shared status-stream stylesheet's (ui/status-stream/StatusStream.module.css), not a module's.
 */
export interface ProviderStream {
  /** What a running bar's ground warms to, as `#rrggbb`. */
  readonly ground: string;
  /** The six tones, as `#rrggbb`, darkest first. */
  readonly lights: readonly [string, string, string, string, string, string];
  /** Optional glow PNG, WebP or JPEG, bundled inline by the provider module. */
  readonly image?: string;
}

/**
 * How a provider looks: its module's, and nothing else's — the override never reaches it (C39).
 * Plain data: it crosses IPC inside every snapshot.
 */
export interface ProviderPresentation {
  /** The usage bars' fill and the mark's colour, as `#rrggbb`. */
  readonly barColor: string;
  readonly icon: ProviderIcon;
  /**
   * The module's logo, as a `data:image/…;base64,` address: its
   * `logo.png`, never in `catalog-defaults.json`. Without one the box draws the mark on the colour.
   */
  readonly logo?: string | undefined;
  /**
   * Its stream in the status bar. A module that declares none leaves its running bar black, with its
   * word in white and no field — as a provider this build does not have is drawn.
   */
  readonly stream?: ProviderStream | undefined;
}

// ── The catalog (C2–C8, C67) ──────────────────────────────────────────────────────────────────

export interface CatalogEffort {
  readonly id: string;
  readonly label: string;
  /** Its place in the model's list, counted from 1 (C5, C70). */
  readonly place: number;
  /** Kept out of plain cycling (C23): Codex's `ultra` delegates tasks and costs the most. */
  readonly caution: boolean;
  /** What the CLI says of the level, where it says anything (Codex's descriptions). */
  readonly description?: string;
  /**
   * What choosing it costs, where its provider's module says: shown wherever the level is chosen.
   * Apart from `caution`, which alone keeps a level from being chosen for the user.
   */
  readonly warning?: string;
}

export interface CatalogSpeedTier {
  /** What asks for it: Codex's service tier, or Claude's `fast`. */
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** What choosing it costs, where its provider's module says (decision 0013): shown wherever the tier is chosen, as a level's is. */
  readonly warning?: string;
}

/** Where a model came from: the CLI's report, the user's file, or a lookup (C48, C78). */
export type CatalogModelOrigin = 'reported' | 'override' | 'generic';

export interface CatalogModel {
  /** What the CLI accepts to select it (C4): Claude's `value`, Codex's `id`. */
  readonly key: string;
  /** What a session reports for it: Claude's `resolvedModel`, Codex's `model`. */
  readonly resolvedId: string | null;
  readonly name: string;
  readonly description: string | null;
  /** In the order they are shown. Empty: the model has no effort (C6). */
  readonly efforts: readonly CatalogEffort[];
  /** What the CLI lists as the default effort — a hint, never what a session runs with (C7). */
  readonly listedDefaultEffort: string | null;
  /** The CLI lists it as its default model (C7). */
  readonly listedDefault: boolean;
  /** Never offered for choosing; still found when a session reports it (C17). */
  readonly hidden: boolean;
  /** In the CLI's order. Empty: none (C8). */
  readonly speedTiers: readonly CatalogSpeedTier[];
  readonly origin: CatalogModelOrigin;
  /** The override changed a field of a model the list already held (C3); hiding it alone does not count. */
  readonly overridden: boolean;
  /** The override hid it (C18). */
  readonly hiddenByOverride: boolean;
  /**
   * What its tile draws (M102, C29): resolved by main, in M102 its provider's default face; null for
   * none, and before the avatars' first scan lands (C57). M103 puts the model's own assignment first.
   */
  readonly avatar: ResolvedAvatar | null;
  /** Its version and short name as its provider reads its identifiers: the overlay's default texts (decision 0032). */
  readonly label?: ModelLabel;
}

export type CatalogSource =
  /** `at`: when the list in use was first reported, not the last poll that repeated it (C32). */
  | { readonly kind: 'report'; readonly at: number }
  /** The CLI has not reported its models: the provider lists none, the override's included (C94). */
  | { readonly kind: 'none' };

/**
 * One instance's models (M14b, C20): the presentation, the effort labels and the override are its
 * provider's, the report its own, since what an account lists depends on its plan.
 */
export interface CatalogProvider {
  readonly id: ProviderId;
  /** With `id`, the instance this entry is for. */
  readonly instanceId: InstanceId;
  readonly presentation: ProviderPresentation;
  /** The CLI's report, or none yet (C96). */
  readonly source: CatalogSource;
  /** Whether fat-g can ask for a speed tier at all, and the reason the CLI gives when it cannot (C67). */
  readonly speedTierRequest: { readonly possible: boolean; readonly reason: string | null };
  readonly models: readonly CatalogModel[];
  /** Newest visible, CLI-reported small model, chosen by the provider module; absent when none is known. */
  readonly smallModel?: string;
}

/** Why the override was ignored, in the order they are checked (C41). */
export const OVERRIDE_CAUSES = ['unreadable', 'too-large', 'not-json', 'damaged', 'newer', 'older', 'invalid'] as const;
export type OverrideCause = (typeof OVERRIDE_CAUSES)[number];

/** `path` is the file's full path in fat-g's data folder: where it is, or where it would go (C57). */
export type OverrideStatus =
  | { readonly kind: 'none'; readonly path: string }
  | {
      readonly kind: 'applied';
      readonly path: string;
      /** Models it changed, added and hid (C57). */
      readonly changed: number;
      readonly added: number;
      readonly hidden: number;
      /** Provider ids this build does not have, skipped (C42). */
      readonly unknownProviders: readonly string[];
    }
  | {
      readonly kind: 'ignored';
      readonly path: string;
      readonly cause: OverrideCause;
      /** The path of the first fault, such as `providers.codex.models.gpt-5.5.hidden`; for `invalid` only. */
      readonly field: string | null;
    };

/** The Main window's `AppStateSnapshot.catalog` (C50). */
export interface CatalogState {
  /** One entry per registered provider, in registry order (C2, C19). */
  readonly providers: readonly CatalogProvider[];
  readonly override: OverrideStatus;
}

// ── What main checks (C24, C26) ────────────────────────────────────────────────────────────────
// Both schemas are strict: fat-g writes what they check, so anything unexpected is a defect.

const id = z.string().regex(ID);
const name = z.string().refine((value) => value !== '' && normalizeText(value, CATALOG_NAME_MAX) === value, 'not a clean name');
const description = z.string().refine((value) => value !== '' && normalizeText(value, CATALOG_DESCRIPTION_MAX) === value, 'not a clean description');

// Drawn as attribute values, never parsed as markup — and still refused anything that is not a
// number list or path data (M11, C65).
const color = z.string().regex(/^#[0-9a-f]{6}$/);

const PresentationSchema = z.strictObject({
  barColor: color,
  icon: z.strictObject({
    viewBox: z.string().regex(/^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/),
    path: z.string().max(2000).regex(/^M[MLHVCSQTAZmlhvcsqtaz0-9.,\s-]+$/),
  }),
  stream: z.strictObject({ ground: color, lights: z.tuple([color, color, color, color, color, color]) }).optional(),
});

const SpeedTierSchema = z.strictObject({ id, name, description: description.nullable(), warning: description.optional() });

/**
 * A provider module's `catalog-defaults.json` (C75): how it looks and how its levels are shown. It
 * holds no model: those come from the user's own CLI.
 */
export interface CatalogDefaults {
  readonly presentation: ProviderPresentation;
  /** Whether fat-g can ask this provider for a speed tier at all (C67). */
  readonly canRequestSpeedTier: boolean;
  /** Every effort level's label, caution flag and warning, in the order levels are shown (C70). */
  readonly efforts: readonly { readonly id: string; readonly label: string; readonly caution?: boolean | undefined; readonly warning?: string | undefined }[];
}

/** A model as an adapter reports it, already mapped and bounded (C26). What it lacks is null. */
export interface ReportedModel {
  readonly key: string;
  readonly resolvedId: string | null;
  readonly name: string | null;
  readonly description: string | null;
  readonly efforts: readonly string[];
  /** What the CLI says of each level, by id, where it says anything. */
  readonly effortDescriptions?: Readonly<Record<string, string>> | undefined;
  readonly listedDefaultEffort: string | null;
  readonly listedDefault: boolean;
  readonly hidden: boolean;
  readonly speedTiers: readonly CatalogSpeedTier[];
}

/** The `models` event's report: nothing else of a CLI's reply leaves its adapter (C26). */
export interface ModelReport {
  readonly models: readonly ReportedModel[];
  /** Why the CLI will not let fat-g ask for a speed tier, when it says (C67). */
  readonly speedTierReason: string | null;
  /** Rows the adapter could not read and left out (C16). */
  readonly dropped: number;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const modelFields = {
  key: id,
  resolvedId: id.nullable(),
  efforts: z.array(id).max(MAX_EFFORTS).refine(unique, 'duplicate effort'),
  listedDefaultEffort: id.nullable(),
  listedDefault: z.boolean(),
  hidden: z.boolean(),
  speedTiers: z.array(SpeedTierSchema).max(MAX_SPEED_TIERS).refine((tiers) => unique(tiers.map((tier) => tier.id)), 'duplicate speed tier'),
};

// Strict: a `models` field, which an earlier draft of M13 shipped, is refused (C75).
export const CatalogDefaultsSchema: z.ZodType<CatalogDefaults> = z.strictObject({
  presentation: PresentationSchema,
  canRequestSpeedTier: z.boolean(),
  efforts: z
    .array(z.strictObject({ id, label: name, caution: z.boolean().optional(), warning: description.optional() }))
    .max(MAX_EFFORTS)
    .refine((efforts) => unique(efforts.map((effort) => effort.id)), 'duplicate effort'),
});

export const ModelReportSchema: z.ZodType<ModelReport> = z.strictObject({
  models: z
    .array(z.strictObject({ ...modelFields, name: name.nullable(), description: description.nullable(), effortDescriptions: z.record(id, description).optional() }))
    .max(MAX_MODELS)
    .refine((models) => unique(models.map((model) => model.key)), 'duplicate key'),
  speedTierReason: id.nullable(),
  dropped: z.number().int().min(0),
});

// ── Lookup (C46–C49) ──────────────────────────────────────────────────────────────────────────

/**
 * The catalog's model, in one instance's own entry (M14b, C28), for the id a session reports: one with that key; else one with that resolved
 * id, preferring one that is not the listed default (C47: Claude's `default` row resolves to the same
 * model as the row that names it); else the generic entry. Hidden models are found like the others.
 */
export function findModel(catalog: CatalogState | undefined, ref: InstanceRef, reportedId: string): CatalogModel {
  const models = catalog?.providers.find((provider) => sameInstance({ providerId: provider.id, instanceId: provider.instanceId }, ref))?.models ?? [];
  const byKey = models.find((model) => model.key === reportedId);
  if (byKey !== undefined) return byKey;
  const resolved = models.filter((model) => model.resolvedId === reportedId);
  return resolved.find((model) => !model.listedDefault) ?? resolved[0] ?? genericModel(reportedId);
}

/**
 * Whether an instance's own list names a model by its key (decision 0016): a session
 * keeps the exact version it was made with, and takes no prompt once its account no longer lists it.
 * Null while the instance's CLI has not reported, so nothing is decided on a list not yet given.
 * A hidden model counts: hiding chooses what is offered, not what may run.
 */
export function modelListed(catalog: CatalogState | undefined, ref: InstanceRef, key: string): boolean | null {
  const entry = catalog?.providers.find((provider) => sameInstance({ providerId: provider.id, instanceId: provider.instanceId }, ref));
  if (entry === undefined || entry.source.kind !== 'report') return null;
  return entry.models.some((model) => model.key === key);
}

/** A model the catalog does not know, made from the id a session reports; never added to the list (C48). */
export function genericModel(reportedId: string): CatalogModel {
  return {
    key: reportedId,
    resolvedId: reportedId,
    name: catalogName(reportedId) ?? 'Unknown model',
    description: null,
    efforts: [],
    listedDefaultEffort: null,
    listedDefault: false,
    hidden: false,
    speedTiers: [],
    origin: 'generic',
    overridden: false,
    hiddenByOverride: false,
    avatar: null,
  };
}
