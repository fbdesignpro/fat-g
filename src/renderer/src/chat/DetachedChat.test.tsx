// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V18 (docs/planning/_archive/M19.md; C53): a chat without a session is drawn by the same components as a
// session's — Markdown, Copy buttons, times, a partial message's line, the elapsed line — and takes
// no update: nothing streams into a conversation no session has.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_LINES } from '@shared/contracts/chat';
import type { ConversationItem, DetachedConversation } from '@shared/contracts/conversation';
import type { InvokeChannel } from '@shared/ipc/channels';
import { usePrefs } from '../state/prefs-store';
import { chatActivity, chatApproval, chatCard, chatItem, chatTurn, type FakeChat, fakeChat } from '../test/chat';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { formatDateTime } from '../ui/format';
import { DetachedChat } from './DetachedChat';

const ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION: DetachedConversation = { id: ID, name: 'Plan the trip', createdAt: 1 };
const AT = Date.parse('2026-03-01T09:30:00');

let bridge: FakeBridge;
let main: FakeChat;
let requests: [InvokeChannel, unknown][];
let written: string[];

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  requests = [];
  written = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
  const prompt = chatItem(ID, 'user', 'What is in *notes_1.txt*?', { time: { receivedAt: AT, providerAt: null } });
  const answer = chatItem(ID, 'assistant', '## The notes\n\nThey hold a **list**:\n\n- one\n- two\n\n```sh\ncat notes_1.txt\n```', { turnId: prompt.turnId, order: { turn: prompt.order.turn, item: 1 }, time: { receivedAt: AT + 4_000, providerAt: null } });
  const again = chatItem(ID, 'user', 'And the rest?', { time: { receivedAt: AT + 60_000, providerAt: null } });
  const cut = chatItem(ID, 'assistant', 'The rest is a table that never', { state: 'partial', turnId: again.turnId, order: { turn: again.order.turn, item: 1 }, time: { receivedAt: AT + 61_000, providerAt: null } });
  main = fakeChat(ID, [prompt, answer, again, cut]);
  main.turns.set(prompt.turnId, chatTurn(prompt.turnId, { state: 'ended', outcome: 'completed', place: prompt.order.turn, time: { acceptedAt: AT, providerStartedAt: null, providerEndedAt: null, endReceivedAt: AT + 4_000, providerDurationMs: null, elapsedMs: 4_000 } }));
  main.turns.set(again.turnId, chatTurn(again.turnId, { state: 'unfinished', outcome: 'stopped', place: again.order.turn }));
  usePrefs.setState({ snapshot: prefsSnapshot({ chat: { messageTimes: true, hoverMessageTimes: true, answerTimes: true, username: 'Robin' } }), error: null, saving: false });
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    if (channel !== 'conversations:readDetached') return Promise.resolve({ ok: true, value: { status: 'saved' } });
    const newest = main.read({ sessionId: ID });
    return Promise.resolve({ ok: true, value: { status: 'page', sessionId: ID, revision: 0, items: newest.items, turns: newest.turns, older: newest.older } });
  });
});
afterEach(cleanup);

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
async function open(): Promise<HTMLElement[]> {
  render(<DetachedChat conversation={CONVERSATION} />);
  await settle();
  return within(screen.getByRole('group', { name: 'Messages' })).getAllByRole('article');
}

