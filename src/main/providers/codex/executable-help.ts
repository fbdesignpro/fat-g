// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ExecutableHelp } from '@shared/contracts/provider';

/** Display examples only. Actual discovery remains in descriptor.ts's installation hints. */
export const CODEX_EXECUTABLE_HELP: ExecutableHelp = {
  command: 'codex',
  locations: {
    win32: {
      folders: ['%USERPROFILE%\\.local\\bin', '%APPDATA%\\npm', '%LOCALAPPDATA%\\OpenAI\\Codex\\bin'],
      note: 'In the desktop app’s bin folder, the newest build subfolder holds its current codex.exe; the copy directly in bin can be older. Automatic detection uses the newest version it finds.',
    },
    darwin: {
      folders: ['~/.local/bin', '/Applications/Codex.app/Contents/Resources', '/Applications/ChatGPT.app/Contents/Resources', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS'],
      note: 'If you installed the app for your user only, also check the same app under ~/Applications.',
    },
    linux: { folders: ['~/.local/bin', '/usr/local/bin', '/usr/bin'] },
  },
};
