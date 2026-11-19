// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A request to open a session's mode menu from elsewhere in the page (docs/planning/_archive/M22.md, Design
// 10; C46, C89): the remedy of the two mode blocks, which stand in place of the chat's input, is the
// control in the session's header. The block asks; the menu, which owns its own opening, answers.
//
// It holds which session was asked for last and a count, and nothing of a mode. In memory only.
import { create } from 'zustand';

interface ModeMenuAsk {
  readonly sessionId: string | null;
  /** Goes up by one with every request, so two alike are told apart. */
  readonly serial: number;
}

const useModeMenuAsk = create<ModeMenuAsk>()(() => ({ sessionId: null, serial: 0 }));

/** Asks the mode menu of this session to open: what Change mode does. */
export function askModeMenu(sessionId: string): void {
  useModeMenuAsk.setState((held) => ({ sessionId, serial: held.serial + 1 }));
}

/** The count of the last request made for this session, or 0 where the last one was another's: a menu opens when it changes. */
export function useModeMenuAsked(sessionId: string): number {
  return useModeMenuAsk((state) => (state.sessionId === sessionId ? state.serial : 0));
}

/** The same count, read once and outside a component. */
export function modeMenuAsked(sessionId: string): number {
  const held = useModeMenuAsk.getState();
  return held.sessionId === sessionId ? held.serial : 0;
}

/** For tests: nothing asked. */
export function resetModeMenuAsk(): void {
  useModeMenuAsk.setState({ sessionId: null, serial: 0 });
}
