// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, V7 (docs/planning/_archive/M106.md, Design 7; C22–C25, C42) and V12, V13 (docs/planning/_archive/M20a.md,
// Design 7, 9; C32, C47–C50): a sub-agent's thread, unfolded in the Sub-agents tab, on a fake bridge that
// answers `chat:readWorker` from what the test holds and records each request. What it shows is what
// main answered and pushed: the sub-agent's own items in the chat's list, and — for one the session's
// list does not hold, as here, where the session lists none — its head line, from the item that started it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityBody } from '@shared/contracts/activity';
import { CHAT_LINES, type ChatPush, type ChatWorkerReadRequest, type ChatWorkerReadResult } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../../tests/support/app-state';
import { sessionEntry, SUMMARIES } from '../../../../../tests/support/sessions';
import { useGroupChoices } from '../../chat/chat-store';
import { showDetached } from '../../chat/detached-store';
import { approvalWith, cardWith, chatActivity, chatApproval, chatCard, chatItem, chatTurn } from '../../test/chat';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge';
import { project } from '../../test/records';
import { showState } from '../../test/sessions';
import { PaneWithKinds } from '../../test/pane';
import { BUILT_IN_KINDS } from '../kinds';
import { AGENTS_KIND, openAgent, openAside } from '../opener';
import { TABS_LABEL } from '../TabList';
import { resetTabs, selectTab, tabId, useTabs } from '../tabs-store';
import { WORKER_LIST_MARK } from './AgentThread';
import { THREAD_WORDS, threadTitle, WORKER_REFUSALS } from './words';

const P = project('Calamari', { providers: ['codex'] });
const ONE = sessionEntry('Create plan', SUMMARIES.idle, { projectId: P.id, providerId: 'codex' });
const ID = ONE.record.id;
const W = 'worker-1';
const TURN = 'turn-1';
const LABEL = 'Read the notes and report back';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
/** What main holds of the worker: the item that started it, and its own items, oldest first. */
let launched: ConversationItem | null;
let held: ConversationItem[];
let revision: number;
let refusal: Extract<ChatWorkerReadResult, { status: 'refused' }>['reason'] | null;
/** How many of the newest items a read with no cursor answers: the rest are behind Show earlier. */
let windowSize: number;

const launch = (body: Partial<ActivityBody> = {}): ConversationItem => chatActivity(ID, TURN, { type: 'worker', name: 'Agent', summary: LABEL, status: 'running', workerId: W, ...body }, { id: 'launch', time: { receivedAt: Date.now() - 5_000, providerAt: null } });
const said = (text: string, overrides: Partial<ConversationItem> = {}): ConversationItem => chatItem(ID, 'assistant', text, { turnId: TURN, workerId: W, phase: null, ...overrides });
const did = (body: Partial<ActivityBody> & Pick<ActivityBody, 'type'>, overrides: Partial<ConversationItem> = {}): ConversationItem => chatActivity(ID, TURN, body, { workerId: W, ...overrides });

function answer(request: ChatWorkerReadRequest): ChatWorkerReadResult {
  if (refusal !== null) return { status: 'refused', reason: refusal };
  // Another worker of the session: main holds nothing of it here.
  if (request.workerId !== W) return { status: 'read', sessionId: ID, workerId: request.workerId, revision, worker: null, items: [], turns: [], older: null };
  const end = request.before === undefined ? held.length : held.findIndex((item) => item.id === request.before);
  if (end === -1) return { status: 'refused', reason: 'unknown-cursor' };
  const items = held.slice(Math.max(0, end - windowSize), end);
  const first = items[0];
  return { status: 'read', sessionId: ID, workerId: W, revision, worker: launched, items, turns: [chatTurn(TURN, { state: 'running', outcome: null })], older: first !== undefined && first !== held[0] ? first.id : null };
}

