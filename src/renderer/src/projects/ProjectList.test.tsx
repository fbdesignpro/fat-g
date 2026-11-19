// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/require-await */
// The project list (docs/planning/_archive/M12.md, Verification V11, V12, V18, V19, V21, V22).
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvokeChannel } from '@shared/ipc/channels';
import type { ProjectEntryView, RecordsRefusalCause } from '@shared/contracts/projects';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { useAppState } from '../state/store';
import { Announcer } from '../ui/Announcer';
import { installDialogStandIn } from '../test/dialog';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { project, recordsState, unreadable, withRecords } from '../test/records';
import { showState } from '../test/sessions';
import { closeProjectDialog, useProjectDialog } from './project-dialog-store';
import { ProjectList } from './ProjectList';
import type { MeasureList } from './useProjectDrag';

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
let answer: (channel: InvokeChannel, request: unknown) => unknown;

beforeAll(installDialogStandIn);
beforeEach(() => {
  bridge = installFakeBridge();
  requests = [];
  answer = () => ({ status: 'saved' });
  bridge.setInvoke(async (channel, request) => {
    requests.push([channel, request]);
    return { ok: true, value: answer(channel, request) };
  });
  closeProjectDialog();
  useProjectDialog.setState({ added: null });
});
afterEach(cleanup);

const ROW = 36;
const LIST_TOP = 40;
/** jsdom computes no layout: every row is 36 px, in DOM order, below a 40 px Add row. */
const measure: MeasureList = (list) => {
  let y = 0;
  const entries: ReturnType<MeasureList>['entries'][number][] = [];
  let hiddenRow: ReturnType<MeasureList>['hiddenRow'] = null;
  for (const element of list.querySelectorAll<HTMLElement>('[data-entry-key], [data-hidden-row]')) {
    if (element.hasAttribute('data-hidden-row')) hiddenRow = { top: y, bottom: y + ROW };
    else entries.push({ key: element.dataset['entryKey'] ?? '', group: element.dataset['group'] === 'hidden' ? 'hidden' : 'visible', top: y, bottom: y + ROW });
    y += ROW;
  }
  return { column: { top: 0, bottom: 400, left: 0, right: 320 }, listTop: LIST_TOP, entries, hiddenRow };
};

function Harness() {
  const column = useRef<HTMLElement>(null);
  return (
    <>
      <aside ref={column} aria-label="Projects">
        <ProjectList column={column} measure={measure} />
      </aside>
      <Announcer />
    </>
  );
}

const show = (projects: readonly ProjectEntryView[], seq = 1) => useAppState.setState({ snapshot: withRecords(recordsState(projects), seq), error: null });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const column = () => screen.getByRole('complementary', { name: 'Projects' });
const actions = (name: string) => screen.getByRole('button', { name: `Actions for ${name}` });
const headerOf = (name: string) => screen.getByRole('heading', { name }).parentElement as HTMLElement;
const openMenuOf = (name: string) => {
  fireEvent.click(actions(name));
  return screen.getByRole('menu', { name: `Actions for ${name}` });
};

const A = project('fat-g');
const B = project('website', { color: 'blue' });
const C = project('notes', { color: 'pink' });
const H1 = project('old-experiment', { hidden: true, color: 'grey' });
const H2 = project('archive', { hidden: true, color: 'green' });

