// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An aside's passage, highlighted where it was selected (docs/planning/_archive/M20b.md, Design 7; C74, C75).
// Painted through the CSS Custom Highlight API: a range of the drawn text is registered under one
// name, and a `::highlight()` rule gives it a background. No element is added and none is changed,
// so the drawing, a selection in it and a copy of it are as they were, and no block is drawn again.
//
// The ranges are made from the markers alone — two offsets and a digest (drawn-text.ts) — after
// each drawing of the source they belong to. The page holds no aside's text for this. Where the
// drawn text at a marker's offsets is no longer what was selected, nothing is painted for it.
//
// A highlight is no element: it takes no focus and has no name. A press on it is found by where the
// pointer is; the keyboard's way to the same aside is the marker beside its block (C74).
import type { AsideMarker } from '@shared/contracts/aside';
import { rangeOf, rangesAt } from './drawn-text';

/** The name the ranges are registered under: what the style sheet's `::highlight()` rule names. */
export const HIGHLIGHT_NAME = 'aside';
/** The attribute a source carries while the pointer is over a highlighted passage of it: the pointer shows it can be pressed. */
export const OVER_ATTRIBUTE = 'data-aside-over';

/**
 * A painted passage: its whole range, from its first character to its last, and the parts of it that
 * are painted — the same one range, but where a control's own words stand inside it, which no part
 * holds (drawn-text.ts).
 */
interface Painted { readonly asideId: string; readonly range: Range; readonly parts: readonly Range[] }

/** What is painted, by the source it is painted in. */
const painted = new Map<Element, readonly Painted[]>();

interface HighlightRegistry { set(name: string, highlight: unknown): void; delete(name: string): void }
type HighlightMaker = new (...ranges: Range[]) => unknown;

/** The platform's registry and its maker, where it has them: a page without them paints nothing, and its markers stand. */
function platform(): { readonly registry: HighlightRegistry; readonly Highlight: HighlightMaker } | null {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const maker = (globalThis as { Highlight?: HighlightMaker }).Highlight;
  return registry === undefined || maker === undefined ? null : { registry, Highlight: maker };
}

/** Every range of every source, registered again under the one name. */
function register(): void {
  const found = platform();
  if (found === null) return;
  const ranges = [...painted.values()].flatMap((list) => list.flatMap((entry) => entry.parts));
  if (ranges.length === 0) found.registry.delete(HIGHLIGHT_NAME);
  else found.registry.set(HIGHLIGHT_NAME, new found.Highlight(...ranges));
}

/**
 * Paints a source's asides, as it is drawn now: each marker's range, where its digest holds.
 * Answers the asides that were painted. Called after each drawing of the source.
 */
export function paintAsides(root: Element, markers: readonly AsideMarker[]): readonly string[] {
  const ranges: Painted[] = [];
  for (const marker of markers) {
    if (marker.source === null) continue;
    const range = rangeOf(root, marker.source);
    if (range !== null) ranges.push({ asideId: marker.id, range, parts: rangesAt(root, marker.source.range.start, marker.source.range.end) });
  }
  if (ranges.length === 0 && !painted.has(root)) return [];
  if (ranges.length === 0) painted.delete(root); else painted.set(root, ranges);
  register();
  return ranges.map((entry) => entry.asideId);
}

/** The source is no longer drawn: nothing of it stays painted. */
export function unpaintAsides(root: Element): void {
  if (!painted.delete(root)) return;
  register();
}

/** A source's painted ranges: what a test reads, and what comes to a passage. */
export function paintedIn(root: Element): readonly Painted[] {
  return painted.get(root) ?? [];
}

interface CaretDocument {
  caretPositionFromPoint?: (x: number, y: number) => { readonly offsetNode: Node; readonly offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/** The place in the text under a point of the window, or null where there is none. */
function caretAt(document: Document, x: number, y: number): { readonly node: Node; readonly offset: number } | null {
  const reader = document as unknown as CaretDocument;
  const position = reader.caretPositionFromPoint?.(x, y) ?? null;
  if (position !== null) return { node: position.offsetNode, offset: position.offset };
  const range = reader.caretRangeFromPoint?.(x, y) ?? null;
  return range === null ? null : { node: range.startContainer, offset: range.startOffset };
}

/**
 * The aside whose painted passage is under a point (C74): the last painted of those that hold it,
 * so a passage inside a longer one is the one pressed. Null for a point on none — the text beside
 * a passage, a control's words inside one, or the space after a line's end.
 */
export function asideAt(root: Element, x: number, y: number): string | null {
  const ranges = painted.get(root);
  if (ranges === undefined) return null;
  const caret = caretAt(root.ownerDocument, x, y);
  if (caret === null || !root.contains(caret.node)) return null;
  for (const entry of [...ranges].reverse()) {
    for (const part of entry.parts) {
      if (!part.isPointInRange(caret.node, caret.offset)) continue;
      // The caret is the nearest place in the text: past a line's end it is still in the range, where nothing is painted.
      const boxes = typeof part.getClientRects === 'function' ? [...part.getClientRects()] : [];
      if (boxes.length === 0 || boxes.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) return entry.asideId;
    }
  }
  return null;
}

/** Brings an aside's painted passage into view, where it is painted. Answers whether it was. */
export function showPassage(root: Element, asideId: string): boolean {
  const entry = painted.get(root)?.find((candidate) => candidate.asideId === asideId);
  const start = entry?.range.startContainer;
  const element = start === undefined ? null : start.nodeType === 1 ? (start as Element) : start.parentElement;
  if (element === null || element === undefined) return false;
  element.scrollIntoView?.({ block: 'center' });
  return true;
}