beforeEach(() => {
  bridge = installFakeBridge('win32');
  requests = [];
  launched = launch();
  held = [];
  revision = 10;
  refusal = null;
  windowSize = 500;
  resetTabs();
  showDetached(null);
  useGroupChoices.setState({ choices: {} });
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    // Another tab beside it, an aside's, reads as a new one would.
    return Promise.resolve({ ok: true, value: channel === 'chat:readWorker' ? answer(request as ChatWorkerReadRequest) : channel === 'chat:readAside' ? { status: 'refused', reason: 'unknown-aside' } : null });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const push = (payload: ChatPush) => act(() => { bridge.push('chat:message', payload); });
const pushItem = (item: ConversationItem, workerId: string | null = W) => { revision += 1; push({ sessionId: ID, revision, item, turn: chatTurn(item.turnId, { state: 'running', outcome: null }), ...(workerId === null ? {} : { workerId }) }); };
const reads = () => requests.filter(([channel]) => channel === 'chat:readWorker').map(([, request]) => request);
const tab = () => within(screen.getByRole('tablist', { name: TABS_LABEL })).getAllByRole('tab');
const body = () => document.querySelector('[data-agent-thread]') as HTMLElement;
/** The head line a thread of a sub-agent the list does not hold draws in its row's place (C24). */
const head = () => document.querySelector('[data-agent-head]') as HTMLElement;
const list = () => within(body()).getByRole('group', { name: THREAD_WORDS.list });
const entries = () => within(list()).queryAllByRole('article');

async function open(label: string = LABEL) {
  act(() => { showState({ projects: [P], sessions: [ONE], selectedId: ID, providers: [sampleProvider({ id: 'codex', displayName: 'Codex' })] }); });
  render(<PaneWithKinds kinds={BUILT_IN_KINDS} />);
  act(() => { openAgent(ID, W, label); });
  await settle();
}

describe('choosing a sub-agent (M106, V5, V7; C4, C23, C24)', () => {
  it('opens the session’s Sub-agents tab with the sub-agent chosen, its thread unfolded; chosen again, the same tab, titled Sub-agents', async () => {
    launched = null;
    refusal = 'unknown-worker';
    await open();
    expect(tab().map((button) => button.querySelector('[data-tab-title]')?.textContent)).toEqual(['Sub-agents']);
    expect(useTabs.getState().sessions[ID]?.tabs.map((entry) => [entry.kind, entry.reference, entry.viewState])).toEqual([[AGENTS_KIND, null, { chosen: { id: W, label: LABEL } }]]);
    expect(body().getAttribute('data-agent-thread')).toBe(W);
    act(() => { openAgent(ID, W, 'Worker 1'); });
    await settle();
    expect(useTabs.getState().sessions[ID]?.tabs).toHaveLength(1);
  });

  it('has fat-g’s word for a head where the sub-agent has no label', () => {
    expect(threadTitle('')).toBe('Sub-agent');
    expect(threadTitle('  ')).toBe('Sub-agent');
    expect(threadTitle(null)).toBe('Sub-agent');
    expect(threadTitle('Worker 2')).toBe('Worker 2');
  });

  it('heads one the list does not hold with the label it was chosen with, else the one its item reads, first in the stack; its press folds it (C24)', async () => {
    launched = launch({ summary: 'Worker 1' });
    await open('an earlier label');
    expect(head().firstElementChild?.textContent).toBe('an earlier label');
    expect(head().getAttribute('aria-expanded')).toBe('true');
    act(() => { openAgent(ID, W, ''); });
    await settle();
    expect(head().firstElementChild?.textContent).toBe('Worker 1');
    fireEvent.click(head());
    expect(body()).toBeNull();
  });

  it('draws no head line for a sub-agent the list holds: its row says what it is (C22)', async () => {
    const listed = { ...ONE, summary: { ...ONE.summary, agents: [{ id: W, number: 1, label: LABEL, state: 'running' as const, action: null, startedAt: 1, finishedAt: null, model: null, agentType: null, attention: null }] } };
    act(() => { showState({ projects: [P], sessions: [listed], selectedId: ID, providers: [sampleProvider({ id: 'codex', displayName: 'Codex' })] }); });
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} />);
    act(() => { openAgent(ID, W, LABEL); });
    await settle();
    expect(body().getAttribute('data-agent-thread')).toBe(W);
    expect(head()).toBeNull();
    expect(document.querySelector(`[data-row="${W}"]`)?.getAttribute('aria-expanded')).toBe('true');
  });

  it('chooses another from a worker row inside a thread (C4)', async () => {
    held = [did({ type: 'worker', name: 'Agent', summary: 'A helper', workerId: 'worker-2', status: 'completed' })];
    await open();
    fireEvent.click(within(entries()[0] as HTMLElement).getByRole('button', { name: /sub-agent/ }));
    fireEvent.click(within(body()).getByRole('button', { name: 'Open' }));
    await settle();
    expect(useTabs.getState().sessions[ID]?.tabs[0]?.viewState).toMatchObject({ chosen: { id: 'worker-2', label: 'A helper' } });
    expect(body().getAttribute('data-agent-thread')).toBe('worker-2');
  });
});

