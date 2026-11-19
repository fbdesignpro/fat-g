// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The `+` visit, before and while its draft is created. Afterwards the screen follows the draft
// itself: any selected session no turn has run is shown on it (useNewChatLifecycle).
import { create } from 'zustand';
import type { ModelPreset } from '@shared/contracts/presets';
import { composerOf, flushDraft } from '../chat/composer/composer-store';
import { draftOf } from '../chat/chat-store';
import { showDetached } from '../chat/detached-store';
import { focusPrompt } from '../chat/prompt-focus';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';

export interface NewSessionView {
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly previousId: string | null;
  readonly serial: number;
  readonly creating: boolean;
  readonly problem: string | null;
  /** Drafts whose Send was accepted in this run: off the screen at once, before main says they run. */
  readonly sent: ReadonlySet<string>;
}

export const useNewSession = create<NewSessionView>()(() => ({ projectId: null, sessionId: null, previousId: null, serial: 0, creating: false, problem: null, sent: new Set() }));

export function openNewSession(projectId: string): void {
  const current = useNewSession.getState();
  const held = current.sessionId === null ? null : composerOf(current.sessionId);
  const hasContent = current.sessionId !== null && (draftOf(current.sessionId).trim() !== '' || (held?.main.draft.attachments.length ?? 0) > 0 || (held?.staging.length ?? 0) > 0);
  if (current.projectId === projectId && !hasContent) {
    if (current.sessionId !== null) focusPrompt(current.sessionId);
    return;
  }
  showDetached(null);
  useNewSession.setState({ projectId, sessionId: null, previousId: useAppState.getState().snapshot?.sessions?.selectedId ?? null, serial: current.serial + 1, creating: false, problem: null });
}

export function closeNewSession(): void {
  useNewSession.setState((state) => ({ projectId: null, sessionId: null, previousId: null, serial: state.serial + 1, creating: false, problem: null }));
}

export function finishNewSession(id: string): void {
  useNewSession.setState((state) => ({ sent: new Set(state.sent).add(id) }));
  if (useNewSession.getState().sessionId === id) closeNewSession();
}

/** A single create after saving the departing draft; late answers never reopen this screen. */
export async function createNewSession(preset: ModelPreset): Promise<boolean> {
  const opening = useNewSession.getState();
  if (opening.projectId === null || opening.creating || opening.sessionId !== null) return false;
  useNewSession.setState({ creating: true, problem: null });
  try {
    if (opening.previousId !== null) await flushDraft(opening.previousId);
    if (useNewSession.getState().serial !== opening.serial) return false;
    const answer = await invoke('sessions:create', { projectId: opening.projectId, preset });
    if (useNewSession.getState().serial !== opening.serial) {
      // It never acquired a composer or content. Keep the existing empty-provisional cleanup rule
      // even when main's reply arrived after navigation, without ever reopening the abandoned view.
      if (answer.status === 'saved') void invoke('sessions:remove', { id: answer.id }).catch(() => undefined);
      return false;
    }
    if (answer.status !== 'saved') {
      useNewSession.setState({ problem: 'fat-g could not create this draft. Choose an available model and try again.' });
      return false;
    }
    useNewSession.setState({ sessionId: answer.id });
    focusPrompt(answer.id);
    return true;
  } catch {
    if (useNewSession.getState().serial === opening.serial) useNewSession.setState({ problem: 'fat-g could not create the draft. Try again.' });
    return false;
  } finally {
    if (useNewSession.getState().serial === opening.serial) useNewSession.setState({ creating: false });
  }
}
