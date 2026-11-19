// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { type DisplayLayout, fitBoundsToDisplays, type PlacementPolicy, type Rect, settleBounds } from './bounds';
import { MAIN_PLACEMENT, petPlacement } from './placement';

// A 1080p primary with a 40px taskbar at the bottom, and a second monitor to its left.
const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const LEFT: Rect = { x: -1920, y: 0, width: 1920, height: 1080 };

const ONE: DisplayLayout = { workAreas: [PRIMARY], primary: PRIMARY };
const TWO: DisplayLayout = { workAreas: [PRIMARY, LEFT], primary: PRIMARY };

const MAIN: PlacementPolicy = { defaultSize: { width: 1280, height: 800 }, minSize: { width: 800, height: 560 }, anchor: 'center' };
const PET: PlacementPolicy = {
  defaultSize: { width: 280, height: 280 },
  minSize: { width: 280, height: 280 },
  anchor: 'top-right',
  margin: 48,
  fixedSize: true,
};

describe('fitBoundsToDisplays', () => {
  it.each<[string, Rect | null, DisplayLayout, PlacementPolicy, Rect]>([
    ['nothing saved → centered on the primary display', null, ONE, MAIN, { x: 320, y: 120, width: 1280, height: 800 }],
    ['nothing saved, Pet → the top-right corner, clear of the edges', null, ONE, PET, { x: 1592, y: 48, width: 280, height: 280 }],
    ['fully on the primary display → unchanged', { x: 100, y: 100, width: 1000, height: 700 }, ONE, MAIN, { x: 100, y: 100, width: 1000, height: 700 }],
    ['on a second monitor at negative x → unchanged', { x: -1500, y: 200, width: 1000, height: 700 }, TWO, MAIN, { x: -1500, y: 200, width: 1000, height: 700 }],
    ['on a monitor that is gone → re-placed on the primary, size kept', { x: -1500, y: 200, width: 1000, height: 700 }, ONE, MAIN, { x: 460, y: 170, width: 1000, height: 700 }],
    ['half off the right edge, still grabbable → unchanged', { x: 1400, y: 100, width: 1000, height: 700 }, ONE, MAIN, { x: 1400, y: 100, width: 1000, height: 700 }],
    ['title bar above the screen, body visible → re-placed', { x: 100, y: -300, width: 1000, height: 700 }, ONE, MAIN, { x: 460, y: 170, width: 1000, height: 700 }],
    ['only a 40px sliver of the title bar on screen → re-placed', { x: 1880, y: 100, width: 1000, height: 700 }, ONE, MAIN, { x: 460, y: 170, width: 1000, height: 700 }],
    ['title bar just above the top edge, mostly visible → unchanged', { x: 100, y: -10, width: 1000, height: 700 }, ONE, MAIN, { x: 100, y: -10, width: 1000, height: 700 }],
    ['straddling two monitors → unchanged', { x: -500, y: 100, width: 1000, height: 700 }, TWO, MAIN, { x: -500, y: 100, width: 1000, height: 700 }],
    ['larger than its display → shrunk to the work area', { x: 0, y: 0, width: 2500, height: 1400 }, ONE, MAIN, { x: 0, y: 0, width: 1920, height: 1040 }],
    ['smaller than the minimum → raised to it', { x: 100, y: 100, width: 300, height: 200 }, ONE, MAIN, { x: 100, y: 100, width: 800, height: 560 }],
    ['fractional → whole DIPs', { x: 100.4, y: 99.6, width: 1000.5, height: 700.49 }, ONE, MAIN, { x: 100, y: 100, width: 1001, height: 700 }],
    ['Pet → its fixed size, whatever the file says', { x: 500, y: 300, width: 999, height: 999 }, ONE, PET, { x: 500, y: 300, width: 280, height: 280 }],
  ])('%s', (_name, saved, displays, policy, expected) => {
    expect(fitBoundsToDisplays(saved, displays, policy)).toEqual(expected);
  });

  it('treats a title bar under a taskbar at the top as unreachable', () => {
    const underTaskbar: Rect = { x: 0, y: 48, width: 1920, height: 1032 };
    const layout = { workAreas: [underTaskbar], primary: underTaskbar };
    expect(fitBoundsToDisplays({ x: 100, y: 0, width: 1000, height: 700 }, layout, MAIN)).toEqual({ x: 460, y: 214, width: 1000, height: 700 });
  });

  it('re-places on the display the window was mostly on, not always the primary', () => {
    // Mostly on the left monitor, with its title bar above that monitor's top edge.
    expect(fitBoundsToDisplays({ x: -1000, y: -100, width: 280, height: 280 }, TWO, PET)).toEqual({ x: -328, y: 48, width: 280, height: 280 });
  });

  it('places the default on the primary display even when it is not at the origin', () => {
    const primary: Rect = { x: 1920, y: 0, width: 1920, height: 1040 };
    const layout = { workAreas: [{ x: 0, y: 0, width: 1920, height: 1080 }, primary], primary };
    expect(fitBoundsToDisplays(null, layout, MAIN)).toEqual({ x: 2240, y: 120, width: 1280, height: 800 });
  });

  it('keeps a window whose title bar is split across two monitors', () => {
    // 60px on each side of the seam: neither half alone is grabbable, together they are.
    expect(fitBoundsToDisplays({ x: -60, y: 100, width: 120, height: 700 }, TWO, { ...MAIN, minSize: { width: 100, height: 100 } })).toEqual({
      x: -60,
      y: 100,
      width: 120,
      height: 700,
    });
  });

  it('shrinks the default to a display smaller than it', () => {
    const small: Rect = { x: 0, y: 0, width: 1024, height: 700 };
    expect(fitBoundsToDisplays(null, { workAreas: [small], primary: small }, MAIN)).toEqual({ x: 0, y: 0, width: 1024, height: 700 });
  });
});

