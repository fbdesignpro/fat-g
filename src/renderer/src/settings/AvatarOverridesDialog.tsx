// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, useId, useState } from 'react';
import { avatarAssignmentKey, type AvatarAssignmentMode } from '@shared/contracts/avatar-targets';
import { type ActiveFamilies, type Assignments, AVATAR_WORDS, type AvatarListing, avatarProblemWords, type AvatarRef, type AvatarView, type FamilyView, matchViewText, type ResolvedAvatar, sameRef } from '@shared/contracts/avatars';
import type { CatalogModel, CatalogProvider } from '@shared/contracts/catalog';
import { providerTiles } from '@shared/contracts/presets';
import type { ProviderSnapshot } from '@shared/contracts/status';
import { CloseIcon } from '../control-bar/icons';
import { Avatar } from '../sessions/Avatar';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import dialogStyles from '../ui/Dialog.module.css';
import { AssignAvatarPopup, type AssignTarget } from './AssignAvatarPopup';
import { activeFamilyOf, familyMatch, findInListing, resolvedOf, twinFamily } from './avatar-listing';
import { unreported } from './ProviderModels';
import { useSettingsDialog } from './settings-dialog';
import styles from './Settings.module.css';
import { ASSIGNMENT_WORDS } from './avatar-assignment-words';

/** A row of the popup (C18, C19): a model by its key, and the avatar its provider's assignments give it. */
export interface AssignmentRow {
  readonly key: string;
  readonly modelKey: string;
  readonly resolvedId: string | null;
  readonly mode: AvatarAssignmentMode;
  readonly name: string;
  /**
   * `listed`, a model an account offers; `hidden`; and, greyed, `folded`, a listed default another row
   * stands for, and `unlisted`, a key no account lists now.
   */
  readonly kind: 'listed' | 'hidden' | 'folded' | 'unlisted' | 'other';
  /** A folded row's: the name of the row that resolves to the same model. */
  readonly sameAs: string | null;
  /** The user's override under this key. */
  readonly ref: AvatarRef | null;
  /** What the model draws and why, as main resolved it; null for a key no account lists. */
  readonly drawn: ResolvedAvatar | null;
}

/**
 * A provider's rows (C18, C19): every model any of its accounts lists, once by key, in the first
 * listing account's order — the tiles, the listed default folded as the New session popup folds it
 * (M14, C118) — then the hidden ones; then every key of its assignments with no row above, a folded
 * listed default by its name and any other by its key. The keys are compared with the rows drawn, as
 * the title model's choice compares its own (M26).
 */
export function assignmentRows(entries: readonly CatalogProvider[], assignments: Readonly<Record<string, AvatarRef>>, mode: AvatarAssignmentMode = 'key'): AssignmentRow[] {
  const rows = new Map<string, AssignmentRow>();
  const add = (model: CatalogModel, kind: 'listed' | 'hidden'): void => {
    const key = avatarAssignmentKey(model, mode);
    if (!rows.has(key)) rows.set(key, { key, modelKey: model.key, resolvedId: model.resolvedId, mode, name: model.name, kind, sameAs: null, ref: assignments[key] ?? null, drawn: model.avatar });
  };
  for (const entry of entries) for (const model of providerTiles(entry)) add(model, 'listed');
  for (const entry of entries) for (const model of entry.models) if (model.hidden) add(model, 'hidden');
  for (const [key, ref] of Object.entries(assignments)) {
    if (rows.has(key)) continue;
    const folded = foldedRow(entries, key);
    const models = entries.flatMap((entry) => entry.models);
    const model = models.find((candidate) => candidate.key === key)
      ?? models.find((candidate) => candidate.resolvedId === key && !candidate.listedDefault)
      ?? models.find((candidate) => candidate.resolvedId === key);
    const otherMode = model?.key === key ? 'key' : 'version';
    const identity: Pick<AssignmentRow, 'key' | 'modelKey' | 'resolvedId' | 'mode' | 'ref'> = { key, modelKey: model?.key ?? key, resolvedId: model?.resolvedId ?? null, mode: otherMode, ref };
    // A folded row draws what the row that stands for it draws; a key no account lists, nothing main resolved.
    rows.set(key, folded !== null
      ? { ...identity, name: folded.model.name, kind: 'folded', sameAs: folded.tile.name, drawn: folded.tile.avatar }
      : { ...identity, name: model?.name ?? key, kind: model === undefined ? 'unlisted' : 'other', sameAs: null, drawn: model?.avatar ?? null });
  }
  return [...rows.values()];
}

