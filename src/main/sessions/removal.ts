// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A removal, across the two stores (docs/planning/_archive/M18.md, Design 9; C21, C22, C30, C42, C62, C63):
// removing a session, a project or the sessions without a project removes their saved chats too,
// and a crash between the two writes must neither leave a chat behind nor bring one back.
//
//   1. mark the conversations `removing`, in one transaction
//   2. run the records write; if it fails or is refused, lift the marks and answer the failure
//   3. delete the marked conversations whole, then fold the log in and empty it (C62)
//
// A mark found later is a removal a crash cut short, and is finished in that same order: the
// session's record first, where it is still listed, then step 3. While the records cannot be read
// nothing of it is deleted — rows deleted then would leave a record that Try again lists again, and
// a history check would bring the removed chat back (C21).
//
// Nothing here reaches a provider (C22): removing local data never deletes its conversation.
import type { ConversationStore } from '../conversations/store';
import { errorKind } from '../storage/error-kind';

export type RemovalStore = Pick<ConversationStore, 'status' | 'markRemoving' | 'liftRemoving' | 'deleteRemoving' | 'removing'>;

export interface RemovalOptions {
  readonly store: RemovalStore;
  /** Kinds only: never an id's chat, a name or a path. */
  readonly log?: Pick<Console, 'warn' | 'error'>;
}

export type RemovalRefusal = { readonly status: 'refused'; readonly reason: 'conversations-refused' | 'storage-failed' };

export interface Removal {
  /**
   * Removes these sessions' chats with their records. `write` is the records write that removes
   * them, and `saved` says whether its answer means it landed. Answers the write's own answer, or
   * the refusal when the conversation store could not take the mark.
   */
  run<T>(ids: readonly string[], write: () => Promise<T>, saved: (answer: T) => boolean): Promise<T | RemovalRefusal>;
  /** Conversations with no record to remove: the detached cleanup (C32). Throws when the store could not do it. */
  detached(ids: readonly string[]): void;
  /**
   * Finishes the removals a crash cut short (C63). `listed` says whether a session's record is still
   * listed, and `removeRecord` removes it. Called only while the records can be read. A session
   * whose removal is under way is neither reconciled nor checked until it has settled; `settled` is
   * told then, for one whose record's write failed: it stays listed, with its chat.
   */
  finish(listed: (id: string) => boolean, removeRecord: (id: string) => Promise<boolean>, settled?: (id: string) => void): void;
  /** A removal of this session's chat is under way. */
  pending(id: string): boolean;
}

export function createRemoval({ store, log = console }: RemovalOptions): Removal {
  /** Late removals whose record's write has not answered yet. */
  const finishing = new Set<string>();

  function lift(ids: readonly string[]): void {
    try {
      store.liftRemoving(ids);
    } catch (error) {
      // Both writes failed together: the marks stay, and the removal is completed at the next launch.
      log.error(`[removal] a removal's marks could not be lifted (${errorKind(error)})`);
    }
  }

  function remove(ids: readonly string[]): void {
    try {
      store.deleteRemoving(ids);
    } catch (error) {
      // The marks stay: the next launch finishes it, and until then the chats are not shown.
      log.error(`[removal] removed sessions' chats could not be deleted yet (${errorKind(error)})`);
    }
  }

  return {
    async run<T>(ids: readonly string[], write: () => Promise<T>, saved: (answer: T) => boolean): Promise<T | RemovalRefusal> {
      // A removal that cannot reach its chats would leave them behind (C42).
      if (store.status().kind === 'refused') return { status: 'refused', reason: 'conversations-refused' };
      try {
        store.markRemoving(ids);
      } catch (error) {
        log.warn(`[removal] a removal could not be marked (${errorKind(error)})`);
        return { status: 'refused', reason: 'storage-failed' };
      }
      let answer: T;
      try {
        answer = await write();
      } catch (error) {
        lift(ids);
        throw error;
      }
      if (!saved(answer)) {
        lift(ids);
        return answer;
      }
      remove(ids);
      return answer;
    },

    detached(ids) {
      store.markRemoving(ids);
      store.deleteRemoving(ids);
    },

    finish(listed, removeRecord, settled) {
      let marked: readonly string[];
      try {
        marked = store.removing();
      } catch {
        return;
      }
      for (const id of marked) {
        if (finishing.has(id)) continue;
        if (!listed(id)) { remove([id]); continue; }
        // The record first, then the rows. A records write that fails there lifts the mark, and the
        // session stays listed with its chat.
        finishing.add(id);
        void removeRecord(id).then((removed) => removed, () => false).then((removed) => {
          finishing.delete(id);
          if (removed) remove([id]);
          else { lift([id]); settled?.(id); }
        });
      }
    },

    pending: (id) => finishing.has(id),
  };
}
