// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, type SyntheticEvent, useId, useLayoutEffect, useRef } from 'react';
import styles from './Dialog.module.css';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  /** Cancel or Escape. The caller closes the dialog by passing `open: false`. */
  readonly onCancel: () => void;
  /** While the confirmed action runs: both buttons wait. */
  readonly busy?: boolean;
}

/**
 * A question before something that cannot be taken back (M12: Remove, C41; Start fresh, C66). A modal
 * `<dialog>`, so Tab stays inside and Escape cancels; Cancel holds the focus when it opens, so the
 * safe answer is the default; closing hands the focus back to whatever opened it.
 */
export function ConfirmDialog({ open, title, children, confirmLabel, onConfirm, onCancel, busy = false }: ConfirmDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      cancel.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // Escape closes the dialog itself; either way the caller hears of it, and the focus goes back.
  // React passes `close` up its own tree, so a confirmation inside Settings would close Settings too.
  const onClose = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.stopPropagation();
    const previous = opener.current;
    opener.current = null;
    if (previous?.isConnected === true) previous.focus();
    if (open) onCancel();
  };

  // Closed, it holds nothing: the question exists only while it is asked.
  return (
    <dialog ref={dialog} className={`${styles.dialog} ${styles.narrow}`} aria-labelledby={titleId} onClose={onClose}>
      {open && (
        <>
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
          </header>
          <div className={styles.body}>{children}</div>
          <footer className={styles.footer}>
            <button ref={cancel} type="button" className={styles.button} disabled={busy} onClick={() => dialog.current?.close()}>
              Cancel
            </button>
            <button type="button" className={styles.button} disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </button>
          </footer>
        </>
      )}
    </dialog>
  );
}
