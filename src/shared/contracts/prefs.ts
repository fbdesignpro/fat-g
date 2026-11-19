// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// User preferences are the only application data persisted by fat-g. The main process keeps the
// original JSON document privately so compatible newer revisions can be edited without losing
// fields this build does not understand (decision 0005). This file describes only the normalized,
// renderer-safe projection and the strict patch surface.
import { z } from 'zod';
import { AudioSoundsSchema, AudioSoundsPatchSchema, DEFAULT_SOUNDS } from './audio';
import { CREATION_ANIMATIONS, DEFAULT_ATTENTION_FLASH, DEFAULT_CREATION_ANIMATION, DEFAULT_DONE_ANIMATION, DEFAULT_THEME, DONE_ANIMATIONS, FLASH_SECONDS, FLASH_SPEEDS, THEMES } from './appearance';
import { mergeEntries, readActiveFamilies } from './avatar-preferences';
import { type Assignments, type AvatarRef, AvatarRefSchema, FamilyRefSchema, isAvatarRef } from './avatars';
import { catalogId, MAX_MODELS } from './catalog';
import type { ProviderInstances } from './instances';
import { isModeId, ModeIdSchema } from './permissions';
import { BUSY_ENTERS } from './composer';
import { normalizeName } from './names';
import { DEFAULT_PET_SIZE, PET_SIZES } from './pet';
import { mergeSavedPresets, readSavedPresets, SavedPresetSchema, useSavedPreset } from './saved-presets';
import { readRecentModels } from './recent-models';

// Revision 3 (M11) added `appearance` and `layout`. Revision 4 (M14b) lets a provider's entry hold
// a label for its first instance and a list of added instances. Revision 5 (M19, C41) adds `chat`:
// whether message times and each turn's elapsed time are shown. Revision 6 (M22, C25, C40) lets a
// provider's entry hold the user's default mode for it: an id, and nothing of a chat, a turn or a
// grant. Revision 7 (M26; decision 0028) adds `titles`: whether a new session's title is asked of
// the secretary, and which model writes it for each provider. Revision 8 (M23, C80) adds `composer`:
// what Enter does while a turn runs, Send now or Queue. Revision 9 (M103, C1; decision 0031) adds
// `avatars`: the avatar the user assigned to each model of a provider. Until the first public release
// a format change raises both numbers and writes no migration, so an older file is refused (decision 0014).
// Revision 10: a local display username; turn durations are always visible in speaker bars.
// Revision 11: named model/effort presets, edited in Settings and not yet used by session starts.
// Revision 12: global recent-first ordering for the new-chat screen's saved presets.
// Revision 13: the last twelve account/model/effort combinations used by accepted prompts.
// Revision 14 (decisions 0031, 0032): each provider's active family; an avatar may be assigned to
// several models. Revision 15 (decision 0032): the overlay's switch, the user's styles and labels gone,
// the family's files the one source of an avatar's look.
// Revision 16 (decision 0016): saved presets and recent combinations carry a speed tier, null for standard.
// Still revision 16, at the maintainer's choice (decision 0005): `windows.pet.size`, the size the
// Pet draws its capsules at. Optional both ways: an older build keeps it as an unknown field, and a file
// without it reads as `compact`. So, too, `appearance.flash`: whether a capsule's status bar
// flashes when it turns to an attention, how fast and for how long; a file without it flashes, fast, 5 s.
// Revision 17: whether model answer footers show their start and end times.
// Revision 18: the Done animation level.
// Revision 19: selectable local sounds for UI and session events.
// Revision 20: notification sounds alongside action sounds.
// Revision 21: automatically hide the Pet while the Main window has focus.
// Revision 22: the creation animation for a new chat's first send.
// Still revision 22, at the maintainer's choice: hover message times default on when absent.
// Older readers preserve the optional setting as an unknown field (decision 0005).
// Revision 23: title models default to Latest small model; $session explicitly selects the session's.
export const PREFERENCES_VERSION = 23;
export const MIN_READER_VERSION = 23;

/** A display preference alone: never incorporated into a prompt or a stored message. */
export const username = (value: string | null): string | null => value === null ? null : normalizeName(value) || null;

/** A catalog key as Settings sends one (M26): bounded here; whether a provider lists it is asked when a title is. */
export const MAX_TITLE_MODEL = 256;

/**
 * Which side of the Main window the project column takes; the other regions keep their order. `left`
 * is the default (M100, round 11); a file that names a side keeps it, so the change moves nobody's
 * window: the accepted values are the same, and the format does not change with it.
 */
