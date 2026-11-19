// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Model presets (docs/planning/_archive/M14.md, Design 8; M14b.md, Design 8; decision 0016): a provider, one
// of its instances, a model, an effort and a speed tier — what every session start takes. Named
// preferences wrap this selection in saved-presets.ts; the session record keeps its five fields.
//
// Pure helpers, used by main to check and by the page to offer, so both resolve a key, pick a level
// and refuse a preset the same way (C94).
import { z } from 'zod';
import { availableInstances, unavailable } from './availability';
import { catalogId, type CatalogModel, type CatalogProvider, type CatalogState } from './catalog';
import { FIRST_INSTANCE_ID, type InstanceId, type InstanceRef, isInstanceId, sameInstance } from './instances';
import type { SessionRefusalReason, SessionView } from './sessions';
import type { ProviderCapabilities } from './provider';
import type { ProviderSnapshot } from './status';

export interface ModelPreset {
  readonly providerId: string;
  /** Which of the provider's instances runs the session (M14b, C25). */
  readonly instanceId: InstanceId;
  /** The catalog's key (M13, C4). */
  readonly model: string;
  /** Null for a model with no levels. */
  readonly effort: string | null;
  /**
   * A speed tier's id, as the model lists it (`CatalogModel.speedTiers`): Claude's `fast`, Codex's
   * service tier. Null for standard speed (decision 0016).
   */
  readonly speed: string | null;
}

const key = z.string().refine((value) => catalogId(value) !== null, 'not a catalog id');

export const ModelPresetSchema = z.strictObject({
  providerId: z.string().min(1).max(128),
  instanceId: z.string().refine(isInstanceId, 'not an instance id'),
  model: key,
  effort: key.nullable(),
  speed: key.nullable(),
});

/** One instance's tiles: the models the popup offers for it (C118; M14b, C25). `provider` is its catalog entry. */
export interface TileGroup {
  readonly provider: CatalogProvider;
  readonly tiles: readonly CatalogModel[];
}

/**
 * A provider's models as tiles: in the catalog's order, hidden ones left out, and a listed-default
 * row left out when another offered row resolves to the same model — Claude's "Default" row and the
 * row that names its model are one model (C118; M13, C47).
 */
export function providerTiles(provider: CatalogProvider): CatalogModel[] {
  const offered = provider.models.filter((model) => !model.hidden);
  return offered.filter(
    (model) => !(model.listedDefault && model.resolvedId !== null && offered.some((other) => other !== model && !other.listedDefault && other.resolvedId === model.resolvedId)),
  );
}

/** An instance's catalog entry: its provider's presentation, and the models its own CLI reported. */
export function catalogEntry(catalog: CatalogState | undefined, ref: InstanceRef): CatalogProvider | undefined {
  return catalog?.providers.find((provider) => sameInstance({ providerId: provider.id, instanceId: provider.instanceId }, ref));
}

/**
 * The tiles of these instances, in the app state's order: a group for each. An instance whose CLI
 * has not reported lists no model, so it has no tile and no group (C118).
 */
export function presetTiles(catalog: CatalogState | undefined, instances: readonly InstanceRef[]): TileGroup[] {
  return (catalog?.providers ?? [])
    .filter((provider) => instances.some((ref) => sameInstance(ref, { providerId: provider.id, instanceId: provider.instanceId })))
    .map((provider) => ({ provider, tiles: providerTiles(provider) }))
    .filter((group) => group.tiles.length > 0);
}

/**
 * The tile a key selects (C94): the tile with that key; else, for the key of a row the tiles leave
 * out, the tile that resolves to the same model. Null for a hidden or unknown key.
 */
export function resolveTileKey(provider: CatalogProvider | undefined, modelKey: string): CatalogModel | null {
  if (provider === undefined) return null;
  const tiles = providerTiles(provider);
  const tile = tiles.find((model) => model.key === modelKey);
  if (tile !== undefined) return tile;
  const row = provider.models.find((model) => model.key === modelKey);
  if (row === undefined || row.hidden || row.resolvedId === null) return null;
  return tiles.find((model) => model.resolvedId === row.resolvedId) ?? null;
}

