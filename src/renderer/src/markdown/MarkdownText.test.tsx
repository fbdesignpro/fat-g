// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V12 (docs/planning/_archive/M19.md; C28–C30, C34–C37, C61, C62): a text drawn as Markdown — every kind the
// sheet names as elements, what stays text, what a failure falls back to, and a late definition.
// The component is given a text and nothing else: no message, no turn and no session is here.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY_ANNOUNCED, COPY_WORDS } from '../ui/CopyButton';
import { TabStopContext } from './inert';
import { markdownFailures, MarkdownText } from './MarkdownText';
import * as parser from './parse';
import { CODE_LABEL, COPY_CODE, NOTES_LABEL, TABLE_LABEL } from './render';

let copied: string[];
beforeEach(() => {
  copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
});

const draw = (text: string) => render(<MarkdownText text={text} />).container;
const tags = (root: Element) => [...root.querySelectorAll('*')].map((element) => element.tagName.toLowerCase());
const selectionChanged = () => act(() => { document.dispatchEvent(new Event('selectionchange')); });

describe('every kind of Markdown, as elements (C29)', () => {
  it('draws headings of each level, by either syntax', () => {
    const root = draw('# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n\nSetext\n======\n\nLower\n-----');
    expect([...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) => `${heading.tagName}:${heading.textContent}`)).toEqual(['H1:One', 'H2:Two', 'H3:Three', 'H4:Four', 'H5:Five', 'H6:Six', 'H1:Setext', 'H2:Lower']);
  });

  it('draws emphasis, strong text, strikethrough, inline code and line breaks', () => {
    const root = draw('This has *emphasis*, **strong text**, ~~struck words~~ and `inline code`.  \nA second line.');
    expect(root.querySelector('em')?.textContent).toBe('emphasis');
    expect(root.querySelector('strong')?.textContent).toBe('strong text');
    expect(root.querySelector('del')?.textContent).toBe('struck words');
    expect(root.querySelector('code')?.textContent).toBe('inline code');
    expect(root.querySelectorAll('br')).toHaveLength(1);
    expect(root.querySelectorAll('p')).toHaveLength(1);
  });

  it('draws lists, ordered from where they start, and nested', () => {
    const root = draw('- one\n- two\n  - inner\n\n3. three\n4. four');
    const [bullets, inner] = root.querySelectorAll('ul');
    expect([...(bullets?.children ?? [])].map((item) => item.tagName)).toEqual(['LI', 'LI']);
    expect(inner?.textContent).toBe('inner');
    const ordered = root.querySelector('ol');
    expect(ordered?.getAttribute('start')).toBe('3');
    expect([...(ordered?.children ?? [])].map((item) => item.textContent)).toEqual(['three', 'four']);
  });

  it('draws a task list’s boxes as glyphs that say whether they are ticked, and no control', () => {
    const root = draw('- [x] done\n- [ ] not done');
    const boxes = within(root).getAllByRole('img');
    expect(boxes.map((box) => `${box.textContent}:${box.getAttribute('aria-label')}`)).toEqual(['☑:Done', '☐:To do']);
    expect(root.querySelector('input')).toBeNull();
    expect([...root.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['☑done', '☐not done']);
  });

  it('draws quotes, rules and tables, a table’s columns aligned as it says', () => {
    const root = draw('> quoted\n> text\n\n---\n\n| Name | Count | Note |\n| :--- | ---: | :---: |\n| a | 1 | x |\n| b | 2 | y |');
    expect(root.querySelector('blockquote')?.textContent).toBe('quoted\ntext');
    expect(root.querySelectorAll('hr')).toHaveLength(1);
    const table = root.querySelector('table');
    expect([...(table?.querySelectorAll('th') ?? [])].map((cell) => [cell.textContent, (cell as HTMLElement).style.textAlign])).toEqual([['Name', 'left'], ['Count', 'right'], ['Note', 'center']]);
    expect([...(table?.querySelectorAll('tbody tr') ?? [])].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))).toEqual([['a', '1', 'x'], ['b', '2', 'y']]);
  });

  it('draws a fenced and an indented code block as text in `pre` and `code`, with the fence’s language as a label (C34)', () => {
    const root = draw('```js\nconst a = 1 < 2 && "x";\n```\n\n    indented <b>code</b>\n\n~~~\nplain\n~~~');
    const blocks = [...root.querySelectorAll('pre')];
    expect(blocks.map((block) => block.querySelector('code')?.textContent)).toEqual(['const a = 1 < 2 && "x";', 'indented <b>code</b>', 'plain']);
    expect(blocks.map((block) => block.getAttribute('aria-label'))).toEqual([`${CODE_LABEL}: js`, CODE_LABEL, CODE_LABEL]);
    expect(blocks[0]?.parentElement?.textContent).toContain('js');
    // Nothing is coloured: a code block's text is one text node.
    expect(blocks[0]?.querySelector('code')?.children).toHaveLength(0);
  });

  it('decodes character references in text, and leaves them as written in code', () => {
    const root = draw('AT&amp;T &copy; &#35; &bogus; `&amp;`\n\n```\n&lt;tag&gt;\n```');
    expect(root.querySelector('p')?.textContent).toBe('AT&T © # &bogus; &amp;');
    expect(root.querySelector('pre code')?.textContent).toBe('&lt;tag&gt;');
  });
});

