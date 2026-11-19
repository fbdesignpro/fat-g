// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import { createZoomControl, type ZoomedPage } from './zoom';

/** A page with the zoom Chromium gave back, and its two events to fire. */
function fakePage(factor = 1) {
  const listeners = new Map<string, (...args: never[]) => void>();
  let destroyed = false;
  const page = {
    getZoomFactor: vi.fn(() => factor),
    setZoomFactor: vi.fn((next: number) => {
      factor = next;
    }),
    isDestroyed: () => destroyed,
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
      return page;
    },
  };
  return {
    page: page as unknown as ZoomedPage & typeof page,
    load: () => (listeners.get('did-finish-load') as () => void)(),
    wheel: (direction: 'in' | 'out') => (listeners.get('zoom-changed') as (event: unknown, direction: 'in' | 'out') => void)({}, direction),
    destroy: () => {
      destroyed = true;
    },
  };
}

describe('createZoomControl', () => {
  it('reads the zoom Chromium kept at each load and tells the app state', () => {
    const store = { setZoom: vi.fn() };
    const zoom = createZoomControl(store);
    const fake = fakePage(0.9);
    zoom.follow(fake.page);
    expect(store.setZoom).not.toHaveBeenCalled();
    fake.load();
    expect(store.setZoom).toHaveBeenLastCalledWith(90);
  });

  it('steps from the last step, sets the factor and tells the app state', () => {
    const store = { setZoom: vi.fn() };
    const zoom = createZoomControl(store);
    const fake = fakePage(0.913);
    zoom.follow(fake.page);
    fake.load();
    expect(store.setZoom).toHaveBeenLastCalledWith(91);
    zoom.change('out');
    expect(fake.page.setZoomFactor).toHaveBeenLastCalledWith(0.9);
    expect(store.setZoom).toHaveBeenLastCalledWith(90);
    zoom.change('out');
    expect(fake.page.setZoomFactor).toHaveBeenLastCalledWith(0.8);
    zoom.change('reset');
    expect(fake.page.setZoomFactor).toHaveBeenLastCalledWith(1);
    expect(store.setZoom).toHaveBeenLastCalledWith(100);
  });

  it('steps on Ctrl+wheel', () => {
    const store = { setZoom: vi.fn() };
    const zoom = createZoomControl(store);
    const fake = fakePage();
    zoom.follow(fake.page);
    fake.load();
    fake.wheel('in');
    expect(fake.page.setZoomFactor).toHaveBeenLastCalledWith(1.1);
    fake.wheel('out');
    fake.wheel('out');
    expect(fake.page.setZoomFactor).toHaveBeenLastCalledWith(0.9);
    expect(store.setZoom).toHaveBeenLastCalledWith(90);
  });

  it('steps before the first load from the zoom the page has', () => {
    const store = { setZoom: vi.fn() };
    const zoom = createZoomControl(store);
    const fake = fakePage(1.25);
    zoom.follow(fake.page);
    zoom.change('in');
    expect(fake.page.setZoomFactor).toHaveBeenLastCalledWith(1.5);
  });

  it('does nothing with no page, or a page that is gone', () => {
    const store = { setZoom: vi.fn() };
    const zoom = createZoomControl(store);
    zoom.change('in');
    const fake = fakePage();
    zoom.follow(fake.page);
    fake.destroy();
    zoom.change('in');
    expect(fake.page.setZoomFactor).not.toHaveBeenCalled();
    expect(store.setZoom).not.toHaveBeenCalled();
  });

  it('follows a new page alone once the Main window is opened again', () => {
    const store = { setZoom: vi.fn() };
    const zoom = createZoomControl(store);
    const first = fakePage();
    zoom.follow(first.page);
    const second = fakePage(1.1);
    zoom.follow(second.page);
    first.wheel('in');
    expect(first.page.setZoomFactor).not.toHaveBeenCalled();
    second.load();
    zoom.change('in');
    expect(second.page.setZoomFactor).toHaveBeenLastCalledWith(1.25);
  });
});
