// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's conversation, pushed as it changes (docs/planning/_archive/M15.md, Design 13; C55, C76; M18.md, Design 5).
//
// Unlike the app state, nothing here is coalesced: a message is sent at once, so an answer shows
// when it arrives. And unlike it, the push goes to the Main window alone, and only for the session
// that window shows: another session's messages wait in main until they are read, and the Pet,
// which shows on screen shares, never receives a word of a conversation.
//
// Electron-free, as push.ts is: windows arrive as targets.
import type { ChatService } from '../sessions/chat-service';
import type { BroadcastTarget } from './push';

export interface ChatPushOptions {
  readonly chat: Pick<ChatService, 'subscribe'>;
  /** The session the Main window shows, or null. */
  readonly selected: () => string | null;
  /** Read at each push, so a window opened or closed in between is handled. */
  readonly targets: () => Iterable<BroadcastTarget>;
  readonly log?: Pick<Console, 'error'>;
}

/** Starts pushing; returns the function that stops. */
export function startChatPush({ chat, selected, targets, log = console }: ChatPushOptions): () => void {
  return chat.subscribe((push) => {
    if (push.sessionId !== selected()) return;
    for (const target of targets()) {
      if (target.kind !== 'main' || !target.isAlive()) continue;
      try {
        target.send('chat:message', push);
      } catch {
        // The kind of failure only: the push holds a message.
        log.error('[push] could not send chat:message to the main window');
      }
    }
  });
}
