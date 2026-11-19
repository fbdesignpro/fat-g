// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { RefObject } from 'react';
import type { ProjectEntryView } from '@shared/contracts/projects';
import { type ColumnRect, DRAG_THRESHOLD, EDGE, SCROLL_STEP, useListDrag } from '../ui/useListDrag';
import { type Box, dropAt, type DropTarget, isOwnPlace, makeRoom, type MeasuredEntry, type Room } from './reorder';

export { DRAG_THRESHOLD, EDGE, SCROLL_STEP };

/** The list's geometry. Measured from the DOM in the app; tests replace it, as jsdom computes no layout. */
export interface ListGeometry {
  /** The project column, on screen. */
  readonly column: ColumnRect;
  /** Where the top of the list is on screen: it moves as the column scrolls. */
  readonly listTop: number;
  /** In the list's own coordinates. */
  readonly entries: readonly MeasuredEntry[];
  readonly hiddenRow: Box | null;
}

export type MeasureList = (list: HTMLElement, column: HTMLElement) => ListGeometry;

/**
 * Each entry where the layout puts it, before anything moves out of the way: offsets ignore the
 * transforms that open the gap (C86), so the targets stay put while the entries slide.
 */
export const measureList: MeasureList = (list, column) => {
  const box = (element: HTMLElement): Box => {
    let top = 0;
    for (let node: HTMLElement | null = element; node !== null && node !== list; node = node.offsetParent as HTMLElement | null) top += node.offsetTop;
    return { top, bottom: top + element.offsetHeight };
  };
  const rect = column.getBoundingClientRect();
  const row = list.querySelector<HTMLElement>('[data-hidden-row]');
  return {
    column: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    listTop: list.getBoundingClientRect().top,
    entries: [...list.querySelectorAll<HTMLElement>('[data-entry-key]')].map((element) => ({
      key: element.dataset['entryKey'] ?? '',
      group: element.dataset['group'] === 'hidden' ? 'hidden' : 'visible',
      ...box(element),
    })),
    hiddenRow: row === null ? null : box(row),
  };
};

export interface Drag {
  readonly key: string;
  /** The lifted copy of the header, on screen. */
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly target: DropTarget;
  /** How the other entries move out of the way, and where the gap opens (C86). */
  readonly room: Room;
}

export interface ProjectDragOptions {
  readonly list: RefObject<HTMLElement | null>;
  readonly column: RefObject<HTMLElement | null>;
  readonly measure: MeasureList;
  readonly entries: readonly ProjectEntryView[];
  readonly hiddenOpen: boolean;
  readonly firstHidden: string | null;
  readonly onDrop: (key: string, hidden: boolean, before: string | null) => void;
}

/**
 * Reordering by dragging a project's header (docs/planning/_archive/M12.md, Design 10; C68–C70, C86), on the
 * pointer handling the session capsules share (ui/useListDrag). The disclosure button can drag the
 * header; the other buttons cannot. Escape, a cancelled pointer or a release outside the column cancels.
 */
export function useProjectDrag(options: ProjectDragOptions): { drag: Drag | null; onPointerDown: ReturnType<typeof useListDrag>['onPointerDown']; wasDragged: () => boolean } {
  const { drag, onPointerDown, wasDragged } = useListDrag<{ readonly target: DropTarget; readonly room: Room }>({
    column: options.column,
    canStart: (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      return button === null || button.hasAttribute('data-project-disclosure');
    },
    locate(key, y) {
      const { list, column, measure, hiddenOpen, firstHidden } = options;
      if (list.current === null || column.current === null) return null;
      const geometry = measure(list.current, column.current);
      const layout = { entries: geometry.entries, hiddenRow: geometry.hiddenRow, hiddenOpen, firstHidden };
      const target = dropAt(layout, y - geometry.listTop);
      return { found: { target, room: makeRoom(layout, key, target) }, column: geometry.column };
    },
    onDrop(key, { target }) {
      if (isOwnPlace(options.entries, key, target)) return;
      options.onDrop(key, target.hidden, target.before);
    },
  });
  return { drag: drag === null ? null : { key: drag.key, top: drag.top, left: drag.left, width: drag.width, target: drag.found.target, room: drag.found.room }, onPointerDown, wasDragged };
}
