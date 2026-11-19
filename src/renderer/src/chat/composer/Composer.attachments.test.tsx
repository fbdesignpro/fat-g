// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4 (docs/planning/_archive/M23.md; C13–C20): images in the composer — pasted with and without text, dropped
// in order on the chat column, a folder or a file that is no image refused in words, the strip with
// its labels, tooltips, Remove and count, a message of images alone, and Send waiting for an image
// still being kept. The chat region on a fake bridge, as the page runs it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_WORDS, type AttachmentDescriptor, type AttachmentStageResult, attachmentAddress } from '@shared/contracts/attachments';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { type ChatComposer, EMPTY_COMPOSER } from '@shared/contracts/composer';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../../tests/support/app-state';
import { sessionEntry, SUMMARIES } from '../../../../../tests/support/sessions';
import { ChatRegion } from '../../shell/ChatRegion';
import { COMPOSER_WORDS } from '../Composer';
import { type FakeChat, fakeChat } from '../../test/chat';
import { installDialogStandIn } from '../../test/dialog';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge';
import { project } from '../../test/records';
import { showState } from '../../test/sessions';
import { useChatDrafts } from '../chat-store';
import { showDetached } from '../detached-store';

const A = project('Calamari', { providers: ['codex'] });
const ONE = sessionEntry('Look at this', SUMMARIES.idle, { projectId: A.id, providerId: 'codex' });
const ID = ONE.record.id;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1];

let bridge: FakeBridge;
let main: FakeChat;
let requests: [InvokeChannel, unknown][];
/** What main answers each staging with, in order; a staged descriptor by default. */
let stageAnswers: (AttachmentStageResult | Promise<AttachmentStageResult>)[];
let revision: number;

const descriptor = (id: string, name: string | null, width = 1200, height = 800): AttachmentDescriptor => ({ id, hash: id.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a'), mediaType: 'image/png', bytes: 100, width, height, name });

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  main = fakeChat(ID);
  main.composer = EMPTY_COMPOSER;
  requests = [];
  stageAnswers = [];
  revision = 100;
  let pastes = 0;
  useChatDrafts.setState({ drafts: {} });
  showDetached(null);
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    if (channel === 'chat:read') return Promise.resolve({ ok: true, value: main.read(request as Parameters<FakeChat['read']>[0]) });
    if (channel === 'attachments:stage') {
      const next = stageAnswers.shift();
      const name = (request as { name?: string }).name ?? `Pasted image ${++pastes}`;
      return Promise.resolve(next ?? { status: 'staged', attachment: descriptor(`use-${requests.length}`, name) }).then((value) => {
        // Main pushes the draft before it answers the staging.
        if (value.status === 'staged') pushComposer({ ...EMPTY_COMPOSER, draft: { ...EMPTY_COMPOSER.draft, attachments: [...held().draft.attachments, value.attachment] } });
        return { ok: true, value };
      });
    }
    if (channel === 'chat:draft' && (request as { op: string }).op === 'remove') {
      const id = (request as { attachmentId: string }).attachmentId;
      const draft = { ...held().draft, attachments: held().draft.attachments.filter((entry) => entry.id !== id) };
      pushComposer({ ...held(), draft });
      return Promise.resolve({ ok: true, value: { status: 'saved', draft } });
    }
    if (channel === 'chat:send') return Promise.resolve({ ok: true, value: { status: 'accepted' } });
    return Promise.resolve({ ok: true, value: { status: 'saved', draft: held().draft } });
  });
});
afterEach(() => { cleanup(); });

let composer: ChatComposer = EMPTY_COMPOSER;
const held = (): ChatComposer => composer;
function pushComposer(next: ChatComposer): void {
  composer = next;
  revision += 1;
  act(() => { bridge.push('chat:message', { sessionId: ID, revision, composer: next }); });
}

const settle = () => act(async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); });
const input = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Codex' });
const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
const staged = () => requests.filter(([channel]) => channel === 'attachments:stage').map(([, request]) => request as { sessionId: string; bytes: Uint8Array; name?: string });
const file = (name: string, bytes: readonly number[], type = '') => new File([new Uint8Array(bytes)], name, { type });
const area = () => document.querySelector<HTMLElement>(`[data-chat-session="${ID}"]`) as HTMLElement;

async function open() {
  composer = EMPTY_COMPOSER;
  act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, providers: [sampleProvider({ id: 'codex', displayName: 'Codex' })] }); });
  render(<ChatRegion />);
  await settle();
}

