// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { InstallDirectoryHint } from '@shared/provider-kit/provider';
import { expandInstallDirectories } from './provider-installation';

describe('provider installation hints', () => {
  it('expands declarative roots for the active platform without provider-specific logic', () => {
    expect(expandInstallDirectories([
      { base: 'home', segments: ['.local', 'bin'] },
      { base: 'app-data', segments: ['npm'], platforms: ['win32'] },
      { base: 'local-app-data', segments: ['Programs'], platforms: ['linux'] },
    ], {
      platform: 'win32', home: 'C:\\Users\\person', appData: 'C:\\Users\\person\\AppData\\Roaming', localAppData: 'C:\\Users\\person\\AppData\\Local',
    })).toEqual([
      'C:\\Users\\person\\.local\\bin',
      'C:\\Users\\person\\AppData\\Roaming\\npm',
    ]);
  });

  it('drops relative roots, traversal, separators, and duplicates', () => {
    expect(expandInstallDirectories([
      { base: 'home', segments: ['bin'] },
      { base: 'home', segments: ['bin'] },
      { base: 'home', segments: ['..'] },
      { base: 'home', segments: ['nested/bin'] },
      { base: 'app-data', segments: ['npm'] },
    ], { platform: 'linux', home: '/home/person', appData: 'relative' })).toEqual(['/home/person/bin']);
  });

  it('keeps versioned hints declarative, rejects escaping suffixes, and expands macOS app roots only on macOS', () => {
    const versions = { children: 'version', suffix: ['runtime'] } as const;
    const hints = [
      { base: 'home', segments: ['desktop'], versions },
      { base: 'home', segments: ['desktop'], versions },
      { base: 'home', segments: ['desktop'], versions: { ...versions, suffix: ['..'] } },
      { base: 'applications', segments: ['Example.app', 'Contents', 'Resources'] },
    ] as const;
    expect(expandInstallDirectories(hints, { platform: 'darwin', home: '/Users/person' })).toEqual([
      { root: '/Users/person/desktop', ...versions }, '/Applications/Example.app/Contents/Resources',
    ]);
    expect(expandInstallDirectories(hints, { platform: 'linux', home: '/home/person' })).toEqual([{ root: '/home/person/desktop', ...versions }]);
  });

  it('expands app bundle hints under both Applications folders only on macOS', () => {
    const hints: readonly InstallDirectoryHint[] = [
      { base: 'mac-applications', segments: ['Example App.app', 'Contents', 'MacOS'] },
    ];
    expect(expandInstallDirectories(hints, { platform: 'darwin', home: '/Users/person' })).toEqual([
      '/Users/person/Applications/Example App.app/Contents/MacOS',
      '/Applications/Example App.app/Contents/MacOS',
    ]);
    expect(expandInstallDirectories(hints, { platform: 'linux', home: '/home/person' })).toEqual([]);
    expect(expandInstallDirectories(hints, { platform: 'win32', home: 'C:\\Users\\person' })).toEqual([]);
  });
});