// The policies the app really uses (placement.ts).
describe('the Main window’s placement (M11, C25; M100, C57)', () => {
  it('may not get smaller than 1280×640, which leaves the prompt controls room with a tab open, and opens at 1440×900', () => {
    expect(MAIN_PLACEMENT.minSize).toEqual({ width: 1280, height: 640 });
    expect(MAIN_PLACEMENT.defaultSize).toEqual({ width: 1440, height: 900 });
  });

  it('opens at its default size, centred, with nothing saved', () => {
    expect(fitBoundsToDisplays(null, ONE, MAIN_PLACEMENT)).toEqual({ x: 240, y: 70, width: 1440, height: 900 });
  });

  it.each<[string, Rect, Rect]>([
    ['the old 800×560 minimum → grown to the new one', { x: 100, y: 100, width: 800, height: 560 }, { x: 100, y: 100, width: 1280, height: 640 }],
    ['M11’s 1120×640 minimum → grown to the new one', { x: 100, y: 100, width: 1120, height: 640 }, { x: 100, y: 100, width: 1280, height: 640 }],
    ['too narrow only → grown in width only', { x: 100, y: 100, width: 1000, height: 900 }, { x: 100, y: 100, width: 1280, height: 900 }],
    ['too short only → grown in height only', { x: 100, y: 100, width: 1400, height: 600 }, { x: 100, y: 100, width: 1400, height: 640 }],
    ['exactly the minimum → unchanged', { x: 100, y: 100, width: 1280, height: 640 }, { x: 100, y: 100, width: 1280, height: 640 }],
  ])('a saved size %s', (_name, saved, expected) => {
    expect(fitBoundsToDisplays(saved, ONE, MAIN_PLACEMENT)).toEqual(expected);
  });

  it('still fits a work area smaller than the minimum, rather than spilling off it', () => {
    const small: Rect = { x: 0, y: 0, width: 1024, height: 600 };
    expect(fitBoundsToDisplays({ x: 0, y: 0, width: 800, height: 560 }, { workAreas: [small], primary: small }, MAIN_PLACEMENT)).toEqual({ x: 0, y: 0, width: 1024, height: 600 });
  });

  it('sizes the Pet by its list alone, whatever the file says', () => {
    const policy = petPlacement({ width: 300, height: 87 });
    expect(policy.minSize).toEqual(policy.defaultSize);
    expect(policy.fixedSize).toBe(true);
    expect(fitBoundsToDisplays({ x: 500, y: 300, width: 280, height: 280 }, ONE, policy)).toEqual({ x: 500, y: 300, width: 300, height: 87 });
  });
});

/** A window that lands `bias` DIP larger than asked, like a thick-framed one at 150% scaling. */
function biasedWindow(bias: { width: number; height: number }) {
  let bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  const calls: Rect[] = [];
  return {
    calls,
    setBounds(asked: Rect) {
      calls.push(asked);
      bounds = { ...asked, width: asked.width + bias.width, height: asked.height + bias.height };
    },
    getBounds: () => bounds,
  };
}

describe('settleBounds', () => {
  const wanted: Rect = { x: 82, y: 41, width: 962, height: 617 };

  it('leaves a window that lands where asked alone after one call', () => {
    const window = biasedWindow({ width: 0, height: 0 });
    settleBounds(window, wanted);
    expect(window.calls).toEqual([wanted]);
    expect(window.getBounds()).toEqual(wanted);
  });

  it('corrects a window that lands larger, so it reports what was asked', () => {
    const window = biasedWindow({ width: 1, height: 1 });
    settleBounds(window, wanted);
    expect(window.getBounds()).toEqual(wanted);
  });

  it('does not creep over repeated launches that save what the window reports', () => {
    let saved = wanted;
    for (let launch = 0; launch < 10; launch += 1) {
      const window = biasedWindow({ width: 3, height: 2 });
      settleBounds(window, saved);
      saved = window.getBounds();
    }
    expect(saved).toEqual(wanted);
  });
});
