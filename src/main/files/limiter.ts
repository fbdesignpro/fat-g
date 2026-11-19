// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The read limiter (docs/planning/_archive/M19b.md, Design 7; C34): the reader's file-system calls — a stat,
// a read, a folder's listing — two at a time, with one deadline for a whole read, counted from when
// it was asked.
//
// Built as the lookups' limiter is (src/main/records/lookup.ts; M12, C85), and for its reason: a
// call on a drive that stops answering holds one of Node's four file-system threads until the OS
// gives up. It is a limiter of its own, so a drive that does not answer a read takes no slot from
// the roots' checks, and it has no deduplication by key: two reads of one file are two reads.
//
// Past its deadline a read hears "not answered" and moves on, while the call itself keeps its slot
// until it returns: the thread is still busy, whatever the asker was told.

export const READ_SLOTS = 2;
export const READ_DEADLINE_MS = 10_000;

export type Limited<T> =
  | { readonly answered: true; readonly ok: true; readonly value: T }
  | { readonly answered: true; readonly ok: false; readonly error: unknown }
  | { readonly answered: false };

/** One read's clock: every call the read makes shares its one deadline. */
export interface ReadClock {
  run<T>(call: () => Promise<T>): Promise<Limited<T>>;
  /** Whether the read's deadline has passed. */
  expired(): boolean;
}

export interface ReadLimiter {
  /** Starts a read's clock: its deadline is counted from here. */
  begin(): ReadClock;
}

export interface ReadLimiterOptions {
  readonly slots?: number;
  readonly deadlineMs?: number;
}

export function createReadLimiter(options: ReadLimiterOptions = {}): ReadLimiter {
  const { slots = READ_SLOTS, deadlineMs = READ_DEADLINE_MS } = options;
  const queue: (() => void)[] = [];
  let running = 0;

  const pump = (): void => {
    while (running < slots && queue.length > 0) queue.shift()?.();
  };

  return {
    begin() {
      const until = Date.now() + deadlineMs;
      return {
        expired: () => Date.now() >= until,
        run<T>(call: () => Promise<T>): Promise<Limited<T>> {
          return new Promise<Limited<T>>((resolve) => {
            let answered = false;
            const answer = (outcome: Limited<T>): void => {
              if (answered) return;
              answered = true;
              clearTimeout(timer);
              resolve(outcome);
            };
            const timer = setTimeout(() => answer({ answered: false }), Math.max(0, until - Date.now()));
            queue.push(() => {
              // Its turn came after its read had given up: nobody needs it, so it takes no slot.
              if (answered) return;
              running += 1;
              (async () => call())().then(
                (value) => answer({ answered: true, ok: true, value }),
                (error: unknown) => answer({ answered: true, ok: false, error }),
              ).finally(() => {
                running -= 1;
                pump();
              });
            });
            pump();
          });
        },
      };
    },
  };
}
