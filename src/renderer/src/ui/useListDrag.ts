// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from 'react';

/** How far the pointer moves before a press becomes a drag: a click stays a click (M12, C70; M14, C55). */
export const DRAG_THRESHOLD = 4;
/** How near the column's top or bottom edge the pointer makes it scroll, and by how much per frame (M12, C86). */
export const EDGE = 32;
export const SCROLL_STEP = 8;

export interface ColumnRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** Where a dragged item would land, and the scrolling column as it is on screen right now. */
export interface Located<Found> {
  readonly found: Found;
  readonly column: ColumnRect;
}

export interface ListDrag<Found> {
  readonly key: string;
  /** The lifted copy of the pressed element, on screen. */
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly found: Found;
}

interface Press {
  readonly resetKey: string | undefined;
  readonly key: string;
  readonly pointerId: number;
  readonly element: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  /** Where on the element it was pressed, so the copy does not jump. */
  readonly offsetY: number;
  readonly left: number;
  readonly width: number;
  started: boolean;
  x: number;
  y: number;
  /** -1 near the top edge, 1 near the bottom one. */
  edge: -1 | 0 | 1;
}

export interface ListDragOptions<Found> {
  /** A visible order or membership change cancels a gesture made against the previous layout. */
  readonly resetKey?: string;
  /** The column that scrolls: a drag near its top or bottom edge scrolls it. */
  readonly column: RefObject<HTMLElement | null>;
  /** Whether a press may start a drag at all. By default any press with the main button does. */
  readonly canStart?: (event: ReactPointerEvent<HTMLElement>) => boolean;
  /** What is under the pointer at `y` (on screen) for the item `key`; null when the list cannot be measured. */
  readonly locate: (key: string, y: number) => Located<Found> | null;
  /** A release inside the column. What it lands on, and whether anything is sent, is the caller's. */
  readonly onDrop: (key: string, found: Found) => void;
}

/**
 * Reordering by dragging, shared by the project headers and the session capsules (M12, Design 10;
 * M14, Design 10). Pointer events only: no native drag-and-drop, so nothing leaves the window and no
 * other program becomes a drop target (M12, C69). A press becomes a drag only past a few pixels;
 * the column scrolls near its edges; Escape, a cancelled pointer or a release outside the column
 * cancels, and nothing is sent.
 *
 * `wasDragged` says whether the last press became a drag: the click that follows one is not a click.
 */
export function useListDrag<Found>(options: ListDragOptions<Found>) {
  const [drag, setDrag] = useState<ListDrag<Found> | null>(null);
  const press = useRef<Press | null>(null);
  const frame = useRef<number | null>(null);
  const current = useRef(options);
  const detach = useRef<() => void>(() => undefined);
  const dragged = useRef(false);

  useEffect(() => {
    current.current = options;
  });

  useEffect(() => () => detach.current(), []);

  function show(active: Press, located = current.current.locate(active.key, active.y)): void {
    if (located === null) return;
    setDrag({ key: active.key, top: active.y - active.offsetY, left: active.left, width: active.width, found: located.found });
  }

  function scrollStep(): void {
    frame.current = null;
    const active = press.current;
    const column = current.current.column.current;
    if (active?.started !== true || active.edge === 0 || column === null) return;
    column.scrollTop += active.edge * SCROLL_STEP;
    show(active);
    frame.current = requestAnimationFrame(scrollStep);
  }

  function finish(drop: boolean): void {
    const active = press.current;
    press.current = null;
    detach.current();
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (active?.started !== true) return;
    try {
      if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    } catch {
      // The element is gone: nothing to release.
    }
    setDrag(null);
    if (!drop) return;
    const located = current.current.locate(active.key, active.y);
    if (located === null) return;
    const { column } = located;
    if (active.x < column.left || active.x > column.right || active.y < column.top || active.y > column.bottom) return;
    current.current.onDrop(active.key, located.found);
  }

  useEffect(() => {
    if (press.current !== null && press.current.resetKey !== options.resetKey) finish(false);
  });

  function onPointerDown(event: ReactPointerEvent<HTMLElement>, key: string): void {
    if (event.button !== 0 || press.current !== null) return;
    dragged.current = false;
    if (current.current.canStart?.(event) === false) return;
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    press.current = {
      resetKey: current.current.resetKey,
      key,
      pointerId: event.pointerId,
      element,
      startX: event.clientX,
      startY: event.clientY,
      offsetY: event.clientY - rect.top,
      left: rect.left,
      width: rect.width,
      started: false,
      x: event.clientX,
      y: event.clientY,
      edge: 0,
    };

    const onMove = (move: PointerEvent): void => {
      const active = press.current;
      if (active === null || move.pointerId !== active.pointerId) return;
      active.x = move.clientX;
      active.y = move.clientY;
      if (!active.started) {
        if (Math.hypot(move.clientX - active.startX, move.clientY - active.startY) < DRAG_THRESHOLD) return;
        active.started = true;
        dragged.current = true;
        try {
          active.element.setPointerCapture(active.pointerId);
        } catch {
          // Capture is a convenience: the window still hears the pointer.
        }
      }
      const located = current.current.locate(active.key, active.y);
      if (located === null) return;
      const { column } = located;
      active.edge = move.clientY < column.top + EDGE ? -1 : move.clientY > column.bottom - EDGE ? 1 : 0;
      if (active.edge !== 0 && frame.current === null) frame.current = requestAnimationFrame(scrollStep);
      show(active, located);
    };
    const onUp = (up: PointerEvent): void => {
      if (up.pointerId !== press.current?.pointerId) return;
      press.current.x = up.clientX;
      press.current.y = up.clientY;
      finish(true);
    };
    const onCancel = (): void => finish(false);
    const onKey = (key: KeyboardEvent): void => {
      if (key.key !== 'Escape' || press.current?.started !== true) return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    detach.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      detach.current = () => undefined;
    };
  }

  return { drag, onPointerDown, wasDragged: () => dragged.current };
}
