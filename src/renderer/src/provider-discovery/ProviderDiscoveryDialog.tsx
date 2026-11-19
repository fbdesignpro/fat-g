// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type SyntheticEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '../ipc/client';
import { openSettings } from '../settings/settings-store';
import { useAppState } from '../state/store';
import styles from '../ui/Dialog.module.css';
import { discoveryProviderText } from './words';

/** Main-owned, batched notices. Other dialogs take priority over automatic discovery. */
export function ProviderDiscoveryDialog() {
  const notice = useAppState((state) => state.snapshot?.providerDiscovery?.notice ?? null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [blocked, setBlocked] = useState(true);
  const [pending, setPending] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const titleId = useId();
  const open = notice !== null && notice.revision !== dismissed && !blocked;

  useEffect(() => {
    const check = (): void => setBlocked([...document.querySelectorAll('dialog[open]')].some((element) => element !== dialog.current));
    check();
    const containsDialog = (node: Node): boolean => node instanceof Element && (node.matches('dialog') || node.querySelector('dialog') !== null);
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(containsDialog))) check();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['open'], childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
      dismiss.current?.focus();
    } else if (!open && element.open) element.close();
  }, [open]);

  const acknowledge = async (settings = false): Promise<void> => {
    if (pending || notice === null) return;
    setPending(true);
    setFeedback(null);
    try {
      const accepted = await invoke('providers:acknowledgeDiscovery', { revision: notice.revision });
      if (accepted) {
        setDismissed(notice.revision);
        // Close before opening Accounts so focus is handed over once.
        dialog.current?.close();
        if (settings) openSettings({ section: 'accounts' });
      }
    } catch { setFeedback('Could not dismiss this notice. Try again.'); }
    finally { setPending(false); }
  };
  const closed = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.stopPropagation();
    const previous = opener.current;
    opener.current = null;
    if (previous?.isConnected === true) previous.focus();
  };

  return (
    <dialog ref={dialog} className={`${styles.dialog} ${styles.narrow}`} aria-labelledby={titleId} onClose={closed} onCancel={(event) => { event.preventDefault(); void acknowledge(); }}>
      {open && notice !== null && <>
        <header className={styles.header}><h2 id={titleId} className={styles.title}>{notice.initial ? 'Providers detected' : 'Provider availability changed'}</h2></header>
        <div className={styles.body}>
          <p>{notice.initial ? 'fat-g automatically detects the provider CLIs installed on your computer.' : 'fat-g detected changes to your installed provider CLIs.'}</p>
          <ul>{notice.providers.map((provider) => <li key={provider.id}><strong>{provider.displayName}:</strong> {discoveryProviderText(provider)}</li>)}</ul>
          <p>Newly detected providers are enabled automatically. Providers you switch off in Settings stay off.</p>
          {!notice.initial && notice.providers.some((provider) => provider.presence === 'missing') && <p>Running work can finish. Your sessions and account settings are kept.</p>}
          {feedback !== null && <p role="status">{feedback}</p>}
        </div>
        <footer className={styles.footer}>
          <button type="button" className={styles.button} disabled={pending} onClick={() => void acknowledge(true)}>Accounts settings</button>
          <button ref={dismiss} type="button" className={styles.button} disabled={pending} onClick={() => void acknowledge()}>Got it</button>
        </footer>
      </>}
    </dialog>
  );
}
