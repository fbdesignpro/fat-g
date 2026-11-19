// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Version-aware preferences storage. The normalized snapshot is safe for application consumers;
// the retained raw document never leaves this module and is what permitted edits are merged into.
//
// A refused file stays refused until the user acts from Settings (M12, C64, C81): Try again reads it
// once more, and Start fresh moves it aside, unchanged, and starts on the defaults. Either one that
// changes what is loaded notifies, and the provider registry admits the providers again from it.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  cleanInstanceLabel,
  FIRST_INSTANCE_ID,
  labelTaken,
  MAX_INSTANCES,
  NO_INSTANCES,
  shownFirstLabel,
  type InstanceId,
  type InstanceRef,
} from '@shared/contracts/instances';
import {
  applyPatch,
  type Preferences,
  type PreferencesPatch,
  type PreferencesSnapshot,
} from '@shared/contracts/prefs';
import type { RetryResult, StartFreshResult } from '@shared/contracts/stored-file';
import { normalizeRoot } from '../records/paths';
import { ModelPresetSchema, type ModelPreset } from '@shared/contracts/presets';
import { useRecentModel } from './recent-models';
import { writeFileAtomic, writeFileAtomicSync } from '../storage/atomic-write';
import { readJsonFile, readTextFile, type ReadText, serializeJson as serialize } from '../storage/json-file';
import { nodeSetAsideIo, setAside, type SetAsideIo } from '../storage/set-aside';
import {
  addRawInstance,
  applyRawInstancePatch,
  applyRawPatch,
  freshPreferences,
  readCompatiblePreferences,
  removeRawInstance,
  type CompatiblePreferences,
  type InstanceAdmission,
  type InstancePatch,
  type ProviderAdmission,
  type RawDocument,
  type ReadOptions,
} from './compatibility';

export const PREFERENCES_FILE = 'preferences.json';
export const WRITE_DELAY_MS = 250;

/** Whether an account was added (M14b, C10, C13, C14). The label and the folder are checked here, whoever asked. */
export type AddInstanceResult =
  | { readonly status: 'saved'; readonly id: InstanceId }
  | { readonly status: 'refused'; readonly reason: 'preferences-blocked' | 'unknown-provider' | 'limit' | 'label-empty' | 'label-taken' | 'folder-invalid' };

export type RemoveInstanceResult =
  | { readonly status: 'removed' }
  | { readonly status: 'refused'; readonly reason: 'preferences-blocked' | 'unknown-provider' | 'first-instance' | 'unknown-instance' };

export interface PreferencesStore {
  getSnapshot(): PreferencesSnapshot;
  getProviderAdmission(providerId: string): ProviderAdmission;
  /** Whether this instance may start (M14b, C17): the provider's admission for the first, the entry's own for an added one. */
  getInstanceAdmission(ref: InstanceRef): InstanceAdmission;
  isWritable(): boolean;
  /**
   * Also a rename and a switch of an instance (C21): a patch naming an unknown instance, an empty
   * label for an added one, or a label another instance of the provider has, changes nothing.
   */
  patch(patch: PreferencesPatch): PreferencesSnapshot;
  /** Main-only: one provider-bound prompt was accepted with this exact selection. */
  noteModelUse(preset: ModelPreset): void;
  /**
   * A new entry at the end of the provider's list, switched on, with a fresh id (C6). The label is
   * cleaned and the folder stored as a root is (M12, C24). Nothing sets a folder afterwards (C18).
   */
  addInstance(providerId: string, instance: { readonly label: string; readonly folder: string }): AddInstanceResult;
  /** Deletes the entry with this key, usable or not, and nothing else (C23, C66). */
  removeInstance(providerId: string, key: string): RemoveInstanceResult;
  subscribe(listener: (snapshot: PreferencesSnapshot) => void): () => void;
  flushSync(): void;
  /**
   * Moves a refused file aside under a dated name and starts on the defaults, as on a first run
   * (C64). Rejects, having changed nothing, when the file cannot be moved.
   */
  startFresh(): Promise<StartFreshResult>;
  /** Reads a refused file once more (C81): one that reads now is loaded. */
  retry(): RetryResult;
  dispose(): void;
}

