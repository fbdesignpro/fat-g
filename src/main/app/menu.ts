// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The application menu. macOS shows it in the system menu bar, including when no window is open.
// Its shortcuts also work on Windows and Linux, where the windows have no menu bar.
// Electron's default list does not fit this app:
//   • its Ctrl+M minimizes the focused window, and a minimized Pet has no taskbar button to come
//     back from;
//   • it ships reload and DevTools in packaged builds.
//   • its zoom steps by Electron's half levels (91%, 110%, 120% …), in whichever window has the
//     focus, and tells no one; fat-g's zoom has steps of its own and shows itself (src/main/windows/zoom.ts).
// Pure — Electron types only — so the rules are a test (menu.test.ts). Installed in src/main/index.ts.
import type { MenuItemConstructorOptions } from 'electron';
import type { ZoomChange } from '@shared/contracts/zoom';

export interface MenuOptions {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  /** Changes the Main window's zoom, whichever window has the focus. */
  readonly zoom: (to: ZoomChange) => void;
  /** Opens or focuses the Main window from the macOS menu. */
  readonly showMain: () => void;
}

/** The keys the zoom roles had, so nothing a hand knows changes. */
export const ZOOM_KEYS: Readonly<Record<ZoomChange, string>> = {
  reset: 'CommandOrControl+0',
  in: 'CommandOrControl+Plus',
  out: 'CommandOrControl+-',
};

const developerItems: MenuItemConstructorOptions[] = [
  { type: 'separator' },
  { role: 'reload' },
  { role: 'forceReload' },
  { role: 'toggleDevTools' },
];

export function applicationMenuTemplate({ platform, isPackaged, zoom, showMain }: MenuOptions): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      // Zoom is an accessibility feature, not a developer one: it stays in every build.
      { label: 'Actual Size', accelerator: ZOOM_KEYS.reset, click: () => zoom('reset') },
      { label: 'Zoom In', accelerator: ZOOM_KEYS.in, click: () => zoom('in') },
      { label: 'Zoom Out', accelerator: ZOOM_KEYS.out, click: () => zoom('out') },
      ...(isPackaged ? [] : developerItems),
    ],
  };
  // On macOS, Cmd+C / Cmd+V reach the page only through an Edit menu — and DOM copy/paste is a core
  // requirement (AGENTS.md). Windows and Linux handle editing keys without one.
  return platform === 'darwin' ? [{ role: 'appMenu' }, { role: 'editMenu' }, view, {
    label: 'Window',
    submenu: [{ label: 'Show Main Window', accelerator: 'Command+1', click: () => showMain() }],
  }] : [view];
}
