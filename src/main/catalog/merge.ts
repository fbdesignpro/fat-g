// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The merge (docs/planning/_archive/M13.md, Design 3; decision 0013): one provider's defaults, its CLI's report
// when there is one, and the user's override when it is valid go in, and its catalog entry comes
// out. Pure: no file, no clock, no Electron.
//
//   Which models, in which order   the report's (C11), then the override adds (C18); without a
//                                  report, none — the override's included (C94)
//   Name, description, resolved id the report's; a model with no name is shown by its key (C77)
//   Effort levels                  the report's ids; labels, caution and order from the defaults
//                                  (C70); the override relabels, and replaces a model's list
//   Everything else                the report's (C7, C8, C17); the override last
//
// The defaults hold no model (C75): what fat-g lists is what the user's own CLI reports. The override
// adjusts that list, so without one it has nothing to stand on: an entry that hides or renames a
// model would otherwise be listed as a model of its own.
import {
  type CatalogDefaults,
  type CatalogEffort,
  type CatalogModel,
  type CatalogProvider,
  type CatalogSpeedTier,
  catalogName,
  MAX_MODELS,
  type ModelReport,
  type ReportedModel,
} from '@shared/contracts/catalog';
import { FIRST_INSTANCE_ID, type InstanceId } from '@shared/contracts/instances';
import type { ProviderId } from '@shared/contracts/provider';

/** What the override says of one model; a field left out is not set (C38). Values are already bounded. */
export interface ModelOverride {
  readonly name?: string;
  readonly description?: string | null;
  readonly resolvedId?: string | null;
  /** Ids, in the file's order. */
  readonly efforts?: readonly string[];
  readonly listedDefaultEffort?: string | null;
  /** A tier named by id alone takes the name it has in the report, else its id. */
  readonly speedTiers?: readonly { readonly id: string; readonly name?: string; readonly description?: string | null }[];
  readonly hidden?: boolean;
}

/** What the override says of one provider (C37, C38). */
export interface ProviderOverride {
  /** Labels and caution flags by effort id, for every model of the provider. */
  readonly efforts: ReadonlyMap<string, { readonly label?: string; readonly caution?: boolean }>;
  /** By key, in the file's order. */
  readonly models: readonly (readonly [string, ModelOverride])[];
}

export interface MergeInput {
  readonly id: ProviderId;
  /** The instance the report is of (M14b, C20); the provider's first when none is named. */
  readonly instanceId?: InstanceId;
  /** Already checked against the contract (src/main/catalog/defaults.ts). */
  readonly defaults: CatalogDefaults;
  /** The CLI's report and when it was first reported, or null. */
  readonly report: { readonly report: ModelReport; readonly at: number } | null;
  readonly override: ProviderOverride | null;
}

/** How many models the override changed, added and hid, for Settings' note (C57). */
export interface OverrideCounts {
  readonly changed: number;
  readonly added: number;
  readonly hidden: number;
}

export interface MergeResult {
  readonly provider: CatalogProvider;
  readonly counts: OverrideCounts;
}

interface Label {
  readonly label: string;
  readonly caution: boolean;
  readonly warning?: string;
}

export function mergeCatalog({ id, instanceId = FIRST_INSTANCE_ID, defaults, report, override }: MergeInput): MergeResult {
  // A report with no model defines no list: one bad answer must not remove every model (C15).
  const used = report !== null && report.report.models.length > 0 ? report : null;
  const order = defaults.efforts.map((effort) => effort.id);
  const labels = labelTable(defaults, override);
  const listed: CatalogModel[] = used === null ? [] : used.report.models.map((model) => fromReport(model, order, labels));
  const { models, counts } = override === null || used === null ? { models: listed, counts: { changed: 0, added: 0, hidden: 0 } } : applyOverride(listed, override, labels, used.report);

  return {
    provider: {
      id,
      instanceId,
      presentation: defaults.presentation,
      source: used === null ? { kind: 'none' } : { kind: 'report', at: used.at },
      speedTierRequest: { possible: defaults.canRequestSpeedTier, reason: used?.report.speedTierReason ?? null },
      models,
    },
    counts,
  };
}

/** The report's model, in its own words; one with no name is shown by its key (C11, C77). */
function fromReport(model: ReportedModel, order: readonly string[], labels: ReadonlyMap<string, Label>): CatalogModel {
  return {
    key: model.key,
    resolvedId: model.resolvedId,
    name: model.name ?? catalogName(model.key) ?? model.key,
    description: model.description,
    efforts: efforts(inOrder(model.efforts, order), labels, model.effortDescriptions),
    listedDefaultEffort: model.listedDefaultEffort,
    listedDefault: model.listedDefault,
    hidden: model.hidden,
    speedTiers: model.speedTiers,
    origin: 'reported',
    overridden: false,
    hiddenByOverride: false,
    avatar: null,
  };
}

/**
 * Known levels in the defaults' order; a level the defaults do not know right after the one it
 * followed in the report, or first when nothing did (C70). Both CLIs report in ascending order today.
 */
export function inOrder(ids: readonly string[], order: readonly string[]): string[] {
  const known = (id: string): boolean => order.includes(id);
  const result = ids.filter(known).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  ids.forEach((id, index) => {
    if (known(id)) return;
    const before = index === 0 ? -1 : result.indexOf(ids[index - 1] ?? '');
    result.splice(before + 1, 0, id);
  });
  return result;
}

/**
 * Labels, caution flags and warnings by id: the defaults', then the override's labels and flags (C38).
 * An unknown id is its own label.
 */
