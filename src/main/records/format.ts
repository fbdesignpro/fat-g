// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The records file, version 8 (docs/planning/_archive/M12.md, Design 2; M14.md, Design 1; M14b.md, Design 8;
// M18.md, Design 7; M22.md, Design 9; decision 0011):
//
//   { "schemaVersion": 8, "minReaderVersion": 8,
//     "projects": [ { id, name, color, roots, hidden, collapsed, providers, permissionModes } ],
//     "sessions": [ { id, projectId, providerId, instanceId, reference, folder, configFolder, model,
//                     effort, speed, name, nameSource, starred, toDo, toVerify, shelvedAt,
//                     completedAt, createdAt, lastActiveAt,
//                     lastTurn: { turnId, startedAt, endedAt, outcome } } ] }
//
// It holds no conversation: what was said is in the conversation store (decision 0019), and the two
// are reconciled by a session's id and its last turn's id (M18, C27–C29). Of what a session may do
// it holds a project's default mode for each provider and nothing else (M22, C25, C40): a chat's
// own mode, its turns' and every decision are the conversation store's.
//
// Each entry of either list is read on its own: one this build cannot read keeps its place and its
// value through every write, and does not stop the others (M12, C6; M14, C3). Fields this build does
// not know stay where they are, at the top, in a project, in a root and in a session (C11). The
// order of each list is its stored order: no order field is written. The page never sees this file.
import { catalogId } from '@shared/contracts/catalog';
import { type InstanceId, isInstanceId } from '@shared/contracts/instances';
import { normalizeName, normalizeSessionName } from '@shared/contracts/names';
import { isModeId } from '@shared/contracts/permissions';
import { isProjectColor, type ProjectColor, TRUST_ANSWERS, type TrustAnswer } from '@shared/contracts/projects';
import { isNameSource, type LastTurn, MAX_REFERENCE, type NameSource, TURN_OUTCOMES, type TurnOutcome } from '@shared/contracts/sessions';
import { plainObject } from '../storage/envelope';
import { isAbsoluteRoot } from './paths';

export const RECORDS_FILE = 'records.json';
/**
 * The format this build reads and writes. A session's speed tier raised both numbers to 8 (decision
 * 0016), saved project folds to 7. The session flags and the shelf raised them to 6,
 * as M22 raised them to 5, for a project's default modes, M18 to 4, for the last turn's id, M14b to 3
 * and M14 to 2, with no migration: an older file is refused as older, with Start fresh (decision
 * 0014; M14, C1; M14b, C26; M18, C29; M22, C25).
 */
export const RECORDS_VERSION = 8;

export type RawDocument = Record<string, unknown>;

/** What this build understands of one project entry. The raw entry beside it is what is written. */
export interface ProjectRecord {
  readonly id: string;
  /** Normalized (C16): what the view shows, and what the next write stores. */
  readonly name: string;
  /** Null for a colour this build does not know, which stays on disk (C12). */
  readonly color: ProjectColor | null;
  readonly roots: readonly RootRecord[];
  readonly hidden: boolean;
  readonly collapsed: boolean;
  /** Every id stored, known or not, in stored order. */
  readonly providers: readonly string[];
  /**
   * The project's default mode for a provider's new chats (M22, C40): by provider id, a mode's id.
   * A provider with no entry uses the user's own default. Every entry stored that reads as one,
   * whether or not this build knows its provider or the provider still lists the mode.
   */
  readonly permissionModes: Readonly<Record<string, string>>;
}

/** A project's default modes as its entry stores them: the entries that are a provider id and a mode id, and none for anything else. */
function readModes(value: unknown): Record<string, string> {
  if (!plainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[0] !== '' && isModeId(entry[1])));
}

export interface RootRecord {
  readonly path: string;
  /** Null when there is no answer, or one this build does not know (C83). */
  readonly answer: TrustAnswer | null;
}

