// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's conversation as the page holds it (docs/planning/_archive/M15.md, Design 13; C55, C96; M18.md,
// Design 5; C20, C58, C60; M19.md, Design 5; C24, C26): a window of it, read once when the chat opens, then kept by the pushes,
// each judged by `takeChat`. The selection reaches the page in the app state and a push at once, so
// the two can cross; every answer and push names its session, which is what makes the crossing
// harmless.
//
// The window is 500 items at most (window.ts). Older pages come only from `showEarlier`; a window
// that let go of its newest takes a push's revision and not its item; and what reads again — a
// `changed` push, a gap, a page answered at another revision — reads the window held, from its
// oldest item, so the pages a reader loaded stay where they were.
//
// A push of an item the window holds is applied in place whatever page it shows (M21, C71): a card
// answered, dismissed or passed while the reader is on an older page is redrawn where it stands.
// A worker's interaction push, which the list passes, says whether a question of that worker's
// waits (C73), and a raised one is posted once from here, whether or not its tab is shown (C74).
//
// An approval is raised, posted and applied in place as a blocking question is (M22, C36); and the
// session's grants, which its read lists, follow each approval's push — its own and a worker's —
// so the list beside the chat says what was sent, and what ended, without another read (C57, C92).
//
// A message that is being written (M19, C24, C26): its item push puts it in, or in place of the
// one held under its id; a partial push appends to the held item only when its text is exactly as
// long as the push says it was, and the window is read again otherwise — a read's answer holds the
// text main has pushed, at its revision, so nothing is shown twice and nothing is lost.
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { type ChatReadRequest, type HeldChat, takeChat } from '@shared/contracts/chat';
import { invoke, subscribe } from '../ipc/client';
import { clearPresentation, takePresentation } from './presentation-store';
import { clearAsides, setAsides } from './asides-store';
import { takeComposer } from './composer/composer-store';
import { clearGrants, noteGrant, setGrants } from './grants-store';
import { clearWaiting, noteWorkerQuestion, setWaiting } from './questions-store';
import { type ChatView, holdsItem, isRaised, windowOf, withAsked, withItem, withNewer, withOlderPage, withText } from './window';

export type { ChatView } from './window';

export interface Chat {
  /** The window held, or null until the first read has answered. */
  readonly view: ChatView | null;
  /** A read or an older page is on its way, or is being put in: the list is busy meanwhile (Design 5). */
  readonly busy: boolean;
  /** The page before the window (C58). Nothing else asks for one. */
  readonly showEarlier: () => void;
  /** The newest page, in place of the window. Resolves once it is shown, or could not be read. */
  readonly showLatest: () => Promise<void>;
}

/**
 * Busy from the moment something is asked for until the commit after the one that put it in: the
 * deferred value is one commit behind, so the list changes while it still says it is busy.
 */
export function useBusy(reading: boolean): boolean {
  const settling = useDeferredValue(reading);
  return reading || settling;
}

const NOTHING_YET: Pick<Chat, 'showEarlier' | 'showLatest'> = { showEarlier: () => undefined, showLatest: () => Promise.resolve() };

