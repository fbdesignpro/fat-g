// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Choosing a session (docs/planning/_archive/M23.md, Design 5; C31): the text typed into the chat the page
// leaves, and not handed over yet, goes to main before the choice does, so main writes that draft at
// the switch with nothing of it left only in the page.
import type { InvokeResponse } from '@shared/ipc/contract';
import { flushDraft, hasUnsentDraft } from '../chat/composer/composer-store';
import { showDetached } from '../chat/detached-store';
import { focusPrompt } from '../chat/prompt-focus';
import { invoke, subscribe } from '../ipc/client';
import { useAppState } from '../state/store';
import { closeNewSession } from '../new-session/new-session-store';

/** `sessions:select`, after the departing session's unsent text: at once where there is none. */
export function selectSession(id: string): Promise<InvokeResponse<'sessions:select'>> {
  closeNewSession();
  const leaving = useAppState.getState().snapshot?.sessions?.selectedId ?? null;
  if (leaving === null || leaving === id || !hasUnsentDraft(leaving)) return invoke('sessions:select', { id });
  return flushDraft(leaving).then(() => invoke('sessions:select', { id }));
}

/**
 * A press on a session in the Pet (decision 0010): main has brought this window forward, and the
 * session opens as a pointer press on its capsule opens it (SessionList) — out of a detached chat, the
 * departing session's unsent text handed over first, and the keyboard given to its prompt once main
 * has selected it. Subscribed once, by the Main page's entry.
 */
export function connectReveal(): () => void {
  return subscribe('sessions:reveal', ({ id }) => {
    showDetached(null);
    selectSession(id)
      .then((answer) => { if (answer.status === 'saved') focusPrompt(id); })
      .catch(() => undefined);
  });
}
