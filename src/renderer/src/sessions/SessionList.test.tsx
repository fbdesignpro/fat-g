// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// The session list (docs/planning/_archive/M14.md, Verification V10, V14, V25), in the project column, as the
// Main window draws it: under each project's header.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOVE_CHAT_TEXT } from '@shared/contracts/chat';
import type { ConversationsState } from '@shared/contracts/conversation';
import type { InvokeChannel } from '@shared/ipc/channels';
import type { SessionEntry, SessionSummary, SessionView } from '@shared/contracts/sessions';
import { sampleProvider } from '../../../../tests/support/app-state';
import { sampleCatalog } from '../../../../tests/support/catalog';
import { LONG_NAME, sessionEntry, sessionId, SUMMARIES, TURN_STARTED_AT } from '../../../../tests/support/sessions';
import { setDraft, useChatDrafts } from '../chat/chat-store';
import { resetPromptFocus, usePromptFocus } from '../chat/prompt-focus';
import { closeNewSession, useNewSession } from '../new-session/new-session-store';
import { NO_PROVIDER_REASON } from '../new-session/NewSessionButton';
import { ProjectList } from '../projects/ProjectList';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { type FocusWatch, watchFocus } from '../test/focus';
import { project, unreadable } from '../test/records';
import { showState, type ShownState } from '../test/sessions';
import { announce, Announcer } from '../ui/Announcer';
import { SessionAnnouncer } from './SessionAnnouncer';
import type { MeasureCapsules } from './useCapsuleDrag';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
/** Every focus the page gave while a test ran: what says whether an element was lit (../test/focus.ts). */
let focus: FocusWatch;
let answer: (channel: InvokeChannel, request: unknown) => unknown;

beforeAll(installDialogStandIn);
beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  focus = watchFocus();
  answer = () => ({ status: 'saved' });
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    return { ok: true, value: answer(channel, request) };
  });
  closeNewSession();
  useChatDrafts.setState({ drafts: {} });
  announce('');
});
afterEach(() => {
  focus.undo();
  cleanup();
  vi.useRealTimers();
});

const ROW = 61;
const LIST_TOP = 100;
/** jsdom computes no layout: 60px content plus its 1px divider, starting 100px down. */
const measureCapsules: MeasureCapsules = (list) => ({
  column: { top: 0, bottom: 600, left: 0, right: 320 },
  listTop: LIST_TOP,
  boxes: [...list.querySelectorAll<HTMLElement>('[data-session-id]')].map((element, index) => ({
    id: element.dataset['sessionId'] ?? '',
    group: element.dataset['group'] === 'starred' ? 'starred' : 'unstarred',
    top: index * ROW,
    bottom: (index + 1) * ROW,
  })),
});

function Harness() {
  const column = useRef<HTMLElement>(null);
  return (
    <>
      <aside ref={column} aria-label="Projects">
        <ProjectList column={column} measureCapsules={measureCapsules} />
      </aside>
      <Announcer />
      <SessionAnnouncer />
    </>
  );
}

const A = project('Calamari');
const B = project('website', { color: 'blue' });
const s = (name: string | null, summary: SessionSummary = SUMMARIES.idle, overrides: Partial<SessionView> = {}): SessionEntry => sessionEntry(name, summary, { projectId: A.id, ...overrides });
const show = (sessions: readonly SessionEntry[], extra: Partial<ShownState> = {}) => showState({ projects: [A, B], sessions, ...extra });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const column = () => screen.getByRole('complementary', { name: 'Projects' });
const capsule = (name: string) => column().querySelector<HTMLElement>(`[aria-label^="${name}, "]`)?.closest('li') as HTMLElement;
const selectButton = (name: string) => within(capsule(name)).getAllByRole('button')[0] as HTMLElement;
const actions = (name: string) => screen.getByRole('button', { name: `Actions for ${name}` });
const openMenuOf = (name: string) => {
  fireEvent.click(actions(name));
  return screen.getByRole('menu', { name: `Actions for ${name}` });
};
const activeNames = () => [...column().querySelectorAll('[data-session-id] [data-select-session]')].map((button) => button.querySelector('span span')?.textContent);
const announced = () => document.querySelector('[aria-live="polite"]')?.textContent ?? '';
const click = async (element: Element) => {
  await act(async () => {
    fireEvent.click(element);
    await flush();
  });
};

