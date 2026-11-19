// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where M10 writes. Raw output only ever goes under spikes/output/, which is gitignored (C7).
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** True when the module at `url` is the script Node was started with. */
export const isMain = (url) => Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === url;

export const M10_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPIKES_DIR = path.resolve(M10_DIR, '..');
export const REPO_ROOT = path.resolve(SPIKES_DIR, '..');
export const OUTPUT_DIR = path.join(SPIKES_DIR, 'output', 'm10');
export const FONTS_OUTPUT_DIR = path.join(SPIKES_DIR, 'output', 'fonts');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures');

export function outputPath(...segments) {
  const file = path.join(OUTPUT_DIR, ...segments);
  if (!file.startsWith(OUTPUT_DIR + path.sep)) throw new Error('output path escapes spikes/output/m10');
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** Write-then-rename, so a spike ended mid-write never leaves half a JSON file behind. */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
  return file;
}

export const stamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 0) { out[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const next = argv[i + 1];
    out[arg.slice(2)] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}
