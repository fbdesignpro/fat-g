// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId } from 'react';
import { type AttentionFlash, CREATION_ANIMATIONS, type CreationAnimation, DONE_ANIMATIONS, type DoneAnimation, FLASH_SECONDS, FLASH_SPEEDS, type FlashSeconds, type FlashSpeed, THEMES, type Theme } from '@shared/contracts/appearance';
import { PROJECT_COLUMN_SIDES, type ProjectColumnSide } from '@shared/contracts/prefs';
import { canZoom, DEFAULT_ZOOM, type ZoomChange } from '@shared/contracts/zoom';
import { invoke } from '../ipc/client';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { ZOOM_WORDS } from '../ui/zoom-text';
import { useKeptFocus } from './kept-focus';
import { Section } from './Section';
import styles from './Settings.module.css';

const THEME_LABELS: Readonly<Record<Theme, string>> = { light: 'Light', dark: 'Dark' };
const SIDE_LABELS: Readonly<Record<ProjectColumnSide, string>> = { right: 'Right', left: 'Left' };
const SPEED_LABELS: Readonly<Record<FlashSpeed, string>> = { slow: 'Slow', medium: 'Medium', fast: 'Fast' };
const DONE_LABELS: Readonly<Record<DoneAnimation, string>> = { none: 'None', 'animation-flash': 'Animation and flash', 'animation-only': 'Animation only' };
const CREATION_LABELS: Readonly<Record<CreationAnimation, string>> = { none: 'None', wipe: 'Wipe' };
const secondsLabel = (seconds: FlashSeconds): string => (seconds === 1 ? '1 second' : `${seconds} seconds`);

/**
 * The theme and the project column's side (C12, C13), which apply at once, in both windows; the
 * Main window's zoom, a step at a time, which main keeps rather than the preferences; the attention
 * flash; and optional message times. Turn durations always appear in the speaker bars.
 */
export function AppearanceSection() {
  const snapshot = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  return (
    <Section section="appearance">
      {snapshot === null ? (
        <p className={styles.muted}>Loading your preferences…</p>
      ) : (
        <div className={styles.fields}>
          <Choice
            legend="Theme"
            options={THEMES}
            labels={THEME_LABELS}
            value={snapshot.values.appearance.theme}
            disabled={snapshot.status.kind === 'read-only' || saving}
            onChange={(theme) => void patchPrefs({ appearance: { theme } })}
          />
          <ZoomChoice />
          <Choice
            legend="Project list"
            options={PROJECT_COLUMN_SIDES}
            labels={SIDE_LABELS}
            value={snapshot.values.layout.projectColumn}
            disabled={snapshot.status.kind === 'read-only' || saving}
            onChange={(projectColumn) => void patchPrefs({ layout: { projectColumn } })}
          />
          <FlashChoice flash={snapshot.values.appearance.flash} disabled={snapshot.status.kind === 'read-only' || saving} />
          <Choice legend="Done animation" options={DONE_ANIMATIONS} labels={DONE_LABELS} value={snapshot.values.appearance.doneAnimation}
            disabled={snapshot.status.kind === 'read-only' || saving} onChange={(doneAnimation) => void patchPrefs({ appearance: { doneAnimation } })} />
          <Choice legend="Creation animation" options={CREATION_ANIMATIONS} labels={CREATION_LABELS} value={snapshot.values.appearance.creationAnimation}
            disabled={snapshot.status.kind === 'read-only' || saving} onChange={(creationAnimation) => void patchPrefs({ appearance: { creationAnimation } })} />
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={snapshot.values.chat.messageTimes}
              disabled={snapshot.status.kind === 'read-only' || saving}
              onChange={(event) => void patchPrefs({ chat: { messageTimes: event.target.checked } })}
            />
            <span>
              Show message times
              <small className={styles.muted}>When fat-g received each message, beside its label: a time of day today, with the date on any other day.</small>
            </span>
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={snapshot.values.chat.hoverMessageTimes} disabled={snapshot.status.kind === 'read-only' || saving}
              onChange={(event) => void patchPrefs({ chat: { hoverMessageTimes: event.target.checked } })} />
            <span>Show message time on hover<small className={styles.muted}>Show a message’s time beside the hovered paragraph, in the main chat’s left margin.</small></span>
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={snapshot.values.chat.answerTimes} disabled={snapshot.status.kind === 'read-only' || saving}
              onChange={(event) => void patchPrefs({ chat: { answerTimes: event.target.checked } })} />
            <span>Show model answer times<small className={styles.muted}>Show start and end times below model answers.</small></span>
          </label>
        </div>
      )}
    </Section>
  );
}