// ── V10: each capsule state ───────────────────────────────────────────────────────────────────
describe('a capsule’s status (V10; C40)', () => {
  it('lights concurrent capsules with their own provider stream and replaces a stream with static attention', () => {
    const source = sampleCatalog(['claude', 'codex']);
    const catalog = { ...source, providers: source.providers.map((provider) => provider.id !== 'codex' ? provider : {
      ...provider, presentation: { ...provider.presentation, stream: { ground: '#043354', lights: ['#061e79', '#0b268c', '#0e2c98', '#0c30a4', '#123db7', '#1447c2'] as const } },
    }) };
    const first = s('First', SUMMARIES.runningThinking);
    const second = s('Second', SUMMARIES.runningThinking, { providerId: 'codex' });
    const legacy = s('Legacy', SUMMARIES.runningThinking, { providerId: 'other' });
    show([first, second, legacy], { catalog });
    render(<Harness />);
    const field = (name: string) => selectButton(name).querySelector('[data-status-stream]') as HTMLElement;
    expect(block('First').style.getPropertyValue('--stream-ground')).toBe('#541704');
    expect(block('Second').style.getPropertyValue('--stream-ground')).toBe('#043354');
    expect([field('First').hasAttribute('data-active'), field('Second').hasAttribute('data-active'), field('Legacy').hasAttribute('data-active')]).toEqual([true, true, false]);
    expect(field('First').getAttribute('aria-hidden')).toBe('true');
    act(() => { show([{ ...first, summary: SUMMARIES.questions }, second, legacy], { catalog }); });
    expect(field('First').hasAttribute('data-active')).toBe(false);
    expect(field('First').hasAttribute('data-immediate')).toBe(true);
    expect(block('First').textContent).toBe('3 Questions');
    expect(field('Second').hasAttribute('data-active')).toBe(true);
    act(() => { show([{ ...first, summary: SUMMARIES.idle }, second, legacy], { catalog }); });
    expect(field('First').hasAttribute('data-active')).toBe(false);
    expect(block('First').textContent).toBe('Idle');
  });

  const block = (name: string) => selectButton(name).querySelector('[data-state]') as HTMLElement;

  // M26 (round 2): a session no turn has run is provisional, and shows nothing at all while there is
  // nothing to show for it — its chat is open, and leaving it removes it (unstarted.ts).
  it('shows no capsule for a session not started with nothing typed and no name', () => {
    show([s(null, SUMMARIES.notStarted)]);
    render(<Harness />);
    expect(column().querySelector('[data-session-id]')).toBeNull();
  });

  // An unsent draft shows its opening text and a cancellation cross from the first keystroke.
  it('shows the opening draft text and a cancel cross, with no status or flags', () => {
    const entry = s(null, SUMMARIES.notStarted, { createdAt: Date.UTC(2020, 0, 22, 12, 0) });
    show([entry]);
    setDraft(entry.record.id, 'Set up the ');
    render(<Harness />);
    const item = column().querySelector('[data-session-id]') as HTMLElement;
    const buttons = within(item).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('New session: Set up the');
    expect(buttons[0]?.textContent).toBe('New session: Set up the');
    expect(buttons[1]?.getAttribute('aria-label')).toBe('Cancel new session: New session: Set up the');
    expect(buttons[0]?.firstElementChild?.getAttribute('data-avatar')).toBe('claude');
    expect(item.querySelector('[data-state]')).toBeNull();
  });

  // What the secretary wrote replaces the opening text; a name keeps the capsule after a restart.
  it('shows the name written from a draft behind New session:, and that name is its accessible name', () => {
    show([s('setting things up', SUMMARIES.notStarted, { nameSource: 'generated' })]);
    render(<Harness />);
    const item = column().querySelector('[data-session-id]') as HTMLElement;
    const buttons = within(item).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toBe('New session: setting things up');
    expect(buttons[0]?.getAttribute('aria-label')).toBe('New session: setting things up');
    expect(item.querySelector('[data-state]')).toBeNull();
  });

  it.each(['cross', 'context menu'])('cancels a draft from its %s without selecting it', async (control) => {
    const entry = s('setting things up', SUMMARIES.notStarted, { nameSource: 'generated' });
    show([entry]);
    render(<Harness />);
    const item = column().querySelector('[data-session-id]') as HTMLElement;
    if (control === 'context menu') {
      fireEvent.contextMenu(item);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel new session' }));
    } else fireEvent.click(within(item).getByRole('button', { name: /^Cancel new session:/ }));
    await act(async () => { await Promise.resolve(); });
    expect(requests).toContainEqual(['sessions:remove', { id: entry.record.id, draftOnly: true }]);
    expect(requests.some(([channel]) => channel === 'sessions:select')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // A name the user typed stands as they typed it, started or not.
  it('shows a name of the user’s own with no New session before it', () => {
    show([s('Create plan', SUMMARIES.notStarted)]);
    render(<Harness />);
    const button = within(column().querySelector('[data-session-id]') as HTMLElement).getAllByRole('button')[0];
    expect(button?.textContent).toBe('Create plan');
    expect(button?.getAttribute('aria-label')).toBe('Create plan');
  });

  it('reads Idle between turns, with no time and no block', () => {
    show([s('Create plan')]);
    render(<Harness />);
    expect(selectButton('Create plan').textContent).toBe('Create planIdle');
    expect(block('Create plan').getAttribute('data-state')).toBe('idle');
  });

  // M100 (C53, V4): the block holds the action's status words; its label, with its detail, is the accessible name's.
  it('shows the action’s status on its provider’s colour, the time since the turn started, and the worker line while it runs', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TURN_STARTED_AT + 247_000 });
    show([s('Create plan', SUMMARIES.runningWorkers)]);
    render(<Harness />);
    const button = selectButton('Create plan');
    expect(button.textContent).toBe('Create planReading2 subagents4m7s');
    expect(block('Create plan').getAttribute('data-state')).toBe('running');
    expect(block('Create plan').querySelector('[aria-hidden] + span')?.textContent).toBe('Reading');
    expect(capsule('Create plan').style.getPropertyValue('--bar-color')).toBe('#ff9933');
    expect(button.getAttribute('aria-label')).toBe('Create plan, Reading notes.txt, +2 active subagents');
  });

  it('shows no worker line with none active', () => {
    show([s('Create plan', SUMMARIES.runningThinking)]);
    render(<Harness />);
    expect(selectButton('Create plan').textContent).toMatch(/^Create planThinking…\d/);
    expect(selectButton('Create plan').textContent).not.toContain('active subagent');
  });

  it('keeps a provider’s sentence in the accessible name, and its kind’s words in the block', () => {
    show([s('Create plan', SUMMARIES.runningSentence)]);
    render(<Harness />);
    const label = SUMMARIES.runningSentence.action?.label ?? '';
    expect(label).toMatch(/^I'll read sample\.txt to find the cat's name/);
    expect(block('Create plan').querySelector('[aria-hidden] + span')?.textContent).toBe('Writing');
    expect(selectButton('Create plan').getAttribute('aria-label')).toBe(`Create plan, ${label}`);
  });

  it('reads as waiting after its turn has ended, with its time and the worker line (C114)', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TURN_STARTED_AT + 150_000 });
    show([s('Create plan', SUMMARIES.waitingOnWorkers)]);
    render(<Harness />);
    expect(selectButton('Create plan').textContent).toBe('Create planWaiting for 2 sub-agents2 subagents2m30s');
    expect(selectButton('Create plan').getAttribute('aria-label')).toBe('Create plan, Waiting for 2 sub-agents, +2 active subagents');
  });

  // M100 (C24, V4): the avatar at the capsule's height, the name on two lines and whole in the DOM.
  it('draws the avatar at the capsule’s size, before the name', () => {
    show([s('Create plan', SUMMARIES.runningThinking)]);
    render(<Harness />);
    const avatar = selectButton('Create plan').firstElementChild as HTMLElement;
    expect([avatar.getAttribute('data-avatar'), avatar.getAttribute('data-size')]).toEqual(['claude', 'capsule']);
  });

  it('shows a session with no name by its creation time (C8)', () => {
    const entry = s(null, SUMMARIES.notStarted, { createdAt: Date.UTC(2020, 0, 22, 12, 0) });
    show([entry]);
    setDraft(entry.record.id, 'Set up the ');
    render(<Harness />);
    const [button] = within(column().querySelector('[data-session-id]') as HTMLElement).getAllByRole('button');
    expect(button?.getAttribute('aria-label')).toBe('New session: Set up the');
  });

  // Decision 0029 (the maintainer): a chat whose plan another chat or the reviewer holds.
  it('says what a chat of a plan waits on, in the waiting pair, over READY and under a turn of its own', () => {
    show([s('Fix login', { ...SUMMARIES.ready, planWait: 'review' }), s('Tidy up', { ...SUMMARIES.runningThinking, planWait: 'implementation' })]);
    render(<Harness />);
    const waiting = block('Fix login');
    expect([waiting.getAttribute('data-state'), waiting.getAttribute('data-plan-wait'), waiting.hasAttribute('data-attention')]).toEqual(['waiting', 'review', false]);
    expect(selectButton('Fix login').textContent).toBe('Fix loginWaiting on plan review');
    expect(selectButton('Fix login').getAttribute('aria-label')).toBe('Fix login, Waiting on plan review');
    // Its own turn runs: the turn is what it shows.
    expect(block('Tidy up').getAttribute('data-state')).toBe('running');
  });

  // Decision 0029: brought into a chat that has run nothing, the plan draws it as a started one, its name alone.
  it('draws a chat that has run nothing as a started one while it takes part in a plan', () => {
    show([s('Plan: Tidy the notes', { ...SUMMARIES.notStarted, attention: { kind: 'plan', count: 1, acknowledged: false } }, { nameSource: 'generated' }), s('Plan: Fix login', { ...SUMMARIES.notStarted, planWait: 'revision' }, { nameSource: 'generated' })]);
    render(<Harness />);
    expect(selectButton('Plan: Tidy the notes').textContent).toBe('Plan: Tidy the notesPlan ready');
    expect(block('Plan: Tidy the notes').getAttribute('data-attention')).toBe('plan');
    expect(selectButton('Plan: Fix login').textContent).toBe('Plan: Fix loginWaiting on plan revision');
    expect(actions('Plan: Fix login')).toBeTruthy();
  });

  it('keeps a 60-character name whole in the DOM and in its accessible names', () => {
    show([s(LONG_NAME)]);
    render(<Harness />);
    expect(selectButton(LONG_NAME).querySelector('span span')?.textContent).toBe(LONG_NAME);
    expect(actions(LONG_NAME)).toBeTruthy();
  });
});

describe('attention (V10; C41, C42, C43, C52)', () => {
  it.each([
    ['ready', SUMMARIES.ready, 'Ready', 'Ready'],
    ['question', SUMMARIES.questions, '3 Questions', '3 Questions'],
    ['approval', SUMMARIES.approval, '1 Approval', '1 Approval'],
    ['plan', { ...SUMMARIES.idle, attention: { kind: 'plan', count: 1, acknowledged: false } }, 'Plan ready', 'Plan ready'],
    ['review', { ...SUMMARIES.idle, attention: { kind: 'review', count: 1, acknowledged: false } }, 'Plan review', 'Plan review'],
    ['error', SUMMARIES.error, 'Error', 'Error'],
    ['stopped', SUMMARIES.stopped, 'Stopped', 'Stopped'],
  ] as const)('replaces the status section with a block naming the %s in sentence case, and says it in words', (kind, summary, text, words) => {
    show([s('Fix login', summary)]);
    render(<Harness />);
    const button = selectButton('Fix login');
    const block = button.querySelector('[data-attention]') as HTMLElement;
    expect(block.textContent).toBe(text);
    expect(block.getAttribute('data-attention')).toBe(kind);
    expect(block.getAttribute('data-state')).toBe('attention');
    expect(block.hasAttribute('data-acknowledged')).toBe(false);
    // The block is in place of the status: no action, no time, no worker line.
    expect(button.textContent).toBe(`Fix login${text}`);
    // Never colour alone: the words are in the capsule's accessible name.
    expect(button.getAttribute('aria-label')).toBe(`Fix login, ${words}`);
    // And it is part of the capsule's one button, not a control of its own.
    expect(block.closest('button')).toBe(button);
    expect(block.tagName).toBe('SPAN');
  });

  it('keeps a notification’s text once acknowledged, in the dim pair', () => {
    show([s('Fix login', { ...SUMMARIES.error, attention: { kind: 'error', count: 1, acknowledged: true } }), s('Review', SUMMARIES.readyAcknowledged)]);
    render(<Harness />);
    const block = selectButton('Fix login').querySelector('[data-attention]') as HTMLElement;
    expect(block.textContent).toBe('Error');
    expect(block.hasAttribute('data-acknowledged')).toBe(true);
    expect(block.getAttribute('data-state')).toBe('acknowledged');
    expect(selectButton('Fix login').getAttribute('aria-label')).toBe('Fix login, Error');
    expect(selectButton('Review').querySelector('[data-attention]')?.textContent).toBe('Ready');
  });

  it('announces a change of attention once, by project, session and kind — and nothing at the first snapshot', () => {
    show([s('Create plan', SUMMARIES.questions)]);
    render(<Harness />);
    expect(announced()).toBe('');
    // Visiting: neither the kind nor the count changes, and the decision stays lit.
    act(() => void show([s('Create plan', SUMMARIES.questions)], { selectedId: sessionId('Create plan') }));
    expect(announced()).toBe('');
    act(() => void show([s('Create plan', SUMMARIES.ready)]));
    expect(announced()).toBe('Calamari, Create plan: ready');
    const first = document.querySelector('[aria-live="polite"] span');
    // The same state again says nothing again.
    act(() => void show([s('Create plan', SUMMARIES.ready)]));
    expect(document.querySelector('[aria-live="polite"] span')).toBe(first);
    act(() => void show([s('Create plan', SUMMARIES.readyAcknowledged)]));
    expect(document.querySelector('[aria-live="polite"] span')).toBe(first);
    act(() => void show([s('Create plan', SUMMARIES.runningThinking)]));
    expect(announced()).toBe('Calamari, Create plan: ready');
    act(() => void show([s('Create plan', SUMMARIES.questions), s('Fix login', SUMMARIES.error)]));
    expect(announced()).toBe('Calamari, Create plan: 3 Questions. Calamari, Fix login: error');
  });

  // M21, V10, V30 (C64, C74): the chat's own status region posts a question raised in the selected
  // session — the session's own, or a worker's — so the announcer leaves it to that.
  it('leaves a question of the selected session to the chat’s region, and announces another session’s as before (M21, C64)', () => {
    const asking = s('Create plan', SUMMARIES.runningThinking);
    const other = s('Fix login', SUMMARIES.runningThinking);
    show([asking, other], { selectedId: asking.record.id });
    render(<Harness />);
    act(() => void show([{ ...asking, summary: SUMMARIES.questions }, other], { selectedId: asking.record.id }));
    expect(announced()).toBe('');
    // Another session's question, while that one is selected: announced as any attention is.
    act(() => void show([{ ...asking, summary: SUMMARIES.questions }, { ...other, summary: SUMMARIES.questions }], { selectedId: asking.record.id }));
    expect(announced()).toBe('Calamari, Fix login: 3 Questions');
    // Any other attention of the selected session is still said.
    act(() => void show([{ ...asking, summary: SUMMARIES.ready }, { ...other, summary: SUMMARIES.questions }], { selectedId: asking.record.id }));
    expect(announced()).toBe('Calamari, Create plan: ready');
  });

  // M22, V10 (C36): an approval of the selected session is posted by the chat's region too, by what
  // it asks leave for; said here as well, it would be read twice.
  it('leaves an approval of the selected session to the chat’s region, and announces another session’s as before (M22, C36)', () => {
    const asking = s('Create plan', SUMMARIES.runningThinking);
    const other = s('Fix login', SUMMARIES.runningThinking);
    show([asking, other], { selectedId: asking.record.id });
    render(<Harness />);
    act(() => void show([{ ...asking, summary: SUMMARIES.approval }, other], { selectedId: asking.record.id }));
    expect(announced()).toBe('');
    // Its capsule still says it, in words.
    expect(selectButton('Create plan').querySelector('[data-attention]')?.textContent).toBe('1 Approval');
    act(() => void show([{ ...asking, summary: SUMMARIES.approval }, { ...other, summary: SUMMARIES.approval }], { selectedId: asking.record.id }));
    expect(announced()).toBe('Calamari, Fix login: 1 Approval');
  });

  // Decision 0029 (the maintainer): one plan ready in several chats is said once, naming
  // each; what a chat waits on while another holds its plan is no attention, and is not said.
  it('says a plan ready in several chats at once once, naming each, and nothing of a chat that waits on it', () => {
    const plan = { ...SUMMARIES.idle, attention: { kind: 'plan', count: 1, acknowledged: false } } as const;
    const chats = [s('Create plan'), s('Fix login'), s('Tidy up')];
    show(chats, { selectedId: chats[0]?.record.id ?? null });
    render(<Harness />);
    act(() => void show(chats.map((chat) => ({ ...chat, summary: plan })), { selectedId: chats[0]?.record.id ?? null }));
    expect(announced()).toBe('Calamari, Fix login; Calamari, Tidy up: plan ready');
    act(() => void show(chats.map((chat) => ({ ...chat, summary: { ...SUMMARIES.idle, planWait: 'review' as const } })), { selectedId: chats[0]?.record.id ?? null }));
    expect(announced()).toBe('Calamari, Fix login; Calamari, Tidy up: plan ready');
  });
});

