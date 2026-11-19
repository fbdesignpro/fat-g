// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V10, the Claude adapter's part (docs/planning/_archive/M23.md; C60, C61, C65; K2): the command list
// the `initialize` reply gives — names, descriptions and hints, bounded — reconciled with each `init`'s
// three lists: its skills under Skills, its terminal-bound names left out, a name the reply did not give
// added; a list push replacing it; and nothing before the CLI said anything.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_COMMAND_TEXT } from '@shared/contracts/composer';
import type { Executable } from '@shared/provider-kit/process';
import { takeCommands, takeInit } from './chat-frames';
import { CHAT_TIMINGS } from './chat-launch';
import { createClaudeChatSession } from './chat-session';
import { manualTimers, scriptedChat, settled } from './chat-test-support';

type Frame = { readonly dir: string; readonly frame: Record<string, unknown> };
const capture = JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures/m23-claude-skill.json'), 'utf8')) as { frames: Frame[] };
const reply = capture.frames.find((entry) => (entry.frame['response'] as { response?: { commands?: unknown } } | undefined)?.response?.commands !== undefined)?.frame['response'] as { response: unknown };
const init = capture.frames.find((entry) => entry.frame['type'] === 'system' && entry.frame['subtype'] === 'init')?.frame;

describe('the CLI’s command list (V10; C60, C65)', () => {
  it('reads the initialize reply’s commands as K2 had them: a name, a description and a hint each, bounded', () => {
    const rows = takeCommands(reply.response) ?? [];
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.every((row) => row.group === 'commands' && row.selector === null && !/\s/.test(row.name))).toBe(true);
    expect(rows.find((row) => row.name === 'compact')).toBeTruthy();
    expect(rows.find((row) => row.name === 'design')).toEqual({ name: 'design', description: 'Grant or revoke Claude agent access to your Design projects', hint: 'consent | revoke', group: 'commands', selector: null });
    // A name that is no single token, a control character, and a text past the bound.
    expect(takeCommands({ commands: [{ name: 'two words' }, { name: 'ok', description: `line\u0007${'x'.repeat(500)}`, argumentHint: '' }] })).toEqual([
      { name: 'ok', description: `line ${'x'.repeat(MAX_COMMAND_TEXT - 5)}`, hint: null, group: 'commands', selector: null },
    ]);
    expect(takeCommands({})).toBeNull();
  });

  it('reads init’s three lists of names', () => {
    const taken = takeInit(init);
    expect(taken?.terminalNames).toEqual(['doctor', 'color', 'reload-plugins']);
    expect(taken?.skillNames?.length).toBeGreaterThan(10);
    expect(taken?.commandNames?.length).toBeGreaterThan(40);
  });
});

const NATIVE: Executable = { path: 'C:\\bin\\claude.exe', kind: 'native' };

describe('a session’s commands (V10; C60, C61)', () => {
  async function opened(replyValue: unknown) {
    const chat = scriptedChat();
    const session = createClaudeChatSession({
      context: chat.context, executable: () => NATIVE, argsPrefix: [], timings: CHAT_TIMINGS, timers: manualTimers(),
      start: { folder: 'C:\\work\\project', model: 'sonnet', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1' }, reference: null,
    });
    expect(session.commands()).toBeNull();
    session.send({ turnId: 'turn-1', prompt: 'Hello', effort: 'low', speed: null, messageId: 'message-1' });
    await settled();
    chat.latest().reply(chat.latest().sent('initialize'), { current_permission_mode: 'default', models: [], account: {}, ...(replyValue as object) });
    await settled();
    return { chat, session };
  }

  it('lists the reply’s rows, its skills under Skills once init names them, and none bound to a terminal', async () => {
    const { chat, session } = await opened({ commands: [{ name: 'compact', description: 'Compact the conversation' }, { name: 'marker', description: 'A skill' }, { name: 'doctor', description: 'Check the install' }] });
    expect(session.commands()?.map((row) => [row.name, row.group])).toEqual([['compact', 'commands'], ['marker', 'commands'], ['doctor', 'commands']]);
    chat.latest().frame({ type: 'command_lifecycle', command_uuid: 'message-1', state: 'started', session_id: 'session-1' });
    chat.latest().frame({ type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet-5', tools: ['Task', 'Glob', 'Grep', 'Read'], permissionMode: 'default', slash_commands: ['compact', 'marker', 'doctor', 'review'], skills: ['marker'], terminal_slash_commands: ['doctor'] });
    expect(session.commands()?.map((row) => [row.name, row.group])).toEqual([['compact', 'commands'], ['marker', 'skills'], ['review', 'commands']]);
    // A well-formed push replaces the list (C60): the fake's path, since no push was captured.
    chat.latest().frame({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'fresh', description: 'New' }] });
    expect(session.commands()?.map((row) => row.name)).toEqual(['fresh']);
  });
});
