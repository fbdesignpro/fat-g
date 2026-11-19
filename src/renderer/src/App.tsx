// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { SmokeProbe } from './diagnostics/SmokeProbe';
import { ProjectDialog } from './projects/ProjectDialog';
import { QuitConfirm } from './QuitConfirm';
import { SessionAnnouncer } from './sessions/SessionAnnouncer';
import { SandboxSetupDialog } from './settings/SandboxSetupDialog';
import { SettingsDialog } from './settings/SettingsDialog';
import { Shell } from './shell/Shell';
import { Announcer } from './ui/Announcer';
import { ProviderDiscoveryDialog } from './provider-discovery/ProviderDiscoveryDialog';

// The Main window: the page grid with its regions (src/renderer/src/shell), and the Settings and
// project dialogs over it. The OS draws the window buttons over the grid's title strip
// (src/main/windows/chrome.ts). The announcer is the one polite live region (M12, C72), which the
// session announcer speaks through (M14, C52); the quit confirmation is main's question before a quit
// that would stop a running session (M14, C76). The sandbox setup's dialog is opened from a Set up
// control, in the session's header or in place of the chat's input (M22, C60).
export function App() {
  return (
    <>
      <Shell />
      <SettingsDialog />
      <ProjectDialog />
      <SandboxSetupDialog />
      <QuitConfirm />
      <ProviderDiscoveryDialog />
      <Announcer />
      <SessionAnnouncer />
      <SmokeProbe page="main" />
    </>
  );
}
