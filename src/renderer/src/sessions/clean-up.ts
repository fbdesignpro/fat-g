// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Clean up done (the maintainer): a mode in which each session pressed is marked done at
// once, as its menu's Done does, until a right-click, Escape or a press anywhere that is not a
// session. Each flashes as Done's does and leaves its place empty, and the places close together once
// the mode ends (the maintainer). In memory only and never saved: it is what the pointer is doing.
import { useEffect } from 'react';
import { create } from 'zustand';
import { type SessionEntry, sessionLabel } from '@shared/contracts/sessions';
import { useAppState } from '../state/store';
import { canCleanUp } from './clean-up-target';
import { completeWithFlash, isLeaving, releaseHeld } from './leaving';
import { runningNoticeText, SESSION_FAILED_TEXT } from './SessionList';

/** Why the mode stopped on its own: a session it pressed was not marked done. */
export interface CleanUpNotice {
  readonly title: string;
  readonly text: string;
}

export interface CleanUpState {
  readonly on: boolean;
  readonly notice: CleanUpNotice | null;
}

export const useCleanUp = create<CleanUpState>()(() => ({ on: false, notice: null }));

/**
 * The attribute on the page's root while the mode is on: what has every element take the root's
 * pointer (CleanUp.module.css), and a capsule a press would complete marked in green (Sessions.module.css).
 */
export const CLEAN_UP_ATTRIBUTE = 'data-clean-up';

export function startCleanUp(): void {
  useCleanUp.setState({ on: true, notice: null });
}

/** Ends the mode; the places of the sessions it marked done close, all together (leaving.ts). */
export function endCleanUp(): void {
  useCleanUp.setState((state) => (state.on ? { on: false } : state));
  releaseHeld();
}

export function closeCleanUpNotice(): void {
  useCleanUp.setState({ notice: null });
}

function complete(entry: SessionEntry): void {
  const title = sessionLabel(entry);
  const stop = (notice: CleanUpNotice): void => {
    endCleanUp();
    useCleanUp.setState({ notice });
  };
  completeWithFlash(entry, { cleanUp: true }).then(
    (answer) => {
      if (answer.status === 'saved') return;
      if (answer.reason === 'running') stop({ title: `${title} is running`, text: runningNoticeText('completed', answer.doing) });
      else stop({ title: `${title} was not marked done`, text: SESSION_FAILED_TEXT });
    },
    () => stop({ title: `${title} was not marked done`, text: SESSION_FAILED_TEXT }),
  );
}

/** The pointer's arrow, its tip at the hotspot, and the check at its lower right, on a 32px square. */
const ARROW = 'M1.5 1.5V19.5L6 15.6L9 22.5L12.2 21.1L9.3 14.4H15Z';
const CHECK = 'M17 23.5L21 27.5L29 18';

/**
 * The mode's pointer: an arrow in black and white with a check in Done's green beside it, outlined
 * in black as the arrow is, so it shows on any ground. Drawn from the tokens as the mode starts, so
 * no stylesheet names an image or a colour; 32px, the most Chromium draws near a window's edge, with
 * a copy twice as fine for a dense screen.
 */
function cursor(): string {
  const token = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const [white, black, green] = [token('--color-status-white'), token('--color-status-black'), token('--color-done-rule')];
  const image = (size: number): string => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 32 32'>`
      + `<path d='${ARROW}' fill='${white}' stroke='${black}' stroke-width='1.2' stroke-linejoin='round'/>`
      + `<path d='${CHECK}' fill='none' stroke='${black}' stroke-width='5.4' stroke-linecap='round' stroke-linejoin='round'/>`
      + `<path d='${CHECK}' fill='none' stroke='${green}' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/>`
      + '</svg>';
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  };
  return `image-set(${image(32)} 1x, ${image(64)} 2x) 1 1, default`;
}

/** Swallowed while the mode is on: no drag starts, no focus moves and no text is selected. */
const SWALLOWED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick'] as const;

/**
 * The mode's listeners, mounted once (CleanUpButton.tsx). While it is on, the page's root holds
 * `CLEAN_UP_ATTRIBUTE` and the mode's pointer, and every press is the mode's before anything else in the page sees it: a
 * click on a session that can be completed completes it — a keyboard's click too — and the second
 * click of a double-click does nothing: its first left the place flashing, or, with less motion asked
 * for, moved the rows up under the pointer. A click on any other session, or on a place a session
 * marked done holds, does nothing; one anywhere else ends the mode, and presses nothing. The window
 * losing the focus or being hidden ends it too (the maintainer): the user has left, and
 * the places it emptied close.
 */
export function useCleanUpMode(): void {
  const on = useCleanUp((state) => state.on);

  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    root.setAttribute(CLEAN_UP_ATTRIBUTE, '');
    root.style.setProperty('cursor', cursor(), 'important');
    const swallow = (event: Event): void => {
      event.stopPropagation();
      if (event.type === 'mousedown') event.preventDefault();
    };
    const onClick = (event: MouseEvent): void => {
      event.stopPropagation();
      event.preventDefault();
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('[data-held-slot]') != null) return;
      const row = element?.closest<HTMLElement>('[data-session-id]') ?? null;
      if (row === null) {
        endCleanUp();
        return;
      }
      if (event.detail > 1) return;
      const entry = useAppState.getState().snapshot?.sessions?.sessions.find((candidate) => candidate.record.id === row.dataset['sessionId']);
      // One whose flash covers its capsule is already being marked.
      if (entry !== undefined && canCleanUp(entry) && !isLeaving(entry.record.id)) complete(entry);
    };
    const onContextMenu = (event: MouseEvent): void => {
      event.stopPropagation();
      event.preventDefault();
      endCleanUp();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      endCleanUp();
    };
    // The window's own blur, not an element's: an element's reaches the window only while capturing, and its target is a node.
    const onBlur = (event: FocusEvent): void => {
      if (!(event.target instanceof Node)) endCleanUp();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') endCleanUp();
    };
    for (const type of SWALLOWED) window.addEventListener(type, swallow, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      root.removeAttribute(CLEAN_UP_ATTRIBUTE);
      root.style.removeProperty('cursor');
      for (const type of SWALLOWED) window.removeEventListener(type, swallow, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [on]);

  // The mode leaves with the page that holds it.
  useEffect(() => endCleanUp, []);
}
