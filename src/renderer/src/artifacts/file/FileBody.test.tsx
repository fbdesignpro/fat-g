// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V12, V22 (docs/planning/_archive/M19b.md; C31–C33, C36–C38, C40, C42, C53, C59): a file's tab, in the pane,
// on a fake bridge that answers `files:read` from what the test holds and records each request.
// Which files are shown as what is main's to say: here an answer names its view, and the tab draws by it.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FileReadAnswer, type FileRefreshAnswer, type FileRefusal, type FileUnshown, MARKDOWN_UNITS_BOUND } from '@shared/contracts/files';
import type { InvokeChannel } from '@shared/ipc/channels';
import { sessionEntry, SUMMARIES } from '../../../../../tests/support/sessions';
import { type AsideMarker, drawnDigest } from '@shared/contracts/aside';
import { paintedIn } from '../../chat/aside-highlights';
import { resetAsides, setAsides } from '../../chat/asides-store';
import { showDetached } from '../../chat/detached-store';
import { textNodes } from '../../chat/drawn-text';
import { reportSelection } from '../../chat/selection-report';
import { REFERENCE_SAID_MS, REFERENCE_WORDS } from '../../markdown/controls';
import { type FakeBridge, installFakeBridge } from '../../test/fake-bridge';
import { project } from '../../test/records';
import { showState } from '../../test/sessions';
import { PaneWithKinds } from '../../test/pane';
import { BUILT_IN_KINDS } from '../kinds';
import { ASIDE_KIND, FILE_KIND, openReference } from '../opener';
import { closeLabel, TABS_LABEL } from '../TabList';
import { openTab, resetTabs, useTabs } from '../tabs-store';
import { LINE_MARK } from './FileBody';
import { LINES_HOLDER } from './PlainTextView';
import { contentsLabel, FILE_WORDS, fileTitle, pathFromRoot, UNSHOWN_WORDS } from './words';

const P = project('Calamari');
const ONE = sessionEntry('Create plan', SUMMARIES.idle, { projectId: P.id });
const TWO = sessionEntry('Fix bug', SUMMARIES.idle, { projectId: P.id });
const ROOT = 'C:\\work\\tide-tools';
const at = (...parts: string[]): string => [ROOT, ...parts].join('\\');
type Text = Extract<FileReadAnswer, { outcome: 'text' }>;
const markdown = (path: string, text: string, overrides: Partial<Text> = {}): Text => ({ outcome: 'text', path, root: ROOT, view: 'markdown', text, revision: { mtimeMs: 0, size: text.length }, line: null, column: null, ...overrides });
const plain = (path: string, text: string, overrides: Partial<Text> = {}): Text => markdown(path, text, { view: 'plain', ...overrides });
const unshown = (path: string, why: FileUnshown): FileReadAnswer => ({ outcome: 'unshown', why, path, root: ROOT, line: null, column: null });
const refused = (why: FileRefusal): FileReadAnswer => ({ outcome: 'refused', why });

const README = at('README.md');
const README_TEXT = '# Tide tools\n\nSmall helpers. See [the log](field%20notes/harbour-log.md), `src/tides.js:12`, [Usage](#usage) and <https://example.com/tides>.\n\n## Usage\n\nRun it.\n';
const SOURCE = at('src', 'tides.js');
const SOURCE_TEXT = Array.from({ length: 30 }, (_, index) => `// line ${index + 1}`).join('\n');

let bridge: FakeBridge;
let requests: [InvokeChannel, unknown][];
/** What main answers a read with, by the target it is asked for. */
let files: Record<string, FileReadAnswer>;
let showFails: boolean;
/** While true, a read's answer is held back until the test lets it go. */
let withhold: boolean;
let waiting: (() => void)[];
let refreshAnswer: FileRefreshAnswer;

