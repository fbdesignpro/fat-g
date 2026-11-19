// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Synthetic M105 cases for the third-provider stream form. No frame here is claimed as wire evidence.
import type { AgentEvent } from '@shared/contracts/agent-events';

export interface StateStep { readonly after: number; readonly events: readonly AgentEvent[] }
export function stateSteps(turnId: string, held: boolean): readonly StateStep[] {
  const action = (kind: 'thinking' | 'reading' | 'running' | 'waiting', count?: number): AgentEvent => ({
    type: 'action-changed', turnId, kind,
    ...(kind !== 'waiting' ? {} : { wait: count === undefined ? { reason: 'provider' as const } : { reason: 'subagents' as const, count } }),
  });
  const read = `${turnId}-read`;
  const command = `${turnId}-command`;
  const one = `${turnId}-one`;
  const two = `${turnId}-two`;
  const steps: StateStep[] = [
    { after: 1000, events: [{ type: 'activity-started', turnId, itemId: read, activityType: 'read', name: 'Read', summary: 'Synthetic parallel read' }, action('reading')] },
    { after: 500, events: [{ type: 'activity-started', turnId, itemId: command, activityType: 'command', name: 'Command', summary: 'Synthetic parallel command' }, action('running')] },
    { after: 1500, events: [{ type: 'activity-ended', turnId, itemId: read, status: 'completed' }] },
    { after: 1000, events: [{ type: 'activity-ended', turnId, itemId: command, status: 'completed' }, action('thinking')] },
    { after: 1500, events: [{ type: 'worker-started', workerId: one, description: 'Synthetic first child' }, { type: 'worker-started', workerId: two, description: 'Synthetic second child' }, action('reading'), { type: 'worker-progressed', workerId: one, kind: 'reading' }] },
    { after: 1500, events: [action('thinking'), { type: 'worker-progressed', workerId: one, kind: 'thinking' }] },
    { after: 1500, events: held ? [{ type: 'turn-ended', turnId, outcome: 'completed', reported: true }] : [action('waiting', 2)] },
    { after: 2500, events: [{ type: 'worker-ended', workerId: one, outcome: 'completed' }, ...(held ? [] : [action('waiting', 1)])] },
    { after: 2500, events: [{ type: 'worker-ended', workerId: two, outcome: 'completed' }, ...(held ? [] : [action('thinking')])] },
  ];
  return held ? steps : [...steps, { after: 1500, events: [action('waiting')] }, { after: 3000, events: [action('thinking')] }];
}
