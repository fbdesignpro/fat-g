// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { EDITOR_WORDS } from './family-editor-words';
import styles from './Settings.module.css';
import { browseImage, useImageDrop } from './useImageDrop';

/**
 * Add avatar's drop zone (decision 0036), under the family editor's list: an image dropped on it, or
 * chosen at its press in the system's chooser, is handed over as a file — its bytes the page's to read,
 * never a path.
 */
export function AvatarDropZone({ disabled, preparing, onFile, onProblem, label = EDITOR_WORDS.drop.label }: {
  readonly label?: string;
  readonly disabled: boolean;
  /** An image is being made ready: the zone says so, and takes no other. */
  readonly preparing: boolean;
  readonly onFile: (file: File) => void;
  /** Words for an image or a folder refused before it was read. */
  readonly onProblem: (words: string) => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const taking = !disabled && !preparing && !browsing;
  const drop = useImageDrop({ enabled: taking, onFile, onFolder: () => onProblem(EDITOR_WORDS.drop.folder) });
  const browse = (): void => {
    setBrowsing(true);
    browseImage().then(
      (browsed) => {
        setBrowsing(false);
        if (browsed.kind === 'chosen') onFile(browsed.file);
        else if (browsed.kind === 'refused') onProblem(EDITOR_WORDS.imageRefusals[browsed.reason]);
      },
      () => { setBrowsing(false); onProblem(EDITOR_WORDS.imageRefusals.unreadable); },
    );
  };

  return (
    <div className={styles.avatarDropTarget} {...drop.handlers}>
      <button
        type="button"
        className={styles.avatarDropZone}
        disabled={!taking}
        aria-busy={preparing || browsing || undefined}
        onClick={browse}
        data-avatar-drop=""
        aria-haspopup="dialog"
        data-dropping={drop.dropping ? '' : undefined}
      >
        <span>{preparing ? EDITOR_WORDS.drop.preparing : label}</span>
        <small className={styles.statusLine}>{EDITOR_WORDS.drop.hint}<strong>{EDITOR_WORDS.drop.square}</strong>{EDITOR_WORDS.drop.sizes}</small>
      </button>
    </div>
  );
}