beforeEach(() => {
  bridge = installFakeBridge('win32');
  requests = [];
  files = {};
  showFails = false;
  withhold = false;
  waiting = [];
  refreshAnswer = { outcome: 'unchanged' };
  resetTabs();
  resetAsides();
  showDetached(null);
  bridge.setInvoke((channel, request) => {
    requests.push([channel, request]);
    if (channel === 'files:refresh') {
      const answer = { ok: true, value: refreshAnswer };
      return withhold ? new Promise((resolve) => { waiting.push(() => resolve(answer)); }) : Promise.resolve(answer);
    }
    if (channel === 'files:read') {
      const answer = { ok: true, value: files[(request as { target: string }).target] ?? refused('not-found') };
      return withhold ? new Promise((resolve) => { waiting.push(() => resolve(answer)); }) : Promise.resolve(answer);
    }
    if (channel === 'files:showInFolder' && showFails) return Promise.resolve({ ok: false, error: 'bad-request' });
    // An aside's tab opened from a file's row reads its aside (M20b): main holds none here.
    if (channel === 'chat:readAside') return Promise.resolve({ ok: true, value: { status: 'refused', reason: 'unknown-aside' } });
    return Promise.resolve({ ok: true, value: null });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A file main can read: by an address a message wrote, and by its own path, which a tab re-reads it by. */
function hold(address: string, answer: FileReadAnswer): void {
  files[address] = answer;
  if (answer.outcome === 'text' || answer.outcome === 'unshown') files[answer.path] = { ...answer, line: null, column: null };
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
function setup(selected = ONE) {
  const view = render(<PaneWithKinds kinds={BUILT_IN_KINDS} />);
  act(() => { showState({ projects: [P], sessions: [ONE, TWO], selectedId: selected.record.id }); });
  return view;
}
const select = (entry: typeof ONE) => act(() => { showState({ projects: [P], sessions: [ONE, TWO], selectedId: entry.record.id }); });
/** Opens a reference as the chat does. */
const open = async (address: string, session = ONE) => { await act(async () => { await openReference(session.record.id, address); }); await flush(); };
const reads = () => requests.filter(([channel]) => channel === 'files:read').map(([, request]) => request as { target: string; from?: string });
const tabNames = () => within(screen.getByRole('tablist', { name: TABS_LABEL })).getAllByRole('tab').map((tab) => tab.querySelector('[data-tab-title]')?.textContent);
const tab = (title: string) => within(screen.getByRole('tablist', { name: TABS_LABEL })).getByTitle(title);
const panel = () => screen.getByRole('tabpanel');
const body = () => panel().firstElementChild as HTMLElement;
const folderTooltip = () => document.getElementById(within(panel()).getByRole('button', { name: FILE_WORDS.showInFolder }).getAttribute('aria-describedby') ?? '') as HTMLElement;
const text = (name: string) => within(panel()).getByLabelText(contentsLabel(name));
const marked = () => [...panel().querySelectorAll(`[${LINE_MARK}]`)];

describe('best-effort visible-file refresh', () => {
  const advance = (ms = 2_000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const polls = () => requests.filter(([channel]) => channel === 'files:refresh').map(([, request]) => request as { path: string; revision: unknown });
  const status = () => panel().querySelector('[data-file-refresh]');
  const clearSelection = () => { document.getSelection()?.removeAllRanges(); fireEvent(document, new Event('selectionchange')); };
  const selectText = () => {
    const range = document.createRange();
    range.selectNodeContents(text('README.md'));
    document.getSelection()?.addRange(range);
    fireEvent(document, new Event('selectionchange'));
  };
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2020-02-25T16:00:00Z')); clearSelection(); });

  it.each(['markdown', 'plain'] as const)('refreshes %s, preserves focus and scroll, and advances only the status clock', async (view) => {
    setup();
    hold('README.md', markdown(README, '# Top\n', { view }));
    await open('README.md');
    expect(status()).toBeNull();
    const original = text('README.md');
    original.scrollTop = 40;
    original.scrollLeft = 12;
    fireEvent.scroll(original);
    original.focus();
    refreshAnswer = markdown(README, '# Changed\n', { view, revision: { mtimeMs: 2, size: 10 } });
    await advance();
    expect(text('README.md').textContent).toContain('Changed');
    expect(text('README.md')).toBe(original);
    expect([original.scrollTop, original.scrollLeft]).toEqual([40, 12]);
    expect(document.activeElement).toBe(original);
    expect(status()?.textContent).toMatch(/^Auto-updated at .+ · seconds ago$/);
    expect(polls()).toEqual([{ sessionId: ONE.record.id, path: README, revision: { mtimeMs: 0, size: 6 } }]);
    refreshAnswer = { outcome: 'unchanged' };
    await advance(12_000);
    expect(status()?.textContent).toContain('seconds ago');
    await advance(48_000);
    expect(status()?.textContent).toContain('1 minute ago');
    expect(screen.getAllByRole('status').filter((element) => element.textContent?.includes(FILE_WORDS.refreshed))).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    expect(JSON.stringify(useTabs.getState())).not.toContain('# Changed');
  });

  it('accepts a metadata-only change without replacing the DOM or claiming an update', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    const heading = screen.getByRole('heading');
    refreshAnswer = markdown(README, '# Top\n', { revision: { mtimeMs: 10, size: 6 } });
    await advance();
    expect(status()).toBeNull();
    expect(screen.getByRole('heading')).toBe(heading);
    refreshAnswer = { outcome: 'unchanged' };
    await advance();
    expect(polls().at(-1)?.revision).toEqual({ mtimeMs: 10, size: 6 });
  });

  it.each<FileRefreshAnswer>([
    { outcome: 'refused', why: 'no-answer' }, { outcome: 'refused', why: 'outside' }, { outcome: 'refused', why: 'not-found' },
    unshown(README, 'not-text'), unshown(README, 'too-large'),
  ])('keeps displayed text on $outcome/$why and recovers quietly', async (failure) => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    refreshAnswer = failure;
    await advance(6_000);
    expect(screen.getByRole('heading').textContent).toBe('Top');
    expect(status()?.textContent).toBe('auto refresh failed');
    expect(status()?.getAttribute('title')).toBe(FILE_WORDS.refreshFailedTip);
    expect(panel().querySelector('[role="alert"]')).toBeNull();
    expect(screen.getAllByRole('status').every((element) => !element.textContent)).toBe(true);
    refreshAnswer = { outcome: 'unchanged' };
    await advance();
    expect(status()).toBeNull();
    refreshAnswer = markdown(README, '# Recovered\n');
    await advance();
    expect(screen.getByRole('heading').textContent).toBe('Recovered');
    expect(status()?.textContent).toContain('Auto-updated at');
  });

  it('catches IPC failures without replacing text or exposing the error', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    bridge.setInvoke(() => Promise.reject(new Error('private exception and path')));
    await advance();
    expect(screen.getByRole('heading').textContent).toBe('Top');
    expect(status()?.textContent).toBe(FILE_WORDS.refreshFailed);
    expect(document.body.textContent).not.toContain('private exception');
  });

  it('silently retries a file still being saved', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    refreshAnswer = { outcome: 'retry' };
    await advance();
    expect(status()).toBeNull();
    expect(screen.getByRole('heading').textContent).toBe('Top');
  });

  it('pauses while hidden and checks immediately on return', async () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    hidden = true;
    fireEvent(document, new Event('visibilitychange'));
    await advance(10_000);
    expect(polls()).toHaveLength(0);
    hidden = false;
    fireEvent(document, new Event('visibilitychange'));
    await flush();
    expect(polls()).toHaveLength(1);
  });

  it('pauses for a selection and checks immediately when it clears', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    selectText();
    refreshAnswer = markdown(README, '# Changed\n');
    await advance(10_000);
    expect(polls()).toHaveLength(0);
    expect(document.getSelection()?.toString()).toBe('Top');
    clearSelection();
    await flush();
    expect(polls()).toHaveLength(1);
    expect(screen.getByRole('heading').textContent).toBe('Changed');
  });

  it('discards an in-flight result if a selection appeared, then rereads when cleared', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    refreshAnswer = markdown(README, '# Changed\n');
    withhold = true;
    await advance();
    selectText();
    await act(async () => { waiting.shift()?.(); await Promise.resolve(); });
    expect(screen.getByRole('heading').textContent).toBe('Top');
    expect(status()).toBeNull();
    withhold = false;
    clearSelection();
    await flush();
    expect(polls()).toHaveLength(2);
    expect(screen.getByRole('heading').textContent).toBe('Changed');
  });

  it('never overlaps polls and lets manual Reload supersede an older result', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    withhold = true;
    refreshAnswer = markdown(README, '# Older automatic result\n');
    await advance(10_000);
    expect(polls()).toHaveLength(1);
    files[README] = markdown(README, '# Manual result\n');
    fireEvent.click(screen.getByRole('button', { name: FILE_WORDS.reload }));
    const [automatic, manual] = waiting.splice(0);
    await act(async () => { manual?.(); await Promise.resolve(); });
    await act(async () => { automatic?.(); await Promise.resolve(); });
    expect(screen.getByRole('heading').textContent).toBe('Manual result');
    expect(status()?.textContent).toBe('Reloaded seconds ago');
  });

  it('keeps only the timestamp across tab switches, and stops polling on unmount', async () => {
    const rendered = setup();
    hold('README.md', markdown(README, '# Top\n'));
    hold('src/tides.js', plain(SOURCE, SOURCE_TEXT));
    await open('README.md');
    refreshAnswer = markdown(README, '# Updated\n');
    await advance();
    const updated = status()?.textContent;
    await open('src/tides.js');
    expect(status()).toBeNull();
    refreshAnswer = { outcome: 'unchanged' };
    await advance();
    expect(polls().at(-1)?.path).toBe(SOURCE);
    fireEvent.click(tab('README.md'));
    await flush();
    expect(status()?.textContent?.split(' · ')[0]).toBe(updated?.split(' · ')[0]);
    expect(screen.getAllByRole('status').every((element) => !element.textContent)).toBe(true);
    const count = polls().length;
    rendered.unmount();
    await advance(10_000);
    expect(polls()).toHaveLength(count);
    expect(JSON.stringify(useTabs.getState())).not.toContain('# Updated');
  });
});