describe('the capsule’s controls (V10; C43, C44, C45, C91)', () => {
  it('is one button holding the name, the status and the attention block, with … as the only other control', () => {
    show([s('Fix login', SUMMARIES.questions)]);
    render(<Harness />);
    const item = capsule('Fix login');
    const buttons = within(item).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Fix login, 3 Questions', 'Actions for Fix login']);
    // Nothing is nested inside another control.
    for (const button of buttons) expect(button.querySelector('button, a, [role="button"]')).toBeNull();
    expect(buttons[0]?.contains(buttons[1] ?? null)).toBe(false);
  });

  it('selects its session with one request, from the button', async () => {
    show([s('Fix login')]);
    render(<Harness />);
    await click(selectButton('Fix login'));
    expect(requests).toEqual([['sessions:select', { id: s('Fix login').record.id }]]);
  });

  it('carries aria-current on the selected one, and only on it', () => {
    const selected = s('Fix login');
    show([s('Create plan'), selected], { selectedId: selected.record.id });
    render(<Harness />);
    expect(selectButton('Fix login').getAttribute('aria-current')).toBe('true');
    expect(capsule('Fix login').hasAttribute('data-selected')).toBe(true);
    expect(selectButton('Create plan').hasAttribute('aria-current')).toBe(false);
    expect(capsule('Create plan').hasAttribute('data-selected')).toBe(false);
  });

  it('draws its set flags as marks, never controls, and says them in its name', () => {
    show([s('Fix login'), s('Create plan', SUMMARIES.idle, { starred: true, toVerify: true })]);
    render(<Harness />);
    const marks = capsule('Create plan').querySelector('[data-flags]') as HTMLElement;
    expect([marks.getAttribute('data-flags'), marks.getAttribute('aria-hidden'), marks.querySelectorAll('svg').length]).toEqual(['starred toVerify', 'true', 2]);
    expect(selectButton('Create plan').getAttribute('aria-label')).toBe('Create plan, Idle, starred, to verify');
    expect(capsule('Fix login').querySelector('[data-flags]')).toBeNull();
    expect(selectButton('Fix login').getAttribute('aria-label')).toBe('Fix login, Idle');
    // The name makes room for the marks above the `…`.
    expect(capsule('Create plan').style.getPropertyValue('--flag-count')).toBe('2');
  });

  it('sets and clears flags from its menu under a Tags header, several in one opening, without selecting', async () => {
    const plain = s('Fix login');
    const starred = s('Create plan', SUMMARIES.idle, { starred: true });
    show([plain, starred]);
    render(<Harness />);
    const flag = (name: string, word: string) => within(within(screen.getByRole('menu', { name: `Actions for ${name}` })).getByRole('group', { name: 'Tags' })).getByRole('menuitemcheckbox', { name: word });
    const menu = openMenuOf('Fix login');
    expect(within(menu).getAllByRole('menuitemcheckbox').map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([['Starred', 'false'], ['To do', 'false'], ['To verify', 'false']]);
    await click(flag('Fix login', 'To do'));
    // Still open, for the next.
    await click(flag('Fix login', 'To verify'));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    openMenuOf('Create plan');
    expect(flag('Create plan', 'Starred').getAttribute('aria-checked')).toBe('true');
    await click(flag('Create plan', 'Starred'));
    expect(requests).toEqual([
      ['sessions:setFlag', { id: plain.record.id, flag: 'toDo', on: true }],
      ['sessions:setFlag', { id: plain.record.id, flag: 'toVerify', on: true }],
      ['sessions:setFlag', { id: starred.record.id, flag: 'starred', on: false }],
    ]);
  });

  it('keeps a capsule in its place while its menu is open, and moves it by its star when the menu closes, the focus with it', async () => {
    const a = s('a');
    const b = s('b');
    show([a, b]);
    render(<Harness />);
    fireEvent.keyDown(actions('b'), { key: 'ArrowDown' });
    await click(within(screen.getByRole('menu', { name: 'Actions for b' })).getByRole('menuitemcheckbox', { name: 'Starred' }));
    expect(requests).toEqual([['sessions:setFlag', { id: b.record.id, flag: 'starred', on: true }]]);
    // Main's answer arrives: starred, and drawn so, where it was.
    act(() => void show([a, { ...b, record: { ...b.record, starred: true } }]));
    expect(activeNames()).toEqual(['a', 'b']);
    expect(within(screen.getByRole('menu', { name: 'Actions for b' })).getByRole('menuitemcheckbox', { name: 'Starred' }).getAttribute('aria-checked')).toBe('true');
    expect(capsule('b').querySelector('[data-flags]')?.getAttribute('data-flags')).toBe('starred');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(activeNames()).toEqual(['b', 'a']);
    expect(document.activeElement).toBe(actions('b'));
  });

  it('hands the focus to the toggle row’s half when a thin capsule leaves the completed ones shown as its menu closes', async () => {
    const old = s('Old task', SUMMARIES.idle, { completedAt: 50, starred: true });
    const others = [1, 2, 3, 4, 5].map((n) => s(`done-${n}`, SUMMARIES.idle, { completedAt: 100 + n }));
    show([...others, old]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '6 completed' }));
    fireEvent.keyDown(actions('Old task'), { key: 'ArrowDown' });
    await click(within(screen.getByRole('menu', { name: 'Actions for Old task' })).getByRole('menuitemcheckbox', { name: 'Starred' }));
    act(() => void show([...others, { ...old, record: { ...old.record, starred: false } }]));
    const completed = () => within(screen.getByRole('list', { name: 'Completed sessions of Calamari' })).getAllByRole('listitem').map((item) => item.querySelector('button')?.textContent);
    // First among the completed while its menu is open.
    expect(completed()[0]).toBe('Old task');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // Last in saved order after losing its star, past the five shown.
    expect(completed()).not.toContain('Old task');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '6 completed' }));
  });

  it('opens a menu operated like a project’s, with its flags, then Rename, Done, Shelve and Remove and no Reopen — and opening it selects nothing (M100, C31; M26)', () => {
    show([s('Fix login')]);
    render(<Harness />);
    fireEvent.keyDown(actions('Fix login'), { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: 'Actions for Fix login' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename', 'Done', 'Shelve', 'Destroy forever']);
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]')];
    expect(items.map((item) => item.textContent)).toEqual(['Starred', 'To do', 'To verify', 'Rename', 'Done', 'Shelve', 'Destroy forever']);
    expect(within(menu).getByRole('separator')).toBeTruthy();
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(actions('Fix login'));
    expect(requests).toEqual([]);
  });

  it('renames a session from its menu: the name in a field, all of it selected, kept at Enter as the user typed it, normalized (M26)', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    fireEvent.click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Rename' }));
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Session name' });
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('Fix login');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Fix login'.length]);
    expect(field.maxLength).toBe(160);
    fireEvent.change(field, { target: { value: '  Login   form, fixed ' } });
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); await flush(); });
    expect(requests).toEqual([['sessions:rename', { id: entry.record.id, name: 'Login form, fixed' }]]);
    expect(screen.queryByRole('textbox', { name: 'Session name' })).toBeNull();
    expect(document.activeElement).toBe(selectButton('Fix login'));
    // The capsule takes the keyboard back unlit: the rename is over, and no move of the reader's asked for a ring round it (ui/focus.ts).
    expect(focus.quiet(selectButton('Fix login'))).toBe(true);
  });

  it('keeps nothing at Escape, nor for a name left as it was or left empty, and keeps a name when the field is left (M26)', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    const rename = () => { fireEvent.click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Rename' })); return screen.getByRole('textbox', { name: 'Session name' }); };
    let field = rename();
    fireEvent.change(field, { target: { value: 'Something else' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(document.activeElement).toBe(selectButton('Fix login'));
    field = rename();
    fireEvent.keyDown(field, { key: 'Enter' });
    field = rename();
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(requests).toEqual([]);
    field = rename();
    fireEvent.change(field, { target: { value: 'Left by a click' } });
    await act(async () => { fireEvent.blur(field); await flush(); });
    expect(requests).toEqual([['sessions:rename', { id: entry.record.id, name: 'Left by a click' }]]);
  });

  it('closes the menu when the column scrolls', () => {
    show([s('Fix login')]);
    render(<Harness />);
    openMenuOf('Fix login');
    fireEvent.scroll(column());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shelves a session from the menu, and says so in a notice when main refuses because it runs', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    await click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Shelve' }));
    expect(requests).toEqual([['sessions:shelve', { id: entry.record.id }]]);
    answer = () => ({ status: 'refused', reason: 'running' });
    await click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Shelve' }));
    expect(screen.getByRole('dialog', { name: 'Fix login is running' }).textContent).toContain('cannot be shelved while it is still working on a reply');
  });

  it('completes a session from the menu, with one request', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    await click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Done' }));
    expect(requests).toEqual([['sessions:complete', { id: entry.record.id }]]);
  });

  it('says so in a notice when main refuses Complete because the session runs (C35)', async () => {
    answer = () => ({ status: 'refused', reason: 'running' });
    show([s('Fix login', SUMMARIES.runningThinking)]);
    render(<Harness />);
    await click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Done' }));
    const notice = screen.getByRole('dialog', { name: 'Fix login is running' });
    expect(notice.textContent).toContain('cannot be completed while it is still working on a reply');
    await click(within(notice).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so under the list when a change fails', async () => {
    bridge.setInvoke(async () => ({ ok: false, error: 'internal' }));
    show([s('Fix login')]);
    render(<Harness />);
    await click(within(openMenuOf('Fix login')).getByRole('menuitemcheckbox', { name: 'Starred' }));
    expect(screen.getByRole('status').textContent).toBe('fat-g could not save the change, and nothing was changed.');
  });
});

