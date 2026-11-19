// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { UsageWindow } from '@shared/contracts/usage';
import { remainingPercent } from '../ui/format';
import styles from './UsageBlock.module.css';

/**
 * One usage window as a bar (M11; M100, C55, C85): its label, a track with a mark at each end in
 * the provider's colour and a fill as wide as the share that remains — 100 % less the share used,
 * clamped to 0–100 — as the note above the usage box says, and after the track `countdown`, how
 * long until the window resets, which the block gives it tightly ("5d5h", "3h32") and leaves empty
 * where the bar above says the same, or the provider does not say. No percentage is written: the
 * meter's value and the rollover panel say it. A window with no data keeps its marks and says so
 * between them — never 0 %, which would read as "nothing left" (C62).
 *
 * The same warning or critical level looks the same as any other in M11 (S7).
 */
export function UsageBar({ window, historical, countdown }: { readonly window: UsageWindow; readonly historical: boolean; readonly countdown: string }) {
  // A model's own limit is named after the model, as in the mockup ("Fable"); the panel says both.
  const label = window.scope ?? window.label;
  const name = `${window.label}${window.scope === undefined ? '' : `, ${window.scope}`} usage`;
  const reset = (
    <span className={styles.countdown} data-reset-countdown="">
      {countdown}
    </span>
  );

  if (window.usedPercent === null) {
    return (
      <div className={styles.bar}>
        <span className={styles.label}>{label}</span>
        <div className={styles.track} role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuetext="No data">
          <span className={styles.message}>No data</span>
        </div>
        {reset}
      </div>
    );
  }

  const value = remainingPercent(window.usedPercent);
  const rounded = Math.round(value);
  return (
    <div className={styles.bar}>
      <span className={styles.label}>{label}</span>
      <div
        className={styles.track}
        role="meter"
        aria-label={name}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${rounded} percent remaining${historical ? ', historical reading' : ''}`}
      >
        <span className={styles.fillArea}>
          <span className={styles.fill} data-hollow={historical ? '' : undefined} style={{ width: `${value}%` }} />
        </span>
      </div>
      {reset}
    </div>
  );
}

/** Where a provider has no usage to show: one track, its two marks, and a short status between them (C39). */
export function StatusTrack({ label }: { readonly label: string }) {
  return (
    <div className={`${styles.track} ${styles.statusTrack}`}>
      <span className={styles.message}>{label}</span>
    </div>
  );
}
