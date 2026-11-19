// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { mainStartupPlacement, parseWindowSize } from './startup-size';

const area = { x: 0, y: 0, width: 2560, height: 1400 };
const displays = { primary: area, workAreas: [area] };
const saved = { bounds: { x: 100, y: 100, width: 1440, height: 900 }, maximized: true };

describe('Main window startup size', () => {
  it('parses the explicit size and uses the last repeated option', () => {
    expect(parseWindowSize(['app', '--window-size=1440x900', '--window-size=1920x1080'])).toEqual({ width: 1920, height: 1080 });
  });

  it.each(['', '--other=1920x1080', '--window-size=0x1080', '--window-size=-1x1080', '--window-size=1920x1.5', '--window-size=Infinityx1080', '--window-size=1920x1080junk'])('ignores invalid or absent dimensions: %s', (arg) => {
    expect(parseWindowSize([arg])).toBeNull();
  });

  it('overrides saved dimensions and maximization while preserving position', () => {
    expect(mainStartupPlacement(saved, displays, { width: 1920, height: 1080 })).toEqual({
      bounds: { x: 100, y: 100, width: 1920, height: 1080 }, maximized: false,
    });
    expect(mainStartupPlacement(saved, displays, null)).toEqual(saved);
  });

  it('honors the minimum size and available work area', () => {
    expect(mainStartupPlacement(saved, displays, { width: 1, height: 9999 }).bounds).toMatchObject({ width: 1280, height: 1400 });
  });

  it('works on first launch without saved bounds', () => {
    expect(mainStartupPlacement({ bounds: null, maximized: true }, displays, { width: 1920, height: 1080 })).toEqual({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }, maximized: false,
    });
  });
});
