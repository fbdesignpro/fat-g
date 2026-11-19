// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { openProjectDialog } from '../projects/project-dialog-store';
import { SessionSearch } from '../session-search/SessionSearch';
import { CleanUpButton } from '../sessions/CleanUpButton';
import { useAppState } from '../state/store';
import styles from './Shell.module.css';

/**
 * Add project (docs/planning/_archive/M100.md, Design 4; C20): a box at the right of the project column's cell
 * in the top band, its bottom edge level with the usage box's. It no longer scrolls with the list.
 * It opens the project dialog, as the app menu's item does (M12, C35); while the records file is
 * refused it stays, announced as unavailable, and does nothing (C50). Nothing shows before the
 * first state arrives.
 *
 * Search and Clean up done stand beside it, in the same order on either side.
 */
export function AddProjectButton() {
  const status = useAppState((state) => state.snapshot?.records?.status.kind);
  if (status === undefined) return <div className={styles.addProjectCell} />;
  const refused = status === 'refused';
  const add = (
    <button key="add" type="button" className={styles.addProject} data-add-project="" aria-disabled={refused || undefined} onClick={() => { if (!refused) openProjectDialog(null); }}>
      <PlusIcon />
      Add project
    </button>
  );
  const cleanUp = <CleanUpButton key="clean-up" />;
  const search = <SessionSearch key="search" />;
  return <div className={styles.addProjectCell}>{[add, search, cleanUp]}</div>;
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}
