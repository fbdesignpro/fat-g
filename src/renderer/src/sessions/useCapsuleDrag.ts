// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { RefObject } from 'react';
import type { Room } from '../projects/reorder';
import { type ColumnRect, useListDrag } from '../ui/useListDrag';
import { type CapsuleBox, capsuleDropAt, capsuleRoom, type CapsuleTarget } from './capsule-reorder';

/** One project's visible capsules in a lifecycle list. Measured from the DOM in the app; tests replace it, as jsdom computes no layout. */
export interface CapsuleGeometry {
  /** The project column, on screen. */
  readonly column: ColumnRect;
  /** Where the top of the list of capsules is on screen: it moves as the column scrolls. */
  readonly listTop: number;
  /** In that list's own coordinates. */
  readonly boxes: readonly CapsuleBox[];
}

export type MeasureCapsules = (list: HTMLElement, column: HTMLElement) => CapsuleGeometry;

/** Each capsule where the layout puts it: offsets ignore the transforms that open the gap. */
export const measureCapsules: MeasureCapsules = (list, column) => {
  const rect = column.getBoundingClientRect();
  return {
    column: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
    listTop: list.getBoundingClientRect().top,
    boxes: [...list.querySelectorAll<HTMLElement>('[data-session-id]')].map((element) => ({
      id: element.dataset['sessionId'] ?? '',
      group: element.dataset['group'] === 'starred' ? 'starred' : 'unstarred',
      top: element.offsetTop,
      bottom: element.offsetTop + element.offsetHeight,
    })),
  };
};

export interface CapsuleDrag {
  readonly id: string;
  /** The lifted copy of the capsule, on screen. */
  readonly top: number;
  readonly left: number;
  readonly width: number;
  /** How the group's other capsules move out of the way, and where the gap opens. */
  readonly room: Room;
}

export interface CapsuleDragOptions {
  readonly resetKey: string;
  /** The project's list of capsules. */
  readonly list: RefObject<HTMLElement | null>;
  readonly column: RefObject<HTMLElement | null>;
  readonly measure: MeasureCapsules;
  /** A release inside the group, at a place that is not the capsule's own. */
  readonly onDrop: (id: string, before: string | null) => void;
  /** Whether a drop is where the capsule already is. */
  readonly isOwnPlace: (id: string, before: string | null) => boolean;
}

/**
 * Reordering a capsule by dragging its select button (docs/planning/_archive/M14.md, Design 10; C55),
 * on the pointer handling the project headers use. The star and the `…` button are the button's
 * siblings, so a press on them never starts a drag. Thin capsules share this handler. A release outside
 * the capsule's own group cancels.
 */
export function useCapsuleDrag(options: CapsuleDragOptions): { drag: CapsuleDrag | null; onPointerDown: ReturnType<typeof useListDrag>['onPointerDown']; wasDragged: () => boolean } {
  const { drag, onPointerDown, wasDragged } = useListDrag<{ readonly target: CapsuleTarget | null; readonly room: Room }>({
    resetKey: options.resetKey,
    column: options.column,
    locate(id, y) {
      const { list, column, measure } = options;
      if (list.current === null || column.current === null) return null;
      const geometry = measure(list.current, column.current);
      const target = capsuleDropAt(geometry.boxes, id, y - geometry.listTop);
      return { found: { target, room: capsuleRoom(geometry.boxes, id, target) }, column: geometry.column };
    },
    onDrop(id, { target }) {
      if (target === null || options.isOwnPlace(id, target.before)) return;
      options.onDrop(id, target.before);
    },
  });
  return { drag: drag === null ? null : { id: drag.key, top: drag.top, left: drag.left, width: drag.width, room: drag.found.room }, onPointerDown, wasDragged };
}
