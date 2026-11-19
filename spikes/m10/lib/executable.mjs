// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Finding a CLI: a --path override, then PATH, then the known install folders. Native before shim
// within each tier, like the app. No folder under ~/.claude or ~/.codex is ever searched (C3).
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

export class ExecutableMissing extends Error {
  constructor(name, override) {
    super(override ? `${name}: the --path given does not exist or is not a file` : `${name}: not found on PATH or in the known install folders`);
    this.name = 'ExecutableMissing';
  }
}

function isFile(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}

export function kindOf(file) {
  if (!isWin) return 'native';
  if (/\.(exe|com)$/i.test(file)) return 'native';
  if (/\.(cmd|bat)$/i.test(file)) return 'shim';
  return null;
}

export function knownInstallDirs() {
  const home = homedir();
  const dirs = [path.join(home, '.local', 'bin')];
  if (isWin) {
    dirs.push(path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'));
    dirs.push(path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'));
  }
  return dirs;
}

/** A folder belonging to a CLI's own data, never searched and never read (C3). */
function isCliFolder(dir) {
  const home = homedir().toLowerCase();
  const d = path.resolve(dir).toLowerCase();
  return ['.claude', '.codex'].some((name) => d === path.join(home, name) || d.startsWith(path.join(home, name) + path.sep));
}

/**
 * Resolves `name`, or throws ExecutableMissing. `{ path, kind: 'native' | 'shim', source }`.
 */
export function resolveExecutable(name, override) {
  if (typeof override === 'string') {
    const file = path.resolve(override);
    if (!isFile(file) || !kindOf(file)) throw new ExecutableMissing(name, true);
    return { path: file, kind: kindOf(file), source: 'override' };
  }
  const pathDirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
  const tiers = [['path', pathDirs], ['known-dir', knownInstallDirs()]];
  const kinds = isWin ? [['native', ['.exe']], ['shim', ['.cmd']]] : [['native', ['']]];
  for (const [source, dirs] of tiers) {
    for (const [, suffixes] of kinds) {
      for (const dir of dirs) {
        if (isCliFolder(dir)) continue;
        for (const suffix of suffixes) {
          const file = path.join(dir, name + suffix);
          if (isFile(file)) return { path: file, kind: kindOf(file), source };
        }
      }
    }
  }
  throw new ExecutableMissing(name, false);
}
