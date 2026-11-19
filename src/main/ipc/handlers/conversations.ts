// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The conversation store's channels (docs/planning/_archive/M18.md, Design 8–10; C23, C24, C31–C33, C35, C41):
// what the storage view shows, Start fresh for a store fat-g refused, and the conversations no
// listed session has — listed, read a page at a time, and removed only when the user asks.
//
// All six are the Main window's only: a conversation's text and a file's name are the user's own,
// and the Pet shows on screen shares. Nothing here reaches a provider: a detached conversation has
// no record to vouch for its instance, its folder or its trust, so it takes no prompt, and neither a
// resume nor a history read is asked for it (C35).
import { cutLine } from '@shared/contracts/agent-events';
import type { ConversationsRefusal } from '@shared/contracts/conversation';
import { normalizeSessionName } from '@shared/contracts/names';
import { type ConversationStore, turnView } from '../../conversations/store';
import type { RecordsStore } from '../../records/store';
import type { Removal } from '../../sessions/removal';
import type { ConversationsFollower } from '../../state/conversations';
import { errorKind } from '../../storage/error-kind';
import type { InvokeHandlers } from '../dispatch';

export interface ConversationsHandlerDeps {
  readonly conversations: Pick<ConversationStore, 'status' | 'startFresh' | 'firstPrompt' | 'textUnits' | 'newestPage' | 'pageBefore' | 'files' | 'attachmentsSize'>;
  readonly records: Pick<RecordsStore, 'isRefused'>;
  readonly detached: ConversationsFollower['detached'];
  readonly removal: Pick<Removal, 'detached'>;
  /** A new store was opened: the sessions are reconciled against it, and their reasons worked out again. */
  readonly afterStartFresh: () => void;
  /** Kinds only: never a text, a name or a path. */
  readonly log?: Pick<Console, 'warn'>;
}

type Channels =
  | 'conversations:storage'
  | 'conversations:startFresh'
  | 'conversations:listDetached'
  | 'conversations:readDetached'
  | 'conversations:removeDetached'
  | 'conversations:removeSetAside';

const refused = (reason: ConversationsRefusal['reason']): ConversationsRefusal => ({ status: 'refused', reason });

export function conversationsHandlers(deps: ConversationsHandlerDeps): Pick<InvokeHandlers, Channels> {
  const { conversations, log = console } = deps;
  const isRefused = (): boolean => conversations.status().kind === 'refused';
  const failed = (what: string, error: unknown): void => { log.warn(`[conversations] ${what} (${errorKind(error)})`); };

  return {
    'conversations:storage'() {
      const detached = deps.detached().map((entry) => entry.id);
      let textUnits = 0;
      try { textUnits = conversations.textUnits(detached); } catch (error) { failed('the detached chats could not be measured', error); }
      // The active images' folder is counted with the store (M23, C12): a set-aside one is in its generation's size (C84).
      return { status: conversations.status(), bytes: conversations.files.totalSize(), detached: { count: detached.length, textUnits }, setAside: conversations.files.setAside(), attachments: conversations.attachmentsSize() };
    },

    async 'conversations:startFresh'() {
      const answer = await conversations.startFresh();
      if (answer.status === 'done') deps.afterStartFresh();
      return answer;
    },

    'conversations:listDetached'() {
      try {
        return deps.detached().map(({ id, createdAt }) => {
          // By its first prompt's first line, clamped as a name is (C31). One with no prompt is shown by its date.
          const name = normalizeSessionName(cutLine(conversations.firstPrompt(id) ?? ''));
          return { id, name: name === '' ? null : name, createdAt };
        });
      } catch (error) {
        failed('the detached chats could not be listed', error);
        return [];
      }
    },

    'conversations:readDetached'({ id, before }) {
      if (isRefused()) return refused('conversations-refused');
      // Only a conversation no listed session has: a session's own chat is read through `chat:read`.
      if (!deps.detached().some((entry) => entry.id === id)) return refused('unknown-conversation');
      try {
        const rows = before === undefined ? conversations.newestPage(id) : conversations.pageBefore(id, before);
        if (rows === null) return refused('unknown-cursor');
        // No turn of it is live: nothing runs for a chat without a session.
        return { status: 'page', sessionId: id, revision: 0, items: rows.items, turns: rows.turns.map((turn) => turnView(turn, false)), older: rows.older ? rows.items[0]?.id ?? null : null };
      } catch (error) {
        failed('a detached chat could not be read', error);
        return refused('storage-failed');
      }
    },

    'conversations:removeDetached'(request) {
      // Not while records are refused (C32): a chat counted as detached then may be a listed session's.
      if (deps.records.isRefused()) return refused('records-refused');
      if (isRefused()) return refused('conversations-refused');
      const detached = new Set(deps.detached().map((entry) => entry.id));
      const ids = 'all' in request ? [...detached] : request.ids;
      if (!ids.every((id) => detached.has(id))) return refused('unknown-conversation');
      try {
        deps.removal.detached(ids);
      } catch (error) {
        failed('detached chats could not be removed', error);
        return refused('storage-failed');
      }
      return { status: 'saved' };
    },

    'conversations:removeSetAside'(request) {
      // A name is one Start fresh gave a store, and the store's own files are never among them (C41).
      const names = 'all' in request ? conversations.files.setAside().map((entry) => entry.name) : request.names;
      return { status: 'saved', ...conversations.files.removeSetAside(names) };
    },
  };
}
