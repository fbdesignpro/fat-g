// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { BrowserWindow } from 'electron';
import type { Theme } from '@shared/contracts/appearance';
import { pageUrl, type TrustedOrigins } from '../app/origins';
import type { Rect } from './bounds';
import { petWindowLevel, windowBackground } from './chrome';
import { secureWebPreferences } from './web-preferences';

export interface PetWindowOptions {
  readonly origins: TrustedOrigins;
  readonly preloadPath: string;
  /** Already fitted to the displays (fitBoundsToDisplays). */
  readonly bounds: Rect;
  /** The saved theme. The Pet never reads preferences: main hands it the theme (C9). */
  readonly theme: Theme;
}

/**
 * The Pet — the "mini window" in everything the user sees (decision 0010, item 0); "pet" in the
 * code, its window kind and its stored preference — a small status window that stays above the others. Frameless — the page's drag strip
 * moves it (src/renderer/src/PetApp.tsx) — with no taskbar button, and never able to minimize,
 * maximize or go fullscreen: a minimized window with no taskbar button has nowhere to come back from.
 *
 * Not shown here: the WindowManager shows it with `showInactive()` once it is ready — and only if it
 * is still wanted by then — so it never takes focus from whatever the user is doing.
 */
export function createPetWindow({ origins, preloadPath, bounds, theme }: PetWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...bounds,
    frame: false,
    // Without the thick frame the window is exactly the size asked for (see settleBounds for what
    // it does otherwise). It would only buy edge-resizing, a shadow and animations, none of which
    // a fixed square needs.
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: windowBackground(theme),
    webPreferences: secureWebPreferences(preloadPath),
  });
  // Not the `alwaysOnTop: true` option: that uses the 'floating' level, which on Windows is not
  // on top at all (see petWindowLevel). The manager also reapplies this after every show.
  window.setAlwaysOnTop(true, petWindowLevel(process.platform));
  // Created near the top of a 150% display, it opened up to 4 DIPs taller than asked, its page as
  // tall (548 for 544 at y 123); set to the same bounds once it exists, its page is the
  // size asked at every place tried.
  window.setBounds(bounds);
  // No settleBounds: without the thick frame the window is the size asked for, and at a half-pixel
  // place (an odd x at 150%) Electron reads it back a DIP wider than it is — so "correcting" by the
  // difference made it a device pixel narrower than its page, cutting the frame's right edge.
  // Chromium zooms every page of a host together, and the Pet shares the Main window's: kept
  // apart, a fixed square stays at 100% whatever the Main window's zoom (src/main/windows/zoom.ts).
  window.webContents.setZoomMode('isolated');
  window.webContents.setZoomLevel(0);

  const url = pageUrl(origins, 'pet.html', theme);
  window.loadURL(url).catch((error: unknown) => {
    console.error(`[pet-window] failed to load ${url}`, error);
  });

  return window;
}