describe('a chat without a session (M19: V18; C53)', () => {
  it('draws an assistant’s message as Markdown and a prompt as typed, as a session’s chat does', async () => {
    const [prompt, answer] = await open();
    expect(prompt?.textContent).toContain('What is in *notes_1.txt*?');
    expect(prompt?.querySelector('em')).toBeNull();
    expect(answer?.querySelector('h2')?.textContent).toBe('The notes');
    expect(answer?.querySelector('strong')?.textContent).toBe('list');
    expect([...(answer?.querySelectorAll('li') ?? [])].map((item) => item.textContent)).toEqual(['one', 'two']);
    expect(answer?.querySelector('pre code')?.textContent).toBe('cat notes_1.txt');
    // No record names its model: the label says no more than is known.
    expect(answer?.getAttribute('aria-label')).toBe('Assistant');
  });

  it('has a Copy button on each prompt, each assistant’s message and each code block, which copy their source', async () => {
    const [prompt, answer] = await open();
    const press = (button: HTMLElement) => act(async () => { fireEvent.click(button); await Promise.resolve(); await Promise.resolve(); });
    await press(within(prompt as HTMLElement).getByRole('button', { name: CHAT_LINES.copyMessage }));
    // An answer of one part has no Copy button of its own: its foot's copies it (the maintainer).
    expect(within(answer as HTMLElement).queryByRole('button', { name: CHAT_LINES.copyPart })).toBeNull();
    await press(screen.getAllByRole('button', { name: CHAT_LINES.copyAnswer })[0] as HTMLElement);
    await press(within(answer as HTMLElement).getByRole('button', { name: 'Copy code' }));
    expect(written).toEqual(['What is in *notes_1.txt*?', (main.items[1] as ConversationItem).blocks[0]?.text, 'cat notes_1.txt']);
  });

  it('shows the times, the elapsed line and a partial message’s line, by the same preferences', async () => {
    const articles = await open();
    const list = screen.getByRole('group', { name: 'Messages' });
    // Another day than today: the date is with the time.
    expect([...list.querySelectorAll('time')].map((time) => time.textContent)).toEqual([AT, AT + 4_000, AT + 60_000, AT + 61_000].map(formatDateTime));
    expect([...list.querySelectorAll('[data-turn-line]')].map((line) => `${line.getAttribute('data-turn-line')}: ${line.textContent}`)).toEqual([`unfinished: ${CHAT_LINES.unfinished}`]);
    expect(articles[3]?.getAttribute('data-state')).toBe('partial');
    expect(articles[3]?.querySelector('[data-item-line="incomplete"]')?.textContent).toBe(CHAT_LINES.incomplete);
    expect(articles.slice(0, 3).some((article) => article.querySelector('[data-item-line="incomplete"]') !== null)).toBe(false);
    // Switched off, both go, here as in a session's chat.
    act(() => { usePrefs.setState({ snapshot: prefsSnapshot({}, { kind: 'ok' }, 2) }); });
    expect(list.querySelectorAll('time, [data-turn-line="elapsed"]')).toHaveLength(0);
  });

  it('takes no update: it listens for no push, and a push that names it changes nothing', async () => {
    const before = await open();
    expect(bridge.listenerCount('chat:message')).toBe(0);
    const [, answer] = main.items;
    act(() => {
      bridge.push('chat:message', { sessionId: ID, revision: 1, partial: { itemId: (answer as ConversationItem).id, before: 0, append: 'streamed in' } });
      bridge.push('chat:message', { sessionId: ID, revision: 2, item: chatItem(ID, 'assistant', 'a new message'), turn: chatTurn('x') });
      bridge.push('chat:message', { sessionId: ID, revision: 3, changed: true });
    });
    await settle();
    expect(within(screen.getByRole('group', { name: 'Messages' })).getAllByRole('article')).toEqual(before);
    expect(screen.queryByText(/streamed in|a new message/)).toBeNull();
    // It asked main for its page, and for nothing else; and it has no input.
    expect([...new Set(requests.map(([channel]) => channel))]).toEqual(['conversations:readDetached']);
    expect(screen.queryByRole('textbox')).toBeNull();
    // No turn of it runs, so nothing of an end is ever said.
    expect(screen.getAllByRole('status').every((region) => !region.textContent?.includes(CHAT_LINES.answerFinished))).toBe(true);
  });
});

// M19b (V11; C21): a chat without a session has no project to hold a file to, so it is given no opener.
describe('references in a chat without a session (M19b: V11; C21)', () => {
  it('draws a link, a code span that reads as a path and a bare address as the text they are, and asks main for nothing', async () => {
    const prompt = chatItem(ID, 'user', 'Where is it?');
    const answer = chatItem(ID, 'assistant', 'In `src/tides.js:12`; see [the README](README.md), [the site](https://example.com/docs) and https://example.com/tides.', { turnId: prompt.turnId, order: { turn: prompt.order.turn, item: 1 } });
    main = fakeChat(ID, [prompt, answer]);
    const [, drawn] = await open();
    expect(drawn?.textContent).toContain('In src/tides.js:12; see the README (README.md), the site (https://example.com/docs) and https://example.com/tides.');
    expect(drawn?.querySelector('[data-reference]')).toBeNull();
    // No control of its own: no reference is one, and an answer of one part has its Copy button at its foot.
    expect(within(drawn as HTMLElement).queryAllByRole('button')).toEqual([]);
    expect(drawn?.querySelector('code')?.closest('button')).toBeNull();
    expect(requests.map(([channel]) => channel)).toEqual(['conversations:readDetached']);
  });
});

