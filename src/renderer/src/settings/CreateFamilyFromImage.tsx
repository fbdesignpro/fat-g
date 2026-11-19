// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { type CreateFamilyAnswer, isNewAvatarName, isNewFamilyName, NEW_AVATAR_NAME_MAX } from '@shared/contracts/avatar-family';
import { type AvatarListing, isMatchKey, matchesModel, matchView, type MatchEntry } from '@shared/contracts/avatars';
import type { CatalogProvider } from '@shared/contracts/catalog';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { invoke } from '../ipc/client';
import dialogStyles from '../ui/Dialog.module.css';
import { type AddedImage, suggestedName } from './AddAvatarDialog';
import { prepareAvatarImage } from './avatar-image';
import { refusalWords } from './avatar-image-words';
import { AvatarDropZone } from './AvatarDropZone';
import { EDITOR_WORDS } from './family-editor-words';
import { keyOf, MatchEditor } from './MatchEditor';
import { PreparedAvatarPreview } from './PreparedAvatarPreview';
import { useSettingsDialog } from './settings-dialog';
import styles from './Settings.module.css';

type Created = Extract<CreateFamilyAnswer, { readonly kind: 'created' }>;
export const CREATE_FAMILY_WORDS = {
  drop: 'Drag an image here to start a new family, or press to browse',
  title: 'Create avatar family',
  confirm: 'Create family',
  creating: 'Creating…',
  familyName: 'Family name',
  avatarName: 'Avatar name',
  default: 'This image will be the family default, used whenever no other avatar matches. Add matches to also create a named avatar from it.',
  badName: 'Use letters, digits, spaces and . _ - ( ) +, starting with a letter or digit. No trailing space or dot, or reserved device names.',
  answers: {
    taken: 'A family with this name already exists. Choose another name.',
    invalid: 'fat-g could not use these images or names. Check them and try again.',
    unavailable: 'The avatars folder cannot be written. Check that it is accessible and is not a link.',
    failed: 'fat-g could not create the family. Try again.',
  },
} as const;

/** Start a family through the existing image preparation and drop/browse path. */
export function CreateFamilyFromImage({ listing, providers, entries, onCreated }: {
  readonly listing: AvatarListing | null;
  readonly providers: readonly ProviderSnapshot[];
  readonly entries: readonly CatalogProvider[];
  readonly onCreated: (answer: Created) => void;
}) {
  const [image, setImage] = useState<AddedImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = useRef(false);
  const drop = useRef<HTMLDivElement>(null);
  const restoreDrop = useRef(false);
  useLayoutEffect(() => {
    if (image === null && restoreDrop.current) {
      restoreDrop.current = false;
      drop.current?.querySelector<HTMLButtonElement>('[data-avatar-drop]')?.focus();
    }
  }, [image]);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const takeImage = (file: File): void => {
    if (pending.current || image !== null) return;
    pending.current = true;
    setPreparing(true);
    setProblem(null);
    prepareAvatarImage(file).then(
      (prepared) => {
        if (!live.current) return;
        pending.current = false;
        setPreparing(false);
        if (prepared.kind === 'prepared') setImage({ file: file.name, prepared });
        else setProblem(refusalWords(prepared));
      },
      () => {
        if (!live.current) return;
        pending.current = false;
        setPreparing(false);
        setProblem(EDITOR_WORDS.imageRefusals.unreadable);
      },
    );
  };
  return <>
    <div ref={drop}><AvatarDropZone label={CREATE_FAMILY_WORDS.drop} disabled={image !== null} preparing={preparing} onFile={takeImage} onProblem={setProblem} /></div>
    {problem !== null && <p className={styles.feedback} role="status">{problem}</p>}
    <CreateFamilyDialog image={image} listing={listing} providers={providers} entries={entries} onCreated={onCreated} onClose={(created) => { restoreDrop.current = !created; setImage(null); }} />
  </>;
}

function CreateFamilyDialog({ image, listing, providers, entries, onCreated, onClose }: {
  readonly image: AddedImage | null;
  readonly listing: AvatarListing | null;
  readonly providers: readonly ProviderSnapshot[];
  readonly entries: readonly CatalogProvider[];
  readonly onCreated: (answer: Created) => void;
  readonly onClose: (created: boolean) => void;
}) {
  const titleId = useId();
  const busyRef = useRef(false);
  const created = useRef<Created | null>(null);
  const { dialog, onDialogClose } = useSettingsDialog(image !== null, () => {
    const result = created.current;
    created.current = null;
    onClose(result !== null);
    if (result !== null) onCreated(result);
  }, 'input');
  return <dialog ref={dialog} className={`${dialogStyles.dialog} ${dialogStyles.narrow}`} aria-labelledby={titleId}
    onClose={onDialogClose} onCancel={(event) => { event.stopPropagation(); if (busyRef.current) event.preventDefault(); }} data-create-family="">
    {image !== null && <CreateFamilyForm key={image.file} image={image} listing={listing} providers={providers} entries={entries} titleId={titleId} busyRef={busyRef}
      onCancel={() => dialog.current?.close()} onCreated={(answer) => { created.current = answer; dialog.current?.close(); }} />}
  </dialog>;
}

