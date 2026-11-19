// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// When a window that was created hidden may be shown: once its page has painted — or, failing that,
// once its page has loaded. Electron's `ready-to-show` is the first; it is not certain to arrive.
//
// Seen on Windows 11 with Electron 44: a window with a hidden title bar and its overlay,
// created hidden directly on a display whose scaling differs from the primary display's, loads its
// page and never emits `ready-to-show`. fat-g waited for it, so the Main window never appeared, and
// the app ran on with nothing but the Pet on screen. Shown anyway, such a window paints at once.
// `createMainWindow` now avoids the case by how it places the window; this is the net under it, for
// whatever else keeps the event away. A window shown a moment early shows its background colour,
// which is the theme's.
//
// Electron-free: the window arrives as the few methods used here, so this runs under plain Vitest
// with a fake window and fake timers (ready.test.ts).

/** How long after its page has loaded a window is shown without having painted. */
export const SHOW_AFTER_LOAD_MS = 500;

export interface ShowableWindow {
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
  readonly webContents: {
    once(event: 'did-finish-load' | 'did-fail-load', listener: () => void): unknown;
  };
}

/**
 * Calls `show` once: at `ready-to-show`; or `delayMs` after the page has loaded; or at once when
 * the page fails to load, so that whatever went wrong is at least on screen. Never after the window
 * has closed.
 */
export function whenReadyToShow(window: ShowableWindow, show: () => void, delayMs = SHOW_AFTER_LOAD_MS): void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (): boolean => {
    if (done) return false;
    done = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    return true;
  };
  const run = (): void => {
    if (settle()) show();
  };
  window.once('ready-to-show', run);
  window.webContents.once('did-finish-load', () => {
    if (!done) timer = setTimeout(run, delayMs);
  });
  window.webContents.once('did-fail-load', run);
  window.once('closed', () => void settle());
}
