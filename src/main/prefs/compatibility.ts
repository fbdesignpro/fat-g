// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import {
  cleanInstanceLabel,
  isAddedInstanceId,
  labelTaken,
  MAX_INSTANCES,
  NO_INSTANCES,
  type InstanceEntry,
  type InstanceIssue,
  type ProviderInstances,
} from '@shared/contracts/instances';
import {
  defaultPreferences,
  PREFERENCES_VERSION,
  PreferencesSchema,
  type Preferences,
  type PreferencesPatch,
  type PreferencesStatus,
  type ProviderPreferenceIssue,
  type ProviderPreferences,
} from '@shared/contracts/prefs';
import { isModeId } from '@shared/contracts/permissions';
import { readSavedPresets, useSavedPreset } from '@shared/contracts/saved-presets';
import { isAbsoluteRoot } from '../records/paths';
import { plainObject, positiveInteger, readEnvelope } from '../storage/envelope';
import { readRawAvatars, settleRawAvatars } from './assignments';
import { migrate } from './migrations';

export type RawDocument = Record<string, unknown>;

/**
 * Where the migrations stop. Revision 1 still becomes revision 2 by the existing step, and is then
 * refused like any revision-2 file: no migrations are written before the first public release, so
 * nothing below PREFERENCES_VERSION is readable (decision 0014).
 */
const LAST_MIGRATED_VERSION = 2;

export type ProviderAdmission =
  | { readonly kind: 'enabled'; readonly preferences: ProviderPreferences }
  | { readonly kind: 'disabled'; readonly preferences: ProviderPreferences }
  | { readonly kind: 'blocked'; readonly reason: 'preferences-unavailable' | 'invalid-preferences' };

/**
 * Whether an instance may start (M14b, C17). The first instance is admitted as its provider is, and
 * names no folder. An added one is blocked when its provider is or its entry is unusable, disabled
 * when the provider's switch or its own is off, and otherwise enabled, with its folder.
 */
export type InstanceAdmission =
  | { readonly kind: 'enabled'; readonly preferences: ProviderPreferences; readonly folder: string | null }
  | { readonly kind: 'disabled'; readonly preferences: ProviderPreferences; readonly folder: string | null }
  | { readonly kind: 'blocked'; readonly reason: 'preferences-unavailable' | 'invalid-preferences' }
  /** The preferences hold no such instance: it was removed, or never added. */
  | { readonly kind: 'blocked'; readonly reason: 'not-configured' }
  | { readonly kind: 'blocked'; readonly reason: 'invalid-instance'; readonly issue: InstanceIssue };

export interface ReadOptions {
  /** Whose rules say what an absolute path is. */
  readonly platform?: string;
  /**
   * The key of an entry with no usable id (C66). Given the same signature it must answer the same
   * key, so an entry keeps its key through every re-read of the run; the store holds that memory.
   */
  readonly runKey?: (signature: string) => string;
}

export interface CompatiblePreferences {
  readonly writable: boolean;
  readonly raw: RawDocument | null;
  readonly values: Preferences;
  readonly status: PreferencesStatus;
  readonly providerIssues: Readonly<Record<string, ProviderPreferenceIssue>>;
  readonly admissions: Readonly<Record<string, ProviderAdmission>>;
  /** Each registered provider's instances, read with their provenance (C16, C66). */
  readonly instances: Readonly<Record<string, ProviderInstances>>;
  readonly writeBack: boolean;
}

const unavailable = (
  reason: Extract<PreferencesStatus, { kind: 'read-only' }>['reason'],
  providerIds: readonly string[],
  details: Omit<Extract<PreferencesStatus, { kind: 'read-only' }>, 'kind' | 'reason'> = {},
): CompatiblePreferences => ({
  writable: false,
  raw: null,
  values: defaultPreferences(),
  status: { kind: 'read-only', reason, ...details },
  providerIssues: {},
  admissions: Object.fromEntries(
    providerIds.map((id) => [
      id,
      {
        kind: 'blocked',
        reason: reason === 'unreadable' || reason === 'incompatible' ? 'preferences-unavailable' : 'invalid-preferences',
      },
    ]),
  ),
  instances: Object.fromEntries(providerIds.map((id) => [id, NO_INSTANCES])),
  writeBack: false,
});

