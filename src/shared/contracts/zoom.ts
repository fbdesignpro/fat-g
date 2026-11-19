// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Main window's zoom: fat-g's own steps, like a browser's, in place of Electron's half levels
// (91%, 110%, 120% …). Main applies it (src/main/windows/zoom.ts) and Chromium keeps it per host
// in its own Preferences file, so it survives a restart without a field in preferences.json.
import { z } from 'zod';

/** Every zoom a key, the wheel or a button can reach, in percent. */
export const ZOOM_PERCENTS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

export const DEFAULT_ZOOM = 100;
const SMALLEST = 50;
const LARGEST = 200;

export const ZOOM_CHANGES = ['in', 'out', 'reset'] as const;
export type ZoomChange = (typeof ZOOM_CHANGES)[number];

export const ZoomChangeRequestSchema = z.strictObject({ to: z.enum(ZOOM_CHANGES) });
export type ZoomChangeRequest = z.infer<typeof ZoomChangeRequestSchema>;

/**
 * The zoom after a change: the next step strictly above or below `current`, so a zoom set before
 * fat-g had steps (91%) lands on the list at the first press; the ends hold.
 */
export function zoomStep(current: number, change: ZoomChange): number {
  if (change === 'reset') return DEFAULT_ZOOM;
  if (change === 'in') return ZOOM_PERCENTS.find((percent) => percent > current) ?? LARGEST;
  return [...ZOOM_PERCENTS].reverse().find((percent) => percent < current) ?? SMALLEST;
}

/** Whether a press would change anything: false at the ends. */
export function canZoom(current: number, change: 'in' | 'out'): boolean {
  return zoomStep(current, change) !== current;
}

/** A zoom factor (1.25) as the percent shown (125). */
export function zoomPercent(factor: number): number {
  return Math.round(factor * 100);
}
