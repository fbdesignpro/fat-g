// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V25, V27 (docs/planning/_archive/M18.md, Design 5; C16, C18–C20, C58, C60): the message list — its
// control for older pages, its lines, its place and what it announces. The chat region on a fake
// bridge, with a layout stood in for jsdom's, which computes none: every line of the list is one
// row tall, and the list shows ten of them.
//
// V9, V10 (docs/planning/_archive/M20a.md, Design 8; C32, C36, C42, C44): what a session did between its
// messages, as entries of the same list.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityBody } from '@shared/contracts/activity';
import { CHAT_LINES, type ChatPush } from '@shared/contracts/chat';
import { type ConversationItem, itemText, WINDOW_ENTRIES } from '@shared/contracts/conversation';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { resetTabs } from '../artifacts/tabs-store';
import { SessionWindow } from '../shell/SessionWindow';
import { ChatRegion } from '../shell/ChatRegion';
import { approvalWith, cardWith, chatActivity, chatApproval, chatCard, chatItem, chatItems, chatTurn, type FakeChat, fakeChat } from '../test/chat';
import { installDialogStandIn } from '../test/dialog';
import { watchFocus } from '../test/focus';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { modedProvider } from '../test/permissions';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { CARD_WORDS } from './card-words';
import { useChatDrafts, useGroupChoices } from './chat-store';
import { showDetached } from './detached-store';
import { usePrefs } from '../state/prefs-store';
import { prefsSnapshot } from '../test/prefs';
import { formatTimeOfDay } from '../ui/format';
import { STORAGE_FAILING_TEXT } from './MessageList';
import { resetWaiting } from './questions-store';

const ROW = 20;
const VIEW = 10 * ROW;
/** How much taller the list's content is than its rows: what a message that is being written has grown by, for a test to set. */
let grown = 0;

/**
 * A layout for the list: each of its children one row, the list ten rows tall, its scroll position kept within what it holds.
 * An answer's foot is drawn into the space its last entry leaves below it, and takes no row here.
 */
function installLayout(): () => void {
  const proto = HTMLElement.prototype;
  const tops = new WeakMap<Element, number>();
  const isList = (element: Element): boolean => element.hasAttribute('data-chat-list');
  const rows = (list: Element): Element[] => [...list.children].filter((child) => !child.hasAttribute('data-run-foot'));
  const box = (top: number, height: number): DOMRect => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 300, width: 300, height, toJSON: () => ({}) });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return isList(this) ? rows(this).length * ROW + grown : 0; } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get(this: HTMLElement) { return isList(this) ? VIEW : 0; } });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) { return tops.get(this) ?? 0; },
    set(this: HTMLElement, value: number) { tops.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))); },
  });
  // Over Element's own, for as long as the test runs.
  proto.getBoundingClientRect = function getBoundingClientRect(this: HTMLElement): DOMRect {
    const list = this.closest('[data-chat-list]');
    if (list === null) return Element.prototype.getBoundingClientRect.call(this);
    if (list === this) return box(0, VIEW);
    const child = rows(list).find((candidate) => candidate.contains(this));
    return box((child === undefined ? 0 : rows(list).indexOf(child)) * ROW - list.scrollTop, ROW);
  };
  return () => {
    for (const name of ['scrollHeight', 'clientHeight', 'scrollTop', 'getBoundingClientRect']) Reflect.deleteProperty(proto, name);
  };
}

const A = project('Calamari', { providers: ['codex'] });
const CATALOG = { ...sampleCatalog([]), providers: [sampleCatalogProvider({ id: 'codex', models: [sampleModel({ key: 'gpt-6-sol', resolvedId: 'gpt-6-sol', name: 'GPT-6 Sol' })] })] };
const PROVIDERS = [sampleProvider({ id: 'codex', displayName: 'Codex' })];
const ONE = sessionEntry('Create plan', SUMMARIES.idle, { projectId: A.id, providerId: 'codex', model: 'gpt-6-sol', effort: 'high' });
const ID = ONE.record.id;

let bridge: FakeBridge;
let main: FakeChat;
let requests: [InvokeChannel, unknown][];
let withheld: Set<InvokeChannel>;
let waiting: (() => void)[];
let removeLayout: () => void;

beforeEach(() => {
  installDialogStandIn();
  grown = 0;
  usePrefs.setState({ snapshot: prefsSnapshot(), error: null, saving: false });
  removeLayout = installLayout();
  bridge = installFakeBridge();
  main = fakeChat(ID);
  requests = [];
  withheld = new Set();
  waiting = [];
  useChatDrafts.setState({ drafts: {} });
  showDetached(null);
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    const value = channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0]) : channel === 'chat:page' ? main.page(request as Parameters<FakeChat['page']>[0]) : channel === 'chat:send' ? { status: 'accepted' } : { status: 'saved' };
    const now = { ok: true, value };
    if (withheld.has(channel)) return new Promise((resolve) => { waiting.push(() => resolve(now)); });
    return Promise.resolve(now);
  });
});
afterEach(() => {
  cleanup();
  removeLayout();
});

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const release = () => act(() => { for (const answer of waiting.splice(0)) answer(); });
const push = (payload: ChatPush) => act(() => { bridge.push('chat:message', payload); });
const changed = async () => { main.revision += 1; push({ sessionId: ID, revision: main.revision, changed: true }); await settle(); };
const log = () => screen.getByRole('group', { name: 'Messages' });
const input = () => screen.getByRole('textbox', { name: 'Message to Codex' });
/** The prompt area's stops after the list (M100, C37, C41): the prompt-type bar's one, the input, and the microphone at its foot. */
// The prompt area's stops: the effort bar under the avatar at its left (M100, round 8; C76), then the prompt-type row, the input and its foot.
const promptStops = () => [screen.getByRole('button', { name: /^Effort: / }), screen.getByRole('button', { name: 'Plan' }), input(), screen.getByRole('button', { name: 'Dictation' })];
const answerStops = () => [screen.getAllByRole('button', { name: CHAT_LINES.copyConversation }).at(-1), screen.getAllByRole('button', { name: CHAT_LINES.copyAnswer }).at(-1)];
const articles = () => within(log()).queryAllByRole('article');
// The message's own text: the first line outside its head row, whether or not the head says a label (C82).
const textOf = (article: Element | undefined) => [...(article?.querySelectorAll('p') ?? [])].find((line) => line.closest('[data-head]') === null)?.textContent ?? '';
const messageNamed = (text: string) => articles().find((article) => textOf(article) === text) as HTMLElement;
const asked = (channel: InvokeChannel) => requests.filter(([name]) => name === channel).map(([, request]) => request);
/** A group the reader has open (round 9, C83): one whose items run keeps to its line, so a test that acts on a row opens it first, by the entry's first item. */
const openGroup = (first: ConversationItem) => { useGroupChoices.setState({ choices: { [first.id]: true } }); };
const earlierButton = () => within(log()).getByRole('button', { name: CHAT_LINES.showEarlier });
/** The first message any of which shows, as a reader sees it. */
const firstVisible = () => articles().find((article) => article.getBoundingClientRect().bottom > 0);
const scrollTo = (top: number) => { log().scrollTop = top; fireEvent.scroll(log()); };

async function open(count: number) {
  main.items = chatItems(ID, count);
  main.revision = count;
  act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
  render(<ChatRegion />);
  await settle();
}
const showEarlier = async () => { fireEvent.click(earlierButton()); await settle(); };

