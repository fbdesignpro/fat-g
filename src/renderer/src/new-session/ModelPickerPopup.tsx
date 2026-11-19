// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelPreset } from '@shared/contracts/presets';
import { modelSelectionKey } from '@shared/contracts/recent-models';
import { choiceShape, ModelChooser, useModelChoice } from '../model-chooser/ModelChooser';
import { SavePresetDialog } from '../model-chooser/SavePresetDialog';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import styles from './ModelPicker.module.css';

/** Distance from the column it opens beside, and the least distance kept from the window's edges. */
const GAP = 4;
const MARGIN = 8;
/**
 * What the popup adds to its chooser: its padding and border, plus its title's line downwards.
 * The chooser includes its action rows above Effort.
 */
const FRAME = { width: 2 * 12 + 2, height: 2 * 12 + 2 + 28 };

/** What the popup needs to place and size itself. Measured from the DOM in the app; tests replace it. */
export interface PopupSpace {
  /** The button it came from, on screen. */
  readonly anchor: { readonly top: number; readonly left: number; readonly right: number };
  /** The column the button stands in, on screen: the popup opens beside it, toward the work area (C79). */
  readonly column: { readonly left: number; readonly right: number };
  readonly window: { readonly width: number; readonly height: number };
  /** Where the page begins below the title strip. */
  readonly top: number;
}

export type MeasurePopup = (anchor: HTMLElement) => PopupSpace;

export const measurePopup: MeasurePopup = (anchor) => {
  const rect = anchor.getBoundingClientRect();
  const column = anchor.closest('aside')?.getBoundingClientRect() ?? rect;
  return {
    anchor: { top: rect.top, left: rect.left, right: rect.right },
    column: { left: column.left, right: column.right },
    window: { width: window.innerWidth, height: window.innerHeight },
    top: document.querySelector('header')?.getBoundingClientRect().bottom ?? 0,
  };
};

const NOT_APPLIED = 'fat-g could not apply this selection. Your draft is still here.';

export interface ModelPickerPopupProps {
  readonly project: { readonly id: string; readonly name: string; readonly providers: readonly string[] };
  /** The selection it opens on; the preselection where a start would refuse it. */
  readonly value: ModelPreset | null;
  /** Takes the selection: true once it holds, and the popup closes. */
  readonly onApply: (preset: ModelPreset) => Promise<boolean>;
  readonly onClose: () => void;
  /** The button that opened it: the popup is placed beside it, and the focus goes back to it. */
  readonly anchor: RefObject<HTMLElement | null>;
  readonly measure?: MeasurePopup;
}

/**
 * The model picker (M14, Design 8; C79, C83, C87, C119): the model chooser in a popup beside the
 * button it came from, with Apply and Save as preset, disabled for a saved combination. Enter applies
 * unless the Save as preset button has focus; Escape and a press
 * anywhere else close it with nothing applied and the focus back on its button. It never scrolls: it
 * is as large as its chooser needs.
 */
export function ModelPickerPopup({ project, anchor, measure = measurePopup, value, onApply, onClose }: ModelPickerPopupProps) {
  const popup = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState<PopupSpace | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [naming, setNaming] = useState<ModelPreset | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const prefs = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  const choice = useModelChoice({ project, initial: value, onChange: () => { setRefusal(null); setSavedId(null); } });
  const { preset } = choice;
  const canSave = preset !== null && !Object.values(prefs?.values.presets ?? {}).some((saved) => modelSelectionKey(saved) === modelSelectionKey(preset));

  useLayoutEffect(() => {
    const update = (): void => {
      if (anchor.current !== null) setSpace(measure(anchor.current));
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchor, measure]);

  const close = (): void => {
    onClose();
    anchor.current?.focus();
  };

  // A press anywhere else closes it, with nothing applied and the focus back on its button (C87).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (naming !== null || inFlight.current) return;
      const target = event.target instanceof Node ? event.target : null;
      if (popup.current?.contains(target) === true || anchor.current?.contains(target) === true) return;
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [anchor, onClose, naming]);

  // Opening moves the focus to the chosen model, or to the popup itself when there is none to choose.
  const placed = space !== null;
  useEffect(() => {
    if (!placed) return;
    (popup.current?.querySelector<HTMLElement>('[data-tile][aria-checked="true"]') ?? popup.current)?.focus();
  }, [placed]);

  const apply = async (selection: ModelPreset | null = preset, usedId: string | null = savedId): Promise<void> => {
    if (selection === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setRefusal(null);
    try {
      if (await onApply(selection)) {
        const saved = usedId === null ? undefined : usePrefs.getState().snapshot?.values.presets[usedId];
        if (usedId !== null && saved !== undefined && modelSelectionKey(saved) === modelSelectionKey(selection)) void patchPrefs({ usePreset: usedId }).catch(() => undefined);
        onClose();
      }
      else setRefusal(NOT_APPLIED);
    } catch {
      setRefusal(NOT_APPLIED);
    }
    inFlight.current = false;
    setBusy(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (naming !== null || inFlight.current) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Enter') {
      if (event.target === saveButton.current) return;
      // Enter applies from the chooser, once (C87); the save button keeps its native activation.
      event.preventDefault();
      void apply();
    }
  };

  const available = space === null ? null : { width: space.window.width - 2 * MARGIN - FRAME.width, height: space.window.height - space.top - 2 * MARGIN - FRAME.height };
  const shape = available === null ? null : choiceShape(choice, available, false, 2);
  const size = shape === null ? null : { width: shape.width + FRAME.width, height: shape.height + FRAME.height };
  const position = space === null || size === null ? null : place(space, size);

  return createPortal(
    <><div
      ref={popup}
      role="dialog"
      aria-label="Choose model"
      tabIndex={-1}
      className={styles.popup}
      data-model-picker={project.id}
      style={position === null || size === null ? { visibility: 'hidden' } : { left: position.left, top: position.top, width: size.width }}
      onKeyDown={onKeyDown}
    >
      <h2 className={styles.title}>Choose model</h2>
      {shape !== null && <ModelChooser choice={choice} shape={shape} actions={<>
        <button type="button" className={styles.apply} disabled={preset === null || busy} onClick={() => void apply()}>Apply</button>
        <button ref={saveButton} type="button" className={styles.savePreset} disabled={!canSave || busy || saving || prefs === null || prefs.status.kind !== 'ok'} onClick={() => { if (canSave && preset !== null) setNaming(preset); }}>Save as preset</button>
      </>} />}
      {refusal !== null && (
        <p className={styles.refusal} role="alert">
          {refusal}
        </p>
      )}
    </div>
    {naming !== null && <SavePresetDialog preset={naming} providers={project.providers} onClose={() => { setNaming(null); if (saveButton.current?.isConnected !== true || saveButton.current.disabled) popup.current?.focus(); }}
      onSaved={(id, selected) => { setNaming(null); setSavedId(id); void apply(selected, id); }} />}
    </>,
    document.body,
  );
}

/** Beside its button, on the work area's side of the column it stands in, inside the window below the title strip (C79). */
function place(space: PopupSpace, size: { readonly width: number; readonly height: number }): { readonly left: number; readonly top: number } {
  const columnOnRight = space.column.left >= space.window.width / 2;
  const wanted = columnOnRight ? space.column.left - GAP - size.width : space.column.right + GAP;
  const left = Math.max(MARGIN, Math.min(wanted, space.window.width - size.width - MARGIN));
  const top = Math.max(space.top + MARGIN, Math.min(space.anchor.top, space.window.height - size.height - MARGIN));
  return { left, top };
}
