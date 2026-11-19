// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { CHAT_LINES } from '@shared/contracts/chat';
import type { DetachedConversation } from '@shared/contracts/conversation';
import { sessionDisplayName } from '@shared/contracts/sessions';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { detachedText, removeDetachedFailedText, removeDetachedText } from '../ui/detached-text';
import { showDetached } from './detached-store';
import { MessageList } from './MessageList';
import { type DetachedProblem, useDetachedChat } from './useDetachedChat';
import styles from './Chat.module.css';

/** No record names its provider or its model (C35): the labels say no more than is known. */
const ASSISTANT_LABEL = 'Assistant';
const PROVIDER_WORDS = 'The provider';

export const DETACHED_PROBLEM_TEXT: Readonly<Record<DetachedProblem, string>> = {
  gone: 'This chat is no longer among the chats without a session: it was removed, or its session is listed again.',
  failed: 'fat-g could not read this chat.',
};

/**
 * A chat without a session, in the chat region (docs/planning/_archive/M18.md, Design 8; C31, C35) — the
 * session window's one column, with no model column, no Done and no prompt area (M100, C44): its
 * messages a page at a time, selectable and copyable as any chat's are, and no input — a line says
 * why in its place, with Remove and Close. It asks main for its pages and for its removal, and for
 * nothing else: no provider is asked anything for it.
 *
 * It gives its messages no opener (docs/planning/_archive/M19b.md, Design 6; C21): a chat without a session has
 * no project to hold a file to, so its links stay the text they are.
 *
 * Remove asks first, and is not offered while records are refused (C32): the chat may be a listed
 * session's once they are read.
 */
export function DetachedChat({ conversation }: { readonly conversation: DetachedConversation }) {
  const chat = useDetachedChat(conversation.id);
  const recordsRefused = useAppState((state) => state.snapshot?.records?.status.kind === 'refused');
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = sessionDisplayName(conversation);

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      const answer = await invoke('conversations:removeDetached', { ids: [conversation.id] });
      setFailed(answer.status !== 'saved');
      if (answer.status === 'saved') showDetached(null);
    } catch {
      setFailed(true);
    }
    setBusy(false);
    setRemoving(false);
  };

  return (
    <div className={styles.area} data-detached-chat={conversation.id}>
      <MessageList view={chat.view} busy={chat.busy} copySource={{ kind: 'detached', id: conversation.id }} modelName={ASSISTANT_LABEL} providerName={PROVIDER_WORDS} onShowEarlier={chat.showEarlier} onShowLatest={chat.showLatest} />
      <div className={`${styles.reason} ${styles.detachedFoot}`} role="note">
        <p className={styles.detachedName}>{name}</p>
        <p className={styles.reasonText}>{CHAT_LINES.readOnly}</p>
        {!recordsRefused && (
          <button type="button" className={styles.button} onClick={() => setRemoving(true)}>
            Remove
          </button>
        )}
        <button type="button" className={styles.button} onClick={() => showDetached(null)}>
          Close
        </button>
        {chat.problem !== null && <p className={styles.problem} role="status">{DETACHED_PROBLEM_TEXT[chat.problem]}</p>}
        {failed && <p className={styles.problem} role="status">{removeDetachedFailedText(1)}</p>}
      </div>
      <ConfirmDialog open={removing} title={`Remove ${detachedText(1)}?`} confirmLabel="Remove" busy={busy} onConfirm={() => void remove()} onCancel={() => setRemoving(false)}>
        <p>{name}</p>
        <p>{removeDetachedText(1)}</p>
      </ConfirmDialog>
    </div>
  );
}
