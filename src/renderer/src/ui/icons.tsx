// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Glyphs more than one feature draws, inline in the current text colour: no image file ships
// (decision 0007). Decorative — each sits in a button that carries the accessible name.

/** The trash can's strokes: a lid and its handle, a tapered can, two ribs. The plan tab's Remove draws them too. */
export const TRASH_PATH = 'M4 6.5h16M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-13M10 10.5v6.5M14 10.5v6.5';

/** A plan's mark (the maintainer): a bulb's round glass on its neck, a filament, two bands of its base. */
export function LightBulbIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 17v-2.8A6 6 0 1 1 15 14.2V17Z" />
      <path d="M10.5 12.5 12 14l1.5-1.5M12 14v3" />
      <path d="M9.5 19.5h5M10.5 22h3" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={TRASH_PATH} />
    </svg>
  );
}