/**
 * The level a model takes (C85, C94, C95): the wanted one when the model lists it; else its listed
 * default effort, when that is one of its levels; else the middle of its levels without the caution
 * flag, the upper one of two middles (the highest had made Claude's Max the default, where
 * the CLI's own is High); else its first level. Null for a model with no levels.
 */
export function effortFor(model: Pick<CatalogModel, 'efforts' | 'listedDefaultEffort'>, wanted: string | null): string | null {
  const ids = model.efforts.map((effort) => effort.id);
  if (wanted !== null && ids.includes(wanted)) return wanted;
  if (model.listedDefaultEffort !== null && ids.includes(model.listedDefaultEffort)) return model.listedDefaultEffort;
  const plain = model.efforts.filter((effort) => !effort.caution);
  return plain[Math.floor(plain.length / 2)]?.id ?? ids[0] ?? null;
}

/**
 * The default preset (C84; M14b, C27): the first group's listed default model — through
 * `resolveTileKey`, since that row may be one the tiles leave out — else its first tile, at the level
 * `effortFor` gives. The first group is the first offered provider's first switched-on instance
 * that lists a model.
 */
export function defaultPreset(groups: readonly TileGroup[]): ModelPreset | null {
  const [first] = groups;
  if (first === undefined) return null;
  const listed = first.provider.models.find((model) => model.listedDefault && !model.hidden);
  const model = (listed === undefined ? null : resolveTileKey(first.provider, listed.key)) ?? first.tiles[0];
  return model === undefined ? null : { providerId: first.provider.id, instanceId: first.provider.instanceId, model: model.key, effort: effortFor(model, null), speed: null };
}

/**
 * The speed tier a model takes (decision 0016): the wanted one when the model lists it,
 * as `effortFor` keeps a level; else standard speed. Never a tier chosen for the user.
 */
export function speedFor(model: Pick<CatalogModel, 'speedTiers'>, wanted: string | null): string | null {
  return wanted !== null && model.speedTiers.some((tier) => tier.id === wanted) ? wanted : null;
}

/**
 * Which instances a preset may name: those of the project's providers that are switched on in
 * Settings, and of those the instances that are configured and switched on themselves. A project is
 * offered to providers, never to instances (M14b, C30).
 */
export interface PresetOffer {
  /** The providers the project is enabled for, of those that have sessions (M15, C6). */
  readonly offered: readonly string[];
  /** The providers that are not switched off. */
  readonly enabled: readonly string[];
  /** The instances that are configured, and not switched off. */
  readonly instances: readonly InstanceRef[];
}

/**
 * A project's offer, from the app state's provider snapshots: main and the popup build it from the
 * same snapshots, so create refuses whatever the popup leaves out (C94). A provider without sessions
 * is offered to no project (M15, C6): the popup shows no tile for it, and create refuses a preset
 * that names it as not offered.
 */
export function presetOffer(projectProviders: readonly string[], snapshots: readonly OfferSnapshot[]): PresetOffer {
  const offered = projectProviders.filter((id) => snapshots.some((snapshot) => snapshot.id === id && snapshot.descriptor.capabilities.sessions));
  const enabled = offered.filter((id) => unavailable(snapshots, { providerId: id, instanceId: FIRST_INSTANCE_ID }) !== 'provider-unavailable');
  return { offered, enabled, instances: availableInstances(snapshots) };
}

/** What an offer reads of a provider snapshot: who it is, whether it can be used, and whether it has sessions. */
export type OfferSnapshot = Pick<ProviderSnapshot, 'id' | 'instanceId' | 'status'> & { readonly descriptor: { readonly capabilities: Pick<ProviderCapabilities, 'sessions'> } };

/** The instances an offer leaves to choose from, in the order given. */
export function offeredInstances(offer: PresetOffer): InstanceRef[] {
  return offer.instances.filter((ref) => offer.offered.includes(ref.providerId) && offer.enabled.includes(ref.providerId));
}