/** A listed-default row the tiles leave out for the row that resolves to the same model (M14, C118). */
function foldedRow(entries: readonly CatalogProvider[], key: string): { readonly model: CatalogModel; readonly tile: CatalogModel } | null {
  for (const entry of entries) {
    const model = entry.models.find((candidate) => candidate.key === key && candidate.listedDefault);
    const tile = model === undefined ? undefined : providerTiles(entry).find((candidate) => candidate !== model && candidate.resolvedId === model.resolvedId);
    if (model !== undefined && tile !== undefined) return { model, tile };
  }
  return null;
}

const NO_ASSIGNMENTS: Assignments = {};
const NO_ACTIVE: ActiveFamilies = {};

/** The move Up, Down, Home and End make in a list of `count`, from `at`; -1 for any other key. */
function moved(key: string, at: number, count: number): number {
  if (key === 'ArrowDown') return Math.min(count - 1, at + 1);
  if (key === 'ArrowUp') return Math.max(0, at - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

/** The less common per-model overrides live in a separate modal over family selection. */
export function AvatarOverridesDialog({ provider, listing, onClose }: {
  readonly provider: ProviderSnapshot | null;
  readonly listing: AvatarListing | null;
  readonly onClose: () => void;
}) {
  const titleId = useId();
  const { dialog, onDialogClose } = useSettingsDialog(provider !== null, onClose);
  return (
    <dialog ref={dialog} className={dialogStyles.dialog} aria-labelledby={titleId} onClose={onDialogClose} data-avatar-overrides={provider?.id}>
      {provider !== null && <>
        <header className={dialogStyles.header}>
          <h2 id={titleId} className={styles.familyAssignmentTitle}>{ASSIGNMENT_WORDS.overrideDialogTitle(provider.displayName)}</h2>
          <button type="button" className={dialogStyles.closeButton} aria-label={ASSIGNMENT_WORDS.close} onClick={() => dialog.current?.close()}><CloseIcon /></button>
        </header>
        <div className={dialogStyles.body}><Overrides provider={provider} listing={listing} /></div>
      </>}
    </dialog>
  );
}

/** Override content is made afresh at each opening. */
function Overrides({ provider, listing }: { readonly provider: ProviderSnapshot; readonly listing: AvatarListing | null }) {
  const prefs = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [assigning, setAssigning] = useState<AssignTarget | null>(null);
  const [assignmentMode, setAssignmentMode] = useState<AvatarAssignmentMode>('key');
  const baseId = useId();

  const assignments = prefs?.values.avatars.assignments ?? NO_ASSIGNMENTS;
  const active = prefs?.values.avatars.active ?? NO_ACTIVE;
  const entries = catalog?.providers.filter((entry) => entry.id === provider.id) ?? [];
  const rows = assignmentRows(entries, assignments[provider.id] ?? {}, assignmentMode);
  const selectedRow = rows.find((row) => row.key === selectedKey) ?? rows[0];
  const disabled = prefs === null || prefs.status.kind === 'read-only' || saving;
  const rowId = (index: number): string => `${baseId}-row-${index}`;

  const chooseMode = (mode: AvatarAssignmentMode): void => {
    if (selectedRow !== undefined) setSelectedKey(avatarAssignmentKey({ key: selectedRow.modelKey, resolvedId: selectedRow.resolvedId }, mode));
    setAssignmentMode(mode);
  };

  /** One patch of one model's override (C6): a press of Clear or Assign avatar. What main saved says whether it was. */
  const save = (changed: Readonly<Record<string, AvatarRef | null>>): void => {
    setFailed(false);
    void patchPrefs({ avatars: { assignments: { [provider.id]: changed } } }).then(() => {
      const { snapshot, error } = usePrefs.getState();
      const saved = snapshot?.values.avatars.assignments[provider.id] ?? {};
      const differs = Object.entries(changed).some(([key, ref]) => {
        const held = saved[key] ?? null;
        return ref === null ? held !== null : held === null || !sameRef(held, ref);
      });
      if (error !== null || differs) setFailed(true);
    });
  };

  /** Clear disables itself, with nothing left to clear: the focus goes to the row it acted on, or to Assign by where the row goes. */
  const clear = (row: AssignmentRow): void => {
    const leaves = row.kind === 'folded' || row.kind === 'unlisted';
    document.getElementById(leaves ? `${baseId}-assign-by` : rowId(rows.indexOf(row)))?.focus();
    save({ [row.key]: null });
  };

  const onRowsKey = (event: KeyboardEvent<HTMLElement>): void => {
    const index = moved(event.key, selectedRow === undefined ? 0 : rows.indexOf(selectedRow), rows.length);
    const next = rows[index];
    if (next === undefined) return;
    event.preventDefault();
    setSelectedKey(next.key);
    document.getElementById(rowId(index))?.focus();
  };

  const activeFamily = listing === null ? undefined : activeFamilyOf(listing, provider.id, active[provider.id]);
  return (
    <section className={styles.assignmentModels} data-avatar-override-content={provider.id}>
      <p className={styles.muted}>{ASSIGNMENT_WORDS.overrideHelp}</p>
      <div className={styles.assignmentBar}>
        <h4 id={`${baseId}-models-title`} className={styles.assignmentModelsTitle} data-models-title="">{ASSIGNMENT_WORDS.detectedModels(provider.displayName)}</h4>
        <span className={styles.inlineActions}>
          <button type="button" disabled={disabled || selectedRow === undefined} onClick={() => { if (selectedRow !== undefined) setAssigning({ providerId: provider.id, key: selectedRow.key, name: selectedRow.name }); }}>
            {ASSIGNMENT_WORDS.assign}
          </button>
          <button type="button" disabled={disabled || selectedRow?.ref == null} onClick={() => { if (selectedRow !== undefined) clear(selectedRow); }}>
            {ASSIGNMENT_WORDS.clear}
          </button>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className={styles.muted} data-assignment-unreported="">{unreported(provider.status.kind)}</p>
      ) : (
        <ul className={styles.assignmentList} role="listbox" aria-labelledby={`${baseId}-models-title`} onKeyDown={onRowsKey}>
          {rows.map((row, index) => (
            <AssignmentRowView key={row.key} id={rowId(index)} row={row} providerId={provider.id} listing={listing} activeFamily={activeFamily} selected={row === selectedRow} onSelect={() => setSelectedKey(row.key)} />
          ))}
        </ul>
      )}
      <label className={styles.familyControl}>
        <span>{ASSIGNMENT_WORDS.assignBy}</span>
        <select id={`${baseId}-assign-by`} disabled={disabled} value={assignmentMode} onChange={(event) => chooseMode(event.target.value === 'version' ? 'version' : 'key')}>
          <option value="key">{ASSIGNMENT_WORDS.byKey}</option>
          <option value="version">{ASSIGNMENT_WORDS.byVersion}</option>
        </select>
      </label>
      <p className={styles.muted}>{ASSIGNMENT_WORDS.bindingHelp}</p>
      {failed && <p className={styles.feedback} role="status">{ASSIGNMENT_WORDS.saveFailed}</p>}
      <AssignAvatarPopup
        listing={listing}
        target={assigning}
        assignments={assignments}
        onAssign={(target, ref) => save({ [target.key]: ref })}
        onClose={() => setAssigning(null)}
      />
    </section>
  );
}

