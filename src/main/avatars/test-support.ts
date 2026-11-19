// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// A file system stand-in for the avatars' tests (docs/planning/_archive/M102.md, V15, V16): a tree held in
// memory, with links, that answers the scanner's, the manifest reader's and the avatar source's
// questions — and records every call, so that a test can prove nothing was written and no more of an
// image read than its header. Paths are the platform's, resolved. No part of the app.
import path from 'node:path';
import type { AvatarEntry, AvatarEntryKind, AvatarFs, AvatarStat } from './fs';

export type StandInNode =
  /** A file's bytes. */
  | Uint8Array
  /** A file's bytes and its modification time. */
  | { readonly bytes: Uint8Array; readonly mtimeMs: number }
  /** A link, to a path the stand-in never follows. */
  | { readonly link: string }
  | { readonly folder: true }
  /** A device, a socket: neither a file nor a folder. */
  | { readonly other: true };

export interface StandInCall {
  readonly op: 'list' | 'lstat' | 'realpath' | 'readPrefix' | 'readWhole' | 'createFolder' | 'writeText' | 'createExclusiveFolder' | 'writeNewFile' | 'removeCopy' | 'moveFile';
  readonly path: string;
  /** For a read: how many bytes it handed back. */
  readonly bytes?: number;
}

export interface AvatarStandIn {
  readonly fs: AvatarFs;
  readonly calls: StandInCall[];
  /** Paths whose calls fail with this code. */
  readonly failing: Map<string, string>;
  /** Real paths to answer for a path: a folder swapped for a link elsewhere. */
  readonly real: Map<string, string>;
  set(target: string, node: StandInNode): void;
  remove(target: string): void;
  /** The tree's paths, folders included. */
  paths(): string[];
  /** A file's text, as written. */
  text(target: string): string | undefined;
}

const fail = (code: string): Error => Object.assign(new Error(code), { code });