export interface PreferencesStoreOptions {
  readonly dir: string;
  /** Only these providers enter the normalized/IPC projection or receive admission decisions. */
  readonly providerIds?: readonly string[];
  /** The clock that dates a file Start fresh moves aside. */
  readonly now?: () => number;
  readonly writeDelayMs?: number;
  readonly log?: Pick<Console, 'warn' | 'error'>;
  readonly write?: (filePath: string, data: string) => Promise<void>;
  readonly writeSync?: (filePath: string, data: string) => void;
  readonly readFile?: ReadText;
  readonly setAsideIo?: SetAsideIo;
  /** Whose rules say what an absolute folder is; tests run each OS's. */
  readonly platform?: string;
  /** Makes an added instance's id, and the run-only key of an entry that has none. */
  readonly newId?: () => string;
}

export function createPreferencesStore(options: PreferencesStoreOptions): PreferencesStore {
  const {
    dir,
    providerIds = [],
    writeDelayMs = WRITE_DELAY_MS,
    log = console,
    write = writeFileAtomic,
    writeSync = writeFileAtomicSync,
    now = Date.now,
    readFile = readTextFile,
    setAsideIo = nodeSetAsideIo,
    platform = process.platform,
    newId = randomUUID,
  } = options;
  const knownProviders = new Set(providerIds);
  const filePath = path.join(dir, PREFERENCES_FILE);
  // An entry with no usable id is named by a key made for this run (C66). The document is read
  // again after every change, so the keys are remembered here, by what each entry stores.
  const runKeys = new Map<string, string>();
  const reading: ReadOptions = {
    platform,
    runKey(signature) {
      const known = runKeys.get(signature);
      if (known !== undefined) return known;
      const made = newId();
      runKeys.set(signature, made);
      return made;
    },
  };
  let current = load(filePath, providerIds, log, readFile, reading);
  let raw: RawDocument | null = current.raw;
  let snapshot = publicSnapshot(0, current);
  const listeners = new Set<(value: PreferencesSnapshot) => void>();
  let dirty = current.writable && current.writeBack;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing = false;
  let queued = false;
  let startingFresh: Promise<StartFreshResult> | null = null;

  function scheduleWrite(): void {
    if (!current.writable || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void writeNow();
    }, writeDelayMs);
  }

  async function writeNow(): Promise<void> {
    if (writing) {
      queued = true;
      return;
    }
    if (!dirty || raw === null) return;
    writing = true;
    const data = serialize(raw);
    queued = false;
    try {
      mkdirSync(dir, { recursive: true });
      await write(filePath, data);
      if (!queued && data === serialize(raw)) dirty = false;
    } catch {
      log.error('[prefs] could not save preferences');
    } finally {
      writing = false;
      if (queued) {
        queued = false;
        void writeNow();
      }
    }
  }

  /** Replaces what was loaded — after Start fresh or Try again — and tells everyone. */
  function adopt(next: CompatiblePreferences): void {
    current = next;
    raw = next.raw;
    snapshot = publicSnapshot(snapshot.rev + 1, current);
    dirty = current.writable && current.writeBack;
    if (dirty) scheduleWrite();
    for (const listener of listeners) listener(snapshot);
  }

  if (dirty) scheduleWrite();

  /** Takes a changed document as the loaded one, saves it and tells everyone. */
  function commit(nextRaw: RawDocument, next: CompatiblePreferences): void {
    raw = nextRaw;
    current = next;
    snapshot = publicSnapshot(snapshot.rev + 1, current);
    dirty = true;
    if (writing) queued = true;
    scheduleWrite();
    for (const listener of listeners) listener(snapshot);
  }

  const providerAdmission = (providerId: string): ProviderAdmission => current.admissions[providerId] ?? { kind: 'blocked', reason: 'invalid-preferences' };
  const instancesOf = (providerId: string) => current.instances[providerId] ?? NO_INSTANCES;
  const takenLabels = (value: CompatiblePreferences, providerId: string): number => (value.instances[providerId] ?? NO_INSTANCES).added.filter((entry) => entry.issue === 'label-taken').length;

  /**
   * The instance part of a patch, cleaned (C13): null when it names an instance the provider does
   * not have, gives an added one an empty label, or gives any a label another instance has.
   */
  function instancePatch(providerId: string, update: NonNullable<PreferencesPatch['providers']>[string]): InstancePatch | null {
    const held = instancesOf(providerId);
    const result: { label?: string | null; instances?: Record<string, { label?: string; enabled?: boolean }> } = {};
    if (update.label !== undefined) {
      const cleaned = update.label === null ? '' : cleanInstanceLabel(update.label);
      const label = cleaned === '' ? null : cleaned;
      if (labelTaken(held, shownFirstLabel(label), { first: true })) return null;
      result.label = label;
    }
    for (const [instanceId, change] of Object.entries(update.instances ?? {})) {
      const entry = held.added.find((candidate) => candidate.id !== null && candidate.id.toLowerCase() === instanceId.toLowerCase());
      if (entry === undefined) return null;
      const cleaned = change.label === undefined ? undefined : cleanInstanceLabel(change.label);
      if (cleaned === '' || (cleaned !== undefined && labelTaken(held, cleaned, { key: entry.key }))) return null;
      (result.instances ??= {})[instanceId] = {
        ...(cleaned === undefined ? {} : { label: cleaned }),
        ...(change.enabled === undefined ? {} : { enabled: change.enabled }),
      };
    }
    return result;
  }

  return {
    getSnapshot: () => snapshot,
    getProviderAdmission: providerAdmission,
    getInstanceAdmission(ref) {
      const provider = providerAdmission(ref.providerId);
      // The first instance names no folder: it runs wherever the user's own environment points (C4).
      if (ref.instanceId === FIRST_INSTANCE_ID) return provider.kind === 'blocked' ? provider : { ...provider, folder: null };
      if (provider.kind === 'blocked') return provider;
      const entry = instancesOf(ref.providerId).added.find((candidate) => candidate.id !== null && candidate.id.toLowerCase() === ref.instanceId.toLowerCase());
      if (entry === undefined) return { kind: 'blocked', reason: 'not-configured' };
      if (entry.issue !== null) return { kind: 'blocked', reason: 'invalid-instance', issue: entry.issue };
      const admitted = { preferences: provider.preferences, folder: entry.folder };
      return provider.kind === 'disabled' || !entry.enabled ? { kind: 'disabled', ...admitted } : { kind: 'enabled', ...admitted };
    },
    isWritable: () => current.writable,
    noteModelUse(preset) {
      if (!current.writable || raw === null) return;
      const parsed = ModelPresetSchema.safeParse(preset);
      if (!parsed.success || !knownProviders.has(parsed.data.providerId)) return;
      const nextRaw = { ...raw, recentModels: useRecentModel(raw['recentModels'], parsed.data) };
      if (serialize(nextRaw) === serialize(raw)) return;
      const next = readCompatiblePreferences(nextRaw, providerIds, reading);
      if (next.writable && next.raw !== null) commit(nextRaw, next);
    },
    patch(patch) {
      if (!current.writable || raw === null) return snapshot;
      const providerKeys = Object.keys(patch.providers ?? {});
      if (providerKeys.some((id) => !knownProviders.has(id))) return snapshot;
      // A title model is a registered provider's (M26), as a provider's controls are; and an avatar assignment (M103, C3, C6).
      if (Object.keys(patch.titles?.models ?? {}).some((id) => !knownProviders.has(id))) return snapshot;
      if (Object.keys(patch.avatars?.assignments ?? {}).some((id) => !knownProviders.has(id))) return snapshot;
      // A provider's active family is a registered provider's too (decision 0031).
      if (Object.keys(patch.avatars?.active ?? {}).some((id) => !knownProviders.has(id))) return snapshot;
      // A malformed providers container is intentionally not repaired piecemeal in-app.
      if (providerKeys.length > 0 && Object.values(current.providerIssues).includes('invalid-provider-section')) return snapshot;
      const instancePatches: [string, InstancePatch][] = [];
      for (const [id, update] of Object.entries(patch.providers ?? {})) {
        if (update.label === undefined && update.instances === undefined) continue;
        const cleaned = instancePatch(id, update);
        if (cleaned === null) return snapshot;
        instancePatches.push([id, cleaned]);
      }

      const normalized = applyPatch(current.values, patch);
      const safePatch = normalizedPatch(patch, normalized);
      let nextRaw = applyRawPatch(raw, safePatch);
      for (const [id, change] of instancePatches) nextRaw = applyRawInstancePatch(nextRaw, id, change);
      const next = readCompatiblePreferences(nextRaw, providerIds, reading);
      if (!next.writable || next.raw === null) return snapshot;
      if (serialize(nextRaw) === serialize(raw)) return snapshot;
      // Two renames in one patch that end on the same label: each passed alone, together they do not.
      if (instancePatches.some(([id]) => takenLabels(next, id) > takenLabels(current, id))) return snapshot;

      commit(nextRaw, next);
      return snapshot;
    },
    addInstance(providerId, instance) {
      if (!current.writable || raw === null) return { status: 'refused', reason: 'preferences-blocked' };
      if (!knownProviders.has(providerId)) return { status: 'refused', reason: 'unknown-provider' };
      const held = instancesOf(providerId);
      // The first instance counts toward the cap; an entry that cannot be used still holds its place.
      if (held.added.length >= MAX_INSTANCES - 1) return { status: 'refused', reason: 'limit' };
      const label = cleanInstanceLabel(instance.label);
      if (label === '') return { status: 'refused', reason: 'label-empty' };
      if (labelTaken(held, label)) return { status: 'refused', reason: 'label-taken' };
      const folder = normalizeRoot(instance.folder, platform);
      if (folder === null) return { status: 'refused', reason: 'folder-invalid' };
      const id = newId();
      // Null when the provider's entry or its list is malformed: that is repaired by hand (C16).
      const nextRaw = addRawInstance(raw, providerId, { id, label, folder, enabled: true });
      if (nextRaw === null) return { status: 'refused', reason: 'preferences-blocked' };
      const next = readCompatiblePreferences(nextRaw, providerIds, reading);
      const added = next.instances[providerId]?.added.at(-1);
      if (!next.writable || next.raw === null || added?.id !== id || added.issue !== null) return { status: 'refused', reason: 'preferences-blocked' };
      commit(nextRaw, next);
      return { status: 'saved', id };
    },
    removeInstance(providerId, key) {
      if (!current.writable || raw === null) return { status: 'refused', reason: 'preferences-blocked' };
      if (!knownProviders.has(providerId)) return { status: 'refused', reason: 'unknown-provider' };
      if (key === FIRST_INSTANCE_ID) return { status: 'refused', reason: 'first-instance' };
      // The entries are listed in stored order, unusable ones included, so the place in the list is the place in the file.
      const index = instancesOf(providerId).added.findIndex((entry) => entry.key.toLowerCase() === key.toLowerCase());
      if (index < 0) return { status: 'refused', reason: 'unknown-instance' };
      const nextRaw = removeRawInstance(raw, providerId, index);
      if (nextRaw === null) return { status: 'refused', reason: 'preferences-blocked' };
      const next = readCompatiblePreferences(nextRaw, providerIds, reading);
      if (!next.writable || next.raw === null) return { status: 'refused', reason: 'preferences-blocked' };
      commit(nextRaw, next);
      return { status: 'removed' };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flushSync() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!current.writable || !dirty || raw === null) return;
      try {
        mkdirSync(dir, { recursive: true });
        writeSync(filePath, serialize(raw));
        dirty = false;
      } catch {
        log.error('[prefs] could not save preferences on quit');
      }
    },
    startFresh() {
      // Two confirmations sent together move the file once.
      startingFresh ??= (async (): Promise<StartFreshResult> => {
        if (current.writable) return { status: 'refused', reason: 'not-refused' };
        // Nothing is written while the file is refused, so no write can be pending here.
        const keptAs = await setAside(dir, PREFERENCES_FILE, now(), setAsideIo);
        log.warn('[prefs] the refused preferences file was moved aside; starting on the defaults');
        runKeys.clear();
        adopt(freshPreferences(providerIds));
        return { status: 'done', keptAs };
      })().finally(() => {
        startingFresh = null;
      });
      return startingFresh;
    },
    retry() {
      if (current.writable) return { status: 'refused', reason: 'not-refused' };
      const next = load(filePath, providerIds, log, readFile, reading);
      if (next.writable) {
        adopt(next);
        return { status: 'loaded' };
      }
      // Still refused, perhaps for another reason now: the note says the new one.
      if (JSON.stringify(next.status) !== JSON.stringify(current.status)) adopt(next);
      return { status: 'refused', reason: 'still-refused' };
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      listeners.clear();
    },
  };
}

