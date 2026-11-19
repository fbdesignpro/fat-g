// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V28 (docs/planning/_archive/M19.md; C61, C65–C67): what a text draws depends on the text alone, never on
// the pieces it arrived in. A text given unit by unit, in a provider's captured deltas and whole
// draws the same elements; an update keeps the nodes of every block whose source it leaves alone;
// and a late definition named in a table's cell draws that row again and no other.
//
// Compared at every update with a fresh `MarkdownText` of the text so far: every unit of the corpus,
// and every delta of the two providers' captured Markdown answers. The fixture's three long streams
// (C52) are compared at a sample of their updates and at their end, for the running time: a fresh
// drawing of a 100,000-unit table at each of four hundred updates is minutes in jsdom.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import claudeMarkdown from '../../../../tests/fixtures/claude/captures/m19-markdown.json';
import codexMarkdown from '../../../../tests/fixtures/codex/captures/m19-markdown.json';
import { LATE, PROBES, streamText, STREAMS } from '../../../../tests/fixtures/conversations/long-conversation.mjs';
import { type Opener, OpenerContext } from './inert';
import { MarkdownText } from './MarkdownText';
import { NOTES_LABEL } from './render';
import { LINE_OFFSETS_ATTRIBUTE, linePart } from './selection';

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

/**
 * What is drawn, but for each block's id, which is its component's own. Each block's lines (M19b,
 * C41) are written after its drawing, so they are taken out of the markup, where only their place
 * among the attributes could differ, and compared after it, block by block.
 */
const drawn = (root: Element): string => {
  const lines = [...root.querySelectorAll('[data-md-block]')].map((block) => block.getAttribute('data-md-lines') ?? 'none');
  return `${root.innerHTML.replace(/ data-md-(?:block|lines)="[^"]*"/g, '')}
lines: ${lines.join(' ')}`;
};
/** A fresh reading of `text`: a component that never saw another. */
function fresh(text: string): string {
  const view = render(<MarkdownText text={text} />);
  const html = drawn(view.container);
  view.unmount();
  return html;
}
/** `text` given in `pieces` to one component, compared with a fresh reading wherever `compare` says. */
function stream(pieces: readonly string[], compare: (update: number) => boolean = () => true): { readonly container: HTMLElement; readonly rerender: (text: string) => void } {
  const view = render(<MarkdownText text="" />);
  let text = '';
  for (const [update, piece] of pieces.entries()) {
    text += piece;
    view.rerender(<MarkdownText text={text} />);
    if (compare(update)) expect(drawn(view.container), `after ${text.length} units`).toBe(fresh(text));
  }
  return { container: view.container, rerender: (next) => view.rerender(<MarkdownText text={next} />) };
}
const units = (text: string): string[] => [...text].flatMap((character) => character.split(''));
const chunks = (text: string, size: number): string[] => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));

/** Texts in which a later line changes what an earlier one is. */
const CORPUS: readonly (readonly [name: string, text: string])[] = [
  ['hard breaks separating items within a paragraph', '**Content**\\\nC56. Before.  \nC12. With *emphasis* and `code`.\\\nC58. After.\n'],
  ['a line that turns out to continue the paragraph before it', 'hello\n#tag and more\n\nA second paragraph.'],
  ['the same after a quote', '> a quote\n#tag\n\nAfter.'],
  ['the same after a list item', '- an item\n#tag\n- another\n\nAfter.'],
  ['the same after a table’s row', '| a | b |\n| --- | --- |\n| 1 | 2 |\n#tag\n\nAfter.'],
  ['a rule that turns out to be emphasis', 'A paragraph.\n***strong and emphasised*** words.\n\n---\n\nA real rule above.'],
  ['a fence that turns out to be inline code', 'A paragraph.\n```code``` inline, and then:\n\n```js\nreal();\n```\n'],
  ['a setext heading that arrives under its text', 'A title\n=======\n\nBody text\n---\n\nMore.'],
  ['a definition’s title read across blocks', '[foo]: /url\n"a title\n\n# with a heading in it\n\nthat ends here"\n\nSee [foo].'],
  ['a definition’s label read across lines', 'See [a long\nlabel] here.\n\n[a long\nlabel]: /url "t"\n'],
  ['emphasis, strong text, strikethrough and code that close late', 'Some **strong text**, *emphasis*, ~~struck~~ and `code` in one paragraph, and an [inline link](https://example.com).'],
  ['a nested list', '- one\n  - inner one\n    - innermost\n  - inner two\n- two\n\n1. first\n2. second\n'],
  ['a task list', '- [x] done\n- [ ] not done\n- plain\n'],
  ['a table that grows', '| Name | Count |\n| :--- | ---: |\n| one | 1 |\n| two | 2 |\n| three | 3 |\n\nAfter the table.'],
  ['a note defined after it is referred to', 'Tides vary[^a] and bells ring[^b]. Tides again[^a].\n\n[^b]: The second.\n\n[^a]: The first note.\n'],
  ['a link defined after it is referred to', `${LATE.before}${LATE.after}`],
  ['an unclosed fence', PROBES.unclosedFence],
  ['raw HTML and a reference', PROBES.rawHtml],
  ['bare URLs', PROBES.bareUrl],
  ['an image and a data image', PROBES.image],
  ['a quote that holds a list and code', '> A quote with\n> - a list\n> - of two\n>\n> ```\n> and code\n> ```\n\nAfter.'],
];