describe('what it shows (V12; C47, C48)', () => {
  it('reads the worker’s items by one channel when it is shown, and draws them in the chat’s list: its messages as Markdown, its activity in groups', async () => {
    held = [did({ type: 'read', summary: 'notes-3.txt', files: [{ path: 'notes-3.txt', line: null }], output: 'Note three.' }), did({ type: 'search', summary: 'logbook' }), said('The **logbook** is kept in the blue drawer.')];
    await open();
    expect(reads()).toEqual([{ sessionId: ID, workerId: W }]);
    expect(entries().map((entry) => entry.getAttribute('data-role'))).toEqual(['activity', 'assistant']);
    expect(entries()[0]?.querySelector('button')?.textContent).toBe('Read 1 file, searched once · 1 s');
    // Its message: labelled with the worker's own label, drawn as Markdown, with its Copy button.
    expect(entries()[1]?.getAttribute('aria-label')).toBe('Sample One');
    expect(entries()[1]?.querySelector('strong')?.textContent).toBe('logbook');
    // Its one part: copied by its foot's Copy button, with none of its own (the maintainer).
    expect(within(entries()[1] as HTMLElement).queryByRole('button', { name: CHAT_LINES.copyPart })).toBeNull();
    expect(within(list()).getByRole('button', { name: CHAT_LINES.copyAnswer })).toBeTruthy();
    // The list is named apart from the chat's own and does not carry its mark.
    expect(list().hasAttribute(WORKER_LIST_MARK)).toBe(true);
    expect(list().hasAttribute('data-chat-list')).toBe(false);
    expect(list().tabIndex).toBe(0);
  });

  it('says on its head the label, its status in words and how long it has run, from the item that started it', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(100_000);
    launched = chatActivity(ID, TURN, { type: 'worker', summary: LABEL, status: 'running', workerId: W }, { id: 'launch', time: { receivedAt: 88_000, providerAt: null } });
    await open();
    expect([...head().children].map((part) => part.textContent)).toEqual([LABEL, 'Running', '12 s']);
    expect(body().getAttribute('data-worker-status')).toBe('running');
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(head().lastElementChild?.textContent).toBe('15 s');
  });

  it('draws no line of a turn under its items, and takes no prompt: a worker is its session’s to direct (C48, C49)', async () => {
    held = [said('Done.')];
    await open();
    expect(within(body()).queryByRole('textbox')).toBeNull();
    expect(entries()).toHaveLength(1);
    // Nothing but the entry in the list: no line that the turn is still running, or how it ended.
    expect(list().querySelector('[data-turn-line]')).toBeNull();
    expect(list().querySelector('[data-turn-progress]')).not.toBeNull();
  });

  it('opens a file a worker’s activity names through the session’s opener, as a tab beside it', async () => {
    held = [did({ type: 'read', summary: 'notes-3.txt', status: 'failed', files: [{ path: 'notes-3.txt', line: 4 }] })];
    await open();
    // No group opens by itself: the reader opens it to reach the row.
    act(() => { fireEvent.click(entries()[0]?.querySelector('button') as HTMLElement); });
    await act(async () => { fireEvent.click(within(entries()[0] as HTMLElement).getByRole('button', { name: 'notes-3.txt' })); await Promise.resolve(); await Promise.resolve(); });
    expect(requests.filter(([channel]) => channel === 'files:read').map(([, request]) => request)).toEqual([{ sessionId: ID, target: 'notes-3.txt' }]);
  });

  it('says, in fat-g’s words, why it shows nothing: a worker main holds nothing of, a session no longer listed', async () => {
    for (const reason of ['unknown-worker', 'unknown-session'] as const) {
      refusal = reason;
      await open();
      expect(within(body()).getByText(WORKER_REFUSALS[reason])).toBeTruthy();
      expect(within(body()).queryByRole('group', { name: THREAD_WORDS.list })).toBeNull();
      cleanup();
      resetTabs();
    }
  });

  it('says that nothing is there yet for a worker that ended having said and done nothing, and nothing of the kind while it runs', async () => {
    launched = launch({ status: 'failed', duration: { ms: 2_000, provenance: 'local' } });
    await open();
    expect(within(body()).getByText(THREAD_WORDS.empty)).toBeTruthy();
    expect([...head().children].map((part) => part.textContent)).toEqual([LABEL, 'Failed', '2 s']);
    cleanup();
    resetTabs();
    launched = launch();
    await open();
    expect(within(body()).queryByText(THREAD_WORDS.empty)).toBeNull();
  });
});

