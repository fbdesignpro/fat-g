// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A file system stand-in for the reader's tests (docs/planning/_archive/M19b.md, V4, V5, V20): a tree held in
// memory, with links, that answers the reader's three questions and the lookups' real path — and
// records every call, so a refusal that asked the file system anything fails its test. It follows
// the platform it is given: its separators, and how that system compares names. No part of the app.
import type { SessionRecord } from '../records/format';
import { createLookups, type LookupFs } from '../records/lookup';
import { comparable } from '../records/paths';
import { pathLib } from './confine';
import type { FileStat, FolderEntry, ReaderFs } from './fs';
import { createReadLimiter } from './limiter';
import { createImageFiles, type ImageFiles, type OwnedImageFiles } from './images';
import { createFileReader, type FileReader } from './reader';

export type Entry =
  /** A file's text, or its bytes. */
  | string
  | Uint8Array
  /** A link to another path: a link to a file, or a junction to a folder. */
  | { readonly link: string }
  /** A file of this size whose bytes are never to be read. */
  | { readonly size: number }
  /** A file that says `size` and gives `bytes`: one that grew between the two. */
  | { readonly size: number; readonly bytes: Uint8Array }
  | { readonly device: true }
  | { readonly folder: true };

export interface Call {
  readonly op: 'stat' | 'read' | 'list' | 'realpath';
  readonly path: string;
}

export interface StandIn {
  readonly fs: ReaderFs;
  readonly lookupFs: LookupFs;
  /** Every question asked, in order. */
  readonly calls: Call[];
  /** Paths whose calls never answer: a drive that has stopped answering. */
  readonly hung: Set<string>;
  /** Paths whose calls fail with this code. */
  readonly failing: Map<string, string>;
  /** Explicit timestamps let tests cover timestamp-only and size-only changes. */
  readonly mtimes: Map<string, number>;
  set(path: string, entry: Entry): void;
  remove(path: string): void;
}

const fail = (code: string): Error => Object.assign(new Error(code), { code });
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const encoder = new TextEncoder();

export function standIn(platform: string, tree: Readonly<Record<string, Entry>>): StandIn {
  const p = pathLib(platform);
  const key = (target: string): string => comparable(p.resolve(target), platform);
  /** By comparable path: the path as the tree spells it, and what is there. */
  const nodes = new Map<string, { readonly path: string; readonly entry: Entry }>();
  const calls: Call[] = [];
  const hung = new Set<string>();
  const failing = new Map<string, string>();
  const mtimes = new Map<string, number>();

  function set(target: string, entry: Entry): void {
    const resolved = p.resolve(target);
    // Every folder above it is there too.
    for (let parent = p.dirname(resolved); !nodes.has(key(parent)); parent = p.dirname(parent)) {
      nodes.set(key(parent), { path: parent, entry: { folder: true } });
      if (p.dirname(parent) === parent) break;
    }
    nodes.set(key(resolved), { path: resolved, entry });
  }
  for (const [target, entry] of Object.entries(tree)) set(target, entry);

  const isLink = (entry: Entry): entry is { readonly link: string } => typeof entry === 'object' && 'link' in entry;
  const isFolder = (entry: Entry): boolean => typeof entry === 'object' && 'folder' in entry;
  const isDevice = (entry: Entry): boolean => typeof entry === 'object' && 'device' in entry;
  const isFile = (entry: Entry): boolean => !isLink(entry) && !isFolder(entry) && !isDevice(entry);
  const bytesOf = (entry: Entry): Uint8Array => (typeof entry === 'string' ? encoder.encode(entry) : entry instanceof Uint8Array ? entry : typeof entry === 'object' && 'bytes' in entry ? entry.bytes : new Uint8Array(0));
  const sizeOf = (entry: Entry): number => (typeof entry === 'object' && !(entry instanceof Uint8Array) && 'size' in entry ? entry.size : bytesOf(entry).length);

  /** The path with every link in it followed, as the tree spells it; throws when nothing is there. */
  function real(target: string, depth = 0): string {
    if (depth > 16) throw fail('ELOOP');
    const resolved = p.resolve(target);
    const { root } = p.parse(resolved);
    let current = nodes.get(key(root))?.path ?? root;
    for (const part of resolved.slice(root.length).split(/[\\/]/).filter(Boolean)) {
      const node = nodes.get(key(p.join(current, part)));
      if (node === undefined) throw fail('ENOENT');
      current = isLink(node.entry) ? real(p.resolve(current, node.entry.link), depth + 1) : node.path;
    }
    return current;
  }
  const at = (target: string): { readonly path: string; readonly entry: Entry } => {
    const found = nodes.get(key(real(target)));
    if (found === undefined) throw fail('ENOENT');
    return found;
  };

  function ask<T>(op: Call['op'], target: string, answer: () => T): Promise<T> {
    calls.push({ op, path: target });
    if (hung.has(target)) return never<T>();
    const code = failing.get(target);
    if (code !== undefined) return Promise.reject(fail(code));
    try {
      return Promise.resolve(answer());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : fail('EIO'));
    }
  }

  const fs: ReaderFs = {
    stat: (target) => ask('stat', target, (): FileStat => {
      const { entry } = at(target);
      return { isFile: () => isFile(entry), isDirectory: () => isFolder(entry), size: sizeOf(entry), mtimeMs: mtimes.get(target) ?? 0 };
    }),
    read: (target, limit) => ask('read', target, () => {
      const { entry } = at(target);
      if (!isFile(entry)) throw fail('EISDIR');
      return bytesOf(entry).subarray(0, limit);
    }),
    list: (target, limit) => ask('list', target, (): FolderEntry[] => {
      const folder = at(target);
      if (!isFolder(folder.entry)) throw fail('ENOTDIR');
      return [...nodes.values()]
        .filter((node) => node.path !== folder.path && key(p.dirname(node.path)) === key(folder.path))
        .slice(0, limit)
        .map((node) => ({ name: p.basename(node.path), isFile: () => isFile(node.entry), isDirectory: () => isFolder(node.entry), isSymbolicLink: () => isLink(node.entry) }));
    }),
  };
  const lookupFs: LookupFs = {
    realpath: (target) => ask('realpath', target, () => real(target)),
    stat: (target) => ask('stat', target, () => ({ isDirectory: () => isFolder(at(target).entry) })),
  };

  return { fs, lookupFs, calls, hung, failing, mtimes, set, remove: (target) => { nodes.delete(key(target)); } };
}

