// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M22's two traces share (M22, C33, C34): their output folder, the state one invocation leaves
// for the next (a session's or a thread's id), and the reductions both use. Plain Node; nothing here
// is application code.
//
// Nothing a scenario notes is a text of the model's: the captures hold the frames. What the spike
// itself wrote — a command its prompt dictates, a rule it sent — is noted, and a command a request
// carries is noted only as whether it is that command.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SPIKES_DIR, writeJson } from '../../m10/lib/paths.mjs';

export const M22_DIR = path.join(SPIKES_DIR, 'output', 'm22');

/** What one invocation leaves for the next (raw; ignored folder): ids, never a text. */
const STATE = () => path.join(M22_DIR, 'state.json');
export const readState = () => (existsSync(STATE()) ? JSON.parse(readFileSync(STATE(), 'utf8')) : {});
export const writeState = (patch) => writeJson(STATE(), { ...readState(), ...patch });

/** Counts of received frames from `from` on, by type key. */
export function typeCounts(driver, typeOf, from = 0) {
  const counts = {};
  for (const f of driver.session.frames) {
    if (f.dir !== 'recv' || f.index < from) continue;
    const key = typeOf(f.frame);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Whether `file` is inside `folder`, by its resolved path; Windows compares without case. */
export function inFolder(file, folder) {
  if (typeof file !== 'string' || typeof folder !== 'string') return false;
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const resolved = fold(path.resolve(file));
  const root = fold(path.resolve(folder));
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** The name of the first of `folders` ({ name: dir }) that holds `file`, else `elsewhere`; null for no path. */
export function whereIs(file, folders, base = null) {
  if (typeof file !== 'string' || file.length === 0) return null;
  const full = path.isAbsolute(file) || !base ? file : path.join(base, file);
  for (const [name, dir] of Object.entries(folders)) if (inFolder(full, dir)) return name;
  return 'elsewhere';
}

/** A text cut to `units`, with its length when it was longer: for a CLI's own fixed words. */
export const cut = (text, units = 240) => (typeof text !== 'string' ? null : text.length <= units ? text : `${text.slice(0, units)}… (${text.length} units)`);
