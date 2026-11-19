// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An aside's conversation as its tab holds it (docs/planning/_archive/M20b.md, Design 6; C38, C73): a window
// of its items, read from main when the tab is shown, then kept by the session's pushes that name
// this aside, each judged by `takeChat` as the chat's are (src/renderer/src/chat/useChat.ts).
// Nothing is held while the tab is not shown: its body is unmounted then, and reads again at its
// next showing.
//
// A push of the session's own, of a worker's or of another aside's passes: its revision is taken,
// and nothing is read again. An aside that has no question yet is none of the store's: its read
// answers that it is unknown, which here is a new aside and no failure. Its first question's push
// names it, and it is read then.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AsideView } from '@shared/contracts/aside';
import { type ChatHistory, type HeldChat, takeChat } from '@shared/contracts/chat';
import { useBusy } from '../../chat/useChat';
import { type ChatView, windowOf, withItem, withNewer, withOlderPage, withText } from '../../chat/window';
import { invoke, subscribe } from '../../ipc/client';
import { takePresentation } from '../../chat/presentation-store';
import type { AsideRefusal } from './words';

export interface AsideChat {
  /** The window held, or null until a read has answered with the aside. */
  readonly view: ChatView | null;
  /** The aside itself — its title, its source with the excerpt, whether a turn of it runs — or null: not read yet, or new. */
  readonly aside: AsideView | null;
  /** A read has answered, and the store holds none of it: a new aside, or one that was removed. */
  readonly unknown: boolean;
  /** The store held it at an earlier read of this showing, and holds it no more: it was removed, by itself or with its session's chat. */
  readonly gone: boolean;
  /** Why main answered with nothing, or null. */
  readonly refused: Exclude<AsideRefusal, 'unknown-aside'> | null;
  readonly busy: boolean;
  /** The page before the window (M18, C58). */
  readonly showEarlier: () => void;
  /** The newest page, in place of what is held. */
  readonly showLatest: () => Promise<void>;
}

/** An aside is no conversation of a provider's to check: nothing is unread, and nothing is missing. */
const NO_HISTORY: ChatHistory = { state: 'unsupported', olderUnread: false, earlierMissing: false };
const NOTHING_YET: Pick<AsideChat, 'showEarlier' | 'showLatest'> = { showEarlier: () => undefined, showLatest: () => Promise.resolve() };

export function useAsideChat(sessionId: string, asideId: string): AsideChat {
  const [view, setView] = useState<ChatView | null>(null);
  const [aside, setAside] = useState<AsideView | null>(null);
  const [unknown, setUnknown] = useState(false);
  const [gone, setGone] = useState(false);
  const [refused, setRefused] = useState<AsideChat['refused']>(null);
  // The first read is on its way from the start.
  const [reading, setReading] = useState(true);
  const actions = useRef(NOTHING_YET);

  useEffect(() => {
    let live = true;
    // The pane keys a body by its tab, so a hook never changes aside: it starts once.
    let held: HeldChat = { sessionId, revision: null, asideId };
    let shown: ChatView | null = null;
    let serial = 0;
    /** Reads and pages asked for and not answered yet. */
    let asked = 0;
    let paging = false;
    // A push that came before the first answer is dropped, and that answer may predate it.
    let seenBeforeRead = 0;
    /** A read of this showing has answered with the aside. */
    let known = false;

    const show = (next: ChatView): void => { shown = next; setView(next); };
    const answered = (): void => { asked -= 1; setReading(asked > 0); };

    /** The newest page of the aside's items, in place of what is held. */
    function read(): Promise<void> {
      asked += 1;
      setReading(true);
      return invoke('chat:readAside', { sessionId, asideId }).then(
        (answer) => {
          if (!live) return;
          answered();
          if (answer.status !== 'read') {
            // None of the store's: a new aside, until its first question is recorded — or one that was removed.
            if (answer.reason === 'unknown-aside') { setUnknown(true); setGone(known); setRefused(null); setAside(null); shown = null; setView(null); held = { sessionId, revision: null, asideId }; return; }
            setRefused(answer.reason);
            return;
          }
          if (answer.asideId !== asideId || takeChat(held, { kind: 'read', sessionId: answer.sessionId, revision: answer.revision }) !== 'take') return;
          takePresentation(sessionId, answer.presentation);
          // The first read, and one that takes the place of a window which had let go of its newest, are shown from their end.
          const fromEnd = shown === null || !shown.latest;
          held = { sessionId, revision: answer.revision, asideId };
          serial += 1;
          known = true;
          setUnknown(false);
          setGone(false);
          setRefused(null);
          setAside(answer.aside);
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
        // Nothing is held: only a push that names this aside, or a change of the session's list, can bring it.
        if (push.asideId !== undefined && push.asideId !== asideId) return;
        if ('partial' in push || ('item' in push && push.asideId === undefined)) return;
        seenBeforeRead = Math.max(seenBeforeRead, push.revision);
        if (asked === 0) void read();
        return;
      }
      const verdict = takeChat(held, { kind: 'push', push });
      if (verdict === 'append' && 'item' in push) {
        held = { sessionId, revision: push.revision, asideId };
        if (shown === null) return;
        if (!shown.latest) { if (!shown.newer) show(withNewer(shown)); return; }
        serial += 1;
        show(withItem(shown, push.item, push.turn, serial));
      } else if (verdict === 'append-text' && 'partial' in push) {
        held = { sessionId, revision: push.revision, asideId };
        if (shown === null) return;
        if (!shown.latest) { if (!shown.newer) show(withNewer(shown)); return; }
        const grown = withText(shown, push.partial, serial + 1);
        if (grown === null) { void read(); return; }
        serial += 1;
        show(grown);
      } else if (verdict === 'pass') {
        // The session's own, a worker's, or another aside's (C73): the revision is taken, and nothing here changes.
        held = { sessionId, revision: push.revision, asideId };
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
      invoke('chat:readAside', { sessionId, asideId, before }).then(
        (answer) => {
          if (!live) return;
          paging = false;
          answered();
          // The store no longer has the cursor: the newest page read again says what is older now.
          if (answer.status !== 'read') { void read(); return; }
          takePresentation(sessionId, answer.presentation);
          // The page before a window no longer held: dropped.
          if (answer.asideId !== asideId || shown === null || shown.older !== before) return;
          serial += 1;
          show(withOlderPage(shown, { items: answer.items, turns: answer.turns, older: answer.older }, held.revision !== null && answer.revision > held.revision, serial));
        },
        () => { if (live) { paging = false; answered(); } },
      );
    };

    actions.current = { showEarlier, showLatest: () => (live ? read() : Promise.resolve()) };
    void read();
    return () => { live = false; actions.current = NOTHING_YET; stop(); };
  }, [sessionId, asideId]);

  return {
    view,
    aside,
    unknown,
    gone,
    refused,
    busy: useBusy(reading),
    showEarlier: useCallback(() => actions.current.showEarlier(), []),
    showLatest: useCallback(() => actions.current.showLatest(), []),
  };
}
