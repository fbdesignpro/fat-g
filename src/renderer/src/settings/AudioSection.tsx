// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';
import { ACTION_AUDIO_EVENTS, NOTIFICATION_AUDIO_EVENTS, AUDIO_LABELS } from '@shared/contracts/audio';
import { previewAudio, readAudio, useAudio } from '../audio/store';
import { invoke } from '../ipc/client';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { Section } from './Section';
import styles from './Settings.module.css';

export function AudioSection() {
  const snapshot = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  const { listing, problem } = useAudio();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => { void readAudio(); }, []);
  const disabled = snapshot?.status.kind !== 'ok' || saving;
  const audio = snapshot?.values.audio;
  // A square-law taper gives finer quiet-volume control; stored volume stays linear playback gain.
  const volumePercent = Math.round(Math.sqrt(audio?.volume ?? 0) * 100);
  const rescan = async (): Promise<void> => { setBusy(true); await readAudio(true); setBusy(false); };
  const open = async (): Promise<void> => {
    try { await invoke('shell:showDataFolder', { folder: 'audio' }); setFeedback('The audio folder was opened.'); }
    catch { setFeedback('The audio folder could not be opened.'); }
  };
  return (
    <Section section="audio">
      <div className={`${styles.fields} ${styles.compactPanel}`}>
        <div className={styles.statusRow}>
          <div>
            <span>Sound files</span>
            <p className={styles.statusLine}>Add WAV, MP3 or Ogg files up to 5 MiB to the audio folder, then Rescan. Missing defaults are copied at startup; existing files are kept.</p>
          </div>
          <span className={styles.inlineActions}>
            <button type="button" onClick={() => void open()}>Open audio data folder</button>
            <button type="button" disabled={busy} onClick={() => void rescan()}>Rescan</button>
          </span>
        </div>
        {audio !== undefined && <>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={audio.muted} disabled={disabled} onChange={(event) => void patchPrefs({ audio: { muted: event.target.checked } })} />
            <span>Mute all sounds</span>
          </label>
          <label className={styles.field}>
            <span>Volume — {volumePercent}%</span>
            <input aria-label="Audio volume" type="range" min="0" max="100" step="1" value={volumePercent} disabled={snapshot?.status.kind !== 'ok'}
              onChange={(event) => void patchPrefs({ audio: { volume: (Number(event.target.value) / 100) ** 2 } })} />
          </label>
          {[{ label: 'Actions', events: ACTION_AUDIO_EVENTS }, { label: 'Notifications', events: NOTIFICATION_AUDIO_EVENTS }].map((group) => (
            <fieldset key={group.label} className={styles.audioGroup}>
              <legend>{group.label}</legend>
              {group.events.map((event) => {
            const filename = audio.sounds[event];
            const file = listing?.files.find((candidate) => candidate.filename === filename);
            return <div key={event} className={styles.statusRow}>
              <label htmlFor={`audio-${event}`}>{AUDIO_LABELS[event]}</label>
              <span className={styles.inlineActions}>
                <select id={`audio-${event}`} value={filename ?? ''} disabled={disabled}
                  onChange={(change) => void patchPrefs({ audio: { sounds: { [event]: change.target.value || null } } })}>
                  <option value="">Off</option>
                  {filename !== null && file === undefined && <option value={filename}>{filename} (missing)</option>}
                  {listing?.files.map((candidate) => <option key={candidate.filename} value={candidate.filename}>{candidate.filename}</option>)}
                </select>
                <button type="button" data-audio="silent" aria-label={`Preview ${AUDIO_LABELS[event]}`} disabled={disabled || audio.muted || audio.volume === 0 || file === undefined}
                  onClick={() => { if (file !== undefined) previewAudio(file.id); }}>Preview</button>
              </span>
            </div>;
              })}
            </fieldset>
          ))}
        </>}
        {snapshot === null && <p className={styles.muted}>Loading your preferences…</p>}
        {audio?.muted === true && <p className={styles.muted}>Unmute to preview sounds.</p>}
        {listing?.unavailable === true && <p role="status">The audio folder is unavailable. Check the folder, then Rescan.</p>}
        {listing !== null && listing.problems > 0 && <p role="status">{listing.problems} audio {listing.problems === 1 ? 'file could' : 'files could'} not be used.</p>}
        {problem !== null && <p role="status">{problem}</p>}
        {feedback !== null && <p role="status">{feedback}</p>}
      </div>
    </Section>
  );
}
