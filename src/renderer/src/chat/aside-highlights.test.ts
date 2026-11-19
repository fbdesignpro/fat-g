// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, V21 (docs/planning/_archive/M20b.md; C74, C75): an aside's passage painted where it was selected —
// its range made from its marker's two offsets, registered under one name, only while the drawn
// text between them has the marker's digest — and a press found by where the pointer is. jsdom has
// no CSS Custom Highlight API: a registry and a maker stand in for the platform's, and the real
// ones are the smoke run's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AsideMarker, drawnDigest } from '@shared/contracts/aside';
import { asideAt, HIGHLIGHT_NAME, paintAsides, paintedIn, showPassage, unpaintAsides } from './aside-highlights';
import { placeOf, textNodes } from './drawn-text';

class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: Range[]) { this.ranges = ranges; }
}
let registry: Map<string, FakeHighlight>;
const roots: Element[] = [];

beforeEach(() => {
  registry = new Map();
  Object.assign(globalThis, { CSS: { ...(globalThis as { CSS?: object }).CSS, highlights: registry }, Highlight: FakeHighlight });
});
afterEach(() => {
  for (const root of roots.splice(0)) unpaintAsides(root);
  document.body.replaceChildren();
  delete (globalThis as { Highlight?: unknown }).Highlight;
  delete (globalThis as { CSS?: { highlights?: unknown } }).CSS?.highlights;
  delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
});

function draw(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  roots.push(root);
  return root;
}
/** A marker for the passage `words` of what `root` draws now, the `nth` place it occurs at. */
function marker(root: Element, id: string, words: string, nth = 0): AsideMarker {
  const whole = textNodes(root).map((node) => node.data).join('');
  let start = -1;
  for (let found = 0; found <= nth; found += 1) start = whole.indexOf(words, start + 1);
  if (start === -1) throw new Error(`nothing drawn holds ${words}`);
  return {
    id, title: words, createdAt: 1, running: false,
    source: { kind: 'message', itemId: 'item-1', role: 'assistant', part: null, workerId: null, path: null, lines: null, range: { start, end: start + words.length }, digest: drawnDigest(words) },
  };
}
const registered = (): string[] => (registry.get(HIGHLIGHT_NAME)?.ranges ?? []).map((range) => range.toString());

