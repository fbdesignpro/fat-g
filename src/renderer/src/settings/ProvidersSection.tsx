// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, useId, useState } from 'react';
import type { CatalogProvider } from '@shared/contracts/catalog';
import { firstInstances, MAX_INSTANCES, NO_INSTANCES, sameInstance } from '@shared/contracts/instances';
import type { PreferencesSnapshot, ProviderPreferenceIssue } from '@shared/contracts/prefs';
import type { ProviderActionResult } from '@shared/contracts/provider';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { ProviderMark } from '../control-bar/ProviderMark';
import { ProviderDiscoveryControls } from '../provider-discovery/ProviderDiscoveryControls';
import { invoke } from '../ipc/client';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { LIMIT_TEXT, redetectRefusalText, runningRefusalText } from '../ui/instance-text';
import { AddAccountRow } from './AddAccountRow';
import { ExecutableHelp } from './ExecutableHelp';
import { InstanceRow } from './InstanceRow';
import { ModeChoice } from './ModeChoice';
import { TitleModelChoice } from './TitleModelChoice';
import { CatalogNote } from './ProviderModels';
import { Section } from './Section';
import { useKeptFocus } from './kept-focus';
import styles from './Settings.module.css';
import { targetHeadingId } from './settings-store';

const NO_PROVIDERS: readonly ProviderSnapshot[] = [];
const NO_ENTRIES: readonly CatalogProvider[] = [];

/**
 * The Accounts tab, which was the Providers section (M101, C3).
 *
 * One part per registered provider, disabled ones included (C40): its status, what to do about it,
 * every action the old Usage and Settings scenes offered (C46, C59 — docs/planning/_archive/M11.md, Design 6,
 * lists each one and where it went), and its models (M13, C83). The user's catalog.json, which may
 * adjust any provider's models, is noted above them only when it needs attention;
 * its full status and controls live in Diagnostics.
 *
 * Each account has a card, including the first. Provider headings and Add account stand outside
 * the cards; installation and provider defaults are shared above them.
 *
 * A provider that declares modes has its Default security mode here (M22, C40, C87): the default a new chat of
 * it starts under where its project says none, saved by this control alone. It reaches no chat that
 * exists and no running session, and it shows nothing of an account (C43).
 */
