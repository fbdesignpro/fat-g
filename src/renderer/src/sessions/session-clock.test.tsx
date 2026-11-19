// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The session clock (docs/planning/_archive/M14.md, V12; C51, C63): one interval for the page whatever the
// number of capsules and workers, and none while no running session is on screen. That the usage
// panel's clock stays its own — `useClock` has no other caller — is checked on the sources, in
// tests/architecture/records-reach.test.ts: a renderer test may not read files.
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { SessionEntry, SessionSummary } from '@shared/contracts/sessions';
import { sessionEntry, SUMMARIES, TURN_STARTED_AT } from '../../../../tests/support/sessions';
import { BUILT_IN_KINDS } from '../artifacts/kinds';
import { resetTabs } from '../artifacts/tabs-store';
import { SpeakerBar } from '../chat/SpeakerBar';
import { ProjectList } from '../projects/ProjectList';
import { PaneWithKinds } from '../test/pane';
import { SelectedModel, SelectedStatus } from '../test/selected';
import { installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { sessionClockState, useElapsed } from './session-clock';

const A = project('Calamari');
const s = (name: string, summary: SessionSummary): SessionEntry => sessionEntry(name, summary, { projectId: A.id });

// The selected session's model block and status bar, its Sub-agents tab — which opens by itself for a
// session with sub-agents (M100, round 8; C78) — and the project list with its capsules.
function Page() {
  const column = useRef<HTMLElement>(null);
  return (
    <>
      <SelectedModel />
      <SelectedStatus />
      <PaneWithKinds kinds={BUILT_IN_KINDS} watch />
      <aside ref={column} aria-label="Projects">
        <ProjectList column={column} />
      </aside>
    </>
  );
}

let setInterval: MockInstance<typeof window.setInterval>;
const intervals = (): number => setInterval.mock.calls.filter(([, ms]) => ms === 1000).length;

beforeEach(() => {
  installFakeBridge();
  resetTabs();
  vi.useFakeTimers({ now: TURN_STARTED_AT + 32_000 });
  setInterval = vi.spyOn(window, 'setInterval');
});
afterEach(() => {
  cleanup();
  resetTabs();
  setInterval.mockRestore();
  vi.useRealTimers();
});

describe('the session clock (V12)', () => {
  it('runs no interval while no running session is on screen', () => {
    showState({ projects: [A], sessions: [s('idle', SUMMARIES.idle), s('new', SUMMARIES.notStarted), s('ready', SUMMARIES.ready), s('error', SUMMARIES.error)] });
    render(<Page />);
    expect(intervals()).toBe(0);
    expect(sessionClockState()).toEqual({ subscribers: 0, ticking: false });
  });

  it('runs one interval for the page, whatever the number of capsules and workers', () => {
    const selected = s('many', SUMMARIES.manyWorkers);
    showState({
      projects: [A],
      sessions: [selected, s('thinking', SUMMARIES.runningThinking), s('workers', SUMMARIES.runningWorkers), s('waiting', SUMMARIES.waitingOnWorkers), s('idle', SUMMARIES.idle)],
      selectedId: selected.record.id,
    });
    render(<Page />);
    expect(intervals()).toBe(1);
    // Four running capsules, the status bar's own time, and the eight running workers' rows in the Sub-agents tab.
    expect(sessionClockState()).toEqual({ subscribers: 4 + 1 + 8, ticking: true });
  });

  it('ticks every second, from a timestamp pushed once: no state is pushed for the time passing', () => {
    showState({ projects: [A], sessions: [s('thinking', SUMMARIES.runningThinking)] });
    render(<Page />);
    const time = () => screen.getByRole('button', { name: 'thinking, Thinking…' }).textContent;
    expect(time()).toBe('thinkingThinking…32s');
    act(() => void vi.advanceTimersByTime(1000));
    expect(time()).toBe('thinkingThinking…33s');
    act(() => void vi.advanceTimersByTime(27_000));
    expect(time()).toBe('thinkingThinking…1m0s');
    expect(intervals()).toBe(1);
  });

  it('keeps the capsule, status bar and speaker counter together after a long decision wait, including another pause and resume', () => {
    const held = (16 * 60 + 17) * 60_000;
    vi.setSystemTime(TURN_STARTED_AT + (17 * 60 + 53) * 60_000);
    const selected = s('thinking', { ...SUMMARIES.runningThinking, turnWait: { turnId: 't1', ms: held, since: null } });
    const push = (summary: SessionSummary) => showState({ projects: [A], sessions: [{ ...selected, summary }], selectedId: selected.record.id });
    push(selected.summary);
    render(<>
      <Page />
      <SpeakerBar speaker={{ role: 'assistant', model: selected.summary.model }} modelName="A model" defaultModel={selected.summary.model} providerId={selected.record.providerId} sessionId={selected.record.id} timer={{ turnId: 't1', running: true, since: TURN_STARTED_AT, elapsedMs: null }} />
    </>);
    const counter = () => document.querySelector('[data-turn-counter]')?.textContent;
    const times = () => [
      document.querySelector('[data-capsule-status]')?.lastElementChild?.textContent,
      document.querySelector('[data-status-bar] p')?.lastElementChild?.textContent,
      counter(),
    ];
    expect(times()).toEqual(['1h36m0s', '1h36m0s', '1h36m0s']);
    act(() => void vi.advanceTimersByTime(1000));
    expect(times()).toEqual(['1h36m1s', '1h36m1s', '1h36m1s']);

    const blockedAt = Date.now();
    act(() => void push({ ...selected.summary, attention: { kind: 'question', count: 1, acknowledged: false }, turnWait: { turnId: 't1', ms: held, since: blockedAt } }));
    expect(sessionClockState()).toEqual({ subscribers: 0, ticking: false });
    act(() => {
      vi.setSystemTime(blockedAt + 60 * 60_000);
      vi.advanceTimersByTime(1000);
    });
    expect(counter()).toBe('1h36m1s');
    act(() => void push({ ...selected.summary, turnWait: { turnId: 't1', ms: held + Date.now() - blockedAt, since: null } }));
    expect(times()).toEqual(['1h36m1s', '1h36m1s', '1h36m1s']);
    act(() => void vi.advanceTimersByTime(2000));
    expect(times()).toEqual(['1h36m3s', '1h36m3s', '1h36m3s']);
  });

  it('stops with the last running row, and starts again with the next', () => {
    showState({ projects: [A], sessions: [s('thinking', SUMMARIES.runningThinking)] });
    render(<Page />);
    expect(sessionClockState().ticking).toBe(true);
    act(() => void showState({ projects: [A], sessions: [s('thinking', SUMMARIES.ready)] }));
    expect(sessionClockState()).toEqual({ subscribers: 0, ticking: false });
    act(() => void showState({ projects: [A], sessions: [s('thinking', SUMMARIES.runningThinking)] }));
    expect(sessionClockState()).toEqual({ subscribers: 1, ticking: true });
    expect(intervals()).toBe(2);
  });

  it('stops when the page that showed it is gone', () => {
    showState({ projects: [A], sessions: [s('thinking', SUMMARIES.runningThinking)] });
    const { unmount } = render(<Page />);
    unmount();
    expect(sessionClockState()).toEqual({ subscribers: 0, ticking: false });
  });

  it('times a running worker from its start, and shows a finished one’s duration without the clock', () => {
    const selected = s('workers', SUMMARIES.runningWorkers);
    vi.setSystemTime(TURN_STARTED_AT + 120_000);
    showState({ projects: [A], sessions: [selected], selectedId: selected.record.id });
    render(<Page />);
    // A running row's time, and a finished one's end with its duration (M106, C6, C9).
    const rowTime = (number: number) => document.querySelector(`[data-row="worker-${number}"] [data-time]`)?.textContent;
    // Worker 1 started 12 s into the turn, worker 3 at 20 s; both still run.
    expect([rowTime(1), rowTime(3)]).toEqual(['1m48s', '1m40s']);
    // Worker 2 ran from 14 s to 95 s; it is folded under the completed line, so open that first.
    act(() => screen.getByRole('button', { name: /completed sub-agent/ }).click());
    expect(rowTime(2)).toBe('Completed 1m21s');
    act(() => void vi.advanceTimersByTime(5000));
    expect([rowTime(1), rowTime(2), rowTime(3)]).toEqual(['1m53s', 'Completed 1m21s', '1m45s']);
  });
});

describe('useElapsed', () => {
  function Probe({ since }: { readonly since: number | null }) {
    return <output>{useElapsed(since) ?? 'none'}</output>;
  }

  it('gives nothing, and subscribes to nothing, with nothing to time', () => {
    render(<Probe since={null} />);
    expect(screen.getByRole('status').textContent).toBe('none');
    expect(sessionClockState().subscribers).toBe(0);
  });

  it('never goes below zero for a start the page’s clock has not reached', () => {
    render(<Probe since={TURN_STARTED_AT + 60_000} />);
    expect(screen.getByRole('status').textContent).toBe('0s');
  });
});
