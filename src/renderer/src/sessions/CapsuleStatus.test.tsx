// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A capsule's bar flashes when it turns to an attention while drawn (the maintainer): in the
// Main window's capsules and the Pet's alike, which both draw CapsuleStatus.
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared/contracts/sessions';
import { sampleSnapshot } from '../../../../tests/support/app-state';
import { SUMMARIES } from '../../../../tests/support/sessions';
import { useAppState } from '../state/store';
import { installFakeBridge } from '../test/fake-bridge';
import { CapsuleStatus } from './CapsuleStatus';

beforeEach(() => {
  installFakeBridge();
  useAppState.setState({ snapshot: null, error: null });
});
afterEach(cleanup);

/**
 * An animation's end, as the page would hear it: Chromium's `animationend`, and the prefixed name React
 * listens for in jsdom, which has no AnimationEvent.
 */
function animationEnds(element: Element): void {
  fireEvent.animationEnd(element);
  act(() => { element.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true })); });
}

const questions = (count: number): SessionSummary => ({ ...SUMMARIES.questions, attention: { kind: 'question', count, acknowledged: false } });

function draw(summary: SessionSummary) {
  const view = render(<CapsuleStatus summary={summary} providerId="claude" />);
  const bar = (): HTMLElement => view.container.querySelector('[data-capsule-status]') as HTMLElement;
  return { bar, show: (next: SessionSummary) => view.rerender(<CapsuleStatus summary={next} providerId="claude" />) };
}

describe('the attention flash', () => {
  it('keeps a plan brought by the user lit without flashing, and still flashes for a later plan result', () => {
    const { bar, show } = draw(SUMMARIES.readyAcknowledged);
    show({ ...SUMMARIES.idle, attention: { kind: 'plan', count: 1, acknowledged: false, flash: false } });
    expect(bar().getAttribute('data-attention')).toBe('plan');
    expect(bar().getAttribute('data-state')).toBe('attention');
    expect(bar().hasAttribute('data-flash')).toBe(false);
    show(SUMMARIES.runningThinking);
    show({ ...SUMMARIES.idle, attention: { kind: 'plan', count: 1, acknowledged: false } });
    expect(bar().getAttribute('data-flash')).toBe('true');
  });

  it('flashes when a running bar turns ready, until its animation ends', () => {
    const { bar, show } = draw(SUMMARIES.runningThinking);
    expect(bar().hasAttribute('data-flash')).toBe(false);
    show(SUMMARIES.ready);
    expect(bar().getAttribute('data-flash')).toBe('true');
    expect(bar().getAttribute('data-attention')).toBe('ready');
    animationEnds(bar());
    expect(bar().hasAttribute('data-flash')).toBe(false);
  });

  it('keeps flashing when a light of its stream ends an animation', () => {
    const { bar, show } = draw(SUMMARIES.runningThinking);
    show(SUMMARIES.error);
    const light = bar().querySelector('[data-status-stream]') as HTMLElement;
    animationEnds(light);
    expect(bar().getAttribute('data-flash')).toBe('true');
  });

  it('does not flash for an attention it already showed when first drawn', () => {
    const { bar, show } = draw(SUMMARIES.ready);
    expect(bar().hasAttribute('data-flash')).toBe(false);
    show({ ...SUMMARIES.ready });
    expect(bar().hasAttribute('data-flash')).toBe(false);
  });

  it('flashes for another kind and for more of one, never for fewer', () => {
    const { bar, show } = draw(questions(1));
    show(questions(2));
    expect(bar().getAttribute('data-flash')).toBe('true');
    animationEnds(bar());
    show(questions(1));
    expect(bar().hasAttribute('data-flash')).toBe(false);
    show(SUMMARIES.approval);
    expect(bar().getAttribute('data-flash')).toBe('true');
  });

  it('never flashes while Settings → Appearance has it off', () => {
    useAppState.setState({ snapshot: { ...sampleSnapshot(1), appearance: { theme: 'light', flash: { enabled: false, speed: 'fast', seconds: 3 } } } });
    const { bar, show } = draw(SUMMARIES.runningThinking);
    show(SUMMARIES.ready);
    expect(bar().getAttribute('data-attention')).toBe('ready');
    expect(bar().hasAttribute('data-flash')).toBe(false);
  });

  it('stops with the attention, and never flashes a seen Ready or a plan’s wait', () => {
    const { bar, show } = draw(SUMMARIES.runningThinking);
    show(SUMMARIES.ready);
    show(SUMMARIES.readyAcknowledged);
    expect(bar().hasAttribute('data-flash')).toBe(false);
    show(SUMMARIES.runningThinking);
    show({ ...SUMMARIES.readyAcknowledged, planWait: 'review' });
    expect(bar().getAttribute('data-state')).toBe('waiting');
    expect(bar().hasAttribute('data-flash')).toBe(false);
  });
});
