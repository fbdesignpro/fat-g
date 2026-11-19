// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8 (docs/planning/_archive/M23.md; C38, C39, C42, C46): a message sent into a running turn, in the store — at
// the turn's next place with its images and its delivery, its draft consumed in the same transaction,
// refused once the turn has the provider's end; its delivery read back; and its move to the turn it
// became, its images with it.
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { NO_INTENT } from '@shared/contracts/composer';
import { createBlobFiles, sha256 } from '../attachments/files';
import { readAttachmentHeader } from '../attachments/headers';
import { pngBytes } from '../images/test-support';
import type { ConversationStore } from './store';
import { type Scratch, scratch } from './test-support';

const CONVERSATION = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
let area: Scratch;
let store: ConversationStore;
beforeEach(() => {
  area = scratch();
  store = area.open({ blobs: createBlobFiles(path.join(area.dir, ATTACHMENTS_FOLDER)) });
  store.acceptPrompt({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'prompt-1', text: 'Read the files', at: 10, started: false });
  store.providerTook(CONVERSATION, 'turn-1', 'pt-1');
  store.addItem(CONVERSATION, 'turn-1', { id: 'answer-1', kind: 'message', origin: 'provider', providerItemId: 'a1', role: 'assistant', phase: null, text: 'Reading the first', cut: false, questions: [], notice: null, detail: null, receivedAt: 20, providerAt: null });
});
afterEach(() => { area.dispose(); });

async function stageImage(id: string): Promise<string> {
  const bytes = pngBytes(3, 2);
  const header = readAttachmentHeader(bytes);
  if (header.kind !== 'image') throw new Error('no image');
  const hash = sha256(bytes);
  await createBlobFiles(path.join(area.dir, ATTACHMENTS_FOLDER)).write(hash, header.mediaType, bytes);
  store.stageDraft(CONVERSATION, { hash, mediaType: header.mediaType, bytes: bytes.byteLength, width: header.width, height: header.height, stagedAt: 30 }, { id, name: 'shot.png' }, 30, true);
  return hash;
}