export function readCompatiblePreferences(parsed: unknown, providerIds: readonly string[], options: ReadOptions = {}): CompatiblePreferences {
  const { platform = process.platform, runKey = () => randomUUID() } = options;
  if (!plain(parsed)) return unavailable('corrupt', providerIds);
  const version = positiveInteger(parsed['schemaVersion']);
  if (version === null) return unavailable('corrupt', providerIds);

  let raw = parsed;
  let writeBack = false;
  if (version === 1) {
    // Revision 1 predates the envelope. A min-reader value there is ambiguous, so do not guess.
    if ('minReaderVersion' in raw) return unavailable('corrupt', providerIds);
    const migrated = migrate(raw, 1, LAST_MIGRATED_VERSION);
    if (!migrated.ok) return unavailable('migration-failed', providerIds, { fileVersion: version });
    raw = migrated.value;
    writeBack = true;
  }

  // The shared checks (src/main/storage/envelope.ts). Preferences call a newer and an older file
  // alike `incompatible`; Settings tells them apart by the numbers.
  const envelope = readEnvelope(raw, PREFERENCES_VERSION);
  switch (envelope.kind) {
    case 'corrupt':
      return unavailable('corrupt', providerIds);
    case 'newer':
    case 'older':
      return unavailable('incompatible', providerIds, { fileVersion: envelope.schemaVersion, minReaderVersion: envelope.minReaderVersion });
    case 'ok':
      break;
  }

  const providersRaw = raw['providers'];
  const wholeProviderSectionInvalid = providersRaw !== undefined && !plain(providersRaw);
  const issues: Record<string, ProviderPreferenceIssue> = {};
  const admissions: Record<string, ProviderAdmission> = {};
  const normalizedProviders: Record<string, ProviderPreferences> = {};
  const instances: Record<string, ProviderInstances> = {};

  for (const id of providerIds) {
    if (wholeProviderSectionInvalid) {
      issues[id] = 'invalid-provider-section';
      admissions[id] = { kind: 'blocked', reason: 'invalid-preferences' };
      instances[id] = NO_INSTANCES;
      continue;
    }
    const entry = plain(providersRaw) ? providersRaw[id] : undefined;
    const result = providerControl(entry);
    normalizedProviders[id] = result.preferences;
    if (result.issue !== undefined) issues[id] = result.issue;
    admissions[id] = result.admission;
    // The instances have a pass of their own, like the controls: each entry is read by itself, so
    // one that cannot be used is named and leaves the others, and the first instance, as they are.
    const read = providerInstances(id, entry, platform, runKey);
    instances[id] = read.instances;
    if (read.listInvalid) issues[id] ??= 'invalid-instances';
  }

  // PreferencesSchema is deliberately tolerant for cosmetic fields. Provider controls are supplied
  // from the provenance-aware pass above so malformed values can never disappear into defaults.
  // The avatar section too (M103, C5; decision 0031): only main knows the registered providers, by
  // which an override or an active family of another is dropped as read.
  const values = PreferencesSchema.parse({ ...raw, providers: normalizedProviders, avatars: readRawAvatars(raw['avatars'], providerIds) });
  return {
    writable: true,
    raw,
    values,
    status: { kind: 'ok' },
    providerIssues: issues,
    admissions,
    instances,
    writeBack,
  };
}

export function freshPreferences(providerIds: readonly string[]): CompatiblePreferences {
  const values = defaultPreferences();
  const raw = structuredClone(values) as RawDocument;
  const admissions: Record<string, ProviderAdmission> = {};
  for (const id of providerIds) admissions[id] = { kind: 'enabled', preferences: { enabled: true, executablePath: null, permissionMode: null } };
  const instances = Object.fromEntries(providerIds.map((id) => [id, NO_INSTANCES]));
  return { writable: true, raw, values, status: { kind: 'ok' }, providerIssues: {}, admissions, instances, writeBack: true };
}