function CreateFamilyForm({ image, listing, providers, entries, titleId, busyRef, onCancel, onCreated }: {
  readonly image: AddedImage;
  readonly listing: AvatarListing | null;
  readonly providers: readonly ProviderSnapshot[];
  readonly entries: readonly CatalogProvider[];
  readonly titleId: string;
  readonly busyRef: { current: boolean };
  readonly onCancel: () => void;
  readonly onCreated: (answer: Created) => void;
}) {
  const [name, setName] = useState(() => suggestedName(image.file));
  const [avatarName, setAvatarName] = useState(() => suggestedName(image.file));
  const [matches, setMatches] = useState<readonly MatchEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [answer, setAnswer] = useState<Exclude<CreateFamilyAnswer['kind'], 'created'> | null>(null);
  const taken = listing?.roots.some((root) => root.origin === 'user' && root.families.some((family) => family.folder.toLowerCase() === name.toLowerCase())) === true;
  const badName = name !== '' && !isNewFamilyName(name);
  const badAvatar = matches.length > 0 && avatarName !== '' && !isNewAvatarName(avatarName);
  const ready = isNewFamilyName(name) && !taken && !creating
    && (matches.length === 0 || isNewAvatarName(avatarName)) && matches.every((match) => isMatchKey(keyOf(match)));
  const views = matches.filter((match) => isMatchKey(keyOf(match))).map(matchView);
  const takes = entries.flatMap((entry) => entry.models.filter((model) => views.some((match) => matchesModel(match, entry.id, model))).map((model) => `${model.name} (${providers.find((provider) => provider.id === entry.id)?.displayName ?? entry.id})`));
  const create = (): void => {
    if (!ready || busyRef.current) return;
    busyRef.current = true;
    setCreating(true);
    setAnswer(null);
    invoke('avatars:createFamily', { name, avatar: matches.length === 0 ? null : { name: avatarName, matches: [...matches] }, portrait: image.prepared.portrait, small: image.prepared.small }).then(
      (result) => {
        busyRef.current = false;
        setCreating(false);
        if (result.kind === 'created') onCreated(result);
        else setAnswer(result.kind);
      },
      () => { busyRef.current = false; setCreating(false); setAnswer('failed'); },
    );
  };
  return <>
    <header className={dialogStyles.header}><h2 id={titleId} className={dialogStyles.title}>{CREATE_FAMILY_WORDS.title}</h2></header>
    <div className={`${dialogStyles.body} ${styles.addAvatarBody}`}>
      <PreparedAvatarPreview image={image} />
      <label className={styles.familyControl}><span>{CREATE_FAMILY_WORDS.familyName}</span>
        <input value={name} maxLength={NEW_AVATAR_NAME_MAX * 2} spellCheck={false} disabled={creating} aria-invalid={badName || taken || undefined}
          onChange={(event) => { setName(event.target.value); setAnswer(null); }} />
      </label>
      {badName && <p className={styles.feedback} role="status">{CREATE_FAMILY_WORDS.badName}</p>}
      {taken && <p className={styles.feedback} role="status">{CREATE_FAMILY_WORDS.answers.taken}</p>}
      <p className={styles.statusLine}>{CREATE_FAMILY_WORDS.default}</p>
      {matches.length > 0 && <label className={styles.familyControl}><span>{CREATE_FAMILY_WORDS.avatarName}</span>
        <input value={avatarName} maxLength={NEW_AVATAR_NAME_MAX * 2} spellCheck={false} disabled={creating} aria-invalid={badAvatar || undefined}
          onChange={(event) => setAvatarName(event.target.value)} />
      </label>}
      {badAvatar && <p className={styles.feedback} role="status">{EDITOR_WORDS.add.badName}</p>}
      <MatchEditor matches={matches} providers={providers} disabled={creating} takes={matches.length === 0 ? null : takes} onChange={setMatches} />
    </div>
    <footer className={dialogStyles.footer}>
      {answer !== null && <p className={styles.feedback} role="status">{CREATE_FAMILY_WORDS.answers[answer]}</p>}
      <button type="button" className={dialogStyles.button} disabled={creating} onClick={onCancel}>{EDITOR_WORDS.cancel}</button>
      <button type="button" className={`${dialogStyles.button} ${dialogStyles.primary}`} disabled={!ready} onClick={create}>{creating ? CREATE_FAMILY_WORDS.creating : CREATE_FAMILY_WORDS.confirm}</button>
    </footer>
  </>;
}
