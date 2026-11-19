// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleProvider, sampleSnapshot } from '../../../../tests/support/app-state';
import { sessionEntry, sessionsState, SUMMARIES } from '../../../../tests/support/sessions';
import { FILE_KIND, openReference } from '../artifacts/opener';
import { openTab, registerKinds, resetTabs, useTabs } from '../artifacts/tabs-store';
import { showDetached } from '../chat/detached-store';
import { closeProjectDialog, useProjectDialog } from '../projects/project-dialog-store';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { prefsSnapshot } from '../test/prefs';
import { project, recordsState } from '../test/records';
import { showState } from '../test/sessions';
import { Shell } from './Shell';
import { resetSplit } from './split-store';
import { SPLIT_LABEL } from './SplitHandle';

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
  resetTabs();
  showDetached(null);
  closeProjectDialog();
  useAppState.setState({ snapshot: sampleSnapshot(1), error: null });
  usePrefs.setState({ snapshot: null, error: null, saving: false });
});
afterEach(cleanup);

const withSide = (projectColumn: 'left' | 'right') => prefsSnapshot({ layout: { projectColumn } });

/** Every landmark and named region, in document order: [role, name]. */
function landmarks(container: HTMLElement): string[] {
  const role = (element: Element): string => {
    const explicit = element.getAttribute('role');
    if (explicit !== null) return explicit;
    switch (element.tagName) {
      case 'HEADER': return 'banner';
      case 'ASIDE': return 'complementary';
      case 'MAIN': return 'main';
      default: return 'region';
    }
  };
  return [...container.querySelectorAll('header, aside, main, section[aria-label], [role="toolbar"]')].map(
    (element) => `${role(element)}${element.hasAttribute('aria-label') ? `: ${element.getAttribute('aria-label') ?? ''}` : ''}`,
  );
}

// docs/planning/_archive/M100.md, Design 2: the title strip with its two buttons, the band, the session window, the projects.
const STRIP = ['banner', 'toolbar: Controls'];
const BAND = ['region: Session', 'region: Usage'];

const CALAMARI = project('Calamari', { color: 'purple' });
const PLAN = sessionEntry('Create plan', SUMMARIES.runningThinking, { projectId: CALAMARI.id });
const selecting = (selected: string | null, seq = 2, entries = [PLAN]) =>
  useAppState.setState({ snapshot: { ...sampleSnapshot(seq), records: recordsState([CALAMARI]), sessions: sessionsState(entries, selected) } });

const done = () => screen.queryByRole('button', { name: 'Done' });

