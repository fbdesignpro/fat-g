// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The avatar catalog (docs/planning/_archive/M102.md, Design 5; C15, C16, C20, C22, C29, C30, C33, C37, C60):
// what both roots' scans make together — the listing the Avatars tab draws, the file behind each id
// the media route serves, and each provider's default face. Built whole at each scan, and held in
// memory alone (C57).
//
// An id is opaque: the first 32 hexadecimal digits of a SHA-256 of the file's root, its path in it,
// its size and its modification time, so that an unchanged file keeps its id across a Rescan and a
// restart, and a changed one gets a new one (C60). No address names a path.
//
// Electron-free and pure: the scans in, the catalog out.
import { createHash } from 'node:crypto';
import { avatarLayers, type OverlayLayer } from '@shared/contracts/avatar-overlay';
import { type AvatarFileView, type AvatarListing, type AvatarOrigin, type AvatarProblem, type AvatarRef, type AvatarRootView, type AvatarView, defaultFolderOf, type FamilyRef, familySupports, type FamilyView, type MatchEntryView, type ResolvedAvatar, strongestMatch } from '@shared/contracts/avatars';
import { familyShape } from './manifest';
import { compareNames, type ScannedFile, type ScannedRoot } from './scan';

/** What the avatar source checks a request against (C61). */
export interface AvatarFileEntry {
  readonly origin: AvatarOrigin;
  /** Its root's real path, which its own must be inside. */
  readonly realRoot: string;
  readonly path: string;
  readonly bytes: number;
  readonly mediaType: 'image/png' | 'image/webp';
  readonly width: number;
  readonly height: number;
}

/** The log line's numbers (C22): counts alone. */
export interface AvatarCounts {
  readonly builtInFamilies: number;
  readonly builtInAvatars: number;
  readonly userFamilies: number;
  readonly userAvatars: number;
  readonly problems: number;
}

/** A model as a family's match entries see it (M104, C1). */
export interface MatchedModel {
  readonly key: string;
  readonly resolvedId: string | null;
}

/**
 * A family as a provider's active family is searched (decision 0031): its avatars with a usable
 * portrait, in its order, with their match entries; and its default, its `Default` folder.
 */
export interface FamilyIndex {
  readonly ref: FamilyRef;
  /** The avatar whose entry matches the model most strongly; at equal strength the first in the family's order. */
  match(providerId: string, model: MatchedModel): ResolvedAvatar | null;
  /** Its `Default` folder for a provider in its scope, where it has a usable portrait; a user family's too. */
  face(providerId: string): ResolvedAvatar | null;
  /** Whether its provider scope fits and it has a default to draw. */
  usableFor(providerId: string): boolean;
}

export interface AvatarCatalog {
  readonly listing: AvatarListing;
  /** The file an id names; undefined for one this catalog did not mint (C60). */
  file(id: string): AvatarFileEntry | undefined;
  /** A provider's default face: the same object for as long as this catalog stands (C30, C33). */
  defaultFace(providerId: string): ResolvedAvatar | null;
  /**
   * The avatar a reference names (M103, C11): of its origin's root, the family and the avatar of
   * those folders' names; null for one this scan did not list and for one with no usable portrait.
   * The same object for as long as this catalog stands.
   */
  byRef(ref: AvatarRef): ResolvedAvatar | null;
  /** A listed family by its reference; undefined for one this scan did not list. */
  family(ref: FamilyRef): FamilyIndex | undefined;
  /** The built-in family whose manifest names it the provider's starting family: its active family until the user chooses one. */
  defaultFamily(providerId: string): FamilyRef | null;
  /** The overlay layers a listed avatar's manifest gives it: its family's, then its own (decision 0032). */
  layers(ref: AvatarRef): readonly (OverlayLayer | undefined)[];
  readonly counts: AvatarCounts;
}

/** Between the parts of an id's source: a character no path or number holds. */
const SEPARATOR = '\u0000';

export function avatarId(origin: AvatarOrigin, relative: string, bytes: number, mtimeMs: number): string {
  return createHash('sha256').update([origin, relative, String(bytes), String(mtimeMs)].join(SEPARATOR)).digest('hex').slice(0, 32);
}