describe('painting (C74, C75)', () => {
  it('makes a range from a marker’s offsets and registers it under the one name, the DOM untouched', () => {
    const root = draw('<p>The <em>tide</em> table lists <a>high water</a> twice.</p><p>Read it each morning.</p>');
    const before = root.innerHTML;
    // Inside one text node, across inline elements, and across two blocks.
    const markers = [marker(root, 'a1', 'table lists'), marker(root, 'a2', 'tide table lists high'), marker(root, 'a3', 'twice.Read it')];
    expect(paintAsides(root, markers)).toEqual(['a1', 'a2', 'a3']);
    expect(registered()).toEqual(['table lists', 'tide table lists high', 'twice.Read it']);
    expect(paintedIn(root).map((entry) => entry.asideId)).toEqual(['a1', 'a2', 'a3']);
    // No element was added and none changed: a link inside a passage is the element it was.
    expect(root.innerHTML).toBe(before);
    expect(root.querySelector('mark')).toBeNull();
  });

  it('paints a passage around a control that stands inside it: a code block’s Copy button is never painted', () => {
    const root = draw('<div><span>js</span><button data-copy="">Copy</button><pre><code>const a = 1;</code></pre></div>');
    const whole: AsideMarker = { ...marker(root, 'a1', 'js'), source: { kind: 'message', itemId: 'item-1', role: 'assistant', part: null, workerId: null, path: null, lines: null, range: { start: 0, end: 14 }, digest: drawnDigest('jsconst a = 1;') } };
    expect(paintAsides(root, [whole])).toEqual(['a1']);
    expect(registered()).toEqual(['js', 'const a = 1;']);
    const button = root.querySelector('[data-copy]') as Element;
    expect((registry.get(HIGHLIGHT_NAME)?.ranges ?? []).some((range) => range.intersectsNode(button))).toBe(false);
    // The passage is still one: its whole range is what it is come to by.
    expect(paintedIn(root).map((entry) => entry.range.toString())).toEqual(['jsCopyconst a = 1;']);
  });

  it('paints a passage that occurs twice where it was selected, and never at its other place', () => {
    const root = draw('<p>The tide turns at noon.</p><p>The tide turns at noon.</p>');
    paintAsides(root, [marker(root, 'a1', 'tide turns', 1)]);
    const [range] = paintedIn(root).map((entry) => entry.range) as [Range];
    expect(range.startContainer).toBe(textNodes(root)[1]);
    expect(range.startContainer).not.toBe(textNodes(root)[0]);
    expect(range.toString()).toBe('tide turns');
  });

  it('paints nothing for a marker whose text has changed since, and its other markers stand', () => {
    const root = draw('<p>alpha beta gamma</p><p>delta epsilon</p>');
    const kept = marker(root, 'kept', 'alpha');
    const moved = marker(root, 'moved', 'epsilon');
    expect(paintAsides(root, [kept, moved])).toEqual(['kept', 'moved']);
    // The drawing changes before the second passage: its offsets now name other text.
    (textNodes(root)[0] as Text).data = 'alpha beta gamma, and more';
    expect(paintAsides(root, [kept, moved])).toEqual(['kept']);
    expect(registered()).toEqual(['alpha']);
    // Nothing wrong is painted in its place.
    expect(paintedIn(root).some((entry) => entry.asideId === 'moved')).toBe(false);
  });

  it('paints nothing for an aside asked freely, which has no source, or for a place past the text’s end', () => {
    const root = draw('<p>short</p>');
    const free: AsideMarker = { id: 'free', title: 'A question', createdAt: 1, running: false, source: null };
    const past = { ...marker(root, 'past', 'short'), source: { ...(marker(root, 'past', 'short').source as NonNullable<AsideMarker['source']>), range: { start: 40, end: 45 } } };
    expect(paintAsides(root, [free, past])).toEqual([]);
    expect(registry.has(HIGHLIGHT_NAME)).toBe(false);
    expect(paintedIn(root)).toEqual([]);
  });

  it('holds every source’s ranges under the one name, and lets go of a source’s when it is no longer drawn', () => {
    const one = draw('<p>first source</p>');
    const two = draw('<p>second source</p>');
    paintAsides(one, [marker(one, 'a1', 'first')]);
    paintAsides(two, [marker(two, 'a2', 'second')]);
    expect(registered().sort()).toEqual(['first', 'second']);
    unpaintAsides(one);
    expect(registered()).toEqual(['second']);
    // A source whose last aside went paints none, and the name is given up once nothing is painted.
    paintAsides(two, []);
    expect(registry.has(HIGHLIGHT_NAME)).toBe(false);
    unpaintAsides(two);
  });

  it('paints nothing, and fails at nothing, on a platform without the API: the ranges are still found, and the markers stand', () => {
    delete (globalThis as { Highlight?: unknown }).Highlight;
    const root = draw('<p>no painter here</p>');
    expect(paintAsides(root, [marker(root, 'a1', 'painter')])).toEqual(['a1']);
    expect(registry.size).toBe(0);
    expect(paintedIn(root)).toHaveLength(1);
  });
});

