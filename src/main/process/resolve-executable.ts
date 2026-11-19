// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import path from 'node:path';
import type { Executable, Resolution, ResolveRequest, VersionedInstallDirectory } from '@shared/provider-kit/process';
import type { ExecutablePresence } from '@shared/contracts/provider-discovery';
import { absoluteDirs, type Environment, sanitizeEnv } from './env';
import { isInstallChild, MAX_INSTALL_ENTRIES, newestInstallChild, type readInstallChildren } from './install-children';

/** The most CLIs one resolution names with `every`: each is launched for its version at detection. */
export const MAX_CANDIDATES = 8;
export interface ResolverOptions {
  platform: string;
  env: Environment;
  /** stat follows symlinks; this also checks execute access on POSIX. Errors mean unavailable. */
  isExecutableFile: (file: string) => Promise<boolean>;
  readInstallChildren?: typeof readInstallChildren;
}

/** Same search as a launch, but an inaccessible candidate is not evidence of an uninstall. */
export async function discoverExecutable(request: ResolveRequest, options: ResolverOptions): Promise<ExecutablePresence> {
  let inconclusive = false;
  const failed = (error: unknown) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') inconclusive = true;
  };
  try {
    const result = await resolveExecutable(request, {
      ...options,
      async isExecutableFile(file) {
        try { return await options.isExecutableFile(file); } catch (error) {
          failed(error);
          return false;
        }
      },
      ...(options.readInstallChildren === undefined ? {} : {
        async readInstallChildren(root, kind) {
          try { return await options.readInstallChildren!(root, kind); }
          catch (error) { failed(error); return []; }
        },
      } satisfies Pick<ResolverOptions, 'readInstallChildren'>),
    });
    return { kind: result.status === 'found' ? 'present' : inconclusive ? 'unknown' : 'missing', overrideInvalid: result.status === 'not-found' && result.overrideInvalid };
  } catch { return { kind: 'unknown', overrideInvalid: false }; }
}
export async function resolveExecutable(request: ResolveRequest, { platform, env, isExecutableFile, readInstallChildren }: ResolverOptions): Promise<Resolution> {
  const windows = platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const missing = (overrideInvalid: boolean): Resolution => ({ status: 'not-found', overrideInvalid, reason: overrideInvalid ? 'invalid-override' : 'missing' });
  const kind = (file: string): Executable['kind'] | undefined => !windows ? 'native'
    : /\.(exe|com)$/i.test(file) ? 'native' : /\.(cmd|bat)$/i.test(file) ? 'cmd-shim' : undefined;
  async function check(file: string): Promise<Executable | undefined> {
    const launch = kind(file);
    if (!launch || !p.isAbsolute(file) || file.includes('\0')) return;
    try { if (await isExecutableFile(file)) return { path: file, kind: launch }; } catch { /* inaccessible is unavailable */ }
    return;
  }
  if (request.override !== null) {
    const executable = await check(request.override);
    return executable ? { status: 'found', executable, source: 'override' } : missing(true);
  }
  const clean = sanitizeEnv(env, platform);
  const extensions = windows ? (clean['PATHEXT'] ?? '.EXE;.COM;.CMD;.BAT').toLowerCase().split(';').filter((s) => /^\.(exe|com|cmd|bat)$/.test(s)) : [''];
  const names = request.names.filter((name) => name.length > 0 && !/[\\/\0]/.test(name) && name !== '.' && name !== '..');
  const same = (file: string): string => (windows ? p.normalize(file).toLowerCase() : p.normalize(file));
  const cwd = same(request.cwd);
  // What is found, in order: the first alone, or with `every` each CLI once, up to the bound.
  const found: { executable: Executable; source: 'path' | 'known-dir' }[] = [];
  const seen = new Set<string>();
  const enough = (): boolean => found.length >= (request.every === true ? MAX_CANDIDATES : 1);
  async function search(tier: readonly string[], source: 'path' | 'known-dir'): Promise<void> {
    const dirs = absoluteDirs(tier, platform).filter((dir) => same(dir) !== cwd);
    // Native before shim within each tier, then directory and descriptor order.
    for (const launch of windows ? ['native', 'cmd-shim'] : ['native']) {
      for (const dir of dirs) for (const name of names) {
        const suffixes = windows && p.extname(name) ? (extensions.includes(p.extname(name).toLowerCase()) ? [''] : []) : extensions;
        for (const suffix of suffixes) {
          const file = p.join(dir, name + suffix);
          if (kind(file) !== launch || seen.has(same(file))) continue;
          const executable = await check(file);
          if (!executable) continue;
          seen.add(same(file));
          found.push({ executable, source });
          if (enough()) return;
        }
      }
    }
  }
  const result = (): Resolution => {
    const [first, ...others] = found;
    if (first === undefined) return missing(false);
    return { status: 'found', ...first, ...(request.every === true ? { others } : {}) };
  };
  await search((clean['PATH'] ?? '').split(windows ? ';' : ':'), 'path');
  if (enough()) return result();
  await search(request.knownDirs.filter((dir) => typeof dir === 'string'), 'known-dir');
  if (enough()) return result();
  // Versioned desktop runtimes are a fallback, enumerated anew on each resolution instead of
  // caching the directory listing. Neither a PATH match nor an override triggers this read
  // unless every CLI is asked for.
  if (names.length === 0) return result();
  for (const directory of request.knownDirs) {
    if (typeof directory === 'string') continue;
    const { root, children, nested, suffix } = directory;
    if (!p.isAbsolute(root) || root.includes('\0') || (children !== 'version' && children !== 'hash')
      || (nested !== undefined && nested !== 'version' && nested !== 'hash')
      || suffix.some((part) => !part || part === '.' || part === '..' || /[\\/\0:]/.test(part))
      || same(root) === cwd) continue;
    const listed = async (folder: string, kind: VersionedInstallDirectory['children']): Promise<string[]> => {
      const entries = await readInstallChildren!(folder, kind);
      if (entries.length > MAX_INSTALL_ENTRIES) throw new Error('installation-directory-limit');
      return entries.filter((entry) => isInstallChild(entry.name, kind)).sort(newestInstallChild(kind)).map((entry) => p.join(folder, entry.name));
    };
    if (readInstallChildren !== undefined) {
      try {
        const dirs = await listed(root, children);
        if (nested === undefined) await search(dirs.map((dir) => p.join(dir, ...suffix)), 'known-dir');
        else {
          // An older version's builds are read only when the newer ones held no executable, or every CLI is asked for.
          for (const dir of dirs) {
            let builds: string[];
            try { builds = await listed(dir, nested); } catch { continue; }
            await search(builds.map((build) => p.join(build, ...suffix)), 'known-dir');
            if (enough()) break;
          }
        }
      } catch { /* an inaccessible runtime folder is unavailable; discovery records uncertainty */ }
    }
    if (enough()) return result();
    // The root's own copy after its build folders: a desktop app updates into them and can leave it
    // behind (Codex's root 0.130, its newest build 0.167).
    if (directory.includeRoot) await search([root], 'known-dir');
    if (enough()) return result();
  }
  return result();
}
