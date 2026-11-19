// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { useNewSession } from './new-session-store';
import type { NewChatView } from './useNewChatLifecycle';

/** A first accepted Send reveals its chat once, until navigation leaves that shown session. */
export function useFirstSendReveal(starting: NewChatView | null, shownId: string | null): boolean {
  const sent = useNewSession((state) => state.sent);
  const [screenDraft, setScreenDraft] = useState<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);

  if (starting !== null) {
    if (screenDraft !== starting.draftId) setScreenDraft(starting.draftId);
    if (reveal !== null) setReveal(null);
  } else if (screenDraft !== null) {
    if (sent.has(screenDraft) && shownId === screenDraft) setReveal(screenDraft);
    setScreenDraft(null);
  } else if (reveal !== null && shownId !== reveal) {
    setReveal(null);
  }

  return reveal !== null && reveal === shownId;
}
