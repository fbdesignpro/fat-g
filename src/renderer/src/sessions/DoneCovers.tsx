// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { DONE_FLASH_STYLE, useLeaving } from './leaving';
import styles from './Sessions.module.css';

/** Done's check, as its button draws it, in the flash's dark green, shown on its green steps: `size` in CSS pixels, or the stylesheet's. */
export function DoneCheck({ size }: { readonly size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-done-check="">
      <path d="M4.5 12.5L9.5 17.5L19.5 6.5" />
    </svg>
  );
}

/**
 * The Done flash over the capsule, chat window and artifact pane (leaving.ts): a box over each, where it
 * was at the press, fixed over the page and taking no pointer — growing from its centre over
 * what still shows, optionally flashing, then fading in place with white over the green.
 * The capsule's cover
 * lives here too, sharing the panels' drawing and timings. It outlives
 * what it covers, which goes with main's push under the full box — the window left empty, the pane
 * gone — and shows what is left as it fades.
 */
export function DoneCovers() {
  const leaving = useLeaving((state) => state.leaving);
  return Object.entries(leaving).flatMap(([id, entry]) => {
    if (entry.phase !== 'flash') return [];
    const boxes = entry.covers.map((rect, index) => ({ rect, capsule: false, check: index === 0 }));
    if (entry.slot !== null) boxes.push({ rect: entry.slot, capsule: true, check: true });
    return boxes.map(({ rect, capsule, check }, index) => (
      <div
        key={`${id}:${entry.serial}:${index}`}
        className={styles.cover}
        data-done-cover={capsule ? undefined : id}
        data-done-capsule={capsule ? id : undefined}
        data-phase={entry.phase}
        data-animation={entry.animation}
        aria-hidden="true"
        style={{ ...DONE_FLASH_STYLE, left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      >
        {check && <DoneCheck size={Math.round(Math.min(rect.width, rect.height) * (capsule ? 0.7 : 0.45))} />}
      </div>
    ));
  });
}
