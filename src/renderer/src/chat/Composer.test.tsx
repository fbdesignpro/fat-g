// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8 (docs/planning/_archive/M18.md, Design 4; C19): a prompt whose record could not be written is refused,
// and nothing of it is lost on the page — the draft stays, a line says to try again, and a later
// Send works. The input row inside the chat region, on a fake bridge.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_LINES, type ChatSendResult } from '@shared/contracts/chat';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { ChatRegion } from '../shell/ChatRegion';
import { chatItem, chatTurn, type FakeChat, fakeChat } from '../test/chat';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { useChatDrafts } from './chat-store';
import { showDetached } from './detached-store';
import { Composer, COMPOSER_WORDS } from './Composer';
import { focusPrompt, resetPromptFocus, usePromptFocus } from './prompt-focus';

const A = project('Calamari', { providers: ['codex'] });
const ONE = sessionEntry('Create plan', SUMMARIES.idle, { projectId: A.id, providerId: 'codex' });
const ID = ONE.record.id;

let bridge: FakeBridge;
let main: FakeChat;
let requests: [InvokeChannel, unknown][];
let sendAnswer: ChatSendResult;

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  main = fakeChat(ID);
  requests = [];
  sendAnswer = { status: 'accepted' };
  useChatDrafts.setState({ drafts: {} });
  showDetached(null);
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    return Promise.resolve({ ok: true, value: channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0]) : channel === 'chat:send' ? sendAnswer : { status: 'saved' } });
  });
});
afterEach(() => { cleanup(); resetPromptFocus(); });

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const input = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Codex' });
const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
const sent = () => requests.filter(([channel]) => channel === 'chat:send').map(([, request]) => { const { revision: _revision, attachments: _attachments, ...rest } = request as Record<string, unknown>; return rest; });

async function open() {
  act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, providers: [sampleProvider({ id: 'codex', displayName: 'Codex' })] }); });
  render(<ChatRegion />);
  await settle();
}

describe('the prompt when entering a chat or returning to the app', () => {
  let frames: Map<number, FrameRequestCallback>;
  beforeEach(() => {
    frames = new Map();
    let serial = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++serial, callback); return serial; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const finishActivation = () => act(() => {
    const waiting = [...frames.values()];
    frames.clear();
    for (const callback of waiting) callback(0);
  });
  const windowEvent = (type: 'focus' | 'blur') => act(() => { fireEvent(window, new Event(type)); });

  it('focuses on entry and on a session change, without taking focus on an ordinary update', async () => {
    await open();
    expect(document.activeElement).toBe(input());
    const list = screen.getByRole('group', { name: 'Messages' });
    list.focus();
    act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, providers: [sampleProvider({ id: 'codex', displayName: 'Codex' })] }); });
    expect(document.activeElement).toBe(list);

    windowEvent('focus');
    expect(frames.size).toBe(1);
    const other = sessionEntry('Another chat', SUMMARIES.idle, { projectId: A.id, providerId: 'codex' });
    main = fakeChat(other.record.id);
    act(() => { showState({ projects: [A], sessions: [ONE, other], selectedId: other.record.id, providers: [sampleProvider({ id: 'codex', displayName: 'Codex' })] }); });
    await settle();
    expect(document.activeElement).toBe(input());
    expect(frames.size).toBe(0);
  });

  it('reclaims focus after an activating click and cancels that deferred work on blur or unmount', async () => {
    await open();
    const list = screen.getByRole('group', { name: 'Messages' });
    list.focus();
    windowEvent('focus');
    expect(document.activeElement).toBe(input());
    // The click that brought the app forward focuses something else after the window event.
    list.focus();
    finishActivation();
    expect(document.activeElement).toBe(input());

    windowEvent('focus');
    expect(frames.size).toBe(1);
    windowEvent('blur');
    expect(frames.size).toBe(0);
    windowEvent('focus');
    cleanup();
    expect(frames.size).toBe(0);
  });

  it('leaves an open dialog in control, including one opened during activation', async () => {
    await open();
    const dialog = document.body.appendChild(document.createElement('dialog'));
    const field = dialog.appendChild(document.createElement('input'));
    try {
      windowEvent('focus');
      dialog.setAttribute('open', '');
      field.focus();
      finishActivation();
      expect(document.activeElement).toBe(field);
      windowEvent('focus');
      finishActivation();
      expect(document.activeElement).toBe(field);
    } finally {
      dialog.remove();
    }
  });
});

