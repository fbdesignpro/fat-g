// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the conversation store's tests share: a scratch data folder, a store in it, and a look at
// the store's files behind its back. Not a test, and it imports no test library: the
// runtime-dependencies test reads this file as source.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STORE_FILE, storeFiles } from './format';
import { type ConversationStore, type ConversationStoreOptions, createConversationStore } from './store';

export const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface Scratch {
  readonly dir: string;
  readonly file: string;
  /** A store in the folder; closed with the scratch if the test did not close it. */
  open(options?: Partial<ConversationStoreOptions>): ConversationStore;
  /** A connection of the test's own, to look at or change what the store's API does not reach. */
  raw<T>(work: (db: DatabaseSync) => T): T;
  /** Each of the store's files that is there, with a hash of its bytes. */
  hashes(): Record<string, string>;
  sizes(): Record<string, number>;
  /** The files of the folder that hold `needle`, as bytes. */
  holding(needle: string): string[];
  dispose(): void;
}

export function scratch(): Scratch {
  const dir = mkdtempSync(path.join(tmpdir(), 'fatg-conversations-'));
  const file = path.join(dir, STORE_FILE);
  const stores: ConversationStore[] = [];
  let ids = 0;
  const present = (): string[] => storeFiles().filter((name) => existsSync(path.join(dir, name)));
  return {
    dir,
    file,
    open(options = {}) {
      // Ids a test can read: `id-1`, `id-2` … in the order the store made them.
      const store = createConversationStore({ dir, log: QUIET, newId: () => `id-${++ids}`, ...options });
      stores.push(store);
      return store;
    },
    raw(work) {
      const db = new DatabaseSync(file);
      try { return work(db); } finally { db.close(); }
    },
    hashes: () => Object.fromEntries(present().map((name) => [name, createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex')])),
    sizes: () => Object.fromEntries(present().map((name) => [name, statSync(path.join(dir, name)).size])),
    holding: (needle) => readdirSync(dir).sort().filter((name) => readFileSync(path.join(dir, name)).includes(needle)),
    dispose() {
      for (const store of stores) store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export const CONVERSATION = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