describe('what stays text (C31–C33, C61)', () => {
  it('draws raw HTML, block and inline, as the text it is', () => {
    const root = draw('Raw <b>bold</b> and <img src=x onerror=alert(1)>.\n\n<div onclick="alert(1)">a block of HTML</div>');
    expect(root.textContent).toContain('<b>bold</b>');
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(root.textContent).toContain('<div onclick="alert(1)">a block of HTML</div>');
    expect(root.querySelector('b, img, [onclick], [onerror]')).toBeNull();
  });

  it('draws a link as its text with its address after it where the two differ, and never as an anchor', () => {
    const root = draw('A [named link](https://example.com/page "Title"), an [https://example.com/x](https://example.com/x).');
    expect(root.textContent).toBe('A named link (https://example.com/page), an https://example.com/x.');
    expect(root.querySelector('a, [href]')).toBeNull();
  });

  it('draws a bare URL, an address in angle brackets and an email as inert text, with no address repeated', () => {
    const root = draw('See https://example.com/docs and www.example.org and <https://x.test>, or write to someone@example.com.');
    expect(root.textContent).toBe('See https://example.com/docs and www.example.org and https://x.test, or write to someone@example.com.');
    expect(root.querySelector('a, [href]')).toBeNull();
  });

  it('draws an image as its alternative text and its address, as text: no `img`, a `data:` image included (C32)', () => {
    const root = draw('An image ![alt text](https://example.com/a.png) and ![dot](data:image/png;base64,iVBORw0KGgo=) and ![](https://example.com/b.png).');
    expect(root.textContent).toBe('An image alt text (https://example.com/a.png) and dot (data:image/png;base64,iVBORw0KGgo=) and Image (https://example.com/b.png).');
    expect(root.querySelector('img, [src]')).toBeNull();
  });

  // M102, V17 (C27, C28): fat-g's own media route is an address like any other in a message.
  it('draws an image or a link naming an avatar’s media address as text: no `img`, no link', () => {
    const address = `app://media/avatars/${'0'.repeat(32)}`;
    const root = draw(`A face ![face](${address}) and [a link](${address}) and ${address}.`);
    expect(root.textContent).toContain(`face (${address})`);
    expect(root.textContent).toContain('a link');
    expect(root.querySelector('img, [src], a, [href]')).toBeNull();
  });

  it('cuts a very long address where it is drawn: the source is not changed by it', () => {
    const address = `data:image/png;base64,${'A'.repeat(5000)}`;
    const root = draw(`![big](${address})`);
    expect(root.textContent?.length).toBeLessThan(300);
    expect(root.textContent?.endsWith('…)')).toBe(true);
  });

  it('draws footnotes as numbered marks and a numbered list of notes, with no link and no way back (C61)', () => {
    const root = draw('Tides vary[^a] and bells ring[^b]. Tides again[^a].\n\n[^b]: The second note, with *emphasis*.\n\n[^a]: Done');
    // Numbered in the order they are first referred to, whatever the order of their definitions.
    expect([...root.querySelectorAll('sup')].map((mark) => mark.textContent)).toEqual(['1', '2', '1']);
    const notes = within(root).getByRole('list', { name: NOTES_LABEL });
    expect([...notes.querySelectorAll('li')].map((note) => `${note.getAttribute('value')}:${note.textContent}`)).toEqual(['1:Done', '2:The second note, with emphasis.']);
    expect(notes.querySelector('em')?.textContent).toBe('emphasis');
    expect(root.querySelector('a, [href], [id^="fn"]')).toBeNull();
    // The definitions draw nothing where they stand.
    expect(root.querySelector('p')?.textContent).toBe('Tides vary1 and bells ring2. Tides again1.');
    expect(root.querySelectorAll('p')).toHaveLength(1);
  });

  it('leaves a reference to a note nothing defines as it was written, and draws no note nothing refers to', () => {
    const root = draw('A note[^missing] here.\n\n[^unused]: Never referred to.');
    expect(root.querySelector('p')?.textContent).toBe('A note[^missing] here.');
    expect(root.querySelector('sup, ol')).toBeNull();
    expect(root.textContent).not.toContain('Never referred to');
  });
});

