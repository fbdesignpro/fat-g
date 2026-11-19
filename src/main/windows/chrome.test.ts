// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { NATIVE_COLORS, THEMES } from '@shared/contracts/appearance';
import { mainWindowChrome, overlayFor, petWindowLevel, TITLE_BAR_HEIGHT, windowBackground } from './chrome';

describe('mainWindowChrome', () => {
  it.each([
    ['light', '#ffffff', '#000000'],
    ['dark', '#17191c', '#dde1e7'],
  ] as const)('draws its own title bar on Windows, over native buttons in the %s theme’s colours', (theme, color, symbolColor) => {
    expect(mainWindowChrome('win32', theme)).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color, symbolColor, height: TITLE_BAR_HEIGHT },
    });
  });

  it.each(THEMES)('keeps the traffic lights on macOS and turns on the title-bar area values (%s)', (theme) => {
    expect(mainWindowChrome('darwin', theme)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: true });
  });

  it.each([
    ['linux', 'light'],
    ['linux', 'dark'],
    ['freebsd', 'dark'],
  ] as const)('keeps the native frame on %s (%s)', (platform, theme) => {
    expect(mainWindowChrome(platform, theme)).toEqual({});
  });
});

describe('overlayFor — a theme change', () => {
  it.each(THEMES)('gives Windows the %s theme’s colours, the same as at creation', (theme) => {
    expect(overlayFor('win32', theme)).toEqual({ color: NATIVE_COLORS[theme].background, symbolColor: NATIVE_COLORS[theme].symbol, height: TITLE_BAR_HEIGHT });
    expect(mainWindowChrome('win32', theme).titleBarOverlay).toEqual(overlayFor('win32', theme));
  });

  it.each(['darwin', 'linux'] as const)('has nothing to change on %s', (platform) => {
    expect(overlayFor(platform, 'dark')).toBeNull();
  });
});

describe('windowBackground', () => {
  it.each(THEMES)('is the %s theme’s page background, on every platform', (theme) => {
    expect(windowBackground(theme)).toBe(NATIVE_COLORS[theme].background);
  });

  it('flips between the themes', () => {
    expect(windowBackground('light')).not.toBe(windowBackground('dark'));
  });
});

describe('petWindowLevel', () => {
  it('never uses a level Electron tucks behind the Windows taskbar, which leaves the Pet not on top', () => {
    const behindTheTaskbar = ['floating', 'torn-off-menu', 'modal-panel', 'main-menu', 'status'];
    expect(behindTheTaskbar).not.toContain(petWindowLevel('win32'));
  });

  it.each(['darwin', 'linux'] as const)('floats on %s', (platform) => {
    expect(petWindowLevel(platform)).toBe('floating');
  });
});