describe('project folds', () => {
  const live = sessionEntry('Active chat', SUMMARIES.idle, { projectId: A.id });
  const done = sessionEntry('Finished chat', SUMMARIES.idle, { projectId: A.id, completedAt: 100 });
  const unfold = () => screen.getByRole('button', { name: A.name });

  function followFolds(projects: readonly ProjectEntryView[] = [A, B]) {
    let current = projects;
    showState({ projects: current, sessions: [live, done], selectedId: live.record.id });
    answer = (channel, request) => {
      if (channel === 'projects:setCollapsed') {
        const { id, collapsed } = request as { id: string; collapsed: boolean };
        current = current.map((entry) => entry.kind === 'project' && entry.id === id ? { ...entry, collapsed } : entry);
        showState({ projects: current, sessions: [live, done], selectedId: live.record.id });
      }
      return { status: 'saved' };
    };
  }

  it('folds the whole session area from either the arrow or the name and keeps other headers available', async () => {
    followFolds();
    render(<Harness />);
    const button = unfold();
    const body = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(body?.hidden).toBe(false);
    await act(async () => { fireEvent.click(button.querySelector('svg') as SVGElement); await flush(); });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(body?.hidden).toBe(true);
    expect(screen.queryByRole('list', { name: `Active sessions of ${A.name}` })).toBeNull();
    expect(screen.queryByRole('button', { name: '1 completed' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New session in fat-g' })).toBeTruthy();
    expect(actions(A.name)).toBeTruthy();
    expect(screen.getByRole('button', { name: B.name }).getAttribute('aria-expanded')).toBe('true');
    expect(useAppState.getState().snapshot?.sessions?.selectedId).toBe(live.record.id);
    await act(async () => { fireEvent.click(within(button).getByText(A.name)); await flush(); });
    expect(body?.hidden).toBe(false);
    expect(requests).toEqual([
      ['projects:setCollapsed', { id: A.id, collapsed: true }],
      ['projects:setCollapsed', { id: A.id, collapsed: false }],
    ]);
  });

  it('keeps completed sessions mounted with their fold state through collapse and reopening', async () => {
    followFolds();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '1 completed' }));
    const completed = screen.getByRole('list', { name: `Completed sessions of ${A.name}` });
    await act(async () => { fireEvent.click(unfold()); await flush(); });
    expect(completed.isConnected).toBe(true);
    expect(screen.queryByRole('list', { name: `Completed sessions of ${A.name}` })).toBeNull();
    await act(async () => { fireEvent.click(unfold()); await flush(); });
    expect(screen.getByRole('list', { name: `Completed sessions of ${A.name}` })).toBe(completed);
  });

  it('restores saved folds at mount, including hidden projects, and gives unreadable entries no disclosure', () => {
    show([project(A.name, { collapsed: true }), project(H1.name, { hidden: true, collapsed: true }), unreadable('bad')]);
    render(<Harness />);
    expect(unfold().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '1 hidden project' }));
    expect(screen.getByRole('button', { name: H1.name }).getAttribute('aria-expanded')).toBe('false');
    expect(within(headerOf('Unreadable project')).getAllByRole('button')).toHaveLength(1);
  });

  it('keeps the saved fold and displays the usual notice when a write fails', async () => {
    followFolds();
    answer = () => ({ status: 'refused', reason: 'storage-failed' });
    render(<Harness />);
    await act(async () => { fireEvent.click(unfold()); await flush(); });
    expect(unfold().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('could not save the change');
    expect(unfold().getAttribute('aria-disabled')).toBeNull();
  });

  it('ignores repeated activation while a fold write is pending and keeps the keyboard stop', async () => {
    followFolds();
    let release!: (value: { ok: true; value: { status: 'saved' } }) => void;
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      return new Promise((resolve) => { release = resolve; });
    });
    render(<Harness />);
    const button = unfold();
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(requests).toHaveLength(1);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    await act(async () => { release({ ok: true, value: { status: 'saved' } }); await flush(); });
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });
});

