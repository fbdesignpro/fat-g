// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V7, V16 (docs/planning/_archive/M23.md; C14, C18, C31–C34, C86): a draft in main over a real store and a
// real images' folder — an image staged, refused for its own reason or the session's, stagings taken
// in their order, a late one that attaches to nothing, and the draft's text held at its revisions and
// written at most every two seconds, at a flush and before a failure is said.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENTS_FOLDER, MAX_IMAGE_BYTES } from '@shared/contracts/attachments';
import { NO_INTENT } from '@shared/contracts/composer';
import { type BlobFiles, createBlobFiles } from '../attachments/files';
import { gifBytes, pngBytes } from '../images/test-support';
import { CONVERSATIONS_VERSION } from '../conversations/format';
import type { ConversationStore } from '../conversations/store';
import { CONVERSATION, type Scratch, scratch } from '../conversations/test-support';
import { type ComposerServiceOptions, createComposerService } from './composer';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const files = (): string[] => (existsSync(path.join(area.dir, ATTACHMENTS_FOLDER)) ? readdirSync(path.join(area.dir, ATTACHMENTS_FOLDER)).sort() : []);

/** Timers a test runs by hand. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    set: (run: () => void) => { next += 1; pending.set(next, run); return next; },
    clear: (handle: unknown) => { pending.delete(handle as number); },
    fire: () => { const runs = [...pending.values()]; pending.clear(); for (const run of runs) run(); },
    get size() { return pending.size; },
  };
}

function setup(patch: Partial<ComposerServiceOptions> = {}, store: ConversationStore = area.open()) {
  const blobs = createBlobFiles(path.join(area.dir, ATTACHMENTS_FOLDER));
  const changed = vi.fn();
  const failing = vi.fn();
  const timers = manualTimers();
  let listed = true;
  let leaving = false;
  let ids = 0;
  const composer = createComposerService({
    store, blobs, listed: () => listed, leaving: () => leaving, started: () => false, changed, failing, timers, newId: () => `use-${++ids}`, now: () => 50, log: { info: () => undefined, warn: () => undefined },
    ...patch,
  });
  return { store, blobs, composer, changed, failing, timers, unlist: () => { listed = false; }, leave: () => { leaving = true; } };
}

describe('staging (V4, V16; C14, C18)', () => {
  it('stages an image into the draft and answers its descriptor, its name cleaned and cut', async () => {
    const { composer, store, changed } = setup();
    const answer = await composer.stage(CONVERSATION, pngBytes(12, 9), `  screen\u0000shot.png${'x'.repeat(200)}`);
    expect(answer).toMatchObject({ status: 'staged', attachment: { id: 'use-1', mediaType: 'image/png', width: 12, height: 9 } });
    if (answer.status !== 'staged') return;
    expect(answer.attachment.name?.startsWith('screenshot.png')).toBe(true);
    expect(answer.attachment.name).toHaveLength(100);
    expect(store.draft(CONVERSATION)?.attachments).toEqual([answer.attachment]);
    expect(files()).toEqual([`${answer.attachment.hash}.png`]);
    expect(changed).toHaveBeenCalledWith(CONVERSATION);
    expect(composer.draft(CONVERSATION).attachments).toHaveLength(1);
  });

  it('returns the saved paste labels in staging order, including repeated pastes of the same image', async () => {
    const { composer, store } = setup();
    const answers = await Promise.all([
      composer.stage(CONVERSATION, pngBytes(2, 2)),
      composer.stage(CONVERSATION, pngBytes(2, 2)),
    ]);
    expect(answers).toMatchObject([
      { status: 'staged', attachment: { name: 'Pasted image 1' } },
      { status: 'staged', attachment: { name: 'Pasted image 2' } },
    ]);
    expect(store.draft(CONVERSATION)?.attachments.map((entry) => entry.name)).toEqual(['Pasted image 1', 'Pasted image 2']);
  });

  it('refuses an image for its own reason, keeping nothing of it', async () => {
    const { composer } = setup();
    expect(await composer.stage(CONVERSATION, Buffer.from('%PDF-1.7'), 'paper.png')).toEqual({ status: 'refused', reason: 'unsupported' });
    expect(await composer.stage(CONVERSATION, pngBytes(4, 4).subarray(0, 20))).toEqual({ status: 'refused', reason: 'damaged' });
    expect(await composer.stage(CONVERSATION, pngBytes(9000, 1))).toEqual({ status: 'refused', reason: 'too-large' });
    expect(await composer.stage(CONVERSATION, new Uint8Array(MAX_IMAGE_BYTES + 1))).toEqual({ status: 'refused', reason: 'too-large' });
    expect(await composer.stage(CONVERSATION, new Uint8Array(0))).toEqual({ status: 'refused', reason: 'too-large' });
    expect(files()).toEqual([]);
  });

  it('refuses for the session: unknown, leaving, or with a store it cannot read', async () => {
    const first = setup();
    first.leave();
    expect(await first.composer.stage(CONVERSATION, pngBytes(2, 2))).toEqual({ status: 'refused', reason: 'busy' });
    first.unlist();
    expect(await first.composer.stage(CONVERSATION, pngBytes(2, 2))).toEqual({ status: 'refused', reason: 'unknown-session' });
    area.open().close();
    area.raw((db) => db.exec(`UPDATE meta SET minReaderVersion = ${CONVERSATIONS_VERSION + 1}`));
    const refused = setup({}, area.open());
    expect(await refused.composer.stage(CONVERSATION, pngBytes(2, 2))).toEqual({ status: 'refused', reason: 'conversations-refused' });
  });

  it('refuses the eleventh image, and removes the file only it named (C2)', async () => {
    const { composer } = setup();
    for (let index = 0; index < 10; index += 1) expect(await composer.stage(CONVERSATION, pngBytes(index + 1, 1))).toMatchObject({ status: 'staged' });
    expect(await composer.stage(CONVERSATION, gifBytes(3, 3))).toEqual({ status: 'refused', reason: 'too-many' });
    expect(files()).toHaveLength(10);
    expect(files().some((name) => name.endsWith('.gif'))).toBe(false);
  });

  it('takes a draft’s stagings in the order they came, whichever write ends first', async () => {
    const real = createBlobFiles(path.join(area.dir, ATTACHMENTS_FOLDER));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slowFirst: Pick<BlobFiles, 'write' | 'remove'> = {
      write: async (hash, mediaType, bytes) => { if (bytes.byteLength === pngBytes(1, 1).byteLength) await held; return real.write(hash, mediaType, bytes); },
      remove: (hash, mediaType) => real.remove(hash, mediaType),
    };
    const { composer, store } = setup({ blobs: slowFirst });
    const first = composer.stage(CONVERSATION, pngBytes(1, 1), 'first.png');
    const second = composer.stage(CONVERSATION, gifBytes(2, 2), 'second.gif');
    release();
    await Promise.all([first, second]);
    expect(store.draft(CONVERSATION)?.attachments.map((entry) => entry.name)).toEqual(['first.png', 'second.gif']);
    await composer.settled(CONVERSATION);
  });

  it('attaches nothing for a staging that ends after its draft was cleared, sent or its session removed, and removes its file (C18)', async () => {
    const real = createBlobFiles(path.join(area.dir, ATTACHMENTS_FOLDER));
    let release: () => void = () => undefined;
    const slow: Pick<BlobFiles, 'write' | 'remove'> = { write: async (...args) => { await new Promise<void>((resolve) => { release = resolve; }); return real.write(...args); }, remove: (hash, mediaType) => real.remove(hash, mediaType) };
    const { composer, store, unlist } = setup({ blobs: slow });
    const late = composer.stage(CONVERSATION, pngBytes(3, 3));
    await Promise.resolve();
    composer.update({ sessionId: CONVERSATION, op: 'clear', revision: 1 });
    release();
    expect(await late).toEqual({ status: 'refused', reason: 'busy' });
    expect(store.draft(CONVERSATION)?.attachments).toEqual([]);
    expect(files()).toEqual([]);

    const sent = composer.stage(CONVERSATION, pngBytes(4, 4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    composer.consumed(CONVERSATION, 2);
    release();
    expect(await sent).toEqual({ status: 'refused', reason: 'busy' });

    const removed = composer.stage(CONVERSATION, pngBytes(5, 5));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unlist();
    composer.forget(CONVERSATION);
    release();
    expect(await removed).toEqual({ status: 'refused', reason: 'unknown-session' });
    expect(files()).toEqual([]);
  });

  it('answers storage-failed where the file or its row could not be kept, says the session is failing for a row, and keeps no orphan', async () => {
    const failingWrite = setup({ blobs: { write: () => Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' })), remove: () => true } });
    expect(await failingWrite.composer.stage(CONVERSATION, pngBytes(2, 2))).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(failingWrite.failing).not.toHaveBeenCalled();
    failingWrite.store.close();

    const failingRow = setup({}, area.open({ hook: (point) => { if (point === 'stage') throw new Error('disk full'); } }));
    expect(await failingRow.composer.stage(CONVERSATION, pngBytes(2, 2))).toEqual({ status: 'refused', reason: 'storage-failed' });
    expect(failingRow.failing).toHaveBeenCalledWith(CONVERSATION);
    expect(files()).toEqual([]);
  });
});

describe('the draft’s text (V7, V18; C31, C34, C86)', () => {
  it('takes text at a revision above the one held, writes the latest after two seconds, and answers it meanwhile', () => {
    const { composer, store, timers } = setup();
    expect(composer.update({ sessionId: CONVERSATION, op: 'text', revision: 1, prompt: 'h', intent: NO_INTENT })).toMatchObject({ status: 'saved', draft: { text: 'h', revision: 1 } });
    composer.update({ sessionId: CONVERSATION, op: 'text', revision: 3, prompt: 'hello', intent: { plan: true, skill: null } });
    // A late one changes nothing.
    expect(composer.update({ sessionId: CONVERSATION, op: 'text', revision: 2, prompt: 'he', intent: NO_INTENT })).toMatchObject({ draft: { text: 'hello', revision: 3 } });
    expect(store.draft(CONVERSATION)).toBeNull();
    expect(composer.draft(CONVERSATION)).toMatchObject({ text: 'hello', intent: { plan: true } });
    // One write for all three, when its timer fires.
    expect(timers.size).toBe(1);
    timers.fire();
    expect(store.draft(CONVERSATION)).toMatchObject({ text: 'hello', revision: 3, intent: { plan: true } });
  });

  it('writes at once at a flush, of one session or of all (C31)', () => {
    const { composer, store, timers } = setup();
    composer.update({ sessionId: CONVERSATION, op: 'text', revision: 1, prompt: 'switching', intent: NO_INTENT });
    expect(composer.update({ sessionId: CONVERSATION, op: 'flush' })).toMatchObject({ status: 'saved' });
    expect(store.draft(CONVERSATION)?.text).toBe('switching');
    composer.update({ sessionId: CONVERSATION, op: 'text', revision: 2, prompt: 'quitting', intent: NO_INTENT });
    composer.flush();
    expect(store.draft(CONVERSATION)?.text).toBe('quitting');
    expect(timers.size).toBe(0);
  });

  it('keeps text a write could not save in main for the run, and says the session is failing (C34)', () => {
    const { composer, failing, timers } = setup({}, area.open({ hook: (point) => { if (point === 'draft') throw new Error('disk full'); } }));
    composer.update({ sessionId: CONVERSATION, op: 'text', revision: 1, prompt: 'not saved', intent: NO_INTENT });
    timers.fire();
    expect(failing).toHaveBeenCalledWith(CONVERSATION);
    expect(composer.draft(CONVERSATION).text).toBe('not saved');
    expect(composer.update({ sessionId: CONVERSATION, op: 'flush' })).toEqual({ status: 'refused', reason: 'storage-failed' });
  });

  it('drops held text an acceptance took at or above its revision, and keeps text typed after it (C86)', () => {
    const { composer, store } = setup();
    composer.update({ sessionId: CONVERSATION, op: 'text', revision: 4, prompt: 'sent', intent: NO_INTENT });
    composer.consumed(CONVERSATION, 4);
    expect(composer.draft(CONVERSATION).text).toBe('');
    composer.update({ sessionId: CONVERSATION, op: 'text', revision: 6, prompt: 'typed after', intent: NO_INTENT });
    composer.consumed(CONVERSATION, 5);
    expect(composer.draft(CONVERSATION).text).toBe('typed after');
    composer.flush();
    expect(store.draft(CONVERSATION)?.text).toBe('typed after');
  });

  it('keeps Plan as pressed when a Send takes the draft or the user clears it, and lets go of a chosen skill (C87)', () => {
    const { composer, store } = setup();
    const plan = { plan: true, skill: null };
    composer.update({ sessionId: CONVERSATION, op: 'text', revision: 1, prompt: 'Plan it', intent: plan });
    composer.flush(CONVERSATION);
    store.acceptPrompt({ conversationId: CONVERSATION, turnId: 'turn-1', itemId: 'prompt-1', text: 'Plan it', at: 60, started: true, from: { draft: { revision: 2, text: 'Plan it', intent: { plan: true, skill: { name: 'review', selector: '0123456789abcdef' } }, attachmentIds: [] } } });
    expect(store.draft(CONVERSATION)).toMatchObject({ revision: 2, text: '', intent: plan });
    composer.update({ sessionId: CONVERSATION, op: 'clear', revision: 3 });
    expect(store.draft(CONVERSATION)).toMatchObject({ revision: 3, text: '', intent: plan });
  });

  it('removes an image of the draft by its use, and refuses one the draft does not hold', async () => {
    const { composer, changed } = setup();
    const staged = await composer.stage(CONVERSATION, pngBytes(2, 2));
    if (staged.status !== 'staged') throw new Error('not staged');
    changed.mockClear();
    expect(composer.update({ sessionId: CONVERSATION, op: 'remove', attachmentId: staged.attachment.id })).toMatchObject({ status: 'saved', draft: { attachments: [] } });
    expect(changed).toHaveBeenCalledWith(CONVERSATION);
    expect(files()).toEqual([]);
    expect(composer.update({ sessionId: CONVERSATION, op: 'remove', attachmentId: staged.attachment.id })).toEqual({ status: 'refused', reason: 'unknown-attachment' });
  });
});