/** The patch over the retained document: what it names set, the rest of the file as it was. */
export function applyRawPatch(raw: RawDocument, patch: PreferencesPatch): RawDocument {
  const next = structuredClone(raw);
  mergeSection(next, 'windows', patch.windows, (section, value) => {
    const main = value['main'];
    const pet = value['pet'];
    mergeSection(section, 'main', plain(main) ? main : undefined);
    mergeSection(section, 'pet', plain(pet) ? pet : undefined);
  });
  if (patch.providers !== undefined) {
    const section = plain(next['providers']) ? { ...next['providers'] } : {};
    for (const [id, update] of Object.entries(patch.providers)) {
      // The controls only. A label and the instances are merged by applyRawInstancePatch, which
      // knows that `instances` is a list in the file and a record by id in a patch.
      const controls = {
        ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
        ...(update.executablePath === undefined ? {} : { executablePath: update.executablePath }),
        // The user's default mode for the provider (M22, C40): an id, or null for none chosen.
        ...(update.permissionMode === undefined ? {} : { permissionMode: update.permissionMode }),
      };
      if (Object.keys(controls).length === 0 && !plain(section[id])) continue;
      section[id] = { ...(plain(section[id]) ? section[id] : {}), ...controls };
    }
    next['providers'] = section;
  }
  mergeSection(next, 'usage', patch.usage);
  mergeSection(next, 'privacy', patch.privacy);
  mergeSection(next, 'audio', patch.audio, (section, value) => {
    const { sounds, ...rest } = value;
    Object.assign(section, rest);
    mergeSection(section, 'sounds', plain(sounds) ? sounds : undefined);
  });
  mergeSection(next, 'appearance', patch.appearance, (section, value) => {
    const { flash, ...rest } = value;
    Object.assign(section, rest);
    // Field by field, so a field this build does not know beside them stays.
    mergeSection(section, 'flash', plain(flash) ? flash : undefined);
  });
  mergeSection(next, 'layout', patch.layout);
  mergeSection(next, 'chat', patch.chat);
  // What Enter does while a turn runs (M23, C80): the rest of what the file holds there stays.
  mergeSection(next, 'composer', patch.composer);
  if (patch.presets !== undefined) {
    const presets = plain(next['presets']) ? { ...next['presets'] } : {};
    for (const [id, preset] of Object.entries(patch.presets)) {
      if (preset === null) delete presets[id];
      else presets[id] = { ...(plain(presets[id]) ? presets[id] : {}), ...preset };
    }
    next['presets'] = presets;
  }
  if (patch.presets !== undefined || patch.usePreset !== undefined) {
    const saved = readSavedPresets(plain(next['presets']) ? next['presets'] : {});
    const recent = Array.isArray(next['presetRecency']) ? next['presetRecency'].filter((id): id is string => typeof id === 'string') : [];
    next['presetRecency'] = useSavedPreset(saved, recent, patch.usePreset);
  }
  if (patch.clearRecentModels === true) next['recentModels'] = [];
  // The title models are merged by provider id, null clearing one (M26): the rest of what the file holds there stays.
  mergeSection(next, 'titles', patch.titles, (section, value) => {
    if (value['generated'] !== undefined) section['generated'] = value['generated'];
    const models = value['models'];
    if (!plain(models)) return;
    const saved = plain(section['models']) ? { ...section['models'] } : {};
    for (const [id, model] of Object.entries(models)) {
      if (model === null) delete saved[id];
      else saved[id] = model;
    }
    section['models'] = saved;
  });
  // The avatar section (M103, C6; decision 0031): each override and active family set or removed, in the same write.
  return settleRawAvatars(next, patch.avatars);
}

/** What a patch may change of a provider's instances: the first one's label, and an added one's label and switch. */
export interface InstancePatch {
  /** Null clears it. */
  readonly label?: string | null;
  readonly instances?: Readonly<Record<string, { readonly label?: string; readonly enabled?: boolean }>>;
}

