// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An image file, read wherever it lies on this machine's own disks (decision 0022, item 15): an image
// an agent read, or one a reference names, is drawn in the chat and in the pane. The CLI read it
// already and sent it to its model; drawing it again on the user's own screen sends it nowhere.
//
//   confine   on its stored path, before the file system is asked anything: this machine's own
//             disks — no share, no device — and inside none of the folders fat-g never reads
//   stat      a regular file of 5 MiB at most
//   confine   again on its real path: a link that leads to a share or into such a folder is refused
//   read      the whole file, and its header: a PNG, JPEG, GIF or WebP of 8,000 pixels a side at most
//
// What passes is given an id for the run, the same one for unchanged bytes of a session's file: the page draws
// it from the media route by that id (src/main/media/files.ts), and never names its path to have it
// read. Every serving of an id passes all of it again, and must find the same file and bytes.
// What is held between two readings is the id's session, the file's real path, its type and its
// size and content digest: never a byte of it. The ids go with the run, and with their session.
//
// Electron-free, and its file system is a parameter, as the reader's is (reader.ts).
import { createHash, randomBytes } from 'node:crypto';
import { type FileImage, type FileRefusal, type FileRevision, type ImageRefreshAnswer, type ImageRefreshRequest, sameFileRevision } from '@shared/contracts/files';
import { type ImageMediaType, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from '@shared/contracts/images';
import { readImageHeader } from '../images/headers';
import type { Lookups } from '../records/lookup';
import { comparable } from '../records/paths';
import { insideAny, isLocalPath, pathLib } from './confine';
import { isGone, type ReaderFs } from './fs';
import type { ReadClock, ReadLimiter } from './limiter';

/** How many image files the run holds an id for: past it, the one named longest ago is forgotten. */
export const MAX_IMAGE_FILES = 1_000;
export const IMAGE_REFRESH_SETTLE_MS = 250;

/** Known app-owned attachments, read through their owning store rather than the general reader. */
export interface OwnedImageFiles {
  owns(path: string): boolean;
  read(path: string): Promise<Uint8Array | null>;
}

export interface ImageFilesDeps {
  readonly fs: ReaderFs;
  /** The roots' own limiter (M12, C85), as the reader's real paths go through it. */
  readonly lookups: Pick<Lookups, 'realpath'>;
  readonly limiter: ReadLimiter;
  readonly platform: string;
  /** Whether a session is listed: an id serves only while its session is. */
  readonly listed: (sessionId: string) => boolean;
  /** The folders no read may enter (C28), asked at each check: an account can be added during the run. */
  readonly refusedFolders: () => readonly string[];
  readonly owned?: OwnedImageFiles;
  /** A new id, of `IMAGE_FILE_ID`'s shape. */
  readonly mint?: () => string;
}

/** Why an image file is not drawn: a file's refusal, or one that is too large or no image of the four. */
export type ImageRefusal = Exclude<FileRefusal, 'several' | 'not-image'> | 'too-large' | 'not-image';

export type Admitted = { readonly ok: true; readonly image: FileImage } | { readonly ok: false; readonly why: ImageRefusal };

/** An id's file as the media route and Copy have it, or why not, by the route's kinds. */
export type Served =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly mediaType: ImageMediaType }
  | { readonly ok: false; readonly kind: 'id' | 'unavailable' | 'changed' };

export interface ImageFiles {
  /** Whether the path names an attachment of the active store, never arbitrary app data. */
  owned(path: string): boolean;
  /** Checks the image at an absolute path, and names it for the session: what `files:read` answers. */
  admit(sessionId: string, path: string, clock?: ReadClock): Promise<Admitted>;
  /** Metadata-only for unchanged files; a stable changed image is reread under the same checks. */
  refresh(request: ImageRefreshRequest): Promise<ImageRefreshAnswer | null>;
  /** The bytes of an id's file, checked again; with a session, only an id of that session's. */
  serve(id: string, sessionId?: string): Promise<Served>;
}

