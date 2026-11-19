// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { canZoom, ZoomChangeRequestSchema, zoomPercent, zoomStep } from './zoom';

describe('zoomStep', () => {
  it('steps through the list in both directions', () => {
    expect(zoomStep(100, 'in')).toBe(110);
    expect(zoomStep(110, 'in')).toBe(125);
    expect(zoomStep(100, 'out')).toBe(90);
    expect(zoomStep(67, 'out')).toBe(50);
  });

  it('brings a zoom set before the steps onto the list at the first press', () => {
    expect(zoomStep(91, 'out')).toBe(90);
    expect(zoomStep(91, 'in')).toBe(100);
    expect(zoomStep(130, 'in')).toBe(150);
  });

  it('holds at the ends', () => {
    expect(zoomStep(200, 'in')).toBe(200);
    expect(zoomStep(50, 'out')).toBe(50);
    expect(zoomStep(250, 'in')).toBe(200);
    expect(zoomStep(30, 'out')).toBe(50);
  });

  it('resets to 100 from anywhere', () => {
    expect(zoomStep(50, 'reset')).toBe(100);
    expect(zoomStep(91, 'reset')).toBe(100);
  });
});

describe('canZoom', () => {
  it('is false only at the ends', () => {
    expect(canZoom(200, 'in')).toBe(false);
    expect(canZoom(200, 'out')).toBe(true);
    expect(canZoom(50, 'out')).toBe(false);
    expect(canZoom(50, 'in')).toBe(true);
    expect(canZoom(100, 'in')).toBe(true);
  });
});

describe('zoomPercent', () => {
  it('rounds a factor to the percent shown', () => {
    expect(zoomPercent(0.913)).toBe(91);
    expect(zoomPercent(1.25)).toBe(125);
    expect(zoomPercent(0.8999999761581421)).toBe(90);
  });
});

describe('ZoomChangeRequestSchema', () => {
  it('takes in, out or reset and nothing else', () => {
    expect(ZoomChangeRequestSchema.safeParse({ to: 'in' }).success).toBe(true);
    expect(ZoomChangeRequestSchema.safeParse({ to: 'reset' }).success).toBe(true);
    expect(ZoomChangeRequestSchema.safeParse({ to: 125 }).success).toBe(false);
    expect(ZoomChangeRequestSchema.safeParse({ to: 'in', extra: true }).success).toBe(false);
  });
});
