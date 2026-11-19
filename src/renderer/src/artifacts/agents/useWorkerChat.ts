// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A sub-agent's items as its thread holds them (docs/planning/_archive/M20a.md, Design 7, 9; C32, C48, C49;
// docs/planning/_archive/M106.md, Design 7; C22): a window of them, read from main when the thread is shown,
// then kept by the session's pushes that name this worker, each judged by `takeChat` as the chat's are
// (src/renderer/src/chat/useChat.ts). Nothing is held while the thread is folded: its body is
// unmounted then, and reads again when it unfolds, or at the tab's next showing.
//
// A push of the session's own, or of another worker's, passes: its revision is taken and nothing is
// read again. One push of the session's own is looked at: the item that started this worker, whose
// status and duration a thread opened for a sub-agent the list no longer holds draws above it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ChatHistory, type ChatWorkerReadRequest, type HeldChat, takeChat } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import { useBusy } from '../../chat/useChat';
import { type ChatView, holdsItem, windowOf, withItem, withNewer, withOlderPage, withText } from '../../chat/window';
import { invoke, subscribe } from '../../ipc/client';
import { takePresentation } from '../../chat/presentation-store';
import type { WorkerRefusal } from './words';

export interface WorkerChat {
  /** The window held, or null until the first read has answered. */
  readonly view: ChatView | null;
  /** The item of the session's own that started the worker (C23, C47), or null: not read yet, or none is kept. */
  readonly worker: ConversationItem | null;
  /** Why main answered with nothing, or null. */
  readonly refused: WorkerRefusal | null;
  readonly busy: boolean;
  /** The page before the window (M18, C58). */
  readonly showEarlier: () => void;
  /** The newest window, in place of what is held. */
  readonly showLatest: () => Promise<void>;
}

/** A worker's work is no conversation of a provider's to check: nothing is unread, and nothing is missing. */
const NO_HISTORY: ChatHistory = { state: 'unsupported', olderUnread: false, earlierMissing: false };
const NOTHING_YET: Pick<WorkerChat, 'showEarlier' | 'showLatest'> = { showEarlier: () => undefined, showLatest: () => Promise.resolve() };

export function useWorkerChat(sessionId: string, workerId: string): WorkerChat {
  const [view, setView] = useState<ChatView | null>(null);
  const [worker, setWorker] = useState<ConversationItem | null>(null);
  const [refused, setRefused] = useState<WorkerRefusal | null>(null);
  // The first read is on its way from the start.
  const [reading, setReading] = useState(true);
  const actions = useRef(NOTHING_YET);

  useEffect(() => {
    let live = true;
    // The pane keys a body by its tab, so a hook never changes worker: it starts once.
    let held: HeldChat = { sessionId, revision: null, workerId };
    let shown: ChatView | null = null;
    let serial = 0;
    /** Reads and pages asked for and not answered yet. */
    let asked = 0;
    let paging = false;
    // A push that came before the first answer is dropped, and that answer may predate it.
    let seenBeforeRead = 0;

    const show = (next: ChatView): void => { shown = next; setView(next); };
    const answered = (): void => { asked -= 1; setReading(asked > 0); };

    /** The newest window of the worker's items, in place of what is held. */
    function read(): Promise<void> {
      const request: ChatWorkerReadRequest = { sessionId, workerId };
      asked += 1;
      setReading(true);
      return invoke('chat:readWorker', request).then(
        (answer) => {
          if (!live) return;
          answered();
          if (answer.status !== 'read') { setRefused(answer.reason); return; }
          takePresentation(sessionId, answer.presentation);
          if (answer.workerId !== workerId || takeChat(held, { kind: 'read', sessionId: answer.sessionId, revision: answer.revision }) !== 'take') return;
          // The first read, and one that takes the place of a window which had let go of its newest, are shown from their end.
          const fromEnd = shown === null || !shown.latest;
          held = { sessionId, revision: answer.revision, workerId };
          serial += 1;
          setRefused(null);
          setWorker(answer.worker);
          show(windowOf({ items: answer.items, turns: answer.turns, latest: true, older: answer.older, history: NO_HISTORY, storage: 'ok' }, { serial, kind: fromEnd ? 'latest' : 'replace' }, shown));
          if (seenBeforeRead > answer.revision) { seenBeforeRead = 0; void read(); }
        },
        // The next push reads again.
        () => { if (live) answered(); },
      );
    }

    const stop = subscribe('chat:message', (push) => {
      if (!live || push.sessionId !== sessionId) return;
      takePresentation(sessionId, push.presentation);
      if ('presentationOnly' in push) return;
      if (held.revision === null) {
        seenBeforeRead = Math.max(seenBeforeRead, push.revision);
        // No read is on its way: the first one failed, and this push is the next chance to ask.
        if (asked === 0) void read();
        return;
      }
      const verdict = takeChat(held, { kind: 'push', push });
      if (verdict === 'append' && 'item' in push) {
        held = { sessionId, revision: push.revision, workerId };
        if (shown === null) return;
        // An item the window holds is applied where it stands, on any page (M21, C71).
        if (!shown.latest && !holdsItem(shown, push.item.id)) { if (!shown.newer) show(withNewer(shown)); return; }
        serial += 1;
        show(withItem(shown, push.item, push.turn, serial));
      } else if (verdict === 'append-text' && 'partial' in push) {
        held = { sessionId, revision: push.revision, workerId };
        if (shown === null) return;
        if (!shown.latest) { if (!shown.newer) show(withNewer(shown)); return; }
        const grown = withText(shown, push.partial, serial + 1);
        if (grown === null) { void read(); return; }
        serial += 1;
        show(grown);
      } else if (verdict === 'pass') {
        // The session's own, or another worker's (C32): the revision is taken. The item that started
        // this worker is the session's own, and its line above the list follows it.
        held = { sessionId, revision: push.revision, workerId };
        if ('item' in push && push.item.activity?.type === 'worker' && push.item.activity.workerId === workerId) setWorker(push.item);
      } else if (verdict === 'read') {
        void read();
      }
    });

    const showEarlier = (): void => {
      const before = shown?.older ?? null;
      if (!live || paging || before === null) return;
      paging = true;
      asked += 1;
      setReading(true);
      invoke('chat:readWorker', { sessionId, workerId, before }).then(
        (answer) => {
          if (!live) return;
          paging = false;
          answered();
          // The store no longer has the cursor: the window read again says what is older now.
          if (answer.status !== 'read') { if (answer.reason === 'unknown-cursor') void read(); else setRefused(answer.reason); return; }
          takePresentation(sessionId, answer.presentation);
          // The page before a window no longer held: dropped.
          if (answer.workerId !== workerId || shown === null || shown.older !== before) return;
          serial += 1;
          show(withOlderPage(shown, answer, held.revision !== null && answer.revision > held.revision, serial));
        },
        () => { if (live) { paging = false; answered(); } },
      );
    };

    actions.current = { showEarlier, showLatest: () => (live ? read() : Promise.resolve()) };
    void read();
    return () => { live = false; actions.current = NOTHING_YET; stop(); };
  }, [sessionId, workerId]);

  return {
    view,
    worker,
    refused,
    busy: useBusy(reading),
    showEarlier: useCallback(() => actions.current.showEarlier(), []),
    showLatest: useCallback(() => actions.current.showLatest(), []),
  };
}
