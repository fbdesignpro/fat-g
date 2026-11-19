// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../../ipc/client';
import { copyImage, copyImageFile } from './copy-image';

vi.mock('../../ipc/client', () => ({ invoke: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function clipboard() {
  const drawImage = vi.fn();
  const close = vi.fn();
  const dimensions: number[][] = [];
  const png = new Blob(['pixels'], { type: 'image/png' });
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve({ width: 600, height: 400, close })));
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(public width: number, public height: number) { dimensions.push([width, height]); }
    getContext() { return { drawImage }; }
    convertToBlob() { return Promise.resolve(png); }
  });
  class Item { constructor(readonly data: Record<string, Promise<Blob>>) {} }
  vi.stubGlobal('ClipboardItem', Item);
  const write = vi.fn(async (items: Item[]) => { await items[0]?.data['image/png']; });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
  return { write, drawImage, close, dimensions };
}

describe('copying a stored image', () => {
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const)('copies %s at natural size, without changing the pane view', async (mediaType) => {
    const test = clipboard();
    vi.mocked(invoke).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mediaType });
    const pending = copyImage('a'.repeat(64));
    expect(test.write).toHaveBeenCalledTimes(1);
    await pending;
    expect(invoke).toHaveBeenLastCalledWith('attachments:readForCopy', { hash: 'a'.repeat(64) });
    expect(test.dimensions).toEqual([[600, 400]]);
    expect(test.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0);
    expect(test.close).toHaveBeenCalledTimes(1);
  });

  it('fails when the stored image is unavailable', async () => {
    const test = clipboard();
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(copyImage('a'.repeat(64))).rejects.toThrow('image unavailable');
    expect(test.drawImage).not.toHaveBeenCalled();
  });

  it('handles a refused clipboard even when the image read later fails', async () => {
    const test = clipboard();
    test.write.mockRejectedValue(new Error('clipboard refused'));
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(copyImage('a'.repeat(64))).rejects.toThrow('clipboard refused');
  });
});

describe('copying an image file (decision 0022, item 15)', () => {
  it('asks main for its bytes by the id it gave the file, and copies them as a PNG', async () => {
    const test = clipboard();
    vi.mocked(invoke).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp' });
    await copyImageFile('s', 'b'.repeat(32));
    expect(invoke).toHaveBeenLastCalledWith('files:readImageForCopy', { sessionId: 's', id: 'b'.repeat(32) });
    expect(test.drawImage).toHaveBeenCalledTimes(1);
  });

  it('fails when main serves the id nothing', async () => {
    const test = clipboard();
    vi.mocked(invoke).mockResolvedValue(null);
    await expect(copyImageFile('s', 'b'.repeat(32))).rejects.toThrow('image unavailable');
    expect(test.drawImage).not.toHaveBeenCalled();
  });
});