describe('while it is shown (V12; C32, C49)', () => {
  it('follows the pushes that name its worker: an item goes in, a message grows, and nothing is read again', async () => {
    held = [did({ type: 'read', summary: 'notes-1.txt' })];
    await open();
    const running = did({ type: 'command', summary: 'rg logbook', status: 'running' });
    pushItem(running);
    // The same group, its line counting the new action; closed, since a running item opens none (round 9, C83).
    expect(entries()).toHaveLength(1);
    expect(entries()[0]?.querySelector('button')?.textContent).toContain('Read 1 file, ran 1 command');
    expect([...(entries()[0]?.querySelectorAll('[data-activity]') ?? [])]).toEqual([]);
    pushItem({ ...running, state: 'complete', activity: { ...(running.activity as ActivityBody), status: 'completed', duration: { ms: 1_000, provenance: 'local' } } });
    const message = said('The log', { state: 'streaming' });
    pushItem(message);
    expect(entries().map((entry) => entry.getAttribute('data-role'))).toEqual(['activity', 'assistant']);
    revision += 1;
    push({ sessionId: ID, revision, partial: { itemId: message.id, before: 'The log'.length, append: 'book is in the drawer.' }, workerId: W });
    expect(entries()[1]?.textContent).toContain('The logbook is in the drawer.');
    expect(reads()).toHaveLength(1);
  });

  it('passes by what is not its worker’s: the session’s own and another worker’s change nothing, and no read is asked', async () => {
    held = [said('One.')];
    await open();
    const before = list().innerHTML;
    pushItem(chatItem(ID, 'assistant', 'The session’s own answer.', { turnId: TURN }), null);
    pushItem(chatItem(ID, 'assistant', 'Another worker’s.', { turnId: TURN, workerId: 'worker-2' }), 'worker-2');
    revision += 1;
    push({ sessionId: ID, revision, partial: { itemId: 'no-item-here', before: 0, append: 'x' } });
    expect(list().innerHTML).toBe(before);
    expect(reads()).toHaveLength(1);
    // Its own next push follows on: no revision was missed.
    pushItem(said('Two.'));
    expect(entries()).toHaveLength(2);
    expect(reads()).toHaveLength(1);
  });

  it('keeps its line above by the push of the item that started it: the worker’s end, with its duration', async () => {
    await open();
    expect(within(head()).getByText('Running')).toBeTruthy();
    pushItem({ ...(launched as ConversationItem), state: 'complete', activity: { ...((launched as ConversationItem).activity as ActivityBody), status: 'completed', duration: { ms: 42_000, provenance: 'provider' }, output: 'The report.' } }, null);
    expect([...head().children].map((part) => part.textContent)).toEqual([LABEL, 'Completed', '42 s']);
    expect(body().getAttribute('data-worker-status')).toBe('completed');
    // Another worker's launch item is not its own.
    pushItem(chatActivity(ID, TURN, { type: 'worker', summary: 'Another', status: 'running', workerId: 'worker-2' }), null);
    expect(within(head()).getByText(LABEL)).toBeTruthy();
    expect(reads()).toHaveLength(1);
  });

  it('reads again where main says something else changed, and where a revision was missed', async () => {
    held = [said('One.')];
    await open();
    held = [...held, said('Two.')];
    revision += 1;
    push({ sessionId: ID, revision, changed: true });
    await settle();
    expect(reads()).toHaveLength(2);
    expect(entries()).toHaveLength(2);
    // A gap: the push is two revisions on.
    held = [...held, said('Three.')];
    revision += 2;
    push({ sessionId: ID, revision, item: said('Four.'), turn: chatTurn(TURN), workerId: W });
    await settle();
    expect(reads()).toHaveLength(3);
    expect(entries()).toHaveLength(3);
  });

  it('drops a push of another session', async () => {
    held = [said('One.')];
    await open();
    push({ sessionId: '99999999-9999-4999-8999-999999999999', revision: revision + 1, item: said('Not this session’s.'), turn: chatTurn(TURN), workerId: W });
    expect(entries()).toHaveLength(1);
    expect(reads()).toHaveLength(1);
  });
});

