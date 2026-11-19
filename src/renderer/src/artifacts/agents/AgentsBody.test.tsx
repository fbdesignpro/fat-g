// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// A session's Sub-agents tab (docs/planning/_archive/M106.md, V5; C1, C5–C12, C16, C18, C20–C25, C30–C32,
// C40–C44; docs/planning/_archive/M100.md, round 8; C78): the stack of its sub-agents, each unfolding its
// thread under its row, and the grants fat-g sent folded under them, drawn in the pane as the page draws
// it — the tab opening by itself for a session with sub-agents. The watcher's own rules are
// AgentsWatcher.test.tsx's, the grants list's GrantsList.test.tsx's and the thread's AgentThread.test.tsx's.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAvatar } from '@shared/contracts/avatars';
import type { AgentView, SessionEntry, SessionSummary } from '@shared/contracts/sessions';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sessionEntry, SUMMARIES, TURN_STARTED_AT } from '../../../../../tests/support/sessions';
import { resetGrants, setGrants } from '../../chat/grants-store';
import { installFakeBridge } from '../../test/fake-bridge';
import { PaneWithKinds } from '../../test/pane';
import { project } from '../../test/records';
import { showState } from '../../test/sessions';
import { BUILT_IN_KINDS } from '../kinds';
import { AGENTS_KIND, openAgent, openAside } from '../opener';
import { closeTab, resetTabs, selectTab, tabId, useTabs } from '../tabs-store';
import { closeLabel } from '../TabList';

let requests: [InvokeChannel, unknown][];

beforeEach(() => {
  const bridge = installFakeBridge();
  requests = [];
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    return { ok: true, value: { status: 'refused', reason: 'unknown-worker' } };
  });
  resetTabs();
  resetGrants();
});
afterEach(() => {
  cleanup();
  resetTabs();
  vi.useRealTimers();
});

const A = project('Calamari');
const s = (name: string, summary: SessionSummary): SessionEntry => sessionEntry(name, summary, { projectId: A.id, providerId: 'claude' });
const show = (sessions: readonly SessionEntry[], selected: SessionEntry) => showState({ projects: [A], sessions: [...sessions], selectedId: selected.record.id });
const tab = () => document.querySelector<HTMLElement>('[data-agents-tab]');
/** The rows drawn, by their buttons. */
const rows = () => [...(tab()?.querySelectorAll<HTMLButtonElement>('[data-row]') ?? [])];
const row = (id: string) => tab()?.querySelector<HTMLButtonElement>(`[data-row="${id}"]`) ?? null;
const thread = () => tab()?.querySelector<HTMLElement>('[data-agent-thread]') ?? null;
const readsOf = () => requests.filter(([channel]) => channel === 'chat:readWorker').map(([, request]) => (request as { workerId: string }).workerId);
const fold = (name: string | RegExp) => within(tab() as HTMLElement).getByRole('button', { name });
const AGENTS_TAB = tabId(AGENTS_KIND, null);
const after = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

const agent = (number: number, patch: Partial<AgentView> = {}): AgentView => ({
  id: `w${number}`, number, label: `Task ${number}`, state: 'running', action: null, startedAt: TURN_STARTED_AT + number * 1000, finishedAt: null, model: null, agentType: null, attention: null, ...patch,
});
const withAgents = (entry: SessionEntry, agents: readonly AgentView[]): SessionEntry => ({ ...entry, summary: { ...entry.summary, agents, activeWorkers: agents.filter((one) => one.state === 'running').length } });
const face = (portrait: string): ResolvedAvatar => ({ ref: { origin: 'built-in', family: 'Orange', avatar: 'Default' }, portrait, small: null });

