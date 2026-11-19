// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V19, V31 (docs/planning/_archive/M15.md, Design 13 and 14; C6, C58–C68, C96, C116, C122, C129) and M18's
// V9 and V15 (M18.md, Design 5 and 8; C18, C33, C35): the chat area, on a fake bridge that answers
// `chat:read` from a conversation the test holds and records each call.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockWords, CHAT_LINES, type ChatHistory, type ChatPush, REMOVE_CHAT_TEXT, removeUnsure } from '@shared/contracts/chat';
import { EMPTY_COMPOSER } from '@shared/contracts/composer';
import type { ConversationItem, ConversationsState } from '@shared/contracts/conversation';
import { MODE_WORDS } from '@shared/contracts/permissions';
import { SEND_BLOCKS, type SendBlock, type SessionEntry } from '@shared/contracts/sessions';
import type { ProviderSnapshot } from '@shared/contracts/status';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog, sampleCatalogProvider, sampleModel } from '../../../../tests/support/catalog';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { BUILT_IN_KINDS } from '../artifacts/kinds';
import { registerKinds, resetTabs, useTabs } from '../artifacts/tabs-store';
import { REFERENCE_WORDS } from '../markdown/controls';
import { useProjectDialog } from '../projects/project-dialog-store';
import { modeMenuAsked, resetModeMenuAsk } from '../session-area/mode-menu-store';
import { closeSandboxSetup, useSandboxSetup } from '../settings/sandbox-setup-store';
import { useSettings } from '../settings/settings-store';
import { ChatRegion } from '../shell/ChatRegion';
import { CHECKED, chatApproval, chatCard, chatItem, chatTurn, type FakeChat, fakeChat } from '../test/chat';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { availability, modedProvider } from '../test/permissions';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { explain, startFreshText, unchangedText } from '../ui/refusal-text';
import { CARD_WORDS } from './card-words';
import { useChatDrafts } from './chat-store';
import { showDetached } from './detached-store';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
/** What main holds, per session; a session in `withheld` has its answers held back until released. */
let held: Record<string, FakeChat>;
let withheld: Set<string>;
let waiting: (() => void)[];
let answers: Partial<Record<InvokeChannel, unknown>>;

beforeEach(() => {
  installDialogStandIn();
  bridge = installFakeBridge();
  requests = [];
  held = {};
  withheld = new Set();
  waiting = [];
  answers = {};
  useChatDrafts.setState({ drafts: {} });
  useSettings.setState({ open: false, target: null });
  useProjectDialog.setState({ open: false, projectId: null, added: null });
  showDetached(null);
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    if (channel === 'chat:read') {
      const { sessionId } = request as { sessionId: string };
      // A copy of the conversation as it is now: a held-back answer is what main said at the time.
      const now = { ok: true, value: (held[sessionId] ?? fakeChat(sessionId)).read(request as { sessionId: string }) };
      if (withheld.has(sessionId)) return new Promise((resolve) => { waiting.push(() => resolve(now)); });
      return now;
    }
    return { ok: true, value: answers[channel] ?? (channel === 'chat:send' ? { status: 'accepted' } : channel === 'chat:stop' ? { status: 'stopping' } : channel === 'chat:loadHistory' ? { status: 'loading' } : { status: 'saved' }) };
  });
});
afterEach(cleanup);

const A = project('Calamari', { providers: ['codex'] });
const CATALOG = { ...sampleCatalog([]), providers: [sampleCatalogProvider({ id: 'codex', models: [sampleModel({ key: 'gpt-6-sol', resolvedId: 'gpt-6-sol', name: 'GPT-6 Sol' })] })] };
const PROVIDERS = [sampleProvider({ id: 'codex', displayName: 'Codex' })];
const session = (name: string, summary = SUMMARIES.idle, block: SendBlock | null = null): SessionEntry => {
  const entry = sessionEntry(name, summary, { projectId: A.id, providerId: 'codex', model: 'gpt-6-sol', effort: 'high' });
  return { ...entry, block };
};
const ONE = session('Create plan');
const TWO = session('Fix bug');
const show = (entries: SessionEntry[], selectedId: string | null, conversations?: ConversationsState) =>
  act(() => { showState({ projects: [A], sessions: entries, selectedId, catalog: CATALOG, providers: PROVIDERS, ...(conversations === undefined ? {} : { conversations }) }); });

const message = chatItem;
const hold = (entry: SessionEntry, items: ConversationItem[], revision = items.length, history: ChatHistory = CHECKED): FakeChat => {
  const chat = fakeChat(entry.record.id, items, revision);
  chat.history = history;
  held[entry.record.id] = chat;
  return chat;
};
const itemPush = (sessionId: string, revision: number, item: ConversationItem): ChatPush => ({ sessionId, revision, item, turn: chatTurn(item.turnId, { place: item.order.turn }) });
const push = (payload: ChatPush) => act(() => { bridge.push('chat:message', payload); });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const chat = () => screen.getByRole('main', { name: 'Chat' });
const log = () => screen.getByRole('group', { name: 'Messages' });
const input = () => screen.getByRole('textbox', { name: 'Message to Codex' });
// Its accessible name says who speaks on every message, whether or not its head draws the label (C82); its text is the first line outside the head.
const texts = () => within(log()).queryAllByRole('article').map((article) => `${article.getAttribute('aria-label') ?? ''}: ${[...article.querySelectorAll('p')].find((line) => line.closest('[data-head]') === null)?.textContent ?? ''}`);
const sent = () => requests.filter(([channel]) => channel === 'chat:send').map(([, request]) => { const { revision: _revision, attachments: _attachments, ...rest } = request as Record<string, unknown>; return rest; });
const reads = () => requests.filter(([channel]) => channel === 'chat:read').length;

async function open(entries: SessionEntry[], selected: SessionEntry | null, conversations?: ConversationsState) {
  show(entries, selected?.record.id ?? null, conversations);
  render(<ChatRegion />);
  await settle();
}

