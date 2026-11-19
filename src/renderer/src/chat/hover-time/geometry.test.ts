// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { placeTime } from './geometry';

const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const base = { host: rect(100, 100, 1000, 700), viewport: rect(250, 110, 900, 600), messageLeft: 266, sourceTop: 240, width: 42, height: 14, gap: 8, toolbar: rect(108, 108, 140, 280) };

describe('the timestamp gutter', () => {
  it('right-aligns beside the message in host coordinates, clipping above and below the list', () => {
    expect(placeTime(base)).toEqual({ left: 158, top: 140, clipTop: 10, clipBottom: 100 });
  });

  it('suppresses actual toolbar intersections with clearance, without moving the time', () => {
    expect(placeTime({ ...base, messageLeft: 150 })).toBeNull();
    expect(placeTime({ ...base, messageLeft: 150, sourceTop: 287 })).toBeNull();
    expect(placeTime({ ...base, messageLeft: 150, sourceTop: 288 })).toEqual({ left: 42, top: 188, clipTop: 10, clipBottom: 100 });
    expect(placeTime({ ...base, messageLeft: 150, toolbar: null })).not.toBeNull();
  });

  it('allows partial horizontal clipping without taking space, and hides a fully clipped time', () => {
    expect(placeTime({ ...base, messageLeft: 125, sourceTop: 400 })).not.toBeNull();
    expect(placeTime({ ...base, messageLeft: 108, sourceTop: 400 })).toBeNull();
  });

  it('hides anchors above or below the visible list even when their messages are still visible', () => {
    expect(placeTime({ ...base, sourceTop: 109 })).toBeNull();
    expect(placeTime({ ...base, sourceTop: 600 })).toBeNull();
    expect(placeTime({ ...base, sourceTop: 599 })).not.toBeNull();
  });
});