describe('a text’s pieces (V28; C66)', () => {
  it.each(CORPUS)('%s: given unit by unit, it draws at every unit what the text so far draws whole', (_name, text) => {
    const view = stream(units(text));
    // A completion with the same text changes nothing: not a node.
    const before = [...view.container.querySelectorAll('*')];
    view.rerender(text);
    expect([...view.container.querySelectorAll('*')]).toEqual(before);
    expect(drawn(view.container)).toBe(fresh(text));
  });

  it('draws a provider’s captured answer the same at every delta as the text so far draws whole: Codex’s 840 deltas', () => {
    const deltas = (codexMarkdown as { frames: { dir: string; frame: { method?: string; params?: { delta?: string } } }[] }).frames
      .flatMap((entry) => (entry.dir === 'recv' && entry.frame.method === 'item/agentMessage/delta' && typeof entry.frame.params?.delta === 'string' ? [entry.frame.params.delta] : []));
    expect(deltas).toHaveLength(840);
    const view = stream(deltas);
    expect(view.container.querySelector('pre code')).not.toBeNull();
    expect(view.container.querySelector('table')).not.toBeNull();
  });

  it('and Claude’s 267', () => {
    type Frame = { dir: string; frame: { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } } } };
    const deltas = (claudeMarkdown as { frames: Frame[] }).frames
      .flatMap((entry) => (entry.dir === 'recv' && entry.frame.type === 'stream_event' && entry.frame.event?.delta?.type === 'text_delta' && typeof entry.frame.event.delta.text === 'string' ? [entry.frame.event.delta.text] : []));
    expect(deltas).toHaveLength(267);
    const view = stream(deltas);
    expect(view.container.querySelector('pre code')).not.toBeNull();
    expect(view.container.querySelector('table')).not.toBeNull();
  });

  it.each(STREAMS)('draws the fixture’s %s stream, in the pieces a push brings, as its text so far draws whole', (kind) => {
    const text = streamText(kind);
    const pieces = chunks(text, 250);
    // Sampled: the first updates, every fortieth after them, and the last.
    const view = stream(pieces, (update) => update < 4 || update % 40 === 0 || update === pieces.length - 1);
    expect(drawn(view.container)).toBe(fresh(text));
  }, 120_000);
});

describe('what an update leaves alone (V28; C65)', () => {
  it('keeps the nodes of every block whose source it leaves alone: only the last block is drawn again as its text grows', () => {
    const head = '# A heading\n\nA first paragraph, complete.\n\n- a list\n- of two items\n\n```js\nconst code = 1;\n```\n\n';
    const tail = 'The last paragraph, which is still being written, a few units at a time, until it is whole.';
    const view = render(<MarkdownText text={head} />);
    const root = view.container.firstElementChild;
    if (root === null) throw new Error('nothing drawn');
    for (const piece of ['T', ...chunks(tail.slice(1), 7)].reduce<string[]>((texts, part) => [...texts, (texts.at(-1) ?? head) + part], [])) {
      const before = [...root.children];
      const inner = before.map((child) => [...child.querySelectorAll('*')]);
      view.rerender(<MarkdownText text={piece} />);
      const after = [...root.children];
      // Every earlier block: the same element, and every element in it the same.
      for (const [index, child] of before.slice(0, 4).entries()) {
        expect(after[index]).toBe(child);
        expect([...child.querySelectorAll('*')]).toEqual(inner[index]);
      }
      expect(after.at(-1)?.textContent).toBe(piece.slice(head.length));
    }
  });

  it('draws an earlier block again only where the new text changes where it ends', () => {
    const view = render(<MarkdownText text={'A first paragraph.\n\nhello\n#'} />);
    const root = view.container.firstElementChild;
    if (root === null) throw new Error('nothing drawn');
    const [first, hello, heading] = root.children;
    expect([hello?.tagName, heading?.tagName]).toEqual(['P', 'H1']);
    view.rerender(<MarkdownText text={'A first paragraph.\n\nhello\n#tag'} />);
    // The heading that was is part of the paragraph now; the paragraph before them never changed.
    expect([...root.children].map((child) => child.tagName)).toEqual(['P', 'P']);
    expect(root.children[0]).toBe(first);
    expect(root.children[1]?.textContent).toBe('hello\n#tag');
  });
});

