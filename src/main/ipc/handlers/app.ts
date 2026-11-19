// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { InvokeHandlers } from '../dispatch';

export interface AppHandlerDeps {
  /**
   * `app.quit()`: the path that already runs process cleanup and the final saves
   * (src/main/app/lifecycle.ts, shutdown.ts). While a session runs, the quit gate questions it first
   * (src/main/app/quit-gate.ts; M14, C101).
   */
  readonly quit: () => void;
  /** The quit gate's: false when no question is asked. */
  readonly answerQuit: (quit: boolean) => boolean;
  /** The draft flush's (M23, C31): false when the token names no open ask. */
  readonly draftsFlushed?: (token: number) => boolean;
}

/**
 * `app:quit` runs on the next tick, after this call has answered, so the window's reply is not lost
 * to the quit. `app:answerQuit` is the page's answer to main's question (M14, C101). `drafts:flushed`
 * is its answer to main's ask for its unsent drafts, before its window closes or fat-g quits (M23, C31).
 */
export function appHandlers({ quit, answerQuit, draftsFlushed }: AppHandlerDeps): Pick<InvokeHandlers, 'app:quit' | 'app:answerQuit' | 'drafts:flushed'> {
  return {
    'app:quit': () => {
      setTimeout(quit, 0);
      return null;
    },
    'app:answerQuit': (request) => (answerQuit(request.quit) ? { status: 'answered' } : { status: 'refused', reason: 'no-question' }),
    'drafts:flushed': (request) => (draftsFlushed?.(request.token) === true ? { status: 'answered' } : { status: 'refused', reason: 'no-request' }),
  };
}
