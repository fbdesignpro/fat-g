// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { CatalogModel, CatalogProvider } from '@shared/contracts/catalog';
import { type InstanceRef, instanceKey, sameInstance } from '@shared/contracts/instances';
import { checkPreset, defaultPreset, effortFor, type ModelPreset, offeredInstances, preselectPreset, presetOffer, presetTiles, resolveTileKey, speedFor, type TileGroup } from '@shared/contracts/presets';
import { useAppState } from '../state/store';
import { effortExplanation, effortText } from '../ui/effort-text';
import { EffortWarning } from '../ui/EffortWarning';
import { SPEED_MARK, speedExplanation, speedRefusal, speedText } from '../ui/speed-text';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import { ACCOUNT_HEIGHT, ACCOUNT_WIDTH, chooserShape, type ChooserShape, columnLeft, HEADING_GAP, HEADING_HEIGHT, LEVEL_HEIGHT, LEVELS_GAP, LEVELS_WIDTH, spanWidth, TILE_GAP } from './chooser-shape';
import { ModelTile } from './ModelCapsule';
import styles from './ModelChooser.module.css';

export const NO_MODELS_REASON = 'This account’s CLI has not reported its models yet, so no session can start on it.';

/** One of a provider's switched-on accounts, as the chooser offers it (M14b, C45, C70). */
export interface Account {
  readonly ref: InstanceRef;
  readonly label: string;
  /** Its models; null for an account whose CLI has not reported them. */
  readonly group: TileGroup | null;
}

/** A provider's part of the chooser: its accounts, and the one whose models its columns list. */
export interface ProviderBlock {
  readonly providerId: string;
  readonly accounts: readonly Account[];
  readonly chosen: Account & { readonly group: TileGroup };
}

/** How an arrow key moves among the capsules: columns across, rows down. */
const GRID_STEPS: Readonly<Record<string, readonly [x: number, y: number]>> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
const LIST_STEPS: Readonly<Record<string, number>> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };

/** A selection in the making: what the chooser shows, and what changes it. */
export interface ModelChoice {
  /** What would be taken now: the one picked while a start would still take it, else the preselection (C83). */
  readonly preset: ModelPreset | null;
  readonly blocks: readonly ProviderBlock[];
  /** One group a provider: the models of its chosen account. */
  readonly groups: readonly TileGroup[];
  /** The chosen model, from its account's list. */
  readonly model: CatalogModel | undefined;
  readonly columnsShown: Readonly<Record<string, number>>;
  readonly showMoreModels: (group: TileGroup, columns: number) => void;
  readonly providerName: (providerId: string) => string;
  /** Puts a whole selection in place, as a capsule offering one does: its account becomes its provider's. */
  readonly choose: (preset: ModelPreset) => void;
  readonly chooseModel: (group: TileGroup, tile: CatalogModel) => void;
  readonly chooseAccount: (account: Account) => void;
  readonly chooseEffort: (effort: string) => void;
  /** A speed tier the chosen model lists, or null for standard speed (decision 0016). */
  readonly chooseSpeed: (speed: string | null) => void;
}

/**
 * The selection a chooser holds, for a project's providers that are switched on in Settings (C54),
 * and of those the instances that are (M14b, C30). It starts at `initial`, or the preselection of the
 * project's newest session (C83) when that would be refused. `onChange` hears every choice the user
 * makes.
 */