describe('a late definition named in a table’s cell (V28; C61, C67)', () => {
  const TABLE = '| Station | Note |\n| --- | --- |\n| North | plain |\n| East | see [guide] |\n| South | noted[^n] |\n| West | plain too |\n\n';
  const rows = (root: Element) => [...root.querySelectorAll('tbody tr')];
  /** The rows in which anything was changed by what `work` did. */
  function changedRows(root: Element, work: () => void): number[] {
    const observer = new MutationObserver(() => undefined);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    work();
    const records = observer.takeRecords();
    observer.disconnect();
    const all = rows(root);
    return [...new Set(records.map((record) => all.findIndex((row) => row.contains(record.target))))].filter((index) => index !== -1).sort();
  }

  it('draws that row again, as a link and as a note’s mark, and no other row', () => {
    const view = render(<MarkdownText text={TABLE} />);
    const before = rows(view.container);
    expect(before.map((row) => row.textContent)).toEqual(['Northplain', 'Eastsee [guide]', 'Southnoted[^n]', 'Westplain too']);

    expect(changedRows(view.container, () => { view.rerender(<MarkdownText text={`${TABLE}[guide]: https://example.com/guide\n`} />); })).toEqual([1]);
    expect(rows(view.container)[1]?.textContent).toBe('Eastsee guide (https://example.com/guide)');

    expect(changedRows(view.container, () => { view.rerender(<MarkdownText text={`${TABLE}[guide]: https://example.com/guide\n\n[^n]: The note.\n`} />); })).toEqual([2]);
    expect(rows(view.container)[2]?.textContent).toBe('Southnoted1');
    expect(view.container.querySelector(`[aria-label="${NOTES_LABEL}"]`)?.textContent).toBe('The note.');
    // The rows themselves are the elements they were.
    expect(rows(view.container)).toEqual(before);
    expect(drawn(view.container)).toBe(fresh(`${TABLE}[guide]: https://example.com/guide\n\n[^n]: The note.\n`));
  });

  it('waits while the selection touches the table, as one block with its rows, and applies once the selection has moved off it', () => {
    const text = `Before the table.\n\n${TABLE}`;
    const later = `${text}[guide]: https://example.com/guide\n`;
    const view = render(<MarkdownText text={text} />);
    const cell = rows(view.container)[0]?.querySelector('td');
    const paragraph = view.container.querySelector('p');
    if (cell === null || cell === undefined || paragraph === null) throw new Error('no cell');
    // The selection is in another row than the one the definition changes: the table waits whole.
    act(() => { window.getSelection()?.selectAllChildren(cell); document.dispatchEvent(new Event('selectionchange')); });
    expect(changedRows(view.container, () => { view.rerender(<MarkdownText text={later} />); })).toEqual([]);
    expect(rows(view.container)[1]?.textContent).toBe('Eastsee [guide]');
    expect(window.getSelection()?.toString()).toBe('North');

    act(() => { window.getSelection()?.selectAllChildren(paragraph); document.dispatchEvent(new Event('selectionchange')); });
    expect(rows(view.container)[1]?.textContent).toBe('Eastsee guide (https://example.com/guide)');
    expect(drawn(view.container)).toBe(fresh(later));
  });

  it('draws a row again when its own text changes, whatever is selected', () => {
    const view = render(<MarkdownText text={'| a |\n| --- |\n| one |\n| tw'} />);
    const [first, second] = rows(view.container);
    if (first === undefined || second === undefined) throw new Error('no rows');
    act(() => { window.getSelection()?.selectAllChildren(first); document.dispatchEvent(new Event('selectionchange')); });
    expect(changedRows(view.container, () => { view.rerender(<MarkdownText text={'| a |\n| --- |\n| one |\n| two |'} />); })).toEqual([1]);
    expect(rows(view.container)[1]?.textContent).toBe('two');
    expect(rows(view.container)[0]).toBe(first);
  });
});

