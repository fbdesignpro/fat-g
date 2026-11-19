// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The queue's rows under the input (docs/planning/_archive/M23.md, Design 7; C48, C50, C51, C54, C89): one row a
// queued message, oldest first and newest last, each its text's first line clipped to the row, its
// images counted, and Edit and Remove — in the DOM at all times, seen while the pointer is over the row
// or the focus in it. The message being sent says so and takes neither. A row moves by a pointer's drag
// — pointer events, never a native drag, whose data any program may receive (M100, C69) — or by
// Alt+Up and Alt+Down while it has the focus; main checks the whole order. A paused queue says why, in
// the send's own words, with Resume. A Send now held until the turn takes it says so, and stays first:
// it is neither moved nor passed.
import { type KeyboardEvent, type PointerEvent, useEffect, useState } from 'react';
import type { SendBlock } from '@shared/contracts/sessions';
import type { SendRefusal } from '@shared/contracts/chat';
import { COMPOSER_WORDS, type QueuedMessage, type QueueView } from '@shared/contracts/composer';
import { sendRefusalText } from '../card-words';
import styles from './Composer.module.css';

/** What a row says of a message's images: none, one, or how many. */
export function imagesWords(count: number): string | null {
  if (count === 0) return null;
  return count === 1 ? '+1 image' : `+${count} images`;
}

/** The first line of a queued message's text: the row clips it to its width. */
const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0] ?? '';

export interface QueueListProps {
  readonly queue: QueueView;
  readonly providerName: string;
  readonly onEdit: (entryId: string) => void;
  readonly onRemove: (entryId: string) => void;
  /** The whole queue in its new order, by id (C51). */
  readonly onReorder: (ids: readonly string[]) => void;
  readonly onResume: () => void;
}

export function QueueList({ queue, providerName, onEdit, onRemove, onReorder, onResume }: QueueListProps) {
  const [dragged, setDragged] = useState<string | null>(null);
  const { entries, paused } = queue;
  // A row moved by Alt+Up or Alt+Down keeps the focus, and is brought into the rows' view, which scrolls past three rows.
  const order = entries.map((entry) => entry.id).join(' ');
  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.hasAttribute('data-queue-entry')) focused.scrollIntoView?.({ block: 'nearest' });
  }, [order]);
  if (entries.length === 0 && paused === null) return null;
  const ids = entries.map((entry) => entry.id);

  /** The rows that stay first: the one being sent (C54), and each Send now held. */
  const pinned = entries.findIndex((entry) => !entry.sending && !entry.now);
  const first = pinned === -1 ? entries.length : pinned;

  /** The order with one entry moved to another's place. The rows that stay first neither move nor are passed. */
  const moved = (id: string, to: number): readonly string[] | null => {
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return null;
    if (from < first || to < first) return null;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, id);
    return next;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, entry: QueuedMessage, index: number): void => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const next = moved(entry.id, event.key === 'ArrowUp' ? index - 1 : index + 1);
    if (next !== null) onReorder(next);
  };

  /** The row a pointer's drag lets go over: its place, or none outside the rows. */
  const placeAt = (event: PointerEvent<HTMLLIElement>): number => {
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-queue-entry]');
    return over === null || over === undefined ? -1 : ids.indexOf(over.getAttribute('data-queue-entry') ?? '');
  };

  const onPointerDown = (event: PointerEvent<HTMLLIElement>, entry: QueuedMessage): void => {
    // A press on Edit or Remove is theirs; the main button alone starts a drag.
    if (entry.sending || entry.now || event.button !== 0 || (event.target as HTMLElement).closest('button') !== null) return;
    setDragged(entry.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerUp = (event: PointerEvent<HTMLLIElement>): void => {
    const id = dragged;
    setDragged(null);
    if (id === null) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const next = moved(id, placeAt(event));
    if (next !== null) onReorder(next);
  };

  return (
    <div className={styles.queue} data-queue="">
      {entries.length > 0 && (
        <ol className={styles.queueRows} aria-label="Queued messages">
          {entries.map((entry, index) => {
            const images = imagesWords(entry.attachments.length);
            const line = firstLine(entry.text);
            return (
              <li
                key={entry.id}
                className={styles.queueRow}
                data-queue-entry={entry.id}
                data-sending={entry.sending ? '' : undefined}
                data-held={entry.now ? '' : undefined}
                data-dragged={dragged === entry.id ? '' : undefined}
                tabIndex={0}
                aria-label={[entry.now ? COMPOSER_WORDS.heldLabel : null, line, images, entry.sending ? COMPOSER_WORDS.sending : null].filter((part) => part !== null && part !== '').join(', ')}
                onPointerDown={(event) => onPointerDown(event, entry)}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDragged(null)}
                onKeyDown={(event) => onKeyDown(event, entry, index)}
              >
                {entry.now && <span className={styles.queueHeld} aria-hidden="true">{COMPOSER_WORDS.held}</span>}
                <span className={styles.queueText}>{line}</span>
                {images !== null && <span className={styles.queueImages}>{images}</span>}
                {entry.sending ? (
                  <span className={styles.queueSending}>{COMPOSER_WORDS.sending}</span>
                ) : (
                  <span className={styles.queueActions}>
                    <button type="button" className={styles.queueButton} onClick={() => onEdit(entry.id)}>{COMPOSER_WORDS.edit}</button>
                    <button type="button" className={styles.queueButton} onClick={() => onRemove(entry.id)}>{COMPOSER_WORDS.remove}</button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {paused !== null && (
        <div className={styles.queuePaused} role="status">
          <p>{COMPOSER_WORDS.paused} {sendRefusalText(paused.reason as SendRefusal | SendBlock, providerName)}</p>
          <button type="button" className={styles.queueButton} onClick={onResume}>{COMPOSER_WORDS.resume}</button>
        </div>
      )}
    </div>
  );
}
