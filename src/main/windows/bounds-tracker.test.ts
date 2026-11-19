// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rect } from './bounds';
import { type Placement, trackPlacement } from './bounds-tracker';

/** Just enough of a BrowserWindow: events, its normal bounds, and whether it is gone. */
class FakeWindow extends EventEmitter {
  bounds: Rect = { x: 100, y: 100, width: 1000, height: 700 };
  destroyed = false;

  getNormalBounds(): Rect {
    if (this.destroyed) throw new Error('Object has been destroyed');
    return this.bounds;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  moveTo(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y };
    this.emit('move');
  }
}

let window: FakeWindow;
let saved: Placement[];

function track(maximized = false) {
  return trackPlacement(window, { maximized, save: (placement) => saved.push(placement), delayMs: 500 });
}

beforeEach(() => {
  vi.useFakeTimers();
  window = new FakeWindow();
  saved = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('trackPlacement', () => {
  it('saves a drag once, after it settles, with whole-DIP bounds', () => {
    track();
    for (let x = 100; x < 400; x += 10) {
      window.moveTo(x + 0.4, 200.6);
      vi.advanceTimersByTime(16);
    }
    expect(saved).toEqual([]); // still dragging

    vi.advanceTimersByTime(500);
    expect(saved).toEqual([{ bounds: { x: 390, y: 201, width: 1000, height: 700 }, maximized: false }]);
  });

  it('saves resizes too', () => {
    track();
    window.bounds = { x: 100, y: 100, width: 1200, height: 900 };
    window.emit('resize');
    vi.advanceTimersByTime(500);
    expect(saved.at(-1)?.bounds).toEqual({ x: 100, y: 100, width: 1200, height: 900 });
  });

  it('follows maximize and unmaximize, keeping the normal bounds', () => {
    track();
    window.emit('maximize');
    vi.advanceTimersByTime(500);
    expect(saved.at(-1)).toEqual({ bounds: { x: 100, y: 100, width: 1000, height: 700 }, maximized: true });

    window.emit('unmaximize');
    vi.advanceTimersByTime(500);
    expect(saved.at(-1)?.maximized).toBe(false);
  });

  it('still knows a window is maximized after it was minimized, and closed from the taskbar', () => {
    // Windows reports isMaximized() === false while minimized; the tracker never asks.
    track(true);
    window.emit('minimize');
    window.emit('move'); // minimizing moves the window off-screen; the normal bounds do not change
    window.emit('close');
    expect(saved).toEqual([{ bounds: { x: 100, y: 100, width: 1000, height: 700 }, maximized: true }]);
  });

  it('saves a pending change at once when flushed, and not again when the timer would have fired', () => {
    const tracker = track();
    window.moveTo(300, 300);
    tracker.flush();
    expect(saved).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(saved).toHaveLength(1);
  });

  it('saves nothing when flushed with nothing pending', () => {
    const tracker = track();
    tracker.flush();
    window.emit('close');
    expect(saved).toEqual([]);
  });

  it('saves a pending change as the window closes', () => {
    track();
    window.moveTo(300, 300);
    window.emit('close');
    expect(saved.map((placement) => placement.bounds.x)).toEqual([300]);
  });

  it('never touches a window that is already gone', () => {
    const tracker = track();
    window.moveTo(300, 300);
    window.destroyed = true;
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => tracker.flush()).not.toThrow();
    expect(saved).toEqual([]);
  });

  it('drops what is pending once the window has closed', () => {
    track();
    window.moveTo(300, 300);
    window.emit('closed');
    vi.advanceTimersByTime(1000);
    expect(saved).toEqual([]);
  });

  it('does not save a collapsed rectangle', () => {
    track();
    window.bounds = { x: 0, y: 0, width: 0, height: 0 };
    window.emit('resize');
    vi.advanceTimersByTime(500);
    expect(saved).toEqual([]);
  });
});
