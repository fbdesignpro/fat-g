// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { create } from 'zustand';
import styles from './Announcer.module.css';

interface Announcement {
  readonly message: string;
  /** Changes with every announcement, so the same words said twice are heard twice. */
  readonly serial: number;
}

const useAnnouncement = create<Announcement>()(() => ({ message: '', serial: 0 }));

/** Says something to a screen reader, politely: after whatever it is saying now (M12, C72). */
export function announce(message: string): void {
  useAnnouncement.setState((current) => ({ message, serial: current.serial + 1 }));
}

/** The one polite live region, mounted once in the Main window (App.tsx). Seen by no one. */
export function Announcer() {
  const { message, serial } = useAnnouncement();
  return (
    <div className={styles.announcer} aria-live="polite" aria-atomic="true">
      <span key={serial}>{message}</span>
    </div>
  );
}
