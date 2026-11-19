// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The chat column as a drop target (docs/planning/_archive/M23.md, Design 4; C15): while a drag carries files
// the whole column is the target and a highlight says so; dropped images are staged in the drop's
// order, and a dropped folder is refused in words without a look inside. A drag that carries no file
// — text, or a project capsule's own drag, which is the pointer's and never a native one — is no drop
// here, and the page goes on as without this.
import { type DragEvent, useCallback, useRef, useState } from 'react';
import { clearProblems, refuseFolder, stageFiles } from './composer-store';

const carriesFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files');

export interface FileDrop {
  /** A drag that carries files is over the column. */
  readonly dropping: boolean;
  readonly handlers: {
    readonly onDragEnter: (event: DragEvent) => void;
    readonly onDragOver: (event: DragEvent) => void;
    readonly onDragLeave: (event: DragEvent) => void;
    readonly onDrop: (event: DragEvent) => void;
  };
}

/** `enabled`: the session takes images now; a column that takes none still keeps a dropped file from being opened. */
export function useFileDrop(sessionId: string, enabled: boolean): FileDrop {
  const [dropping, setDropping] = useState(false);
  // Enter and leave come for every element the drag crosses: counted, so a move between two of the column's own is no leave.
  const depth = useRef(0);

  const onDragEnter = useCallback((event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    if (enabled) setDropping(true);
  }, [enabled]);

  const onDragOver = useCallback((event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    // Taken here: no file dropped on the column is ever opened by the page.
    event.preventDefault();
    event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
  }, [enabled]);

  const onDragLeave = useCallback((event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDropping(false);
  }, []);

  const onDrop = useCallback((event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDropping(false);
    if (!enabled) return;
    clearProblems(sessionId);
    const files: File[] = [];
    const items = [...event.dataTransfer.items];
    if (items.length > 0) {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        // A folder is told by its entry, and refused with nothing of it read (C15).
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
        const file = item.getAsFile();
        if (entry?.isDirectory === true) { refuseFolder(sessionId, file?.name === '' ? null : file?.name ?? entry.name); continue; }
        if (file !== null) files.push(file);
      }
    } else {
      files.push(...event.dataTransfer.files);
    }
    void stageFiles(sessionId, files, { keepProblems: true });
  }, [enabled, sessionId]);

  return { dropping: dropping && enabled, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
