// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, useEffect, useId, useState } from 'react';
import { AVATAR_WORDS, type AvatarListing, type AvatarProblem, avatarProblemWords, type AvatarRootView, type FamilyRef, type FamilyView } from '@shared/contracts/avatars';
import type { CatalogProvider } from '@shared/contracts/catalog';
import { firstInstances } from '@shared/contracts/instances';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { invoke } from '../ipc/client';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { activeFamilyOf } from './avatar-listing';
import { AvatarFamilyPreview } from './AvatarFamilyPreview';
import { AvatarFamilyGuide } from './AvatarFamilyGuide';
import { CreateFamilyFromImage } from './CreateFamilyFromImage';
import { FamilyAssignmentDialog } from './FamilyAssignmentDialog';
import { FamilyEditorDialog } from './FamilyEditorDialog';
import { Section } from './Section';
import styles from './Settings.module.css';

/** The tab's words beyond the contract's (C36–C40). */
export const AVATARS_TAB_TEXT = {
  assignment: 'Provider Avatars',
  families: 'Avatar families',
  noFamily: 'No family',
  custom: 'Custom',
  chooseFamily: (provider: string, family: string): string => `${provider}: ${family}. Choose its family`,
  editFamily: (family: string): string => `Edit family ${family}`,
  openFamily: (family: string): string => `Open family ${family}`,
  problems: (count: number): string => (count === 1 ? '1 problem' : `${count} problems`),
  unread: 'fat-g could not list its avatars.',
  measuring: 'Listing…',
  opened: 'The avatars folder was opened.',
  notOpened: 'The avatars folder could not be opened.',
  rescanFailed: 'fat-g could not scan the avatars again.',
  noProviders: 'No providers are registered in this build.',
} as const;

const NO_PROVIDERS: readonly ProviderSnapshot[] = [];

/**
 * Settings' Avatars tab (decisions 0031, 0032): Provider Avatars has one row per provider, its name
 * beside its active family's preview, opening the family assignment popup; then the families
 * the scan found, the user's first, each a row of its avatars as capsules in its own style,
 * opening the family editor; with Rescan and Show avatars folder. It asks main for the listing when it
 * is shown, after a Rescan and after a family is saved; every drawn avatar follows by the app state.
 * The page holds no path: a problem names its file relative to its root.
 */
export function AvatarsSection() {
  const [listing, setListing] = useState<AvatarListing | null>(null);
  const [unread, setUnread] = useState(false);
  /** Raised after each Rescan and each save: the listing is asked for again. */
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [editing, setEditing] = useState<FamilyRef | null>(null);
  const snapshots = useAppState((state) => state.snapshot?.providers ?? NO_PROVIDERS);
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const active = usePrefs((state) => state.snapshot?.values.avatars.active);
  const providers = firstInstances(snapshots);
  /** Each provider's first account's models: what a family's avatars are shown with. */
  const entries = providers.flatMap((provider) => catalog?.providers.find((entry) => entry.id === provider.id) ?? []);

  useEffect(() => {
    let live = true;
    invoke('avatars:list', null).then(
      (answer) => { if (live) { setListing(answer); setUnread(false); } },
      () => { if (live) setUnread(true); },
    );
    return () => { live = false; };
  }, [asked]);

  const rescan = (): void => {
    setBusy(true);
    setFeedback(null);
    invoke('avatars:rescan', null).then(
      () => { setBusy(false); setAsked((current) => current + 1); },
      () => { setBusy(false); setFeedback(AVATARS_TAB_TEXT.rescanFailed); },
    );
  };
  // Main names the folder and makes it where it is missing (C40): the page names none.
  const showFolder = (): void => {
    setFeedback(null);
    invoke('shell:showDataFolder', { folder: 'avatars' }).then(() => setFeedback(AVATARS_TAB_TEXT.opened), () => setFeedback(AVATARS_TAB_TEXT.notOpened));
  };

  return (
    <Section section="avatars">
      <div className={styles.fields}>
        <section className={styles.avatarRoot} aria-labelledby="avatar-assignment-title" data-family-assignments="">
          <h4 id="avatar-assignment-title" className={styles.providerAvatarsTitle}>{AVATARS_TAB_TEXT.assignment}</h4>
          {providers.length === 0 ? (
            <p className={styles.muted}>{AVATARS_TAB_TEXT.noProviders}</p>
          ) : (
            <div className={styles.providerAvatarRows}>
              {providers.map((provider) => (
                <ProviderFamilyButton
                  key={provider.id}
                  provider={provider}
                  entry={entries.find((entry) => entry.id === provider.id)}
                  family={listing === null ? undefined : activeFamilyOf(listing, provider.id, active?.[provider.id])}
                  onOpen={() => setAssigning(provider.id)}
                  onEdit={setEditing}
                />
              ))}
            </div>
          )}
        </section>
        <section className={styles.avatarRoot} aria-labelledby="avatar-families-title" data-avatar-families="">
          <h4 id="avatar-families-title" className={styles.avatarRootTitle}>{AVATARS_TAB_TEXT.families}</h4>
          <CreateFamilyFromImage listing={listing} providers={providers} entries={entries} onCreated={(answer) => { setListing(answer.listing); setEditing(answer.ref); }} />
          <span className={styles.inlineActions}>
            <button type="button" disabled={busy} onClick={rescan}>{AVATAR_WORDS.rescan}</button>
            <button type="button" onClick={showFolder}>{AVATAR_WORDS.showFolder}</button>
            <AvatarFamilyGuide compact />
          </span>
          {feedback !== null && <p className={styles.feedback} role="status">{feedback}</p>}
          {listing === null ? (
            <p className={styles.muted}>{unread ? AVATARS_TAB_TEXT.unread : AVATARS_TAB_TEXT.measuring}</p>
          ) : (
            // The user's own families first, under their heading; then fat-g's own.
            [...listing.roots].sort((a, b) => Number(b.origin === 'user') - Number(a.origin === 'user')).map((root) => <RootPart key={root.origin} root={root} entries={entries} onEdit={setEditing} />)
          )}
        </section>
      </div>
      <FamilyAssignmentDialog providerId={assigning} listing={listing} onEditFamily={setEditing} onClose={() => setAssigning(null)} />
      <FamilyEditorDialog family={editing} listing={listing} onSaved={() => setAsked((current) => current + 1)} onCopied={(ref, updated) => { setListing(updated); setEditing(ref); }} onListed={setListing} onClose={() => setEditing(null)} />
    </Section>
  );
}