// M100b, V19 (C61): the focus asked for a session's prompt is taken by its text area once it stands, then forgotten.
describe('the focus asked for the prompt (M100b, V19; C61)', () => {
  it('takes it for its own session alone, once, and leaves another session\'s ask to that session', async () => {
    await open();
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => { focusPrompt('5e55aaaa-0000-4000-8000-00000000ffff'); });
    expect(document.activeElement).not.toBe(input());
    expect(usePromptFocus.getState().sessionId).not.toBeNull();
    act(() => { focusPrompt(ID); });
    expect(document.activeElement).toBe(input());
    // Taken, it is forgotten: a later drawing of the chat takes nothing.
    expect(usePromptFocus.getState().sessionId).toBeNull();
  });

  it('takes an ask made before the chat stands, as soon as it does', async () => {
    focusPrompt(ID);
    await open();
    expect(document.activeElement).toBe(input());
    expect(usePromptFocus.getState().sessionId).toBeNull();
  });
});

describe('a Send refused because its record could not be written (V8; C19)', () => {
  it('keeps the draft, says to try again, and sends when the next try is taken', async () => {
    sendAnswer = { status: 'refused', reason: 'storage-failed' };
    await open();
    fireEvent.change(input(), { target: { value: 'Fix the login bug' } });
    fireEvent.click(sendButton());
    await settle();
    expect(sent()).toEqual([{ sessionId: ID, prompt: 'Fix the login bug' }]);
    expect(input().value).toBe('Fix the login bug');
    expect(screen.getByText(CHAT_LINES.storageFailed).getAttribute('role')).toBe('status');
    // Nothing was sent, so nothing is shown as sent.
    expect(screen.queryAllByRole('article')).toEqual([]);
    // The input is as usable as before, and the focus is still in it.
    expect(sendButton().disabled).toBe(false);
    expect(document.activeElement).toBe(input());

    // The store takes the next one: the same draft, sent once more by the user.
    sendAnswer = { status: 'accepted' };
    fireEvent.keyDown(input(), { key: 'Enter' });
    await settle();
    expect(sent()).toEqual([{ sessionId: ID, prompt: 'Fix the login bug' }, { sessionId: ID, prompt: 'Fix the login bug' }]);
    expect(input().value).toBe('');
    expect(screen.queryByText(CHAT_LINES.storageFailed)).toBeNull();
  });

  it('sends nothing again by itself', async () => {
    sendAnswer = { status: 'refused', reason: 'storage-failed' };
    await open();
    fireEvent.change(input(), { target: { value: 'Once' } });
    fireEvent.click(sendButton());
    await settle();
    // Whatever arrives afterwards, the refused prompt is the user's to send again.
    const item = chatItem(ID, 'assistant', 'unrelated');
    act(() => { bridge.push('chat:message', { sessionId: ID, revision: 1, item, turn: chatTurn(item.turnId) }); });
    await settle();
    expect(sent()).toHaveLength(1);
    expect(input().value).toBe('Once');
  });

  it('keeps a draft that changed while the Send was on its way', async () => {
    await open();
    let taken: (answer: unknown) => void = () => undefined;
    bridge.setInvoke((channel) => (channel === 'chat:send' ? new Promise((resolve) => { taken = resolve; }) : Promise.resolve({ ok: true, value: main.read({ sessionId: ID }) })));
    fireEvent.change(input(), { target: { value: 'First' } });
    fireEvent.click(sendButton());
    await settle();
    fireEvent.change(input(), { target: { value: 'First, and more' } });
    act(() => taken({ ok: true, value: { status: 'accepted' } }));
    await settle();
    // What was taken leaves the input; what was typed after it stays (M23, C86).
    expect(input().value).toBe(', and more');
  });
});

