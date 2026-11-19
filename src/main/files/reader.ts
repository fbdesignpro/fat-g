// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// How fat-g reads a project's file (docs/planning/_archive/M19b.md, Design 7, 9; C25–C35, C43, C51, C55, C59;
// decision 0022): opened at the user's press, refreshed while visible, inside the project's trusted
// folders, and only to show it. A reference is a claim the page passes on; everything it names is
// worked out and checked here, and the page never names a base folder.
//
//   resolve   against the folder the session runs in, or the folder of the file the reference is in
//   confine   on stored paths, before the file system is asked anything: inside a root of the
//             session's project that is trusted and not marked missing, and inside none of the
//             folders fat-g never reads — so a share's path that is no root reaches no network
//   stat      a regular file; then on real paths, the same two comparisons again: a link inside a
//             root that leads out of it is refused
//   read      2 MiB at most, its size asked before it is opened; only a name on the lists is read
//   decode    UTF-8, or UTF-16 by its mark; anything else is not text, and none of it is answered
//
// Where a reference leads, a file or a folder, is placed by the same steps up to the read: what its
// menu copies and shows, and the folder a press on it opens in the file manager (decision 0022).
//
// A file by an image's name is read as an image (decision 0022, item 15), by images.ts: inside the
// project's folders or outside them, on this machine's own disks and in none of the folders fat-g
// never reads. Its answer is the id the page draws it by. One that is too large or no image fat-g
// draws opens the tab that says so inside the project's folders, and is refused outside them.
//
// Every read passes all of it again (C32). Nothing of a file is kept once the answer is made: the
// bytes and the text are locals of one call (C33). Electron-free, and its file system is a
// parameter, so its tests run on a stand-in that records every call.
import {
  FILE_BYTES_BOUND, type FileReadAnswer, type FileReadRequest, type FileRefreshAnswer, type FileRefreshRequest, type FileRefusal, type FileRevision, type FileShowRequest, hasSeparator, isImageName, lastPart, readTarget, sameFileRevision, type TargetTry, viewOf,
} from '@shared/contracts/files';
import type { TrustAnswer } from '@shared/contracts/projects';
import type { SessionRecord } from '../records/format';
import type { Lookups } from '../records/lookup';
import { isAbsoluteRoot } from '../records/paths';
import { admittingRoot, insideAny, isLocalPath, pathLib, within } from './confine';
import { decodeText } from './decode';
import { type FileStat, isGone, type ReaderFs } from './fs';
import type { ImageFiles } from './images';
import type { ReadClock, ReadLimiter } from './limiter';
import { findByName } from './walk';

export interface FileReaderDeps {
  readonly fs: ReaderFs;
  /** The roots' own limiter (M12, C85): the confinement's real paths go through it (C27, C34). */
  readonly lookups: Pick<Lookups, 'realpath'>;
  readonly limiter: ReadLimiter;
  readonly platform: string;
  /** A session's record, from the records store. */
  readonly session: (id: string) => SessionRecord | undefined;
  /** The folder a session runs in: the gate's word (M15, C30). */
  readonly folder: (record: SessionRecord) => string | null;
  readonly project: (id: string) => { readonly roots: readonly { readonly path: string; readonly answer: TrustAnswer | null }[] } | undefined;
  readonly isMissing: (root: string) => boolean;
  /** The folders no read may enter (C28), asked at each read: an account can be added during the run. */
  readonly refusedFolders: () => readonly string[];
  /** What reads a file by an image's name (decision 0022, item 15), and names it for the run. */
  readonly images: Pick<ImageFiles, 'admit' | 'owned'>;
}

export type Located = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly why: FileRefusal };
export type Placed = { readonly ok: true; readonly kind: 'file' | 'folder'; readonly path: string } | { readonly ok: false; readonly why: FileRefusal };

export interface FileReader {
  /** Null for a session that is not listed, and for a `from` that is no absolute path: a bad request. */
  read(request: FileReadRequest): Promise<FileReadAnswer | null>;
  /** An exact open text file: checked even when unchanged, no name search or image exception. */
  refresh(request: FileRefreshRequest): Promise<FileRefreshAnswer | null>;
  /** The real path Show in folder may show (C43), after the same confinements. Null for a session that is not listed. */
  locate(request: FileShowRequest): Promise<Located | null>;
  /**
   * Where a reference leads, a file or a folder, by its real path: resolved and confined as a read
   * is, with nothing of a file's bytes read. What a reference's menu copies and shows, and the folder
   * a press opens. Null for a bad request, as a read's.
   */
  place(request: FileReadRequest): Promise<Placed | null>;
}

