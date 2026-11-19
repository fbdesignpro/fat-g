// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import type { LifecycleTraceEvent } from '@shared/provider-kit/lifecycle-trace';
import { createLifecycleTrace, lifecycleTraceEnabled } from './lifecycle-trace';

describe('opt-in lifecycle trace', () => {
  it('requires the exact opt-in and cannot be enabled in a packaged app', () => {
    expect(lifecycleTraceEnabled(false, '1')).toBe(true);
    for (const setting of [undefined, '', '0', 'true']) expect(lifecycleTraceEnabled(false, setting)).toBe(false);
    expect(lifecycleTraceEnabled(true, '1')).toBe(false);
  });
  it('is absent when disabled and reconstructs only safe metadata when enabled', () => {
    const sink = vi.fn();
    expect(createLifecycleTrace(false, 40, sink)).toBeUndefined();
    let at = 100;
    const trace = createLifecycleTrace(true, 40, sink, () => at++);
    trace?.({ phase: 'reply', pid: 50, request: 2, operation: 'resume', outcome: 'rpc-error', refusal: 'active-writer', numericCode: -32600, message: 'private prompt', path: 'private folder', threadId: 'private reference' } as LifecycleTraceEvent);
    const line = sink.mock.calls[0]?.[0] as string;
    expect(JSON.parse(line.slice('[fatg-trace] '.length))).toEqual({ version: 1, at: 101, elapsedMs: 1, appPid: 40, phase: 'reply', pid: 50, request: 2, operation: 'resume', outcome: 'rpc-error', refusal: 'active-writer', numericCode: -32600 });
    expect(line).not.toContain('private');
  });
  it('drops uncontrolled strings, rejects an unknown phase and isolates a failing sink', () => {
    const sink = vi.fn();
    const trace = createLifecycleTrace(true, 1, sink);
    trace?.({ phase: 'reply', pid: Number.NaN, operation: 'private', outcome: 'private', refusal: 'private', numericCode: Number.NaN } as unknown as LifecycleTraceEvent);
    expect(sink.mock.calls[0]?.[0]).not.toContain('private');
    trace?.({ phase: 'private', pid: 1 } as unknown as LifecycleTraceEvent);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(() => createLifecycleTrace(true, 1, () => { throw Error('sink failed'); })?.({ phase: 'spawn', pid: 3 })).not.toThrow();
  });
});