describe('older pages (V25; C58)', () => {
  it('copies the full conversation from any answer without paging or moving the displayed list', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
    try {
      await open(250);
      scrollTo(400);
      const shown = articles();
      const top = log().scrollTop;
      const button = within(log()).getAllByRole('button', { name: CHAT_LINES.copyConversation })[0] as HTMLElement;
      await act(async () => { fireEvent.click(button); await Promise.resolve(); });
      expect(written).toHaveLength(1);
      expect(written[0]).toContain(itemText(main.items[0] as ConversationItem));
      expect(written[0]).toContain(itemText(main.items.at(-1) as ConversationItem));
      expect(written[0]?.match(/^(You|GPT-6 Sol):$/gm)).toHaveLength(250);
      expect(articles()).toEqual(shown);
      expect(log().scrollTop).toBe(top);
      expect(asked('chat:page')).toHaveLength(2);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('offers them at its head only while the store holds older messages', async () => {
    await open(80);
    expect(within(log()).queryByRole('button', { name: CHAT_LINES.showEarlier })).toBeNull();
    cleanup();
    await open(250);
    expect(log().firstElementChild?.contains(earlierButton())).toBe(true);
    await showEarlier();
    await showEarlier();
    expect(articles()).toHaveLength(250);
    expect(within(log()).queryByRole('button', { name: CHAT_LINES.showEarlier })).toBeNull();
  });

  it('asks for one only from the control, never from scrolling', async () => {
    await open(250);
    for (const top of [900, 400, 0, 0, 600, 0]) scrollTo(top);
    fireEvent.wheel(log(), { deltaY: -500 });
    await settle();
    expect(asked('chat:page')).toEqual([]);
    expect(articles()).toHaveLength(100);
    await showEarlier();
    expect(asked('chat:page')).toEqual([{ sessionId: ID, before: main.items[150]?.id }]);
    expect(articles()).toHaveLength(200);
  });

  it('puts an older page in while the list is busy, and announces one line in its place, beside the list', async () => {
    await open(250);
    const list = log();
    expect(list.getAttribute('aria-busy')).toBe('false');
    const timeline: string[] = [];
    const note = (records: MutationRecord[]): void => {
      for (const record of records) {
        const event = record.type === 'attributes' ? (record.oldValue === 'true' ? 'idle' : 'busy') : [...record.addedNodes].some((node) => node.nodeName === 'ARTICLE') ? 'messages added' : null;
        if (event !== null && timeline.at(-1) !== event) timeline.push(event);
      }
    };
    const observer = new MutationObserver(note);
    observer.observe(list, { childList: true, attributes: true, attributeFilter: ['aria-busy'], attributeOldValue: true });
    withheld.add('chat:page');
    fireEvent.click(earlierButton());
    await settle();
    // Asked for, and not in yet.
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(CHAT_LINES.earlierLoaded(100))).toBeNull();
    release();
    withheld.delete('chat:page');
    await settle();
    note(observer.takeRecords());
    observer.disconnect();
    expect(articles()).toHaveLength(200);
    // The messages went in while it said it was busy, and only then did it stop saying so.
    expect(timeline).toEqual(['busy', 'messages added', 'idle']);
    expect(list.getAttribute('aria-busy')).toBe('false');
    const line = screen.getByText(CHAT_LINES.earlierLoaded(100));
    expect(line.closest('[role="status"]')).not.toBeNull();
    expect(list.contains(line)).toBe(false);
    // The last page of this conversation holds fewer.
    await showEarlier();
    expect(screen.getByText(CHAT_LINES.earlierLoaded(50))).toBeTruthy();
    expect(screen.queryByText(CHAT_LINES.earlierLoaded(100))).toBeNull();
  });

  it('is busy while a window is read again, and announces no line for it', async () => {
    await open(50);
    withheld.add('chat:read');
    await changed();
    expect(log().getAttribute('aria-busy')).toBe('true');
    release();
    await settle();
    expect(log().getAttribute('aria-busy')).toBe('false');
    expect(log().parentElement?.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('says at its foot that newer messages are not shown once it let go of them, and Show latest returns to the end', async () => {
    await open(700);
    for (let page = 0; page < 4; page += 1) await showEarlier();
    expect(log().textContent).not.toContain(CHAT_LINES.notLatest);
    await showEarlier();
    expect(articles()).toHaveLength(500);
    expect(log().lastElementChild?.textContent).toContain(CHAT_LINES.notLatest);
    expect(textOf(articles().at(-1))).toBe('message 600');
    fireEvent.click(within(log()).getByRole('button', { name: CHAT_LINES.showLatest }));
    await settle();
    expect(asked('chat:read').at(-1)).toEqual({ sessionId: ID });
    expect(articles()).toHaveLength(100);
    expect(textOf(articles().at(-1))).toBe('message 700');
    expect(log().textContent).not.toContain(CHAT_LINES.notLatest);
    // Shown from its end.
    expect(log().scrollTop).toBe(log().scrollHeight - VIEW);
  });

  it('shows the latest first when a prompt is sent from a window that let go of its newest', async () => {
    await open(700);
    for (let page = 0; page < 5; page += 1) await showEarlier();
    requests = [];
    fireEvent.change(input(), { target: { value: 'Go on' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();
    await settle();
    expect(requests).toEqual([['chat:read', { sessionId: ID }], ['chat:send', expect.objectContaining({ sessionId: ID, prompt: 'Go on', attachments: [] })]]);
    expect(textOf(articles().at(-1))).toBe('message 700');
    expect(log().textContent).not.toContain(CHAT_LINES.notLatest);
  });
});

describe('the reader’s place (V9, V27; C20, C60)', () => {
  it('shows the newest page from its end, and follows the end while the reader is there', async () => {
    await open(250);
    const list = log();
    expect(list.scrollTop).toBe(list.scrollHeight - VIEW);
    const next = chatItem(ID, 'assistant', 'next');
    main.items.push(next);
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, item: next, turn: chatTurn(next.turnId) });
    expect(list.scrollTop).toBe(list.scrollHeight - VIEW);
    expect(firstVisible()).not.toBe(articles()[0]);
    // A window read again that is taller at its end: a turn's line under the last message.
    main.turns.set(next.turnId, chatTurn(next.turnId, { state: 'unfinished', outcome: null }));
    const before = list.scrollHeight;
    await changed();
    expect(list.scrollHeight).toBe(before + ROW);
    expect(list.scrollTop).toBe(list.scrollHeight - VIEW);
  });

  it('keeps the first visible message where it is when older ones arrive, and leaves the focus in the input', async () => {
    await open(250);
    const list = log();
    input().focus();
    // At the head: the control's line, then the first message held, one row down.
    scrollTo(0);
    const first = messageNamed('message 151');
    expect(firstVisible()).toBe(first);
    expect(first.getBoundingClientRect().top).toBe(2 * ROW);
    await showEarlier();
    expect(articles()).toHaveLength(200);
    // It is where it was, and the page's last message shows above it, where the control's line was.
    expect(first.getBoundingClientRect().top).toBe(2 * ROW);
    expect(list.scrollTop).toBe(200 * ROW);
    expect(textOf(firstVisible())).toBe('message 150');
    expect(document.activeElement).toBe(input());
    // Half past a message: its offset is kept, not only which one it is.
    scrollTo(list.scrollTop + 30 * ROW + ROW / 2);
    const partly = firstVisible() as HTMLElement;
    const offset = partly.getBoundingClientRect().top;
    expect(offset).toBe(-ROW / 2);
    await showEarlier();
    expect(articles()).toHaveLength(250);
    expect(firstVisible()).toBe(partly);
    expect(partly.getBoundingClientRect().top).toBe(offset);
    expect(document.activeElement).toBe(input());
  });

  it('keeps the held window and the first visible message through an echo, a turn’s start and its end', async () => {
    await open(450);
    await showEarlier();
    await showEarlier();
    scrollTo(50 * ROW);
    const first = firstVisible() as HTMLElement;
    const top = log().scrollTop;
    const held = articles().map(textOf);
    for (const what of ['echo', 'start', 'end']) {
      if (what === 'echo') main.items[449] = { ...(main.items[449] as ConversationItem), providerItemId: 'item_1' };
      await changed();
      expect(asked('chat:read').at(-1)).toEqual({ sessionId: ID, from: main.items[150]?.id, keep: 'newest' });
      expect(articles().map(textOf)).toEqual(held);
      expect(firstVisible()).toBe(first);
      expect(log().scrollTop).toBe(top);
    }
    expect(asked('chat:page')).toHaveLength(2);
  });

  it('keeps the first visible message where it is when an import puts messages before it', async () => {
    await open(450);
    await showEarlier();
    scrollTo(120 * ROW);
    const first = firstVisible() as HTMLElement;
    const offset = first.getBoundingClientRect().top;
    const top = log().scrollTop;
    // Three messages of a turn made elsewhere, placed among those above the reader.
    const place = (main.items[260] as ConversationItem).order.turn;
    main.items.splice(260, 0, ...[0.25, 0.5, 0.75].map((step) => chatItem(ID, 'assistant', `imported ${step}`, { origin: 'provider', order: { turn: place - 1 + step, item: 0 } })));
    await changed();
    expect(articles()).toHaveLength(203);
    expect(firstVisible()).toBe(first);
    expect(first.getBoundingClientRect().top).toBe(offset);
    expect(log().scrollTop).toBe(top + 6 * ROW);
  });

  it('stays put when a message arrives while the reader is scrolled up', async () => {
    await open(250);
    scrollTo(10 * ROW);
    const first = firstVisible();
    const next = chatItem(ID, 'assistant', 'next');
    main.items.push(next);
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, item: next, turn: chatTurn(next.turnId) });
    expect(log().scrollTop).toBe(10 * ROW);
    expect(firstVisible()).toBe(first);
    expect(textOf(articles().at(-1))).toBe('next');
  });
});

describe('the lines that are not messages (V8, V9; C16, C18, C19)', () => {
  it('says under a turn what is known of an end that never came, and of what could not be saved', async () => {
    const [unacknowledged, unfinished, both, running, ended] = chatItems(ID, 5) as [ConversationItem, ConversationItem, ConversationItem, ConversationItem, ConversationItem];
    main.items = [unacknowledged, unfinished, both, { ...chatItem(ID, 'assistant', 'second of its turn'), turnId: both.turnId, order: { turn: both.order.turn, item: 1 } }, running, ended];
    main.turns.set(unacknowledged.turnId, chatTurn(unacknowledged.turnId, { state: 'unacknowledged', outcome: null }));
    main.turns.set(unfinished.turnId, chatTurn(unfinished.turnId, { state: 'unfinished', outcome: null }));
    main.turns.set(both.turnId, chatTurn(both.turnId, { state: 'unfinished', outcome: null, gap: true }));
    main.turns.set(running.turnId, chatTurn(running.turnId, { state: 'running', outcome: null }));
    act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
    render(<ChatRegion />);
    await settle();
    // In order: each turn's lines after the last of its items, a running or an ended turn with none.
    expect([...log().children].filter((child) => !child.matches('[data-speaker], [data-turn-progress], [data-run-foot]')).map((child) => (child.nodeName === 'ARTICLE' ? textOf(child) : child.textContent))).toEqual([
      'message 1', CHAT_LINES.unacknowledged('Codex'),
      'message 2', CHAT_LINES.unfinished,
      'message 3', 'second of its turn', CHAT_LINES.unfinished, CHAT_LINES.gap,
      'message 4',
      'message 5',
    ]);
    // The first two read alike but for the line, which claims no more than it knows (C15).
    expect(CHAT_LINES.unacknowledged('Codex')).not.toMatch(/not (sent|delivered)/);
  });

  it('says at its foot that part of the conversation could not be saved, and hides no message for it', async () => {
    main.storage = 'failing';
    await open(3);
    expect(log().lastElementChild?.textContent).toBe(STORAGE_FAILING_TEXT);
    expect(articles()).toHaveLength(3);
  });

  it('shows the lines together, each apart from the others', async () => {
    main.history = { state: 'failed', olderUnread: true, earlierMissing: true };
    main.storage = 'failing';
    await open(700);
    for (let page = 0; page < 5; page += 1) await showEarlier();
    const lines = [...log().children].filter((child) => child.nodeName === 'P').map((child) => child.textContent);
    expect(lines).toEqual([`${CHAT_LINES.historyFailed} Try again`, CHAT_LINES.olderUnread, CHAT_LINES.showEarlier, STORAGE_FAILING_TEXT, `${CHAT_LINES.notLatest} ${CHAT_LINES.showLatest}`]);
    expect(articles()).toHaveLength(500);
  });
});

// ── M19: the list while a message is written ──────────────────────────────────────────────────
// V16 (docs/planning/_archive/M19.md; C45, C46, C49, C50, C65): the reader's place through partial updates,
// the control at the foot, what an update leaves alone, what is announced, and the keyboard.
describe('while a message is written (M19: V16)', () => {
  /** Main as it is while a message is written: the item at the conversation's end, under a turn that runs. */
  function opening(text = ''): ConversationItem {
    const item = chatItem(ID, 'assistant', text, { state: 'streaming' });
    main.items.push(item);
    main.turns.set(item.turnId, chatTurn(item.turnId, { state: 'running', outcome: null, place: item.order.turn }));
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, item, turn: main.turnOf(item) });
    return item;
  }
  /** More of its text: main appends, the message is `rows` rows taller, and the partial push arrives. */
  function grow(item: ConversationItem, append: string, rows = 0): void {
    const at = main.items.findIndex((entry) => entry.id === item.id);
    const before = main.items[at]?.blocks[0]?.text ?? '';
    main.items[at] = { ...(main.items[at] as ConversationItem), blocks: [{ type: 'text', text: before + append, cut: false }] };
    main.revision += 1;
    grown += rows * ROW;
    push({ sessionId: ID, revision: main.revision, partial: { itemId: item.id, before: before.length, append } });
  }
  /** Its turn ends: main says that something changed, and the window read again holds the turn as over. */
  async function end(item: ConversationItem, outcome: 'completed' | 'interrupted' | 'failed', state: 'complete' | 'partial' = 'complete'): Promise<void> {
    const at = main.items.findIndex((entry) => entry.id === item.id);
    main.items[at] = { ...(main.items[at] as ConversationItem), state };
    main.turns.set(item.turnId, chatTurn(item.turnId, { state: 'ended', outcome, place: item.order.turn }));
    await changed();
  }
  const atEnd = () => log().scrollTop === log().scrollHeight - VIEW;
  const toEnd = () => screen.queryByRole('button', { name: new RegExp(`${CHAT_LINES.toEnd}|${CHAT_LINES.toEndNew}`) });
  const status = () => screen.getAllByRole('status').map((region) => region.textContent).filter((text) => text !== '');
  const current = () => articles().find((article) => article.hasAttribute('data-current'));
  const stops = () => [...screen.getByRole('main', { name: 'Chat' }).querySelectorAll<HTMLElement>('button, textarea, [tabindex]')].filter((element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled);

  describe('the reader’s place (C45, C46)', () => {
    it('keeps to the end through every partial update while the reader is there', async () => {
      await open(30);
      expect(atEnd()).toBe(true);
      const item = opening();
      expect(atEnd()).toBe(true);
      const before = log().scrollHeight;
      for (const piece of ['One line. ', 'And a second.\n\n', 'A new paragraph, ', 'which grows.']) {
        grow(item, piece, 2);
        expect(atEnd()).toBe(true);
      }
      expect(log().scrollHeight).toBe(before + 8 * ROW);
      expect(toEnd()).toBeNull();
    });

    it('moves nothing the reader looks at once they have scrolled away, and offers the way to the end, with word of what arrived since', async () => {
      await open(30);
      const item = opening('The start. ');
      scrollTo(120);
      const looking = firstVisible();
      const top = looking?.getBoundingClientRect().top;
      // Away from the end: the control is there, and nothing has arrived since.
      expect(toEnd()?.textContent).toBe(CHAT_LINES.toEnd);
      expect(toEnd()?.hasAttribute('data-arrived')).toBe(false);

      for (const piece of ['More. ', 'And more. ', 'And more still.']) grow(item, piece, 3);
      expect(log().scrollTop).toBe(120);
      expect(firstVisible()).toBe(looking);
      expect(looking?.getBoundingClientRect().top).toBe(top);
      expect(toEnd()?.textContent).toBe(CHAT_LINES.toEndNew);
      expect(toEnd()?.hasAttribute('data-arrived')).toBe(true);

      // It goes there, and is gone: the list follows the end again.
      fireEvent.click(toEnd() as HTMLElement);
      expect(atEnd()).toBe(true);
      expect(toEnd()).toBeNull();
      grow(item, ' The last of it.', 2);
      expect(atEnd()).toBe(true);
    });

    // Found in M106's walk: a group the reader closed brought the end into view with no scroll, and the way to the end stood on.
    it('lets the way to the end go once a press inside the list shrinks what it holds to bring its end into view, with no scroll; and keeps it while the list still runs on past its view', async () => {
      await open(30);
      scrollTo(120);
      expect(toEnd()).not.toBeNull();
      const drawn = () => act(async () => { await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); }); });
      // Something closed, and the list still runs on below its view.
      grown = -ROW;
      fireEvent.click(log());
      await drawn();
      expect(toEnd()).not.toBeNull();
      // Something closed that brings its end into view where the reader is: no scroll comes.
      grown = -(log().scrollHeight - grown - VIEW - 120);
      expect(log().scrollHeight - log().scrollTop - VIEW).toBe(0);
      fireEvent.click(log());
      await drawn();
      expect(toEnd()).toBeNull();
    });

    it('hands the focus to the list when the way to the end is pressed with the focus on it, since it leaves with its press', async () => {
      await open(30);
      scrollTo(120);
      (toEnd() as HTMLElement).focus();
      const focus = watchFocus();
      try {
        fireEvent.click(toEnd() as HTMLElement);
        expect(toEnd()).toBeNull();
        expect(document.activeElement).toBe(log());
        // The control left with its own press: the list takes the keyboard, and is not lit for it (ui/focus.ts).
        expect(focus.quiet(log())).toBe(true);
      } finally {
        focus.undo();
      }
      // Pressed while the focus is elsewhere, it moves none.
      scrollTo(120);
      const elsewhere = screen.getByRole('main', { name: 'Chat' }).querySelector('textarea') as HTMLTextAreaElement;
      elsewhere.focus();
      fireEvent.click(toEnd() as HTMLElement);
      expect(document.activeElement).toBe(elsewhere);
    });

    it('offers no such control at the end, and none in a window that let go of its newest: that one has Show latest', async () => {
      await open(WINDOW_ENTRIES + 200);
      expect(toEnd()).toBeNull();
      for (let page = 0; page < 5; page += 1) await showEarlier();
      scrollTo(200);
      expect(toEnd()).toBeNull();
      expect(log().textContent).toContain(CHAT_LINES.notLatest);
      // Something arrives that the window does not show: the line says so, and nothing in it moves.
      const before = articles();
      const item = opening();
      grow(item, 'Unseen.');
      expect(log().textContent).toContain(CHAT_LINES.notLatestNew);
      expect(articles()).toEqual(before);
      expect(log().scrollTop).toBe(200);
      expect(within(log()).getByRole('button', { name: CHAT_LINES.showLatest })).toBeDefined();
    });

    it('scrolls nothing while a pointer is held down in the list, and follows the end again once it is released', async () => {
      await open(30);
      const item = opening();
      expect(atEnd()).toBe(true);
      const held = log().scrollTop;
      fireEvent.pointerDown(log());
      for (const piece of ['Selected while ', 'it is ', 'written.']) grow(item, piece, 2);
      // The content grew under the pointer, and the list did not move.
      expect(log().scrollTop).toBe(held);
      expect(atEnd()).toBe(false);
      // Released, anywhere: the next update follows the end, where the reader was.
      fireEvent.pointerUp(window);
      grow(item, ' More.', 1);
      expect(atEnd()).toBe(true);
    });
  });

  describe('what an update changes (C65)', () => {
    it('draws the message that grew again, and leaves every other message, and every earlier block of that one, the nodes they were', async () => {
      await open(6);
      const item = opening('# A heading\n\nA first paragraph.\n\n');
      const others = articles().slice(0, 6);
      const inner = others.map((article) => [...article.querySelectorAll('*')]);
      const mine = articles().at(-1) as HTMLElement;
      const [heading, first] = [mine.querySelector('h1'), mine.querySelector('h1 + p')];
      expect(heading?.textContent).toBe('A heading');

      grow(item, 'A second paragraph that is ');
      grow(item, 'being written.');
      expect(articles().slice(0, 6)).toEqual(others);
      expect(articles().slice(0, 6).map((article) => [...article.querySelectorAll('*')])).toEqual(inner);
      expect(articles().at(-1)).toBe(mine);
      expect(mine.querySelector('h1')).toBe(heading);
      expect(mine.querySelector('h1 + p')).toBe(first);
      expect(mine.querySelector('h1 + p + p')?.textContent).toBe('A second paragraph that is being written.');
    });

    it('replaces the message in place at its completion, with the whole message’s text', async () => {
      await open(4);
      const item = opening();
      grow(item, 'Helo wrold');
      const mine = articles().at(-1);
      main.revision += 1;
      push({ sessionId: ID, revision: main.revision, item: { ...item, state: 'complete', blocks: [{ type: 'text', text: 'Hello, world.', cut: false }] }, turn: main.turnOf(item) });
      expect(articles()).toHaveLength(5);
      expect(articles().at(-1)).toBe(mine);
      expect(textOf(articles().at(-1))).toBe('Hello, world.');
      expect(mine?.getAttribute('data-state')).toBe('complete');
    });
  });

  describe('what is announced (C49)', () => {
    it('is no live region, and says nothing for a delta: only the turn’s end is said, once', async () => {
      await open(4);
      expect(log().getAttribute('aria-live')).toBeNull();
      expect(log().closest('[aria-live]')).toBeNull();
      const item = opening();
      for (const piece of ['One. ', 'Two. ', 'Three.']) grow(item, piece);
      expect(status()).toEqual([]);
      await end(item, 'completed');
      expect(status()).toEqual([CHAT_LINES.answerFinished]);
      // Read again for another reason: nothing is said twice, and the line stays the one it was.
      const said = screen.getAllByRole('status').flatMap((region) => [...region.querySelectorAll('span')]);
      await changed();
      expect(screen.getAllByRole('status').flatMap((region) => [...region.querySelectorAll('span')])).toEqual(said);
    });

    it('says that the answer was stopped for a turn that was', async () => {
      await open(4);
      const item = opening('Half an');
      await end(item, 'interrupted', 'partial');
      expect(status()).toEqual([CHAT_LINES.answerStopped]);
      expect(articles().at(-1)?.textContent).toContain(CHAT_LINES.incomplete);
    });

    it('says nothing when a chat is opened on a turn that had ended, or when the chat is switched', async () => {
      main.items = chatItems(ID, 4);
      main.revision = 4;
      for (const item of main.items) main.turns.set(item.turnId, chatTurn(item.turnId, { state: 'ended', outcome: 'completed' }));
      act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
      render(<ChatRegion />);
      await settle();
      expect(status()).toEqual([]);
      // Away, and back: the chat is read anew, and that says nothing either.
      act(() => { showState({ projects: [A], sessions: [ONE], selectedId: null, catalog: CATALOG, providers: PROVIDERS }); });
      await settle();
      act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
      await settle();
      expect(status()).toEqual([]);
      // An older page says its own one line, as before.
    });
  });

  describe('the keyboard (C50)', () => {
    it('is one stop in the tab order, whose current message is the newest: only that message’s controls are stops', async () => {
      await open(40);
      expect(log().tabIndex).toBe(0);
      expect(log().getAttribute('aria-activedescendant')).toBe(articles().at(-1)?.id);
      expect(current()).toBe(articles().at(-1));
      // Each prompt's Copy button; an answer of one part has none of its own, its foot's copying it all (the maintainer).
      const prompts = within(log()).getAllByRole('button', { name: CHAT_LINES.copyMessage });
      expect(prompts).toHaveLength(20);
      expect(within(log()).queryAllByRole('button', { name: CHAT_LINES.copyPart })).toEqual([]);
      const answers = within(log()).getAllByRole('button', { name: CHAT_LINES.copyAnswer });
      expect(answers).toHaveLength(20);
      const conversations = within(log()).getAllByRole('button', { name: CHAT_LINES.copyConversation });
      expect(conversations).toHaveLength(20);
      expect([...prompts, ...conversations, ...answers].filter((button) => button.tabIndex === 0)).toEqual(answerStops());
      // Tab goes from the list through the current answer's controls, its foot's, to the prompt area: forty messages are not forty stops.
      expect(stops()).toEqual([log(), ...answerStops(), ...promptStops()]);
    });

    it('moves its current message with Up and Down, Home and End, bringing it into view, and makes that message’s controls the stops', async () => {
      await open(40);
      const shown: string[] = [];
      HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { shown.push(this.id); };
      try {
        log().focus();
        const all = articles();
        fireEvent.keyDown(log(), { key: 'ArrowUp' });
        expect(current()).toBe(all.at(-2));
        expect(log().getAttribute('aria-activedescendant')).toBe(all.at(-2)?.id);
        expect(shown).toEqual([all.at(-2)?.id]);
        expect(stops()).toEqual([log(), within(all.at(-2) as HTMLElement).getByRole('button', { name: CHAT_LINES.copyMessage }), ...promptStops()]);
        fireEvent.keyDown(log(), { key: 'ArrowUp' });
        fireEvent.keyDown(log(), { key: 'ArrowDown' });
        expect(current()).toBe(all.at(-2));
        fireEvent.keyDown(log(), { key: 'Home' });
        expect(current()).toBe(all[0]);
        fireEvent.keyDown(log(), { key: 'ArrowUp' });
        expect(current()).toBe(all[0]);
        fireEvent.keyDown(log(), { key: 'End' });
        expect(current()).toBe(all.at(-1));
        fireEvent.keyDown(log(), { key: 'ArrowDown' });
        expect(current()).toBe(all.at(-1));
        // The focus never left the list.
        expect(document.activeElement).toBe(log());
      } finally {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    });

    it('keeps the newest as its current message as messages arrive, and stays on one the reader moved to', async () => {
      await open(6);
      const item = opening('A new answer');
      expect(current()).toBe(articles().at(-1));
      expect(textOf(current())).toBe('A new answer');
      fireEvent.keyDown(log(), { key: 'ArrowUp' });
      const chosen = current();
      grow(item, ', which grows');
      opening('And another');
      expect(current()).toBe(chosen);
      fireEvent.keyDown(log(), { key: 'End' });
      opening('The newest');
      expect(textOf(current())).toBe('The newest');
    });

    it('leaves a key pressed inside one of its controls to that control, and takes none with a modifier', async () => {
      await open(6);
      const before = current();
      fireEvent.keyDown(screen.getAllByRole('button', { name: CHAT_LINES.copyAnswer }).at(-1) as HTMLElement, { key: 'ArrowUp' });
      fireEvent.keyDown(log(), { key: 'ArrowUp', altKey: true });
      fireEvent.keyDown(log(), { key: 'ArrowUp', shiftKey: true });
      expect(current()).toBe(before);
    });

    it('keeps the list’s own controls stops as they are: Show earlier at its head', async () => {
      await open(250);
      expect(stops()[0]).toBe(log());
      expect(stops()).toContain(earlierButton());
      expect(stops().slice(-promptStops().length)).toEqual(promptStops());
    });
  });

  describe('times and elapsed, as the preferences say (V15; C41–C43)', () => {
    it('toggles message times independently of turn counters and updates user labels', async () => {
      main.items = chatItems(ID, 2);
      main.revision = 2;
      for (const item of main.items) main.turns.set(item.turnId, chatTurn(item.turnId, { state: 'ended', outcome: 'completed', time: { acceptedAt: 1, providerStartedAt: null, providerEndedAt: null, endReceivedAt: 2, providerDurationMs: null, elapsedMs: 4_200 } }));
      act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
      render(<ChatRegion />);
      await settle();
      const times = () => log().querySelectorAll('time').length;
      const elapsed = () => log().querySelectorAll('[data-turn-counter]').length;
      expect([times(), elapsed()]).toEqual([0, 1]);
      act(() => { usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: true, hoverMessageTimes: true, answerTimes: true, username: null } }, { kind: 'ok' }, 2) }); });
      expect([times(), elapsed()]).toEqual([2, 1]);
      act(() => { usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: true, hoverMessageTimes: true, answerTimes: true, username: 'Robin' } }, { kind: 'ok' }, 3) }); });
      expect([times(), elapsed()]).toEqual([2, 1]);
      expect(articles()[0]?.getAttribute('aria-label')).toBe('Robin');
      expect(log().querySelector('[data-turn-counter]')?.textContent).toBe('4s');
      act(() => { usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: null } }, { kind: 'ok' }, 4) }); });
      expect([times(), elapsed()]).toEqual([0, 1]);
      // What is kept never changed: the same messages, by the same elements.
      expect(articles()).toHaveLength(2);
    });
  });
});

