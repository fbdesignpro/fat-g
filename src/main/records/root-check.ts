// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Which roots have gone missing (M12, C28, C29). In memory only: the marks join the app state, and
// nothing is ever removed because of them. A check runs through the limiter (lookup.ts), after the
// request that caused it has answered, so it never delays a window or a request; a folder whose
// check does not answer keeps the state it had.
import type { Lookups } from './lookup';

export interface RootCheck {
  /** Checks these roots; `onChange` runs once if any mark changed. */
  check(roots: readonly string[]): Promise<void>;
  isMissing(root: string): boolean;
}

export function createRootCheck(lookups: Lookups, onChange: () => void): RootCheck {
  const missing = new Map<string, boolean>();
  return {
    async check(roots) {
      const unique = [...new Set(roots)];
      const states = await Promise.all(unique.map((root) => lookups.folder(root)));
      let changed = false;
      for (const [index, root] of unique.entries()) {
        const state = states[index];
        if (state === undefined || state === 'no-answer') continue;
        const now = state === 'missing';
        if ((missing.get(root) ?? false) !== now) changed = true;
        missing.set(root, now);
      }
      if (changed) onChange();
    },
    isMissing: (root) => missing.get(root) === true,
  };
}
