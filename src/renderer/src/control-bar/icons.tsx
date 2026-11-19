// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The control bar's own glyphs, drawn inline in the current text colour: no image file ships (C65).
// Decorative — each sits in a button that carries the accessible name.
import styles from './ControlBar.module.css';

export function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M3 6H21M3 12H21M3 18H21" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M19.52 9.26L22.26 9.75L22.26 14.25L19.52 14.74L19.25 15.38L20.84 17.66L17.66 20.84L15.38 19.25L14.74 19.52L14.25 22.26L9.75 22.26L9.26 19.52L8.62 19.25L6.34 20.84L3.16 17.66L4.75 15.38L4.48 14.74L1.74 14.25L1.74 9.75L4.48 9.26L4.75 8.62L3.16 6.34L6.34 3.16L8.62 4.75L9.26 4.48L9.75 1.74L14.25 1.74L14.74 4.48L15.38 4.75L17.66 3.16L20.84 6.34L19.25 8.62ZM15.5 12A3.5 3.5 0 1 0 8.5 12A3.5 3.5 0 1 0 15.5 12Z"
      />
    </svg>
  );
}

/**
 * The Pet window: the screen, and the Pet in its top-right corner — filled while it is shown, its
 * outline alone while it is hidden (`.petMark`, ControlBar.module.css, by the button's aria-pressed).
 */
export function PetIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path d="M2 4H22V20H2Z" stroke="currentColor" strokeWidth="2" fill="none" />
      <path className={styles.petMark} d="M12.5 7.5H18.5V12.5H12.5Z" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** The zoom's frame: four corners, as a viewfinder's, around the percent the button writes in it. */
export function ZoomFrameIcon() {
  return (
    <svg viewBox="0 0 44 22" width="44" height="22" aria-hidden="true" focusable="false">
      <path d="M1 7V1H7M37 1H43V7M43 15V21H37M7 21H1V15" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

export function ChevronIcon({ direction }: { readonly direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d={direction === 'left' ? 'M15 5L8 12L15 19' : 'M9 5L16 12L9 19'} stroke="currentColor" strokeWidth="2.5" fill="none" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M5 5L19 19M19 5L5 19" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}
