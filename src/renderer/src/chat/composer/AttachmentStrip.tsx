// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useRef } from 'react';
import { ATTACHMENT_WORDS, type AttachmentDescriptor, attachmentAddress, MAX_IMAGES } from '@shared/contracts/attachments';
import { Tooltip, useTooltip } from '../../ui/Tooltip';
import type { Staging } from './composer-store';
import styles from './Composer.module.css';

/** A thumbnail's label (C19): its name, or its size in pixels. */
export function attachmentLabel(attachment: Pick<AttachmentDescriptor, 'name' | 'width' | 'height'>, ordinal = 1): string {
  return attachment.name ?? ATTACHMENT_WORDS.unnamed(attachment.width, attachment.height, ordinal);
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

function Thumbnail({ attachment, ordinal, onRemove }: { readonly attachment: AttachmentDescriptor; readonly ordinal: number; readonly onRemove: (id: string) => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = useTooltip();
  const label = attachmentLabel(attachment, ordinal);
  return (
    <li className={styles.thumb} data-attachment={attachment.id}>
      {/* In the input's tab order (C19), an image by its name as it takes the focus, its name and size its tooltip (C16). */}
      <span ref={anchor} className={styles.thumbImage} tabIndex={0} role="img" aria-label={label} {...tooltip.targetProps}>
        <img src={attachmentAddress(attachment.hash)} alt="" draggable={false} />
      </span>
      <Tooltip id={tooltip.id} open={tooltip.open} anchor={anchor}>
        {ATTACHMENT_WORDS.tooltip(attachment.name, attachment.width, attachment.height)}
      </Tooltip>
      {/* In the DOM at all times, shown on hover or focus (the roadmap's rule; C16). */}
      <button type="button" className={styles.thumbRemove} aria-label={ATTACHMENT_WORDS.remove(label)} onClick={() => onRemove(attachment.id)}>
        <RemoveIcon />
      </button>
    </li>
  );
}

/**
 * The draft's images (docs/planning/_archive/M23.md, Design 4; C16, C19, C20): a strip inside the input box,
 * over the text area, each image a 48 px thumbnail drawn through the media route with Remove beside
 * it; a placeholder for each still being kept; and the count once there is more than one.
 */
export function AttachmentStrip({ attachments, staging, onRemove }: { readonly attachments: readonly AttachmentDescriptor[]; readonly staging: readonly Staging[]; readonly onRemove: (id: string) => void }) {
  if (attachments.length === 0 && staging.length === 0) return null;
  const count = attachments.length + staging.length;
  return (
    <div className={styles.strip}>
      <ul className={styles.thumbs} aria-label="Images">
        {attachments.map((attachment, index) => <Thumbnail key={attachment.id} attachment={attachment} ordinal={index + 1} onRemove={onRemove} />)}
        {staging.map((entry) => (
          <li key={`staging-${entry.key}`} className={styles.thumb} data-staging="">
            <span className={styles.thumbPending} role="img" aria-label={`${entry.name ?? 'Image'}, being kept`} />
          </li>
        ))}
      </ul>
      {count > 1 && <span className={styles.count}>{ATTACHMENT_WORDS.count(Math.min(count, MAX_IMAGES))}</span>}
    </div>
  );
}
