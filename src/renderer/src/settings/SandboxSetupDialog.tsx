// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type SyntheticEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { type InstanceRef, sameInstance, shownLabel } from '@shared/contracts/instances';
import { availabilityOf, type SetupAction } from '@shared/contracts/permissions';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import styles from '../ui/Dialog.module.css';
import { closeSandboxSetup, useSandboxSetup } from './sandbox-setup-store';
import { SETUP_WORDS, setupRefusalText } from './setup-words';

const NO_PROVIDERS: readonly ProviderSnapshot[] = [];
/** What the keyboard can stop at: the first of them in a part of the page is where the focus goes when the control it came from is gone. */
const STOPS = '[tabindex="0"], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled)';

/** What stands around an element, nearest first, up to the page's body and without it. */
function around(element: HTMLElement | null): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let at = element?.parentElement ?? null; at !== null && at !== document.body; at = at.parentElement) found.push(at);
  return found;
}

/**
 * The CLI's own sandbox setup for one account (docs/planning/_archive/M22.md, Design 10; C60–C62, C72): a
 * modal `<dialog>` of the shared frame, opened from a Set up control. Before the press it says what
 * the setup changes on the machine, that Windows will ask for an administrator's approval, whose
 * configuration it belongs to, and that fat-g cannot undo it; Cancel holds the focus, so the safe
 * answer is the default. Set up sends the one request, and never by itself.
 *
 * From there it follows the account's snapshot, which main publishes: waiting, with Stop waiting;
 * failed, with the CLI's reason and Try again; completed; or an outcome fat-g did not hear, said as
 * unknown with what the CLI reports now. It holds nothing of a setup itself: closing it stops
 * nothing, and opening it again shows where the account stands.
 *
 * Closed, it gives the focus back to the control that opened it. That control can be gone by then:
 * a completed setup ends the block whose Set up it was (C89), and the input row stands in its
 * place. The focus then goes to the first stop of what still stands around that place — the chat's
 * list, there — and never to the page's body.
 */
export function SandboxSetupDialog() {
  const open = useSandboxSetup((state) => state.open);
  const target = useSandboxSetup((state) => state.target);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const stood = useRef<readonly HTMLElement[]>([]);
  const titleId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      stood.current = around(opener.current);
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // However it closed, the store follows and the focus goes back.
  const onClose = (event: SyntheticEvent<HTMLDialogElement>): void => {
    // React passes `close` up its own tree: a dialog this one stands in would close too.
    event.stopPropagation();
    if (event.target !== event.currentTarget) return;
    closeSandboxSetup();
    const previous = opener.current;
    const place = stood.current;
    opener.current = null;
    stood.current = [];
    if (previous?.isConnected === true) previous.focus();
    else place.find((element) => element.isConnected)?.querySelector<HTMLElement>(STOPS)?.focus({ preventScroll: true });
  };

  // Closed, it holds nothing.
  return (
    <dialog ref={dialog} className={`${styles.dialog} ${styles.narrow}`} aria-labelledby={titleId} onClose={onClose} data-sandbox-setup="">
      {open && target !== null && <Setup key={`${target.providerId}:${target.instanceId}`} target={target} titleId={titleId} close={() => dialog.current?.close()} />}
    </dialog>
  );
}

