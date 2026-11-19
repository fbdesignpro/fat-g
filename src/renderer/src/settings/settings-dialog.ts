// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type RefObject, type SyntheticEvent, useLayoutEffect, useRef } from 'react';

/**
 * A modal `<dialog>` over Settings, as Preview and Assign avatar are: shown while `open`, the focus
 * handed back to what opened it when it closes, and its `close` stopped where it rose — React passes it
 * up its own tree, and Settings would close with it. `focus`: what takes the focus when it opens.
 */
export function useSettingsDialog(open: boolean, onClose: () => void, focus?: string): {
  readonly dialog: RefObject<HTMLDialogElement | null>;
  readonly onDialogClose: (event: SyntheticEvent<HTMLDialogElement>) => void;
} {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      if (focus !== undefined) element.querySelector<HTMLElement>(focus)?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open, focus]);

  const onDialogClose = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.stopPropagation();
    const previous = opener.current;
    opener.current = null;
    if (previous?.isConnected === true) previous.focus();
    if (open) onClose();
  };
  return { dialog, onDialogClose };
}