describe('a press on a painted passage (C74)', () => {
  /** The caret the platform would find under a point: here, wherever the test says. */
  const caretAt = (node: Node, offset: number): void => {
    (document as unknown as { caretPositionFromPoint: () => { offsetNode: Node; offset: number } }).caretPositionFromPoint = () => ({ offsetNode: node, offset });
  };

  it('finds the aside whose range holds the point, none beside it, and the inner one of two that overlap', () => {
    const root = draw('<p>The tide table lists high water twice.</p>');
    const [text] = textNodes(root) as [Text];
    paintAsides(root, [marker(root, 'outer', 'tide table lists high'), marker(root, 'inner', 'table')]);
    caretAt(text, text.data.indexOf('lists') + 2);
    expect(asideAt(root, 10, 10)).toBe('outer');
    // The last painted of those that hold the point: a passage inside a longer one is the one pressed.
    caretAt(text, text.data.indexOf('table') + 2);
    expect(asideAt(root, 10, 10)).toBe('inner');
    caretAt(text, text.data.indexOf('twice') + 1);
    expect(asideAt(root, 10, 10)).toBeNull();
    caretAt(text, 1);
    expect(asideAt(root, 10, 10)).toBeNull();
  });

  it('finds none where the point’s text is outside the source, where nothing is painted, or where the platform gives no caret', () => {
    const root = draw('<p>inside the source</p>');
    const other = draw('<p>another source</p>');
    paintAsides(root, [marker(root, 'a1', 'inside')]);
    caretAt(textNodes(other)[0] as Text, 2);
    expect(asideAt(root, 10, 10)).toBeNull();
    caretAt(textNodes(other)[0] as Text, 2);
    expect(asideAt(other, 10, 10)).toBeNull();
    delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
    expect(asideAt(root, 10, 10)).toBeNull();
  });

  it('does not count the space past a line’s end, where the caret is still in the range and nothing is painted', () => {
    const root = draw('<p>a short line</p>');
    const [text] = textNodes(root) as [Text];
    paintAsides(root, [marker(root, 'a1', 'short line')]);
    const [entry] = paintedIn(root) as unknown as [{ parts: [Range] }];
    // The passage is drawn in one box; the press is far to its right, and the nearest caret is the line's end.
    entry.parts[0].getClientRects = () => [{ left: 20, right: 90, top: 0, bottom: 18 }] as unknown as DOMRectList;
    caretAt(text, text.data.length);
    expect(asideAt(root, 400, 9)).toBeNull();
    expect(asideAt(root, 60, 9)).toBe('a1');
  });

  it('finds none on a control’s own words inside a passage: the press is the control’s', () => {
    const root = draw('<div><span>js</span><button data-copy="">Copy</button><pre><code>const a = 1;</code></pre></div>');
    const whole: AsideMarker = { ...marker(root, 'a1', 'js'), source: { kind: 'message', itemId: 'item-1', role: 'assistant', part: null, workerId: null, path: null, lines: null, range: { start: 0, end: 14 }, digest: drawnDigest('jsconst a = 1;') } };
    paintAsides(root, [whole]);
    caretAt((root.querySelector('[data-copy]') as Element).firstChild as Text, 2);
    expect(asideAt(root, 10, 10)).toBeNull();
    caretAt(textNodes(root)[1] as Text, 3);
    expect(asideAt(root, 10, 10)).toBe('a1');
  });

  it('comes to a painted passage, and says so; one that is not painted is not come to', () => {
    const root = draw('<p>come to this passage</p>');
    paintAsides(root, [marker(root, 'a1', 'this passage')]);
    const seen: Element[] = [];
    (root.firstElementChild as HTMLElement).scrollIntoView = function scrollIntoView(this: Element) { seen.push(this); };
    expect(showPassage(root, 'a1')).toBe(true);
    expect(seen).toEqual([root.firstElementChild]);
    expect(showPassage(root, 'unknown')).toBe(false);
  });
});

describe('a marker and its place', () => {
  it('carries two offsets and a digest and no text: what a selection reported is what is painted', () => {
    const root = draw('<p>One <strong>two</strong> three.</p>');
    const range = document.createRange();
    range.setStart(textNodes(root)[1] as Text, 0);
    range.setEnd(textNodes(root)[2] as Text, 6);
    const place = placeOf(root, range) as NonNullable<ReturnType<typeof placeOf>>;
    const reported: AsideMarker = { id: 'a1', title: 'two three', createdAt: 1, running: false, source: { kind: 'message', itemId: 'i', role: 'assistant', part: null, workerId: null, path: null, lines: { first: 1, last: 1 }, ...place } };
    expect(JSON.stringify(reported.source)).not.toContain('two');
    expect(paintAsides(root, [reported])).toEqual(['a1']);
    expect(registered()).toEqual(['two three']);
  });
});