/** Position of the entry whose usable id this is: the first with it, as the reading pass counts. */
function indexOfInstance(list: readonly unknown[], id: string): number {
  return list.findIndex((item) => plain(item) && isAddedInstanceId(item['id']) && item['id'].toLowerCase() === id.toLowerCase());
}

/**
 * Merges a rename or a switch into the retained document. The entry it changes keeps every other
 * field, and no entry is added, removed or moved. An id the list does not hold changes nothing.
 */
export function applyRawInstancePatch(raw: RawDocument, providerId: string, patch: InstancePatch): RawDocument {
  const next = structuredClone(raw);
  const section: RawDocument = plain(next['providers']) ? next['providers'] : {};
  const entry: RawDocument = plain(section[providerId]) ? section[providerId] : {};
  let changed = false;
  if (patch.label !== undefined) {
    if (patch.label === null) {
      if ('label' in entry) { delete entry['label']; changed = true; }
    } else { entry['label'] = patch.label; changed = true; }
  }
  const list: unknown = entry['instances'];
  if (patch.instances !== undefined && Array.isArray(list)) {
    const items = list as unknown[];
    for (const [id, change] of Object.entries(patch.instances)) {
      const index = indexOfInstance(items, id);
      if (index < 0) continue;
      items[index] = { ...(items[index] as RawDocument), ...change };
      changed = true;
    }
  }
  if (!changed) return raw;
  section[providerId] = entry;
  next['providers'] = section;
  return next;
}

/** Adds an instance at the end of the provider's list, or answers null when its entry or its list cannot take one. */
export function addRawInstance(raw: RawDocument, providerId: string, instance: { id: string; label: string; folder: string; enabled: boolean }): RawDocument | null {
  const next = structuredClone(raw);
  const providers = next['providers'];
  if (providers !== undefined && !plain(providers)) return null;
  const section: RawDocument = providers ?? {};
  const stored = section[providerId];
  if (stored !== undefined && !plain(stored)) return null;
  const entry: RawDocument = stored ?? {};
  const list: unknown = entry['instances'];
  if (list !== undefined && !Array.isArray(list)) return null;
  entry['instances'] = [...((list as unknown[] | undefined) ?? []), instance];
  section[providerId] = entry;
  next['providers'] = section;
  return next;
}

/** Deletes the entry at `index` of the provider's list, and nothing else. */
export function removeRawInstance(raw: RawDocument, providerId: string, index: number): RawDocument | null {
  const next = structuredClone(raw);
  const section = next['providers'];
  const entry = plain(section) ? section[providerId] : undefined;
  const list: unknown = plain(entry) ? entry['instances'] : undefined;
  if (!Array.isArray(list) || index < 0 || index >= list.length) return null;
  (list as unknown[]).splice(index, 1);
  return next;
}

function mergeSection(
  parent: RawDocument,
  key: string,
  patch: Record<string, unknown> | undefined,
  nested?: (section: RawDocument, patch: Record<string, unknown>) => void,
): void {
  if (patch === undefined) return;
  const section: RawDocument = plain(parent[key]) ? { ...parent[key] } : {};
  if (nested) nested(section, patch);
  else Object.assign(section, patch);
  parent[key] = section;
}