describe('providers (V10; C59, C108)', () => {
  // M102 (V7; C4, C31): the avatar main resolved, over the placeholder, at each capsule's size.
  it('draws the resolved avatar over the placeholder: an active capsule its portrait, a completed one its small', () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
    show([{ ...s('Fix login'), avatar: face }, { ...s('Old task', SUMMARIES.idle, { completedAt: 100, starred: true }), avatar: face }]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '1 completed' }));
    const active = selectButton('Fix login').querySelector('[data-avatar]') as HTMLElement;
    expect(active.querySelector('svg')).not.toBeNull();
    expect(active.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${face.portrait}`);
    const thin = column().querySelector('[data-thin-session] [data-avatar]') as HTMLElement;
    expect(thin.querySelector('img')?.getAttribute('src')).toBe(`app://media/avatars/${face.small}`);
  });

  // M103 (V6; C13, C14): each capsule its own entry's, the one assigned beside the default face — not started and renaming alike.
  it('draws on each capsule its own entry’s avatar, an assigned one beside the default face, not started, renaming and completed alike', () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: 'b'.repeat(32) };
    const assigned = { ref: { origin: 'user' as const, family: 'Mine', avatar: 'Op' }, portrait: 'c'.repeat(32), small: 'd'.repeat(32) };
    const fresh = { ...s('Create plan', SUMMARIES.notStarted), avatar: assigned };
    show([{ ...s('Fix login'), avatar: assigned }, { ...s('Other task'), avatar: face }, fresh, { ...s('Old task', SUMMARIES.idle, { completedAt: 100, starred: true }), avatar: assigned }]);
    render(<Harness />);
    const drawn = (element: Element | null | undefined) => element?.querySelector('[data-avatar] img')?.getAttribute('src');
    expect(drawn(selectButton('Fix login'))).toBe(`app://media/avatars/${assigned.portrait}`);
    expect(drawn(selectButton('Other task'))).toBe(`app://media/avatars/${face.portrait}`);
    expect(drawn(column().querySelector(`[data-session-id="${fresh.record.id}"]`))).toBe(`app://media/avatars/${assigned.portrait}`);
    fireEvent.click(screen.getByRole('button', { name: '1 completed' }));
    expect(drawn(column().querySelector('[data-thin-session]'))).toBe(`app://media/avatars/${assigned.small}`);
    fireEvent.click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Rename' }));
    expect(drawn(column().querySelector('[data-renaming]'))).toBe(`app://media/avatars/${assigned.portrait}`);
  });

  it('draws the placeholder avatar in the provider’s bar colour, with its mark', () => {
    show([s('Fix login')]);
    render(<Harness />);
    const avatar = selectButton('Fix login').querySelector('[data-avatar]') as HTMLElement;
    expect(avatar.getAttribute('data-avatar')).toBe('claude');
    expect(avatar.style.getPropertyValue('--bar-color')).toBe('#ff9933');
    expect(avatar.querySelector('path')?.getAttribute('d')).toBe('M2 2H22V22H2Z');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps a session whose provider is switched off listed and selectable, with that provider’s avatar', async () => {
    const entry = s('Fix login');
    show([entry], { providers: [sampleProvider({ status: { kind: 'disabled' } }), sampleProvider({ id: 'codex', displayName: 'Codex' })] });
    render(<Harness />);
    const avatar = selectButton('Fix login').querySelector('[data-avatar]') as HTMLElement;
    expect(avatar.hasAttribute('data-neutral')).toBe(false);
    expect(avatar.style.getPropertyValue('--bar-color')).toBe('#ff9933');
    await click(selectButton('Fix login'));
    expect(requests).toEqual([['sessions:select', { id: entry.record.id }]]);
    expect(within(openMenuOf('Fix login')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename', 'Done', 'Shelve', 'Destroy forever']);
  });

  // M100b, V19 (C61): a press of the pointer hands the keyboard to the session's prompt; a key leaves it on the list.
  it('asks for the session\'s prompt focus once a pointer press selects it, and not for a selection by a key', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    // A key's click carries no count.
    await click(selectButton('Fix login'));
    expect(usePromptFocus.getState().sessionId).toBeNull();
    await act(async () => {
      fireEvent.click(selectButton('Fix login'), { detail: 1 });
      await flush();
    });
    expect(requests.at(-1)).toEqual(['sessions:select', { id: entry.record.id }]);
    expect(usePromptFocus.getState().sessionId).toBe(entry.record.id);
    resetPromptFocus();
  });

  it('gives a session whose provider this build does not have a neutral square with no mark, and keeps it selectable', async () => {
    const entry = s('From elsewhere', SUMMARIES.idle, { providerId: 'gemini', model: 'gemini-3' });
    show([entry]);
    render(<Harness />);
    const avatar = selectButton('From elsewhere').querySelector('[data-avatar]') as HTMLElement;
    expect(avatar.hasAttribute('data-neutral')).toBe(true);
    expect(avatar.querySelector('svg')).toBeNull();
    expect(avatar.style.getPropertyValue('--bar-color')).toBe('');
    await click(selectButton('From elsewhere'));
    expect(requests).toEqual([['sessions:select', { id: entry.record.id }]]);
    expect(actions('From elsewhere')).toBeTruthy();
  });
});