/**
 * The Main window's zoom: − and + a step at a time, and Reset, applied as they are pressed
 * (src/main/windows/zoom.ts). Not a preference, so a read-only preferences file leaves it alone. At
 * an end its button is announced as unavailable but keeps the focus, so a key held on it stays put.
 */
function ZoomChoice() {
  const zoom = useAppState((state) => state.snapshot?.zoom) ?? DEFAULT_ZOOM;
  const can: Readonly<Record<ZoomChange, boolean>> = { out: canZoom(zoom, 'out'), in: canZoom(zoom, 'in'), reset: zoom !== DEFAULT_ZOOM };
  const change = (to: ZoomChange) => (): void => {
    if (!can[to]) return;
    // The app state brings the new zoom back; a call that fails leaves it as it was, shown.
    invoke('zoom:change', { to }).catch(() => undefined);
  };
  return (
    <fieldset className={`${styles.choice} ${styles.zoomChoice}`}>
      <legend>{ZOOM_WORDS.legend}</legend>
      <span className={styles.inlineActions}>
        <button type="button" aria-label={ZOOM_WORDS.zoomOut} aria-disabled={!can.out || undefined} onClick={change('out')}>−</button>
        <output className={styles.zoomValue}>{zoom}%</output>
        <button type="button" aria-label={ZOOM_WORDS.zoomIn} aria-disabled={!can.in || undefined} onClick={change('in')}>+</button>
        <button type="button" aria-disabled={!can.reset || undefined} onClick={change('reset')}>{ZOOM_WORDS.reset}</button>
      </span>
    </fieldset>
  );
}

/**
 * The attention flash (the maintainer): whether a session's status bar flashes inverted
 * when it turns to Ready or to anything else that waits on the user — in the Main window and the Pet
 * — and, beside it, how fast and for how long. Each applies at once; speed and duration wait while it
 * is off. Under the system's reduced motion it holds still for the duration instead.
 */
function FlashChoice({ flash, disabled }: { readonly flash: AttentionFlash; readonly disabled: boolean }) {
  const group = useKeptFocus(disabled);
  const change = (next: Partial<AttentionFlash>): void => void patchPrefs({ appearance: { flash: next } });
  return (
    <fieldset ref={group} className={styles.choice} disabled={disabled}>
      <legend>Attention flash</legend>
      <label className={styles.radio}>
        <input type="checkbox" checked={flash.enabled} onChange={(event) => change({ enabled: event.target.checked })} />
        Flash a session’s status when it needs you
      </label>
      <label className={styles.radio}>
        Speed
        <select value={flash.speed} disabled={!flash.enabled} onChange={(event) => change({ speed: FLASH_SPEEDS.find((speed) => speed === event.target.value) ?? flash.speed })}>
          {FLASH_SPEEDS.map((speed) => <option key={speed} value={speed}>{SPEED_LABELS[speed]}</option>)}
        </select>
      </label>
      <label className={styles.radio}>
        For
        <select value={flash.seconds} disabled={!flash.enabled} onChange={(event) => change({ seconds: FLASH_SECONDS.find((seconds) => String(seconds) === event.target.value) ?? flash.seconds })}>
          {FLASH_SECONDS.map((seconds) => <option key={seconds} value={seconds}>{secondsLabel(seconds)}</option>)}
        </select>
      </label>
    </fieldset>
  );
}

function Choice<T extends string>({ legend, options, labels, value, disabled, onChange }: {
  readonly legend: string;
  readonly options: readonly T[];
  readonly labels: Readonly<Record<T, string>>;
  readonly value: T;
  readonly disabled: boolean;
  readonly onChange: (value: T) => void;
}) {
  const name = useId();
  // Disabled while its choice is saved: the focus an arrow key had in it is given back once it is not.
  const group = useKeptFocus(disabled);
  return (
    <fieldset ref={group} className={styles.choice} disabled={disabled}>
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option} className={styles.radio}>
          <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
          {labels[option]}
        </label>
      ))}
    </fieldset>
  );
}
