// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useRef, useState } from 'react';
import type { ProjectColumnSide } from '@shared/contracts/prefs';
import type { DiscoveredProvider } from '@shared/contracts/provider-discovery';
import { invoke } from '../ipc/client';
import { discoveryProviderText } from '../provider-discovery/words';
import { openSettings } from '../settings/settings-store';
import { usePrefs } from '../state/prefs-store';
import type { FirstRunGuide } from './first-run';
import styles from './FirstRun.module.css';
import { useAddProjectArrow } from './useAddProjectArrow';

/**
 * The guide drawn on the grid in place of an empty chat window, as a new chat is (first-run.ts): the
 * page's main landmark while it shows.
 */
export function FirstRunScreen({ guide }: { readonly guide: FirstRunGuide }) {
  return guide.kind === 'no-provider' ? <NoProvider providers={guide.providers} checking={guide.checking} /> : <AddProject />;
}

/**
 * Each registered provider, as discovery last found it, with its installation guide — opened in the
 * user's browser by main, from the provider's definition — while it is not installed. A check runs at
 * the press; Accounts settings is where a provider is switched on or its executable chosen.
 */
function NoProvider({ providers, checking }: { readonly providers: readonly DiscoveredProvider[]; readonly checking: boolean }) {
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const detected = providers.some((provider) => provider.presence === 'present');
  const check = async (): Promise<void> => {
    setPending(true);
    setFeedback(null);
    try { await invoke('providers:discover', null); }
    catch { setFeedback('Could not check for providers. Try again.'); }
    finally { setPending(false); }
  };
  const openGuide = (providerId: string): void => {
    setFeedback(null);
    invoke('shell:openLink', { providerId }).catch(() => setFeedback('The installation guide could not be opened.'));
  };
  return (
    <main className={`${styles.screen} ${styles.noProvider}`} aria-label="Getting started" data-first-run="no-provider">
      <h1 className={styles.title}>{detected ? 'No LLM provider enabled' : 'No AI coding CLI found'}</h1>
      <hr className={styles.rule} />
      <div className={styles.body}>
        <p>{detected
          ? 'fat-g works through the AI coding CLIs installed on this computer. Switch one on in Accounts settings to start.'
          : 'fat-g needs an AI coding CLI. A desktop app may include one, but installing the app alone does not guarantee a usable CLI. Install a CLI or choose its executable in Accounts settings, then sign in from your own terminal if needed.'}</p>
        <ul className={styles.providers}>
          {providers.map((provider) => (
            <li key={provider.id}>
              <strong>{provider.displayName}</strong>
              <span>{discoveryProviderText(provider)}</span>
              {provider.presence !== 'present' && <button type="button" className={styles.button} onClick={() => openGuide(provider.id)}>Installation guide</button>}
            </li>
          ))}
        </ul>
        <p>fat-g checks for installed CLIs at launch and when you return to it. For help locating yours, open Accounts settings and expand How to find the CLI executable.</p>
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={pending || checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check now'}</button>
          <button type="button" className={styles.button} onClick={() => openSettings({ section: 'accounts' })}>Accounts settings</button>
        </div>
        {feedback !== null && <p role="status">{feedback}</p>}
      </div>
    </main>
  );
}

/** One line on the project column's side, and an arrow drawn from it to Add project. */
function AddProject() {
  const side: ProjectColumnSide = usePrefs((state) => state.snapshot?.values.layout.projectColumn ?? 'left');
  const line = useRef<HTMLSpanElement>(null);
  const arrow = useAddProjectArrow(line, side);
  return (
    <main className={`${styles.screen} ${styles.addProject}`} aria-label="Getting started" data-first-run="add-project" data-side={side}>
      <h1 className={styles.hint}><span ref={line}>Start by adding a project from a folder</span></h1>
      <p className={styles.detail}>A project is a folder, or several, that your agents work in.</p>
      {arrow !== null && (
        <svg className={styles.arrow} aria-hidden="true" focusable="false">
          <path className={styles.arrowLine} d={arrow.line} pathLength={1} />
          <path className={styles.arrowHead} d={arrow.head} />
        </svg>
      )}
    </main>
  );
}
