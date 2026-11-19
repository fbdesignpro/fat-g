// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Replay only the lifecycle fields retained by K1. Redacted content is fixed fixture text here;
// synthetic reorder/failure faults live in the adapters' m105-actions tests, not these captures.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapFrame, newTurn, type MapperState } from '../../src/main/providers/codex/turn-mapper';
import { beginChatTurn, mapChatFrame, newChatMapper } from '../../src/main/providers/claude/chat-mapper';

interface Projection {
  readonly version: string;
  readonly frames: readonly {
    readonly index: number; readonly type: string; readonly subtype?: string; readonly thread?: string; readonly turn?: string;
    readonly parentTool?: string | null; readonly task?: string; readonly toolUse?: string; readonly background?: boolean; readonly status?: string;
    readonly item?: { readonly id: string; readonly type: string; readonly phase?: string; readonly kind?: string; readonly agentThread?: string; readonly tool?: string; readonly receivers?: readonly string[]; readonly status?: string };
    readonly blocks?: readonly { readonly type: string; readonly id?: string; readonly name?: string; readonly tool?: string; readonly error?: boolean }[];
  }[];
}
const capture = (name: string): Projection => JSON.parse(readFileSync(`tests/fixtures/m105/${name}.json`, 'utf8')) as Projection;

describe('M105 versioned lifecycle projections', () => {
  it.each(['tools', 'workers'])('replays Codex %s without retaining a completed local tool', (scenario) => {
    const wire = capture(`codex-${scenario}`);
    expect(wire.version).toBe('0.164.0');
    const state: MapperState = { threadId: 'thread-1', turn: newTurn('runtime', 'turn-2'), workers: new Map(), asides: new Map(), denied: new Set() };
    let ends = 0;
    let anonymous = false;
    const open = new Set<string>();
    for (const frame of wire.frames) {
      if (frame.item === undefined || frame.type !== 'item/started' && frame.type !== 'item/completed') continue;
      const item = frame.item;
      const result = mapFrame(state, frame.type, { threadId: frame.thread, turnId: frame.turn, item: {
        ...item, text: 'Redacted fixture text', agentThreadId: item.agentThread, receiverThreadIds: item.receivers,
      } });
      if (frame.thread === 'thread-1' && frame.type === 'item/started' && ['commandExecution', 'collabAgentToolCall'].includes(item.type)) open.add(item.id);
      if (frame.thread === 'thread-1' && frame.type === 'item/completed' && ['commandExecution', 'collabAgentToolCall'].includes(item.type)) {
        ends += 1;
        open.delete(item.id);
        if (open.size === 0) expect(state.turn?.lastAction.kind).toBe('thinking');
      }
      if (item.tool === 'wait' && frame.type === 'item/started') {
        expect(result.events.at(-1)).toMatchObject({ type: 'action-changed', turnId: 'runtime', kind: 'waiting', wait: { reason: 'provider' } });
        anonymous = true;
      }
    }
    expect(ends).toBeGreaterThan(0);
    expect(anonymous).toBe(scenario === 'workers');
  });

  it.each(['tools', 'workers'])('replays Claude %s tool/result and foreground pairing fields', (scenario) => {
    const wire = capture(`claude-${scenario}`);
    expect(wire.version).toBe('2.1.302');
    const state = newChatMapper('D:\\fixture', true);
    beginChatTurn(state, 'runtime', 'prompt').started = true;
    let ended = 0;
    for (const frame of wire.frames) {
      if (frame.type === 'assistant' || frame.type === 'user') {
        const content = (frame.blocks ?? []).flatMap<Record<string, unknown>>((block) => block.type === 'tool_use'
          ? [{ type: block.type, id: block.id, name: block.name, input: {} }]
          : block.type === 'tool_result' ? [{ type: block.type, tool_use_id: block.tool, is_error: block.error }] : []);
        mapChatFrame(state, { type: frame.type, uuid: `fixture-${frame.index}`, parent_tool_use_id: frame.parentTool ?? null, message: { model: 'claude-fixture', content } });
        ended += (frame.blocks ?? []).filter((block) => block.type === 'tool_result').length;
      } else if (frame.subtype?.startsWith('task_')) {
        mapChatFrame(state, { type: 'system', subtype: frame.subtype, task_id: frame.task, tool_use_id: frame.toolUse, is_backgrounded: frame.background, patch: { status: frame.status }, status: frame.status });
      }
    }
    expect(ended).toBeGreaterThan(0);
    expect(state.turn?.lastAction.kind).toBe('thinking');
  });
});