export const PROJECT_COLUMN_SIDES = ['left', 'right'] as const;
export type ProjectColumnSide = (typeof PROJECT_COLUMN_SIDES)[number];

/** Provider usage APIs are deliberately never polled more frequently than once a minute. */
export const POLL_INTERVAL_SEC = { min: 60, max: 3600, default: 300 } as const;
// Linear playback gain; Settings presents it on a perceptual curve.
export const VOLUME = { min: 0, max: 1, default: 0.1 } as const;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const windowBounds = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .nullable()
  .catch(null);

const mainWindow = z
  .object({ bounds: windowBounds, maximized: z.boolean().catch(false) })
  .catch({ bounds: null, maximized: false });

const petWindow = z
  .object({ visible: z.boolean().catch(true), autoHideOnMainFocus: z.boolean().catch(true), bounds: windowBounds, size: z.enum(PET_SIZES).catch(DEFAULT_PET_SIZE) })
  .catch({ visible: true, autoHideOnMainFocus: true, bounds: null, size: DEFAULT_PET_SIZE });

export const ProviderPreferencesSchema = z.object({
  enabled: z.boolean().catch(true),
  executablePath: z.string().min(1).nullable().catch(null),
  /**
   * The user's default mode for the provider's new chats (M22, C40): the id of one of its modes, or
   * null for none chosen, which is the provider's fallback. Whether the provider still lists the id
   * is asked when a chat is created, never here; a value that is no id at all reads as none.
   */
  permissionMode: z.string().nullable().catch(null).transform((value) => (isModeId(value) ? value : null)),
});

/**
 * Normalized known preferences. Version fields deliberately accept compatible future revisions;
 * compatibility is established against the retained raw envelope in main before this is parsed.
 */
export const PreferencesSchema = z.object({
  schemaVersion: z.number().int().positive().catch(PREFERENCES_VERSION),
  minReaderVersion: z.number().int().positive().catch(MIN_READER_VERSION),
  windows: z
    .object({ main: mainWindow, pet: petWindow })
    .catch({ main: { bounds: null, maximized: false }, pet: { visible: true, autoHideOnMainFocus: true, bounds: null, size: DEFAULT_PET_SIZE } }),
  /** Main filters this record to registered provider ids before it crosses IPC. */
  providers: z.record(z.string(), ProviderPreferencesSchema).catch({}),
  usage: z
    .object({
      pollIntervalSec: z
        .number()
        .int()
        .catch(POLL_INTERVAL_SEC.default)
        .transform((seconds) => clamp(seconds, POLL_INTERVAL_SEC.min, POLL_INTERVAL_SEC.max)),
    })
    .catch({ pollIntervalSec: POLL_INTERVAL_SEC.default }),
  privacy: z.object({ maskEmail: z.boolean().catch(true) }).catch({ maskEmail: true }),
  audio: z
    .object({
      muted: z.boolean().catch(false),
      sounds: AudioSoundsSchema,
      volume: z
        .number()
        .catch(VOLUME.default)
        .transform((level) => clamp(level, VOLUME.min, VOLUME.max)),
    })
    .catch(() => ({ muted: false, volume: VOLUME.default, sounds: { ...DEFAULT_SOUNDS } })),
  appearance: z
    .object({
      theme: z.enum(THEMES).catch(DEFAULT_THEME),
      doneAnimation: z.enum(DONE_ANIMATIONS).catch(DEFAULT_DONE_ANIMATION),
      creationAnimation: z.enum(CREATION_ANIMATIONS).catch(DEFAULT_CREATION_ANIMATION),
      flash: z
        .object({
          enabled: z.boolean().catch(DEFAULT_ATTENTION_FLASH.enabled),
          speed: z.enum(FLASH_SPEEDS).catch(DEFAULT_ATTENTION_FLASH.speed),
          seconds: z.literal(FLASH_SECONDS).catch(DEFAULT_ATTENTION_FLASH.seconds),
        })
        .catch(DEFAULT_ATTENTION_FLASH),
    })
    .catch({ theme: DEFAULT_THEME, flash: DEFAULT_ATTENTION_FLASH, doneAnimation: DEFAULT_DONE_ANIMATION, creationAnimation: DEFAULT_CREATION_ANIMATION }),
  layout: z.object({ projectColumn: z.enum(PROJECT_COLUMN_SIDES).catch('left') }).catch({ projectColumn: 'left' }),
  /** Local presentation only. Turn durations are always shown. */
  chat: z.object({ messageTimes: z.boolean().catch(false), hoverMessageTimes: z.boolean().catch(true), answerTimes: z.boolean().catch(true), username: z.string().nullable().catch(null).transform(username) }).catch({ messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: null }),
  /**
   * A new session's title (M26; decision 0028). `generated`: whether the secretary is asked for one
   * at the first prompt, on until switched off. `models`: by provider id, the catalog key of the model
   * that writes it, where the user chose one; none is the session's own model. An entry that is no
   * key at all is dropped as it is read.
   */
  titles: z
    .object({
      generated: z.boolean().catch(true),
      models: z
        .record(z.string(), z.unknown())
        .catch({})
        .transform((models) => Object.fromEntries(Object.entries(models).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0 && entry[1].length <= MAX_TITLE_MODEL))),
    })
    .catch({ generated: true, models: {} }),
  /**
   * What the composer does (M23, C37, C80): `busyEnter` is what Enter does while a turn runs — Send now,
   * the default, or Queue — the other on Ctrl+Enter. It changes which button stands in Send's place.
   */
  composer: z.object({ busyEnter: z.enum(BUSY_ENTERS).catch('send-now') }).catch({ busyEnter: 'send-now' }),
  /**
   * The avatars (M103; decisions 0031, 0032). `assignments`: the user's overrides, by provider id, then
   * by model key or version id, an avatar reference — global to the provider, whatever its accounts
   * list (C3). `active`: the family each provider's models are searched in, where the user chose one.
   * Main hands this only what it kept of the file (src/main/prefs/assignments.ts), and only for
   * registered providers. How an avatar looks is its family's `family.json` alone (decision 0032).
   */
  avatars: z
    .object({
      assignments: z.record(z.string(), z.unknown()).catch({}).transform(readAssignments),
      active: z.record(z.string(), z.unknown()).catch({}).transform(readActiveFamilies),
    })
    .catch({ assignments: {}, active: {} }),
  /** Named selections by stable id. Missing accounts, models and efforts remain saved. */
  presets: z.record(z.string(), z.unknown()).catch({}).transform(readSavedPresets),
  presetRecency: z.array(z.guid()).catch([]),
  recentModels: z.array(z.unknown()).catch([]).transform(readRecentModels),
});

