// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A family's `family.json` written (decisions 0031, 0032): made with fat-g's defaults where a family
// holding avatars has none, at the scan of a root fat-g may write, and replaced whole by the family
// editor's save. This module writes only the manifest. Make a copy creates a separate user family
// with unchanged artwork in copy-family.ts; Add avatar's new folder is add-avatar.ts's, whose entry
// is written here as a save would write it (decision 0036).
//
// Which roots may be written is the service's option: the user's folder, and fat-g's own art only in a
// development run, where it is the repository's assets/avatars; never in an installed copy.
//
// A save is made from a draft and the revision it was made from. The file is read again, and a change
// made outside since is refused as a conflict; the family's folder is checked again — no link, its real
// path one folder inside its root's — and the file too; every name of the draft is checked against the
// scan and the file. What fat-g does not know of the file is kept, unknown fields at every level, and
// so is what the editor does not edit: `defaultFor`, set by hand. A file fat-g refuses is never written.
//
// Electron-free: the file system is a parameter (fs.ts).
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AvatarDraft, FamilyDraft, FamilyLock, FamilySource, SaveFamilyAnswer, SaveFamilyRequest } from '@shared/contracts/avatar-family';
import { EFFORT_LOOK_FIELDS, type OverlayLayer, readOverlayLayer, SEEDED_OVERLAY, VERSION_LOOK_FIELDS } from '@shared/contracts/avatar-overlay';
import { defaultFolderOf, type Manifest, MANIFEST_FILE, MANIFEST_MAX_BYTES, MANIFEST_VERSION, type MatchEntry } from '@shared/contracts/avatars';
import { plainObject as plain } from '../storage/envelope';
import { errorCode } from '../storage/json-file';
import type { AvatarFs } from './fs';
import { type ManifestReading, parseManifest } from './manifest';
import type { ScannedFamily, ScannedRoot } from './scan';

/** The fields of each style this build reads: any other a file holds is kept as it is. */
const KNOWN_FIELDS: Readonly<Record<keyof OverlayLayer, ReadonlySet<string>>> = {
  version: new Set(['preset', 'parts', ...VERSION_LOOK_FIELDS]),
  effort: new Set(['show', ...EFFORT_LOOK_FIELDS]),
};

const BOM = '﻿';

/** A file's revision: its bytes' SHA-256. */
export function revisionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const written = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The file fat-g makes where a family has none: its defaults written out whole — the style of its
 * `Default` folder — and its other avatars in name order, matching nothing yet.
 */
export function seededManifest(folders: readonly string[]): string {
  const own = defaultFolderOf(folders);
  return written({ schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION, provider: 'any', overlay: SEEDED_OVERLAY, avatars: folders.filter((folder) => folder !== own).map((folder) => ({ folder, matches: [] })) });
}

/** The family's folder and its file, checked: a folder, not a link, one name inside its root's real path. */
export async function locate(root: ScannedRoot, family: ScannedFamily, fs: AvatarFs): Promise<{ readonly folder: string; readonly file: string } | null> {
  if (root.realRoot === null) return null;
  const folder = path.join(root.realRoot, family.folder);
  try {
    if ((await fs.lstat(folder)).kind !== 'folder') return null;
    const inside = path.relative(root.realRoot, await fs.realpath(folder));
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside) || inside.includes(path.sep)) return null;
  } catch {
    return null;
  }
  return { folder, file: path.join(folder, MANIFEST_FILE) };
}

/** The file as it is now: its bytes, fat-g's reading of them, its raw object, or a link where it should be. */
export interface Current {
  readonly bytes: Uint8Array | null;
  readonly reading: ManifestReading;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly link: boolean;
}

export async function readCurrent(file: string, fs: AvatarFs): Promise<Current> {
  const unreadable = (code: string | null): Current => ({ bytes: null, reading: { kind: 'refused', cause: 'unreadable', field: null, code }, raw: {}, link: false });
  let size: number;
  try {
    const stat = await fs.lstat(file);
    if (stat.kind !== 'file') return { ...unreadable(null), link: true };
    size = stat.size;
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? { bytes: null, reading: { kind: 'none' }, raw: {}, link: false } : unreadable(null);
  }
  const tooLarge: Current = { bytes: null, reading: { kind: 'refused', cause: 'too-large', field: null, code: null }, raw: {}, link: false };
  if (size > MANIFEST_MAX_BYTES) return tooLarge;
  let bytes: Uint8Array | null;
  try {
    bytes = await fs.readWhole(file, MANIFEST_MAX_BYTES);
  } catch {
    return unreadable(null);
  }
  if (bytes === null) return tooLarge;
  let raw: Readonly<Record<string, unknown>> = {};
  try {
    const text = new TextDecoder().decode(bytes);
    const value: unknown = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
    if (plain(value)) raw = value;
  } catch {
    // parseManifest says why.
  }
  return { bytes, reading: parseManifest(bytes), raw, link: false };
}

