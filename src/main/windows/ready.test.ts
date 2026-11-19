// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// When a hidden window is shown: at its first paint, or failing that once its page has loaded. A
// window that waited only for `ready-to-show` stayed hidden for good on a second display (ready.ts).
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOW_AFTER_LOAD_MS, whenReadyToShow } from './ready';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeWindow() {
  const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
  const show = vi.fn();
  whenReadyToShow(window, show);
  return { window, show };
}

describe('whenReadyToShow', () => {
  it('shows the window when it is ready, and never again', () => {
    const { window, show } = fakeWindow();
    expect(show).not.toHaveBeenCalled();
    window.emit('ready-to-show');
    expect(show).toHaveBeenCalledOnce();
    // The page's load arrives after, as it usually does, and a second paint: neither shows it again.
    window.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(SHOW_AFTER_LOAD_MS * 4);
    window.emit('ready-to-show');
    expect(show).toHaveBeenCalledOnce();
  });

  it('shows a window that never becomes ready, a moment after its page has loaded', () => {
    const { window, show } = fakeWindow();
    window.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(SHOW_AFTER_LOAD_MS - 1);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledOnce();
  });

  it('lets the paint win when it arrives within that moment', () => {
    const { window, show } = fakeWindow();
    window.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(SHOW_AFTER_LOAD_MS / 2);
    window.emit('ready-to-show');
    expect(show).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(SHOW_AFTER_LOAD_MS * 4);
    expect(show).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a window whose page failed to load at once: what went wrong is then on screen', () => {
    const { window, show } = fakeWindow();
    window.webContents.emit('did-fail-load');
    expect(show).toHaveBeenCalledOnce();
  });

  it('waits for as long as nothing has loaded: an empty window is never shown on a timer alone', () => {
    const { show } = fakeWindow();
    vi.advanceTimersByTime(60_000);
    expect(show).not.toHaveBeenCalled();
  });

  it('shows nothing once the window has closed, and leaves no timer behind', () => {
    const { window, show } = fakeWindow();
    window.webContents.emit('did-finish-load');
    window.emit('closed');
    vi.advanceTimersByTime(SHOW_AFTER_LOAD_MS * 4);
    window.emit('ready-to-show');
    expect(show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes its delay from the caller', () => {
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
    const show = vi.fn();
    whenReadyToShow(window, show, 50);
    window.webContents.emit('did-finish-load');
    vi.advanceTimersByTime(50);
    expect(show).toHaveBeenCalledOnce();
  });
});
