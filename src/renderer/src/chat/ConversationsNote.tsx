// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { invoke } from '../ipc/client';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { COULD_NOT_MOVE_STORE, explain, type RefusalCause, startFreshText, unchangedText } from '../ui/refusal-text';

/** The classes of whoever shows the note: the chat area, or Settings. */
export interface NoteClasses {
  readonly note: string | undefined;
  readonly line?: string | undefined;
  readonly problem: string | undefined;
  readonly actions: string | undefined;
  readonly button?: string | undefined;
}

/**
 * What stands where a conversation would when fat-g refused its conversation store (M18, C33, C36):
 * the saved chats are unchanged, why the store was refused, and Start fresh, which moves the store's
 * files aside together and is never taken without a confirmation whose default is Cancel. Built as
 * the records note is (src/renderer/src/projects/RecordsNote.tsx), with the same words for the four
 * causes. There is no Try again: nothing reads the store a second time in one run.
 */
export function ConversationsNote({ cause, classes, onFresh }: {
  /** Null when the page was told the store is refused, and not why. */
  readonly cause: RefusalCause | null;
  readonly classes: NoteClasses;
  /** After Start fresh: where the old store was kept, or null when it turned out not to be refused. */
  readonly onFresh?: (keptAs: string | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const why = cause === null ? null : explain('conversations', cause);

  const startFresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const answer = await invoke('conversations:startFresh', null);
      setProblem(null);
      onFresh?.(answer.status === 'done' ? answer.keptAs : null);
    } catch {
      setProblem(COULD_NOT_MOVE_STORE);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <div className={classes.note} role="status" data-conversations-refused={cause ?? ''}>
        <p className={classes.line}>{unchangedText('conversations')}</p>
        {why !== null && (
          <p className={classes.line}>
            {why.cause} {why.remedy}
          </p>
        )}
        {problem !== null && <p className={classes.problem}>{problem}</p>}
        <div className={classes.actions}>
          <button type="button" className={classes.button} onClick={() => setConfirming(true)}>
            Start fresh…
          </button>
        </div>
      </div>
      <ConfirmDialog open={confirming} title="Start fresh?" confirmLabel="Start fresh" busy={busy} onConfirm={() => void startFresh()} onCancel={() => setConfirming(false)}>
        {why !== null && (
          <p>
            {why.cause} {why.remedy}
          </p>
        )}
        <p>{startFreshText('conversations')}</p>
      </ConfirmDialog>
    </>
  );
}
