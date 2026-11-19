// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type SyntheticEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import { type AddAvatarAnswer, isNewAvatarName, NEW_AVATAR_NAME_MAX } from '@shared/contracts/avatar-family';
import { type FamilyRef, type FamilyView, isMatchKey, type MatchEntry, matchView } from '@shared/contracts/avatars';
import type { CatalogProvider } from '@shared/contracts/catalog';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { invoke } from '../ipc/client';
import dialogStyles from '../ui/Dialog.module.css';
import type { PreparedImage } from './avatar-image';
import { newAvatarTakes } from './avatar-listing';
import { EDITOR_WORDS } from './family-editor-words';
import { keyOf, MatchEditor } from './MatchEditor';
import { PreparedAvatarPreview } from './PreparedAvatarPreview';
import styles from './Settings.module.css';

/** An image made ready for a new avatar, with the name of the file it came from. */
export interface AddedImage {
  readonly file: string;
  readonly prepared: Extract<PreparedImage, { readonly kind: 'prepared' }>;
}

/** What of an add's answer the editor shows itself: its file changed, it may not be written, or it is gone. */
export type AddRefusal = Extract<AddAvatarAnswer, { readonly kind: 'conflict' | 'locked' | 'missing' }>;

export interface AddAvatarDialogProps {
  /** The image to add; null while the popup is closed. */
  readonly image: AddedImage | null;
  readonly family: FamilyRef;
  /** The revision of the family's file the editor holds. */
  readonly revision: string | null;
  /** The family as the editor's draft makes it: what the new avatar's matches are searched with. */
  readonly shown: FamilyView;
  /** The names the family holds, folders and entries: a new one may be none of them, in any case. */
  readonly taken: readonly string[];
  readonly providers: readonly ProviderSnapshot[];
  readonly entries: readonly CatalogProvider[];
  readonly onAdded: (answer: Extract<AddAvatarAnswer, { readonly kind: 'added' }>, matches: readonly MatchEntry[]) => void;
  readonly onRefused: (answer: AddRefusal) => void;
  readonly onClose: () => void;
}

/** A name for the new avatar from its file's: its stem, with what a name may not hold made a hyphen; empty where none is left. */
export function suggestedName(file: string): string {
  const stem = file.replace(/\.[^.]*$/u, '');
  const cleaned = stem.replace(/[^\p{L}\p{N} ._()+-]+/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '');
  const cut = [...cleaned].slice(0, NEW_AVATAR_NAME_MAX).join('').replace(/[ .]+$/u, '');
  return isNewAvatarName(cut) ? cut : '';
}

/**
 * Add avatar (decision 0036): a modal popup over the family editor, with the portrait and the small
 * made of the image the user dropped or chose, the new avatar's name and its match entries. Add
 * avatar hands main both images and writes at once; the family's file changed, locked or gone is the
 * editor's to say, the rest is said here. Escape and Cancel close it, writing nothing.
 */
export function AddAvatarDialog(props: AddAvatarDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const titleId = useId();
  const open = props.image !== null;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // React passes `close` up its own tree: the editor around it must not hear of it.
  const onClose = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.stopPropagation();
    const previous = opener.current;
    opener.current = null;
    if (previous?.isConnected === true) previous.focus();
    if (open) props.onClose();
  };

  return (
    <dialog
      ref={dialog}
      className={`${dialogStyles.dialog} ${dialogStyles.narrow}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => { event.stopPropagation(); if (busyRef.current) event.preventDefault(); }}
      data-add-avatar=""
    >
      {props.image !== null && <AddAvatarForm key={props.image.file} {...props} image={props.image} titleId={titleId} busyRef={busyRef} onDone={() => dialog.current?.close()} />}
    </dialog>
  );
}

function AddAvatarForm({ image, family, revision, shown, taken, providers, entries, onAdded, onRefused, titleId, busyRef, onDone }: AddAvatarDialogProps & {
  readonly image: AddedImage;
  readonly titleId: string;
  readonly busyRef: { current: boolean };
  readonly onDone: () => void;
}) {
  const nameId = useId();
  const [name, setName] = useState(() => suggestedName(image.file));
  const [matches, setMatches] = useState<readonly MatchEntry[]>(() => {
    const first = suggestedName(image.file);
    return isMatchKey(first) ? [first] : [];
  });
  const [adding, setAdding] = useState(false);
  const [answer, setAnswer] = useState<'taken' | 'invalid' | 'failed' | null>(null);


  const folded = name.toLowerCase();
  const badName = name !== '' && !isNewAvatarName(name);
  const takenName = !badName && taken.some((other) => other.toLowerCase() === folded);
  const badPatterns = matches.some((entry) => !isMatchKey(keyOf(entry)));
  const providerName = (id: string): string => providers.find((provider) => provider.id === id)?.displayName ?? id;
  const views = matches.filter((entry) => isMatchKey(keyOf(entry))).map(matchView);
  const takes = entries.flatMap((entry) => entry.models.filter((model) => newAvatarTakes(shown, views, entry.id, model)).map((model) => `${model.name} (${providerName(entry.id)})`));
  const ready = isNewAvatarName(name) && !takenName && !badPatterns && !adding;
  const problem = badName ? EDITOR_WORDS.add.badName : takenName ? EDITOR_WORDS.add.takenName : null;

  const add = (): void => {
    if (!ready) return;
    setAdding(true);
    busyRef.current = true;
    setAnswer(null);
    const done = (): void => { setAdding(false); busyRef.current = false; };
    invoke('avatars:addAvatar', { ref: family, revision, name, matches: [...matches], portrait: image.prepared.portrait, small: image.prepared.small }).then(
      (result) => {
        done();
        if (result.kind === 'added') { onAdded(result, matches); onDone(); return; }
        if (result.kind === 'conflict' || result.kind === 'locked' || result.kind === 'missing') { onRefused(result); onDone(); return; }
        setAnswer(result.kind);
      },
      () => { done(); setAnswer('failed'); },
    );
  };

  return (
    <>
      <header className={dialogStyles.header}>
        <h2 id={titleId} className={dialogStyles.title}>{EDITOR_WORDS.add.title(family.family)}</h2>
      </header>
      <div className={`${dialogStyles.body} ${styles.addAvatarBody}`}>
        <PreparedAvatarPreview image={image} />
        <label className={styles.familyControl}>
          <span>{EDITOR_WORDS.add.name}</span>
          <input
            type="text"
            value={name}
            maxLength={NEW_AVATAR_NAME_MAX * 2}
            spellCheck={false}
            disabled={adding}
            aria-invalid={problem !== null || undefined}
            aria-describedby={problem === null ? undefined : nameId}
            onChange={(event) => { setName(event.target.value); setAnswer(null); }}
            data-added-name=""
          />
        </label>
        {problem !== null && <small id={nameId} className={`${styles.statusLine} ${styles.critical}`} data-name-problem="">{problem}</small>}
        <MatchEditor matches={matches} providers={providers} disabled={adding} takes={takes} onChange={setMatches} />
      </div>
      <footer className={dialogStyles.footer}>
        {answer !== null && <p className={styles.feedback} role="status" data-add-answer={answer}>{EDITOR_WORDS.add.answers[answer]}</p>}
        <button type="button" className={dialogStyles.button} disabled={adding} onClick={onDone}>{EDITOR_WORDS.cancel}</button>
        <button type="button" className={`${dialogStyles.button} ${dialogStyles.primary}`} disabled={!ready} onClick={add} data-confirm-add="">{adding ? EDITOR_WORDS.add.adding : EDITOR_WORDS.add.confirm}</button>
      </footer>
    </>
  );
}
