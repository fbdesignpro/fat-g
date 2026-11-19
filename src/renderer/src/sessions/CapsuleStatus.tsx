// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { actionStatus, type Attention, attentionWords, capitalize, PLAN_WAIT_WORDS, planWaitShown, type SessionAction, type SessionSummary, workersLine } from '@shared/contracts/sessions';
import { useAppState } from '../state/store';
import { StatusStream, streamStyle, useProviderStream } from '../ui/status-stream/StatusStream';
import streamStyles from '../ui/status-stream/StatusStream.module.css';
import { useElapsed } from './session-clock';
import { useActionWords } from './useActionWords';
import styles from './Sessions.module.css';

/** What a capsule reads, including the mini window's safe waiting metadata (decision 0010). */
export type CapsuleStatusSummary = Pick<SessionSummary, 'status' | 'turnStartedAt' | 'turnWait' | 'activeWorkers' | 'attention' | 'planWait' | 'displayHold'> & {
  readonly action: Pick<SessionAction, 'kind' | 'wait'> | null;
};

/** The bar's words: a plan's wait, else the attention, else what the turn does, else the state. */
export function capsuleStatusWords(summary: CapsuleStatusSummary): string {
  const wait = planWaitShown(summary);
  if (wait !== null) return PLAN_WAIT_WORDS[wait];
  if (summary.attention !== null) return capitalize(attentionWords(summary.attention));
  if (summary.status === 'running') return actionStatus(summary.action ?? 'thinking');
  return summary.status === 'idle' ? 'Idle' : 'Not started';
}

/**
 * A continuous bar touching the avatar and the capsule's right edge. Its provider stream runs behind
 * the action, worker count and time. Attention replaces that field immediately; its words stay whole
 * in the select button's accessible name even where the narrow bar cuts them. A plan held in another
 * chat replaces it with what this one waits on, in the waiting pair (decision 0029). Drawn by the
 * Main window's capsules and the Pet's alike. A bar that has just turned to an attention flashes
 * (`useAttentionFlash`).
 */
export function CapsuleStatus({ summary, providerId }: { readonly summary: CapsuleStatusSummary; readonly providerId: string }) {
  const wait = planWaitShown(summary);
  const attention = wait === null ? summary.attention : null;
  const running = summary.status === 'running' && wait === null;
  const elapsed = useElapsed(running && attention === null ? summary.turnStartedAt : null, summary.turnWait);
  const stream = useProviderStream(providerId);
  const workers = running && attention === null && summary.activeWorkers > 0;
  const active = running && attention === null;
  const actionWords = useActionWords(summary.action, summary.displayHold, active);
  const state = wait !== null ? 'waiting' : attention === null ? summary.status : attention.acknowledged ? 'acknowledged' : 'attention';
  const flash = useAttentionFlash(state === 'attention' && attention?.flash !== false ? attention : null);
  // Settings → Appearance can turn it off; its speed and duration are the page's (ThemeRoot).
  const flashes = useAppState((app) => app.snapshot?.appearance.flash?.enabled ?? true);
  return (
    <span
      className={`${styles.status} ${streamStyles.surface}`}
      data-capsule-status=""
      data-state={state}
      data-attention={attention?.kind}
      data-acknowledged={attention?.acknowledged || undefined}
      data-plan-wait={wait ?? undefined}
      data-stream={stream === undefined ? undefined : ''}
      data-flash={(flashes && flash.on) || undefined}
      style={stream === undefined ? undefined : streamStyle(stream)}
      onAnimationEnd={flash.end}
    >
      <StatusStream active={active} waiting={summary.action?.kind === 'waiting'} available={stream !== undefined} immediate={attention !== null || wait !== null} compact />
      <span className={styles.statusText}>{active ? actionWords : capsuleStatusWords(summary)}</span>
      {workers && <span className={styles.workers}>{workersLine(summary.activeWorkers)}</span>}
      {elapsed !== null && <span className={styles.time}>{elapsed}</span>}
    </span>
  );
}

/**
 * Whether the bar flashes (the maintainer): inverted, yellow on black, at the speed and for
 * the time Settings → Appearance sets — six times a second for five seconds unless changed —
 * (`.status[data-flash]`, Sessions.module.css), when it turns to an attention while drawn — from any
 * other state, to another kind, or to more of one: a new question beside the first. Never for one it
 * already showed when it was first drawn, so opening a window or the Pet lights nothing that waited
 * before; never for fewer, once one of two is answered. `lit` is the attention the bar shows, or
 * null; the flash ends with its animation, or with the attention.
 */
function useAttentionFlash(lit: Pick<Attention, 'kind' | 'count'> | null): { readonly on: boolean; readonly end: (event: { readonly target: EventTarget; readonly currentTarget: EventTarget }) => void } {
  const kind = lit?.kind ?? null;
  const count = lit?.count ?? 0;
  // What the bar showed at its last render, and whether it flashes: set while rendering, as React
  // has a state follow a prop, so the flash is drawn in the same frame as the attention.
  const [seen, setSeen] = useState({ kind, count, on: false });
  let now = seen;
  if (seen.kind !== kind || seen.count !== count) {
    const turned = kind !== null && (seen.kind !== kind || count > seen.count);
    now = { kind, count, on: kind !== null && (turned || seen.on) };
    setSeen(now);
  }
  // The bar's own animation alone: its stream's lights animate inside it too.
  return { on: now.on, end: (event) => { if (event.target === event.currentTarget) setSeen((current) => ({ ...current, on: false })); } };
}
