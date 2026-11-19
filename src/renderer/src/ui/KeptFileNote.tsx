// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { CloseIcon } from '../control-bar/icons';
import styles from './KeptFileNote.module.css';

/** A recovery receipt the user can dismiss. Key by path so a later recovery shows a new receipt. */
export function KeptFileNote({ file, path, className }: {
  readonly file: 'projects' | 'preferences';
  readonly path: string;
  readonly className: string | undefined;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className={`${className ?? ''} ${styles.note}`} role="status">
      <p className={styles.text}>
        Your old {file} file was kept as <span className={styles.path}>{path}</span>
      </p>
      <button type="button" className={styles.close} aria-label={`Dismiss ${file} recovery notice`} onClick={() => setDismissed(true)}>
        <CloseIcon />
      </button>
    </div>
  );
}
