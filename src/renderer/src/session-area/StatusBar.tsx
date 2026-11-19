// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { COMPOSER_WORDS } from '@shared/contracts/composer';
import { actionStatus, attentionWords, capitalize, PLAN_WAIT_WORDS, planWaitShown, type SessionEntry, type SessionSummary } from '@shared/contracts/sessions';
import { StatusStream, streamStyle, useProviderStream } from '../ui/status-stream/StatusStream';
import streamStyles from '../ui/status-stream/StatusStream.module.css';
import { useElapsed } from '../sessions/session-clock';
import { useActionWords } from '../sessions/useActionWords';
import styles from './SessionArea.module.css';

export type StatusBarState = 'running' | 'attention' | 'waiting' | 'ready' | 'not-started';

/** The words for a running session with no action yet. */
const RUNNING_WORDS = 'Thinking…';

/**
 * Which look the bar takes (docs/planning/_archive/M100.md, Design 7; C51): a question, an approval, an error
 * or a stop calls for the user, as does a pending plan or review, while a turn runs too; a ready attention does not, in the chat that
 * has the focus, and reads as Ready. A plan held in another chat is what this one waits on (decision 0029), where `planWaitShown` puts it.
 */
export function statusBarState(summary: SessionSummary): StatusBarState {
  if (planWaitShown(summary) !== null) return 'waiting';
  if (summary.attention !== null && summary.attention.kind !== 'ready') return 'attention';
  if (summary.status === 'running') return 'running';
  return summary.status === 'not-started' && summary.attention === null ? 'not-started' : 'ready';
}

/** The one-line states, in sentence case: Ready, Not started, "1 question", Error. */
export function statusBarWords(summary: SessionSummary): string {
  switch (statusBarState(summary)) {
    case 'attention': return summary.attention === null ? '' : capitalize(attentionWords(summary.attention));
    case 'waiting': { const wait = planWaitShown(summary); return wait === null ? '' : PLAN_WAIT_WORDS[wait]; }
    case 'not-started': return 'Not started';
    case 'running': return runningStatus(summary);
    case 'ready': return 'Ready';
  }
}

/** A running session's semantic status: shared words, Thinking before specific work is known. */
function runningStatus(summary: SessionSummary): string {
  return summary.action === null ? RUNNING_WORDS : actionStatus(summary.action);
}

/**
 * The status bar (docs/planning/_archive/M100.md, Design 7; C34, C36, C51, C52), at the top of the prompt
 * area: what the session does, on one line at a fixed height in every state, so the prompt-type bar
 * and the input under it never move when a turn starts or ends.
 *
 * While a turn runs — a session waiting on its workers included (M14, C114) — the action's status
 * stands in bold sentence case with an equally sized, bold elapsed time at its right.
 * Otherwise the bar has one centred line. Pending decisions use the attention colour pair. Other
 * non-running states are black with their word in white; a turn keeps it black and brings in the provider's stream, whose rectangles come in
 * from the left (ui/status-stream/useLightStream.ts). None of it changes the words or the accessible name.
 *
 * Its full detail and queue count remain in its accessible name. It is no live region: while a
 * turn runs it changes every second. ChatArea places the mode alongside the prompt actions, or
 * above this bar for decision panels and blocked states.
 */
export function StatusBar({ entry, queued = 0 }: { readonly entry: SessionEntry; /** Messages waiting in the session's queue: kept in the accessible name. */ readonly queued?: number }) {
  const { summary } = entry;
  const state = statusBarState(summary);
  const running = state === 'running';
  const pendingDecision = state === 'waiting' || (summary.attention !== null && ['question', 'approval', 'plan', 'review'].includes(summary.attention.kind));
  const stream = useProviderStream(entry.record.providerId);
  const elapsed = useElapsed(running ? summary.turnStartedAt : null, summary.turnWait);
  const status = runningStatus(summary);
  const visibleStatus = useActionWords(summary.action, summary.displayHold, running);
  const detail = summary.action?.detail ?? null;
  const waiting = queued > 0 ? COMPOSER_WORDS.queued(queued) : null;
  const words = running ? [status, ...(detail === null ? [] : [detail]), ...(waiting === null ? [] : [waiting]), ...(elapsed === null ? [] : [elapsed])].join(', ') : statusBarWords(summary);
  return (
    <div className={`${styles.statusBar} ${streamStyles.surface}`} role="group" aria-label={words} data-state={state} data-attention={state === 'waiting' ? undefined : summary.attention?.kind} data-status-bar="" data-stream={stream === undefined ? undefined : ''} style={stream === undefined ? undefined : streamStyle(stream)}>
      <StatusStream active={running} waiting={summary.action?.kind === 'waiting'} available={stream !== undefined} immediate={pendingDecision} />
      {running ? (
        <div className={styles.statusWords}>
          <p className={styles.statusLine}>
            <span className={styles.statusText}>{visibleStatus}</span>
            {elapsed !== null && <span className={styles.statusTime}>{elapsed}</span>}
          </p>
        </div>
      ) : (
        <p className={styles.statusOne}>{statusBarWords(summary)}</p>
      )}
    </div>
  );
}