export function useModelChoice({ project, initial, onChange }: {
  readonly project: { readonly id: string; readonly providers: readonly string[] };
  readonly initial: ModelPreset | null | undefined;
  readonly onChange?: () => void;
}): ModelChoice {
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const providers = useAppState((state) => state.snapshot?.providers);
  const sessions = useAppState((state) => state.snapshot?.sessions?.sessions);
  const [picked, setPicked] = useState<ModelPreset | null>(initial ?? null);
  /** The account last chosen for each provider, for the columns of a provider the preset does not name. */
  const [accountOf, setAccountOf] = useState<Readonly<Record<string, string>>>({});
  const [columnsShown, setColumnsShown] = useState<Readonly<Record<string, number>>>({});

  const offer = presetOffer(project.providers, providers ?? []);
  const preselected = preselectPreset({ catalog, offer, projectId: project.id, sessions: (sessions ?? []).map((entry) => entry.record) });
  const preset = picked !== null && checkPreset(catalog, offer, picked).ok ? picked : preselected;
  const blocks = providerBlocks(offeredInstances(offer), (ref) => presetTiles(catalog, [ref])[0] ?? null, (ref) => providers?.find((provider) => sameInstance({ providerId: provider.id, instanceId: provider.instanceId }, ref))?.label ?? '', preset, accountOf);
  const groups = blocks.map((block) => block.chosen.group);
  const model = preset === null ? undefined : groups.find((group) => sameInstance(groupRef(group), preset))?.tiles.find((tile) => tile.key === preset.model);

  const take = (next: ModelPreset): void => {
    onChange?.();
    setPicked(next);
    setAccountOf((current) => ({ ...current, [next.providerId]: next.instanceId }));
  };

  return {
    preset,
    blocks,
    groups,
    model,
    columnsShown,
    showMoreModels: (group, columns) => setColumnsShown((current) => ({ ...current, [instanceKey(group.provider)]: columns })),
    providerName: (id) => providers?.find((provider) => provider.id === id)?.displayName ?? id,
    choose: take,
    // The level stays when the new model lists it (C85), and so does the speed tier (decision 0016).
    chooseModel: (group, tile) => take({ ...groupRef(group), model: tile.key, effort: effortFor(tile, preset?.effort ?? null), speed: speedFor(tile, preset?.speed ?? null) }),
    /**
     * Choosing an account makes the preset name it (M14b, C46): the chosen model is kept when that
     * account lists it, else its default by the chooser's own rule, and the effort and the speed tier
     * follow as they do for a change of model.
     */
    chooseAccount: (account) => {
      if (account.group === null) return;
      const kept = preset !== null && preset.providerId === account.ref.providerId ? resolveTileKey(account.group.provider, preset.model) : null;
      const next = kept !== null ? { ...account.ref, model: kept.key, effort: effortFor(kept, preset?.effort ?? null), speed: speedFor(kept, preset?.speed ?? null) } : defaultPreset([account.group]);
      if (next === null) return;
      // The level a default brings gives way to the one in force, when the model lists it (C85).
      const tile = account.group.tiles.find((candidate) => candidate.key === next.model);
      take(tile === undefined ? next : { ...next, effort: effortFor(tile, preset?.effort ?? null), speed: speedFor(tile, preset?.speed ?? null) });
    },
    chooseEffort: (effort) => { if (preset !== null) take({ ...preset, effort }); },
    chooseSpeed: (speed) => { if (preset !== null) take({ ...preset, speed }); },
  };
}

