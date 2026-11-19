// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Which chat without a session the chat region shows, if any (docs/planning/_archive/M18.md, Design 8; C31,
// C35). The row at the foot of the project column chooses one, and the chat region draws it in place
// of the selected session's chat, read-only. In memory only and never saved: it is where the reader
// happens to be. Selecting a session clears it (src/renderer/src/shell/ChatRegion.tsx).
import { create } from 'zustand';
import type { DetachedConversation } from '@shared/contracts/conversation';

export interface DetachedShown {
  readonly shown: DetachedConversation | null;
}

export const useDetached = create<DetachedShown>()(() => ({ shown: null }));

/** Shows a chat without a session in the chat region, or — with null — the selected session's chat again. */
export function showDetached(conversation: DetachedConversation | null): void {
  useDetached.setState((state) => (state.shown === conversation ? state : { shown: conversation }));
}
