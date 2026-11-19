// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import styles from './Sessions.module.css';

/**
 * The dim row between a project's shelf and its completed sessions (M14, C47), in two halves: "n on
 * the shelf" with an up chevron folds the shelf above it, "n completed" with a down chevron the part
 * below. Each half is a button with its expanded state. Both parts start folded at every launch
 * (M100, C88, C94), and neither state is saved.
 */
export function ToggleRow({ shelf, completed, shelfOpen, completedOpen, onToggleShelf, onToggleCompleted }: {
  readonly shelf: number;
  readonly completed: number;
  readonly shelfOpen: boolean;
  readonly completedOpen: boolean;
  readonly onToggleShelf: () => void;
  readonly onToggleCompleted: () => void;
}) {
  return (
    <div className={styles.toggleRow} data-toggle-row="">
      <button type="button" className={styles.toggle} aria-expanded={shelfOpen} disabled={shelf === 0} data-toggle="shelf" onClick={onToggleShelf}>
        <span>{shelf} on the shelf</span>
        <Chevron up open={shelfOpen} />
      </button>
      <button type="button" className={styles.toggle} aria-expanded={completedOpen} disabled={completed === 0} data-toggle="completed" onClick={onToggleCompleted}>
        <span>{completed} completed</span>
        <Chevron up={false} open={completedOpen} />
      </button>
    </div>
  );
}

/** Points at the part it folds while that part is open, and sideways once it is folded. */
function Chevron({ up, open }: { readonly up: boolean; readonly open: boolean }) {
  const path = !open ? 'M9 5L16 12L9 19' : up ? 'M5 15L12 8L19 15' : 'M5 9L12 16L19 9';
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={path} stroke="currentColor" strokeWidth="2.5" fill="none" />
    </svg>
  );
}
