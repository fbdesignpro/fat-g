// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useLayoutEffect, type RefObject } from 'react';

/** Position the first line's visible ink at the scroll area's top, including accents. */
export function useTitleInkAlignment(
  name: string,
  heading: RefObject<HTMLHeadingElement | null>,
  title: RefObject<HTMLSpanElement | null>,
) {
  useLayoutEffect(() => {
    const row = heading.current;
    const label = title.current;
    if (row === null || label === null) return;
    return alignTitleInk(row, label);
  }, [name, heading, title]);
}

/** The DOM work, outside the hook: it writes the heading's style, which a hook's arguments may not be. */
function alignTitleInk(row: HTMLElement, label: HTMLElement): () => void {
  let active = true;

  const align = (): void => {
    if (!active || label.clientWidth === 0) return;
    const node = label.firstChild;
    if (node === null || node.nodeType !== Node.TEXT_NODE) return;

    // Only the first visual line determines the top inset. An accent on a later
    // line must not push the whole heading down.
    const range = document.createRange();
    let firstTop: number | undefined;
    let end = 0;
    for (const character of node.textContent ?? '') {
      range.setStart(node, end);
      range.setEnd(node, end + character.length);
      const bounds = range.getBoundingClientRect();
      if (firstTop !== undefined && bounds.top > firstTop + 1) break;
      firstTop ??= bounds.top;
      end += character.length;
    }
    const firstLine = (node.textContent ?? '').slice(0, end);
    if (firstLine.trim().length === 0) return;
    const context = document.createElement('canvas').getContext('2d');
    if (context === null) return;
    const style = getComputedStyle(label);
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const capAscent = context.measureText('H').actualBoundingBoxAscent;
    const inkAscent = context.measureText(firstLine).actualBoundingBoxAscent;
    if (!Number.isFinite(capAscent) || !Number.isFinite(inkAscent)) return;
    // CSS trims to cap height. Reserve only the extra ink above it (or remove
    // unused space for lowercase names), plus one physical pixel for rasterization.
    row.style.marginTop = `${inkAscent - capAscent + 1 / window.devicePixelRatio}px`;
  };

  align();
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(align);
  observer?.observe(label);
  window.addEventListener('resize', align);
  document.fonts?.addEventListener('loadingdone', align);
  void document.fonts?.ready.then(align);
  return () => {
    active = false;
    observer?.disconnect();
    window.removeEventListener('resize', align);
    document.fonts?.removeEventListener('loadingdone', align);
  };
}
