// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { AudioSection } from './AudioSection';
import { type FunctionComponent, type SyntheticEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PreferencesStatus } from '@shared/contracts/prefs';
import { CloseIcon } from '../control-bar/icons';
import { invoke } from '../ipc/client';
import { usePrefs } from '../state/prefs-store';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { KeptFileNote } from '../ui/KeptFileNote';
import { COULD_NOT_MOVE, explain, preferencesCause, startFreshText, unchangedText } from '../ui/refusal-text';
import { AppearanceSection } from './AppearanceSection';
import { AboutSection } from './AboutSection';
import { AvatarsSection } from './AvatarsSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { GeneralSection } from './GeneralSection';
import { ProvidersSection } from './ProvidersSection';
import { PresetsSection } from './PresetsSection';
import styles from './Settings.module.css';
import { closeSettings, selectSettingsTab, type SettingsSection, targetLandingIds, useSettings } from './settings-store';
import { SettingsTabs } from './SettingsTabs';
import { StorageSection } from './StorageSection';

/** Each tab's content: its section's component, which draws its panel (M101, C14). */
const PANELS: Readonly<Record<SettingsSection, FunctionComponent>> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  audio: AudioSection,
  accounts: ProvidersSection,
  presets: PresetsSection,
  avatars: AvatarsSection,
  storage: StorageSection,
  diagnostics: DiagnosticsSection,
  about: AboutSection,
};

/**
 * Settings: one modal <dialog> in the Main window (decision 0008). `showModal()` brings the focus
 * trap, the inert page behind it and Escape; closing it — Escape, or its close button — hands the
 * focus back to whatever opened it (C43). Its text stays selectable (C30).
 *
 * Under its header, a row of tabs, one per section, and the shown tab's panel, which scrolls alone
 * (docs/planning/_archive/M101-spec-sheet.md; C1, C5). Opened at a section, it shows that tab and focuses it;
 * at a provider or an account, it shows Accounts, scrolled to that heading with the focus on it (C6,
 * C8). Opened with neither, it shows the tab it last showed (C7).
 *
 * With read-only preferences the note above the tabs says why, and every control is disabled (C48;
 * M101, C4). The note offers Start fresh, and Try again for a file that could not be opened (M12,
 * C64, C81).
 */
export function SettingsDialog() {
  const open = useSettings((state) => state.open);
  const target = useSettings((state) => state.target);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (open && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);

  // Opening at a target has already selected its tab (settings-store), so its panel is mounted here.
  useEffect(() => {
    if (!open || target === null) return;
    const landing = targetLandingIds(target).map((id) => document.getElementById(id)).find((element) => element !== null);
    if ('provider' in target) landing?.scrollIntoView?.({ block: 'start' });
    landing?.focus();
  }, [open, target]);

  // However it closed, the store follows and the focus goes back.
  const onClose = (event: SyntheticEvent<HTMLDialogElement>): void => {
    // Only its own: a dialog inside it closing is not this one closing.
    if (event.target !== event.currentTarget) return;
    closeSettings();
    const previous = opener.current;
    opener.current = null;
    if (previous?.isConnected === true) previous.focus();
  };

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={onClose}>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          Settings
        </h2>
        <button type="button" className={styles.closeButton} aria-label="Close settings" onClick={() => dialog.current?.close()}>
          <CloseIcon />
        </button>
      </header>
      {open && <SettingsContent />}
    </dialog>
  );
}

/** The notes, whatever tab is open, then the row of tabs and the one panel (M101, C4, C5). */
function SettingsContent() {
  const snapshot = usePrefs((state) => state.snapshot);
  const error = usePrefs((state) => state.error);
  const tab = useSettings((state) => state.tab);
  // After Start fresh, where the old file went — until dismissed or Settings closes.
  const [keptAs, setKeptAs] = useState<string | null>(null);
  const Panel = PANELS[tab];
  return (
    <div className={styles.content}>
      <div className={styles.notes}>
        {snapshot === null ? (
          <p className={styles.note} role="status">
            {error === null ? 'Loading your preferences…' : `Preferences could not be read (${error}).`}
          </p>
        ) : (
          <StatusNote status={snapshot.status} onKept={setKeptAs} />
        )}
        {keptAs !== null && (
          <KeptFileNote key={keptAs} file="preferences" path={keptAs} className={styles.note} />
        )}
      </div>
      <SettingsTabs selected={tab} onSelect={selectSettingsTab} />
      <Panel />
    </div>
  );
}

/** Silently starting on defaults, or silently not saving, is the kind of thing people notice late. */
function StatusNote({ status, onKept }: { readonly status: PreferencesStatus; readonly onKept: (path: string) => void }) {
  switch (status.kind) {
    case 'ok':
      return null;
    case 'read-only':
      return <RefusedNote status={status} onKept={onKept} />;
  }
}

/**
 * The file is unchanged, why it was refused, and the remedy that keeps it (C62). Start fresh moves it
 * aside only after a confirmation whose default is Cancel (C64, C66); the providers then go back to
 * their default switches. Try again reads a file that could not be opened once more (C81).
 */
function RefusedNote({ status, onKept }: { readonly status: Extract<PreferencesStatus, { kind: 'read-only' }>; readonly onKept: (path: string) => void }) {
  const cause = preferencesCause(status);
  const { cause: why, remedy } = explain('preferences', cause);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const startFresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const answer = await invoke('prefs:startFresh', null);
      if (answer.status === 'done') onKept(answer.keptAs);
      setProblem(null);
    } catch {
      setProblem(COULD_NOT_MOVE);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const retry = async (): Promise<void> => {
    try {
      const answer = await invoke('prefs:retry', null);
      setProblem(answer.status === 'loaded' ? null : 'fat-g tried again, and still cannot read it.');
    } catch {
      setProblem('fat-g could not try again.');
    }
  };

  return (
    <>
      <div className={styles.note} role="status">
        <p className={styles.noteLine}>{unchangedText('preferences')}</p>
        <p className={styles.noteLine}>
          {why} {remedy}
        </p>
        {problem !== null && <p className={`${styles.noteLine} ${styles.critical}`}>{problem}</p>}
        <div className={styles.actions}>
          {cause === 'unreadable' && (
            <button type="button" onClick={() => void retry()}>
              Try again
            </button>
          )}
          <button type="button" onClick={() => setConfirming(true)}>
            Start fresh…
          </button>
        </div>
      </div>
      <ConfirmDialog open={confirming} title="Start fresh?" confirmLabel="Start fresh" busy={busy} onConfirm={() => void startFresh()} onCancel={() => setConfirming(false)}>
        <p>
          {why} {remedy}
        </p>
        <p>{startFreshText('preferences')}</p>
      </ConfirmDialog>
    </>
  );
}
