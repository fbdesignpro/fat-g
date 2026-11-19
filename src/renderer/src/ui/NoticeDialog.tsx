// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, type SyntheticEvent, useId, useLayoutEffect, useRef } from 'react';
import styles from './Dialog.module.css';

export interface NoticeDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  /** OK or Escape. The caller closes the dialog by passing `open: false`. */
  readonly onClose: () => void;
}

/**
 * Why something cannot be done, said in place of the confirmation that would have asked about it
 * (M14, C96): Remove while a session runs. A modal `<dialog>` with one button, which holds the focus
 * when it opens; closing hands the focus back to whatever opened it, as a confirmation does.
 */
export function NoticeDialog({ open, title, children, onClose }: NoticeDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      ok.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // React passes `close` up its own tree: a notice inside another dialog would close that one too.
  const closed = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.stopPropagation();
    const previous = opener.current;
    opener.current = null;
    if (previous?.isConnected === true) previous.focus();
    if (open) onClose();
  };

  return (
    <dialog ref={dialog} className={`${styles.dialog} ${styles.narrow}`} aria-labelledby={titleId} onClose={closed}>
      {open && (
        <>
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
          </header>
          <div className={styles.body}>{children}</div>
          <footer className={styles.footer}>
            <button ref={ok} type="button" className={styles.button} onClick={() => dialog.current?.close()}>
              OK
            </button>
          </footer>
        </>
      )}
    </dialog>
  );
}
