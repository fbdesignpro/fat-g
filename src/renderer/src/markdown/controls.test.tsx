// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, V22 (docs/planning/_archive/M19b.md; C16–C19, C24, C49, C50, C57, C58): a reference as a control. With
// no opener a text draws as M19 drew it; with one, a link whose address names a file or a site, a
// code span that reads as a path and a bare address are buttons that hand their address over. Each
// has a menu of its own on the right button: Open, Show in folder and Copy path, or Open link and Copy link.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFERENCE_MENU, REFERENCE_SAID_MS, REFERENCE_WORDS } from './controls';
import { MAX_ADDRESS_SHOWN, type OpenFailure, type Opener, OpenerContext, TabStopContext } from './inert';
import { MarkdownText } from './MarkdownText';

let opened: ([address: string, kind: string] | [address: string, kind: string, line: number])[];
/** What the menu's two local items were handed, in order. */
let placed: [item: 'show' | 'copyPath', address: string][];
let written: string[];
let answer: OpenFailure | null | 'throw';
const answered = (): Promise<OpenFailure | null> => (answer === 'throw' ? Promise.reject(new Error('no main')) : Promise.resolve(answer));
const opener = (platform = 'win32'): Opener => ({
  platform,
  open: (address, kind, line) => {
    // A line is there only where the words beside the reference said one (C65).
    opened.push(line === undefined ? [address, kind] : [address, kind, line]);
    return answered();
  },
  show: (address) => { placed.push(['show', address]); return answered(); },
  copyPath: (address) => { placed.push(['copyPath', address]); return answered(); },
});
beforeEach(() => {
  opened = [];
  placed = [];
  written = [];
  answer = null;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const drawWith = (text: string, given: Opener | null = opener(), stop = true) =>
  render(<TabStopContext value={stop}><OpenerContext value={given}><MarkdownText text={text} /></OpenerContext></TabStopContext>).container;
const controls = (root: Element) => [...root.querySelectorAll<HTMLButtonElement>('[data-reference] > button')];
const press = (button: Element) => act(async () => { fireEvent.click(button); await Promise.resolve(); await Promise.resolve(); });
/** What is drawn, but for the ids of its blocks. */
const drawn = (root: Element): string => root.innerHTML.replace(/ data-md-block="[^"]*"/g, '');

const MIXED = 'See [the guide](https://example.com/guide), [the notes](docs/notes.md), `src/tides.js:12`, `nextHighTide`, https://example.com/bare, <https://example.com/angle> and someone@example.com.';

describe('with no opener (C16)', () => {
  it('draws what M19 drew: a link as its text and address, a code span as code, a bare address as text', () => {
    const plain = render(<MarkdownText text={MIXED} />).container;
    expect(plain.textContent).toBe('See the guide (https://example.com/guide), the notes (docs/notes.md), src/tides.js:12, nextHighTide, https://example.com/bare, https://example.com/angle and someone@example.com.');
    expect(plain.querySelector('button, [data-reference], a')).toBeNull();
    // Given none through the context, it is the same DOM.
    expect(drawn(drawWith(MIXED, null))).toBe(drawn(plain));
  });
});

describe('with an opener (V10; C16–C19, C50)', () => {
  it('draws an external and a local link, a code span that reads as a path and a bare address as buttons, and nothing else', () => {
    const root = drawWith(MIXED);
    expect(controls(root).map((button) => [button.parentElement?.getAttribute('data-reference'), button.textContent])).toEqual([
      ['external', 'the guide (https://example.com/guide)'],
      ['local', 'the notes'],
      ['local', 'src/tides.js:12'],
      ['external', 'https://example.com/bare'],
      ['external', 'https://example.com/angle'],
    ]);
    for (const button of controls(root)) expect(button.getAttribute('type')).toBe('button');
    // A code span that is no path is code alone, and an email is the text it was.
    expect([...root.querySelectorAll('code')].map((code) => [code.textContent, code.closest('button') !== null])).toEqual([['src/tides.js:12', true], ['nextHighTide', false]]);
    expect(root.textContent).toContain('and someone@example.com.');
    expect(root.querySelector('a, [href]')).toBeNull();
  });

  it('gives each press its address and what it is, and opens nothing before a press', async () => {
    const root = drawWith(MIXED);
    expect(opened).toEqual([]);
    for (const button of controls(root)) await press(button);
    expect(opened).toEqual([
      ['https://example.com/guide', 'external'],
      ['docs/notes.md', 'local'],
      ['src/tides.js:12', 'local'],
      ['https://example.com/bare', 'external'],
      ['https://example.com/angle', 'external'],
    ]);
  });

  it.each([
    ['a script', '[x](javascript:alert(1))'],
    ['data', '[x](data:text/html,hi)'],
    ['mail', '[x](mailto:someone@example.com)'],
    ['a fragment alone', '[x](#usage)'],
    ['an unknown scheme', '[x](app://fatg/index.html)'],
    ['an empty address', '[x]()'],
  ])('leaves a link to %s the text it was', (_name, text) => {
    const root = drawWith(text);
    expect(controls(root)).toHaveLength(0);
    expect(drawn(root)).toBe(drawn(render(<MarkdownText text={text} />).container));
  });

  it('shows an external control’s address after its text where the two differ, cut at its bound, and holds the whole address in its tooltip', () => {
    const long = `https://example.com/${'a'.repeat(400)}`;
    const root = drawWith(`[site](https://example.com/x) [https://example.com/same](https://example.com/same) [long](${long})`);
    const [differs, same, cut] = controls(root);
    expect(differs?.textContent).toBe('site (https://example.com/x)');
    expect(differs?.title).toBe('https://example.com/x');
    expect(same?.textContent).toBe('https://example.com/same');
    expect(cut?.textContent).toBe(`long (${long.slice(0, MAX_ADDRESS_SHOWN)}…)`);
    expect(cut?.title).toBe(long);
  });

  it('adds the host as the URL parser spells it to the tooltip, where that is not what is written', () => {
    const root = drawWith('[bank](https://EXAMPLE.com/login) [idn](https://exämple.com/) [plain](https://example.com/a)');
    expect(controls(root).map((button) => button.title)).toEqual(['https://EXAMPLE.com/login (example.com)', 'https://exämple.com/ (xn--exmple-cua.com)', 'https://example.com/a']);
  });

  it('shows a local control’s text alone, with its address in its tooltip', () => {
    const root = drawWith('[the README](C:/proj/README.md) and `src/tides.js:12`');
    expect(controls(root).map((button) => [button.textContent, button.title])).toEqual([['the README', 'C:/proj/README.md'], ['src/tides.js:12', 'src/tides.js:12']]);
  });

  it('draws a bare URL and an address in angle brackets as controls that open in the browser, with no address repeated', async () => {
    const root = drawWith('See https://example.com/docs and www.example.org and <https://x.test>, or write to someone@example.com or <mailto:a@example.com>.');
    expect(root.textContent).toBe('See https://example.com/docs and www.example.org and https://x.test, or write to someone@example.com or mailto:a@example.com.');
    expect(controls(root).map((button) => button.textContent)).toEqual(['https://example.com/docs', 'www.example.org', 'https://x.test']);
    for (const button of controls(root)) await press(button);
    expect(opened).toEqual([['https://example.com/docs', 'external'], ['http://www.example.org', 'external'], ['https://x.test', 'external']]);
  });

  it('reads an address with the opener’s platform: a drive path is a file on Windows, and nothing elsewhere', () => {
    const text = '[a](C:/proj/a.md) [b](/home/me/b.md)';
    expect(controls(drawWith(text, opener('win32'))).map((button) => button.textContent)).toEqual(['a', 'b']);
    expect(controls(drawWith(text, opener('linux'))).map((button) => button.textContent)).toEqual(['b']);
  });

  it('draws a code span it reads as a path as a control drawn as code, and one it does not as code alone', () => {
    const paths = ['src/server.ts:42', './x', 'C:\\p\\a.md', '/etc/hosts', 'conf.d/x.conf', 'Makefile:12', 'C:\\Users\\A B\\a.md', 'README.md', 'package.json', 'main.py:10', 'console.log'];
    const code = ['process.env', 'module.exports', 'glm-5.3', 'example.com', 'example.com/x', '/chat/settings', 'localhost:3000', 'port:3000', 'TODO:12', 'a b.md', 'README'];
    const root = drawWith([...paths, ...code].map((text) => `\`${text}\``).join(' and '));
    expect(controls(root).map((button) => button.textContent)).toEqual(paths);
    for (const button of controls(root)) expect(button.firstElementChild?.tagName).toBe('CODE');
    expect([...root.querySelectorAll('code')].filter((element) => element.closest('button') === null).map((element) => element.textContent)).toEqual(code);
  });

  it('leaves a file’s name in plain prose the text it is', () => {
    const root = drawWith('The `field notes` folder is beside README.md and src/tides.js:12.');
    expect(controls(root)).toHaveLength(0);
  });

  it('draws controls in a heading, a list, a quote and a table’s cell as anywhere', () => {
    const root = drawWith('# `a.md`\n\n- `b.md`\n\n> `c.md`\n\n| file |\n| --- |\n| `d.md` |\n');
    expect(controls(root).map((button) => button.textContent)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    // And none in a code block: its text is code, never a reference.
    expect(controls(drawWith('```\nsrc/a.md\n```\n'))).toHaveLength(0);
  });
});

describe('a file’s name in bold or in italics (V24; C64)', () => {
  it('is a control where its whole text reads as a path, by the code span’s rule, still drawn as it was written', async () => {
    // Codex's answer about the folder with a space, and the two forms Claude Haiku answered with (V17).
    const root = drawWith('The `field notes` folder contains **harbour-log.md**. See **src/tides.js**, *docs/guide.md*, _lib/a.ts:4_ and **README.md** — a summary.');
    expect(controls(root).map((button) => [button.firstElementChild?.tagName, button.textContent, button.title])).toEqual([
      ['STRONG', 'harbour-log.md', 'harbour-log.md'],
      ['STRONG', 'src/tides.js', 'src/tides.js'],
      ['EM', 'docs/guide.md', 'docs/guide.md'],
      ['EM', 'lib/a.ts:4', 'lib/a.ts:4'],
      ['STRONG', 'README.md', 'README.md'],
    ]);
    for (const button of controls(root)) await press(button);
    expect(opened).toEqual([['harbour-log.md', 'local'], ['src/tides.js', 'local'], ['docs/guide.md', 'local'], ['lib/a.ts:4', 'local'], ['README.md', 'local']]);
    // What a copy takes is what was written: the words, in their place.
    expect(root.textContent).toBe('The field notes folder contains harbour-log.md. See src/tides.js, docs/guide.md, lib/a.ts:4 and README.md — a summary.');
  });

  it('leaves emphasis that reads as no path the emphasis it was', () => {
    const text = '**Important:** read **the notes**, *not* **process.env**, **glm-5.3**, **example.com**, **two words.md**, **localhost:3000** or **README**.';
    const root = drawWith(text);
    expect(controls(root)).toHaveLength(0);
    expect(drawn(root)).toBe(drawn(render(<MarkdownText text={text} />).container));
  });

  it('draws it as M19 drew it where there is no opener', () => {
    const text = 'See **src/tides.js** and *docs/guide.md*.';
    const plain = render(<MarkdownText text={text} />).container;
    expect(plain.querySelector('button, [data-reference]')).toBeNull();
    expect([...plain.querySelectorAll('strong, em')].map((element) => [element.tagName, element.className, element.textContent])).toEqual([['STRONG', '', 'src/tides.js'], ['EM', '', 'docs/guide.md']]);
    expect(drawn(drawWith(text, null))).toBe(drawn(plain));
  });

  it('makes one control where emphasis holds more than a name, or lies in another: the inmost that is a reference', async () => {
    const root = drawWith('**see `src/a.md`**, ***src/b.md***, **[the c](docs/c.md)** and **src/d.md is here**');
    expect(controls(root).map((button) => button.textContent)).toEqual(['src/a.md', 'src/b.md', 'the c']);
    expect(root.querySelector('button button')).toBeNull();
    for (const button of controls(root)) await press(button);
    expect(opened).toEqual([['src/a.md', 'local'], ['src/b.md', 'local'], ['docs/c.md', 'local']]);
  });

  it('is no control of its own inside a link’s text (C57)', async () => {
    const root = drawWith('[**src/tides.js**](https://example.com/real)');
    expect(root.querySelectorAll('button')).toHaveLength(1);
    expect(root.querySelector('button strong')?.textContent).toBe('src/tides.js');
    await press(controls(root)[0] as Element);
    expect(opened).toEqual([['https://example.com/real', 'external']]);
  });

  it('asks the file system nothing before a press: a product’s name that ends as a file’s does is a control that says so when pressed', async () => {
    answer = 'not-found';
    const root = drawWith('It runs on **Node.js**.');
    expect(controls(root).map((button) => button.textContent)).toEqual(['Node.js']);
    await press(controls(root)[0] as Element);
    expect(within(root).getByRole('status').textContent).toBe(REFERENCE_WORDS['not-found']);
  });

  it('is a stop in the tab order by the rule a code span’s control is (C58)', () => {
    expect(controls(drawWith('**src/a.md**', opener(), true)).map((button) => button.tabIndex)).toEqual([0]);
    expect(controls(drawWith('**src/a.md**', opener(), false)).map((button) => button.tabIndex)).toEqual([-1]);
  });
});

describe('a line said in words beside a reference (V24; C65)', () => {
  it('is where a press comes to: Claude Haiku’s answer, the name in bold and the line in bold after it', async () => {
    const root = drawWith('The `nextHighTide` function is defined in **src/tides.js** at **line 12**.');
    expect(controls(root).map((button) => [button.textContent, button.title])).toEqual([['src/tides.js', 'src/tides.js:12']]);
    await press(controls(root)[0] as Element);
    expect(opened).toEqual([['src/tides.js', 'local', 12]]);
    // The words stay the words they were.
    expect(root.textContent).toBe('The nextHighTide function is defined in src/tides.js at line 12.');
  });

  it.each([
    ['after a code span', 'See `src/tides.js` at line 12.', [['src/tides.js', 'local', 12]]],
    ['after a comma', 'See `src/tides.js`, line 12.', [['src/tides.js', 'local', 12]]],
    ['in brackets, the first of a range', 'See `src/tides.js` (lines 12–20).', [['src/tides.js', 'local', 12]]],
    ['with the line in bold', 'See *src/tides.js* on **line 12**.', [['src/tides.js', 'local', 12]]],
    ['with the number alone in bold', 'See `src/tides.js` at line **12**.', [['src/tides.js', 'local', 12]]],
    ['before it', 'It is on line 12 of `src/tides.js`.', [['src/tides.js', 'local', 12]]],
    ['before it, in bold', 'Look at **line 12** in **src/tides.js**.', [['src/tides.js', 'local', 12]]],
    ['outside the emphasis that holds a code span', '**`src/tides.js`** at line 12.', [['src/tides.js', 'local', 12]]],
    ['as a label on the next line', '**File:** `src/tides.js`  \n**Line:** 12', [['src/tides.js', 'local', 12]]],
    ['after a link whose address names none', '[the helpers](src/tides.js) at line 12.', [['src/tides.js', 'local', 12]]],
    ['each reference its own', '`a.js` line 3, `b.js` line 9.', [['a.js', 'local', 3], ['b.js', 'local', 9]]],
    ['the one that follows before the one that precedes', 'Line 3 of `a.js` at line 9.', [['a.js', 'local', 9]]],
    ['the words between two references the nearer one’s', '`a.js` and line 30 of `b.js`.', [['a.js', 'local'], ['b.js', 'local', 30]]],
  ] as const)('reads it %s', async (_name, text, expected) => {
    const root = drawWith(text);
    for (const button of controls(root)) await press(button);
    expect(opened).toEqual(expected);
  });

  it.each([
    ['a reference that names its line itself', 'See `src/tides.js:3` at line 12.', [['src/tides.js:3', 'local']]],
    ['words that say no line', '`a.js` has 12 lines, and its outline 4 is `b.js`.', [['a.js', 'local'], ['b.js', 'local']]],
    ['a line that another reference stands before', '`a.js` `b.js` at line 4.', [['a.js', 'local'], ['b.js', 'local', 4]]],
    ['a line in another paragraph', '`a.js`\n\nAt line 4 it starts.', [['a.js', 'local']]],
    ['a number that is no line’s', '`a.js` at line 0 and `b.js` at line 1,024.', [['a.js', 'local'], ['b.js', 'local']]],
    ['an address that opens in the browser', '[docs](https://example.com/a) at line 12.', [['https://example.com/a', 'external']]],
  ] as const)('reads none for %s', async (_name, text, expected) => {
    const root = drawWith(text);
    for (const button of controls(root)) await press(button);
    expect(opened).toEqual(expected);
  });

  it('follows a text as it is written: the line is there once its words are', async () => {
    const first = render(<TabStopContext value><OpenerContext value={opener()}><MarkdownText text={'Defined in **src/tides.js** at **line'} /></OpenerContext></TabStopContext>);
    expect(controls(first.container)[0]?.title).toBe('src/tides.js');
    first.rerender(<TabStopContext value><OpenerContext value={opener()}><MarkdownText text={'Defined in **src/tides.js** at **line 12**.'} /></OpenerContext></TabStopContext>);
    expect(controls(first.container)[0]?.title).toBe('src/tides.js:12');
    await press(controls(first.container)[0] as Element);
    expect(opened).toEqual([['src/tides.js', 'local', 12]]);
  });
});

describe('no control inside a control (V22; C57)', () => {
  it('draws a code span that reads as a path inside a link’s text as code alone, and a press gives the link’s one address', async () => {
    const root = drawWith('[`src/tides.js:12`](/C:/proj/src/tides.js:12)');
    expect(controls(root)).toHaveLength(1);
    expect(root.querySelectorAll('button')).toHaveLength(1);
    expect(root.querySelector('button button')).toBeNull();
    expect(root.querySelector('button code')?.textContent).toBe('src/tides.js:12');
    await press(controls(root)[0] as Element);
    expect(opened).toEqual([['/C:/proj/src/tides.js:12', 'local']]);
  });

  it('draws an address inside a link’s text as the text it is', async () => {
    const root = drawWith('[see https://other.example/x here](https://example.com/real)');
    expect(root.querySelectorAll('button')).toHaveLength(1);
    await press(controls(root)[0] as Element);
    expect(opened).toEqual([['https://example.com/real', 'external']]);
  });
});

describe('a control’s place in the tab order (V22; C58)', () => {
  const text = 'A [link](https://example.com), a `README.md` and https://example.com/bare.';

  it('is a stop where its text’s controls are stops: in a file, and in the chat’s current message', () => {
    expect(controls(drawWith(text, opener(), true)).map((button) => button.tabIndex)).toEqual([0, 0, 0]);
  });

  it('is no stop in a message that is not current, as a code block’s Copy button is none', () => {
    const root = drawWith(`${text}\n\n\`\`\`\ncode\n\`\`\`\n`, opener(), false);
    expect(controls(root).map((button) => button.tabIndex)).toEqual([-1, -1, -1]);
    expect(within(root).getByRole('button', { name: 'Copy code' }).tabIndex).toBe(-1);
  });
});

describe('a reference that did not open (V11; C24)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each(Object.keys(REFERENCE_WORDS) as OpenFailure[])('says “%s” in fat-g’s words beside it for a moment, and announces it', async (failure) => {
    answer = failure;
    const root = drawWith('Open `README.md` now.');
    const status = within(root).getByRole('status');
    expect(status.textContent).toBe('');
    await press(controls(root)[0] as Element);
    // Beside it, where it is read; and in a status region, where it is announced once.
    expect(root.textContent).toBe(`Open README.md ${REFERENCE_WORDS[failure]}${REFERENCE_WORDS[failure]} now.`);
    expect(status.textContent).toBe(REFERENCE_WORDS[failure]);
    expect(root.querySelector('[aria-hidden="true"]')?.textContent).toBe(` ${REFERENCE_WORDS[failure]}`);
    act(() => { vi.advanceTimersByTime(REFERENCE_SAID_MS - 1); });
    expect(status.textContent).toBe(REFERENCE_WORDS[failure]);
    act(() => { vi.advanceTimersByTime(1); });
    expect(status.textContent).toBe('');
    expect(root.textContent).toBe('Open README.md now.');
  });

  it('says nothing when it opened, and takes back what it said when a later press opens', async () => {
    const root = drawWith('Open `README.md` now.');
    await press(controls(root)[0] as Element);
    expect(screen.getByRole('status').textContent).toBe('');
    answer = 'not-found';
    await press(controls(root)[0] as Element);
    expect(screen.getByRole('status').textContent).toBe(REFERENCE_WORDS['not-found']);
    answer = null;
    await press(controls(root)[0] as Element);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('says it could not be opened when the opener itself fails', async () => {
    answer = 'throw';
    const root = drawWith('See https://example.com/x.');
    await press(controls(root)[0] as Element);
    expect(screen.getByRole('status').textContent).toBe(REFERENCE_WORDS.failed);
  });

  it('has words for each of the seven causes main names, and for an address main refused', () => {
    expect(Object.keys(REFERENCE_WORDS).sort()).toEqual(['failed', 'folder', 'no-answer', 'not-found', 'not-image', 'not-regular', 'outside', 'several']);
    for (const words of Object.values(REFERENCE_WORDS)) expect(words).toMatch(/^[A-Z].*\.$/);
  });
});

describe('a reference’s menu', () => {
  const menu = () => screen.queryByRole('menu', { name: REFERENCE_MENU.label });
  const items = () => within(menu() as HTMLElement).getAllByRole('menuitem').map((item) => item.textContent);
  const rightClick = (button: Element) => fireEvent.contextMenu(button, { button: 2, clientX: 40, clientY: 20 });
  const choose = (label: string) => act(async () => {
    fireEvent.click(within(menu() as HTMLElement).getByRole('menuitem', { name: label }));
    await Promise.resolve();
    await Promise.resolve();
  });

  it('opens on a local reference by the right button with Open, Show in folder and Copy path, and does nothing before a choice', () => {
    const root = drawWith('See `src/tides.js:12` and [the notes](docs/notes.md).');
    // The system's own menu is kept from showing.
    expect(rightClick(controls(root)[0] as Element)).toBe(false);
    expect(items()).toEqual([REFERENCE_MENU.open, REFERENCE_MENU.show, REFERENCE_MENU.copyPath]);
    expect([opened, placed, written]).toEqual([[], [], []]);
    // Opened by the pointer: no item is marked before the pointer is over one.
    expect(document.activeElement).toBe(menu());
  });

  it('hands each choice the reference’s address: Open with the line the words beside it said, Show in folder and Copy path to the opener', async () => {
    const root = drawWith('Defined in **src/tides.js** at **line 12**.');
    const control = controls(root)[0] as HTMLButtonElement;
    rightClick(control);
    await choose(REFERENCE_MENU.open);
    expect(opened).toEqual([['src/tides.js', 'local', 12]]);
    // The menu closes and the focus goes back to the control.
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(control);
    rightClick(control);
    await choose(REFERENCE_MENU.show);
    rightClick(control);
    await choose(REFERENCE_MENU.copyPath);
    expect(placed).toEqual([['show', 'src/tides.js'], ['copyPath', 'src/tides.js']]);
    expect(written).toEqual([]);
  });

  it('offers Open link and Copy link on an external reference, Copy link taking the address as written', async () => {
    const root = drawWith('See [the guide](https://example.com/guide).');
    rightClick(controls(root)[0] as Element);
    expect(items()).toEqual([REFERENCE_MENU.openLink, REFERENCE_MENU.copyLink]);
    await choose(REFERENCE_MENU.copyLink);
    expect(written).toEqual(['https://example.com/guide']);
    rightClick(controls(root)[0] as Element);
    await choose(REFERENCE_MENU.openLink);
    expect(opened).toEqual([['https://example.com/guide', 'external']]);
    expect(placed).toEqual([]);
  });

  it('says beside the reference what did not happen, as a press does', async () => {
    answer = 'outside';
    const root = drawWith('Open `README.md` now.');
    rightClick(controls(root)[0] as Element);
    await choose(REFERENCE_MENU.show);
    expect(within(root).getByRole('status').textContent).toBe(REFERENCE_WORDS.outside);
  });

  it('opens from the keyboard with its first item marked, and Escape hands the focus back', () => {
    const root = drawWith('See `src/tides.js:12`.');
    const control = controls(root)[0] as HTMLButtonElement;
    control.focus();
    fireEvent.contextMenu(control, { button: 0 });
    expect(document.activeElement?.textContent).toBe(REFERENCE_MENU.open);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe(REFERENCE_MENU.show);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(control);
  });

  it('closes on a press elsewhere, having done nothing', () => {
    const root = drawWith('See `src/tides.js:12`.');
    rightClick(controls(root)[0] as Element);
    fireEvent.pointerDown(document.body);
    expect(menu()).toBeNull();
    expect([opened, placed]).toEqual([[], []]);
  });

  it('lets none of its own events reach what holds the reference: a message or an activity’s row', async () => {
    const held = vi.fn();
    const root = render(<div onClick={held} onKeyDown={held}><OpenerContext value={opener()}><MarkdownText text={'See `src/tides.js:12`.'} /></OpenerContext></div>).container;
    rightClick(controls(root)[0] as Element);
    fireEvent.keyDown(menu() as HTMLElement, { key: 'ArrowDown' });
    await choose(REFERENCE_MENU.copyPath);
    expect(held).not.toHaveBeenCalled();
    expect(placed).toEqual([['copyPath', 'src/tides.js:12']]);
  });

  it('leaves a selection the reference lies in to the selection’s own menu', () => {
    const root = drawWith('Read `src/tides.js:12` first.');
    const range = document.createRange();
    range.selectNodeContents(root.querySelector('p') as HTMLElement);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    expect(rightClick(controls(root)[0] as Element)).toBe(true);
    expect(menu()).toBeNull();
    document.getSelection()?.removeAllRanges();
  });
});