/**
 * A model's row (C20–C22; decision 0031): what it draws at 30 px — as main resolved it, or for a key no
 * account lists the override itself — or an empty dashed box where it draws nothing, its name, then in
 * the muted colour its marks, its override with what keeps it from being drawn, and why it draws what
 * it does. No path and no account label.
 */
function AssignmentRowView({ id, row, providerId, listing, activeFamily, selected, onSelect }: {
  readonly id: string;
  readonly row: AssignmentRow;
  readonly providerId: string;
  readonly listing: AvatarListing | null;
  readonly activeFamily: FamilyView | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  // Told by the thumbnail itself when its files failed to draw (M102, C9): main is not told.
  const [failed, setFailed] = useState(false);
  const found = row.ref === null || listing === null ? undefined : findInListing(listing, row.ref);
  const words = rowWords(row, providerId, listing, activeFamily, found, failed);
  // An override the listing holds but cannot draw stands as the placeholder, as main would draw past it.
  const thumbnail = row.drawn ?? (found === undefined ? undefined : resolvedOf(found.family, found.view));
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={[row.name, ...words].join(', ')}
      tabIndex={selected ? 0 : -1}
      className={styles.assignmentRow}
      data-assignment-row={row.key}
      data-greyed={row.kind === 'folded' || row.kind === 'unlisted' ? '' : undefined}
      onClick={onSelect}
    >
      {thumbnail === undefined ? (
        <span className={styles.assignmentEmpty} data-assignment-empty="" aria-hidden="true" />
      ) : (
        <Avatar providerId={providerId} avatar={thumbnail} size="thin" onFailed={setFailed} />
      )}
      <span className={styles.assignmentName} title={row.name}>{row.name}</span>
      {words.length > 0 && <span className={styles.assignmentWords}>{words.join(' · ')}</span>}
    </li>
  );
}

