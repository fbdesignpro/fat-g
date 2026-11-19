// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useContext, useState } from 'react';
import { ATTACHMENT_WORDS, type AttachmentView, attachmentAddress } from '@shared/contracts/attachments';
import { openImage } from '../artifacts/opener';
import { AsideSourceContext } from './ExplainControl';
import styles from './Chat.module.css';

/** What a sent image is called (C26): its name, its size in pixels, or — for one fat-g holds nothing of — that it is not available. */
function imageLabel(image: AttachmentView, ordinal: number): string {
  if (image.hash === null) return ATTACHMENT_WORDS.unavailable;
  return image.name ?? ATTACHMENT_WORDS.unnamed(image.width, image.height, ordinal);
}

function SentImage({ image, ordinal, sessionId, tabIndex }: { readonly image: AttachmentView; readonly ordinal: number; readonly sessionId: string | null; readonly tabIndex: number }) {
  const [failed, setFailed] = useState(false);
  const available = image.hash !== null && image.available && !failed;
  const label = imageLabel(image, ordinal);
  const caption = image.hash === null ? null : ATTACHMENT_WORDS.caption(image.name, image.width, image.height, ordinal);
  const open = (): void => {
    if (sessionId === null || image.hash === null) return;
    openImage(sessionId, image.hash, { name: image.name, width: image.width, height: image.height, available, ordinal });
  };
  return (
    <li className={styles.sentImage} data-sent-image={image.id}>
      {available ? (
        <button type="button" className={styles.sentImageButton} tabIndex={tabIndex} aria-label={label} onClick={open} disabled={sessionId === null}>
          <img src={attachmentAddress(image.hash ?? '')} alt={label} draggable={false} onError={() => setFailed(true)} />
        </button>
      ) : (
        // Nothing invented for it (C8): its name and size kept where fat-g holds them, and the message's text stands.
        <span className={styles.sentImageMissing} role="img" aria-label={caption === null ? ATTACHMENT_WORDS.unavailable : `${caption}: ${ATTACHMENT_WORDS.unavailable}`}>
          {ATTACHMENT_WORDS.unavailable}
        </span>
      )}
      {caption !== null && <span className={styles.sentImageCaption}>{caption}</span>}
    </li>
  );
}

/**
 * A user's message's images (docs/planning/_archive/M23.md, Design 4; C8, C26): under its text, in a row that
 * wraps, each at most 240 px wide with its name or its size under it; a press opens it in the
 * artifact pane (C27). Its images are the message's own by its explicit ownership, never by a time or
 * an adjacency.
 */
export function MessageAttachments({ images, current }: { readonly images: readonly AttachmentView[]; readonly current: boolean }) {
  const sessionId = useContext(AsideSourceContext)?.sessionId ?? null;
  if (images.length === 0) return null;
  return (
    <ul className={styles.sentImages} aria-label="Images">
      {images.map((image, index) => <SentImage key={image.id} image={image} ordinal={index + 1} sessionId={sessionId} tabIndex={current ? 0 : -1} />)}
    </ul>
  );
}