describe('the page grid (M100: V2; C9–C12)', () => {
  it('has every region as a named landmark, in the order of the layout, the toolbar inside the banner', () => {
    const { container } = render(<Shell />);
    // The projects are on the left by default (C91), so their column is read before the window.
    expect(landmarks(container)).toEqual([...STRIP, ...BAND, 'complementary: Projects', 'main: Chat']);
    expect(within(screen.getByRole('banner')).getByRole('toolbar', { name: 'Controls' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Projects' })).toBeTruthy();
    expect(screen.getByRole('main', { name: 'Chat' })).toBeTruthy();
    for (const name of ['Session', 'Usage']) expect(screen.getByRole('region', { name })).toBeTruthy();
  });

  it('fills the names and the chat for the selected session, the model block inside its prompt area, with Done in the band and no pane without a tab (C29, C32, C33, C76, C92)', () => {
    selecting(null);
    const { container } = render(<Shell />);
    const session = screen.getByRole('region', { name: 'Session' });
    const chat = screen.getByRole('main', { name: 'Chat' });
    expect([session.children.length, chat.children.length]).toEqual([0, 0]);
    expect(screen.queryByRole('region', { name: 'Model' })).toBeNull();
    expect(done()).toBeNull();
    // Nothing shown: the window draws no box (the maintainer).
    expect(container.querySelectorAll('[data-empty]')).toHaveLength(1);
    act(() => selecting(PLAN.record.id, 3));
    expect(session.textContent).toBe('Calamari // Create plan');
    const model = screen.getByRole('region', { name: 'Model' });
    expect(model.querySelector('[data-avatar][data-size="column"]')).not.toBeNull();
    // The chat holds the model block, at its prompt area's left, before the prompt-type bar (round 8; C76).
    expect(landmarks(container)).toEqual([...STRIP, ...BAND, 'complementary: Projects', 'toolbar: Done, shelf and tags', 'main: Chat', 'region: Model', 'toolbar: Session actions']);
    expect(chat.querySelector('[data-prompt-area]')?.firstElementChild).toBe(model);
    // The chat holds the selected session's: its list, and under it the prompt area with the status bar.
    expect(within(chat).getByRole('group', { name: 'Messages' })).toBeDefined();
    expect(chat.querySelector(`[data-chat-session="${PLAN.record.id}"]`)).not.toBeNull();
    expect(chat.querySelector('[data-prompt-area] [data-status-bar]')?.textContent).toContain('Thinking…');
    expect(container.querySelector('[data-empty]')).toBeNull();
    // Done stands inside the chat window's box, over the chat and outside its landmark, and no
    // longer in the band (the maintainer).
    const band = session.parentElement as HTMLElement;
    expect(band.contains(done())).toBe(false);
    expect(chat.contains(done())).toBe(false);
    expect(container.querySelector('[data-chat-window]')?.contains(done())).toBe(true);
    expect(screen.queryByRole('region', { name: 'Artifacts' })).toBeNull();
  });

  it('shows no text and draws nothing in the session window, with no project and no session (C28, C29)', () => {
    const { container } = render(<Shell />);
    for (const region of [screen.getByRole('region', { name: 'Session' }), screen.getByRole('main', { name: 'Chat' })]) {
      expect(region.textContent).toBe('');
      expect(region.children).toHaveLength(0);
    }
    expect(screen.queryByRole('region', { name: 'Model' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Artifacts' })).toBeNull();
    expect(done()).toBeNull();
    // No box either: the grid alone in the window (the maintainer).
    expect(container.querySelectorAll('[data-empty]')).toHaveLength(1);
  });

  it('holds the project list in the scrolling column, and Add project in the band outside it: nothing before the records arrive (C12, C20)', () => {
    useAppState.setState({ snapshot: sampleSnapshot(1) });
    render(<Shell />);
    const column = screen.getByRole('complementary', { name: 'Projects' });
    expect(column.textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull();
    act(() => useAppState.setState({ snapshot: { ...sampleSnapshot(2), records: { status: { kind: 'ok', keptAs: null }, projects: [] } } }));
    const add = screen.getByRole('button', { name: 'Add project' });
    expect(column.contains(add)).toBe(false);
    expect(column.contains(screen.getByRole('button', { name: 'Search' }))).toBe(false);
    expect(screen.getByRole('button', { name: 'Search' }).parentElement).toBe(add.parentElement);
    // In the band's project cell, before the band's work cell on the left, which is the default (C91).
    const body = column.parentElement as HTMLElement;
    expect([...body.children].indexOf(add.parentElement as HTMLElement)).toBe(0);
  });

  it('opens the project dialog empty from Add project (M12, C35), and does nothing while the records file is refused (C50)', () => {
    selecting(null);
    render(<Shell />);
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(useProjectDialog.getState()).toMatchObject({ open: true, projectId: null });
    closeProjectDialog();
    act(() => useAppState.setState({ snapshot: { ...sampleSnapshot(3), records: recordsState([], { kind: 'refused', cause: 'damaged' }) } }));
    const add = screen.getByRole('button', { name: 'Add project' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(add);
    expect(useProjectDialog.getState().open).toBe(false);
  });

  it('holds the app’s name in the title strip, and after it the menu and the gear (C19)', () => {
    render(<Shell />);
    const strip = screen.getByRole('banner');
    expect(strip.textContent).toBe('fat-g');
    const heading = within(strip).getByRole('heading', { name: 'fat-g' });
    const controls = within(strip).getByRole('toolbar', { name: 'Controls' });
    expect(heading.nextElementSibling).toBe(controls);
    expect(within(controls).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Menu', 'Settings', 'Mini window']);
    expect(strip.querySelectorAll('a, nav')).toHaveLength(0);
  });

  it('holds the usage blocks in the usage box, with its note above it, and the account labels with no second height (C17, C54)', () => {
    const WORK = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
    const codex = (overrides: Parameters<typeof sampleProvider>[0] = {}) => sampleProvider({ id: 'codex', displayName: 'Codex', ...overrides });
    useAppState.setState({ snapshot: sampleSnapshot(2, [sampleProvider(), codex({ label: 'Personal' }), codex({ instanceId: WORK, label: 'Work' })]) });
    const { container } = render(<Shell />);
    const usage = screen.getByRole('region', { name: 'Usage' });
    expect(usage.firstElementChild?.textContent).toBe('Usage remaining');
    expect([...usage.querySelectorAll('[data-usage-block]')].map((block) => block.getAttribute('data-usage-block'))).toEqual(['claude', 'codex', 'codex']);
    expect([...usage.querySelectorAll('[data-account-label]')].map((label) => label.textContent)).toEqual(['Personal', 'Work']);
    expect(container.querySelector('[data-account-labels]')).toBeNull();
  });
});

// M100 (C31, C50, V5): Done, for a selected session that is not completed.
describe('Done (M100, C50)', () => {
  it('stands for a selected active session, goes for a completed one, and sends sessions:complete', () => {
    const requests: string[] = [];
    bridge.setInvoke((channel) => { requests.push(channel); return Promise.resolve({ ok: true, value: { status: 'saved' } }); });
    // Idle: Done is grayed while a session runs.
    const idle = { ...PLAN, summary: SUMMARIES.idle };
    selecting(PLAN.record.id, 2, [idle]);
    render(<Shell />);
    fireEvent.click(done() as HTMLElement);
    expect(requests).toContain('sessions:complete');
    const completed = { ...idle, record: { ...idle.record, completedAt: 5 } };
    act(() => selecting(PLAN.record.id, 3, [completed]));
    expect(done()).toBeNull();
  });
});

// M100 (C43, C44, C59, V7, V14): the split, its kinds and its cleanup, and the chat without a session.
describe('the artifact split (M100, C43, C59)', () => {
  const README = 'D:\\Code\\Calamari\\README.md';
  const handed = { outcome: 'text', path: README, root: 'D:\\Code\\Calamari', view: 'markdown', text: '# Calamari\n', revision: null, line: null, column: null };

  it('splits the session window while the selected session has a tab, and ends the split when the last one closes', () => {
    selecting(PLAN.record.id);
    const { container } = render(<Shell />);
    const split = () => container.querySelector('[data-split]');
    expect(split()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Artifacts' })).toBeNull();
    act(() => { openTab(PLAN.record.id, FILE_KIND, README, { handed }); });
    const artifacts = screen.getByRole('region', { name: 'Artifacts' });
    expect(split()).not.toBeNull();
    // The rows of buttons that act as tabs, and under them the selected tab's body.
    expect(within(artifacts).getByRole('tablist', { name: 'Open items' })).toBeTruthy();
    expect(within(artifacts).getByRole('tab').textContent).toBe('// README.md×');
    expect(within(within(artifacts).getByRole('tabpanel')).getByRole('heading', { level: 1 }).textContent).toBe('Calamari');
    // After the chat among the landmarks; with a tab open the pane holds the right half and Done
    // stays over the chat, in its box and not in the band (C50; the maintainer).
    expect(landmarks(container)).toEqual([...STRIP, ...BAND, 'complementary: Projects', 'toolbar: Done, shelf and tags', 'main: Chat', 'region: Model', 'toolbar: Session actions', 'region: Artifacts']);
    expect(container.querySelector('[data-chat-window]')?.contains(done())).toBe(true);
    expect(screen.getByRole('region', { name: 'Session' }).parentElement?.contains(done())).toBe(false);
    // Two boxes, the handle in the gap between them (round 8; C79, C80).
    expect([...(split() as HTMLElement).children].map((child) => child.getAttribute('role') ?? child.getAttribute('aria-label') ?? child.tagName)).toEqual(['DIV', 'separator', 'Artifacts']);
    // No session selected: no split, and the tab is kept.
    act(() => selecting(null, 3));
    expect(split()).toBeNull();
    act(() => selecting(PLAN.record.id, 4));
    expect(within(screen.getByRole('region', { name: 'Artifacts' })).getByRole('tab').textContent).toBe('// README.md×');
    fireEvent.click(within(screen.getByRole('region', { name: 'Artifacts' })).getByRole('button', { name: 'Close README.md' }));
    expect(split()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Artifacts' })).toBeNull();
  });

  it('opens the first tab from a fresh start, the page’s kinds registered by the session window and by no test (C59, V14)', async () => {
    resetTabs();
    registerKinds([]);
    bridge.setInvoke((channel) => Promise.resolve({ ok: true, value: channel === 'files:read' ? handed : { status: 'saved' } }));
    selecting(PLAN.record.id);
    render(<Shell />);
    await act(async () => { expect(await openReference(PLAN.record.id, 'README.md', { local: true })).toBeNull(); });
    expect(useTabs.getState().sessions[PLAN.record.id]?.tabs.map((tab) => tab.kind)).toEqual([FILE_KIND]);
    expect(within(screen.getByRole('region', { name: 'Artifacts' })).getByRole('tab').textContent).toBe('// README.md×');
  });

  it('drops the tabs of a session no longer listed, while no tab is shown (C59, V14)', () => {
    const other = sessionEntry('Fix login', SUMMARIES.idle, { projectId: CALAMARI.id });
    selecting(null, 2, [PLAN, other]);
    render(<Shell />);
    act(() => { openTab(PLAN.record.id, FILE_KIND, README, { handed }); });
    act(() => { openTab(other.record.id, FILE_KIND, README, { handed }); });
    expect(screen.queryByRole('region', { name: 'Artifacts' })).toBeNull();
    act(() => selecting(null, 3, [other]));
    expect(Object.keys(useTabs.getState().sessions)).toEqual([other.record.id]);
  });

  // Round 8 (C78): the Sub-agents tab opens by itself, by its kind's watcher, which the session window draws.
  it('opens the Sub-agents tab, and so the pane, as soon as the selected session has a sub-agent', () => {
    selecting(PLAN.record.id);
    render(<Shell />);
    expect(screen.queryByRole('region', { name: 'Artifacts' })).toBeNull();
    act(() => selecting(PLAN.record.id, 3, [{ ...PLAN, summary: SUMMARIES.runningWorkers }]));
    const artifacts = screen.getByRole('region', { name: 'Artifacts' });
    // It cannot be closed (M106, C2): no ×.
    expect(within(artifacts).getByRole('tab').textContent).toBe('// Sub-agents');
    expect(within(artifacts).getByRole('group', { name: 'Sub-agents' }).querySelectorAll('[data-row]')).toHaveLength(2);
  });

  it('draws a chat without a session as one column: no Model region, no Done, no prompt area, no names (C44, V7)', () => {
    showState({ projects: [CALAMARI], sessions: [PLAN], selectedId: PLAN.record.id, conversations: { status: { kind: 'ok' }, detached: 1 } });
    const { container } = render(<Shell />);
    expect(screen.getByRole('region', { name: 'Model' })).toBeTruthy();
    act(() => showDetached({ id: '11111111-1111-4111-8111-111111111111', name: 'Plan the trip', createdAt: 1 }));
    expect(screen.queryByRole('region', { name: 'Model' })).toBeNull();
    expect(done()).toBeNull();
    const chat = screen.getByRole('main', { name: 'Chat' });
    expect(chat.querySelector('[data-detached-chat]')).not.toBeNull();
    expect(chat.querySelector('[data-prompt-area], textarea')).toBeNull();
    expect(container.querySelector('[data-detached]')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Session' }).textContent).toBe('');
  });
});

// Round 8 (C79, C80, V21): the chat window and the pane, two boxes; the gap between them a window
// splitter, by the pointer and by the keyboard, its share kept for the run.
describe('the gap between the chat and the pane (M100, C80)', () => {
  const README = 'D:\\Code\\Calamari\\README.md';
  const handed = { outcome: 'text', path: README, root: 'D:\\Code\\Calamari', view: 'markdown', text: '# Calamari\n', revision: null, line: null, column: null };
  const handle = () => screen.getByRole('separator', { name: SPLIT_LABEL });
  const own = () => document.querySelector<HTMLElement>('[data-split]') as HTMLElement;
  const shares = (element: HTMLElement) => [element.style.getPropertyValue('--chat-share'), element.style.getPropertyValue('--pane-share')];
  const value = () => handle().getAttribute('aria-valuenow');
  const STYLE: Readonly<Record<string, string>> = { '--gap-grid': '8px', '--split-chat-min': '400px', '--split-pane-min': '300px' };

  function open() {
    selecting(PLAN.record.id);
    render(<Shell />);
    act(() => { openTab(PLAN.record.id, FILE_KIND, README, { handed }); });
  }

  /** The window 1000 px wide from x = 100: 992 px for the two boxes, the chat's at least 400, the pane's 300. */
  function measured() {
    const target = own();
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 0, right: 1100, bottom: 600, width: 1000, height: 600, x: 100, y: 0, toJSON: () => ({}) });
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
      element === target ? ({ getPropertyValue: (name: string) => STYLE[name] ?? '' } as unknown as CSSStyleDeclaration) : original(element, pseudo));
  }

  afterEach(() => {
    resetSplit();
    vi.restoreAllMocks();
  });

  it('is a window splitter for the chat, at 60/40 to begin with, writing the two boxes’ shares', () => {
    open();
    expect(handle().getAttribute('aria-orientation')).toBe('vertical');
    expect(handle().tabIndex).toBe(0);
    expect(value()).toBe('60');
    expect(handle().getAttribute('aria-valuetext')).toBe('Chat 60%, pane 40%');
    // It names the chat's box, which it sizes.
    expect(document.getElementById(handle().getAttribute('aria-controls') ?? '')?.contains(screen.getByRole('main', { name: 'Chat' }))).toBe(true);
    expect(shares(own())).toEqual(['0.6fr', '0.4fr']);
  });

  it('moves by the keyboard: Left and Right a step, Home and End to either box’s least width, Enter back to the default split', () => {
    open();
    measured();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect([value(), shares(own())[0]]).toEqual(['65', '0.65fr']);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(value()).toBe('55');
    // 400 of 992 px, and 1 less 300 of them.
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(shares(own())[0]).toBe('0.403fr');
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(shares(own())[0]).toBe('0.698fr');
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(shares(own())[0]).toBe('0.698fr');
    fireEvent.keyDown(handle(), { key: 'Enter' });
    expect(value()).toBe('60');
  });

  it('follows a drag, writing the columns as it moves, no further than either box’s least width, and keeps the share when let go', () => {
    open();
    measured();
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 600 });
    expect(handle().hasAttribute('data-dragging')).toBe(true);
    // The middle of the gap at 700 px: 596 of the 992.
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 700 });
    expect(shares(own())).toEqual(['0.601fr', `${1 - 0.601}fr`]);
    // Kept in the page's store only when it is let go: nothing is drawn again while it moves.
    expect(value()).toBe('60');
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 1090 });
    expect(shares(own())[0]).toBe('0.698fr');
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 1090 });
    expect(value()).toBe('70');
    expect(handle().hasAttribute('data-dragging')).toBe(false);
    // A move with no press moves nothing.
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 300 });
    expect(shares(own())[0]).toBe('0.698fr');
  });

  it('goes back to the default split at a double-click', () => {
    open();
    measured();
    fireEvent.keyDown(handle(), { key: 'End' });
    fireEvent.doubleClick(handle());
    expect(value()).toBe('60');
  });

  it('keeps its share for the run, and gives the window its columns back while it is not split', () => {
    open();
    measured();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    const target = own();
    fireEvent.click(within(screen.getByRole('region', { name: 'Artifacts' })).getByRole('button', { name: 'Close README.md' }));
    expect(screen.queryByRole('separator')).toBeNull();
    expect(shares(target)).toEqual(['', '']);
    act(() => { openTab(PLAN.record.id, FILE_KIND, README, { handed }); });
    expect(value()).toBe('65');
    expect(shares(own())).toEqual(['0.65fr', `${1 - 0.65}fr`]);
  });
});