export const SESSION = '8a1f0c52-3c1e-4d0b-9a37-5e2b7f6d9c10';
export const PROJECT = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';

/** A session's record, as far as the reader reads one. */
export const sessionRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  id: SESSION, projectId: PROJECT, providerId: 'example', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'example-model', effort: null, speed: null,
  name: null, nameSource: null, starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: 1, lastActiveAt: 1, lastTurn: null, ...overrides,
});

export interface Harness extends StandIn {
  readonly reader: FileReader;
  /** What the reader reads an image's file through (decision 0022, item 15), with ids minted in order. */
  readonly images: ImageFiles;
  /** The project's roots, which a test may change between two reads. */
  readonly roots: { path: string; answer: 'trusted' | 'not-trusted' | null }[];
  readonly missing: Set<string>;
  readonly refused: string[];
  /** The calls made since the last time this was asked: what one read asked of the file system. */
  asked(): string[];
}

export interface HarnessOptions {
  readonly platform: string;
  readonly tree: Readonly<Record<string, Entry>>;
  /** The session's project's roots, each trusted unless it says otherwise. */
  readonly roots: readonly (string | { readonly path: string; readonly answer: 'trusted' | 'not-trusted' | null })[];
  /** The folder the session runs in: the first root, unless given. */
  readonly folder?: string | null;
  readonly refused?: readonly string[];
  readonly deadlineMs?: number;
  readonly owned?: OwnedImageFiles;
}

export function harness({ platform, tree, roots: given, folder, refused: refusedGiven = [], deadlineMs, owned }: HarnessOptions): Harness {
  const stand = standIn(platform, tree);
  const roots = given.map((root) => (typeof root === 'string' ? { path: root, answer: 'trusted' as const } : { ...root }));
  const missing = new Set<string>();
  const refused = [...refusedGiven];
  let seen = 0;
  let minted = 0;
  const lookups = createLookups({ fs: stand.lookupFs });
  const limiter = createReadLimiter(deadlineMs === undefined ? {} : { deadlineMs });
  const images = createImageFiles({
    fs: stand.fs, lookups, limiter, platform,
    listed: (id) => id === SESSION,
    refusedFolders: () => refused,
    owned,
    mint: () => (minted += 1).toString(16).padStart(32, '0'),
  });
  const reader = createFileReader({
    fs: stand.fs,
    lookups,
    limiter,
    platform,
    session: (id) => (id === SESSION ? sessionRecord() : undefined),
    folder: () => (folder === undefined ? roots[0]?.path ?? null : folder),
    project: (id) => (id === PROJECT ? { roots } : undefined),
    isMissing: (root) => missing.has(root),
    refusedFolders: () => refused,
    images,
  });
  return {
    ...stand, reader, images, roots, missing, refused,
    asked() {
      const since = stand.calls.slice(seen).map((call) => `${call.op} ${call.path}`);
      seen = stand.calls.length;
      return since;
    },
  };
}