describe('its height (M106, C40)', () => {
  /** How tall what the list holds is, and how tall the tab lets the thread be: jsdom lays nothing out. */
  let content: number;
  let bound: number;
  let observers: Set<() => void>;
  beforeEach(() => {
    content = 60;
    bound = 200;
    observers = new Set();
    const isList = (element: HTMLElement): boolean => element.hasAttribute(WORKER_LIST_MARK);
    // A fitted list is as tall as what it holds, up to the bound; a framed one is the bound's height.
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return isList(this) ? (/fitList/.test(this.className) ? Math.min(content, bound) : bound) : 0; });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return isList(this) ? Math.max(content, this.clientHeight) : 0; });
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly changed: () => void) {}
      observe(): void { observers.add(this.changed); }
      disconnect(): void { observers.delete(this.changed); }
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const resize = () => act(() => { for (const changed of [...observers]) changed(); });
  const framed = () => [/full/.test(body().className), !/fitList/.test(list().className)];

  it('is as tall as what it holds until its list outgrows the bound, then framed at it, and fitted again where it would fit', async () => {
    held = [said('A short answer')];
    await open();
    expect(framed()).toEqual([false, false]);
    // The sub-agent goes on: what the list holds outgrows the bound.
    content = 260;
    pushItem(said('A longer one'));
    expect(framed()).toEqual([true, true]);
    // The window grows taller than what it holds, and shrinks again.
    bound = 400;
    resize();
    expect(framed()).toEqual([false, false]);
    bound = 100;
    resize();
    expect(framed()).toEqual([true, true]);
  });

  // Where scrollbars overlay the text, a framed list that comes to fit changes no size of its own: a press is what is seen.
  it('fits again after a press inside it leaves what it holds within the bound, with no change of its size', async () => {
    held = [said('A short answer')];
    await open();
    content = 260;
    pushItem(said('A longer one'));
    expect(framed()).toEqual([true, true]);
    // A row closed: what the list holds is short again, and no observer reports.
    content = 120;
    fireEvent.click(list());
    await act(async () => { await new Promise((resolve) => { requestAnimationFrame(() => { resolve(undefined); }); }); });
    expect(framed()).toEqual([false, false]);
  });
});

