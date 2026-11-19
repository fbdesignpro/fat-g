// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { mapFrame, type MapperState, newTurn, newWorker } from './turn-mapper';

const fresh = (): MapperState => ({ threadId: 'parent', turn: newTurn('runtime', 'turn'), workers: new Map(), asides: new Map(), denied: new Set() });
const item = (state: MapperState, started: boolean, value: Record<string, unknown>) => mapFrame(state, started ? 'item/started' : 'item/completed', { threadId: 'parent', turnId: 'turn', item: value });

describe('M105 Codex action lifetimes', () => {
  it('rejects a stale child turn end and releases specific work at its own terminal boundary', () => {
    const state = fresh();
    state.workers.set('child', newWorker('runtime'));
    mapFrame(state, 'turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    mapFrame(state, 'item/started', { threadId: 'child', turnId: 'child-turn', item: { type: 'commandExecution', id: 'command' } });
    expect(mapFrame(state, 'turn/completed', { threadId: 'child', turn: { id: 'old-turn', status: 'completed' } }).drop).toBe('other-turn');
    expect(state.workers.get('child')?.lastAction.kind).toBe('running');
    expect(mapFrame(state, 'turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } }).events).toContainEqual({ type: 'worker-progressed', workerId: 'child', kind: 'thinking' });
  });
  it.each([['a', 'b'], ['b', 'a']])('completes parallel tools in order %s, %s without clearing the other', (first, last) => {
    const state = fresh();
    item(state, true, { type: 'commandExecution', id: 'a', commandActions: [{ type: 'read', name: 'a.txt' }] });
    item(state, true, { type: 'commandExecution', id: 'b', commandActions: [] });
    expect(state.turn?.lastAction.kind).toBe('running');
    item(state, false, { type: 'commandExecution', id: first, status: 'failed' });
    expect(state.turn?.lastAction.kind).toBe(last === 'a' ? 'reading' : 'running');
    const completed = item(state, false, { type: 'commandExecution', id: last, status: 'completed' });
    expect(completed.events.at(-1)).toMatchObject({ type: 'action-changed', kind: 'thinking' });
    expect(item(state, true, { type: 'commandExecution', id: last }).events).toEqual([]);
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });

  it('ends response Writing at message completion while keeping a parallel command', () => {
    const state = fresh();
    item(state, true, { type: 'agentMessage', id: 'message', text: '', phase: 'commentary' });
    expect(state.turn?.lastAction.kind).toBe('writing');
    item(state, true, { type: 'commandExecution', id: 'command' });
    item(state, false, { type: 'agentMessage', id: 'message', text: 'Finished commentary', phase: 'commentary' });
    expect(state.turn?.lastAction.kind).toBe('running');
    item(state, false, { type: 'commandExecution', id: 'command', status: 'declined' });
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });

  it('counts only explicit live wait targets and retains a generic wait after they finish', () => {
    const state = fresh();
    for (const id of ['one', 'two', 'unrelated']) state.workers.set(id, newWorker('runtime', null, false));
    item(state, true, { type: 'collabAgentToolCall', id: 'wait', tool: 'wait', receiverThreadIds: ['one', 'two'] });
    expect(state.turn?.lastAction.wait).toEqual({ reason: 'subagents', count: 2 });
    item(state, true, { type: 'commandExecution', id: 'local' });
    expect(state.turn?.lastAction.kind).toBe('running');
    item(state, false, { type: 'commandExecution', id: 'local', status: 'completed' });
    expect(state.turn?.lastAction.wait).toEqual({ reason: 'subagents', count: 2 });
    for (const [id, count] of [['unrelated', 2], ['one', 1], ['two', 0]] as const) {
      mapFrame(state, 'turn/completed', { threadId: id, turn: { id: `${id}-turn`, status: 'completed' } });
      expect(state.turn?.lastAction.wait).toEqual(count === 0 ? { reason: 'provider' } : { reason: 'subagents', count });
    }
    item(state, false, { type: 'collabAgentToolCall', id: 'wait', tool: 'wait', status: 'completed' });
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });

  it('keeps anonymous waits generic and coordination distinct from waiting', () => {
    const state = fresh();
    item(state, true, { type: 'collabAgentToolCall', id: 'send', tool: 'sendInput', receiverThreadIds: ['child'] });
    expect(state.turn?.lastAction.kind).toBe('tool');
    item(state, false, { type: 'collabAgentToolCall', id: 'send', tool: 'sendInput' });
    item(state, true, { type: 'collabAgentToolCall', id: 'wait', tool: 'wait', receiverThreadIds: [], agentsStates: {} });
    expect(state.turn?.lastAction).toEqual({ kind: 'waiting', wait: { reason: 'provider' } });
  });
});