function Setup({ target, titleId, close }: { readonly target: InstanceRef; readonly titleId: string; readonly close: () => void }) {
  const providers = useAppState((state) => state.snapshot?.providers ?? NO_PROVIDERS);
  const account = providers.find((provider) => sameInstance({ providerId: provider.id, instanceId: provider.instanceId }, target));
  const name = account?.displayName ?? target.providerId;
  const setup = account?.sandboxSetup ?? null;
  const state = setup?.state ?? 'idle';
  // The provider's own lines for its setup (C60): what it changes, who asks for leave, and what may be happening meanwhile.
  const declared = account?.descriptor.capabilities.permissions?.setup ?? null;
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The modes the setup is for, by the labels their provider declares: the ones this account was
  // offered it for when the dialog opened. Kept, since a completed setup offers it for none.
  const [needing] = useState<readonly string[]>(() => (account?.descriptor.capabilities.permissions?.modes ?? []).filter((mode) => availabilityOf(account?.modes, mode.id).setup).map((mode) => mode.label));
  // The button that leaves things as they are holds the focus (C60): at the opening, and at every
  // change of state, when the button that was pressed has gone and another stands in its place.
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => { safe.current?.focus(); }, [state]);

  // A button whose press is on its way is said disabled and not made so: a disabled button loses the
  // focus to the page's body before the next state's button stands in its place.
  const send = (action: SetupAction): void => {
    if (sending) return;
    setProblem(null);
    setSending(true);
    invoke('instances:setupSandbox', { providerId: target.providerId, instanceId: target.instanceId, action }).then(
      // Taken: the account's snapshot brings the state. Refused: said here, and nothing was sent.
      (answer) => { if (answer.status === 'refused') setProblem(setupRefusalText(answer.reason, action, name)); },
      () => { setProblem(SETUP_WORDS.notSent); },
    ).finally(() => { setSending(false); });
  };

  const waiting = state === 'starting' || state === 'waiting';
  return (
    <>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {SETUP_WORDS.title(name)}
        </h2>
      </header>
      <div className={styles.body} data-setup-state={state}>
        {state === 'idle' && (
          <>
            {declared !== null && <p>{declared.changes}</p>}
            <p>{declared === null ? SETUP_WORDS.noPassword : `${declared.approval} ${SETUP_WORDS.noPassword}`}</p>
            <p>{SETUP_WORDS.belongs(name, shownLabel(providers, target))}</p>
            <p>{SETUP_WORDS.permanent}</p>
          </>
        )}
        {waiting && (
          <>
            <p role="status">{SETUP_WORDS.waiting(name, declared?.waiting ?? '')}</p>
            <p>{SETUP_WORDS.held}</p>
          </>
        )}
        {state === 'failed' && (
          <>
            <p role="status">{SETUP_WORDS.failed(name)}</p>
            {setup?.error != null && setup.error !== '' && <p>{SETUP_WORDS.reported(name, setup.error)}</p>}
          </>
        )}
        {state === 'completed' && <p role="status">{SETUP_WORDS.completed(needing)}</p>}
        {state === 'unknown' && (
          <>
            <p role="status">{SETUP_WORDS.unknown}</p>
            <p>{SETUP_WORDS.reports(name, setup?.readiness ?? null)}</p>
          </>
        )}
        {problem !== null && <p className={styles.error} role="alert">{problem}</p>}
      </div>
      <footer className={styles.footer}>
        <button ref={safe} type="button" className={styles.button} onClick={close}>
          {state === 'idle' ? SETUP_WORDS.cancel : SETUP_WORDS.close}
        </button>
        {/* Each a button of its own, by its key: one that was pressed never becomes another under the same press. */}
        {state === 'idle' && (
          <button key="start" type="button" className={styles.button} aria-disabled={sending || undefined} data-setup-action="start" onClick={() => send('start')}>
            {SETUP_WORDS.setUp}
          </button>
        )}
        {waiting && (
          <button key="stop" type="button" className={styles.button} aria-disabled={sending || undefined} data-setup-action="stop-waiting" onClick={() => send('stop-waiting')}>
            {SETUP_WORDS.stopWaiting}
          </button>
        )}
        {(state === 'failed' || (state === 'unknown' && setup?.readiness !== 'ready')) && (
          <button key="again" type="button" className={styles.button} aria-disabled={sending || undefined} data-setup-action="start" onClick={() => send('start')}>
            {SETUP_WORDS.tryAgain}
          </button>
        )}
      </footer>
    </>
  );
}
