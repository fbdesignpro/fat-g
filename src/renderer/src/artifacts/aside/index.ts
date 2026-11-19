// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The `aside` kind (docs/planning/_archive/M20b.md, Design 6; C36–C43; decision 0025): a tab for a question
// asked beside the session — Explain this on a selection, or one typed freely. Opened from the
// Explain this control and the context menu's item, from a marker and a highlighted passage, and
// from the toolbar. Its reference is the aside's id, which the page makes for a new one; its
// title is the aside's own, which its body sets once it is known.
//
// The one kind whose body holds an input and keeps a draft: docs/adding-a-tab-kind.md takes it as
// its example of both.
import { ASIDE_KIND } from '../opener';
import { setAsideProblem } from '../../chat/asides-store';
import { invoke } from '../../ipc/client';
import { tabKind } from '../tab-kind';
import { AsideBody, type AsideViewState } from './AsideBody';
import { AsideWatcher } from './AsideWatcher';
import { waitForQuestion } from './ask';
import { ASIDE_WORDS } from './words';

export const asideKind = tabKind<string, AsideViewState>({
  id: ASIDE_KIND, title: () => ASIDE_WORDS.title, Body: AsideBody, Watcher: AsideWatcher,
  async beforeClose(sessionId, asideId) {
    setAsideProblem(sessionId, null);
    try {
      await waitForQuestion(sessionId, asideId);
      const answer = await invoke('chat:removeAside', { sessionId, asideId });
      // A draft has no saved conversation. A removed session has no tab content left to remove.
      if (answer.status === 'removed' || answer.reason === 'unknown-aside' || answer.reason === 'unknown-session') return true;
    } catch { /* Keep the tab and its draft available for another attempt. */ }
    setAsideProblem(sessionId, ASIDE_WORDS.removeFailed);
    return false;
  },
});
