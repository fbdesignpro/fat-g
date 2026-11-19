// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { defaultPreset, presetTiles } from '@shared/contracts/presets';
import { sameInstance } from '@shared/contracts/instances';
import { normalizePresetName } from '@shared/contracts/names';
import type { SavedPreset } from '@shared/contracts/saved-presets';
import type { PreferencesPatch } from '@shared/contracts/prefs';
import { capsulePresentation, PresetPreview } from '../model-chooser/ModelCapsule';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { Section } from './Section';
import { PresetEditor } from './PresetEditor';
import styles from './PresetsSection.module.css';
import settings from './Settings.module.css';

interface Editing { readonly id: string; readonly value: SavedPreset }

/** Saved selections shown in the same capsules as the pickers, with their editor beside the list. */
export function PresetsSection() {
  const prefs = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  const app = useAppState((state) => state.snapshot);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const disabled = prefs === null || prefs.status.kind !== 'ok' || saving;
  const providers = app?.providers ?? [];
  const catalog = app?.catalog;
  const accounts = providers.filter((entry) => entry.descriptor.capabilities.sessions);
  const initial = defaultPreset(presetTiles(catalog, accounts.map((entry) => ({ providerId: entry.id, instanceId: entry.instanceId }))));

  const save = async (patch: NonNullable<PreferencesPatch['presets']>): Promise<void> => {
    setProblem(null);
    await patchPrefs({ presets: patch });
    const latest = usePrefs.getState();
    const applied = latest.snapshot?.status.kind === 'ok' && Object.entries(patch).every(([id, value]) => {
      const saved = latest.snapshot?.values.presets[id];
      return value === null ? saved === undefined : saved !== undefined && saved.name === normalizePresetName(value.name)
        && sameInstance(saved, value) && saved.model === value.model && saved.effort === value.effort && saved.speed === value.speed;
    });
    if (applied) setEditing(null);
    else setProblem('fat-g could not save the change.');
  };

  return (
    <Section section="presets">
      <p className={settings.muted}>Save a name for a model and effort on one account. Presets stay saved when their combination is unavailable.</p>
      <div className={settings.actions}>
        <button type="button" disabled={disabled || initial === null || editing !== null} onClick={() => {
          if (initial !== null) { setProblem(null); setEditing({ id: crypto.randomUUID(), value: { ...initial, name: '' } }); }
        }}>New preset</button>
      </div>
      {initial === null && <p className={settings.detail}>No account lists a model to choose yet. Saved presets can still be edited or deleted.</p>}
      {problem !== null && <p role="alert" className={settings.critical}>{problem}</p>}
      {editing !== null && <PresetEditor key={editing.id} value={editing.value} catalog={catalog} accounts={accounts} disabled={disabled}
        onSave={(value) => void save({ [editing.id]: value })} onCancel={() => { setEditing(null); setProblem(null); }} />}
      <div className={styles.list}>
        {Object.entries(prefs?.values.presets ?? {}).map(([id, preset]) => (
          <article key={id} className={styles.preset} aria-label={preset.name}>
            <PresetPreview preset={preset} presentation={capsulePresentation(preset, catalog, providers)} />
            <div className={settings.inlineActions}>
              <button type="button" disabled={disabled || editing !== null} onClick={() => { setProblem(null); setEditing({ id, value: preset }); }}>Edit</button>
              <button type="button" disabled={disabled || editing !== null} onClick={() => void save({ [id]: null })}>Delete</button>
            </div>
          </article>
        ))}
      </div>
      {Object.keys(prefs?.values.presets ?? {}).length === 0 && <p className={settings.detail}>No presets saved yet.</p>}
    </Section>
  );
}
