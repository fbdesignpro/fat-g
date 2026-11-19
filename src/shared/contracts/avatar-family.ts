// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A family opened for editing, and saved (decisions 0031, 0032). Settings → Avatars' family editor
// edits what the family's `family.json` holds — the family default's style, which its `Default` folder
// wears and every other avatar starts from, and each other avatar's match entries and own styles in the
// family's order — as a draft, which main writes whole in one save. The page names a family by its
// reference and its avatars by their folders' names, which main checks against its scan and the file:
// never a path. Make a copy separately duplicates a built-in family into a new user folder. Add avatar
// (decision 0036) makes a new avatar of an image the page scaled, written at once.
//
// Renderer-safe: types, bounds and schemas.
import { z } from 'zod';
import { type OverlayLayer, OverlayLayerSchema } from './avatar-overlay';
import { AVATAR_NAME_MAX, AVATAR_SCAN_LIMIT, type AvatarListing, type FamilyRef, FamilyProviderSchema, FamilyRefSchema, isDefaultFolder, isMatchKey, type ManifestCause, type MatchEntry } from './avatars';
import { CATALOG_ID_MAX } from './catalog';
import { MAX_IMAGE_BYTES } from './images';

/** At most this many match entries an avatar, as the editor writes them. */
export const MAX_MATCHES = 64;

/** One avatar of a draft: its folder's name, its match entries in order and its own layer. */
export interface AvatarDraft {
  readonly folder: string;
  readonly matches: readonly MatchEntry[];
  readonly overlay: OverlayLayer;
}

/** A family's `family.json` as the editor edits it. */
export interface FamilyDraft {
  /** `any`, or the provider this family is offered to. */
  readonly provider: string;
  /** The family default's style: its `Default` folder's, and the look every other avatar starts from. */
  readonly overlay: OverlayLayer;
  /** Its other avatars, its `Default` folder apart, in the family's order: its file's, then those it does not list, by name. */
  readonly avatars: readonly AvatarDraft[];
}

/** Why a family cannot be saved: fat-g's own art in an installed copy, a file it refused, a link. */
export type FamilyLock =
  | { readonly kind: 'packaged' }
  | { readonly kind: 'manifest'; readonly cause: ManifestCause; readonly field: string | null }
  | { readonly kind: 'link' };

/** `avatars:family`'s answer: the family as its file holds it now. */
export interface FamilySource {
  readonly ref: FamilyRef;
  /** Null where it can be saved. */
  readonly lock: FamilyLock | null;
  /** The file's bytes' SHA-256, by which a save finds an edit made outside since; null where it has none. */
  readonly revision: string | null;
  /** What the file holds, read field by field; for a family with none, its folders in name order. */
  readonly draft: FamilyDraft;
  /** The folders of the draft's avatars that the scan does not list: entries of the file for a folder gone. */
  readonly missing: readonly string[];
}

const folder = z.string().min(1).max(AVATAR_NAME_MAX);
const matchKey = z.string().refine(isMatchKey, 'not a model key or pattern');
const MatchDraftSchema = z.union([matchKey, z.strictObject({ provider: z.string().min(1).max(CATALOG_ID_MAX), key: matchKey })]);

export const FamilyDraftSchema: z.ZodType<FamilyDraft> = z.strictObject({
  provider: FamilyProviderSchema,
  overlay: OverlayLayerSchema,
  avatars: z.array(z.strictObject({ folder, matches: z.array(MatchDraftSchema).max(MAX_MATCHES), overlay: OverlayLayerSchema })).max(AVATAR_SCAN_LIMIT),
});

/** `avatars:saveFamily`'s request: the family, the revision the draft was made from, and the draft. */
export const SaveFamilyRequestSchema = z.strictObject({
  ref: FamilyRefSchema,
  revision: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  draft: FamilyDraftSchema,
});
export type SaveFamilyRequest = z.infer<typeof SaveFamilyRequestSchema>;

/** `avatars:saveFamily`'s answer. */
export type SaveFamilyAnswer =
  | { readonly kind: 'saved' }
  /** The file changed since the draft was made: nothing was written. */
  | { readonly kind: 'conflict' }
  | { readonly kind: 'locked'; readonly lock: FamilyLock }
  /** The family is no longer listed. */
  | { readonly kind: 'missing' }
  /** The draft names what the family does not hold: `field` as `avatars.2.folder`. */
  | { readonly kind: 'invalid'; readonly field: string }
  /** The write failed: the file stands as it was. */
  | { readonly kind: 'failed' };

/** A built-in family copied into the user's avatars, with the listing that already holds the copy. */
export type CopyFamilyAnswer =
  | { readonly kind: 'copied'; readonly ref: FamilyRef; readonly listing: AvatarListing }
  | { readonly kind: 'missing' | 'unavailable' | 'failed' };

// ── Add avatar (decision 0036) ────────────────────────────────────────────────────────────────

/** The side of the portrait an added image is scaled down to: a smaller one is kept at its own. */
export const ADDED_PORTRAIT_SIDE = 512;
/** The side of the small made for an added image, and the least side an added image may have. */
export const ADDED_SMALL_SIDE = 64;
/** A new avatar's name, at most, in characters. */
export const NEW_AVATAR_NAME_MAX = 64;

