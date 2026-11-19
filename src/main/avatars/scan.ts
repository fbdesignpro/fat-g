// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The scan of one avatar root (docs/planning/_archive/M102.md, Design 3; C1, C2, C5, C8, C10, C17, C20, C21,
// C53, C54, C58): its families, each family's manifest, and each avatar's files by role, every role
// file judged by its header alone (src/main/images/headers.ts). Both roots — the built-in art and the
// user's folder — are read by this one function, into what the catalog (catalog.ts) is built from.
//
// It writes nothing, follows no link and enters no folder whose name starts with a dot (C58). Of an
// image it reads the first 64 KiB, and the whole of a PNG whose chunks reach no IDAT within them, its
// bound applied first (C53). Every entry it lists counts toward one bound a root, and at it the scan
// stops where it is and says where (C58).
//
// Electron-free: the file system is a parameter (fs.ts).
import path from 'node:path';
import {
  AVATAR_HEADER_BYTES,
  AVATAR_MEDIA_TYPES,
  AVATAR_ROLES,
  AVATAR_SCAN_LIMIT,
  type AvatarFormat,
  type AvatarOrigin,
  type AvatarProblem,
  type AvatarRole,
  displayText,
  MANIFEST_FILE,
  roleFileOf,
} from '@shared/contracts/avatars';
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from '@shared/contracts/images';
import { type HeaderReading, readImageHeader } from '../images/headers';
import { errorCode } from '../storage/json-file';
import type { AvatarEntry, AvatarFs } from './fs';
import { type ManifestReading, readManifest } from './manifest';

/** A role file that passed (C51, C54): what the catalog mints its id from and the route checks again. */
export interface ScannedFile {
  readonly role: AvatarRole;
  readonly format: AvatarFormat;
  readonly mediaType: 'image/png' | 'image/webp';
  readonly width: number;
  readonly height: number;
  /** Its size and modification time at the scan (C60). */
  readonly bytes: number;
  readonly mtimeMs: number;
  /** Its absolute path, for main alone. */
  readonly path: string;
  /** Its path relative to its root, with `/` between names. */
  readonly relative: string;
}

export interface ScannedAvatar {
  /** Its folder's name, as listed. */
  readonly folder: string;
  /** Its usable files, in role order. */
  readonly files: readonly ScannedFile[];
  /** The files in its folder that are no role (C5), by name. */
  readonly unused: readonly string[];
  readonly problems: readonly AvatarProblem[];
}

export interface ScannedFamily {
  readonly folder: string;
  readonly manifest: ManifestReading;
  /** By name, as far as the scan got. */
  readonly avatars: readonly ScannedAvatar[];
  /** A family folder that could not be listed. */
  readonly problems: readonly AvatarProblem[];
}

export interface ScannedRoot {
  readonly origin: AvatarOrigin;
  /** The root's real path, which every file it serves must be inside (C61); null for a root that could not be read. */
  readonly realRoot: string | null;
  /** By name, as far as the scan got. */
  readonly families: readonly ScannedFamily[];
  /** `stopped` and `root-unreadable` (C58). */
  readonly problems: readonly AvatarProblem[];
}

const collator = new Intl.Collator('en', { numeric: true });
/** The one order of names (C16, C30, C37): by the English collation, numbers by value, then by code unit. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

const byName = (entries: readonly AvatarEntry[]): AvatarEntry[] => [...entries].sort((a, b) => compareNames(a.name, b.name));
const hidden = (name: string): boolean => name.startsWith('.');

/** The one count of a root's entries (C58): what each listing takes of it, and where it ran out. */
class Budget {
  private left = AVATAR_SCAN_LIMIT;
  stoppedAt: string | null = null;

  get stopped(): boolean {
    return this.stoppedAt !== null;
  }

