// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { DisplayLayout, Rect } from './bounds';
import { fitPetBounds, openingPetBounds, petAnchor, wholePixels } from './pet-fit';

// A 1080p primary with a 40px taskbar at the bottom, and a second monitor to its left.
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const LEFT: Rect = { x: -1920, y: 0, width: 1920, height: 1080 };
const ONE: DisplayLayout = { workAreas: [PRIMARY], primary: PRIMARY };
const TWO: DisplayLayout = { workAreas: [PRIMARY, LEFT], primary: PRIMARY };

describe('fitPetBounds', () => {
  it.each<[string, Rect, { width: number; height: number }, DisplayLayout, Rect]>([
    ['in the right half → the right edge stays', { x: 1572, y: 48, width: 300, height: 87 }, { width: 240, height: 200 }, ONE, { x: 1632, y: 48, width: 240, height: 200 }],
    ['in the left half → the left edge stays', { x: 100, y: 48, width: 300, height: 87 }, { width: 240, height: 200 }, ONE, { x: 100, y: 48, width: 240, height: 200 }],
    ['on the left monitor, in its right half → its right edge stays', { x: -400, y: 100, width: 240, height: 54 }, { width: 300, height: 54 }, TWO, { x: -460, y: 100, width: 300, height: 54 }],
    ['bottom right → grows up and left', { x: 1572, y: 900, width: 300, height: 87 }, { width: 360, height: 500 }, ONE, { x: 1512, y: 487, width: 360, height: 500 }],
    ['bottom left → grows up and right', { x: 100, y: 900, width: 240, height: 87 }, { width: 300, height: 500 }, ONE, { x: 100, y: 487, width: 300, height: 500 }],
    ['bottom → shrinks down', { x: 1572, y: 600, width: 300, height: 387 }, { width: 300, height: 87 }, ONE, { x: 1572, y: 900, width: 300, height: 87 }],
    ['top → stops at the work area’s bottom', { x: 1572, y: 400, width: 300, height: 87 }, { width: 300, height: 1000 }, ONE, { x: 1572, y: 400, width: 300, height: 640 }],
    ['bottom → stops at the work area’s top', { x: 1572, y: 900, width: 300, height: 87 }, { width: 300, height: 1500 }, ONE, { x: 1572, y: 0, width: 300, height: 987 }],
    ['on an upper monitor → uses that monitor’s edges', { x: -400, y: -180, width: 300, height: 87 }, { width: 300, height: 500 }, { workAreas: [PRIMARY, { ...LEFT, y: -1080 }], primary: PRIMARY }, { x: -400, y: -593, width: 300, height: 500 }],
  ])('%s', (_name, current, size, displays, expected) => {
    expect(fitPetBounds(current, size, displays)).toEqual(expected);
  });

  it.each([48, 900])('keeps its chosen edge through growth across the midpoint and shrinkage (y = %d)', (y) => {
    const current = { x: 1572, y, width: 300, height: 87 };
    const anchor = petAnchor(current, ONE);
    const grown = fitPetBounds(current, { width: 300, height: 1500 }, ONE, 1, anchor);
    expect(fitPetBounds(grown, { width: 300, height: 87 }, ONE, 1, anchor)).toEqual(current);
  });

  it('keeps at least its frame, bar and one line if its anchored edge leaves no room', () => {
    expect(fitPetBounds({ x: 1572, y: 1030, width: 300, height: 87 }, { width: 300, height: 500 }, ONE, 1, { right: true, bottom: false }).height).toBe(56);
  });
});

describe('fitPetBounds at a fractional scale: whole device pixels, or the page is cut', () => {
  it.each<[string, Rect, { width: number; height: number }, number, Rect]>([
    ['an odd height at 150% → the next even one', { x: 1572, y: 48, width: 300, height: 54 }, { width: 300, height: 55 }, 1.5, { x: 1572, y: 48, width: 300, height: 56 }],
    ['an even height at 150% → as it is', { x: 1572, y: 48, width: 300, height: 54 }, { width: 300, height: 168 }, 1.5, { x: 1572, y: 48, width: 300, height: 168 }],
    ['at 125% → a multiple of four', { x: 1572, y: 48, width: 300, height: 54 }, { width: 240, height: 55 }, 1.25, { x: 1632, y: 48, width: 240, height: 56 }],
    ['cut at the screen’s bottom at 150% → rounded down there', { x: 1572, y: 400, width: 300, height: 87 }, { width: 300, height: 1000 }, 1.5, { x: 1572, y: 400, width: 300, height: 640 }],
    ['cut at an odd room at 150% → the even height under it', { x: 1572, y: 401, width: 300, height: 87 }, { width: 300, height: 1000 }, 1.5, { x: 1572, y: 401, width: 300, height: 638 }],
    ['growing up at 150% → keeps the bottom with a whole-pixel height', { x: 1572, y: 900, width: 300, height: 88 }, { width: 300, height: 501 }, 1.5, { x: 1572, y: 486, width: 300, height: 502 }],
    ['cut at the screen’s top at 150% → rounded down there', { x: 1572, y: 901, width: 300, height: 87 }, { width: 300, height: 1500 }, 1.5, { x: 1572, y: 0, width: 300, height: 988 }],
  ])('%s', (_name, current, size, scale, expected) => {
    expect(fitPetBounds(current, size, ONE, scale)).toEqual(expected);
  });

  it.each([[55, 1, false, 55], [55, 1.5, false, 56], [55, 1.5, true, 54], [55, 1.25, false, 56], [55, 1.75, false, 56], [300, 1.75, false, 300], [7, 1.1, false, 10]])('wholePixels(%d, %d, down %s) → %d', (size, scale, down, expected) => {
    expect(wholePixels(size, scale, down)).toBe(expected);
  });
});

describe('openingPetBounds', () => {
  it('opens in the top-right corner with nothing saved', () => {
    expect(openingPetBounds(null, { width: 300, height: 54 }, ONE)).toEqual({ x: 1572, y: 48, width: 300, height: 54 });
  });

  it('opens where it was left, at its list’s size, the right edge where it was', () => {
    expect(openingPetBounds({ x: 1592, y: 48, width: 280, height: 280 }, { width: 300, height: 115 }, ONE)).toEqual({ x: 1572, y: 48, width: 300, height: 115 });
  });

  it('comes back to the primary display from one that is gone', () => {
    expect(openingPetBounds({ x: -400, y: 100, width: 300, height: 54 }, { width: 300, height: 54 }, ONE)).toEqual({ x: 1572, y: 48, width: 300, height: 54 });
  });

  it('opens from its saved bottom edge when the list has changed', () => {
    expect(openingPetBounds({ x: 1572, y: 900, width: 300, height: 87 }, { width: 300, height: 500 }, ONE)).toEqual({ x: 1572, y: 487, width: 300, height: 500 });
  });
});
