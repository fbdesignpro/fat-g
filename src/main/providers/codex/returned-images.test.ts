// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_BASE64 } from '@shared/contracts/returned-images';
import { readHistoryPage } from './history';
import { takeItemFrame } from './session-schemas';
import { takeReturnedImage } from './returned-images';

const image = { type: 'imageGeneration', id: 'image-1', status: 'completed', result: 'aGVsbG8=', savedPath: 'C:\\private\\.codex\\generated_images\\image.png', revisedPrompt: 'A blue star' };

describe('Codex returned images', () => {
  it('extracts inline bytes only from completed generation, without exposing saved paths or raw result in tool output', () => {
    expect(takeReturnedImage(image)).toEqual({ kind: 'base64', data: image.result });
    const frame = takeItemFrame({ threadId: 'thread', turnId: 'turn', item: image }, false);
    expect(frame?.image).toEqual({ kind: 'base64', data: image.result });
    expect(JSON.stringify(frame?.activity)).not.toContain(image.result);
    expect(JSON.stringify(frame)).not.toContain(image.savedPath);
    expect(takeItemFrame({ threadId: 'thread', turnId: 'turn', item: image }, true)?.image).toBeUndefined();
  });

  it('returns an explicit failure for empty, failed, uncompleted or oversized payloads', () => {
    expect(takeReturnedImage({ ...image, result: '' })).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(takeReturnedImage({ ...image, status: 'failed' })).toEqual({ kind: 'unavailable', reason: 'failed' });
    expect(takeReturnedImage({ ...image, status: 'generating' })).toEqual({ kind: 'unavailable', reason: 'missing' });
    expect(takeReturnedImage({ ...image, result: 'A'.repeat(MAX_IMAGE_BASE64 + 1) })).toEqual({ kind: 'unavailable', reason: 'too-large' });
  });

  it('returns images from existing CLI history without regenerating them, and reads none for listings', async () => {
    const calls: string[] = [];
    const connection = {
      ready: () => true, droppedLines: () => 0, onDropped: () => () => undefined,
      ask: (method: string) => { calls.push(method); return Promise.resolve({ data: [{ id: 'turn', status: 'completed', items: [image] }], nextCursor: null }); },
    };
    const full = await readHistoryPage(connection, 'thread', { size: 1, cursor: null, detail: 'full' }, new AbortController().signal);
    expect(full).toMatchObject({ kind: 'page', images: [{ turnId: 'turn', itemId: 'image-1', image: { kind: 'base64', data: image.result } }], activities: [{ name: 'imageGeneration' }] });
    const listing = await readHistoryPage(connection, 'thread', { size: 1, cursor: null, detail: 'none' }, new AbortController().signal);
    expect(listing).not.toHaveProperty('images');
    expect(calls).toEqual(['thread/turns/list', 'thread/turns/list']);
  });
});
