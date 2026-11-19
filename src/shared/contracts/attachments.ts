// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Attachments (docs/planning/_archive/M23.md, Design 1–4; C1–C3, C5, C8–C20, C79, C85; decision 0030): an
// image the user pasted or dropped into a session's composer, kept by fat-g in its data folder under
// a hash of its bytes, and sent to the session's CLI with its prompt. What an attachment is, its
// bounds, and what the page is shown of one.
//
// Renderer-safe: types, bounds, schemas and fat-g's words. The bytes never cross a push or the app
// state, and the page is shown no path: an attachment is drawn through the confined media route,
// `app://media/attachments/<hash>` (src/main/media/), and named by the hash alone.
import { z } from 'zod';
import { cutTo } from './cut';
import { IMAGE_MEDIA_TYPES, type ImageMediaType, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from './images';

// The signature, its bytes and the one image bound are every image reader's (M102, C50): kept here
// under the names M23's callers use.
export { imageSignature, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, SIGNATURE_BYTES } from './images';

// ── What an attachment is (C1, C3, C85) ───────────────────────────────────────────────────────

/** The four formats taken, told by their bytes' signature and never by a name or a clipboard's type (C1). */
export const ATTACHMENT_MEDIA_TYPES = IMAGE_MEDIA_TYPES;
export type AttachmentMediaType = ImageMediaType;

/** The file's ending under `attachments/`, from its verified signature (C85). */
export const ATTACHMENT_EXTENSIONS: Readonly<Record<AttachmentMediaType, 'png' | 'jpg' | 'gif' | 'webp'>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function isAttachmentMediaType(value: unknown): value is AttachmentMediaType {
  return typeof value === 'string' && (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}

/** The folder in fat-g's data folder that holds the active store's images (C85). */
export const ATTACHMENTS_FOLDER = 'attachments';

/** A SHA-256 of an image's bytes, lowercase hex: its name, its identity and its media address (C5, C10, C85). */
export const ATTACHMENT_HASH = /^[0-9a-f]{64}$/;
export const AttachmentHashSchema = z.string().regex(ATTACHMENT_HASH);

export function isAttachmentHash(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_HASH.test(value);
}

// ── Bounds, fixed before code (C2, C9, C17, C20) ──────────────────────────────────────────────

const MIB = 1024 * 1024;
// One image, in bytes and in pixels a side: the shared bound, MAX_IMAGE_BYTES and MAX_IMAGE_SIDE (M102, C50).
/** One message's images, by count of uses: the same image twice counts twice. */
export const MAX_IMAGES = 10;
/** One message's images together, in bytes. */
export const MAX_MESSAGE_IMAGE_BYTES = 20 * MIB;
/** A dropped file's name or a pasted image's numbered display label, kept in UTF-16 units. */
export const MAX_ATTACHMENT_NAME = 100;
/** What a stage request may carry as a name before main cuts it: a file system's own bound. */
export const MAX_STAGE_NAME = 1024;

/**
 * A name as fat-g keeps it (C5): its control characters gone, cut to its bound, and none for one
 * that is then empty. Never a path: a dropped file's name is all the page hands over.
 */
export function attachmentName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const clean = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  return clean === '' ? null : cutTo(clean, MAX_ATTACHMENT_NAME).text;
}

// ── What the page is shown (C5, C8, C16, C19, C26) ────────────────────────────────────────────

/**
 * One use of an image, as the page draws it: in a draft, a queued message or a sent one. `id` is the
 * use's own, which a Remove names; `hash` the image's. Display names belong to uses, since the same
 * bytes may be dropped under two names. Neither a path nor a byte of the image.
 */
export interface AttachmentDescriptor {
  readonly id: string;
  readonly hash: string;
  readonly mediaType: AttachmentMediaType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly name: string | null;
}

/**
 * An attachment of a sent message (C8, C25, C26). `available`: fat-g holds its file. One read from a
 * provider's history whose path fat-g never wrote has no hash and no metadata, and reads "image not
 * available", as does one whose file has gone; nothing is invented for it, and its message stands.
 */
export type AttachmentView =
  | (AttachmentDescriptor & { readonly available: boolean })
  | { readonly id: string; readonly hash: null; readonly available: false; readonly name: null };

/** The media address of an image: the route's source and the hash, never a path (C10). */
export function attachmentAddress(hash: string): string {
  return `app://media/attachments/${hash}`;
}

/** A transient, verified image read requested by Copy; never stored by the page or pushed. */
export interface AttachmentCopySource {
  readonly bytes: Uint8Array;
  readonly mediaType: AttachmentMediaType;
}

// ── Staging (C14, C18, C79) ───────────────────────────────────────────────────────────────────

/**
 * An image handed to main: the session whose draft takes it, its bytes as the page read them with
 * the File API, and the dropped file's name where it had one; a paste omits the name for main to
 * assign its session's next numbered display label. The preload refuses a byte view past
 * the one-image bound before it forwards anything (C79); main checks it again before copying it.
 */
export const AttachmentStageRequestSchema = z.strictObject({
  sessionId: z.guid(),
  bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength >= 1 && bytes.byteLength <= MAX_IMAGE_BYTES, 'outside the image bound'),
  name: z.string().max(MAX_STAGE_NAME).optional(),
});
export type AttachmentStageRequest = z.infer<typeof AttachmentStageRequestSchema>;