/** A family with no file of its own: its folders but its `Default` in name order, with the defaults. */
function foldersDraft(folders: readonly string[]): FamilyDraft {
  const own = defaultFolderOf(folders);
  return { provider: 'any', overlay: SEEDED_OVERLAY, avatars: folders.filter((folder) => folder !== own).map((folder) => ({ folder, matches: [], overlay: {} })) };
}

/** A match entry as a draft holds it: a key or pattern, or a provider's. */
const matchDraft = (entry: MatchEntry): MatchEntry => (typeof entry === 'string' ? entry : { provider: entry.provider, key: entry.key });

/**
 * What a file holds, as the editor edits it: its entries in its order, then the folders it does not
 * list; the `Default` folder apart, its style the family's.
 */
function draftOf(manifest: Manifest, folders: readonly string[]): FamilyDraft {
  const own = defaultFolderOf(folders);
  const avatars: AvatarDraft[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.avatars ?? []) {
    // Listed twice: the first stands, as the scan reads it. The default is no entry of the draft.
    if (seen.has(entry.folder) || entry.folder === own) continue;
    seen.add(entry.folder);
    avatars.push({ folder: entry.folder, matches: (entry.matches ?? []).map(matchDraft), overlay: readOverlayLayer(entry.overlay).layer });
  }
  for (const folder of folders) if (!seen.has(folder) && folder !== own) avatars.push({ folder, matches: [], overlay: {} });
  return { provider: manifest.provider, overlay: readOverlayLayer(manifest.overlay).layer, avatars };
}

/**
 * Writes a family's file with fat-g's defaults where the scan found none and the family holds an
 * avatar. Answers how many it wrote. A family whose file the scan did not take — a `Family.json` on a
 * system that keeps both cases — is left alone, as is one that is no longer a plain folder.
 */
export async function seedMissing(root: ScannedRoot, fs: AvatarFs): Promise<number> {
  let made = 0;
  for (const family of root.families) {
    if (family.manifest.kind !== 'none' || family.avatars.length === 0) continue;
    const located = await locate(root, family, fs);
    if (located === null) continue;
    const absent = await fs.lstat(located.file).then(() => false, (error: unknown) => errorCode(error) === 'ENOENT');
    if (!absent) continue;
    try {
      await fs.writeText(located.file, seededManifest(family.avatars.map((avatar) => avatar.folder)));
      made += 1;
    } catch {
      // The family stands as its folders, as it did.
    }
  }
  return made;
}

/** A listed family as its file holds it now, and whether it can be saved. */
export async function openFamily(root: ScannedRoot, family: ScannedFamily, writable: boolean, fs: AvatarFs): Promise<FamilySource> {
  const ref = { origin: root.origin, family: family.folder };
  const folders = family.avatars.map((avatar) => avatar.folder);
  const located = await locate(root, family, fs);
  const current = located === null ? null : await readCurrent(located.file, fs);
  const lock: FamilyLock | null = !writable
    ? { kind: 'packaged' }
    : current === null || current.link
      ? { kind: 'link' }
      : current.reading.kind === 'refused'
        ? { kind: 'manifest', cause: current.reading.cause, field: current.reading.field }
        : null;
  const draft = current?.reading.kind === 'applied' ? draftOf(current.reading.manifest, folders) : foldersDraft(folders);
  const present = new Set(folders);
  return {
    ref,
    lock,
    revision: current?.bytes == null ? null : revisionOf(current.bytes),
    draft,
    missing: draft.avatars.filter((avatar) => !present.has(avatar.folder)).map((avatar) => avatar.folder),
  };
}

/** The first name of the draft the family does not hold, by its field; null when every one is its. */
function invalidField(draft: FamilyDraft, folders: readonly string[], listed: ReadonlySet<string>): string | null {
  const present = new Set(folders);
  const own = defaultFolderOf(folders);
  const seen = new Set<string>();
  for (const [index, avatar] of draft.avatars.entries()) {
    // The default's style is the family's: it is no avatar of the draft.
    if (avatar.folder === own) return `avatars.${index}.folder`;
    if (!present.has(avatar.folder) && !listed.has(avatar.folder)) return `avatars.${index}.folder`;
    if (seen.has(avatar.folder)) return `avatars.${index}.folder`;
    seen.add(avatar.folder);
  }
  return null;
}

