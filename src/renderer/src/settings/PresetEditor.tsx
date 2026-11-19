// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId, useState } from 'react';
import type { CatalogState } from '@shared/contracts/catalog';
import { sameInstance } from '@shared/contracts/instances';
import { limitPresetNameInput, normalizePresetName } from '@shared/contracts/names';
import { catalogEntry, effortFor, providerTiles, resolveTileKey, speedFor } from '@shared/contracts/presets';
import { type SavedPreset, savedPresetProblem } from '@shared/contracts/saved-presets';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { Avatar } from '../sessions/Avatar';
import { effortText } from '../ui/effort-text';
import { EffortWarning } from '../ui/EffortWarning';
import { speedExplanation, speedText } from '../ui/speed-text';
import { presetAccountName } from './preset-presentation';
import styles from './PresetsSection.module.css';
import settings from './Settings.module.css';

export function PresetEditor({ value, catalog, accounts, disabled, onSave, onCancel }: {
  readonly value: SavedPreset;
  readonly catalog: CatalogState | undefined;
  readonly accounts: readonly ProviderSnapshot[];
  readonly disabled: boolean;
  readonly onSave: (preset: SavedPreset) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const id = useId();
  const accountIndex = accounts.findIndex((account) => sameInstance({ providerId: account.id, instanceId: account.instanceId }, draft));
  const entry = catalogEntry(catalog, draft);
  const models = entry === undefined ? [] : providerTiles(entry);
  const model = resolveTileKey(entry, draft.model);
  const named = entry?.models.find((row) => row.key === draft.model) ?? model;
  const missingModel = !models.some((row) => row.key === draft.model);
  const missingEffort = draft.effort !== null && !model?.efforts.some((level) => level.id === draft.effort);
  const tiers = model?.speedTiers ?? [];
  const missingSpeed = draft.speed !== null && !tiers.some((tier) => tier.id === draft.speed);
  const tier = tiers.find((one) => one.id === draft.speed);
  const problem = savedPresetProblem(draft, catalog, accounts);

  return (
    <form className={styles.editor} aria-label="Preset editor" onSubmit={(event) => {
      event.preventDefault();
      if (!disabled && normalizePresetName(draft.name) !== '' && draft.model !== '') onSave({ ...draft, name: normalizePresetName(draft.name) });
    }}>
      <fieldset disabled={disabled}>
        <legend>{value.name === '' ? 'New preset' : `Edit ${value.name}`}</legend>
        <label htmlFor={`${id}-name`}>Preset name</label>
        <input id={`${id}-name`} autoFocus maxLength={4096} aria-description="Up to 18 characters." title="Up to 18 characters" value={draft.name} onChange={(event) => setDraft({ ...draft, name: limitPresetNameInput(event.target.value) })} />
        <label htmlFor={`${id}-account`}>Account</label>
        <select id={`${id}-account`} value={accountIndex < 0 ? '' : String(accountIndex)} onChange={(event) => {
          const account = accounts[Number(event.target.value)];
          if (account === undefined) return;
          const ref = { providerId: account.id, instanceId: account.instanceId };
          const nextEntry = catalogEntry(catalog, ref);
          const nextModel = nextEntry === undefined ? undefined : providerTiles(nextEntry)[0];
          setDraft({ name: draft.name, ...ref, model: nextModel?.key ?? '', effort: nextModel === undefined ? null : effortFor(nextModel, null), speed: nextModel === undefined ? null : speedFor(nextModel, draft.speed) });
        }}>
          {accountIndex < 0 && <option value="">{presetAccountName(accounts, draft)} (unavailable)</option>}
          {accounts.map((account, index) => <option key={`${account.id}/${account.instanceId}`} value={String(index)}>{presetAccountName(accounts, { providerId: account.id, instanceId: account.instanceId })}</option>)}
        </select>
        <label htmlFor={`${id}-model`}>Model</label>
        <div className={styles.modelChoice}>
          <Avatar providerId={draft.providerId} avatar={named?.avatar ?? null} size="thin" />
          <select id={`${id}-model`} value={draft.model} onChange={(event) => {
            const nextModel = models.find((row) => row.key === event.target.value);
            if (nextModel !== undefined) setDraft({ ...draft, model: nextModel.key, effort: effortFor(nextModel, draft.effort), speed: speedFor(nextModel, draft.speed) });
          }}>
            {missingModel && <option value={draft.model}>{draft.model === '' ? 'No models listed' : `${draft.model} (saved key)`}</option>}
            {models.map((row) => <option key={row.key} value={row.key}>{row.name}</option>)}
          </select>
          {problem !== null && <span className={styles.unavailable} role="status" aria-label={`Unavailable — ${problem}`} title={problem}>Unavailable</span>}
        </div>
        <label htmlFor={`${id}-effort`}>Effort</label>
        <select id={`${id}-effort`} value={draft.effort ?? ''} aria-describedby={`${id}-effort-warning`} onChange={(event) => setDraft({ ...draft, effort: event.target.value || null })}>
          {(draft.effort === null || !model?.efforts.length) && <option value="">{model?.efforts.length ? 'No effort (unavailable)' : 'No effort'}</option>}
          {missingEffort && <option value={draft.effort ?? ''}>{draft.effort} (unavailable)</option>}
          {model?.efforts.map((level) => <option key={level.id} value={level.id}>{effortText(level)}</option>)}
        </select>
        <EffortWarning id={`${id}-effort-warning`} effort={model?.efforts.find((level) => level.id === draft.effort)} />
        {(tiers.length > 0 || draft.speed !== null) && (
          <>
            <label htmlFor={`${id}-speed`}>Speed</label>
            <select id={`${id}-speed`} value={draft.speed ?? ''} title={tier === undefined ? undefined : speedExplanation(tier)} onChange={(event) => setDraft({ ...draft, speed: event.target.value === '' ? null : event.target.value })}>
              <option value="">Standard</option>
              {missingSpeed && <option value={draft.speed ?? ''}>{draft.speed} (unavailable)</option>}
              {tiers.map((one) => <option key={one.id} value={one.id}>{speedText(one)}</option>)}
            </select>
          </>
        )}
      </fieldset>
      <div className={settings.actions}>
        <button type="submit" disabled={disabled || normalizePresetName(draft.name) === '' || draft.model === ''}>Save preset</button>
        <button type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
