// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8, V19, the Claude adapter's part (docs/planning/_archive/M23.md; C36, C38, C42–C44, C88; K2): a
// message written while a turn runs — offered only on a process whose `init` says a Stop can drop it,
// under the chat's own mode; written as a prompt's frame under the message's own id; taken into the
// turn at a tool boundary, or run as the CLI's next turn once that turn has ended, as K2's frames have
// it; dropped by a Stop that asks `cancel_queued`; and not confirmed where its process ended first.
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { Executable } from '@shared/provider-kit/process';
import type { TurnRequest } from '@shared/provider-kit/sessions';
import { CHAT_TIMINGS } from './chat-launch';
import { createClaudeChatSession } from './chat-session';
import { manualTimers, scriptedChat, type ScriptedLaunch, settled } from './chat-test-support';

const NATIVE: Executable = { path: 'C:\\bin\\claude.exe', kind: 'native' };
const SESSION = 'session-abc';
const REPLY = { current_permission_mode: 'default', models: [], account: {} };
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'];
const turn: TurnRequest = { turnId: 'turn-1', prompt: 'Count to fifty', effort: 'low', speed: null, messageId: 'message-1' };
const steer = { turnId: 'turn-1', messageId: 'steer-1', prompt: 'Then say done' };

function setup() {
  const chat = scriptedChat();
  const timers = manualTimers();
  const session = createClaudeChatSession({
    context: chat.context, executable: () => NATIVE, argsPrefix: [], timings: CHAT_TIMINGS, timers,
    start: { folder: 'C:\\work\\project', model: 'sonnet', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }, reference: null,
  });
  const events: AgentEvent[] = [];
  session.subscribe((event) => { if (event.type !== 'in-force') events.push(event); });
  const process = (): ScriptedLaunch => chat.latest();
  const frame = (value: Record<string, unknown>): void => process().frame(value);
  const lifecycle = (id: string, state: string): void => frame({ type: 'command_lifecycle', command_uuid: id, state, session_id: SESSION });
  const init = (capabilities: readonly string[] = CAPABILITIES): void => frame({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-5', tools: ['Task', 'Glob', 'Grep', 'Read'], permissionMode: 'default', capabilities });
  return {
    chat, session, events, process, frame, lifecycle, init,
    text(text: string, uuid: string) { frame({ type: 'assistant', uuid, parent_tool_use_id: null, session_id: SESSION, message: { model: 'claude-sonnet-5', id: `msg-${uuid}`, content: [{ type: 'text', text }] } }); },
    result() { frame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'done' }); },
    async running(capabilities: readonly string[] = CAPABILITIES) {
      session.send(turn);
      await settled();
      process().reply(process().sent('initialize'), REPLY);
      await settled();
      lifecycle('message-1', 'queued');
      lifecycle('message-1', 'started');
      init(capabilities);
    },
    types: () => events.map((event) => event.type),
  };
}

