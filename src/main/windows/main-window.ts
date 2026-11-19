// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { BrowserWindow } from 'electron';
import type { Theme } from '@shared/contracts/appearance';
import { pageUrl, type TrustedOrigins } from '../app/origins';
import { type Rect, settleBounds } from './bounds';
import { appIconPath } from './app-icon';
import { mainWindowChrome, windowBackground } from './chrome';
import { attachImageMenu } from './image-menu';
import { MAIN_PLACEMENT } from './placement';
import { whenReadyToShow } from './ready';
import { secureWebPreferences } from './web-preferences';

export interface MainWindowOptions {
  readonly origins: TrustedOrigins;
  readonly preloadPath: string;
  /** Already fitted to the displays (fitBoundsToDisplays): the normal, un-maximized bounds. */
  readonly bounds: Rect;
  readonly maximized: boolean;
  /** The saved theme: the frame painted before the page loads already matches it. */
  readonly theme: Theme;
}

export function createMainWindow({ origins, preloadPath, bounds, maximized, theme }: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    // Its size only: it is given its place just below, once it exists.
    width: bounds.width,
    height: bounds.height,
    minWidth: MAIN_PLACEMENT.minSize.width,
    minHeight: MAIN_PLACEMENT.minSize.height,
    show: false,
    icon: appIconPath,
    // No flash of the wrong colour before first paint.
    backgroundColor: windowBackground(theme),
    // Only matters where the native frame stays (Linux): no menu bar unless Alt is pressed.
    autoHideMenuBar: true,
    ...mainWindowChrome(process.platform, theme),
    webPreferences: secureWebPreferences(preloadPath),
  });
  // Created on the primary display, then moved to where it belongs, then settled there.
  //
  // Not created in place: a window with this hidden title bar, created hidden directly on a display
  // whose scaling differs from the primary display's, loads its page and never emits
  // `ready-to-show`, so it was never shown (Windows 11, Electron 44, primary at 150 % and the second
  // display at 100 %; see ready.ts). Moved there after it exists, it paints and reports as usual.
  //
  // Moved first and settled second, so the settling happens at the scaling of the display it ends
  // on: its thick frame — what makes the edges resizable without an OS title bar — would otherwise
  // make it a little larger on every launch (see settleBounds).
  window.setBounds(bounds);
  settleBounds(window, bounds);

  whenReadyToShow(window, () => {
    if (window.isDestroyed()) return;
    // Created at its normal bounds, so un-maximizing later returns there.
    if (maximized) window.maximize();
    window.show();
  });

  attachImageMenu(window, origins);
  const url = pageUrl(origins, 'index.html', theme);
  window.loadURL(url).catch((error: unknown) => {
    console.error(`[main-window] failed to load ${url}`, error);
  });

  return window;
}
