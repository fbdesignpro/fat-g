// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { WebPreferences } from 'electron';

/** The one place renderer privileges are defined. Every window (Main, Pet) uses this. */
export function secureWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    // Electron's spellchecker downloads dictionaries from a Google CDN on Windows/Linux,
    // which would break the "no network calls" guarantee.
    spellcheck: false,
  };
}