export type PresetRefusal = Extract<SessionRefusalReason, 'provider-not-offered' | 'provider-unavailable' | 'instance-unavailable' | 'model-not-listed' | 'effort-not-listed' | 'speed-not-listed' | 'speed-unavailable'>;

export type PresetCheck = { readonly ok: true; readonly preset: ModelPreset } | { readonly ok: false; readonly reason: PresetRefusal };

/**
 * What `sessions:create` refuses (C32; M14b, C25): a provider the project does not offer, or one
 * switched off; an instance that is not configured, or is switched off; a model its own catalog
 * entry hides or does not list, whatever another instance of the provider lists; a level the model
 * lacks there; a speed tier the model does not list, or one asked of an account whose catalog entry
 * says fat-g cannot ask for one (decision 0016). An accepted preset comes back carrying
 * the key of the tile it selects (C94).
 */
export function checkPreset(catalog: CatalogState | undefined, offer: PresetOffer, preset: ModelPreset): PresetCheck {
  if (!offer.offered.includes(preset.providerId)) return { ok: false, reason: 'provider-not-offered' };
  if (!offer.enabled.includes(preset.providerId)) return { ok: false, reason: 'provider-unavailable' };
  if (!offer.instances.some((ref) => sameInstance(ref, preset))) return { ok: false, reason: 'instance-unavailable' };
  const model = resolveTileKey(catalogEntry(catalog, preset), preset.model);
  if (model === null) return { ok: false, reason: 'model-not-listed' };
  const listed = model.efforts.length === 0 ? preset.effort === null : model.efforts.some((effort) => effort.id === preset.effort);
  if (!listed) return { ok: false, reason: 'effort-not-listed' };
  const speed = speedCheck(catalogEntry(catalog, preset), model, preset.speed);
  if (speed !== null) return { ok: false, reason: speed };
  return { ok: true, preset: { providerId: preset.providerId, instanceId: preset.instanceId, model: model.key, effort: preset.effort, speed: preset.speed } };
}

/**
 * Why a speed tier cannot be asked of a model on this account, or null where it can: standard speed
 * always can; a tier the model does not list cannot, nor any tier where the account's catalog entry
 * says fat-g cannot ask for one. `sessions:setSpeed` asks the same.
 */
export function speedCheck(entry: CatalogProvider | undefined, model: Pick<CatalogModel, 'speedTiers'>, speed: string | null): 'speed-not-listed' | 'speed-unavailable' | null {
  if (speed === null) return null;
  if (!model.speedTiers.some((tier) => tier.id === speed)) return 'speed-not-listed';
  return entry?.speedTierRequest.possible === true ? null : 'speed-unavailable';
}

/**
 * The preset the popup opens with (C83; M14b, C27): that of the project's newest session by its
 * created time, with its instance, else of the newest session in any project, else the default —
 * skipping one create would refuse. A session's speed tier comes with it where it may still be asked,
 * else it opens at standard speed. Nothing is saved for it.
 */
export function preselectPreset(input: {
  readonly catalog: CatalogState | undefined;
  readonly offer: PresetOffer;
  readonly projectId: string;
  readonly sessions: readonly Pick<SessionView, 'projectId' | 'providerId' | 'instanceId' | 'model' | 'effort' | 'speed' | 'createdAt'>[];
}): ModelPreset | null {
  const { catalog, offer, projectId, sessions } = input;
  const newestFirst = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  for (const session of [...newestFirst.filter((candidate) => candidate.projectId === projectId), ...newestFirst]) {
    const preset = { providerId: session.providerId, instanceId: session.instanceId, model: session.model, effort: session.effort, speed: session.speed };
    const check = checkPreset(catalog, offer, preset);
    if (check.ok) return check.preset;
    if (check.reason !== 'speed-not-listed' && check.reason !== 'speed-unavailable') continue;
    const standard = checkPreset(catalog, offer, { ...preset, speed: null });
    if (standard.ok) return standard.preset;
  }
  return defaultPreset(presetTiles(catalog, offeredInstances(offer)));
}