describe('a text as far as it goes (C36)', () => {
  it('draws an unclosed fence as a code block to the end: nothing is closed or guessed ahead of the text', () => {
    const root = draw('Before.\n\n```js\nconst a = 1;\n**not strong**');
    expect(root.querySelector('pre code')?.textContent).toBe('const a = 1;\n**not strong**');
    expect(root.querySelector('strong')).toBeNull();
    // Unclosed emphasis is the text it is.
    expect(draw('An *unclosed emphasis').textContent).toBe('An *unclosed emphasis');
  });

  it('draws an empty text as nothing', () => {
    expect(draw('').textContent).toBe('');
  });
});

describe('a late definition (C61)', () => {
  it('updates the blocks that name it when it arrives, and leaves every other block’s element as it is', () => {
    const before = 'Read [the guide][g] first, and note the tide[^t].\n\nA second paragraph that names nothing.\n\n';
    const view = render(<MarkdownText text={before} />);
    const [first, second] = view.container.querySelectorAll('p');
    expect(first?.textContent).toBe('Read [the guide][g] first, and note the tide[^t].');

    view.rerender(<MarkdownText text={`${before}[g]: https://example.com/guide "Guide"\n\n[^t]: The tide note.\n`} />);
    const [firstNow, secondNow] = view.container.querySelectorAll('p');
    expect(firstNow?.textContent).toBe('Read the guide (https://example.com/guide) first, and note the tide1.');
    // The same elements: React patched the one, and never touched the other.
    expect(firstNow).toBe(first);
    expect(secondNow).toBe(second);
    expect(within(view.container).getByRole('list', { name: NOTES_LABEL }).textContent).toBe('The tide note.');
  });

  it('waits while the reader’s selection touches the block, also after the pointer is released, and applies once the selection moves off it', () => {
    const before = 'Read [the guide][g] first.\n\nAnother paragraph.\n\n';
    const after = `${before}[g]: https://example.com/guide\n`;
    const view = render(<MarkdownText text={before} />);
    const [first, second] = view.container.querySelectorAll('p');
    if (first === undefined || second === undefined) throw new Error('no paragraphs');
    act(() => { window.getSelection()?.selectAllChildren(first); });
    selectionChanged();
    expect(window.getSelection()?.toString()).toBe('Read [the guide][g] first.');

    view.rerender(<MarkdownText text={after} />);
    // The selected block keeps its DOM, and the selection its text.
    expect(first.textContent).toBe('Read [the guide][g] first.');
    expect(window.getSelection()?.toString()).toBe('Read [the guide][g] first.');
    fireEvent.pointerUp(first);
    expect(first.textContent).toBe('Read [the guide][g] first.');

    // The selection moves to another block: the first takes its latest drawing.
    act(() => { window.getSelection()?.selectAllChildren(second); });
    selectionChanged();
    expect(view.container.querySelector('p')?.textContent).toBe('Read the guide (https://example.com/guide) first.');
    // Cleared, nothing more changes.
    act(() => { window.getSelection()?.removeAllRanges(); });
    selectionChanged();
    expect(view.container.querySelector('p')?.textContent).toBe('Read the guide (https://example.com/guide) first.');
  });

  it('never makes a block whose own text grew wait for the selection', () => {
    const view = render(<MarkdownText text="A paragraph that is being" />);
    const paragraph = view.container.querySelector('p');
    if (paragraph === null) throw new Error('no paragraph');
    act(() => { window.getSelection()?.selectAllChildren(paragraph); });
    selectionChanged();
    view.rerender(<MarkdownText text="A paragraph that is being written." />);
    expect(view.container.querySelector('p')?.textContent).toBe('A paragraph that is being written.');
  });
});

