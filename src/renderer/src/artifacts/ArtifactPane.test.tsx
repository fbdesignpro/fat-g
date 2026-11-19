// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8 (docs/planning/_archive/M19b.md; C3–C6, C9, C10, C13): the artifact pane, with a kind of tab defined
// outside its folder. The pane names no kind: it is given this one in one line.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetachedConversation } from '@shared/contracts/conversation';
import type { SessionEntry } from '@shared/contracts/sessions';
import { EXAMPLE_KIND, exampleKind, noteMounts, PINNED_KIND, pinnedKind } from '../../../../tests/support/example-kind';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { showDetached } from '../chat/detached-store';
import { installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { PaneWithKinds } from '../test/pane';
import { closeLabel, TABS_LABEL } from './TabList';
import { openTab, resetTabs, useTabs } from './tabs-store';

const P = project('Calamari');
const ONE = sessionEntry('Create plan', SUMMARIES.idle, { projectId: P.id });
const TWO = sessionEntry('Fix bug', SUMMARIES.idle, { projectId: P.id });
const KINDS = [exampleKind, pinnedKind];
const DETACHED: DetachedConversation = { id: '5e551000-0000-4000-8000-0000000000dd', name: 'An old chat', createdAt: 1 };

let bridge: ReturnType<typeof installFakeBridge>;
beforeEach(() => {
  bridge = installFakeBridge();
  resetTabs();
  noteMounts.clear();
  showDetached(null);
});
afterEach(cleanup);

const show = (sessions: SessionEntry[], selectedId: string | null, detached = 0) =>
  act(() => { showState({ projects: [P], sessions, selectedId, ...(detached === 0 ? {} : { conversations: { status: { kind: 'ok' as const }, detached } }) }); });
const open = (session: SessionEntry, note: string, topic?: string) => act(() => { openTab(session.record.id, EXAMPLE_KIND, topic === undefined ? { note } : { note, topic }); });
const list = () => screen.getByRole('tablist', { name: TABS_LABEL });
const tabText = (tab: Element | undefined) => tab === undefined ? undefined : `${tab.querySelector('[data-tab-title]')?.textContent ?? ''}${tab.querySelector('button')?.textContent ?? ''}`;
const tabNames = () => within(list()).getAllByRole('tab').map(tabText);
const selectedTab = () => within(list()).getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');
const panel = () => screen.getByRole('tabpanel');
const pane = (container: HTMLElement) => container.querySelector('[data-artifact-pane]');

describe('the pane (C3, C4, C6)', () => {
  it('lets a kind remove the frame and restores it when a framed tab is selected', () => {
    const bare = { ...exampleKind, id: 'example-bare', framed: false };
    render(<PaneWithKinds kinds={[...KINDS, bare]} />);
    show([ONE], ONE.record.id);
    act(() => { openTab(ONE.record.id, bare.id, { note: 'bare' }); });
    expect(panel().getAttribute('data-frameless')).toBe('');
    open(ONE, 'framed');
    expect(panel().hasAttribute('data-frameless')).toBe(false);
    act(() => { openTab(ONE.record.id, bare.id, { note: 'bare' }); });
    expect(panel().getAttribute('data-frameless')).toBe('');
  });

  it('shows nothing with no tab, with no session, and with a session that has none', () => {
    const { container } = render(<PaneWithKinds kinds={KINDS} />);
    expect(container.innerHTML).toBe('');
    show([ONE], null);
    expect(container.innerHTML).toBe('');
    show([ONE], ONE.record.id);
    expect(container.innerHTML).toBe('');
  });

  it('draws a kind defined outside its folder, given in one line: its tab among the rows, its body under them', () => {
    const { container } = render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    open(ONE, 'a');
    expect(pane(container)?.getAttribute('data-artifact-pane')).toBe(ONE.record.id);
    expect(tabNames()).toEqual(['Note a×']);
    expect(within(panel()).getByText('Note a')).toBeTruthy();
    expect(panel().querySelector('[data-example-note="a"]')?.getAttribute('data-note-session')).toBe(ONE.record.id);
    // The rows come first, the body under them.
    expect([...(pane(container)?.children ?? [])].map((child) => child.getAttribute('role'))).toEqual(['tablist', 'tabpanel']);
  });

  it('shows each session its own tabs and its own selected tab, again when it is selected again', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE, TWO], ONE.record.id);
    open(ONE, 'a');
    open(ONE, 'b');
    fireEvent.click(within(list()).getAllByRole('tab')[0] as Element);
    show([ONE, TWO], TWO.record.id);
    expect(screen.queryByRole('tablist')).toBeNull();
    open(TWO, 'c');
    expect([tabNames(), tabText(selectedTab())]).toEqual([['Note c×'], 'Note c×']);
    show([ONE, TWO], ONE.record.id);
    expect([tabNames(), tabText(selectedTab())]).toEqual([['Note a×', 'Note b×'], 'Note a×']);
    expect(panel().querySelector('[data-example-note]')?.getAttribute('data-example-note')).toBe('a');
  });

  it('shows nothing while no session is selected or a chat without a session is shown, and keeps every session’s tabs', () => {
    const { container } = render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    open(ONE, 'a');
    show([ONE], null);
    expect(container.innerHTML).toBe('');
    show([ONE], ONE.record.id, 1);
    expect(tabNames()).toEqual(['Note a×']);
    // A chat without a session takes the chat region: the pane shows nothing beside it.
    act(() => { showDetached(DETACHED); });
    expect(container.innerHTML).toBe('');
    expect(useTabs.getState().sessions[ONE.record.id]?.tabs).toHaveLength(1);
    act(() => { showDetached(null); });
    expect(tabNames()).toEqual(['Note a×']);
  });

  it('takes a removed session’s tabs with it, and leaves the others’', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE, TWO], ONE.record.id);
    open(ONE, 'a');
    open(TWO, 'b');
    show([TWO], TWO.record.id);
    expect(Object.keys(useTabs.getState().sessions)).toEqual([TWO.record.id]);
    expect(tabNames()).toEqual(['Note b×']);
  });

  it('asks main for nothing of its own: opening, selecting and closing tabs are the page’s', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    open(ONE, 'a');
    open(ONE, 'b');
    fireEvent.click(within(list()).getAllByRole('tab')[0] as Element);
    fireEvent.click(screen.getByRole('button', { name: closeLabel('Note b') }));
    expect(bridge.calls).toEqual([]);
  });
});