// ── M19b ──────────────────────────────────────────────────────────────────────────────────────
// V10, V22 (docs/planning/_archive/M19b.md; C16, C41): an opener given to a text that is being written redraws
// no block, and each block carries the lines of its source through every update.
describe('an opener given to a streaming text (M19b: V10; C16)', () => {
  const opener: Opener = { platform: 'win32', open: () => Promise.resolve(null), show: () => Promise.resolve(null), copyPath: () => Promise.resolve(null) };
  const head = '# A heading\n\nSee `src/tides.js:12` and [the guide](https://example.com/guide).\n\n- a list\n- of two items\n\n';
  const tail = 'The last paragraph, which is still being written, with `README.md` in it, until it is whole.';

  it('keeps the nodes of every block whose source an update leaves alone, its controls among them', () => {
    const draw = (text: string) => <OpenerContext value={opener}><MarkdownText text={text} /></OpenerContext>;
    const view = render(draw(head));
    const root = view.container.firstElementChild;
    if (root === null) throw new Error('nothing drawn');
    expect(root.querySelectorAll('[data-reference] > button')).toHaveLength(2);
    for (const text of chunks(tail, 9).reduce<string[]>((texts, part) => [...texts, (texts.at(-1) ?? head) + part], [])) {
      const before = [...root.children].slice(0, 3);
      const inner = before.map((child) => [...child.querySelectorAll('*')]);
      view.rerender(draw(text));
      for (const [index, child] of before.entries()) {
        expect(root.children[index]).toBe(child);
        expect([...child.querySelectorAll('*')]).toEqual(inner[index]);
      }
    }
    expect(root.querySelectorAll('[data-reference] > button')).toHaveLength(3);
  });

  it('draws no block again when the chat is drawn again with the same opener: its value is one for the session', () => {
    const Chat = ({ tick }: { readonly tick: number }) => <OpenerContext value={opener}><p data-tick={tick} /><MarkdownText text={head} /></OpenerContext>;
    const view = render(<Chat tick={1} />);
    const before = [...view.container.querySelectorAll('*')];
    view.rerender(<Chat tick={2} />);
    expect([...view.container.querySelectorAll('*')]).toEqual(before);
  });

  it('draws a text the same at every unit with an opener as the text so far draws whole with one', () => {
    const draw = (text: string) => <OpenerContext value={opener}><MarkdownText text={text} /></OpenerContext>;
    const text = `${head}${tail}\n\n| file | where |\n| --- | --- |\n| \`a.md\` | <https://example.com/a> |\n`;
    const view = render(draw(''));
    let so = '';
    for (const unit of units(text)) {
      so += unit;
      view.rerender(draw(so));
      const whole = render(draw(so));
      expect(drawn(view.container), `after ${so.length} units`).toBe(drawn(whole.container));
      whole.unmount();
    }
  });
});