export type Preferences = z.infer<typeof PreferencesSchema>;
export type ProviderPreferences = z.infer<typeof ProviderPreferencesSchema>;
export type WindowBounds = NonNullable<z.infer<typeof windowBounds>>;

/** No untrusted text or file contents are included in these renderer-visible states. */
export type PreferencesStatus =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'read-only';
      readonly reason: 'unreadable' | 'corrupt' | 'incompatible' | 'migration-failed';
      readonly fileVersion?: number;
      readonly minReaderVersion?: number;
    };

/**
 * `invalid-instances`: the entry's `instances` is not a list (M14b, C16). The provider's first
 * instance still runs; it has no added instance, and none can be added until the file is repaired.
 */
export type ProviderPreferenceIssue = 'invalid-enabled' | 'invalid-executable-path' | 'invalid-provider-entry' | 'invalid-provider-section' | 'invalid-instances';

export interface PreferencesSnapshot {
  /** Counts changes in this run. Never persisted; it settles fetch-versus-push races. */
  readonly rev: number;
  readonly values: Preferences;
  readonly status: PreferencesStatus;
  /** Only registered ids are projected. Raw invalid values and unknown provider ids stay private. */
  readonly providerIssues: Readonly<Record<string, ProviderPreferenceIssue>>;
  /**
   * Each registered provider's instances (M14b, C12): the first one's label, and the added ones with
   * their label, folder, switch and issue. Read with their provenance, beside `values`, so a
   * malformed entry is named and never read as a default. The Pet reads no preferences, so it sees
   * no label and no folder (C24).
   */
  readonly instances: Readonly<Record<string, ProviderInstances>>;
}

/**
 * What `prefs:patch` answers: the preferences as they now are. `refused` is there when the patch
 * was refused whole because it would end the runtime of a session that is running (M15, C18).
 */
export type PreferencesPatchResult = PreferencesSnapshot & { readonly refused?: 'session-running' };

export function defaultPreferences(): Preferences {
  return PreferencesSchema.parse({ schemaVersion: PREFERENCES_VERSION, minReaderVersion: MIN_READER_VERSION });
}

// Patching is an IPC trust boundary. Objects are strict and compatibility metadata is intentionally
// absent: only migrations may change the version envelope.
const bounds = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
/** A label as a window sends it: bounded here, cleaned and clamped by main. */
const instanceLabel = z.string().max(256);
/** A model key, bounded as a catalog key is (M103, C2). */
const modelKey = z.string().refine((value) => catalogId(value) !== null, 'not a catalog id');
/** A provider id as a patch names one; main refuses one it does not register. */
const providerKey = z.string().min(1).max(64);

