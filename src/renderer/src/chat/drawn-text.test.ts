// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V21 (docs/planning/_archive/M20b.md; C75): a source's drawn text as one run of characters — where a
// boundary lies in it, the range two offsets name, and the digest that says the text between them
// is still what was selected.
import { afterEach, describe, expect, it } from 'vitest';
import { drawnDigest } from '@shared/contracts/aside';
import { CHROME_ATTRIBUTE, drawnBetween, offsetOf, placeOf, rangeAt, rangeOf, rangesAt, textNodes } from './drawn-text';

afterEach(() => { document.body.replaceChildren(); });

/** A source drawn from markup: its root is the element returned. */
function draw(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
const textOf = (root: Element, text: string): Text => {
  const found = textNodes(root).find((node) => node.data.includes(text));
  if (found === undefined) throw new Error(`no text node holds ${text}`);
  return found;
};
/** A range from a place in one text to a place in another, each named by words the text holds. */
function between(root: Element, from: string, to: string): Range {
  const range = document.createRange();
  const start = textOf(root, from);
  const end = textOf(root, to);
  range.setStart(start, start.data.indexOf(from));
  range.setEnd(end, end.data.indexOf(to) + to.length);
  return range;
}

describe('the drawn text (C75)', () => {
  it('is the source’s text nodes in order, a control’s own words counting for nothing', () => {
    const root = draw(`<p>One <strong>two</strong> three.</p><button ${CHROME_ATTRIBUTE}="">Explain this</button><pre><button data-copy="">Copy</button><code>four</code></pre><p>five</p>`);
    expect(textNodes(root).map((node) => node.data)).toEqual(['One ', 'two', ' three.', 'four', 'five']);
    expect(drawnBetween(root, 0, 1000)).toBe('One two three.fourfive');
    // A Copy button's words change when it is pressed: the text after it stays where it was.
    const before = offsetOf(root, textOf(root, 'four'), 0);
    (root.querySelector('[data-copy]') as HTMLElement).textContent = 'Copied';
    expect(offsetOf(root, textOf(root, 'four'), 0)).toBe(before);
    expect(before).toBe('One two three.'.length);
  });

  it('gives a boundary inside one text node, across inline elements and across two blocks its offset', () => {
    const root = draw('<p>The <em>quick</em> brown <code>fox</code>.</p><p>It <strong>jumps</strong> over.</p>');
    // Inside one text node.
    expect(placeOf(root, between(root, 'brown', 'brown'))?.range).toEqual({ start: 10, end: 15 });
    // Across inline elements.
    const inline = placeOf(root, between(root, 'quick', 'fox'));
    expect(inline?.range).toEqual({ start: 4, end: 19 });
    expect(drawnBetween(root, 4, 19)).toBe('quick brown fox');
    // Across two blocks.
    const blocks = placeOf(root, between(root, 'fox', 'jumps'));
    expect(blocks?.range).toEqual({ start: 16, end: 28 });
    expect(drawnBetween(root, 16, 28)).toBe('fox.It jumps');
    expect(blocks?.digest).toBe(drawnDigest('fox.It jumps'));
  });

  it('reads a boundary in an element as the start of the text that follows, and one past the last child as the element’s end', () => {
    const root = draw('<p>alpha</p><p>beta</p><p>gamma</p>');
    const [first, second] = [...root.children] as [Element, Element];
    expect(offsetOf(root, root, 0)).toBe(0);
    expect(offsetOf(root, root, 1)).toBe(5);
    expect(offsetOf(root, root, 3)).toBe(14);
    expect(offsetOf(root, second, 0)).toBe(5);
    expect(offsetOf(root, second, 1)).toBe(9);
    // A whole block, as the control beside one reports it.
    const whole = document.createRange();
    whole.selectNodeContents(second);
    expect(placeOf(root, whole)).toEqual({ range: { start: 5, end: 9 }, digest: drawnDigest('beta') });
    expect(offsetOf(root, first.firstChild as Node, 99)).toBe(5);
  });

  it('gives no place to a boundary outside the source, to an empty range, or to one that runs backwards', () => {
    const root = draw('<p>inside</p>');
    const other = draw('<p>outside</p>');
    expect(offsetOf(root, other.firstChild as Node, 0)).toBeNull();
    const across = document.createRange();
    across.setStart(textOf(root, 'inside'), 1);
    across.setEnd(textOf(other, 'outside'), 2);
    expect(placeOf(root, across)).toBeNull();
    const empty = document.createRange();
    empty.setStart(textOf(root, 'inside'), 2);
    empty.setEnd(textOf(root, 'inside'), 2);
    expect(placeOf(root, empty)).toBeNull();
  });

  it('makes the range two offsets name: its start in the node that holds the first character, never at the end of the one before', () => {
    const root = draw('<p>One <strong>two</strong> three.</p><p>four</p>');
    const range = rangeAt(root, 4, 7);
    expect(range?.toString()).toBe('two');
    expect(range?.startContainer).toBe(textOf(root, 'two'));
    expect(range?.startOffset).toBe(0);
    expect(rangeAt(root, 2, 16)?.toString()).toBe('e two three.fo');
    // Where the text is shorter than the offsets say, there is none.
    expect(rangeAt(root, 4, 400)).toBeNull();
    expect(rangeAt(root, 400, 401)).toBeNull();
    expect(rangeAt(root, 7, 4)).toBeNull();
  });

  it('gives a passage as one range, and as the ranges around a control’s own words where one stands inside it', () => {
    const plain = draw('<p>One <strong>two</strong> three.</p><p>four</p>');
    expect(rangesAt(plain, 2, 16).map((range) => range.toString())).toEqual(['e two three.fo']);
    // A code block as it is drawn: its label, its Copy button, its code. The button is inside the passage, and in no range of it.
    const code = draw('<p>Before.</p><div><span>js</span><button data-copy="">Copy</button><pre><code>const a = 1;</code></pre></div><p>After.</p>');
    const whole = rangesAt(code, 'Before.'.length, 'Before.jsconst a = 1;'.length);
    expect(whole.map((range) => range.toString())).toEqual(['js', 'const a = 1;']);
    expect(whole.some((range) => range.intersectsNode(code.querySelector('[data-copy]') as Element))).toBe(false);
    // A passage that begins after the control is one range, and one that ends before it is one too.
    expect(rangesAt(code, 'Before.js'.length + 6, 'Before.jsconst a = 1;After'.length).map((range) => range.toString())).toEqual(['a = 1;After']);
    expect(rangesAt(code, 2, 'Before.js'.length).map((range) => range.toString())).toEqual(['fore.js']);
    // Together they are the drawn text between the offsets, whatever stands between them.
    expect(whole.map((range) => range.toString()).join('')).toBe(drawnBetween(code, 'Before.'.length, 'Before.jsconst a = 1;'.length));
    // Where the text is shorter than the offsets say, or they name nothing, there is none.
    expect(rangesAt(plain, 4, 400)).toEqual([]);
    expect(rangesAt(plain, 7, 7)).toEqual([]);
    expect(rangesAt(plain, 7, 4)).toEqual([]);
  });

  it('finds a place again only while the drawn text between its offsets has its digest', () => {
    const root = draw('<p>The tide turns at noon.</p><p>The tide turns at noon.</p>');
    // A passage that occurs twice is found where it was selected: the second, by its offsets.
    const second = document.createRange();
    const node = textNodes(root)[1] as Text;
    second.setStart(node, 4);
    second.setEnd(node, 14);
    const place = placeOf(root, second);
    expect(place).toEqual({ range: { start: 27, end: 37 }, digest: drawnDigest('tide turns') });
    const found = rangeOf(root, place as NonNullable<typeof place>);
    expect(found?.startContainer).toBe(node);
    expect(found?.toString()).toBe('tide turns');
    // The text before it changed: what is at the offsets is no longer what was selected, and nothing is found.
    (textNodes(root)[0] as Text).data = 'The tide turned at noon.';
    expect(rangeOf(root, place as NonNullable<typeof place>)).toBeNull();
    // An empty place, and a digest that was never the text's, find nothing.
    expect(rangeOf(root, { range: { start: 3, end: 3 }, digest: drawnDigest('') })).toBeNull();
    expect(rangeOf(root, { range: { start: 0, end: 3 }, digest: '00000000' })).toBeNull();
  });

  it('changes nothing of the DOM: finding a place and making a range add no node and no attribute', () => {
    const root = draw('<p>One <strong>two</strong> three.</p>');
    const before = root.innerHTML;
    const place = placeOf(root, between(root, 'two', 'three'));
    rangeOf(root, place as NonNullable<typeof place>);
    rangeAt(root, 0, 5);
    expect(root.innerHTML).toBe(before);
  });
});