describe('the Sub-agents tab (M106, V5)', () => {
  it('is not there for a session with no sub-agent', () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    expect(tab()).toBeNull();
    expect(useTabs.getState().sessions[entry.record.id]).toBeUndefined();
  });

  it('stands first with no ×, and neither Delete nor the store closes it (C1, C2)', () => {
    const entry = s('Create plan', SUMMARIES.runningWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    const shown = screen.getByRole('tab', { name: 'Sub-agents' });
    expect(shown.getAttribute('aria-selected')).toBe('true');
    expect(shown.textContent).toBe('// Sub-agents');
    expect(screen.queryByRole('button', { name: closeLabel('Sub-agents') })).toBeNull();
    fireEvent.keyDown(shown, { key: 'Delete' });
    act(() => closeTab(entry.record.id, AGENTS_TAB));
    expect(useTabs.getState().sessions[entry.record.id]?.tabs.map((held) => held.kind)).toEqual([AGENTS_KIND]);
  });

  it('draws each running sub-agent with its number and label, and its action and time together in the capsule footer', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: TURN_STARTED_AT + 120_000 });
    const entry = s('Create plan', SUMMARIES.runningWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    // Running ones only, the most recently started on top: worker 2 has finished and is folded.
    expect(rows().map((button) => button.getAttribute('data-row'))).toEqual(['worker-3', 'worker-1']);
    const [third, first] = rows();
    expect(third?.querySelector('[data-avatar]')?.getAttribute('data-size')).toBe('capsule');
    expect(third?.textContent).toBe('#3: Check the release notesThinking…1m40s');
    expect(first?.textContent).toBe('#1: Explore the login flowReading1m48s');
    expect(first?.querySelector('[title="#1: Explore the login flow"]')).toBeTruthy();
    expect(third?.querySelector('[data-capsule-status]')?.textContent).toBe('Thinking…1m40s');
    expect(third?.querySelector('[data-capsule-status]')?.lastElementChild?.getAttribute('data-time')).toBe('');
    expect(third?.querySelector('[data-status-stream]')?.getAttribute('data-compact')).toBe('true');
    expect(tab()?.querySelector('[data-model]')).toBeNull();
    // Model details remain available to assistive technology.
    expect(third?.getAttribute('aria-label')).toBe('Sub-agent 3, Check the release notes: Thinking…, on Sample One, model assumed');
    expect(first?.getAttribute('aria-label')).toBe('Sub-agent 1, Explore the login flow: Reading auth.ts, on gpt-6-sol');
    // No heading: the tab's title names it (C11).
    expect(within(tab() as HTMLElement).queryByRole('heading')).toBeNull();
  });

  it('says a running one with no action is working, without showing model or agent definition labels', () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    show([withAgents(entry, [agent(1, { model: 'sample-1', agentType: 'Explore' }), agent(2, { model: 'sample-1', agentType: 'general-purpose' })])], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    expect(rows().every((button) => !/Sample One|Explore|general-purpose/.test(button.textContent ?? ''))).toBe(true);
    expect(rows().map((button) => button.textContent?.includes('Thinking…'))).toEqual([true, true]);
  });

  it('replaces the whole footer with attention when a sub-agent waits on the user (C8)', () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    show([withAgents(entry, [agent(1, { attention: { kind: 'question', count: 2, acknowledged: false } }), agent(2)])], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    const lit = row('w1');
    const bar = lit?.querySelector('[data-attention="question"]');
    expect(bar?.textContent).toContain('2 Questions');
    expect(bar?.querySelector('[data-time]')).toBeTruthy();
    expect(bar?.querySelector('[data-status-stream]')?.hasAttribute('data-immediate')).toBe(true);
    expect(lit?.getAttribute('aria-label')).toBe('Sub-agent 1, Task 1: 2 Questions, on Sample One, model assumed');
    expect(row('w2')?.querySelector('[data-attention]')).toBeNull();
  });

  // M106 (C16, C17): each by its own model's avatar, main's; one with none by its session's.
  it('draws each row’s avatar by its model, and the session’s for one the CLI did not name, following its entry', () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    const agents = [agent(1, { model: 'haiku' }), agent(2)];
    const shown = (map: SessionEntry['agentAvatars']) => show([{ ...withAgents(entry, agents), avatar: face('a'.repeat(32)), ...(map === undefined ? {} : { agentAvatars: map }) }], entry);
    shown({ w1: face('b'.repeat(32)) });
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    const images = () => ['w1', 'w2'].map((id) => row(id)?.querySelector('[data-avatar] img')?.getAttribute('src') ?? null);
    expect(images()).toEqual([`app://media/avatars/${'b'.repeat(32)}`, `app://media/avatars/${'a'.repeat(32)}`]);
    // A model main resolved to nothing draws the placeholder alone, not the session's art.
    act(() => { shown({ w1: null }); });
    expect(images()).toEqual([null, `app://media/avatars/${'a'.repeat(32)}`]);
  });

  it('folds the finished ones under their count, thin, the most recently finished first, each with how long it ran (C9, C11)', () => {
    const entry = s('Create plan', SUMMARIES.manyWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    expect(rows().map((button) => button.getAttribute('data-row'))).toEqual(['worker-8', 'worker-7', 'worker-6', 'worker-5', 'worker-4', 'worker-3', 'worker-2', 'worker-1']);
    const line = fold('4 completed sub-agents');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    // 11 at 170 s, 9 at 150 s, 12 at 135 s, 10 at 110 s.
    const thin = rows().slice(8);
    expect(thin.map((button) => button.textContent)).toEqual([
      '#11: List the open issuesCompleted 1m10s',
      '#9: Summarise the findingsCompleted 1m0s',
      '#12: 019f2c1a-7b3e-7d21-8a4f-0c5d6e7f8a9bCompleted 15s',
      '#10: Fetch the changelogFailed 15s',
    ]);
    expect(thin[0]?.querySelector('[data-avatar]')?.getAttribute('data-size')).toBe('thin');
    expect(thin.every((button) => after(line, button))).toBe(true);
    fireEvent.click(line);
    expect(rows()).toHaveLength(8);
  });

  it('says 1 completed sub-agent for one', () => {
    const entry = s('Create plan', SUMMARIES.runningWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    expect(fold('1 completed sub-agent')).toBeTruthy();
  });

  it('keeps its folds as they were left, between showings and across a turn’s start (C23, C30)', () => {
    const entry = s('Create plan', SUMMARIES.manyWorkers);
    show([entry], entry);
    act(() => setGrants(entry.record.id, [{ itemId: 'g1', covers: 'Bash(ls)', decidedAt: 5, confirmed: true, live: true }]));
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    fireEvent.click(fold('4 completed sub-agents'));
    fireEvent.click(fold('1 grant'));
    expect(rows()).toHaveLength(12);
    // Another tab shown, then this one again: as it was left.
    act(() => { openAside(entry.record.id, 'aside-1', 'A question'); });
    expect(tab()).toBeNull();
    act(() => { selectTab(entry.record.id, AGENTS_TAB); });
    expect(rows()).toHaveLength(12);
    expect(fold('1 grant').getAttribute('aria-expanded')).toBe('true');
    // A new turn: the finished ones stay listed and unfolded (C26, C30).
    act(() => void show([{ ...entry, summary: { ...entry.summary, turnStartedAt: TURN_STARTED_AT + 500_000 } }], entry));
    expect(fold('4 completed sub-agents').getAttribute('aria-expanded')).toBe('true');
    expect(rows()).toHaveLength(12);
  });

  it('keeps each session’s folds apart', () => {
    const first = s('Create plan', SUMMARIES.manyWorkers);
    const second = s('Fix login', SUMMARIES.manyWorkers);
    show([first, second], first);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    fireEvent.click(fold('4 completed sub-agents'));
    act(() => void show([first, second], second));
    expect(fold('4 completed sub-agents').getAttribute('aria-expanded')).toBe('false');
    act(() => void show([first, second], first));
    expect(fold('4 completed sub-agents').getAttribute('aria-expanded')).toBe('true');
  });

  it('unfolds a sub-agent’s thread under its own row, before the next, the two one box; a second press folds it, another row’s moves it (C40–C42, C44)', () => {
    const entry = s('Create plan', SUMMARIES.runningWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    // Nothing is read while no thread is unfolded, and a new sub-agent opens none (C23).
    expect(readsOf()).toEqual([]);
    expect(thread()).toBeNull();
    fireEvent.click(row('worker-1') as HTMLElement);
    const opened = thread() as HTMLElement;
    expect(opened.getAttribute('data-agent-thread')).toBe('worker-1');
    expect(row('worker-1')?.getAttribute('aria-expanded')).toBe('true');
    expect(row('worker-1')?.getAttribute('aria-controls')).toBe(opened.id);
    expect(row('worker-3')?.getAttribute('aria-expanded')).toBe('false');
    // In its row's box, after its row and before the fold line under it.
    const box = row('worker-1')?.closest('[data-agent]') as HTMLElement;
    expect([box.contains(opened), box.hasAttribute('data-open'), after(row('worker-1') as HTMLElement, opened), after(opened, fold('1 completed sub-agent'))]).toEqual([true, true, true, true]);
    expect(row('worker-3')?.closest('[data-agent]')?.hasAttribute('data-open')).toBe(false);
    expect(readsOf()).toEqual(['worker-1']);
    // Another row: the thread moves there, read afresh.
    fireEvent.click(row('worker-3') as HTMLElement);
    expect(thread()?.getAttribute('data-agent-thread')).toBe('worker-3');
    expect(after(row('worker-3') as HTMLElement, thread() as HTMLElement) && after(thread() as HTMLElement, row('worker-1') as HTMLElement)).toBe(true);
    expect(tab()?.querySelectorAll('[data-agent-thread]')).toHaveLength(1);
    expect(readsOf()).toEqual(['worker-1', 'worker-3']);
    // The open row pressed again: folded.
    fireEvent.click(row('worker-3') as HTMLElement);
    expect(thread()).toBeNull();
    expect(rows().every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true);
  });

  it('is one stop for the keyboard: Up, Down, Home and End among the rows drawn, Enter or Space unfolding; the open one is the stop (C43)', () => {
    const entry = s('Create plan', SUMMARIES.manyWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    const stops = () => rows().filter((button) => button.tabIndex === 0).map((button) => button.getAttribute('data-row'));
    expect(stops()).toEqual(['worker-8']);
    const first = rows()[0] as HTMLButtonElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-row')).toBe('worker-7');
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-row')).toBe('worker-1');
    // The completed ones join the stop while their fold is open.
    fireEvent.click(fold('4 completed sub-agents'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-row')).toBe('worker-10');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('data-row')).toBe('worker-12');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement?.getAttribute('data-row')).toBe('worker-8');
    expect(stops()).toEqual(['worker-8']);
    // A row is a button: Enter and Space press it.
    fireEvent.click(document.activeElement as Element);
    expect(thread()?.getAttribute('data-agent-thread')).toBe('worker-8');
    // A press of the pointer moves the focus nowhere, and the stop follows it.
    const pressed = fireEvent.mouseDown(row('worker-5') as HTMLElement);
    expect(pressed).toBe(false);
    fireEvent.click(row('worker-5') as HTMLElement);
    expect(stops()).toEqual(['worker-5']);
    // Tab from the open row goes into its thread: the rows after it are no stops of their own.
    expect(after(row('worker-5') as HTMLElement, thread() as HTMLElement)).toBe(true);
  });

  it('keeps the completed rows unfolded while one of them is chosen, and folds its thread with them (C9, C24)', () => {
    const entry = s('Create plan', SUMMARIES.manyWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    act(() => { openAgent(entry.record.id, 'worker-9', 'Summarise the findings'); });
    expect(fold('4 completed sub-agents').getAttribute('aria-expanded')).toBe('true');
    expect(thread()?.getAttribute('data-agent-thread')).toBe('worker-9');
    fireEvent.click(fold('4 completed sub-agents'));
    expect([thread(), rows().length]).toEqual([null, 8]);
  });

  it('drops the chosen one when its sub-agent leaves the list, and opens no thread for a new one (C23, C27)', () => {
    const entry = s('Create plan', SUMMARIES.runningWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    fireEvent.click(row('worker-1') as HTMLElement);
    const gone = withAgents(entry, entry.summary.agents.filter((one) => one.id !== 'worker-1'));
    act(() => void show([gone], entry));
    expect(thread()).toBeNull();
    act(() => void show([withAgents(entry, [...gone.summary.agents, agent(9)])], entry));
    expect(thread()).toBeNull();
    expect(row('w9')).toBeTruthy();
  });

  it('heads a thread chosen for a sub-agent the list does not hold with its own line, first in the stack, which folds it (C24)', () => {
    const entry = s('Create plan', SUMMARIES.runningWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    act(() => { openAgent(entry.record.id, 'worker-old', 'An older task'); });
    const box = tab()?.querySelector('[data-unlisted]') as HTMLElement;
    expect(box).toBeTruthy();
    expect(after(box, row('worker-3') as HTMLElement)).toBe(true);
    const head = within(box).getByRole('button', { name: 'An older task' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(thread()?.getAttribute('data-agent-thread')).toBe('worker-old');
    expect(rows().every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true);
    fireEvent.click(head);
    expect(tab()?.querySelector('[data-unlisted]')).toBeNull();
  });

  it('says No sub-agents where a grant opened it and none has run, and folds the grants under one line (C11, C31)', () => {
    const entry = s('Create plan', SUMMARIES.runningThinking);
    show([entry], entry);
    act(() => setGrants(entry.record.id, [{ itemId: 'g1', covers: 'Bash(ls)', decidedAt: 5, confirmed: true, live: true }, { itemId: 'g2', covers: 'Edit', decidedAt: 6, confirmed: false, live: false }]));
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    expect(within(tab() as HTMLElement).getByText('No sub-agents')).toBeTruthy();
    const line = fold('2 grants');
    expect([line.getAttribute('aria-expanded'), tab()?.querySelector('[data-grants]')]).toEqual(['false', null]);
    fireEvent.click(line);
    const grants = within(tab() as HTMLElement).getByRole('region', { name: 'Grants fat-g sent' });
    expect(after(line, grants)).toBe(true);
    expect([...grants.querySelectorAll('[data-grant]')].map((one) => one.getAttribute('data-grant'))).toEqual(['g1', 'g2']);
  });

  it('draws no grants line for a session with none, and is the part that scrolls, as a whole (C40)', () => {
    const entry = s('Create plan', SUMMARIES.runningWorkers);
    show([entry], entry);
    render(<PaneWithKinds kinds={BUILT_IN_KINDS} watch />);
    expect(within(tab() as HTMLElement).queryByRole('button', { name: /grant/ })).toBeNull();
    expect(rows().every((button) => (tab() as HTMLElement).contains(button))).toBe(true);
  });
});
