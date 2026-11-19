// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from 'react';
import { useAppState } from '../state/store';
import { announce } from '../ui/Announcer';
import { NoticeDialog } from '../ui/NoticeDialog';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import styles from './CleanUp.module.css';
import { closeCleanUpNotice, endCleanUp, startCleanUp, useCleanUp, useCleanUpMode } from './clean-up';

export const CLEAN_UP_TEXT = 'Clean up done';
/** Its tooltip, and what is said when the mode starts. */
export const CLEAN_UP_DESCRIPTION = 'Click sessions to mark them done. Right-click, Escape or a click elsewhere stops.';

/**
 * Clean up done (the maintainer): beside Add project, a compact broom with a check. A
 * press starts the mode of clean-up.ts, in which the pointer carries a green check and each session
 * pressed is marked done; it is pressed while the mode is on, and a press of it then ends the mode as
 * any press outside a session does. While the records file is refused it stays, announced as
 * unavailable, and does nothing, as Add project does (C50).
 */
export function CleanUpButton() {
  const refused = useAppState((state) => state.snapshot?.records?.status.kind === 'refused');
  const on = useCleanUp((state) => state.on);
  const notice = useCleanUp((state) => state.notice);
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  useCleanUpMode();
  useEffect(() => { if (refused) endCleanUp(); }, [refused]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.cleanUp}
        aria-pressed={on}
        aria-disabled={refused || undefined}
        {...tooltip.targetProps}
        onClick={() => {
          if (refused) return;
          startCleanUp();
          announce(CLEAN_UP_DESCRIPTION);
        }}
      >
        <BroomIcon />
        {CLEAN_UP_TEXT}
      </button>
      <Tooltip id={tooltip.id} open={tooltip.open && !on} anchor={anchor} side="right">
        {CLEAN_UP_DESCRIPTION}
      </Tooltip>
      <NoticeDialog open={notice !== null} title={notice?.title ?? CLEAN_UP_TEXT} onClose={closeCleanUpNotice}>
        <p>{notice?.text}</p>
      </NoticeDialog>
    </>
  );
}

/** A broom sweeping down to the left, its head widening to the bristles, and a check in Done's text colour. */
function BroomIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M20.5 3.5L12.5 11.5M10.5 9.5L14.5 13.5L11 21L3 13ZM8.75 13.25L5.7 15.7M10.75 15.25L8.3 18.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
