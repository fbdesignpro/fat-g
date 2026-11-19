// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';
import { type ChatPageRequest, type ChatReadRequest } from '@shared/contracts/chat';
import { chatActivity, chatItem, chatItems, fakeChat } from '../test/chat';
import { type FakeBridge, installFakeBridge } from '../test/fake-bridge';
import { conversationCopyText, type ConversationCopySource } from './copy-conversation';

const S = '11111111-1111-4111-8111-111111111111';
const session: ConversationCopySource = { kind: 'session', sessionId: S };
let bridge: FakeBridge;
beforeEach(() => { bridge = installFakeBridge(); });

describe('conversation copy', () => {
  it('reads every page, keeps Markdown and speaker labels, and includes current partial text', async () => {
    const items = chatItems(S, 250);
    items[0] = chatItem(S, 'user', 'The first **question**.', { model: null });
    items[249] = chatItem(S, 'assistant', 'The current `partial` reply', { model: 'model-2', state: 'streaming' });
    const main = fakeChat(S, items);
    const calls: string[] = [];
    bridge.setInvoke((channel, request) => {
      calls.push(channel);
      return Promise.resolve({ ok: true, value: channel === 'chat:read' ? main.read(request as ChatReadRequest) : main.page(request as ChatPageRequest) });
    });
    const text = await conversationCopyText(session, 'Assistant', (key) => key === 'model-2' ? 'Second model' : key, 'Player');
    expect(calls).toEqual(['chat:read', 'chat:page', 'chat:page']);
    expect(text.startsWith('Player:\n\nThe first **question**.')).toBe(true);
    expect(text.endsWith('Second model:\n\nThe current `partial` reply')).toBe(true);
    expect(text.match(/^(Player|Assistant|Second model):$/gm)).toHaveLength(250);
  });

  it('copies messages alone, keeping their text exactly, without notices or tool output', async () => {
    const items = [
      chatItem(S, 'user', '  Question\n  with spacing  '),
      chatActivity(S, 't1', { type: 'command', summary: 'private command' }),
      chatItem(S, 'notice', 'A status notice', { notice: 'turn-failed' }),
      chatItem(S, 'assistant', 'A **reply**.', { model: null }),
    ];
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: fakeChat(S, items).read({ sessionId: S }) }));
    expect(await conversationCopyText(session, 'Assistant')).toBe('You:\n\n  Question\n  with spacing  \n\nAssistant:\n\nA **reply**.');
  });

  it.each([
    [{ kind: 'worker', sessionId: S, workerId: 'worker-1' }, 'chat:readWorker', { sessionId: S, workerId: 'worker-1' }],
    [{ kind: 'aside', sessionId: S, asideId: S }, 'chat:readAside', { sessionId: S, asideId: S }],
    [{ kind: 'detached', id: S }, 'conversations:readDetached', { id: S }],
  ] as const)('keeps %j scoped to its own thread through every page', async (source, channel, request) => {
    const calls: unknown[] = [];
    bridge.setInvoke((name, value) => {
      calls.push([name, value]);
      const earlier = 'before' in (value as object);
      return Promise.resolve({ ok: true, value: { status: 'read', items: [chatItem(S, earlier ? 'user' : 'assistant', earlier ? 'Question' : 'Answer')], older: earlier ? null : 'cursor' } });
    });
    expect(await conversationCopyText(source, 'Assistant')).toBe('You:\n\nQuestion\n\nAssistant:\n\nAnswer');
    expect(calls).toEqual([[channel, request], [channel, { ...request, before: 'cursor' }]]);
  });

  it('rejects a failed older page instead of returning a partial conversation', async () => {
    bridge.setInvoke((channel) => Promise.resolve({ ok: true, value: channel === 'chat:read'
      ? { status: 'read', items: [chatItem(S, 'assistant', 'Newest')], older: 'cursor' }
      : { status: 'refused', reason: 'unknown-cursor' } }));
    await expect(conversationCopyText(session, 'Assistant')).rejects.toThrow('Conversation could not be read.');
  });

  it('rejects an unreadable store and propagates IPC failures', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: { status: 'read', items: [], older: null, storage: 'refused' } }));
    await expect(conversationCopyText(session, 'Assistant')).rejects.toThrow('Conversation could not be read.');
    bridge.setInvoke(() => Promise.resolve({ ok: false, error: 'unavailable' }));
    await expect(conversationCopyText(session, 'Assistant')).rejects.toThrow('IPC call failed: unavailable');
  });

  it('stops if an older cursor repeats', async () => {
    bridge.setInvoke(() => Promise.resolve({ ok: true, value: { status: 'read', items: [], older: 'cursor' } }));
    await expect(conversationCopyText(session, 'Assistant')).rejects.toThrow('Conversation cursor did not advance.');
    expect(bridge.calls).toHaveLength(2);
  });
});
