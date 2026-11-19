// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The page's unsent drafts, asked for before the Main page goes (docs/planning/_archive/M23.md, Design 5; C31,
// V7). The page hands a draft's text over within 300 ms of the last keystroke; what it typed in that
// time is in the page alone. Before the page goes — its window closed, or fat-g quitting — main asks
// it for that text over \`drafts:flush\`, and the page hands every draft over, then answers the ask over
// \`drafts:flushed\`. Main waits for the answer a bounded time: a page that cannot answer — frozen,
// gone, still loading — holds nothing up, and its last instant of typing is lost, as a forced end's is.
//
// The Main window's close: a close the quit gate let pass is held while the page is asked, then
// closed again, which passes. The quit's drain asks first, before its Stops (shutdown.ts), so the text
// is in main's hands when main writes every draft it holds.
//
// Electron-free: the push and the window's close arrive as functions, so it is tested with fakes.

/** The most the page's answer is waited for. */
export const DRAFT_FLUSH_WAIT_MS = 1000;

export interface DraftFlushTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface DraftFlushDeps {
  /** Sends the ask to the Main page: false when there is no page that can answer it. */
  readonly ask: (token: number) => boolean;
  readonly waitMs?: number;
  readonly timers?: DraftFlushTimers;
}

interface Preventable {
  preventDefault(): void;
}

export interface DraftFlush {
  /** Asks the Main page for its unsent drafts: resolves once it answers, once the wait is over, or at once where there is no page to ask. */
  flush(): Promise<void>;
  /** The page's answer: true when it answers an ask still open. */
  flushed(token: number): boolean;
  /**
   * The Main window's \`close\`, once the quit gate let it pass: the first is held while the page is
   * asked, then \`close\` closes the window again, and that close passes.
   */
  mainClose(event: Preventable, close: () => void): void;
}

const defaultTimers: DraftFlushTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function createDraftFlush({ ask, waitMs = DRAFT_FLUSH_WAIT_MS, timers = defaultTimers }: DraftFlushDeps): DraftFlush {
  let tokens = 0;
  /** The asks still open, by token: each resolved by its answer or its wait. */
  const open = new Map<number, () => void>();
  /** Where the Main window's close stands: held while its ask is open, then let through once. */
  let closing: 'none' | 'asking' | 'passing' = 'none';

  function flush(): Promise<void> {
    tokens += 1;
    const token = tokens;
    return new Promise<void>((resolve) => {
      const timer = timers.set(() => { open.delete(token); resolve(); }, waitMs);
      open.set(token, () => { timers.clear(timer); open.delete(token); resolve(); });
      let asked: boolean;
      try { asked = ask(token); } catch { asked = false; }
      if (!asked) open.get(token)?.();
    });
  }

  return {
    flush,
    flushed(token) {
      const done = open.get(token);
      if (done === undefined) return false;
      done();
      return true;
    },
    mainClose(event, close) {
      if (closing === 'passing') { closing = 'none'; return; }
      event.preventDefault();
      if (closing === 'asking') return;
      closing = 'asking';
      // Electron may emit the close again during \`close()\` or after it: either way that one passes.
      void flush().then(() => {
        closing = 'passing';
        close();
      });
    },
  };
}
