// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useId, useState } from 'react';
import { CONVERSATIONS_FILE, type ConversationsStorage } from '@shared/contracts/conversation';
import { PLANS_FOLDER, type PlansStorage } from '@shared/contracts/plans';
import { ATTACHMENTS_FOLDER } from '@shared/contracts/attachments';
import { ConversationsNote, type NoteClasses } from '../chat/ConversationsNote';
import { showDetached } from '../chat/detached-store';
import { plansRemoved } from '../chat/plans-store';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { detachedText, removeDetachedFailedText, removeDetachedText } from '../ui/detached-text';
import { formatBytes } from '../ui/format';
import { Section } from './Section';
import styles from './Settings.module.css';

export const STORAGE_UNREAD_TEXT = 'fat-g could not measure its saved chats.';
export const SET_ASIDE_REFUSED_TEXT = 'fat-g could not remove them, and nothing was changed.';

/** How many set-aside stores stayed after a removal (C23): the others went. */
export function setAsideFailedText(failed: number): string {
  return failed === 1 ? 'fat-g could not remove 1 set-aside store: it is still in the data folder.' : `fat-g could not remove ${failed} set-aside stores: they are still in the data folder.`;
}

const NOTE_CLASSES: NoteClasses = { note: styles.note, line: styles.noteLine, problem: `${styles.noteLine} ${styles.critical}`, actions: styles.actions };

/** What a confirmation is about: the chats without a session, set-aside stores by name, or every plan (M22b, C21). */
type Confirming = { readonly kind: 'detached'; readonly count: number } | { readonly kind: 'set-aside'; readonly names: readonly string[] } | { readonly kind: 'plans'; readonly count: number };

/** The plans' row (M22b, C21, C75): how many, their size, and the folder they are in. */
export const PLANS_STORAGE_TEXT = {
  label: 'Plans',
  count: (count: number): string => (count === 1 ? '1 plan' : `${count} plans`),
  reviews: (count: number): string => (count === 1 ? '1 review' : `${count} reviews`),
  show: 'Show plans folder',
  removeAll: 'Remove all',
  removeTitle: (count: number): string => (count === 1 ? 'Remove the plan?' : `Remove all ${count} plans?`),
  removeText: 'fat-g deletes every plan, with all its versions and its reviews, from its plans folder. A decision that waits on one is cancelled first. The chats keep their lines, which say the plan was removed.',
  removeFailed: 'fat-g could not remove the plans, and nothing was changed.',
  removeWriting: 'A plan is still being written: remove them once that ends.',
  unread: 'fat-g could not measure its plans.',
} as const;

/** The images' row (M23, C12): how many and their size, measured when the tab is shown; nothing here removes them, since they go with their sessions. */
export const ATTACHMENTS_STORAGE_TEXT = {
  label: 'Images',
  count: (count: number): string => (count === 1 ? '1 image' : `${count} images`),
} as const;

/**
 * Settings' Storage section (docs/planning/_archive/M18.md, Design 9; C23, C32, C41): what fat-g keeps of
 * conversations on disk, one row a thing — the store's size; the chats no listed session has, with
 * their count, their text's size and Remove; each store that Start fresh set aside, by name, with its
 * size and Remove; and Show data folder. It asks main for the sizes when it shows and after each
 * action, and never holds a chat's text or name.
 *
 * Every removal asks first: of the chats, saying how many go; of set-aside stores, naming the files.
 * The chats' Remove is not offered while records are refused (C32). A failure names what could not
 * be done, and leaves the rest as it is. While the store itself is refused, the note says why and
 * offers Start fresh (C33).
 */