describe('a file tab’s title and the line above its text (C36, C59)', () => {
  it('copies the complete original text including Markdown syntax', async () => {
    setup();
    const source = '# Heading\n\n**Bold** and `code`.\n';
    const copy = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    hold('copy', markdown(at('copy.md'), source));
    await open('copy');
    await act(async () => { fireEvent.click(within(panel()).getByRole('button', { name: 'Copy entire text' })); await Promise.resolve(); });
    expect(copy).toHaveBeenCalledWith(source);
  });
  it('is titled by the file’s name, and two of one name each add their folder’s', async () => {
    setup();
    hold('a', markdown(at('field notes', 'harbour-log.md'), '# Harbour log\n'));
    hold('b', markdown(at('archive', 'harbour-log.md'), '# Old log\n'));
    await open('a');
    expect(tabNames()).toEqual(['harbour-log.md']);
    await open('b');
    expect(tabNames()).toEqual(['harbour-log.md — field notes', 'harbour-log.md — archive']);
    fireEvent.click(screen.getByRole('button', { name: closeLabel('harbour-log.md — archive') }));
    expect(tabNames()).toEqual(['harbour-log.md']);
    expect(fileTitle('C:\\a\\x.md', ['C:\\b\\y.md'])).toBe('x.md');
    expect(fileTitle('/a/x.md', ['/b/x.md'])).toBe('x.md — a');
  });

  it('puts the full path and folder instruction in the folder tooltip, with Copy at the right', async () => {
    setup();
    hold('x', markdown(at('field notes', 'harbour-log.md'), '# Harbour log\n'));
    await open('x');
    const bar = body().firstElementChild as HTMLElement;
    expect(within(bar).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([FILE_WORDS.reload, FILE_WORDS.showInFolder, 'Copy entire text']);
    expect(folderTooltip().textContent).toBe(`${at('field notes', 'harbour-log.md')}Click to open in folder`);
    fireEvent.pointerEnter(within(bar).getByRole('button', { name: FILE_WORDS.showInFolder }));
    expect(folderTooltip().getAttribute('data-open')).toBe('true');
    expect(bar.compareDocumentPosition(text('harbour-log.md')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // V22 (C59): main names the root by its real path, so the path holds where the stored root is a link.
  it('draws the path from the root main answered, whatever the project’s stored root is', async () => {
    setup();
    hold('x', markdown('D:\\real\\place\\docs\\a.md', '# A\n', { root: 'D:\\real\\place' }));
    await open('x');
    expect(folderTooltip().textContent).toContain('D:\\real\\place\\docs\\a.md');
  });

  it('names a path from its root on each system, and falls back to the file’s name', () => {
    expect(pathFromRoot('/home/me/proj/src/a.ts', '/home/me/proj')).toBe('proj/src/a.ts');
    expect(pathFromRoot('C:\\a.md', 'C:\\')).toBe('C:/a.md');
    expect(pathFromRoot('/a.md', '/')).toBe('//a.md'.replace('//', '/'));
    expect(pathFromRoot('C:\\projects\\a.md', 'C:\\proj')).toBe('a.md');
    expect(pathFromRoot('C:\\elsewhere\\a.md', 'C:\\proj')).toBe('a.md');
  });
});

describe('how a file is drawn (C31, C37, C38, C53)', () => {
  it.each([['a .md file', at('notes.md')], ['a .MARKDOWN file', at('NOTES.MARKDOWN')]])('draws %s that main names Markdown with the chat’s own component', async (_name, path) => {
    setup();
    hold('x', markdown(path, '# A heading\n\nSome *text* and a table:\n\n| a |\n| - |\n| 1 |\n'));
    await open('x');
    expect(body().getAttribute('data-file-view')).toBe('markdown');
    expect(within(panel()).getByRole('heading', { level: 1 }).textContent).toBe('A heading');
    expect(panel().querySelector('em')?.textContent).toBe('text');
    expect(panel().querySelector('table')).not.toBeNull();
    expect(panel().querySelector(`[${LINES_HOLDER}]`)).toBeNull();
  });

  it.each([['a .py file', at('main.py')], ['a .JSON file', at('data.JSON')], ['a Makefile', at('Makefile')]])('draws %s that main names plain as plain text, an element a line', async (_name, path) => {
    setup();
    hold('x', plain(path, '# not a heading\n**not bold**\n\tindented'));
    await open('x');
    expect(body().getAttribute('data-file-view')).toBe('plain');
    expect([...(panel().querySelector(`[${LINES_HOLDER}]`)?.children ?? [])].map((line) => line.textContent)).toEqual(['# not a heading', '**not bold**', '\tindented']);
    expect(panel().querySelector('h1, strong')).toBeNull();
  });

  it('scrolls a text within itself, by the keyboard too: its scroller is a stop, named for the file', async () => {
    setup();
    hold('x', plain(SOURCE, SOURCE_TEXT));
    await open('x');
    const scroller = text('tides.js');
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.contains(panel().querySelector(`[${LINES_HOLDER}]`))).toBe(true);
    // The line above it is outside what scrolls.
    expect(scroller.contains(body().firstElementChild)).toBe(false);
  });

  it('shows a Markdown file past its bound as plain text, with a line that says so', async () => {
    setup();
    const long = `# A heading\n\n${'word '.repeat(MARKDOWN_UNITS_BOUND / 5)}\n`;
    expect(long.length).toBeGreaterThan(MARKDOWN_UNITS_BOUND);
    hold('x', markdown(at('big.md'), long));
    await open('x');
    expect(body().getAttribute('data-file-view')).toBe('plain');
    expect(panel().textContent).toContain(FILE_WORDS.pastBound);
    expect(panel().querySelector('h1')).toBeNull();
    expect(panel().querySelector(`[${LINES_HOLDER}]`)?.firstElementChild?.textContent).toBe('# A heading');
  });

  it('draws one of exactly the bound as Markdown, with no such line', async () => {
    setup();
    const exact = `# H\n\n${'x'.repeat(MARKDOWN_UNITS_BOUND - 5)}`;
    expect(exact).toHaveLength(MARKDOWN_UNITS_BOUND);
    hold('x', markdown(at('edge.md'), exact));
    await open('x');
    expect(body().getAttribute('data-file-view')).toBe('markdown');
    expect(panel().textContent).not.toContain(FILE_WORDS.pastBound);
  });
});

describe('references in a shown file (C37)', () => {
  it('resolves a relative reference against the file’s own folder: main is told which file it is in', async () => {
    setup();
    hold('README.md', markdown(README, README_TEXT));
    hold('field%20notes/harbour-log.md', markdown(at('field notes', 'harbour-log.md'), '# Harbour log\n'));
    await open('README.md');
    const controls = [...panel().querySelectorAll<HTMLButtonElement>('[data-reference] > button')];
    expect(controls.map((button) => button.textContent)).toEqual(['the log', 'src/tides.js:12', 'https://example.com/tides']);
    await act(async () => { fireEvent.click(controls[0] as Element); await Promise.resolve(); });
    await flush();
    expect(reads().at(-1)).toEqual({ sessionId: ONE.record.id, target: 'field%20notes/harbour-log.md', from: README });
    expect(tabNames()).toEqual(['README.md', 'harbour-log.md']);
    expect(within(panel()).getByRole('heading', { level: 1 }).textContent).toBe('Harbour log');
  });

  it('leaves a heading’s address the text it is, and opens an external address in the browser', async () => {
    setup();
    hold('README.md', markdown(README, README_TEXT));
    await open('README.md');
    expect(panel().textContent).toContain('Usage (#usage)');
    const external = panel().querySelector<HTMLButtonElement>('[data-reference="external"] > button');
    await act(async () => { fireEvent.click(external as Element); await Promise.resolve(); });
    expect(requests.at(-1)).toEqual(['shell:openAddress', { address: 'https://example.com/tides' }]);
  });

  it('makes every control in a file a stop: there is no current message here (C58)', async () => {
    setup();
    hold('README.md', markdown(README, README_TEXT));
    await open('README.md');
    expect([...panel().querySelectorAll<HTMLButtonElement>('[data-reference] > button')].map((button) => button.tabIndex)).toEqual([0, 0, 0]);
  });

  it('says beside a reference why it did not open, and opens no tab', async () => {
    vi.useFakeTimers();
    setup();
    hold('README.md', markdown(README, '# Top\n\nSee `../elsewhere/secret.md`.\n'));
    files['../elsewhere/secret.md'] = refused('outside');
    await act(async () => { await openReference(ONE.record.id, 'README.md'); });
    const control = panel().querySelector<HTMLButtonElement>('[data-reference] > button');
    await act(async () => { fireEvent.click(control as Element); await Promise.resolve(); await Promise.resolve(); });
    expect(panel().textContent).toContain(REFERENCE_WORDS.outside);
    expect(tabNames()).toEqual(['README.md']);
    act(() => { vi.advanceTimersByTime(REFERENCE_SAID_MS); });
    expect(panel().textContent).not.toContain(REFERENCE_WORDS.outside);
  });
});

describe('a line the target named (C40)', () => {
  /** A layout: every line, and every block, is 20 px high at the place its order gives it; the text shows from its own top. */
  function withLayout(): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const index = this.hasAttribute('tabindex') || this.parentElement === null ? 0 : [...this.parentElement.children].indexOf(this);
      return { top: index * 20, bottom: index * 20 + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: index * 20, toJSON: () => ({}) };
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(4000);
  }

  it('comes to the line and marks it in plain text, and a later reference moves the mark', async () => {
    withLayout();
    setup();
    hold('src/tides.js:12', plain(SOURCE, SOURCE_TEXT, { line: 12 }));
    hold('src/tides.js:25', plain(SOURCE, SOURCE_TEXT, { line: 25 }));
    await open('src/tides.js:12');
    expect(marked().map((line) => line.textContent)).toEqual(['// line 12']);
    // The twelfth line is 220 px down: it stands a little under the text's top.
    expect(text('tides.js').scrollTop).toBe(220 - 32);
    await open('src/tides.js:25');
    expect(tabNames()).toEqual(['tides.js']);
    expect(marked().map((line) => line.textContent)).toEqual(['// line 25']);
    expect(text('tides.js').scrollTop).toBe(188 + 480 - 32);
  });

  it('marks the block that holds the line in Markdown, or the last block before it', async () => {
    withLayout();
    setup();
    const doc = '# Title\n\nFirst paragraph.\n\n[def]: /x\n\nSecond paragraph\nof two lines.\n';
    hold('a.md:3', markdown(at('a.md'), doc, { line: 3 }));
    hold('a.md:8', markdown(at('a.md'), doc, { line: 8 }));
    hold('a.md:5', markdown(at('a.md'), doc, { line: 5 }));
    await open('a.md:3');
    expect(marked().map((block) => block.textContent)).toEqual(['First paragraph.']);
    await open('a.md:8');
    expect(marked().map((block) => block.textContent)).toEqual(['Second paragraph\nof two lines.']);
    // A line that is in no drawn block, a definition's: the last block before it.
    await open('a.md:5');
    expect(marked().map((block) => block.textContent)).toEqual(['First paragraph.']);
  });

  it.each(['\\\n', '  \n', '\\\r\n'])('marks only the referenced item in a paragraph separated by %j', async (breakAt) => {
    withLayout();
    setup();
    const doc = `# Spec\n\n**Content: the plan's decision**${breakAt}C56. A plan's lifetime.${breakAt}C12. A decision is taken **once**, through \`plans:decide\`.${breakAt}C58. The mode cannot change.\n\nNext section.\n`;
    hold('spec.md:5', markdown(at('spec.md'), doc, { line: 5 }));
    hold('spec.md:6', markdown(at('spec.md'), doc, { line: 6 }));
    await open('spec.md:5');
    expect(marked().map((part) => part.textContent)).toEqual(['C12. A decision is taken once, through plans:decide.']);
    expect(marked()[0]?.tagName).toBe('SPAN');
    expect(marked()[0]?.querySelector('strong')?.textContent).toBe('once');
    expect(marked()[0]?.querySelector('code')?.textContent).toBe('plans:decide');
    // Come to the item's own position inside the paragraph, rather than its heading.
    expect(text('spec.md').scrollTop).toBe(80 - 32);
    await open('spec.md:6');
    expect(marked().map((part) => part.textContent)).toEqual(['C58. The mode cannot change.']);
    expect(tabNames()).toEqual(['spec.md']);
    fireEvent.click(screen.getByRole('button', { name: FILE_WORDS.reload }));
    await flush();
    expect(marked().map((part) => part.textContent)).toEqual(['C58. The mode cannot change.']);
  });

  it('comes to the end for a line past it, in each view, and marks nothing', async () => {
    withLayout();
    setup();
    hold('src/tides.js:999', plain(SOURCE, SOURCE_TEXT, { line: 999 }));
    await open('src/tides.js:999');
    expect(marked()).toEqual([]);
    expect(text('tides.js').scrollTop).toBe(4000);
    hold('a.md:999', markdown(at('a.md'), '# Title\n\nBody.\n', { line: 999 }));
    await open('a.md:999');
    expect(marked()).toEqual([]);
    expect(text('a.md').scrollTop).toBe(4000);
  });

  it('comes to the same line again when it is named again, and not when the tab is only shown again', async () => {
    withLayout();
    setup();
    hold('src/tides.js:12', plain(SOURCE, SOURCE_TEXT, { line: 12 }));
    hold('README.md', markdown(README, '# Top\n'));
    await open('src/tides.js:12');
    const scroller = text('tides.js');
    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    await open('README.md');
    fireEvent.click(tab('tides.js'));
    await flush();
    // Shown again: where the reader left it, the mark still on its line.
    expect(text('tides.js').scrollTop).toBe(40);
    expect(marked().map((line) => line.textContent)).toEqual(['// line 12']);
    await open('src/tides.js:12');
    expect(text('tides.js').scrollTop).toBe(40 + 220 - 32);
  });

  it('marks no line for a target that names none', async () => {
    setup();
    hold('src/tides.js', plain(SOURCE, SOURCE_TEXT));
    await open('src/tides.js');
    expect(marked()).toEqual([]);
  });
});

describe('the states that show no text (C42)', () => {
  it.each([['other-kind', 'photo.png'], ['too-large', 'big.log'], ['not-text', 'data.txt']] as const)('opens a tab that says a file is %s, in fat-g’s words, with Show in folder', async (why, name) => {
    setup();
    hold(name, unshown(at(name), why));
    await open(name);
    expect(tabNames()).toEqual([name]);
    expect(body().getAttribute('data-file-outcome')).toBe('unshown');
    expect(panel().textContent).toContain(UNSHOWN_WORDS[why]);
    expect(within(panel()).getByRole('button', { name: FILE_WORDS.showInFolder })).toBeTruthy();
    expect(folderTooltip().textContent).toContain(name);
    // No text is drawn, and there is nothing to scroll.
    expect(within(panel()).queryByLabelText(contentsLabel(name))).toBeNull();
  });

  it('has words for each of the three, none of them a milestone’s name', () => {
    expect(Object.keys(UNSHOWN_WORDS).sort()).toEqual(['not-text', 'other-kind', 'too-large']);
    for (const words of Object.values(UNSHOWN_WORDS)) expect(words).not.toMatch(/M\d+/);
  });

  it.each(['outside', 'not-found', 'no-answer'] satisfies FileRefusal[])('says why a later read was refused (%s), in the control’s words, and keeps the tab’s place', async (why) => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    hold('src/tides.js', plain(SOURCE, SOURCE_TEXT));
    await open('README.md');
    await open('src/tides.js');
    // The root's trust is withdrawn, or the file is gone: the next showing finds it.
    files[README] = refused(why);
    fireEvent.click(tab('README.md'));
    await flush();
    expect(panel().textContent).toContain(REFERENCE_WORDS[why]);
    expect(panel().textContent).not.toContain('Top');
    expect(tabNames()).toEqual(['README.md', 'tides.js']);
    expect(folderTooltip().textContent).toContain('README.md');
  });

  it('says so when main could not be asked at all', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    bridge.setInvoke(() => Promise.reject(new Error('window closing')));
    fireEvent.click(within(panel()).getByRole('button', { name: FILE_WORDS.reload }));
    await flush();
    expect(panel().textContent).toContain(FILE_WORDS.failed);
  });
});

describe('when a file is read (C32, C33)', () => {
  it('reads once at its opening: the answer that opened the tab is the one it shows', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    expect(reads()).toEqual([{ sessionId: ONE.record.id, target: 'README.md' }]);
    expect(within(panel()).getByRole('heading').textContent).toBe('Top');
    // And it is dropped from the store as it is taken: the text is the body's alone.
    expect(JSON.stringify(useTabs.getState())).not.toContain('Top');
  });

  it('reads again each time its tab is shown, by the path the tab holds, and shows what is there then', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    hold('src/tides.js', plain(SOURCE, SOURCE_TEXT));
    await open('README.md');
    await open('src/tides.js');
    files[README] = markdown(README, '# Changed on disk\n');
    fireEvent.click(tab('README.md'));
    await flush();
    expect(reads().at(-1)).toEqual({ sessionId: ONE.record.id, target: README });
    expect(within(panel()).getByRole('heading').textContent).toBe('Changed on disk');
    // Another session and back is a showing too.
    files[README] = markdown(README, '# Changed again\n');
    select(TWO);
    select(ONE);
    await flush();
    expect(within(panel()).getByRole('heading').textContent).toBe('Changed again');
    expect(reads().filter((request) => request.target === README)).toHaveLength(2);
  });

  it('reads again at Reload, and keeps what it shows until the answer is there', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    files[README] = markdown(README, '# Reloaded\n');
    withhold = true;
    fireEvent.click(within(panel()).getByRole('button', { name: FILE_WORDS.reload }));
    await flush();
    expect(within(panel()).getByRole('heading').textContent).toBe('Top');
    await act(async () => { for (const answer of waiting.splice(0)) answer(); await Promise.resolve(); });
    expect(within(panel()).getByRole('heading').textContent).toBe('Reloaded');
    expect(within(panel()).getByText('Reloaded seconds ago')).toBeTruthy();
    expect(reads()).toHaveLength(2);
  });

  it('holds only the shown tab’s text: another tab’s is nowhere in the page', async () => {
    const { container } = setup();
    hold('README.md', markdown(README, '# Top\n\nthe-readme-text-7f3a\n'));
    hold('src/tides.js', plain(SOURCE, 'the-source-text-7f3a\n'));
    await open('README.md');
    await open('src/tides.js');
    expect(container.textContent).toContain('the-source-text-7f3a');
    expect(container.textContent).not.toContain('the-readme-text-7f3a');
    expect(JSON.stringify(useTabs.getState())).not.toMatch(/the-(readme|source)-text-7f3a/);
    // No session shown: no file's text is held at all.
    act(() => { showState({ projects: [P], sessions: [ONE, TWO], selectedId: null }); });
    expect(container.textContent).toBe('');
    expect(JSON.stringify(useTabs.getState())).not.toMatch(/the-(readme|source)-text-7f3a/);
  });

  it('drops an answer for a tab that is no longer shown', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    hold('src/tides.js', plain(SOURCE, 'source\n'));
    await open('README.md');
    await open('src/tides.js');
    files[README] = markdown(README, '# Late\n\nthe-late-text-7f3a\n');
    withhold = true;
    fireEvent.click(tab('README.md'));
    await flush();
    // Before its read answers, the other tab is shown again.
    fireEvent.click(tab('tides.js'));
    await flush();
    await act(async () => { for (const answer of waiting.splice(0)) answer(); await Promise.resolve(); await Promise.resolve(); });
    expect(panel().textContent).toContain('source');
    expect(document.body.textContent).not.toContain('the-late-text-7f3a');
    expect(JSON.stringify(useTabs.getState())).not.toContain('the-late-text-7f3a');
  });

  it('shows the newer of two reads: an answer that comes after a later one was asked is dropped', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    withhold = true;
    files[README] = markdown(README, '# First\n');
    fireEvent.click(within(panel()).getByRole('button', { name: FILE_WORDS.reload }));
    files[README] = markdown(README, '# Second\n');
    fireEvent.click(within(panel()).getByRole('button', { name: FILE_WORDS.reload }));
    const [first, second] = waiting.splice(0);
    await act(async () => { second?.(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { first?.(); await Promise.resolve(); await Promise.resolve(); });
    expect(within(panel()).getByRole('heading').textContent).toBe('Second');
  });

  it('takes a reference to the file it shows in place of its text, without a read of its own', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    hold('README.md:3', markdown(README, '# Top\n\nA new last line.\n', { line: 3 }));
    await open('README.md:3');
    expect(panel().textContent).toContain('A new last line.');
    expect(reads().map((request) => request.target)).toEqual(['README.md', 'README.md:3']);
  });

  it('reads a tab that was opened with nothing read for it', async () => {
    setup();
    hold('x', markdown(README, '# Top\n'));
    act(() => { openTab(ONE.record.id, FILE_KIND, README); });
    await flush();
    expect(reads()).toEqual([{ sessionId: ONE.record.id, target: README }]);
    expect(within(panel()).getByRole('heading').textContent).toBe('Top');
  });
});

