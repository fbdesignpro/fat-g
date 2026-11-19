// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, useId, useState } from 'react';
import type { AvatarRole } from '@shared/contracts/avatars';
import { EDITOR_WORDS } from './family-editor-words';
import styles from './Settings.module.css';
import { browseImage, useImageDrop } from './useImageDrop';

/** What an avatar's images may do in the family editor (decision 0036). */
export interface ImageActions {
  /** The family may be written: each image takes a drop and offers Browse. */
  readonly editable: boolean;
  /** An image is being replaced, of this avatar or another: no other is taken until it is done. */
  readonly busy: boolean;
  /** Which of this avatar's images is being replaced; null for neither. */
  readonly replacing: AvatarRole | null;
  /** Why this avatar's last image was refused; null for none. */
  readonly problem: string | null;
  readonly onFile: (role: AvatarRole, file: File) => void;
  readonly onProblem: (words: string) => void;
}

/**
 * One of an avatar's images in the family editor's detail (decision 0036): its description at the
 * left, centred on it — what it is, its size, and how to replace it — and the image at the right,
 * which takes an image dropped onto it, with a note beside it where it has one; Browse opens the
 * system's chooser.
 */
export function AvatarImageRow({ role, label, hint, note, actions, children }: {
  readonly role: AvatarRole;
  readonly label: string;
  /** How to replace it, read before Browse. */
  readonly hint: string;
  /** Said beside the image, in the room the main image's width leaves, while it can be replaced. */
  readonly note?: string;
  readonly actions: ImageActions;
  readonly children: ReactNode;
}) {
  const labelId = useId();
  const noteId = useId();
  const [browsing, setBrowsing] = useState(false);
  const taking = actions.editable && !actions.busy && !browsing;
  const drop = useImageDrop({ enabled: taking, onFile: (file) => actions.onFile(role, file), onFolder: () => actions.onProblem(EDITOR_WORDS.drop.folder) });
  const browse = (): void => {
    setBrowsing(true);
    browseImage().then(
      (browsed) => {
        setBrowsing(false);
        if (browsed.kind === 'chosen') actions.onFile(role, browsed.file);
        else if (browsed.kind === 'refused') actions.onProblem(EDITOR_WORDS.imageRefusals[browsed.reason]);
      },
      () => { setBrowsing(false); actions.onProblem(EDITOR_WORDS.imageRefusals.unreadable); },
    );
  };
  return (
    <>
      <div className={styles.imageLabel} data-image-label={role}>
        <span id={labelId} className={styles.imageName}>{label}</span>
        {actions.editable && (
          <small className={styles.statusLine}>
            {actions.replacing === role ? EDITOR_WORDS.images.replacing : (
              <>
                {hint}
                <button type="button" className={styles.copyFamilyButton} disabled={!taking} aria-label={`${EDITOR_WORDS.images.browse}: ${label}`} onClick={browse} data-browse-image={role}>
                  {EDITOR_WORDS.images.browse}
                </button>
              </>
            )}
          </small>
        )}
      </div>
      <div className={styles.imageSide}>
        <div className={styles.imageCell} role="group" aria-labelledby={labelId} aria-describedby={note !== undefined && actions.editable ? noteId : undefined} data-image-slot={role} data-dropping={drop.dropping ? '' : undefined} {...drop.handlers}>
          {children}
        </div>
        {note !== undefined && actions.editable && <small id={noteId} className={`${styles.statusLine} ${styles.imageNote}`} data-image-note={role}>{note}</small>}
      </div>
    </>
  );
}
