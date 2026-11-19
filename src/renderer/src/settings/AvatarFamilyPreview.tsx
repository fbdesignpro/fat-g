// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ButtonHTMLAttributes } from 'react';
import type { FamilyView } from '@shared/contracts/avatars';
import { avatarProblemWords } from '@shared/contracts/avatars';
import type { CatalogProvider } from '@shared/contracts/catalog';
import { Avatar } from '../sessions/Avatar';
import { avatarsForDisplay, sampleLabel, styledOf } from './avatar-listing';
import styles from './Settings.module.css';

const SHOWN_EFFORT = 'medium';

/** Shared family card, with independent open/select and compact edit actions. */
export function AvatarFamilyPreview({ family, entries, lineId, providerId, displayName, action, onEdit, editName, selected, stripLabel }: {
  readonly family: FamilyView;
  readonly entries: readonly CatalogProvider[];
  readonly lineId: string;
  readonly providerId?: string;
  /** Assignment choices distinguish same-named roots and mark the provider's default family. */
  readonly displayName?: string;
  readonly action: ButtonHTMLAttributes<HTMLButtonElement> & { readonly [key: `data-${string}`]: string | undefined };
  readonly onEdit: () => void;
  readonly editName?: string;
  readonly selected?: boolean;
  readonly stripLabel?: string;
}) {
  // Its origin is its group's heading: the line says its author and licence.
  const credits = [family.author, family.licence].filter((part) => part !== null).join(' · ');
  const problems = [...family.problems, ...family.avatars.flatMap((view) => view.problems)];
  const first = problems[0];
  return (
    <div className={styles.familyRow} data-family-card="" data-selected={selected}>
      <span className={styles.familyRowHeading}>
        <button {...action} type="button" className={styles.familyOpen} aria-describedby={lineId} data-family-action="">
          <span className={styles.avatarFamilyName} data-family-name="">{displayName ?? family.folder}</span>
        </button>
        <button type="button" className={styles.familyEdit} aria-label={`Edit family ${editName ?? family.folder}`} aria-haspopup="dialog" onClick={onEdit}>Edit family</button>
      </span>
      <span className={styles.statusLine} id={lineId}>
        {credits}
        {problems.length > 0 && <span className={styles.critical}>{credits === '' ? '' : ' · '}{`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`}{first === undefined ? '' : `: ${avatarProblemWords(first)}`}</span>}
      </span>
      <span className={styles.familyStrip} role={stripLabel === undefined ? undefined : 'group'} aria-label={stripLabel} data-family-strip="" data-assigned-strip={selected === true ? '' : undefined}>
        {avatarsForDisplay(family).map((view) => (
          <span key={view.folder} className={styles.familyCapsule} title={view.folder} data-family-capsule={view.folder}>
            <Avatar providerId={providerId ?? family.defaultFor[0] ?? ''} avatar={styledOf(family, view, sampleLabel(family, view, entries))} size="capsule" effort={SHOWN_EFFORT} />
          </span>
        ))}
      </span>
    </div>
  );
}

