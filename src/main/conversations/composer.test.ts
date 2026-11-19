// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V16, V17, V18 (docs/planning/_archive/M23.md; C5, C6, C8, C25, C31, C47–C51, C81–C87): the composer's rows on
// a real file — a draft at its revisions, an image's uses and their bounds, ownership moved by Queue,
// Edit and a prompt's acceptance without a moment unnamed, an image's row and file gone with its last
// use, a removal that takes all of it, and the open's sweep of what no row names.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENTS_FOLDER, type AttachmentMediaType, MAX_IMAGE_BYTES } from '@shared/contracts/attachments';
import { NO_INTENT } from '@shared/contracts/composer';
import { createBlobFiles, sha256 } from '../attachments/files';
import { gifBytes, pngBytes } from '../images/test-support';
import { CONVERSATIONS_VERSION } from './format';
import { type ConversationStore, type GivenInput, StorageFailure, type StoredBlob } from './store';
import { CONVERSATION, OTHER, type Scratch, scratch } from './test-support';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const root = (): string => path.join(area.dir, ATTACHMENTS_FOLDER);
const files = (): string[] => (existsSync(root()) ? readdirSync(root()).sort() : []);

/** An image written to the folder, as staging writes it, and its row's content. */
async function image(bytes: Uint8Array, mediaType: AttachmentMediaType = 'image/png', width = 8, height = 8): Promise<StoredBlob> {
  const hash = sha256(bytes);
  await createBlobFiles(root()).write(hash, mediaType, bytes);
  return { hash, mediaType, bytes: bytes.byteLength, width, height, stagedAt: 1 };
}

const PNG = pngBytes(8, 8);
const GIF = gifBytes(3, 3);
let uses = 0;
const use = (name: string | null = null) => ({ id: `use-${++uses}`, name });
const given = (store: ConversationStore, patch: Partial<GivenInput> = {}): GivenInput => {
  const draft = store.draft(CONVERSATION);
  return { revision: (draft?.revision ?? 0) + 1, text: draft?.text ?? '', intent: draft?.intent ?? NO_INTENT, attachmentIds: draft?.attachments.map((entry) => entry.id) ?? [], ...patch };
};
const failure = (work: () => unknown): string | null => {
  try { work(); return null; } catch (error) { return error instanceof StorageFailure ? error.kind : 'other'; }
};

describe('a draft (V7, V18; C31, C32, C86)', () => {
  it('keeps text and intent at a revision above the one held, and refuses a late one', () => {
    const store = area.open();
    expect(store.draft(CONVERSATION)).toBeNull();
    expect(store.saveDraft(CONVERSATION, 2, { text: 'first', intent: NO_INTENT }, 10, false)).toBe(true);
    expect(store.saveDraft(CONVERSATION, 1, { text: 'stale', intent: NO_INTENT }, 11, false)).toBe(false);
    expect(store.saveDraft(CONVERSATION, 2, { text: 'same revision', intent: NO_INTENT }, 11, false)).toBe(false);
    expect(store.saveDraft(CONVERSATION, 5, { text: 'later', intent: { plan: true, skill: { name: 'review', selector: 'a'.repeat(16) } } }, 12, false)).toBe(true);
    expect(store.draft(CONVERSATION)).toMatchObject({ text: 'later', revision: 5, intent: { plan: true, skill: { name: 'review' } }, changedAt: 12, attachments: [] });
  });

  it('makes its conversation’s row with it, so a removal takes them together (C83)', () => {
    const store = area.open();
    store.saveDraft(CONVERSATION, 1, { text: 'a draft', intent: NO_INTENT }, 10, false);
    expect(store.conversation(CONVERSATION)).toMatchObject({ startHeld: true, createdAt: 10 });
    // A session that had started already: the store does not hold its start (C18).
    store.saveDraft(OTHER, 1, { text: 'b', intent: NO_INTENT }, 10, true);
    expect(store.conversation(OTHER)?.startHeld).toBe(false);
    expect(store.withContent().slice().sort()).toEqual([CONVERSATION, OTHER].sort());
  });

  it('clears at a revision, and a late update cannot bring the text back (C86)', async () => {
    const store = area.open();
    store.saveDraft(CONVERSATION, 3, { text: 'sent', intent: NO_INTENT }, 10, false);
    store.stageDraft(CONVERSATION, await image(PNG), use('a.png'), 11, false);
    store.clearDraft(CONVERSATION, 4, 12);
    expect(store.draft(CONVERSATION)).toMatchObject({ text: '', revision: 4, attachments: [] });
    expect(store.saveDraft(CONVERSATION, 4, { text: 'sent', intent: NO_INTENT }, 13, false)).toBe(false);
    // Its image went with its last use (C6).
    expect(files()).toEqual([]);
    expect(store.withContent()).toEqual([]);
  });
});