/** Why an image was not staged (C14). The first five are the image's own; the rest the session's. */
export const STAGE_REFUSALS = [
  /** Not one of the four formats by its signature (C1). */
  'unsupported',
  /** Past a bound in bytes or pixels, or past the message's bytes together (C2, C9). */
  'too-large',
  /** The draft holds ten already (C2). */
  'too-many',
  /** Its header could not be read whole, or a side is zero (C2, C3). */
  'damaged',
  /** It could not be kept: nothing was attached. */
  'storage-failed',
  'unknown-session',
  /** The session is being removed, or fat-g is quitting. */
  'busy',
  /** fat-g could not read its saved chats: nothing can be kept until Start fresh. */
  'conversations-refused',
] as const;
export type StageRefusal = (typeof STAGE_REFUSALS)[number];

export type AttachmentStageResult =
  | { readonly status: 'staged'; readonly attachment: AttachmentDescriptor }
  | { readonly status: 'refused'; readonly reason: StageRefusal };

// ── fat-g's words (C14, C15, C20) ─────────────────────────────────────────────────────────────

const grouped = (count: number): string => count.toLocaleString('en-US');
const mebibytes = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

export const ATTACHMENT_WORDS = {
  /** The line that names the formats and the bound, under every refusal of an image's own (C20). */
  formats: 'Images: PNG, JPEG, GIF or WebP, up to 5 MiB each',
  /** By the strip, when more than one is staged (C20). */
  count: (count: number): string => `${count} of ${MAX_IMAGES} images`,
  /** A paste has no meaningful filename; its use keeps this label across the session. */
  pasted: (ordinal: number): string => `Pasted image ${ordinal}`,
  /** A thumbnail's label for an image with no saved name, by its place among its message's images. */
  unnamed: (width: number, height: number, ordinal = 1): string => `Image ${ordinal}, ${width}x${height}`,
  /** A sent image's visible caption keeps both its display name and dimensions. */
  caption: (name: string | null, width: number, height: number, ordinal: number): string => `${name ?? `Image ${ordinal}`}, ${width}x${height}`,
  /** A thumbnail's tooltip (C16): its name, where it has one, and its size in pixels. */
  tooltip: (name: string | null, width: number, height: number): string => `${name === null ? '' : `${name}, `}${width}x${height}`,
  remove: (label: string): string => `Remove ${label}`,
  /** A sent message's image whose file fat-g does not hold (C8, C25). */
  unavailable: 'Image not available',
  /** A queue row's count (C48). */
  more: (count: number): string => `+${count} ${count === 1 ? 'image' : 'images'}`,
  /** A dropped folder (C15): refused without a look inside. */
  folder: (name: string | null): string => `${name ?? 'A folder'} is a folder: only images can be attached.`,
  /** A dropped file that is not one of the four (C15). */
  notImage: (name: string | null): string => `${name ?? 'That file'} is not an image fat-g can attach.`,
} as const;

/** Why an image was not attached, in fat-g's words (C14): the formats' line follows a refusal of the image's own. */
export function stageRefusalWords(reason: StageRefusal, name: string | null, bytes: number | null = null): string {
  const what = name ?? 'The image';
  switch (reason) {
    case 'unsupported':
      return `${what} is not a PNG, JPEG, GIF or WebP image.`;
    case 'too-large':
      return bytes !== null && bytes > MAX_IMAGE_BYTES ? `${what} is ${mebibytes(bytes)}, more than 5 MiB.` : `${what} is too large: at most ${grouped(MAX_IMAGE_SIDE)} pixels a side, and 20 MiB of images a message.`;
    case 'too-many':
      return `A message takes at most ${MAX_IMAGES} images.`;
    case 'damaged':
      return `${what} could not be read: it may be damaged.`;
    case 'storage-failed':
      return `fat-g could not keep ${name ?? 'the image'}, so it was not attached. Try again.`;
    case 'unknown-session':
      return 'This session is no longer listed.';
    case 'busy':
      return 'This session is being removed, or fat-g is quitting.';
    case 'conversations-refused':
      return 'fat-g could not read its saved chats, so nothing can be attached.';
  }
}

/** Whether a refusal is the image's own, after which the formats' line is said (C20). */
export function refusalOfImage(reason: StageRefusal): boolean {
  return reason === 'unsupported' || reason === 'too-large' || reason === 'damaged';
}
