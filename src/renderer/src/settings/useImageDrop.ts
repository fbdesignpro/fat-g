// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where the family editor takes an image (decision 0036): its Add avatar zone, and an avatar's main
// image and small version. A drag that carries files is taken here whether or not the target takes one
// now, so a dropped file is never opened by the page; a folder is refused with nothing of it read. A
// dropped image's folder is told main through the preload, so the next Browse opens there; Browse is
// the system's chooser, which main opens and answers with the image's name and bytes, never its path.
import { type DragEvent, useRef, useState } from 'react';
import { invoke, noteDroppedFile } from '../ipc/client';

const carriesFiles = (event: DragEvent): boolean => event.dataTransfer.types.includes('Files');

export interface ImageDrop {
  /** A drag that carries files is over the target, which takes one now. */
  readonly dropping: boolean;
  readonly handlers: {
    readonly onDragEnter: (event: DragEvent) => void;
    readonly onDragOver: (event: DragEvent) => void;
    readonly onDragLeave: (event: DragEvent) => void;
    readonly onDrop: (event: DragEvent) => void;
  };
}

export function useImageDrop({ enabled, onFile, onFolder }: {
  readonly enabled: boolean;
  readonly onFile: (file: File) => void;
  readonly onFolder: () => void;
}): ImageDrop {
  const [dropping, setDropping] = useState(false);
  // Enter and leave come for every element the drag crosses: counted, so a move between two of the target's own is no leave.
  const depth = useRef(0);

  const onDragEnter = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    if (enabled) setDropping(true);
  };
  const onDragOver = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
  };
  const onDragLeave = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDropping(false);
  };
  const onDrop = (event: DragEvent): void => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDropping(false);
    if (!enabled) return;
    const item = [...event.dataTransfer.items].find((candidate) => candidate.kind === 'file');
    const entry = item !== undefined && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory === true) { onFolder(); return; }
    const file = item?.getAsFile() ?? event.dataTransfer.files[0] ?? null;
    if (file === null) return;
    noteDroppedFile(file);
    onFile(file);
  };

  return { dropping: dropping && enabled, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}

/** What Browse gave: an image as a file, or none, or why main would not read it. */
export type Browsed =
  | { readonly kind: 'chosen'; readonly file: File }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly reason: 'too-large' | 'unreadable' };

/** The system's chooser for one image, which main opens at the folder an image last came from. */
export async function browseImage(): Promise<Browsed> {
  const answer = await invoke('avatars:chooseImage', null);
  if (answer.kind !== 'chosen') return answer;
  return { kind: 'chosen', file: new File([new Uint8Array(answer.bytes)], answer.name) };
}
