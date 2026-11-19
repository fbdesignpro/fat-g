// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useId, useRef, useState } from 'react';
import type { BusyEnter } from '@shared/contracts/composer';
import { POLL_INTERVAL_SEC } from '@shared/contracts/prefs';
import { normalizeName } from '@shared/contracts/names';
import { patchPrefs, usePrefs } from '../state/prefs-store';
import { Section } from './Section';
import styles from './Settings.module.css';

/** What the busy Enter setting is called, and its two values (M23, C80). */
export const BUSY_ENTER_WORDS = {
  label: 'While a reply is in progress, “Enter”',
  help: 'The other is on Ctrl+Enter. Send now adds your message to the current reply; Queue sends it once the chat and its sub-agents have finished.',
  values: { 'send-now': 'sends now', queue: 'queues' } satisfies Record<BusyEnter, string>,
} as const;

/** Masking the email, showing the Pet, how often usage is checked, whether a new session's title is asked for, and what Enter does while a turn runs. */
export function GeneralSection() {
  const snapshot = usePrefs((state) => state.snapshot);
  const saving = usePrefs((state) => state.saving);
  return (
    <Section section="general">
      {snapshot === null ? (
        <p className={styles.muted}>Loading your preferences…</p>
      ) : (
        <GeneralControls
          maskEmail={snapshot.values.privacy.maskEmail}
          petVisible={snapshot.values.windows.pet.visible}
          petAutoHide={snapshot.values.windows.pet.autoHideOnMainFocus}
          pollIntervalSec={snapshot.values.usage.pollIntervalSec}
          generatedTitles={snapshot.values.titles.generated}
          busyEnter={snapshot.values.composer.busyEnter}
          username={snapshot.values.chat.username}
          disabled={snapshot.status.kind === 'read-only' || saving}
        />
      )}
    </Section>
  );
}

interface ControlsProps {
  readonly maskEmail: boolean;
  readonly petVisible: boolean;
  readonly petAutoHide: boolean;
  readonly pollIntervalSec: number;
  readonly generatedTitles: boolean;
  readonly busyEnter: BusyEnter;
  readonly username: string | null;
  readonly disabled: boolean;
}