// ── M19b ──────────────────────────────────────────────────────────────────────────────────────
// V9 (docs/planning/_archive/M19b.md; C12, C58): a tab opened from the chat moves nothing of the chat's, and a
// reference's control is a stop only in the list's current message.
describe('references in the list (M19b: V9; C12, C58)', () => {
  const README = 'D:\\Code\\Calamari\\README.md';
  const stops = () => [...screen.getByRole('main', { name: 'Chat' }).querySelectorAll<HTMLElement>('button, textarea, [tabindex]')].filter((element) => element.tabIndex === 0 && !element.hasAttribute('disabled'));
  const controls = (article: Element | undefined) => [...(article?.querySelectorAll<HTMLButtonElement>('[data-reference] > button') ?? [])];

  /** A conversation of `count` messages, each answer naming a file and a site. */
  async function openWithReferences(count: number) {
    main.items = Array.from({ length: count }, (_, index) => chatItem(ID, index % 2 === 0 ? 'user' : 'assistant', index % 2 === 0 ? `prompt ${index + 1}` : `Answer ${index + 1}: see \`README.md\` and [the site](https://example.com/${index + 1}).`));
    main.revision = count;
    act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
    render(<SessionWindow />);
    await settle();
  }

  beforeEach(() => {
    resetTabs();
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      const value = channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0])
        : channel === 'files:read' ? { outcome: 'text', path: README, root: 'D:\\Code\\Calamari', view: 'markdown', text: '# Calamari\n\nThe file.\n', revision: null, line: null, column: null }
          : { status: 'saved' };
      return Promise.resolve({ ok: true, value });
    });
  });

  it('makes the current message’s reference controls stops, and no other message’s', async () => {
    await openWithReferences(40);
    const current = articles().at(-1);
    expect(controls(current).map((button) => button.tabIndex)).toEqual([0, 0]);
    expect(articles().slice(0, -1).flatMap((article) => controls(article)).every((button) => button.tabIndex === -1)).toBe(true);
    // Tab goes from the list through the current message's controls and its answer's foot to the prompt area: twenty answers are not forty stops.
    expect(stops()).toEqual([log(), ...controls(current), ...answerStops(), ...promptStops()]);
  });

  it('moves the stops with the current message', async () => {
    await openWithReferences(8);
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    const current = articles().at(-3);
    expect(controls(current).map((button) => button.tabIndex)).toEqual([0, 0]);
    expect(controls(articles().at(-1)).map((button) => button.tabIndex)).toEqual([-1, -1]);
  });

  it('leaves the focus, the caret, a draft and the list’s place as they were when a tab is opened from the chat', async () => {
    await openWithReferences(60);
    scrollTo(300);
    const place = log().scrollTop;
    const first = firstVisible();
    fireEvent.change(input(), { target: { value: 'a draft, half typed' } });
    const area = input() as HTMLTextAreaElement;
    act(() => { area.focus(); area.setSelectionRange(3, 7); });

    // A press on a reference in a message that shows: its file opens beside the chat.
    const pressed = controls(articles().find((article) => controls(article).length > 0 && article.getBoundingClientRect().bottom > 0))[0];
    await act(async () => { fireEvent.click(pressed as Element); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    const pane = screen.getByRole('region', { name: 'Artifacts' });
    expect(within(pane).getByRole('tab').textContent).toBe('// README.md×');
    expect(within(pane).getByRole('heading', { level: 1 }).textContent).toBe('Calamari');

    expect(document.activeElement).toBe(area);
    expect([area.selectionStart, area.selectionEnd]).toEqual([3, 7]);
    expect(area.value).toBe('a draft, half typed');
    expect(useChatDrafts.getState().drafts[ID]).toBe('a draft, half typed');
    expect(log().scrollTop).toBe(place);
    expect(firstVisible()).toBe(first);

    // And selecting or closing a tab from the pane leaves the chat where it is, too.
    fireEvent.click(within(pane).getByRole('button', { name: 'Close README.md' }));
    expect(log().scrollTop).toBe(place);
    expect(area.value).toBe('a draft, half typed');
  });
});

