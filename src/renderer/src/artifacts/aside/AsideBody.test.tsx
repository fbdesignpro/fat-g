// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V11 (docs/planning/_archive/M20b.md; C5, C7, C11, C36–C43, C72, C73): an aside's tab, in the pane beside
// its session's chat, on a fake bridge that answers `chat:readAside` from what the test holds and
// records each request. What it shows is what main answered and pushed.
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AsideSource, capabilityWords, drawnDigest, NEW_ASIDE_TITLE } from '@shared/contracts/aside';
import type { ConversationItem } from '@shared/contracts/conversation';
import { type AsideStage, asideStage, CLAUDE_ASIDES, CODEX_ASIDES, type HeldAside, marker, session } from '../../test/asides';
import { chatActivity, chatItem, chatTurn } from '../../test/chat';
import { AGENTS_KIND, ASIDE_KIND, openAside } from '../opener';
import { TABS_LABEL } from '../TabList';
import { closeTab, selectTab, tabId } from '../tabs-store';
import { ASIDE_LIST_MARK } from './AsideBody';
import { ASIDE_WORDS, sourceWords } from './words';

const ONE = session('Create plan');
const TWO = session('Fix bug');
const ID = ONE.record.id;
const A = 'aside-1';
/** Another aside of the session, whose tab is shown in this one's place. */
const OTHER = 'aside-2';
const TAB = tabId(ASIDE_KIND, A);
const EXCERPT = 'The tide table lists high and low water.';
const SOURCE: AsideSource = { kind: 'message', itemId: 'answer-1', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 3, last: 5 }, range: { start: 5, end: 45 }, digest: '0badc0de', excerpt: EXCERPT, cut: false };