export function ProvidersSection() {
  const prefs = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  const snapshots = useAppState((state) => state.snapshot?.providers ?? NO_PROVIDERS);
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const providers = firstInstances(snapshots);

  return (
    <Section section="accounts">
      <ProviderDiscoveryControls />
      {catalog !== undefined && <CatalogNote status={catalog.override} warningsOnly />}
      {prefs === null ? (
        <p className={styles.muted}>Loading provider controls…</p>
      ) : providers.length === 0 ? (
        <p className={styles.muted}>No providers are registered in this build.</p>
      ) : (
        <div className={styles.providerList}>
          {providers.map((provider) => (
            <ProviderSettings
              key={provider.id}
              provider={provider}
              snapshots={snapshots.filter((snapshot) => snapshot.id === provider.id)}
              entries={catalog?.providers.filter((entry) => entry.id === provider.id) ?? NO_ENTRIES}
              prefs={prefs}
              disabled={prefs.status.kind === 'read-only' || saving}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

type Feedback = string | null;

function ProviderSettings({ provider, snapshots, entries, prefs, disabled }: {
  /** The provider's first instance supplies its shared capabilities and installation status. */
  readonly provider: ProviderSnapshot;
  /** Every instance of the provider, the first one first. */
  readonly snapshots: readonly ProviderSnapshot[];
  /** Its instances' catalog entries: its look, and each one's models. There is none only before the first snapshot. */
  readonly entries: readonly CatalogProvider[];
  readonly prefs: PreferencesSnapshot;
  readonly disabled: boolean;
}) {
  const saved = prefs.values.providers[provider.id] ?? { enabled: true, executablePath: null, permissionMode: null };
  const permissions = provider.descriptor.capabilities.permissions;
  const instances = prefs.instances[provider.id] ?? NO_INSTANCES;
  const issue = prefs.providerIssues[provider.id];
  const executableChoice = useId();
  const executableGroup = useKeptFocus(disabled);
  // Choosing Manual opens a draft; only Save path or Browse commits a usable override.
  const [manual, setManual] = useState(saved.executablePath !== null || issue === 'invalid-executable-path' || issue === 'invalid-provider-entry');
  const [draft, setDraft] = useState(saved.executablePath ?? '');
  const [shownFor, setShownFor] = useState(saved.executablePath);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [adding, setAdding] = useState(false);
  if (shownFor !== saved.executablePath) {
    setShownFor(saved.executablePath);
    setDraft(saved.executablePath ?? '');
    setManual(saved.executablePath !== null);
  }
  const kind = provider.status.kind;
  /** Redetection reaches every enabled account when there is more than one. */
  const rows = snapshots.length > 1;
  const entryOf = (snapshot: ProviderSnapshot): CatalogProvider | undefined =>
    entries.find((entry) => sameInstance({ providerId: entry.id, instanceId: entry.instanceId }, { providerId: snapshot.id, instanceId: snapshot.instanceId }));
  const entry = entryOf(provider);
  // Its module can run several accounts, and the saved list of them can be added to (C5, C16).
  const canAdd = provider.instanceVariable !== null && issue !== 'invalid-instances' && issue !== 'invalid-provider-section';
  const atLimit = 1 + instances.added.length >= MAX_INSTANCES;

  /**
   * Detect the CLI again. With several accounts, each one that is switched on is asked in turn, one
   * request each (C71): an entry that cannot be used has no runtime to start.
   */
  const redetect = async (): Promise<void> => {
    setFeedback(null);
    const targets = rows ? snapshots.filter((snapshot) => snapshot.status.kind !== 'disabled' && !(snapshot.status.kind === 'blocked' && snapshot.status.reason === 'invalid-instance')) : [provider];
    try {
      const refusals: Extract<ProviderActionResult, { status: 'refused' }>['reason'][] = [];
      for (const target of targets) {
        const result = await invoke('providers:redetect', { providerId: target.id, instanceId: target.instanceId });
        if (result.status === 'refused') refusals.push(result.reason);
      }
      // A running session is the refusal the user can act on soonest.
      const reason = refusals.includes('session-running') ? 'session-running' : refusals[0];
      setFeedback(reason === undefined ? 'Detection restarted.' : redetectRefusalText(reason));
    } catch {
      setFeedback('Detection could not be restarted.');
    }
  };
  const browse = async (): Promise<void> => {
    setFeedback(null);
    try {
      const result = await invoke('providers:pickExecutable', { providerId: provider.id });
      setFeedback(result.status === 'selected' ? 'Executable saved.' : result.status === 'cancelled' ? 'No file selected.' : result.reason === 'session-running' ? runningRefusalText('provider-executable') : 'The executable could not be changed right now.');
    } catch {
      setFeedback('The file picker is unavailable.');
    }
  };
  /** A change main refused because a session of the provider runs (M15, C18): said here. */
  const sayRunning = (action: 'provider-switch' | 'provider-executable') => (refused: 'session-running' | null): void => {
    if (refused !== null) setFeedback(runningRefusalText(action));
  };
  const openGuide = (): void => {
    setFeedback(null);
    invoke('shell:openLink', { providerId: provider.id }).catch(() => setFeedback('The installation guide could not be opened.'));
  };
  const savePath = (): void => {
    const value = draft.trim();
    setFeedback(null);
    if (value.length === 0) {
      setDraft(saved.executablePath ?? '');
    } else if (!isAbsolutePath(value, window.fatg.platform)) {
      setFeedback('Enter a literal absolute path, or choose the executable with Browse.');
    } else {
      void patchPrefs({ providers: { [provider.id]: { executablePath: value } } }).then(sayRunning('provider-executable'));
    }
  };
  const useAutomatic = (): void => {
    setFeedback(null);
    void patchPrefs({ providers: { [provider.id]: { executablePath: null } } }).then((refused) => {
      sayRunning('provider-executable')(refused);
      const current = usePrefs.getState();
      if (refused === null && current.error === null && current.snapshot?.status.kind === 'ok' && (current.snapshot.values.providers[provider.id]?.executablePath ?? null) === null) setManual(false);
    });
  };

  const headingId = targetHeadingId({ provider: provider.id });
  return (
    <section className={styles.provider} aria-labelledby={headingId} style={entry === undefined ? undefined : { '--bar-color': entry.presentation.barColor } as CSSProperties}>
      <div className={styles.providerHeading}>
        <h4 id={headingId} className={styles.providerName} tabIndex={-1}>
          {entry?.presentation.logo !== undefined ? <img className={styles.providerLogo} src={entry.presentation.logo} alt="" draggable={false} /> : entry !== undefined && <ProviderMark name={provider.displayName} presentation={entry.presentation} size={28} decorative />}
          <span>{provider.displayName}</span>
        </h4>
        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={saved.enabled}
            disabled={disabled}
            onChange={(event) => { setFeedback(null); void patchPrefs({ providers: { [provider.id]: { enabled: event.target.checked } } }).then(sayRunning('provider-switch')); }}
          />
          Enabled
        </label>
      </div>
      {/* The provider's own, once for all its accounts: the CLI is one installation. */}
      {kind === 'not-installed' && (
        <div className={styles.actions}>
          <button type="button" onClick={openGuide}>Installation guide</button>
        </div>
      )}
      {issue !== undefined && <p className={styles.note}>{providerIssue(issue)}</p>}
      <div className={styles.providerChoices}>
        {/* Defaults belong to the provider and are shared by all of its accounts. */}
        {permissions !== null && (
          <div className={styles.providerChoiceBox}>
            <ModeChoice
              tooltipsOnly
              legend="Default security mode"
              capability={permissions}
              value={saved.permissionMode}
              none="fallback"
              disabled={disabled}
              onChange={(mode) => { setFeedback(null); void patchPrefs({ providers: { [provider.id]: { permissionMode: mode } } }); }}
            />
          </div>
        )}
        {provider.descriptor.capabilities.titles === true && (
          <div className={`${styles.providerChoiceBox} ${styles.providerTitleBox}`}>
            <TitleModelChoice
              entries={entries}
              value={prefs.values.titles.models[provider.id] ?? null}
              disabled={disabled || !prefs.values.titles.generated}
              onChange={(model) => { setFeedback(null); void patchPrefs({ titles: { models: { [provider.id]: model } } }); }}
            />
          </div>
        )}
      </div>
      <fieldset ref={executableGroup} disabled={disabled} className={`${styles.cliChoice} ${styles.providerChoiceBox}`}>
        <legend className={styles.modeLegend}>CLI executable</legend>
        <ExecutableHelp help={provider.descriptor.executableHelp} platform={window.fatg.platform} />
        <div className={styles.cliOptions}>
          <label className={styles.cliOption}>
            <input type="radio" name={executableChoice} value="automatic" checked={!manual} disabled={disabled} onChange={useAutomatic} />
            Automatic detection
          </label>
          <div className={`${styles.inlineActions} ${styles.cliDetectionRow}`}>
            <button type="button" disabled={disabled || !saved.enabled} title="Restart the CLI connection and detect the installation again for each enabled account. Reloads account status and models; unavailable while an affected session is running." onClick={() => void redetect()}>Redetect / reconnect</button>
            <small className={styles.cliDetection}>{detectedCliText(provider)}</small>
          </div>
          <label className={styles.cliOption}>
            <input type="radio" name={executableChoice} value="manual" checked={manual} disabled={disabled} onChange={() => setManual(true)} />
            Manual override
          </label>
          <div className={styles.cliManualFields}>
            <label className={styles.pathField}>
              <span className={styles.muted}>Enter an absolute path and save it, or choose the executable with Browse.</span>
              <input aria-label="CLI executable path" type="text" value={draft} disabled={disabled || !manual} placeholder="Absolute path to CLI executable" onChange={(event) => setDraft(event.target.value)} />
            </label>
            <div className={styles.inlineActions}>
              <button type="button" disabled={disabled || !manual} onClick={savePath}>Save path</button>
              <button type="button" disabled={disabled || !manual} onClick={() => void browse()}>Browse…</button>
            </div>
          </div>
        </div>
      </fieldset>
      {feedback !== null && <p className={styles.muted} role="status">{feedback}</p>}
      {canAdd && (adding ? (
        <AddAccountRow providerId={provider.id} providerName={provider.displayName} instances={instances} onDone={() => setAdding(false)} />
      ) : (
        <div className={styles.actions}>
          <button type="button" disabled={disabled || atLimit} onClick={() => setAdding(true)}>Add {provider.displayName} account</button>
          {atLimit && <span className={styles.muted}>{LIMIT_TEXT}</span>}
        </div>
      ))}
      <div className={styles.instances}>
        {snapshots.map((snapshot) => (
          <InstanceRow
            key={snapshot.instanceId}
            provider={snapshot}
            entry={entryOf(snapshot)}
            instance={instances.added.find((candidate) => candidate.key.toLowerCase() === snapshot.instanceId.toLowerCase()) ?? null}
            instances={instances}
            siblings={snapshots}
            disabled={disabled}
          />
        ))}
      </div>
    </section>
  );
}

function isAbsolutePath(value: string, platform: string): boolean {
  return platform === 'win32' ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) : value.startsWith('/');
}

/** Detection exposes the version and source, never the resolved executable path. */
function detectedCliText(provider: ProviderSnapshot): string {
  const installation = provider.installation;
  if (installation === null) return provider.status.kind === 'detecting' ? 'Checking installation…' : provider.status.kind === 'not-installed' ? 'CLI not found' : 'No detection result';
  const source = { override: 'manual override', path: 'PATH', 'known-dir': 'known install folder' }[installation.source];
  return `Found CLI${installation.version === null ? '' : ` ${installation.version}`} via ${source}`;
}

function providerIssue(issue: ProviderPreferenceIssue): string {
  switch (issue) {
    case 'invalid-enabled': return 'The saved enabled value is invalid. Set the toggle explicitly to repair it.';
    case 'invalid-executable-path': return 'The saved executable override is invalid. Choose a file, enter an absolute path, or use automatic detection.';
    case 'invalid-provider-entry': return 'This provider’s saved controls are malformed. Set the controls explicitly to repair them.';
    case 'invalid-provider-section': return 'The providers section needs manual repair. The original file is being preserved; repair it and restart fat-g.';
    case 'invalid-instances': return 'This provider’s saved accounts are not a list, so only its first account runs and none can be added. The original file is being preserved; repair it and restart fat-g.';
  }
}
