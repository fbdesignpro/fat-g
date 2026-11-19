// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The avatar service (docs/planning/_archive/M102.md, Design 5; C17, C20, C22, C30, C40, C57): the one owner of
// the avatar catalog. It scans both roots with the one scanner, the built-in root first, at start and
// at each Rescan, and replaces the catalog whole when both have landed; nothing watches the folders,
// and the catalog lives in memory alone (C57). Before the first scan lands the catalog is empty: the
// first app state carries no avatar, and the placeholder stands until the state updates.
//
// A Rescan pressed while a scan runs is one more scan after it, and a further press joins that one:
// at most one runs and one waits, and each press's answer follows a scan that began after it.
//
// In a root fat-g may write, a scan makes the `family.json` a family holding avatars lacks, with
// fat-g's defaults, and reads the root again; and the family editor's save writes one (authoring.ts;
// decision 0031), then scans both roots again; as does its Add avatar, which makes a new avatar's
// folder too (add-avatar.ts; decision 0036), and an image replaced, the old one sent to the system's
// trash (replace-image.ts). A scan and a write never run at once.
//
// Electron-free: the roots, the file system, the providers and the log are its options.
import path from 'node:path';
import type { AddAvatarAnswer, AddAvatarRequest, CopyFamilyAnswer, CreateFamilyAnswer, CreateFamilyRequest, FamilySource, ReplaceImageAnswer, ReplaceImageRequest, SaveFamilyAnswer, SaveFamilyRequest } from '@shared/contracts/avatar-family';
import type { OverlayLayer } from '@shared/contracts/avatar-overlay';
import type { AvatarListing, AvatarOrigin, AvatarRef, FamilyRef, ResolvedAvatar } from '@shared/contracts/avatars';
import { addAvatar } from './add-avatar';
import { openFamily, saveFamily, seedMissing } from './authoring';
import { type AvatarCatalog, type AvatarFileEntry, buildCatalog, countsLine, EMPTY_CATALOG, type FamilyIndex } from './catalog';
import type { AvatarFs } from './fs';
import { copyFamily } from './copy-family';
import { createFamily } from './create-family';
import { replaceImage, type Trash } from './replace-image';
import { type ScannedFamily, type ScannedRoot, scanRoot } from './scan';

