// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { limitPresetNameInput, normalizePresetName } from '@shared/contracts/names';
import type { ModelPreset } from '@shared/contracts/presets';
import { modelSelectionKey } from '@shared/contracts/recent-models';
import type { SavedPreset } from '@shared/contracts/saved-presets';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import dialogStyles from '../ui/Dialog.module.css';
import { capsulePresentation, PresetPreview } from './ModelCapsule';
import styles from './SavePresetDialog.module.css';

/** Naming a fixed selection: Cancel writes nothing; saving reports the exact preset main kept. */
export function SavePresetDialog({ preset, providers, onSaved, onClose }: {
  readonly preset: ModelPreset;
  readonly providers: readonly string[];
  readonly onSaved: (id: string, preset: ModelPreset) => void;
  readonly onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const inFlight = useRef(false);
  const [id] = useState(() => crypto.randomUUID());
  const titleId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const prefs = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  const app = useAppState((state) => state.snapshot);
  const disabled = busy || saving || prefs === null || prefs.status.kind !== 'ok';
  const saved: SavedPreset = { name: normalizePresetName(name), providerId: preset.providerId, instanceId: preset.instanceId, model: preset.model, effort: preset.effort, speed: preset.speed };

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    input.current?.focus();
  }, []);

  const cancel = (): void => {
    if (!inFlight.current) dialog.current?.close();
  };

  const save = async (): Promise<void> => {
    if (disabled || inFlight.current || saved.name === '') return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await patchPrefs({ presets: { [id]: saved } });
      const latest = usePrefs.getState().snapshot;
      const held = latest?.values.presets[id];
      if (latest?.status.kind !== 'ok' || held === undefined || held.name !== saved.name || modelSelectionKey(held) !== modelSelectionKey(saved)) {
        setProblem('fat-g could not save this preset. Try again.');
        return;
      }
      onSaved(id, preset);
    } catch {
      setProblem('fat-g could not save this preset. Try again.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return createPortal(<dialog ref={dialog} className={`${dialogStyles.dialog} ${styles.dialog}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); cancel(); }}
    onClose={(event) => { event.stopPropagation(); onClose(); if (opener.current?.isConnected === true) opener.current.focus(); }}>
    <header className={dialogStyles.header}><h2 id={titleId} className={dialogStyles.title}>Save as preset</h2></header>
    <form className={styles.form} aria-label="Name preset" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); void save(); }}>
      <div className={dialogStyles.body}>
        <div className={styles.preview}>
          <PresetPreview preset={saved} presentation={capsulePresentation(preset, app?.catalog, app?.providers ?? [], providers)} nameField={
            <input ref={input} className={styles.name} aria-label="Preset name" aria-description="Up to 18 characters." title="Up to 18 characters" placeholder="Preset name" autoComplete="off" maxLength={4096} value={name} disabled={disabled}
              onChange={(event) => { setName(limitPresetNameInput(event.target.value)); setProblem(null); }} />
          } />
        </div>
        {problem !== null && <p className={styles.problem} role="alert">{problem}</p>}
      </div>
      <footer className={dialogStyles.footer}>
        <button type="submit" className={`${dialogStyles.button} ${dialogStyles.primary}`} disabled={disabled || saved.name === ''}>Save and apply</button>
        <button type="button" className={dialogStyles.button} disabled={busy} onClick={cancel}>Cancel</button>
      </footer>
    </form>
  </dialog>, document.body);
}
