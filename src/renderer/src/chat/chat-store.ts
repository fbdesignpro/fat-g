// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the page keeps of a conversation (docs/planning/_archive/M15.md, Design 14; C67): a draft per session,
// for the run. A draft is never sent to main before Send, and never saved: the messages themselves
// are main's, read and pushed (useChat.ts).
//
// And which groups of activity the reader opened or closed themselves (docs/planning/_archive/M20a.md,
// Design 8; C36): kept for the run, so a later item of the group never undoes the choice, and
// neither does the list letting go of the group and reading it again. Never sent to main, never saved.
import { create } from 'zustand';

export interface ChatDrafts {
  readonly drafts: Readonly<Record<string, string>>;
}

export const useChatDrafts = create<ChatDrafts>()(() => ({ drafts: {} }));

export function draftOf(sessionId: string): string {
  return useChatDrafts.getState().drafts[sessionId] ?? '';
}

export interface GroupChoices {
  /** By the id of a group's first item: true for one the reader opened, false for one they closed. */
  readonly choices: Readonly<Record<string, boolean>>;
}

export const useGroupChoices = create<GroupChoices>()(() => ({ choices: {} }));

/** The reader's own opening or closing of a group (C36). */
export function setGroupOpen(key: string, open: boolean): void {
  useGroupChoices.setState((state) => (state.choices[key] === open ? state : { choices: { ...state.choices, [key]: open } }));
}

export function setDraft(sessionId: string, text: string): void {
  useChatDrafts.setState((state) => {
    if ((state.drafts[sessionId] ?? '') === text) return state;
    const drafts = { ...state.drafts };
    if (text === '') delete drafts[sessionId];
    else drafts[sessionId] = text;
    return { drafts };
  });
}