describe('older items, and showings (V12; C48, C49)', () => {
  it('offers the page before its window at the list’s head, read by the same channel with its cursor', async () => {
    held = Array.from({ length: 6 }, (_, index) => said(`message ${index + 1}`));
    windowSize = 4;
    await open();
    expect(entries()).toHaveLength(4);
    fireEvent.click(within(list()).getByRole('button', { name: CHAT_LINES.showEarlier }));
    await settle();
    expect(reads()).toEqual([{ sessionId: ID, workerId: W }, { sessionId: ID, workerId: W, before: held[2]?.id }]);
    expect(entries()).toHaveLength(6);
    expect(within(list()).queryByRole('button', { name: CHAT_LINES.showEarlier })).toBeNull();
  });

  it('holds nothing while it is not shown, and reads again at each showing', async () => {
    held = [said('One.')];
    await open();
    expect(entries()).toHaveLength(1);
    // Another tab is shown: its body is gone, with what it held.
    act(() => { openAside(ID, 'aside-1', 'A question'); });
    await settle();
    expect(document.querySelector(`[data-agent-thread="${W}"]`)).toBeNull();
    const asked = reads().length;
    // What arrives meanwhile is no one's to take: nothing subscribes for a tab that is not shown.
    held = [...held, said('Two.')];
    pushItem(held[1] as ConversationItem);
    expect(reads()).toHaveLength(asked);
    act(() => { selectTab(ID, tabId(AGENTS_KIND, null)); });
    await settle();
    expect(reads().at(-1)).toEqual({ sessionId: ID, workerId: W });
    expect(reads()).toHaveLength(asked + 1);
    expect(entries()).toHaveLength(2);
    // The pane kept the chosen one alone, and none of what it read.
    expect(useTabs.getState().sessions[ID]?.tabs.find((entry) => entry.kind === AGENTS_KIND)?.viewState).toEqual({ chosen: { id: W, label: LABEL } });
  });
});

// M21, V9, V36 (C37, C42, C74, C79): a worker's question, in its thread.
describe('a worker’s question (M21: V9, V36; C37, C42, C79)', () => {
  const cards = () => entries().filter((article) => article.hasAttribute('data-interaction'));
  const asked = (body: Parameters<typeof chatCard>[2] = {}): ConversationItem => chatCard(ID, TURN, body, { workerId: W });
  const answered = { outcome: 'answered' as const, answers: [{ options: [0], text: null, secret: false }], settledAt: 5 };

  it('is a card in the worker’s list, drawn by the chat’s own component and named Sub-agent with its label; it is answered from here', async () => {
    const card = asked();
    held = [said('I need to know which file.'), card];
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      return Promise.resolve({ ok: true, value: channel === 'chat:readWorker' ? answer(request as ChatWorkerReadRequest) : { status: 'answered' } });
    });
    await open();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.getAttribute('aria-label')).toBe(`Sub-agent ${LABEL} asks a question`);
    fireEvent.click(within(cards()[0] as HTMLElement).getAllByRole('radio')[1] as HTMLElement);
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Submit' }));
    await settle();
    expect(requests.filter(([channel]) => channel === 'chat:answer').map(([, request]) => request)).toEqual([{ sessionId: ID, itemId: card.id, answers: [{ question: 0, options: [1], text: null }] }]);
  });

  it('takes a card’s push as the list takes its own, and posts nothing for a raising: the chat’s region says it (C74)', async () => {
    await open();
    const card = asked();
    pushItem(card);
    expect(cards()[0]?.dataset['outcome']).toBe('pending');
    expect([...body().querySelectorAll('[role="status"]')].map((region) => region.textContent)).toEqual(['']);
    pushItem(cardWith(card, { ...answered, confirmedAt: 6 }));
    expect(cards()[0]?.dataset['outcome']).toBe('answered');
    expect(cards()[0]?.querySelectorAll('input, textarea')).toHaveLength(0);
    expect(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Show questions and answers' }).getAttribute('aria-expanded')).toBe('false');
    expect(reads()).toHaveLength(1);
  });

  it('reads an answer with no mark as answered while the worker runs, though its parent’s turn is over, and as unconfirmed once the worker has ended (V36; C79)', async () => {
    held = [asked(answered)];
    await open();
    const outcome = () => cards()[0]?.querySelector('[data-card-outcome]')?.textContent;
    expect(outcome()).toBeUndefined();
    expect(cards()[0]?.textContent).toBe('1 Question — Answered');
    // The item that started the worker ends: the worker is over, and its result never confirmed the answer.
    pushItem({ ...(launched as ConversationItem), state: 'complete', activity: { ...((launched as ConversationItem).activity as ActivityBody), status: 'completed' } }, null);
    expect(outcome()).toBe('Answered; the model did not confirm it');
    cleanup();
    resetTabs();
    // Confirmed by the worker's own result: answered, whatever became of the worker after.
    launched = launch({ status: 'completed' });
    held = [asked({ ...answered, confirmedAt: 6 })];
    await open();
    expect(outcome()).toBeUndefined();
    expect(cards()[0]?.textContent).toBe('1 Question — Answered');
  });
});