// ── M20a: what a session did, in the list ─────────────────────────────────────────────────────

describe('what a session did between its messages (M20a: V9, V10; C32, C36, C42, C44)', () => {
  const current = () => articles().find((article) => article.hasAttribute('data-current'));
  const groups = () => articles().filter((article) => article.getAttribute('data-role') === 'activity');
  const rowsOf = (group: Element | undefined) => [...(group?.querySelectorAll('[data-activity]') ?? [])];
  const headOf = (group: Element | undefined) => group?.querySelector('button') as HTMLButtonElement;
  const stops = () => [...screen.getByRole('main', { name: 'Chat' }).querySelectorAll<HTMLElement>('button, textarea, [tabindex]')].filter((element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled);

  /** A turn: its prompt, what it did, and its answer. */
  function turnOf(turnId: string, work: readonly Parameters<typeof chatActivity>[2][]): ConversationItem[] {
    return [
      chatItem(ID, 'user', `prompt of ${turnId}`, { turnId }),
      ...work.map((body) => chatActivity(ID, turnId, body)),
      chatItem(ID, 'assistant', `answer of ${turnId}`, { turnId }),
    ];
  }
  async function openWith(items: readonly ConversationItem[]) {
    main.items = [...items];
    main.revision = items.length;
    act(() => { showState({ projects: [A], sessions: [ONE], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
    render(<SessionWindow />);
    await settle();
  }
  /** Main pushes one item of the session's own, or of a worker's. */
  function pushItem(item: ConversationItem, workerId?: string): void {
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, item, turn: chatTurn(item.turnId, { state: 'running', outcome: null }), ...(workerId === undefined ? {} : { workerId }) });
  }

  beforeEach(() => {
    resetTabs();
    useGroupChoices.setState({ choices: {} });
  });

  it('draws the consecutive activities of a turn as one entry between its messages, closed, with its summary line', async () => {
    await openWith([...turnOf('t-a', [{ type: 'read', summary: 'README.md' }, { type: 'read', summary: 'sample.txt' }, { type: 'command', summary: 'rg --files' }]), ...turnOf('t-b', [{ type: 'search', summary: 'tide' }])]);
    expect(articles().map((article) => article.getAttribute('data-role'))).toEqual(['user', 'activity', 'assistant', 'user', 'activity', 'assistant']);
    expect(groups().map((group) => headOf(group).textContent)).toEqual(['Read 2 files, ran 1 command · 1 s', 'Searched once · 1 s']);
    // Closed: its line alone (C44).
    expect(groups().flatMap(rowsOf)).toEqual([]);
    // Each is a child of the list as a message is: an anchor of its place.
    expect(groups().every((group) => group.parentElement === log())).toBe(true);
  });

  it('keeps two groups of one turn apart where a message stands between them, and one of each turn where none does', async () => {
    const turn = 't-c';
    await openWith([
      chatItem(ID, 'user', 'a prompt', { turnId: turn }),
      chatActivity(ID, turn, { type: 'read' }),
      chatItem(ID, 'assistant', 'a note', { turnId: turn, phase: 'commentary' }),
      chatActivity(ID, turn, { type: 'command' }),
      chatActivity(ID, turn, { type: 'command' }),
      chatItem(ID, 'assistant', 'the answer', { turnId: turn }),
    ]);
    expect(groups().map((group) => headOf(group).textContent)).toEqual(['Read 1 file · 1 s', 'Ran 2 commands · 1 s']);
  });

  // M100 (round 9, C82): one label per run of the same speaker, what the model did between two of its answers breaking none.
  it('says who speaks when the speaker changes and no more, and names every message for a reader who hears it', async () => {
    const turn = 't-f';
    await openWith([
      chatItem(ID, 'user', 'a prompt', { turnId: turn }),
      chatActivity(ID, turn, { type: 'read' }),
      chatItem(ID, 'assistant', 'a note', { turnId: turn, phase: 'commentary' }),
      chatActivity(ID, turn, { type: 'command' }),
      chatItem(ID, 'assistant', 'the answer', { turnId: turn }),
      ...turnOf('t-g', [{ type: 'search', summary: 'tide' }]),
    ]);
    // What each entry of the list says of its speaker: the label in a message's head, or the line that stands above an entry that is no message.
    const said = (article: Element) => article.querySelector('[data-head] p')?.textContent
      ?? (article.previousElementSibling?.hasAttribute('data-speaker') === true ? article.previousElementSibling.querySelector('[title]')?.textContent : null);
    expect(articles().map((article) => [article.getAttribute('data-role'), said(article)])).toEqual([
      ['user', 'You'],
      // The model's run begins at its commands: the name stands above them, never after them.
      ['activity', 'GPT-6 Sol'],
      ['assistant', null],
      ['activity', null],
      ['assistant', null],
      // The next prompt changes the speaker, and the model is named above its work again.
      ['user', 'You'],
      ['activity', 'GPT-6 Sol'],
      ['assistant', null],
    ]);
    // One line and no more for the run, and it is the list's own child, before the group: no stop of the keyboard's and no anchor of its place.
    const lines = [...log().querySelectorAll('[data-speaker]')];
    expect(lines.map((line) => [line.querySelector('[title]')?.textContent, line.nextElementSibling?.getAttribute('data-role')])).toEqual([['You', 'user'], ['GPT-6 Sol', 'activity'], ['You', 'user'], ['GPT-6 Sol', 'activity']]);
    expect(lines.every((line) => line.parentElement === log() && line.tagName === 'DIV')).toBe(true);
    // Every message is named for a reader who hears the list, labelled or not.
    expect(articles().filter((article) => article.getAttribute('data-role') !== 'activity').map((article) => article.getAttribute('aria-label')))
      .toEqual(['You', 'GPT-6 Sol', 'GPT-6 Sol', 'You', 'GPT-6 Sol']);
    // A message that says nothing in its head has a bare one, which takes no room: no empty line stands where its label was.
    expect(articles().filter((article) => article.getAttribute('data-role') !== 'activity').map((article) => article.querySelector('[data-head]')?.getAttribute('data-head')))
      .toEqual(['bare', 'bare', 'bare', 'bare', 'bare']);
  });

  it('ends an answer told in parts with one foot, which says its turn’s time and copies every part of its text (the maintainer)', async () => {
    const turn = 't-parts';
    const since = new Date(2020, 1, 21, 8, 53).getTime();
    const end = since + 152_000;
    main.turns.set(turn, chatTurn(turn, { time: { acceptedAt: since, providerStartedAt: null, providerEndedAt: null, endReceivedAt: end, providerDurationMs: null, elapsedMs: 152_000 } }));
    await openWith([
      chatItem(ID, 'user', 'Find the tides.', { turnId: turn }),
      chatItem(ID, 'assistant', 'Let me look.', { turnId: turn, phase: 'commentary' }),
      chatActivity(ID, turn, { type: 'search', summary: 'tide' }),
      chatItem(ID, 'assistant', 'The tides are in **tides.js**.', { turnId: turn }),
    ]);
    // The prompt's run has none; the answer's stands after its last entry, a child of the list and no entry of it.
    const feet = [...log().querySelectorAll<HTMLElement>('[data-run-foot]')];
    expect(feet).toHaveLength(1);
    expect(feet[0]?.previousElementSibling).toBe(articles().at(-1));
    expect(feet[0]?.textContent).toContain(`→ ${formatTimeOfDay(end)} (2m32s) · completed `);
    act(() => { usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: false, hoverMessageTimes: true, answerTimes: false, username: null } }, { kind: 'ok' }, 2) }); });
    expect(feet[0]?.textContent).not.toContain('completed ');
    expect(within(feet[0] as HTMLElement).getByRole('button', { name: CHAT_LINES.copyAnswer })).toBeTruthy();
    act(() => { usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: false, hoverMessageTimes: true, answerTimes: true, username: null } }, { kind: 'ok' }, 3) }); });
    expect(feet[0]?.textContent).toContain('completed ');
    // Each part keeps its own Copy button, for itself alone.
    expect(articles().filter((article) => article.getAttribute('data-role') === 'assistant').map((article) => within(article).getAllByRole('button', { name: CHAT_LINES.copyPart }).length)).toEqual([1, 1]);
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
    try {
      await act(async () => { fireEvent.click(within(feet[0] as HTMLElement).getByRole('button', { name: CHAT_LINES.copyAnswer })); await Promise.resolve(); });
      expect(written).toEqual(['Let me look.\n\nThe tides are in **tides.js**.']);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('gives an answer of one part no Copy button of its own: its foot’s copies the same (the maintainer)', async () => {
    await openWith(turnOf('t-one', [{ type: 'search', summary: 'tide' }]));
    const answer = articles().at(-1) as HTMLElement;
    expect(within(answer).queryByRole('button', { name: CHAT_LINES.copyPart })).toBeNull();
    // Nor the room above its first block that a Copy button there would take.
    expect(answer.querySelector('[data-copy]')).toBeNull();
    expect(screen.getAllByRole('button', { name: CHAT_LINES.copyAnswer })).toHaveLength(1);
    // A second part gives each its own.
    act(() => { pushItem(chatItem(ID, 'assistant', 'And one more thing.', { turnId: 't-one' })); });
    await settle();
    expect(articles().filter((article) => article.getAttribute('data-role') === 'assistant').map((article) => within(article).queryAllByRole('button', { name: CHAT_LINES.copyPart }).length)).toEqual([1, 1]);
  });

  it('is one entry for Up and Down, and its own controls are stops only while it is the current one (C42)', async () => {
    await openWith(turnOf('t-d', [{ type: 'read', summary: 'README.md', status: 'failed', files: [{ path: 'README.md', line: null }] }, { type: 'command', summary: 'rg', input: 'rg --files' }]));
    const [prompt, group, answer] = articles();
    expect(current()).toBe(answer);
    // No group opens by itself: the reader opens this one, which is not the current entry; its controls are then there, and none is a stop.
    act(() => { fireEvent.click(headOf(group)); });
    expect(rowsOf(group)).toHaveLength(2);
    expect([...(group?.querySelectorAll('button') ?? [])].every((button) => button.tabIndex === -1)).toBe(true);
    log().focus();
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(current()).toBe(group);
    expect(log().getAttribute('aria-activedescendant')).toBe(group?.id);
    // Its line, each row's disclosure and the file's control: stops now, and the answer's part's Copy is not. The answer's foot's
    // is: the group is of that answer.
    const own = [...(group?.querySelectorAll('button') ?? [])];
    expect(own.length).toBe(4);
    expect(own.every((button) => button.tabIndex === 0)).toBe(true);
    expect(stops()).toEqual([log(), ...own, ...answerStops(), ...promptStops()]);
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(current()).toBe(prompt);
    expect(own.every((button) => button.tabIndex === -1)).toBe(true);
    fireEvent.keyDown(log(), { key: 'End' });
    expect(current()).toBe(answer);
    expect(document.activeElement).toBe(log());
  });

  it('is no entry where it holds thinking alone: nothing is drawn of it, and the keyboard passes it by (C9)', async () => {
    const turn = 't-e';
    await openWith([chatItem(ID, 'user', 'a prompt', { turnId: turn }), chatActivity(ID, turn, { type: 'thinking' }), chatItem(ID, 'assistant', 'the answer', { turnId: turn })]);
    expect(articles().map((article) => article.getAttribute('data-role'))).toEqual(['user', 'assistant']);
    log().focus();
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(current()).toBe(articles()[0]);
  });

  it('puts its turn’s lines after the turn’s last entry, a group included', async () => {
    const turn = 't-f';
    main.turns.set(turn, chatTurn(turn, { state: 'ended', outcome: 'interrupted', gap: true }));
    await openWith([chatItem(ID, 'user', 'a prompt', { turnId: turn }), chatActivity(ID, turn, { type: 'command', status: 'unfinished' })]);
    const [, group] = articles();
    expect(group?.getAttribute('data-role')).toBe('activity');
    // The line that says part of the turn is missing follows the group, as it follows a message.
    expect(group?.nextElementSibling?.tagName).toBe('P');
    expect(log().lastElementChild).not.toBe(group);
  });

  it('takes an activity as it starts and as it ends by its push, reading nothing again, and keeps to the end (C32, C44)', async () => {
    const turn = 't-g';
    await openWith([chatItem(ID, 'user', 'a prompt', { turnId: turn })]);
    const reads = asked('chat:read').length;
    const running = chatActivity(ID, turn, { type: 'command', summary: 'npm test', status: 'running' }, { time: { receivedAt: Date.now(), providerAt: null } });
    pushItem(running);
    const [group] = groups();
    // Closed while it runs, its line alone, and busy: it does not open at an action's start (round 9, C83).
    expect(headOf(group).getAttribute('aria-expanded')).toBe('false');
    expect(group?.getAttribute('aria-busy')).toBe('true');
    expect(rowsOf(group)).toEqual([]);
    // The reader opens it to watch: what arrives after that is drawn in its rows.
    act(() => { fireEvent.click(headOf(group)); });
    expect(rowsOf(groups()[0]).map((row) => row.getAttribute('data-status'))).toEqual(['running']);
    const second = chatActivity(ID, turn, { type: 'read', summary: 'sample.txt', status: 'running' }, { time: { receivedAt: Date.now(), providerAt: null } });
    pushItem(second);
    expect(groups()).toHaveLength(1);
    const [commandRow, readRow] = rowsOf(groups()[0]);
    // Its end: the same item, as it now is, in place. The other row is the node it was.
    pushItem({ ...running, state: 'complete', activity: { ...(running.activity as ActivityBody), status: 'completed', duration: { ms: 2_000, provenance: 'local' } } });
    expect(rowsOf(groups()[0])).toEqual([commandRow, readRow]);
    expect(rowsOf(groups()[0]).map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'running']);
    pushItem({ ...second, state: 'complete', activity: { ...(second.activity as ActivityBody), status: 'completed', duration: { ms: 1_000, provenance: 'local' } } });
    // Every item ended without failure: nothing runs, and the reader's own opening stands (C36).
    expect(headOf(groups()[0]).getAttribute('aria-expanded')).toBe('true');
    expect(groups()[0]?.getAttribute('aria-busy')).toBeNull();
    expect(asked('chat:read')).toHaveLength(reads);
    expect(log().scrollTop).toBe(Math.max(0, log().scrollHeight - VIEW));
  });

  it('passes a worker’s pushes by: its revision is taken, nothing of it is shown, and nothing is read again (C32)', async () => {
    const turn = 't-h';
    await openWith([chatItem(ID, 'user', 'a prompt', { turnId: turn })]);
    const reads = asked('chat:read').length;
    const before = log().innerHTML;
    const theirs = chatActivity(ID, turn, { type: 'read', summary: 'notes-3.txt', status: 'running' }, { workerId: 'worker-1' });
    pushItem(theirs, 'worker-1');
    pushItem(chatItem(ID, 'assistant', 'The worker’s report.', { turnId: turn, workerId: 'worker-1', phase: null }), 'worker-1');
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, partial: { itemId: 'no-item-of-the-list', before: 0, append: 'more' }, workerId: 'worker-1' });
    expect(log().innerHTML).toBe(before);
    expect(asked('chat:read')).toHaveLength(reads);
    // The next push of the session's own follows on at once: no revision was missed.
    pushItem(chatActivity(ID, turn, { type: 'worker', summary: 'Worker 1', status: 'running', workerId: 'worker-1' }));
    expect(groups()).toHaveLength(1);
    expect(asked('chat:read')).toHaveLength(reads);
  });

  // M106 (V7; C4): the worker's own tab retired; its thread unfolds in the Sub-agents tab.
  it('chooses the sub-agent in the Sub-agents tab beside the chat from its row’s Open button, and leaves the focus, a draft and the list’s place as they were (C40, C47; M106, C4)', async () => {
    const turn = 't-i';
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      const value = channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0])
        : channel === 'chat:readWorker' ? { status: 'read', sessionId: ID, workerId: 'worker-1', revision: main.revision, worker: main.items.find((item) => item.activity?.type === 'worker') ?? null, items: [], turns: [], older: null }
          : { status: 'saved' };
      return Promise.resolve({ ok: true, value });
    });
    const worker = chatActivity(ID, turn, { type: 'worker', summary: 'Read the notes', status: 'running', workerId: 'worker-1' });
    openGroup(worker);
    await openWith([...chatItems(ID, 40), chatItem(ID, 'user', 'a prompt', { turnId: turn }), worker]);
    scrollTo(300);
    const place = log().scrollTop;
    fireEvent.change(input(), { target: { value: 'a draft' } });
    const area = input() as HTMLTextAreaElement;
    act(() => { area.focus(); });
    const openButton = within(groups()[0] as HTMLElement).getByRole('button', { name: 'Open' });
    await act(async () => { fireEvent.click(openButton); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    const pane = screen.getByRole('region', { name: 'Artifacts' });
    // Its title is the tab's, which has no ×; the thread is the sub-agent's, read by its id.
    expect(within(pane).getByRole('tab').textContent).toBe('// Sub-agents');
    expect(within(pane).getByRole('tab').getAttribute('aria-selected')).toBe('true');
    expect(pane.querySelector('[data-agent-thread="worker-1"] [data-worker-list]')).toBeTruthy();
    expect(asked('chat:readWorker')).toEqual([{ sessionId: ID, workerId: 'worker-1' }]);
    expect(document.activeElement).toBe(area);
    expect(area.value).toBe('a draft');
    expect(log().scrollTop).toBe(place);
    // Pressed again, it selects the tab that is open: one tab a session (M19b, C8).
    await act(async () => { fireEvent.click(openButton); await Promise.resolve(); });
    expect(within(pane).getAllByRole('tab')).toHaveLength(1);
  });
});

