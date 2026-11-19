// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { fitBoundsToDisplays, type DisplayLayout, type Rect, type Size } from './bounds';
import type { Placement } from './bounds-tracker';
import { MAIN_PLACEMENT } from './placement';

/** App arguments only; unknown or malformed sizes leave the saved placement in charge. */
export function parseWindowSize(args: readonly string[]): Size | null {
  const argument = args.findLast((value) => value.startsWith('--window-size='));
  const match = argument?.match(/^--window-size=([1-9]\d{0,4})x([1-9]\d{0,4})$/);
  return match === undefined || match === null ? null : { width: Number(match[1]), height: Number(match[2]) };
}

export function mainStartupPlacement(saved: { readonly bounds: Rect | null; readonly maximized: boolean }, displays: DisplayLayout, size: Size | null): Placement {
  const bounds = size === null ? saved.bounds : { x: displays.primary.x, y: displays.primary.y, ...saved.bounds, ...size };
  return {
    bounds: fitBoundsToDisplays(bounds, displays, MAIN_PLACEMENT),
    maximized: size === null && saved.maximized,
  };
}