type Standing = { readonly kind: 'file'; readonly stat: FileStat } | { readonly kind: Exclude<FileRefusal, 'outside' | 'several' | 'not-image'> };
/**
 * What a target was found to be, before its real path is checked. `root`: the trusted root it lies
 * in, or null for an image's file outside them all (item 15).
 */
type Found = { readonly resolved: string; readonly root: string | null; readonly attempt: TargetTry; readonly at: { readonly kind: 'file'; readonly stat: FileStat } | { readonly kind: 'folder' | 'owned-image' } };

export const REFRESH_SETTLE_MS = 250;
const revisionOf = ({ mtimeMs, size }: FileStat): FileRevision => ({ mtimeMs, size });

export function createFileReader(deps: FileReaderDeps): FileReader {
  const { fs, lookups, limiter, platform } = deps;
  const p = pathLib(platform);
  const refused = (why: FileRefusal): FileReadAnswer => ({ outcome: 'refused', why });

  /** The roots a read may enter: the gate's own filter for a project's other folders (M16, C19). */
  const rootsOf = (record: SessionRecord): string[] =>
    (deps.project(record.projectId)?.roots ?? []).filter((root) => root.answer === 'trusted' && !deps.isMissing(root.path)).map((root) => root.path);

  /** What is at a path the first confinement let through. */
  async function standing(clock: ReadClock, target: string): Promise<Standing> {
    const answer = await clock.run(() => fs.stat(target));
    if (!answer.answered) return { kind: 'no-answer' };
    if (!answer.ok) return { kind: isGone(answer.error) ? 'not-found' : 'no-answer' };
    if (answer.value.isDirectory()) return { kind: 'folder' };
    // A device, a socket or a pipe: only a regular file is read (C29).
    if (!answer.value.isFile()) return { kind: 'not-regular' };
    return { kind: 'file', stat: answer.value };
  }

  /**
   * The second confinement (C27, C28): the file's real path inside its root's, and inside no folder
   * fat-g never reads, by that folder's stored path and by its real one. An image's file outside the
   * roots (item 15) has its real path on this machine's own disks instead of inside a root.
   */
  async function onRealPaths(resolved: string, root: string | null, folders: readonly string[]): Promise<{ readonly ok: true; readonly path: string; readonly root: string | null } | { readonly ok: false; readonly why: FileRefusal }> {
    const [realFile, realRoot, ...realFolders] = await Promise.all([resolved, root, ...folders].map((entry) => (entry === null ? Promise.resolve(null) : lookups.realpath(entry))));
    if (realFile === null || realFile === undefined || (root !== null && (realRoot === null || realRoot === undefined))) return { ok: false, why: 'no-answer' };
    if (realRoot === null || realRoot === undefined ? !isLocalPath(realFile, platform) : !within(realRoot, realFile, platform)) return { ok: false, why: 'outside' };
    const everyForm = [...folders, ...realFolders.filter((folder): folder is string => typeof folder === 'string')];
    if (insideAny(realFile, everyForm, platform)) return { ok: false, why: 'outside' };
    return { ok: true, path: realFile, root: realRoot ?? null };
  }

  /** Whether a path outside every root may still be read (item 15): an image's name, on this machine's own disks. */
  const anywhere = (resolved: string): boolean => isImageName(lastPart(resolved)) && isLocalPath(resolved, platform);

  /** A name the lookup may look for (C55): no separator, no drive, and neither of the two dots. */
  const isBareName = (name: string): boolean => !hasSeparator(name) && name !== '.' && name !== '..' && !(platform === 'win32' && name.includes(':'));

  /**
   * What a target names, on its stored paths: each of its tries resolved against the folder the
   * session runs in, or the folder of the file it is in, confined before the file system is asked
   * anything, and then asked what is there; a bare name that is nothing where it resolves is looked
   * up. A folder is found where `takeFolder` says so, and is a refusal where it does not. Null for a
   * bad request.
   */
  async function find({ sessionId, target, from }: FileReadRequest, clock: ReadClock, folders: readonly string[], takeFolder: boolean): Promise<Found | FileRefusal | null> {
    const record = deps.session(sessionId);
    if (record === undefined) return null;
    if (from !== undefined && !isAbsoluteRoot(from, platform)) return null;
    const reading = readTarget(target, platform);
    if (reading === null) return 'not-found';
    // A `file:` URL that names another machine reaches no network (C26).
    if (reading.host !== null && reading.host !== '' && reading.host.toLowerCase() !== 'localhost') return 'outside';
    const base = from === undefined ? deps.folder(record) : p.dirname(p.resolve(from));
    if (base === null || !isAbsoluteRoot(base, platform)) return 'outside';
    const roots = rootsOf(record);

    let missing = false;
    for (const attempt of reading.tries) {
      const resolved = p.resolve(base, attempt.path);
      const root = admittingRoot(resolved, roots, platform);
      // A known attachment uses its owner's verified read, including while it lies in app data.
      if (deps.images.owned(resolved)) return { resolved, root: null, attempt, at: { kind: 'owned-image' } };
      // Outside: the file system is asked nothing about it (C26). An image's name is read on this machine's own disks (item 15).
      if ((root === null && !anywhere(resolved)) || insideAny(resolved, folders, platform)) continue;
      const at = await standing(clock, resolved);
      if (at.kind === 'not-found') {
        missing = true;
        continue;
      }
      if (at.kind === 'file') return { resolved, root, attempt, at };
      // Outside the roots, only an image's file is taken: no folder there opens.
      if (root === null) return at.kind === 'folder' ? 'outside' : at.kind;
      if (at.kind === 'folder' && takeFolder) return { resolved, root, attempt, at: { kind: 'folder' } };
      return at.kind;
    }

    if (!missing) return 'outside';
    // A bare name that is no file where it resolves is looked up in the project's folders (C55).
    const first = reading.tries[0];
    if (first === undefined || !isBareName(first.path)) return 'not-found';
    const walked = await findByName({ fs, clock, platform, roots, name: first.path, refused: (folder) => insideAny(folder, folders, platform) });
    if (walked.found !== 'one') return walked.found === 'several' ? 'several' : walked.found === 'none' ? 'not-found' : 'no-answer';
    // What it found goes through the same checks as any target.
    const root = admittingRoot(walked.path, roots, platform);
    if (root === null || insideAny(walked.path, folders, platform)) return 'outside';
    const at = await standing(clock, walked.path);
    if (at.kind !== 'file') return at.kind;
    return { resolved: walked.path, root, attempt: first, at };
  }

  /** The common bounded text read; refresh never enters the image branch or address parser. */
  async function readText(found: Found, clock: ReadClock, folders: readonly string[]): Promise<FileReadAnswer> {
    if (found.at.kind !== 'file') return refused('folder');
    const { root } = found;
    if (root === null) return refused('outside');
    const real = await onRealPaths(found.resolved, root, folders);
    if (!real.ok) return refused(real.why);
    if (real.root === null) return refused('outside');
    const place = { path: real.path, root: real.root, line: found.attempt.line, column: found.attempt.column };
    if (found.at.stat.size > FILE_BYTES_BOUND) return { outcome: 'unshown', why: 'too-large', ...place };
    const view = viewOf(lastPart(real.path));
    if (view === 'other') return { outcome: 'unshown', why: 'other-kind', ...place };
    const bytes = await clock.run(() => fs.read(real.path, FILE_BYTES_BOUND + 1));
    if (!bytes.answered) return refused('no-answer');
    if (!bytes.ok) return refused(isGone(bytes.error) ? 'not-found' : 'no-answer');
    if (bytes.value.length > FILE_BYTES_BOUND) return { outcome: 'unshown', why: 'too-large', ...place };
    const text = decodeText(bytes.value);
    if (text === null) return { outcome: 'unshown', why: 'not-text', ...place };
    // A normal opening may still show a read made during a save, but cannot bless it as a
    // polling baseline. Automatic reads below discard it instead and retry without replacing text.
    const after = await standing(clock, found.resolved);
    const afterReal = await onRealPaths(found.resolved, root, folders);
    const revision = after.kind === 'file' && afterReal.ok && afterReal.path === real.path
      && bytes.value.length === after.stat.size && sameFileRevision(revisionOf(found.at.stat), revisionOf(after.stat))
      ? revisionOf(after.stat) : null;
    return { outcome: 'text', view, text, revision, ...place };
  }

  /** Literal paths only. Confinement precedes stat, and real-path checks precede comparison. */
  async function exactFile(sessionId: string, path: string, clock: ReadClock): Promise<Found | FileRefusal | null> {
    const record = deps.session(sessionId);
    if (record === undefined) return null;
    if (path.includes('\0') || !isAbsoluteRoot(path, platform)) return 'outside';
    const resolved = p.resolve(path);
    const folders = deps.refusedFolders();
    const root = admittingRoot(resolved, rootsOf(record), platform);
    if (root === null || insideAny(resolved, folders, platform)) return 'outside';
    const real = await onRealPaths(resolved, root, folders);
    if (!real.ok) return real.why;
    // The tab names the real path from its opening. Do not silently follow a retargeted link.
    if (real.path !== path) return 'outside';
    const at = await standing(clock, resolved);
    if (at.kind !== 'file') return at.kind;
    return { resolved, root, attempt: { path, line: null, column: null }, at };
  }

  return {
    async read(request) {
      const folders = deps.refusedFolders();
      const clock = limiter.begin();
      const found = await find(request, clock, folders, false);
      if (found === null) return null;
      if (typeof found === 'string') return refused(found);
      if (found.at.kind === 'owned-image') {
        const image = await deps.images.admit(request.sessionId, found.resolved, clock);
        return image.ok ? { outcome: 'image', ...image.image } : refused(image.why === 'too-large' ? 'not-image' : image.why);
      }
      // `find` refuses a folder itself when none is taken: this narrows the type.
      if (found.at.kind !== 'file') return refused('folder');

      // An image's name (item 15): read as an image, wherever it is, and answered by the id the page draws it by.
      if (isImageName(lastPart(found.resolved))) {
        const image = await deps.images.admit(request.sessionId, found.resolved, clock);
        if (image.ok) return { outcome: 'image', ...image.image };
        if (image.why !== 'too-large' && image.why !== 'not-image') return refused(image.why);
        // One fat-g does not draw opens the tab that says so inside the project's folders, as a file of any other kind.
        if (found.root === null) return refused('not-image');
      }
      return readText(found, clock, folders);
    },

    async refresh({ sessionId, path, revision }) {
      const clock = limiter.begin();
      const before = await exactFile(sessionId, path, clock);
      if (before === null) return null;
      if (typeof before === 'string') return refused(before);
      if (before.at.kind !== 'file') return refused('folder');
      // Bounds and the supported-name list apply even to a claimed unchanged revision.
      if (before.at.stat.size > FILE_BYTES_BOUND || viewOf(lastPart(path)) === 'other') return readText(before, clock, deps.refusedFolders());
      if (sameFileRevision(revision, revisionOf(before.at.stat))) return { outcome: 'unchanged' };
      await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_SETTLE_MS));
      const settled = await exactFile(sessionId, path, clock);
      if (settled === null) return null;
      if (typeof settled === 'string') return refused(settled);
      if (settled.at.kind !== 'file') return refused('folder');
      if (!sameFileRevision(revisionOf(before.at.stat), revisionOf(settled.at.stat))) return { outcome: 'retry' };
      const answer = await readText(settled, clock, deps.refusedFolders());
      // A read is accepted only while the original path remains admitted, with the same metadata.
      const after = await exactFile(sessionId, path, clock);
      if (after === null) return null;
      if (typeof after === 'string') return refused(after);
      if (after.at.kind !== 'file') return refused('folder');
      if (answer.outcome === 'text' && (!sameFileRevision(answer.revision, revisionOf(settled.at.stat))
        || !sameFileRevision(answer.revision, revisionOf(after.at.stat)))) return { outcome: 'retry' };
      return answer;
    },

    async locate({ sessionId, path }) {
      const record = deps.session(sessionId);
      if (record === undefined) return null;
      if (path.includes('\0') || !isAbsoluteRoot(path, platform)) return { ok: false, why: 'outside' };
      const resolved = p.resolve(path);
      if (deps.images.owned(resolved)) {
        const image = await deps.images.admit(sessionId, resolved);
        return image.ok ? { ok: true, path: image.image.path } : { ok: false, why: image.why === 'too-large' ? 'not-image' : image.why };
      }
      const folders = deps.refusedFolders();
      const root = admittingRoot(resolved, rootsOf(record), platform);
      if ((root === null && !anywhere(resolved)) || insideAny(resolved, folders, platform)) return { ok: false, why: 'outside' };
      const real = await onRealPaths(resolved, root, folders);
      return real.ok ? { ok: true, path: real.path } : real;
    },

    async place(request) {
      const folders = deps.refusedFolders();
      const found = await find(request, limiter.begin(), folders, true);
      if (found === null) return null;
      if (typeof found === 'string') return { ok: false, why: found };
      if (found.at.kind === 'owned-image') {
        const image = await deps.images.admit(request.sessionId, found.resolved);
        return image.ok ? { ok: true, kind: 'file', path: image.image.path } : { ok: false, why: image.why === 'too-large' ? 'not-image' : image.why };
      }
      const real = await onRealPaths(found.resolved, found.root, folders);
      return real.ok ? { ok: true, kind: found.at.kind, path: real.path } : real;
    },
  };
}
