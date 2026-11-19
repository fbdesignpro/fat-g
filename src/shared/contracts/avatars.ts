// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Avatars (docs/planning/_archive/M102.md, Design 1; C1, C2, C8, C13, C50–C56, C63; decision 0031): the art
// drawn for a model, read by main from two roots of one layout — fat-g's own built-in art, and the
// folder the user fills in fat-g's data folder. A family is a folder, each avatar a folder in it
// holding its files by role. What the folders and files are named, how a file is judged, the family's
// manifest, what the Avatars tab is shown, and what a session entry or a catalog model resolves to;
// the reference by which the preferences assign an avatar to a model (M103, C2); and how a manifest's
// match entry finds a model (M104, C1–C4).
//
// Renderer-safe: types, bounds, schemas and pure helpers. The page is shown ids, names, sizes and
// problem kinds, never a path but a file's relative to its root, and draws an avatar through the
// confined media route, `app://media/avatars/<id>` (src/main/media/).
import { z } from 'zod';
import { type OverlayLayer, type ResolvedOverlay, sameOverlay } from './avatar-overlay';
import { CATALOG_ID_MAX, CATALOG_MAX_BYTES } from './catalog';
import { cutTo } from './cut';
import type { ProviderId } from './provider';

// ── Folders and files (C1, C2, C5, C17) ───────────────────────────────────────────────────────

/** The user's root, in fat-g's data folder; the built-in root is `avatars` beside the archive. */
export const AVATARS_FOLDER = 'avatars';
/** A family's manifest (C11). */
export const MANIFEST_FILE = 'family.json';
/** A family's licence, where its manifest names one (C69). */
export const LICENSE_FILE = 'LICENSE.txt';

/** An avatar's files by role (C2): its portrait, required, and its small, optional. M105 adds roles. */
export const AVATAR_ROLES = ['portrait', 'small'] as const;

/**
 * The avatar folder every family needs (decision 0031): the family default — its style is the family's,
 * and a model nothing matches shows it. Its name matched without regard to ASCII case.
 */
export const DEFAULT_AVATAR = 'Default';

export function isDefaultFolder(name: string): boolean {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) === 'default';
}

/**
 * Which of a family's folders is its default: the one spelled `Default`, else the first other case of
 * it in the order given; any further case of it is an avatar like the others. The catalog and the
 * editor ask this one function.
 */
export function defaultFolderOf(folders: readonly string[]): string | undefined {
  return folders.includes(DEFAULT_AVATAR) ? DEFAULT_AVATAR : folders.find(isDefaultFolder);
}
export type AvatarRole = (typeof AVATAR_ROLES)[number];
export const AVATAR_FORMATS = ['png', 'webp'] as const;
export type AvatarFormat = (typeof AVATAR_FORMATS)[number];
export const AVATAR_MEDIA_TYPES: Readonly<Record<AvatarFormat, 'image/png' | 'image/webp'>> = { png: 'image/png', webp: 'image/webp' };

