// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from 'react';
import { ProjectList } from '../projects/ProjectList';
import styles from './Shell.module.css';

/**
 * The project list's column: full height, on the side the preference names, and the one region that
 * scrolls (M11, C27). Its contents are src/renderer/src/projects' (M12).
 *
 * Nothing is dragged out of it: a project is reordered with pointer events, and the browser's own
 * drag of an element or a selection is stopped here, so no other program becomes a drop target (C69).
 */
export function ProjectColumn() {
  const column = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = column.current;
    if (element === null) return;
    const stop = (event: Event): void => event.preventDefault();
    element.addEventListener('dragstart', stop);
    return () => element.removeEventListener('dragstart', stop);
  }, []);

  return (
    <aside ref={column} className={styles.projectColumn} aria-label="Projects">
      <ProjectList column={column} />
    </aside>
  );
}
