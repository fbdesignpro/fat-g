// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V21 (docs/planning/_archive/M20b.md; C45, C75): a selection's report — the source it lies in, its
// text, its lines where the drawing carries them, and its place in the drawn text with the digest
// of what is drawn there — on what the page really draws: a message, a prompt, an activity's
// output, and a file's two views.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { drawnDigest, MAX_EXCERPT } from '@shared/contracts/aside';
import type { ConversationItem } from '@shared/contracts/conversation';
import { MarkdownText } from '../markdown/MarkdownText';
import { chatItem } from '../test/chat';
import { AsideSourceContext } from './ExplainControl';
import { Message } from './Message';
import { activitySource, fileSource, LINES_HOLDER, messageSource, readSource, reportBlock, reportSelection, sourceAttributes, sourceRoot } from './selection-report';

const S = '11111111-1111-4111-8111-111111111111';
afterEach(() => { document.getSelection()?.removeAllRanges(); cleanup(); });

const scope = { sessionId: S, workerId: null };
const show = (...items: ConversationItem[]) => render(
  <AsideSourceContext value={scope}>
    {items.map((item) => <Message key={item.id} item={item} modelName="GPT-6 Sol" providerName="Codex" />)}
  </AsideSourceContext>,
);

/** The text node under `root` that holds `words`. */
function textOf(root: ParentNode, words: string): Text {
  const walker = document.createTreeWalker(root, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if ((node as Text).data.includes(words)) return node as Text;
  throw new Error(`nothing drawn holds ${words}`);
}
/** Selects from the start of `from` to the end of `to`, as a drag would, and answers the report. */
function select(root: ParentNode, from: string, to: string = from) {
  const range = document.createRange();
  const start = textOf(root, from);
  const end = textOf(root, to);
  range.setStart(start, start.data.indexOf(from));
  range.setEnd(end, end.data.indexOf(to) + to.length);
  const selection = document.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);
  return reportSelection(selection);
}

const ANSWER = ['# Tides', '', 'The tide table lists **high** and low water.', 'It is read each morning.', '', '- one item', '- another item', '', 'A last paragraph.'].join('\n');

describe('a selection in an assistant’s message (C45, C75)', () => {
  it('reports its source, its text and the lines of the block it lies in', () => {
    const item = chatItem(S, 'assistant', ANSWER, { id: 'answer-1' });
    const view = show(item);
    const report = select(view.container, 'tide table lists');
    expect(report).toMatchObject({ kind: 'message', itemId: 'answer-1', role: 'assistant', part: null, workerId: null, path: null });
    expect(report?.excerpt).toBe('tide table lists');
    expect(report?.cut).toBe(false);
    // The paragraph is lines 3 and 4 of the message's source, and the blank line after it is its own, by the drawing's marks (M19b, C41).
    expect(report?.lines).toEqual({ first: 3, last: 5 });
    expect(report?.digest).toBe(drawnDigest('tide table lists'));
  });

  it('reports two selections inside one paragraph with the same lines, each with its own text, place and digest', () => {
    const view = show(chatItem(S, 'assistant', ANSWER, { id: 'answer-1' }));
    const first = select(view.container, 'tide table');
    const second = select(view.container, 'each morning');
    expect(first?.lines).toEqual({ first: 3, last: 5 });
    expect(second?.lines).toEqual(first?.lines);
    expect([first?.excerpt, second?.excerpt]).toEqual(['tide table', 'each morning']);
    expect(second?.range.start).toBeGreaterThan(first?.range.end ?? Infinity);
    expect(second?.digest).not.toBe(first?.digest);
  });

  it('reports one across inline elements whole, and one across blocks from the first block’s first line to the last block’s last', () => {
    const view = show(chatItem(S, 'assistant', ANSWER, { id: 'answer-1' }));
    const inline = select(view.container, 'lists ', ' and low');
    expect(inline?.excerpt).toBe('lists high and low');
    expect(inline?.lines).toEqual({ first: 3, last: 5 });
    expect((inline?.range.end ?? 0) - (inline?.range.start ?? 0)).toBe('lists high and low'.length);
    const across = select(view.container, 'Tides', 'another item');
    expect(across?.lines).toEqual({ first: 1, last: 8 });
    expect(across?.range.start).toBe(0);
    expect(across?.excerpt).toContain('Tides');
    expect(across?.excerpt).toContain('another item');
  });

  it('counts a control’s own words for nothing: the place is the same with Explain this beside each block', () => {
    const view = show(chatItem(S, 'assistant', ANSWER, { id: 'answer-1' }));
    const body = view.container.querySelector('[data-source-kind]') as Element;
    const bare = select(view.container, 'last paragraph');
    // The same text drawn with no control at all: a file's Markdown, under a source of its own.
    cleanup();
    const plain = render(<div {...sourceAttributes(fileSource('C:\\project\\notes.md'))}><MarkdownText text={ANSWER} /></div>);
    const again = select(plain.container, 'last paragraph');
    expect(again?.range).toEqual(bare?.range);
    expect(again?.digest).toBe(bare?.digest);
    expect(body.getAttribute('data-source-kind')).toBe('message');
  });

  it('cuts a selection past its bound, and says so', () => {
    const long = 'x'.repeat(MAX_EXCERPT + 50);
    const view = show(chatItem(S, 'assistant', long, { id: 'answer-1' }));
    const report = select(view.container, long);
    expect(report?.excerpt).toHaveLength(MAX_EXCERPT);
    expect(report?.cut).toBe(true);
    // Its place is the whole selection's all the same: what is painted is what was selected.
    expect((report?.range.end ?? 0) - (report?.range.start ?? 0)).toBe(long.length);
  });
});