describe('an image’s uses (V16; C2, C5, C6, C8, C85)', () => {
  it('names the image once and each use with its own name, in the order staged', async () => {
    const store = area.open();
    const png = await image(PNG);
    store.stageDraft(CONVERSATION, png, use('cat.png'), 10, false);
    store.stageDraft(CONVERSATION, { ...png, stagedAt: 99 }, use('same bytes, other name.png'), 11, false);
    store.stageDraft(CONVERSATION, await image(GIF, 'image/gif', 3, 3), use(null), 12, false);
    const draft = store.draft(CONVERSATION);
    expect(draft?.attachments.map((entry) => [entry.name, entry.mediaType, entry.width])).toEqual([['cat.png', 'image/png', 8], ['same bytes, other name.png', 'image/png', 8], ['Pasted image 1', 'image/gif', 3]]);
    // The first staging's row stands.
    expect(store.blob(png.hash)).toMatchObject({ stagedAt: 1, bytes: PNG.length });
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM blob').get())).toEqual({ n: 2 });
  });

  it('keeps paste labels per session across queued and sent messages, repeated bytes and a restart', async () => {
    const store = area.open();
    const png = await image(PNG);
    expect(store.stageDraft(CONVERSATION, png, use(), 10, false)).toBe('Pasted image 1');
    store.enqueue(CONVERSATION, 'q-paste', given(store), 11, false);
    expect(store.stageDraft(CONVERSATION, png, use(), 12, false)).toBe('Pasted image 2');
    store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't-paste', itemId: 'p-paste', text: '', at: 13, started: false, from: { draft: given(store) } });
    expect(store.stageDraft(OTHER, png, use(), 14, false)).toBe('Pasted image 1');
    store.close();

    const again = area.open();
    expect(again.queue(CONVERSATION)[0]?.attachments[0]?.name).toBe('Pasted image 1');
    expect(again.newestPage(CONVERSATION).items[0]?.attachments?.[0]?.name).toBe('Pasted image 2');
    expect(again.stageDraft(CONVERSATION, png, use(), 15, true)).toBe('Pasted image 3');
    expect(again.stageDraft(CONVERSATION, png, use('actual-file.png'), 16, true)).toBe('actual-file.png');
    expect(again.stageDraft(CONVERSATION, png, use(), 17, true)).toBe('Pasted image 4');
    expect(files()).toEqual([`${png.hash}.png`]);
  });

  it('refuses an eleventh use, counting the same image twice, and the message’s bytes past 20 MiB (C2)', async () => {
    const store = area.open();
    const png = await image(PNG);
    for (let index = 0; index < 10; index += 1) store.stageDraft(CONVERSATION, png, use(), 10, false);
    expect(failure(() => store.stageDraft(CONVERSATION, png, use(), 11, false))).toBe('too-many');
    expect(store.draft(CONVERSATION)?.attachments).toHaveLength(10);

    const big = (index: number): StoredBlob => ({ hash: String(index).repeat(64).slice(0, 64), mediaType: 'image/png', bytes: MAX_IMAGE_BYTES, width: 10, height: 10, stagedAt: 1 });
    for (let index = 1; index <= 4; index += 1) store.stageDraft(OTHER, big(index), use(), 10, false);
    expect(failure(() => store.stageDraft(OTHER, { ...big(5), bytes: 1 }, use(), 10, false))).toBe('too-large');
    // Nothing of a refused staging was written.
    expect(store.blob(big(5).hash)).toBeNull();
  });

  it('removes a use, and the image with its last one — its row and its file — while one still used stays (C6)', async () => {
    const store = area.open();
    const png = await image(PNG);
    const first = use('one');
    const second = use('two');
    store.stageDraft(CONVERSATION, png, first, 10, false);
    store.stageDraft(OTHER, png, second, 10, false);
    expect(store.removeDraftAttachment(CONVERSATION, first.id, 11)).toBe(true);
    expect(store.removeDraftAttachment(CONVERSATION, first.id, 11)).toBe(false);
    // Another session's use: not this draft's to remove.
    expect(store.removeDraftAttachment(CONVERSATION, second.id, 11)).toBe(false);
    expect(files()).toEqual([`${png.hash}.png`]);
    expect(store.removeDraftAttachment(OTHER, second.id, 12)).toBe(true);
    expect(store.blob(png.hash)).toBeNull();
    expect(files()).toEqual([]);
  });

  it('keeps a row whose file will not unlink, and the next open’s sweep removes the file (C6)', async () => {
    const store = area.open({ blobs: { ...createBlobFiles(root()), remove: () => false } });
    const png = await image(PNG);
    const only = use();
    store.stageDraft(CONVERSATION, png, only, 10, false);
    store.removeDraftAttachment(CONVERSATION, only.id, 11);
    expect(store.blob(png.hash)).toBeNull();
    expect(files()).toEqual([`${png.hash}.png`]);
    store.close();
    area.open();
    expect(files()).toEqual([]);
  });
});

