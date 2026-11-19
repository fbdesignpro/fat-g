// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Done flash's lock (the maintainer): from a flash's start until the last slot it
// held has closed, the page takes nothing but the wheel, which still scrolls the session list — no
// press, no key, no drag and no zoom — so nothing changes under the flash and the slots. Clean up done
// mode takes its own input while it is on (clean-up.ts), its slots waiting empty meanwhile.
import { useEffect } from 'react';
import { useCleanUp } from './clean-up';
import { playing, useLeaving } from './leaving';

/** On the page's root while the lock is on: what a probe waits on until the list has settled. */
export const SEQUENCE_ATTRIBUTE = 'data-done-sequence';

/** Swallowed while the lock is on, before anything in the page sees them. */
const SWALLOWED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'keydown', 'keyup', 'dragstart'] as const;

/**
 * Holds the lock's listeners while a flash plays and Clean up done mode is off. Set from the stores'
 * own changes, not after React's next render, so a press in the same frame as the Done is already
 * swallowed.
 */
export function watchSequenceLock(): () => void {
  let on = false;
  const swallow = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
  };
  const onWheel = (event: WheelEvent): void => {
    if (event.ctrlKey) swallow(event);
  };
  const apply = (): void => {
    const next = playing(useLeaving.getState()) && !useCleanUp.getState().on;
    if (next === on) return;
    on = next;
    document.documentElement.toggleAttribute(SEQUENCE_ATTRIBUTE, next);
    for (const type of SWALLOWED) {
      if (next) window.addEventListener(type, swallow, true);
      else window.removeEventListener(type, swallow, true);
    }
    if (next) window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    else window.removeEventListener('wheel', onWheel, true);
  };
  const stopLeaving = useLeaving.subscribe(apply);
  const stopCleanUp = useCleanUp.subscribe(apply);
  apply();
  return () => {
    stopLeaving();
    stopCleanUp();
    on = false;
    document.documentElement.removeAttribute(SEQUENCE_ATTRIBUTE);
    for (const type of SWALLOWED) window.removeEventListener(type, swallow, true);
    window.removeEventListener('wheel', onWheel, true);
  };
}

/** The lock, for as long as the page that holds it. */
export function useSequenceLock(): void {
  useEffect(() => watchSequenceLock(), []);
}
