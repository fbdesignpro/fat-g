// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Folder lookups — real paths and the missing check alike — through one small limiter (M12, C85).
//
// A lookup on a drive that stops answering (a sleeping network share, an unplugged disk) holds one
// of Node's four file-system threads until the OS gives up, which can take minutes. The records and
// preferences files are written through the same threads, so at most two lookups run at a time and
// the other threads stay free. Each lookup has a deadline, counted from when it was asked: past it
// the asker hears "no answer" and moves on, while the call itself keeps its slot until it returns —
// the thread is still busy, whatever the asker was told.
import { realpath } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

export const LOOKUP_SLOTS = 2;
export const LOOKUP_DEADLINE_MS = 2000;

export interface LookupFs {
  /** `fs.realpath.native`: the path as the filesystem stores it, links followed. */
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

// Only the callback API has the native form, which asks the OS itself and so spells each folder the
// way its filesystem stores it.
const realpathNative = promisify(realpath.native);

export const nodeLookupFs: LookupFs = {
  realpath: (path) => realpathNative(path),
  stat: (path) => stat(path),
};

export type FolderState = 'present' | 'missing' | 'no-answer';

export interface Lookups {
  /** The real path, or null when the lookup failed or did not answer in time (C78 then applies). */
  realpath(path: string): Promise<string | null>;
  /** Whether a folder is there. `no-answer` leaves whatever was known before (C29). */
  folder(path: string): Promise<FolderState>;
}

export interface LookupOptions {
  readonly fs?: LookupFs;
  readonly slots?: number;
  readonly deadlineMs?: number;
}

type Outcome<T> = { readonly answered: true; readonly ok: true; readonly value: T } | { readonly answered: true; readonly ok: false; readonly error: unknown } | { readonly answered: false };

interface Pending {
  /** Settles when the call returns, or at once when every asker gave up before it started. */
  readonly done: Promise<Outcome<unknown>>;
  /** Askers still inside their deadline. */
  waiting: number;
}

export function createLookups(options: LookupOptions = {}): Lookups {
  const { fs = nodeLookupFs, slots = LOOKUP_SLOTS, deadlineMs = LOOKUP_DEADLINE_MS } = options;
  const pending = new Map<string, Pending>();
  const queue: (() => void)[] = [];
  let running = 0;

  const pump = (): void => {
    while (running < slots && queue.length > 0) queue.shift()?.();
  };

  /** One call per key at a time: a path asked twice shares its lookup. */
  function ask<T>(key: string, call: () => Promise<T>): Promise<Outcome<T>> {
    let entry = pending.get(key);
    if (entry === undefined) {
      let settle: (outcome: Outcome<unknown>) => void = () => undefined;
      const done = new Promise<Outcome<unknown>>((resolve) => {
        settle = resolve;
      });
      const created: Pending = { done, waiting: 0 };
      entry = created;
      pending.set(key, created);
      queue.push(() => {
        // Its turn came after every asker had given up: nobody needs it, so it takes no slot.
        if (created.waiting === 0) {
          pending.delete(key);
          settle({ answered: false });
          return;
        }
        running += 1;
        call().then(
          (value) => settle({ answered: true, ok: true, value }),
          (error: unknown) => settle({ answered: true, ok: false, error }),
        ).finally(() => {
          running -= 1;
          pending.delete(key);
          pump();
        });
      });
    }
    const shared = entry;
    shared.waiting += 1;
    return new Promise<Outcome<T>>((resolve) => {
      let answered = false;
      const timer = setTimeout(() => {
        if (answered) return;
        answered = true;
        shared.waiting -= 1;
        resolve({ answered: false });
      }, deadlineMs);
      void shared.done.then((outcome) => {
        if (answered) return;
        answered = true;
        clearTimeout(timer);
        shared.waiting -= 1;
        resolve(outcome as Outcome<T>);
      });
      pump();
    });
  }

  return {
    async realpath(path) {
      const outcome = await ask(`realpath\0${path}`, () => fs.realpath(path));
      return outcome.answered && outcome.ok ? outcome.value : null;
    },
    async folder(path) {
      const outcome = await ask(`stat\0${path}`, () => fs.stat(path));
      if (!outcome.answered) return 'no-answer';
      if (outcome.ok) return outcome.value.isDirectory() ? 'present' : 'missing';
      const code = typeof outcome.error === 'object' && outcome.error !== null && 'code' in outcome.error ? outcome.error.code : undefined;
      // Gone, or a file where the folder was. Any other answer — access denied, say — means
      // something is there (C28).
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'present';
    },
  };
}