// M22, V9 (docs/planning/_archive/M22.md, Design 10; C11, C14, C36): a worker's request for leave, in its thread.
describe('a worker’s approval (M22: V9; C11, C14, C36)', () => {
  const cards = () => entries().filter((article) => article.dataset['kind'] === 'approval');
  const asked = (body: Parameters<typeof chatApproval>[2] = {}): ConversationItem => chatApproval(ID, TURN, body, { workerId: W });

  it('is a card in the worker’s list, named Sub-agent with its label, decided from here; its Stop is the session’s own', async () => {
    const card = asked({ request: { kind: 'file-change', tool: 'Write', summary: 'notes.txt', choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'notes.txt' } } });
    held = [said('I will write the note.'), card];
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      return Promise.resolve({ ok: true, value: channel === 'chat:readWorker' ? answer(request as ChatWorkerReadRequest) : channel === 'chat:decide' ? { status: 'decided' } : { status: 'stopping' } });
    });
    await open();
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.getAttribute('aria-label')).toBe(`Sub-agent ${LABEL} asks to change a file`);
    expect([...(cards()[0] as HTMLElement).querySelectorAll('button')].map((button) => button.textContent)).toEqual(['The whole action', 'Approve once', 'Approve for this session: notes.txt', 'Deny', 'Stop']);
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Deny' }));
    await settle();
    fireEvent.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Stop' }));
    await settle();
    // By the session and the card's item: the page holds no request id, and names no worker.
    expect(requests.filter(([channel]) => channel === 'chat:decide' || channel === 'chat:stop')).toEqual([['chat:decide', { sessionId: ID, itemId: card.id, choice: 'deny' }], ['chat:stop', { sessionId: ID }]]);
  });

  it('takes its decision by its push, in place, and posts nothing itself: the chat’s region says a worker’s request once (C36)', async () => {
    const card = asked();
    await open();
    pushItem(card);
    expect(cards()[0]?.dataset['outcome']).toBe('pending');
    expect([...body().querySelectorAll('[role="status"]')].every((region) => !region.textContent?.includes('asks to'))).toBe(true);
    pushItem(approvalWith(card, { outcome: 'approved', decidedAt: 6, delivered: true, confirmedAt: 7 }));
    expect(cards()[0]?.dataset['outcome']).toBe('approved');
    expect(cards()[0]?.querySelector('[data-card-outcome]')?.textContent).toBe('Approved once');
    expect(within(cards()[0] as HTMLElement).queryByRole('button', { name: 'Approve once' })).toBeNull();
    expect(reads()).toHaveLength(1);
  });

  it('reads a decision with no mark as unconfirmed only once the worker has ended, whatever became of its parent’s turn (M21, C79)', async () => {
    held = [asked({ outcome: 'approved', decidedAt: 5, delivered: true })];
    await open();
    const outcome = () => cards()[0]?.querySelector('[data-card-outcome]')?.textContent;
    expect(outcome()).toBe('Approved once');
    pushItem({ ...(launched as ConversationItem), state: 'complete', activity: { ...((launched as ConversationItem).activity as ActivityBody), status: 'completed' } }, null);
    expect(outcome()).toBe('Approved; the CLI did not confirm it');
  });
});
