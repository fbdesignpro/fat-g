// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Whether a session's draft or queue holds something (docs/planning/_archive/M23.md, Design 5; C83): a
// presence alone, which keeps a provisional session — never started and never named — from the
// cleanup of unstarted sessions, and gives it a capsule after a restart though it holds only images.
// Read from the conversation store as ids alone; no text, image or count of either leaves it. A store
// that cannot be read answers neither yes nor no, and is never taken for proof that nothing is there.
//
// Electron-free, and no provider is named.
import type { ConversationStore } from '../conversations/store';

export interface ContentPresence {
  /** True or false as the store says; null while it cannot say. */
  has(sessionId: string): boolean | null;
  /** Read again after a change of drafts or queues: true when any session's presence changed. */
  refresh(): boolean;
}

export function createContentPresence(store: Pick<ConversationStore, 'status' | 'withContent'>): ContentPresence {
  /** Undefined until first asked; null while the store cannot say. */
  let held: ReadonlySet<string> | null | undefined;

  function read(): ReadonlySet<string> | null {
    if (store.status().kind !== 'ok') return null;
    try {
      return new Set(store.withContent());
    } catch {
      return null;
    }
  }

  return {
    has(sessionId) {
      if (held === undefined) held = read();
      return held === null ? null : held.has(sessionId);
    },
    refresh() {
      const before = held;
      held = read();
      if (before === undefined) return true;
      if (before === null || held === null) return before !== held;
      return before.size !== held.size || [...held].some((id) => !before.has(id));
    },
  };
}
