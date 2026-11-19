// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The command menu (docs/planning/_archive/M23.md, Design 9; C58–C67): over the input while the draft begins
// with `/` and its first word is still being typed. Its rows are main's — fat-g's own first, then the
// CLI's commands, then its skills under their heading — read when it opens (Composer.tsx), and
// filtered by the typed prefix. Up and Down move through them, Enter or a click chooses one and Escape
// closes it; choosing puts `/name ` at the draft's start and leaves the rest to the user. Every text is
// drawn as text. The list is a labelled listbox, its count said once at opening.
import { useEffect } from 'react';
import { type CommandList, type CommandRow, leadingCommand, MENU_WORDS } from '@shared/contracts/composer';
import styles from './Composer.module.css';

/** The rows a typed prefix leaves: those whose name begins with it, in main's order. */
export function matching(rows: readonly CommandRow[], prefix: string): CommandRow[] {
  const typed = prefix.toLowerCase();
  return rows.filter((row) => row.name.toLowerCase().startsWith(typed));
}

/** Whether the menu stands for a draft: it begins with `/` and its first word has no end yet. The prefix typed, or null. */
export function menuOpenFor(draft: string): string | null {
  const name = leadingCommand(draft);
  return name !== null && draft.length === name.length + 1 ? name : null;
}

export interface CommandMenuProps {
  /** What main listed, or null before it answered. */
  readonly list: CommandList | null;
  /** The rows the prefix leaves. */
  readonly rows: readonly CommandRow[];
  readonly listId: string;
  readonly active: number;
  readonly onChoose: (row: CommandRow) => void;
}

export function CommandMenu({ list, rows, listId, active, onChoose }: CommandMenuProps) {
  // The row Up and Down reach is brought into the menu's view: a CLI lists more than it shows (C65).
  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' }); }, [listId, active, rows.length]);
  if (list === null) return null;
  const firstSkill = rows.findIndex((row) => row.group === 'skills');
  return (
    <div className={styles.menu} data-command-menu="">
      <ul id={listId} className={styles.menuRows} role="listbox" aria-label={MENU_WORDS.label}>
        {rows.map((row, index) => (
          <li
            key={`${row.group}:${row.name}:${row.selector ?? ''}`}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            className={styles.menuRow}
            data-active={index === active ? '' : undefined}
            data-group={row.group}
            // A press on a row keeps the focus in the input: the row is chosen, and the typing goes on.
            onMouseDown={(event) => { event.preventDefault(); onChoose(row); }}
          >
            {index === firstSkill && <span className={styles.menuHeading}>{MENU_WORDS.skills}</span>}
            <span className={styles.menuName}>/{row.name}</span>
            {row.hint !== null && <span className={styles.menuHint}>{row.hint}</span>}
            {row.description !== null && <span className={styles.menuDescription}>{row.description}</span>}
          </li>
        ))}
      </ul>
      {rows.length === 0 && list.rows.length > 0 && <p className={styles.menuNote}>{MENU_WORDS.none}</p>}
      {list.rows.length === 0 && list.note === null && <p className={styles.menuNote}>{MENU_WORDS.empty}</p>}
      {list.note !== null && <p className={styles.menuNote}>{list.note}</p>}
    </div>
  );
}