describe('a prompt’s acceptance from the draft (V5, V16; C21, C26, C56, C86)', () => {
  it('moves the draft’s uses to the prompt as items of its turn, in one transaction, and folds them into its message', async () => {
    const store = area.open();
    const png = await image(PNG);
    const gif = await image(GIF, 'image/gif', 3, 3);
    store.saveDraft(CONVERSATION, 4, { text: 'Look at these', intent: NO_INTENT }, 10, false);
    store.stageDraft(CONVERSATION, png, use('a.png'), 10, false);
    store.stageDraft(CONVERSATION, gif, use(null), 10, false);
    const from = given(store, { text: 'Look at these' });
    const made = store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't1', itemId: 'p1', text: 'Look at these', at: 20, started: false, from: { draft: from } });
    expect(made.item.attachments?.map((entry) => [entry.id, entry.hash, entry.name, entry.available])).toEqual([[from.attachmentIds[0], png.hash, 'a.png', true], [from.attachmentIds[1], gif.hash, 'Pasted image 1', true]]);
    expect(store.draft(CONVERSATION)).toMatchObject({ text: '', attachments: [], revision: from.revision });
    // A page holds the message alone, with its images: no use stands as an item of its own.
    const page = store.newestPage(CONVERSATION).items;
    expect(page.map((item) => item.kind)).toEqual(['message']);
    expect(page[0]?.attachments).toHaveLength(2);
    // The images are named by the turn now: nothing was released.
    expect(files()).toEqual([`${gif.hash}.gif`, `${png.hash}.png`].sort());
  });

  it('writes nothing where the images named are not the draft’s', async () => {
    const store = area.open();
    store.stageDraft(CONVERSATION, await image(PNG), use(), 10, false);
    expect(failure(() => store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't1', itemId: 'p1', text: 'x', at: 20, started: false, from: { draft: given(store, { attachmentIds: [] }) } }))).toBe('draft-changed');
    expect(store.turn(CONVERSATION, 't1')).toBeNull();
    expect(store.draft(CONVERSATION)?.attachments).toHaveLength(1);
  });

  it('accepts a prompt of images alone (C17)', async () => {
    const store = area.open();
    store.stageDraft(CONVERSATION, await image(PNG), use(), 10, false);
    const made = store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't1', itemId: 'p1', text: '', at: 20, started: false, from: { draft: given(store, { text: '' }) } });
    expect(made.item.blocks[0]?.text).toBe('');
    expect(made.item.attachments).toHaveLength(1);
  });
});