/** The chooser's shape for this choice, in the space whatever holds it can give it; `scrolls` where that can scroll. */
export function choiceShape(choice: ModelChoice, available: { readonly width: number; readonly height: number }, scrolls = false, actionRows = 0): ChooserShape {
  // A model that lists a speed tier has its row, or its Standard row and a row a tier, under the levels.
  const levels = Math.max(0, ...choice.groups.flatMap((group) => group.tiles.map((tile) => tile.efforts.length + (tile.speedTiers.length === 0 ? 0 : tile.speedTiers.length === 1 ? 1 : tile.speedTiers.length + 1))));
  // Each action is 32 px high with an 8 px gap, including the gap before Effort.
  const actionsHeight = actionRows * 40;
  const limits = choice.groups.map((group) => choice.columnsShown[instanceKey(group.provider)] ?? 1);
  const measure = () => chooserShape(choice.groups.map((group) => group.tiles.length), { ...available, height: available.height - actionsHeight }, levels,
    choice.blocks.map((block) => (block.accounts.length > 1 ? block.accounts.length : 0)), scrolls, limits);
  let shape = measure();
  // A saved selection can name a model beyond the first column. Keep it visible on opening,
  // account changes and resize, without changing the selection or the catalog's order.
  const selectedGroup = choice.groups.findIndex((group) => choice.preset !== null && sameInstance(groupRef(group), choice.preset));
  const selectedIndex = choice.groups[selectedGroup]?.tiles.findIndex((tile) => tile.key === choice.preset?.model) ?? -1;
  while (selectedGroup >= 0 && selectedIndex >= shape.rows * (limits[selectedGroup] ?? 1)) {
    limits[selectedGroup] = Math.floor(selectedIndex / shape.rows) + 1;
    shape = measure();
  }
  const actionsTop = actionRows === 0 ? 0 : HEADING_HEIGHT + HEADING_GAP + shape.band - 32;
  return { ...shape, height: Math.max(shape.height, HEADING_HEIGHT + HEADING_GAP + levels * LEVEL_HEIGHT + actionsHeight + actionsTop) };
}

/**
 * The model chooser (M14, Design 8; C82, C86, C118): a provider's accounts, its models as capsules in
 * columns under its name, revealed one at a time by Show more, and the chosen model's levels on the right — the selection alone, which
 * whatever holds it applies. One tab stop for each group; the arrow keys move and choose.
 *
 * A provider with more than one switched-on account shows a button for each under its name (M14b,
 * C44–C46, C70): they choose whose models its columns list and which account the preset names.
 */
export function ModelChooser({ choice, shape, actions }: { readonly choice: ModelChoice; readonly shape: ChooserShape; readonly actions?: ReactNode }) {
  const effortId = useId();
  const { blocks, groups, preset, model } = choice;
  if (groups.length === 0) return <><p className={styles.empty}>Models are listed once a provider’s CLI reports them.</p>{actions !== undefined && <div className={styles.actions}>{actions}</div>}</>;
  return (
    <div className={styles.grids}>
      <div className={styles.modelsArea}>
        {/* Before the capsules, as they are drawn: the accounts are chosen first. */}
        {blocks.map((block, index) => block.accounts.length > 1 && (
          <AccountButtons
            key={block.providerId}
            block={block}
            name={choice.providerName(block.providerId)}
            left={columnLeft(shape.columns.findIndex((column) => column.group === index), shape.tileWidth)}
            width={spanWidth(shape.columns.filter((column) => column.group === index).length, shape.tileWidth)}
            height={shape.band}
            onChoose={choice.chooseAccount}
          />
        ))}
        <ModelGrid choice={choice} shape={shape} />
      </div>
      {/* The primary action ends where the first capsule starts, including any account band. */}
      <div className={styles.levels} style={{ width: LEVELS_WIDTH, marginLeft: LEVELS_GAP, marginTop: actions === undefined ? 0 : HEADING_HEIGHT + HEADING_GAP + shape.band - 32, '--selection-color': groups.find((group) => preset !== null && sameInstance(groupRef(group), preset))?.provider.presentation.barColor } as CSSProperties}>
        {actions !== undefined && <div className={styles.actions}>{actions}</div>}
        <div className={styles.heading} id={effortId}>Effort</div>
        {model === undefined || model.efforts.length === 0 ? (
          <p className={styles.none}>No effort levels</p>
        ) : (
          <EffortGrid model={model} chosen={preset?.effort ?? null} labelledBy={effortId} onChoose={choice.chooseEffort} />
        )}
        {model !== undefined && preset !== null && <SpeedChoice model={model} account={groups.find((group) => sameInstance(groupRef(group), preset))?.provider} chosen={preset.speed} onChoose={choice.chooseSpeed} />}
      </div>
    </div>
  );
}

