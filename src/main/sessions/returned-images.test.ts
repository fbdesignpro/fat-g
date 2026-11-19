// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlobFiles, sha256 } from '../attachments/files';
import { CONVERSATION, type Scratch, scratch } from '../conversations/test-support';
import { gifBytes, pngBytes } from '../images/test-support';
import { createAttachmentSource } from '../media/attachments';
import { bridge } from './bridge';
import { checkHistory } from './history-check';
import { createReturnedImages, type ImageReturned } from './returned-images';

const areas: Scratch[] = [];
afterEach(() => { for (const area of areas.splice(0)) area.dispose(); });
const PNG = pngBytes(64, 32);
const encoded = Buffer.from(PNG).toString('base64');
const event = (itemId = 'generation-1', image: ImageReturned['image'] = { kind: 'base64', data: encoded }): ImageReturned => ({ type: 'image-returned', turnId: 't1', itemId, image });
function setup() {
  const area = scratch(); areas.push(area);
  const blobs = createBlobFiles(path.join(area.dir, 'attachments'));
  const store = area.open({ blobs });
  store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't1', itemId: 'p1', text: 'Create an image', at: 1, started: false });
  let alive = true;
  const changed = vi.fn();
  const receiver = createReturnedImages({ store, blobs, alive: () => alive, changed, now: () => 2 });
  return { area, store, blobs, receiver, changed, leave: () => { alive = false; } };
}