// M21, V9, V10, V27, V29, V30 (C37, C39, C40, C42, C43, C49, C71, C73, C74): a question's card, as an
// entry of the list.
describe('a question the session asks (M21: V9, V10, V27, V29, V30)', () => {
  const current = () => articles().find((article) => article.hasAttribute('data-current'));
  const cards = () => articles().filter((article) => article.hasAttribute('data-interaction'));
  const stops = () => [...screen.getByRole('main', { name: 'Chat' }).querySelectorAll<HTMLElement>('button, textarea, input, [tabindex]')].filter((element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled);
  /** The one line said beside the list, and the element that says it. */
  const said = () => (log().parentElement?.nextElementSibling as HTMLElement).querySelector('span');
  const foot = () => screen.queryByRole('button', { name: /go to the latest/i });
  const TITLES = [{ title: 'Which file do you want me to read?', options: ['notes-1.txt', 'notes-2.txt'] }];

  async function openWith(items: readonly ConversationItem[]) {
    main.items = [...items];
    main.revision = items.length;
    // A session whose turn runs, on the model the catalog names.
    act(() => { showState({ projects: [A], sessions: [{ ...ONE, summary: { ...SUMMARIES.runningThinking, model: ONE.summary.model, effort: ONE.summary.effort } }], selectedId: ID, catalog: CATALOG, providers: PROVIDERS }); });
    render(<SessionWindow />);
    await settle();
  }
  function pushItem(item: ConversationItem, workerId?: string): void {
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, item, turn: chatTurn(item.turnId, { state: 'running', outcome: null }), ...(workerId === undefined ? {} : { workerId }) });
  }
  const settled = (item: ConversationItem, outcome: 'answered' | 'withdrawn'): ConversationItem => cardWith(item, { outcome, settledAt: 9, ...(outcome === 'answered' ? { answers: [{ options: [0], text: null, secret: false }], confirmedAt: 10 } : { withdrawnBy: 'turn' as const }) });

  beforeEach(() => {
    resetTabs();
    resetWaiting();
    useGroupChoices.setState({ choices: {} });
  });

  it('draws a card at its item’s place, one entry of the list, named by who asks (C37)', async () => {
    const turn = 't-q';
    await openWith([chatItem(ID, 'user', 'Read a note.', { turnId: turn }), chatCard(ID, turn), chatItem(ID, 'assistant', 'Read it.', { turnId: turn })]);
    expect(articles().map((article) => article.getAttribute('data-role') ?? '')).toEqual(['user', 'interaction', 'assistant']);
    expect(cards()[0]?.getAttribute('aria-label')).toBe('GPT-6 Sol asks a question');
    expect(within(cards()[0] as HTMLElement).getAllByRole('radio')).toHaveLength(2);
  });

  it('draws no message where a card draws its questions, the card standing for it, and keeps a message’s lines where no card does (C40; decision 0026, item 2)', async () => {
    const turn = 't-a';
    // Made in the order they are stored in. The CLI's text is its own copy of the questions.
    const prompt = chatItem(ID, 'user', 'Read a note.', { turnId: turn });
    const asking = chatItem(ID, 'assistant', 'Which file do you want me to read?\n- notes-1.txt\n- notes-2.txt', { turnId: turn, providerItemId: 'item-q', questions: TITLES });
    const itsCard = chatCard(ID, turn, { mode: 'async', outcome: 'open' }, { providerItemId: 'item-q' });
    const plain = chatItem(ID, 'assistant', 'A worker’s question, relayed.', { providerItemId: 'item-w', questions: TITLES });
    await openWith([prompt, asking, itsCard, plain]);
    expect(articles().map((article) => article.getAttribute('data-role') ?? '')).toEqual(['user', 'interaction', 'assistant']);
    const [, card, without] = articles();
    expect(card?.textContent).toContain('Which file should I read?');
    expect(articles().some((article) => article.textContent?.includes('- notes-1.txt'))).toBe(false);
    // No card ever exists for it: its plain lines stay, as M15 drew them.
    expect(without?.textContent).toContain('Which file do you want me to read?');
    expect(without?.textContent).toContain('notes-2.txt');
  });

  it('draws the message again where its card is not in the list', async () => {
    const turn = 't-b';
    // Made in the order they are stored in.
    const prompt = chatItem(ID, 'user', 'Read a note.', { turnId: turn });
    const asking = chatItem(ID, 'assistant', 'Which file do you want me to read?\n- notes-1.txt\n- notes-2.txt', { turnId: turn, providerItemId: 'item-q', questions: TITLES });
    await openWith([prompt, asking]);
    expect(articles().map((article) => article.getAttribute('data-role') ?? '')).toEqual(['user', 'assistant']);
    expect(articles()[1]?.textContent).toContain('notes-2.txt');
  });

  it('is one entry for Up and Down, and its controls are stops only while it is the current one (V10; C43)', async () => {
    const turn = 't-k';
    await openWith([chatItem(ID, 'user', 'Read a note.', { turnId: turn }), chatCard(ID, turn), chatItem(ID, 'assistant', 'Read it.', { turnId: turn })]);
    const [, card, answer] = articles();
    expect(current()).toBe(answer);
    const own = () => [...(card as HTMLElement).querySelectorAll<HTMLElement>('input, textarea, button')];
    expect(own().every((control) => control.tabIndex === -1)).toBe(true);
    log().focus();
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(current()).toBe(card);
    expect(log().getAttribute('aria-activedescendant')).toBe(card?.id);
    expect(own().every((control) => control.tabIndex === 0)).toBe(true);
    // Tab goes from the list through the card's own controls to the input: each group is labelled by its question.
    expect(stops().filter((stop) => (card as HTMLElement).contains(stop))).toEqual(own());
    expect(within(card as HTMLElement).getByRole('group').textContent).toContain('Which file should I read?');
    // A key pressed in one of its controls is that control's: the radios keep their arrows.
    fireEvent.keyDown(own()[0] as HTMLElement, { key: 'ArrowDown' });
    expect(current()).toBe(card);
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(own().every((control) => control.tabIndex === -1)).toBe(true);
    expect(document.activeElement).toBe(log());
  });

  // M100b, V3 (C15): a number key pressed on the list picks a row of its current card, and of no other entry.
  it('passes a number key on to its current entry where that is a waiting card, and to nothing otherwise', async () => {
    const turn = 't-n';
    await openWith([chatItem(ID, 'user', 'Read a note.', { turnId: turn }), chatCard(ID, turn), chatItem(ID, 'assistant', 'Read it.', { turnId: turn })]);
    const [, card] = articles();
    const radios = () => within(card as HTMLElement).getAllByRole<HTMLInputElement>('radio');
    log().focus();
    // The answer is current: the key is no card's.
    fireEvent.keyDown(log(), { key: '2' });
    expect(radios().map((radio) => radio.checked)).toEqual([false, false]);
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(current()).toBe(card);
    fireEvent.keyDown(log(), { key: '2' });
    expect(radios().map((radio) => radio.checked)).toEqual([false, true]);
    // A key past its rows is nothing; the focus stays on the list.
    fireEvent.keyDown(log(), { key: '9' });
    expect(radios().map((radio) => radio.checked)).toEqual([false, true]);
    expect(document.activeElement).toBe(log());
  });

  it('posts a raised blocking question once to the status region, in words, and moves no focus; the foot says new below for a raising and not for an outcome (V10; C39, C43)', async () => {
    const turn = 't-r';
    await openWith([...chatItems(ID, 40), chatItem(ID, 'user', 'Read a note.', { turnId: turn })]);
    act(() => { input().focus(); });
    scrollTo(300);
    const place = log().scrollTop;
    expect(foot()?.textContent).toBe(CHAT_LINES.toEnd);
    const card = chatCard(ID, turn);
    pushItem(card);
    expect(said()?.textContent).toBe('GPT-6 Sol asks a question');
    const line = said();
    expect(document.activeElement).toBe(input());
    expect(log().scrollTop).toBe(place);
    expect(foot()?.textContent).toBe(CHAT_LINES.toEndNew);
    // Its outcome's push redraws it in place: nothing is posted again, the reader is not moved, and nothing new is below.
    fireEvent.click(foot() as HTMLElement);
    scrollTo(300);
    expect(foot()?.textContent).toBe(CHAT_LINES.toEnd);
    pushItem(settled(card, 'answered'));
    expect(cards()[0]?.dataset['outcome']).toBe('answered');
    expect(cards()[0]?.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(within(cards()[0] as HTMLElement).getByRole('button', { name: CARD_WORDS.showAnswers }).getAttribute('aria-expanded')).toBe('false');
    expect(said()).toBe(line);
    expect(foot()?.textContent).toBe(CHAT_LINES.toEnd);
    expect(log().scrollTop).toBe(300);
    expect(document.activeElement).toBe(input());
  });

  it('posts nothing for an async card’s arrival, nor for a card a read brings (C5, C43)', async () => {
    const turn = 't-s';
    await openWith([chatItem(ID, 'user', 'Read a note.', { turnId: turn }), chatCard(ID, turn)]);
    expect(said()).toBeNull();
    pushItem(chatCard(ID, turn, { mode: 'async', outcome: 'open' }));
    expect(said()).toBeNull();
    expect(cards()).toHaveLength(2);
  });

  it('redraws a card settled while the reader looks at earlier messages: inert, in place, the first visible message where it was (V27; C71)', async () => {
    const turn = 't-p';
    const card = chatCard(ID, turn, { mode: 'async', outcome: 'open' });
    await openWith([chatItem(ID, 'user', 'Read a note.', { turnId: turn }), card, ...chatItems(ID, 40)]);
    scrollTo(0);
    const first = firstVisible();
    expect(within(cards()[0] as HTMLElement).getByRole('button', { name: CARD_WORDS.decline(1) })).toBeTruthy();
    pushItem(cardWith(card, { outcome: 'passed', settledAt: 9 }));
    expect(cards()[0]?.dataset['outcome']).toBe('passed');
    expect(cards()[0]?.querySelectorAll('input, textarea, button')).toHaveLength(0);
    expect(cards()[0]?.querySelector('[data-card-outcome]')?.textContent).toBe('Passed over: the conversation went on without an answer');
    expect(firstVisible()).toBe(first);
    expect(log().scrollTop).toBe(0);
    expect(asked('chat:read')).toHaveLength(1);
  });

  it('answers a card from the list with the session and the item alone, and redraws nothing by itself for a stale press (C35, C49)', async () => {
    const turn = 't-x';
    const card = chatCard(ID, turn);
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      return Promise.resolve({ ok: true, value: channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0]) : channel === 'chat:answer' ? { status: 'refused', reason: 'not-pending' } : { status: 'saved' } });
    });
    await openWith([chatItem(ID, 'user', 'Read a note.', { turnId: turn }), card]);
    const drawn = cards()[0] as HTMLElement;
    fireEvent.click(within(drawn).getAllByRole('radio')[0] as HTMLElement);
    fireEvent.click(within(drawn).getByRole('button', { name: CARD_WORDS.submit(1) }));
    await settle();
    // No request id: the page holds none (C35).
    expect(asked('chat:answer')).toEqual([{ sessionId: ID, itemId: card.id, answers: [{ question: 0, options: [0], text: null }] }]);
    expect(within(drawn).queryByRole('status')).toBeNull();
    expect(cards()[0]?.dataset['outcome']).toBe('pending');
    // The item's push, which main sends at every outcome, brings the card's state. The focus was on
    // Submit: when the card settles and its controls go, the focus is the list's, whose current
    // entry the card still is — never the page's body (C43).
    within(drawn).getByRole('button', { name: CARD_WORDS.submit(1) }).focus();
    expect(document.activeElement?.closest('article')).toBe(drawn);
    pushItem(settled(card, 'withdrawn'));
    expect(cards()[0]?.dataset['outcome']).toBe('withdrawn');
    expect(cards()[0]?.querySelector('[data-card-outcome]')?.textContent).toBe('Withdrawn: the reply ended');
    expect(document.activeElement).toBe(document.querySelector('[data-chat-list]'));
  });

  it('leaves the focus where it is when a card settles and the focus was elsewhere', async () => {
    const turn = 't-x';
    const card = chatCard(ID, turn);
    await openWith([chatItem(ID, 'user', 'Read a note.', { turnId: turn }), card]);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    pushItem(settled(card, 'withdrawn'));
    expect(cards()[0]?.dataset['outcome']).toBe('withdrawn');
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('makes a worker’s row read that it waits while any question of the worker’s is pending, from the read and from its pushes (V29; C42, C73)', async () => {
    const turn = 't-w';
    const worker = chatActivity(ID, turn, { type: 'worker', summary: 'Read the notes', status: 'running', workerId: 'worker-1' });
    const one = chatCard(ID, turn, {}, { workerId: 'worker-1' });
    const two = chatCard(ID, turn, {}, { workerId: 'worker-1' });
    main.waiting = [{ workerId: 'worker-1', itemId: one.id, kind: 'question' }];
    openGroup(worker);
    await openWith([chatItem(ID, 'user', 'a prompt', { turnId: turn }), worker]);
    const row = () => log().querySelector('[data-activity="worker"]') as HTMLElement;
    const words = () => [...row().querySelectorAll('span')].map((part) => part.textContent).filter((text) => text !== '');
    // "Sub-agent", its label and that it waits, with its Open button: the card is in the tab.
    expect(row().hasAttribute('data-waits')).toBe(true);
    expect(words()).toEqual(expect.arrayContaining(['Sub-agent', 'Read the notes', CARD_WORDS.rowWaits]));
    expect(within(row()).getByRole('button', { name: 'Open' })).toBeTruthy();
    // No card of a worker's is in the session's list.
    expect(cards()).toEqual([]);
    pushItem(two, 'worker-1');
    pushItem(settled(one, 'answered'), 'worker-1');
    expect(row().hasAttribute('data-waits')).toBe(true);
    pushItem(settled(two, 'withdrawn'), 'worker-1');
    expect(row().hasAttribute('data-waits')).toBe(false);
    expect(words()).toContain('Running');
    expect(words()).not.toContain(CARD_WORDS.rowWaits);
    expect(asked('chat:read')).toHaveLength(1);
  });

  it('posts a worker’s question once from the chat’s region, with its tab closed and with it open, and the worker’s own list posts nothing (V30; C74)', async () => {
    const turn = 't-v';
    const worker = chatActivity(ID, turn, { type: 'worker', summary: 'Read the notes', status: 'running', workerId: 'worker-1' });
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      const value = channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0])
        : channel === 'chat:readWorker' ? { status: 'read', sessionId: ID, workerId: 'worker-1', revision: main.revision, worker, items: [], turns: [], older: null }
          : { status: 'saved' };
      return Promise.resolve({ ok: true, value });
    });
    openGroup(worker);
    await openWith([chatItem(ID, 'user', 'a prompt', { turnId: turn }), worker]);
    // Its tab is closed: only the chat's region can say it.
    pushItem(chatCard(ID, turn, {}, { workerId: 'worker-1' }), 'worker-1');
    expect(said()?.textContent).toBe('Sub-agent asks a question');
    const first = said();
    // With the tab open, a second question is posted once, by the chat's region alone.
    await act(async () => { fireEvent.click(within(log()).getByRole('button', { name: 'Open' })); await Promise.resolve(); await Promise.resolve(); });
    await settle();
    pushItem(chatCard(ID, turn, {}, { workerId: 'worker-1' }), 'worker-1');
    await settle();
    expect(said()).not.toBe(first);
    expect(said()?.textContent).toBe('Sub-agent asks a question');
    const pane = screen.getByRole('region', { name: 'Artifacts' });
    expect(within(pane).getAllByRole('article').filter((article) => article.hasAttribute('data-interaction'))).toHaveLength(1);
    expect([...pane.querySelectorAll('[role="status"]')].map((region) => region.textContent)).toEqual(['']);
    expect([...document.querySelectorAll('[role="status"]')].filter((region) => region.textContent === 'Sub-agent asks a question')).toHaveLength(1);
  });
});

