// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ConversationItem, itemText } from '@shared/contracts/conversation';
import { invoke } from '../ipc/client';

/** Each list copies only its own conversation, never a parent or a neighbouring thread. */
export type ConversationCopySource =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'worker'; readonly sessionId: string; readonly workerId: string }
  | { readonly kind: 'aside'; readonly sessionId: string; readonly asideId: string }
  | { readonly kind: 'detached'; readonly id: string };

interface Page {
  readonly items: readonly ConversationItem[];
  readonly older: string | null;
}

/** Reuses the Main-only, bounded reads; exporting never changes the displayed window. */
async function readPage(source: ConversationCopySource, before: string | null): Promise<Page> {
  const cursor = before === null ? {} : { before };
  const answer = source.kind === 'session'
    ? before === null ? await invoke('chat:read', { sessionId: source.sessionId }) : await invoke('chat:page', { sessionId: source.sessionId, before })
    : source.kind === 'worker'
      ? await invoke('chat:readWorker', { sessionId: source.sessionId, workerId: source.workerId, ...cursor })
      : source.kind === 'aside'
        ? await invoke('chat:readAside', { sessionId: source.sessionId, asideId: source.asideId, ...cursor })
        : await invoke('conversations:readDetached', { id: source.id, ...cursor });
  if (answer.status === 'refused' || ('storage' in answer && answer.storage === 'refused')) throw new Error('Conversation could not be read.');
  return answer;
}

/**
 * Reads at the press, newest page first, then every older page. Keeps Markdown source and speaker
 * labels, leaving out activity, notices and other threads. Nothing is cached or written to disk;
 * a failed page rejects the copy rather than placing a partial transcript on the clipboard.
 */
export async function conversationCopyText(source: ConversationCopySource, modelName: string, nameModel?: (key: string) => string, userName = 'You'): Promise<string> {
  const pages: string[][] = [];
  const cursors = new Set<string>();
  let before: string | null = null;
  do {
    const page = await readPage(source, before);
    pages.push(page.items.flatMap((item) => {
      if (item.kind !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) return [];
      const speaker = item.role === 'user' ? userName : item.model === null ? modelName : nameModel?.(item.model) ?? item.model;
      return [`${speaker}:\n\n${itemText(item)}`];
    }));
    before = page.older;
    if (before !== null) {
      if (cursors.has(before)) throw new Error('Conversation cursor did not advance.');
      cursors.add(before);
    }
  } while (before !== null);
  return pages.reverse().flat().join('\n\n');
}
