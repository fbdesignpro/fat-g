// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What becomes of a session no turn has run when the user goes elsewhere (docs/planning/_archive/M26.md,
// round 2). Such a session is provisional: it holds a model preset, and nothing of it is drawn while
// its composer is empty and it has no name (`SessionList`), so leaving it then removes it — there
// would be no capsule to find it by again, and there is nothing in it to keep.
//
// Left with text in its composer, it keeps its capsule, and the secretary is asked what that text is
// about so the list can tell it apart (`sessions:describeDraft`). Left with images in its draft or a
// queued message (M23, C83), it keeps its capsule too, and is never removed: main says so of it by a
// presence alone, after a restart as well, and the page by what its composer holds meanwhile. That is the one moment a draft
// leaves the page before Send, cut here to the most a name is written from, and the same text is
// never sent twice.
//
// The page's, not main's: the draft is the page's own (chat-store.ts), and main is told of it only
// here. A session the user has named is left alone — main refuses the description for it as well.
import { useEffect, useRef } from 'react';
import { cutTo } from '@shared/contracts/cut';
import { MAX_LINE_INPUT, notStarted, type SessionEntry } from '@shared/contracts/sessions';
import { draftOf } from '../chat/chat-store';
import { composerOf } from '../chat/composer/composer-store';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';

/**
 * Whether a session draws a capsule: every session a turn has run, and one not started that has a
 * name, something typed in its composer, or a draft or queue that main says holds something (M23,
 * C83). The session list and the recent sessions switcher (M100, C93) both go by it, so neither
 * counts a session the other does not show.
 */
export function hasCapsule(entry: Pick<SessionEntry, 'record' | 'summary' | 'content'>, draft: string): boolean {
  return !notStarted(entry) || entry.record.name !== null || draft !== '' || entry.content === true;
}

/** Whether the page's composer holds images, staged or being staged, or a queued message, for the session (M23, C83). */
function holdsMore(sessionId: string): boolean {
  const held = composerOf(sessionId);
  return held.staging.length > 0 || held.main.draft.attachments.length > 0 || held.main.queue.entries.length > 0;
}

/**
 * Watches which session is selected, for the window. Mounted once: what it does belongs to the
 * session the selection leaves, so it runs on the change and not on a press.
 */
export function useUnstartedSessions(): void {
  const selectedId = useAppState((state) => state.snapshot?.sessions?.selectedId ?? null);
  /** What was last sent for each session: a draft that has not changed is not described again. */
  const described = useRef(new Map<string, string>());

  useEffect(() => {
    const left = selectedId;
    const sent = described.current;
    if (left === null) return;
    return () => {
      // The state as it stands, which the selection's own change has already reached. Gone from the
      // list: it was removed — by Cancel, or with its project — and nothing is owed it.
      const entry = useAppState.getState().snapshot?.sessions?.sessions.find((candidate) => candidate.record.id === left);
      if (entry === undefined || !notStarted(entry)) return;
      const draft = draftOf(left).trim();
      if (draft === '') {
        // Nothing typed and no name, and no image or queued message: there is nothing to show and nothing to keep.
        if (entry.record.name === null && entry.content !== true && !holdsMore(left)) void invoke('sessions:remove', { id: left }).catch(() => undefined);
        return;
      }
      const { text } = cutTo(draft, MAX_LINE_INPUT);
      if (sent.get(left) === text) return;
      sent.set(left, text);
      void invoke('sessions:describeDraft', { id: left, text }).catch(() => undefined);
    };
  }, [selectedId]);
}