describe('a selection in a prompt and in an activity’s text (C45, C47)', () => {
  it('reports a prompt’s by its item and role, with no lines: it is drawn as the text it is', () => {
    const view = show(chatItem(S, 'user', 'look at src/notes_1.txt\nand *this* line', { id: 'prompt-1' }));
    const report = select(view.container, 'and *this*');
    expect(report).toMatchObject({ kind: 'message', itemId: 'prompt-1', role: 'user', lines: null, excerpt: 'and *this*' });
    expect(report?.range).toEqual({ start: 'look at src/notes_1.txt\n'.length, end: 'look at src/notes_1.txt\nand *this*'.length });
  });

  it('reports an activity’s output by its item and its part, with no lines', () => {
    const view = render(<pre {...sourceAttributes(activitySource('activity-1', 'output', null))}><code>first line{'\n'}second line</code></pre>);
    const report = select(view.container, 'second');
    expect(report).toMatchObject({ kind: 'activity', itemId: 'activity-1', part: 'output', role: null, lines: null, excerpt: 'second' });
    expect(report?.range).toEqual({ start: 11, end: 17 });
  });

  it('reports a worker’s message under its worker', () => {
    const view = render(
      <AsideSourceContext value={{ sessionId: S, workerId: 'worker-1' }}>
        <Message item={chatItem(S, 'assistant', 'A worker said this.', { id: 'w-item', workerId: 'worker-1' })} modelName="GPT-6 Sol" providerName="Codex" />
      </AsideSourceContext>,
    );
    expect(select(view.container, 'worker said')).toMatchObject({ kind: 'message', itemId: 'w-item', workerId: 'worker-1' });
  });

  it('has none for a notice, which is fat-g’s own words, nor for anything drawn without a source', () => {
    const view = show(chatItem(S, 'notice', 'The turn failed.', { notice: 'turn-failed' }));
    expect(view.container.querySelector('[data-source-kind]')).toBeNull();
    expect(select(view.container, 'turn failed')).toBeNull();
    cleanup();
    // The same message outside a source's scope — an aside's own tab (C40) — marks nothing.
    const bare = render(<Message item={chatItem(S, 'assistant', 'An answer.')} modelName="GPT-6 Sol" providerName="Codex" />);
    expect(bare.container.querySelector('[data-source-kind]')).toBeNull();
    expect(select(bare.container, 'answer')).toBeNull();
  });
});

describe('a selection in a file (C45)', () => {
  const PATH = 'C:\\project\\docs\\tides.md';

  it('reports the real path and the lines of the blocks it touches, in the Markdown view', () => {
    const view = render(<div {...sourceAttributes(fileSource(PATH))}><MarkdownText text={ANSWER} /></div>);
    const report = select(view.container, 'one item', 'another');
    expect(report).toMatchObject({ kind: 'file', path: PATH, itemId: null, role: null, part: null });
    expect(report?.lines).toEqual({ first: 6, last: 8 });
    expect(select(view.container, 'read each')?.lines).toEqual({ first: 3, last: 5 });
    // The last block has no blank line after it.
    expect(select(view.container, 'last paragraph')?.lines).toEqual({ first: 9, last: 9 });
  });

  it('reports the view’s own lines in the plain view: each line it touches, and not the one it ends at the start of', () => {
    const lines = ['alpha', 'beta', 'gamma', 'delta'];
    const view = render(<div {...sourceAttributes(fileSource(PATH))}><div {...{ [LINES_HOLDER]: '' }}>{lines.map((line) => <div key={line}>{line}</div>)}</div></div>);
    expect(select(view.container, 'beta')).toMatchObject({ kind: 'file', path: PATH, lines: { first: 2, last: 2 }, excerpt: 'beta' });
    expect(select(view.container, 'eta', 'gam')?.lines).toEqual({ first: 2, last: 3 });
    // A drag down to the very start of the next line touches the lines above it alone.
    const holder = view.container.querySelector(`[${LINES_HOLDER}]`) as Element;
    const range = document.createRange();
    range.setStart(textOf(view.container, 'alpha'), 0);
    range.setEnd(holder.children[2] as Element, 0);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(reportSelection(selection)?.lines).toEqual({ first: 1, last: 2 });
  });
});

