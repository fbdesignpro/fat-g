// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The prompt type pressed in a session's prompt-type bar (docs/planning/_archive/M100.md, Design 7; C38): Plan
// or none, per session. Kept in the page as the drafts are (chat-store.ts): M22b sends the next prompt
// in plan mode from it. M23 (C87) makes it the draft's: a press is handed to main with the draft's text
// (composer-store.ts, `choosePlan`) and comes back with the draft after a restart.
import { create } from 'zustand';

export type PromptType = 'plan';

export interface PromptTypes {
  readonly types: Readonly<Record<string, PromptType>>;
}

export const usePromptTypes = create<PromptTypes>()(() => ({ types: {} }));

/** The type pressed for a session, or null with none. */
export function usePromptType(sessionId: string): PromptType | null {
  return usePromptTypes((state) => state.types[sessionId] ?? null);
}

/** Presses a type for a session, or — with null — releases it: one or none is pressed. */
export function setPromptType(sessionId: string, type: PromptType | null): void {
  usePromptTypes.setState((state) => {
    if ((state.types[sessionId] ?? null) === type) return state;
    const types = { ...state.types };
    if (type === null) delete types[sessionId];
    else types[sessionId] = type;
    return { types };
  });
}

/** For tests: none pressed anywhere. */
export function resetPromptTypes(): void {
  usePromptTypes.setState({ types: {} });
}
