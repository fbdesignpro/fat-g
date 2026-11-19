// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CSSProperties, PointerEvent, RefObject } from 'react';
import type { SessionFlag } from '@shared/contracts/session-flags';
import { attentionWords, capitalize, groupOfSession, type SessionEntry } from '@shared/contracts/sessions';
import { Avatar, useBarColor } from './Avatar';
import { canCleanUp } from './clean-up-target';
import { FlagMarks, spokenFlags } from './flags';
import { SessionMenu } from './SessionMenu';
import styles from './Sessions.module.css';

export interface ThinCapsuleProps {
  readonly onStep: (direction: -1 | 1) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly wasDragged: () => boolean;
  readonly lifted: boolean;
  readonly shift: number;
  readonly entry: SessionEntry;
  readonly name: string;
  readonly selected: boolean;
  readonly column: RefObject<HTMLElement | null>;
  /** `byPointer`: a press of the pointer, not a key (M100b, C61). */
  readonly onSelect: (byPointer: boolean) => void;
  readonly onFlag: (flag: SessionFlag, on: boolean) => void;
  /** A shelved session's Done; a completed one has none. */
  readonly onComplete: () => void;
  /** Back to the active list: Unshelve, for a session on the shelf, or Restore, for a completed one. */
  readonly onRestore: () => void;
  /** A completed session's: to the shelf, as a shelved one. */
  readonly onShelve: () => void;
  /** Null while removal is not offered (M18, C42). */
  readonly onRemove: (() => void) | null;
  /** Its menu opened or closed (SessionMenu). */
  readonly onMenuChange?: (open: boolean) => void;
}

/**
 * A session on the shelf or completed (M14, C46, C48, C49; M100, C26): a box of half an active
 * capsule's height, the avatar at half the size and the name on one line, the marks of its flags at
 * the end of the line, and the `…` button beside it. A completed one's name is in the muted colour
 * and its menu holds its flags, Shelve, Restore and Remove; a shelved one's is in the text colour,
 * with Done and Unshelve in its menu, and an attention it has not had seen — a decision waiting, a
 * stop, an error — in its words on the attention colour, so the shelf hides none. It selects its
 * session like an active one, and shares its pointer and keyboard reordering within its own group.
 */
export function ThinCapsule({ entry, name, selected, column, onSelect, onFlag, onComplete, onRestore, onShelve, onRemove, onMenuChange, onStep, onPointerDown, wasDragged, lifted, shift }: ThinCapsuleProps) {
  const { record, summary } = entry;
  const barColor = useBarColor(record.providerId);
  const shelved = record.shelvedAt !== null;
  // An acknowledged attention — the dim READY almost every idle session holds — is not shown.
  const attention = shelved && summary.attention !== null && !summary.attention.acknowledged ? attentionWords(summary.attention) : null;
  return (
    <li
      className={`${styles.capsule} ${styles.thin}`}
      data-thin-session={record.id}
      data-session-id={record.id}
      data-group={groupOfSession(record)}
      data-lifted={lifted || undefined}
      data-shelved={shelved || undefined}
      data-selected={selected || undefined}
      data-clean-up-target={canCleanUp(entry) || undefined}
      style={{ ...(barColor === undefined ? {} : ({ '--bar-color': barColor } as CSSProperties)), ...(shift === 0 ? {} : { transform: `translateY(${shift}px)` }) }}
    >
      <button
        type="button"
        className={styles.thinSelect}
        aria-label={`${name}, ${shelved ? 'shelved' : 'completed'}${attention === null ? '' : `, ${attention}`}${spokenFlags(record)}`}
        aria-current={selected ? 'true' : undefined}
        data-select-session={record.id}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onPointerDown={onPointerDown}
        onClick={(event) => { if (!wasDragged()) onSelect(event.detail > 0); }}
        onKeyDown={(event) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          onStep(event.key === 'ArrowUp' ? -1 : 1);
        }}
      >
        <Avatar providerId={record.providerId} avatar={entry.avatar} size="thin" />
        <span className={styles.thinName}>{name}</span>
        {attention !== null && <span className={styles.thinAttention} data-thin-attention={summary.attention?.kind}>{capitalize(attention)}</span>}
        <FlagMarks record={record} />
      </button>
      <div className={styles.side}>
        <SessionMenu
          sessionId={record.id}
          name={name}
          completed={!shelved}
          column={column}
          flags={record}
          onFlag={onFlag}
          onComplete={onComplete}
          {...(shelved ? { onUnshelve: onRestore } : { onShelve, onRestore })}
          onRemove={onRemove}
          onOpenChange={onMenuChange}
        />
      </div>
    </li>
  );
}
