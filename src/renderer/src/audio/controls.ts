// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { UiAudioEvent } from '@shared/contracts/audio';
import { invoke } from '../ipc/client';

const ACTIONABLE = 'button, a[href], select, summary, input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [data-audio-control]';
function control(target: EventTarget | null): Element | null {
  const element = target instanceof Element ? target.closest(ACTIONABLE) : null;
  return element?.closest(':disabled, [aria-disabled="true"], [inert]') != null ? null : element;
}

/** Delegation covers portal dialogs and menus as well as controls added later. */
export function connectControlAudio(emit: (event: UiAudioEvent) => void = (event) => { void invoke('audio:ui', { event }).catch(() => undefined); }): () => void {
  let lastRollover = -Infinity;
  const over = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    const element = control(event.target);
    if (element === null || control(event.relatedTarget) === element || element.closest('[data-audio="silent"]') !== null) return;
    const now = Date.now();
    if (now - lastRollover < 100) return;
    lastRollover = now;
    emit('rollover');
  };
  const click = (event: MouseEvent): void => {
    const element = control(event.target);
    // Capture eligibility before a handler disables or unmounts its button, then let it cancel.
    if (element === null || element.closest('[data-audio]') !== null) return;
    queueMicrotask(() => { if (!event.defaultPrevented) emit('click'); });
  };
  const context = (): void => { emit('rightClick'); };
  document.addEventListener('pointerover', over);
  document.addEventListener('click', click, true);
  // Capturing also hears a context menu whose own handler stops propagation.
  window.addEventListener('contextmenu', context, true);
  return () => {
    document.removeEventListener('pointerover', over);
    document.removeEventListener('click', click, true);
    window.removeEventListener('contextmenu', context, true);
  };
}
