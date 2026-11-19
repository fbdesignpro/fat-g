// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The media route's attachments source (docs/planning/_archive/M23.md, Design 3; C10, C11, C85): an image of a
// chat, by the hash of its bytes. The hash must be one the active conversation store names; its file
// is the one the images' folder holds under that hash and the type its row says, read whole within
// the size the row says, and served only where its bytes hash to its name and its header still says
// that type and those pixels. A file replaced, cut or linked elsewhere is read to be checked and never
// served. Nothing of the request but its hash is used, and no path is read from it.
//
// Electron-free: the store's row and the folder's read arrive as functions.
import { type AttachmentMediaType, isAttachmentHash, MAX_IMAGE_BYTES } from '@shared/contracts/attachments';
import { readAttachmentHeader } from '../attachments/headers';
import type { MediaSource, SourceAnswer } from './route';

export const ATTACHMENTS_SOURCE = 'attachments';

/** What the source asks of an image's row: its type, its size and its pixels; null for a hash no row names. */
export interface HeldImage {
  readonly mediaType: AttachmentMediaType;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

export interface AttachmentSourceOptions {
  /** The active store's row for a hash: null for one it names not, and while the store is refused or closed. */
  readonly image: (hash: string) => HeldImage | null;
  /** The images' folder's read (attachments/files.ts): the bytes of the file of that hash and type, checked against size and hash. */
  readonly read: (hash: string, mediaType: AttachmentMediaType, bytes: number) => Promise<Uint8Array | null>;
}

export function createAttachmentSource({ image, read }: AttachmentSourceOptions): MediaSource {
  return {
    name: ATTACHMENTS_SOURCE,
    // Kept in no cache of Chromium's (M23, C11): nothing of a chat persists outside the owned folder.
    cache: 'no-store',
    async serve(id): Promise<SourceAnswer> {
      if (!isAttachmentHash(id)) return { status: 404, kind: 'id' };
      let held: HeldImage | null;
      try { held = image(id); } catch { held = null; }
      if (held === null) return { status: 404, kind: 'id' };
      if (held.bytes <= 0 || held.bytes > MAX_IMAGE_BYTES) return { status: 404, kind: 'changed' };
      const bytes = await read(id, held.mediaType, held.bytes);
      if (bytes === null) return { status: 404, kind: 'unavailable' };
      // Its header again (C10): the type and the pixels its row says, or a file that changed.
      const header = readAttachmentHeader(bytes);
      if (header.kind !== 'image' || header.mediaType !== held.mediaType || header.width !== held.width || header.height !== held.height) return { status: 404, kind: 'changed' };
      return { status: 200, body: bytes, contentType: held.mediaType };
    },
  };
}
