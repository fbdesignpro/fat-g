// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8, V9 (docs/planning/_archive/M20a.md, Design 8; C9, C36–C46): a group of activity, by itself — its
// summary line and when it stands open, its rows and their words, a row's detail and its Copy
// buttons, the controls a file is, a worker row's Open button, the keyboard's stops, and what is
// drawn again when one item changes.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityBody } from '@shared/contracts/activity';
import type { ConversationItem } from '@shared/contracts/conversation';
import { REFERENCE_WORDS } from '../markdown/controls';
import { type Opener, OpenerContext } from '../markdown/inert';
import { sessionClockState } from '../sessions/session-clock';
import { chatActivity } from '../test/chat';
import { ActivityGroup, sameItems, WorkerOpenContext } from './ActivityGroup';
import { ACTIVITY_LABELS, CUT_WORDS } from './activity-words';
import { useGroupChoices } from './chat-store';

const S = '11111111-1111-4111-8111-111111111111';
let written: string[];
let opened: [string, string, number | undefined][];
const opener: Opener = { platform: 'test-os', open: (address, kind, line) => { opened.push([address, kind, line]); return Promise.resolve(null); }, show: () => Promise.resolve(null), copyPath: () => Promise.resolve(null) };

beforeEach(() => {
  written = [];
  opened = [];
  useGroupChoices.setState({ choices: {} });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

type Given = Partial<ActivityBody> & Pick<ActivityBody, 'type'>;
const activity = (body: Given, overrides: Partial<ConversationItem> = {}): ConversationItem => chatActivity(S, 't1', body, overrides);
const READ: Given = { type: 'read', name: 'Read', summary: 'sample.txt', input: '{\n  "file_path": "C:\\\\work\\\\sample.txt"\n}', output: 'The cat is called Biscuit.', files: [{ path: 'C:\\work\\sample.txt', line: null }] };
const COMMAND: Given = { type: 'command', name: 'commandExecution', summary: 'rg --files', input: 'rg --files --hidden', output: 'README.md\nsample.txt', exitCode: 0 };

interface Shown { readonly current?: boolean; readonly opener?: Opener | null; readonly onOpenWorker?: ((workerId: string, label: string) => void) | null; readonly open?: boolean }
function show(items: readonly ConversationItem[], { current = true, opener: given = opener, onOpenWorker = null, open = false }: Shown = {}) {
  // No group opens by itself (maintainer): a test that reads rows opens it as the reader would, through the store that keeps the choice.
  if (open && items[0] !== undefined) useGroupChoices.setState({ choices: { [items[0].id]: true } });
  return render(
    <OpenerContext value={given}>
      <WorkerOpenContext value={onOpenWorker}>
        <ActivityGroup items={items} id="g1" current={current} />
      </WorkerOpenContext>
    </OpenerContext>,
  );
}
const group = () => screen.getByRole('article', { name: ACTIVITY_LABELS.group });
const head = () => within(group()).getAllByRole('button')[0] as HTMLElement;
const rowsShown = () => within(group()).queryAllByRole('listitem').filter((row) => row.hasAttribute('data-activity'));
const row = (type: string) => rowsShown().find((each) => each.getAttribute('data-activity') === type) as HTMLElement;
const press = (button: HTMLElement) => act(async () => { fireEvent.click(button); await Promise.resolve(); await Promise.resolve(); });
const disclosure = (of: HTMLElement) => within(of).getAllByRole('button').find((button) => button.hasAttribute('aria-controls')) as HTMLElement;

describe('the summary line (V8; C36)', () => {
  it('says what was done and how long it took, and is the control that opens the group, which is closed until it is pressed', async () => {
    show([activity(READ, { time: { receivedAt: 10_000, providerAt: null } }), activity({ ...COMMAND, duration: { ms: 4_000, provenance: 'provider' } }, { time: { receivedAt: 20_000, providerAt: null } })]);
    expect(head().textContent).toBe('Read 1 file, ran 1 command · 14 s');
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(group().hasAttribute('data-open')).toBe(false);
    // Closed, it draws its line alone (C44).
    expect(rowsShown()).toEqual([]);
    await press(head());
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(rowsShown().map((each) => each.getAttribute('data-activity'))).toEqual(['read', 'command']);
    await press(head());
    expect(rowsShown()).toEqual([]);
  });

  // No group opens by itself (maintainer): one that opened on a failure unrolled under a reader who was reading something else, as one that opened at an action's start and closed at its end flickered through its rows (M100, round 9, C83).
  it('opens by itself for no ending of an action, its line saying what became of them, and keeps to that line while one runs', () => {
    for (const status of ['failed', 'unfinished', 'declined'] as const) {
      show([activity(READ), activity({ ...COMMAND, status })]);
      expect(head().getAttribute('aria-expanded'), status).toBe('false');
      expect(rowsShown(), status).toEqual([]);
      expect(group().getAttribute('aria-busy'), status).toBe(null);
      cleanup();
    }
    // What failed, and what never finished, is said by the line it keeps to.
    show([activity(READ), activity({ ...COMMAND, status: 'failed' })]);
    expect(head().textContent).toBe('Read 1 file, ran 1 command, 1 failed · 1 s');
    cleanup();
    show([activity(READ), activity({ ...COMMAND, status: 'unfinished' })]);
    expect(head().textContent).toBe('Read 1 file, ran 1 command, 1 did not finish · 1 s');
    cleanup();
    show([activity(READ), activity({ ...COMMAND, status: 'running' })]);
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(rowsShown()).toEqual([]);
    // Its line says what runs, and the group says it is busy.
    expect(head().textContent).toContain('Read 1 file, ran 1 command');
    expect(group().getAttribute('aria-busy')).toBe('true');
  });

  it('keeps the reader’s own opening or closing: no later item undoes it, and it is kept for the run (C36)', async () => {
    const first = activity(READ);
    const running = activity({ ...COMMAND, status: 'running' });
    const view = show([first, running]);
    // Closed while one runs: the reader opens it, and the action's end leaves it open (round 9, C83).
    await press(head());
    expect(rowsShown()).toHaveLength(2);
    const ended = { ...running, activity: { ...(running.activity as ActivityBody), status: 'completed' as const } };
    view.rerender(<OpenerContext value={opener}><WorkerOpenContext value={null}><ActivityGroup items={[first, ended]} id="g1" current /></WorkerOpenContext></OpenerContext>);
    expect(head().getAttribute('aria-expanded')).toBe('true');
    // The reader closes it, another item starts and one fails: it stays closed.
    await press(head());
    const failed = { ...running, activity: { ...(running.activity as ActivityBody), status: 'failed' as const } };
    view.rerender(<OpenerContext value={opener}><WorkerOpenContext value={null}><ActivityGroup items={[first, failed, activity({ type: 'search', status: 'running' })]} id="g1" current /></WorkerOpenContext></OpenerContext>);
    expect(head().getAttribute('aria-expanded')).toBe('false');
    // And through the list letting go of the group and drawing it again: the choice is the store's.
    cleanup();
    show([first, failed]);
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(useGroupChoices.getState().choices).toEqual({ [first.id]: false });
  });

  it('counts its span from the page’s clock while an item runs, and stops the clock when none does', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const first = activity(READ, { time: { receivedAt: 90_000, providerAt: null } });
    const running = activity({ ...COMMAND, status: 'running' }, { time: { receivedAt: 95_000, providerAt: null } });
    // A running group keeps to its line (round 9, C83): the reader has this one open, so its rows' times show.
    useGroupChoices.setState({ choices: { [first.id]: true } });
    const view = show([first, running]);
    expect(head().textContent).toBe('Read 1 file, ran 1 command · 10 s');
    expect(sessionClockState().ticking).toBe(true);
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(head().textContent).toBe('Read 1 file, ran 1 command · 13 s');
    // The running row counts too.
    expect(within(row('command')).getByText('8 s')).toBeTruthy();
    const ended = { ...running, state: 'complete' as const, activity: { ...(running.activity as ActivityBody), status: 'completed' as const, duration: { ms: 6_000, provenance: 'local' as const } } };
    view.rerender(<OpenerContext value={opener}><WorkerOpenContext value={null}><ActivityGroup items={[first, ended]} id="g1" current /></WorkerOpenContext></OpenerContext>);
    expect(head().textContent).toBe('Read 1 file, ran 1 command · 11 s');
    expect(sessionClockState()).toEqual({ subscribers: 0, ticking: false });
  });

  it('draws nothing for a group that holds thinking alone, and leaves thinking out of the line and the rows of any other (C9)', () => {
    const view = show([activity({ type: 'thinking', thinking: 'Weighing the tides.' })]);
    expect(view.container.innerHTML).toBe('');
    cleanup();
    show([activity({ type: 'thinking' }), activity({ ...READ, status: 'failed' })], { open: true });
    expect(head().textContent).toContain('Read 1 file');
    expect(rowsShown().map((each) => each.getAttribute('data-activity'))).toEqual(['read']);
    expect(group().textContent).not.toContain('Weighing');
  });
});

describe('a row (V8; C37, C39–C41, C45)', () => {
  const open = (...items: ConversationItem[]) => { show([...items, activity({ type: 'wait', status: 'failed' })], { open: true }); };

  it('reads its kind’s word, what it is said of, its duration and its status in words, in one line', () => {
    open(activity(READ), activity({ ...COMMAND, duration: { ms: 3_000, provenance: 'provider' } }), activity({ type: 'search', summary: 'nextHighTide' }), activity({ type: 'web-search', summary: 'tide tables' }), activity({ type: 'mcp', name: 'docs: search', summary: 'docs: search' }), activity({ type: 'other', name: 'ALaterTool' }));
    const said = (type: string) => [...(row(type).querySelector('[data-row-line]')?.children ?? [])].map((part) => part.textContent).filter((text) => text !== '');
    expect(said('read')).toEqual(['Read', 'sample.txt', '1 s', 'Completed']);
    // One run of text, its parts apart by real spaces: what is copied reads as it is drawn.
    expect(row('read').querySelector('[data-row-line]')?.textContent).toBe('Read sample.txt 1 s Completed');
    expect(said('command')).toEqual(['Ran', 'rg', '3 s', 'Completed']);
    expect(said('search')).toEqual(['Searched', 'nextHighTide', '1 s', 'Completed']);
    expect(said('web-search')).toEqual(['Searched the web', 'tide tables', '1 s', 'Completed']);
    expect(said('mcp')).toEqual(['Called', 'docs: search', '1 s', 'Completed']);
    expect(said('other')).toEqual(['Used', 'ALaterTool', '1 s', 'Completed']);
    // A wait has nothing to open: no disclosure, and a gap in its place so the rows line up.
    expect(said('wait')).toEqual(['Waited', '1 s', 'Failed']);
    expect(within(row('wait')).queryAllByRole('button')).toEqual([]);
  });

  it('says a failure and an unfinished item in words, with the exit code where there is one, and marks the row for no colour alone', () => {
    show([activity({ ...COMMAND, status: 'failed', exitCode: 2 }), activity({ ...READ, status: 'unfinished' }), activity({ type: 'search', status: 'running' })], { open: true });
    expect(within(row('command')).getByText('Failed (exit code 2)')).toBeTruthy();
    expect(within(row('read')).getByText('Did not finish')).toBeTruthy();
    expect(within(row('search')).getByText('Running')).toBeTruthy();
    expect(rowsShown().map((each) => each.getAttribute('data-status'))).toEqual(['failed', 'unfinished', 'running']);
  });

  it('opens to its input and its output, each with a Copy button of its own, and draws them only once opened (C37, C44)', async () => {
    open(activity(COMMAND));
    expect(group().querySelector('pre')).toBeNull();
    const toggle = disclosure(row('command'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Show Ran rg');
    await press(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Hide Ran rg');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).not.toBeNull();
    expect([...row('command').querySelectorAll('pre')].map((pre) => [pre.getAttribute('aria-label'), pre.textContent])).toEqual([['Input', 'rg --files --hidden'], ['Output', 'README.md\nsample.txt']]);
    await press(within(row('command')).getByRole('button', { name: ACTIVITY_LABELS.copyInput }));
    await press(within(row('command')).getByRole('button', { name: ACTIVITY_LABELS.copyOutput }));
    expect(written).toEqual(['rg --files --hidden', 'README.md\nsample.txt']);
    await press(toggle);
    expect(row('command').querySelector('pre')).toBeNull();
  });

  it('shows a cut output as its two halves with fat-g’s line where the cut is, and copies it so (C5)', async () => {
    const output = `${'a'.repeat(10)}${'z'.repeat(10)}`;
    open(activity({ ...COMMAND, output, cut: { fields: ['output'], output: { omitted: 1_234, at: 10 }, files: 0, steps: 0, changes: 0 } }));
    await press(disclosure(row('command')));
    const pre = [...row('command').querySelectorAll('pre')].at(-1) as HTMLElement;
    expect([...pre.children].map((part) => [part.tagName, part.textContent])).toEqual([['CODE', 'a'.repeat(10)], ['SPAN', CUT_WORDS.output(1_234)], ['CODE', 'z'.repeat(10)]]);
    expect(pre.querySelector('[data-item-line="cut"]')?.textContent).toBe('… 1,234 characters left out here …');
    await press(within(row('command')).getByRole('button', { name: ACTIVITY_LABELS.copyOutput }));
    expect(written).toEqual([`${'a'.repeat(10)}\n${CUT_WORDS.output(1_234)}\n${'z'.repeat(10)}`]);
  });

  it('says in a line of fat-g’s what else was cut: an input, files, and an output or an input too long to keep at all', async () => {
    open(
      activity({ ...COMMAND, output: null, cut: { fields: ['input', 'output'], output: null, files: 0, steps: 0, changes: 0 } }),
      activity({ ...READ, input: null, output: null, cut: { fields: ['input', 'files'], output: null, files: 7, steps: 0, changes: 0 } }),
    );
    await press(disclosure(row('command')));
    await press(disclosure(row('read')));
    const lines = (type: string) => [...row(type).querySelectorAll('[data-item-line="cut"]')].map((line) => line.textContent);
    expect(lines('command')).toEqual([CUT_WORDS.input, CUT_WORDS.outputGone]);
    expect(lines('read')).toEqual([CUT_WORDS.files(7), CUT_WORDS.inputGone]);
  });

  it('opens an edit to its changes as they were reported, under the line that says when, and a task list to its steps with their state (C10, C39, C41)', async () => {
    const edit = activity({ type: 'edit', name: 'fileChange', changes: [{ path: 'src/tides.js', kind: 'update', text: '-old\n+new' }, { path: 'notes.md', kind: 'delete', text: null }] }, { time: { receivedAt: Date.UTC(2020, 0, 29, 14, 5), providerAt: null } });
    const list = activity({ type: 'checklist', name: 'plan', steps: [{ text: 'List the files', state: 'completed' }, { text: 'Read the README', state: 'in-progress' }, { text: 'Count the lines', state: 'pending' }] });
    open(edit, list);
    expect(within(row('edit')).getByText('Edited')).toBeTruthy();
    expect(within(row('edit')).getByText('changed, and 1 more')).toBeTruthy();
    await press(disclosure(row('edit')));
    expect(row('edit').textContent).toContain('As reported at ');
    expect(row('edit').textContent).toContain(': the file may have changed since.');
    expect([...row('edit').querySelectorAll('pre')].map((pre) => [pre.getAttribute('aria-label'), pre.textContent])).toEqual([['src/tides.js — changed', '-old\n+new']]);
    expect(row('edit').textContent).toContain('notes.md — deleted');
    await press(within(row('edit')).getByRole('button', { name: ACTIVITY_LABELS.copyChange }));
    expect(written).toEqual(['-old\n+new']);

    expect(within(row('checklist')).getByText('Tasks: 1 of 3 done')).toBeTruthy();
    await press(disclosure(row('checklist')));
    expect([...row('checklist').querySelectorAll('[data-step]')].map((step) => [step.getAttribute('data-step'), step.textContent])).toEqual([['completed', 'Done List the files'], ['in-progress', 'In progress Read the README'], ['pending', 'To do Count the lines']]);
  });
});

describe('the controls a file is (V9; C8, C38)', () => {
  it('makes a read’s file a control beside the disclosure, given the path and its line as the provider wrote them', async () => {
    show([activity({ ...READ, status: 'failed', files: [{ path: 'C:\\work\\sample.txt', line: 12 }] })], { open: true });
    const control = within(row('read')).getByRole('button', { name: 'sample.txt' });
    expect(control.getAttribute('title')).toBe('C:\\work\\sample.txt:12');
    // Beside the disclosure, never inside it: no control holds another (M19b, C57).
    expect(disclosure(row('read')).contains(control)).toBe(false);
    await press(control);
    expect(opened).toEqual([['C:\\work\\sample.txt', 'local', 12]]);
  });

  it('lists every file an item names in its detail, each a control; its input and output draw none, whatever they hold', async () => {
    show([activity({ type: 'search', status: 'failed', summary: 'tide', input: 'see `src/tides.js` and https://example.com', output: '[a link](https://example.com) src/tides.js:3', files: [{ path: 'src/tides.js', line: 3 }, { path: 'field notes/harbour-log.md', line: null }] })], { open: true });
    await press(disclosure(row('search')));
    const files = within(within(row('search')).getByRole('list', { name: ACTIVITY_LABELS.files })).getAllByRole('button');
    expect(files.map((file) => file.textContent)).toEqual(['src/tides.js:3', 'field notes/harbour-log.md']);
    await press(files[0] as HTMLElement);
    expect(opened).toEqual([['src/tides.js', 'local', 3]]);
    for (const pre of row('search').querySelectorAll('pre')) {
      expect(pre.querySelector('button, a, [data-reference]')).toBeNull();
    }
  });

  it('says beside a file that is outside the project that it is, and opens nothing: the opener’s own line, as a reference in a message has it (M19b, C24)', async () => {
    const refusing: Opener = { platform: 'test-os', open: (address, kind, line) => { opened.push([address, kind, line]); return Promise.resolve('outside'); }, show: () => Promise.resolve(null), copyPath: () => Promise.resolve(null) };
    show([activity({ ...READ, status: 'failed', files: [{ path: 'C:\\Users\\someone\\secrets.txt', line: 3 }], summary: 'secrets.txt' })], { opener: refusing, open: true });
    await press(within(row('read')).getByRole('button', { name: 'secrets.txt' }));
    expect(opened).toEqual([['C:\\Users\\someone\\secrets.txt', 'local', 3]]);
    expect(within(row('read')).getAllByText(REFERENCE_WORDS.outside, { exact: false }).length).toBeGreaterThan(0);
    expect(within(row('read')).getByRole('status').textContent).toBe(REFERENCE_WORDS.outside);
  });

  it('draws a file as the text it is where the chat has no opener: a chat without a session (C46)', async () => {
    show([activity({ ...READ, status: 'failed' })], { opener: null, open: true });
    expect(within(row('read')).queryByRole('button', { name: 'sample.txt' })).toBeNull();
    expect(within(row('read')).getByText('sample.txt')).toBeTruthy();
    await press(disclosure(row('read')));
    expect(within(row('read')).getByRole('list', { name: ACTIVITY_LABELS.files }).textContent).toBe('C:\\work\\sample.txt');
    expect(group().querySelector('[data-reference]')).toBeNull();
  });
});

describe('a worker’s row (V8; C23, C40, C46)', () => {
  const WORKER: Given = { type: 'worker', name: 'Agent', summary: 'Read notes-3.txt and report back', input: '{\n  "prompt": "Read the file"\n}', output: 'The logbook is kept in the blue drawer.', workerId: 'worker-1', duration: { ms: 9_000, provenance: 'provider' } };

  it('reads "Sub-agent" with its label, status and duration, and has an Open button that opens its worker’s tab', async () => {
    const calls: [string, string][] = [];
    show([activity({ ...WORKER, status: 'failed' })], { onOpenWorker: (workerId, label) => { calls.push([workerId, label]); }, open: true });
    expect(within(row('worker')).getByText('Sub-agent')).toBeTruthy();
    expect(within(row('worker')).getByText('Read notes-3.txt and report back')).toBeTruthy();
    expect(within(row('worker')).getByText('9 s')).toBeTruthy();
    const openButton = within(row('worker')).getByRole('button', { name: ACTIVITY_LABELS.openWorker });
    expect(openButton.getAttribute('data-open-worker')).toBe('worker-1');
    await press(openButton);
    expect(calls).toEqual([['worker-1', 'Read notes-3.txt and report back']]);
    // It opens to the worker's report, which Copy takes.
    await press(disclosure(row('worker')));
    expect([...row('worker').querySelectorAll('pre')].map((pre) => pre.getAttribute('aria-label'))).toEqual(['Input', 'Report']);
    await press(within(row('worker')).getByRole('button', { name: ACTIVITY_LABELS.copyReport }));
    expect(written).toEqual(['The logbook is kept in the blue drawer.']);
  });

  it('has no Open button for a launch that failed before any worker started: it opens to its error, an output as any tool’s', async () => {
    show([activity({ ...WORKER, status: 'failed', workerId: null, output: 'A worktree was asked for outside a git repository.' })], { onOpenWorker: () => undefined, open: true });
    expect(within(row('worker')).queryByRole('button', { name: ACTIVITY_LABELS.openWorker })).toBeNull();
    expect(within(row('worker')).getByText('Failed')).toBeTruthy();
    await press(disclosure(row('worker')));
    expect([...row('worker').querySelectorAll('pre')].map((pre) => [pre.getAttribute('aria-label'), pre.textContent]).at(-1)).toEqual(['Output', 'A worktree was asked for outside a git repository.']);
  });

  it('has no Open button where nothing can open a tab: a chat without a session (C46)', () => {
    const worker = activity({ ...WORKER, status: 'running' });
    useGroupChoices.setState({ choices: { [worker.id]: true } });
    show([worker], { onOpenWorker: null });
    expect(within(row('worker')).queryByRole('button', { name: ACTIVITY_LABELS.openWorker })).toBeNull();
  });
});

describe('the keyboard (V9; C42)', () => {
  it('makes its line, its rows’ disclosures, their Copy buttons and their controls stops only while it is the current entry', async () => {
    const items = [activity({ ...READ, status: 'failed' }), activity({ ...COMMAND, workerId: null }), activity({ type: 'worker', summary: 'Worker 1', workerId: 'w1', output: 'Done.' })];
    const view = show(items, { current: true, onOpenWorker: () => undefined, open: true });
    await press(disclosure(row('command')));
    const stops = () => within(group()).getAllByRole('button').map((button) => button.tabIndex);
    expect(stops().length).toBeGreaterThanOrEqual(8);
    expect(new Set(stops())).toEqual(new Set([0]));
    expect(group().hasAttribute('data-current')).toBe(true);
    view.rerender(<OpenerContext value={opener}><WorkerOpenContext value={() => undefined}><ActivityGroup items={items} id="g1" current={false} /></WorkerOpenContext></OpenerContext>);
    expect(new Set(stops())).toEqual(new Set([-1]));
    expect(group().hasAttribute('data-current')).toBe(false);
    // What it opened stays open: only the stops moved.
    expect(row('command').querySelectorAll('pre')).toHaveLength(2);
  });

  it('is made of nothing a conversation’s text may not become: no image, no drawing, no link and no field, opened to every detail', async () => {
    show([activity({ ...READ, status: 'failed' }), activity(COMMAND), activity({ type: 'worker', summary: 'Worker 1', workerId: 'w1', output: 'Done.' })], { onOpenWorker: () => undefined, open: true });
    for (const each of rowsShown()) await press(disclosure(each));
    expect(group().querySelectorAll('pre').length).toBeGreaterThanOrEqual(5);
    // What the smoke run counts in the chat's list and in the pane (M19, C31): the disclosure's mark is the stylesheet's.
    expect(group().querySelectorAll('script, img, a, iframe, object, embed, form, input, svg, style, link, video, audio, source, base, meta')).toHaveLength(0);
    expect(group().querySelectorAll('[href], [src], [srcset], [action]')).toHaveLength(0);
  });

  it('carries the element’s id the list names as its current entry, and its name', () => {
    show([activity(READ)]);
    expect(group().id).toBe('g1');
    expect(group().getAttribute('data-role')).toBe('activity');
  });
});

describe('what is drawn again (V10; C44)', () => {
  it('holds the very same items for two lists that do, and not for one whose item changed', () => {
    const [a, b] = [activity(READ), activity(COMMAND)];
    expect(sameItems([a, b], [a, b])).toBe(true);
    expect(sameItems([a, b], [a, { ...b }])).toBe(false);
    expect(sameItems([a], [a, b])).toBe(false);
  });

  it('draws nothing again for a new list of the same items, and one row for an item that changed', () => {
    const first = activity({ ...READ, status: 'failed' });
    const second = activity({ ...COMMAND, status: 'running' });
    const tree = (items: readonly ConversationItem[]) => <OpenerContext value={opener}><WorkerOpenContext value={null}><ActivityGroup items={items} id="g1" current /></WorkerOpenContext></OpenerContext>;
    useGroupChoices.setState({ choices: { [first.id]: true } });
    const view = render(tree([first, second]));
    const [readRow, commandRow] = rowsShown();
    // What tells a row that was drawn again from one that was not: its item's own words, changed
    // under it. A row drawn again would read them.
    (first.activity as { summary: string }).summary = 'another.txt';
    (second.activity as { summary: string }).summary = 'npm test';
    // The list makes its entries again at every change: the same items in a new array. Nothing is drawn.
    view.rerender(tree([first, second]));
    expect(within(readRow as HTMLElement).getByText('sample.txt')).toBeTruthy();
    expect(within(commandRow as HTMLElement).getByText('rg')).toBeTruthy();
    // One item ends: its row is drawn again, in place, and the other row is left as it was.
    view.rerender(tree([first, { ...second, state: 'complete', activity: { ...(second.activity as ActivityBody), status: 'completed', duration: { ms: 2_000, provenance: 'local' } } }]));
    expect(rowsShown()[0]).toBe(readRow);
    expect(rowsShown()[1]).toBe(commandRow);
    expect(within(commandRow as HTMLElement).getByText('Completed')).toBeTruthy();
    expect(within(commandRow as HTMLElement).getByText('npm')).toBeTruthy();
    expect(within(readRow as HTMLElement).getByText('sample.txt')).toBeTruthy();
  });
});
