// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V5, V6, V7, V17 (docs/planning/_archive/M23.md; C14, C17, C21, C28, C31, C56, C83, C86): the composer through the
// session runtime, on a real records store, a real conversation store with its images' folder, a real
// session service, and a facet in the test's hands — an image staged into a draft, a Send that
// consumes the draft in its prompt's transaction and hands the adapter the images' paths and bytes,
// the refusals for a draft that changed and an image that went, and the naming that waits for text;
// the draft's text written at most every two seconds, at a switch and at the quit, and read back after a
// restart with its images; and the presence that keeps a provisional session with a draft.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import type { ChatPush } from '@shared/contracts/chat';
import { NO_INTENT } from '@shared/contracts/composer';
import type { ProviderStatus } from '@shared/contracts/status';
import { type BlobFiles, createBlobFiles, sha256 } from '../attachments/files';
import { gifBytes, pngBytes } from '../images/test-support';
import { type ConversationStore, createConversationStore } from '../conversations/store';
import { RECORDS_FILE, RECORDS_VERSION } from '../records/format';
import { createRecordsStore, type RecordsStore } from '../records/store';
import { createAppStateStore } from '../state/app-state-store';
import { type ChatService, createChatService } from './chat-service';
import { createContentPresence } from './content';
import { createGate } from './gate';
import { createRemoval } from './removal';
import { createSessionRuntime, type SessionRuntime } from './runtime';
import { createReturnedImages } from './returned-images';
import { fakeFacet, type FakeFacet } from './runtime-test-support';
import { createSessionService, type SessionService } from './service';

