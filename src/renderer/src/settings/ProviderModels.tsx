// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { CATALOG_FILE, type CatalogModel, type CatalogProvider, type OverrideStatus } from '@shared/contracts/catalog';
import type { ProviderStatus } from '@shared/contracts/status';
import { invoke } from '../ipc/client';
import { effortExplanation, WARNING_MARK } from '../ui/effort-text';
import { formatDateTime } from '../ui/format';
import { overrideText } from '../ui/refusal-text';
import styles from './Settings.module.css';

/**
 * A provider's models, in its part of the Accounts tab (M13, C83, C84, C96): where the list came
 * from, then one compact row per model. Display only: nothing here changes a model, an effort or the
 * file (C60). Every mark is a word, never a colour alone, and the text can be selected (C61).
 */
export function ProviderModels({ entry, status }: { readonly entry: CatalogProvider | undefined; readonly status: ProviderStatus['kind'] }) {
  if (entry === undefined) return null;
  const source = entry.source.kind === 'report' ? `Reported by the CLI on ${formatDateTime(entry.source.at)}` : unreported(status);
  const refusal = entry.speedTierRequest.possible || !entry.models.some((model) => model.speedTiers.length > 0)
    ? null
    : `fat-g cannot ask for a speed tier${entry.speedTierRequest.reason === null ? '' : ` (${entry.speedTierRequest.reason})`}.`;
  return (
    <details className={styles.models}>
      <summary className={styles.modelsSummary}>Models</summary>
      <p className={styles.modelsLine}>
        <span className={styles.muted}>{source}</span>
        {refusal !== null && <span className={styles.muted}>{refusal}</span>}
      </p>
      {entry.models.length > 0 && (
        <table className={styles.modelTable}>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">ID</th>
              <th scope="col">Effort</th>
              <th scope="col">Speed</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {entry.models.map((model) => (
              <ModelRow key={model.key} model={model} />
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

/** Why there is no list (C94–C96): a provider that does not run has no CLI to report one. The Avatars tab says it too (M103, C19). */
export function unreported(status: ProviderStatus['kind']): string {
  if (status === 'disabled') return 'Listed once it is enabled and its CLI reports them.';
  if (status === 'blocked') return 'Listed once it runs again and its CLI reports them.';
  return 'The CLI has not reported its models.';
}

function ModelRow({ model }: { readonly model: CatalogModel }) {
  return (
    <tr className={model.hidden ? styles.hiddenModel : undefined} data-model-key={model.key}>
      <td>{model.name}</td>
      <td><code>{model.resolvedId ?? 'Not reported'}</code></td>
      <td>
        {model.efforts.length === 0 ? 'None' : model.efforts.map((effort, index) => (
          <span key={effort.id} title={effortExplanation(effort)}>{index > 0 && ' · '}{effortText(effort, model.listedDefaultEffort)}</span>
        ))}
        {model.efforts.filter((effort) => effort.warning !== undefined).map((effort) => (
          <small key={effort.id} className={styles.effortWarning} data-effort-warning={effort.id}><span aria-hidden="true">{WARNING_MARK}</span> {effort.label}: {effort.warning}</small>
        ))}
      </td>
      <td>{model.speedTiers.length === 0 ? 'None' : model.speedTiers.map((tier) => tier.name).join(' · ')}</td>
      <td>{modelMarks(model).join(' · ')}</td>
    </tr>
  );
}

/** A model's marks, in words (C84, C61). */
function modelMarks(model: CatalogModel): string[] {
  const marks: string[] = [];
  if (model.hidden) marks.push(model.hiddenByOverride ? `Hidden by your ${CATALOG_FILE}` : 'Hidden');
  if (model.origin === 'override') marks.push(`Added by your ${CATALOG_FILE}`);
  if (model.overridden) marks.push(`Changed by your ${CATALOG_FILE}`);
  if (model.listedDefault) marks.push('Listed default');
  return marks;
}

/** "Medium (listed default)", "Max ⚠": what the CLI lists, never what is in force (C7); a level's warning is said under the list. */
function effortText(effort: CatalogModel['efforts'][number], listedDefault: string | null): string {
  const label = effort.warning === undefined ? effort.label : `${effort.label} ${WARNING_MARK}`;
  return effort.id === listedDefault ? `${label} (listed default)` : label;
}

/**
 * The user's catalog.json: full details in Diagnostics, warnings alone in Accounts.
 * Its state, path and read-only controls send nothing until a button is pressed.
 */
export function CatalogNote({ status, warningsOnly = false }: { readonly status: OverrideStatus; readonly warningsOnly?: boolean }) {
  const [feedback, setFeedback] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    setFeedback(null);
    try {
      const answer = await invoke('catalog:reload', null);
      setFeedback(answer.kind === 'none' ? `No ${CATALOG_FILE} was found.` : answer.kind === 'applied' ? `${CATALOG_FILE} was read again and applied.` : `${CATALOG_FILE} was read again, and is ignored.`);
    } catch {
      setFeedback('fat-g could not read the file again.');
    }
  };
  const showFolder = async (): Promise<void> => {
    setFeedback(null);
    try {
      await invoke('shell:showDataFolder', null);
      setFeedback('The data folder was opened.');
    } catch {
      setFeedback('The data folder could not be opened.');
    }
  };

  const warning = status.kind === 'ignored' || (status.kind === 'applied' && status.unknownProviders.length > 0);
  if (warningsOnly && !warning) return null;

  return (
    <div className={warning ? `${styles.note} ${styles.catalogNote}` : `${styles.note} ${styles.catalogNote} ${styles.calm}`} role="status">
      <div className={styles.catalogLine}>
        <span>{overrideText(status)}</span>
        <span className={styles.inlineActions}>
          <button type="button" onClick={() => void reload()}>Reload</button>
          <button type="button" onClick={() => void showFolder()}>Show data folder</button>
        </span>
      </div>
      <p className={styles.catalogPath}>{status.path}</p>
      {feedback !== null && <p className={styles.feedback}>{feedback}</p>}
    </div>
  );
}