function publicSnapshot(rev: number, value: CompatiblePreferences): PreferencesSnapshot {
  return { rev, values: value.values, status: value.status, providerIssues: value.providerIssues, instances: value.instances };
}

function load(filePath: string, providerIds: readonly string[], log: Pick<Console, 'warn' | 'error'>, read: ReadText, options: ReadOptions): CompatiblePreferences {
  const reading = readJsonFile(filePath, read);
  switch (reading.kind) {
    case 'missing':
      return freshPreferences(providerIds);
    case 'unreadable':
      log.warn(`[prefs] preferences could not be read (${reading.code ?? 'no code'}); the original file will be left alone`);
      return unavailableRead(providerIds);
    case 'invalid-json':
      log.warn('[prefs] preferences contain invalid JSON; the original file will be left alone');
      return readCompatiblePreferences(null, providerIds);
    case 'parsed': {
      const result = readCompatiblePreferences(reading.value, providerIds, options);
      if (!result.writable) log.warn(`[prefs] preferences are ${result.status.kind === 'read-only' ? result.status.reason : 'unavailable'}; the original file will be left alone`);
      return result;
    }
  }
}

function unavailableRead(providerIds: readonly string[]): CompatiblePreferences {
  // The compatibility function's corrupt path has the same safe defaults/admissions; only the
  // public reason differs for a file the OS would not let us read.
  const base = readCompatiblePreferences(null, providerIds);
  return {
    ...base,
    status: { kind: 'read-only', reason: 'unreadable' },
    admissions: Object.fromEntries(providerIds.map((id) => [id, { kind: 'blocked', reason: 'preferences-unavailable' }])),
  };
}