export function useChat(sessionId: string): Chat {
  const [view, setView] = useState<ChatView | null>(null);
  // The first read is on its way from the start.
  const [reading, setReading] = useState(true);
  const actions = useRef(NOTHING_YET);

  useEffect(() => {
    let live = true;
    // ChatRegion keys the chat by its session, so a hook never changes session: it starts once.
    let held: HeldChat = { sessionId, revision: null };
    let shown: ChatView | null = null;
    let serial = 0;
    /** Reads and pages asked for and not answered yet. */
    let asked = 0;
    let paging = false;
    // A push that came before the first answer is dropped, and that answer may predate it: the
    // newest such revision says whether to read once more.
    let seenBeforeRead = 0;

    const show = (next: ChatView): void => { shown = next; setView(next); };
    const answered = (): void => { asked -= 1; setReading(asked > 0); };

    /** The newest page, or — `window` — what is held, from its oldest item on (C60). Resolves with whether it was taken. */
    function read(window: boolean): Promise<boolean> {
      const from = window ? shown?.items[0]?.id ?? null : null;
      const request: ChatReadRequest = from === null ? { sessionId } : { sessionId, from, keep: shown?.latest === false ? 'oldest' : 'newest' };
      asked += 1;
      return invoke('chat:read', request).then(
        (answer) => {
          if (!live) return false;
          answered();
          if (answer.status !== 'read') return false;
          takePresentation(sessionId, answer.presentation);
          if (takeChat(held, { kind: 'read', sessionId: answer.sessionId, revision: answer.revision }) !== 'take') return false;
          // The window's head moved while this was on its way — an older page went in, or the oldest
          // was let go: it answers a window no longer held, which is read again as it now is.
          if (from !== null && shown?.items[0]?.id !== from) { again(); return false; }
          held = { sessionId, revision: answer.revision };
          serial += 1;
          // The session's asides, as this read lists them (M20b, C30): what its markers, its highlights and restored tabs are drawn from.
          setAsides(sessionId, answer.asides, answer.asking);
          // And its workers' questions that wait for an answer (M21, C73): what their rows read.
          setWaiting(sessionId, answer.waiting);
          // And the grants fat-g sent (M22, C57, C92): what the list beside the chat draws, and the mode menu counts.
          setGrants(sessionId, answer.grants);
          // And the composer beside it (M23, C57, C86): the draft, the queue, and whether Send now is offered.
          if (answer.composer !== undefined) takeComposer(sessionId, answer.revision, answer.composer);
          // A `from` the store no longer has is answered with the newest page, and is taken as such.
          show(windowOf(answer, { serial, kind: from === null ? 'latest' : 'replace' }, shown));
          if (seenBeforeRead > answer.revision) { seenBeforeRead = 0; again(); }
          return true;
        },
        // The next push reads again.
        () => { if (live) answered(); return false; },
      );
    }
    /** Reads the held window again: the list is busy until it is in. */
    function again(): void { setReading(true); void read(true); }

    const stop = subscribe('chat:message', (push) => {
      if (!live || push.sessionId !== sessionId) return;
      takePresentation(sessionId, push.presentation);
      if ('presentationOnly' in push) return;
      // The composer's state is whole in each push (M23, C86): taken where newer, whatever the window holds.
      if ('composer' in push) takeComposer(sessionId, push.revision, push.composer);
      if (held.revision === null) {
        seenBeforeRead = Math.max(seenBeforeRead, push.revision);
        // No read is on its way: the first one failed, and this push is the next chance to ask.
        if (asked === 0) again();
        return;
      }
      const verdict = takeChat(held, { kind: 'push', push });
      // An approval's push says what became of its grant (M22, C57, C92): the session's own, and a
      // worker's, which this list passes. A push that is read for brings it with the read.
      if ('item' in push && push.asideId === undefined && (verdict === 'append' || verdict === 'pass')) noteGrant(sessionId, push.item);
      if (verdict === 'append' && 'item' in push) {
        held = { sessionId, revision: push.revision };
        if (shown === null) return;
        // A window that let go of its newest takes the revision alone (C58): the item is on disk,
        // past its end. It notes that something newer arrived (M19, C46), and nothing in it moves —
        // but an item it holds is applied where it stands (M21, C71).
        if (!shown.latest && !holdsItem(shown, push.item.id)) {
          const noted = withNewer(shown);
          // A question raised past the window's end is posted all the same (M21, C43).
          if (isRaised(push.item)) { serial += 1; show(withAsked(noted, serial, false, push.item)); } else if (noted !== shown) show(noted);
          return;
        }
        serial += 1;
        show(withItem(shown, push.item, push.turn, serial));
      } else if (verdict === 'append-text' && 'partial' in push) {
        held = { sessionId, revision: push.revision };
        if (shown === null) return;
        if (!shown.latest) { if (!shown.newer) show(withNewer(shown)); return; }
        // To a held item of exactly that length, or the window is read again (M19, C24).
        const grown = withText(shown, push.partial, serial + 1);
        if (grown === null) { again(); return; }
        serial += 1;
        show(grown);
      } else if (verdict === 'pass') {
        // A worker's (M20a, C32), or an aside's (M20b, C73): its tab shows it. The revision is taken, and nothing here changes or is read again.
        held = { sessionId, revision: push.revision };
        // A worker's question (M21, C73, C74): its row waits while it is pending, and its raising is
        // posted from here, since only the selected tab's body is mounted.
        if ('item' in push && push.workerId !== undefined && push.asideId === undefined && push.item.kind === 'interaction' && noteWorkerQuestion(sessionId, push.item) && shown !== null) {
          serial += 1;
          show(withAsked(shown, serial, true, push.item));
        }
      } else if (verdict === 'read') {
        // A question raised right behind a change the window is still reading for (M21, C43, C74):
        // its push is past the revision held, so its card comes with the read — and a read posts
        // nothing. The raising is noted here, once, as it is for a push that is applied.
        if ('item' in push && push.asideId === undefined && isRaised(push.item) && shown !== null) {
          const worker = push.workerId !== undefined;
          if (!worker || noteWorkerQuestion(sessionId, push.item)) { serial += 1; show(withAsked(shown, serial, worker, push.item)); }
        }
        again();
      }
    });

    const showEarlier = (): void => {
      const before = shown?.older ?? null;
      if (!live || paging || before === null) return;
      paging = true;
      asked += 1;
      setReading(true);
      invoke('chat:page', { sessionId, before }).then(
        (answer) => {
          if (!live) return;
          paging = false;
          answered();
          // The store no longer has the cursor (C20): the window read again says what is older now.
          if (answer.status === 'refused') { if (answer.reason === 'unknown-cursor') again(); return; }
            takePresentation(sessionId, answer.presentation);
          // Another session's, or the page before a window no longer held: dropped.
          if (answer.sessionId !== sessionId || shown === null || shown.older !== before) return;
          serial += 1;
          show(withOlderPage(shown, answer, held.revision !== null && answer.revision > held.revision, serial));
          // Answered at another revision than the one held (C60): what it joined may have changed since.
          if (answer.revision !== held.revision) again();
        },
        () => { if (live) { paging = false; answered(); } },
      );
    };

    const showLatest = (): Promise<void> => {
      if (!live) return Promise.resolve();
      setReading(true);
      return read(false).then(() => undefined);
    };

    actions.current = { showEarlier, showLatest };
    void read(false);
    return () => { live = false; actions.current = NOTHING_YET; stop(); clearAsides(sessionId); clearWaiting(sessionId); clearGrants(sessionId); clearPresentation(sessionId); };
  }, [sessionId]);

  return {
    view,
    busy: useBusy(reading),
    showEarlier: useCallback(() => actions.current.showEarlier(), []),
    showLatest: useCallback(() => actions.current.showLatest(), []),
  };
}
