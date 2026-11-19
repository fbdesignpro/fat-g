// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Start fresh (docs/planning/_archive/M12.md, C61): a file fat-g refused is moved aside, unchanged, under a
// dated name in the same folder — never deleted, and never over an earlier copy. A rename replaces
// an existing file on Windows and POSIX alike, so each name is checked first.
import { lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { errorCode } from './json-file';

/** The most copies of one file with the same second in their name. */
export const MAX_SUFFIX = 99;

export interface SetAsideIo {
  /** Resolves when something is at the path, rejects with ENOENT when nothing is. */
  lstat(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
}

export const nodeSetAsideIo: SetAsideIo = { lstat, rename };

/** `2020-01-21T14:03:12.345Z` → `2020-01-21T14-03-12Z`: UTC to the second, legal in every file name. */
export function setAsideStamp(now: number): string {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

/** `records.json` at that time → `records.set-aside.<stamp>.json`, then `…<stamp>-2.json` and on. */
export function setAsideName(name: string, now: number, attempt = 1): string {
  const extension = path.extname(name);
  const base = name.slice(0, name.length - extension.length);
  return `${base}.set-aside.${setAsideStamp(now)}${attempt === 1 ? '' : `-${attempt}`}${extension}`;
}

/**
 * Moves `dir/name` aside and answers the full path it now has. Rejects, having moved nothing, when
 * every name is taken or the rename fails.
 */
export async function setAside(dir: string, name: string, now: number, io: SetAsideIo = nodeSetAsideIo): Promise<string> {
  const from = path.join(dir, name);
  for (let attempt = 1; attempt <= MAX_SUFFIX; attempt += 1) {
    const to = path.join(dir, setAsideName(name, now, attempt));
    if (await exists(to, io)) continue;
    await io.rename(from, to);
    return to;
  }
  throw Object.assign(new Error('every set-aside name is taken'), { code: 'EEXIST' });
}

/**
 * Moves several files of `dir` aside together, under one dated name (M18, C40): the conversation
 * store is its main file and what SQLite keeps beside it, and one moved without the others is an
 * older store, or an empty one. One attempt number is found that is free for every name; the files
 * that are there are moved, and one that is not is passed over. A rename that fails moves back what
 * was moved before it, and rejects: all, or none. Answers the full path the first name now has.
 */
export async function setAsideTogether(dir: string, names: readonly string[], now: number, io: SetAsideIo = nodeSetAsideIo): Promise<string> {
  const [first] = names;
  if (first === undefined) throw new Error('nothing to set aside');
  for (let attempt = 1; attempt <= MAX_SUFFIX; attempt += 1) {
    const targets = names.map((name) => path.join(dir, setAsideName(name, now, attempt)));
    let taken = false;
    for (const target of targets) taken ||= await exists(target, io);
    if (taken) continue;
    const moved: { readonly from: string; readonly to: string }[] = [];
    try {
      for (const [index, name] of names.entries()) {
        const from = path.join(dir, name);
        const to = targets[index] as string;
        if (!(await exists(from, io))) continue;
        await io.rename(from, to);
        moved.push({ from, to });
      }
    } catch (error) {
      // Back where they were, last moved first. One that will not go back stays aside, under its dated name.
      for (const { from, to } of moved.reverse()) await io.rename(to, from).catch(() => undefined);
      throw error;
    }
    return targets[0] as string;
  }
  throw Object.assign(new Error('every set-aside name is taken'), { code: 'EEXIST' });
}

async function exists(file: string, io: SetAsideIo): Promise<boolean> {
  try {
    await io.lstat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