function normalizedPatch(patch: PreferencesPatch, values: Preferences): PreferencesPatch {
  const result: PreferencesPatch = {};
  if (patch.windows !== undefined) {
    result.windows = {};
    if (patch.windows.main !== undefined) {
      result.windows.main = {};
      if ('bounds' in patch.windows.main) result.windows.main.bounds = values.windows.main.bounds;
      if ('maximized' in patch.windows.main) result.windows.main.maximized = values.windows.main.maximized;
    }
    if (patch.windows.pet !== undefined) {
      result.windows.pet = {};
      if ('bounds' in patch.windows.pet) result.windows.pet.bounds = values.windows.pet.bounds;
      if ('visible' in patch.windows.pet) result.windows.pet.visible = values.windows.pet.visible;
      if ('autoHideOnMainFocus' in patch.windows.pet) result.windows.pet.autoHideOnMainFocus = values.windows.pet.autoHideOnMainFocus;
      if ('size' in patch.windows.pet) result.windows.pet.size = values.windows.pet.size;
    }
  }
  if (patch.providers !== undefined) {
    result.providers = {};
    for (const [id, changed] of Object.entries(patch.providers)) {
      const saved = values.providers[id] ?? { enabled: true, executablePath: null, permissionMode: null };
      // The controls only: a label and the instances are cleaned and merged by the store itself.
      result.providers[id] = {
        ...('enabled' in changed ? { enabled: saved.enabled } : {}),
        ...('executablePath' in changed ? { executablePath: saved.executablePath } : {}),
        // The user's default mode for the provider (M22, C40): an id, or null for none chosen.
        ...('permissionMode' in changed ? { permissionMode: saved.permissionMode } : {}),
      };
    }
  }
  if (patch.usage !== undefined) result.usage = { pollIntervalSec: values.usage.pollIntervalSec };
  if (patch.privacy !== undefined) result.privacy = { maskEmail: values.privacy.maskEmail };
  if (patch.audio !== undefined) {
    result.audio = {
      ...('muted' in patch.audio ? { muted: values.audio.muted } : {}),
      ...('volume' in patch.audio ? { volume: values.audio.volume } : {}),
      ...(patch.audio.sounds === undefined ? {} : { sounds: Object.fromEntries(Object.keys(patch.audio.sounds).map((key) => [key, values.audio.sounds[key as keyof typeof values.audio.sounds]])) }),
    };
  }
  if (patch.appearance !== undefined) {
    result.appearance = 'theme' in patch.appearance ? { theme: values.appearance.theme } : {};
    if ('doneAnimation' in patch.appearance) result.appearance.doneAnimation = values.appearance.doneAnimation;
    if ('creationAnimation' in patch.appearance) result.appearance.creationAnimation = values.appearance.creationAnimation;
    const flash = patch.appearance.flash;
    if (flash !== undefined) {
      result.appearance.flash = {};
      if ('enabled' in flash) result.appearance.flash.enabled = values.appearance.flash.enabled;
      if ('speed' in flash) result.appearance.flash.speed = values.appearance.flash.speed;
      if ('seconds' in flash) result.appearance.flash.seconds = values.appearance.flash.seconds;
    }
  }
  if (patch.layout !== undefined) result.layout = 'projectColumn' in patch.layout ? { projectColumn: values.layout.projectColumn } : {};
  if (patch.chat !== undefined) {
    result.chat = {
      ...('messageTimes' in patch.chat ? { messageTimes: values.chat.messageTimes } : {}),
      ...('hoverMessageTimes' in patch.chat ? { hoverMessageTimes: values.chat.hoverMessageTimes } : {}),
      ...('answerTimes' in patch.chat ? { answerTimes: values.chat.answerTimes } : {}),
      ...('username' in patch.chat ? { username: values.chat.username } : {}),
    };
  }
  // What Enter does while a turn runs (M23, C80).
  if (patch.composer !== undefined) result.composer = 'busyEnter' in patch.composer ? { busyEnter: values.composer.busyEnter } : {};
  if (patch.presets !== undefined) result.presets = Object.fromEntries(Object.keys(patch.presets).map((id) => [id, values.presets[id] ?? null]));
  if (patch.usePreset !== undefined) result.usePreset = patch.usePreset;
  if (patch.clearRecentModels === true) result.clearRecentModels = true;
  if (patch.titles !== undefined) {
    const models = patch.titles.models;
    result.titles = {
      ...('generated' in patch.titles ? { generated: values.titles.generated } : {}),
      ...(models === undefined ? {} : { models: Object.fromEntries(Object.keys(models).map((id) => [id, values.titles.models[id] ?? null])) }),
    };
  }
  // The avatar section of the patch (M103, C6; decision 0031): each entry as the schema read it, or null.
  if (patch.avatars !== undefined) {
    const { assignments, active } = patch.avatars;
    const saved = values.avatars;
    result.avatars = {
      ...(assignments === undefined ? {} : { assignments: Object.fromEntries(Object.entries(assignments).map(([id, entries]) => [id, Object.fromEntries(Object.keys(entries).map((key) => [key, saved.assignments[id]?.[key] ?? null]))])) }),
      ...(active === undefined ? {} : { active: Object.fromEntries(Object.keys(active).map((id) => [id, saved.active[id] ?? null])) }),
    };
  }
  return result;
}
