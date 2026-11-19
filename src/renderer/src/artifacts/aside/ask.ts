// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ChatAskResult } from '@shared/contracts/chat';
import { invoke } from '../../ipc/client';

const pending = new Map<string, Set<Promise<ChatAskResult>>>();
const key = (sessionId: string, asideId: string): string => `${sessionId}\u0000${asideId}`;

/** A close must wait for an in-flight send, so a late acceptance cannot recreate deleted content. */
export function askQuestion(sessionId: string, asideId: string, text: string): Promise<ChatAskResult> {
  const id = key(sessionId, asideId);
  const questions = pending.get(id) ?? new Set<Promise<ChatAskResult>>();
  pending.set(id, questions);
  const sent = invoke('chat:ask', { sessionId, asideId, text }).finally(() => {
    questions.delete(sent);
    if (questions.size === 0) pending.delete(id);
  });
  questions.add(sent);
  return sent;
}

export async function waitForQuestion(sessionId: string, asideId: string): Promise<void> {
  const id = key(sessionId, asideId);
  // A body remounted during a slow send may have sent another question. Wait for every acceptance.
  while (pending.has(id)) await Promise.allSettled([...(pending.get(id) ?? [])]);
}
