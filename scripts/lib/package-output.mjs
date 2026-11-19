// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { lstatSync } from 'node:fs';
import path from 'node:path';

/** A named child of release/, shared by the builder and audit. Never accept arbitrary delete paths. */
export function packageOptions(root, args, allowedFlags) {
  const [flavor, ...options] = args;
  if (flavor !== 'release' && flavor !== 'smoke') throw new Error('Expected release or smoke.');
  let name = flavor;
  let named = false;
  const flags = new Set();
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (option === '--output') {
      if (named) throw new Error('Specify --output only once.');
      named = true;
      name = options[++i];
      if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(name)
        || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) {
        throw new Error('--output needs a folder name (letters, numbers, dots, hyphens or underscores), not a path.');
      }
    } else if (allowedFlags.includes(option)) flags.add(option);
    else throw new Error(`Unknown option: ${option}`);
  }
  return { flavor, output: path.resolve(root, 'release', name), flags };
}

/** Check every known build directory before cleanup, including parents that could be junctions. */
export function checkPackageDirectories(root, directories) {
  const base = path.resolve(root);
  for (const directory of directories) {
    const relative = path.relative(base, path.resolve(directory));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Package directory must be inside the checkout: ${directory}`);
    }
    let current = base;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      let stat;
      try { stat = lstatSync(current); } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Package directory must be an ordinary folder: ${current}`);
    }
  }
}
