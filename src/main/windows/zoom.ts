// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Main window's zoom, which fat-g steps itself (src/shared/contracts/zoom.ts): the View menu's
// keys, Ctrl+wheel and the page's buttons all come here, and the app state tells the page where it
// stands. Chromium keeps the zoom per host in its own Preferences file and gives it back at the
// next start, so this reads it at every load rather than saving it anywhere.
//
// Electron does not zoom on Ctrl+wheel by itself: it only emits `zoom-changed`. The Pet shares the
// Main window's host, so it is kept apart at 100% (pet-window.ts).
import type { WebContents } from 'electron';
import { zoomPercent, zoomStep, type ZoomChange } from '@shared/contracts/zoom';
import type { AppStateStore } from '../state/app-state-store';

export type ZoomedPage = Pick<WebContents, 'getZoomFactor' | 'setZoomFactor' | 'isDestroyed'> & {
  on(event: 'did-finish-load', listener: () => void): unknown;
  on(event: 'zoom-changed', listener: (event: unknown, direction: 'in' | 'out') => void): unknown;
};

export interface ZoomControl {
  /** The Main window's page: its zoom is read at each load, and Ctrl+wheel steps it. */
  follow(page: ZoomedPage): void;
  /** A step in or out, or back to 100%. Nothing while no page is followed. */
  change(to: ZoomChange): void;
}

export function createZoomControl(store: Pick<AppStateStore, 'setZoom'>): ZoomControl {
  let page: ZoomedPage | null = null;
  // Kept here rather than read back, so a step starts from the step before it.
  let percent: number | null = null;

  function change(to: ZoomChange): void {
    if (page === null || page.isDestroyed()) return;
    const next = zoomStep(percent ?? zoomPercent(page.getZoomFactor()), to);
    page.setZoomFactor(next / 100);
    percent = next;
    store.setZoom(next);
  }

  function follow(next: ZoomedPage): void {
    page = next;
    percent = null;
    next.on('did-finish-load', () => {
      if (page !== next || next.isDestroyed()) return;
      percent = zoomPercent(next.getZoomFactor());
      store.setZoom(percent);
    });
    next.on('zoom-changed', (_event, direction) => {
      if (page === next) change(direction);
    });
  }

  return { follow, change };
}
