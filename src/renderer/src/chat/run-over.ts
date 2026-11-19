// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An answer's foot (RunFoot.tsx) shows while the pointer is anywhere over its answer. The list's
// children are its entries, its speakers' bars and the answers' feet, in order; this module reads
// them as they are drawn, and holds no state of the page's.

/** What a foot carries while the pointer is anywhere over its answer: what shows it (Chat.module.css). */
export const RUN_OVER_ATTRIBUTE = 'data-run-over';

/**
 * The list's child the pointer is over; in the space between two children, which is the list's own,
 * the last that begins above the pointer. The children are in order, so the search halves. Below
 * the last child, where the list holds nothing more, none.
 */
function childAt(list: HTMLElement, target: EventTarget | null, y: number): Element | null {
  if (target instanceof Element && target !== list) {
    let child: Element | null = target;
    while (child !== null && child.parentElement !== list) child = child.parentElement;
    if (child !== null) return child;
  }
  const { children } = list;
  let low = 0;
  let high = children.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((children[middle]?.getBoundingClientRect().top ?? y) <= y) low = middle + 1;
    else high = middle;
  }
  const above = children[low - 1] ?? null;
  return above !== null && low === children.length && above.getBoundingClientRect().bottom < y ? null : above;
}

/** The foot of the answer a child of the list is part of: the next foot, unless a speaker's bar comes first. */
function footAfter(child: Element | null): Element | null {
  for (let at = child; at !== null; at = at.nextElementSibling) {
    if (at.hasAttribute('data-run-foot')) return at;
    if (at !== child && at.hasAttribute('data-speaker')) return null;
  }
  return null;
}

/**
 * Marks the foot of the answer under the pointer (the maintainer): solid from the top of
 * its speaker's bar to the foot's bottom, the space between its parts included, which no `:hover` of
 * a part covers. The space above a bar belongs to the run before it. Found again only when the
 * pointer comes over another part, or moves in the list's own space. Returns what stops it.
 */
export function watchRunOver(element: HTMLElement): () => void {
  let shown: Element | null = null;
  let last: EventTarget | null = null;
  const show = (foot: Element | null): void => {
    if (foot === shown) return;
    shown?.removeAttribute(RUN_OVER_ATTRIBUTE);
    foot?.setAttribute(RUN_OVER_ATTRIBUTE, '');
    shown = foot;
  };
  const moved = (event: PointerEvent): void => {
    if (event.target === last && event.target !== element && shown?.isConnected !== false) return;
    last = event.target;
    show(footAfter(childAt(element, event.target, event.clientY)));
  };
  const left = (): void => {
    last = null;
    show(null);
  };
  element.addEventListener('pointermove', moved);
  element.addEventListener('pointerleave', left);
  return () => {
    element.removeEventListener('pointermove', moved);
    element.removeEventListener('pointerleave', left);
    show(null);
  };
}