function providerControl(value: unknown): {
  preferences: ProviderPreferences;
  issue?: ProviderPreferenceIssue;
  admission: ProviderAdmission;
} {
  const defaults: ProviderPreferences = { enabled: true, executablePath: null, permissionMode: null };
  if (value === undefined) return { preferences: defaults, admission: { kind: 'enabled', preferences: defaults } };
  if (!plain(value)) {
    return { preferences: defaults, issue: 'invalid-provider-entry', admission: { kind: 'blocked', reason: 'invalid-preferences' } };
  }
  const enabled = value['enabled'] === undefined ? true : value['enabled'];
  const executablePath = value['executablePath'] === undefined ? null : value['executablePath'];
  const pathValid = executablePath === null || (typeof executablePath === 'string' && executablePath.length > 0);
  const normalized: ProviderPreferences = {
    enabled: typeof enabled === 'boolean' ? enabled : true,
    executablePath: pathValid ? executablePath : null,
    // A default mode that is no id at all reads as none chosen, and blocks nothing (M22, C40): whether
    // the provider lists it is asked when a chat is made.
    permissionMode: isModeId(value['permissionMode']) ? value['permissionMode'] : null,
  };
  // An explicit valid disable is authoritative even when another control is malformed.
  if (enabled === false) {
    return {
      preferences: normalized,
      admission: { kind: 'disabled', preferences: normalized },
      ...(pathValid ? {} : { issue: 'invalid-executable-path' as const }),
    };
  }
  if (typeof enabled !== 'boolean') {
    return { preferences: normalized, issue: 'invalid-enabled', admission: { kind: 'blocked', reason: 'invalid-preferences' } };
  }
  if (!pathValid) {
    return { preferences: normalized, issue: 'invalid-executable-path', admission: { kind: 'blocked', reason: 'invalid-preferences' } };
  }
  return { preferences: normalized, admission: { kind: 'enabled', preferences: normalized } };
}

/**
 * A provider's instances as its entry stores them (C12, C13, C16, C66). Each element of the list is
 * read by itself, in stored order, and the first rule it fails is its issue.
 */
function providerInstances(providerId: string, entry: unknown, platform: string, runKey: (signature: string) => string): { instances: ProviderInstances; listInvalid: boolean } {
  if (!plain(entry)) return { instances: NO_INSTANCES, listInvalid: false };
  const stored = entry['label'];
  const cleaned = typeof stored === 'string' ? cleanInstanceLabel(stored) : '';
  const firstLabel = cleaned === '' ? null : cleaned;
  const list: unknown = entry['instances'];
  if (list === undefined) return { instances: { firstLabel, added: [] }, listInvalid: false };
  if (!Array.isArray(list)) return { instances: { firstLabel, added: [] }, listInvalid: true };

  const added: InstanceEntry[] = [];
  const ids = new Set<string>();
  const unkeyed = new Map<string, number>();
  /** A key for an entry with no usable id: the same entry, by its stored value, keeps it through the run. */
  const keyOf = (item: unknown): string => {
    const signature = `${providerId}\u0000${JSON.stringify(item) ?? 'undefined'}`;
    const occurrence = unkeyed.get(signature) ?? 0;
    unkeyed.set(signature, occurrence + 1);
    return runKey(`${signature}\u0000${occurrence}`);
  };
  for (const [index, item] of (list as unknown[]).entries()) {
    if (!plain(item)) {
      added.push({ key: keyOf(item), id: null, label: null, folder: null, enabled: false, issue: 'invalid-entry' });
      continue;
    }
    const found: InstanceIssue[] = [];
    const storedId = item['id'];
    let id: string | null = null;
    if (!isAddedInstanceId(storedId)) found.push('invalid-id');
    else if (ids.has(storedId.toLowerCase())) found.push('duplicate-id');
    else { id = storedId; ids.add(storedId.toLowerCase()); }
    const storedLabel = item['label'];
    const cleanedLabel = typeof storedLabel === 'string' ? cleanInstanceLabel(storedLabel) : '';
    const label = cleanedLabel === '' ? null : cleanedLabel;
    // Taken by an earlier instance: the first one's shown label, and every earlier entry's.
    if (label === null) found.push('invalid-label');
    else if (labelTaken({ firstLabel, added }, label)) found.push('label-taken');
    const storedFolder = item['folder'];
    const folder = typeof storedFolder === 'string' && isAbsoluteRoot(storedFolder, platform) ? storedFolder : null;
    if (folder === null) found.push('invalid-folder');
    const enabled = item['enabled'];
    if (typeof enabled !== 'boolean') found.push('invalid-enabled');
    // The first instance counts toward the cap, so the list holds one fewer.
    if (index >= MAX_INSTANCES - 1) found.push('over-limit');
    added.push({ key: id ?? keyOf(item), id, label, folder, enabled: enabled === true, issue: found[0] ?? null });
  }
  return { instances: { firstLabel, added }, listInvalid: false };
}

export const plain: (value: unknown) => value is RawDocument = plainObject;