export const PreferencesPatchSchema = z.strictObject({
  windows: z
    .strictObject({
      main: z.strictObject({ bounds: bounds.nullable().optional(), maximized: z.boolean().optional() }).optional(),
      pet: z.strictObject({ visible: z.boolean().optional(), autoHideOnMainFocus: z.boolean().optional(), bounds: bounds.nullable().optional(), size: z.enum(PET_SIZES).optional() }).optional(),
    })
    .optional(),
  providers: z
    .record(z.string().min(1), z.strictObject({
      enabled: z.boolean().optional(),
      executablePath: z.string().min(1).nullable().optional(),
      // The user's default mode for the provider (M22, C40): saved by its own control alone, and
      // null clears it. It reaches no running session and no chat that exists.
      permissionMode: ModeIdSchema.nullable().optional(),
      // The first instance's label (M14b, C13): main cleans it, and null or an empty one clears it.
      label: instanceLabel.nullable().optional(),
      // A rename and a switch, by an added instance's id. No field sets a folder, adds an instance
      // or removes one (C18, C21): a patch naming an unknown instance, or a taken label, changes nothing.
      instances: z.record(z.guid(), z.strictObject({ label: instanceLabel.optional(), enabled: z.boolean().optional() })).optional(),
    }))
    .optional(),
  usage: z.strictObject({ pollIntervalSec: z.number().optional() }).optional(),
  privacy: z.strictObject({ maskEmail: z.boolean().optional() }).optional(),
  audio: z.strictObject({ muted: z.boolean().optional(), volume: z.number().optional(), sounds: AudioSoundsPatchSchema.optional() }).optional(),
  appearance: z
    .strictObject({
      theme: z.enum(THEMES).optional(),
      doneAnimation: z.enum(DONE_ANIMATIONS).optional(),
      creationAnimation: z.enum(CREATION_ANIMATIONS).optional(),
      // The attention flash's switch, speed and duration, each alone or together.
      flash: z.strictObject({ enabled: z.boolean().optional(), speed: z.enum(FLASH_SPEEDS).optional(), seconds: z.literal(FLASH_SECONDS).optional() }).optional(),
    })
    .optional(),
  layout: z.strictObject({ projectColumn: z.enum(PROJECT_COLUMN_SIDES).optional() }).optional(),
  chat: z.strictObject({ messageTimes: z.boolean().optional(), hoverMessageTimes: z.boolean().optional(), answerTimes: z.boolean().optional(), username: z.string().max(4096).nullable().transform(username).optional() }).optional(),
  // A provider's title model by its id (M26): a catalog key, or null for the session's own model.
  titles: z.strictObject({ generated: z.boolean().optional(), models: z.record(z.string().min(1).max(64), z.string().min(1).max(MAX_TITLE_MODEL).nullable()).optional() }).optional(),
  // What Enter does while a turn runs (M23, C80).
  composer: z.strictObject({ busyEnter: z.enum(BUSY_ENTERS).optional() }).optional(),
  // Set one named selection or remove it, retaining unrelated entries and unknown fields in main.
  presets: z.record(z.guid(), SavedPresetSchema.nullable()).optional(),
  usePreset: z.guid().optional(),
  // An explicit request to clear recent model combinations, independently of saved presets.
  clearRecentModels: z.literal(true).optional(),
  // The avatar section (M103, C6, C27; decisions 0031, 0032). `assignments`: one provider's models'
  // overrides, each a reference or null to clear it, at most a catalog's models; one avatar may hold
  // several models. `active`: a provider's active family, null for the built-in one.
  avatars: z
    .strictObject({
      assignments: z.record(providerKey, z.record(modelKey, AvatarRefSchema.nullable())).optional(),
      active: z.record(providerKey, FamilyRefSchema.nullable()).optional(),
    })
    .refine(({ assignments }) => {
      if (assignments === undefined) return true;
      const providers = Object.values(assignments);
      const entries = Object.values(providers[0] ?? {});
      return providers.length === 1 && entries.length >= 1 && entries.length <= MAX_MODELS;
    }, 'one provider’s models')
    .optional(),
});

export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

/** Pure normalized merge used by tests and renderer-side fixture construction. Disk writes use the
 * retained-document merge in main/prefs/compatibility.ts so unknown fields survive. A provider's
 * instances are not part of `Preferences`: main applies their part of a patch itself. */
