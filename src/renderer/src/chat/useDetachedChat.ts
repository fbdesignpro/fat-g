// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A chat without a session as the page holds it (docs/planning/_archive/M18.md, Design 8; C31, C35): the same
// window a session's chat is (window.ts), read a page at a time over `conversations:readDetached`
// and nothing else. No push reaches it and no revision orders it: nothing writes to a conversation
// no session has, and nothing is asked of a provider for it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatHistory } from '@shared/contracts/chat';
import { invoke } from '../ipc/client';
import { useBusy } from './useChat';
import { type ChatView, windowOf, withOlderPage } from './window';

/** No record vouches for its provider: nothing of its history is asked, or said. */
const NO_HISTORY: ChatHistory = { state: 'unsupported', olderUnread: false, earlierMissing: false };

/** `gone`: it has a session again, or was removed. `failed`: it could not be read. */
export type DetachedProblem = 'gone' | 'failed';

export interface DetachedChatView {
  readonly view: ChatView | null;
  readonly busy: boolean;
  readonly problem: DetachedProblem | null;
  readonly showEarlier: () => void;
  readonly showLatest: () => void;
}

const NOTHING_YET: Pick<DetachedChatView, 'showEarlier' | 'showLatest'> = { showEarlier: () => undefined, showLatest: () => undefined };

export function useDetachedChat(id: string): DetachedChatView {
  const [view, setView] = useState<ChatView | null>(null);
  // The newest page is on its way from the start.
  const [reading, setReading] = useState(true);
  const [problem, setProblem] = useState<DetachedProblem | null>(null);
  const actions = useRef(NOTHING_YET);

  useEffect(() => {
    let live = true;
    let shown: ChatView | null = null;
    let serial = 0;
    let asked = 0;

    /** The newest page, or the one before the cursor. */
    function read(before: string | null): void {
      asked += 1;
      invoke('conversations:readDetached', before === null ? { id } : { id, before }).then(
        (answer) => {
          if (!live) return;
          asked -= 1;
          setReading(asked > 0);
          if (answer.status === 'refused') {
            // The store no longer has the cursor: the newest page says what is older now.
            if (answer.reason === 'unknown-cursor' && before !== null) { setReading(true); read(null); return; }
            setProblem(answer.reason === 'unknown-conversation' || answer.reason === 'unknown-session' ? 'gone' : 'failed');
            return;
          }
          setProblem(null);
          serial += 1;
          if (before === null || shown === null) shown = windowOf({ items: answer.items, turns: answer.turns, latest: true, older: answer.older, history: NO_HISTORY, storage: 'ok' }, { serial, kind: 'latest' }, null);
          else if (shown.older === before) shown = withOlderPage(shown, answer, false, serial);
          else return;
          setView(shown);
        },
        () => {
          if (!live) return;
          asked -= 1;
          setReading(asked > 0);
          setProblem('failed');
        },
      );
    }

    actions.current = {
      showEarlier: () => {
        const before = shown?.older ?? null;
        if (!live || asked > 0 || before === null) return;
        setReading(true);
        read(before);
      },
      showLatest: () => {
        if (!live) return;
        setReading(true);
        read(null);
      },
    };
    read(null);
    return () => { live = false; actions.current = NOTHING_YET; };
  }, [id]);

  return {
    view,
    busy: useBusy(reading),
    problem,
    showEarlier: useCallback(() => actions.current.showEarlier(), []),
    showLatest: useCallback(() => actions.current.showLatest(), []),
  };
}