interface Held {
  readonly sessionId: string;
  readonly key: string;
  readonly path: string;
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly digest: string;
  readonly revision: FileRevision | null;
}

type Refused = { readonly ok: false; readonly why: ImageRefusal };
type Probed = { readonly ok: true; readonly path: string; readonly revision: FileRevision | null } | Refused;
type Checked = { readonly ok: true; readonly path: string; readonly mediaType: ImageMediaType; readonly width: number; readonly height: number; readonly digest: string; readonly revision: FileRevision | null; readonly bytes: Uint8Array } | Refused;

const mintId = (): string => randomBytes(16).toString('hex');

export function createImageFiles(deps: ImageFilesDeps): ImageFiles {
  const { fs, lookups, limiter, platform } = deps;
  const p = pathLib(platform);
  const mint = deps.mint ?? mintId;
  /** By id, in the order they were last named. */
  const held = new Map<string, Held>();
  /** By session and comparable real path: one id for one file of a session. */
  const ids = new Map<string, string>();
  const no = (why: ImageRefusal): Refused => ({ ok: false, why });

  async function probe(path: string, clock: ReadClock): Promise<Probed> {
    const folders = deps.refusedFolders();
    // On its stored path, before the file system is asked anything.
    if (!isLocalPath(path, platform)) return no('outside');
    const resolved = p.resolve(path);
    // Owned attachments are immutable; their owner still checks bytes when served or copied.
    if (deps.owned?.owns(resolved)) return { ok: true, path: resolved, revision: null };
    if (insideAny(resolved, folders, platform)) return no('outside');
    const stat = await clock.run(() => fs.stat(resolved));
    if (!stat.answered) return no('no-answer');
    if (!stat.ok) return no(isGone(stat.error) ? 'not-found' : 'no-answer');
    if (stat.value.isDirectory()) return no('folder');
    if (!stat.value.isFile()) return no('not-regular');
    // Asked before the file is opened: a larger one is not read at all.
    if (stat.value.size > MAX_IMAGE_BYTES) return no('too-large');
    // On its real path: a link that leads to a share, or into a folder fat-g never reads.
    const [real, ...realFolders] = await Promise.all([resolved, ...folders].map((entry) => lookups.realpath(entry)));
    if (real === null || real === undefined) return no('no-answer');
    const everyForm = [...folders, ...realFolders.filter((folder): folder is string => typeof folder === 'string')];
    if (!isLocalPath(real, platform) || insideAny(real, everyForm, platform)) return no('outside');
    return { ok: true, path: real, revision: { mtimeMs: stat.value.mtimeMs, size: stat.value.size } };
  }

  async function check(path: string, clock: ReadClock): Promise<Checked> {
    const found = await probe(path, clock);
    if (!found.ok) return found;
    if (found.revision === null) {
      const read = await clock.run(() => deps.owned?.read(found.path) ?? Promise.resolve(null));
      if (!read.answered || !read.ok || read.value === null) return no('no-answer');
      return checkedBytes(found.path, read.value, null);
    }
    const bytes = await clock.run(() => fs.read(found.path, MAX_IMAGE_BYTES + 1));
    if (!bytes.answered) return no('no-answer');
    if (!bytes.ok) return no(isGone(bytes.error) ? 'not-found' : 'no-answer');
    return checkedBytes(found.path, bytes.value, found.revision.size === bytes.value.length ? found.revision : null);
  }

  function checkedBytes(path: string, bytes: Uint8Array, revision: FileRevision | null): Checked {
    // It grew past the bound between its size and its read.
    if (bytes.length > MAX_IMAGE_BYTES) return no('too-large');
    const header = readImageHeader(bytes);
    if (header.kind !== 'image') return no('not-image');
    if (header.width > MAX_IMAGE_SIDE || header.height > MAX_IMAGE_SIDE) return no('too-large');
    return { ok: true, path, mediaType: header.mediaType, width: header.width, height: header.height, digest: createHash('sha256').update(bytes).digest('hex'), revision, bytes };
  }

  function remember(sessionId: string, checked: Extract<Checked, { ok: true }>): FileImage {
    const key = `${sessionId}\0${comparable(checked.path, platform)}`;
    const known = ids.get(key);
    // An edited image needs a new URL: Chromium can keep decoded pixels for an existing <img>
    // even though the route uses no-store. Keep only the current revision of each file.
    const id = known !== undefined && held.get(known)?.digest === checked.digest ? known : mint();
    ids.set(key, id);
    // Named again: the last to be forgotten.
    if (known !== undefined) held.delete(known);
    held.set(id, { sessionId, key, path: checked.path, mediaType: checked.mediaType, width: checked.width, height: checked.height, digest: checked.digest, revision: checked.revision });
    for (const [oldest, entry] of held) {
      if (held.size <= MAX_IMAGE_FILES) break;
      held.delete(oldest);
      ids.delete(entry.key);
    }
    return { path: checked.path, id, width: checked.width, height: checked.height };
  }

  return {
    owned: (path) => isLocalPath(path, platform) && (deps.owned?.owns(p.resolve(path)) ?? false),
    async admit(sessionId, path, clock = limiter.begin()) {
      const checked = await check(path, clock);
      return checked.ok ? { ok: true, image: remember(sessionId, checked) } : checked;
    },

    async refresh({ sessionId, path, id }) {
      // Only a path already admitted to this session, never a new reference or a name search.
      if (!deps.listed(sessionId) || !isLocalPath(path, platform)) return null;
      const known = ids.get(`${sessionId}\0${comparable(p.resolve(path), platform)}`);
      const entry = known === undefined ? undefined : held.get(known);
      if (known === undefined || entry === undefined) return null;
      const clock = limiter.begin();
      const refused = (why: ImageRefusal): ImageRefreshAnswer => ({ outcome: 'refused', why: why === 'too-large' ? 'not-image' : why });
      const before = await probe(entry.path, clock);
      if (!before.ok) return refused(before.why);
      if (!deps.listed(sessionId)) return null;
      if (comparable(before.path, platform) !== comparable(entry.path, platform)) return refused('outside');
      if (before.revision === null || sameFileRevision(entry.revision, before.revision)) {
        return id === known ? { outcome: 'unchanged' } : { outcome: 'image', path: entry.path, id: known, width: entry.width, height: entry.height };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, IMAGE_REFRESH_SETTLE_MS));
      const settled = await probe(entry.path, clock);
      if (!settled.ok) return refused(settled.why);
      if (settled.path !== before.path || !sameFileRevision(settled.revision, before.revision)) return { outcome: 'retry' };
      const checked = await check(entry.path, clock);
      if (!checked.ok) return refused(checked.why);
      const after = await probe(entry.path, clock);
      if (!after.ok) return refused(after.why);
      if (!deps.listed(sessionId)) return null;
      if (checked.path !== settled.path || after.path !== settled.path || !sameFileRevision(checked.revision, settled.revision) || !sameFileRevision(after.revision, settled.revision)) return { outcome: 'retry' };
      const image = remember(sessionId, checked);
      return image.id === id ? { outcome: 'unchanged' } : { outcome: 'image', ...image };
    },

    async serve(id, sessionId) {
      const entry = held.get(id);
      if (entry === undefined || (sessionId !== undefined && entry.sessionId !== sessionId)) return { ok: false, kind: 'id' };
      // A session removed takes its ids with it.
      if (!deps.listed(entry.sessionId)) return { ok: false, kind: 'id' };
      const checked = await check(entry.path, limiter.begin());
      if (!checked.ok) return { ok: false, kind: checked.why === 'not-found' || checked.why === 'no-answer' ? 'unavailable' : 'changed' };
      // The same revision, including pixel edits that preserve the dimensions and byte size.
      if (comparable(checked.path, platform) !== comparable(entry.path, platform) || checked.mediaType !== entry.mediaType || checked.width !== entry.width || checked.height !== entry.height || checked.digest !== entry.digest) return { ok: false, kind: 'changed' };
      return { ok: true, bytes: checked.bytes, mediaType: checked.mediaType };
    },
  };
}