/** One provider per row, with its current family's preview opening the assignment dialog. */
function ProviderFamilyButton({ provider, entry, family, onOpen, onEdit }: {
  readonly provider: ProviderSnapshot;
  readonly entry: CatalogProvider | undefined;
  readonly family: FamilyView | undefined;
  readonly onOpen: () => void;
  readonly onEdit: (family: FamilyRef) => void;
}) {
  const lineId = useId();
  const name = family?.folder ?? AVATARS_TAB_TEXT.noFamily;
  return (
    <div className={styles.providerAvatarRow} style={entry === undefined ? undefined : { '--bar-color': entry.presentation.barColor } as CSSProperties}>
      <h5 className={styles.providerAvatarName}>{provider.displayName}</h5>
      {family === undefined ? <button
        type="button"
        className={styles.familyRow}
        aria-label={AVATARS_TAB_TEXT.chooseFamily(provider.displayName, name)}
        aria-haspopup="dialog"
        onClick={onOpen}
        data-family-provider={provider.id}
      >
        <span className={styles.avatarFamilyName} data-family-name="">{name}</span>
      </button> : (
        <AvatarFamilyPreview
          family={family} entries={entry === undefined ? [] : [entry]} lineId={lineId} providerId={provider.id}
          action={{ 'aria-label': AVATARS_TAB_TEXT.chooseFamily(provider.displayName, name), 'aria-haspopup': 'dialog', onClick: onOpen, 'data-family-provider': provider.id }}
          onEdit={() => onEdit({ origin: family.origin, family: family.folder })}
        />
      )}
    </div>
  );
}

/**
 * One root (C37) under its heading — Custom for the user's, Built-in for fat-g's own — its problems,
 * then its families by name. The user's with no family and no problem is not shown at all.
 */
function RootPart({ root, entries, onEdit }: {
  readonly root: AvatarRootView;
  readonly entries: readonly CatalogProvider[];
  readonly onEdit: (family: FamilyRef) => void;
}) {
  const headingId = useId();
  if (root.origin === 'user' && root.families.length === 0 && root.problems.length === 0) return null;
  const label = root.origin === 'built-in' ? AVATAR_WORDS.builtIn : AVATARS_TAB_TEXT.custom;
  return (
    <div className={styles.familyRows} aria-labelledby={headingId} role="group" data-avatar-root={root.origin}>
      <h5 id={headingId} className={styles.familyGroupTitle} data-family-group={root.origin}>{label}</h5>
      <Problems problems={root.problems} />
      {root.families.map((family) => <FamilyRow key={family.folder} family={family} entries={entries} onEdit={onEdit} />)}
    </div>
  );
}

/**
 * A family (C37, C38; decision 0032): a button of its name, its origin, author and licence, how many
 * problems it has and the first, and its avatars as capsules in its own style, each with the texts of
 * a model it suits and Medium's marks. Pressing it opens the family editor.
 */
function FamilyRow({ family, entries, onEdit }: {
  readonly family: FamilyView;
  readonly entries: readonly CatalogProvider[];
  readonly onEdit: (family: FamilyRef) => void;
}) {
  const lineId = useId();
  return (
    <AvatarFamilyPreview
      family={family} entries={entries} lineId={lineId}
      action={{ 'aria-label': AVATARS_TAB_TEXT.openFamily(family.folder), 'aria-haspopup': 'dialog', onClick: () => onEdit({ origin: family.origin, family: family.folder }), 'data-avatar-family': family.folder, 'data-origin': family.origin }}
      onEdit={() => onEdit({ origin: family.origin, family: family.folder })}
    />
  );
}

/** Problems, each naming its file relative to its root. */
function Problems({ problems }: { readonly problems: readonly AvatarProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className={styles.violations} data-avatar-problems="">
      {problems.map((problem, index) => <li key={`${index}:${problem.kind}:${problem.path}`} data-problem={problem.kind}>{avatarProblemWords(problem)}</li>)}
    </ul>
  );
}
