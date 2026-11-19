// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9 (docs/planning/_archive/M19b.md; C9, C11, C12): the rows of buttons by the keyboard, their roles and
// states, and the selected button brought into view by the list's own scroll position.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_KIND, exampleKind } from '../../../../tests/support/example-kind';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { showDetached } from '../chat/detached-store';
import { installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { PaneWithKinds } from '../test/pane';
import { closeLabel, TABS_LABEL } from './TabList';
import { openTab, resetTabs } from './tabs-store';

const P = project('Calamari');
const ONE = sessionEntry('Create plan', SUMMARIES.idle, { projectId: P.id });

beforeEach(() => {
  installFakeBridge();
  resetTabs();
  showDetached(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(notes: readonly string[]) {
  const view = render(<><button type="button">Before</button><PaneWithKinds kinds={[exampleKind]} /><button type="button">After</button></>);
  act(() => { showState({ projects: [P], sessions: [ONE], selectedId: ONE.record.id }); });
  for (const note of notes) act(() => { openTab(ONE.record.id, EXAMPLE_KIND, { note }); });
  return view;
}
const list = () => screen.getByRole('tablist', { name: TABS_LABEL });
const tabs = () => within(list()).getAllByRole('tab');
const titleOf = (element: Element | null | undefined) => element?.querySelector('[data-tab-title]')?.textContent;
const tab = (note: string) => within(list()).getByTitle(`Note ${note}`);
const names = () => tabs().map(titleOf);
const selected = () => titleOf(tabs().find((element) => element.getAttribute('aria-selected') === 'true'));
const focused = () => titleOf(document.activeElement);
const key = (name: string, target: Element = document.activeElement as Element, init: KeyboardEventInit = {}) => fireEvent.keyDown(target, { key: name, ...init });
/** The elements Tab would stop at, in order: what has a tab index of zero or is a control without one. */
const stops = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex]')].filter((element) => element.tabIndex === 0);

describe('the tab list’s roles and states (C11)', () => {
  it('is a tab list named for what it holds, its tabs and its body carrying a tab list’s roles', () => {
    setup(['a', 'b', 'c']);
    expect(list().getAttribute('aria-label')).toBe('Open items');
    const panel = screen.getByRole('tabpanel');
    for (const element of tabs()) {
      expect(element.getAttribute('aria-controls')).toBe(panel.id);
      expect(['true', 'false']).toContain(element.getAttribute('aria-selected'));
      expect(element.id).not.toBe('');
    }
    expect(tabs().filter((element) => element.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    // The body is named by the tab it shows.
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('c').id);
    fireEvent.click(tab('a'));
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab('a').id);
    expect(new Set(tabs().map((element) => element.id)).size).toBe(3);
  });

  it('makes a tab no button, so that its × is no control inside another', () => {
    setup(['a']);
    expect(tab('a').tagName).toBe('DIV');
    const close = screen.getByRole('button', { name: closeLabel('Note a') });
    expect(tab('a').contains(close)).toBe(true);
    expect(close.closest('button:not([aria-label])')).toBeNull();
    expect(tab('a').querySelectorAll('button')).toHaveLength(1);
  });

  it('prefixes the visible title without adding the decoration to accessible names or tooltips', () => {
    setup(['a']);
    const element = within(list()).getByRole('tab', { name: 'Note a ×' });
    expect(element.textContent).toBe('// Note a×');
    expect(element.querySelector('[aria-hidden="true"]')?.textContent).toBe('// ');
    expect(element.getAttribute('title')).toBe('Note a');
    expect(screen.getByRole('tabpanel', { name: 'Note a ×' })).toBeTruthy();
  });
});

describe('the tab list by the keyboard (C11)', () => {
  it('is one stop: the selected tab, and no × is a stop of its own', () => {
    setup(['a', 'b', 'c']);
    expect(stops(list()).map(titleOf)).toEqual(['Note c']);
    expect(tabs().map((element) => element.tabIndex)).toEqual([-1, -1, 0]);
    for (const close of within(list()).getAllByRole('button')) expect(close.tabIndex).toBe(-1);
  });

  it('moves among the tabs with Left and Right, Home and End, and selects none of them', () => {
    setup(['a', 'b', 'c', 'd']);
    act(() => { tab('d').focus(); });
    key('ArrowLeft');
    expect(focused()).toBe('Note c');
    key('ArrowLeft');
    key('ArrowLeft');
    expect(focused()).toBe('Note a');
    // It stops at each end.
    key('ArrowLeft');
    expect(focused()).toBe('Note a');
    key('End');
    expect(focused()).toBe('Note d');
    key('ArrowRight');
    expect(focused()).toBe('Note d');
    key('Home');
    expect(focused()).toBe('Note a');
    key('ArrowRight');
    expect(focused()).toBe('Note b');
    // Moving read no tab: the selected one is the one it was.
    expect(selected()).toBe('Note d');
    expect(document.querySelector('[data-example-note]')?.getAttribute('data-example-note')).toBe('d');
  });

  it('keeps the list one stop as the keyboard moves: the tab that last held it', () => {
    setup(['a', 'b', 'c']);
    act(() => { tab('c').focus(); });
    key('Home');
    expect(tabs().map((element) => element.tabIndex)).toEqual([0, -1, -1]);
    expect(stops(list())).toHaveLength(1);
  });

  it.each([['Enter', 'Enter'], ['Space', ' ']])('selects the tab that holds the keyboard with %s', (_name, pressed) => {
    setup(['a', 'b', 'c']);
    act(() => { tab('c').focus(); });
    key('Home');
    expect(selected()).toBe('Note c');
    key(pressed);
    expect(selected()).toBe('Note a');
    expect(document.querySelector('[data-example-note]')?.getAttribute('data-example-note')).toBe('a');
    // The keyboard stays in the list.
    expect(focused()).toBe('Note a');
  });

  it('closes the tab that holds the keyboard with Delete, and gives the keyboard to the one that takes its place', () => {
    setup(['a', 'b', 'c']);
    act(() => { tab('c').focus(); });
    key('ArrowLeft');
    key('Delete');
    expect(names()).toEqual(['Note a', 'Note c']);
    expect(focused()).toBe('Note c');
    key('Delete');
    // The last of the row: the one before it.
    expect(names()).toEqual(['Note a']);
    expect(focused()).toBe('Note a');
    key('Delete');
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('leaves a key with a modifier, and a key pressed on the ×, to what they were', () => {
    setup(['a', 'b']);
    act(() => { tab('b').focus(); });
    key('ArrowLeft', tab('b'), { altKey: true });
    key('Delete', tab('b'), { ctrlKey: true });
    key('Home', tab('b'), { shiftKey: true });
    expect([names(), focused()]).toEqual([['Note a', 'Note b'], 'Note b']);
    key('Delete', screen.getByRole('button', { name: closeLabel('Note a') }));
    expect(names()).toEqual(['Note a', 'Note b']);
  });

  it('lets Tab go on from the list into the body, whose stops are its kind’s', () => {
    const { container } = setup(['a', 'b']);
    // In document order: what comes before, the list's one tab, the body's own controls, what comes after.
    expect(stops(container).map((element) => titleOf(element) ?? (element.textContent || element.tagName))).toEqual(['Before', 'Note b', 'INPUT', 'Add a line', 'Rename', 'After']);
    const panel = screen.getByRole('tabpanel');
    expect(list().compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the rows (C9, C12)', () => {
  /** A layout: each tab is 24 px high, at the top its place in the list gives, and the list shows 80 px. */
  function withRows(tops: Readonly<Record<string, number>>): void {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) { return tops[titleOf(this) ?? ''] ?? 0; });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(24);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(80);
  }

  it('brings the selected tab’s button into view by the list’s own scroll position, down and up', () => {
    withRows({ 'Note a': 8, 'Note b': 36, 'Note c': 64, 'Note d': 92, 'Note e': 120 });
    setup(['a', 'b', 'c', 'd', 'e']);
    // The fifth row's button ends at 144: the list shows 80, so it scrolls to 64.
    expect(list().scrollTop).toBe(64);
    fireEvent.click(tab('a'));
    expect(list().scrollTop).toBe(8);
    // One that is in view moves nothing.
    fireEvent.click(tab('b'));
    expect(list().scrollTop).toBe(8);
  });

  it('never asks the page to scroll a tab into view: nothing outside the list moves', () => {
    const into = vi.fn();
    Element.prototype.scrollIntoView = into;
    withRows({ 'Note a': 8, 'Note b': 200 });
    setup(['a', 'b']);
    fireEvent.click(tab('a'));
    expect(into).not.toHaveBeenCalled();
  });

  it('moves no focus when a tab is opened or selected from elsewhere', () => {
    setup(['a']);
    const before = screen.getByRole('button', { name: 'Before' });
    act(() => { before.focus(); });
    act(() => { openTab(ONE.record.id, EXAMPLE_KIND, { note: 'b' }); });
    act(() => { openTab(ONE.record.id, EXAMPLE_KIND, { note: 'a' }); });
    expect(document.activeElement).toBe(before);
  });
});