function paste(files: File[], text = '') {
  fireEvent.paste(input(), { clipboardData: { items: files.map((entry) => ({ kind: 'file', type: entry.type, getAsFile: () => entry })), files, getData: (type: string) => (type === 'text/plain' ? text : '') } });
}

function dropOn(target: HTMLElement, items: { readonly file: File; readonly folder?: boolean }[]) {
  const dataTransfer = {
    types: ['Files'],
    files: items.map((entry) => entry.file),
    items: items.map((entry) => ({ kind: 'file', type: entry.file.type, getAsFile: () => entry.file, webkitGetAsEntry: () => ({ isDirectory: entry.folder === true, name: entry.file.name }) })),
    dropEffect: 'none',
  };
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

describe('paste (V4; C13)', () => {
  it('stages a pasted image at once, and puts the text pasted with it at the caret, once', async () => {
    await open();
    fireEvent.change(input(), { target: { value: 'Before after' } });
    input().setSelectionRange(7, 7);
    paste([file('', PNG, 'image/png')], 'MIDDLE ');
    await settle();
    expect(input().value).toBe('Before MIDDLE after');
    expect(staged()).toHaveLength(1);
    expect(staged()[0]).toMatchObject({ sessionId: ID });
    expect(staged()[0]?.name).toBeUndefined();
    expect([...(staged()[0]?.bytes ?? [])]).toEqual(PNG);
  });

  it('discards clipboard filenames and uses the saved numbered paste labels', async () => {
    await open();
    paste([file('image.png', PNG, 'image/png'), file('6a18e9e8-58e9-4d42-aaf5-638bdc253a27.png', PNG, 'image/png')]);
    await settle();
    expect(staged().map((entry) => entry.name)).toEqual([undefined, undefined]);
    expect(screen.getByRole('button', { name: 'Remove Pasted image 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Pasted image 2' })).toBeTruthy();
  });

  it('leaves a paste of text alone to the text area: a path or an address is text, nothing is fetched', async () => {
    await open();
    paste([], 'C:\\Users\\someone\\cat.png');
    await settle();
    expect(staged()).toEqual([]);
  });

  // The maintainer: never cut where nothing shows.
  it('refuses a paste that would take the message past its bound, images and all, says so, and lets go of the words at the next change', async () => {
    await open();
    fireEvent.change(input(), { target: { value: 'Before' } });
    input().setSelectionRange(6, 6);
    paste([file('', PNG, 'image/png')], 'x'.repeat(MAX_MESSAGE_TEXT));
    await settle();
    expect(input().value).toBe('Before');
    expect(staged()).toEqual([]);
    expect(document.querySelector('[data-paste-refused]')?.textContent).toBe(COMPOSER_WORDS.tooLong(6));
    // A selection the paste replaces counts out: this one fits.
    input().setSelectionRange(0, 6);
    paste([], 'x'.repeat(MAX_MESSAGE_TEXT));
    expect(document.querySelector('[data-paste-refused]')).toBeNull();
    fireEvent.change(input(), { target: { value: 'Before.' } });
    expect(document.querySelector('[data-paste-refused]')).toBeNull();
  });
});

describe('a drop on the chat column (V4; C15)', () => {
  it('highlights the column while a drag carries files, and none for one that carries text', async () => {
    await open();
    fireEvent.dragEnter(area(), { dataTransfer: { types: ['Files'], items: [], files: [] } });
    expect(area().className).toContain('dropping');
    fireEvent.dragLeave(area(), { dataTransfer: { types: ['Files'], items: [], files: [] } });
    expect(area().className).not.toContain('dropping');
    fireEvent.dragEnter(area(), { dataTransfer: { types: ['text/plain'], items: [], files: [] } });
    expect(area().className).not.toContain('dropping');
  });

  it('stages dropped images in the drop’s order, and refuses a folder and a file that is no image in words', async () => {
    await open();
    dropOn(area(), [
      { file: file('first.png', PNG) },
      { file: file('Holiday', [], ''), folder: true },
      { file: file('notes.txt', [0x68, 0x65, 0x6c, 0x6c, 0x6f], 'text/plain') },
      { file: file('second.jpg', JPEG) },
    ]);
    await settle();
    expect(staged().map((request) => request.name)).toEqual(['first.png', 'second.jpg']);
    const lines = screen.getAllByRole('status').map((line) => line.textContent ?? '');
    expect(lines).toContain(ATTACHMENT_WORDS.folder('Holiday'));
    expect(lines.some((line) => line.startsWith(ATTACHMENT_WORDS.notImage('notes.txt')) && line.endsWith(ATTACHMENT_WORDS.formats))).toBe(true);
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('aria-label'))).toEqual(['first.png', 'second.jpg']);
  });
});

