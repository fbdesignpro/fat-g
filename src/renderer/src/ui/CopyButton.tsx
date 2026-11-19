// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from 'react';
import announcer from './Announcer.module.css';
import styles from './CopyButton.module.css';
import { NameTip, useNameTip } from './Tooltip';

/** What the button reads, at rest and for a moment after a press. */
export const COPY_WORDS = { copy: 'Copy', copied: 'Copied', failed: 'Could not copy' } as const;
/** What is announced with it. */
export const COPY_ANNOUNCED = { copied: 'Copied.', failed: 'Could not be copied.' } as const;
/** How long the button says what became of the copy. */
export const COPY_SAID_MS = 2_000;

export interface CopyButtonProps {
  /** What the button is for, in words: its accessible name and its tooltip. */
  readonly label: string;
  /** What to copy, asked for at the press: a text that is still being written is copied as far as it is then. */
  readonly text: () => string | Promise<string>;
  /** Its place in the tab order: left out, it is a stop as any button is. */
  readonly tabIndex?: number;
  /**
   * How it is drawn: its word, or two overlapping squares, beside a message's text (the maintainer),
   * its name then shown at once beside it. A conversation uses a stack of sheets.
   * Left out, its word.
   */
  readonly look?: 'words' | 'icon' | 'conversation';
}

/**
 * A Copy button (docs/planning/_archive/M19.md, Design 7; C38–C40): it writes plain text through the one
 * clipboard permission the window grants (`clipboard-sanitized-write`, src/main/windows/security.ts),
 * as the login command's Copy does, says for a moment that it copied or that it could not, and
 * says the same in a polite status region of its own. It knows nothing of what it copies.
 *
 * The stylesheet draws its icon. A conversation adds an empty decorative span for its third sheet.
 * A check, or a mark that it could not, stands for the word for that moment, and its name
 * beside it says the word.
 */
export function CopyButton({ label, text, tabIndex, look = 'words' }: CopyButtonProps) {
  const [said, setSaid] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  const anchor = useRef<HTMLButtonElement>(null);
  const tip = useNameTip();
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    let outcome: 'copied' | 'failed' = 'copied';
    try {
      const value = text();
      await navigator.clipboard.writeText(typeof value === 'string' ? value : await value);
    } catch {
      outcome = 'failed';
    }
    setSaid(outcome);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaid('idle'), COPY_SAID_MS);
  };

  const stop = tabIndex === undefined ? {} : { tabIndex };
  return (
    <span className={styles.copy} data-copy={said}>
      {look !== 'words' ? (
        <>
          <button ref={anchor} type="button" className={look === 'conversation' ? `${styles.icon} ${styles.conversation}` : styles.icon} aria-label={label} {...tip.targetProps} {...stop} onClick={() => void copy()}>
            {look === 'conversation' && <span className={styles.extraSheets} aria-hidden="true" />}
          </button>
          <NameTip open={tip.open} anchor={anchor} side={look === 'conversation' ? 'above' : 'right'}>{said === 'idle' ? label : COPY_WORDS[said]}</NameTip>
        </>
      ) : (
        <button type="button" className={styles.button} aria-label={label} title={label} {...stop} onClick={() => void copy()}>
          {said === 'idle' ? COPY_WORDS.copy : COPY_WORDS[said]}
        </button>
      )}
      <span className={announcer.announcer} role="status">{said !== 'idle' && COPY_ANNOUNCED[said]}</span>
    </span>
  );
}