/** The catalog before any scan has landed: nothing listed, no face (C57). */
export const EMPTY_CATALOG: AvatarCatalog = buildCatalog([{ origin: 'built-in', realRoot: null, families: [], problems: [] }, { origin: 'user', realRoot: null, families: [], problems: [] }], new Set());

/**
 * The catalog of the two roots' scans, the built-in root first (C17, C20). `known`: the provider ids
 * this build registers. A user family named like a built-in one stands beside it, and a user family's
 * `defaultFor` is shown and never followed (C20, C30): a provider's starting family and its face are
 * fat-g's own.
 */
export function buildCatalog(roots: readonly ScannedRoot[], known: ReadonlySet<string>): AvatarCatalog {
  const files = new Map<string, AvatarFileEntry>();
  const faces = new Map<string, ResolvedAvatar | null>();
  const defaultFamilies = new Map<string, FamilyRef>();
  /** Every listed avatar as drawn, by its reference (M103, C11). */
  const resolved = new Map<string, ResolvedAvatar | null>();
  const indexes = new Map<string, FamilyIndex>();
  const layers = new Map<string, readonly (OverlayLayer | undefined)[]>();
  const counts = { builtInFamilies: 0, builtInAvatars: 0, userFamilies: 0, userAvatars: 0, problems: 0 };

  const viewOf = (root: ScannedRoot): AvatarRootView => {
    const families = [...root.families].sort((a, b) => compareNames(a.folder, b.folder)).map((family): FamilyView => {
      const byFolder = new Map(family.avatars.map((avatar) => [avatar.folder, avatar]));
      const shape = familyShape(family.manifest, family.avatars.map((avatar) => avatar.folder), known, family.folder);
      const fileViews = new Map<ScannedFile, AvatarFileView>();
      for (const avatar of family.avatars) {
        for (const file of avatar.files) {
          const id = avatarId(root.origin, file.relative, file.bytes, file.mtimeMs);
          fileViews.set(file, { id, role: file.role, format: file.format, width: file.width, height: file.height, bytes: file.bytes });
          if (root.realRoot !== null) files.set(id, { origin: root.origin, realRoot: root.realRoot, path: file.path, bytes: file.bytes, mediaType: file.mediaType, width: file.width, height: file.height });
        }
      }
      // The family default (decision 0031): its `Default` folder, the one spelled so before another case
      // of it, listed first. Its style is the family's alone, and it matches nothing: it is what a model
      // nothing matches shows.
      const defaultFolder = defaultFolderOf(family.avatars.map((avatar) => avatar.folder));
      const order = defaultFolder === undefined ? shape.order : [defaultFolder, ...shape.order.filter((folder) => folder !== defaultFolder)];
      const avatars = order.flatMap((folder): AvatarView[] => {
        const avatar = byFolder.get(folder);
        if (avatar === undefined) return [];
        const files = avatar.files.map((file) => fileViews.get(file)).filter((view) => view !== undefined);
        if (folder === defaultFolder) {
          return [{ folder, files, unused: avatar.unused, matches: [], problems: avatar.problems, fallback: files.some((file) => file.role === 'portrait') }];
        }
        return [{
          folder,
          files,
          unused: avatar.unused,
          matches: shape.matches.get(folder) ?? [],
          problems: avatar.problems,
          fallback: false,
          ...(shape.overlays.has(folder) ? { overlay: shape.overlays.get(folder) } : {}),
        }];
      });
      for (const avatar of avatars) {
        const ref = { origin: root.origin, family: family.folder, avatar: avatar.folder };
        resolved.set(refKey(ref), resolve(root.origin, family.folder, avatar));
        layers.set(refKey(ref), avatarLayers(shape.overlay, avatar.overlay, avatar.folder === defaultFolder));
      }
      const familyRef: FamilyRef = { origin: root.origin, family: family.folder };
      const searched = avatars.flatMap((avatar) => {
        const drawn = avatar.folder === defaultFolder ? null : (resolved.get(refKey({ ...familyRef, avatar: avatar.folder })) ?? null);
        return drawn === null ? [] : [{ drawn, matches: avatar.matches }];
      });
      const fallback = defaultFolder === undefined ? null : (resolved.get(refKey({ ...familyRef, avatar: defaultFolder })) ?? null);
      const noDefault: readonly AvatarProblem[] = fallback === null ? [{ kind: 'no-default', path: family.folder }] : [];
      indexes.set(familyKeyOf(familyRef), familyIndex(familyRef, shape.provider, searched, fallback));
      // Each provider's starting family is the first built-in family in name order to name it so, and
      // its built-in face that family's default (C30).
      // A family with no default is no one's starting family: the next that names the provider is.
      if (root.origin === 'built-in' && fallback !== null) {
        for (const providerId of shape.defaultFor) {
          if (!familySupports(shape, providerId)) continue;
          if (faces.has(providerId)) continue;
          faces.set(providerId, fallback);
          defaultFamilies.set(providerId, familyRef);
        }
      }
      return {
        origin: root.origin,
        provider: shape.provider,
        folder: family.folder,
        author: shape.author,
        licence: shape.licence,
        defaultFor: shape.defaultFor,
        unknownProviders: shape.unknownProviders,
        problems: [...family.problems, ...shape.problems, ...noDefault],
        avatars,
        ...(shape.overlay === undefined ? {} : { overlay: shape.overlay }),
      };
    });
    const avatarCount = families.reduce((sum, family) => sum + family.avatars.length, 0);
    const problemCount = root.problems.length + families.reduce((sum, family) => sum + family.problems.length + family.avatars.reduce((inner, avatar) => inner + avatar.problems.length, 0), 0);
    if (root.origin === 'built-in') { counts.builtInFamilies += families.length; counts.builtInAvatars += avatarCount; } else { counts.userFamilies += families.length; counts.userAvatars += avatarCount; }
    counts.problems += problemCount;
    return { origin: root.origin, families, problems: root.problems };
  };

  const listing: AvatarListing = { roots: roots.map(viewOf) };
  return {
    listing,
    file: (id) => files.get(id),
    defaultFace: (providerId) => faces.get(providerId) ?? null,
    byRef: (ref) => resolved.get(refKey(ref)) ?? null,
    family: (ref) => indexes.get(familyKeyOf(ref)),
    defaultFamily: (providerId) => defaultFamilies.get(providerId) ?? null,
    layers: (ref) => layers.get(refKey(ref)) ?? [],
    counts,
  };
}

