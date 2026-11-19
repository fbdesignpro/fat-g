// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Remembers where a window is, without saving on every pixel of a drag: changes settle for a
// moment first, and whatever is pending is saved at once when the window closes or the app quits.
//
// Electron-free: the window arrives as the few methods used here, so this runs under plain Vitest
// with a fake window and fake timers (bounds-tracker.test.ts).
import { type Rect, roundRect } from './bounds';

/** The events that can change where a window is, plus the two that end its life. */
export type TrackedEvent = 'move' | 'resize' | 'maximize' | 'unmaximize' | 'close' | 'closed';

export interface TrackedWindow {
  on(event: TrackedEvent, listener: () => void): unknown;
  /** The un-maximized, un-minimized position — valid in every state, which is why it is used. */
  getNormalBounds(): Rect;
  isDestroyed(): boolean;
}

export interface Placement {
  readonly bounds: Rect;
  readonly maximized: boolean;
}

export interface PlacementTracker {
  /** Saves a pending change now. Does nothing if nothing changed since the last save. */
  flush(): void;
}

export interface TrackPlacementOptions {
  /** Whether the window starts maximized — it cannot be read back reliably (see below). */
  readonly maximized: boolean;
  readonly save: (placement: Placement) => void;
  readonly delayMs?: number;
}

/** Long enough that a drag saves once, when it ends. */
export const PLACEMENT_SAVE_DELAY_MS = 500;

export function trackPlacement(window: TrackedWindow, options: TrackPlacementOptions): PlacementTracker {
  const { save, delayMs = PLACEMENT_SAVE_DELAY_MS } = options;
  // Followed through events rather than read from `isMaximized()`: Windows answers false while a
  // window is minimized, so closing a minimized, maximized window would save the wrong thing.
  let maximized = options.maximized;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    // A destroyed window throws from every getter, and a throw in a timer callback becomes
    // Electron's main-process error dialog.
    if (!pending || window.isDestroyed()) return;
    pending = false;
    const bounds = roundRect(window.getNormalBounds());
    if (bounds.width < 1 || bounds.height < 1) return;
    save({ bounds, maximized });
  }

  // Debounced, not coalesced: every change restarts the wait, so a drag saves once, when it ends.
  function changed(): void {
    pending = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  }

  window.on('move', changed);
  window.on('resize', changed);
  window.on('maximize', () => {
    maximized = true;
    changed();
  });
  window.on('unmaximize', () => {
    maximized = false;
    changed();
  });
  window.on('close', flush);
  window.on('closed', () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = false;
  });

  return { flush };
}