let stage: AsideStage;
beforeEach(() => { stage = asideStage(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const said = (role: 'user' | 'assistant' | 'notice', text: string, overrides: Partial<ConversationItem> = {}): ConversationItem => chatItem(A, role, text, { turnId: 'aside-turn-1', ...overrides });
/** What main holds of the aside: its question and its answer, unless said otherwise. */
function hold(overrides: Partial<HeldAside['view']> = {}, items: ConversationItem[] = [said('user', 'Explain this passage.', { id: 'q1' }), said('assistant', 'It lists the two tides.', { id: 'r1' })]): HeldAside {
  return (stage.asides[A] = { view: { id: A, title: 'The tide table lists high and low water.', source: SOURCE, createdAt: 1, running: false, ...overrides }, items, turns: [] });
}
/** The session's chat with the answer the aside was asked about, the pane beside it, and the aside's tab open. */
async function open({ asking = CODEX_ASIDES, title = 'The tide table lists high and low water.', focus = false }: { asking?: typeof CODEX_ASIDES | 'none'; title?: string | null; focus?: boolean } = {}) {
  const chat = stage.chat(ONE);
  chat.items = [chatItem(ID, 'user', 'What does the table list?', { id: 'prompt-1' }), chatItem(ID, 'assistant', '# Tides\n\nThe tide table lists high and low water.', { id: 'answer-1' })];
  chat.revision = 10;
  chat.asking = asking;
  await stage.open([ONE, TWO], ONE, true);
  act(() => { openAside(ID, A, title, focus); });
  await stage.settle();
}
const body = () => document.querySelector('[data-aside]') as HTMLElement;
const head = () => within(body()).getByRole('group', { name: ASIDE_WORDS.head });
const sourceLink = (source: AsideSource = SOURCE) => within(body()).getByRole('button', { name: sourceWords(source) });
const unfold = () => fireEvent.click(within(head()).getByRole('button', { name: ASIDE_WORDS.showExcerpt }));
const list = () => within(body()).getByRole('group', { name: ASIDE_WORDS.list });
const entries = () => within(list()).queryAllByRole('article');
const field = () => within(body()).getByRole<HTMLTextAreaElement>('textbox');
const tabs = () => within(screen.getByRole('tablist', { name: TABS_LABEL })).getAllByRole('tab');
const reads = () => stage.sent('chat:readAside');
/** A push of the aside's, as main sends one: under its session's id and revision, naming the aside. */
function push(item: ConversationItem, asideId: string | null = A, state: 'running' | 'ended' = 'running'): void {
  const chat = stage.chat(ONE);
  chat.revision += 1;
  if (asideId === A) stage.asides[A]?.items.push(item);
  stage.push({ sessionId: ID, revision: chat.revision, item, turn: chatTurn(item.turnId, state === 'running' ? { state: 'running', outcome: null } : {}), ...(asideId === null ? {} : { asideId }) });
}

describe('the tab and its title (C36)', () => {
  it('is one tab an aside, titled at once with the title it was opened with, then by what its own read says', async () => {
    hold({ title: 'The title main holds' });
    await open({ title: 'The title it was opened with' });
    expect(stage.tabs(ONE).map((tab) => [tab.kind, tab.reference])).toEqual([[ASIDE_KIND, A]]);
    expect(tabs().map((tab) => tab.querySelector('[data-tab-title]')?.textContent)).toEqual(['The title main holds']);
    // Opened again it is the same tab: its identity is the aside's id (M19b, C8).
    act(() => { openAside(ID, A, 'Another title'); });
    await stage.settle();
    expect(stage.tabs(ONE)).toHaveLength(1);
  });

  it('is "New aside" until a question is sent, and then the question’s first line', async () => {
    await open({ title: null, focus: true });
    expect(tabs().map((tab) => tab.querySelector('[data-tab-title]')?.textContent)).toEqual([NEW_ASIDE_TITLE]);
    // Main holds nothing of it: its read says so, and that is no failure.
    expect(reads()).toEqual([{ sessionId: ID, asideId: A }]);
    expect(within(body()).queryByText(ASIDE_WORDS.gone)).toBeNull();
    expect(within(body()).queryByRole('group', { name: ASIDE_WORDS.head })).toBeNull();
    expect(within(body()).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(field().placeholder).toBe(ASIDE_WORDS.firstPlaceholder);
    expect(document.activeElement).toBe(field());

    // Its first question: main records it, and its push names the aside.
    stage.ask = (request) => {
      stage.asides[A] = { view: { id: A, title: 'Why is the sea salty?', source: null, createdAt: 2, running: true }, items: [], turns: [chatTurn('aside-turn-1', { state: 'running', outcome: null })] };
      return { status: 'accepted', asideId: request.asideId };
    };
    fireEvent.change(field(), { target: { value: 'Why is the sea salty?\nIn one line.' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await stage.settle();
    expect(stage.sent('chat:ask')).toEqual([{ sessionId: ID, asideId: A, text: 'Why is the sea salty?\nIn one line.' }]);
    expect(field().value).toBe('');
    push(said('user', 'Why is the sea salty?\nIn one line.', { id: 'q1' }));
    await stage.settle();
    expect(tabs().map((tab) => tab.querySelector('[data-tab-title]')?.textContent)).toEqual(['Why is the sea salty?']);
    expect(entries().map((entry) => entry.getAttribute('data-role'))).toEqual(['user']);
    expect(field().placeholder).toBe(ASIDE_WORDS.placeholder);
  });
});

describe('its body, top to bottom (C11, C37, C43)', () => {
  it('keeps the source link visible above Explained excerpt, then starts the model turn immediately after the fold', async () => {
    hold();
    await open();
    const parts = [...body().children].map((part) => part.getAttribute('role') ?? part.className.replace(/^_|_.*$/g, ''));
    expect(parts).toEqual(['group', 'source', 'items', 'composer']);
    expect(within(body()).getByRole('group', { name: 'Explanation controls' }).textContent).toBe('Explanation');
    expect(within(head()).getByRole('button', { name: ASIDE_WORDS.showExcerpt }).getAttribute('aria-expanded')).toBe('false');
    expect(within(head()).queryByRole('button', { name: sourceWords(SOURCE) })).toBeNull();
    expect(sourceLink().textContent).toBe('Explaining chat lines 3–5');
    expect(sourceLink().closest(`[${ASIDE_LIST_MARK}]`)).toBeNull();
    expect(head().querySelector('[data-foldable]')?.textContent).toBe('Explained excerpt');
    expect(head().nextElementSibling?.getAttribute('data-speaker-role')).toBe('assistant');
    expect(list().textContent).not.toContain('Explain this passage.');
    expect(within(body()).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(body()).queryByText(capabilityWords(CODEX_ASIDES))).toBeNull();
    unfold();
    expect(sourceLink().textContent).toBe('Explaining chat lines 3–5');
    const quotation = within(body()).getByLabelText(ASIDE_WORDS.excerpt);
    expect(quotation.tagName).toBe('BLOCKQUOTE');
    expect(quotation.textContent).toBe(EXCERPT);
    expect(within(body()).queryByText(ASIDE_WORDS.cut)).toBeNull();
    expect(entries().map((entry) => [entry.getAttribute('data-role'), entry.getAttribute('aria-label')])).toEqual([['assistant', 'GPT-6 Sol']]);
    expect(field().getAttribute('aria-label')).toBe(ASIDE_WORDS.field);
    fireEvent.click(within(head()).getByRole('button', { name: ASIDE_WORDS.hideExcerpt }));
    expect(within(head()).queryByRole('button', { name: sourceWords(SOURCE) })).toBeNull();
    expect(sourceLink().textContent).toBe('Explaining chat lines 3–5');
    expect(stage.asides[A]?.items[0]?.blocks[0]?.text).toBe('Explain this passage.');
  });

  it('keeps a freely typed first question in the conversation, with no excerpt or capability line', async () => {
    hold({ source: null }, [said('user', 'Why is the sea salty?', { id: 'q1' }), said('assistant', 'Because of dissolved salts.', { id: 'r1' })]);
    await open({ asking: CLAUDE_ASIDES });
    expect(within(body()).queryByRole('group', { name: ASIDE_WORDS.head })).toBeNull();
    expect(within(body()).queryByText(capabilityWords(CLAUDE_ASIDES))).toBeNull();
    expect(entries().map((entry) => entry.getAttribute('data-role'))).toEqual(['user', 'assistant']);
    expect(entries()[0]?.textContent).toContain('Why is the sea salty?');
  });

  it('says a passage was cut to its bound, and names a file’s and an activity’s source in words', async () => {
    hold({ source: { ...SOURCE, cut: true } });
    await open();
    unfold();
    expect(within(body()).getByText(ASIDE_WORDS.cut)).not.toBeNull();
    expect(sourceWords({ ...SOURCE, kind: 'file', itemId: null, role: null, path: 'C:\\work\\tide-tools\\docs\\notes.md', lines: { first: 12, last: 12 } })).toBe('Explaining notes.md line 12');
    expect(sourceWords({ ...SOURCE, kind: 'file', itemId: null, role: null, path: '/home/someone/notes.md', lines: null })).toBe('Explaining notes.md');
    expect(sourceWords({ ...SOURCE, kind: 'activity', role: null, part: 'output', lines: null })).toBe('Explaining an action’s output');
    expect(sourceWords({ ...SOURCE, kind: 'activity', role: null, part: 'input', lines: null })).toBe('Explaining an action’s input');
    expect(sourceWords({ ...SOURCE, role: 'user', lines: null })).toBe('Explaining chat message');
    expect(sourceWords({ ...SOURCE, workerId: 'worker-1', lines: null })).toBe('Explaining sub-agent message');
  });

  it('draws its conversation with the chat’s own list, as Markdown, marked apart from the chat’s, and no answer of it is a source (C40)', async () => {
    hold({}, [said('user', 'Explain this passage.', { id: 'q1' }), said('assistant', 'It lists **two** tides.\n\n- high\n- low', { id: 'r1' })]);
    await open();
    expect(list().hasAttribute(ASIDE_LIST_MARK)).toBe(true);
    expect(list().hasAttribute('data-chat-list')).toBe(false);
    expect(entries()[0]?.querySelector('strong')?.textContent).toBe('two');
    expect(entries()[0]?.querySelectorAll('li')).toHaveLength(2);
    // No Explain this, no marker, and nothing marked as what a selection came from.
    expect(body().querySelectorAll('[data-explain], [data-aside-marker], [data-md-control], [data-source-kind]')).toHaveLength(0);
    // The chat beside it remains a source, with standalone Explain buttons hidden.
    expect(document.querySelectorAll('[data-chat-list] [data-explain]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-chat-list] [data-source-kind]').length).toBeGreaterThan(0);
  });

  it('labels an answer another model wrote by that model’s name, and one the session’s wrote by the session’s (C7)', async () => {
    hold({}, [said('user', 'One?', { id: 'q1' }), said('assistant', 'By the session’s model.', { id: 'r1' }), said('user', 'Two?', { id: 'q2', turnId: 'aside-turn-2' }), said('assistant', 'By another.', { id: 'r2', turnId: 'aside-turn-2', model: 'gpt-6-luna' }), said('assistant', 'By one the catalog has not.', { id: 'r3', turnId: 'aside-turn-2', model: 'some-other-model' })]);
    await open();
    const labels = () => entries().filter((entry) => entry.getAttribute('data-role') === 'assistant').map((entry) => entry.getAttribute('aria-label'));
    expect(labels()).toEqual(['GPT-6 Sol', 'GPT-6 Luna', 'some-other-model']);
    // After a tab change it is read again, and labelled the same: the name is the message's own, as main keeps it.
    act(() => { openAside(ID, OTHER, 'Another aside'); });
    await stage.settle();
    expect(document.querySelector(`[data-aside="${A}"]`)).toBeNull();
    act(() => { selectTab(ID, TAB); });
    await stage.settle();
    expect(labels()).toEqual(['GPT-6 Sol', 'GPT-6 Luna', 'some-other-model']);
  });

  it('draws what a Codex side thread did in the chat’s groups, between its question and its answer', async () => {
    hold({}, [said('user', 'What does the file say?', { id: 'q1' }), chatActivity(A, 'aside-turn-1', { type: 'read', name: 'read', summary: 'notes.md' }, { id: 'act-1' }), said('assistant', 'It says little.', { id: 'r1' })]);
    await open();
    expect(entries().map((entry) => entry.getAttribute('data-role'))).toEqual(['activity', 'assistant']);
    expect(entries()[0]?.textContent).toMatch(/Read 1 file/);
  });
});

describe('an answer on its way (C37, C39)', () => {
  it('streams a Codex answer as its text is written, by the pushes that name the aside', async () => {
    hold({ running: true }, [said('user', 'Explain this passage.', { id: 'q1' })]);
    (stage.asides[A] as HeldAside).turns = [chatTurn('aside-turn-1', { state: 'running', outcome: null })];
    await open();
    push(said('assistant', '', { id: 'r1', state: 'streaming' }));
    const chat = stage.chat(ONE);
    for (const [before, append] of [[0, 'It lists '], [9, 'the two tides.']] as const) {
      chat.revision += 1;
      stage.push({ sessionId: ID, revision: chat.revision, partial: { itemId: 'r1', before, append }, asideId: A });
    }
    expect(entries().at(-1)?.textContent).toContain('It lists the two tides.');
    expect(entries().at(-1)?.getAttribute('aria-busy')).toBe('true');
    // Nothing was read again for it: the text was appended.
    expect(reads()).toHaveLength(1);
    push(said('assistant', 'It lists the two tides.', { id: 'r1', state: 'complete' }), A, 'ended');
    expect(entries().at(-1)?.hasAttribute('aria-busy')).toBe(false);
    expect(entries()).toHaveLength(1);
  });

  it('shows one line, "Answering…" with the time counting, while a whole answer is awaited, and Stop in the button’s place', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2020-01-30T10:00:10.000Z'));
    hold({ running: true }, [said('user', 'Explain this passage.', { id: 'q1' })]);
    (stage.asides[A] as HeldAside).turns = [chatTurn('aside-turn-1', { state: 'running', outcome: null, time: { acceptedAt: Date.parse('2020-01-30T10:00:00.000Z'), providerStartedAt: null, providerEndedAt: null, endReceivedAt: null, providerDurationMs: null, elapsedMs: null } })];
    await open({ asking: CLAUDE_ASIDES });
    const waiting = () => body().querySelector('[data-turn-progress]');
    const counter = () => body().querySelector('[data-turn-counter]');
    expect(counter()?.textContent).toBe('10s');
    expect(waiting()?.getAttribute('aria-label')).toBe('Reply in progress');
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(counter()?.textContent).toBe('15s');
    expect(within(body()).getByRole('button', { name: ASIDE_WORDS.stop })).not.toBeNull();
    expect(within(body()).queryByRole('button', { name: ASIDE_WORDS.send })).toBeNull();
    expect(body().hasAttribute('data-aside-running')).toBe(true);
    // The answer arrives whole: the line goes, and Send is back.
    push(said('assistant', 'It lists the two tides.', { id: 'r1' }), A, 'ended');
    expect(waiting()).toBeNull();
    expect(entries().map((entry) => entry.getAttribute('data-role'))).toEqual(['assistant']);
    expect(within(body()).getByRole('button', { name: ASIDE_WORDS.send })).not.toBeNull();
  });

  it('shows fat-g’s line where no answer was given, and never a text as the model’s', async () => {
    hold({}, [said('user', 'Explain this passage.', { id: 'q1' }), said('notice', 'No answer was given.', { id: 'n1', notice: 'no-answer' })]);
    await open({ asking: CLAUDE_ASIDES });
    expect(entries().map((entry) => [entry.getAttribute('data-role'), entry.getAttribute('aria-label')])).toEqual([['notice', 'fat-g']]);
    expect(entries()[0]?.textContent).toContain('No answer was given.');
    expect(entries().some((entry) => entry.getAttribute('data-role') === 'assistant')).toBe(false);
  });

  it('asks main to stop the aside’s turn, and nothing of the session’s', async () => {
    hold({ running: true }, [said('user', 'Explain this passage.', { id: 'q1' })]);
    (stage.asides[A] as HeldAside).turns = [chatTurn('aside-turn-1', { state: 'running', outcome: null })];
    await open();
    fireEvent.click(within(body()).getByRole('button', { name: ASIDE_WORDS.stop }));
    await stage.settle();
    expect(stage.sent('chat:stopAside')).toEqual([{ sessionId: ID, asideId: A }]);
    expect(stage.sent('chat:stop')).toEqual([]);
  });
});

describe('the field (C37, C73)', () => {
  it('sends a follow-up on Enter under the aside’s id, breaks the line on Shift+Enter, and sends nothing empty or while an input method composes', async () => {
    hold();
    await open();
    expect(within(body()).getByRole<HTMLButtonElement>('button', { name: ASIDE_WORDS.send }).disabled).toBe(true);
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.change(field(), { target: { value: 'And at night?' } });
    expect(fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229 });
    await stage.settle();
    expect(stage.sent('chat:ask')).toEqual([]);
    expect(fireEvent.keyDown(field(), { key: 'Enter' })).toBe(false);
    await stage.settle();
    // As typed, with no source: a follow-up is sent as it is (C51).
    expect(stage.sent('chat:ask')).toEqual([{ sessionId: ID, asideId: A, text: 'And at night?' }]);
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
  });

  it('keeps the draft and says why in one line when an ask is not taken', async () => {
    hold();
    await open();
    stage.ask = () => ({ status: 'refused', reason: 'aside-running' });
    fireEvent.change(field(), { target: { value: 'And at night?' } });
    fireEvent.click(within(body()).getByRole('button', { name: ASIDE_WORDS.send }));
    await stage.settle();
    expect(field().value).toBe('And at night?');
    expect(within(body()).getByText('This side question is still being answered. Ask again once it has finished.').getAttribute('role')).toBe('status');
  });

  it('takes no question where the session cannot be asked beside any more: what was asked stays to be read', async () => {
    hold();
    await open({ asking: 'none' });
    expect(field().disabled).toBe(true);
    expect(entries()).toHaveLength(1);
    expect(within(body()).getByRole<HTMLButtonElement>('button', { name: ASIDE_WORDS.send }).disabled).toBe(true);
  });

  it('keeps its draft between showings, then removes the conversation when its tab closes', async () => {
    hold();
    await open();
    fireEvent.change(field(), { target: { value: 'half a question' } });
    unfold();
    act(() => { openAside(ID, OTHER, 'Another aside'); });
    await stage.settle();
    expect(field().value).toBe('');
    act(() => { selectTab(ID, TAB); });
    await stage.settle();
    expect(field().value).toBe('half a question');
    expect(within(head()).getByRole('button', { name: ASIDE_WORDS.hideExcerpt })).not.toBeNull();
    stage.remove = ({ asideId }) => { delete stage.asides[asideId]; return { status: 'removed' }; };
    // Closed explicitly: remove the conversation without a second confirmation.
    act(() => { closeTab(ID, TAB); });
    await stage.settle();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(stage.sent('chat:removeAside')).toEqual([{ sessionId: ID, asideId: A }]);
    expect(stage.tabs(ONE).some((tab) => tab.id === TAB)).toBe(false);
    act(() => { openAside(ID, A, 'reopened'); });
    await stage.settle();
    expect(field().value).toBe('');
    expect(within(body()).queryByRole('group', { name: ASIDE_WORDS.list })).toBeNull();
    expect(within(body()).queryByRole('group', { name: ASIDE_WORDS.head })).toBeNull();
  });

  it.each(['refused', 'failed'] as const)('keeps the tab and draft when removal is %s, and allows another attempt', async (outcome) => {
    hold();
    await open();
    fireEvent.change(field(), { target: { value: 'Keep my draft' } });
    stage.remove = () => {
      if (outcome === 'failed') throw new Error('Unavailable');
      return { status: 'refused', reason: 'storage-failed' };
    };
    act(() => closeTab(ID, TAB));
    await stage.settle();
    expect(stage.tabs(ONE).some((tab) => tab.id === TAB)).toBe(true);
    expect(field().value).toBe('Keep my draft');
    expect(screen.getByText(ASIDE_WORDS.removeFailed).getAttribute('role')).toBe('status');
    stage.remove = () => ({ status: 'removed' });
    act(() => closeTab(ID, TAB));
    await stage.settle();
    expect(stage.tabs(ONE)).toHaveLength(0);
  });

  it.each(['button', 'middle click', 'Delete'] as const)('removes an inactive side question through its tab’s %s', async (action) => {
    hold();
    await open();
    act(() => { openAside(ID, OTHER, null); });
    await stage.settle();
    const tab = tabs()[0] as HTMLElement;
    if (action === 'button') fireEvent.click(within(tab).getByRole('button'));
    else if (action === 'middle click') fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    else fireEvent.keyDown(tab, { key: 'Delete' });
    await stage.settle();
    expect(stage.sent('chat:removeAside')).toEqual([{ sessionId: ID, asideId: A }]);
    expect(stage.tabs(ONE).map((item) => item.reference)).toEqual([OTHER]);
  });

  it('closes an unsent draft even though it has no saved conversation', async () => {
    await open({ title: null });
    stage.remove = () => ({ status: 'refused', reason: 'unknown-aside' });
    fireEvent.click(within(tabs()[0] as HTMLElement).getByRole('button'));
    await stage.settle();
    expect(stage.tabs(ONE)).toHaveLength(0);
  });

  it.each([false, true])('waits for in-flight questions before removing the tab, including after a remount (%s)', async (remount) => {
    await open({ title: null });
    const accepts: (() => void)[] = [];
    stage.ask = () => new Promise((resolve) => {
      accepts.push(() => { hold(); resolve({ status: 'accepted', asideId: A }); });
    });
    stage.remove = ({ asideId }) => { delete stage.asides[asideId]; return { status: 'removed' }; };
    fireEvent.change(field(), { target: { value: 'First question' } });
    fireEvent.click(within(body()).getByRole('button', { name: ASIDE_WORDS.send }));
    if (remount) {
      act(() => { openAside(ID, OTHER, null); });
      await stage.settle();
      act(() => { selectTab(ID, TAB); });
      await stage.settle();
      fireEvent.click(within(body()).getByRole('button', { name: ASIDE_WORDS.send }));
    }
    fireEvent.click(within(tabs()[0] as HTMLElement).getByRole('button'));
    await stage.settle();
    expect(stage.sent('chat:removeAside')).toEqual([]);
    if (remount) {
      act(() => { accepts[1]?.(); });
      await stage.settle();
      expect(stage.sent('chat:removeAside')).toEqual([]);
    }
    act(() => { accepts[0]?.(); });
    await stage.settle();
    expect(stage.sent('chat:removeAside')).toEqual([{ sessionId: ID, asideId: A }]);
    expect(stage.tabs(ONE).some((tab) => tab.id === TAB)).toBe(false);
    expect(stage.asides[A]).toBeUndefined();
  });
});

describe('what it holds, and when (C38, C73)', () => {
  it('reads at each showing, and holds nothing while another tab is shown: a push of its own then reads nothing', async () => {
    hold();
    await open();
    const own = () => reads().filter((request) => (request as { asideId: string }).asideId === A);
    expect(own()).toHaveLength(1);
    act(() => { openAside(ID, OTHER, 'Another aside'); });
    await stage.settle();
    expect(document.querySelector(`[data-aside="${A}"]`)).toBeNull();
    push(said('user', 'Asked while hidden?', { id: 'q2', turnId: 'aside-turn-2' }));
    await stage.settle();
    expect(own()).toHaveLength(1);
    act(() => { selectTab(ID, TAB); });
    await stage.settle();
    expect(own()).toHaveLength(2);
    expect(entries()).toHaveLength(2);
  });

  it('takes the pushes that name it, and passes the session’s own, a worker’s and another aside’s: none is drawn, and none is read for', async () => {
    hold();
    await open();
    push(chatItem(ID, 'assistant', 'The session’s own answer.', { id: 'own-1' }), null, 'ended');
    push(said('assistant', 'Another aside’s answer.', { id: 'other-1' }), 'aside-2', 'ended');
    const chat = stage.chat(ONE);
    chat.revision += 1;
    stage.push({ sessionId: ID, revision: chat.revision, item: chatItem(ID, 'assistant', 'A worker’s.', { id: 'w-1', workerId: 'worker-1' }), turn: chatTurn('t-w'), workerId: 'worker-1' });
    await stage.settle();
    expect(entries()).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    // Its own, after those: appended at once, the revisions between having been taken.
    push(said('user', 'And at night?', { id: 'q2', turnId: 'aside-turn-2' }));
    expect(entries()).toHaveLength(2);
    expect(reads()).toHaveLength(1);
    // The chat beside it drew the session's own answer, and none of the aside's.
    const chatList = document.querySelector('[data-chat-list]') as HTMLElement;
    expect(chatList.textContent).toContain('The session’s own answer.');
    expect(chatList.textContent).not.toContain('And at night?');
    expect(chatList.textContent).not.toContain('Another aside’s answer.');
  });

  it('reads again at a push it cannot follow: a revision missed', async () => {
    hold();
    await open();
    const chat = stage.chat(ONE);
    chat.revision += 5;
    (stage.asides[A] as HeldAside).items.push(said('user', 'After a gap?', { id: 'q2', turnId: 'aside-turn-2' }));
    stage.push({ sessionId: ID, revision: chat.revision, changed: true, asideId: A });
    await stage.settle();
    expect(reads()).toHaveLength(2);
    expect(entries()).toHaveLength(2);
  });

  it('says why where main answers with nothing', async () => {
    hold();
    stage.asides[A] = undefined as never;
    delete stage.asides[A];
    const answered: unknown[] = [];
    stage.bridge.setInvoke((channel, request) => {
      stage.requests.push([channel, request]);
      if (channel === 'chat:readAside') { answered.push(request); return Promise.resolve({ ok: true, value: { status: 'refused', reason: 'unknown-session' } }); }
      return Promise.resolve({ ok: true, value: channel === 'chat:read' ? stage.chat(ONE).read(request as { sessionId: string }) : { status: 'saved' } });
    });
    await open();
    expect(answered).toHaveLength(1);
    expect(within(body()).getByText('This session is no longer listed.')).not.toBeNull();
    expect(field().disabled).toBe(true);
  });
});

describe('where the passage came from (C37)', () => {
  /** What the head line's press brought into view, and how: every element is listened to. */
  function watchScrolls(): { element: Element; block: unknown }[] {
    const seen: { element: Element; block: unknown }[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element, options?: boolean | ScrollIntoViewOptions) { seen.push({ element: this, block: typeof options === 'object' ? options.block : options }); };
    return seen;
  }
  afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView; });
  const answer = () => document.querySelector('[data-chat-list] [data-source-item="answer-1"]') as HTMLElement;

  it('comes to the passage itself where it is painted in the chat, and not to the middle of its message', async () => {
    // The aside is about the answer's heading, by its place in the drawn text, which the chat paints: its
    // lines here name the paragraph, so that what is come to is seen to be the painted passage, and not its lines' block.
    const place = { range: { start: 0, end: 'Tides'.length }, digest: drawnDigest('Tides') };
    const painted: AsideSource = { ...SOURCE, ...place };
    hold({ source: painted });
    stage.chat(ONE).asides = [marker(A, 'Tides', { itemId: 'answer-1', lines: SOURCE.lines, ...place })];
    await open();
    const seen = watchScrolls();
    fireEvent.click(sourceLink(painted));
    expect(seen).toEqual([{ element: within(answer()).getByText('Tides'), block: 'center' }]);
    // Nothing was opened, and nothing asked.
    expect(stage.tabs(ONE)).toHaveLength(1);
  });

  it('comes to the block the passage’s lines begin in where it is not painted, and to the message’s start where it has no lines', async () => {
    // The digest is not the drawn text's, as after a change: nothing is painted, and the lines still say where.
    hold();
    await open();
    const seen = watchScrolls();
    fireEvent.click(sourceLink());
    expect(seen).toEqual([{ element: within(answer()).getByText('The tide table lists high and low water.'), block: 'center' }]);
    cleanup();

    stage = asideStage();
    const unplaced: AsideSource = { ...SOURCE, lines: null };
    hold({ source: unplaced });
    await open();
    const again = watchScrolls();
    fireEvent.click(sourceLink(unplaced));
    expect(again).toEqual([{ element: answer().closest('article'), block: 'start' }]);
  });

  it('opens a file at the passage’s first line, and a sub-agent’s thread for a worker’s item', async () => {
    const file: AsideSource = { ...SOURCE, kind: 'file', itemId: null, role: null, path: 'C:\\work\\tide-tools\\docs\\notes.md', lines: { first: 12, last: 14 } };
    hold({ source: file });
    await open();
    fireEvent.click(sourceLink(file));
    await stage.settle();
    expect(stage.sent('files:read')).toEqual([{ sessionId: ID, target: 'C:\\work\\tide-tools\\docs\\notes.md' }]);
    cleanup();

    stage = asideStage();
    const workers: AsideSource = { ...SOURCE, itemId: 'w-item', workerId: 'worker-1', lines: null };
    hold({ source: workers });
    await open();
    fireEvent.click(sourceLink(workers));
    await stage.settle();
    // The sub-agent chosen in the Sub-agents tab, first in the row, its thread unfolded (M106, C4, C24).
    expect(stage.tabs(ONE).map((tab) => [tab.kind, tab.reference])).toEqual([[AGENTS_KIND, null], [ASIDE_KIND, A]]);
    expect(stage.tabs(ONE)[0]?.viewState).toEqual({ chosen: { id: 'worker-1', label: null } });
  });
});

describe('removed content', () => {
  it('says an aside removed elsewhere is no longer saved, once its tab reads again', async () => {
    hold();
    await open();
    delete stage.asides[A];
    stage.changed(ONE);
    await stage.settle();
    expect(within(body()).getByText(ASIDE_WORDS.gone)).not.toBeNull();
    expect(document.querySelector(`[data-aside] [${ASIDE_LIST_MARK}]`)).toBeNull();
    // Nothing more is asked under its id: a question would start another aside in its name.
    expect(field().disabled).toBe(true);
  });
});

describe('a session that is no longer listed (C72)', () => {
  it('takes its aside tabs with it', async () => {
    hold();
    await open();
    expect(stage.tabs(ONE)).toHaveLength(1);
    stage.show([TWO], TWO);
    await stage.settle();
    expect(stage.tabs(ONE)).toEqual([]);
    expect(document.querySelector('[data-aside]')).toBeNull();
  });
});
