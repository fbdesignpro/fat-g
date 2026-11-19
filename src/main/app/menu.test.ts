// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { applicationMenuTemplate as template, type MenuOptions, ZOOM_KEYS } from './menu';

const applicationMenuTemplate = (options: Pick<MenuOptions, 'platform' | 'isPackaged'> & Partial<MenuOptions>) => template({ zoom: () => undefined, showMain: () => undefined, ...options });

/** Every item in the template, submenus included. */
function items(list: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return list.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

/** Every role in the template, submenus included. */
function roles(items: readonly MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.role === undefined ? [] : [item.role]),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : []),
  ]);
}

const PLATFORMS = ['win32', 'darwin', 'linux'] as const;

describe('applicationMenuTemplate', () => {
  it.each(PLATFORMS)('never offers a shortcut that could strand or hide a window (%s)', (platform) => {
    for (const isPackaged of [true, false]) {
      const found = roles(applicationMenuTemplate({ platform, isPackaged }));
      for (const role of ['minimize', 'close', 'togglefullscreen', 'windowMenu', 'zoom', 'viewMenu', 'fileMenu']) {
        expect(found).not.toContain(role);
      }
    }
  });

  it.each(PLATFORMS)('keeps zoom in every build, on the keys the roles had, as fat-g’s own steps (%s)', (platform) => {
    for (const isPackaged of [true, false]) {
      const zoom = vi.fn();
      const found = items(applicationMenuTemplate({ platform, isPackaged, zoom }));
      for (const role of ['resetZoom', 'zoomIn', 'zoomOut']) expect(roles(found)).not.toContain(role);
      for (const [to, accelerator] of Object.entries(ZOOM_KEYS)) {
        const item = found.find((each) => each.accelerator === accelerator);
        expect(item?.role).toBeUndefined();
        (item?.click as () => void)();
        expect(zoom).toHaveBeenLastCalledWith(to);
      }
    }
    expect(Object.values(ZOOM_KEYS)).toEqual(['CommandOrControl+0', 'CommandOrControl+Plus', 'CommandOrControl+-']);
  });

  it.each(PLATFORMS)('offers reload and DevTools only in development (%s)', (platform) => {
    const developer = ['reload', 'forceReload', 'toggleDevTools'];
    expect(roles(applicationMenuTemplate({ platform, isPackaged: false }))).toEqual(expect.arrayContaining(developer));
    const packaged = roles(applicationMenuTemplate({ platform, isPackaged: true }));
    for (const role of developer) expect(packaged).not.toContain(role);
  });

  it('gives macOS its app and Edit menus and a way to open Main with no focused window', () => {
    const showMain = vi.fn();
    const menu = applicationMenuTemplate({ platform: 'darwin', isPackaged: true, showMain });
    expect(roles(menu)).toEqual(expect.arrayContaining(['appMenu', 'editMenu']));
    const window = menu.find((item) => item.label === 'Window');
    const show = Array.isArray(window?.submenu) ? window.submenu.find((item) => item.label === 'Show Main Window') : undefined;
    expect(show?.accelerator).toBe('Command+1');
    (show?.click as () => void)();
    expect(showMain).toHaveBeenCalledOnce();
  });

  it.each(['win32', 'linux'] as const)('adds no Edit menu on %s, where editing keys work without one', (platform) => {
    expect(roles(applicationMenuTemplate({ platform, isPackaged: true }))).not.toContain('editMenu');
  });
});
