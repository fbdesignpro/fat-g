// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { TurnSpeed } from '@shared/contracts/conversation';
import { memo, type CSSProperties } from 'react';
import { findModel } from '@shared/contracts/catalog';
import { formatElapsed } from '@shared/contracts/sessions';
import { Avatar } from '../sessions/Avatar';
import { useSessionClock } from '../sessions/session-clock';
import { usePrefs } from '../state/prefs-store';
import { useAppState } from '../state/store';
import { useChatPresentation } from './presentation-store';
import type { Speaker, SpeakerTimer } from './speakers';
import styles from './SpeakerBar.module.css';

export interface SpeakerBarProps {
  readonly speaker: Speaker;
  readonly speed?: TurnSpeed | null | undefined;
  readonly modelName: string;
  readonly defaultModel: string;
  readonly providerId: string;
  readonly sessionId: string;
  readonly timer: SpeakerTimer;
  readonly nameModel?: ((key: string) => string) | undefined;
}

export const SPEAKER_WORDS = {
  /** A user's message that answers a question's card, sent as a prompt while the turn went on or to start one. */
  answer: (username: string) => `${username} (answer to question)`,
  received: (label: string) => `${label} (received by model)`,
  pendingReceipt: (label: string) => `${label} (sent, not read yet)`,
  queued: (label: string) => `${label} (from queue)`,
} as const;

export const SpeakerBar = memo(function SpeakerBar({ speaker, modelName, defaultModel, providerId, sessionId, timer, nameModel, speed }: SpeakerBarProps) {
  const username = usePrefs((state) => state.snapshot?.values.chat.username ?? 'You');
  const entry = useAppState((state) => state.snapshot?.sessions?.sessions.find((session) => session.record.id === sessionId));
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const projected = useChatPresentation((state) => state.sessionId === sessionId && speaker.model !== null ? state.value?.models[speaker.model] : undefined);
  const model = speaker.model ?? defaultModel;
  const found = entry === undefined ? null : findModel(catalog, entry.record, model);
  const avatar = projected !== undefined ? projected : model === entry?.summary.model ? entry.avatar : found?.avatar ?? null;
  const color = catalog?.providers.find((provider) => provider.id === providerId)?.presentation.barColor;
  const answerLabel = speaker.answer === true ? SPEAKER_WORDS.answer(username) : username;
  const userLabel = speaker.fromQueue === true ? SPEAKER_WORDS.queued(answerLabel) : answerLabel;
  const deliveryLabel = speaker.pendingReceipt === true ? SPEAKER_WORDS.pendingReceipt(userLabel) : speaker.received === true ? SPEAKER_WORDS.received(userLabel) : userLabel;
  const label = speaker.role === 'user' ? deliveryLabel : speaker.role === 'notice' ? 'fat-g' : model === defaultModel ? modelName : nameModel?.(model) ?? found?.name ?? model;
  if (speaker.role === 'notice') {
    return (
      <div className={styles.notice} data-speaker="" data-speaker-role="notice">
        <span className={styles.info} aria-hidden="true">i</span>
        <span className={styles.name} data-speaker-name="" title={label}>{label}</span>
      </div>
    );
  }
  return (
    <div className={styles.bar} data-speaker="" data-speaker-role={speaker.role} style={speaker.role === 'assistant' && color !== undefined ? { '--speaker-fill': color } as CSSProperties : undefined}>
      {speaker.role === 'assistant' && <span className={styles.avatar}><Avatar providerId={providerId} avatar={avatar} size="thin" /></span>}
      <span className={styles.name} data-speaker-name="" title={label}>{label}</span>
      {speaker.role === 'assistant' && speed != null && <span className={styles.speed} role="img" data-speaker-speed="" title={`${speed.name} requested for this reply; actual speed is not confirmed by this marker.`} aria-label={`${speed.name} requested`}>{/ultra/i.test(speed.name) || /ultra/i.test(speed.id) ? '⚡⚡⚡' : '⚡'}</span>}
      {speaker.role === 'assistant' && <TurnCounter timer={timer} wait={timer.turnId !== undefined && timer.turnId === entry?.summary.turnWait?.turnId ? entry.summary.turnWait : undefined} />}
    </div>
  );
}, (before, after) => before.speaker.role === after.speaker.role && before.speaker.model === after.speaker.model && before.speaker.answer === after.speaker.answer
  && before.speaker.interactive === after.speaker.interactive
  && before.speaker.pendingReceipt === after.speaker.pendingReceipt
  && before.speaker.received === after.speaker.received
  && before.speaker.fromQueue === after.speaker.fromQueue
  && before.speed?.id === after.speed?.id && before.speed?.name === after.speed?.name
  && before.modelName === after.modelName && before.defaultModel === after.defaultModel && before.providerId === after.providerId
  && before.sessionId === after.sessionId && before.nameModel === after.nameModel && before.timer.running === after.timer.running
  && before.timer.since === after.timer.since && before.timer.elapsedMs === after.timer.elapsedMs && before.timer.turnId === after.timer.turnId);

function TurnCounter({ timer, wait }: { readonly timer: SpeakerTimer; readonly wait: { readonly ms: number; readonly since: number | null } | undefined }) {
  const now = useSessionClock(timer.running && timer.since !== null && wait?.since == null);
  const elapsed = timer.running ? timer.since === null ? null : Math.max(0, (wait?.since ?? now) - timer.since - (wait?.ms ?? 0)) : timer.elapsedMs;
  const text = elapsed === null ? '—' : formatElapsed(elapsed);
  return <span className={styles.counter} data-turn-counter="" aria-label={elapsed === null ? 'Elapsed time unavailable' : `Elapsed time: ${text}`} title="Reply time, including tools; paused while waiting for your decision">{text}</span>;
}

export function TurnProgress() {
  return <div className={styles.progress} data-turn-progress="" role="img" aria-label="Reply in progress"><span /><span /><span /></div>;
}
