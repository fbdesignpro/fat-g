// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The words of the Main window's zoom: the title strip's indicator and its tooltip, and the
// Appearance tab's row. The keys are the View menu's (src/main/app/menu.ts), Cmd on macOS.

export interface ZoomKey {
  readonly keys: string;
  readonly what: string;
}

export const ZOOM_WORDS = {
  /** The indicator's name: what it shows, and what a press does. */
  indicator: (percent: number) => `Zoom ${percent}%, back to 100%`,
  click: 'Click for 100%',
  legend: 'Zoom',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  reset: 'Reset',
} as const;

/** The keys that zoom, for the platform's modifier. Chromium zooms with the wheel everywhere but macOS. */
export function zoomKeys(platform: string): readonly ZoomKey[] {
  const mod = platform === 'darwin' ? 'Cmd' : 'Ctrl';
  return [
    { keys: `${mod}+=`, what: 'Zoom in' },
    { keys: `${mod}+-`, what: 'Zoom out' },
    { keys: `${mod}+0`, what: 'Back to 100%' },
    ...(platform === 'darwin' ? [] : [{ keys: `${mod}+wheel`, what: 'Zoom in or out' }]),
  ];
}
