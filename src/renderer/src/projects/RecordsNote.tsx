// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import type { RecordsRefusalCause } from '@shared/contracts/projects';
import { invoke } from '../ipc/client';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { KeptFileNote } from '../ui/KeptFileNote';
import { COULD_NOT_MOVE, explain, startFreshText, unchangedText } from '../ui/refusal-text';
import styles from './Projects.module.css';

/**
 * What the project column shows when fat-g refused the records file (C5, C50, C61–C63, C66, C67): the
 * file is unchanged, why, and the remedy that keeps the projects. Start fresh moves the file aside,
 * never taken without a confirmation whose default is Cancel. Try again is offered for a file that
 * could not be opened.
 */
export function RecordsNote({ cause }: { readonly cause: RecordsRefusalCause }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { cause: why, remedy } = explain('records', cause);

  const startFresh = async (): Promise<void> => {
    setBusy(true);
    try {
      await invoke('records:startFresh', null);
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
      const answer = await invoke('records:retry', null);
      setProblem(answer.status === 'loaded' ? null : 'fat-g tried again, and still cannot read it.');
    } catch {
      setProblem('fat-g could not try again.');
    }
  };

  return (
    <>
      <div className={styles.note} role="status">
        <p>{unchangedText('records')}</p>
        <p>
          {why} {remedy}
        </p>
        {problem !== null && <p className={styles.problem}>{problem}</p>}
        <div className={styles.noteActions}>
          {cause === 'unreadable' && (
            <button type="button" className={styles.noteButton} onClick={() => void retry()}>
              Try again
            </button>
          )}
          <button type="button" className={styles.noteButton} onClick={() => setConfirming(true)}>
            Start fresh…
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Start fresh?"
        confirmLabel="Start fresh"
        busy={busy}
        onConfirm={() => void startFresh()}
        onCancel={() => setConfirming(false)}
      >
        <p>
          {why} {remedy}
        </p>
        <p>{startFreshText('records')}</p>
      </ConfirmDialog>
    </>
  );
}

/** After Start fresh: where the old file went, until dismissed. */
export function KeptNote({ path }: { readonly path: string }) {
  return <KeptFileNote key={path} file="projects" path={path} className={styles.kept} />;
}
