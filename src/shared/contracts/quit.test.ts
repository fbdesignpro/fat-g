// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { quitActivity, quitWords } from './quit';
import type { SessionSummary } from './sessions';
import { SUMMARIES } from '../../../tests/support/sessions';

const planReady = (running: boolean): SessionSummary => ({
  ...SUMMARIES.idle,
  status: running ? 'running' : 'idle',
  action: running ? { kind: 'plan-ready', label: 'Plan ready' } : null,
  attention: { kind: 'plan', count: 1, acknowledged: false },
});
const entry = (summary: SessionSummary) => ({ summary });

describe('quit activity', () => {
  it('recognizes a saved plan both while a provider waits and after its reply ends', () => {
    for (const running of [false, true]) {
      expect(quitActivity([entry(planReady(running))])).toEqual({ working: 0, planReady: 1 });
    }
  });

  it('counts work alongside a plan decision, including sub-agents after a parent reply ends', () => {
    expect(quitActivity([entry(planReady(true)), entry(SUMMARIES.runningThinking), entry(SUMMARIES.waitingOnWorkers), entry(SUMMARIES.idle)]))
      .toEqual({ working: 2, planReady: 1 });
  });

  it('does not hide active sub-agents or another reply behind a ready plan', () => {
    const ready = planReady(true);
    expect(quitActivity([entry({ ...ready, activeWorkers: 1 })])).toEqual({ working: 1, planReady: 1 });
    expect(quitActivity([entry({ ...ready, action: { kind: 'thinking', label: 'Thinking' } })])).toEqual({ working: 1, planReady: 1 });
  });

  it('does not mistake drafting or reviewing a plan for a saved plan decision', () => {
    expect(quitActivity([entry({ ...SUMMARIES.runningThinking, attention: { kind: 'review', count: 1, acknowledged: false } })]))
      .toEqual({ working: 1, planReady: 0 });
  });
});

describe('quit words', () => {
  it('explains what happens to a saved plan without calling it active work', () => {
    const { body } = quitWords({ working: 0, planReady: 1 });
    expect(body).toContain('1 chat has a plan ready for review.');
    expect(body).toContain('Your saved plan will still be ready for review when you return.');
    expect(body).toContain('Nothing will run automatically.');
    expect(body).not.toMatch(/stops|still working|\bturns?\b/i);
  });

  it('explains both interrupted work and saved plans in a mixed quit', () => {
    const { body } = quitWords({ working: 2, planReady: 2 });
    expect(body).toContain('2 chats are still working. Quitting stops their current replies and any sub-agents.');
    expect(body).toContain('2 chats have plans ready for review.');
    expect(body).toContain('Your saved plans will still be ready for review when you return.');
  });
});
