// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { SESSION_FLAGS, type SessionFlag, type SessionFlags } from '@shared/contracts/session-flags';
import styles from './Sessions.module.css';

/** A flag's words: its item in the capsule's menu, and what the capsule's accessible name adds for it. */
export const FLAG_WORDS: Readonly<Record<SessionFlag, { readonly item: string; readonly spoken: string }>> = {
  starred: { item: 'Starred', spoken: 'starred' },
  toDo: { item: 'To do', spoken: 'to do' },
  toVerify: { item: 'To verify', spoken: 'to verify' },
};

/** The header over the flags in a capsule's menu. */
export const FLAGS_HEADER = 'Tags';

/** The flags a session has set, in their own order. */
export function setFlags(record: SessionFlags): SessionFlag[] {
  return SESSION_FLAGS.filter((flag) => record[flag]);
}

/** What a capsule's accessible name says of its flags: ", starred, to do", or nothing. */
export function spokenFlags(record: SessionFlags): string {
  return setFlags(record).map((flag) => `, ${FLAG_WORDS[flag].spoken}`).join('');
}

/**
 * A flag's mark, drawn in the current colour: the star; two rows of a box and a line, as a list of
 * things to do; an Erlenmeyer flask with liquid in it, for a result still to be tested and verified
 * (the maintainer).
 */
export function FlagIcon({ flag, size = 14 }: { readonly flag: SessionFlag; readonly size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {flag === 'starred' && <path d="M12 3L14.8 9.2L21.5 9.9L16.5 14.4L17.9 21L12 17.6L6.1 21L7.5 14.4L2.5 9.9L9.2 9.2Z" fill="currentColor" />}
      {flag === 'toDo' && <path d="M3 4H9V10H3ZM12 7H21M3 14H9V20H3ZM12 17H21" stroke="currentColor" strokeWidth="2" fill="none" />}
      {flag === 'toVerify' && (
        <>
          <path d="M8.5 3H15.5M10 3V9L4.2 19.2A1.2 1.2 0 0 0 5.2 21H18.8A1.2 1.2 0 0 0 19.8 19.2L14 9V3" stroke="currentColor" strokeWidth="2" fill="none" />
          <path d="M6.6 15.5H17.4L19.4 19.1A1 1 0 0 1 18.6 20.4H5.4A1 1 0 0 1 4.6 19.1Z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

/**
 * A flag's mark as a capsule and its menu show it (the maintainer): its icon in the
 * ground's colour on a small square of the text's. Never read out: what holds it says the flag in words.
 */
export function FlagMark({ flag }: { readonly flag: SessionFlag }) {
  return (
    <span className={styles.flag} data-flag-mark={flag} aria-hidden="true">
      <FlagIcon flag={flag} size={12} />
    </span>
  );
}

/**
 * The flags a session has set, as marks: never a control, and never read out — the capsule's
 * accessible name says them (`spokenFlags`). A press on them is the capsule's.
 */
export function FlagMarks({ record }: { readonly record: SessionFlags }) {
  const set = setFlags(record);
  if (set.length === 0) return null;
  return (
    <span className={styles.flags} aria-hidden="true" data-flags={set.join(' ')}>
      {set.map((flag) => <FlagMark key={flag} flag={flag} />)}
    </span>
  );
}