describe('a block’s lines through every update (M19b: V22; C41)', () => {
  const lines = (root: Element) => [...root.querySelectorAll('[data-md-block]')].map((block) => `${block.tagName} ${block.getAttribute('data-md-lines')}`);

  it('locates hard-break-separated passages through leading blank lines, soft wraps and an earlier block gaining lines', () => {
    const passage = '**Content**\\\nC56. Before.\nStill before.  \nC12. With `code`.\\\nC58. After.\n';
    const view = render(<MarkdownText text={`\n\n${passage}`} />);
    const block = view.container.querySelector('p') as Element;
    const c12 = linePart(block, 6);
    expect(c12.textContent).toBe('C12. With code.');
    expect(linePart(block, 4).textContent).toBe('C56. Before.\nStill before.');
    expect(linePart(block, 5)).toBe(linePart(block, 4));
    expect(linePart(block, 7).textContent).toBe('C58. After.');

    // These offsets are local to the block: its unchanged DOM stays as it was when earlier lines shift.
    view.rerender(<MarkdownText text={`First.\n\n${passage}`} />);
    const held = view.container.querySelectorAll('p')[1] as Element;
    const parts = [...held.querySelectorAll(`[${LINE_OFFSETS_ATTRIBUTE}]`)];
    view.rerender(<MarkdownText text={`First.\nAnother line.\n\n${passage}`} />);
    expect(view.container.querySelectorAll('p')[1]).toBe(held);
    expect([...held.querySelectorAll(`[${LINE_OFFSETS_ATTRIBUTE}]`)]).toEqual(parts);
    expect(linePart(held, 7).textContent).toBe('C12. With code.');
  });

  it('carries the first and last line of its source on each top-level block, and on nothing else', () => {
    const view = render(<MarkdownText text={'# Title\n\nA paragraph\nof two lines.\n\n- one\n- two\n\n```js\ncode();\n```\n\n| a |\n| - |\n| 1 |\n\n> quoted\n'} />);
    expect(lines(view.container)).toEqual(['H1 1-2', 'P 3-5', 'UL 6-8', 'DIV 9-12', 'DIV 13-16', 'BLOCKQUOTE 17-17']);
    expect(view.container.querySelectorAll('[data-md-lines]')).toHaveLength(6);
    // A block that draws nothing has no element: a definition's lines are no block's.
    const defined = render(<MarkdownText text={'See [a].\n\n[a]: /x\n\nAfter.\n'} />);
    expect(lines(defined.container)).toEqual(['P 1-2', 'P 5-5']);
  });

  it('keeps them right as a text streams: a line that turns out to continue the paragraph before it', () => {
    const view = render(<MarkdownText text="" />);
    const steps: [text: string, expected: string[]][] = [
      ['First.\n\nhello', ['P 1-2', 'P 3-3']],
      ['First.\n\nhello\n', ['P 1-2', 'P 3-3']],
      ['First.\n\nhello\n#', ['P 1-2', 'P 3-3', 'H1 4-4']],
      ['First.\n\nhello\n#tag', ['P 1-2', 'P 3-4']],
      ['First.\n\nhello\n#tag\n\nLast.', ['P 1-2', 'P 3-5', 'P 6-6']],
    ];
    const first = () => view.container.querySelector('[data-md-block]');
    let held: Element | null = null;
    for (const [text, expected] of steps) {
      view.rerender(<MarkdownText text={text} />);
      expect(lines(view.container), JSON.stringify(text)).toEqual(expected);
      // The first block's source never changes: it is the element it was.
      if (held !== null) expect(first()).toBe(held);
      held = first();
    }
  });

  it('shifts every later block’s lines when an earlier block gains one, with no unchanged block’s nodes replaced', () => {
    const before = 'One.\n\nTwo, with `README.md`.\n\n```\nthree\n```\n\nFour.\n';
    const after = 'One.\nAnd a second line.\nAnd a third.\n\nTwo, with `README.md`.\n\n```\nthree\n```\n\nFour.\n';
    const view = render(<MarkdownText text={before} />);
    expect(lines(view.container)).toEqual(['P 1-2', 'P 3-4', 'DIV 5-8', 'P 9-9']);
    const blocks = [...view.container.querySelectorAll('[data-md-block]')];
    const inner = blocks.map((block) => [...block.querySelectorAll('*')]);
    const observer = new MutationObserver(() => undefined);
    observer.observe(view.container, { subtree: true, childList: true, characterData: true, attributes: true });
    view.rerender(<MarkdownText text={after} />);
    const changed = observer.takeRecords().filter((record) => record.type !== 'attributes').map((record) => record.target);
    observer.disconnect();

    expect(lines(view.container)).toEqual(['P 1-4', 'P 5-6', 'DIV 7-10', 'P 11-11']);
    const now = [...view.container.querySelectorAll('[data-md-block]')];
    // Every block is the element it was, and no later block had a node added, removed or rewritten.
    expect(now).toEqual(blocks);
    for (const [index, block] of now.entries()) {
      if (index === 0) continue;
      expect([...block.querySelectorAll('*')]).toEqual(inner[index]);
      expect(changed.filter((node) => block.contains(node))).toEqual([]);
    }
  });

  it('writes nothing when nothing changed: the same text again touches no attribute', () => {
    const text = 'One.\n\nTwo.\n';
    const view = render(<MarkdownText text={text} />);
    const observer = new MutationObserver(() => undefined);
    observer.observe(view.container, { subtree: true, attributes: true, childList: true, characterData: true });
    view.rerender(<MarkdownText text={`${text}`} />);
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });
});
