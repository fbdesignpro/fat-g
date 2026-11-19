// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { invoke } from '../ipc/client';
import { openProjectDialog } from '../projects/project-dialog-store';
import { useAppState } from '../state/store';
import { useMenu } from '../ui/useMenu';
import styles from './ControlBar.module.css';
import { MenuIcon } from './icons';

/**
 * The application menu (C31–C33): a DOM menu with Add project (M12, C35) and Exit. Its keyboard and
 * pointer behaviour is useMenu's. Add project is disabled — announced as such, still reachable —
 * while the records file is refused (C50).
 */
export function AppMenu() {
  const { open, setOpen, buttonProps, menuProps } = useMenu();
  const refused = useAppState((state) => state.snapshot?.records?.status.kind === 'refused');

  const addProject = (): void => {
    if (refused) return;
    setOpen(false);
    openProjectDialog(null);
  };

  const exit = (): void => {
    setOpen(false);
    // Main answers, then quits the normal way (src/main/ipc/handlers/app.ts). Nothing to show if the
    // call fails: the window is on its way out, or main is.
    invoke('app:quit', null).catch(() => undefined);
  };

  return (
    <div className={styles.menuAnchor}>
      <button {...buttonProps} type="button" className={styles.iconButton} aria-label="Menu">
        <MenuIcon />
      </button>
      {open && (
        <div {...menuProps} aria-label="Menu" className={styles.menu}>
          <button type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} aria-disabled={refused || undefined} onClick={addProject}>
            Add project
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className={styles.menuItem} onClick={exit}>
            Exit
          </button>
        </div>
      )}
    </div>
  );
}