// M22, V9, V10, V22 (docs/planning/_archive/M22.md, Design 10; C36, C77, C83): an approval's card as an entry
// of the list, the one line posted when it is raised, and the line that says a chat's mode changed.
describe('an action the session asks leave for (M22: V9, V10, V22)', () => {
  const current = () => articles().find((article) => article.hasAttribute('data-current'));
  const cards = () => articles().filter((article) => article.hasAttribute('data-interaction'));
  const said = () => (log().parentElement?.nextElementSibling as HTMLElement).querySelector('span');
  const foot = () => screen.queryByRole('button', { name: /go to the latest/i });
  const modeLines = () => [...log().querySelectorAll('[data-mode-line]')].map((line) => line.textContent);
  const MODED = [modedProvider({ id: 'codex', displayName: 'Codex' })];
  const RUNNING = { ...ONE, summary: { ...SUMMARIES.runningThinking, model: ONE.summary.model, effort: ONE.summary.effort, mode: 'ask-first' }, mode: { id: 'ask-first', source: 'chat' as const } };

  beforeEach(() => {
    resetTabs();
    resetWaiting();
    useGroupChoices.setState({ choices: {} });
  });

  async function openWith(items: readonly ConversationItem[], providers = MODED) {
    main.items = [...items];
    main.revision = items.length;
    act(() => { showState({ projects: [A], sessions: [RUNNING], selectedId: ID, catalog: CATALOG, providers }); });
    render(<SessionWindow />);
    await settle();
  }
  function pushItem(item: ConversationItem, workerId?: string): void {
    main.revision += 1;
    push({ sessionId: ID, revision: main.revision, item, turn: chatTurn(item.turnId, { state: 'running', outcome: null }), ...(workerId === undefined ? {} : { workerId }) });
  }

  it('draws an approval’s card at its item’s place, told from a question’s by its body’s kind and not by another item kind (V22; C77)', async () => {
    const turn = 't-a';
    await openWith([chatItem(ID, 'user', 'Make a note.', { turnId: turn }), chatCard(ID, turn), chatApproval(ID, turn), chatItem(ID, 'assistant', 'Made it.', { turnId: turn })]);
    expect(articles().map((article) => article.getAttribute('data-role') ?? '')).toEqual(['user', 'interaction', 'interaction', 'assistant']);
    expect(cards().map((card) => [card.dataset['kind'], card.getAttribute('aria-label')])).toEqual([['question', 'GPT-6 Sol asks a question'], ['approval', 'Codex asks to run a command']]);
    // Each draws its own: a question its options, an approval its choices.
    expect(within(cards()[0] as HTMLElement).getAllByRole('radio')).toHaveLength(2);
    expect(within(cards()[1] as HTMLElement).getByRole('button', { name: 'Approve once' })).toBeTruthy();
    expect(within(cards()[1] as HTMLElement).queryAllByRole('radio')).toEqual([]);
  });

  it('says an action whose card was withdrawn or dropped before a decision did not run, whatever its provider said, and leaves one that was decided as it is (C110)', async () => {
    const turn = 't-n';
    const action = (n: number, status: 'failed' | 'unfinished' | 'completed') => chatActivity(ID, turn, { type: 'edit', summary: `f${n}.txt`, status, changes: [{ path: `f${n}.txt`, kind: 'write', text: 'x' }] }, { providerItemId: `action-${n}` });
    await openWith([
      chatItem(ID, 'user', 'Make three files.', { turnId: turn }),
      action(1, 'completed'), chatApproval(ID, turn, { outcome: 'approved', decidedAt: 5, delivered: true }, { providerItemId: 'action-1' }),
      action(2, 'failed'), chatApproval(ID, turn, { outcome: 'withdrawn', settledAt: 6, withdrawnBy: 'turn' }, { providerItemId: 'action-2' }),
      action(3, 'unfinished'), chatApproval(ID, turn, { outcome: 'dropped', settledAt: 7 }, { providerItemId: 'action-3' }),
    ]);
    const rowOf = (n: number) => log().querySelector(`li[data-activity] [data-row-line]`) === null ? null : [...log().querySelectorAll('li[data-activity]')].find((row) => row.textContent?.includes(`f${n}.txt`));
    // Each group stands open by itself where an item did not complete; the first is opened here.
    const heads = [...log().querySelectorAll('article[data-role="activity"] > button')];
    for (const head of heads) if (head.getAttribute('aria-expanded') === 'false') fireEvent.click(head);
    await settle();
    expect(rowOf(1)?.textContent).toMatch(/^Edited f1\.txt written .* Completed$/);
    expect(rowOf(2)?.textContent).toBe('Asked to edit f2.txt Not run');
    expect(rowOf(3)?.textContent).toBe('Asked to edit f3.txt Not run');
    expect(heads.map((head) => head.textContent)).toEqual(['Edited 1 file · 1 s', '1 action not run', '1 action not run']);
  });

  it('is one entry for Up and Down, and its controls are stops only while it is the current one (V10; C36)', async () => {
    const turn = 't-k';
    await openWith([chatItem(ID, 'user', 'Make a note.', { turnId: turn }), chatApproval(ID, turn), chatItem(ID, 'assistant', 'Made it.', { turnId: turn })]);
    const [, card, answer] = articles();
    expect(current()).toBe(answer);
    const own = () => [...(card as HTMLElement).querySelectorAll<HTMLElement>('button')];
    expect(own().map((control) => control.textContent)).toEqual(['The whole action', 'Approve once', 'Deny', 'Stop']);
    expect(own().every((control) => control.tabIndex === -1)).toBe(true);
    log().focus();
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(current()).toBe(card);
    expect(log().getAttribute('aria-activedescendant')).toBe(card?.id);
    expect(own().every((control) => control.tabIndex === 0)).toBe(true);
    fireEvent.keyDown(log(), { key: 'ArrowUp' });
    expect(own().every((control) => control.tabIndex === -1)).toBe(true);
    expect(document.activeElement).toBe(log());
  });

  it('posts a raised approval once to the status region, by what it asks leave for, and moves no focus; the foot says new below (V10; C36)', async () => {
    const turn = 't-r';
    await openWith([...chatItems(ID, 40), chatItem(ID, 'user', 'Make a note.', { turnId: turn })]);
    act(() => { input().focus(); });
    scrollTo(300);
    const place = log().scrollTop;
    const card = chatApproval(ID, turn);
    pushItem(card);
    expect(said()?.textContent).toBe('Codex asks to run a command');
    const line = said();
    expect(document.activeElement).toBe(input());
    expect(log().scrollTop).toBe(place);
    expect(foot()?.textContent).toBe(CHAT_LINES.toEndNew);
    // Nothing on it is active, and nothing was chosen for the user.
    expect(asked('chat:decide')).toEqual([]);
    // Its decision's push redraws it in place, and posts nothing again.
    pushItem(approvalWith(card, { outcome: 'approved', decidedAt: 9, delivered: true }));
    expect(cards()[0]?.dataset['outcome']).toBe('approved');
    expect(within(cards()[0] as HTMLElement).queryByRole('button', { name: 'Approve once' })).toBeNull();
    expect(said()).toBe(line);
    expect(document.activeElement).toBe(input());
    // A file change is said as one.
    pushItem(chatApproval(ID, turn, { request: { kind: 'file-change', summary: 'notes.txt' } }));
    expect(said()?.textContent).toBe('Codex asks to change a file');
  });

  it('posts nothing for an approval a read brings', async () => {
    const turn = 't-s';
    await openWith([chatItem(ID, 'user', 'Make a note.', { turnId: turn }), chatApproval(ID, turn)]);
    expect(cards()).toHaveLength(1);
    expect(said()).toBeNull();
  });

  it('decides a card from the list by the session and the item alone, and draws its outcome when the push brings it (C13, C88)', async () => {
    const turn = 't-d';
    const card = chatApproval(ID, turn, { request: { choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'notes.txt' } } });
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      return Promise.resolve({ ok: true, value: channel === 'chat:read' ? main.read(request as Parameters<FakeChat['read']>[0]) : channel === 'chat:decide' ? { status: 'decided' } : { status: 'saved' } });
    });
    await openWith([chatItem(ID, 'user', 'Make a note.', { turnId: turn }), card]);
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Approve for this session: notes.txt' }));
    await settle();
    expect(asked('chat:decide')).toEqual([{ sessionId: ID, itemId: card.id, choice: 'approve-session' }]);
    expect(cards()[0]?.dataset['outcome']).toBe('pending');
    pushItem(approvalWith(card, { outcome: 'approved-session', decidedAt: 9, delivered: true, grant: { covers: 'notes.txt', processKey: 'k1', live: true } }));
    expect(cards()[0]?.querySelector('[data-card-outcome]')?.textContent).toBe('Approved for this session: covers notes.txt');
    expect(asked('chat:read')).toHaveLength(1);
  });

  it('makes a worker’s row read that it waits for an approval, and posts the worker’s request once from the chat’s region whether or not its tab is shown (C36)', async () => {
    const turn = 't-w';
    const worker = chatActivity(ID, turn, { type: 'worker', summary: 'Tidy the notes', status: 'running', workerId: 'worker-1' });
    openGroup(worker);
    await openWith([chatItem(ID, 'user', 'a prompt', { turnId: turn }), worker]);
    const row = () => log().querySelector('[data-activity="worker"]') as HTMLElement;
    const request = chatApproval(ID, turn, { request: { kind: 'file-change', summary: 'notes.txt' } }, { workerId: 'worker-1' });
    pushItem(request, 'worker-1');
    expect(said()?.textContent).toBe('Sub-agent asks to change a file');
    expect(row().dataset['waits']).toBe('approval');
    expect(row().textContent).toContain(CARD_WORDS.rowWaitsApproval);
    // Its card is its tab's: none of it is in the session's list.
    expect(cards()).toEqual([]);
    pushItem(approvalWith(request, { outcome: 'denied', decidedAt: 9, delivered: true }), 'worker-1');
    expect(row().hasAttribute('data-waits')).toBe(false);
    expect(row().textContent).not.toContain(CARD_WORDS.rowWaitsApproval);
    expect(asked('chat:read')).toHaveLength(1);
  });

  describe('the line that says a chat’s mode changed (V22; C83)', () => {
    const turnOf = (id: string, place: number, mode: string | null) => { main.turns.set(id, chatTurn(id, { place, mode })); };
    const pair = (turn: string, text: string) => [chatItem(ID, 'user', `${text}?`, { turnId: turn }), chatItem(ID, 'assistant', `${text}.`, { turnId: turn })];

    it('stands before the first turn under another mode than the one before it, by the mode’s label, and nowhere else', async () => {
      turnOf('t1', 1, 'ask-first');
      turnOf('t2', 2, 'ask-first');
      turnOf('t3', 3, 'edits-ok');
      turnOf('t4', 4, 'edits-ok');
      turnOf('t5', 5, 'read-only');
      await openWith([...pair('t1', 'one'), ...pair('t2', 'two'), ...pair('t3', 'three'), ...pair('t4', 'four'), ...pair('t5', 'five')]);
      expect(modeLines()).toEqual(['Mode: Edits ok', 'Mode: Read only']);
      // Each before its turn's first entry: the prompt that was sent under it.
      const lines = [...log().querySelectorAll('[data-mode-line]')];
      expect(textOf(lines[0]?.nextElementSibling?.nextElementSibling ?? undefined)).toBe('three?');
      expect(textOf(lines[1]?.nextElementSibling?.nextElementSibling ?? undefined)).toBe('five?');
      // A line, and no item: no entry of the list, so no stop of Up and Down and no anchor of its place.
      expect(articles()).toHaveLength(10);
      expect(lines.every((line) => line.tagName === 'P' && line.closest('article') === null)).toBe(true);
    });

    it('draws nothing where a chat’s mode never changed, nor at the first turn the window holds', async () => {
      turnOf('t1', 1, 'edits-ok');
      turnOf('t2', 2, 'edits-ok');
      await openWith([...pair('t1', 'one'), ...pair('t2', 'two')]);
      expect(modeLines()).toEqual([]);
    });

    it('passes over a turn that kept no mode, one read from a provider’s history among them', async () => {
      turnOf('t1', 1, null);
      turnOf('t2', 2, 'ask-first');
      turnOf('t3', 3, null);
      turnOf('t4', 4, 'ask-first');
      turnOf('t5', 5, 'berserk');
      await openWith([...pair('t1', 'one'), ...pair('t2', 'two'), ...pair('t3', 'three'), ...pair('t4', 'four'), ...pair('t5', 'five')]);
      // Nothing at the first turn that has a mode, since none is known before it; nothing at a turn that kept none.
      expect(modeLines()).toEqual(['Mode: Berserk']);
    });

    it('draws it as a turn under another mode arrives, and none for a provider that declares no mode', async () => {
      turnOf('t1', 1, 'ask-first');
      await openWith(pair('t1', 'one'));
      expect(modeLines()).toEqual([]);
      const prompt = chatItem(ID, 'user', 'two?', { turnId: 't2' });
      main.revision += 1;
      push({ sessionId: ID, revision: main.revision, item: prompt, turn: chatTurn('t2', { place: 2, state: 'running', outcome: null, mode: 'edits-ok' }) });
      expect(modeLines()).toEqual(['Mode: Edits ok']);
      cleanup();
      main = fakeChat(ID);
      turnOf('t1', 1, 'ask-first');
      turnOf('t2', 2, 'edits-ok');
      await openWith([...pair('t1', 'one'), ...pair('t2', 'two')], PROVIDERS);
      expect(modeLines()).toEqual([]);
    });
  });
});