// M20a (V10; C46): a detached conversation draws its activity as a session's chat does, and nothing of it leads anywhere.
describe('what a session did, in a chat without a session (M20a: V10; C46)', () => {
  it('draws its groups and rows the same, a file as the text it is and a worker’s row without its Open button, and asks main for nothing', async () => {
    const prompt = chatItem(ID, 'user', 'Read the notes.');
    const turn = prompt.turnId;
    main = fakeChat(ID, [
      prompt,
      chatActivity(ID, turn, { type: 'read', name: 'Read', summary: 'notes-3.txt', status: 'failed', output: 'No such file.', files: [{ path: 'C:/work/notes-3.txt', line: null }] }),
      chatActivity(ID, turn, { type: 'worker', name: 'Agent', summary: 'Look for the notes', workerId: 'worker-1', output: 'Found none.' }),
      chatItem(ID, 'assistant', 'There are no such notes.', { turnId: turn }),
    ]);
    const [, group] = await open();
    expect(group?.getAttribute('data-role')).toBe('activity');
    // Its line says what was done and what failed, in fat-g's words; it opens by itself no more than a session's chat does.
    expect(group?.querySelector('button')?.textContent).toBe('Read 1 file, started 1 sub-agent, 1 failed · 1 s');
    expect(group?.querySelectorAll('[data-activity]')).toHaveLength(0);
    act(() => { fireEvent.click(group?.querySelector('button') as HTMLElement); });
    const rows = [...(group?.querySelectorAll('[data-activity]') ?? [])] as HTMLElement[];
    expect(rows.map((row) => row.getAttribute('data-activity'))).toEqual(['read', 'worker']);
    // The file is text: no control, and no reference.
    expect(within(rows[0] as HTMLElement).getByText('notes-3.txt').closest('button')).toBeNull();
    expect(group?.querySelector('[data-reference]')).toBeNull();
    // The worker's row has no Open button: no pane holds a tab for a chat without a session.
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: 'Open' })).toBeNull();
    expect(group?.querySelector('[data-open-worker]')).toBeNull();
    // A row still opens to what it kept, which Copy takes.
    const disclosure = rows[0]?.querySelector('button[aria-controls]') as HTMLElement;
    await act(async () => { fireEvent.click(disclosure); await Promise.resolve(); });
    expect(rows[0]?.querySelector('pre')?.textContent).toBe('No such file.');
    await act(async () => { fireEvent.click(within(rows[0] as HTMLElement).getByRole('button', { name: 'Copy output' })); await Promise.resolve(); await Promise.resolve(); });
    expect(written).toEqual(['No such file.']);
    expect(requests.map(([channel]) => channel)).toEqual(['conversations:readDetached']);
  });

  it('takes no update of it: a push that names the conversation, or a worker of it, changes nothing', async () => {
    const prompt = chatItem(ID, 'user', 'Read the notes.');
    const running = chatActivity(ID, prompt.turnId, { type: 'command', summary: 'rg notes', status: 'unfinished' });
    main = fakeChat(ID, [prompt, running]);
    await open();
    const before = screen.getByRole('group', { name: 'Messages' }).innerHTML;
    act(() => {
      bridge.push('chat:message', { sessionId: ID, revision: 1, item: { ...running, state: 'complete', activity: { ...(running.activity as NonNullable<ConversationItem['activity']>), status: 'completed' } }, turn: chatTurn(prompt.turnId) });
      bridge.push('chat:message', { sessionId: ID, revision: 2, item: chatActivity(ID, prompt.turnId, { type: 'read' }, { workerId: 'worker-1' }), turn: chatTurn(prompt.turnId), workerId: 'worker-1' });
    });
    await settle();
    expect(screen.getByRole('group', { name: 'Messages' }).innerHTML).toBe(before);
    expect(requests.map(([channel]) => channel)).toEqual(['conversations:readDetached']);
  });
});

