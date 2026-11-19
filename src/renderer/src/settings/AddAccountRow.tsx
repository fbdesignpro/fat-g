// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId, useState } from 'react';
import { cleanInstanceLabel, type FolderRefusal, INSTANCE_LABEL_MAX, labelTaken, type ProviderInstances } from '@shared/contracts/instances';
import { invoke } from '../ipc/client';
import { useAppState } from '../state/store';
import { addRefusal, FOLDER_HELP, FOLDER_NEEDED, folderRefusalText, LABEL_EMPTY, LABEL_TAKEN, pickRefusalText, type RefusalNames } from '../ui/instance-text';
import styles from './Settings.module.css';

/**
 * Adding an account (M14b, C33): a name, a folder chosen in main's own picker, Save and Cancel.
 * Choosing a folder stores and starts nothing; Save alone does, and Cancel, or leaving Settings,
 * drops the pick. Each refusal is said beside the field it is about, checked here with the helpers
 * main checks with, and again by main whatever this row let through (C13, C15, C21).
 */
export function AddAccountRow({ providerId, providerName, instances, onDone }: {
  readonly providerId: string;
  readonly providerName: string;
  /** The provider's instances as the preferences hold them: whose names are taken. */
  readonly instances: ProviderInstances;
  /** Saved or cancelled: the row closes. */
  readonly onDone: () => void;
}) {
  const projects = useAppState((state) => state.snapshot?.records?.projects);
  const [label, setLabel] = useState('');
  const [folder, setFolder] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<FolderRefusal | null>(null);
  const [labelProblem, setLabelProblem] = useState<string | null>(null);
  const [folderProblem, setFolderProblem] = useState<string | null>(null);
  const [rowProblem, setRowProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const labelProblemId = useId();
  const folderProblemId = useId();

  const names: RefusalNames = {
    project: (id) => {
      const entry = projects?.find((candidate) => candidate.kind === 'project' && candidate.id === id);
      return entry?.kind === 'project' ? entry.name : null;
    },
    account: (key) => instances.added.find((entry) => entry.key.toLowerCase() === key.toLowerCase())?.label ?? null,
  };

  /** The rule a name fails, with the helpers main uses (C13). */
  const checkLabel = (value: string): string | null => {
    const cleaned = cleanInstanceLabel(value);
    if (cleaned === '') return LABEL_EMPTY;
    return labelTaken(instances, cleaned) ? LABEL_TAKEN : null;
  };

  const choose = async (): Promise<void> => {
    setBusy(true);
    setRowProblem(null);
    try {
      const answer = await invoke('instances:pickFolder', { providerId });
      if (answer.status === 'picked') {
        setFolder(answer.path);
        setRefusal(answer.refusal);
        setFolderProblem(answer.refusal === null ? null : folderRefusalText(answer.refusal, names));
      } else if (answer.status === 'refused') {
        setFolderProblem(pickRefusalText(answer.reason));
      }
    } catch {
      setFolderProblem('The folder picker is unavailable.');
    }
    setBusy(false);
  };

  const save = async (): Promise<void> => {
    const problem = checkLabel(label);
    setLabelProblem(problem);
    if (folder === null) setFolderProblem(FOLDER_NEEDED);
    if (problem !== null || folder === null || refusal !== null) return;
    setBusy(true);
    setRowProblem(null);
    try {
      const answer = await invoke('instances:add', { providerId, label, folder });
      if (answer.status === 'saved') {
        onDone();
        return;
      }
      const said = addRefusal(answer, names);
      if (said.field === 'label') setLabelProblem(said.text);
      else if (said.field === 'folder') setFolderProblem(said.text);
      else setRowProblem(said.text);
    } catch {
      setRowProblem('fat-g could not add the account, and nothing was saved.');
    }
    setBusy(false);
  };

  return (
    <div className={styles.addAccount} role="group" aria-label={`Add a ${providerName} account`} data-add-account={providerId}>
      <div className={styles.addFields}>
        <label className={styles.addField} htmlFor={nameId}>
          <span>Name</span>
          <input
            id={nameId}
            type="text"
            value={label}
            maxLength={INSTANCE_LABEL_MAX * 4}
            placeholder="Work"
            aria-invalid={labelProblem !== null}
            aria-describedby={labelProblem !== null ? labelProblemId : undefined}
            onChange={(event) => {
              setLabel(event.target.value);
              if (labelProblem !== null) setLabelProblem(checkLabel(event.target.value));
            }}
            onBlur={() => {
              if (label !== '') setLabelProblem(checkLabel(label));
            }}
          />
        </label>
        <div className={styles.addField}>
          <span>Account data folder</span>
          <div className={styles.addFolder}>
            <button type="button" disabled={busy} aria-describedby={folderProblem !== null ? folderProblemId : undefined} onClick={() => void choose()}>
              Choose folder…
            </button>
            {folder !== null && <span className={styles.path} data-picked-folder="">{folder}</span>}
          </div>
        </div>
        <div className={styles.inlineActions}>
          <button type="button" disabled={busy} onClick={() => void save()}>Save</button>
          <button type="button" disabled={busy} onClick={onDone}>Cancel</button>
        </div>
      </div>
      {labelProblem !== null && <p id={labelProblemId} className={styles.fieldProblem} role="alert">{labelProblem}</p>}
      {folderProblem !== null && <p id={folderProblemId} className={styles.fieldProblem} role="alert">{folderProblem}</p>}
      {rowProblem !== null && <p className={styles.fieldProblem} role="alert">{rowProblem}</p>}
      <p className={styles.addAccountHelp}>{FOLDER_HELP}</p>
    </div>
  );
}