// ── V11 ───────────────────────────────────────────────────────────────────────────────────
describe('the list (V11)', () => {
  it('shows nothing before the first state arrives', () => {
    useAppState.setState({ snapshot: null });
    render(<Harness />);
    expect(column().textContent).toBe('');
  });

  // M100 (C20, V4): Add project stands in the top band, over the list, and scrolls with nothing (src/renderer/src/shell/Shell.test.tsx).
  it('shows nothing with no project: Add project is no part of the list (C50; M100, C20)', () => {
    show([]);
    render(<Harness />);
    expect(within(column()).queryAllByRole('button')).toEqual([]);
    expect(within(column()).queryAllByRole('heading')).toEqual([]);
    cleanup();
    show([A, B]);
    render(<Harness />);
    expect(within(column()).queryByRole('button', { name: 'Add project' })).toBeNull();
  });

  // M100 (C22, C23, V4): the colour is drawn nowhere for now — every header is the bar pair — and kept as the header's attribute.
  it('draws each header with its name, visible projects first in stored order, keeping its colour as an attribute alone (C42, C47; M100, C23)', () => {
    show([A, H1, B, C]);
    render(<Harness />);
    expect(within(column()).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['fat-g', 'website', 'notes']);
    expect(headerOf('fat-g').getAttribute('data-color')).toBe('teal');
    expect(headerOf('website').getAttribute('data-color')).toBe('blue');
    // One class for every header, whatever its colour, and no colour set inline.
    expect(headerOf('fat-g').className).toBe(headerOf('website').className);
    expect([headerOf('fat-g').getAttribute('style'), headerOf('website').getAttribute('style')]).toEqual([null, null]);
  });

  it('shows a colour this build does not know as grey (C12)', () => {
    show([project('future', { color: null })]);
    render(<Harness />);
    expect(headerOf('future').getAttribute('data-color')).toBe('grey');
  });

  it('keeps a long name whole in the DOM and in its accessible names (C43)', () => {
    const long = `A project with a very long name that will not fit in the header ${'x'.repeat(20)}`;
    show([project(long)]);
    render(<Harness />);
    expect(screen.getByRole('heading', { name: long }).textContent).toBe(long);
    expect(actions(long)).toBeTruthy();
  });

  it('marks a header when a folder is missing, with a text alternative (C28)', () => {
    show([A, project('gone', { roots: [{ path: 'E:\\gone', trust: 'trusted', missing: true }] })]);
    render(<Harness />);
    expect(within(headerOf('gone')).getByRole('img', { name: 'A folder is missing' })).toBeTruthy();
    expect(within(headerOf('fat-g')).queryByRole('img')).toBeNull();
  });

  // M14 lifted M12's C46: a header now has its `+`, before the `…` (M14, C54). Still no Move buttons.
  it('has a + before the …, and no Move buttons on a header (M14, C54; C68)', () => {
    show([A, B]);
    render(<Harness />);
    expect(within(headerOf('fat-g')).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['fat-g', 'New session in fat-g', 'Actions for fat-g']);
    expect(screen.queryByRole('button', { name: /move/i })).toBeNull();
  });

  it('shows no session, and no row of sessions without a project, before any exists (M14, C37, C107)', () => {
    show([A, B]);
    render(<Harness />);
    expect(column().querySelectorAll('[data-session-id], [data-thin-session], [data-toggle-row], [data-orphan-row]')).toHaveLength(0);
  });

  it('counts the hidden projects in a row that opens and closes their list, closed at first (C47, C48)', () => {
    show([A, H1, H2]);
    render(<Harness />);
    const row = screen.getByRole('button', { name: '2 hidden projects' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('heading', { name: 'archive' })).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(within(screen.getByRole('list', { name: 'Hidden projects' })).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['old-experiment', 'archive']);
    fireEvent.click(row);
    expect(screen.queryByRole('list', { name: 'Hidden projects' })).toBeNull();
  });

  it('says 1 hidden project, and shows no row with none hidden', () => {
    show([A, H1]);
    const { unmount } = render(<Harness />);
    expect(screen.getByRole('button', { name: '1 hidden project' })).toBeTruthy();
    unmount();
    show([A], 2);
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /hidden project/ })).toBeNull();
  });

  it('puts a new project at the end, and brings it into view once the state holds it (C49)', () => {
    show([A, B]);
    render(<Harness />);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const added = project('brand-new');
    act(() => useProjectDialog.setState({ added: added.id }));
    expect(scrolled).not.toHaveBeenCalled();
    act(() => show([A, B, added], 2));
    expect(within(column()).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['fat-g', 'website', 'brand-new']);
    expect(scrolled).toHaveBeenCalledOnce();
    expect(useProjectDialog.getState().added).toBeNull();
  });
});