// M21, V9 (C42): a chat without a session takes no prompt, so none of its cards can be answered.
describe('a question’s card in a chat without a session (M21: V9; C42)', () => {
  it('takes no answer whatever its outcome, with recorded answers folded until opened', async () => {
    const turn = main.items[0]?.turnId ?? '';
    main.items.push(
      chatCard(ID, turn, { outcome: 'answered', answers: [{ options: [1], text: null, secret: false }], settledAt: 5, confirmedAt: 6 }),
      chatCard(ID, turn, { mode: 'async', outcome: 'open' }),
      chatCard(ID, turn, { outcome: 'dropped', settledAt: 5 }),
    );
    const cards = (await open()).filter((article) => article.hasAttribute('data-interaction'));
    expect(cards.map((card) => card.dataset['outcome'])).toEqual(['answered', 'open', 'dropped']);
    const toggle = within(cards[0] as HTMLElement).getByRole('button', { name: 'Show questions and answers' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    for (const card of cards) {
      expect(card.querySelectorAll('input, textarea, fieldset, [data-card-submit], [data-card-decline]')).toHaveLength(0);
      expect(card.textContent).toContain('Which file should I read?');
    }
    expect(cards[0]?.querySelector('[data-card-outcome]')?.textContent).toBe('Answered');
    expect(cards[0]?.textContent).toContain('notes-2.txt');
    // An open card of a chat that takes no prompt says nothing became of it.
    expect(cards[1]?.querySelector('[data-card-outcome]')).toBeNull();
    // No record names its model: the label says no more than is known.
    expect(cards[1]?.getAttribute('aria-label')).toBe('Assistant asked a question and went on');
    expect(requests.map(([channel]) => channel)).toEqual(['conversations:readDetached']);
  });
});

// M22, V9 (C36, C57): a chat without a session has no process, so none of its approvals can be decided.
describe('an approval’s card in a chat without a session (M22: V9; C36)', () => {
  it('is drawn inert whatever its outcome: what was asked as text, its outcome in words, and no choice', async () => {
    const turn = main.items[0]?.turnId ?? '';
    const request = { choices: ['approve' as const, 'approve-session' as const, 'deny' as const], grant: { covers: 'Bash(touch notes.txt)' }, targets: ['notes.txt'], cut: true };
    main.items.push(
      chatApproval(ID, turn, { request, outcome: 'approved-session', decidedAt: 5, delivered: true, confirmedAt: 6, grant: { covers: 'Bash(touch notes.txt)', processKey: 'k1', live: false } }),
      chatApproval(ID, turn, { request, outcome: 'denied', decidedAt: 5, delivered: true, confirmedAt: 6 }),
      chatApproval(ID, turn, { request, outcome: 'dropped', settledAt: 5 }),
    );
    const cards = (await open()).filter((article) => article.dataset['kind'] === 'approval');
    expect(cards.map((card) => card.dataset['outcome'])).toEqual(['approved-session', 'denied', 'dropped']);
    for (const card of cards) {
      // The disclosure alone: no choice, no Stop, and a path that is text, since nothing opens here.
      expect([...card.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['The whole action']);
      expect(card.querySelector('[data-approval-summary]')?.textContent).toBe('touch notes.txt');
      // No record names its provider: the head says no more than is known.
      expect(card.getAttribute('aria-label')).toBe('The provider asked to run a command');
    }
    // A grant of restored history is ended: no process of it is left.
    expect(cards[0]?.querySelector('[data-card-outcome]')?.textContent).toBe('Approved for this session: covers Bash(touch notes.txt); ended with the process');
    expect(cards[1]?.querySelector('[data-card-outcome]')?.textContent).toBe('Denied');
    // What the store kept of the action can still be read, and is said shortened.
    await act(async () => { fireEvent.click(cards[0]?.querySelector('[data-approval-detail]') as HTMLElement); await Promise.resolve(); });
    expect(cards[0]?.querySelector('pre')?.textContent).toBe('touch notes.txt');
    expect(cards[0]?.querySelector('[data-item-line="cut"]')).not.toBeNull();
    expect(requests.map(([channel]) => channel)).toEqual(['conversations:readDetached']);
  });
});
