// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { builtInProviders } from '../providers';
import { discoverExecutable, resolveExecutable } from '../process/resolve-executable';
import { expandInstallDirectories } from './provider-installation';

describe('registered desktop CLI layouts', () => {
  // The last column: the runtime folders one resolution lists before it finds the executable.
  it.each([
    ['win32', 'codex', 'C:\\Local\\OpenAI\\Codex\\bin\\5449c1f0f26f1f98\\codex.exe', 1],
    // The root's own copy only once no build folder holds one.
    ['win32', 'codex', 'C:\\Local\\OpenAI\\Codex\\bin\\codex.exe', 1],
    ['win32', 'claude', 'C:\\Roaming\\Claude\\claude-code\\2.1.100\\claude.exe', 1],
    // The MSIX desktop app's data folder, outside its package: one build folder per version.
    ['win32', 'claude', 'C:\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude-code\\2.1.100\\9078b9c1d466\\claude.exe', 3],
    ['darwin', 'codex', '/Applications/Codex.app/Contents/Resources/codex', 0],
    ['darwin', 'codex', '/Users/test/Applications/ChatGPT.app/Contents/Resources/codex', 0],
    ['darwin', 'codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', 0],
    ['darwin', 'codex', '/Users/test/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', 0],
    ['darwin', 'claude', '/Users/test/Library/Application Support/Claude/claude-code/2.1.100/claude.app/Contents/MacOS/claude', 1],
    ['darwin', 'claude', '/Users/test/Library/Application Support/Claude/claude-code/2.1.100/9078b9c1d466/claude.app/Contents/MacOS/claude', 3],
  ])('discovers and resolves %s %s at %s using the registered hints', async (platform, id, executable, reads) => {
    const definition = builtInProviders('test').find((provider) => provider.descriptor.id === id)!;
    const windows = platform === 'win32';
    const request = {
      override: null, names: definition.executableNames, cwd: windows ? 'C:\\probe' : '/probe',
      knownDirs: expandInstallDirectories(definition.installDirectoryHints, {
        platform, home: windows ? 'C:\\Users\\test' : '/Users/test', appData: 'C:\\Roaming', localAppData: 'C:\\Local',
      }),
    };
    const options = {
      platform, env: {}, isExecutableFile: vi.fn((file: string) => Promise.resolve(file === executable)),
      readInstallChildren: vi.fn((_root: string, kind: 'version' | 'hash') => Promise.resolve([{ name: kind === 'version' ? '2.1.100' : id === 'claude' ? '9078b9c1d466' : '5449c1f0f26f1f98', modifiedAt: 1 }])),
    };
    expect(await discoverExecutable(request, options)).toEqual({ kind: 'present', overrideInvalid: false });
    expect(await resolveExecutable(request, options)).toEqual({ status: 'found', source: 'known-dir', executable: { path: executable, kind: 'native' } });
    expect(options.readInstallChildren.mock.calls.length).toBe(2 * reads);
  });
  it('keeps Linux on ordinary CLI paths and never searches desktop or configuration folders there', () => {
    for (const definition of builtInProviders('test')) {
      expect(expandInstallDirectories(definition.installDirectoryHints, { platform: 'linux', home: '/home/test' })).toEqual(['/home/test/.local/bin']);
    }
  });
});