describe('a message sent into a running turn (V8; C38, C46)', () => {
  it('is written at the turn’s next place, after what the model had done, with its images and its delivery, its draft consumed', async () => {
    const hash = await stageImage('use-1');
    store.saveDraft(CONVERSATION, 1, { text: 'Also the second one', intent: NO_INTENT }, 31, true);
    const { item } = store.acceptSteer({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'steer-1', text: 'Also the second one', at: 40, from: { draft: { revision: 2, text: 'Also the second one', intent: NO_INTENT, attachmentIds: ['use-1'] } } });
    expect(item).toMatchObject({ id: 'steer-1', role: 'user', delivery: { state: 'sent', detail: null } });
    const items = store.newestPage(CONVERSATION).items;
    expect(items.map((entry) => entry.id)).toEqual(['prompt-1', 'answer-1', 'steer-1']);
    expect(items.at(-1)?.attachments?.map((entry) => [entry.id, entry.hash])).toEqual([['use-1', hash]]);
    expect(store.draft(CONVERSATION)).toMatchObject({ revision: 2, text: '', attachments: [] });
    // More of the turn goes after it.
    store.addItem(CONVERSATION, 'turn-1', { id: 'answer-2', kind: 'message', origin: 'provider', providerItemId: 'a2', role: 'assistant', phase: null, text: 'And the second', cut: false, questions: [], notice: null, detail: null, receivedAt: 50, providerAt: null });
    expect(store.newestPage(CONVERSATION).items.map((entry) => entry.id)).toEqual(['prompt-1', 'answer-1', 'steer-1', 'answer-2']);
  });

  it('takes a held Send now whole from the queue, its images with it, in the same transaction, and nothing for one no longer queued', async () => {
    const hash = await stageImage('use-1');
    store.saveDraft(CONVERSATION, 1, { text: 'Held for the turn', intent: NO_INTENT }, 31, true);
    store.enqueue(CONVERSATION, 'queued-1', { revision: 2, text: 'Held for the turn', intent: NO_INTENT, attachmentIds: ['use-1'] }, 32, true);
    store.acceptSteer({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'steer-1', text: 'Held for the turn', at: 40, from: { queued: 'queued-1' } });
    expect(store.newestPage(CONVERSATION).items.at(-1)?.fromQueue).toBe(true);
    expect(store.queue(CONVERSATION)).toEqual([]);
    expect(store.newestPage(CONVERSATION).items.at(-1)).toMatchObject({ id: 'steer-1', role: 'user', delivery: { state: 'sent', detail: null } });
    expect(store.newestPage(CONVERSATION).items.at(-1)?.attachments?.map((entry) => entry.hash)).toEqual([hash]);
    expect(() => store.acceptSteer({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'steer-2', text: 'Again', at: 41, from: { queued: 'queued-1' } })).toThrow(/not-queued/);
    expect(store.newestPage(CONVERSATION).items.map((entry) => entry.id)).toEqual(['prompt-1', 'answer-1', 'steer-1']);
  });

  it('writes nothing once the turn has its provider’s end, nor for a draft that changed', async () => {
    await stageImage('use-1');
    expect(() => store.acceptSteer({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'steer-1', text: 'x', at: 40, from: { draft: { revision: 2, text: 'x', intent: NO_INTENT, attachmentIds: [] } } })).toThrow(/draft-changed/);
    store.providerEnded(CONVERSATION, 'turn-1', 'completed', 60, null, 50);
    expect(() => store.acceptSteer({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'steer-2', text: 'Too late', at: 70 })).toThrow(/turn-over/);
    expect(store.newestPage(CONVERSATION).items.map((entry) => entry.id)).toEqual(['prompt-1', 'answer-1']);
    expect(store.draft(CONVERSATION)?.attachments.map((entry) => entry.id)).toEqual(['use-1']);
  });

  it('keeps each delivery as set, and sets none on a message that is not the user’s', () => {
    store.acceptSteer({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'steer-1', text: 'Also this', at: 40 });
    expect(store.setDelivery(CONVERSATION, 'steer-1', { state: 'taken', detail: null })).toBe(true);
    expect(store.newestPage(CONVERSATION).items.at(-1)?.delivery).toEqual({ state: 'taken', detail: null });
    expect(store.setDelivery(CONVERSATION, 'steer-1', { state: 'not-sent', detail: 'x'.repeat(5000) })).toBe(true);
    expect(store.newestPage(CONVERSATION).items.at(-1)?.delivery?.detail?.length).toBeLessThan(5000);
    expect(store.setDelivery(CONVERSATION, 'answer-1', { state: 'taken', detail: null })).toBe(false);
  });

  it('moves a handed message and its images to the turn it became, after the conversation’s last', async () => {
    const hash = await stageImage('use-1');
    store.acceptSteer({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'steer-1', text: 'Then this', at: 40, from: { draft: { revision: 2, text: 'Then this', intent: NO_INTENT, attachmentIds: ['use-1'] } } });
    store.providerEnded(CONVERSATION, 'turn-1', 'completed', 60, null, 50);
    const { turn } = store.moveToTurn(CONVERSATION, 'steer-1', 'turn-2', 61);
    expect(turn.id).toBe('turn-2');
    const page = store.newestPage(CONVERSATION);
    expect(page.turns.map((entry) => entry.id)).toEqual(['turn-1', 'turn-2']);
    const moved = page.items.find((entry) => entry.id === 'steer-1');
    expect(moved?.turnId).toBe('turn-2');
    expect(moved?.attachments?.map((entry) => entry.hash)).toEqual([hash]);
    // Again, the same: it is already there.
    expect(store.moveToTurn(CONVERSATION, 'steer-1', 'turn-2', 62).item.turnId).toBe('turn-2');
  });
});