/** A layer written over the file's: its known fields the draft's, its unknown ones kept; undefined when empty. */
function layerWritten(raw: unknown, layer: OverlayLayer): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = plain(raw) ? { ...raw } : {};
  for (const part of ['version', 'effort'] as const) {
    const before = base[part];
    const unknown = plain(before) ? Object.fromEntries(Object.entries(before).filter(([field]) => !KNOWN_FIELDS[part].has(field))) : {};
    const merged = { ...unknown, ...layer[part] };
    if (Object.keys(merged).length > 0) base[part] = merged;
    else delete base[part];
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

/** An avatar's entry written over the file's own: its folder, its matches and its layer; the rest kept. */
function avatarWritten(raw: Readonly<Record<string, unknown>> | undefined, avatar: AvatarDraft): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(raw ?? {}), folder: avatar.folder };
  if (avatar.matches.length > 0) base['matches'] = avatar.matches.map(matchDraft);
  else delete base['matches'];
  const layer = layerWritten(base['overlay'], avatar.overlay);
  if (layer === undefined) delete base['overlay'];
  else base['overlay'] = layer;
  return base;
}

/** The file a draft makes of the file there was: the version pair first, then its fields in their order. */
function manifestWritten(raw: Readonly<Record<string, unknown>>, draft: FamilyDraft, folders: readonly string[]): Record<string, unknown> {
  const own = defaultFolderOf(folders);
  const next: Record<string, unknown> = { schemaVersion: MANIFEST_VERSION, minReaderVersion: MANIFEST_VERSION };
  for (const [field, value] of Object.entries(raw)) if (!(field in next)) next[field] = value;
  next['provider'] = draft.provider;
  const overlay = layerWritten(raw['overlay'], draft.overlay);
  if (overlay === undefined) delete next['overlay'];
  else next['overlay'] = overlay;
  const entries = new Map<string, Readonly<Record<string, unknown>>>();
  const defaults: Readonly<Record<string, unknown>>[] = [];
  for (const entry of Array.isArray(raw['avatars']) ? (raw['avatars'] as unknown[]) : []) {
    if (!plain(entry) || typeof entry['folder'] !== 'string') continue;
    // An entry the file holds for its `Default` folder is not read, and is kept as written, first.
    if (entry['folder'] === own) defaults.push(entry);
    else if (!entries.has(entry['folder'])) entries.set(entry['folder'], entry);
  }
  next['avatars'] = [...defaults, ...draft.avatars.map((avatar) => avatarWritten(entries.get(avatar.folder), avatar))];
  return next;
}

/**
 * The file a new avatar's entry makes of the file there is (decision 0036): what a save of the draft
 * the file holds would write, the new entry last. `folders` are the family's as the scan listed them.
 */
export function manifestAdding(current: Current, folders: readonly string[], avatar: AvatarDraft): string {
  const draft = current.reading.kind === 'applied' ? draftOf(current.reading.manifest, folders) : foldersDraft(folders);
  return written(manifestWritten(current.raw, { ...draft, avatars: [...draft.avatars, avatar] }, [...folders, avatar.folder]));
}

/** A draft saved into a listed family's file, as a save's answer says. */
export async function saveFamily(root: ScannedRoot, family: ScannedFamily, writable: boolean, fs: AvatarFs, request: SaveFamilyRequest): Promise<SaveFamilyAnswer> {
  if (!writable) return { kind: 'locked', lock: { kind: 'packaged' } };
  const located = await locate(root, family, fs);
  if (located === null) return { kind: 'locked', lock: { kind: 'link' } };
  const current = await readCurrent(located.file, fs);
  if (current.link) return { kind: 'locked', lock: { kind: 'link' } };
  if ((current.bytes === null ? null : revisionOf(current.bytes)) !== request.revision) return { kind: 'conflict' };
  if (current.reading.kind === 'refused') return { kind: 'locked', lock: { kind: 'manifest', cause: current.reading.cause, field: current.reading.field } };
  const listed = new Set(current.reading.kind === 'applied' ? (current.reading.manifest.avatars ?? []).map((entry) => entry.folder) : []);
  const invalid = invalidField(request.draft, family.avatars.map((avatar) => avatar.folder), listed);
  if (invalid !== null) return { kind: 'invalid', field: invalid };
  const text = written(manifestWritten(current.raw, request.draft, family.avatars.map((avatar) => avatar.folder)));
  if (Buffer.byteLength(text) > MANIFEST_MAX_BYTES) return { kind: 'invalid', field: '' };
  try {
    await fs.writeText(located.file, text);
  } catch {
    return { kind: 'failed' };
  }
  return { kind: 'saved' };
}
