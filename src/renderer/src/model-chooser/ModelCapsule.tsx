// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { CSSProperties, ReactNode } from 'react';
import type { CatalogModel, CatalogState } from '@shared/contracts/catalog';
import { catalogEntry, checkPreset, presetOffer, resolveTileKey, type ModelPreset } from '@shared/contracts/presets';
import { savedPresetProblem } from '@shared/contracts/saved-presets';
import { modelSelectionKey } from '@shared/contracts/recent-models';
import type { SavedPreset } from '@shared/contracts/saved-presets';
import { shownLabel } from '@shared/contracts/instances';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { Avatar } from '../sessions/Avatar';
import { tierOf, withSpeed } from '../ui/speed-text';
import { TILE_HEIGHT, TILE_WIDTH } from './chooser-shape';
import styles from './Capsules.module.css';

export function capsulePresentation(preset: ModelPreset, catalog: CatalogState | undefined, accounts: readonly ProviderSnapshot[], providers?: readonly string[]) {
  const entry = catalogEntry(catalog, preset);
  const model = resolveTileKey(entry, preset.model);
  const named = entry?.models.find((row) => row.key === preset.model) ?? model;
  const check = providers === undefined ? null : checkPreset(catalog, presetOffer(providers, accounts), preset);
  const problem = check !== null && !check.ok && check.reason === 'provider-not-offered' ? 'This project is not set up for this provider.' : savedPresetProblem(preset, catalog, accounts);
  const modelName = named?.name ?? preset.model;
  const level = preset.effort === null ? 'No effort' : model?.efforts.find((one) => one.id === preset.effort)?.label ?? preset.effort;
  // The speed tier after the level, as the effort bar says them (decision 0016): "Max - ⚡Fast".
  const effort = withSpeed(level, tierOf(model?.speedTiers, preset.speed));
  const account = shownLabel(accounts, preset);
  const providerName = accounts.find((one) => one.id === preset.providerId)?.displayName ?? preset.providerId;
  const accountName = account === null ? providerName : `${providerName} (${account})`;
  return { modelName, effort, detail: `${modelName} · ${effort}`, account, accountName, avatar: named?.avatar ?? null, color: entry?.presentation.barColor, problem };
}

type CapsulePresentation = ReturnType<typeof capsulePresentation>;

/** One presentation for selectable presets, Settings, and the name entered into a new preset. */
function CapsuleContents({ preset, presentation, title, named, status = false }: { readonly preset: ModelPreset; readonly presentation: CapsulePresentation; readonly title: ReactNode; readonly named: boolean; readonly status?: boolean }) {
  const { effort, detail, account, avatar, problem } = presentation;
  return <>
    <Avatar providerId={preset.providerId} avatar={avatar} size="capsule" effort={preset.effort} fast={preset.speed !== null} />
    <span className={styles.capsuleText}>{title}<small>{named ? detail : `${effort}${account === null ? '' : ` (${account})`}`}</small>{problem !== null && <small className={styles.unavailable} role={status ? 'status' : undefined} aria-label={status ? `Unavailable — ${problem}` : undefined} title={problem}>Unavailable</small>}</span>
  </>;
}

/** A non-interactive, standard-size preset capsule; its name can be replaced by the naming field. */
export function PresetPreview({ preset, presentation, nameField }: { readonly preset: SavedPreset; readonly presentation: CapsulePresentation; readonly nameField?: ReactNode }) {
  const description = [presentation.accountName, presentation.detail, presentation.problem].filter(Boolean).join(' — ');
  return <div className={`${styles.capsule} ${styles.preview}`} style={{ width: TILE_WIDTH, height: TILE_HEIGHT }} data-preset-preview="" role="group" aria-label={preset.name || 'Preset preview'} title={description}>
    <CapsuleContents preset={preset} presentation={presentation} named status title={nameField === undefined ? <h3>{preset.name}</h3> : <strong>{nameField}</strong>} />
  </div>;
}

export function ModelCapsule({ preset, presentation, name, busy, selection, presetId, recentKey, onChoose }: {
  readonly preset: ModelPreset;
  readonly presentation: ReturnType<typeof capsulePresentation>;
  readonly name?: string;
  readonly busy: boolean;
  readonly selection: ModelPreset | null;
  readonly presetId?: string;
  readonly recentKey?: string;
  readonly onChoose: () => void;
}) {
  const { modelName, effort, detail, account, color, problem } = presentation;
  const selected = selection !== null && modelSelectionKey(selection) === modelSelectionKey(preset);
  const title = name ?? modelName;
  return <button type="button" className={styles.capsule} style={{ '--selection-color': color } as CSSProperties} data-preset-id={presetId} data-recent-model={recentKey} aria-pressed={selected} aria-disabled={busy || problem !== null || undefined}
    title={[detail, account, problem].filter(Boolean).join(' — ')} aria-label={`${title}: ${name === undefined ? effort : detail}${account === null ? '' : ` (${account})`}${problem === null ? '' : ` — Unavailable: ${problem}`}`}
    onClick={() => { if (!busy && problem === null) onChoose(); }}>
    <CapsuleContents preset={preset} presentation={presentation} title={<strong>{title}</strong>} named={name !== undefined} />
  </button>;
}

/**
 * A model's capsule in the chooser (C86, C118): a radio of the model group, named by the model and
 * described by its CLI's words, drawn as a preset's capsule is. The chosen one carries the chosen
 * level's marks on its avatar; the others carry none.
 */
export function ModelTile({ providerId, model, chosen, effort, fast = false, position, onChoose }: {
  readonly providerId: string;
  readonly model: CatalogModel;
  readonly chosen: boolean;
  /** The level chosen, drawn on the avatar of the chosen capsule only. */
  readonly effort: string | null;
  /** A speed tier is chosen: its marker, on the chosen capsule's avatar only. */
  readonly fast?: boolean;
  /** Its column and row, which the grid's arrow keys go by. */
  readonly position: string;
  readonly onChoose: () => void;
}) {
  return <button type="button" role="radio" aria-checked={chosen} tabIndex={chosen ? 0 : -1} aria-label={model.name} aria-description={model.description ?? undefined}
    title={[model.name, model.description].filter(Boolean).join(' — ')} className={`${styles.capsule} ${styles.tile}`} style={{ height: TILE_HEIGHT }}
    data-tile={position} data-model={model.key} onClick={onChoose}>
    <Avatar providerId={providerId} avatar={model.avatar} size="capsule" effort={chosen ? effort : null} fast={chosen && fast} />
    <span className={styles.capsuleText}><strong>{model.name}</strong>{model.description !== null && <small>{model.description}</small>}</span>
  </button>;
}