function labelTable(defaults: CatalogDefaults, override: ProviderOverride | null): ReadonlyMap<string, Label> {
  const table = new Map<string, Label>(defaults.efforts.map((effort) => [effort.id, { label: effort.label, caution: effort.caution ?? false, ...(effort.warning === undefined ? {} : { warning: effort.warning }) }]));
  for (const [id, change] of override?.efforts ?? []) {
    const current = table.get(id);
    table.set(id, { label: change.label ?? current?.label ?? id, caution: change.caution ?? current?.caution ?? false, ...(current?.warning === undefined ? {} : { warning: current.warning }) });
  }
  return table;
}

/** The levels of `ids`, each with its label, its flag, its warning and what the CLI said of it. */
function efforts(ids: readonly string[], labels: ReadonlyMap<string, Label>, said: Readonly<Record<string, string>> = {}): CatalogEffort[] {
  return [...new Set(ids)].map((id, index) => {
    const known = labels.get(id);
    const description = Object.hasOwn(said, id) ? said[id] : undefined;
    return {
      id,
      label: known?.label ?? catalogName(id) ?? id,
      place: index + 1,
      caution: known?.caution ?? false,
      ...(description === undefined ? {} : { description }),
      ...(known?.warning === undefined ? {} : { warning: known.warning }),
    };
  });
}

/** What the CLI said of a model's levels, as its catalog entry holds it. */
function saidOf(model: CatalogModel): Readonly<Record<string, string>> {
  return Object.fromEntries(model.efforts.flatMap((effort) => (effort.description === undefined ? [] : [[effort.id, effort.description]])));
}

/** Last, and it wins (C18): named fields replaced, new keys added at the end in the file's order. */
function applyOverride(
  listed: readonly CatalogModel[],
  override: ProviderOverride,
  labels: ReadonlyMap<string, Label>,
  report: ModelReport,
): { models: CatalogModel[]; counts: OverrideCounts } {
  const models = listed.map((model) => relabel(model, labels));
  const index = new Map(models.map((model, at) => [model.key, at]));
  let changed = 0;
  let added = 0;
  let hidden = 0;
  for (const [key, change] of override.models) {
    const at = index.get(key);
    const current = at === undefined ? undefined : models[at];
    if (at === undefined || current === undefined) {
      if (models.length >= MAX_MODELS) continue;
      const model = adjust(newModel(key), change, labels, [], report);
      index.set(key, models.length);
      models.push({ ...model, origin: 'override', overridden: false });
      added += 1;
      if (model.hiddenByOverride) hidden += 1;
    } else {
      const model = adjust(current, change, labels, current.speedTiers, report);
      models[at] = model;
      if (model.overridden) changed += 1;
      if (model.hiddenByOverride) hidden += 1;
    }
  }
  return { models, counts: { changed, added, hidden } };
}

/** The override's labels reach every model's levels, whichever layer listed them (C38). */
function relabel(model: CatalogModel, labels: ReadonlyMap<string, Label>): CatalogModel {
  return { ...model, efforts: efforts(model.efforts.map((effort) => effort.id), labels, saidOf(model)) };
}

function newModel(key: string): CatalogModel {
  return {
    key,
    resolvedId: null,
    name: catalogName(key) ?? key,
    description: null,
    efforts: [],
    listedDefaultEffort: null,
    listedDefault: false,
    hidden: false,
    speedTiers: [],
    origin: 'override',
    overridden: false,
    hiddenByOverride: false,
    avatar: null,
  };
}

function adjust(
  model: CatalogModel,
  change: ModelOverride,
  labels: ReadonlyMap<string, Label>,
  ownTiers: readonly CatalogSpeedTier[],
  report: ModelReport,
): CatalogModel {
  // Hiding alone is its own mark; any other field named, showing included, is a change.
  const changes = Object.entries(change).some(([field, value]) => value !== undefined && !(field === 'hidden' && value === true));
  return {
    ...model,
    ...(change.name === undefined ? {} : { name: change.name }),
    ...(change.description === undefined ? {} : { description: change.description }),
    ...(change.resolvedId === undefined ? {} : { resolvedId: change.resolvedId }),
    // The file's order, not the defaults' (Design 3).
    ...(change.efforts === undefined ? {} : { efforts: efforts(change.efforts, labels, saidOf(model)) }),
    ...(change.listedDefaultEffort === undefined ? {} : { listedDefaultEffort: change.listedDefaultEffort }),
    ...(change.speedTiers === undefined ? {} : { speedTiers: change.speedTiers.map((tier) => namedTier(tier, ownTiers, report)) }),
    ...(change.hidden === undefined ? {} : { hidden: change.hidden }),
    overridden: changes,
    hiddenByOverride: change.hidden === true,
  };
}

/**
 * A tier the file names by id alone takes its name from the model or the report, else its id. Its
 * warning is the provider module's alone: the file names none, and a known tier keeps its own.
 */
function namedTier(tier: NonNullable<ModelOverride['speedTiers']>[number], ownTiers: readonly CatalogSpeedTier[], report: ModelReport): CatalogSpeedTier {
  const known = [ownTiers, ...report.models.map((model) => model.speedTiers)]
    .flat()
    .find((candidate) => candidate.id === tier.id);
  return {
    id: tier.id,
    name: tier.name ?? known?.name ?? catalogName(tier.id) ?? tier.id,
    description: tier.description !== undefined ? tier.description : known?.description ?? null,
    ...(known?.warning === undefined ? {} : { warning: known.warning }),
  };
}