/** The role and format a file's name gives, its ASCII case aside on every system (C2); null for any other name. */
export function roleFileOf(name: string): { readonly role: AvatarRole; readonly format: AvatarFormat } | null {
  const match = /^(portrait|small)\.(png|webp)$/.exec(name.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
  return match === null ? null : { role: match[1] as AvatarRole, format: match[2] as AvatarFormat };
}

// ── Bounds (C50, C53, C55, C58) ───────────────────────────────────────────────────────────────

/** What the scan reads of an image for its header; a PNG whose chunks reach no IDAT within it is read whole (C53). */
export const AVATAR_HEADER_BYTES = 64 * 1024;
/** Entries listed in one root, folders and files at any depth, before its scan stops (C58). */
export const AVATAR_SCAN_LIMIT = 2000;
/**
 * The manifest's format (decisions 0014, 0032): both version fields advance together;
 * version 7 adds the family's provider scope.
 */
export const MANIFEST_VERSION = 7;
/** A larger manifest is refused whole, unread: the catalog override's bound (C55). */
export const MANIFEST_MAX_BYTES = CATALOG_MAX_BYTES;
/** What the listing shows of a name, an author, a licence or a match entry, in UTF-16 units. */
export const AVATAR_DISPLAY_MAX = 200;

/** An avatar file's id: opaque, minted by main at each scan, within the route's segment alphabet (C60). */
export const AVATAR_ID = /^[0-9a-f]{32}$/;

export function isAvatarId(value: unknown): value is string {
  return typeof value === 'string' && AVATAR_ID.test(value);
}

/** The media address of an avatar's file: the route's source and its id, never a path (C60). */
export function avatarAddress(id: string): string {
  return `app://media/avatars/${id}`;
}

// ── What an avatar is (C1, C20) ───────────────────────────────────────────────────────────────

/** Which root a family is in: a user family named like a built-in one is a family of its own (C20). */
export type AvatarOrigin = 'built-in' | 'user';

/** An avatar's identity (C1): its root's origin and its family's and its own folders' names, as listed. */
export interface AvatarRef {
  readonly origin: AvatarOrigin;
  readonly family: string;
  readonly avatar: string;
}

/** A folder's name as a reference holds it, at most, in UTF-16 units (M103, C2). */
export const AVATAR_NAME_MAX = 255;

const refName = z.string().min(1).max(AVATAR_NAME_MAX);

/**
 * An avatar reference as the preferences keep one (M103, C2): nothing else of a name's form is
 * checked, since the names are compared with the listing and never made into a path (C11).
 */
export const AvatarRefSchema: z.ZodType<AvatarRef> = z.strictObject({ origin: z.enum(['built-in', 'user']), family: refName, avatar: refName });

export function isAvatarRef(value: unknown): value is AvatarRef {
  return AvatarRefSchema.safeParse(value).success;
}

/** The same avatar: the same origin and the same two names, compared as strings (C4, C6). */
export function sameRef(a: AvatarRef, b: AvatarRef): boolean {
  return a.origin === b.origin && a.family === b.family && a.avatar === b.avatar;
}

/** The assignments: by provider id, then by CLI key or resolved version id, an avatar reference. */
export type Assignments = Readonly<Record<string, Readonly<Record<string, AvatarRef>>>>;

/** A family's identity: its root's origin and its folder's name, as listed. */
export interface FamilyRef {
  readonly origin: AvatarOrigin;
  readonly family: string;
}

export const FamilyRefSchema: z.ZodType<FamilyRef> = z.strictObject({ origin: z.enum(['built-in', 'user']), family: refName });

export function isFamilyRef(value: unknown): value is FamilyRef {
  return FamilyRefSchema.safeParse(value).success;
}

/** The active family of each provider the user chose, by provider id (decision 0031). */
export type ActiveFamilies = Readonly<Record<string, FamilyRef>>;

/** A usable file of an avatar, as the tab shows it. */
export interface AvatarFileView {
  readonly id: string;
  readonly role: AvatarRole;
  readonly format: AvatarFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/**
 * Why a model draws its avatar (decision 0031): the user's override, its active family's match, that
 * family's face, or the built-in face of its provider.
 */
export type AvatarSource = 'override' | 'match' | 'family-face' | 'built-in-face';

/**
 * What a session entry or a catalog model draws (C29, C32): the avatar and the ids of its usable
 * files. An avatar without a usable portrait resolves nowhere (C10). A model's resolution also says
 * why it draws it and what its overlay draws (decision 0032); the catalog's own avatars carry neither.
 */
export interface ResolvedAvatar {
  readonly ref: AvatarRef;
  readonly portrait: string;
  readonly small: string | null;
  readonly source?: AvatarSource;
  readonly overlay?: ResolvedOverlay | null;
}

/** Whether two resolutions draw the same: the same files, for the same reason, under the same overlay. */
export function sameAvatar(a: ResolvedAvatar | null, b: ResolvedAvatar | null): boolean {
  if (a === null || b === null) return a === b;
  return a.portrait === b.portrait && a.small === b.small && sameRef(a.ref, b.ref) && a.source === b.source && sameOverlay(a.overlay, b.overlay);
}

// ── Problems (C5, C8, C10, C15, C54, C55, C58) ────────────────────────────────────────────────

/** Why a role file is not used (C8, C54). */
export const AVATAR_FILE_PROBLEMS = ['wrong-type', 'not-square', 'too-large-bytes', 'too-large-pixels', 'animated', 'damaged', 'unreadable', 'link', 'duplicate-role'] as const;
export type AvatarFileProblem = (typeof AVATAR_FILE_PROBLEMS)[number];

/** Why a manifest was refused whole, in the order they are checked: the catalog override's causes (C55). */
export const MANIFEST_CAUSES = ['unreadable', 'too-large', 'not-json', 'damaged', 'newer', 'older', 'invalid'] as const;
export type ManifestCause = (typeof MANIFEST_CAUSES)[number];

/**
 * A problem, named by its file or folder relative to its root, with `/` between names. A file that is
 * no role is no problem: it is listed under its avatar as not used (C5).
 */
export type AvatarProblem =
  | { readonly kind: AvatarFileProblem; readonly path: string }
  /** An avatar with no usable portrait (C10): listed, drawn nowhere. */
  | { readonly kind: 'no-portrait'; readonly path: string }
  /** A family with no `Default` folder holding a usable portrait: listed, never chosen nor drawn from (decision 0031). */
  | { readonly kind: 'no-default'; readonly path: string }
  /** The manifest refused whole (C55): its cause, and for `invalid` the field, as `avatars.2.matches.0`. */
  | { readonly kind: 'manifest'; readonly path: string; readonly cause: ManifestCause; readonly field: string | null }
  /** An avatar the manifest lists with no folder (C15): `path` is the folder it names. */
  | { readonly kind: 'listed-missing'; readonly path: string }
  /** Overlay fields not of their form, dropped one by one (decision 0032): `fields` as `avatars.2.overlay.size`. */
  | { readonly kind: 'overlay-field'; readonly path: string; readonly fields: readonly string[] }
  /** The scan stopped at its bound (C58): `path` is the folder it was listing. */
  | { readonly kind: 'stopped'; readonly path: string }
  /** A root that could not be listed: `path` is empty, the root itself. */
  | { readonly kind: 'root-unreadable'; readonly path: string };

// ── What the Avatars tab is shown (C36–C39, C63) ──────────────────────────────────────────────

export interface AvatarView {
  /** Its folder's name, as listed: its identity in the family (C1). */
  readonly folder: string;
  /** Its usable files, the portrait first. */
  readonly files: readonly AvatarFileView[];
  /** The files in its folder that are no role (C5). */
  readonly unused: readonly string[];
  /** Its match entries, in the manifest's order (C56; M104, C2). */
  readonly matches: readonly MatchEntryView[];
  readonly problems: readonly AvatarProblem[];
  /**
   * Whether it is its family's default (decision 0031): its `Default` folder, with a usable portrait —
   * the family's style is its own, and a model nothing matches shows it, whatever its provider. Its
   * match entries and its own layer are not read.
   */
  readonly fallback: boolean;
  /** Its manifest's overlay layer, where it has one (decision 0032). */
  readonly overlay?: OverlayLayer;
}

export interface FamilyView {
  readonly origin: AvatarOrigin;
  /** `any`, or the provider this family is offered to. */
  readonly provider: string;
  /** Its folder's name, as listed (C1): the family's name, wherever it is shown. */
  readonly folder: string;
  readonly author: string | null;
  readonly licence: string | null;
  /**
   * The providers whose starting family its manifest says it is, among the registered ones: honoured
   * for fat-g's own families alone, until the user chooses another (decision 0031).
   */
  readonly defaultFor: readonly ProviderId[];
  /** Provider ids its manifest names that this build does not register: kept, unused, named (C15). */
  readonly unknownProviders: readonly string[];
  readonly problems: readonly AvatarProblem[];
  /** In the family's order: the manifest's, then the others by name (C16). */
  readonly avatars: readonly AvatarView[];
  /** Its manifest's overlay layer, where it has one (decision 0032). */
  readonly overlay?: OverlayLayer;
}

export interface AvatarRootView {
  readonly origin: AvatarOrigin;
  /** By name (C37). */
  readonly families: readonly FamilyView[];
  /** `stopped` and `root-unreadable`, drawn above its families (C58). */
  readonly problems: readonly AvatarProblem[];
}

/** `avatars:list`'s answer: the built-in root, then the user's (C37). */
export interface AvatarListing {
  readonly roots: readonly AvatarRootView[];
}

// ── The manifest (C11, C13, C15, C55, C56) ────────────────────────────────────────────────────

/** A model key, or a pattern holding `*`: the catalog id's alphabet with `*` added, as long as a key may be (C56). */
const MATCH_KEY = /^[A-Za-z0-9._\-:/@[\]*]+$/;

/** Whether a key or a pattern is of the form a match entry takes (C56): what M104 checks before it resolves one. */
export function isMatchKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CATALOG_ID_MAX && MATCH_KEY.test(value);
}

const matchKey = z.string().refine(isMatchKey, 'not a model key or pattern');
/** A match entry (C56): a key or pattern for any provider, or one for the provider it names. */
export const MatchEntrySchema = z.union([matchKey, z.looseObject({ provider: z.string().min(1).max(CATALOG_ID_MAX), key: matchKey })]);
export type MatchEntry = z.infer<typeof MatchEntrySchema>;

/** A folder's name as the manifest gives it: compared with the names listed, never made into a path. */
const folderName = z.string().min(1).max(255);

/** `any` keeps a family available to every provider; other values are extensible provider ids. */
export const FamilyProviderSchema = z.string().min(1).max(64);

export function familySupports(family: { readonly provider: string }, providerId: string): boolean {
  return family.provider === 'any' || family.provider === providerId;
}

/**
 * `family.json` (C13, C15): loose at every level, so a field this build does not know is skipped,
 * and strict about the form of what it does. The envelope is read first, apart (decision 0014). An
 * `overlay` is the exception: read field by field (src/shared/contracts/avatar-overlay.ts), a field of
 * the wrong form dropped and named, never refusing the manifest (decision 0032). A family's name is its
 * folder's: a `name` an older file holds is kept, unread. `defaultFor` names the providers whose
 * starting family it is. The family default is no field of it, but its `Default` folder; an entry for
 * that folder is kept as written, unread.
 */
export const ManifestSchema = z.looseObject({
  provider: FamilyProviderSchema.default('any'),
  author: z.string().optional(),
  licence: z.string().optional(),
  overlay: z.unknown().optional(),
  avatars: z.array(z.looseObject({ folder: folderName, matches: z.array(MatchEntrySchema).optional(), overlay: z.unknown().optional() })).optional(),
  defaultFor: z.array(z.string().min(1).max(64)).max(16).optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ── The match entries resolved (M104, C1–C4) ──────────────────────────────────────────────────

/**
 * A match entry as the listing carries it (M104, C2): `provider` null for any provider, else the id
 * the manifest names, cleaned for display; `key` a key, or a pattern holding `*`.
 */
export interface MatchEntryView {
  readonly provider: string | null;
  readonly key: string;
}

/** A manifest's entry as the listing carries it (M104, C2). */
export function matchView(entry: MatchEntry): MatchEntryView {
  return typeof entry === 'string' ? { provider: null, key: entry } : { provider: displayText(entry.provider) ?? entry.provider, key: entry.key };
}

/** A match entry as the tab shows it: `pattern`, or `provider: pattern` (C56). */
export function matchViewText(entry: MatchEntryView): string {
  return displayText(entry.provider === null ? entry.key : `${entry.provider}: ${entry.key}`) ?? '';
}

/** Each entry's pattern, made once. */
const patterns = new WeakMap<MatchEntryView, RegExp>();

/**
 * The pattern of an entry's key: each character as itself but `*`, which stands for any run, the
 * whole compared. A key's and a pattern's alphabets are ASCII, so `i` sets ASCII case aside (C1).
 */
function patternOf(entry: MatchEntryView): RegExp {
  let pattern = patterns.get(entry);
  if (pattern === undefined) {
    pattern = new RegExp(`^${entry.key.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    patterns.set(entry, pattern);
  }
  return pattern;
}

/**
 * Whether an entry matches a model of a provider (M104, C1, C3): an entry for another provider never
 * does; else its key, as a pattern, matches the whole of the model's key or of its resolved id.
 */
export function matchesModel(entry: MatchEntryView, providerId: string, model: { readonly key: string; readonly resolvedId: string | null }): boolean {
  if (entry.provider !== null && entry.provider !== providerId) return false;
  const pattern = patternOf(entry);
  return pattern.test(model.key) || (model.resolvedId !== null && pattern.test(model.resolvedId));
}

/** What an entry's strength is made of (M104, C4). */
export interface MatchStrength {
  /** No `*`: a key. */
  readonly exact: boolean;
  /** Its characters other than `*`: what it pins down. */
  readonly literal: number;
  /** For one provider. */
  readonly qualified: boolean;
}

export function matchStrength(entry: MatchEntryView): MatchStrength {
  return { exact: !entry.key.includes('*'), literal: entry.key.replaceAll('*', '').length, qualified: entry.provider !== null };
}

/**
 * Negative when `a` is the stronger (M104, C4): an exact key over a pattern, then more characters
 * other than `*`, then a qualified entry over an unqualified one; zero when alike in all three.
 */
export function compareStrength(a: MatchEntryView, b: MatchEntryView): number {
  const left = matchStrength(a);
  const right = matchStrength(b);
  if (left.exact !== right.exact) return left.exact ? -1 : 1;
  if (left.literal !== right.literal) return right.literal - left.literal;
  if (left.qualified !== right.qualified) return left.qualified ? -1 : 1;
  return 0;
}

/**
 * The avatar of a family whose entry matches a model most strongly, with that entry (decision 0031):
 * `avatars` in the family's order, and at equal strength the first of them. Main's search of an active
 * family and the Avatars tab's account of it are this one function.
 */
export function strongestMatch<T extends { readonly matches: readonly MatchEntryView[] }>(avatars: readonly T[], providerId: string, model: { readonly key: string; readonly resolvedId: string | null }): { readonly avatar: T; readonly entry: MatchEntryView } | null {
  let best: { readonly avatar: T; readonly entry: MatchEntryView } | null = null;
  for (const avatar of avatars) {
    for (const entry of avatar.matches) {
      if (!matchesModel(entry, providerId, model)) continue;
      // Only a stronger entry takes the place: at equal strength the earlier avatar stands.
      if (best === null || compareStrength(entry, best.entry) < 0) best = { avatar, entry };
    }
  }
  return best;
}

/**
 * A text from a manifest or a folder, as the listing shows it: its control and format characters
 * gone, trimmed and cut to its bound; null when nothing is left.
 */
export function displayText(raw: string): string | null {
  const clean = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  return clean === '' ? null : cutTo(clean, AVATAR_DISPLAY_MAX).text;
}

// ── fat-g's words (C36–C39) ───────────────────────────────────────────────────────────────────

export const AVATAR_WORDS = {
  layout: 'A family is a folder holding a Default folder and any other avatars, each a folder holding portrait.png or portrait.webp, 512 px square.',
  rescan: 'Rescan',
  showFolder: 'Show avatars folder',
  preview: 'Preview',
  noneYet: 'None yet',
  builtIn: 'Built-in',
  user: 'Yours',
  couldNotDraw: 'Could not be drawn',
  fallback: 'Family default: shown when no model name matched',
  unused: (names: readonly string[]): string => `Not used: ${names.join(', ')}`,
  unknownProviders: (ids: readonly string[]): string => `Names providers this build does not have: ${ids.join(', ')}`,
} as const;

const MANIFEST_CAUSE_WORDS: Readonly<Record<ManifestCause, string>> = {
  unreadable: 'could not be read',
  'too-large': 'is larger than 256 KiB',
  'not-json': 'is not JSON',
  damaged: 'has no valid version',
  newer: 'needs a newer fat-g',
  older: 'was written for an earlier version of fat-g',
  invalid: 'holds a field of the wrong form',
};

/** A problem in fat-g's words, its file named relative to its root. */
export function avatarProblemWords(problem: AvatarProblem): string {
  const at = problem.path;
  switch (problem.kind) {
    case 'wrong-type':
      return `${at}: not a PNG or WebP image, or its name says another type`;
    case 'not-square':
      return `${at}: not square`;
    case 'too-large-bytes':
      return `${at}: larger than 5 MiB`;
    case 'too-large-pixels':
      return `${at}: more than 8,000 pixels a side`;
    case 'animated':
      return `${at}: animated`;
    case 'damaged':
      return `${at}: damaged`;
    case 'unreadable':
      return `${at}: could not be read`;
    case 'link':
      return `${at}: a link, which fat-g does not follow`;
    case 'duplicate-role':
      return `${at}: two files for one role, so neither is used`;
    case 'no-portrait':
      return `${at}: no usable portrait, so it is drawn nowhere`;
    case 'no-default':
      return `${at}: no ${DEFAULT_AVATAR} folder holding portrait.png or portrait.webp, so the family is not used`;
    case 'manifest':
      return `${at} ${MANIFEST_CAUSE_WORDS[problem.cause]}${problem.field === null ? '' : ` (${problem.field})`}, so the family stands as its folders`;
    case 'listed-missing':
      return `${at}: listed in ${MANIFEST_FILE}, but there is no such folder`;
    case 'overlay-field':
      return `${at}: overlay fields of the wrong form, left out: ${problem.fields.join(', ')}`;
    case 'stopped':
      return `The scan stopped at ${AVATAR_SCAN_LIMIT.toLocaleString('en-US')} entries, in ${at === '' ? 'the folder itself' : at}: what follows is not listed`;
    case 'root-unreadable':
      return 'The folder could not be read';
  }
}