export function avatarStandIn(tree: Readonly<Record<string, StandInNode>> = {}): AvatarStandIn {
  const nodes = new Map<string, StandInNode>();
  const calls: StandInCall[] = [];
  const failing = new Map<string, string>();
  const real = new Map<string, string>();
  const key = (target: string): string => path.resolve(target);

  function set(target: string, node: StandInNode): void {
    const resolved = key(target);
    for (let parent = path.dirname(resolved); !nodes.has(parent) && parent !== path.dirname(parent); parent = path.dirname(parent)) nodes.set(parent, { folder: true });
    nodes.set(resolved, node);
  }
  for (const [target, node] of Object.entries(tree)) set(target, node);

  const kindOf = (node: StandInNode): AvatarEntryKind => {
    if (node instanceof Uint8Array || 'bytes' in node) return 'file';
    if ('link' in node) return 'link';
    return 'folder' in node ? 'folder' : 'other';
  };
  const bytesOf = (node: StandInNode): Uint8Array => (node instanceof Uint8Array ? node : 'bytes' in node ? node.bytes : new Uint8Array(0));

  /** The node at a path, after its failure is checked: a call's first step. */
  function at(op: StandInCall['op'], target: string): StandInNode {
    const resolved = key(target);
    const code = failing.get(resolved);
    if (code !== undefined) { calls.push({ op, path: resolved }); throw fail(code); }
    const node = nodes.get(resolved);
    if (node === undefined) { calls.push({ op, path: resolved }); throw fail('ENOENT'); }
    return node;
  }

  const fs: AvatarFs = {
    async list(folder) {
      const node = at('list', folder);
      calls.push({ op: 'list', path: key(folder) });
      if (kindOf(node) !== 'folder') throw fail('ENOTDIR');
      const resolved = key(folder);
      return [...nodes].filter(([candidate]) => path.dirname(candidate) === resolved && candidate !== resolved).map(([candidate, child]): AvatarEntry => ({ name: path.basename(candidate), kind: kindOf(child) }));
    },
    async lstat(target): Promise<AvatarStat> {
      const node = at('lstat', target);
      calls.push({ op: 'lstat', path: key(target) });
      return { kind: kindOf(node), size: bytesOf(node).byteLength, mtimeMs: !(node instanceof Uint8Array) && 'mtimeMs' in node ? node.mtimeMs : 1000 };
    },
    async realpath(target) {
      at('realpath', target);
      calls.push({ op: 'realpath', path: key(target) });
      return real.get(key(target)) ?? key(target);
    },
    async readPrefix(target, bytes) {
      const node = at('readPrefix', target);
      if (kindOf(node) !== 'file') { calls.push({ op: 'readPrefix', path: key(target) }); throw fail('EISDIR'); }
      const read = bytesOf(node).subarray(0, bytes);
      calls.push({ op: 'readPrefix', path: key(target), bytes: read.byteLength });
      return read;
    },
    async readWhole(target, bound) {
      const node = at('readWhole', target);
      if (kindOf(node) !== 'file') { calls.push({ op: 'readWhole', path: key(target) }); throw fail('EISDIR'); }
      const all = bytesOf(node);
      const read = all.subarray(0, bound + 1);
      calls.push({ op: 'readWhole', path: key(target), bytes: read.byteLength });
      return read.byteLength > bound ? null : read;
    },
    async createFolder(folder) {
      calls.push({ op: 'createFolder', path: key(folder) });
      if (!nodes.has(key(folder))) set(folder, { folder: true });
    },
    async writeText(target, text) {
      const resolved = key(target);
      const code = failing.get(resolved);
      calls.push({ op: 'writeText', path: resolved, bytes: Buffer.byteLength(text) });
      if (code !== undefined) throw fail(code);
      if (!nodes.has(path.dirname(resolved))) throw fail('ENOENT');
      set(target, { bytes: new TextEncoder().encode(text), mtimeMs: 2000 });
    },
    async createExclusiveFolder(folder) {
      const resolved = key(folder);
      calls.push({ op: 'createExclusiveFolder', path: resolved });
      const code = failing.get(resolved);
      if (code !== undefined) throw fail(code);
      if (nodes.has(resolved)) return false;
      if (!nodes.has(path.dirname(resolved))) throw fail('ENOENT');
      set(folder, { folder: true });
      return true;
    },
    async writeNewFile(target, bytes) {
      const resolved = key(target);
      calls.push({ op: 'writeNewFile', path: resolved, bytes: bytes.byteLength });
      const code = failing.get(resolved);
      if (code !== undefined) throw fail(code);
      if (nodes.has(resolved)) throw fail('EEXIST');
      if (!nodes.has(path.dirname(resolved))) throw fail('ENOENT');
      set(target, { bytes, mtimeMs: 2000 });
    },
    async removeCopy(folder) {
      calls.push({ op: 'removeCopy', path: key(folder) });
      const resolved = key(folder);
      for (const candidate of [...nodes.keys()]) if (candidate === resolved || candidate.startsWith(`${resolved}${path.sep}`)) nodes.delete(candidate);
    },
    async moveFile(from, to) {
      const source = key(from);
      const target = key(to);
      calls.push({ op: 'moveFile', path: target });
      const code = failing.get(target) ?? failing.get(source);
      if (code !== undefined) throw fail(code);
      const node = nodes.get(source);
      if (node === undefined) throw fail('ENOENT');
      nodes.delete(source);
      set(to, node);
    },
  };

  return {
    fs,
    calls,
    failing,
    real,
    set,
    remove(target) {
      const resolved = key(target);
      for (const candidate of [...nodes.keys()]) if (candidate === resolved || candidate.startsWith(`${resolved}${path.sep}`)) nodes.delete(candidate);
    },
    paths: () => [...nodes.keys()].sort(),
    text(target) {
      const node = nodes.get(key(target));
      return node === undefined || kindOf(node) !== 'file' ? undefined : new TextDecoder().decode(bytesOf(node));
    },
  };
}