/**
 * A row's words (C19–C21; decision 0031): its mark; then its override's family and name, and why it is
 * not drawn; then, where it draws something else, why — the family's match and the entry that won, its
 * face, the built-in face.
 */
function rowWords(row: AssignmentRow, providerId: string, listing: AvatarListing | null, activeFamily: FamilyView | undefined, found: { readonly family: FamilyView; readonly view: AvatarView } | undefined, failed: boolean): string[] {
  const words: string[] = [];
  if (row.kind === 'hidden') words.push(ASSIGNMENT_WORDS.hidden);
  if (row.kind === 'other') words.push(row.mode === 'version' ? ASSIGNMENT_WORDS.byVersion : ASSIGNMENT_WORDS.byKey);
  if (row.kind === 'unlisted') words.push(ASSIGNMENT_WORDS.notListed);
  if (row.kind === 'folded' && row.sameAs !== null) words.push(ASSIGNMENT_WORDS.sameModel(row.sameAs));
  const named = (ref: AvatarRef): string => {
    const origin = listing !== null && twinFamily(listing, ref.family) ? ` ${ref.origin === 'built-in' ? ASSIGNMENT_WORDS.builtIn : ASSIGNMENT_WORDS.yours}` : '';
    return `${ref.family}${origin} / ${ref.avatar}`;
  };
  if (row.ref !== null) {
    words.push(`${ASSIGNMENT_WORDS.sources.override}: ${named(row.ref)}`);
    // Until the listing is read, nothing is said of whether it holds the avatar.
    if (listing !== null && found === undefined) words.push(ASSIGNMENT_WORDS.notFound);
    else if (found !== undefined && resolvedOf(found.family, found.view) === null) {
      const problem = found.view.problems.find((candidate) => candidate.kind === 'no-portrait');
      words.push(avatarProblemWords(problem ?? { kind: 'no-portrait', path: `${found.family.folder}/${found.view.folder}` }));
    }
  }
  // What main resolved instead of an override, or past one it could not draw.
  const drawn = row.drawn;
  if (drawn?.source !== undefined && drawn.source !== 'override') {
    const entry = drawn.source === 'match' && activeFamily !== undefined ? familyMatch(activeFamily, providerId, { key: row.modelKey, resolvedId: row.resolvedId })?.entry : undefined;
    words.push(`${ASSIGNMENT_WORDS.sources[drawn.source]}: ${named(drawn.ref)}${entry === undefined ? '' : ` (${matchViewText(entry)})`}`);
  }
  if (failed) words.push(AVATAR_WORDS.couldNotDraw);
  return words;
}