describe('the … menu (C40, C44)', () => {
  it('is operated like the application menu', () => {
    show([A]);
    render(<Harness />);
    fireEvent.keyDown(actions('fat-g'), { key: 'ArrowDown' });
    const menu = screen.getByRole('menu', { name: 'Actions for fat-g' });
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Edit', 'Hide', 'Remove']);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(actions('fat-g'));
  });

  it('closes when the column scrolls', () => {
    show([A]);
    render(<Harness />);
    openMenuOf('fat-g');
    fireEvent.scroll(column());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the project dialog at the project from Edit', () => {
    show([A]);
    render(<Harness />);
    fireEvent.click(within(openMenuOf('fat-g')).getByRole('menuitem', { name: 'Edit' }));
    expect(useProjectDialog.getState()).toMatchObject({ open: true, projectId: A.id });
    expect(requests).toEqual([]);
  });

  it('hides a visible project, and shows a hidden one', async () => {
    show([A, H1]);
    render(<Harness />);
    const hide = within(openMenuOf('fat-g')).getByRole('menuitem', { name: 'Hide' });
    await act(async () => {
      fireEvent.click(hide);
      await flush();
    });
    fireEvent.click(screen.getByRole('button', { name: '1 hidden project' }));
    const showItem = within(openMenuOf('old-experiment')).getByRole('menuitem', { name: 'Show' });
    await act(async () => {
      fireEvent.click(showItem);
      await flush();
    });
    expect(requests).toEqual([
      ['projects:setHidden', { id: A.id, hidden: true }],
      ['projects:setHidden', { id: H1.id, hidden: false }],
    ]);
  });

  it('says so under the Add row when a change fails, and that nothing was changed', async () => {
    show([A]);
    bridge.setInvoke(async () => ({ ok: false, error: 'internal' }));
    render(<Harness />);
    const hide = within(openMenuOf('fat-g')).getByRole('menuitem', { name: 'Hide' });
    await act(async () => {
      fireEvent.click(hide);
      await flush();
    });
    expect(screen.getByRole('status').textContent).toBe('fat-g could not save the change, and nothing was changed.');
  });
});

// ── V12 and V19 ───────────────────────────────────────────────────────────────────────────
describe('Remove (V12, V19)', () => {
  const confirmation = (name: string) => screen.getByRole('dialog', { name: `Remove ${name}?` });

  it('asks first, naming the project and saying what is kept, with Cancel focused (C41)', () => {
    show([A]);
    render(<Harness />);
    fireEvent.click(within(openMenuOf('fat-g')).getByRole('menuitem', { name: 'Remove' }));
    const dialog = confirmation('fat-g');
    expect(dialog.textContent).toContain('fat-g forgets this project. Nothing in its folders, and nothing in the providers’ history, is touched.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests).toEqual([]);
    expect(document.activeElement).toBe(actions('fat-g'));
  });

  it('removes the project once confirmed', async () => {
    show([A, B]);
    render(<Harness />);
    fireEvent.click(within(openMenuOf('website')).getByRole('menuitem', { name: 'Remove' }));
    await act(async () => {
      fireEvent.click(within(confirmation('website')).getByRole('button', { name: 'Remove' }));
      await flush();
    });
    expect(requests).toEqual([['projects:remove', { key: B.key }]]);
  });

  it('shows an entry fat-g cannot read at its place, with Remove only, and removes it by its key (C60)', async () => {
    const bad = unreadable('one');
    show([A, bad, B]);
    render(<Harness />);
    expect(within(column()).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['fat-g', 'Unreadable project', 'website']);
    const menu = openMenuOf('unreadable project');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Remove']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove' }));
    const dialog = confirmation('this unreadable project');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
      await flush();
    });
    expect(requests).toEqual([['projects:remove', { key: bad.key }]]);
  });
});