/** Any 8-4-4-4-12 hexadecimal UUID: a hand-edited id need not carry RFC 4122's version bits. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** One entry of `projects`, or null when it cannot be read (Design 2, "Entries"). */
export function readProject(raw: unknown, platform: string): ProjectRecord | null {
  if (!plainObject(raw)) return null;
  const { id, name, color, roots, hidden, providers } = raw;
  if (!isUuid(id)) return null;
  if (typeof name !== 'string') return null;
  const shown = normalizeName(name);
  if (shown === '') return null;
  if (typeof color !== 'string') return null;
  if (!Array.isArray(roots) || roots.length === 0) return null;
  const rootRecords: RootRecord[] = [];
  for (const root of roots) {
    if (!plainObject(root) || typeof root['path'] !== 'string' || !isAbsoluteRoot(root['path'], platform)) return null;
    rootRecords.push({ path: root['path'], answer: trustAnswer(root['trust']) });
  }
  if (typeof hidden !== 'boolean') return null;
  if (!Array.isArray(providers) || !providers.every((provider) => typeof provider === 'string')) return null;
  return { id, name: shown, color: isProjectColor(color) ? color : null, roots: rootRecords, hidden, collapsed: raw['collapsed'] === true, providers, permissionModes: readModes(raw['permissionModes']) };
}

/** What this build understands of one session entry (M14, C2). The raw entry beside it is what is written. */
export interface SessionRecord {
  readonly id: string;
  /** The project, by id: its roots may change after the session starts (C4). */
  readonly projectId: string;
  readonly providerId: string;
  /** Which of the provider's instances runs it: stored at create and never changed (M14b, C26). */
  readonly instanceId: InstanceId;
  /** The provider's own session id, opaque; null until the provider session exists (C5). */
  readonly reference: string | null;
  /** The folder it started in, stored with the reference and kept from then on (C6). */
  readonly folder: string | null;
  /**
   * The configuration folder its instance had when the reference was stored, in that same write and
   * kept from then on (M14b, C61): the provider's session lives in that folder and no other. Null
   * until then, and for a provider that declares no instances. Never sent to a window.
   */
  readonly configFolder: string | null;
  /** The catalog's key (C7), fixed at create (M14b, C55), and the effort id. */
  readonly model: string;
  readonly effort: string | null;
  /** The speed tier its turns ask for, by the model's id for it; null for standard speed (decision 0016). Changed as the effort is. */
  readonly speed: string | null;
  /** Normalized; null with its source until the session has a name (C8). */
  readonly name: string | null;
  readonly nameSource: NameSource | null;
  /** Its flags (`@shared/contracts/session-flags`), one field each. */
  readonly starred: boolean;
  readonly toDo: boolean;
  readonly toVerify: boolean;
  /** When it was shelved; never set together with `completedAt`. A turn clears both. */
  readonly shelvedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly lastTurn: LastTurn | null;
}

/**
 * What a session is, from its creation on: no change may set these (C12; M14b, C26, C55). The model
 * is the catalog's key, the value the CLI takes to select one (M14b, C63): what a session later
 * reports it runs with is the summary's, and never written here.
 */
export const FIXED_SESSION_FIELDS = ['id', 'projectId', 'providerId', 'instanceId', 'model', 'createdAt'] as const;
type FixedSessionField = (typeof FIXED_SESSION_FIELDS)[number];

/**
 * The fields a change may set (C12). The reference, the folder and the configuration folder are set
 * once, together, and kept (C5, C6; M14b, C61).
 */
export type SessionChange = Partial<Omit<SessionRecord, FixedSessionField>>;

/** Whether a change may carry this field. The store drops any other, whatever a recipe returns. */
export function isChangeableField(field: string): field is keyof SessionChange {
  return (CHANGEABLE as readonly string[]).includes(field);
}

const CHANGEABLE: readonly (keyof SessionChange)[] = [
  'reference',
  'folder',
  'configFolder',
  'effort',
  'speed',
  'name',
  'nameSource',
  'starred',
  'toDo',
  'toVerify',
  'shelvedAt',
  'completedAt',
  'lastActiveAt',
  'lastTurn',
];

/** A time: a whole number of milliseconds, zero or more. */
function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const isCatalogId = (value: unknown): value is string => typeof value === 'string' && catalogId(value) !== null;

