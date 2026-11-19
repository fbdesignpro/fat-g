// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Where the keyboard goes next (M100b, C61): the prompt's text area of a session, once its chat is
// drawn. Asked for on entering a chat or returning to the app, by a press on a session's capsule,
// by a new session once it is made, and by a question's card once its answer or its decline is
// taken. The session's own Composer takes it as soon as it stands in the page, then forgets it,
// so a later drawing of the same chat takes nothing. Held in the page's memory alone, as a
// session's id: no text, nothing kept.
import { useEffect } from 'react';
import { create } from 'zustand';

interface PromptFocus {
  /** The session whose prompt asks for the focus, or null when nothing asks. */
  readonly sessionId: string | null;
  /** Grows with each ask, so that a second ask for the same session is a new one. */
  readonly serial: number;
  readonly atEnd: boolean;
}

export const usePromptFocus = create<PromptFocus>()(() => ({ sessionId: null, serial: 0, atEnd: false }));

/** Asks for the focus in this session's prompt. The latest ask stands for the earlier ones. */
export function focusPrompt(sessionId: string, atEnd = false): void {
  usePromptFocus.setState((held) => ({ sessionId, serial: held.serial + 1, atEnd }));
}

/** Focus the shown chat on entry and on returning to the app; ordinary updates leave focus alone. */
export function usePromptAutofocus(sessionId: string | null): void {
  useEffect(() => {
    if (sessionId === null) return;
    let frame: number | null = null;
    const focus = (): void => {
      // Settings, questions in dialogs and other modal work keep their keyboard focus.
      if (document.querySelector('dialog[open]') === null) focusPrompt(sessionId);
    };
    const cancel = (): void => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
    };
    const onFocus = (event: FocusEvent): void => {
      if (event.target !== event.currentTarget) return;
      focus();
      cancel();
      // A click that activates the window can focus its target after the window's focus event.
      // Reclaim the prompt once that activation has finished, checking for a modal again.
      frame = window.requestAnimationFrame(() => { frame = null; focus(); });
    };
    focus();
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', cancel);
    return () => {
      cancel();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', cancel);
    };
  }, [sessionId]);
}

/** The Composer took it: nothing asks any more. */
export function promptFocusTaken(serial: number): void {
  usePromptFocus.setState((held) => (held.serial === serial ? { sessionId: null, serial } : held));
}

/** For tests: nothing asks. */
export function resetPromptFocus(): void {
  usePromptFocus.setState({ sessionId: null, serial: 0, atEnd: false });
}