describe('the input row on its own', () => {
  it('shows the line it is given, keeps the draft when the prompt was not taken, and clears it when it was', async () => {
    const outcomes = [false, true];
    const prompts: string[] = [];
    const onSend = ({ prompt }: { readonly prompt: string }) => { prompts.push(prompt); return Promise.resolve(outcomes.shift() ?? true); };
    const view = render(<Composer sessionId={ID} providerName="Codex" running={false} loading={false} ready onSend={onSend} onStop={() => undefined} problem={CHAT_LINES.storageFailed} />);
    expect(screen.getByText(CHAT_LINES.storageFailed)).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'Again' } });
    fireEvent.click(sendButton());
    await settle();
    expect(input().value).toBe('Again');
    fireEvent.click(sendButton());
    await settle();
    expect(prompts).toEqual(['Again', 'Again']);
    expect(input().value).toBe('');
    view.unmount();
  });

  // M100 (C40–C42, V6): a box, the text area over a foot row — the microphone at its left, Send or Stop at its right — and the lines under it.
  it('is a box holding the text area over its foot, with the microphone at the foot’s left and Send or Stop at its right', () => {
    const view = render(<Composer sessionId={ID} providerName="Codex" running={false} loading ready onSend={() => Promise.resolve(true)} onStop={() => undefined} problem={CHAT_LINES.storageFailed} />);
    const box = input().parentElement as HTMLElement;
    const foot = box.lastElementChild as HTMLElement;
    expect([...box.children].map((child) => child.tagName)).toEqual(['TEXTAREA', 'DIV']);
    const microphone = screen.getByRole('button', { name: COMPOSER_WORDS.dictation });
    expect([...foot.children].map((child) => child.textContent)).toEqual(['', 'Send']);
    expect(foot.contains(microphone) && foot.firstElementChild === microphone).toBe(true);
    expect(sendButton().hasAttribute('data-primary')).toBe(true);
    // The loading line and the problem line stand under the box, not in it.
    for (const line of [screen.getByText(CHAT_LINES.loading), screen.getByText(CHAT_LINES.storageFailed)]) {
      expect(box.contains(line)).toBe(false);
      expect(box.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    view.rerender(<Composer sessionId={ID} providerName="Codex" running loading={false} ready onSend={() => Promise.resolve(true)} onStop={() => undefined} problem={null} />);
    // While a turn runs (M23, C35): Queue in Send's place with Stop beside it; Send now where main offers it.
    expect([...foot.children].map((child) => child.textContent)).toEqual(['', 'QueueStop']);
    view.unmount();
  });

  it('draws the microphone unavailable, still reachable, its tooltip saying dictation comes later; its press does nothing (C41)', () => {
    let sends = 0;
    const view = render(<Composer sessionId={ID} providerName="Codex" running={false} loading={false} ready onSend={() => { sends += 1; return Promise.resolve(true); }} onStop={() => undefined} problem={null} />);
    const microphone = screen.getByRole('button', { name: COMPOSER_WORDS.dictation });
    expect(microphone.getAttribute('aria-disabled')).toBe('true');
    expect(microphone.hasAttribute('disabled')).toBe(false);
    const tip = document.getElementById(microphone.getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect(tip.textContent).toBe(COMPOSER_WORDS.dictationLater);
    fireEvent.focus(microphone);
    expect(tip.hasAttribute('data-open')).toBe(true);
    fireEvent.click(microphone);
    expect(sends).toBe(0);
    view.unmount();
  });
});

// V16 (docs/planning/_archive/M19.md; C48): no update of a message that is being written moves the focus or
// touches the input — the draft, the caret and a composition in progress are as they were.
describe('the input while a message is written (M19: V16; C48)', () => {
  it('keeps its draft, its caret, the focus and a composition in progress through an opening, any number of partial updates and a completion', async () => {
    await open();
    fireEvent.change(input(), { target: { value: 'A draft, half typed' } });
    input().focus();
    input().setSelectionRange(3, 9);
    // An input method starts composing before the first push, and is still composing after the last.
    fireEvent.compositionStart(input());
    const element = input();
    let changes = 0;
    let composed = 0;
    element.addEventListener('input', () => { changes += 1; });
    element.addEventListener('compositionend', () => { composed += 1; });

    const item = chatItem(ID, 'assistant', '', { state: 'streaming' });
    const turn = chatTurn(item.turnId, { state: 'running', outcome: null });
    act(() => { bridge.push('chat:message', { sessionId: ID, revision: 1, item, turn }); });
    let text = '';
    for (let update = 0; update < 200; update += 1) {
      const append = `piece ${update} `;
      act(() => { bridge.push('chat:message', { sessionId: ID, revision: 2 + update, partial: { itemId: item.id, before: text.length, append } }); });
      text += append;
    }
    act(() => { bridge.push('chat:message', { sessionId: ID, revision: 202, item: { ...item, state: 'complete', blocks: [{ type: 'text', text, cut: false }] }, turn }); });
    await settle();

    // The message arrived, whole.
    expect(screen.getByRole('article').textContent).toContain('piece 199');
    // And the input is the element it was, as it was.
    expect(input()).toBe(element);
    expect(document.activeElement).toBe(element);
    expect(element.value).toBe('A draft, half typed');
    expect([element.selectionStart, element.selectionEnd]).toEqual([3, 9]);
    expect([changes, composed]).toEqual([0, 0]);
    // Still composing: Enter picks the input method's candidate, and sends nothing.
    fireEvent.keyDown(element, { key: 'Enter', keyCode: 229 });
    expect(sent()).toEqual([]);
    fireEvent.compositionEnd(element);
    expect(composed).toBe(1);
  });

  it('never takes the focus from the list either, when the reader is moving through the messages', async () => {
    main.items = [chatItem(ID, 'user', 'a prompt'), chatItem(ID, 'assistant', 'an answer')];
    main.revision = 2;
    await open();
    const list = screen.getByRole('group', { name: 'Messages' });
    list.focus();
    const item = chatItem(ID, 'assistant', '', { state: 'streaming' });
    act(() => { bridge.push('chat:message', { sessionId: ID, revision: 3, item, turn: chatTurn(item.turnId, { state: 'running', outcome: null }) }); });
    act(() => { bridge.push('chat:message', { sessionId: ID, revision: 4, partial: { itemId: item.id, before: 0, append: 'More text.' } }); });
    expect(document.activeElement).toBe(list);
  });
});
