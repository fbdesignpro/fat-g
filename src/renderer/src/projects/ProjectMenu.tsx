// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type RefObject, useEffect } from 'react';
import type { ProjectEntryView } from '@shared/contracts/projects';
import { menuStyles, Popup } from '../ui/Popup';
import { useMenu } from '../ui/useMenu';
import styles from './Projects.module.css';

export interface ProjectMenuProps {
  readonly entry: ProjectEntryView;
  /** The project column: the menu closes when it scrolls. */
  readonly column: RefObject<HTMLElement | null>;
  readonly onEdit: () => void;
  readonly onToggleHidden: () => void;
  /** Null while removal is not offered: the conversation store is refused, and a removal could not reach the chats (M18, C42). */
  readonly onRemove: (() => void) | null;
  /** Alt+Up and Alt+Down on the button (C72). */
  readonly onStep: (direction: -1 | 1) => void;
}

/**
 * A project's `…` button and its menu of Edit, Hide or Show, and Remove — Remove alone for an entry
 * fat-g cannot read (C40, C44, C60). Operated like the application menu (useMenu). The column
 * scrolls and clips, so the menu opens in a popup (ui/Popup), placed fixed below its button as the
 * usage panel is; it closes when the column scrolls.
 *
 * The actions button carries the project's keyboard moves.
 */
export function ProjectMenu({ entry, column, onEdit, onToggleHidden, onRemove, onStep }: ProjectMenuProps) {
  const { open, setOpen, close, button, buttonProps, menuProps } = useMenu();
  const label = `Actions for ${entry.kind === 'project' ? entry.name : 'unreadable project'}`;

  useEffect(() => {
    const scroller = column.current;
    if (!open || scroller === null) return;
    const onScroll = (): void => setOpen(false);
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [open, column, setOpen]);

  const choose = (action: () => void) => (): void => {
    close(true);
    action();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (entry.kind === 'project') onStep(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    buttonProps.onKeyDown(event);
  };

  // An entry fat-g cannot read has Remove alone: with that not offered there is no menu to open.
  if (entry.kind !== 'project' && onRemove === null) return null;

  return (
    <>
      <button
        {...buttonProps}
        onKeyDown={onKeyDown}
        type="button"
        className={styles.actions}
        aria-label={label}
        aria-keyshortcuts={entry.kind === 'project' ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        data-actions-for={entry.key}
      >
        <DotsIcon />
      </button>
      {open && (
        <Popup anchor={button}>
          <div {...menuProps} aria-label={label} className={menuStyles.menu}>
            {entry.kind === 'project' && (
              <>
                <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={choose(onEdit)}>
                  Edit
                </button>
                <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={choose(onToggleHidden)}>
                  {entry.hidden ? 'Show' : 'Hide'}
                </button>
              </>
            )}
            {onRemove !== null && (
              <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={choose(onRemove)}>
                Remove
              </button>
            )}
          </div>
        </Popup>
      )}
    </>
  );
}

export function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M4 10H8V14H4ZM10 10H14V14H10ZM16 10H20V14H16Z" />
    </svg>
  );
}
