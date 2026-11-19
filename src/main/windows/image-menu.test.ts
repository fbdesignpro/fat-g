// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachImageMenu } from './image-menu';

const { build, popup } = vi.hoisted(() => ({ build: vi.fn(), popup: vi.fn() }));
vi.mock('electron', () => ({ Menu: { buildFromTemplate: build } }));

const origins = { renderer: 'app://fatg', devServer: undefined };
const image = { pageURL: 'app://fatg/index.html', mediaType: 'image', hasImageContents: true, srcURL: `app://media/attachments/${'a'.repeat(64)}`, x: 45, y: 80 };

function setup() {
  const on = vi.fn();
  const copyImageAt = vi.fn();
  const isDestroyed = vi.fn(() => false);
  const window = { webContents: { on, copyImageAt, isDestroyed } } as unknown as BrowserWindow;
  attachImageMenu(window, origins);
  const open = (params = image) => (on.mock.calls[0]?.[1] as (event: unknown, params: ContextMenuParams) => void)({}, params as ContextMenuParams);
  return { window, open, copyImageAt, isDestroyed };
}

beforeEach(() => {
  vi.clearAllMocks();
  build.mockReturnValue({ popup });
});

describe('attachment image context menu', () => {
  it('copies the displayed image only when Copy image is chosen', () => {
    const test = setup();
    test.open();
    expect(popup).toHaveBeenCalledWith({ window: test.window });
    expect(test.copyImageAt).not.toHaveBeenCalled();
    const items = build.mock.calls[0]?.[0] as MenuItemConstructorOptions[];
    expect(items.map((item) => item.label)).toEqual(['Copy image']);
    (items[0]?.click as () => void)();
    expect(test.copyImageAt).toHaveBeenCalledWith(45, 80);
    test.isDestroyed.mockReturnValue(true);
    (items[0]?.click as () => void)();
    expect(test.copyImageAt).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mediaType: 'none' }, { hasImageContents: false }, { pageURL: 'https://example.com/' },
    { srcURL: 'file:///private.png' }, { srcURL: 'https://example.com/image.png' },
    { srcURL: `app://media/avatars/${'a'.repeat(64)}` },
    { srcURL: 'app://media/attachments/not-a-hash' },
    { srcURL: `${image.srcURL}?other=1` }, { srcURL: 'invalid' },
  ])('leaves other content and unavailable images alone: %j', (overrides) => {
    const test = setup();
    test.open({ ...image, ...overrides });
    expect(build).not.toHaveBeenCalled();
    expect(test.copyImageAt).not.toHaveBeenCalled();
  });
});