  /** The entries a listing may keep, by name: all of them, or as many as are left, the stop said. */
  take(entries: readonly AvatarEntry[], at: string): AvatarEntry[] {
    const sorted = byName(entries);
    if (sorted.length <= this.left) {
      this.left -= sorted.length;
      return sorted;
    }
    const kept = sorted.slice(0, this.left);
    this.left = 0;
    this.stoppedAt = at;
    return kept;
  }
}

type Judged = { readonly kind: 'ok'; readonly mediaType: 'image/png' | 'image/webp'; readonly width: number; readonly height: number } | { readonly kind: 'undecided' } | { readonly kind: 'problem'; readonly problem: AvatarProblem['kind'] };

/** A header against what an avatar's file must be (C51, C54): its extension's format, within the bound in pixels, square and still. */
function judge(reading: HeaderReading, format: AvatarFormat): Judged {
  if (reading.kind === 'refused') return { kind: 'problem', problem: reading.reason === 'unsupported' ? 'wrong-type' : 'damaged' };
  const mediaType = AVATAR_MEDIA_TYPES[format];
  if (reading.mediaType !== mediaType) return { kind: 'problem', problem: 'wrong-type' };
  if (reading.width > MAX_IMAGE_SIDE || reading.height > MAX_IMAGE_SIDE) return { kind: 'problem', problem: 'too-large-pixels' };
  if (reading.width !== reading.height) return { kind: 'problem', problem: 'not-square' };
  if (reading.animation === 'animated') return { kind: 'problem', problem: 'animated' };
  if (reading.animation === 'undecided') return { kind: 'undecided' };
  return { kind: 'ok', mediaType, width: reading.width, height: reading.height };
}

/** One role file (C53, C54): its size first, then its header from its first 64 KiB, or from the whole of a PNG they leave undecided. */
async function judgeFile(file: string, relative: string, role: AvatarRole, format: AvatarFormat, fs: AvatarFs): Promise<ScannedFile | AvatarProblem> {
  const problem = (kind: Exclude<AvatarProblem['kind'], 'manifest' | 'overlay-field'>): AvatarProblem => ({ kind, path: relative });
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch {
    return problem('unreadable');
  }
  // Replaced since it was listed.
  if (stat.kind === 'link') return problem('link');
  if (stat.kind !== 'file') return problem('unreadable');
  if (stat.size > MAX_IMAGE_BYTES) return problem('too-large-bytes');
  let judged: Judged;
  try {
    const prefix = await fs.readPrefix(file, AVATAR_HEADER_BYTES);
    const whole = prefix.byteLength < AVATAR_HEADER_BYTES || prefix.byteLength >= stat.size;
    judged = judge(readImageHeader(prefix, whole), format);
    if (judged.kind === 'undecided') {
      const bytes = await fs.readWhole(file, MAX_IMAGE_BYTES);
      if (bytes === null) return problem('too-large-bytes');
      judged = judge(readImageHeader(bytes, true), format);
    }
  } catch {
    return problem('unreadable');
  }
  if (judged.kind === 'problem') return { kind: judged.problem, path: relative } as AvatarProblem;
  if (judged.kind === 'undecided') return problem('damaged');
  return { role, format, mediaType: judged.mediaType, width: judged.width, height: judged.height, bytes: stat.size, mtimeMs: stat.mtimeMs, path: file, relative };
}

