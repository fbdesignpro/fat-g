// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A source's drawn text, as one run of characters (docs/planning/_archive/M20b.md, Design 7; C75): the text
// nodes under the element that holds what was drawn of a message, of an activity's input or output,
// or of a file, in document order. A place in it is an offset, in UTF-16 units from its start.
//
// The selection's report says where a selection lies in it, and the highlight painter makes a range
// from those two offsets again: both walk it here, the same way, so an offset means one place. The
// words of a control that is fat-g's own — a Copy button's, which change when it is pressed, the
// Explain this control's — count for nothing: they are no part of what was drawn.
import { drawnDigest } from '@shared/contracts/aside';

/** The attribute an element carries whose words are a control's own, and no part of the text drawn. */
export const CHROME_ATTRIBUTE = 'data-chrome';
/** What is skipped: fat-g's marked controls, and a Copy button, which marks itself. */
const CHROME = `[${CHROME_ATTRIBUTE}], [data-copy]`;

const SHOW_TEXT = 4;

/** Whether a text node under `root` is a control's own words. */
function isChrome(root: Element, node: Node): boolean {
  const chrome = node.parentElement?.closest(CHROME) ?? null;
  return chrome !== null && root.contains(chrome);
}

/** The text nodes of a source's drawn text, in order. */
export function textNodes(root: Element): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (isChrome(root, node)) continue;
    nodes.push(node as Text);
  }
  return nodes;
}

/**
 * A boundary of a range as an offset in the drawn text, or null for one outside the source. A
 * boundary in an element is before its child of that number: at the start of the text that follows.
 */
export function offsetOf(root: Element, container: Node, offset: number): number | null {
  if (!root.contains(container)) return null;
  const nodes = textNodes(root);
  let total = 0;
  if (container.nodeType === 3) {
    for (const node of nodes) {
      if (node === container) return total + Math.min(offset, node.data.length);
      total += node.data.length;
    }
    // A text node of a control's own: where it stands, as nothing.
    return before(root, nodes, container);
  }
  const child = container.childNodes[offset];
  return child === undefined ? after(nodes, container) : before(root, nodes, child);
}

/** How much drawn text comes before `mark` in the document. */
function before(root: Element, nodes: readonly Text[], mark: Node): number {
  let total = 0;
  for (const node of nodes) {
    // FOLLOWING: the node comes after the mark's start, a node the mark contains among them.
    if (node === mark || (mark.compareDocumentPosition(node) & 4) !== 0) break;
    total += node.data.length;
  }
  return root.contains(mark) ? total : 0;
}

/** How much drawn text there is up to the end of `container`. */
function after(nodes: readonly Text[], container: Node): number {
  let total = 0;
  for (const node of nodes) {
    const relation = container.compareDocumentPosition(node);
    // After the container, and not inside it: past its end.
    if ((relation & 4) !== 0 && (relation & 16) === 0) break;
    total += node.data.length;
  }
  return total;
}

/** The range between two offsets of the drawn text, or null where the text is shorter than they say. */
export function rangeAt(root: Element, start: number, end: number): Range | null {
  if (end < start) return null;
  const range = root.ownerDocument.createRange();
  let total = 0;
  let begun = false;
  for (const node of textNodes(root)) {
    const next = total + node.data.length;
    // The start goes to the node that holds its character, never to the end of the one before it.
    if (!begun && start < next) { range.setStart(node, start - total); begun = true; }
    if (begun && end <= next) { range.setEnd(node, end - total); return range; }
    total = next;
  }
  return null;
}

/**
 * The drawn text between two offsets as the ranges that hold it and nothing else: one, but where a
 * control's own words stand inside the passage — a code block's Copy button, between its label and
 * its code — which end one range and begin the next. What is painted is these, so that no control
 * is painted with a passage around it. Empty where the text is shorter than the offsets say.
 */
export function rangesAt(root: Element, start: number, end: number): Range[] {
  if (end <= start) return [];
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  const ranges: Range[] = [];
  let open: Range | null = null;
  let total = 0;
  for (let node = walker.nextNode() as Text | null; node !== null && total < end; node = walker.nextNode() as Text | null) {
    if (isChrome(root, node)) {
      if (open !== null) { ranges.push(open); open = null; }
      continue;
    }
    const next = total + node.data.length;
    if (next > start) {
      if (open === null) { open = root.ownerDocument.createRange(); open.setStart(node, Math.max(0, start - total)); }
      open.setEnd(node, Math.min(node.data.length, end - total));
    }
    total = next;
  }
  if (open !== null) ranges.push(open);
  return total < end ? [] : ranges;
}

/** The drawn text a range of the source covers. */
export function drawnBetween(root: Element, start: number, end: number): string {
  let total = 0;
  let text = '';
  for (const node of textNodes(root)) {
    const next = total + node.data.length;
    if (next > start && total < end) text += node.data.slice(Math.max(0, start - total), Math.min(node.data.length, end - total));
    if (next >= end) break;
    total = next;
  }
  return text;
}

/** A range of the source as a report carries it (C75): its two offsets, and the digest of the drawn text between them. Null for one that is empty, or not all in the source. */
export function placeOf(root: Element, range: Pick<Range, 'startContainer' | 'startOffset' | 'endContainer' | 'endOffset'>): { readonly range: { readonly start: number; readonly end: number }; readonly digest: string } | null {
  const start = offsetOf(root, range.startContainer, range.startOffset);
  const end = offsetOf(root, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { range: { start, end }, digest: drawnDigest(drawnBetween(root, start, end)) };
}

/**
 * The range a marker's offsets name, where the drawn text between them still has its digest (C75):
 * null where the drawing has changed since — a file edited, an answer whose text went on — so that
 * nothing is ever painted on another passage than the one that was selected.
 */
export function rangeOf(root: Element, place: { readonly range: { readonly start: number; readonly end: number }; readonly digest: string }): Range | null {
  const { start, end } = place.range;
  if (end <= start || drawnDigest(drawnBetween(root, start, end)) !== place.digest) return null;
  return rangeAt(root, start, end);
}