describe('a tab its kind keeps open (M106, V6; C2)', () => {
  it('draws no ×, and neither a middle click nor Delete closes it, while a tab beside it closes as before', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    act(() => { openTab(ONE.record.id, PINNED_KIND, 'stack', { first: true }); });
    open(ONE, 'a');
    expect(tabNames()).toEqual(['Pinned stack', 'Note a×']);
    expect(screen.queryByRole('button', { name: closeLabel('Pinned stack') })).toBeNull();
    const pinned = within(list()).getAllByRole('tab')[0] as HTMLElement;
    fireEvent(pinned, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    pinned.focus();
    fireEvent.keyDown(pinned, { key: 'Delete' });
    expect(tabNames()).toEqual(['Pinned stack', 'Note a×']);
    fireEvent.click(screen.getByRole('button', { name: closeLabel('Note a') }));
    expect([tabNames(), tabText(selectedTab())]).toEqual([['Pinned stack'], 'Pinned stack']);
    // Its session gone, it goes.
    show([TWO], TWO.record.id);
    expect(useTabs.getState().sessions[ONE.record.id]).toBeUndefined();
  });
});

describe('a tab’s button (C8–C10)', () => {
  it('puts a new tab last and selects it; opening what is open selects it', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    for (const note of ['a', 'b', 'c']) open(ONE, note);
    expect([tabNames(), tabText(selectedTab())]).toEqual([['Note a×', 'Note b×', 'Note c×'], 'Note c×']);
    open(ONE, 'a');
    expect([tabNames(), tabText(selectedTab())]).toEqual([['Note a×', 'Note b×', 'Note c×'], 'Note a×']);
  });

  it('closes by its ×, selecting the next tab, else the one before', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    for (const note of ['a', 'b', 'c']) open(ONE, note);
    fireEvent.click(within(list()).getAllByRole('tab')[1] as Element);
    fireEvent.click(screen.getByRole('button', { name: closeLabel('Note b') }));
    expect([tabNames(), tabText(selectedTab())]).toEqual([['Note a×', 'Note c×'], 'Note c×']);
    fireEvent.click(screen.getByRole('button', { name: closeLabel('Note c') }));
    expect([tabNames(), tabText(selectedTab())]).toEqual([['Note a×'], 'Note a×']);
    fireEvent.click(screen.getByRole('button', { name: closeLabel('Note a') }));
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('closes by a middle click, asks nothing, and does not select the tab it closes', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    for (const note of ['a', 'b']) open(ONE, note);
    const first = within(list()).getAllByRole('tab')[0] as Element;
    fireEvent(first, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect([tabNames(), tabText(selectedTab())]).toEqual([['Note b×'], 'Note b×']);
    expect(screen.queryByRole('dialog')).toBeNull();
    // Another button of the mouse closes nothing.
    fireEvent(within(list()).getAllByRole('tab')[0] as Element, new MouseEvent('auxclick', { bubbles: true, button: 2 }));
    expect(tabNames()).toEqual(['Note b×']);
  });

  it('shows a long title cut in its button and whole in its tooltip', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    const long = 'a-note-with-a-very-long-name-that-no-tab-of-280-px-could-hold.md';
    open(ONE, long);
    const tab = within(list()).getByRole('tab');
    expect(tab.getAttribute('title')).toBe(`Note ${long}`);
    // The title is one element, which the stylesheet cuts with an ellipsis (tests/architecture/styles.test.ts).
    expect(tab.querySelector('[data-tab-title]')?.textContent).toBe(`Note ${long}`);
    expect(tab.querySelector('[data-tab-title]')?.tagName).toBe('SPAN');
  });

  it('asks each tab’s title again when the session’s tabs change', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    open(ONE, 'a', 'tides');
    expect(tabNames()).toEqual(['Note a×']);
    open(ONE, 'b', 'tides');
    expect(tabNames()).toEqual(['Note a (tides)×', 'Note b (tides)×']);
    fireEvent.click(screen.getByRole('button', { name: closeLabel('Note b (tides)') }));
    expect(tabNames()).toEqual(['Note a×']);
  });
});

