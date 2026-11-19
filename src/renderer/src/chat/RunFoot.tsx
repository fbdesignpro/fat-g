// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { memo, type RefObject, useEffect } from 'react';
import { CHAT_LINES } from '@shared/contracts/chat';
import { type ConversationItem, itemText } from '@shared/contracts/conversation';
import { formatElapsed } from '@shared/contracts/sessions';
import { useCoarseClock } from '../sessions/session-clock';
import { CopyButton } from '../ui/CopyButton';
import { formatAgo, formatDayTime, formatTimeOfDay, startOfDay } from '../ui/format';
import styles from './Chat.module.css';
import { watchRunOver } from './run-over';

const DAY_MS = 86_400_000;

/** When an answer's turn ran, as its speaker's bar counts it, with its end where it ended and that is known. */
export interface RunTimes {
  readonly running: boolean;
  /** The prompt's acceptance, else the provider's start. */
  readonly since: number | null;
  readonly endedAt: number | null;
  /** How long it took, as its bar says it: waits for the user's own decisions left out. */
  readonly elapsedMs: number | null;
}

export const RUN_WORDS = {
  started: (ago: string): string => `started ${ago}`,
  completed: (ago: string): string => `completed ${ago}`,
} as const;

/** A time of today by its time of day alone; of another day, with its date, its year only where it is not this one. */
const when = (at: number, now: number): string => {
  const today = startOfDay(now);
  return at >= today && at < today + DAY_MS ? formatTimeOfDay(at) : formatDayTime(at, now);
};

/**
 * What an answer's foot says of its time (the maintainer): "8:53 AM → 8:55 AM (2m32s) ·
 * completed 5 minutes ago", and while it runs "8:53 AM · started 5 minutes ago". Only what is known:
 * a turn that never said its end has its start alone, and none is invented. Null when nothing is known.
 */
export function runTimeLine({ running, since, endedAt, elapsedMs }: RunTimes, now: number): string | null {
  if (running || endedAt === null) {
    if (since === null) return null;
    return running ? `${when(since, now)} · ${RUN_WORDS.started(formatAgo(since, now))}` : when(since, now);
  }
  const took = elapsedMs === null ? '' : ` (${formatElapsed(elapsedMs)})`;
  const end = since !== null && startOfDay(since) === startOfDay(endedAt) ? formatTimeOfDay(endedAt) : when(endedAt, now);
  return `${since === null ? '' : `${when(since, now)} → `}${end}${took} · ${RUN_WORDS.completed(formatAgo(endedAt, now))}`;
}

export interface RunFootProps extends RunTimes {
  readonly showTime?: boolean;
  /** The answer's messages, in order: every part of its text, which its Copy button copies. */
  readonly messages: readonly ConversationItem[];
  /** The answer holds the keyboard's current entry: its Copy button is a stop, as that entry's own controls are. */
  readonly current: boolean;
  /** All messages of this list's conversation, read only at the press. */
  readonly copyConversation?: () => Promise<string>;
}

/**
 * The foot of an answer — a model's run, from its speaker's bar to the next bar (the maintainer):
 * when it ran and how long ago, and a Copy button for all of its text, where a message's
 * own copies only the part it stands beside. One small row in the space the answer leaves below it,
 * shown while the pointer is anywhere over the answer (`useRunOver`) or the keyboard is in it
 * (Chat.module.css). Not on a prompt, which is one message and has its own. The time is read again
 * every half minute.
 */
export const RunFoot = memo(function RunFoot({ messages, current, copyConversation, showTime = true, ...times }: RunFootProps) {
  const now = useCoarseClock();
  const line = showTime ? runTimeLine(times, now) : null;
  if (line === null && messages.length === 0) return null;
  return (
    <div className={styles.runFoot} data-run-foot="" data-current-run={current ? '' : undefined}>
      {line !== null && <span className={styles.runTime}>{line}</span>}
      {messages.length > 0 && copyConversation !== undefined && <CopyButton look="conversation" label={CHAT_LINES.copyConversation} text={copyConversation} tabIndex={current ? 0 : -1} />}
      {messages.length > 0 && <CopyButton look="icon" label={CHAT_LINES.copyAnswer} text={() => messages.map(itemText).join('\n\n')} tabIndex={current ? 0 : -1} />}
    </div>
  );
});

/**
 * Marks the foot of the answer under the pointer, solid from the top of its speaker's bar to the
 * foot (run-over.ts), for as long as the list is drawn.
 */
export function useRunOver(list: RefObject<HTMLElement | null>): void {
  useEffect(() => (list.current === null ? undefined : watchRunOver(list.current)), [list]);
}
