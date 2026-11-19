// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, useState } from 'react';
import type { CatalogProvider } from '@shared/contracts/catalog';
import {
  cleanInstanceLabel,
  FIRST_INSTANCE_ID,
  INSTANCE_LABEL_MAX,
  type InstanceEntry,
  labelTaken,
  loginCommand,
  loginShell,
  type ProviderInstances,
  sameAccountAs,
  sameInstance,
} from '@shared/contracts/instances';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { invoke } from '../ipc/client';
import { patchPrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { folderRuleText, instanceIssueText, LABEL_EMPTY, LABEL_TAKEN, redetectRefusalText, removeRefusalText, runningRefusalText, SESSION_RUNNING_TEXT, sessionCount } from '../ui/instance-text';
import { NoticeDialog } from '../ui/NoticeDialog';
import { menuStyles, Popup } from '../ui/Popup';
import { providerStatusDetail } from '../ui/provider-status-detail';
import { providerStatusSummary } from '../ui/provider-status-label';
import { useMenu } from '../ui/useMenu';
import { LoginHelp } from './LoginHelp';
import { ProviderModels } from './ProviderModels';
import styles from './Settings.module.css';
import { targetHeadingId } from './settings-store';

/** What a row's label reads for an entry that has none to show. */
export const UNNAMED_ACCOUNT = 'Unnamed account';

type Say = (text: string | null) => void;

/** Refresh and reconnect, for one instance: each names it, and reaches it alone (M14b, C21, C60). */
export function instanceActions(provider: ProviderSnapshot, say: Say) {
  const ref = { providerId: provider.id, instanceId: provider.instanceId };
  return {
    async refresh(): Promise<void> {
      say(null);
      try {
        const result = await invoke('providers:refresh', ref);
        // The button shows the read while it runs; only a Refresh that could not start is said (M13, C98).
        if (result.status === 'refused') say('That action is unavailable right now.');
      } catch {
        say('The main process could not accept that action.');
      }
    },
    /** Opens the user's terminal with this account's login command in it (C80). Main builds the command. */
    async openLoginTerminal(): Promise<boolean> {
      say(null);
      try {
        return (await invoke('instances:openLoginTerminal', ref)).status === 'opened';
      } catch {
        return false;
      }
    },
    /** After signing in, or after an error: fat-g's own CLI process for this account is started again. */
    async reconnect(): Promise<void> {
      say(null);
      try {
        const result = await invoke('providers:redetect', ref);
        say(result.status === 'refused' ? redetectRefusalText(result.reason) : 'CLI reconnection accepted.');
      } catch {
        say('Detection could not be restarted.');
      }
    },
  };
}

/** Whether Refresh has anything to read: not for an instance that is off, blocked, or still being found. */
export function canRefresh(provider: ProviderSnapshot): boolean {
  const kind = provider.status.kind;
  return kind !== 'disabled' && kind !== 'blocked' && kind !== 'detecting';
}

/**
 * Email first, then status, plan and CLI version below the account heading.
 * Settings always shows the email in full (M14b, C79).
 */
export function StatusLine({ provider }: { readonly provider: ProviderSnapshot }) {
  const version = provider.installation?.version ?? null;
  const parts = [
    provider.account?.email,
    providerStatusSummary(provider),
    provider.account?.plan,
    version === null ? undefined : `CLI ${version}`,
  ].filter((part) => part !== undefined);
  return <p className={styles.statusLine}>{parts.join(' · ')}</p>;
}

/**
 * What is under an instance's status line: what its status means, the login command when it is
 * signed out, Reconnect after an error, the variables it was started without (C64), the account it
 * repeats (C11), and — with `models` — its own models (C35).
 */
export function InstanceDetails({ provider, entry, instance, siblings, models, onReconnect, onOpenTerminal, onRemove }: {
  readonly provider: ProviderSnapshot;
  /** Its own catalog entry. */
  readonly entry: CatalogProvider | undefined;
  /** An added instance's preferences entry; null for the first one. */
  readonly instance: InstanceEntry | null;
  /** Every instance of its provider, in order. */
  readonly siblings: readonly ProviderSnapshot[];
  readonly models: boolean;
  readonly onReconnect: () => void;
  readonly onOpenTerminal: () => Promise<boolean>;
  /** Removing it is the remedy for a blocked one (C37, C59, C66); undefined where there is no Remove. */
  readonly onRemove?: (() => void) | undefined;
}) {
  const { status } = provider;
  const detail = providerStatusDetail(provider);
  const folder = instance?.folder ?? null;
  // The first instance sets nothing, so its command is the CLI's own (C36).
  const command = provider.instanceVariable !== null && folder !== null
    ? loginCommand(loginShell(window.fatg.platform), provider.instanceVariable, folder, provider.descriptor.loginCommand)
    : provider.descriptor.loginCommand;
  const same = sameAccountAs(siblings, provider);
  const blockedInstance = status.kind === 'blocked' && (status.reason === 'invalid-instance' || status.reason === 'folder-missing' || status.reason === 'folder-refused');
  const why = status.kind !== 'blocked' ? null : status.reason === 'invalid-instance' ? instanceIssueText(status.issue) : status.reason === 'folder-refused' ? folderRuleText(status.rule) : null;

  return (
    <>
      {detail !== null && <p className={styles.detail}>{detail}</p>}
      {why !== null && <p className={styles.detail}>{why}</p>}
      {blockedInstance && onRemove !== undefined && (
        <div className={styles.actions}>
          <button type="button" onClick={onRemove}>Remove account…</button>
        </div>
      )}
      {status.kind === 'not-logged-in' && <LoginHelp command={command} offPath={provider.installation !== null && provider.installation.source !== 'path'} onReconnect={onReconnect} onOpenTerminal={onOpenTerminal} />}
      {status.kind === 'error' && (
        <div className={styles.actions}>
          <button type="button" onClick={onReconnect}>Reconnect CLI</button>
        </div>
      )}
      {provider.startedWithout.length > 0 && (
        <p className={styles.detail} data-started-without="">
          Started without {provider.startedWithout.join(', ')}
        </p>
      )}
      {same !== null && (
        <p className={styles.detail} data-same-account="">
          Same account as {same.label}
        </p>
      )}
      {models && <ProviderModels entry={entry} status={status.kind} />}
    </>
  );
}

/**
 * One account's card (M14b, C34, C35): its email or label, its status line, its
 * switch and its folder for an added one, Refresh, Rename beside its heading, and a Remove menu
 * for an added one; then what its status calls for, and its own models. An entry that cannot be used shows
 * why, with Remove (C66). The first account has no switch and no Remove: it is the provider's own.
 */
export function InstanceRow({ provider, entry, instance, instances, siblings, disabled }: {
  readonly provider: ProviderSnapshot;
  readonly entry: CatalogProvider | undefined;
  /** Its preferences entry; null for the first instance. */
  readonly instance: InstanceEntry | null;
  readonly instances: ProviderInstances;
  readonly siblings: readonly ProviderSnapshot[];
  /** The preferences cannot be written, or a change is on its way. */
  readonly disabled: boolean;
}) {
  const sessions = useAppState((state) => state.snapshot?.sessions?.sessions);
  const { open, close, button, buttonProps, menuProps } = useMenu();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const first = provider.instanceId === FIRST_INSTANCE_ID;
  /** An added entry that can run: it has an id, so it can be renamed and switched. */
  const usable = first || (instance !== null && instance.issue === null && instance.id !== null);
  const label = provider.label !== '' ? provider.label : UNNAMED_ACCOUNT;
  const customName = first ? instances.firstLabel : instance?.label ?? null;
  const actions = instanceActions(provider, setFeedback);
  const own = (sessions ?? []).filter((session) => sameInstance({ providerId: session.record.providerId, instanceId: session.record.instanceId }, { providerId: provider.id, instanceId: provider.instanceId }));

  const saveName = async (): Promise<void> => {
    if (renaming === null) return;
    const cleaned = cleanInstanceLabel(renaming);
    // An added account's name is required; the first one's, cleared, reads "Default" again (C13).
    if (cleaned === '' && !first) {
      setRenameProblem(LABEL_EMPTY);
      return;
    }
    if (cleaned !== '' && labelTaken(instances, cleaned, first ? { first: true } : { key: instance?.key ?? '' })) {
      setRenameProblem(LABEL_TAKEN);
      return;
    }
    setRenameProblem(null);
    setRenaming(null);
    if (first) await patchPrefs({ providers: { [provider.id]: { label: cleaned === '' ? null : cleaned } } });
    else if (instance?.id != null) await patchPrefs({ providers: { [provider.id]: { instances: { [instance.id]: { label: cleaned } } } } });
  };

  const onRenameKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveName();
    } else if (event.key === 'Escape') {
      // The field's alone: Escape must not also close Settings.
      event.preventDefault();
      event.stopPropagation();
      setRenaming(null);
      setRenameProblem(null);
    }
  };

  /** Remove asks first (C23) — or, while one of its sessions runs, says why it cannot (M14, C96). */
  const askRemove = (): void => {
    setFeedback(null);
    if (own.some((session) => session.summary.status === 'running')) setRunning(true);
    else setConfirming(true);
  };

  const remove = async (): Promise<void> => {
    if (instance === null) return;
    setBusy(true);
    try {
      const answer = await invoke('instances:remove', { providerId: provider.id, key: instance.key });
      if (answer.status === 'refused') setFeedback(removeRefusalText(answer.reason));
    } catch {
      setFeedback('fat-g could not remove the account.');
    }
    setBusy(false);
    setConfirming(false);
  };

  const headingId = targetHeadingId({ provider: provider.id, instanceId: provider.instanceId });
  return (
    <div className={styles.instance} data-instance={provider.instanceId}>
      <div className={styles.instanceHeading}>
        <div className={styles.instanceName}>
          {renaming === null ? (
            <h5 id={headingId} className={styles.instanceLabel} tabIndex={-1}>
              Account: {customName ?? provider.account?.email ?? label}
            </h5>
          ) : (
            <span className={styles.renameField}>
              <input
                type="text"
                value={renaming}
                autoFocus
                maxLength={INSTANCE_LABEL_MAX * 4}
                aria-label={`Name of the account ${label}`}
                aria-invalid={renameProblem !== null}
                onChange={(event) => setRenaming(event.target.value)}
                onKeyDown={onRenameKey}
              />
              <span className={styles.inlineActions}>
                <button type="button" onClick={() => void saveName()}>Save name</button>
                <button type="button" onClick={() => { setRenaming(null); setRenameProblem(null); }}>Cancel</button>
              </span>
            </span>
          )}
          {renaming === null && usable && (
            <span className={styles.inlineActions}>
              <button type="button" className={styles.renameButton} aria-label={`Rename account ${label}`} disabled={disabled} onClick={() => {
                close(false);
                setRenameProblem(null);
                setRenaming(first ? instances.firstLabel ?? '' : instance?.label ?? '');
              }}>Rename</button>
            </span>
          )}
        </div>
        <span className={styles.instanceActions}>
          {!first && usable && instance !== null && (
            <label className={styles.switch}>
              <input
                type="checkbox"
                checked={instance.enabled}
                disabled={disabled}
                onChange={(event) => {
                  if (instance.id === null) return;
                  setFeedback(null);
                  void patchPrefs({ providers: { [provider.id]: { instances: { [instance.id]: { enabled: event.target.checked } } } } }).then((refused) => {
                    if (refused !== null) setFeedback(runningRefusalText('instance-switch'));
                  });
                }}
              />
              Enabled
            </label>
          )}
          <span className={styles.inlineActions}>
            {canRefresh(provider) && (
              <button type="button" disabled={provider.refreshing} onClick={() => void actions.refresh()}>
                {provider.refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
            {!first && <button {...buttonProps} type="button" aria-label={`Actions for the account ${label}`}>
              …
            </button>}
          </span>
        </span>
        {!first && open && (
          <Popup anchor={button} inPlace>
            <div {...menuProps} aria-label={`Actions for the account ${label}`} className={menuStyles.menu}>
                <button type="button" role="menuitem" tabIndex={-1} className={menuStyles.item} disabled={disabled} onClick={() => { close(true); askRemove(); }}>
                  Remove…
                </button>
            </div>
          </Popup>
        )}
      </div>
      <StatusLine provider={provider} />
      {renameProblem !== null && <p className={styles.fieldProblem} role="alert">{renameProblem}</p>}
      {instance?.folder != null && <p className={`${styles.path} ${styles.instanceFolder}`} data-instance-folder="">{instance.folder}</p>}
      <InstanceDetails
        provider={provider}
        entry={entry}
        instance={instance}
        siblings={siblings}
        models
        onReconnect={() => void actions.reconnect()}
        onOpenTerminal={() => actions.openLoginTerminal()}
        onRemove={first || disabled ? undefined : askRemove}
      />
      {feedback !== null && <p className={styles.muted} role="status">{feedback}</p>}
      <ConfirmDialog open={confirming} title={`Remove the account ${label}?`} confirmLabel="Remove" busy={busy} onConfirm={() => void remove()} onCancel={() => setConfirming(false)}>
        <p>
          {provider.displayName} will no longer run as “{label}”, which has {sessionCount(own.length)}.{own.length > 0 ? ' They stay in the list, and cannot be continued without this account.' : ''}
        </p>
        <p>Its folder, and everything the CLI keeps in it, is left as it is.</p>
      </ConfirmDialog>
      <NoticeDialog open={running} title={`A session of ${label} is running`} onClose={() => setRunning(false)}>
        <p>{SESSION_RUNNING_TEXT}</p>
      </NoticeDialog>
    </div>
  );
}