/** The instance a group's models are of. */
const groupRef = (group: TileGroup): { readonly providerId: string; readonly instanceId: string } => ({ providerId: group.provider.id, instanceId: group.provider.instanceId });

/**
 * The providers the chooser shows, each with its switched-on accounts and the one that is chosen: the
 * preset's, for the provider the preset names; else the one last chosen; else the first that lists a
 * model. A provider none of whose accounts lists a model is left out (C118).
 */
function providerBlocks(
  instances: readonly InstanceRef[],
  groupOf: (ref: InstanceRef) => TileGroup | null,
  labelOf: (ref: InstanceRef) => string,
  preset: ModelPreset | null,
  remembered: Readonly<Record<string, string>>,
): ProviderBlock[] {
  const ids = [...new Set(instances.map((ref) => ref.providerId))];
  return ids.flatMap((providerId): ProviderBlock[] => {
    const accounts = instances.filter((ref) => ref.providerId === providerId).map((ref): Account => ({ ref, label: labelOf(ref), group: groupOf(ref) }));
    const listing = accounts.filter((account): account is Account & { group: TileGroup } => account.group !== null);
    const wanted = preset !== null && preset.providerId === providerId ? preset.instanceId : remembered[providerId];
    const chosen = listing.find((account) => wanted !== undefined && sameInstance(account.ref, { providerId, instanceId: wanted })) ?? listing[0];
    return chosen === undefined ? [] : [{ providerId, accounts, chosen }];
  });
}

/**
 * A provider's accounts, under its name (M14b, C45, C70): a radio group by label with one tab stop,
 * placed over the band the shape keeps for it. The arrow keys move among the accounts and choose the
 * one they reach. An account whose CLI has not reported its models keeps its button, dimmed: a press
 * or an arrow does not choose it, and a tooltip, which is its description, says why.
 */