describe('a tab’s body (C5)', () => {
  it('changes its title and what it shows while it is shown, and holds an input', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    open(ONE, 'a');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Add a line' }));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Add a line' }));
    expect(within(panel()).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['line 1', 'line 2']);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Rename' }));
    expect(tabNames()).toEqual(['Renamed a×']);
    expect(screen.getByRole('button', { name: closeLabel('Renamed a') })).toBeTruthy();
    const input = within(panel()).getByLabelText('Follow-up');
    fireEvent.change(input, { target: { value: 'and then?' } });
    expect(within(panel()).getByLabelText<HTMLInputElement>('Follow-up').value).toBe('and then?');
  });

  it('draws only the selected tab’s body, and has a tab’s view state when it is shown again', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE], ONE.record.id);
    open(ONE, 'a');
    fireEvent.change(within(panel()).getByLabelText('Follow-up'), { target: { value: 'kept by the pane' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Add a line' }));
    open(ONE, 'b');
    expect([...document.querySelectorAll('[data-example-note]')].map((body) => body.getAttribute('data-example-note'))).toEqual(['b']);
    expect(within(panel()).getByLabelText<HTMLInputElement>('Follow-up').value).toBe('');
    fireEvent.click(within(list()).getAllByRole('tab')[0] as Element);
    // Shown again: mounted again, with the view state the pane kept — and none of what the body kept itself.
    expect([...document.querySelectorAll('[data-example-note]')].map((body) => body.getAttribute('data-example-note'))).toEqual(['a']);
    expect(within(panel()).getByLabelText<HTMLInputElement>('Follow-up').value).toBe('kept by the pane');
    expect(within(panel()).queryAllByRole('listitem')).toEqual([]);
    expect(noteMounts.get('a')).toBe(2);
    expect(noteMounts.get('b')).toBe(1);
  });

  it('gives another session’s tab of the same reference a body of its own', () => {
    render(<PaneWithKinds kinds={KINDS} />);
    show([ONE, TWO], ONE.record.id);
    open(ONE, 'a');
    open(TWO, 'a');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Add a line' }));
    show([ONE, TWO], TWO.record.id);
    expect(panel().querySelector('[data-example-note]')?.getAttribute('data-note-session')).toBe(TWO.record.id);
    expect(within(panel()).queryAllByRole('listitem')).toEqual([]);
  });
});