/** One avatar's folder, from its entries (C2, C5, C8, C10). */
async function scanAvatar(folder: string, at: string, entries: readonly AvatarEntry[], fs: AvatarFs): Promise<ScannedAvatar> {
  const relative = (name: string): string => `${at}/${name}`;
  const byRole = new Map<AvatarRole, { readonly entry: AvatarEntry; readonly format: AvatarFormat }[]>();
  const unused: string[] = [];
  for (const entry of entries) {
    // A dot name is passed over, and a folder is not entered (C5, C58).
    if (hidden(entry.name) || entry.kind === 'folder') continue;
    const role = roleFileOf(entry.name);
    if (role === null) {
      if (entry.kind === 'file') unused.push(displayText(entry.name) ?? entry.name);
      continue;
    }
    byRole.set(role.role, [...(byRole.get(role.role) ?? []), { entry, format: role.format }]);
  }
  const files: ScannedFile[] = [];
  const problems: AvatarProblem[] = [];
  for (const role of AVATAR_ROLES) {
    const candidates = byRole.get(role) ?? [];
    // Which one the author meant is not guessed (C8).
    if (candidates.length > 1) {
      for (const { entry } of candidates) problems.push({ kind: 'duplicate-role', path: relative(entry.name) });
      continue;
    }
    const [candidate] = candidates;
    if (candidate === undefined) continue;
    if (candidate.entry.kind === 'link') { problems.push({ kind: 'link', path: relative(candidate.entry.name) }); continue; }
    if (candidate.entry.kind !== 'file') { problems.push({ kind: 'unreadable', path: relative(candidate.entry.name) }); continue; }
    const judged = await judgeFile(path.join(folder, candidate.entry.name), relative(candidate.entry.name), role, candidate.format, fs);
    if ('role' in judged) files.push(judged);
    else problems.push(judged);
  }
  // Drawn nowhere, and a small alone never (C10).
  if (!files.some((file) => file.role === 'portrait')) problems.push({ kind: 'no-portrait', path: at });
  return { folder: path.basename(folder), files, unused, problems };
}

/**
 * One root, read into its families (C1, C17, C58). An absent user root is no problem: the user has
 * made no family yet. Nothing in it is written.
 */
export async function scanRoot(origin: AvatarOrigin, root: string, fs: AvatarFs): Promise<ScannedRoot> {
  const budget = new Budget();
  const unreadable: ScannedRoot = { origin, realRoot: null, families: [], problems: [{ kind: 'root-unreadable', path: '' }] };
  let listed: readonly AvatarEntry[];
  let realRoot: string;
  try {
    listed = await fs.list(root);
    realRoot = await fs.realpath(root);
  } catch (error) {
    return origin === 'user' && errorCode(error) === 'ENOENT' ? { origin, realRoot: null, families: [], problems: [] } : unreadable;
  }
  const families: ScannedFamily[] = [];
  // A file or a link at the root is passed over, and so is a dot name (C58).
  for (const entry of budget.take(listed, '')) {
    if (entry.kind !== 'folder' || hidden(entry.name) || budget.stopped) continue;
    const familyFolder = path.join(root, entry.name);
    let familyEntries: AvatarEntry[];
    try {
      familyEntries = budget.take(await fs.list(familyFolder), entry.name);
    } catch {
      families.push({ folder: entry.name, manifest: { kind: 'none' }, avatars: [], problems: [{ kind: 'unreadable', path: entry.name }] });
      continue;
    }
    const manifestEntry = familyEntries.find((candidate) => candidate.name === MANIFEST_FILE);
    const manifest: ManifestReading = manifestEntry === undefined ? { kind: 'none' } : await readManifest(path.join(familyFolder, MANIFEST_FILE), fs);
    const avatars: ScannedAvatar[] = [];
    const problems: AvatarProblem[] = [];
    for (const avatarEntry of familyEntries) {
      if (avatarEntry.kind !== 'folder' || hidden(avatarEntry.name) || budget.stopped) continue;
      const at = `${entry.name}/${avatarEntry.name}`;
      const avatarFolder = path.join(familyFolder, avatarEntry.name);
      let avatarEntries: AvatarEntry[];
      try {
        avatarEntries = budget.take(await fs.list(avatarFolder), at);
      } catch {
        problems.push({ kind: 'unreadable', path: at });
        continue;
      }
      avatars.push(await scanAvatar(avatarFolder, at, avatarEntries, fs));
    }
    families.push({ folder: entry.name, manifest, avatars, problems });
  }
  return { origin, realRoot, families, problems: budget.stoppedAt === null ? [] : [{ kind: 'stopped', path: budget.stoppedAt }] };
}