describe('the chat area (V19)', () => {
  it('is empty with no session selected (C58)', async () => {
    await open([ONE], null);
    expect(chat().children).toHaveLength(0);
    expect(reads()).toBe(0);
  });

  it('labels each message in words, shows both phases, and the questions as plain lines (C62, C63)', async () => {
    const id = ONE.record.id;
    hold(ONE, [
      message(id, 'user', 'What is the cat’s name?'),
      message(id, 'assistant', 'I’ll read sample.txt.', { phase: 'commentary' }),
      message(id, 'assistant', 'Which file?', { questions: [{ title: 'Pick one', options: ['a.txt', 'b.txt'] }] }),
      message(id, 'notice', 'Codex stopped answering. The reply was ended.', { notice: 'connection-lost', detail: 'socket closed' }),
    ]);
    await open([ONE], ONE);
    expect(texts()).toEqual(['You: What is the cat’s name?', 'GPT-6 Sol: I’ll read sample.txt.', 'GPT-6 Sol: Which file?', 'fat-g: Codex stopped answering. The reply was ended.']);
    const articles = within(log()).getAllByRole('article');
    expect(articles.map((article) => article.getAttribute('data-phase'))).toEqual([null, 'commentary', 'final', null]);
    expect(articles.map((article) => article.getAttribute('data-role'))).toEqual(['user', 'assistant', 'assistant', 'notice']);
    expect(articles[2]?.textContent).toContain('Pick one');
    // One label when the speaker changes and no more (M100, round 9, C82): the second answer in a row draws none, and its name still says whose it is.
    expect([...log().querySelectorAll('[data-speaker-name]')].map((line) => line.textContent)).toEqual(['You', 'GPT-6 Sol', 'GPT-6 Sol', 'fat-g']);
    expect([...(articles[2]?.querySelectorAll('p') ?? [])].map((line) => line.textContent)).toEqual(['Which file?', 'Pick one', 'a.txt', 'b.txt']);
    // None of it is a control but the Copy buttons (M19, C38): one on the prompt and on each assistant's message, none on a notice.
    // An assistant's message is a part of its answer, whose foot copies it all; an answer of one part, as each here, has no
    // Copy button but its foot's (the maintainer).
    expect(articles.map((article) => within(article).queryAllByRole('button').map((button) => button.getAttribute('aria-label')))).toEqual([['Copy message'], [], [], []]);
    expect(within(log()).getAllByRole('button', { name: 'Copy entire message' })).toHaveLength(2);
    expect(articles[3]?.textContent).toContain('socket closed');
  });

  it('draws nothing for an item of a reserved kind (M18, C3)', async () => {
    const id = ONE.record.id;
    hold(ONE, [message(id, 'user', 'one'), message(id, 'assistant', '', { kind: 'attachment', role: null, phase: null, blocks: [] }), message(id, 'assistant', 'two')]);
    await open([ONE], ONE);
    expect(texts()).toEqual(['You: one', 'GPT-6 Sol: two']);
  });

  // M19 (C29–C33; amends M15, C59): an assistant's message is read as Markdown; a prompt, a notice, its detail and a question's lines are not.
  it('shows a prompt, a notice and a question as typed, and reads an assistant’s message as Markdown: no HTML made, no link that opens, no image', async () => {
    const typed = 'Look at <b>this</b> & **that**\n  [link](https://example.test) https://example.test <script>x()</script>';
    const id = ONE.record.id;
    hold(ONE, [
      message(id, 'user', typed),
      message(id, 'assistant', typed, { questions: [{ title: '**Pick** [one](https://q.test)', options: ['*a*'] }] }),
      message(id, 'notice', typed, { notice: 'turn-failed', detail: '**detail** <i>x</i>' }),
    ]);
    await open([ONE], ONE);
    const [prompt, answer, notice] = within(log()).getAllByRole('article');
    // As typed: its breaks and spaces kept, and nothing of it made into an element.
    expect(prompt?.querySelectorAll('p')[0]?.textContent).toBe(typed);
    expect(prompt?.querySelector('strong, em, b, a, script, img, code')).toBeNull();
    expect(notice?.querySelectorAll('p')[0]?.textContent).toBe(typed);
    expect(notice?.textContent).toContain('**detail** <i>x</i>');
    expect(notice?.querySelector('strong, em, i')).toBeNull();
    // The assistant's: emphasis is an element, raw HTML is the text it is, a link is its text and its address, and nothing can be followed or loaded.
    expect(answer?.querySelector('strong')?.textContent).toBe('that');
    expect(answer?.textContent).toContain('<b>this</b>');
    expect(answer?.textContent).toContain('link (https://example.test)');
    expect(answer?.textContent).toContain('<script>x()</script>');
    expect(log().querySelector('b, a, script, img, iframe, input')).toBeNull();
    // Its question stays plain lines (M15, C63; M21 draws its card).
    expect(answer?.textContent).toContain('**Pick** [one](https://q.test)');
    expect(answer?.textContent).toContain('*a*');
  });

  it('marks a cut message with a line that is not part of its text, and shows the lines that are not messages', async () => {
    hold(ONE, [message(ONE.record.id, 'assistant', 'Long…', { cut: true })], 1, { state: 'checked', olderUnread: true, earlierMissing: true });
    await open([ONE], ONE);
    const [article] = within(log()).getAllByRole('article');
    expect(article?.querySelectorAll('p')[0]?.textContent).toBe('Long…');
    expect(article?.textContent).toContain(CHAT_LINES.cut);
    // Apart, and together (M18, C18): neither hides the message.
    expect(log().textContent).toContain(CHAT_LINES.earlierMissing);
    expect(log().textContent).toContain(CHAT_LINES.olderUnread);
    expect(texts()).toEqual(['GPT-6 Sol: Long…']);
  });

  // M19 (C49; amends M15, C64): the list announces nothing by itself, so a message that is written is not read out a word at a time.
  it('keeps to the bottom while the reader is there, stays put once they scroll up, and is no live region (C64; M19, C49)', async () => {
    hold(ONE, [message(ONE.record.id, 'user', 'one')]);
    await open([ONE], ONE);
    const list = log();
    expect(list.getAttribute('aria-live')).toBeNull();
    expect(list.getAttribute('role')).toBe('group');
    expect(list.closest('[aria-live]')).toBeNull();
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
    push(itemPush(ONE.record.id, 2, message(ONE.record.id, 'assistant', 'two')));
    expect(list.scrollTop).toBe(1000);
    // Scrolled up: the next message leaves the view where it is.
    list.scrollTop = 300;
    fireEvent.scroll(list);
    push(itemPush(ONE.record.id, 3, message(ONE.record.id, 'assistant', 'three')));
    expect(list.scrollTop).toBe(300);
    expect(texts()).toHaveLength(3);
  });

  it('sends on Enter, breaks the line on Shift+Enter, and does neither while an input method composes (C65)', async () => {
    await open([ONE], ONE);
    fireEvent.change(input(), { target: { value: 'Fix the login bug' } });
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    expect(sent()).toEqual([]);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await settle();
    expect(sent()).toEqual([{ sessionId: ONE.record.id, prompt: 'Fix the login bug' }]);
    // Taken: the draft is cleared, and the focus stays in the text area.
    expect((input() as HTMLTextAreaElement).value).toBe('');
    expect(document.activeElement).toBe(input());
  });

  // M20b (C68; amends M15, C65): its height is the style sheet's to work out from what it holds, a
  // wrapped line counting as a line break does. No row count is set from the draft: the rule itself —
  // two lines at its smallest, eight at its tallest — is proven on the stylesheet (tests/architecture/styles.test.ts).
  it('is sized by what it holds, by the style sheet: no row count is set from the draft', async () => {
    await open([ONE], ONE);
    expect(input().hasAttribute('rows')).toBe(false);
    fireEvent.change(input(), { target: { value: 'a\nb\nc' } });
    expect(input().hasAttribute('rows')).toBe(false);
    fireEvent.change(input(), { target: { value: Array.from({ length: 12 }, (_, n) => String(n)).join('\n') } });
    expect(input().hasAttribute('rows')).toBe(false);
    expect(input().getAttribute('style')).toBeNull();
    // One long line with no break at all is sized the same way: nothing here counts its breaks.
    fireEvent.change(input(), { target: { value: 'word '.repeat(400) } });
    expect(input().hasAttribute('rows')).toBe(false);
    expect((input() as HTMLTextAreaElement).value).toHaveLength(2000);
  });

  it('takes a command typed and not chosen as text: a prompt that starts with a slash is sent as any other (M20b, C57, C59; M23, C59)', async () => {
    await open([ONE], ONE);
    fireEvent.change(input(), { target: { value: '/compact keep the plan' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await settle();
    // As it was written: what fat-g answers itself is main's to decide (C55), and never the page's.
    expect(sent()).toEqual([{ sessionId: ONE.record.id, prompt: '/compact keep the plan' }]);
  });

  it('is Send while idle and Stop while running, workers alone included; Enter starts no prompt while it runs (C66, C99; M23: it sends now, which main holds until the turn or its workers can take it)', async () => {
    await open([session('Running', SUMMARIES.runningThinking)], session('Running', SUMMARIES.runningThinking));
    cleanup();
    for (const summary of [SUMMARIES.runningThinking, SUMMARIES.waitingOnWorkers]) {
      const running = session('Running', summary);
      await open([running], running);
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      fireEvent.change(input(), { target: { value: 'More' } });
      expect((input() as HTMLTextAreaElement).value).toBe('More');
      fireEvent.keyDown(input(), { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await settle();
      expect(sent()).toEqual([expect.objectContaining({ prompt: 'More', when: 'now' })]);
      expect(requests.filter(([channel]) => channel === 'chat:stop')).toEqual([['chat:stop', { sessionId: running.record.id }]]);
      cleanup();
      requests = [];
    }
    await open([ONE], ONE);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('leaves an async card’s Submit usable while its turn runs exactly where main says the turn takes a message now (M23, C45)', async () => {
    for (const sendNow of [true, false]) {
      const running = session('Running', SUMMARIES.runningThinking);
      hold(running, [chatCard(running.record.id, 't1', { mode: 'async', outcome: 'open' })]).composer = { ...EMPTY_COMPOSER, steer: sendNow ? 'open' : 'wait' };
      await open([running], running);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' }).disabled).toBe(!sendNow);
      expect(within(log()).queryByText(CARD_WORDS.intoTurn('Codex')) !== null).toBe(sendNow);
      cleanup();
    }
  });

  // M23 (C31, C86) amends C67: the draft is kept per session, and handed to main as a draft — at a
  // session switch at once — so that a restart keeps it; none of it is sent before Send.
  it('keeps a draft per session, hands it to main as a draft when the chat goes, and sends none of it before Send (C67; M23, C31)', async () => {
    await open([ONE, TWO], ONE);
    fireEvent.change(input(), { target: { value: 'For one' } });
    show([ONE, TWO], TWO.record.id);
    await settle();
    expect((input() as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(input(), { target: { value: 'For two' } });
    show([ONE, TWO], ONE.record.id);
    await settle();
    expect((input() as HTMLTextAreaElement).value).toBe('For one');
    expect(sent()).toEqual([]);
    const drafts = requests.filter(([channel]) => channel === 'chat:draft').map(([, request]) => request);
    expect(drafts).toEqual([
      { sessionId: ONE.record.id, op: 'text', revision: 1, prompt: 'For one', intent: { plan: false, skill: null } },
      { sessionId: TWO.record.id, op: 'text', revision: 1, prompt: 'For two', intent: { plan: false, skill: null } },
    ]);
    expect(requests.filter(([channel]) => channel !== 'chat:draft').every(([, request]) => !JSON.stringify(request).includes('For'))).toBe(true);
  });

  // V3 (C6) and C68: the reason, in words, with its remedy. A refused conversation store has a note of its own, below.
  it.each(SEND_BLOCKS.filter((block) => block !== 'conversations-refused'))('puts the reason %s in place of the input, with its remedy', async (block) => {
    const entry = session('Held', SUMMARIES.idle, block);
    await open([entry], entry);
    expect(screen.queryByRole('textbox')).toBeNull();
    const note = screen.getByRole('note');
    const { text, remedy } = blockWords(block, 'Codex');
    expect(note.textContent).toContain(text);
    if (remedy === 'settings') {
      fireEvent.click(within(note).getByRole('button', { name: 'Settings' }));
      expect(useSettings.getState()).toEqual({ open: true, target: { provider: 'codex', instanceId: entry.record.instanceId }, tab: 'accounts' });
    } else if (remedy === 'edit-project') {
      fireEvent.click(within(note).getByRole('button', { name: 'Edit project' }));
      expect(useProjectDialog.getState()).toMatchObject({ open: true, projectId: A.id });
    } else if (remedy === 'change-mode') {
      // The two mode blocks (M22, C46, C89): their remedy is the mode control on the status bar (M100, C36).
      resetModeMenuAsk();
      fireEvent.click(within(note).getByRole('button', { name: 'Change mode' }));
      expect(modeMenuAsked(entry.record.id)).toBe(1);
    } else {
      expect(within(note).queryAllByRole('button')).toEqual([]);
    }
  });

  // M100 (round 8; C77): the hold's own words, which name the variable, are said here; the model column that said them is gone.
  it('says a session held for a moved configuration folder in the hold’s words, naming the variable and no path', async () => {
    const entry: SessionEntry = { ...session('Held', SUMMARIES.idle, 'folder-moved'), hold: 'folder-moved' };
    act(() => { showState({ projects: [A], sessions: [entry], selectedId: entry.record.id, catalog: CATALOG, providers: [sampleProvider({ id: 'codex', displayName: 'Codex', instanceVariable: 'CODEX_HOME' })] }); });
    render(<ChatRegion />);
    await settle();
    const note = screen.getByRole('note');
    expect(note.dataset['chatBlock']).toBe('folder-moved');
    expect(note.querySelector('p')?.textContent).toBe('This session started in another configuration folder than its account has now (CODEX_HOME). It cannot be continued until fat-g is started with that folder again.');
    expect(within(note).queryAllByRole('button')).toEqual([]);
  });

  it('keeps the input and its draft while its earlier messages are checked, with Send disabled and a line saying so (C122; M18, C52)', async () => {
    for (const state of ['not-checked', 'checking'] as const) {
      hold(ONE, [], 0, { state, olderUnread: false, earlierMissing: true });
      await open([ONE], ONE);
      fireEvent.change(input(), { target: { value: 'Waiting' } });
      expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true);
      expect(chat().textContent).toContain(CHAT_LINES.loading);
      // The check may still bring them: nothing says yet that they are not saved.
      expect(log().textContent).not.toContain(CHAT_LINES.earlierMissing);
      fireEvent.keyDown(input(), { key: 'Enter' });
      await settle();
      expect(sent()).toEqual([]);
      expect((input() as HTMLTextAreaElement).value).toBe('Waiting');
      cleanup();
    }
  });

  it('shows a failed history check with Try again, and leaves Send usable (C93)', async () => {
    hold(ONE, [], 0, { state: 'failed', olderUnread: false, earlierMissing: true });
    await open([ONE], ONE);
    expect(log().textContent).toContain(CHAT_LINES.historyFailed);
    fireEvent.click(within(log()).getByRole('button', { name: 'Try again' }));
    await settle();
    expect(requests.filter(([channel]) => channel === 'chat:loadHistory')).toEqual([['chat:loadHistory', { sessionId: ONE.record.id }]]);
    fireEvent.change(input(), { target: { value: 'Go on' } });
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false);
  });

  it('says as plain fact that earlier messages are not saved for a provider with no history, and leaves Send usable (M18, C18)', async () => {
    hold(ONE, [message(ONE.record.id, 'user', 'one')], 1, { state: 'unsupported', olderUnread: false, earlierMissing: true });
    await open([ONE], ONE);
    expect(log().textContent).toContain(CHAT_LINES.earlierMissing);
    expect(within(log()).queryByRole('button', { name: 'Try again' })).toBeNull();
    fireEvent.change(input(), { target: { value: 'Go on' } });
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', false);
    expect(chat().textContent).not.toContain(CHAT_LINES.loading);
  });

  it('says why a Send was refused as unconfirmed, and keeps the draft (C116)', async () => {
    answers['chat:send'] = { status: 'refused', reason: 'unconfirmed' };
    await open([ONE], ONE);
    fireEvent.change(input(), { target: { value: 'Again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();
    expect(chat().textContent).toContain(CHAT_LINES.unconfirmed('Codex'));
    expect((input() as HTMLTextAreaElement).value).toBe('Again');
  });

  it('offers to remove a session that did not reopen, unsure in its words, and removes it through M14’s confirmation (C129)', async () => {
    hold(ONE, [message(ONE.record.id, 'notice', 'Codex could not reopen this conversation.', { notice: 'session-not-reopened' })]);
    await open([ONE], ONE);
    fireEvent.click(within(log()).getByRole('button', { name: 'Remove session' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain(removeUnsure('Codex'));
    // The saved chat goes too, and nothing of the provider's (M18, C21).
    expect(dialog.textContent).toContain(REMOVE_CHAT_TEXT.session('Codex'));
    // Neither sentence says that the conversation is gone.
    expect(dialog.textContent).not.toMatch(/conversation (was|is|has been) deleted/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(requests.filter(([channel]) => channel === 'sessions:remove')).toEqual([['sessions:remove', { id: ONE.record.id }]]);
  });

  it.each(['conversations-refused', 'storage-failed'] as const)('says so when that removal is refused as %s (M18, C42, C63)', async (reason) => {
    answers['sessions:remove'] = { status: 'refused', reason };
    hold(ONE, [message(ONE.record.id, 'notice', 'Codex could not reopen this conversation.', { notice: 'session-not-reopened' })]);
    await open([ONE], ONE);
    fireEvent.click(within(log()).getByRole('button', { name: 'Remove session' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    await settle();
    expect(chat().textContent).toContain('fat-g could not remove the session.');
  });
});

describe('a refused conversation store (M18, V14; C33)', () => {
  const REFUSED: ConversationsState = { status: { kind: 'refused', cause: 'newer' }, detached: 0 };

  it('puts the note in place of the list and the input, reads nothing, and starts fresh only after a confirmation', async () => {
    answers['conversations:startFresh'] = { status: 'done', keptAs: 'D:\\data\\conversations.set-aside.2020-01-25T10-00-00Z.sqlite' };
    const entry = session('Held', SUMMARIES.idle, 'conversations-refused');
    await open([entry], entry, REFUSED);
    expect(screen.queryByRole('group', { name: 'Messages' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(reads()).toBe(0);
    const { cause, remedy } = explain('conversations', 'newer');
    expect(chat().textContent).toContain(unchangedText('conversations'));
    expect(chat().textContent).toContain(`${cause} ${remedy}`);
    fireEvent.click(within(chat()).getByRole('button', { name: 'Start fresh…' }));
    const dialog = screen.getByRole('dialog', { name: 'Start fresh?' });
    expect(dialog.textContent).toContain(startFreshText('conversations'));
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests).toEqual([]);
    fireEvent.click(within(chat()).getByRole('button', { name: 'Start fresh…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Start fresh?' })).getByRole('button', { name: 'Start fresh' }));
    await settle();
    expect(requests).toEqual([['conversations:startFresh', null]]);
    // Main opens a new store: the chat is read from it, and the input is back.
    show([{ ...entry, block: null }], entry.record.id, { status: { kind: 'ok' }, detached: 0 });
    await settle();
    expect(reads()).toBe(1);
    expect(screen.getByRole('group', { name: 'Messages' })).toBeTruthy();
    expect(input()).toBeTruthy();
  });

  it('says so when the files could not be moved, and keeps the note', async () => {
    bridge.setInvoke(async () => Promise.resolve({ ok: false, error: 'internal' }));
    const entry = session('Held', SUMMARIES.idle, 'conversations-refused');
    await open([entry], entry, REFUSED);
    fireEvent.click(within(chat()).getByRole('button', { name: 'Start fresh…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Start fresh?' })).getByRole('button', { name: 'Start fresh' }));
    await settle();
    expect(chat().textContent).toContain('fat-g could not move the files. Nothing was changed.');
    expect(chat().textContent).toContain(unchangedText('conversations'));
  });

  it('shows the note when the read itself says the store is refused, and reads again after Start fresh', async () => {
    answers['conversations:startFresh'] = { status: 'done', keptAs: 'kept' };
    const main = hold(ONE, []);
    main.storage = 'refused';
    await open([ONE], ONE);
    expect(screen.queryByRole('group', { name: 'Messages' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(chat().textContent).toContain(unchangedText('conversations'));
    main.storage = 'ok';
    fireEvent.click(within(chat()).getByRole('button', { name: 'Start fresh…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Start fresh?' })).getByRole('button', { name: 'Start fresh' }));
    await settle();
    await settle();
    expect(reads()).toBe(2);
    expect(input()).toBeTruthy();
  });
});

describe('a chat without a session, in the chat region (M18, V15; C31, C35)', () => {
  const DETACHED = { id: '0d0d0d0d-0000-4000-8000-00000000000d', name: 'Plan the trip', createdAt: 1_579_696_800_000 };

  it('is drawn in place of the selected session’s chat, with no input, until a session is selected', async () => {
    answers['conversations:readDetached'] = { status: 'page', sessionId: DETACHED.id, revision: 0, items: [message(DETACHED.id, 'user', 'Plan the trip'), message(DETACHED.id, 'assistant', 'Where to?')], turns: [], older: null };
    hold(ONE, [message(ONE.record.id, 'user', 'one’s')]);
    await open([ONE, TWO], ONE, { status: { kind: 'ok' }, detached: 1 });
    act(() => showDetached(DETACHED));
    await settle();
    expect(texts()).toEqual(['You: Plan the trip', 'Assistant: Where to?']);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain(CHAT_LINES.readOnly);
    expect(sent()).toEqual([]);
    // Another session selected: its own chat is back.
    show([ONE, TWO], TWO.record.id, { status: { kind: 'ok' }, detached: 1 });
    await settle();
    expect(screen.getByRole('textbox', { name: 'Message to Codex' })).toBeTruthy();
    expect(chat().querySelector('[data-detached-chat]')).toBeNull();
  });

  it('closes, and goes when no chat without a session is left', async () => {
    answers['conversations:readDetached'] = { status: 'page', sessionId: DETACHED.id, revision: 0, items: [message(DETACHED.id, 'user', 'Plan the trip')], turns: [], older: null };
    await open([ONE], ONE, { status: { kind: 'ok' }, detached: 1 });
    act(() => showDetached(DETACHED));
    await settle();
    fireEvent.click(within(screen.getByRole('note')).getByRole('button', { name: 'Close' }));
    await settle();
    expect(chat().querySelector('[data-detached-chat]')).toBeNull();
    expect(input()).toBeTruthy();
    act(() => showDetached(DETACHED));
    await settle();
    expect(chat().querySelector('[data-detached-chat]')).not.toBeNull();
    show([ONE], ONE.record.id, { status: { kind: 'ok' }, detached: 0 });
    await settle();
    expect(chat().querySelector('[data-detached-chat]')).toBeNull();
  });
});

describe('pushes and answers that cross (V31; C96)', () => {
  it('drops a push for the session not shown, though the revisions match', async () => {
    hold(ONE, [message(ONE.record.id, 'user', 'one')]);
    await open([ONE, TWO], ONE);
    push(itemPush(TWO.record.id, 2, message(TWO.record.id, 'user', 'for two')));
    expect(texts()).toEqual(['You: one']);
    expect(reads()).toBe(1);
  });

  it('drops a read answered after the selection changed', async () => {
    hold(ONE, [message(ONE.record.id, 'user', 'one’s')]);
    hold(TWO, [message(TWO.record.id, 'user', 'two’s')]);
    withheld.add(ONE.record.id);
    await open([ONE, TWO], ONE);
    show([ONE, TWO], TWO.record.id);
    await settle();
    act(() => { for (const release of waiting.splice(0)) release(); });
    await settle();
    expect(texts()).toEqual(['You: two’s']);
  });

  it('drops a duplicate, appends the next, and reads again on a gap or a change of the whole list', async () => {
    const id = ONE.record.id;
    const one = message(id, 'user', 'one');
    const main = hold(ONE, [one], 1);
    await open([ONE], ONE);
    const next = message(id, 'assistant', 'two');
    push(itemPush(id, 2, next));
    push(itemPush(id, 2, next));
    expect(texts()).toEqual(['You: one', 'GPT-6 Sol: two']);
    expect(reads()).toBe(1);
    // A gap: read again.
    const three = message(id, 'assistant', 'three');
    const four = message(id, 'assistant', 'four');
    main.items = [one, next, three, four];
    main.revision = 4;
    push(itemPush(id, 4, four));
    await settle();
    expect(reads()).toBe(2);
    expect(texts()).toEqual(['You: one', 'GPT-6 Sol: two', 'GPT-6 Sol: three', 'GPT-6 Sol: four']);
    // A change of the whole list: read again, and the history state with it.
    main.revision = 5;
    main.history = { state: 'failed', olderUnread: false, earlierMissing: false };
    push({ sessionId: id, revision: 5, changed: true });
    await settle();
    expect(reads()).toBe(3);
    expect(log().textContent).toContain(CHAT_LINES.historyFailed);
  });

  it('drops a read answered after a newer push, and keeps the newer message', async () => {
    const id = ONE.record.id;
    const one = message(id, 'user', 'one');
    const main = hold(ONE, [one], 1);
    await open([ONE], ONE);
    // A whole-list change asks for a read, held back at revision 2.
    main.revision = 2;
    withheld.add(id);
    push({ sessionId: id, revision: 2, changed: true });
    await settle();
    // Then a message after a gap: read again, answered at once at revision 3.
    withheld.delete(id);
    const three = message(id, 'assistant', 'three');
    main.items = [one, three];
    main.revision = 3;
    push(itemPush(id, 3, three));
    await settle();
    expect(texts()).toEqual(['You: one', 'GPT-6 Sol: three']);
    // The older answer arrives last: dropped.
    act(() => { for (const release of waiting.splice(0)) release(); });
    await settle();
    expect(texts()).toEqual(['You: one', 'GPT-6 Sol: three']);
  });

  it('reads once more when a push came before the first answer and is newer than it', async () => {
    const id = ONE.record.id;
    withheld.add(id);
    const one = message(id, 'user', 'one');
    const main = hold(ONE, [one], 1);
    await open([ONE], ONE);
    const two = message(id, 'assistant', 'two');
    push(itemPush(id, 2, two));
    withheld.delete(id);
    main.items = [one, two];
    main.revision = 2;
    act(() => { for (const release of waiting.splice(0)) release(); });
    await settle();
    await settle();
    expect(reads()).toBe(2);
    expect(texts()).toEqual(['You: one', 'GPT-6 Sol: two']);
  });
});

// ── M19b ──────────────────────────────────────────────────────────────────────────────────────
// V11 (docs/planning/_archive/M19b.md; C20, C21, C24): the chat gives its session's opener to the messages it
// draws as Markdown — an assistant's — and to no other. A press reaches main's channels, naming the session.
describe('references in a session’s messages (M19b: V11; C21)', () => {
  const README = 'D:\\Code\\Calamari\\README.md';
  const ANSWER = 'It is in `src/tides.js:12`; see [the README](README.md) and https://example.com/tides.';
  const controls = () => [...log().querySelectorAll<HTMLButtonElement>('[data-reference] > button')];
  const press = (button: Element) => act(async () => { fireEvent.click(button); await Promise.resolve(); await Promise.resolve(); });
  const asked = (channel: InvokeChannel) => requests.filter(([name]) => name === channel).map(([, request]) => request);

  beforeEach(() => {
    resetTabs();
    registerKinds(BUILT_IN_KINDS);
  });

  it('draws a reference in an assistant’s message as a control, of either phase, and none in a prompt, a notice or a question’s lines', async () => {
    const id = ONE.record.id;
    hold(ONE, [
      message(id, 'user', 'Where is `src/tides.js:12`? See https://example.com/a and [x](README.md).'),
      message(id, 'assistant', 'I’ll read `README.md`.', { phase: 'commentary' }),
      message(id, 'assistant', ANSWER, { questions: [{ title: 'Open `README.md`?', options: ['`src/tides.js`', 'https://example.com/b'] }] }),
      message(id, 'notice', 'Codex stopped answering: see `README.md` and https://example.com/c.', { notice: 'connection-lost', detail: 'in `src/tides.js:12`' }),
    ]);
    await open([ONE], ONE);
    const articles = within(log()).getAllByRole('article');
    expect(articles.map((article) => article.querySelectorAll('[data-reference]').length)).toEqual([0, 1, 3, 0]);
    expect(controls().map((button) => button.textContent)).toEqual(['README.md', 'src/tides.js:12', 'the README', 'https://example.com/tides']);
    // What is not drawn as Markdown is the text it was.
    expect(articles[0]?.textContent).toContain('Where is `src/tides.js:12`? See https://example.com/a and [x](README.md).');
    expect(log().querySelector('a, [href]')).toBeNull();
  });

  it('hands a local press to main’s reader and an external one to main’s channel for the browser, naming the session', async () => {
    hold(ONE, [message(ONE.record.id, 'assistant', ANSWER)]);
    answers['files:read'] = { outcome: 'text', path: README, root: 'D:\\Code\\Calamari', view: 'markdown', text: '# Calamari\n', revision: null, line: null, column: null };
    await open([ONE], ONE);
    const [code, link, bare] = controls();
    await press(link as Element);
    expect(asked('files:read')).toEqual([{ sessionId: ONE.record.id, target: 'README.md' }]);
    expect(useTabs.getState().sessions[ONE.record.id]?.tabs.map((tab) => [tab.kind, tab.reference, tab.title])).toEqual([['file', README, 'README.md']]);
    await press(code as Element);
    expect(asked('files:read').at(-1)).toEqual({ sessionId: ONE.record.id, target: 'src/tides.js:12' });
    await press(bare as Element);
    expect(asked('shell:openAddress')).toEqual([{ address: 'https://example.com/tides' }]);
    // The page named no base folder, and asked for nothing else — beside the chat's own reads, and its review's (M22e, C44).
    expect(requests.map(([channel]) => channel).filter((channel) => !channel.startsWith('chat:') && channel !== 'reviews:read' && channel !== 'plans:workflow')).toEqual(['files:read', 'files:read', 'shell:openAddress']);
  });

  it('says beside a reference why it did not open, announces it, and opens no tab', async () => {
    hold(ONE, [message(ONE.record.id, 'assistant', 'See `../elsewhere/secret.md`.')]);
    answers['files:read'] = { outcome: 'refused', why: 'outside' };
    await open([ONE], ONE);
    await press(controls()[0] as Element);
    const article = within(log()).getByRole('article');
    expect(article.textContent).toContain(REFERENCE_WORDS.outside);
    expect(within(article).getAllByRole('status').map((status) => status.textContent)).toContain(REFERENCE_WORDS.outside);
    expect(useTabs.getState().sessions[ONE.record.id]).toBeUndefined();
  });

  it('opens each session’s references in that session’s own tabs', async () => {
    hold(ONE, [message(ONE.record.id, 'assistant', 'See `README.md`.')]);
    hold(TWO, [message(TWO.record.id, 'assistant', 'See `README.md` too.')]);
    answers['files:read'] = { outcome: 'text', path: README, root: 'D:\\Code\\Calamari', view: 'markdown', text: '# Calamari\n', revision: null, line: null, column: null };
    await open([ONE, TWO], ONE);
    await press(controls()[0] as Element);
    show([ONE, TWO], TWO.record.id);
    await settle();
    await press(controls()[0] as Element);
    expect(asked('files:read').map((request) => (request as { sessionId: string }).sessionId)).toEqual([ONE.record.id, TWO.record.id]);
    expect(Object.keys(useTabs.getState().sessions).sort()).toEqual([ONE.record.id, TWO.record.id].sort());
  });

  it('draws no message again when the chat is drawn again: the session’s opener is one value', async () => {
    hold(ONE, [message(ONE.record.id, 'assistant', ANSWER)]);
    await open([ONE], ONE);
    const before = [...log().querySelectorAll('article *')];
    // A snapshot that changes nothing of the conversation: the area is drawn again, and no block is.
    show([ONE], ONE.record.id);
    fireEvent.change(input(), { target: { value: 'a draft' } });
    expect([...log().querySelectorAll('article *')]).toEqual(before);
  });

  it('gives a chat without a session no opener: its references stay text (M18, C35)', async () => {
    const DETACHED = { id: '0d0d0d0d-0000-4000-8000-00000000000d', name: 'Plan the trip', createdAt: 1_579_696_800_000 };
    answers['conversations:readDetached'] = { status: 'page', sessionId: DETACHED.id, revision: 0, items: [message(DETACHED.id, 'assistant', ANSWER)], turns: [], older: null };
    await open([ONE], ONE, { status: { kind: 'ok' }, detached: 1 });
    act(() => showDetached(DETACHED));
    await settle();
    expect(log().textContent).toContain('It is in src/tides.js:12; see the README (README.md) and https://example.com/tides.');
    expect(controls()).toEqual([]);
    expect(log().querySelector('code')?.closest('button')).toBeNull();
  });
});

// M22, V29 (docs/planning/_archive/M22.md, Design 3, 10; C43, C46, C60, C89): the two mode blocks, and their
// remedy, which is taken under either of them.
describe('a chat whose mode blocks it (M22: V29; C46, C89)', () => {
  const NEEDS = [availability('sandbox-ok', { available: false, reason: 'needs-setup', setup: true })];
  const blocked = (block: SendBlock, mode = 'sandbox-ok'): SessionEntry => ({ ...session('Held', SUMMARIES.idle, block), mode: { id: mode, source: 'chat' } });
  const showWith = (entry: SessionEntry, modes = NEEDS) =>
    act(() => { showState({ projects: [A], sessions: [entry], selectedId: entry.record.id, catalog: CATALOG, providers: [modedProvider({ id: 'codex', displayName: 'Codex', modes })] }); });
  async function openWith(entry: SessionEntry, modes = NEEDS) {
    showWith(entry, modes);
    render(<ChatRegion />);
    await settle();
  }
  const note = () => within(screen.getByRole('main', { name: 'Chat' })).getByRole('note');
  const buttons = () => within(note()).getAllByRole('button').map((button) => button.textContent);

  beforeEach(() => {
    resetModeMenuAsk();
    closeSandboxSetup();
  });

  it('attaches the mode tab to the normal composer and keeps it reachable across blocked-state transitions', async () => {
    const entry: SessionEntry = { ...session('Ready'), mode: { id: 'ask-first', source: 'chat' } };
    await openWith(entry, []);
    const section = () => document.querySelector('[data-composer-section]');
    const mode = () => document.querySelector('[data-session-mode]') as HTMLElement;
    expect(section()?.contains(mode())).toBe(true);
    const row = mode().closest('[data-prompt-controls]');
    expect(row?.querySelector('[role="toolbar"]')).not.toBeNull();
    expect((row?.compareDocumentPosition(input()) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    showWith({ ...entry, block: 'mode-unconfirmed' }, []);
    expect(section()).toBeNull();
    expect(mode().closest('[data-prompt-area]')).toBeNull();
    fireEvent.click(within(note()).getByRole('button', { name: 'Change mode' }));
    expect(screen.getByRole('menu', { name: 'Permission Mode' })).not.toBeNull();

    showWith(entry, []);
    expect(section()?.contains(mode())).toBe(true);
    expect(document.querySelectorAll('[data-session-mode]')).toHaveLength(1);
  });

  // Decision 0033: the context meter stands before the mode control, in its row, wherever that goes.
  it('stands the context meter just before the mode control, and moves it with the control', async () => {
    const reporting = (): ProviderSnapshot => {
      const shown = modedProvider({ id: 'codex', displayName: 'Codex', modes: [] });
      return { ...shown, descriptor: { ...shown.descriptor, capabilities: { ...shown.descriptor.capabilities, context: true } } };
    };
    const show = (entry: SessionEntry) => act(() => { showState({ projects: [A], sessions: [entry], selectedId: entry.record.id, catalog: CATALOG, providers: [reporting()] }); });
    const entry: SessionEntry = { ...session('Ready'), mode: { id: 'ask-first', source: 'chat' } };
    show(entry);
    render(<ChatRegion />);
    await settle();
    const meter = () => document.querySelector('[data-context-meter]') as HTMLElement;
    const mode = () => document.querySelector('[data-session-mode]') as HTMLElement;
    expect(meter().closest('[data-prompt-controls]')).not.toBeNull();
    expect(meter().parentElement).toBe(mode().parentElement);
    expect(meter().compareDocumentPosition(mode()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    show({ ...entry, block: 'mode-unconfirmed' });
    expect(meter().closest('[data-prompt-area]')).toBeNull();
    expect(meter().parentElement).toBe(mode().parentElement);
    expect(document.querySelectorAll('[data-context-meter]')).toHaveLength(1);
  });

  it('says a mode its account cannot use by the mode’s name and its reason, with Change mode and — where the CLI’s setup is what it needs — Set up (C43, C60)', async () => {
    const entry = blocked('mode-unavailable');
    await openWith(entry);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(note().dataset['chatBlock']).toBe('mode-unavailable');
    expect(note().textContent).toContain('Sandbox ok needs Codex’s sandbox, which this account does not have. Choose another mode.');
    expect(buttons()).toEqual(['Change mode', 'Set up']);
    fireEvent.click(within(note()).getByRole('button', { name: 'Set up' }));
    // The dialog of the session's own account; nothing is sent by opening it.
    expect(useSandboxSetup.getState()).toEqual({ open: true, target: { providerId: 'codex', instanceId: entry.record.instanceId } });
    expect(requests.some(([channel]) => channel === 'instances:setupSandbox')).toBe(false);
  });

  it('offers no Set up where a setup is not what the mode waits for', async () => {
    await openWith(blocked('mode-unavailable', 'berserk'), [availability('berserk', { available: false, reason: 'unvalidated' })]);
    expect(note().textContent).toContain('Berserk has not been shown to work on this version of Codex. Choose another mode.');
    expect(buttons()).toEqual(['Change mode']);
  });

  // Decision 0016: the exact version the chat was made with is gone from its account's list; nothing is put in its place.
  it('says a model its account no longer lists in place of the input, with no remedy, and keeps the chat’s messages', async () => {
    await openWith(blocked('model-not-listed'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(note().dataset['chatBlock']).toBe('model-not-listed');
    expect(note().textContent).toContain('Codex’s CLI no longer lists this chat’s model, and fat-g does not switch a chat to another.');
    expect(within(note()).queryAllByRole('button')).toEqual([]);
    expect(screen.getByRole('group', { name: 'Messages' })).toBeTruthy();
  });

  it('says a mode no start confirmed by its name, with Change mode alone (C46)', async () => {
    await openWith(blocked('mode-unconfirmed', 'ask-first'), []);
    expect(note().dataset['chatBlock']).toBe('mode-unconfirmed');
    expect(note().textContent).toContain('Codex reported another policy than Ask first; nothing was sent. Choose a mode this account runs.');
    expect(buttons()).toEqual(['Change mode']);
  });

  // M100 (the maintainer's review): the mode control stands at the list's foot, above the thick rule, with no line saying it applies at the next prompt.
  it('stands at the foot of the list, after it and before the prompt area, and says nothing on screen of the next prompt', async () => {
    await openWith(blocked('mode-unconfirmed', 'ask-first'), []);
    const control = document.querySelector('[data-session-mode]') as HTMLElement;
    const list = screen.getByRole('group', { name: 'Messages' });
    const prompt = document.querySelector('[data-prompt-area]') as HTMLElement;
    expect(list.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(control.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prompt.contains(control)).toBe(false);
    expect(control.textContent).not.toContain(MODE_WORDS.atNextPrompt);
  });

  it.each(['mode-unavailable', 'mode-unconfirmed'] as const)('takes the change its remedy offers under %s: the menu opens, the change is asked, and once main has taken it the input is back and the next prompt is sent (C89)', async (block) => {
    const entry = blocked(block);
    await openWith(entry);
    fireEvent.click(within(note()).getByRole('button', { name: 'Change mode' }));
    // The control on the status bar, opened for the keyboard on the chat's saved mode.
    const menu = screen.getByRole('menu', { name: 'Permission Mode' });
    expect(document.activeElement).toBe(menu.querySelector('[data-mode="sandbox-ok"]'));
    answers['chat:setMode'] = { status: 'set' };
    fireEvent.click(menu.querySelector('[data-mode="ask-first"]') as HTMLElement);
    await settle();
    expect(sent()).toEqual([]);
    expect(requests.filter(([channel]) => channel === 'chat:setMode').map(([, request]) => request)).toEqual([{ sessionId: entry.record.id, mode: 'ask-first' }]);
    // Main publishes the chat's new mode, and no block: the input stands where the reason stood.
    showWith({ ...entry, block: null, mode: { id: 'ask-first', source: 'chat' } });
    expect(within(screen.getByRole('main', { name: 'Chat' })).queryByRole('note')).toBeNull();
    fireEvent.change(input(), { target: { value: 'Go on.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();
    expect(sent()).toEqual([{ sessionId: entry.record.id, prompt: 'Go on.' }]);
  });

  it('hands the focus to the chat’s list when a block takes the input from under it, and when the block’s reason leaves in its turn: never to the page', async () => {
    const entry: SessionEntry = { ...session('Held'), mode: { id: 'sandbox-ok', source: 'chat' } };
    await openWith(entry);
    // The prompt was just sent from here: the start confirmed no mode, and the reason stands where the input stood.
    input().focus();
    showWith({ ...entry, block: 'mode-unconfirmed' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(log());
    // And back: the block ends while the focus is on its remedy.
    within(note()).getByRole<HTMLButtonElement>('button', { name: 'Change mode' }).focus();
    showWith({ ...entry, block: null });
    expect(input()).toBeInstanceOf(HTMLTextAreaElement);
    expect(document.activeElement).toBe(log());
    // The mode tab relocates above the status bar as the composer leaves; its old node hands
    // focus to the list too, rather than leaving it on the body.
    const control = (document.querySelector('[data-session-mode]') as HTMLElement).querySelector('button') as HTMLButtonElement;
    control.focus();
    showWith({ ...entry, block: 'mode-unconfirmed' });
    expect(document.activeElement).toBe(log());
    expect(document.querySelector('[data-session-mode]')?.closest('[data-prompt-area]')).toBeNull();
  });

  it('keeps the block where main refuses the mode asked for, and says that mode’s own reason under the control (C89)', async () => {
    const entry = blocked('mode-unconfirmed', 'ask-first');
    await openWith(entry, []);
    fireEvent.click(within(note()).getByRole('button', { name: 'Change mode' }));
    answers['chat:setMode'] = { status: 'refused', reason: 'mode-unavailable' };
    fireEvent.click(screen.getByRole('menu', { name: 'Permission Mode' }).querySelector('[data-mode="berserk"]') as HTMLElement);
    await settle();
    expect(document.querySelector('[data-session-mode] p[role="status"]')?.textContent).toBe('This account cannot use Berserk.');
    expect(note().dataset['chatBlock']).toBe('mode-unconfirmed');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('tells an approval’s card the account it belongs to and its provider’s modes, so it names both (C14, C56)', async () => {
    const entry: SessionEntry = { ...session('Asking', SUMMARIES.runningThinking), mode: { id: 'ask-first', source: 'chat' } };
    hold(entry, [chatItem(entry.record.id, 'user', 'Make a note.', { turnId: 't-a' }), chatApproval(entry.record.id, 't-a', { request: { modeThatWouldStop: 'edits-ok' } })]);
    act(() => {
      showState({ projects: [A], sessions: [entry], selectedId: entry.record.id, catalog: CATALOG, providers: [
        modedProvider({ id: 'codex', displayName: 'Codex', label: 'Home' }),
        modedProvider({ id: 'codex', displayName: 'Codex', instanceId: 'aaaaaaaa-0000-4000-8000-00000000000a', label: 'Work' }),
      ] });
    });
    render(<ChatRegion />);
    await settle();
    const card = screen.getByRole('article', { name: 'Codex asks to run a command' });
    expect(card.querySelector('[data-approval-account]')?.textContent).toBe('Account: Home');
    expect(card.querySelector('[data-approval-would-stop]')?.textContent).toBe('Edits ok would stop this question');
  });
});
