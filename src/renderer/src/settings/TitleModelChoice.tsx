// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId } from 'react';
import type { CatalogModel, CatalogProvider } from '@shared/contracts/catalog';
import { providerTiles } from '@shared/contracts/presets';
import { SESSION_TITLE_MODEL } from '@shared/contracts/title-model';
import styles from './Settings.module.css';

export interface TitleModelChoiceProps {
  /** The provider's instances' catalog entries: what each account's CLI lists. */
  readonly entries: readonly CatalogProvider[];
  /** A catalog key, SESSION_TITLE_MODEL, or null for Latest small model. */
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (model: string | null) => void;
}

/** Every model one of the accounts offers, once each, in the first account's order. */
function offered(entries: readonly CatalogProvider[]): CatalogModel[] {
  const seen = new Map<string, CatalogModel>();
  for (const entry of entries) for (const model of providerTiles(entry)) if (!seen.has(model.key)) seen.set(model.key, model);
  return [...seen.values()];
}

/**
 * Which model writes a new session's title (decision 0028): the latest small model by default,
 * the session's own, or a fixed CLI-listed model. A fixed choice no account lists any more stays
 * shown as saved, and the session's own model writes meanwhile.
 */
export function TitleModelChoice({ entries, value, disabled, onChange }: TitleModelChoiceProps) {
  const id = useId();
  const descriptionId = useId();
  const models = offered(entries);
  const unlisted = value !== null && value !== SESSION_TITLE_MODEL && !models.some((model) => model.key === value);
  return (
    <div className={styles.titleModelChoice} data-title-model="">
      <label htmlFor={id}><strong>Chat titles written by</strong></label>
      <select id={id} aria-describedby={value === null ? descriptionId : undefined} value={value ?? ''} disabled={disabled} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
        <option value="">Latest small model</option>
        <option value={SESSION_TITLE_MODEL}>Use the chat’s own model</option>
        {models.map((model) => (
          <option key={model.key} value={model.key}>{model.name}</option>
        ))}
        {unlisted && <option value={value}>{value} (not listed now)</option>}
      </select>
      {value === null && <small id={descriptionId} className={styles.muted}>Uses each account’s newest available small model. Refreshes at startup and when the CLI’s list changes; falls back to the session’s model.</small>}
    </div>
  );
}
