// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type RefObject, useLayoutEffect, useState } from 'react';
import type { ProjectColumnSide } from '@shared/contracts/prefs';

interface Point { readonly x: number; readonly y: number }

export interface ArrowPaths { readonly line: string; readonly head: string }

/** Room left between the arrow's ends and what they touch, in CSS pixels. */
const ARROW_GAP = 12;
/** The straight run up into the head, at most: the head sits on a straight line, never on the bend. */
const ARROW_TAIL = 24;

/**
 * A curve from beside the line's first row toward the project column, bending up to run straight into
 * the middle of the target's foot, and a narrow head pointing up: the curve's control point is level
 * with its start and plumb with its end, so it leaves sideways and arrives straight up. The line stops
 * short of the tip, so its round end does not blunt the head's point.
 */
export function arrowPaths(start: Point, end: Point): ArrowPaths {
  const bend = end.y + Math.min(ARROW_TAIL, Math.max(2, (start.y - end.y) / 2));
  return {
    line: `M ${start.x} ${start.y} Q ${end.x} ${start.y} ${end.x} ${bend} L ${end.x} ${end.y + 2}`,
    head: `M ${end.x - 5} ${end.y + 10} L ${end.x} ${end.y} L ${end.x + 5} ${end.y + 10}`,
  };
}

/**
 * Where the arrow from `line` to Add project runs, in the window's coordinates: the SVG drawing it is
 * fixed over the whole window, so it reaches out of the session window into the top band. Measured
 * again when either end changes size, the window is resized or zoomed, or the column changes side.
 * Null while Add project is not drawn.
 */
export function useAddProjectArrow(line: RefObject<HTMLElement | null>, side: ProjectColumnSide): ArrowPaths | null {
  const [arrow, setArrow] = useState<ArrowPaths | null>(null);
  useLayoutEffect(() => {
    const from = line.current;
    const target = document.querySelector<HTMLElement>('[data-add-project]');
    if (from === null || target === null) return;
    const measure = (): void => {
      const row = from.getClientRects()[0] ?? from.getBoundingClientRect();
      const button = target.getBoundingClientRect();
      const start = { x: side === 'left' ? row.left - ARROW_GAP : row.right + ARROW_GAP, y: row.top + row.height / 2 };
      setArrow(arrowPaths(start, { x: button.left + button.width / 2, y: button.bottom + ARROW_GAP }));
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    // An inline line never reports a size of its own: its block does, when the font arrives or it wraps.
    for (const element of [from, from.parentElement, target]) if (element !== null) observer?.observe(element);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [line, side]);
  return arrow;
}