describe('Show in folder (C43)', () => {
  it('asks main to show the file the tab holds, naming its session', async () => {
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await open('README.md');
    await act(async () => { fireEvent.click(within(panel()).getByRole('button', { name: FILE_WORDS.showInFolder })); await Promise.resolve(); });
    expect(requests.at(-1)).toEqual(['files:showInFolder', { sessionId: ONE.record.id, path: README }]);
    expect(panel().textContent).not.toContain(FILE_WORDS.showFailed);
  });

  it('says for a moment that it could not, when main refuses, and announces it', async () => {
    vi.useFakeTimers();
    setup();
    hold('README.md', markdown(README, '# Top\n'));
    await act(async () => { await openReference(ONE.record.id, 'README.md'); });
    showFails = true;
    await act(async () => { fireEvent.click(within(panel()).getByRole('button', { name: FILE_WORDS.showInFolder })); await Promise.resolve(); await Promise.resolve(); });
    expect(within(panel()).getAllByRole('status').map((status) => status.textContent)).toContain(FILE_WORDS.showFailed);
    act(() => { vi.advanceTimersByTime(REFERENCE_SAID_MS); });
    expect(panel().textContent).not.toContain(FILE_WORDS.showFailed);
  });
});

// M20b (V9, V10; C45, C74, C75): a file's text is a source — a selection in it is reported with the
// file's real path and its lines — and the asides asked about the file are listed above the text.
describe('a file’s text as a source, and the asides asked about it (M20b, C45, C74)', () => {
  class FakeHighlight {
    readonly ranges: readonly Range[];
    constructor(...ranges: Range[]) { this.ranges = ranges; }
  }
  beforeEach(() => { Object.assign(globalThis, { CSS: { ...(globalThis as { CSS?: object }).CSS, highlights: new Map() }, Highlight: FakeHighlight }); });
  afterEach(() => { document.getSelection()?.removeAllRanges(); delete (globalThis as { Highlight?: unknown }).Highlight; });

  const NOTES = at('docs', 'notes.md');
  const NOTES_TEXT = '# Notes\n\nThe tide table lists high and low water.\n\nRead it each morning.\n';
  const scroller = () => panel().querySelector('[data-source-kind]') as HTMLElement;
  /** Selects `words` in the shown text, and answers what is reported of it. */
  function selected(words: string) {
    // (`Text` is this file's name for a read's answer: the DOM's text node is a `CharacterData` here.)
    const node = textNodes(scroller()).find((text) => text.data.includes(words)) as CharacterData;
    const range = document.createRange();
    range.setStart(node, node.data.indexOf(words));
    range.setEnd(node, node.data.indexOf(words) + words.length);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    return reportSelection(selection);
  }
  /** A marker of an aside about `words` of the shown file, at its real place in the drawing. */
  function about(id: string, words: string, path: string): AsideMarker {
    const whole = textNodes(scroller()).map((text) => text.data).join('');
    const start = whole.indexOf(words);
    return { id, title: words, createdAt: 1, running: false, source: { kind: 'file', itemId: null, role: null, part: null, workerId: null, path, lines: { first: 3, last: 4 }, range: { start, end: start + words.length }, digest: drawnDigest(words) } };
  }
  const row = () => within(panel()).queryByRole('group', { name: FILE_WORDS.asides });

  it('marks the text, and nothing else of the tab, as the file’s by its real path — in the Markdown view and in the plain one', async () => {
    setup();
    hold('docs/notes.md', markdown(NOTES, NOTES_TEXT));
    await open('docs/notes.md');
    expect(panel().querySelectorAll('[data-source-kind]')).toHaveLength(1);
    expect([scroller().getAttribute('data-source-kind'), scroller().getAttribute('data-source-path')]).toEqual(['file', NOTES]);
    // The line above the text is no part of the source: a selection of the path reports nothing.
    expect(scroller().contains(within(panel()).getByRole('button', { name: FILE_WORDS.reload }))).toBe(false);
    expect(selected('tide table')).toMatchObject({ kind: 'file', path: NOTES, itemId: null, lines: { first: 3, last: 4 }, excerpt: 'tide table' });

    hold('src/tides.js', plain(SOURCE, SOURCE_TEXT));
    await open('src/tides.js');
    expect([scroller().getAttribute('data-source-kind'), scroller().getAttribute('data-source-path')]).toEqual(['file', SOURCE]);
    expect(selected('line 12')).toMatchObject({ kind: 'file', path: SOURCE, lines: { first: 12, last: 12 }, excerpt: 'line 12' });
  });

  it('has no row for a file nothing was asked about, nor for the asides of another file', async () => {
    setup();
    hold('docs/notes.md', markdown(NOTES, NOTES_TEXT));
    await open('docs/notes.md');
    expect(row()).toBeNull();
    act(() => { setAsides(ONE.record.id, [about('aside-x', 'tide table', SOURCE)], { followUp: true, streamed: true, tools: 'read-only' }); });
    expect(row()).toBeNull();
    expect(paintedIn(scroller())).toEqual([]);
  });

  it('lists the file’s asides above the text, each a control titled as its tab, and paints each passage where it was selected', async () => {
    setup();
    hold('docs/notes.md', markdown(NOTES, NOTES_TEXT));
    await open('docs/notes.md');
    act(() => { setAsides(ONE.record.id, [about('aside-1', 'tide table', NOTES), about('aside-2', 'each morning', NOTES)], { followUp: true, streamed: true, tools: 'read-only' }); });
    expect(within(row() as HTMLElement).getAllByRole('button').map((button) => [button.textContent, button.title])).toEqual([['tide table', 'tide table'], ['each morning', 'each morning']]);
    // Under the line above the text, and before the text.
    expect((row() as HTMLElement).compareDocumentPosition(scroller()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(paintedIn(scroller()).map((entry) => [entry.asideId, entry.range.toString()])).toEqual([['aside-1', 'tide table'], ['aside-2', 'each morning']]);
    // The drawing is untouched: the passage is no element.
    expect(scroller().querySelector('mark')).toBeNull();
  });

  it('comes to a painted passage at its control’s press, and opens the aside’s tab where its passage is no longer there', async () => {
    setup();
    hold('docs/notes.md', markdown(NOTES, NOTES_TEXT));
    await open('docs/notes.md');
    const kept = about('aside-1', 'tide table', NOTES);
    const gone = { ...about('aside-2', 'each morning', NOTES), source: { ...(about('aside-2', 'each morning', NOTES).source as NonNullable<AsideMarker['source']>), digest: drawnDigest('as the file read before it was edited') } };
    act(() => { setAsides(ONE.record.id, [kept, gone], { followUp: true, streamed: true, tools: 'read-only' }); });
    expect(paintedIn(scroller()).map((entry) => entry.asideId)).toEqual(['aside-1']);
    // Both are listed: the list is the read's, by the source alone (C74).
    const [first, second] = within(row() as HTMLElement).getAllByRole('button') as [HTMLElement, HTMLElement];
    const seen: Element[] = [];
    const paragraph = [...scroller().querySelectorAll('p')].find((element) => element.textContent?.includes('tide table')) as HTMLElement;
    paragraph.scrollIntoView = function scrollIntoView(this: Element) { seen.push(this); };
    fireEvent.click(first);
    expect(seen).toEqual([paragraph]);
    expect(useTabs.getState().sessions[ONE.record.id]?.tabs.map((entry) => entry.kind)).toEqual([FILE_KIND]);
    // The file has changed under the second one's place: its tab is the way to it.
    fireEvent.click(second);
    expect(useTabs.getState().sessions[ONE.record.id]?.tabs.map((entry) => [entry.kind, entry.reference])).toEqual([[FILE_KIND, NOTES], [ASIDE_KIND, 'aside-2']]);
  });

  it.each(['manual', 'automatic'])('paints the markers again after a %s refresh: a passage that moved is no longer painted', async (mode) => {
    vi.useFakeTimers();
    setup();
    hold('docs/notes.md', markdown(NOTES, NOTES_TEXT));
    await open('docs/notes.md');
    act(() => { setAsides(ONE.record.id, [about('aside-1', 'tide table', NOTES)], { followUp: true, streamed: true, tools: 'read-only' }); });
    expect(paintedIn(scroller())).toHaveLength(1);
    hold('docs/notes.md', markdown(NOTES, `A new first line.\n\n${NOTES_TEXT}`));
    if (mode === 'automatic') {
      refreshAnswer = markdown(NOTES, `A new first line.\n\n${NOTES_TEXT}`);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    } else await act(async () => { fireEvent.click(within(panel()).getByRole('button', { name: FILE_WORDS.reload })); await Promise.resolve(); });
    await flush();
    expect(scroller().textContent).toContain('A new first line.');
    expect(paintedIn(scroller())).toEqual([]);
    // Its control stands, and is the way to the aside.
    expect(within(row() as HTMLElement).getAllByRole('button')).toHaveLength(1);
  });
});