/** Letters, digits, spaces and `. _ - ( ) +`; a letter or digit first, no space or dot last. */
const NEW_AVATAR_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._()+-]*[\p{L}\p{N}_()+-])?$/u;
/** Names Windows keeps for its devices, with or without an extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Whether a name may be a new avatar's folder on every system: of the form above, within its bound,
 * not the family default's `Default` in any case, and no device name. Whether the family already
 * holds it is main's to say, by its folder.
 */
export function isNewAvatarName(value: unknown): value is string {
  return isNewFamilyName(value) && !isDefaultFolder(value);
}

/** A new family's folder uses the same portable names, with Default allowed. */
export function isNewFamilyName(value: unknown): value is string {
  return typeof value === 'string'
    && [...value].length <= NEW_AVATAR_NAME_MAX
    && NEW_AVATAR_NAME.test(value)
    && !DEVICE_NAME.test(value);
}

/** An added image's PNG, as the page made it: main checks its header before it writes it. */
const addedImage = z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength >= 1 && bytes.byteLength <= MAX_IMAGE_BYTES, 'outside the image bound');

/**
 * `avatars:addAvatar`'s request: the family, the revision of its file the editor holds, the new
 * avatar's name and match entries, and the portrait and small the page made of the image the user
 * dropped or chose.
 */
export const AddAvatarRequestSchema = z.strictObject({
  ref: FamilyRefSchema,
  revision: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  name: z.string().refine(isNewAvatarName, 'not a new avatar name'),
  matches: z.array(MatchDraftSchema).max(MAX_MATCHES),
  portrait: addedImage,
  small: addedImage,
});
export type AddAvatarRequest = z.infer<typeof AddAvatarRequestSchema>;

/** Start a user family with a Default image, and optionally a named avatar with matches. */
export const CreateFamilyRequestSchema = z.strictObject({
  name: z.string().refine(isNewFamilyName, 'not a new family name'),
  avatar: z.strictObject({
    name: z.string().refine(isNewAvatarName, 'not a new avatar name'),
    matches: z.array(MatchDraftSchema).min(1).max(MAX_MATCHES),
  }).nullable(),
  portrait: addedImage,
  small: addedImage,
});
export type CreateFamilyRequest = z.infer<typeof CreateFamilyRequestSchema>;

export type CreateFamilyAnswer =
  | { readonly kind: 'created'; readonly ref: FamilyRef; readonly listing: AvatarListing }
  | { readonly kind: 'taken' | 'invalid' | 'unavailable' | 'failed' };

/** `avatars:addAvatar`'s answer. */
export type AddAvatarAnswer =
  /** Written and scanned: its folder, the family as its file holds it now, and the listing that holds it. */
  | { readonly kind: 'added'; readonly folder: string; readonly source: FamilySource; readonly listing: AvatarListing }
  /** The file changed since the editor read it: nothing was written. */
  | { readonly kind: 'conflict' }
  | { readonly kind: 'locked'; readonly lock: FamilyLock }
  /** The family is no longer listed. */
  | { readonly kind: 'missing' }
  /** The family already holds a folder or an entry of that name, in any case. */
  | { readonly kind: 'taken' }
  /** The images are not the PNGs the page makes. */
  | { readonly kind: 'invalid' }
  /** A write failed: whatever this add made was removed. */
  | { readonly kind: 'failed' };

/**
 * `avatars:replaceImage`'s request (decision 0036): a listed avatar of the family, its folder's name as
 * listed — its `Default` folder too — and the PNGs the page made of the image the user dropped or
 * chose. A new main image comes with its small, made from the same image; a small may come alone.
 */
export const ReplaceImageRequestSchema = z.strictObject({
  ref: FamilyRefSchema,
  avatar: folder,
  portrait: addedImage.nullable(),
  small: addedImage,
});
export type ReplaceImageRequest = z.infer<typeof ReplaceImageRequestSchema>;

/** `avatars:replaceImage`'s answer. */
export type ReplaceImageAnswer =
  /** Written and scanned: the listing that holds the new files. */
  | { readonly kind: 'replaced'; readonly listing: AvatarListing }
  | { readonly kind: 'locked'; readonly lock: FamilyLock }
  /** The family or the avatar is no longer listed. */
  | { readonly kind: 'missing' }
  /** The images are not the PNGs the page makes. */
  | { readonly kind: 'invalid' }
  /** A write, or the old image's move to the system's trash, failed: the avatar's files stand as they were. */
  | { readonly kind: 'failed' };

/**
 * `avatars:chooseImage`'s answer: the image the user chose in the system's file chooser, by its name and
 * its bytes — never its path — or why there is none.
 */
export type ChooseImageAnswer =
  | { readonly kind: 'chosen'; readonly name: string; readonly bytes: Uint8Array }
  | { readonly kind: 'cancelled' }
  /** Past the one image bound, or not a file main could read. */
  | { readonly kind: 'refused'; readonly reason: 'too-large' | 'unreadable' };

/** The longest path the preload tells main of a dropped file, in UTF-16 units. */
export const DROPPED_PATH_MAX = 4096;

/** `avatars:noteDropped`'s request, which the preload alone sends: the dropped file's path. */
export const NoteDroppedRequestSchema = z.strictObject({ path: z.string().min(1).max(DROPPED_PATH_MAX) });
export type NoteDroppedRequest = z.infer<typeof NoteDroppedRequestSchema>;
