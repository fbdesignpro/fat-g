// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Scratch folders (C5): outside the repository and outside any real project, under the temp folder,
// with stable names rebuilt per invocation. The CLIs' own records of working folders therefore grow
// by three entries in all, not by one per run.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './paths.mjs';

// Two are M15's (spikes/m15): the folder its saved threads start in, and a second folder outside
// it. Their names never change, so a saved thread is found again by its folder. Four are M16's
// (spikes/m16): the folder its saved Claude sessions start in, two more roots handed over with
// `--add-dir`, and a folder outside every root.
export const SCRATCH_NAMES = Object.freeze({
  trace: 'fat-g-spike-trace', trust: 'fat-g-spike-trust', probe: 'fat-g-spike-probe', m15: 'fat-g-spike-m15', m15Outside: 'fat-g-spike-m15-outside',
  m16: 'fat-g-spike-m16', m16Other: 'fat-g-spike-m16-other', m16Third: 'fat-g-spike-m16-third', m16Outside: 'fat-g-spike-m16-outside',
  // M22's K1 (spikes/m22): a second root of the project, which Codex is not given.
  m22Second: 'fat-g-spike-m22-second',
  // M22b's K1 (spikes/m22b), in reserve: a plans folder named by `--settings`.
  m22bPlans: 'fat-g-spike-m22b-plans',
});
const MARKER = '.fat-g-spike';
const MARKER_TEXT = "Scratch folder made by fat-g's spikes (spikes/m10, spikes/m15, spikes/m16, spikes/m19, spikes/m19b, spikes/m20a, spikes/m20b). Safe to delete.\n";

/** The small harmless files every tracing session sees. */
export const TRACE_FILES = Object.freeze({
  'sample.txt': "The lighthouse keeper's cat is called Biscuit, and it sleeps on the warm lamp housing.\n",
  'notes-1.txt': 'Note one: the tide table is pinned by the door.\n',
  'notes-2.txt': 'Note two: the kettle whistles twice before it boils.\n',
  'notes-3.txt': 'Note three: the logbook is kept in the blue drawer.\n',
  'notes-4.txt': 'Note four: the spare bulbs are on the top shelf.\n',
});

export function scratchPath(kind) {
  const name = SCRATCH_NAMES[kind];
  if (!name) throw new Error(`unknown scratch kind ${kind}`);
  return path.join(tmpdir(), name);
}

/**
 * Deletes and rebuilds the scratch folder of `kind` with `files` (relative path → text). Refuses a
 * folder of that name that it did not make, and any location inside the repository.
 */
export function buildScratch(kind, files = {}) {
  const dir = scratchPath(kind);
  const inside = (child, parent) => child.toLowerCase().startsWith(parent.toLowerCase() + path.sep);
  if (inside(dir, REPO_ROOT) || dir.toLowerCase() === REPO_ROOT.toLowerCase()) throw new Error('scratch folder would sit inside the repository');
  if (existsSync(dir)) {
    if (!existsSync(path.join(dir, MARKER))) throw new Error(`${dir} exists but was not made by the spikes; not touching it`);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, MARKER), MARKER_TEXT);
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative);
    if (!inside(file, dir)) throw new Error(`scratch file escapes the folder: ${relative}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { dir, manifest: manifestOf(dir) };
}

/** Relative path → { size, sha256 } for every file under `dir`. */
export function manifestOf(dir) {
  const manifest = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const bytes = readFileSync(full);
        manifest[path.relative(dir, full).split(path.sep).join('/')] = { size: statSync(full).size, sha256: createHash('sha256').update(bytes).digest('hex') };
      } else {
        manifest[path.relative(dir, full).split(path.sep).join('/')] = { size: -1, sha256: 'not-a-file' };
      }
    }
  };
  walk(dir);
  return manifest;
}

/** V10: the folder's files compared with the manifest taken when it was built. */
export function compareManifest(dir, manifest) {
  const now = existsSync(dir) ? manifestOf(dir) : {};
  const added = Object.keys(now).filter((name) => !(name in manifest));
  const removed = Object.keys(manifest).filter((name) => !(name in now));
  const changed = Object.keys(manifest).filter((name) => name in now && now[name].sha256 !== manifest[name].sha256);
  return { unchanged: added.length + removed.length + changed.length === 0, added, removed, changed };
}