/** A reference as one key: no folder's name holds the separator. */
function refKey(ref: AvatarRef): string {
  return [ref.origin, ref.family, ref.avatar].join(SEPARATOR);
}

function familyKeyOf(ref: FamilyRef): string {
  return [ref.origin, ref.family].join(SEPARATOR);
}

/** A family's search (decision 0031): `avatars` those with a usable portrait, in the family's order, its default apart; `fallback` its default. */
function familyIndex(ref: FamilyRef, provider: string, avatars: readonly { readonly drawn: ResolvedAvatar; readonly matches: readonly MatchEntryView[] }[], fallback: ResolvedAvatar | null): FamilyIndex {
  const supports = (providerId: string): boolean => familySupports({ provider }, providerId);
  return {
    ref,
    match: (providerId, model) => supports(providerId) ? strongestMatch(avatars, providerId, model)?.avatar.drawn ?? null : null,
    face: (providerId) => supports(providerId) ? fallback : null,
    usableFor: (providerId) => supports(providerId) && fallback !== null,
  };
}

/** An avatar as drawn: its usable portrait and small, or none for one without a portrait (C10). */
export function resolve(origin: AvatarOrigin, family: string, avatar: AvatarView | undefined): ResolvedAvatar | null {
  const portrait = avatar?.files.find((file) => file.role === 'portrait');
  if (avatar === undefined || portrait === undefined) return null;
  return { ref: { origin, family, avatar: avatar.folder }, portrait: portrait.id, small: avatar.files.find((file) => file.role === 'small')?.id ?? null };
}

/** The log line (C22): counts alone, never a name or a path. */
export function countsLine({ builtInFamilies, builtInAvatars, userFamilies, userAvatars, problems }: AvatarCounts): string {
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
  return `[avatars] ${plural(builtInFamilies, 'built-in family', 'built-in families')}, ${plural(builtInAvatars, 'avatar', 'avatars')}; ${plural(userFamilies, 'user family', 'user families')}, ${plural(userAvatars, 'avatar', 'avatars')}, ${plural(problems, 'problem', 'problems')}`;
}
