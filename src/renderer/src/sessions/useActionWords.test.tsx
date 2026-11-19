// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionHold, SessionAction } from '@shared/contracts/sessions';
import { useActionWords } from './useActionWords';

const thinking = { kind: 'thinking' as const };
const hold: ActionHold = { kind: 'waiting', wait: { reason: 'subagents', count: 2 }, until: 3000 };
function Words({ action = thinking, deadline = hold, active = true }: { readonly action?: Pick<SessionAction, 'kind' | 'wait'>; readonly deadline?: ActionHold; readonly active?: boolean }) {
  return <span>{useActionWords(action, deadline, active)}</span>;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('shared visible fallback, independent of provider and surface', () => {
  it('holds through 1999 ms and falls back at 2000, without restarting on unrelated renders', () => {
    const view = render(<Words />);
    expect(view.container.textContent).toBe('Waiting for 2 sub-agents');
    act(() => { vi.advanceTimersByTime(1999); });
    view.rerender(<Words deadline={{ ...hold }} />);
    expect(view.container.textContent).toBe('Waiting for 2 sub-agents');
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.container.textContent).toBe('Thinking…');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consumes the remaining deadline on remount and never replays an expired transition', () => {
    const first = render(<Words />);
    act(() => { vi.advanceTimersByTime(250); });
    first.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const second = render(<Words />);
    act(() => { vi.advanceTimersByTime(1750); });
    expect(second.container.textContent).toBe('Thinking…');
    second.unmount();
    expect(render(<Words />).container.textContent).toBe('Thinking…');
  });

  it('cancels for new work and bypasses attention, terminal state and another owner', () => {
    const view = render(<Words />);
    view.rerender(<Words action={{ kind: 'reading' }} />);
    expect(view.container.textContent).toBe('Reading');
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(<Words active={false} />);
    expect(view.container.textContent).toBe('Thinking…');
    view.rerender(<Words deadline={{ kind: 'tool', until: 1000 }} />);
    expect(view.container.textContent).toBe('Thinking…');
    expect(vi.getTimerCount()).toBe(0);
  });
});
