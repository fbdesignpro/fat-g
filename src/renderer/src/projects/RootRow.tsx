// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId, useState } from 'react';
import type { RootRelation, TrustAnswer } from '@shared/contracts/projects';
import styles from './ProjectDialog.module.css';

/** The question of C30 and C31, word for word in every root's row. */
export const TRUST_QUESTION = 'Trust this folder?';
export const TRUST_EXPLANATION =
  'Trusting it lets the CLIs load the settings committed in it. Those settings can run commands, such as hooks and MCP servers, as soon as a session starts, before any prompt.';

/**
 * Why a root is refused for an added account's folder (M14b, C58), in words: `name` is the account
 * by its provider and the user's label. Its CLI keeps the account's login there.
 */
export function accountText(account: { readonly relation: RootRelation }, name: string): string {
  switch (account.relation) {
    case 'same':
      return `This is the folder of ${name}, where its CLI keeps that account’s login. Choose another folder.`;
    case 'inside':
      return `This folder is inside the folder of ${name}, where its CLI keeps that account’s login. Choose another folder.`;
    case 'around':
      return `This folder contains the folder of ${name}, where its CLI keeps that account’s login. Choose another folder.`;
  }
}

/** How a later root stands to an earlier one, beside the later one (C26). */
export function relationText(relation: RootRelation, other: string): string {
  switch (relation) {
    case 'same':
      return `Same folder as ${other}`;
    case 'inside':
      return `Inside ${other}`;
    case 'around':
      return `Contains ${other}`;
  }
}

export interface RootRowProps {
  readonly path: string;
  readonly trust: TrustAnswer | null;
  /** The folder's last check found nothing there (C28). */
  readonly missing: boolean;
  /** Why this root cannot be saved, when it cannot: an overlap, or a trust question not answered. */
  readonly faults: readonly string[];
  readonly faultId: string;
  readonly onTrust: (answer: TrustAnswer) => void;
  readonly onRemove: () => void;
  readonly onOpen: () => Promise<void>;
}

/**
 * One root in the project dialog: its path, whether its folder is missing, the trust question, and
 * Open folder and Remove (C22, C28, C30–C33). Answering "Don't trust" keeps the root, marked "Not trusted"; M15 and
 * M16 start no session in it (C32).
 */
export function RootRow({ path, trust, missing, faults, faultId, onTrust, onRemove, onOpen }: RootRowProps) {
  const name = useId();
  const explanation = useId();
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const open = (): void => {
    setOpening(true);
    setOpenFailed(false);
    onOpen().then(
      () => setOpening(false),
      () => { setOpening(false); setOpenFailed(true); },
    );
  };
  return (
    <li className={styles.root}>
      <div className={styles.rootLine}>
        <span className={styles.path}>{path}</span>
        {missing && <span className={styles.flag}>Folder not found</span>}
        {trust === 'not-trusted' && <span className={styles.flag}>Not trusted</span>}
        <button type="button" className={styles.smallButton} aria-label={`Open folder ${path}`} disabled={opening} aria-busy={opening || undefined} onClick={open}>
          Open folder
        </button>
        <button type="button" className={styles.smallButton} aria-label={`Remove ${path}`} onClick={onRemove}>
          Remove
        </button>
      </div>
      {openFailed && <p className={styles.fault} role="status">fat-g could not open this folder.</p>}
      <fieldset
        className={styles.trust}
        aria-label={`${TRUST_QUESTION} ${path}`}
        aria-describedby={faults.length > 0 ? `${explanation} ${faultId}` : explanation}
        aria-invalid={faults.length > 0 || undefined}
        data-fault-target=""
      >
        <legend className={styles.question}>{TRUST_QUESTION}</legend>
        <p id={explanation} className={styles.explanation}>
          {TRUST_EXPLANATION}
        </p>
        <label className={styles.choice}>
          <input type="radio" name={name} checked={trust === 'trusted'} onChange={() => onTrust('trusted')} />
          Trust
        </label>
        <label className={styles.choice}>
          <input type="radio" name={name} checked={trust === 'not-trusted'} onChange={() => onTrust('not-trusted')} />
          Don’t trust
        </label>
      </fieldset>
      {faults.length > 0 && (
        <p id={faultId} className={styles.fault}>
          {faults.join(' ')}
        </p>
      )}
    </li>
  );
}
