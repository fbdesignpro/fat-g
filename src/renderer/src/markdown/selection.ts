// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Which drawn blocks the reader's selection touches (docs/planning/_archive/M19.md, Design 6; C61). A block
// that a late definition would draw again keeps its DOM while the selection touches it, so the
// selection, and what a copy of it takes, stays whole; it takes its latest drawing once the
// selection is cleared or moves off it. Releasing the mouse alone clears no selection.
//
// One listener on the document, there only while something asks. A block is known by the id on its
// element (`data-md-block`): what is kept here is ids, never a text.

/** The attribute a drawn block's top element carries: its id, unique in the page. */
export const BLOCK_ATTRIBUTE = 'data-md-block';
/**
 * And the lines of its source, `first-last` (M19b, C41): what finds a block by a line, in a message
 * as in a file. Written by MarkdownText after each reading, never by a block's own drawing.
 */
export const LINES_ATTRIBUTE = 'data-md-lines';
/** A paragraph's hard-break-separated passage: zero-based source lines relative to its block. */
export const LINE_OFFSETS_ATTRIBUTE = 'data-md-line-offsets';

/** The first and last line a drawn block's element carries, or null for an element that is no block. */
export function blockLines(element: Element): { readonly first: number; readonly last: number } | null {
  const match = /^(\d+)-(\d+)$/.exec(element.getAttribute(LINES_ATTRIBUTE) ?? '');
  return match === null ? null : { first: Number(match[1]), last: Number(match[2]) };
}

/** The passage containing a source line, where a paragraph has hard breaks; otherwise its whole block. */
export function linePart(block: Element, line: number): Element {
  const held = blockLines(block);
  if (held === null) return block;
  const offset = line - held.first;
  for (const part of block.querySelectorAll(`[${LINE_OFFSETS_ATTRIBUTE}]`)) {
    const match = /^(\d+)-(\d+)$/.exec(part.getAttribute(LINE_OFFSETS_ATTRIBUTE) ?? '');
    if (match !== null && Number(match[1]) <= offset && offset <= Number(match[2])) return part;
  }
  return block;
}

const listeners = new Set<() => void>();
let touched: ReadonlySet<string> = new Set();

/** The ids of the blocks the selection touches now. */
function read(): ReadonlySet<string> {
  const selection = document.getSelection();
  const found = new Set<string>();
  if (selection === null || selection.isCollapsed) return found;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const common = range.commonAncestorContainer;
    const root = common instanceof Element ? common : common.parentElement;
    if (root === null) continue;
    // Inside one block: that block. Else every block under the common ancestor that the range crosses.
    const inside = root.closest(`[${BLOCK_ATTRIBUTE}]`);
    if (inside !== null) { found.add(inside.getAttribute(BLOCK_ATTRIBUTE) ?? ''); continue; }
    for (const block of root.querySelectorAll(`[${BLOCK_ATTRIBUTE}]`)) if (range.intersectsNode(block)) found.add(block.getAttribute(BLOCK_ATTRIBUTE) ?? '');
  }
  return found;
}

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((id) => b.has(id));

function onSelectionChange(): void {
  const next = read();
  if (same(next, touched)) return;
  touched = next;
  for (const listener of [...listeners]) listener();
}

/** Tells `listener` whenever the set of touched blocks changes. Returns the function that stops it. */
export function subscribeSelection(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener('selectionchange', onSelectionChange);
    touched = read();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) document.removeEventListener('selectionchange', onSelectionChange);
  };
}

/** Whether the selection touches the block with this id. */
export function selectionTouches(id: string): boolean {
  return touched.has(id);
}