describe('the queue (V9, V18; C47, C48, C50, C51, C56, C82, C87)', () => {
  it('appends the draft with its images and intent, empties the draft, and refuses an eleventh entry', async () => {
    const store = area.open();
    const png = await image(PNG);
    store.saveDraft(CONVERSATION, 1, { text: 'first', intent: { plan: true, skill: null } }, 10, false);
    store.stageDraft(CONVERSATION, png, use('x.png'), 10, false);
    store.enqueue(CONVERSATION, 'q1', given(store), 11, false);
    expect(store.draft(CONVERSATION)).toMatchObject({ text: '', attachments: [] });
    expect(store.queue(CONVERSATION)).toMatchObject([{ id: 'q1', text: 'first', intent: { plan: true }, queuedAt: 11, attachments: [{ name: 'x.png', hash: png.hash }] }]);
    expect(failure(() => store.enqueue(CONVERSATION, 'q-empty', given(store, { text: '  ' }), 12, false))).toBe('empty');
    for (let index = 2; index <= 10; index += 1) store.enqueue(CONVERSATION, `q${index}`, given(store, { text: `m${index}` }), 12, false);
    expect(failure(() => store.enqueue(CONVERSATION, 'q11', given(store, { text: 'eleventh' }), 13, false))).toBe('full');
    expect(store.queue(CONVERSATION)).toHaveLength(10);
    expect(store.queued()).toEqual([CONVERSATION]);
  });

  it('swaps an entry with a draft that holds something, and takes an entry into an empty one (C50, C87)', async () => {
    const store = area.open();
    const png = await image(PNG);
    const gif = await image(GIF, 'image/gif', 3, 3);
    store.saveDraft(CONVERSATION, 1, { text: 'queued text', intent: { plan: true, skill: null } }, 10, false);
    store.stageDraft(CONVERSATION, png, use('queued.png'), 10, false);
    store.enqueue(CONVERSATION, 'q1', given(store), 11, false);
    store.saveDraft(CONVERSATION, 7, { text: 'draft text', intent: NO_INTENT }, 12, false);
    store.stageDraft(CONVERSATION, gif, use('draft.gif'), 12, false);
    store.editQueued(CONVERSATION, 'q1', given(store, { revision: 7 }), 13);
    expect(store.draft(CONVERSATION)).toMatchObject({ text: 'queued text', intent: { plan: true }, revision: 8, attachments: [{ name: 'queued.png' }] });
    expect(store.queue(CONVERSATION)).toMatchObject([{ id: 'q1', text: 'draft text', intent: { plan: false }, attachments: [{ name: 'draft.gif' }] }]);
    // A late flush of the old draft cannot undo the swap.
    expect(store.saveDraft(CONVERSATION, 7, { text: 'draft text', intent: NO_INTENT }, 14, false)).toBe(false);
    // Into an empty draft: the slot goes, the images with the entry.
    store.clearDraft(CONVERSATION, 9, 15);
    expect(files()).toEqual([`${gif.hash}.gif`]);
    store.editQueued(CONVERSATION, 'q1', given(store, { text: '' }), 16);
    expect(store.queue(CONVERSATION)).toEqual([]);
    expect(store.draft(CONVERSATION)).toMatchObject({ text: 'draft text', attachments: [{ name: 'draft.gif' }] });
    expect(files()).toEqual([`${gif.hash}.gif`]);
  });

  it('removes an entry with its images, reorders only by every entry once, and drops the whole queue (C50, C51, C82)', async () => {
    const store = area.open();
    const png = await image(PNG);
    store.stageDraft(CONVERSATION, png, use(), 10, false);
    store.enqueue(CONVERSATION, 'q1', given(store, { text: 'one' }), 11, false);
    store.enqueue(CONVERSATION, 'q2', given(store, { text: 'two' }), 11, false);
    store.enqueue(CONVERSATION, 'q3', given(store, { text: 'three' }), 11, false);
    store.reorderQueue(CONVERSATION, ['q3', 'q1', 'q2']);
    expect(store.queue(CONVERSATION).map((entry) => entry.id)).toEqual(['q3', 'q1', 'q2']);
    for (const ids of [['q3', 'q1'], ['q3', 'q1', 'q2', 'q2'], ['q3', 'q1', 'q9'], ['q3', 'q3', 'q1']]) expect(failure(() => store.reorderQueue(CONVERSATION, ids))).toBe('unknown-entry');
    expect(store.queue(CONVERSATION).map((entry) => entry.id)).toEqual(['q3', 'q1', 'q2']);
    expect(store.unqueue(OTHER, 'q1')).toBe(false);
    expect(store.unqueue(CONVERSATION, 'q1')).toBe(true);
    expect(files()).toEqual([]);
    store.dropQueue(CONVERSATION);
    expect(store.queue(CONVERSATION)).toEqual([]);
    expect(store.queued()).toEqual([]);
  });

  it('puts an entry at a place among the others, numbering them again past the gaps that removals left', () => {
    const store = area.open();
    for (const id of ['q1', 'q2', 'q3', 'q4']) store.enqueue(CONVERSATION, id, given(store, { text: id }), 11, false);
    store.unqueue(CONVERSATION, 'q1');
    store.unqueue(CONVERSATION, 'q3');
    store.enqueue(CONVERSATION, 'held', given(store, { text: 'held' }), 12, false, 0);
    expect(store.queue(CONVERSATION).map((entry) => [entry.id, entry.place])).toEqual([['held', 1], ['q2', 2], ['q4', 3]]);
    store.enqueue(CONVERSATION, 'second', given(store, { text: 'second' }), 13, false, 1);
    expect(store.queue(CONVERSATION).map((entry) => entry.id)).toEqual(['held', 'second', 'q2', 'q4']);
    // Past the end is the end.
    store.enqueue(CONVERSATION, 'last', given(store, { text: 'last' }), 14, false, 99);
    expect(store.queue(CONVERSATION).map((entry) => entry.id).at(-1)).toBe('last');
    expect(store.draft(CONVERSATION)).toMatchObject({ text: '' });
  });

  it('takes a queued message whole into a prompt, its images the prompt’s (C56)', async () => {
    const store = area.open();
    const png = await image(PNG);
    store.stageDraft(CONVERSATION, png, use('q.png'), 10, false);
    store.enqueue(CONVERSATION, 'q1', given(store, { text: 'queued' }), 11, false);
    const made = store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't1', itemId: 'p1', text: 'queued', at: 20, started: false, from: { queued: 'q1' } });
    expect(made.item.attachments).toMatchObject([{ name: 'q.png', hash: png.hash }]);
    expect(made.item.fromQueue).toBe(true);
    expect(store.queue(CONVERSATION)).toEqual([]);
    expect(failure(() => store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't2', itemId: 'p2', text: 'queued', at: 21, started: false, from: { queued: 'q1' } }))).toBe('not-queued');
    expect(store.turn(CONVERSATION, 't2')).toBeNull();
    store.close();
    expect(area.open().newestPage(CONVERSATION).items.find((item) => item.id === 'p1')?.fromQueue).toBe(true);
  });
});

