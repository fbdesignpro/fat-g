// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import type { DetachedConversation } from '@shared/contracts/conversation';
import { sessionDisplayName } from '@shared/contracts/sessions';
import { showDetached, useDetached } from '../chat/detached-store';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { detachedText, removeDetachedFailedText, removeDetachedText } from '../ui/detached-text';
import styles from './Sessions.module.css';

export const DETACHED_LIST_FAILED_TEXT = 'fat-g could not list them.';

/** What a confirmation is about: one chat, or all of them. */
type Removal = { readonly one: DetachedConversation } | { readonly all: number };

/**
 * The second dim row at the foot of the project column (M18, C31, C32), built as the row of sessions
 * without a project is: "n chats without a session", absent when there are none. The app state holds
 * their count and never a name, so the row asks for the list when it is opened: each chat by its
 * first prompt's first line, or by its date when it has none. Choosing one shows it in the chat
 * region, read-only (C35).
 *
 * Remove, of one or of all, asks first, saying how many chats go and that nothing of a provider's
 * does. It is not offered while records are refused: with no session listed every chat is without
 * one, and any of them may be a listed session's once the records are read.
 *
 * The list opens in the column, which scrolls: nothing here does.
 */
export function DetachedRow() {
  const count = useAppState((state) => state.snapshot?.conversations?.detached ?? 0);
  const removable = useAppState((state) => state.snapshot?.records?.status.kind !== 'refused');
  const shown = useDetached((state) => state.shown);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<readonly DetachedConversation[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<number | null>(null);
  /** Raised to ask for the list again: after a removal whose count the state may not show yet. */
  const [asked, setAsked] = useState(0);

  // Asked for when the row opens, and again whenever the count changes while it is open.
  useEffect(() => {
    if (!open || count === 0) return;
    let live = true;
    invoke('conversations:listDetached', null).then(
      (answer) => { if (live) { setList(answer); setListFailed(false); } },
      () => { if (live) setListFailed(true); },
    );
    return () => { live = false; };
  }, [open, count, asked]);

  if (count === 0 && removal === null) return null;

  const remove = async (): Promise<void> => {
    if (removal === null) return;
    const many = 'all' in removal ? removal.all : 1;
    setBusy(true);
    try {
      const answer = await invoke('conversations:removeDetached', 'all' in removal ? { all: true } : { ids: [removal.one.id] });
      setFailed(answer.status === 'saved' ? null : many);
      if (answer.status === 'saved') {
        // The chat shown went with them.
        if ('all' in removal || shown?.id === removal.one.id) showDetached(null);
        setAsked((current) => current + 1);
      }
    } catch {
      setFailed(many);
    }
    setBusy(false);
    setRemoval(null);
  };

  return (
    <>
      {count > 0 && (
        <div className={styles.orphans} data-detached-row="">
          <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
            <span>{detachedText(count)}</span>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <path d={open ? 'M5 9L12 16L19 9' : 'M9 5L16 12L9 19'} stroke="currentColor" strokeWidth="2.5" fill="none" />
            </svg>
          </button>
          {removable && (
            <button type="button" className={styles.more} onClick={() => setRemoval({ all: count })}>
              Remove all
            </button>
          )}
        </div>
      )}
      {count > 0 && open && list !== null && (
        <ul className={styles.group} aria-label="Chats without a session">
          {list.map((conversation) => {
            const name = sessionDisplayName(conversation);
            const selected = shown?.id === conversation.id;
            return (
              <li key={conversation.id} className={`${styles.capsule} ${styles.thin}`} data-detached-chat={conversation.id} data-selected={selected || undefined}>
                <button type="button" className={styles.thinSelect} aria-current={selected ? 'true' : undefined} onClick={() => showDetached(conversation)}>
                  <span className={styles.thinName}>{name}</span>
                </button>
                {removable && (
                  <button type="button" className={styles.more} aria-label={`Remove ${name}`} onClick={() => setRemoval({ one: conversation })}>
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {count > 0 && open && listFailed && (
        <p className={styles.problem} role="status">
          {DETACHED_LIST_FAILED_TEXT}
        </p>
      )}
      {failed !== null && (
        <p className={styles.problem} role="status">
          {removeDetachedFailedText(failed)}
        </p>
      )}
      <ConfirmDialog
        open={removal !== null}
        title={`Remove ${detachedText(removal === null ? count : 'all' in removal ? removal.all : 1)}?`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoval(null)}
      >
        {removal !== null && 'one' in removal && <p>{sessionDisplayName(removal.one)}</p>}
        <p>{removeDetachedText(removal === null ? count : 'all' in removal ? removal.all : 1)}</p>
      </ConfirmDialog>
    </>
  );
}
