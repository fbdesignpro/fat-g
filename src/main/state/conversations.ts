// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The conversation store, carried into the app state for the Main window (docs/planning/_archive/M18.md,
// Design 8; C24, C31–C33): its status, and how many conversations no listed session has. A status
// and a count, never a name, a text or a path: the Pet's projection leaves even that out.
//
// A conversation whose session is not listed is detached (C31): kept unchanged, and attached again
// by its id if the record returns. One a removal has marked is neither shown nor counted (C63).
//
// A conversation with a parent is never detached by itself (M20b, C71): an aside is its session's
// chat's, counted with it and not beside it, and listed nowhere else.
import type { ConversationsState } from '@shared/contracts/conversation';
import type { ConversationStore } from '../conversations/store';
import type { RecordsStore } from '../records/store';
import type { AppStateStore } from './app-state-store';

export interface ConversationsFollower {
  /** The detached conversations, oldest first, each with when it was made. None while the store is refused. */
  detached(): readonly { readonly id: string; readonly createdAt: number }[];
  stop(): void;
}

export interface FollowConversationsOptions {
  readonly conversations: Pick<ConversationStore, 'status' | 'subscribe' | 'conversations'>;
  readonly records: Pick<RecordsStore, 'subscribe' | 'getView'>;
  readonly store: Pick<AppStateStore, 'setConversations'>;
}

export function followConversations({ conversations, records, store }: FollowConversationsOptions): ConversationsFollower {
  let shown: ConversationsState | null = null;

  function detached(): { id: string; createdAt: number }[] {
    if (conversations.status().kind !== 'ok') return [];
    const listed = new Set(records.getView().sessions.map((record) => record.id));
    try {
      return conversations.conversations().filter((entry) => entry.parentId === null && !entry.removing && !listed.has(entry.id)).map(({ id, createdAt }) => ({ id, createdAt }));
    } catch {
      // The store could not be read: nothing is said to be there that cannot be shown.
      return [];
    }
  }

  function apply(): void {
    const status = conversations.status();
    const next: ConversationsState = { status, detached: detached().length };
    const same = shown !== null && shown.detached === next.detached && shown.status.kind === status.kind && (shown.status.kind !== 'refused' || status.kind !== 'refused' || shown.status.cause === status.cause);
    if (same) return;
    shown = next;
    store.setConversations(next);
  }

  apply();
  const stops = [conversations.subscribe(apply), records.subscribe(apply)];
  return { detached, stop: () => { for (const stop of stops) stop(); } };
}
