// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// How roots are stored and compared (docs/planning/_archive/M12.md, Design 5; C24–C27, C78). The platform is
// a parameter, so each OS's rules run in every OS's tests.
//
// Stored: absolute and resolved, spelled as the OS returned it, with no trailing separator except
// the one that belongs to a filesystem root — `C:\` without it is "the current folder on drive C",
// and `/` without it is nothing. Links are not followed.
//
// Compared: on the real paths the OS reports, so each filesystem's own rules settle letter case and
// Unicode forms (a Mac volume or a Windows folder can be case-sensitive). When a real path cannot
// be had — the folder is missing, or its drive does not answer — on the stored paths, under the
// OS's usual rules instead.
import path from 'node:path';
import type { RootRelation } from '@shared/contracts/projects';
import type { Lookups } from './lookup';

export type Relation = RootRelation | 'apart';

const lib = (platform: string): path.PlatformPath => (platform === 'win32' ? path.win32 : path.posix);
const separator = (platform: string): string => (platform === 'win32' ? '\\' : '/');

/** A drive and its separator, or a UNC share (`\\server\share`, `\\?\…`). Never `\x` or `C:x`. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** Absolute under this platform's rules, and free of NUL. */
export function isAbsoluteRoot(input: string, platform: string): boolean {
  if (input.length === 0 || input.includes('\0')) return false;
  return platform === 'win32' ? WINDOWS_ABSOLUTE.test(input) : lib(platform).isAbsolute(input);
}

/** The stored form of a root (C24), or null for a path that is not absolute. */
export function normalizeRoot(input: string, platform: string): string | null {
  if (!isAbsoluteRoot(input, platform)) return null;
  const p = lib(platform);
  const resolved = p.resolve(input);
  if (p.parse(resolved).root === resolved) return resolved;
  return resolved.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
}

/** The folder's own name, proposed as a project's name (C17); none for a drive or filesystem root. */
export function folderName(root: string, platform: string): string | null {
  const p = lib(platform);
  if (p.parse(root).root === root) return null;
  const name = p.basename(root);
  return name.length > 0 ? name : null;
}

/**
 * Where `b` stands to `a`: the same folder, inside it, around it, or apart. `inside` means b begins
 * with a followed by a separator — or a is a filesystem root, which ends in one, and b begins with it.
 */
export function relationOf(a: string, b: string, sep: string): Relation {
  if (a === b) return 'same';
  const under = (parent: string, child: string): boolean => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (under(a, b)) return 'inside';
  if (under(b, a)) return 'around';
  return 'apart';
}

/**
 * A stored path under the OS's usual rules (C78): on Windows letter case is folded and `/` counts
 * as `\`; on macOS both are put in NFC and case is folded; on Linux the spelling must match.
 */
export function comparable(root: string, platform: string): string {
  if (platform === 'win32') return root.replaceAll('/', '\\').toLowerCase();
  if (platform === 'darwin') return root.normalize('NFC').toLowerCase();
  return root;
}

export interface Overlap {
  /** The earlier root. */
  readonly first: number;
  /** The later root, and how it stands to the earlier one. */
  readonly second: number;
  readonly relation: RootRelation;
}

/**
 * The first pair of roots that is not apart (C26), in the order a reader meets them: each root
 * against every root before it. Real paths where both answer; the stored paths otherwise.
 */
export async function firstOverlap(roots: readonly string[], platform: string, lookups: Lookups): Promise<Overlap | null> {
  const real = await Promise.all(roots.map((root) => lookups.realpath(root)));
  const sep = separator(platform);
  for (let second = 1; second < roots.length; second += 1) {
    for (let first = 0; first < second; first += 1) {
      const relation = pairRelation(roots[first] ?? '', roots[second] ?? '', real[first] ?? null, real[second] ?? null, platform, sep);
      if (relation !== 'apart') return { first, second, relation };
    }
  }
  return null;
}

/** How `candidate` stands to each of `roots`, in order: the first that is not apart. */
export async function overlapWith(roots: readonly string[], candidate: string, platform: string, lookups: Lookups): Promise<{ index: number; relation: RootRelation } | null> {
  const [real, ...realRoots] = await Promise.all([candidate, ...roots].map((root) => lookups.realpath(root)));
  const sep = separator(platform);
  for (const [index, root] of roots.entries()) {
    const relation = pairRelation(root, candidate, realRoots[index] ?? null, real ?? null, platform, sep);
    if (relation !== 'apart') return { index, relation };
  }
  return null;
}

function pairRelation(a: string, b: string, realA: string | null, realB: string | null, platform: string, sep: string): Relation {
  if (realA !== null && realB !== null) return relationOf(realA, realB, sep);
  return relationOf(comparable(a, platform), comparable(b, platform), sep);
}