describe('a text that cannot be drawn (C37)', () => {
  it('is drawn whole as plain text when the lexer throws, and the failure is counted', () => {
    const before = markdownFailures();
    vi.spyOn(parser, 'parse').mockImplementation(() => { throw new Error('lexer: infinite loop'); });
    const text = '# Not a heading now\n\n**kept**  as   typed';
    const root = draw(text);
    expect(root.querySelector('p')?.textContent).toBe(text);
    expect(root.querySelector('h1, strong')).toBeNull();
    expect(markdownFailures()).toBe(before + 1);
  });

  it('is drawn whole as plain text when the renderer throws, and drawn as Markdown again once its text changes', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = parser.parse;
    const named = { links: {}, notes: new Map<string, number>() };
    const broken = { type: 'paragraph', raw: 'x', get tokens(): never { throw new Error('renderer: bad token'); } };
    // A token the renderer cannot read, for the first text alone.
    vi.spyOn(parser, 'parse').mockImplementation((text) => (text.includes('first') ? { blocks: [{ index: 0, source: 'x', signature: 'x', named, token: broken, firstLine: 1, lastLine: 1 }], notes: [], notesSignature: '', named } : real(text)));
    const before = markdownFailures();
    const view = render(<MarkdownText text="**first** text" />);
    expect(view.container.textContent).toBe('**first** text');
    expect(view.container.querySelector('strong')).toBeNull();
    expect(markdownFailures()).toBeGreaterThan(before);
    // No text of the message is in what was logged.
    expect(JSON.stringify(errors.mock.calls.map((call) => call.map(String)))).not.toContain('first');

    view.rerender(<MarkdownText text="**second** text" />);
    expect(view.container.querySelector('strong')?.textContent).toBe('second');
  });
});

describe('a code block’s Copy button (C38, C39)', () => {
  it('copies the block’s code without its fence, and says that it did', async () => {
    const root = draw('Run this:\n\n```sh\nnpm run check\nnpm test\n```\n\nThen:\n\n```\nsecond\n```');
    const [first, second] = within(root).getAllByRole('button', { name: COPY_CODE });
    expect(first?.textContent).toBe(COPY_WORDS.copy);
    await act(async () => { first?.click(); await Promise.resolve(); });
    expect(copied).toEqual(['npm run check\nnpm test']);
    expect(first?.textContent).toBe(COPY_WORDS.copied);
    expect(within(root).getAllByRole('status').map((status) => status.textContent)).toContain(COPY_ANNOUNCED.copied);
    await act(async () => { second?.click(); await Promise.resolve(); });
    expect(copied).toEqual(['npm run check\nnpm test', 'second']);
  });

  it('says that it could not, when the clipboard refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } });
    const root = draw('```\ncode\n```');
    const button = within(root).getByRole('button', { name: COPY_CODE });
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(button.textContent).toBe(COPY_WORDS.failed);
    expect(within(root).getByRole('status').textContent).toBe(COPY_ANNOUNCED.failed);
  });
});

describe('what scrolls sideways (C35)', () => {
  /** A layout in which every scroller is as wide as `width` and 300 wide in its place. */
  function withLayout(width: number): void {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly changed: () => void) {}
      observe(): void { this.changed(); }
      disconnect(): void { /* nothing is held */ }
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
  }
  const wide = '```\n' + 'x'.repeat(500) + '\n```\n\n| a | b |\n|--|--|\n| 1 | 2 |';

  it('makes a code block and a table that are wider than their place stops for the keyboard, each named', () => {
    withLayout(900);
    const root = draw(wide);
    const pre = root.querySelector('pre');
    const table = within(root).getByLabelText(TABLE_LABEL);
    expect(pre?.tabIndex).toBe(0);
    expect(table.tabIndex).toBe(0);
    expect(table.querySelector('table')).not.toBeNull();
  });

  it('makes neither a stop while it fits, nor in a text whose controls are no stops', () => {
    withLayout(300);
    expect([...draw(wide).querySelectorAll('pre, [aria-label="Table"]')].map((element) => (element as HTMLElement).tabIndex)).toEqual([-1, -1]);
    cleanup();
    vi.restoreAllMocks();
    withLayout(900);
    const { container } = render(<TabStopContext value={false}><MarkdownText text={wide} /></TabStopContext>);
    expect([...container.querySelectorAll('pre, [aria-label="Table"]')].map((element) => (element as HTMLElement).tabIndex)).toEqual([-1, -1]);
    expect(within(container).getByRole('button', { name: COPY_CODE }).tabIndex).toBe(-1);
  });
});

describe('the component itself (C62)', () => {
  it('draws a text given with no message, turn or session, and nothing but elements of its fixed list', () => {
    const root = draw('# A file\n\nSome *text*, a [link](https://example.com) and `code`.\n\n- [ ] a task\n\n| a |\n|--|\n| 1 |\n\n```js\nx\n```');
    expect(new Set(tags(root))).toEqual(new Set(['div', 'h1', 'p', 'em', 'span', 'code', 'ul', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'button']));
    expect(screen.queryByRole('link')).toBeNull();
  });
});
