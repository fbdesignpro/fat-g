// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { LiveActions } from './live-actions';

describe('live action ownership (M105, including a third provider)', () => {
  it('starts thinking, retains parallel tools in start order, and never restarts completed ids', () => {
    const work = new LiveActions();
    expect(work.current()).toEqual({ kind: 'thinking' });
    work.start('a', { kind: 'reading', file: 'a.txt' });
    work.start('b', { kind: 'running' });
    work.start('a', { kind: 'tool' });
    expect(work.current()).toEqual({ kind: 'running' });
    work.end('b');
    expect(work.current()).toEqual({ kind: 'reading', file: 'a.txt' });
    work.end('a');
    work.start('b', { kind: 'running' });
    expect(work.current()).toEqual({ kind: 'thinking' });
  });

  it('local tools precede response text and waits; text ends without ending another tool', () => {
    const work = new LiveActions();
    work.start('wait', { kind: 'waiting', wait: { reason: 'provider' } });
    work.start('text', { kind: 'writing', message: true });
    expect(work.current()).toEqual({ kind: 'writing' });
    work.start('edit', { kind: 'writing' });
    expect(work.current()).toEqual({ kind: 'writing', tool: true });
    work.end('text');
    expect(work.current()).toEqual({ kind: 'writing', tool: true });
    work.end('edit');
    expect(work.current()).toEqual({ kind: 'waiting', wait: { reason: 'provider' } });
  });

  it('aggregates only identified foreground targets and releases them independently', () => {
    const work = new LiveActions();
    for (const id of ['one', 'two']) work.start(id, { kind: 'waiting', wait: { reason: 'subagents' } });
    work.link('one', 'child-a');
    expect(work.current()).toEqual({ kind: 'waiting', wait: { reason: 'subagents' } });
    work.link('two', 'child-b');
    expect(work.current()).toEqual({ kind: 'waiting', wait: { reason: 'subagents', count: 2 } });
    work.endTarget('not-a-target');
    work.endTarget('child-a');
    expect(work.current()).toEqual({ kind: 'waiting', wait: { reason: 'subagents', count: 1 } });
    work.endTarget('child-b');
    expect(work.current()).toEqual({ kind: 'thinking' });
  });

  it('an explicit wait stays generic after its identified targets end, until its own completion', () => {
    const work = new LiveActions();
    work.start('wait', { kind: 'waiting', wait: { reason: 'subagents' }, targets: new Set(['child']) });
    work.endTarget('child');
    expect(work.current()).toEqual({ kind: 'waiting', wait: { reason: 'provider' } });
    work.end('wait');
    expect(work.current()).toEqual({ kind: 'thinking' });
  });

  it('clears live ownership when an owner ends and allows ids in a distinct turn', () => {
    const work = new LiveActions();
    work.start('a', { kind: 'reading' }); work.end('a'); work.clear();
    work.start('a', { kind: 'running' });
    expect(work.current().kind).toBe('running');
    work.clear();
    expect(work.current().kind).toBe('thinking');
  });
});