export interface AvatarServiceOptions {
  /** The built-in art's folder, and the user's in fat-g's data folder (C17). */
  readonly roots: { readonly builtIn: string; readonly user: string };
  /**
   * Which roots fat-g may write a family's `family.json` into (decision 0031): the user's unless told
   * otherwise; the built-in art's only when told, in a development run.
   */
  readonly writable?: { readonly builtIn?: boolean; readonly user?: boolean };
  readonly fs: AvatarFs;
  /** Where a replaced image goes (decision 0036): the system's trash; without one, no image is replaced. */
  readonly trash?: Trash;
  /** The provider ids this build registers (C15). */
  readonly providers: readonly string[];
  /** The one line a scan writes: counts alone (C22). */
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

export interface AvatarService {
  /** Scans both roots; resolves once the catalog of a scan begun after this call stands. */
  scan(): Promise<void>;
  /** Resolves once no scan runs or waits. */
  idle(): Promise<void>;
  listing(): AvatarListing;
  file(id: string): AvatarFileEntry | undefined;
  defaultFace(providerId: string): ResolvedAvatar | null;
  /** The avatar a reference names, as this scan listed it (M103, C11): null for one not listed or with no usable portrait. */
  assigned(ref: AvatarRef): ResolvedAvatar | null;
  /** A family as this scan listed it, to be searched as a provider's active family (decision 0031). */
  family(ref: FamilyRef): FamilyIndex | undefined;
  /** The built-in family holding a provider's face: its active family until the user chooses one. */
  defaultFamily(providerId: string): FamilyRef | null;
  /** A listed avatar's overlay layers from its manifest: its family's, then its own (decision 0032). */
  layers(ref: AvatarRef): readonly (OverlayLayer | undefined)[];
  /** A listed family as its file holds it now, for the family editor; null for one this scan did not list. */
  openFamily(ref: FamilyRef): Promise<FamilySource | null>;
  /** A listed family's current, confined folder for the file manager; its path stays in main. */
  familyFolder(ref: FamilyRef): Promise<string | null>;
  /** A draft saved into a listed family's file; once saved, both roots are scanned again before it answers. */
  saveFamily(request: SaveFamilyRequest): Promise<SaveFamilyAnswer>;
  /** Copy a built-in family into the user's avatars, then publish the updated catalog. */
  copyFamily(ref: FamilyRef): Promise<CopyFamilyAnswer>;
  /** Start a new user family from prepared PNGs, then publish its catalog. */
  createFamily(request: CreateFamilyRequest): Promise<CreateFamilyAnswer>;
  /** A new avatar made in a listed family (decision 0036); once added, both roots are scanned again and the family read again before it answers. */
  addAvatar(request: AddAvatarRequest): Promise<AddAvatarAnswer>;
  /** An avatar's image replaced (decision 0036); once replaced, both roots are scanned again before it answers. */
  replaceImage(request: ReplaceImageRequest): Promise<ReplaceImageAnswer>;
  /** Told after each catalog that replaces the last. */
  subscribe(listener: () => void): () => void;
}

export function createAvatarService(options: AvatarServiceOptions): AvatarService {
  const log = options.log ?? console;
  const known: ReadonlySet<string> = new Set(options.providers);
  const writable: Readonly<Record<AvatarOrigin, boolean>> = { 'built-in': options.writable?.builtIn ?? false, user: options.writable?.user ?? true };
  const listeners = new Set<() => void>();
  let catalog: AvatarCatalog = EMPTY_CATALOG;
  let scanned: readonly ScannedRoot[] = [];
  let running: Promise<void> | null = null;
  let waiting: Promise<void> | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  /** One at a time, in the order asked: a save never writes while a scan reads. */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  /** A root read, with the files it lacks made first where fat-g may write it. */
  async function scanOne(origin: AvatarOrigin, root: string): Promise<ScannedRoot> {
    const read = await scanRoot(origin, root, options.fs);
    if (!writable[origin]) return read;
    const made = await seedMissing(read, options.fs);
    if (made === 0) return read;
    log.info(`[avatars] ${made} ${made === 1 ? 'family.json' : 'family.json files'} made with the defaults`);
    return scanRoot(origin, root, options.fs);
  }

  async function both(): Promise<void> {
    const builtIn = await scanOne('built-in', options.roots.builtIn);
    const user = await scanOne('user', options.roots.user);
    scanned = [builtIn, user];
    catalog = buildCatalog(scanned, known);
    log.info(countsLine(catalog.counts));
    for (const listener of [...listeners]) {
      try { listener(); } catch { log.warn('[avatars] a listener failed'); }
    }
  }

  function start(): Promise<void> {
    const run: Promise<void> = exclusive(both)
      .catch(() => { log.warn('[avatars] the scan failed; the last catalog stands'); })
      .finally(() => { if (running === run) running = null; });
    running = run;
    return run;
  }

  function scan(): Promise<void> {
    if (running === null) return start();
    waiting ??= running.then(() => { waiting = null; return start(); });
    return waiting;
  }

  /** A family of the last scan, with its root. */
  function find(ref: FamilyRef): { readonly root: ScannedRoot; readonly family: ScannedFamily } | null {
    const root = scanned.find((candidate) => candidate.origin === ref.origin);
    const family = root?.families.find((candidate) => candidate.folder === ref.family);
    return root === undefined || family === undefined ? null : { root, family };
  }

  return {
    scan,
    async idle() {
      while (running !== null || waiting !== null) await (waiting ?? running);
    },
    listing: () => catalog.listing,
    file: (id) => catalog.file(id),
    defaultFace: (providerId) => catalog.defaultFace(providerId),
    assigned: (ref) => catalog.byRef(ref),
    family: (ref) => catalog.family(ref),
    defaultFamily: (providerId) => catalog.defaultFamily(providerId),
    layers: (ref) => catalog.layers(ref),
    openFamily: (ref) => exclusive(async () => {
      const found = find(ref);
      return found === null ? null : openFamily(found.root, found.family, writable[ref.origin], options.fs);
    }),
    familyFolder: (ref) => exclusive(async () => {
      const found = find(ref);
      if (found === null || found.root.realRoot === null) return null;
      const root = options.roots[ref.origin === 'built-in' ? 'builtIn' : 'user'];
      try {
        if ((await options.fs.lstat(root)).kind !== 'folder') return null;
        const realRoot = await options.fs.realpath(root);
        if (realRoot !== found.root.realRoot) return null;
        const folder = path.join(realRoot, found.family.folder);
        if ((await options.fs.lstat(folder)).kind !== 'folder') return null;
        const real = await options.fs.realpath(folder);
        if (path.relative(realRoot, real) !== found.family.folder) return null;
        return real;
      } catch {
        return null;
      }
    }),
    async saveFamily(request) {
      const answer = await exclusive(async (): Promise<SaveFamilyAnswer> => {
        const found = find(request.ref);
        return found === null ? { kind: 'missing' } : saveFamily(found.root, found.family, writable[request.ref.origin], options.fs, request);
      });
      if (answer.kind === 'saved') {
        log.info('[avatars] a family.json saved');
        await scan();
      }
      return answer;
    },
    copyFamily: (ref) => exclusive(async () => {
      if (ref.origin !== 'built-in' || !writable.user) return { kind: 'unavailable' };
      const found = find(ref);
      if (found === null) return { kind: 'missing' };
      const result = await copyFamily(found.root, found.family, options.roots.user, options.fs);
      if (result.kind !== 'copied') return result;
      await both();
      log.info('[avatars] a built-in family copied');
      return { kind: 'copied', ref: result.ref, listing: catalog.listing };
    }),
    createFamily: (request) => exclusive(async (): Promise<CreateFamilyAnswer> => {
      if (!writable.user) return { kind: 'unavailable' };
      const result = await createFamily(options.roots.user, options.fs, request);
      if (result.kind !== 'created') return result;
      await both();
      log.info('[avatars] a family created');
      return { ...result, listing: catalog.listing };
    }),
    addAvatar: (request) => exclusive(async (): Promise<AddAvatarAnswer> => {
      const found = find(request.ref);
      if (found === null) return { kind: 'missing' };
      const result = await addAvatar(found.root, found.family, writable[request.ref.origin], options.fs, request);
      if (result.kind !== 'added') return result;
      await both();
      log.info('[avatars] an avatar added');
      const again = find(request.ref);
      if (again === null) return { kind: 'missing' };
      const source = await openFamily(again.root, again.family, writable[request.ref.origin], options.fs);
      return { kind: 'added', folder: result.folder, source, listing: catalog.listing };
    }),
    replaceImage: (request) => exclusive(async (): Promise<ReplaceImageAnswer> => {
      const found = find(request.ref);
      if (found === null) return { kind: 'missing' };
      const trash = options.trash ?? (() => Promise.reject(new Error('no trash')));
      const result = await replaceImage(found.root, found.family, writable[request.ref.origin], options.fs, trash, request);
      if (result.kind !== 'replaced') {
        // A failure may have replaced part: the scan tells what stands.
        if (result.kind === 'failed') await both();
        return result;
      }
      await both();
      log.info('[avatars] an avatar image replaced');
      return { kind: 'replaced', listing: catalog.listing };
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