describe('the project column’s side (M11, C13, C26; M100, C9, C91)', () => {
  it('is on the left by default: Add project before the band, the list before the session window (round 11; C91)', () => {
    usePrefs.setState({ snapshot: withSide('left') });
    const { container } = render(<Shell />);
    expect(landmarks(container)).toEqual([...STRIP, ...BAND, 'complementary: Projects', 'main: Chat']);
    expect(container.querySelector('[data-project-column]')?.getAttribute('data-project-column')).toBe('left');
  });

  it('moves the project column’s two cells to the right: the band before Add project, the window before the list', () => {
    usePrefs.setState({ snapshot: withSide('right') });
    const { container } = render(<Shell />);
    expect(landmarks(container)).toEqual([...STRIP, ...BAND, 'main: Chat', 'complementary: Projects']);
    expect(container.querySelector('[data-project-column]')?.getAttribute('data-project-column')).toBe('right');
  });

  it('puts each row’s project cell first or last in the DOM, so keyboard order follows the side it is drawn on, and moves the parts without drawing them again', () => {
    selecting(null);
    usePrefs.setState({ snapshot: withSide('left') });
    const { container } = render(<Shell />);
    const body = container.querySelector('[data-project-column]') as HTMLElement;
    const add = () => screen.getByRole('button', { name: 'Add project' }).parentElement;
    const chat = screen.getByRole('main', { name: 'Chat' });
    expect([...body.children].indexOf(add() as HTMLElement)).toBe(0);
    expect(body.children[2]?.getAttribute('aria-label')).toBe('Projects');

    act(() => usePrefs.setState({ snapshot: prefsSnapshot({ layout: { projectColumn: 'right' } }, { kind: 'ok' }, 2) }));
    expect([...body.children].indexOf(add() as HTMLElement)).toBe(1);
    expect(body.lastElementChild?.getAttribute('aria-label')).toBe('Projects');
    expect(body.firstElementChild?.querySelector('[aria-label="Usage"]')).not.toBeNull();
    // The same chat, moved rather than drawn again.
    expect(screen.getByRole('main', { name: 'Chat' })).toBe(chat);
  });

  it.each([
    ['before preferences arrive', null],
    ['with read-only preferences, which give the defaults', prefsSnapshot({}, { kind: 'read-only', reason: 'incompatible', fileVersion: 2, minReaderVersion: 2 })],
  ])('is on the left %s (C10, C91)', (_when, snapshot) => {
    usePrefs.setState({ snapshot });
    const { container } = render(<Shell />);
    expect(container.querySelector('[data-project-column]')?.getAttribute('data-project-column')).toBe('left');
  });
});
