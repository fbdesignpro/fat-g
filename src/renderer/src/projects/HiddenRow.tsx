// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import styles from './Projects.module.css';

export function hiddenRowText(count: number): string {
  if (count === 0) return 'No hidden projects';
  return count === 1 ? '1 hidden project' : `${count} hidden projects`;
}

/**
 * The grey row after the visible projects (C47): it opens and closes the hidden list below it. Closed
 * at every launch, and never saved (C48). During a drag it is a drop target, even with nothing hidden
 * yet (C75), lights up while it is the target, and moves out of the way like an entry (C86).
 */
export function HiddenRow({ count, open, onToggle, target, shift }: {
  readonly count: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly target: boolean;
  readonly shift: number;
}) {
  return (
    <button
      type="button"
      className={styles.hiddenRow}
      aria-expanded={open}
      onClick={onToggle}
      data-hidden-row=""
      data-target={target || undefined}
      style={shift === 0 ? undefined : { transform: `translateY(${shift}px)` }}
    >
      <span>{hiddenRowText(count)}</span>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" className={styles.chevron}>
        <path d={open ? 'M5 9L12 16L19 9' : 'M9 5L16 12L9 19'} stroke="currentColor" strokeWidth="2.5" fill="none" />
      </svg>
    </button>
  );
}