const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const ROOT = 'D:\\Code\\fat-g';
const S = (n: number) => `5e551000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = Date.parse('2020-02-11T09:00:00.000Z');

let dir: string;
let records: RecordsStore;
let service: SessionService;
let runtime: SessionRuntime;
let chat: ChatService;
let conversations: ConversationStore;
let blobs: BlobFiles;
let fake: FakeFacet;
let ids: number;
let pushes: ChatPush[];
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const titles: string[] = [];
const status: ProviderStatus = { kind: 'ok' };

const root = () => ({ path: ROOT, trust: { answer: 'trusted', answeredAt: '2020-01-23T00:00:00.000Z' } });
const project = () => ({ id: PROJECT, name: 'fat-g', color: 'teal', hidden: false, providers: ['codex', 'claude'], roots: [root()] });
const session = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: S(n), projectId: PROJECT, providerId: 'codex', instanceId: 'default', reference: null, folder: null, configFolder: null, model: 'gpt-6-sol', effort: 'high', speed: null, name: null, nameSource: null,
  starred: false, toDo: false, toVerify: false, shelvedAt: null, completedAt: null, createdAt: AT - 5000, lastActiveAt: AT - 5000, lastTurn: null, ...overrides,
});

function open(sessions: unknown[]): void {
  writeFileSync(path.join(dir, RECORDS_FILE), JSON.stringify({ schemaVersion: RECORDS_VERSION, minReaderVersion: RECORDS_VERSION, projects: [project()], sessions }));
  records = createRecordsStore({ dir, providerIds: ['codex', 'claude'], platform: 'win32', now: () => AT, log });
  const store = createAppStateStore();
  fake = fakeFacet({ history: false });
  blobs = createBlobFiles(path.join(dir, ATTACHMENTS_FOLDER));
  conversations = createConversationStore({ dir, log, blobs });
  chat = createChatService({ store: conversations, log });
  pushes = [];
  chat.subscribe((push) => { pushes.push(push); });
  let ready = false;
  const gate = createGate({
    recordsRefused: () => records.isRefused(), conversationsRefused: () => conversations.status().kind === 'refused', demo: () => false,
    snapshot: () => ({ status, descriptor: { id: 'codex', displayName: 'Codex', installGuidance: '', loginCommand: '', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: false, models: true, asides: 'none', questions: 'none', permissions: null } } }),
    hasRuntime: () => true,
    project: (id) => records.getProject(id),
    isMissing: () => false,
    kept: (id) => (ready ? runtime.kept(id) : undefined),
    platform: 'win32',
  });
  const presence = createContentPresence(conversations);
  service = createSessionService({ records, store, now: () => AT, platform: 'win32', log, block: (record, hold) => gate.block(record, hold), onSessionEnded: (id, turnId, at, outcome) => chat.sessionEnded(id, turnId, at, outcome), hasContent: (id) => presence.has(id) });
  runtime = createSessionRuntime({
    sessions: service, records, chat, gate, log, now: () => AT, newId: () => `id-${++ids}`,
    facet: () => fake.facet,
    providerName: () => 'Codex',
    hasHistory: () => false,
    store: conversations,
    removal: createRemoval({ store: conversations, log }),
    secretary: { title: (_sessionId, _record, prompt) => { titles.push(prompt); }, forget: () => undefined, dispose: () => undefined },
    composer: { store: conversations, blobs, presence },
    returnedImages: createReturnedImages({ store: conversations, blobs, alive: (id) => service.record(id) !== undefined, changed: (id) => chat.changed(id) }),
  });
  ready = true;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fatg-runtime-composer-'));
  ids = 0;
  titles.length = 0;
  for (const spy of Object.values(log)) spy.mockClear();
});
afterEach(async () => {
  runtime?.dispose();
  // A record write still under way would make the folder again once it is removed.
  await service?.settled();
  service?.stop();
  conversations?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** The session's turn ends, as its provider says. */
function finish(n = 1): void {
  const turnId = fake.latest().sent.at(-1)?.turnId ?? '';
  fake.latest().emit({ type: 'turn-started', turnId, providerTurnId: `pt-${n}` });
  fake.latest().emit({ type: 'turn-ended', turnId, outcome: 'completed', reported: true });
}

async function staged(sessionId: string, bytes: Uint8Array, name?: string) {
  const answer = await runtime.stage(sessionId, bytes, name);
  if (answer.status !== 'staged') throw new Error(`not staged: ${answer.reason}`);
  return answer.attachment;
}

describe('changing an initial draft’s selection', () => {
  it('routes a CLI returned image through main and pushes its durable attachment to the chat', async () => {
    open([session(1)]);
    expect(await runtime.send(S(1), 'Create an image')).toMatchObject({ status: 'accepted' });
    const turnId = fake.latest().sent.at(-1)?.turnId ?? '';
    fake.latest().emit({ type: 'image-returned', turnId, itemId: 'generated-image', image: { kind: 'base64', data: Buffer.from(pngBytes(6, 4)).toString('base64') } });
    await vi.waitFor(() => expect(conversations.newestPage(S(1)).items.find((item) => item.providerItemId === 'image:generated-image')?.attachments).toHaveLength(1));
    const read = runtime.read(S(1));
    expect(read.status === 'read' && read.items.some((item) => {
      const image = item.attachments?.[0];
      return item.role === 'assistant' && image?.hash !== null && image !== undefined && image.width === 6;
    })).toBe(true);
  });

  const preset = { providerId: 'claude', instanceId: 'default', model: 'opus', effort: 'high', speed: null };

  it('changes an empty provisional session without starting a process', async () => {
    open([session(1)]);
    expect(await runtime.setDraftPreset(S(1), preset)).toEqual({ status: 'saved' });
    expect(service.record(S(1))).toMatchObject({ id: S(1), ...preset, reference: null, lastTurn: null });
    expect(fake.made).toEqual([]);
  });

  it('keeps text, images and Plan intent at the same revision and session id', async () => {
    open([session(1)]);
    const image = await staged(S(1), pngBytes(4, 3), 'draft.png');
    runtime.draft({ sessionId: S(1), op: 'text', revision: 5, prompt: 'Keep this plan', intent: { plan: true, skill: null } });
    runtime.draft({ sessionId: S(1), op: 'flush' });
    const before = conversations.draft(S(1));
    expect(await runtime.setDraftPreset(S(1), preset)).toEqual({ status: 'saved' });
    expect(conversations.draft(S(1))).toEqual(before);
    expect(conversations.draft(S(1))?.attachments[0]?.id).toBe(image.id);
    expect(fake.made).toEqual([]);
  });

  it('serializes the change against first-send admission and rejects another change', async () => {
    open([session(1)]);
    const write = records.setDraftPreset.bind(records);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(records, 'setDraftPreset').mockImplementation(async (...args) => { await held; return write(...args); });
    const changing = runtime.setDraftPreset(S(1), preset);
    expect(await runtime.send(S(1), 'Wait for the selection')).toEqual({ status: 'refused', reason: 'changing-mode' });
    expect(await runtime.setDraftPreset(S(1), preset)).toEqual({ status: 'refused', reason: 'draft-locked' });
    expect(fake.made).toEqual([]);
    release();
    expect(await changing).toEqual({ status: 'saved' });
    expect(await runtime.send(S(1), 'Now send')).toEqual({ status: 'accepted' });
    expect(await runtime.setDraftPreset(S(1), { ...preset, model: 'another' })).toEqual({ status: 'refused', reason: 'draft-locked' });
    finish();
    await service.settled();
    expect(await runtime.setDraftPreset(S(1), preset)).toEqual({ status: 'refused', reason: 'draft-locked' });
  });

  it('keeps an unsupported chosen skill and refuses Send with its explanation', async () => {
    open([session(1)]);
    const intent = { plan: false, skill: { name: 'project-skill', selector: 'a'.repeat(16) } };
    runtime.draft({ sessionId: S(1), op: 'text', revision: 4, prompt: 'Use my skill', intent });
    runtime.draft({ sessionId: S(1), op: 'flush' });
    expect(await runtime.setDraftPreset(S(1), preset)).toEqual({ status: 'saved' });
    expect(await runtime.send(S(1), 'Use my skill', { input: { revision: 4, attachmentIds: [], intent } })).toEqual({ status: 'refused', reason: 'skill-unavailable' });
    expect(conversations.draft(S(1))).toMatchObject({ text: 'Use my skill', intent });
    expect(fake.made).toEqual([]);
  });

  it.each([{ reference: 'existing' }, { completedAt: AT }, { shelvedAt: AT }])('rejects a non-provisional record: %j', async (patch) => {
    open([session(1, patch)]);
    expect((await runtime.setDraftPreset(S(1), preset)).status).toBe('refused');
    expect(service.record(S(1))?.providerId).toBe('codex');
  });
});

describe('a draft’s images through the runtime (V4, V5; C14, C21, C56, C86)', () => {
  it('stages into the draft, reads it with the chat, and sends the prompt with the images’ paths and bytes, consuming the draft in its transaction', async () => {
    open([session(1)]);
    const png = pngBytes(6, 4);
    const gif = gifBytes(3, 3);
    const first = await staged(S(1), png, 'first.png');
    const second = await staged(S(1), gif);
    const read = runtime.read(S(1));
    if (read.status !== 'read') throw new Error('not read');
    expect(read.composer?.draft.attachments.map((entry) => entry.id)).toEqual([first.id, second.id]);
    // Main pushed the draft at each staging.
    expect(pushes.filter((push) => 'composer' in push)).toHaveLength(2);

    const sent = await runtime.send(S(1), 'Look at these', { input: { revision: 3, attachmentIds: [first.id, second.id], intent: NO_INTENT } });
    expect(sent).toEqual({ status: 'accepted' });
    const turn = fake.latest().sent[0];
    expect(turn?.prompt).toBe('Look at these');
    expect(turn?.attachments?.map((attachment) => [attachment.mediaType, attachment.path])).toEqual([
      ['image/png', path.join(dir, ATTACHMENTS_FOLDER, `${sha256(png)}.png`)],
      ['image/gif', path.join(dir, ATTACHMENTS_FOLDER, `${sha256(gif)}.gif`)],
    ]);
    expect(Buffer.from(turn?.attachments?.[0]?.bytes ?? []).equals(png)).toBe(true);
    // The prompt holds them, and the draft is empty, at the Send's revision.
    const prompt = conversations.newestPage(S(1)).items.find((item) => item.role === 'user');
    expect(prompt?.attachments?.map((entry) => [entry.id, entry.name])).toEqual([[first.id, 'first.png'], [second.id, 'Pasted image 1']]);
    expect(conversations.draft(S(1))).toMatchObject({ text: '', revision: 3, attachments: [] });
    // And the page is told its draft is empty.
    const last = pushes.filter((push) => 'composer' in push).at(-1);
    expect(last !== undefined && 'composer' in last ? last.composer.draft.attachments : null).toEqual([]);
  });

  it('sends a prompt of images alone, with an empty text', async () => {
    open([session(1)]);
    const image = await staged(S(1), pngBytes(2, 2));
    expect(await runtime.send(S(1), '', { input: { revision: 1, attachmentIds: [image.id], intent: NO_INTENT } })).toEqual({ status: 'accepted' });
    expect(fake.latest().sent[0]).toMatchObject({ prompt: '', attachments: [{ mediaType: 'image/png' }] });
  });

  it('refuses a Send whose images are not the draft’s, and sends nothing (C86)', async () => {
    open([session(1)]);
    const image = await staged(S(1), pngBytes(2, 2));
    expect(await runtime.send(S(1), 'x', { input: { revision: 1, attachmentIds: [], intent: NO_INTENT } })).toEqual({ status: 'refused', reason: 'draft-changed' });
    expect(await runtime.send(S(1), 'x', { input: { revision: 1, attachmentIds: [image.id, image.id], intent: NO_INTENT } })).toEqual({ status: 'refused', reason: 'draft-changed' });
    expect(fake.made).toEqual([]);
    expect(conversations.draft(S(1))?.attachments).toHaveLength(1);
  });

  it('refuses a Send whose image went or changed, and leaves the draft as it was (C8)', async () => {
    open([session(1)]);
    const png = pngBytes(2, 2);
    const image = await staged(S(1), png);
    writeFileSync(path.join(dir, ATTACHMENTS_FOLDER, `${sha256(png)}.png`), pngBytes(3, 3).subarray(0, png.length));
    expect(await runtime.send(S(1), 'x', { input: { revision: 1, attachmentIds: [image.id], intent: NO_INTENT } })).toEqual({ status: 'refused', reason: 'attachment-missing' });
    expect(fake.made).toEqual([]);
    expect(conversations.draft(S(1))?.attachments.map((entry) => entry.id)).toEqual([image.id]);
  });

  it('keeps the text of a draft at its revision, and clears it with a Send of text alone (C31, C86)', async () => {
    open([session(1)]);
    runtime.draft({ sessionId: S(1), op: 'text', revision: 4, prompt: 'Typed', intent: NO_INTENT });
    runtime.draft({ sessionId: S(1), op: 'flush' });
    expect(conversations.draft(S(1))?.text).toBe('Typed');
    expect(await runtime.send(S(1), 'Typed', { input: { revision: 5, attachmentIds: [], intent: NO_INTENT } })).toEqual({ status: 'accepted' });
    expect(conversations.draft(S(1))).toMatchObject({ text: '', revision: 5 });
    // A late update of the sent text brings nothing back.
    runtime.draft({ sessionId: S(1), op: 'text', revision: 4, prompt: 'Typed', intent: NO_INTENT });
    runtime.draft({ sessionId: S(1), op: 'flush' });
    expect(conversations.draft(S(1))?.text).toBe('');
  });
});

describe('the draft through a run and the next (V7, V17; C31, C32, C83)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('writes its text at most every two seconds, at a switch and at the quit, and a restart shows it with its images', async () => {
    open([session(1), session(2)]);
    const image = await staged(S(1), pngBytes(5, 5), 'diagram.png');
    vi.useFakeTimers();
    const typed = (revision: number, prompt: string) => runtime.draft({ sessionId: S(1), op: 'text', revision, prompt, intent: NO_INTENT });
    expect(typed(2, 'Half a thought')).toMatchObject({ status: 'saved', draft: { revision: 2, text: 'Half a thought' } });
    // Held in main, and not written yet.
    expect(conversations.draft(S(1))?.text).toBe('');
    await vi.advanceTimersByTimeAsync(1_999);
    expect(conversations.draft(S(1))?.text).toBe('');
    await vi.advanceTimersByTimeAsync(1);
    expect(conversations.draft(S(1))).toMatchObject({ revision: 2, text: 'Half a thought' });
    // At a switch: written as the selection leaves it.
    await service.select(S(1));
    runtime.selectionChanged();
    typed(3, 'Half a thought, and more');
    await service.select(S(2));
    runtime.selectionChanged();
    expect(conversations.draft(S(1))).toMatchObject({ revision: 3, text: 'Half a thought, and more' });
    // A late update, at or below the revision held, changes nothing.
    expect(typed(2, 'Half a thought')).toMatchObject({ draft: { revision: 3, text: 'Half a thought, and more' } });
    // At the quit: written before anything is waited for.
    typed(4, 'The last words before the quit');
    void runtime.stopAll(10);
    expect(conversations.draft(S(1))).toMatchObject({ revision: 4, text: 'The last words before the quit' });
    vi.useRealTimers();

    runtime.dispose();
    service.stop();
    conversations.close();
    open([session(1), session(2)]);
    const read = runtime.read(S(1));
    if (read.status !== 'read') throw new Error('not read');
    expect(read.composer?.draft).toMatchObject({ revision: 4, text: 'The last words before the quit' });
    expect(read.composer?.draft.attachments.map((entry) => [entry.id, entry.name, entry.hash])).toEqual([[image.id, 'diagram.png', image.hash]]);
  });

  it('says a provisional session’s draft holds something while it does, by a presence alone (C83)', async () => {
    open([session(1)]);
    const entryOf = () => service.snapshot().sessions.find((entry) => entry.record.id === S(1));
    expect(entryOf()).not.toHaveProperty('content');
    const image = await staged(S(1), pngBytes(2, 2));
    expect(entryOf()?.content).toBe(true);
    // Its text alone keeps it too, once written.
    runtime.draft({ sessionId: S(1), op: 'remove', attachmentId: image.id });
    expect(entryOf()).not.toHaveProperty('content');
    runtime.draft({ sessionId: S(1), op: 'text', revision: 5, prompt: 'Something to keep', intent: NO_INTENT });
    runtime.draft({ sessionId: S(1), op: 'flush' });
    expect(entryOf()?.content).toBe(true);
    // Nothing of the draft is in the entry: the presence alone.
    expect(JSON.stringify(entryOf())).not.toContain('Something to keep');
  });
});

describe('the name a first prompt gives (V6; C28)', () => {
  it('names nothing and asks no secretary for prompts of images alone, and names from the first prompt with text', async () => {
    open([session(1)]);
    const image = await staged(S(1), pngBytes(2, 2));
    expect(await runtime.send(S(1), '', { input: { revision: 1, attachmentIds: [image.id], intent: NO_INTENT } })).toEqual({ status: 'accepted' });
    finish(1);
    // The record holds the turn by now: the first prompt is past, and only the store says none had text.
    await service.settled();
    expect(service.record(S(1))?.lastTurn).not.toBeNull();
    expect(service.record(S(1))?.name).toBeNull();
    expect(titles).toEqual([]);
    expect(await runtime.send(S(1), 'What is in this picture?', { input: { revision: 2, attachmentIds: [], intent: NO_INTENT } })).toEqual({ status: 'accepted' });
    expect(titles).toEqual(['What is in this picture?']);
    await service.settled();
    expect(service.record(S(1))?.name).toBe('What is in this picture?');
    finish(2);
    // And no later prompt names it again.
    expect(await runtime.send(S(1), 'And now?')).toEqual({ status: 'accepted' });
    expect(titles).toEqual(['What is in this picture?']);
  });

  it('names nothing for a session that started before the store held its conversation', async () => {
    open([session(1, { reference: 'thread-1', folder: ROOT, lastTurn: { turnId: 'turn-0', startedAt: 5, endedAt: 9, outcome: 'completed' } })]);
    expect(await runtime.send(S(1), 'A later prompt')).toEqual({ status: 'accepted' });
    expect(titles).toEqual([]);
  });
});