function AccountButtons({ block, name, left, width, height, onChoose }: {
  readonly block: ProviderBlock;
  readonly name: string;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly onChoose: (account: Account) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = LIST_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    // Keep the capsules' own arrows out of it.
    event.stopPropagation();
    const buttons = [...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const at = buttons.findIndex((button) => button === document.activeElement);
    const index = ((at === -1 ? 0 : at) + step + buttons.length) % buttons.length;
    const account = block.accounts[index];
    buttons[index]?.focus();
    if (account !== undefined) onChoose(account);
  };
  return (
    <div ref={group} role="radiogroup" aria-label={`${name} account`} className={styles.accounts} style={{ left, top: HEADING_HEIGHT, width, height }} data-accounts={block.providerId} onKeyDown={onKeyDown}>
      {block.accounts.map((account) => (
        <AccountButton key={account.ref.instanceId} account={account} chosen={sameInstance(account.ref, block.chosen.ref)} onChoose={() => onChoose(account)} />
      ))}
    </div>
  );
}

function AccountButton({ account, chosen, onChoose }: { readonly account: Account; readonly chosen: boolean; readonly onChoose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useTooltip();
  const listing = account.group !== null;
  return (
    <>
      <button
        ref={button}
        type="button"
        role="radio"
        aria-checked={chosen}
        aria-disabled={!listing || undefined}
        tabIndex={chosen ? 0 : -1}
        className={styles.account}
        style={{ width: ACCOUNT_WIDTH, height: ACCOUNT_HEIGHT }}
        data-account={account.ref.instanceId}
        onClick={onChoose}
        {...(listing ? {} : tooltip.targetProps)}
      >
        <span className={styles.accountName}>{account.label}</span>
      </button>
      {!listing && (
        <Tooltip id={tooltip.id} open={tooltip.open} anchor={button}>
          {NO_MODELS_REASON}
        </Tooltip>
      )}
    </>
  );
}

/**
 * The model capsules (C118, C86): a radio group with one tab stop, in the shape's columns, each
 * provider starting a column under its name. The arrow keys move and choose: up and down within a
 * column, sideways between columns.
 */
function ModelGrid({ choice, shape }: { readonly choice: ModelChoice; readonly shape: ChooserShape }) {
  const grid = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ readonly providerId: string; readonly model: string } | null>(null);
  const { groups, preset } = choice;
  const columns = shape.columns.flatMap((column) => {
    const group = groups[column.group];
    return group === undefined ? [] : [{ ...column, owner: group, tiles: group.tiles.slice(column.from, column.from + column.count) }];
  });
  const isChosen = (group: TileGroup, tile: CatalogModel): boolean => preset !== null && sameInstance(groupRef(group), preset) && preset.model === tile.key;

  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    pendingFocus.current = null;
    const found = [...(grid.current?.querySelectorAll<HTMLElement>('[data-model]') ?? [])].find((tile) => tile.dataset.model === pending.model && tile.closest<HTMLElement>('[data-column]')?.dataset.column === pending.providerId);
    found?.focus();
  }, [shape]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('[data-show-more]') !== null) return;
    const step = GRID_STEPS[event.key];
    if (step === undefined) return;
    const focused = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tile]')?.dataset.tile : undefined;
    const at = columns.flatMap((column, x) => column.tiles.map((tile, y) => ({ x, y, chosen: isChosen(column.owner, tile) }))).find((cell) => focused === undefined ? cell.chosen : `${cell.x}:${cell.y}` === focused);
    if (at === undefined) return;
    event.preventDefault();
    const x = Math.max(0, Math.min(columns.length - 1, at.x + step[0]));
    const column = columns[x];
    if (column === undefined) return;
    const y = Math.max(0, Math.min(column.tiles.length - 1, at.y + step[1]));
    const tile = column.tiles[y];
    if (tile === undefined) return;
    choice.chooseModel(column.owner, tile);
    grid.current?.querySelector<HTMLElement>(`[data-tile="${x}:${y}"]`)?.focus();
  };

  return (
    <div ref={grid} role="radiogroup" aria-label="Model" className={styles.models} style={{ gap: TILE_GAP }} onKeyDown={onKeyDown}>
      {columns.map((column, x) => (
        <div key={`${instanceKey(column.owner.provider)}:${column.from}`} className={styles.column} style={{ width: shape.tileWidth, '--selection-color': column.owner.provider.presentation.barColor } as CSSProperties} data-column={column.owner.provider.id}>
          <div className={styles.heading}>{column.first ? choice.providerName(column.owner.provider.id) : ' '}</div>
          {/* The account buttons' band (M14b, C45): kept in every column, so the capsules start level. */}
          {shape.band > 0 && <div style={{ height: shape.band }} data-account-band="" />}
          <div className={styles.tiles} style={{ gap: TILE_GAP }}>
            {column.tiles.map((tile, y) => (
              <ModelTile key={tile.key} providerId={column.owner.provider.id} model={tile} chosen={isChosen(column.owner, tile)} effort={preset?.effort ?? null} fast={preset?.speed != null} position={`${x}:${y}`}
                onChoose={() => choice.chooseModel(column.owner, tile)} />
            ))}
          </div>
          {column.from + column.count < column.owner.tiles.length && columns[x + 1]?.group !== column.group && (
            <button type="button" className={styles.showMore} data-show-more="" aria-label={`Show more ${choice.providerName(column.owner.provider.id)} models`}
              onKeyDown={(event) => { if (event.key === 'Enter') event.stopPropagation(); }}
              onClick={() => {
                const next = column.owner.tiles[column.from + column.count];
                if (next !== undefined) pendingFocus.current = { providerId: column.owner.provider.id, model: next.key };
                choice.showMoreModels(column.owner, columns.filter((one) => one.group === column.group).length + 1);
              }}>Show more</button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The chosen model's levels by label, in the catalog's order (C82, C86); a level that warns carries
 * its mark, says why on hover and to assistive technology, and once chosen says it in words under them.
 */
function EffortGrid({ model, chosen, labelledBy, onChoose }: { readonly model: CatalogModel; readonly chosen: string | null; readonly labelledBy: string; readonly onChoose: (effort: string) => void }) {
  const group = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = LIST_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const at = model.efforts.findIndex((effort) => effort.id === chosen);
    const next = model.efforts[(at + step + model.efforts.length) % model.efforts.length];
    if (next === undefined) return;
    onChoose(next.id);
    group.current?.querySelector<HTMLElement>(`[data-effort="${next.id}"]`)?.focus();
  };
  return (
    <>
      <div ref={group} role="radiogroup" aria-labelledby={labelledBy} className={styles.efforts} onKeyDown={onKeyDown}>
        {model.efforts.map((effort) => (
          <button
            key={effort.id}
            type="button"
            role="radio"
            aria-checked={effort.id === chosen}
            aria-description={effortExplanation(effort)}
            title={effortExplanation(effort)}
            tabIndex={effort.id === chosen ? 0 : -1}
            className={styles.level}
            data-effort={effort.id}
            data-caution={effort.caution || undefined}
            data-warning={effort.warning === undefined ? undefined : ''}
            onClick={() => onChoose(effort.id)}
          >
            {effortText(effort)}
          </button>
        ))}
      </div>
      <EffortWarning effort={model.efforts.find((effort) => effort.id === chosen)} />
    </>
  );
}

/**
 * The chosen model's speed tiers under its levels (decision 0016; the maintainer): one tier
 * is a checkbox, "⚡ Fast"; two or more a radio row, Standard and each tier. What a tier costs is said
 * on hover and to assistive technology, and once chosen in words under it, as a level's warning is. An
 * account fat-g cannot ask for a tier keeps the control, disabled, saying why.
 */
function SpeedChoice({ model, account, chosen, onChoose }: {
  readonly model: CatalogModel;
  readonly account: CatalogProvider | undefined;
  readonly chosen: string | null;
  readonly onChoose: (speed: string | null) => void;
}) {
  const labelId = useId();
  const tiers = model.speedTiers;
  if (tiers.length === 0) return null;
  const refused = speedRefusal(account?.speedTierRequest);
  const picked = tiers.find((tier) => tier.id === chosen);
  const said = picked === undefined ? undefined : picked.warning ?? picked.description ?? undefined;
  const [only] = tiers;
  return (
    <div className={styles.speed} data-speed-choice="">
      {tiers.length === 1 && only !== undefined ? (
        <label className={styles.speedRow} title={refused ?? speedExplanation(only)}>
          <input type="checkbox" checked={chosen === only.id} disabled={refused !== null} aria-description={refused ?? speedExplanation(only)} data-speed={only.id} onChange={(event) => onChoose(event.target.checked ? only.id : null)} />
          <span>{SPEED_MARK} {only.name}</span>
        </label>
      ) : (
        <div role="radiogroup" aria-labelledby={labelId} className={styles.speedRows} title={refused ?? undefined}>
          <span id={labelId} className={styles.speedHeading}>Speed</span>
          <label className={styles.speedRow}>
            <input type="radio" name={labelId} checked={chosen === null} disabled={refused !== null} data-speed="" onChange={() => onChoose(null)} />
            <span>Standard</span>
          </label>
          {tiers.map((tier) => (
            <label key={tier.id} className={styles.speedRow} title={refused ?? speedExplanation(tier)}>
              <input type="radio" name={labelId} checked={chosen === tier.id} disabled={refused !== null} aria-description={refused ?? speedExplanation(tier)} data-speed={tier.id} onChange={() => onChoose(tier.id)} />
              <span>{speedText(tier)}</span>
            </label>
          ))}
        </div>
      )}
      {refused !== null && <p className={styles.speedNote}>{refused}</p>}
      {refused === null && picked !== undefined && said !== undefined && <p className={styles.speedNote} data-speed-warning="">{speedText(picked)}: {said}</p>}
    </div>
  );
}
