// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import path from 'node:path';
import type { InstallDirectoryHint } from '@shared/provider-kit/provider';
import type { InstallDirectory } from '@shared/provider-kit/process';

export interface InstallationEnvironment {
  readonly platform: string;
  readonly home: string;
  readonly appData?: string;
  readonly localAppData?: string;
}

/** Expands only declarative roots supplied by composition; providers never receive host env vars. */
export function expandInstallDirectories(hints: readonly InstallDirectoryHint[], environment: InstallationEnvironment): InstallDirectory[] {
  const p = environment.platform === 'win32' ? path.win32 : path.posix;
  const roots: Record<InstallDirectoryHint['base'], readonly (string | undefined)[]> = {
    home: [environment.home],
    'app-data': [environment.appData],
    'local-app-data': [environment.localAppData],
    applications: environment.platform === 'darwin' ? ['/Applications'] : [],
    'mac-applications': environment.platform === 'darwin' ? [p.join(environment.home, 'Applications'), '/Applications'] : [],
  };
  const result: InstallDirectory[] = [];
  for (const hint of hints) {
    if (hint.platforms !== undefined && !hint.platforms.includes(environment.platform as 'win32' | 'darwin' | 'linux')) continue;
    const segments = [...hint.segments, ...(hint.versions?.suffix ?? [])];
    if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\/\0:]/.test(segment))) continue;
    for (const root of roots[hint.base]) {
      if (root === undefined || !p.isAbsolute(root) || root.includes('\0')) continue;
      const directory = p.join(root, ...hint.segments);
      result.push(hint.versions === undefined ? directory : { ...hint.versions, root: directory });
    }
  }
  return [...new Map(result.map((directory) => [JSON.stringify(directory), directory])).values()];
}
