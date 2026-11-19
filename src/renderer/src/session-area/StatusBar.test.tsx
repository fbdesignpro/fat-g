// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The single-line bar shows the status and time. Queue context stays in its accessible name;
// the composer draws the queue itself. Empty queues and idle sessions have no queue context.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPOSER_WORDS } from '@shared/contracts/composer';
import { sampleCatalog } from '../../../../tests/support/catalog';
import { sessionEntry, SUMMARIES } from '../../../../tests/support/sessions';
import { showState } from '../test/sessions';
import { useAppState } from '../state/store';
import { StatusBar } from './StatusBar';

afterEach(() => {
  cleanup();
  useAppState.setState({ snapshot: null, error: null });
});

describe('the queued count (V9; C82)', () => {
  it('delays only visible fallback, with semantic accessibility and pacing on every render', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const summary = { ...SUMMARIES.runningThinking, displayHold: { kind: 'waiting' as const, wait: { reason: 'subagents' as const, count: 2 }, until: 1400 } };
    const view = render(<StatusBar entry={sessionEntry('Third provider', summary, { providerId: 'third' })} />);
    const bar = () => view.container.querySelector('[data-status-bar]');
    expect(bar()?.textContent).toContain('Waiting for 2 sub-agents');
    expect(bar()?.getAttribute('aria-label')).toContain('Thinking…');
    expect(view.container.querySelector('[data-waiting]')).toBeNull();
    act(() => { vi.advanceTimersByTime(400); });
    expect(bar()?.textContent).toContain('Thinking…');
    view.rerender(<StatusBar entry={sessionEntry('Waiting', { ...summary, action: { kind: 'waiting', label: 'Private provider prose', wait: { reason: 'subagents', count: 1 } } })} />);
    expect(bar()?.textContent).toContain('Waiting for a sub-agent');
    expect(bar()?.textContent).not.toContain('Private provider prose');
    view.unmount();
    vi.useRealTimers();
  });
  it('keeps the count in the accessible name without adding another visible status element', () => {
    render(<StatusBar entry={sessionEntry('Running', SUMMARIES.runningThinking)} queued={2} />);
    expect(screen.queryByText(COMPOSER_WORDS.queued(2))).toBeNull();
    expect(COMPOSER_WORDS.queued(2)).toBe('2 messages queued');
    expect(COMPOSER_WORDS.queued(1)).toBe('1 message queued');
    expect(document.querySelector('[data-status-bar]')?.getAttribute('aria-label')).toContain('2 messages queued');
  });

  it('says nothing for an empty queue, nor on a session that is not running', () => {
    render(<StatusBar entry={sessionEntry('Running', SUMMARIES.runningThinking)} queued={0} />);
    expect(document.querySelector('[data-status-queued]')).toBeNull();
    cleanup();
    render(<StatusBar entry={sessionEntry('Idle', SUMMARIES.idle)} queued={3} />);
    expect(document.querySelector('[data-status-queued]')).toBeNull();
  });
});

// Platform colours (decision 0013, amended): the lit ground and the six tones are the
// session's provider's, set here from its module's descriptor; a provider with none leaves the bar black.
describe('a provider’s stream', () => {
  const bar = () => document.querySelector<HTMLElement>('[data-status-bar]');

  it('carries its provider’s ground and six tones on the bar', () => {
    act(() => { showState({ catalog: sampleCatalog(['claude']) }); });
    render(<StatusBar entry={sessionEntry('Running', SUMMARIES.runningThinking)} />);
    const element = bar();
    expect(element?.getAttribute('data-stream')).toBe('');
    expect(element?.style.getPropertyValue('--stream-ground')).toBe('#541704');
    expect([1, 2, 3, 4, 5, 6].map((n) => element?.style.getPropertyValue(`--stream-${n}`))).toEqual(['#791e08', '#8c260b', '#982c0e', '#a4300c', '#b73d12', '#c24714']);
  });

  it('carries none for a provider this build does not have', () => {
    act(() => { showState({ catalog: sampleCatalog(['codex']) }); });
    render(<StatusBar entry={sessionEntry('Running', SUMMARIES.runningThinking)} />);
    const element = bar();
    expect(element?.hasAttribute('data-stream')).toBe(false);
    expect(element?.style.getPropertyValue('--stream-ground')).toBe('');
  });
});

// Decision 0029 (the maintainer): what a chat of a plan waits on while another holds it.
describe('a plan held in another chat', () => {
  it('says what the chat waits on, in the waiting pair, over READY and its plan’s request', () => {
    render(<StatusBar entry={sessionEntry('Waiting', { ...SUMMARIES.ready, planWait: 'review' })} />);
    const element = document.querySelector<HTMLElement>('[data-status-bar]');
    expect([element?.getAttribute('data-state'), element?.hasAttribute('data-attention'), element?.textContent]).toEqual(['waiting', false, 'Waiting on plan review']);
    expect(element?.getAttribute('aria-label')).toBe('Waiting on plan review');
    cleanup();
    render(<StatusBar entry={sessionEntry('Held', { ...SUMMARIES.runningThinking, attention: { kind: 'plan', count: 1, acknowledged: false }, planWait: 'implementation' })} />);
    expect(document.querySelector('[data-status-bar]')?.textContent).toBe('Waiting on plan implementation');
  });
});
