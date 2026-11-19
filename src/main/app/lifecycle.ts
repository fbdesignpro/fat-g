// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// How the app answers a second launch, and how it quits without losing anything.
//
// The order of Electron's quit events is the point of this file:
//   the last window is closed:        close → closed → window-all-closed → before-quit → will-quit
//   app.quit() (Cmd+Q, M8's tray):    before-quit → close → closed → will-quit
// Windows hand over their final position as they close (src/main/windows/bounds-tracker.ts), so
// only `will-quit` is sure to come after all of that — which is why the last write happens there.
// Neither event fires on Windows logoff or shutdown; each window's `session-end` covers that
// (src/main/windows/window-manager.ts).
//
// While a session runs, a quit is questioned first (M14, C76): the quit gate (quit-gate.ts) stands
// at the Main window's `close` and at `before-quit`, so the question comes before any window closes
// on either path. A logoff skips it, and the running records keep their missing end (C74).
import { app } from 'electron';
import type { PreferencesStore } from '../prefs/store';
import type { WindowManager } from '../windows/window-manager';
import type { QuitGate } from './quit-gate';
import type { createShutdown } from './shutdown';

export interface LifecycleDeps {
  readonly windows: WindowManager;
  readonly prefs: PreferencesStore;
  readonly shutdown: ReturnType<typeof createShutdown>;
  readonly gate: Pick<QuitGate, 'beforeQuit'>;
  /** The conversation store: closed here if the quit's drain did not close it (M18, C45). */
  readonly conversations?: { close(): void };
}

/** Call once the app is ready: most of these handlers may open a window. */
export function installLifecycle({ windows, prefs, shutdown, gate, conversations }: LifecycleDeps): void {
  // Someone launched the app again. This instance holds the lock (src/main/index.ts), so the other
  // one has already quit; bring this one forward instead.
  app.on('second-instance', () => { if (!shutdown.quitting) windows.showMain(); });
  app.on('activate', () => { if (!shutdown.quitting) windows.showMain(); }); // macOS dock click
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // The gate first: while a session runs and the quit is not confirmed it prevents the event, asks,
  // and nothing of the shutdown starts (M14, C99).
  app.on('before-quit', (event) => {
    if (gate.beforeQuit(event)) shutdown.beforeQuit(event);
  });
  app.on('will-quit', () => {
    windows.flushPlacements();
    // The event loop stops right after this, so the last write cannot be a promise.
    prefs.flushSync();
    // Synchronous, and safe to call twice: the drain's last step closes it first on a normal quit.
    conversations?.close();
  });
}