// ── V18 (the column's part) ───────────────────────────────────────────────────────────────
describe('a refused records file (V18)', () => {
  const refused = (cause: RecordsRefusalCause) => useAppState.setState({ snapshot: withRecords(recordsState([], { kind: 'refused', cause })) });

  it.each([
    ['newer', 'A newer fat-g saved your projects. Update fat-g to see them again.'],
    ['older', 'An earlier development version of fat-g saved them. That version still reads them.'],
    ['unreadable', 'The file cannot be opened. Another program may be holding it. Try again.'],
    ['damaged', 'The file is damaged. If you edited it by hand, undo the edit.'],
  ] as const)('shows only the note for a %s file: unchanged, the cause and the remedy (C5, C50, C62)', (cause, text) => {
    refused(cause);
    render(<Harness />);
    const note = screen.getByRole('status');
    expect(note.textContent).toContain('Your projects file is unchanged.');
    expect(note.textContent).toContain(text);
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(cause === 'unreadable');
  });

  it('asks before Start fresh, with Cancel focused, and Cancel changes nothing (C66)', () => {
    refused('damaged');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh…' }));
    const dialog = screen.getByRole('dialog', { name: 'Start fresh?' });
    expect(dialog.textContent).toContain('The file is damaged. If you edited it by hand, undo the edit.');
    expect(dialog.textContent).toContain('fat-g will move records.json, unchanged, to records.set-aside.<date and time>.json in its data folder, and start with no projects.');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests).toEqual([]);
  });

  it('starts fresh once confirmed, then names the kept file for the rest of the run (C63)', async () => {
    refused('newer');
    answer = () => ({ status: 'done', keptAs: 'C:\\data\\records.set-aside.2020-01-21T14-03-12Z.json' });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh…' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Start fresh?' })).getByRole('button', { name: 'Start fresh' }));
      await flush();
    });
    expect(requests).toEqual([['records:startFresh', null]]);
    act(() => useAppState.setState({ snapshot: withRecords(recordsState([], { kind: 'ok', keptAs: 'C:\\data\\records.set-aside.2020-01-21T14-03-12Z.json' }), 2) }));
    expect(column().textContent).toContain('Your old projects file was kept as C:\\data\\records.set-aside.2020-01-21T14-03-12Z.json');
    expect(screen.queryByRole('button', { name: 'Start fresh…' })).toBeNull();
  });

  it('keeps the note and says so when the file could not be moved', async () => {
    refused('damaged');
    bridge.setInvoke(async () => ({ ok: false, error: 'internal' }));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh…' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Start fresh?' })).getByRole('button', { name: 'Start fresh' }));
      await flush();
    });
    expect(screen.getByRole('status').textContent).toContain('fat-g could not move the file. Nothing was changed.');
  });

  it('reads the file again on Try again (C67)', async () => {
    refused('unreadable');
    answer = () => ({ status: 'refused', reason: 'still-refused' });
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await flush();
    });
    expect(requests).toEqual([['records:retry', null]]);
    expect(screen.getByRole('status').textContent).toContain('fat-g tried again, and still cannot read it.');
  });
});