export function applyPatch(current: Preferences, patch: PreferencesPatch): Preferences {
  const providers: Record<string, ProviderPreferences> = { ...current.providers };
  for (const [id, update] of Object.entries(patch.providers ?? {})) {
    providers[id] = {
      ...(providers[id] ?? { enabled: true, executablePath: null, permissionMode: null }),
      ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
      ...(update.executablePath === undefined ? {} : { executablePath: update.executablePath }),
      ...(update.permissionMode === undefined ? {} : { permissionMode: update.permissionMode }),
    };
  }
  return PreferencesSchema.parse({
    schemaVersion: current.schemaVersion,
    minReaderVersion: current.minReaderVersion,
    windows: {
      main: { ...current.windows.main, ...patch.windows?.main },
      pet: { ...current.windows.pet, ...patch.windows?.pet },
    },
    providers,
    usage: { ...current.usage, ...patch.usage },
    privacy: { ...current.privacy, ...patch.privacy },
    audio: { ...current.audio, ...patch.audio, sounds: { ...current.audio.sounds, ...patch.audio?.sounds } },
    appearance: { ...current.appearance, ...patch.appearance, flash: { ...current.appearance.flash, ...patch.appearance?.flash } },
    layout: { ...current.layout, ...patch.layout },
    chat: { ...current.chat, ...patch.chat, username: username(patch.chat?.username === undefined ? current.chat.username : patch.chat.username) },
    titles: {
      generated: patch.titles?.generated ?? current.titles.generated,
      models: mergeModels(current.titles.models, patch.titles?.models),
    },
    composer: { ...current.composer, ...patch.composer },
    avatars: {
      assignments: mergeAssignments(current.avatars.assignments, patch.avatars?.assignments),
      active: mergeEntries(current.avatars.active, patch.avatars?.active),
    },
    presets: mergeSavedPresets(current.presets, patch.presets),
    presetRecency: useSavedPreset(mergeSavedPresets(current.presets, patch.presets), current.presetRecency, patch.usePreset),
    recentModels: patch.clearRecentModels ? [] : current.recentModels,
  });
}

/**
 * The assignments as a file holds them (M103, C5): per provider id, the entries whose key is a
 * catalog id and whose value is a reference of the form; the rest is dropped without a word. Which
 * providers are registered only main can tell: it drops the others before this reads
 * (src/main/prefs/assignments.ts).
 */
export function readAssignments(raw: Readonly<Record<string, unknown>>): Assignments {
  const result: Record<string, Record<string, AvatarRef>> = {};
  for (const [providerId, entries] of Object.entries(raw)) {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue;
    const kept = Object.entries(entries as Record<string, unknown>).filter((entry): entry is [string, AvatarRef] => catalogId(entry[0]) !== null && isAvatarRef(entry[1]));
    if (kept.length > 0) result[providerId] = Object.fromEntries(kept.map(([key, ref]) => [key, { origin: ref.origin, family: ref.family, avatar: ref.avatar }]));
  }
  return result;
}

/**
 * A patch's assignment over the saved ones (M103, C6; decision 0031): a reference sets one key, null
 * clears it; another model holding the same avatar keeps it. What main's write does to the file
 * (src/main/prefs/assignments.ts), over the normalized values.
 */
export function mergeAssignments(current: Assignments, patch: Readonly<Record<string, Readonly<Record<string, AvatarRef | null>>>> | undefined): Assignments {
  if (patch === undefined) return current;
  const next: Record<string, Record<string, AvatarRef>> = Object.fromEntries(Object.entries(current).map(([id, entries]) => [id, { ...entries }]));
  for (const [providerId, entries] of Object.entries(patch)) {
    for (const [key, ref] of Object.entries(entries)) {
      const own = next[providerId];
      if (ref === null) {
        if (own !== undefined) delete own[key];
        continue;
      }
      (next[providerId] ??= {})[key] = ref;
    }
  }
  // A provider left with none is listed no more, as the read leaves it out.
  return Object.fromEntries(Object.entries(next).filter(([, entries]) => Object.keys(entries).length > 0));
}

/** A patch's title models over the saved ones: a key sets a provider's, null clears it. */
export function mergeModels(current: Readonly<Record<string, string>>, patch: Readonly<Record<string, string | null>> | undefined): Record<string, string> {
  const next: Record<string, string> = { ...current };
  for (const [id, model] of Object.entries(patch ?? {})) {
    if (model === null) delete next[id];
    else next[id] = model;
  }
  return next;
}