describe('a removal and the open (V16, V17; C6, C84)', () => {
  it('takes a session’s draft, queue and sent images with its conversation, keeping an image another session uses', async () => {
    const store = area.open();
    const png = await image(PNG);
    const gif = await image(GIF, 'image/gif', 3, 3);
    store.stageDraft(CONVERSATION, png, use(), 10, false);
    store.acceptPrompt({ conversationId: CONVERSATION, turnId: 't1', itemId: 'p1', text: 'sent', at: 11, started: false, from: { draft: given(store, { text: 'sent' }) } });
    store.stageDraft(CONVERSATION, gif, use(), 12, false);
    store.enqueue(CONVERSATION, 'q1', given(store, { text: 'q' }), 12, false);
    store.stageDraft(CONVERSATION, png, use(), 13, false);
    store.stageDraft(OTHER, gif, use(), 13, false);
    store.markRemoving([CONVERSATION]);
    store.deleteRemoving([CONVERSATION]);
    expect(store.draft(CONVERSATION)).toBeNull();
    expect(store.queue(CONVERSATION)).toEqual([]);
    expect(store.blob(png.hash)).toBeNull();
    expect(files()).toEqual([`${gif.hash}.gif`]);
    expect(area.raw((db) => db.prepare('SELECT count(*) AS n FROM staged').get())).toEqual({ n: 1 });
  });

  it('sweeps at a compatible open what no row names: a file a failed commit left, and a temporary file (C6)', async () => {
    const png = await image(PNG);
    const store = area.open({ hook: (point) => { if (point === 'stage') throw new Error('disk full'); } });
    expect(() => store.stageDraft(CONVERSATION, png, use(), 10, false)).toThrow('disk full');
    expect(store.blob(png.hash)).toBeNull();
    store.close();
    writeFileSync(path.join(root(), '.stage-abc.tmp'), 'cut short');
    const again = area.open();
    // The open swept the failed commit's file and the temporary one: an image staged now stays.
    expect(files()).toEqual([]);
    const kept = await image(GIF, 'image/gif', 3, 3);
    again.stageDraft(CONVERSATION, kept, use(), 10, false);
    again.close();
    area.open();
    expect(files()).toEqual([`${kept.hash}.gif`]);
  });

  it('sweeps nothing of a store it refuses (C84)', async () => {
    area.open().close();
    area.raw((db) => db.exec(`UPDATE meta SET minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    const png = await image(PNG);
    const store = area.open();
    expect(store.status()).toMatchObject({ kind: 'refused' });
    expect(files()).toEqual([`${png.hash}.png`]);
  });
});

describe('a provider’s history (V5; C24, C25)', () => {
  it('folds a history message’s images: one under fat-g’s folder that it holds, and any other as not available, never read', async () => {
    const store = area.open();
    const png = await image(PNG);
    store.stageDraft(OTHER, png, use(), 10, false);
    store.ensure(CONVERSATION, 1);
    store.mergePage(CONVERSATION, [{
      kind: 'new',
      turn: { turnId: 'pt1', outcome: 'completed', startedAt: 1, endedAt: 2, durationMs: 1 },
      messages: [
        { role: 'user', itemId: 'u1', phase: null, text: 'from the CLI', turnId: 'pt1', at: 1, images: [{ path: path.join(root(), `${png.hash}.png`) }, { path: path.join(area.dir, 'Pictures', 'never-written.png') }] },
        { role: 'assistant', itemId: 'a1', phase: 'final', text: 'seen', turnId: 'pt1', at: 1 },
      ],
      notShown: false,
    }], null, 'not shown');
    const items = store.newestPage(CONVERSATION).items;
    expect(items.map((item) => item.kind)).toEqual(['message', 'message']);
    expect(items[0]?.attachments).toMatchObject([{ hash: png.hash, available: true }, { hash: null, available: false, name: null }]);
    expect(items[1]?.attachments).toBeUndefined();
    // The image is named by the history's turn now, as by the other draft.
    store.removeDraftAttachment(OTHER, `use-${uses}`, 11);
    expect(files()).toEqual([`${png.hash}.png`]);
  });
});
