// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// How the Pet's window follows its list (decision 0010): its width is its capsules' size and its
// height its list's (src/shared/contracts/pet.ts). Pure, like bounds.ts: displays arrive as plain
// rectangles, in DIPs.
import { PET_LAYOUT } from '@shared/contracts/pet';
import { type DisplayLayout, fitBoundsToDisplays, mostOverlapping, type Rect, roundRect, type Size } from './bounds';
import { petPlacement } from './placement';

/**
 * The least of the Pet a short room leaves: its frame, its bar, which moves it, and one line. Never
 * less, or Windows' own least height for a window (56 device pixels, seen at 100% and 150%) wins at a
 * size that is no whole number of pixels, and the page is cut.
 */
const LEAST_HEIGHT = 2 * PET_LAYOUT.border + PET_LAYOUT.bar + PET_LAYOUT.empty;

export interface PetAnchor {
  readonly right: boolean;
  readonly bottom: boolean;
}

/** Choose the nearer edges when the user places the window; keep them until it moves again. */
export function petAnchor(current: Rect, displays: DisplayLayout): PetAnchor {
  const area = mostOverlapping(current, displays.workAreas) ?? displays.primary;
  return {
    right: current.x + current.width / 2 > area.x + area.width / 2,
    bottom: current.y + current.height / 2 > area.y + area.height / 2,
  };
}

/**
 * The nearest size from `size` up — or down, with `down` — that is a whole number of device pixels at
 * `scale`. Chromium lays a page out at whole DIPs: a window half a device pixel off them — 55 DIP at
 * 150% is 82.5 pixels, which Windows made 83 — is a fraction smaller than its page, and the page's last
 * row of pixels, the frame's border, is cut. Looked for within 20 DIPs; past that, `size` as it is.
 */
export function wholePixels(size: number, scale: number, down = false): number {
  for (let step = 0; step <= 20; step += 1) {
    const candidate = down ? size - step : size + step;
    const pixels = candidate * scale;
    if (Math.abs(pixels - Math.round(pixels)) < 1e-6) return candidate;
  }
  return size;
}

/**
 * The Pet at `size`, from where it is now, on a display of `scale`. The nearer horizontal and vertical
 * edges stay: a Pet in the bottom-right corner grows upward and toward the left.
 * Its width stops at its work area's, and its height at the opposite work area edge, past which its list
 * scrolls — but never below its frame, bar and one line. Each is whole device pixels (`wholePixels`), the
 * window rounded up and a limit rounded down.
 */
export function fitPetBounds(current: Rect, size: Size, displays: DisplayLayout, scale = 1, anchor = petAnchor(current, displays)): Rect {
  const area = mostOverlapping(current, displays.workAreas) ?? displays.primary;
  const width = size.width <= area.width ? wholePixels(size.width, scale) : wholePixels(area.width, scale, true);
  const bottom = current.y + current.height;
  const room = anchor.bottom ? bottom - area.y : area.y + area.height - current.y;
  const tall = wholePixels(size.height, scale);
  const height = tall <= room ? tall : Math.max(wholePixels(room, scale, true), wholePixels(LEAST_HEIGHT, scale));
  const x = anchor.right ? current.x + current.width - width : current.x;
  const y = anchor.bottom ? bottom - height : current.y;
  return roundRect({ x, y, width, height });
}

/**
 * Where the Pet opens: where it was left, at its list's size and on the same side; then somewhere
 * reachable (bounds.ts); then no lower than the screen, in whole device pixels at `scale`.
 */
export function openingPetBounds(saved: Rect | null, size: Size, displays: DisplayLayout, scale = 1): Rect {
  const wanted = saved === null ? null : fitPetBounds(saved, size, displays, scale);
  return fitPetBounds(fitBoundsToDisplays(wanted, displays, petPlacement(size)), size, displays, scale);
}