export function StorageSection() {
  const conversations = useAppState((state) => state.snapshot?.conversations);
  const recordsRefused = useAppState((state) => state.snapshot?.records?.status.kind === 'refused');
  const [storage, setStorage] = useState<ConversationsStorage | null>(null);
  const [unread, setUnread] = useState(false);
  /** Raised after each action: the sizes are asked for again. */
  const [asked, setAsked] = useState(0);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  // After Start fresh, where the old store went — until Settings closes.
  const [keptAs, setKeptAs] = useState<string | null>(null);
  const statusKind = conversations?.status.kind;
  const detachedCount = conversations?.detached;
  const [plans, setPlans] = useState<PlansStorage | 'unread' | null>(null);

  useEffect(() => {
    let live = true;
    invoke('conversations:storage', null).then(
      (answer) => { if (live) { setStorage(answer); setUnread(false); } },
      () => { if (live) setUnread(true); },
    );
    return () => { live = false; };
  }, [asked, statusKind, detachedCount]);

  // The plans' count and size (M22b, C21, C75): main's registry, read from the plan store.
  useEffect(() => {
    let live = true;
    invoke('plans:storage', null).then((answer) => { if (live) setPlans(answer); }, () => { if (live) setPlans('unread'); });
    return () => { live = false; };
  }, [asked]);

  const status = storage?.status ?? conversations?.status;
  const detached = storage?.detached ?? { count: 0, textUnits: 0 };
  const setAside = storage?.setAside ?? [];

  const act = async (work: () => Promise<string | null>, failure: string): Promise<void> => {
    setBusy(true);
    setFeedback(null);
    try {
      setFeedback(await work());
    } catch {
      setFeedback(failure);
    }
    setBusy(false);
    setConfirming(null);
    setAsked((current) => current + 1);
  };

  const confirm = (): void => {
    if (confirming === null) return;
    if (confirming.kind === 'plans') {
      void act(async () => {
        const answer = await invoke('plans:remove', { all: true });
        // The chat's lines and the plans' tabs read their plans again: each now says it was removed.
        plansRemoved();
        if (answer.status === 'removed') return null;
        return answer.reason === 'writing' ? PLANS_STORAGE_TEXT.removeWriting : PLANS_STORAGE_TEXT.removeFailed;
      }, PLANS_STORAGE_TEXT.removeFailed);
      return;
    }
    if (confirming.kind === 'detached') {
      void act(async () => {
        const answer = await invoke('conversations:removeDetached', { all: true });
        if (answer.status !== 'saved') return removeDetachedFailedText(confirming.count);
        // One of them may be the chat the chat region shows.
        showDetached(null);
        return null;
      }, removeDetachedFailedText(confirming.count));
    } else {
      void act(async () => {
        // By name, also for all of them: exactly the stores the confirmation named go.
        const answer = await invoke('conversations:removeSetAside', { names: [...confirming.names] });
        if (answer.status !== 'saved') return SET_ASIDE_REFUSED_TEXT;
        return answer.failed > 0 ? setAsideFailedText(answer.failed) : null;
      }, SET_ASIDE_REFUSED_TEXT);
    }
  };

  const showFolder = (): void => {
    setFeedback(null);
    invoke('shell:showDataFolder', null).then(() => setFeedback('The data folder was opened.'), () => setFeedback('The data folder could not be opened.'));
  };
  // Main names the plans' folder too (M22b, C75): the page names none.
  const showPlans = (): void => {
    setFeedback(null);
    invoke('shell:showDataFolder', { folder: 'plans' }).then(() => setFeedback('The plans folder was opened.'), () => setFeedback('The plans folder could not be opened.'));
  };

  return (
    <Section section="storage">
      <div className={styles.compactPanel}>
        {status?.kind === 'refused' && (
          <ConversationsNote cause={status.cause} classes={NOTE_CLASSES} onFresh={(kept) => { setKeptAs(kept); setAsked((current) => current + 1); }} />
        )}
        {keptAs !== null && (
          <p className={styles.note} role="status">
            Your old saved chats were kept as <span className={styles.path}>{keptAs}</span>
          </p>
        )}
        <div className={styles.storageSections}>
          <StorageGroup kind="store" title="Saved chats">
            <p className={styles.muted}><span className={styles.path}>{CONVERSATIONS_FILE}</span> and the files beside it</p>
            <p>Size: {storage === null ? (unread ? 'Size unknown' : 'Measuring…') : storage.bytes === null ? 'Size unknown' : formatBytes(storage.bytes)}</p>
            <span className={styles.inlineActions}>
              <button type="button" onClick={showFolder}>Show data folder</button>
            </span>
          </StorageGroup>
          <StorageGroup kind="attachments" title={ATTACHMENTS_STORAGE_TEXT.label}>
            <p className={styles.muted}><span className={styles.path}>{ATTACHMENTS_FOLDER}</span> in the data folder</p>
            {storage?.attachments != null && <p>{ATTACHMENTS_STORAGE_TEXT.count(storage.attachments.count)}</p>}
            <p>Size: {storage === null ? (unread ? 'Size unknown' : 'Measuring…') : storage.attachments === null ? 'Size unknown' : formatBytes(storage.attachments.bytes)}</p>
          </StorageGroup>
          <StorageGroup kind="plans" title={PLANS_STORAGE_TEXT.label}>
            <p className={styles.muted}><span className={styles.path}>{PLANS_FOLDER}</span> in the data folder</p>
            {plans !== null && plans !== 'unread' && <>
              <p>{PLANS_STORAGE_TEXT.count(plans.count)}</p>
              <p>{PLANS_STORAGE_TEXT.reviews(plans.reviews ?? 0)}</p>
            </>}
            <p>Size: {plans === null ? 'Measuring…' : plans === 'unread' ? 'Size unknown' : formatBytes(plans.bytes)}</p>
            <span className={styles.inlineActions}>
              <button type="button" onClick={showPlans}>{PLANS_STORAGE_TEXT.show}</button>
              {plans !== null && plans !== 'unread' && plans.count > 0 && !recordsRefused && status?.kind !== 'refused' && (
                <button type="button" disabled={busy} onClick={() => setConfirming({ kind: 'plans', count: plans.count })}>{PLANS_STORAGE_TEXT.removeAll}</button>
              )}
            </span>
          </StorageGroup>
          {detached.count > 0 && (
            <StorageGroup kind="detached" title="Chats without a session">
              <p>{detachedText(detached.count)}</p>
              <p>{new Intl.NumberFormat().format(detached.textUnits)} characters of text</p>
              {!recordsRefused && status?.kind !== 'refused' && (
                <span className={styles.inlineActions}>
                  <button type="button" disabled={busy} onClick={() => setConfirming({ kind: 'detached', count: detached.count })}>Remove</button>
                </span>
              )}
            </StorageGroup>
          )}
          {setAside.length > 0 && (
            <StorageGroup kind="set-aside-group" title="Set-aside stores">
              {setAside.map((store) => (
                <div key={store.name} className={styles.storageEntry} data-storage-row="set-aside">
                  <p className={styles.path}>{store.name}</p>
                  <p>Size: {formatBytes(store.bytes)}</p>
                  <span className={styles.inlineActions}>
                    <button type="button" disabled={busy} aria-label={`Remove ${store.name}`} onClick={() => setConfirming({ kind: 'set-aside', names: [store.name] })}>Remove</button>
                  </span>
                </div>
              ))}
              {setAside.length > 1 && (
                <div className={styles.storageEntry} data-storage-row="set-aside-all">
                  <p>{setAside.length} set-aside stores</p>
                  <p>Total size: {formatBytes(setAside.reduce((sum, store) => sum + store.bytes, 0))}</p>
                  <span className={styles.inlineActions}>
                    <button type="button" disabled={busy} onClick={() => setConfirming({ kind: 'set-aside', names: setAside.map((store) => store.name) })}>Remove all</button>
                  </span>
                </div>
              )}
            </StorageGroup>
          )}
        </div>
        {unread && <p className={styles.fieldProblem} role="status">{STORAGE_UNREAD_TEXT}</p>}
        {plans === 'unread' && <p className={styles.fieldProblem} role="status">{PLANS_STORAGE_TEXT.unread}</p>}
        {feedback !== null && <p className={styles.muted} role="status">{feedback}</p>}
      </div>
      <ConfirmDialog
        open={confirming !== null}
        title={confirming === null ? 'Remove?' : confirming.kind === 'plans' ? PLANS_STORAGE_TEXT.removeTitle(confirming.count) : confirming.kind === 'detached' ? `Remove ${detachedText(confirming.count)}?` : confirming.names.length === 1 ? 'Remove this set-aside store?' : `Remove ${confirming.names.length} set-aside stores?`}
        confirmLabel="Remove"
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setConfirming(null)}
      >
        {confirming?.kind === 'plans' && <p>{PLANS_STORAGE_TEXT.removeText}</p>}
        {confirming?.kind === 'detached' && <p>{removeDetachedText(confirming.count)}</p>}
        {confirming?.kind === 'set-aside' && (
          <>
            <p>fat-g deletes {confirming.names.length === 1 ? 'this file' : 'these files'} from its data folder, with the -wal and -shm files SQLite kept beside {confirming.names.length === 1 ? 'it' : 'each'} and the images set aside with {confirming.names.length === 1 ? 'it' : 'them'}:</p>
            {confirming.names.map((name) => (
              <p key={name} className={styles.path}>{name}</p>
            ))}
            <p>The chats in {confirming.names.length === 1 ? 'it' : 'them'} cannot be brought back. No other file is touched.</p>
          </>
        )}
      </ConfirmDialog>
    </Section>
  );
}

/** A Storage category: its heading, individual facts, and an action row when it has actions. */
function StorageGroup({ kind, title, children }: { readonly kind: string; readonly title: string; readonly children: ReactNode }) {
  const titleId = useId();
  return (
    <section className={styles.storageGroup} aria-labelledby={titleId} data-storage-row={kind}>
      <h4 id={titleId} className={styles.storageTitle}>{title}</h4>
      {children}
    </section>
  );
}
