// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ExecutableHelp } from '@shared/contracts/provider';

/** Display examples only. Actual discovery remains in descriptor.ts's installation hints. */
export const CLAUDE_EXECUTABLE_HELP: ExecutableHelp = {
  command: 'claude',
  locations: {
    win32: {
      folders: ['%USERPROFILE%\\.local\\bin', '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links', '%LOCALAPPDATA%\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude-code', '%APPDATA%\\Claude\\claude-code'],
      note: 'In a desktop runtime folder, open a version subfolder (then, under Claude-Data, its one build subfolder) and choose claude.exe. Automatic detection uses the newest version it finds.',
    },
    darwin: {
      folders: ['~/.local/bin', '~/Library/Application Support/Claude/claude-code'],
      note: 'In the desktop runtime folder, open a version subfolder and its build subfolder if present. Open claude.app/Contents/MacOS and choose claude.',
    },
    linux: { folders: ['~/.local/bin', '/usr/local/bin', '/usr/bin'] },
  },
};
