// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// How the session window shares its width between the chat and the artifact pane (docs/planning/
// M100.md, round 8; C80): the chat's share of the two boxes' width, set by dragging the gap between
// them. Held in the page's memory for the run, as the tabs are: nothing is written, and each start
// begins with 60% for chat and 40% for the pane.
import { create } from 'zustand';

/** The chat's default share; Enter or a double-click on the gap restores it. */
export const DEFAULT_CHAT_SHARE = 0.6;

export interface SplitState {
  /** The chat's share of the two boxes' width, from 0 to 1. */
  readonly share: number;
}

export const useSplit = create<SplitState>()(() => ({ share: DEFAULT_CHAT_SHARE }));

export function setShare(share: number): void {
  useSplit.setState((held) => (held.share === share ? held : { share }));
}

/** For tests: the default split. */
export function resetSplit(): void {
  useSplit.setState({ share: DEFAULT_CHAT_SHARE });
}