describe('returned images', () => {
  it('marks an old completed generation as needing history until its returned image is retained', async () => {
    const h = setup();
    h.store.providerTook(CONVERSATION, 't1', 'provider-turn');
    h.store.addActivity(CONVERSATION, 't1', { id: 'activity', origin: 'local', providerItemId: 'generation-1', workerId: null, start: { type: 'other', name: 'imageGeneration', summary: '' }, receivedAt: 1, providerAt: null });
    h.store.endActivity(CONVERSATION, 't1', { providerItemId: 'generation-1', workerId: null }, { status: 'completed' });
    expect(h.store.held(CONVERSATION).byProviderTurnId('provider-turn')?.gap).toBe(true);
    await h.receiver.receive(CONVERSATION, event());
    expect(h.store.held(CONVERSATION).byProviderTurnId('provider-turn')?.gap).toBe(false);
  });

  it('recovers a previously dropped result through the ordinary history walk and then reads no image again', async () => {
    const h = setup();
    h.store.providerTook(CONVERSATION, 't1', 'provider-turn');
    h.store.providerEnded(CONVERSATION, 't1', 'completed', 2);
    h.store.addActivity(CONVERSATION, 't1', { id: 'activity', origin: 'local', providerItemId: 'generation-1', workerId: null, start: { type: 'other', name: 'imageGeneration', summary: '' }, receivedAt: 1, providerAt: null });
    h.store.endActivity(CONVERSATION, 't1', { providerItemId: 'generation-1', workerId: null }, { status: 'completed' });
    const asked: string[] = [];
    const check = () => checkHistory((page) => {
      asked.push(page.detail);
      return Promise.resolve({ kind: 'page', turns: [{ turnId: 'provider-turn', outcome: 'completed', startedAt: 1, endedAt: 2, durationMs: 1 }], messages: [], ...(page.detail === 'full' ? { images: [{ turnId: 'provider-turn', itemId: 'generation-1', image: event().image }] } : {}), next: null });
    }, {
      held: () => h.store.held(CONVERSATION),
      merge: (plans, anchor) => h.store.mergePage(CONVERSATION, plans, anchor, 'Unavailable').anchor,
      mark: (ids, start) => h.store.markReached(CONVERSATION, ids, start),
      images: async (images) => {
        for (const image of images) {
          const turn = h.store.held(CONVERSATION).byProviderTurnId(image.turnId);
          if (turn !== null) await h.receiver.receive(CONVERSATION, { ...event(image.itemId, image.image), turnId: turn.id });
        }
      },
    }, new AbortController().signal);
    expect(await check()).toMatchObject({ state: 'checked' });
    expect(asked).toEqual(['none', 'full']);
    expect(h.store.newestPage(CONVERSATION).items.filter((item) => item.attachments?.length)).toHaveLength(1);
    asked.length = 0;
    expect(await check()).toMatchObject({ state: 'checked' });
    expect(asked).toEqual(['none']);
  });

  it('keeps a worker image under that worker while sharing the blob safely', async () => {
    const h = setup();
    await h.receiver.receive(CONVERSATION, { ...event(), workerId: 'worker' });
    expect(h.store.newestPage(CONVERSATION).items.filter((item) => item.attachments?.length)).toHaveLength(0);
    expect(h.store.workerItems(CONVERSATION, 'worker')?.items[0]?.attachments).toHaveLength(1);
  });

  it('retains one verified blob, publishes its message, reopens it and removes it with its conversation', async () => {
    const h = setup();
    await h.receiver.receive(CONVERSATION, event());
    const items = h.store.newestPage(CONVERSATION).items;
    const image = items.find((item) => item.providerItemId === 'image:generation-1');
    expect(image).toMatchObject({ kind: 'message', role: 'assistant', attachments: [{ hash: sha256(PNG), available: true, name: 'Generated image', width: 64, height: 32 }] });
    expect(h.changed).toHaveBeenCalledWith(CONVERSATION);
    const source = createAttachmentSource({ image: (hash) => h.store.blob(hash), read: (hash, type, size) => h.blobs.read(hash, type, size) });
    expect(await source.serve(sha256(PNG))).toMatchObject({ status: 200, body: new Uint8Array(PNG) });
    h.store.close();
    const reopened = h.area.open({ blobs: h.blobs });
    expect(reopened.newestPage(CONVERSATION).items.find((item) => item.id === image?.id)?.attachments).toHaveLength(1);
    reopened.markRemoving([CONVERSATION]); reopened.deleteRemoving([CONVERSATION]);
    expect(existsSync(h.blobs.pathOf(sha256(PNG), 'image/png'))).toBe(false);
  });

  it('deduplicates repeated completions and keeps distinct generations sharing the same bytes', async () => {
    const h = setup();
    await Promise.all([h.receiver.receive(CONVERSATION, event()), h.receiver.receive(CONVERSATION, event())]);
    await h.receiver.receive(CONVERSATION, event());
    await h.receiver.receive(CONVERSATION, event('generation-2'));
    expect(h.store.newestPage(CONVERSATION).items.filter((item) => item.attachments?.length)).toHaveLength(2);
    expect(h.blobs.measure()).toEqual({ count: 1, bytes: PNG.length });
  });

  it('reserves its position before later assistant text while bytes are being written', async () => {
    const h = setup();
    let finish: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const receiver = createReturnedImages({ store: h.store, blobs: { ...h.blobs, write: async (...args) => { await wait; await h.blobs.write(...args); } }, alive: () => true, changed: h.changed });
    const pending = receiver.receive(CONVERSATION, event());
    h.store.addItem(CONVERSATION, 't1', { id: 'answer', providerItemId: 'answer', kind: 'message', origin: 'local', role: 'assistant', phase: 'final', text: 'Here it is.', cut: false, questions: [], notice: null, detail: null, receivedAt: 3, providerAt: null });
    finish?.(); await pending;
    expect(h.store.newestPage(CONVERSATION).items.map((item) => item.providerItemId)).toEqual([null, 'image:generation-1', 'answer']);
  });

  it.each([
    [{ kind: 'base64', data: 'AAAA=bad' }, 'invalid'],
    [{ kind: 'base64', data: 'AB==' }, 'invalid'],
    [{ kind: 'base64', data: Buffer.from('<svg/>').toString('base64') }, 'not supported'],
    [{ kind: 'base64', data: Buffer.from(gifBytes(8000, 8000)).toString('base64') }, 'preview limit'],
    [{ kind: 'unavailable', reason: 'failed' }, 'generation failed'],
    [{ kind: 'unavailable', reason: 'missing' }, 'no image bytes'],
  ] as const)('shows an explicit fallback without saving invalid/unavailable bytes', async (image, words) => {
    const h = setup();
    await h.receiver.receive(CONVERSATION, event('bad', image));
    const notice = h.store.newestPage(CONVERSATION).items.at(-1);
    expect(notice?.kind).toBe('notice');
    expect(notice?.blocks[0]?.text).toContain(words);
    expect(h.blobs.measure()).toEqual({ count: 0, bytes: 0 });
  });

  it('does not resurrect a removed conversation after a delayed blob write', async () => {
    const h = setup();
    const receiver = createReturnedImages({ store: h.store, blobs: { ...h.blobs, write: async (...args) => { h.store.markRemoving([CONVERSATION]); h.store.deleteRemoving([CONVERSATION]); h.leave(); await h.blobs.write(...args); } }, alive: () => h.store.conversation(CONVERSATION) !== null, changed: h.changed });
    await receiver.receive(CONVERSATION, event());
    expect(h.store.conversation(CONVERSATION)).toBeNull();
    expect(h.blobs.measure()).toEqual({ count: 0, bytes: 0 });
  });

  it('bounds the turn across distinct sources and gives the eleventh image an explicit fallback', async () => {
    const h = setup();
    for (let n = 0; n < 11; n++) await h.receiver.receive(CONVERSATION, event(`image-${n}`));
    const items = h.store.newestPage(CONVERSATION).items;
    expect(items.filter((item) => item.attachments?.length)).toHaveLength(10);
    expect(items.at(-1)?.kind).toBe('notice');
    expect(h.blobs.measure()).toEqual({ count: 1, bytes: PNG.length });
  });

  it('reports queue saturation before decoding queued bytes', async () => {
    const h = setup();
    const payload = { kind: 'base64' as const, data: 'A'.repeat(4 * 1024 * 1024) };
    await Promise.all(Array.from({ length: 7 }, (_, n) => h.receiver.receive(CONVERSATION, event(`pressure-${n}`, payload))));
    const refused = h.store.newestPage(CONVERSATION).items.find((item) => item.providerItemId === 'image:pressure-6');
    expect(refused?.blocks[0]?.text).toContain('queue is full');
    expect(h.blobs.measure()).toEqual({ count: 0, bytes: 0 });
  });

  it('hands an unsaved failure notice to the chat if the store cannot persist it', async () => {
    const h = setup(); const unsaved = vi.fn();
    const receiver = createReturnedImages({ store: { reserveItem: (...args) => h.store.reserveItem(...args), blob: (hash) => h.store.blob(hash), saveReturnedImage: () => { throw new Error('disk full'); } }, blobs: h.blobs, alive: () => true, changed: h.changed, unsaved });
    await receiver.receive(CONVERSATION, event());
    expect(unsaved).toHaveBeenCalledTimes(1);
    const notice = unsaved.mock.calls[0]?.[2] as { kind: string; text: string };
    expect(notice.kind).toBe('notice');
    expect(notice.text).toContain('could not be saved');
    expect(JSON.stringify(unsaved.mock.calls)).not.toContain(encoded);
  });

  it('keeps encoded image bytes out of summaries and the renderer bridge', () => {
    const bridged = bridge(CONVERSATION, event());
    expect(bridged.session).toEqual([]);
    expect(bridged.chat).toEqual([]);
    expect(JSON.stringify(bridged)).not.toContain(encoded);
  });
});
