// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type PointerEvent, type ReactNode, type RefObject, useId, useRef, useState } from 'react';
import { UNKNOWN_COLOR_FALLBACK } from '@shared/contracts/projects';
import { NewSessionButton } from '../new-session/NewSessionButton';
import { groupOf } from './reorder';
import { ProjectMenu, type ProjectMenuProps } from './ProjectMenu';
import styles from './Projects.module.css';

export interface ProjectHeaderProps extends Omit<ProjectMenuProps, 'column'> {
  readonly column: RefObject<HTMLElement | null>;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>, key: string) => void;
  readonly wasDragged: () => boolean;
  readonly onToggleCollapsed: () => Promise<boolean>;
  /** While this header is being dragged: its copy follows the pointer, and its place is drawn empty. */
  readonly lifted: boolean;
  /** How far it moves out of the way of a dragged project, in pixels (C86). */
  readonly shift: number;
  /** The project's sessions, below the header (M14, C37). They move with it, and are no part of what drags it. */
  readonly children?: ReactNode;
}

/**
 * One project in the list: a bar with its name, in the bar pair (docs/planning/_archive/M100.md, Design 5; C22),
 * and under it the project's sessions (M14). The project's colour is drawn nowhere for now and stays
 * on the header as an attribute, for a later look (M100, C23). A long name ends in an ellipsis, and the
 * DOM keeps it whole, so its accessible name is whole (C43). The name tells projects apart. A
 * folder gone missing shows a mark with a text alternative (C28). The `+` before the `…` opens the
 * new-chat screen (M14, C54).
 * The arrow and name unfold or fold its sessions, kept mounted so their own folds survive.
 *
 * An entry fat-g cannot read shows at its place as "Unreadable project", with Remove only, and is
 * never dragged — though it moves out of the way of one (C60, C86). It has no `+` and shows no session.
 */
export function ProjectHeader({ entry, column, onPointerDown, wasDragged, onToggleCollapsed, lifted, shift, children, ...menu }: ProjectHeaderProps) {
  const sessionsId = useId();
  const changing = useRef(false);
  const [folding, setFolding] = useState(false);
  const moved = shift === 0 ? undefined : { transform: `translateY(${shift}px)` };
  if (entry.kind === 'unreadable') {
    return (
      <li className={styles.entry} data-entry-key={entry.key} data-group="visible" style={moved}>
        <div className={`${styles.header} ${styles.unreadable}`}>
          <h3 className={styles.name}>Unreadable project</h3>
          <ProjectMenu entry={entry} column={column} {...menu} />
        </div>
      </li>
    );
  }
  const missing = entry.roots.some((root) => root.missing);
  return (
    <li className={styles.entry} data-entry-key={entry.key} data-group={groupOf(entry)} data-lifted={lifted || undefined} style={moved}>
      <div className={styles.header} data-color={entry.color ?? UNKNOWN_COLOR_FALLBACK} onPointerDown={(event) => onPointerDown(event, entry.key)}>
        <h3 className={styles.name}>
          <button
            type="button"
            className={styles.disclosure}
            data-project-disclosure=""
            aria-expanded={!entry.collapsed}
            aria-controls={sessionsId}
            aria-disabled={folding || undefined}
            title={`${entry.collapsed ? 'Expand' : 'Collapse'} ${entry.name}`}
            onClick={(event) => {
              if (changing.current || (event.detail > 0 && wasDragged())) return;
              changing.current = true;
              setFolding(true);
              void onToggleCollapsed().finally(() => {
                changing.current = false;
                setFolding(false);
              });
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" className={styles.chevron}>
              <path d={entry.collapsed ? 'M9 5L16 12L9 19' : 'M5 9L12 16L19 9'} stroke="currentColor" strokeWidth="2.5" fill="none" />
            </svg>
            <span className={styles.disclosureName}>{entry.name}</span>
          </button>
        </h3>
        {missing && (
          <span className={styles.missing} role="img" aria-label="A folder is missing">
            <MissingIcon />
          </span>
        )}
        <NewSessionButton project={entry} className={styles.actions} />
        <ProjectMenu entry={entry} column={column} {...menu} />
      </div>
      <div id={sessionsId} hidden={entry.collapsed}>{children}</div>
    </li>
  );
}

function MissingIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="currentColor" fillRule="evenodd" d="M12 2L23 21H1ZM11 9V15H13V9ZM11 17V19H13V17Z" />
    </svg>
  );
}
