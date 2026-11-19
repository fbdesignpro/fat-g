// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, type SyntheticEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import type { ModelPreset } from '@shared/contracts/presets';
import { modelSelectionKey } from '@shared/contracts/recent-models';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import dialogStyles from '../ui/Dialog.module.css';
import capsules from './Capsules.module.css';
import { TILE_HEIGHT, TILE_WIDTH } from './chooser-shape';
import { capsulePresentation } from './ModelCapsule';
import { choiceShape, ModelChooser, useModelChoice } from './ModelChooser';
import { PresetsCarousel } from './PresetsCarousel';
import { RecentModels } from './RecentModels';
import styles from './ModelDialog.module.css';

const FAILED = 'fat-g could not do that. Try again.';

export interface ModelDialogProps {
  /** The project whose providers and accounts are offered. */
  readonly projectId: string;
  readonly title: string;
  /** The selection it opens on; the preselection where a start would refuse it. */
  readonly initial: ModelPreset | null;
  readonly confirmLabel: string;
  /** Above the choice: what it is for. */
  readonly lead?: ReactNode;
  /** Under the choice, for the selection as it stands: what it spends, how it runs. */
  readonly details?: (preset: ModelPreset | null) => ReactNode;
  /** Whether to show the selected model summary beneath the chooser. */
  readonly showSelection?: boolean;
  /** Why the selection as it stands cannot be confirmed, from the app state; null where it can. */
  readonly check?: (preset: ModelPreset, snapshot: AppStateSnapshot | null) => string | null;
  /** Does what the dialog is for: null once done, and the dialog closes; else the problem, said in it. */
  readonly onConfirm: (preset: ModelPreset) => Promise<string | null>;
  /** Cancel, Escape or done. Whoever opened it unmounts it. */
  readonly onClose: () => void;
}

/** The five selection keys alone: a saved preset's name, or a recent's, goes nowhere. */
const keysOf = (preset: ModelPreset): ModelPreset => ({ providerId: preset.providerId, instanceId: preset.instanceId, model: preset.model, effort: preset.effort, speed: preset.speed });

/** The selection summary and the lines explaining what it will do. */
const UNDER = 128;
/** The least height the chooser is given, where the dialog is short: three capsules, its body scrolling. */
const LEAST_HEIGHT = 230;
/** Content, the grid/chooser and body's padding, and the dialog's border, bounded by the window. */
const dialogWidth = (content: string): string => `min(calc(${content} + 2 * var(--space-6) + 2 * var(--space-2) + 2px), 1200px, calc(100vw - 2 * var(--space-3)))`;
const SHORTCUT_WIDTH = dialogWidth(`${3 * TILE_WIDTH}px + 2 * var(--space-6)`);

/**
 * The chooser fits the window as the regular picker does. Use the frame's maximum height rather
 * than its content's current height, so measuring cannot repeatedly shrink the chooser.
 */
function chooserSpace(body: HTMLElement | null, above: HTMLElement | null): { readonly width: number; readonly height: number } {
  if (body === null || above === null) return { width: Math.min(1200, window.innerWidth - 24) - 2 * 24 - 16 - 2, height: Math.max(LEAST_HEIGHT, window.innerHeight - 300) };
  const style = getComputedStyle(body);
  // Shape against the available window, never the width just chosen for this content. Otherwise
  // a compact dialog narrows the next shape, and Show more cannot expand to full-size columns.
  const width = Math.min(1200, window.innerWidth - 24) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 16 - 2;
  const frame = body.closest('dialog');
  const top = frame === null ? 0 : parseFloat(getComputedStyle(frame).top) || 0;
  const headerHeight = frame?.querySelector('header')?.getBoundingClientRect().height ?? 0;
  // The centered dialog's current position depends on its content. Use its fixed top clearance
  // and maximum height instead, so reopening it does not successively reduce the row count.
  const height = Math.min(880, window.innerHeight - top - 16) - headerHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - above.getBoundingClientRect().height - UNDER;
  return { width, height: Math.max(LEAST_HEIGHT, height) };
}

/**
 * A model chosen for something that is not a new chat's draft — a reviewer, a new session an
 * integration makes (decision 0016). Presets, Recents and Custom start in columns, Custom opening the
 * regular chooser. Custom's selection is local: Cancel discards it and returns to the columns.
 * Only confirmation acts or touches a selected preset's recency.
 */
