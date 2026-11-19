// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6, V12 (docs/planning/_archive/M23.md; C30): the stream form's message with two images — the fixture's own
// synthetic images, written into fat-g's folder and named in the store through the staging and the
// acceptance a pasted image goes through, last in the session's conversation, and drawn from there.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { createBlobFiles, sha256 } from '../attachments/files';
import { type Scratch, scratch } from '../conversations/test-support';
import { fillImages, STREAM_IMAGE_ANSWER, STREAM_IMAGE_FILES, STREAM_IMAGE_PROMPT, STREAM_SESSION } from './demo-stream';

const FIXTURES = path.resolve(import.meta.dirname, '../../../tests/fixtures/attachments');
let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

describe('the stream form’s images (V6; C30)', () => {
  it('are the fixture’s two synthetic images, each a PNG fat-g takes', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual([...STREAM_IMAGE_FILES].sort());
  });

  it('write the fixture’s message with both images, last in the conversation, through the staging rows and the folder', async () => {
    const store = area.open();
    store.ensure(STREAM_SESSION, 1);
    store.acceptPrompt({ conversationId: STREAM_SESSION, turnId: 'earlier', itemId: 'earlier-prompt', text: 'An earlier turn', at: 2, started: true });
    const blobs = createBlobFiles(path.join(area.dir, ATTACHMENTS_FOLDER));
    const images = STREAM_IMAGE_FILES.map((name) => ({ name, bytes: new Uint8Array(readFileSync(path.join(FIXTURES, name))) }));
    expect(await fillImages(store, blobs, images, 2_000)).toBe(2);
    const items = store.newestPage(STREAM_SESSION).items;
    const prompt = items.find((item) => item.id === 'fixture-images-prompt');
    expect(prompt?.blocks[0]?.text).toBe(STREAM_IMAGE_PROMPT);
    expect(prompt?.attachments?.map((entry) => [entry.name, entry.available, entry.hash])).toEqual(images.map((image) => [image.name, true, sha256(image.bytes)]));
    expect(items.at(-1)?.blocks[0]?.text).toBe(STREAM_IMAGE_ANSWER);
    expect(items.at(-1)?.order.turn).toBeGreaterThan(items.find((item) => item.id === 'earlier-prompt')?.order.turn ?? 0);
    for (const image of images) expect(existsSync(path.join(area.dir, ATTACHMENTS_FOLDER, `${sha256(image.bytes)}.png`))).toBe(true);
    // Nothing of the draft is left: the images are the prompt's.
    expect(store.draft(STREAM_SESSION)?.attachments).toEqual([]);
  });

  it('write nothing where no image was read, or one is no image fat-g takes', async () => {
    const store = area.open();
    const blobs = createBlobFiles(path.join(area.dir, ATTACHMENTS_FOLDER));
    expect(await fillImages(store, blobs, [], 2_000)).toBe(0);
    expect(await fillImages(store, blobs, [{ name: 'notes.txt', bytes: new Uint8Array([104, 105]) }], 2_000)).toBe(0);
    expect(existsSync(path.join(area.dir, ATTACHMENTS_FOLDER))).toBe(false);
  });
});