describe('the strip (V4; C16, C19, C20)', () => {
  it('draws each image through the media route, labelled by its name or its size, with Remove and the count', async () => {
    await open();
    pushComposer({ ...EMPTY_COMPOSER, draft: { ...EMPTY_COMPOSER.draft, attachments: [descriptor('aaa1', 'cat.png'), descriptor('aaa2', null, 1200, 800), descriptor('aaa3', 'dog.webp', 10, 20)] } });
    // Each thumbnail is one image, named, where the focus lands: its picture inside says nothing more.
    const images = screen.getAllByRole('img');
    expect(images.map((image) => image.getAttribute('aria-label'))).toEqual(['cat.png', 'Image 2, 1200x800', 'dog.webp']);
    expect(images[0]?.querySelector('img')?.getAttribute('src')).toBe(attachmentAddress(descriptor('aaa1', 'cat.png').hash));
    expect(screen.getByText(ATTACHMENT_WORDS.count(3))).toBeTruthy();
    // Each thumbnail is in the tab order, and its tooltip names it and its size.
    const thumbnail = images[0] as HTMLElement;
    expect(thumbnail.tabIndex).toBe(0);
    expect(document.getElementById(thumbnail.getAttribute('aria-describedby') ?? '')?.textContent).toBe(ATTACHMENT_WORDS.tooltip('cat.png', 1200, 800));
    // Remove is in the DOM at all times, by name.
    fireEvent.click(screen.getByRole('button', { name: ATTACHMENT_WORDS.remove('Image 2, 1200x800') }));
    await settle();
    expect(requests.filter(([channel]) => channel === 'chat:draft').map(([, request]) => request)).toContainEqual({ sessionId: ID, op: 'remove', attachmentId: 'aaa2' });
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it('says no count for a single image, and takes the text’s bound as its length', async () => {
    await open();
    pushComposer({ ...EMPTY_COMPOSER, draft: { ...EMPTY_COMPOSER.draft, attachments: [descriptor('aaa1', 'cat.png')] } });
    expect(screen.queryByText(/of 10 images/)).toBeNull();
    expect(input().maxLength).toBe(100_000);
  });
});

describe('sending images (V4; C17, C18)', () => {
  it('sends a message of images alone, with the draft’s images by their ids and its revision', async () => {
    await open();
    pushComposer({ ...EMPTY_COMPOSER, draft: { revision: 4, text: '', intent: { plan: false, skill: null }, attachments: [descriptor('aaa1', 'cat.png')] } });
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await settle();
    const sent = requests.filter(([channel]) => channel === 'chat:send').map(([, request]) => request);
    expect(sent).toEqual([{ sessionId: ID, prompt: '', revision: 5, attachments: ['aaa1'] }]);
  });

  it('keeps typing usable while an image is kept, and Send waits for it', async () => {
    let finish: (value: AttachmentStageResult) => void = () => undefined;
    stageAnswers.push(new Promise((resolve) => { finish = resolve; }));
    await open();
    paste([file('slow.png', PNG, 'image/png')]);
    await settle();
    expect(within(area()).getByRole('img', { name: 'Pasted image, being kept' })).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'With the image' } });
    fireEvent.click(sendButton());
    await settle();
    expect(requests.filter(([channel]) => channel === 'chat:send')).toEqual([]);
    finish({ status: 'staged', attachment: descriptor('aaa9', 'slow.png') });
    await settle();
    await settle();
    expect(requests.filter(([channel]) => channel === 'chat:send').map(([, request]) => request)).toEqual([expect.objectContaining({ prompt: 'With the image', attachments: ['aaa9'] })]);
  });

  it('leaves the text as it was when a staging fails, and says why with the formats', async () => {
    stageAnswers.push({ status: 'refused', reason: 'damaged' });
    await open();
    fireEvent.change(input(), { target: { value: 'Keep me' } });
    paste([file('broken.png', PNG, 'image/png')]);
    await settle();
    expect(input().value).toBe('Keep me');
    const lines = screen.getAllByRole('status').map((line) => line.textContent ?? '');
    expect(lines.some((line) => line.includes('The image could not be read') && line.includes(ATTACHMENT_WORDS.formats))).toBe(true);
  });
});