// ── V30 ───────────────────────────────────────────────────────────────────────────────────
describe('dragging (V30)', () => {
  /** The middle of row `index` (0-based, in DOM order), on screen. */
  const rowY = (index: number) => LIST_TOP + index * ROW + ROW / 2;
  const press = (element: Element, y: number, x = 100) => fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: x, clientY: y });
  const moveTo = (y: number, x = 100) => fireEvent.pointerMove(window, { pointerId: 1, clientX: x, clientY: y });
  const release = (y: number, x = 100) => fireEvent.pointerUp(window, { pointerId: 1, clientX: x, clientY: y });
  /** The outlined room where the project will land (C86). */
  const gap = () => column().querySelector<HTMLElement>('[data-gap]');
  const entryOf = (name: string) => headerOf(name).closest('li') as HTMLElement;
  const shiftOf = (name: string) => entryOf(name).style.transform;

  it('starts only after the pointer moves 4 px, so a click stays a click (C70)', () => {
    show([A, B, C]);
    render(<Harness />);
    press(headerOf('fat-g'), rowY(0));
    moveTo(rowY(0) + 3);
    expect(gap()).toBeNull();
    moveTo(rowY(0) + 4);
    expect(gap()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    release(rowY(0));
    expect(requests).toEqual([]);
  });

  it('never starts from the … button', () => {
    show([A, B]);
    render(<Harness />);
    press(actions('fat-g'), rowY(0));
    moveTo(rowY(1) + 10);
    expect(gap()).toBeNull();
    release(rowY(1) + 10);
    expect(requests).toEqual([]);
  });

  it('drags a folded project from its name without folding on the following click, and still accepts a keyboard activation', async () => {
    show([project(A.name, { collapsed: true }), B, C]);
    render(<Harness />);
    const button = screen.getByRole('button', { name: A.name });
    press(within(button).getByText(A.name), rowY(0));
    moveTo(rowY(2) + 10);
    release(rowY(2) + 10);
    await act(async () => { fireEvent.click(button, { detail: 1 }); await flush(); });
    expect(requests).toEqual([['projects:move', { id: A.id, hidden: false, before: null }]]);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { fireEvent.click(button, { detail: 0 }); await flush(); });
    expect(requests.at(-1)).toEqual(['projects:setCollapsed', { id: A.id, collapsed: false }]);
  });

  it('moves the others out of the way, and outlines where it will land (C86)', () => {
    show([A, B, C]);
    render(<Harness />);
    press(headerOf('fat-g'), rowY(0));
    moveTo(rowY(0) + 10);
    // Its own place first: nothing moves, and the gap is where it was.
    expect([shiftOf('website'), shiftOf('notes')]).toEqual(['', '']);
    expect([gap()?.style.top, gap()?.style.height]).toEqual(['0px', `${ROW}px`]);
    expect(entryOf('fat-g').hasAttribute('data-lifted')).toBe(true);
    expect(column().querySelector('[class*="lifted"]')?.textContent).toBe('fat-g');
    // Past the last one: both move up a header's height, closing its place and opening the gap below.
    moveTo(rowY(2) + 10);
    expect([shiftOf('website'), shiftOf('notes')]).toEqual([`translateY(-${ROW}px)`, `translateY(-${ROW}px)`]);
    expect(gap()?.style.top).toBe(`${2 * ROW}px`);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(gap()).toBeNull();
    expect([shiftOf('website'), shiftOf('notes')]).toEqual(['', '']);
    expect(entryOf('fat-g').hasAttribute('data-lifted')).toBe(false);
  });

  it('moves the others down when dragged up', () => {
    show([A, B, C]);
    render(<Harness />);
    press(headerOf('notes'), rowY(2));
    moveTo(rowY(0) - 10);
    expect([shiftOf('fat-g'), shiftOf('website')]).toEqual([`translateY(${ROW}px)`, `translateY(${ROW}px)`]);
    expect(gap()?.style.top).toBe('0px');
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('draws no gap over a closed hidden row: the row lights up, and moves up into the closed place (C75, C86)', () => {
    show([A, B, H1]);
    render(<Harness />);
    press(headerOf('fat-g'), rowY(0));
    moveTo(rowY(2));
    const row = screen.getByRole('button', { name: '1 hidden project' });
    expect(row.hasAttribute('data-target')).toBe(true);
    expect(row.style.transform).toBe(`translateY(-${ROW}px)`);
    expect(shiftOf('website')).toBe(`translateY(-${ROW}px)`);
    expect(gap()).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
  });

  it('sends one move with the new place, and keeps the header there until the state arrives (C68)', async () => {
    show([A, B, C]);
    render(<Harness />);
    press(headerOf('fat-g'), rowY(0));
    moveTo(rowY(1) + 12);
    await act(async () => {
      release(rowY(1) + 12);
      await flush();
    });
    expect(requests).toEqual([['projects:move', { id: A.id, hidden: false, before: C.key }]]);
    expect(within(column()).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['website', 'fat-g', 'notes']);
  });

  it('puts the header back when the move fails', async () => {
    show([A, B, C]);
    bridge.setInvoke(async () => ({ ok: false, error: 'internal' }));
    render(<Harness />);
    press(headerOf('fat-g'), rowY(0));
    moveTo(rowY(2) + 12);
    await act(async () => {
      release(rowY(2) + 12);
      await flush();
    });
    expect(within(column()).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['fat-g', 'website', 'notes']);
    expect(screen.getByRole('status').textContent).toContain('nothing was changed');
  });

  it('sends nothing for a drop at its own place', () => {
    show([A, B, C]);
    render(<Harness />);
    press(headerOf('website'), rowY(1));
    moveTo(rowY(1) + 10);
    release(rowY(1) + 10);
    expect(requests).toEqual([]);
  });

  it('cancels on Escape, and on a release outside the column (C86)', () => {
    show([A, B, C]);
    render(<Harness />);
    press(headerOf('fat-g'), rowY(0));
    moveTo(rowY(2) + 10);
    fireEvent.keyDown(window, { key: 'Escape' });
    release(rowY(2) + 10);
    press(headerOf('fat-g'), rowY(0));
    moveTo(rowY(2) + 10);
    release(rowY(2) + 10, 500);
    expect(requests).toEqual([]);
    expect(gap()).toBeNull();
  });

  it('shows the hidden row as a target during a drag, even with nothing hidden, and hides a project dropped on it (C75)', async () => {
    show([A, B]);
    render(<Harness />);
    expect(screen.queryByRole('button', { name: /hidden project/ })).toBeNull();
    press(headerOf('fat-g'), rowY(0));
    moveTo(rowY(0) + 10);
    const row = screen.getByRole('button', { name: 'No hidden projects' });
    moveTo(rowY(2));
    expect(row.hasAttribute('data-target')).toBe(true);
    await act(async () => {
      release(rowY(2));
      await flush();
    });
    expect(requests).toEqual([['projects:move', { id: A.id, hidden: true, before: null }]]);
  });

  it('drops across the hidden row both ways, in the same change (C74)', async () => {
    show([A, B, H1, H2]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '2 hidden projects' }));
    // Rows: fat-g, website, the hidden row, old-experiment, archive.
    press(headerOf('website'), rowY(1));
    moveTo(rowY(4) - 10);
    await act(async () => {
      release(rowY(4) - 10);
      await flush();
    });
    press(headerOf('archive'), rowY(4));
    moveTo(rowY(0) - 10);
    await act(async () => {
      release(rowY(0) - 10);
      await flush();
    });
    expect(requests).toEqual([
      ['projects:move', { id: B.id, hidden: true, before: H2.key }],
      ['projects:move', { id: H2.id, hidden: false, before: A.key }],
    ]);
  });

  it('scrolls the column near its edges, one step per frame (C86)', async () => {
    show([A, B, C]);
    render(<Harness />);
    let top = 0;
    Object.defineProperty(column(), 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    press(headerOf('fat-g'), rowY(0));
    moveTo(395);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(top).toBeGreaterThan(0);
    const reached = top;
    moveTo(200);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(top).toBeLessThanOrEqual(reached + 8);
    fireEvent.keyDown(window, { key: 'Escape' });
  });
});

