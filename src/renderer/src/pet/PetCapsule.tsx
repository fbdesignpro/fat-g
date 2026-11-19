// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CSSProperties } from 'react';
import type { PetSession, PetSize } from '@shared/contracts/pet';
import { planWaitShown, sessionLabel, workersText } from '@shared/contracts/sessions';
import { invoke } from '../ipc/client';
import { Avatar, useBarColor } from '../sessions/Avatar';
import { CapsuleStatus, capsuleStatusWords } from '../sessions/CapsuleStatus';
import styles from './Pet.module.css';

/**
 * A session on the Pet (decision 0010): one button, the avatar at its full height, the name and under
 * it the status bar the Main window's capsule draws. At `capsule` size it has that capsule's geometry,
 * the name on up to two lines; at `compact` the name takes one line beside a smaller avatar. A press
 * opens the session in the Main window, as a press on its capsule there would. No menu, flag, drag or
 * rename: those are the Main window's.
 *
 * Its accessible name is the session's name, then its state in the bar's words — so the attention is
 * never signalled by colour alone — then its worker count while it runs.
 */
export function PetCapsule({ session, size }: { readonly session: PetSession; readonly size: PetSize }) {
  const { record, summary, avatar } = session;
  const barColor = useBarColor(record.providerId);
  const name = sessionLabel(session);
  const words = capsuleStatusWords(summary);
  const working = summary.status === 'running' && summary.attention === null && planWaitShown(summary) === null && summary.activeWorkers > 0;
  return (
    <li className={styles.row} data-pet-session={record.id} style={barColor === undefined ? undefined : ({ '--bar-color': barColor } as CSSProperties)}>
      <button type="button" className={styles.capsule} aria-label={`${name}, ${working ? `${words}, ${workersText(summary.activeWorkers)}` : words}`} onClick={() => openSession(record.id)}>
        <Avatar providerId={record.providerId} avatar={avatar} size={size} effort={summary.effort} fast={record.speed !== null} />
        <span className={styles.body}>
          <span className={styles.name}>{name}</span>
          <CapsuleStatus summary={summary} providerId={record.providerId} />
        </span>
      </button>
    </li>
  );
}

/** Main brings the Main window forward and has its page open the session (`pet:open`). */
function openSession(id: string): void {
  // Nothing to show if it fails: the session is gone, or main is.
  invoke('pet:open', { id }).catch(() => undefined);
}
