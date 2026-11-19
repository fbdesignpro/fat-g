// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import type { DataResetInfo } from '@shared/contracts/data-reset';
import { invoke } from '../ipc/client';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import styles from './Settings.module.css';

/** Two separate confirmations. Nothing is written until the second is accepted. */
export function ResetDataSection() {
  const [info, setInfo] = useState<DataResetInfo | null>(null);
  const [stage, setStage] = useState<'idle' | 'first' | 'second'>('idle');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void invoke('diagnostics:dataResetInfo', null).then((value) => { if (current) setInfo(value); }, () => { if (current) setFeedback('The data folder could not be checked. Close and reopen Settings to try again.'); });
    return () => { current = false; };
  }, []);
  const cancel = (): void => { if (!busy) { setStage('idle'); setFeedback(null); } };
  const reset = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await invoke('diagnostics:resetAllData', null);
      if (result.status === 'scheduled') setFeedback('Reset scheduled. fat-g is quitting; your next launch will start fresh.');
      else { setFeedback('The reset could not be scheduled. Nothing was deleted and fat-g will stay open. Try again.'); setBusy(false); }
    } catch { setFeedback('The reset could not be confirmed. fat-g will stay open if it was not scheduled.'); setBusy(false); }
  };
  return (
    <div onKeyDownCapture={(event) => { if (busy && event.key === 'Escape') event.preventDefault(); }}>
      <h3>Application data</h3>
      {info !== null && <p>Data folder: <code>{info.folder}</code></p>}
      <div className={styles.inlineActions}>
        <button type="button" onClick={() => { void invoke('shell:showDataFolder', null).catch(() => setFeedback('The data folder could not be opened.')); }}>Open data folder</button>
        <button type="button" disabled={info?.available !== true || busy} onClick={() => { setFeedback(null); setStage('first'); }}>Reset all data...</button>
      </div>
      <p>Remove all fat-g data for this installation and return to a fresh install. Two confirmations are required.</p>
      {info?.available === false && <p role="status">Reset is unavailable because this data folder or its pending reset request could not be safely checked.</p>}
      {feedback !== null && stage !== 'second' && <p role="status">{feedback}</p>}
      <ConfirmDialog open={stage === 'first'} title="Reset all fat-g data?" confirmLabel="Continue" onConfirm={() => setStage('second')} onCancel={cancel}>
        <p>This removes all settings, provider account entries, presets, project and session lists, chats, plans, attachments, custom avatars, sounds, overrides and saved backups in this installation's data folder.</p>
        <p>Your actual project files and the CLIs' own logins, configuration and history stay untouched.</p>
        <p>Folder to clear: <code>{info?.folder}</code></p>
      </ConfirmDialog>
      <ConfirmDialog open={stage === 'second'} title="Permanently reset and quit?" confirmLabel="Reset on next start and quit" busy={busy} onConfirm={() => void reset()} onCancel={cancel}>
        <p>fat-g will quit now, stopping any running work. On the next launch it will permanently erase all fat-g data in this folder before starting fresh:</p>
        <p><code>{info?.folder}</code></p>
        <p>This cannot be undone. No backup will be kept. Project folders and CLI logins are not removed.</p>
        {feedback !== null && <p role="status">{feedback}</p>}
      </ConfirmDialog>
    </div>
  );
}
