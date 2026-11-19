// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type RefObject, useEffect, useId, useRef } from 'react';
import { SESSION_FLAGS, type SessionFlag, type SessionFlags } from '@shared/contracts/session-flags';
import { DotsIcon } from '../projects/ProjectMenu';
import { menuStyles, Popup } from '../ui/Popup';
import { useMenu } from '../ui/useMenu';
import { FLAG_WORDS, FLAGS_HEADER, FlagMark } from './flags';
import styles from './Sessions.module.css';

export const SHELVE_TEXT = 'Shelve';
export const UNSHELVE_TEXT = 'Unshelve';
export const RESTORE_TEXT = 'Restore';

export interface SessionMenuProps {
  /** The session's id: its button carries it, so the list can hand the focus back to it after a move. */
  readonly sessionId: string;
  /** The session's shown name: the button and its menu are named after it. */
  readonly name: string;
  /** A completed session's menu holds its flags, Unshelve or Restore, and Destroy forever: no Done (C91). */
  readonly completed: boolean;
  /** The project column: the menu closes when it scrolls. */
  readonly column: RefObject<HTMLElement | null>;
  readonly flags: SessionFlags;
  /** A flag pressed: set when it was not, cleared when it was. The menu stays open for the next. */
  readonly onFlag: (flag: SessionFlag, on: boolean) => void;
  readonly onComplete: () => void;
  /** Null while removal is not offered: the conversation store is refused, and a removal could not reach the chat (M18, C42). */
  readonly onRemove: (() => void) | null;
  /** Turns the name into a field (M26). Left out where the row has no field for it. */
  readonly onRename?: () => void;
  /** Puts the session on the shelf: an active one's, and a completed one's. */
  readonly onShelve?: () => void;
  /** Back to the active list: a shelved session's. */
  readonly onUnshelve?: () => void;
  /** Back to the active list: a completed session's. */
  readonly onRestore?: () => void;
  /** The menu opened or closed: the list keeps the capsule where it is while its menu is open. */
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * A capsule's `…` button and its menu (M14, C91). At its head, under a Flags header, one checkable
 * item for each flag: a press sets or clears it and leaves the menu open, so several are set in one
 * opening. Then, below a rule, the session's actions: Rename, where the row offers it (M26); Done,
 * for a session that is not completed — the word the session window's button says (M100, C31);
 * Shelve, Unshelve or Restore; and Destroy forever. Operated like a project header's menu (useMenu), in the same popup.
 */
export function SessionMenu({ sessionId, name, completed, column, flags, onFlag, onComplete, onRemove, onRename, onShelve, onUnshelve, onRestore, onOpenChange }: SessionMenuProps) {
  const { open, setOpen, close, button, buttonProps, menuProps } = useMenu();
  const label = `Actions for ${name}`;
  const headerId = useId();

  useEffect(() => {
    const scroller = column.current;
    if (!open || scroller === null) return;
    const onScroll = (): void => setOpen(false);
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [open, column, setOpen]);

  // Told on a change alone: the first render says nothing.
  const told = useRef(open);
  useEffect(() => {
    if (told.current === open) return;
    told.current = open;
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const choose = (action: () => void) => (): void => {
    close(true);
    action();
  };

  return (
    <>
      <button {...buttonProps} type="button" className={styles.sideButton} aria-label={label} data-session-menu={sessionId}>
        <DotsIcon />
      </button>
      {open && (
        <Popup anchor={button}>
          <div {...menuProps} aria-label={label} className={menuStyles.menu}>
            <div role="group" aria-labelledby={headerId}>
              <p id={headerId} className={menuStyles.menuNote}>{FLAGS_HEADER}</p>
              {SESSION_FLAGS.map((flag) => (
                <button key={flag} type="button" role="menuitemcheckbox" aria-checked={flags[flag]} tabIndex={-1} className={menuStyles.item} data-flag={flag} onClick={() => onFlag(flag, !flags[flag])}>
                  <span className={styles.flagItem}>
                    <span className={styles.flagCheck} aria-hidden="true">{flags[flag] ? '✓' : ''}</span>
                    <FlagMark flag={flag} />
                    {FLAG_WORDS[flag].item}
                  </span>
                </button>
              ))}
            </div>
            <div role="separator" className={menuStyles.rule} />
            {onRename !== undefined && (
              // The focus goes to the field, not back to this button.
              <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={() => { close(false); onRename(); }}>
                Rename
              </button>
            )}
            {!completed && (
              <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} data-audio="dedicated" onClick={choose(onComplete)}>
                Done
              </button>
            )}
            {onShelve !== undefined && (
              <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} data-audio="dedicated" onClick={choose(onShelve)}>
                {SHELVE_TEXT}
              </button>
            )}
            {onUnshelve !== undefined && (
              <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} data-audio="dedicated" onClick={choose(onUnshelve)}>
                {UNSHELVE_TEXT}
              </button>
            )}
            {onRestore !== undefined && (
              <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} data-audio="dedicated" onClick={choose(onRestore)}>
                {RESTORE_TEXT}
              </button>
            )}
            {onRemove !== null && (
              <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} onClick={choose(onRemove)}>
                Destroy forever
              </button>
            )}
          </div>
        </Popup>
      )}
    </>
  );
}