function GeneralControls({ maskEmail, petVisible, petAutoHide, pollIntervalSec, generatedTitles, busyEnter, username, disabled }: ControlsProps) {
  const busyHelpId = useId();
  const intervalHelpId = useId();
  // The interval is kept as a draft while it is being typed: patching on every keystroke would
  // clamp "5" to 60 before the second digit arrived.
  const [draft, setDraft] = useState(String(pollIntervalSec));
  // When main saves a different value than was typed — a clamp, or a change from elsewhere — show
  // what was saved. Adjusted during render rather than in an effect, which would render twice
  // (https://react.dev/learn/you-might-not-need-an-effect).
  const [shownFor, setShownFor] = useState(pollIntervalSec);
  if (shownFor !== pollIntervalSec) {
    setShownFor(pollIntervalSec);
    setDraft(String(pollIntervalSec));
  }

  const commitInterval = (): void => {
    const seconds = Number(draft);
    if (Number.isFinite(seconds) && draft.trim() !== '') void patchPrefs({ usage: { pollIntervalSec: Math.round(seconds) } });
    else setDraft(String(pollIntervalSec));
  };

  return (
    <div className={`${styles.fields} ${styles.compactPanel}`}>
      <Username value={username} disabled={disabled} />
      <h3 className={styles.generalOptionsTitle}>General Options</h3>

      {/* Main follows this preference (src/main/windows/window-manager.ts); the Pet's own × turns it off. */}
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={petVisible}
          disabled={disabled}
          onChange={(event) => void patchPrefs({ windows: { pet: { visible: event.target.checked } } })}
        />
        <span>
          Show the mini window
          <small className={styles.muted}>A small window that stays above the others with your sessions that are running or waiting on you, by name under their projects. It never shows your email or organization.</small>
        </span>
      </label>

      <label className={`${styles.checkbox} ${styles.subOption}`}>
        <input
          type="checkbox"
          checked={petAutoHide}
          disabled={disabled}
          onChange={(event) => void patchPrefs({ windows: { pet: { autoHideOnMainFocus: event.target.checked } } })}
        />
        <span>
          Automatically hide when the main window is in focus
          <small className={styles.muted}>The mini window returns when you switch away from the main window.</small>
        </span>
      </label>

      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={maskEmail}
          disabled={disabled}
          onChange={(event) => void patchPrefs({ privacy: { maskEmail: event.target.checked } })}
        />
        <span>
          Mask the account email in the usage panel
          <small className={styles.muted}>Shows u•••@example.com instead of the full address when you point at a usage block. Settings always shows it in full.</small>
        </span>
      </label>

      {/* M26 (decision 0028): the secretary is asked, at a session's first prompt, through the session's own account. */}
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={generatedTitles}
          disabled={disabled}
          onChange={(event) => void patchPrefs({ titles: { generated: event.target.checked } })}
        />
        <span>
          Name sessions automatically
          <small className={styles.muted}>After a session’s first prompt, its own account writes it a short title, with no tool and nothing saved; this uses a little of your plan. A name you type is never replaced. Off, a session is named by its first prompt.</small>
        </span>
      </label>

      {/* M23 (C37, C80): what Enter does while a turn runs, the other on Ctrl+Enter. */}
      <div className={styles.sentenceSetting}>
        <label className={styles.sentenceField}>
          <span>{BUSY_ENTER_WORDS.label}</span>
          <select aria-describedby={busyHelpId} value={busyEnter} disabled={disabled} onChange={(event) => void patchPrefs({ composer: { busyEnter: event.target.value as BusyEnter } })}>
            <option value="send-now">{BUSY_ENTER_WORDS.values['send-now']}</option>
            <option value="queue">{BUSY_ENTER_WORDS.values.queue}</option>
          </select>
        </label>
        <small id={busyHelpId} className={styles.muted}>{BUSY_ENTER_WORDS.help}</small>
      </div>

      <div className={styles.sentenceSetting}>
        <label className={styles.sentenceField}>
          <span>Check usage every</span>
          <span className={styles.withUnit}>
            <input
              type="number"
              aria-describedby={intervalHelpId}
              inputMode="numeric"
              min={POLL_INTERVAL_SEC.min}
              max={POLL_INTERVAL_SEC.max}
              step={30}
              value={draft}
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitInterval}
            />
            seconds
          </span>
        </label>
        <small id={intervalHelpId} className={styles.muted}>
          Between {POLL_INTERVAL_SEC.min} and {POLL_INTERVAL_SEC.max} seconds. Anything outside that is brought back inside it.
        </small>
      </div>
    </div>
  );
}

function Username({ value, disabled }: { readonly value: string | null; readonly disabled: boolean }) {
  const pending = useRef<string | null | undefined>(undefined);
  const [draft, setDraft] = useState(value ?? '');
  const [shownFor, setShownFor] = useState(value);
  if (shownFor !== value) { setShownFor(value); setDraft(value ?? ''); }
  const commit = (): void => {
    const next = normalizeName(draft) || null;
    setDraft(next ?? '');
    if (next !== value && pending.current !== next) {
      pending.current = next;
      void patchPrefs({ chat: { username: next } }).finally(() => { pending.current = undefined; });
    }
  };
  return (
    <div className={styles.username}>
      <h2 className={styles.usernameTitle}><label htmlFor="chat-username">Your name</label></h2>
      <p id="chat-username-description" className={styles.muted}>Your name in chat. Leave blank to show “You”. Kept on this computer only.</p>
      <input id="chat-username" aria-describedby="chat-username-description" type="text" value={draft} placeholder="You" maxLength={4096} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
    </div>
  );
}
