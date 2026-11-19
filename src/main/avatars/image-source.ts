// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Browse for an avatar's image (decision 0036): the system's file chooser, opened at the folder the
// user last took an image from — chosen in it, or dropped from it, which the preload tells — held in
// memory for this run alone, never stored or logged; before any, the system's own memory of where its
// chooser was. The chosen file is read whole within the one image bound and handed to the page by its
// name and its bytes: its path stays here. Nothing is decoded: the page does that.
//
// Electron-free: the chooser and the file system are parameters.
import path from 'node:path';
import type { ChooseImageAnswer } from '@shared/contracts/avatar-family';
import { MAX_IMAGE_BYTES } from '@shared/contracts/images';
import type { AvatarFs } from './fs';

export interface ImageSource {
  /** The system's chooser, at the last folder; the image chosen, or why there is none. */
  choose(): Promise<ChooseImageAnswer>;
  /** A dropped image's path, whose folder the next chooser opens at. */
  noteDropped(file: string): void;
  /** The folder the next chooser opens at; undefined before any. For tests. */
  lastFolder(): string | undefined;
}

export interface ImageSourceOptions {
  /** Opens the system's chooser for one image at a folder, or where the system remembers; the path chosen, or null. */
  readonly pick: (folder: string | undefined) => Promise<string | null>;
  readonly fs: Pick<AvatarFs, 'readWhole'>;
}

export function createImageSource(options: ImageSourceOptions): ImageSource {
  let last: string | undefined;
  return {
    async choose() {
      const chosen = await options.pick(last);
      if (chosen === null || !path.isAbsolute(chosen)) return { kind: 'cancelled' };
      last = path.dirname(chosen);
      let bytes: Uint8Array | null;
      try {
        bytes = await options.fs.readWhole(chosen, MAX_IMAGE_BYTES);
      } catch {
        return { kind: 'refused', reason: 'unreadable' };
      }
      if (bytes === null) return { kind: 'refused', reason: 'too-large' };
      if (bytes.byteLength === 0) return { kind: 'refused', reason: 'unreadable' };
      return { kind: 'chosen', name: path.basename(chosen), bytes };
    },
    noteDropped(file) {
      if (path.isAbsolute(file)) last = path.dirname(file);
    },
    lastFolder: () => last,
  };
}
