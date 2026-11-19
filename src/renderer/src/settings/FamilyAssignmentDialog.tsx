// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId, useState } from 'react';
import { type ActiveFamilies, type AvatarListing, type FamilyRef } from '@shared/contracts/avatars';
import { firstInstances } from '@shared/contracts/instances';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { CloseIcon } from '../control-bar/icons';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import dialogStyles from '../ui/Dialog.module.css';
import { AvatarFamilyPreview } from './AvatarFamilyPreview';
import { AvatarOverridesDialog } from './AvatarOverridesDialog';
import { ASSIGNMENT_WORDS } from './avatar-assignment-words';
import { activeFamilyOf, defaultFamilyOf, familyKeyOf, twinFamily, usableFamilies } from './avatar-listing';
import { useSettingsDialog } from './settings-dialog';
import styles from './Settings.module.css';

const NO_PROVIDERS: readonly ProviderSnapshot[] = [];
const NO_ACTIVE: ActiveFamilies = {};

export interface FamilyAssignmentDialogProps {
  readonly providerId: string | null;
  readonly listing: AvatarListing | null;
  readonly onEditFamily: (family: FamilyRef) => void;
  readonly onClose: () => void;
}

/** Select one eligible family; the model-specific override workflow opens in a dialog of its own. */
export function FamilyAssignmentDialog({ providerId, listing, onEditFamily, onClose }: FamilyAssignmentDialogProps) {
  const titleId = useId();
  const { dialog, onDialogClose } = useSettingsDialog(providerId !== null, onClose);
  const snapshots = useAppState((state) => state.snapshot?.providers ?? NO_PROVIDERS);
  const provider = providerId === null ? undefined : firstInstances(snapshots).find((candidate) => candidate.id === providerId);
  return (
    <dialog ref={dialog} className={dialogStyles.dialog} aria-labelledby={titleId} onClose={onDialogClose} data-family-assignment={providerId ?? undefined}>
      {provider !== undefined && <>
        <header className={dialogStyles.header}>
          <h2 id={titleId} className={styles.familyAssignmentTitle}>{ASSIGNMENT_WORDS.title(provider.displayName)}</h2>
          <button type="button" className={dialogStyles.closeButton} aria-label={ASSIGNMENT_WORDS.close} onClick={() => dialog.current?.close()}><CloseIcon /></button>
        </header>
        <div className={dialogStyles.body}>
          <Assignment provider={provider} listing={listing} onEditFamily={onEditFamily} />
        </div>
      </>}
    </dialog>
  );
}

function Assignment({ provider, listing, onEditFamily }: {
  readonly provider: ProviderSnapshot;
  readonly listing: AvatarListing | null;
  readonly onEditFamily: (family: FamilyRef) => void;
}) {
  const prefs = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const [failed, setFailed] = useState(false);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const baseId = useId();
  const active = prefs?.values.avatars.active ?? NO_ACTIVE;
  const entries = catalog?.providers.filter((entry) => entry.id === provider.id) ?? [];
  const families = listing === null ? [] : usableFamilies(listing, provider.id);
  const fallback = listing === null ? undefined : defaultFamilyOf(listing, provider.id);
  const current = listing === null ? undefined : activeFamilyOf(listing, provider.id, active[provider.id]);
  const disabled = prefs === null || prefs.status.kind === 'read-only' || saving;

  const choose = (family: (typeof families)[number]): void => {
    const reference = family === fallback ? null : { origin: family.origin, family: family.folder };
    setFailed(false);
    void patchPrefs({ avatars: { active: { [provider.id]: reference } } }).then(() => {
      const { snapshot, error } = usePrefs.getState();
      const saved = snapshot?.values.avatars.active[provider.id] ?? null;
      if (error !== null || (reference === null ? saved !== null : saved?.origin !== reference.origin || saved.family !== reference.family)) setFailed(true);
    });
  };

  return (
    <section className={styles.assignmentModels} data-avatar-assignments={provider.id}>
      <div className={styles.familyRows} role="group" aria-label={ASSIGNMENT_WORDS.family}>
        {families.map((family, index) => {
          const selected = family === current;
          const name = listing !== null && twinFamily(listing, family.folder)
            ? `${family.folder} ${family.origin === 'built-in' ? ASSIGNMENT_WORDS.builtIn : ASSIGNMENT_WORDS.yours}` : family.folder;
          const descriptionId = `${baseId}-family-${index}`;
          return (
            <AvatarFamilyPreview
              key={familyKeyOf(family)} family={family} entries={entries} lineId={descriptionId} providerId={provider.id}
              displayName={family === fallback ? ASSIGNMENT_WORDS.defaultFamily(name) : name}
              editName={name} selected={selected} stripLabel={ASSIGNMENT_WORDS.strip(family.folder)}
              action={{ 'aria-label': family === fallback ? ASSIGNMENT_WORDS.defaultFamily(name) : name, 'aria-pressed': selected, disabled, onClick: () => choose(family), 'data-family-choice': familyKeyOf(family) }}
              onEdit={() => onEditFamily({ origin: family.origin, family: family.folder })}
            />
          );
        })}
        {families.length === 0 && <p className={styles.muted}>{listing === null ? 'Listing families...' : 'No eligible avatar families are available.'}</p>}
      </div>
      {failed && <p className={styles.feedback} role="status">{ASSIGNMENT_WORDS.saveFailed}</p>}
      <span className={styles.inlineActions}>
        <button type="button" aria-haspopup="dialog" onClick={() => setOverridesOpen(true)}>{ASSIGNMENT_WORDS.overrideTitle}</button>
      </span>
      <AvatarOverridesDialog provider={overridesOpen ? provider : null} listing={listing} onClose={() => setOverridesOpen(false)} />
    </section>
  );
}
