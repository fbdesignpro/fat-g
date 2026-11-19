// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where a window opens: where it was left, if that is still somewhere the user can reach —
// otherwise a sensible default. Monitors get unplugged, resolutions change, and a hand-edited
// preferences file can say anything, so a saved position is a wish, not an instruction.
//
// Pure (no Electron): displays arrive as plain rectangles, so the rules are a table test
// (bounds.test.ts). Electron's screen coordinates are DIPs, and so are these.

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface DisplayLayout {
  /** Every display's work area: its bounds minus taskbars and docks. */
  readonly workAreas: readonly Rect[];
  /** The primary display's work area. */
  readonly primary: Rect;
}

export interface PlacementPolicy {
  readonly defaultSize: Size;
  readonly minSize: Size;
  /** Where the window goes when it has no usable saved position. */
  readonly anchor: 'center' | 'top-right';
  /** Distance from the work area's edges when anchored to a corner. */
  readonly margin?: number;
  /** A window the user cannot resize keeps `defaultSize`, whatever the file says. */
  readonly fixedSize?: boolean;
}

/** The top edge a window is grabbed by — about a title bar's height. */
export const GRAB_STRIP_HEIGHT = 32;
/** How much of that strip must be on screen for the window to count as reachable. */
export const MIN_GRAB_WIDTH = 96;

export function fitBoundsToDisplays(saved: Rect | null, displays: DisplayLayout, policy: PlacementPolicy): Rect {
  if (saved === null) return place(policy.defaultSize, displays.primary, policy);

  const rect = roundRect(saved);
  // The display it was mostly on, if that display is still there.
  const home = mostOverlapping(rect, displays.workAreas) ?? displays.primary;
  const wanted = policy.fixedSize === true ? policy.defaultSize : rect;
  const size = {
    width: Math.min(Math.max(wanted.width, policy.minSize.width), home.width),
    height: Math.min(Math.max(wanted.height, policy.minSize.height), home.height),
  };
  const sized = { x: rect.x, y: rect.y, ...size };
  return isReachable(sized, displays.workAreas) ? sized : place(size, home, policy);
}

/**
 * Reachable = enough of the top strip is inside the work areas to grab it and drag the window back.
 * Work areas, not display bounds: a title bar under the taskbar cannot be grabbed. Widths are
 * summed across displays (they never overlap), so a window straddling two monitors still counts.
 */
function isReachable(rect: Rect, workAreas: readonly Rect[]): boolean {
  const strip = { x: rect.x, y: rect.y, width: rect.width, height: Math.min(GRAB_STRIP_HEIGHT, rect.height) };
  const minVisibleHeight = Math.ceil(strip.height / 2);
  let visibleWidth = 0;
  for (const area of workAreas) {
    const overlap = intersect(strip, area);
    if (overlap !== null && overlap.height >= minVisibleHeight) visibleWidth += overlap.width;
  }
  return visibleWidth >= Math.min(MIN_GRAB_WIDTH, rect.width);
}

/** The policy's default spot on `area`, for a window of `size` (shrunk to fit if it must). */
function place(size: Size, area: Rect, policy: PlacementPolicy): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  if (policy.anchor === 'center') {
    return {
      x: area.x + Math.floor((area.width - width) / 2),
      y: area.y + Math.floor((area.height - height) / 2),
      width,
      height,
    };
  }
  const margin = policy.margin ?? 0;
  return {
    x: Math.max(area.x, area.x + area.width - width - margin),
    y: Math.min(area.y + margin, area.y + area.height - height),
    width,
    height,
  };
}

/** The work area holding most of `rect`, or null if none holds any of it. */
export function mostOverlapping(rect: Rect, areas: readonly Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of areas) {
    const overlap = intersect(rect, area);
    const size = overlap === null ? 0 : overlap.width * overlap.height;
    if (size > bestArea) {
      best = area;
      bestArea = size;
    }
  }
  return best;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** What `settleBounds` needs of a window. */
export interface PlaceableWindow {
  setBounds(bounds: Rect): void;
  getBounds(): Rect;
}

/**
 * Puts a window at `bounds` so that it REPORTS `bounds` back — or within a DIP of it.
 *
 * At fractional display scaling, a window with a thick frame (every Electron window without an OS
 * title bar has one unless told otherwise; it is what makes the edges resizable) is created a few
 * DIP larger than asked, and even setBounds lands a DIP off, always in the same direction. The
 * window reports that size, the tracker saves it, and the next launch asks for it — so the window
 * grew on every launch (measured at 150%: 1280 → 1285 in five launches). Correcting by the
 * difference once settles it for good (measured: stable over six launches, at worst a DIP smaller
 * than first asked).
 */
export function settleBounds(window: PlaceableWindow, bounds: Rect): void {
  window.setBounds(bounds);
  const actual = window.getBounds();
  if (actual.width === bounds.width && actual.height === bounds.height) return;
  window.setBounds({ ...bounds, width: 2 * bounds.width - actual.width, height: 2 * bounds.height - actual.height });
}

/** Whole DIPs. The preferences schema accepts integers only — anything else would become `null`. */
export function roundRect(rect: Rect): Rect {
  return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
}