describe('a selection with no one source (C45)', () => {
  it('has no report across two messages, across a message and a file, when it is empty, or when its text is blank', () => {
    const view = show(chatItem(S, 'assistant', 'The first answer.', { id: 'a1' }), chatItem(S, 'assistant', 'The second answer.', { id: 'a2' }));
    expect(select(view.container, 'first', 'second')).toBeNull();
    const file = render(<div {...sourceAttributes(fileSource('C:\\project\\a.txt'))}><p>file text</p></div>);
    const range = document.createRange();
    range.setStart(textOf(view.container, 'first'), 0);
    range.setEnd(textOf(file.container, 'file text'), 4);
    const selection = document.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(reportSelection(selection)).toBeNull();
    selection.removeAllRanges();
    expect(reportSelection(selection)).toBeNull();
    expect(reportSelection(null)).toBeNull();
    // Inside one source, and nothing but white space.
    cleanup();
    const blank = render(<pre {...sourceAttributes(activitySource('a', 'output', null))}>one{'   \n   '}two</pre>);
    const spaces = document.createRange();
    const node = textOf(blank.container, '   ');
    spaces.setStart(node, 0);
    spaces.setEnd(node, 3);
    selection.addRange(spaces);
    expect(reportSelection(selection)).toBeNull();
  });
});

describe('what marks a source', () => {
  it('reads back the attributes it wrote, and nothing from an element that says less than a whole source', () => {
    for (const source of [messageSource('i1', 'assistant', null), messageSource('i2', 'user', 'w1'), activitySource('a1', 'input', null), activitySource('a2', 'output', 'w2'), fileSource('/home/someone/notes.md')]) {
      const element = document.createElement('div');
      for (const [name, value] of Object.entries(sourceAttributes(source))) element.setAttribute(name, value);
      expect(readSource(element)).toEqual(source);
    }
    const partial = document.createElement('div');
    partial.setAttribute('data-source-kind', 'message');
    expect(readSource(partial)).toBeNull();
    partial.setAttribute('data-source-item', 'i1');
    expect(readSource(partial)).toBeNull();
    partial.setAttribute('data-source-kind', 'plan');
    expect(readSource(partial)).toBeNull();
    expect(sourceRoot(null)).toBeNull();
  });
});

describe('a block’s report (C46)', () => {
  it('is the block’s source text by its lines, and its own span of the drawn text', () => {
    const view = show(chatItem(S, 'assistant', ANSWER, { id: 'answer-1' }));
    const blocks = [...view.container.querySelectorAll('[data-md-block]')];
    const paragraph = blocks.find((block) => block.textContent?.startsWith('The tide table')) as Element;
    const report = reportBlock(paragraph, ANSWER);
    // The source, with its Markdown: what the model wrote, and not what was drawn of it.
    expect(report?.excerpt).toBe('The tide table lists **high** and low water.\nIt is read each morning.');
    // Its lines are its marks', with the blank line after it; the text sent has no blank line at either end.
    expect(report?.lines).toEqual({ first: 3, last: 5 });
    expect(report).toMatchObject({ kind: 'message', itemId: 'answer-1', role: 'assistant' });
    // Its place is the drawn block's: what is painted for it is the block as drawn.
    const drawn = paragraph.textContent ?? '';
    expect((report?.range.end ?? 0) - (report?.range.start ?? 0)).toBe(drawn.length);
    expect(report?.digest).toBe(drawnDigest(drawn));
    const list = blocks.find((block) => block.tagName === 'UL') as Element;
    expect(reportBlock(list, ANSWER)).toMatchObject({ lines: { first: 6, last: 8 }, excerpt: '- one item\n- another item' });
    // An element that is no block of a source has none.
    expect(reportBlock(document.createElement('p'), ANSWER)).toBeNull();
  });
});
