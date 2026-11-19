// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import styles from './Settings.module.css';

export const TERMINAL_OPENED = 'A terminal opened and started the sign-in. Finish it in your browser, then press Signed in, reconnect.';
export const TERMINAL_FAILED = 'No terminal could be opened. Run the command below in a terminal of your own.';
export const OFF_PATH = 'fat-g found this CLI outside your PATH, so a terminal of your own will not find it by this name; Sign in with the CLI runs it by its full path.';

/**
 * What a signed-out account needs (M11, C46; M14b, C36, C80): a button that opens the user's own
 * terminal with the CLI's login command, which sends them to the sign-in page in their browser; a
 * button to reconnect once they are back; and, under the steps, the command with Copy, the fallback
 * for a terminal of their own. For an added account the command sets the variable to its folder
 * first (`loginCommand`, in the contract). The sign-in is the CLI's own, in the user's terminal and
 * browser: fat-g presents no login and reads nothing of one (decision 0004).
 */
export function LoginHelp({ command, offPath = false, onReconnect, onOpenTerminal }: {
  readonly command: string;
  /** The CLI was found by an override or in a known install folder: main's terminal runs it by its full path. */
  readonly offPath?: boolean;
  readonly onReconnect: () => void;
  /** Asks main to open a terminal with this account's command; answers whether one opened. */
  readonly onOpenTerminal: () => Promise<boolean>;
}) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [terminal, setTerminal] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle');
  const openTerminal = async (): Promise<void> => {
    setTerminal('opening');
    setTerminal((await onOpenTerminal()) ? 'opened' : 'failed');
  };
  const copyCommand = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <div className={styles.login}>
      <ol className={styles.loginSteps}>
        <li>
          <div className={styles.loginStep}>
            <span>Start the sign-in.</span>
            <span className={styles.inlineActions}>
              <button type="button" disabled={terminal === 'opening'} onClick={() => void openTerminal()}>Sign in with the CLI</button>
            </span>
          </div>
          <p className={styles.loginNote}>A terminal opens and runs the CLI’s sign-in command, which sends you to the sign-in page in your browser.</p>
        </li>
        <li>
          <div className={styles.loginStep}>
            <span>Finish signing in there, as the CLI asks.</span>
          </div>
        </li>
        <li>
          <div className={styles.loginStep}>
            <span>Come back and reconnect.</span>
            <span className={styles.inlineActions}>
              <button type="button" onClick={onReconnect}>Signed in, reconnect</button>
            </span>
          </div>
        </li>
      </ol>
      <div className={styles.loginFallback}>
        <span>No sign-in page? Run the command in a terminal of your own:</span>
        <div className={styles.command}>
          <code>{command}</code>
          <button type="button" onClick={() => void copyCommand()}>Copy</button>
        </div>
      </div>
      {offPath && <p className={styles.muted} data-off-path="">{OFF_PATH}</p>}
      {(terminal === 'opened' || terminal === 'failed') && <p className={styles.muted} role="status">{terminal === 'opened' ? TERMINAL_OPENED : TERMINAL_FAILED}</p>}
      {copy !== 'idle' && <p className={styles.muted} role="status">{copy === 'copied' ? 'Command copied.' : 'The command could not be copied.'}</p>}
    </div>
  );
}