// ── The four parts (C37, C46–C49) ─────────────────────────────────────────────────────────────
describe('the parts of a project’s list (V10; C37, C46–C49)', () => {
  const done = (name: string, at: number, starred = false) => s(name, SUMMARIES.idle, { completedAt: at, starred });
  const shelved = (name: string, at: number, overrides: Partial<SessionView> = {}, summary: SessionSummary = SUMMARIES.idle) => s(name, summary, { shelvedAt: at, ...overrides });
  const thinNames = (label: string) => within(screen.getByRole('list', { name: label })).getAllByRole('listitem').map((item) => item.querySelector('button')?.textContent);

  it('shows a project with no session as its header alone', () => {
    show([]);
    render(<Harness />);
    expect(column().querySelectorAll('[data-session-id], [data-thin-session], [data-toggle-row]')).toHaveLength(0);
    expect(within(column()).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['Calamari', 'website']);
  });

  it('lists each project’s own sessions under its header, the starred first', () => {
    show([s('a'), s('b', SUMMARIES.idle, { starred: true }), s('c'), sessionEntry('elsewhere', SUMMARIES.idle, { projectId: B.id })]);
    render(<Harness />);
    expect(within(screen.getByRole('list', { name: 'Sessions of Calamari' })).getAllByRole('listitem').map((item) => item.getAttribute('data-group'))).toEqual(['starred', 'unstarred', 'unstarred']);
    expect(activeNames()).toEqual(['b', 'a', 'c', 'elsewhere']);
    expect(within(screen.getByRole('list', { name: 'Sessions of website' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('puts the shelf above the toggle row and the completed below it, the starred first in each, each group in saved order', () => {
    show([s('active'), done('old', 100), done('star-old', 150, true), done('new', 300), done('star-new', 250, true), shelved('parked', 200), shelved('star-parked', 50, { starred: true })]);
    render(<Harness />);
    // Both folds start closed (M100, C88, C94): opened here to read them.
    fireEvent.click(screen.getByRole('button', { name: '2 on the shelf' }));
    expect(thinNames('Shelf of Calamari')).toEqual(['star-parked', 'parked']);
    fireEvent.click(screen.getByRole('button', { name: '4 completed' }));
    expect(thinNames('Completed sessions of Calamari')).toEqual(['star-old', 'star-new', 'old', 'new']);
    const row = column().querySelector('[data-toggle-row]') as HTMLElement;
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['2 on the shelf', '4 completed']);
    // In document order: active, the shelf, the row, completed.
    const order = [...column().querySelectorAll('[data-session-id], [data-thin-session], [data-toggle-row]')].map((element) => element.getAttribute('data-thin-session') === null ? (element.hasAttribute('data-toggle-row') ? 'row' : 'active') : 'thin');
    expect(order).toEqual(['active', 'thin', 'thin', 'row', 'thin', 'thin', 'thin', 'thin']);
  });

  it('files a starred completed session among the completed, never on the shelf', () => {
    show([done('star', 100, true)]);
    render(<Harness />);
    expect(screen.getByRole('button', { name: '0 on the shelf' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '1 completed' }));
    expect(thinNames('Completed sessions of Calamari')).toEqual(['star']);
  });

  it('puts the shelved sessions on the shelf, in saved order, each named and drawn its own way', () => {
    show([s('active'), shelved('parked-old', 100), done('star', 400, true), shelved('parked-new', 200, { toVerify: true })]);
    render(<Harness />);
    expect(activeNames()).toEqual(['active']);
    fireEvent.click(screen.getByRole('button', { name: '2 on the shelf' }));
    fireEvent.click(screen.getByRole('button', { name: '1 completed' }));
    expect(thinNames('Shelf of Calamari')).toEqual(['parked-old', 'parked-new']);
    expect(screen.getByRole('button', { name: 'parked-new, shelved, to verify' }).closest('li')?.hasAttribute('data-shelved')).toBe(true);
    expect(screen.getByRole('button', { name: 'star, completed, starred' }).closest('li')?.hasAttribute('data-shelved')).toBe(false);
    // Its menu: its flags, Done and Unshelve, and Remove.
    expect(within(openMenuOf('parked-new')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Done', 'Unshelve', 'Destroy forever']);
  });

  it('unshelves and completes a shelved session from its menu', async () => {
    const parked = shelved('parked', 100);
    show([parked]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '1 on the shelf' }));
    await click(within(openMenuOf('parked')).getByRole('menuitem', { name: 'Unshelve' }));
    await click(within(openMenuOf('parked')).getByRole('menuitem', { name: 'Done' }));
    expect(requests).toEqual([['sessions:restore', { id: parked.record.id }], ['sessions:complete', { id: parked.record.id }]]);
  });

  it('shows on the shelf what a shelved session waits on, unseen — and nothing for what was seen', () => {
    show([shelved('asks', 100, {}, SUMMARIES.questions), shelved('seen', 200, {}, SUMMARIES.readyAcknowledged)]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '2 on the shelf' }));
    const asks = screen.getByRole('button', { name: 'asks, shelved, 3 Questions' });
    expect(asks.querySelector('[data-thin-attention]')?.textContent).toBe('3 Questions');
    expect(screen.getByRole('button', { name: 'seen, shelved' }).querySelector('[data-thin-attention]')).toBeNull();
  });

  it('shows no toggle row without a completed session', () => {
    show([s('active'), s('star', SUMMARIES.idle, { starred: true })]);
    render(<Harness />);
    expect(column().querySelector('[data-toggle-row]')).toBeNull();
  });

  // M100 (C88, C94): both folds start closed, so a project's finished work is out of the way until asked for.
  it('folds each part from its own half of the row, both closed at first, with their expanded states', () => {
    show([done('plain', 100), shelved('parked', 150)]);
    render(<Harness />);
    const [shelf, completed] = within(column().querySelector('[data-toggle-row]') as HTMLElement).getAllByRole('button');
    expect([shelf?.getAttribute('aria-expanded'), completed?.getAttribute('aria-expanded')]).toEqual(['false', 'false']);
    expect(screen.queryByRole('list', { name: 'Shelf of Calamari' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Completed sessions of Calamari' })).toBeNull();
    fireEvent.click(completed as HTMLElement);
    expect(screen.getByRole('list', { name: 'Completed sessions of Calamari' })).toBeTruthy();
    expect(completed?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(shelf as HTMLElement);
    expect(screen.getByRole('list', { name: 'Shelf of Calamari' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Completed sessions of Calamari' })).toBeTruthy();
    expect(shelf?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(completed as HTMLElement);
    expect(screen.queryByRole('list', { name: 'Completed sessions of Calamari' })).toBeNull();
    fireEvent.click(shelf as HTMLElement);
    expect(screen.queryByRole('list', { name: 'Shelf of Calamari' })).toBeNull();
  });

  it('shows five completed sessions, five more with Show more, and takes five away with Show less (C48)', () => {
    show(Array.from({ length: 12 }, (_unused, index) => done(`done-${index + 1}`, 1000 + index)));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '12 completed' }));
    const shown = () => thinNames('Completed sessions of Calamari').length;
    const more = () => screen.queryByRole('button', { name: 'Show more' });
    const less = () => screen.queryByRole('button', { name: 'Show less' });
    expect(shown()).toBe(5);
    expect(thinNames('Completed sessions of Calamari')[0]).toBe('done-1');
    expect([more() !== null, less() !== null]).toEqual([true, false]);
    fireEvent.click(more() as HTMLElement);
    expect(shown()).toBe(10);
    expect([more() !== null, less() !== null]).toEqual([true, true]);
    fireEvent.click(more() as HTMLElement);
    expect(shown()).toBe(12);
    expect([more() !== null, less() !== null]).toEqual([false, true]);
    fireEvent.click(less() as HTMLElement);
    fireEvent.click(less() as HTMLElement);
    expect(shown()).toBe(5);
    expect(less()).toBeNull();
  });

  it('draws a completed session thin: one line, with the same column, its menu holding its flags, Shelve, Restore and Remove', async () => {
    const entry = done('Old task', 100, true);
    show([entry]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '1 completed' }));
    const item = column().querySelector('[data-thin-session]') as HTMLElement;
    // Its avatar at half an active capsule's size (M100, C26, C28).
    expect(item.querySelector('[data-avatar]')?.getAttribute('data-size')).toBe('thin');
    expect(within(item).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Old task, completed, starred', 'Actions for Old task']);
    expect(item.querySelector('[data-attention]')).toBeNull();
    expect(item.querySelector('[data-flags]')?.getAttribute('data-flags')).toBe('starred');
    const menu = openMenuOf('Old task');
    expect(within(menu).getAllByRole('menuitem').map((menuItem) => menuItem.textContent)).toEqual(['Shelve', 'Restore', 'Destroy forever']);
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Starred' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shelves or restores a completed session from its menu, starred or not', async () => {
    const plain = done('Old task', 100);
    const starred = done('Starred task', 200, true);
    show([plain, starred]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '2 completed' }));
    expect(within(openMenuOf('Old task')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Shelve', 'Restore', 'Destroy forever']);
    await click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Restore' }));
    await click(within(openMenuOf('Old task')).getByRole('menuitem', { name: 'Shelve' }));
    await click(within(openMenuOf('Starred task')).getByRole('menuitem', { name: 'Shelve' }));
    expect(requests).toEqual([['sessions:restore', { id: plain.record.id }], ['sessions:shelve', { id: plain.record.id }], ['sessions:shelve', { id: starred.record.id }]]);
  });

  it('selects a completed session like an active one (C49)', async () => {
    const entry = done('Old task', 100);
    show([entry], { selectedId: null });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /\d+ completed$/ }));
    await click(screen.getByRole('button', { name: 'Old task, completed' }));
    expect(requests).toEqual([['sessions:select', { id: entry.record.id }]]);
    act(() => void show([entry], { selectedId: entry.record.id }));
    expect(screen.getByRole('button', { name: 'Old task, completed' }).getAttribute('aria-current')).toBe('true');
  });

  it('lists a hidden project’s sessions in the hidden list too (C37)', () => {
    const hidden = project('archive', { hidden: true });
    showState({ projects: [A, hidden], sessions: [sessionEntry('Kept away', SUMMARIES.idle, { projectId: hidden.id })] });
    render(<Harness />);
    expect(screen.queryByRole('list', { name: 'Sessions of archive' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1 hidden project' }));
    expect(within(screen.getByRole('list', { name: 'Sessions of archive' })).getAllByRole('listitem')).toHaveLength(1);
  });
});

// ── C54: the + ────────────────────────────────────────────────────────────────────────────────
describe('the + on a project header (V10; C54)', () => {
  const plus = (name: string) => screen.getByRole('button', { name: `New session in ${name}` });

  it('sits before the …, and chooses one initial new-chat screen; repeated presses keep it open', () => {
    show([]);
    render(<Harness />);
    const header = screen.getByRole('heading', { name: 'Calamari' }).parentElement as HTMLElement;
    expect(within(header).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Calamari', 'New session in Calamari', 'Actions for Calamari']);
    expect(plus('Calamari').getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(plus('Calamari'));
    expect(useNewSession.getState().projectId).toBe(A.id);
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    expect(plus('Calamari').getAttribute('aria-expanded')).toBeNull();
    fireEvent.click(plus('website'));
    expect(useNewSession.getState().projectId).toBe(B.id);
    const serial = useNewSession.getState().serial;
    fireEvent.click(plus('website'));
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    expect(useNewSession.getState().serial).toBe(serial);
  });

  it('never starts a project drag, and an unreadable project has none', () => {
    show([], { projects: [A, unreadable('one')] });
    render(<Harness />);
    expect(screen.getAllByRole('button', { name: /^New session in/ })).toHaveLength(1);
    fireEvent.pointerDown(plus('Calamari'), { button: 0, pointerId: 1, clientX: 100, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 80 });
    expect(column().querySelector('[data-lifted]')).toBeNull();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 80 });
  });

  it('stays in place, dimmed and focusable, with no provider switched on — and a tooltip gives the reason on hover and on focus', () => {
    show([], { providers: [sampleProvider({ status: { kind: 'disabled' } })] });
    render(<Harness />);
    const button = plus('Calamari');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    // The tooltip is its description, there to be read whether it shows or not.
    const tooltip = document.getElementById(button.getAttribute('aria-describedby') ?? '') as HTMLElement;
    expect(tooltip.getAttribute('role')).toBe('tooltip');
    expect(tooltip.textContent).toBe(NO_PROVIDER_REASON);
    expect(tooltip.hasAttribute('data-open')).toBe(false);
    fireEvent.pointerEnter(button);
    expect(tooltip.hasAttribute('data-open')).toBe(true);
    fireEvent.pointerLeave(button);
    expect(tooltip.hasAttribute('data-open')).toBe(false);
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(tooltip.hasAttribute('data-open')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tooltip.hasAttribute('data-open')).toBe(false);
    act(() => button.blur());
    // And it opens nothing.
    fireEvent.click(button);
    expect(useNewSession.getState().projectId).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has no tooltip while a provider of the project is switched on', () => {
    show([]);
    render(<Harness />);
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    expect(plus('Calamari').hasAttribute('aria-disabled')).toBe(false);
  });
});

// ── V14: the confirmations ────────────────────────────────────────────────────────────────────
describe('Remove session (V14; C36, C96)', () => {
  it('asks first, naming the session and saying the provider’s history is untouched, with Cancel focused', async () => {
    const entry = s('Fix login');
    show([entry]);
    render(<Harness />);
    fireEvent.click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Destroy forever' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Fix login?' });
    expect(dialog.textContent).toContain('fat-g forgets this session.');
    // The saved chat goes with it, and nothing of the provider's (M18, C21, C23).
    expect(dialog.textContent).toContain(REMOVE_CHAT_TEXT.session('Claude'));
    expect(dialog.textContent).toContain('Its conversation stays in Claude’s own history, which fat-g does not touch.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests).toEqual([]);
    fireEvent.click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Destroy forever' }));
    await click(within(screen.getByRole('dialog', { name: 'Remove Fix login?' })).getByRole('button', { name: 'Remove' }));
    expect(requests).toEqual([['sessions:remove', { id: entry.record.id }]]);
  });

  // M14b, V23 (C73): what a held session loses is the offer M15 makes after a failed resume, not its own Remove.
  it.each(['provider-unavailable', 'instance-unavailable', 'folder-moved'] as const)('keeps Remove, and Complete, for a session held as %s', async (hold) => {
    const entry = { ...s('Fix login'), hold };
    show([entry]);
    render(<Harness />);
    const menu = openMenuOf('Fix login');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename', 'Done', 'Shelve', 'Destroy forever']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Destroy forever' }));
    await click(within(screen.getByRole('dialog', { name: 'Remove Fix login?' })).getByRole('button', { name: 'Remove' }));
    expect(requests).toEqual([['sessions:remove', { id: entry.record.id }]]);
  });

  it('removes a completed session from its thin capsule’s menu', async () => {
    const entry = s('Old task', SUMMARIES.idle, { completedAt: 100 });
    show([entry]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /\d+ completed$/ }));
    fireEvent.click(within(openMenuOf('Old task')).getByRole('menuitem', { name: 'Destroy forever' }));
    await click(within(screen.getByRole('dialog', { name: 'Remove Old task?' })).getByRole('button', { name: 'Remove' }));
    expect(requests).toEqual([['sessions:remove', { id: entry.record.id }]]);
  });

  it.each([['in a turn', SUMMARIES.runningThinking, 'turn', 'it is still working on a reply'], ['waiting on its workers', SUMMARIES.waitingOnWorkers, 'workers', 'its sub-agents are still running'], ['integrating a review', SUMMARIES.runningThinking, 'integration', 'it is evaluating a review’s feedback on its plan']] as const)('is refused in place of its confirmation while the session is %s, saying what it does as main says', async (_name, summary, doing, words) => {
    answer = (channel) => (channel === 'sessions:doing' ? { status: 'read', doing } : { status: 'saved' });
    show([s('Fix login', summary)]);
    render(<Harness />);
    await click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Destroy forever' }));
    expect(screen.queryByRole('dialog', { name: 'Remove Fix login?' })).toBeNull();
    const notice = screen.getByRole('dialog', { name: 'Fix login is running' });
    expect(notice.textContent).toContain(`A chat cannot be removed while ${words}. Wait until it finishes, or stop it, then try again.`);
    expect(within(notice).getAllByRole('button').map((button) => button.textContent)).toEqual(['OK']);
    // Only asked what it does: nothing is removed.
    expect(requests.map(([channel]) => channel)).toEqual(['sessions:doing']);
  });

  it('says the same when main refuses after the confirmation: a turn began meanwhile', async () => {
    answer = () => ({ status: 'refused', reason: 'running' });
    show([s('Fix login')]);
    render(<Harness />);
    fireEvent.click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Destroy forever' }));
    await click(within(screen.getByRole('dialog', { name: 'Remove Fix login?' })).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('dialog', { name: 'Fix login is running' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Remove project (V14; C13, C57, C96)', () => {
  const projectMenu = (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
    return screen.getByRole('menu', { name: `Actions for ${name}` });
  };

  it.each([[0, 'fat-g forgets this project. Nothing in its folders'], [1, 'fat-g forgets this project. Its 1 session goes with it. Nothing in its folders'], [7, 'fat-g forgets this project. Its 7 sessions go with it. Nothing in its folders']])(
    'names how many sessions go with it: %d',
    (count, text) => {
      showState({ projects: [project('Calamari', { sessions: count })] });
      render(<Harness />);
      fireEvent.click(within(projectMenu('Calamari')).getByRole('menuitem', { name: 'Remove' }));
      const words = screen.getByRole('dialog', { name: 'Remove Calamari?' }).textContent;
      expect(words).toContain(text);
      // Its sessions' saved chats go too (M18, C21, C23): said when it has any.
      expect(words.includes(REMOVE_CHAT_TEXT.project)).toBe(count > 0);
    },
  );

  it('names the count on an unreadable project’s row too, as main matches them', () => {
    showState({ projects: [A, unreadable('one', 3)] });
    render(<Harness />);
    fireEvent.click(within(projectMenu('unreadable project')).getByRole('menuitem', { name: 'Remove' }));
    expect(screen.getByRole('dialog', { name: 'Remove this unreadable project?' }).textContent).toContain('Its 3 sessions go with it.');
  });

  it('is refused in place of its confirmation while one of its sessions runs', () => {
    show([s('Fix login'), s('Create plan', SUMMARIES.runningThinking)]);
    render(<Harness />);
    fireEvent.click(within(projectMenu('Calamari')).getByRole('menuitem', { name: 'Remove' }));
    expect(screen.queryByRole('dialog', { name: 'Remove Calamari?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'A session of Calamari is running' }).textContent).toContain('cannot be removed while one of its chats or its sub-agents is still working');
    expect(requests).toEqual([]);
    // A project whose sessions do not run is asked about as before.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'OK' }));
    fireEvent.click(within(projectMenu('website')).getByRole('menuitem', { name: 'Remove' }));
    expect(screen.getByRole('dialog', { name: 'Remove website?' })).toBeTruthy();
  });

  it('says so when main refuses after the confirmation, and not that the change failed', async () => {
    answer = () => ({ status: 'refused', reason: 'session-running' });
    show([s('Fix login')]);
    render(<Harness />);
    fireEvent.click(within(projectMenu('Calamari')).getByRole('menuitem', { name: 'Remove' }));
    await click(within(screen.getByRole('dialog', { name: 'Remove Calamari?' })).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('dialog', { name: 'A session of Calamari is running' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the row of sessions without a project (V14; C107)', () => {
  const row = () => column().querySelector('[data-orphan-row]');

  it('shows only with a count above zero, at the foot of the column', () => {
    show([s('Fix login')]);
    const { unmount } = render(<Harness />);
    expect(row()).toBeNull();
    unmount();
    show([s('Fix login')], { orphans: 2 });
    render(<Harness />);
    expect(row()?.textContent).toBe('2 sessions without a projectRemove');
    expect(column().lastElementChild?.lastElementChild?.hasAttribute('data-orphan-row') === true || column().querySelector('[data-orphan-row] ~ ul') === null).toBe(true);
    act(() => void show([], { orphans: 1 }));
    expect(row()?.textContent).toBe('1 session without a projectRemove');
  });

  it('confirms with the count, and sends one request', async () => {
    show([], { orphans: 2 });
    render(<Harness />);
    fireEvent.click(within(row() as HTMLElement).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove 2 sessions without a project?' });
    expect(dialog.textContent).toContain('2 sessions whose projects are no longer in it');
    expect(dialog.textContent).toContain(REMOVE_CHAT_TEXT.orphans);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(requests).toEqual([['sessions:removeOrphans', null]]);
  });

  it('sends nothing when cancelled', () => {
    show([], { orphans: 1 });
    render(<Harness />);
    fireEvent.click(within(row() as HTMLElement).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Remove 1 session without a project?' })).getByRole('button', { name: 'Cancel' }));
    expect(requests).toEqual([]);
  });
});

// ── V25: reordering ───────────────────────────────────────────────────────────────────────────
describe('dragging a capsule (V25; C55)', () => {
  // Starred first, as the list draws them: s1, s2, then a, b, c; touching rows include their dividers.
  const five = () => [s('a'), s('s1', SUMMARIES.idle, { starred: true }), s('b'), s('s2', SUMMARIES.idle, { starred: true }), s('c'), s('done', SUMMARIES.idle, { completedAt: 5 })];
  const id = (name: string) => s(name).record.id;
  const y = (index: number, part = 0.5) => LIST_TOP + index * ROW + part * ROW;
  const press = (element: Element, at: number, x = 100) => fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: x, clientY: at });
  const moveTo = (at: number, x = 100) => fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: at });
  const release = (at: number, x = 100) => fireEvent.pointerUp(window, { pointerId: 1, clientX: x, clientY: at });
  const lifted = () => column().querySelector('[data-session-id][data-lifted]');
  const shifts = (): Record<string, string> =>
    Object.fromEntries([...column().querySelectorAll<HTMLElement>('[data-session-id]')].filter((element) => element.style.transform !== '').map((element) => [element.querySelector('span span')?.textContent ?? '', element.style.transform]));

  it.each(['shelf', 'completed'] as const)('drags and keyboard-reorders thin %s capsules with focus and announcements', async (list) => {
    const state = list === 'shelf' ? { shelvedAt: 1 } : { completedAt: 1 };
    show(['a', 'b', 'c'].map((name) => s(name, SUMMARIES.idle, state)));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: list === 'shelf' ? '3 on the shelf' : '3 completed' }));
    press(selectButton('a'), y(0));
    moveTo(y(2, 0.8));
    expect(lifted()).not.toBeNull();
    expect(column().querySelectorAll('[data-gap]')).toHaveLength(1);
    await act(async () => { release(y(2, 0.8)); await flush(); });
    expect(requests).toEqual([['sessions:move', { id: id('a'), before: null, group: { list, starred: false } }]]);
    fireEvent.click(selectButton('a'));
    expect(requests).toHaveLength(1);
    fireEvent.keyDown(selectButton('a'), { key: 'ArrowUp', altKey: true });
    await act(async () => { await flush(); });
    expect(requests.at(-1)).toEqual(['sessions:move', { id: id('a'), before: id('c'), group: { list, starred: false } }]);
    expect(document.activeElement).toBe(selectButton('a'));
    expect(announced()).toContain(`position 2 of 3 in ${list === 'shelf' ? 'shelved' : 'completed'} sessions`);
  });

  it('drops at the visible completed page boundary before its hidden tail and keeps keyboard moves within that page', async () => {
    show([1, 2, 3, 4, 5, 6, 7].map((n) => s(`d${n}`, SUMMARIES.idle, { completedAt: n })));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '7 completed' }));
    fireEvent.keyDown(selectButton('d5'), { key: 'ArrowDown', altKey: true });
    expect(requests).toEqual([]);
    press(selectButton('d1'), y(0));
    moveTo(y(4, 0.8));
    await act(async () => { release(y(4, 0.8)); await flush(); });
    expect(requests).toEqual([['sessions:move', { id: id('d1'), before: id('d6'), group: { list: 'completed', starred: false } }]]);
    const rows = screen.getByRole('list', { name: 'Completed sessions of Calamari' });
    expect(within(rows).getAllByRole('button').filter((button) => button.hasAttribute('data-select-session')).map((button) => button.textContent)).toEqual(['d2', 'd3', 'd4', 'd5', 'd1']);
  });

  it('cancels a drag when its visible group order changes', async () => {
    const entries = five();
    show(entries);
    render(<Harness />);
    press(selectButton('a'), y(2));
    moveTo(y(4));
    expect(lifted()).not.toBeNull();
    act(() => { show([...entries].reverse()); });
    expect(lifted()).toBeNull();
    await act(async () => { release(y(4)); await flush(); });
    expect(requests).toEqual([]);
  });

  it('starts only after the pointer moves 4 px, so a press still selects', async () => {
    show(five());
    render(<Harness />);
    press(selectButton('a'), y(2));
    moveTo(y(2) + 3);
    expect(lifted()).toBeNull();
    release(y(2) + 3);
    await click(selectButton('a'));
    expect(requests).toEqual([['sessions:select', { id: id('a') }]]);
  });

  it('lifts the capsule past the threshold, moves the others of its group out of the way, and drops with one move', async () => {
    show(five());
    render(<Harness />);
    press(selectButton('a'), y(2));
    moveTo(y(2) + 10);
    expect(lifted()?.getAttribute('data-session-id')).toBe(id('a'));
    // Down to the second half of c, the last of its group: b and c move up one capsule.
    moveTo(y(4, 0.75));
    expect(shifts()).toEqual({ b: `translateY(-${ROW}px)`, c: `translateY(-${ROW}px)` });
    expect(column().querySelector('[data-gap]')).not.toBeNull();
    await act(async () => {
      release(y(4, 0.75));
      await flush();
    });
    expect(requests).toEqual([['sessions:move', { id: id('a'), before: null, group: { list: 'active', starred: false } }]]);
    expect(lifted()).toBeNull();
    // It stays where it was dropped until the new state arrives.
    expect(activeNames()).toEqual(['s1', 's2', 'b', 'c', 'a']);
  });

  // M102 (V7; C34): the avatar's image takes no pointer event, so a press on it is its capsule's.
  it('drags a capsule from a press on its avatar’s image', async () => {
    const face = { ref: { origin: 'built-in' as const, family: 'Orange', avatar: 'Default' }, portrait: 'a'.repeat(32), small: null };
    show(five().map((entry) => ({ ...entry, avatar: face })));
    render(<Harness />);
    const image = selectButton('a').querySelector('img') as HTMLImageElement;
    press(image, y(2));
    moveTo(y(2) + 10);
    expect(lifted()?.getAttribute('data-session-id')).toBe(id('a'));
    release(y(2) + 10);
  });

  it('does not select with the click that ends a drag', async () => {
    show(five());
    render(<Harness />);
    press(selectButton('c'), y(4));
    moveTo(y(2, 0.25));
    await act(async () => {
      release(y(2, 0.25));
      fireEvent.click(selectButton('c'));
      await flush();
    });
    expect(requests).toEqual([['sessions:move', { id: id('c'), before: id('a'), group: { list: 'active', starred: false } }]]);
  });

  it('keeps a starred capsule among the starred', async () => {
    show(five());
    render(<Harness />);
    press(selectButton('s2'), y(1));
    moveTo(y(0, 0.25));
    await act(async () => {
      release(y(0, 0.25));
      await flush();
    });
    expect(requests).toEqual([['sessions:move', { id: id('s2'), before: id('s1'), group: { list: 'active', starred: true } }]]);
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['a release outside its group', () => release(y(0, 0.5))],
    ['a release outside the column', () => release(y(4), 500)],
    ['a release at its own place', () => release(y(2, 0.6))],
    ['a cancelled pointer', () => fireEvent.pointerCancel(window, { pointerId: 1 })],
  ])('sends nothing on %s', async (_name, end) => {
    show(five());
    render(<Harness />);
    press(selectButton('a'), y(2));
    moveTo(y(2) + 10);
    moveTo(y(3, 0.75));
    expect(lifted()).not.toBeNull();
    // Over the starred capsules there is no gap: a release there cancels.
    moveTo(y(0, 0.5));
    expect(column().querySelector('[data-gap]')).toBeNull();
    moveTo(y(2, 0.6));
    await act(async () => {
      end();
      await flush();
    });
    expect(lifted()).toBeNull();
    expect(requests).toEqual([]);
    expect(activeNames()).toEqual(['s1', 's2', 'a', 'b', 'c']);
  });

  it('never drags from the … button, nor a thin capsule', () => {
    show(five());
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /\d+ completed$/ }));
    for (const control of [actions('a'), actions('done')]) {
      press(control, y(2));
      moveTo(y(4));
      expect(lifted()).toBeNull();
      expect(column().querySelector('[data-gap]')).toBeNull();
      release(y(4));
    }
    expect(requests).toEqual([]);
  });

  it('never starts a project drag from a capsule', () => {
    show(five());
    render(<Harness />);
    press(selectButton('a'), y(2));
    moveTo(y(4));
    expect(column().querySelector('[data-entry-key][data-lifted]')).toBeNull();
    release(y(2, 0.6));
  });

  it('puts the capsule back when the move is refused', async () => {
    answer = () => ({ status: 'refused', reason: 'outside-group' });
    show(five());
    render(<Harness />);
    press(selectButton('a'), y(2));
    moveTo(y(4, 0.75));
    await act(async () => {
      release(y(4, 0.75));
      await flush();
    });
    expect(activeNames()).toEqual(['s1', 's2', 'a', 'b', 'c']);
    expect(screen.getByRole('status').textContent).toBe('fat-g could not save the change, and nothing was changed.');
  });
});

describe('moving a capsule from the keyboard (V25; C90)', () => {
  const three = () => [s('a'), s('b'), s('c'), s('star', SUMMARIES.idle, { starred: true })];
  const id = (name: string) => s(name).record.id;
  const key = async (name: string, arrow: 'ArrowUp' | 'ArrowDown', altKey = true) => {
    await act(async () => {
      fireEvent.keyDown(selectButton(name), { key: arrow, altKey });
      await flush();
    });
  };

  it('moves one place within its group with Alt+Up and Alt+Down, keeps the focus, and announces the position', async () => {
    show(three());
    render(<Harness />);
    act(() => selectButton('b').focus());
    await key('b', 'ArrowUp');
    expect(requests).toEqual([['sessions:move', { id: id('b'), before: id('a'), group: { list: 'active', starred: false } }]]);
    expect(activeNames()).toEqual(['star', 'b', 'a', 'c']);
    expect(announced()).toBe('b, position 1 of 3 in sessions.');
    expect(document.activeElement).toBe(selectButton('b'));
    await key('b', 'ArrowDown');
    expect(requests.at(-1)).toEqual(['sessions:move', { id: id('b'), before: id('c'), group: { list: 'active', starred: false } }]);
    expect(announced()).toBe('b, position 2 of 3 in sessions.');
  });

  it('stops at its group’s ends, and never crosses into the other group', async () => {
    show(three());
    render(<Harness />);
    await key('a', 'ArrowUp');
    await key('c', 'ArrowDown');
    await key('star', 'ArrowDown');
    await key('star', 'ArrowUp');
    expect(requests).toEqual([]);
    expect(announced()).toBe('');
  });

  it('leaves the plain arrow keys alone, and says its shortcut', async () => {
    show(three());
    render(<Harness />);
    await key('b', 'ArrowUp', false);
    expect(requests).toEqual([]);
    expect(selectButton('b').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown');
  });
});

// Choosing a session puts it first in its group (decision 0011, item 12): main's write, the list's wait.
describe('the order held after a press', () => {
  const id = (name: string) => s(name).record.id;
  const press = async (name: string, detail = 1) => {
    await act(async () => {
      fireEvent.click(selectButton(name), { detail });
      await flush();
    });
  };
  const leave = () => act(() => { fireEvent.pointerLeave(selectButton('b')); });

  it('keeps the capsules where they were until the pointer leaves the list, then shows the saved order', async () => {
    show([s('a'), s('b'), s('c')]);
    render(<Harness />);
    await press('c');
    expect(requests).toEqual([['sessions:select', { id: id('c') }]]);
    act(() => { show([s('c'), s('a'), s('b')]); });
    expect(activeNames()).toEqual(['a', 'b', 'c']);
    // A change of list shows at once: only the order waits.
    act(() => { show([s('c'), s('a', SUMMARIES.idle, { completedAt: 5 }), s('b')]); });
    expect(activeNames()).toEqual(['b', 'c']);
    leave();
    expect(activeNames()).toEqual(['c', 'b']);
  });

  it('holds nothing for a choice made from the keyboard', async () => {
    show([s('a'), s('b'), s('c')]);
    render(<Harness />);
    await press('c', 0);
    act(() => { show([s('c'), s('a'), s('b')]); });
    expect(activeNames()).toEqual(['c', 'a', 'b']);
  });

  it('saves a move made meanwhile as shown, the promotion held back put where the user left it', async () => {
    show([s('a'), s('b'), s('c'), s('d')]);
    render(<Harness />);
    await press('c');
    act(() => { show([s('c'), s('a'), s('b'), s('d')]); });
    requests = [];
    act(() => selectButton('d').focus());
    await act(async () => {
      fireEvent.keyDown(selectButton('d'), { key: 'ArrowUp', altKey: true });
      await flush();
    });
    // Shown a, b, d, c; saved c, a, b, d: c to the end makes them one.
    expect(requests).toEqual([['sessions:move', { id: id('c'), before: null, group: { list: 'active', starred: false } }]]);
    expect(activeNames()).toEqual(['a', 'b', 'd', 'c']);
    expect(announced()).toBe('d, position 3 of 4 in sessions.');
    expect(document.activeElement).toBe(selectButton('d'));
    act(() => { show([s('a'), s('b'), s('d'), s('c')]); });
    leave();
    expect(activeNames()).toEqual(['a', 'b', 'd', 'c']);
  });
});

// ── M18, V19 (C42): no removal while the conversation store is refused ─────────────────────────────
describe('while the conversation store is refused (M18, V19; C42)', () => {
  const REFUSED: ConversationsState = { status: { kind: 'refused', cause: 'damaged' }, detached: 0 };
  const READ: ConversationsState = { status: { kind: 'ok' }, detached: 0 };

  it('offers no Remove for a session: Rename, Done and Shelve alone in an active one’s menu, and its flags, Shelve and Restore in a completed one’s', () => {
    show([s('Fix login'), s('Old task', SUMMARIES.idle, { completedAt: 100 })], { conversations: REFUSED });
    render(<Harness />);
    // A name is the records’ (M26): the conversation store being refused takes nothing from Rename.
    fireEvent.click(screen.getByRole('button', { name: /\d+ completed$/ }));
    expect(within(openMenuOf('Fix login')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename', 'Done', 'Shelve']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    const completed = openMenuOf('Old task');
    expect(within(completed).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Shelve', 'Restore']);
    expect(within(completed).getAllByRole('menuitemcheckbox')).toHaveLength(3);
    fireEvent.keyDown(completed, { key: 'Escape' });
    // The session stays listed, and selectable.
    fireEvent.click(within(capsule('Old task')).getAllByRole('button')[0] as HTMLElement);
    expect(requests).toEqual([['sessions:select', { id: s('Old task', SUMMARIES.idle, { completedAt: 100 }).record.id }]]);
  });

  it('offers no Remove for a project, and no menu for one fat-g cannot read', () => {
    showState({ projects: [A, unreadable('one', 3)], conversations: REFUSED });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Calamari' }));
    expect(within(screen.getByRole('menu', { name: 'Actions for Calamari' })).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Edit', 'Hide']);
    expect(screen.queryByRole('button', { name: 'Actions for unreadable project' })).toBeNull();
  });

  it('counts the sessions without a project, and offers no Remove for them', () => {
    show([], { orphans: 2, conversations: REFUSED });
    render(<Harness />);
    const row = column().querySelector('[data-orphan-row]') as HTMLElement;
    expect(row.textContent).toBe('2 sessions without a project');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('offers them all again once the store is read', () => {
    show([s('Fix login')], { orphans: 1, conversations: READ });
    render(<Harness />);
    expect(within(openMenuOf('Fix login')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename', 'Done', 'Shelve', 'Destroy forever']);
    expect(within(column().querySelector('[data-orphan-row]') as HTMLElement).getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it.each(['conversations-refused', 'storage-failed'] as const)('says the change failed when main refuses a removal as %s', async (reason) => {
    answer = () => ({ status: 'refused', reason });
    show([s('Fix login')], { orphans: 1 });
    render(<Harness />);
    fireEvent.click(within(openMenuOf('Fix login')).getByRole('menuitem', { name: 'Destroy forever' }));
    await click(within(screen.getByRole('dialog', { name: 'Remove Fix login?' })).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('status').textContent).toBe('fat-g could not save the change, and nothing was changed.');
    cleanup();
    show([s('Fix login')], { orphans: 1 });
    render(<Harness />);
    fireEvent.click(within(column().querySelector('[data-orphan-row]') as HTMLElement).getByRole('button', { name: 'Remove' }));
    await click(within(screen.getByRole('dialog', { name: 'Remove 1 session without a project?' })).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('status').textContent).toBe('fat-g could not remove them, and nothing was changed.');
    cleanup();
    show([s('Fix login')]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Calamari' }));
    fireEvent.click(within(screen.getByRole('menu', { name: 'Actions for Calamari' })).getByRole('menuitem', { name: 'Remove' }));
    await click(within(screen.getByRole('dialog', { name: 'Remove Calamari?' })).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('status').textContent).toBe('fat-g could not save the change, and nothing was changed.');
  });
});
