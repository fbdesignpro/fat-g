// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef } from 'react';
import { ChatArea } from '../chat/ChatArea';
import { DetachedChat } from '../chat/DetachedChat';
import { showDetached, useDetached } from '../chat/detached-store';
import { usePromptAutofocus } from '../chat/prompt-focus';
import { useSelectedSession } from '../session-area/selected';
import { useAppState } from '../state/store';
import styles from './Shell.module.css';

/**
 * Where the conversation happens: the page's main landmark (M15, C58), the whole of the chat
 * window's content (docs/planning/_archive/M100.md, Design 6, 7, round 8; C76) — the message list, and under
 * it the prompt area with the session's avatar at its left. It hosts the selected session's chat,
 * keyed by the session, so another one starts from its own read; with none selected it stays empty.
 *
 * A chat without a session, chosen from the row at the foot of the project column, is drawn in its
 * place, read-only (M18, C31, C35) — until a session is selected, or no such chat is left.
 */
export function ChatRegion() {
  const selected = useSelectedSession();
  const detached = useDetached((state) => state.shown);
  const count = useAppState((state) => state.snapshot?.conversations?.detached ?? 0);
  const selectedId = selected?.entry.record.id ?? null;
  const previous = useRef(selectedId);
  usePromptAutofocus(detached !== null && count > 0 ? null : selectedId);

  useEffect(() => {
    // Another session selected, a new one included, puts its own chat back. So does the last chat
    // without a session going: removed, or its session listed again.
    if (previous.current !== selectedId || count === 0) showDetached(null);
    previous.current = selectedId;
  }, [selectedId, count]);

  return (
    <main className={styles.chat} aria-label="Chat">
      {detached !== null && count > 0 ? (
        <DetachedChat key={detached.id} conversation={detached} />
      ) : (
        selected !== null && <ChatArea key={selected.entry.record.id} entry={selected.entry} />
      )}
    </main>
  );
}
