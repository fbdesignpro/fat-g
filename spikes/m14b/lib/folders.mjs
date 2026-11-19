// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Scratch configuration folders for the M14b spike (C1, Design 1): one parent under the temp
// folder, marked as the spikes' own with M10's marker file, and under it one folder per CLI and
// case. The marker sits in the parent, so an "empty" folder is truly empty.
//
// A folder here stands in for an account's folder, so the spike asks of it only what fat-g will
// (S6): whether it is there, and the names of its top-level entries once every process is gone.
// No file inside one is ever opened.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../../m10/lib/paths.mjs';

export const PARENT_NAME = 'fat-g-spike-m14b';
export const CASES = Object.freeze(['empty', 'absent', 'login']);
const MARKER = '.fat-g-spike';
const MARKER_TEXT = "Scratch folder made by fat-g's M14b spike (spikes/m14b). Safe to delete once the spike's second part has run.\n";

export const parentPath = () => path.join(tmpdir(), PARENT_NAME);

export function folderPath(cli, kind) {
  if (!/^[a-z]+$/.test(cli) || !CASES.includes(kind)) throw new Error(`unknown scratch folder ${cli}-${kind}`);
  return path.join(parentPath(), `${cli}-${kind}`);
}

export const folderLabel = (cli, kind) => `${cli}-${kind}`;

/** Makes the parent, or accepts one the spike made earlier. Refuses any other folder of that name. */
export function ensureParent() {
  const dir = parentPath();
  const repo = REPO_ROOT.toLowerCase();
  if (dir.toLowerCase() === repo || dir.toLowerCase().startsWith(repo + path.sep)) throw new Error('the scratch parent would sit inside the repository');
  if (existsSync(dir)) {
    if (!existsSync(path.join(dir, MARKER))) throw new Error(`${dir} exists but was not made by the spikes; not touching it`);
    return dir;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, MARKER), MARKER_TEXT);
  return dir;
}

/** Deletes one case folder. Only ever a direct child of the marked parent, named as folderPath names it. */
export function removeFolder(cli, kind) {
  const parent = ensureParent();
  const dir = folderPath(cli, kind);
  if (path.dirname(dir) !== parent) throw new Error('scratch folder escapes its parent');
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  return !existsSync(dir);
}

/** An empty folder, rebuilt. */
export function makeEmpty(cli, kind = 'empty') {
  removeFolder(cli, kind);
  const dir = folderPath(cli, kind);
  mkdirSync(dir);
  return dir;
}

/** A path that names no folder. */
export function makeAbsent(cli) {
  removeFolder(cli, 'absent');
  return folderPath(cli, 'absent');
}

/** Removes the parent once nothing but the marker is left in it. Returns whether it is gone. */
export function removeParentIfBare() {
  const dir = parentPath();
  if (!existsSync(dir)) return true;
  if (!existsSync(path.join(dir, MARKER))) return false;
  if (readdirSync(dir).some((name) => name !== MARKER)) return false;
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  return !existsSync(dir);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_HEX = /[0-9a-f]{16,}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/** An entry's name, with anything id-like in it replaced: a name is kept for its kind, not its value. */
export const maskName = (name) => name.replace(EMAIL, '<email>').replace(UUID, '<uuid>').replace(LONG_HEX, '<hex>');

/**
 * The folder's top-level entries: name, kind, and for a folder how many entries it holds. One
 * listing of names; nothing is opened. `null` when the folder is not there.
 */
export function entriesOf(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const kind = entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : 'other';
    const row = { name: maskName(entry.name), kind };
    if (kind === 'folder') {
      try { row.entries = readdirSync(path.join(dir, entry.name)).length; } catch { row.entries = null; }
    }
    out.push(row);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
