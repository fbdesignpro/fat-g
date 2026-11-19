// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { beginChatTurn, mapChatFrame, newChatMapper, type ChatMapperState } from './chat-mapper';

function fresh(): ChatMapperState {
  const state = newChatMapper('D:\\fixture', true);
  beginChatTurn(state, 'turn', 'prompt').started = true;
  return state;
}
const use = (state: ChatMapperState, id: string, name: string, parent: string | null = null) => mapChatFrame(state, {
  type: 'assistant', uuid: `frame-${id}`, parent_tool_use_id: parent,
  message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id, name, input: { file_path: `${id}.txt` } }] },
});
const result = (state: ChatMapperState, id: string, parent: string | null = null, failed = false) => mapChatFrame(state, {
  type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: 'fixture output' }] },
});

describe('M105 Claude action lifetimes', () => {
  it.each([['a', 'b'], ['b', 'a']])('closes only the named parallel tool in order %s, %s', (first, last) => {
    const state = fresh();
    use(state, 'a', 'Read'); use(state, 'b', 'Bash');
    expect(state.turn?.lastAction.kind).toBe('running');
    result(state, first, null, true);
    expect(state.turn?.lastAction.kind).toBe(last === 'a' ? 'reading' : 'running');
    expect(result(state, last).events.at(-1)).toMatchObject({ type: 'action-changed', kind: 'thinking' });
    use(state, last, 'Read');
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });

  it('foreground dependencies aggregate, local work wins, and child results stay under the child', () => {
    const state = fresh();
    for (const id of ['one', 'two']) {
      use(state, id, 'Agent');
      mapChatFrame(state, { type: 'system', subtype: 'task_started', task_id: `task-${id}`, tool_use_id: id, is_backgrounded: false });
    }
    expect(state.turn?.lastAction.wait).toEqual({ reason: 'subagents', count: 2 });
    use(state, 'child-read', 'Read', 'one');
    result(state, 'child-read', 'one');
    expect(state.workers.get('task-one')?.lastAction.kind).toBe('thinking');
    expect(state.turn?.lastAction.wait).toEqual({ reason: 'subagents', count: 2 });
    use(state, 'local', 'Bash');
    expect(state.turn?.lastAction.kind).toBe('running');
    result(state, 'local');
    expect(state.turn?.lastAction.wait).toEqual({ reason: 'subagents', count: 2 });
    mapChatFrame(state, { type: 'system', subtype: 'task_updated', task_id: 'task-one', patch: { status: 'completed' } });
    expect(state.turn?.lastAction.wait).toEqual({ reason: 'subagents', count: 1 });
    mapChatFrame(state, { type: 'system', subtype: 'task_updated', task_id: 'task-two', patch: { status: 'completed' } });
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });

  it('a returned/background invocation does not leave the parent waiting for a still-running child', () => {
    const state = fresh(); use(state, 'agent', 'Agent');
    mapChatFrame(state, { type: 'system', subtype: 'task_started', task_id: 'background', tool_use_id: 'agent', is_backgrounded: true });
    expect(state.workers.has('background')).toBe(true);
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });

  it('does not call a known background launch a child dependency while it is being set up', () => {
    const state = fresh();
    mapChatFrame(state, { type: 'assistant', uuid: 'launch', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'background', name: 'Agent', input: { run_in_background: true } }] } });
    expect(state.turn?.lastAction.kind).toBe('tool');
    result(state, 'background');
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });

  it('publishes release when the paired invocation returns before its child ends', () => {
    const state = fresh(); use(state, 'agent', 'Agent');
    mapChatFrame(state, { type: 'system', subtype: 'task_started', task_id: 'child', tool_use_id: 'agent', is_backgrounded: false });
    expect(result(state, 'agent').events).toContainEqual({ type: 'action-changed', turnId: 'turn', kind: 'thinking' });
    expect(state.workers.has('child')).toBe(true);
  });

  it('uses content block end to stop Writing even before the whole message arrives', () => {
    const state = fresh();
    const stream = (event: unknown) => mapChatFrame(state, { type: 'stream_event', parent_tool_use_id: null, event });
    stream({ type: 'message_start', message: { id: 'reply', model: 'claude-sonnet-5' } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    expect(state.turn?.lastAction.kind).toBe('writing');
    stream({ type: 'content_block_stop', index: 0 });
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });
});