// ── V22 ───────────────────────────────────────────────────────────────────────────────────
describe('keyboard moves (V22)', () => {
  it('moves the focused project one place with Alt+Up and Alt+Down, and says where it is now', async () => {
    show([A, B, C]);
    render(<Harness />);
    expect(actions('website').getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowUp Alt+ArrowDown');
    actions('website').focus();
    await act(async () => {
      fireEvent.keyDown(actions('website'), { key: 'ArrowUp', altKey: true });
      await flush();
    });
    expect(requests).toEqual([['projects:move', { id: B.id, hidden: false, before: A.key }]]);
    expect(within(column()).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['website', 'fat-g', 'notes']);
    expect(document.activeElement).toBe(actions('website'));
    expect(screen.getByText('website, position 1 of 3 in visible projects.')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('keeps the focus when the list moves the header’s element down', async () => {
    show([A, B, C]);
    render(<Harness />);
    actions('fat-g').focus();
    await act(async () => {
      fireEvent.keyDown(actions('fat-g'), { key: 'ArrowDown', altKey: true });
      await flush();
    });
    expect(requests).toEqual([['projects:move', { id: A.id, hidden: false, before: C.key }]]);
    expect(document.activeElement).toBe(actions('fat-g'));
  });

  it('lets the focus go once the new state has arrived', async () => {
    show([A, B, C]);
    render(<Harness />);
    actions('website').focus();
    await act(async () => {
      fireEvent.keyDown(actions('website'), { key: 'ArrowUp', altKey: true });
      await flush();
    });
    act(() => show([B, A, C], 2));
    expect(document.activeElement).toBe(actions('website'));
    actions('notes').focus();
    act(() => show([B, A, C, project('later')], 3));
    expect(document.activeElement).toBe(actions('notes'));
  });

  it('does nothing at the ends of its group', () => {
    show([A, B, H1]);
    render(<Harness />);
    fireEvent.keyDown(actions('fat-g'), { key: 'ArrowUp', altKey: true });
    fireEvent.keyDown(actions('website'), { key: 'ArrowDown', altKey: true });
    expect(requests).toEqual([]);
  });

  it('moves a hidden project within the hidden list', async () => {
    show([A, H1, H2]);
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '2 hidden projects' }));
    await act(async () => {
      fireEvent.keyDown(actions('archive'), { key: 'ArrowUp', altKey: true });
      await flush();
    });
    expect(requests).toEqual([['projects:move', { id: H2.id, hidden: true, before: H1.key }]]);
    expect(screen.getByText('archive, position 1 of 2 in hidden projects.')).toBeTruthy();
  });
});
