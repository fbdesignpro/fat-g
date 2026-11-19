// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Window chrome — what the OS draws around the page — and the other per-platform window choices.
// Pure (Electron types only), so each choice is a table test (chrome.test.ts).
import type { BrowserWindow, BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron';
import { NATIVE_COLORS, type Theme } from '@shared/contracts/appearance';

/** Keep in sync with --title-bar-height in tokens.css (the page's fallback when there is no overlay). */
export const TITLE_BAR_HEIGHT = 40;

export type MainWindowChrome = Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'>;

/** Painted before the page's first frame, and behind it: the theme's --color-chrome (appearance.ts). */
export function windowBackground(theme: Theme): string {
  return NATIVE_COLORS[theme].background;
}

/**
 * The Main window draws its own title bar (src/renderer/src/shell/TitleStrip.tsx) while the OS keeps
 * drawing the window buttons over it — native minimize/maximize/close, Windows 11 snap layouts,
 * macOS traffic lights — so nothing has to be re-implemented per OS. The page learns where the
 * buttons are from the CSS `titlebar-area-*` env() values the overlay provides.
 *
 * Linux keeps its native frame. Electron supports the overlay there, but it is untested here
 * (Wayland especially), and a hidden title bar whose overlay failed would leave a window with no
 * controls at all. Turning it on is one line below.
 */
export function mainWindowChrome(platform: NodeJS.Platform, theme: Theme): MainWindowChrome {
  const overlay = overlayFor(platform, theme);
  if (overlay !== null) return { titleBarStyle: 'hidden', titleBarOverlay: overlay };
  // The colours are ignored on macOS; `true` is what turns on the env() values.
  if (platform === 'darwin') return { titleBarStyle: 'hidden', titleBarOverlay: true };
  return {};
}

/**
 * What to pass to `setTitleBarOverlay` when the theme or focus changes: the colours on Windows, and
 * nothing elsewhere — macOS draws its traffic lights in its own colours, Linux keeps its frame.
 */
export function overlayFor(platform: NodeJS.Platform, theme: Theme, focused = true): TitleBarOverlay | null {
  if (platform !== 'win32') return null;
  const colors = NATIVE_COLORS[theme];
  return { color: colors.background, symbolColor: focused ? colors.symbol : colors.inactiveSymbol, height: TITLE_BAR_HEIGHT };
}

export type AlwaysOnTopLevel = NonNullable<Parameters<BrowserWindow['setAlwaysOnTop']>[1]>;

/**
 * The level that keeps the Pet above other windows. On macOS that is 'floating'. On Windows,
 * Electron slides a window at 'floating' — the level `alwaysOnTop: true` uses — or at one of the
 * other panel levels in just behind the taskbar instead, and on current Windows 11 that leaves it
 * not topmost at all: measured with Electron 44 on build 26200, the window never gets
 * WS_EX_TOPMOST and isAlwaysOnTop() answers false. Any other level is plain topmost there.
 */
export function petWindowLevel(platform: NodeJS.Platform): AlwaysOnTopLevel {
  return platform === 'win32' ? 'pop-up-menu' : 'floating';
}
