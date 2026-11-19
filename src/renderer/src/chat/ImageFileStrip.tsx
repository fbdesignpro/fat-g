// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { ATTACHMENT_WORDS } from '@shared/contracts/attachments';
import { imageFileAddress, lastPart } from '@shared/contracts/files';
import { IMAGE_FILE_FAILURE_WORDS, IMAGE_FILE_STORAGE_NOTE } from '../images/file-failure';
import { openImageFile } from '../artifacts/opener';
import { forgetImageFile, useImageFile } from './image-files';
import styles from './Chat.module.css';

/** fat-g's words for a row of image files. */
export const IMAGE_FILE_WORDS = { label: 'Images' } as const;

interface ThumbnailProps {
  readonly sessionId: string;
  readonly target: string;
  /** Its name before main has answered: the last part of the address. */
  readonly name: string;
  readonly missing: boolean;
  readonly tabIndex: number;
}

function Thumbnail({ sessionId, target, name: written, missing, tabIndex }: ThumbnailProps) {
  // The id that failed to draw: the file changed or went since it was read.
  const [failed, setFailed] = useState<string | null>(null);
  const { state, refresh } = useImageFile(sessionId, target, failed);
  if (state === null) return null;
  if ('why' in state) {
    if (!missing) return null;
    const reason = IMAGE_FILE_FAILURE_WORDS[state.why];
    return (
      <li className={styles.sentImage} data-image-file="unavailable">
        <span className={styles.imageFileMissing} role="img" aria-label={`${written}: ${reason}`}>{reason}</span>
        <span className={styles.sentImageCaption} title={target}>{written}</span>
        {state.why === 'not-found' && <span className={styles.imageFileNote}>{IMAGE_FILE_STORAGE_NOTE}</span>}
      </li>
    );
  }
  const image = state;
  const name = lastPart(image.path);
  const open = async (): Promise<void> => {
    const current = await refresh();
    if (current !== null && !('why' in current)) openImageFile(sessionId, current);
  };
  return (
    <li className={styles.sentImage} data-image-file="shown">
      <button type="button" className={styles.sentImageButton} tabIndex={tabIndex} aria-label={name} title={ATTACHMENT_WORDS.tooltip(name, image.width, image.height)} onClick={() => void open()}>
        <img
          src={imageFileAddress(image.id)}
          alt={name}
          draggable={false}
          onError={() => {
            forgetImageFile(sessionId, target);
            setFailed(image.id);
          }}
        />
      </button>
      <span className={styles.sentImageCaption}>{name}</span>
    </li>
  );
}

export interface ImageFileStripProps {
  readonly sessionId: string;
  /** The addresses, in order, each once, with the name each is known by until main answers. */
  readonly targets: readonly { readonly target: string; readonly name: string }[];
  /** Whether an address main draws no image of says so: an agent read it; a message's text only named it. */
  readonly missing: boolean;
  readonly tabIndex: number;
}

/**
 * A row of image files (decision 0022, item 15): under an activity group's line, the images its agent
 * read — whether the group is open or closed, for no fold opens by itself — and under a finished
 * message, the images its text names. Each is drawn as a sent image is (M23, C26): at most 240 px
 * wide with its name under it, a press opening it in the pane. Arrival opens no tab and moves neither
 * the focus nor the chat's place. An image an agent read that main draws nothing of says it is not
 * available; an address a message named in vain is left out, as its text is no claim that it was there.
 */
export function ImageFileStrip({ sessionId, targets, missing, tabIndex }: ImageFileStripProps) {
  if (targets.length === 0) return null;
  return (
    <ul className={styles.sentImages} data-image-files="" aria-label={IMAGE_FILE_WORDS.label}>
      {targets.map(({ target, name }) => <Thumbnail key={target} sessionId={sessionId} target={target} name={name} missing={missing} tabIndex={tabIndex} />)}
    </ul>
  );
}
