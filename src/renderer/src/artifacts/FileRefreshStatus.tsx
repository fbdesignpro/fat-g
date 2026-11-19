// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { formatAgo, formatDateTime, formatTime } from '../ui/format';
import styles from './ArtifactBar.module.css';

/** Shared by text and image file tabs; update the age at minute boundaries. */
export function FileRefreshStatus({ failed, updatedAt, failedTip, manuallyReloaded = false }: { readonly failed: boolean; readonly updatedAt: number | null; readonly failedTip: string; readonly manuallyReloaded?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (updatedAt === null || failed) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const current = Date.now();
      setNow(current);
      const elapsed = Math.max(0, current - updatedAt);
      timer = setTimeout(tick, 60_000 - (elapsed % 60_000));
    };
    tick();
    return () => clearTimeout(timer);
  }, [updatedAt, failed]);
  if (failed) return <span title={failedTip} data-file-refresh="failed">auto refresh failed</span>;
  if (updatedAt === null) return null;
  const seconds = Math.floor(Math.max(0, now - updatedAt) / 1000);
  const ago = seconds < 60 ? 'seconds ago' : formatAgo(updatedAt, now);
  return <span className={styles.refreshUpdated} title={`${formatDateTime(updatedAt)} · ${formatTime(updatedAt)}`} data-file-refresh="updated">{manuallyReloaded ? 'Reloaded' : `Auto-updated at ${formatTime(updatedAt)} ·`} {ago}</span>;
}
