// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary on Claude (docs/planning/_archive/M26.md, Design 2), against a scripted process: what it is
// launched with and writes, the answer it takes, what it refuses, and its end on every path. The
// real process, through the real process layer, is in tests/claude/secretary.integration.test.ts.
import { describe, expect, it } from 'vitest';
import type { Executable } from '@shared/provider-kit/process';
import { scriptedChat, settled } from './chat-test-support';
import { runClaudeSecretary, SECRETARY_ARGS } from './secretary';

const EXECUTABLE: Executable = { path: 'C:\\bin\\claude.exe', kind: 'native' };
const REQUEST = { instructions: 'Name the session.', text: 'The first message of the session:\n\nFix the login form', model: 'haiku', effort: null };
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', uuid: '11111111-1111-4111-8111-111111111111', parent_tool_use_id: null, message: { id: 'msg_1', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ignored' };

function setup() {
  const chat = scriptedChat();
  const controller = new AbortController();
  const answer = runClaudeSecretary({ context: chat.context, executable: () => EXECUTABLE, argsPrefix: [] }, REQUEST, controller.signal);
  return { chat, controller, answer };
}

describe('the secretary on Claude (M26, Design 2)', () => {
  it('launches with its fixed arguments in the probe folder, writes initialize with the instruction, then the one prompt, and answers the final text', async () => {
    const { chat, answer } = setup();
    await settled();
    const launch = chat.latest();
    expect(launch.args).toEqual([...SECRETARY_ARGS, '--model', 'haiku']);
    expect(launch.options).toEqual({ cwd: 'C:\\probe' });
    // No text of the request on the command line.
    expect(launch.args.join(' ')).not.toContain('login');
    const init = launch.sent('initialize');
    expect(init.request).toEqual({ subtype: 'initialize', systemPrompt: ['Name the session.'] });
    expect(launch.prompts()).toEqual([]);
    launch.reply(init, {});
    await settled();
    expect(launch.prompts()).toEqual([{ type: 'user', message: { role: 'user', content: REQUEST.text }, parent_tool_use_id: null, session_id: '' }]);
    launch.frame({ type: 'system', subtype: 'init', tools: [] });
    launch.frame(assistant('Login form fix'));
    launch.frame(RESULT);
    expect(await answer).toEqual({ kind: 'answered', text: 'Login form fix' });
    expect(launch.ended).toBe(true);
    expect(launch.frames).toHaveLength(2);
  });

  it('names the level where the model has one', async () => {
    const chat = scriptedChat();
    void runClaudeSecretary({ context: chat.context, executable: () => EXECUTABLE, argsPrefix: ['fake.mjs'] }, { ...REQUEST, model: 'sonnet', effort: 'low' }, new AbortController().signal);
    await settled();
    expect(chat.latest().args).toEqual(['fake.mjs', ...SECRETARY_ARGS, '--model', 'sonnet', '--effort', 'low']);
  });

  it('takes the last text of its own that a model wrote: no worker’s, no error’s, no marker’s', async () => {
    const { chat, answer } = setup();
    await settled();
    const launch = chat.latest();
    launch.reply(launch.sent('initialize'), {});
    await settled();
    launch.frame(assistant('First'));
    launch.frame(assistant('A worker’s', { parent_tool_use_id: 'toolu_1' }));
    launch.frame(assistant('An error', { error: 'rate_limit' }));
    launch.frame(assistant('A marker', { message: { id: 'msg_2', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'A marker' }] } }));
    launch.frame(RESULT);
    expect(await answer).toEqual({ kind: 'answered', text: 'First' });
  });

  it('refuses whatever the CLI asks, as the usage client does', async () => {
    const { chat, answer } = setup();
    await settled();
    const launch = chat.latest();
    launch.frame({ type: 'control_request', request_id: 'cli_1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    launch.frame({ type: 'control_request', request_id: 'x'.repeat(200), request: { subtype: 'can_use_tool' } });
    await settled();
    expect(launch.frames.filter((frame) => frame['type'] === 'control_response')).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: 'cli_1', error: 'unsupported' } }]);
    launch.reply(launch.sent('initialize'), {});
    launch.frame(assistant('Fine'));
    launch.frame(RESULT);
    expect(await answer).toEqual({ kind: 'answered', text: 'Fine' });
  });

  it.each([
    ['a refused initialize', (launch: ReturnType<ReturnType<typeof scriptedChat>['latest']>) => launch.refuse(launch.sent('initialize'))],
    ['a result that is an error', (launch: ReturnType<ReturnType<typeof scriptedChat>['latest']>) => { launch.reply(launch.sent('initialize'), {}); launch.frame(assistant('Partial')); launch.frame({ ...RESULT, is_error: true }); }],
    ['a result with no text', (launch: ReturnType<ReturnType<typeof scriptedChat>['latest']>) => { launch.reply(launch.sent('initialize'), {}); launch.frame(RESULT); }],
    ['an end before the result', (launch: ReturnType<ReturnType<typeof scriptedChat>['latest']>) => { launch.reply(launch.sent('initialize'), {}); launch.end(1); }],
  ])('answers no title for %s, and ends the process', async (_name, script) => {
    const { chat, answer } = setup();
    await settled();
    const launch = chat.latest();
    script(launch);
    expect(await answer).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(launch.ended).toBe(true);
  });

  it('ends the process at once when let go of', async () => {
    const { chat, controller, answer } = setup();
    await settled();
    controller.abort();
    expect(await answer).toEqual({ kind: 'failed', reason: 'aborted' });
    expect(chat.latest().closes).toBe(1);
    expect(chat.latest().ended).toBe(true);
  });

  it('launches nothing with no executable, with a request already let go of, or when the launch is refused', async () => {
    const chat = scriptedChat();
    expect(await runClaudeSecretary({ context: chat.context, executable: () => undefined, argsPrefix: [] }, REQUEST, new AbortController().signal)).toEqual({ kind: 'failed', reason: 'unavailable' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await runClaudeSecretary({ context: chat.context, executable: () => EXECUTABLE, argsPrefix: [] }, REQUEST, aborted.signal)).toEqual({ kind: 'failed', reason: 'aborted' });
    expect(chat.launches).toEqual([]);
    chat.failNextLaunch('spawn-failed');
    expect(await runClaudeSecretary({ context: chat.context, executable: () => EXECUTABLE, argsPrefix: [] }, REQUEST, new AbortController().signal)).toEqual({ kind: 'failed', reason: 'unavailable' });
  });
});
