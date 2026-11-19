// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { REMOVE_CHAT_TEXT } from '@shared/contracts/chat';
import { invoke } from '../ipc/client';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import styles from './Sessions.module.css';

export function orphanText(count: number): string {
  return count === 1 ? '1 session without a project' : `${count} sessions without a project`;
}

/**
 * The dim row at the foot of the project column (M14, C107): session entries in the records file
 * that no project's removal reaches. They hold names and folders, and the file should keep nothing
 * the app never shows and cannot delete. Its only action is Remove, after a confirmation naming how
 * many; absent when there are none.
 *
 * Their saved chats go with them (M18, C21), so Remove is not offered while the conversation store
 * is refused (C42): the row then only counts them.
 */
export function OrphanRow({ count, removable = true }: { readonly count: number; readonly removable?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (count === 0 && !confirming) return null;

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      setFailed((await invoke('sessions:removeOrphans', null)).status !== 'saved');
    } catch {
      setFailed(true);
    }
    setBusy(false);
    setConfirming(false);
  };

  return (
    <>
      {count > 0 && (
        <div className={styles.orphans} data-orphan-row="">
          <span>{orphanText(count)}</span>
          {removable && (
            <button type="button" className={styles.more} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      )}
      {failed && (
        <p className={styles.problem} role="status">
          fat-g could not remove them, and nothing was changed.
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Remove ${orphanText(count)}?`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirming(false)}
      >
        <p>
          Your projects file holds {count === 1 ? 'a session whose project is' : `${count} sessions whose projects are`} no longer in it, so fat-g shows {count === 1 ? 'it' : 'them'} nowhere. fat-g forgets{' '}
          {count === 1 ? 'it' : 'them'}; nothing in the providers’ history is touched.
        </p>
        <p>{REMOVE_CHAT_TEXT.orphans}</p>
      </ConfirmDialog>
    </>
  );
}