export function ModelDialog({ projectId, title, initial, confirmLabel, lead, details, showSelection = true, check, onConfirm, onClose }: ModelDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const done = useRef(false);
  const titleId = useId();
  const snapshot = useAppState((state) => state.snapshot);
  const presets = usePrefs((state) => state.snapshot?.values.presets);
  const providers = snapshot?.records?.projects.find((entry) => entry.kind === 'project' && entry.id === projectId);
  const project = { id: projectId, providers: providers?.kind === 'project' ? providers.providers : [] };
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [custom, setCustom] = useState(false);
  const [customWidth, setCustomWidth] = useState<number | null>(null);
  const customButton = useRef<HTMLButtonElement>(null);
  /** The saved preset whose capsule put the selection in place, while the selection is still its. */
  const [savedId, setSavedId] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const above = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState(() => chooserSpace(null, null));
  const choice = useModelChoice({ project, initial, onChange: () => setProblem(null) });
  const { preset } = choice;

  // Measure on entry and window resize. Observing the content would feed its own width/height
  // changes back into the shape, making a wrapping title repeatedly expand and shrink the dialog.
  useLayoutEffect(() => {
    const update = (): void => {
      const next = chooserSpace(body.current, above.current);
      setSpace((current) => (current.width === next.width && current.height === next.height ? current : next));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [custom]);

  // Opening focuses the selected shortcut; returning from Custom focuses its button.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    const opening = !element.open;
    if (opening) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    }
    if (!custom) {
      if (body.current !== null) body.current.scrollTop = 0;
      (opening ? element.querySelector<HTMLElement>('[aria-pressed="true"]') ?? customButton.current : customButton.current)?.focus();
    }
  }, [custom]);

  // Only closing the outer dialog notifies its caller. React bubbles `close` up its own tree.
  const closed = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.stopPropagation();
    if (!done.current && opener.current?.isConnected === true) opener.current.focus();
    onClose();
  };

  const cancel = (): void => {
    if (inFlight.current) return;
    setProblem(null);
    if (custom) setCustom(false);
    else dialog.current?.close();
  };

  const confirm = async (selected: ModelPreset | null): Promise<void> => {
    if (selected === null || inFlight.current || (check?.(selected, snapshot) ?? null) !== null) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const said = await onConfirm(keysOf(selected));
      if (said !== null) { setProblem(said); return; }
      const saved = savedId === null ? undefined : presets?.[savedId];
      if (savedId !== null && saved !== undefined && modelSelectionKey(saved) === modelSelectionKey(selected)) void patchPrefs({ usePreset: savedId }).catch(() => undefined);
      done.current = true;
      dialog.current?.close();
    } catch {
      setProblem(FAILED);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className={dialogStyles.dialog} style={{ width: custom && customWidth !== null ? dialogWidth(`${customWidth}px`) : SHORTCUT_WIDTH }} aria-labelledby={titleId} onClose={closed} onCancel={(event) => { event.preventDefault(); cancel(); }} data-model-dialog="">
      <header className={dialogStyles.header}>
        <h2 id={titleId} className={`${dialogStyles.title} ${styles.title}`}>{title}</h2>
      </header>
      <div ref={body} className={`${dialogStyles.body} ${styles.body}`}>
        <div ref={above}>{lead}</div>
        <div hidden={custom}>
          <div className={styles.shortcuts} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${TILE_WIDTH}px), ${TILE_WIDTH}px))` }}>
            <PresetsCarousel layout="column" providers={project.providers} busy={busy} selection={preset} onChoose={(chosen, id) => { choice.choose(keysOf(chosen)); setSavedId(id); return Promise.resolve(true); }} />
            <RecentModels layout="column" providers={project.providers} busy={busy} selection={preset} onChoose={(chosen) => { choice.choose(keysOf(chosen)); setSavedId(null); return Promise.resolve(true); }} />
            <section className={capsules.columnSection} aria-label="Custom">
              <h2>Custom</h2>
              <button ref={customButton} type="button" className={`${capsules.capsule} ${styles.customChoice}`} style={{ height: TILE_HEIGHT }} disabled={busy} onClick={() => { setProblem(null); setCustomWidth(null); setCustom(true); }}>Custom model &amp; effort</button>
            </section>
          </div>
        </div>
        {custom && <CustomChoice project={project} initial={preset} space={space} busy={busy} confirmLabel={confirmLabel} onConfirm={confirm} onCancel={cancel} onChange={() => setProblem(null)} onWidth={setCustomWidth}
          information={(selected) => <SelectionInfo preset={selected} snapshot={snapshot} providers={project.providers} details={details} showSelection={showSelection} check={check} problem={problem} />} check={check} snapshot={snapshot} />}
      </div>
      {!custom && <footer className={`${dialogStyles.footer} ${styles.footer}`}>
        <SelectionInfo preset={preset} snapshot={snapshot} providers={project.providers} details={details} showSelection={showSelection} check={check} problem={problem} />
        <div className={styles.actions}>
          <ConfirmButton preset={preset} busy={busy} blocked={preset !== null && (check?.(preset, snapshot) ?? null) !== null} label={confirmLabel} onConfirm={confirm} />
          <button type="button" className={dialogStyles.button} disabled={busy} onClick={cancel}>Cancel</button>
        </div>
      </footer>}
    </dialog>
  );
}

function ConfirmButton({ preset, busy, blocked, label, onConfirm }: {
  readonly preset: ModelPreset | null;
  readonly busy: boolean;
  readonly blocked: boolean;
  readonly label: string;
  readonly onConfirm: (preset: ModelPreset | null) => Promise<void>;
}) {
  return <button type="button" className={`${dialogStyles.button} ${dialogStyles.primary}`} aria-disabled={preset === null || busy || blocked || undefined} data-model-dialog-confirm="" onClick={() => void onConfirm(preset)}>{label}</button>;
}

/** Unmounting this screen discards its choices, including remembered accounts and expanded models. */
function CustomChoice({ project, initial, space, busy, confirmLabel, onConfirm, onCancel, onChange, onWidth, information, check, snapshot }: {
  readonly project: { readonly id: string; readonly providers: readonly string[] };
  readonly initial: ModelPreset | null;
  readonly space: { readonly width: number; readonly height: number };
  readonly busy: boolean;
  readonly confirmLabel: string;
  readonly onConfirm: (preset: ModelPreset | null) => Promise<void>;
  readonly onCancel: () => void;
  readonly onChange: () => void;
  readonly onWidth: (width: number) => void;
  readonly information: (preset: ModelPreset | null) => ReactNode;
  readonly check: ModelDialogProps['check'];
  readonly snapshot: AppStateSnapshot | null;
}) {
  const choice = useModelChoice({ project, initial, onChange });
  const shape = choiceShape(choice, space, false, 2);
  const screen = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { onWidth(shape.width); }, [shape.width, onWidth]);
  useLayoutEffect(() => {
    screen.current?.querySelector<HTMLElement>('[data-tile][aria-checked="true"], [data-model-dialog-confirm]')?.focus();
  }, []);
  return <div ref={screen}>
    <fieldset className={styles.chooser} disabled={busy} aria-label="Model and effort">
      <ModelChooser choice={choice} shape={shape} actions={<>
        <ConfirmButton preset={choice.preset} busy={busy} blocked={choice.preset !== null && (check?.(choice.preset, snapshot) ?? null) !== null} label={confirmLabel} onConfirm={onConfirm} />
        <button type="button" className={dialogStyles.button} disabled={busy} onClick={onCancel}>Cancel</button>
      </>} />
    </fieldset>
    {information(choice.preset)}
  </div>;
}

function SelectionInfo({ preset, snapshot, providers, details, showSelection, check, problem }: {
  readonly preset: ModelPreset | null;
  readonly snapshot: AppStateSnapshot | null;
  readonly providers: readonly string[];
  readonly details: ModelDialogProps['details'];
  readonly showSelection: boolean;
  readonly check: ModelDialogProps['check'];
  readonly problem: string | null;
}) {
  const presentation = preset === null ? null : capsulePresentation(preset, snapshot?.catalog, snapshot?.providers ?? [], providers);
  const blocked = preset === null ? null : check?.(preset, snapshot) ?? null;
  return <div className={styles.information}>
    {showSelection && <p className={styles.selection} data-model-dialog-selection="">{presentation === null ? 'No model available.' : `Selected: ${presentation.detail}${presentation.account === null ? '' : ` (${presentation.account})`}`}</p>}
    {details !== undefined && <div className={styles.lines}>{details(preset)}</div>}
    {blocked !== null && <p className={styles.blocked} role="status">{blocked}</p>}
    {problem !== null && <p className={styles.problem} role="alert">{problem}</p>}
  </div>;
}