describe('Send now on Claude (V8, V19; C36, C42–C44, C88)', () => {
  it('is open only once the turn’s init says a Stop can drop a held message, waits once a Stop is pressed, and is unsupported where the init says none can', async () => {
    const s = setup();
    expect(s.session.steerState()).toBe('wait');
    await s.running();
    expect(s.session.steerState()).toBe('open');
    s.session.stop();
    expect(s.session.steerState()).toBe('wait');
    const without = setup();
    await without.running(['interrupt_receipt_v1', 'msg_lifecycle_v1']);
    expect(without.session.steerState()).toBe('unsupported');
    expect(without.types()).toContain('steer-changed');
  });

  it('says the turn takes a message by a steer-changed event, at an init that names no model and so says nothing else', async () => {
    const s = setup();
    s.session.send(turn);
    await settled();
    s.process().reply(s.process().sent('initialize'), REPLY);
    await settled();
    s.lifecycle('message-1', 'queued');
    s.lifecycle('message-1', 'started');
    expect(s.session.steerState()).toBe('wait');
    expect(s.types()).not.toContain('steer-changed');
    s.frame({ type: 'system', subtype: 'init', session_id: SESSION, tools: ['Task', 'Glob', 'Grep', 'Read'], permissionMode: 'default', capabilities: CAPABILITIES });
    expect(s.session.steerState()).toBe('open');
    expect(s.types()).not.toContain('in-force');
    expect(s.types().filter((type) => type === 'steer-changed')).toHaveLength(1);
    // A frame that changes nothing of it says nothing more.
    s.text('Counting', 'a1');
    expect(s.types().filter((type) => type === 'steer-changed')).toHaveLength(1);
  });

  it('writes a prompt’s frame under the message’s own id, its images as blocks, and is taken into the turn at a tool boundary', async () => {
    const s = setup();
    await s.running();
    const outcome = await s.session.steer({ ...steer, attachments: [{ mediaType: 'image/png', path: 'unused', bytes: new Uint8Array([1, 2, 3]) }] });
    expect(outcome).toEqual({ kind: 'handed' });
    expect(s.process().prompts().at(-1)).toEqual({
      type: 'user', uuid: 'steer-1', parent_tool_use_id: null, session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'Then say done' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }] },
    });
    // K2's fold: queued at once, then started with no init inside the turn, completed, and the one result.
    s.lifecycle('steer-1', 'queued');
    expect(s.events.filter((event) => event.type === 'delivery')).toEqual([]);
    s.lifecycle('steer-1', 'started');
    expect(s.events.at(-1)).toEqual({ type: 'delivery', messageId: 'steer-1', state: 'taken' });
    s.text('done', 'answer-2');
    s.lifecycle('steer-1', 'completed');
    s.result();
    s.lifecycle('message-1', 'completed');
    await settled();
    expect(s.events.filter((event) => event.type === 'turn-ended')).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'answer-2' }]);
    expect(s.events.filter((event) => event.type === 'held-turn-started')).toEqual([]);
  });

  it('runs a message held at the turn’s end as the CLI’s next turn, with its own init and result, as K2’s text-alone case has it', async () => {
    const s = setup();
    await s.running();
    await s.session.steer(steer);
    s.lifecycle('steer-1', 'queued');
    s.text('1 2 3 … 50', 'answer-1');
    s.result();
    s.lifecycle('message-1', 'completed');
    await settled();
    s.lifecycle('steer-1', 'started');
    // The held turn takes a message from its start: said once that turn is the session's own.
    expect(s.events.slice(-2)).toEqual([{ type: 'held-turn-started', turnId: 'steer-1:turn', messageId: 'steer-1' }, { type: 'steer-changed' }]);
    expect(s.session.steerState()).toBe('open');
    s.init();
    s.text('done', 'answer-2');
    s.result();
    s.lifecycle('steer-1', 'completed');
    await settled();
    expect(s.events.filter((event) => event.type === 'turn-ended').map((event) => event.type === 'turn-ended' && [event.turnId, event.outcome, event.answerItemId])).toEqual([['turn-1', 'completed', 'answer-1'], ['steer-1:turn', 'completed', 'answer-2']]);
    expect(s.events.filter((event) => event.type === 'message').map((event) => event.type === 'message' && event.turnId)).toEqual(['turn-1', 'steer-1:turn']);
  });

  it('asks the Stop to drop what the CLI holds, says each dropped message cancelled once, and ends the process where one is still held', async () => {
    const s = setup();
    await s.running();
    await s.session.steer(steer);
    s.lifecycle('steer-1', 'queued');
    s.session.stop();
    const interrupt = s.process().sent('interrupt');
    expect(interrupt['request']).toEqual({ subtype: 'interrupt', cancel_queued: true });
    s.lifecycle('steer-1', 'cancelled');
    s.process().reply(interrupt, { still_queued: [], cancelled: ['steer-1'] });
    await settled();
    expect(s.events.filter((event) => event.type === 'delivery')).toEqual([{ type: 'delivery', messageId: 'steer-1', state: 'cancelled' }]);
    expect(s.process().closes).toBe(0);

    const held = setup();
    await held.running();
    await held.session.steer(steer);
    held.session.stop();
    held.process().reply(held.process().sent('interrupt'), { still_queued: ['steer-1'], cancelled: [] });
    await settled();
    expect(held.process().closes).toBe(1);
    expect(held.events.filter((event) => event.type === 'delivery')).toEqual([{ type: 'delivery', messageId: 'steer-1', state: 'not-confirmed' }]);
  });

  it('asks a plain interrupt where nothing is held', async () => {
    const s = setup();
    await s.running();
    s.session.stop();
    expect(s.process().sent('interrupt')['request']).toEqual({ subtype: 'interrupt' });
  });

  it('says a held message not confirmed where its process ended first', async () => {
    const s = setup();
    await s.running();
    await s.session.steer(steer);
    s.process().end(1);
    await settled();
    expect(s.events.filter((event) => event.type === 'delivery')).toEqual([{ type: 'delivery', messageId: 'steer-1', state: 'not-confirmed' }]);
  });
});