function readLastTurn(value: unknown): LastTurn | null | undefined {
  if (value === null) return null;
  if (!plainObject(value)) return undefined;
  const { turnId, startedAt, endedAt, outcome } = value;
  // The runtime's id for the turn, as an event carries it (M18, C29).
  if (typeof turnId !== 'string' || turnId.length < 1 || turnId.length > 128) return undefined;
  if (!isTime(startedAt) || !(endedAt === null || isTime(endedAt))) return undefined;
  if (!(outcome === null || (typeof outcome === 'string' && (TURN_OUTCOMES as readonly string[]).includes(outcome)))) return undefined;
  return { turnId, startedAt, endedAt, outcome: outcome as TurnOutcome | null };
}

/**
 * One entry of `sessions`, or null when it cannot be read (M14, Design 1, "Entries"). Whether an
 * earlier entry already uses its id is the store's to say.
 */
export function readSession(raw: unknown, platform: string): SessionRecord | null {
  if (!plainObject(raw)) return null;
  const { id, projectId, providerId, instanceId, reference, folder, configFolder, model, effort, speed, name, nameSource, starred, toDo, toVerify, shelvedAt, completedAt, createdAt, lastActiveAt } = raw;
  if (!isUuid(id) || !isUuid(projectId)) return null;
  if (!isCatalogId(providerId) || !isCatalogId(model)) return null;
  // The first instance's id, or an added one's UUID (M14b, C26).
  if (!isInstanceId(instanceId)) return null;
  if (!(configFolder === null || (typeof configFolder === 'string' && isAbsoluteRoot(configFolder, platform)))) return null;
  if (!(effort === null || isCatalogId(effort))) return null;
  if (!(speed === null || isCatalogId(speed))) return null;
  if (!(reference === null || (typeof reference === 'string' && reference.length >= 1 && reference.length <= MAX_REFERENCE && !/\p{Cc}/u.test(reference)))) return null;
  if (!(folder === null || (typeof folder === 'string' && isAbsoluteRoot(folder, platform)))) return null;
  let shown: string | null = null;
  if (name !== null || nameSource !== null) {
    if (typeof name !== 'string' || !isNameSource(nameSource)) return null;
    shown = normalizeSessionName(name);
    if (shown === '') return null;
  }
  if (typeof starred !== 'boolean' || typeof toDo !== 'boolean' || typeof toVerify !== 'boolean') return null;
  if (!(completedAt === null || isTime(completedAt))) return null;
  // Shelved or completed, never both: each takes the session out of the active list its own way.
  if (!(shelvedAt === null || (isTime(shelvedAt) && completedAt === null))) return null;
  if (!isTime(createdAt) || !isTime(lastActiveAt)) return null;
  const lastTurn = readLastTurn(raw['lastTurn']);
  if (lastTurn === undefined) return null;
  return {
    id,
    projectId,
    providerId,
    instanceId,
    reference,
    folder,
    configFolder,
    model,
    effort,
    speed,
    name: shown,
    nameSource: shown === null ? null : nameSource,
    starred,
    toDo,
    toVerify,
    shelvedAt,
    completedAt,
    createdAt,
    lastActiveAt,
    lastTurn,
  };
}

/** The project id a session entry stores, readable or not; null when that id cannot be read (C13, C107). */
export function storedProjectId(raw: unknown): string | null {
  return plainObject(raw) && isUuid(raw['projectId']) ? raw['projectId'] : null;
}

/** The id a project entry stores, readable or not; null when it stores none. */
export function storedId(raw: unknown): string | null {
  return plainObject(raw) && typeof raw['id'] === 'string' ? raw['id'] : null;
}

/** A stored `trust`: `{ answer, answeredAt }`. Anything else reads as not answered (C83). */
export function trustAnswer(value: unknown): TrustAnswer | null {
  if (!plainObject(value)) return null;
  const answer = value['answer'];
  return typeof answer === 'string' && (TRUST_ANSWERS as readonly string[]).includes(answer) ? (answer as TrustAnswer) : null;
}
