// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V5–V7, V27, V41 (docs/planning/_archive/M16.md, Design 2, 3; C10–C14, C16, C17, C19, C20, C40, C69,
// C88, C89): the launch of a chat session's process — its whole argument line, the folders a shim
// launch would refuse, the one variable it adds, its deadlines on a replaced clock, and its reader.
// And V2, V3, V7 (docs/planning/_archive/M22.md, Design 6, 8; C5, C45, C47, C67): the two arguments a session's
// mode gives its launch, with no flag beside them, and what is read of a line over the limit.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shimRefuses, type Executable } from '@shared/provider-kit/process';
import type { PeekedLine } from '@shared/provider-kit/ndjson';
import type { SessionStart } from '@shared/provider-kit/sessions';
import { CHAT_LAUNCHES, CHAT_FIXED_ARGS as FAKE_FIXED_ARGS, chatFixedArgs as fakeFixedArgs, parseChatArgs } from '../../../../tests/fixtures/claude/replay.mjs';
import { CHAT_ENVIRONMENT, CHAT_TIMINGS, chatArguments, type ChatConnection, chatFixedArgs, ChatLaunchFailure, launchChat } from './chat-launch';
import { CLAUDE_MODE_IDS, CLAUDE_MODES, READING_MODE, READING_TOOLS, WEB_TOOLS } from './chat-modes';
import { manualTimers, scriptedChat, type ScriptedChat, type ScriptedLaunch, settled } from './chat-test-support';
import { CONTROL_ARGS } from './session';

/** The reading mode's launch (M22, C45): M16's fixed list, which the four other modes change two values of. */
const CHAT_FIXED_ARGS = chatFixedArgs(READING_MODE);
const CHAT_TOOLS = READING_TOOLS;
const NATIVE: Executable = { path: 'C:\\bin\\claude.exe', kind: 'native' };
const FOLDER = 'D:\\Code\\fat-g';
const start = (patch: Partial<SessionStart> = {}): SessionStart => ({ folder: FOLDER, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1', ...patch });
const capture = (name: string) => (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { launch: { args: string[] }; frames: { index: number; dir: string; frame: Record<string, unknown> }[] });

describe('a chat session’s arguments (Design 3)', () => {
  it('are the fixed list, exactly: stream-json both ways, the user’s configuration, the default mode with requests to fat-g, the tool list, and the CLI’s commands left on', () => {
    expect([...CHAT_FIXED_ARGS]).toEqual([
      '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
      '--setting-sources', 'user,project,local',
      '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
      // M21 (C16): five, the fifth asking the user a question.
      '--tools', 'Read,Glob,Grep,Agent,AskUserQuestion',
      // M19 (C9): a reply's text as it is written, beside the whole messages.
      '--include-partial-messages',
    ]);
    // M20b (C54; decision 0023): the launch no longer turns the CLI's commands off — a side question is refused where it does (K1, `m20b-flagged`).
    expect(CHAT_FIXED_ARGS).not.toContain('--disable-slash-commands');
    // M21's K1 launch is this list, and with the session it reopened for the capture that resumed one.
    expect([...capture('m21-question-one').launch.args].sort()).toEqual([...chatArguments('native', start(), null).args].sort());
    expect([...capture('m21-question-killed-resumed').launch.args].sort()).toEqual([...chatArguments('native', start(), '<session-1>').args].sort());
    // The captures before it were taken with the four that read: the fifth tool is all that differs.
    const four = (args: readonly string[]): string[] => args.map((arg) => (arg === CHAT_TOOLS.join(',') ? 'Read,Glob,Grep,Agent' : arg));
    // M20b's K1 launch is this list with the session it reopened.
    expect([...capture('m20b-idle').launch.args].sort()).toEqual(four(chatArguments('native', start(), '<session-2>').args).sort());
    expect(capture('m20b-flagged').launch.args).toContain('--disable-slash-commands');
    expect(Object.isFrozen(CHAT_FIXED_ARGS)).toBe(true);
    // No tool that changes a file, runs a command or reaches the network (C14): four read, and one asks the user (M21, C16).
    expect([...CHAT_TOOLS]).toEqual(['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion']);
    // The fake starts a chat session for this list and no other: the two are one.
    expect([...FAKE_FIXED_ARGS]).toEqual([...CHAT_FIXED_ARGS]);
    // And they are the arguments M19's K2 captures were taken under, in another order: K20's, and the one more.
    // But for that flag, which M20b dropped, the launch is the one M19's K2 captures were taken under.
    const traced = capture('m19-t1-basic').launch.args;
    expect([...four(chatArguments('native', start(), null).args), '--disable-slash-commands'].sort()).toEqual([...traced].sort());
    expect([...traced].sort()).toEqual([...capture('m16-t1-basic').launch.args, '--include-partial-messages'].sort());
  });

  it('never carry what the launch rules out, whatever the session', () => {
    const never = ['--no-session-persistence', '--fork-session', '--fallback-model', '--strict-mcp-config', '--session-id', '--name', '--replay-user-messages', '--include-hook-events', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--print', '-p', '--continue', '--settings', '--mcp-config', '--allowedTools', '--debug'];
    const lines = [
      chatArguments('native', start(), null), chatArguments('native', start({ effort: null }), 'ref-1'),
      chatArguments('cmd-shim', start({ otherFolders: ['D:\\second', 'D:\\third (old)'] }), 'ref-1'),
    ].map((made) => made.args);
    for (const args of lines) {
      for (const flag of never) expect(args, flag).not.toContain(flag);
      expect(args).not.toContain('--setting-sources=');
      expect(args.filter((arg) => arg === '--permission-mode')).toHaveLength(1);
      expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
      expect(args[args.indexOf('--setting-sources') + 1]).toBe('user,project,local');
    }
    // A usage session's line is another: nothing of it is a chat session's but the stream-json flags.
    expect(CONTROL_ARGS).toContain('--no-session-persistence');
  });

  it('follow the fixed list with the record’s model and effort, a started session’s reference, and each other folder', () => {
    expect(chatArguments('native', start(), null)).toEqual({ args: [...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low'], leftOut: 0 });
    // A model with no levels has no effort to name.
    expect(chatArguments('native', start({ model: 'opus[1m]', effort: null }), null).args).toEqual([...CHAT_FIXED_ARGS, '--model', 'opus[1m]']);
    expect(chatArguments('native', start(), 'a1b2c3d4-0000-4000-8000-000000000001').args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low', '--resume', 'a1b2c3d4-0000-4000-8000-000000000001']);
    expect(chatArguments('native', start({ otherFolders: ['D:\\second', 'E:\\third one'] }), 'ref').args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low', '--resume', 'ref', '--add-dir', 'D:\\second', '--add-dir', 'E:\\third one']);
    // The working folder is no argument, and neither is a prompt: the line is a function of the start alone.
    for (const made of [chatArguments('native', start(), null), chatArguments('native', start({ otherFolders: ['D:\\second'] }), 'ref')]) expect(made.args).not.toContain(FOLDER);
    // Every line it makes is one the fake starts a chat session for.
    for (const made of [chatArguments('native', start(), null), chatArguments('native', start({ effort: null }), 'ref'), chatArguments('native', start({ otherFolders: ['a', 'b'] }), null)]) expect(parseChatArgs(made.args)).not.toBeNull();
    expect(parseChatArgs(chatArguments('native', start({ otherFolders: ['a', 'b'] }), 'ref').args)).toEqual({ model: 'sonnet', effort: 'low', resume: 'ref', addDirs: ['a', 'b'], mode: 'default', tools: ['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion'] });
  });

  // M22 (V2, V7; C5, C45, C47): the mode gives the launch two values, in the fixed list's own places, and nothing else.
  it('names each mode’s permission mode and tool list in the fixed list’s places, and differs by nothing else: no flag, for the mode that asks nothing either', () => {
    const made = (mode: string | null) => chatArguments('native', start({ mode }), null).args;
    const reading = made('read-only');
    expect(reading).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low']);
    const at = { mode: reading.indexOf('--permission-mode') + 1, tools: reading.indexOf('--tools') + 1 };
    // The three that act, the two of the web, and the plan's tool (M22b, C8).
    const acting = 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit,WebFetch,WebSearch,ExitPlanMode';
    const lines = Object.fromEntries(CLAUDE_MODE_IDS.map((id) => [id, made(id)]));
    expect(CLAUDE_MODE_IDS.map((id) => [id, lines[id]?.[at.mode], lines[id]?.[at.tools]])).toEqual([
      ['read-only', 'default', 'Read,Glob,Grep,Agent,AskUserQuestion'], ['ask-first', 'default', acting], ['edits-ok', 'acceptEdits', acting], ['auto-reviewed', 'auto', acting], ['berserk', 'bypassPermissions', acting],
    ]);
    for (const id of CLAUDE_MODE_IDS) {
      const args = lines[id] ?? [];
      // The same line but for those two values: the same length, the same flags in the same places.
      expect(args.map((arg, index) => (index === at.mode || index === at.tools ? '<mode>' : arg)), id).toEqual(reading.map((arg, index) => (index === at.mode || index === at.tools ? '<mode>' : arg)));
      expect(args.filter((arg) => arg === '--permission-mode'), id).toHaveLength(1);
      expect(args.filter((arg) => arg === '--tools'), id).toHaveLength(1);
      // No flag that bypasses permissions, in either spelling, for any mode (C47; decision 0020, item 4).
      for (const flag of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--allowedTools', '--disallowedTools', '--settings', '--permission-prompt-tool-name']) expect(args, `${id}: ${flag}`).not.toContain(flag);
      expect(args.filter((arg) => /skip-permissions|bypass/i.test(arg)), id).toEqual(id === 'berserk' ? ['bypassPermissions'] : []);
      expect(chatFixedArgs(CLAUDE_MODES[id]), id).toEqual(args.slice(0, CHAT_FIXED_ARGS.length));
      expect(Object.isFrozen(chatFixedArgs(CLAUDE_MODES[id])), id).toBe(true);
    }
    // A start that names no mode, or one this build does not know, is the reading mode's: never a launch that acts.
    for (const mode of [null, 'sandbox-ok', 'bypassPermissions', '']) expect(made(mode), String(mode)).toEqual(reading);
  });

  it('is, for each mode, a launch the fake starts a chat session for, and the launch K2’s and K5’s captures were taken under', () => {
    // The fake's five launches are these five, pair by pair: the two tables are one.
    expect(CHAT_LAUNCHES.map((launch) => [launch.mode, launch.tools])).toEqual(CLAUDE_MODE_IDS.map((id) => [CLAUDE_MODES[id].native, CLAUDE_MODES[id].tools.join(',')]));
    for (const id of CLAUDE_MODE_IDS) {
      const mode = CLAUDE_MODES[id];
      expect([...fakeFixedArgs(mode.native, mode.tools.join(','))], id).toEqual([...chatFixedArgs(mode)]);
      expect(parseChatArgs(chatArguments('native', start({ mode: id, otherFolders: ['a'] }), 'ref').args), id).toEqual({ model: 'sonnet', effort: 'low', resume: 'ref', addDirs: ['a'], mode: mode.native, tools: [...mode.tools] });
    }
    // And no sixth: a tool list that is no mode's, a word that is none, the reading list under a mode that acts.
    const other = (mode: string, tools: string): string[] => [...fakeFixedArgs(mode, tools), '--model', 'sonnet'];
    for (const [mode, tools] of [['default', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit,WebFetch'], ['default', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit,ExitPlanMode'], ['default', 'Read,Glob,Grep,Agent,AskUserQuestion,WebFetch,WebSearch'], ['default', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash'], ['plan', 'Read,Glob,Grep,Agent,AskUserQuestion'], ['dontAsk', 'Read,Glob,Grep,Agent,AskUserQuestion,Bash,Write,Edit'], ['acceptEdits', 'Read,Glob,Grep,Agent,AskUserQuestion'], ['bypassPermissions', 'Read,Glob,Grep,Agent,AskUserQuestion']] as const) expect(parseChatArgs(other(mode, tools)), `${mode} ${tools}`).toBeNull();
    // M22b's K1 launches, each mode's with the plan's tool (C8): this line, in another order, less
    // the two web tools, which their tool lists predate. M22's K2 and K5 launches were these less the
    // plan's tool too.
    const traced: [string, string, Partial<SessionStart>, string | null][] = [
      ['m22b-plan-ask-first', 'ask-first', {}, null], ['m22b-plan-edits-ok', 'edits-ok', {}, null], ['m22b-plan-auto-reviewed', 'auto-reviewed', {}, null], ['m22b-plan-berserk', 'berserk', {}, null],
    ];
    const lessWeb = (args: readonly string[]): string[] => args.map((arg, index) => (args[index - 1] === '--tools' ? arg.split(',').filter((tool) => !WEB_TOOLS.includes(tool as never)).join(',') : arg));
    for (const [name, id, patch, reference] of traced) expect([...capture(name).launch.args].sort(), name).toEqual(lessWeb(chatArguments('native', start({ mode: id, ...patch }), reference).args).sort());
  });

  it('leave out a folder a shim launch would refuse, by the kit’s rule, and say how many; a native launch refuses none (C20)', () => {
    const folders = ['D:\\ok folder', 'D:\\work (old)', 'D:\\R&D', 'D:\\100%', 'D:\\fine-too', 'D:\\a^b', 'D:\\wow!'];
    const shim = chatArguments('cmd-shim', start({ otherFolders: folders }), null);
    expect(shim.args.slice(CHAT_FIXED_ARGS.length + 4)).toEqual(['--add-dir', 'D:\\ok folder', '--add-dir', 'D:\\fine-too']);
    expect(shim.leftOut).toBe(5);
    // What is left out is what the process layer's own rule refuses, and nothing else.
    expect(folders.filter((folder) => !shim.args.includes(folder))).toEqual(folders.filter(shimRefuses));
    for (const arg of shim.args) expect(shimRefuses(arg), arg).toBe(false);
    const native = chatArguments('native', start({ otherFolders: folders }), null);
    expect(native.leftOut).toBe(0);
    expect(native.args.filter((arg, index) => native.args[index - 1] === '--add-dir')).toEqual(folders);
    // A project with one root passes none.
    expect(chatArguments('cmd-shim', start(), null).args).not.toContain('--add-dir');
    // The model key the CLI lists with a bracket passes a shim launch.
    expect(chatArguments('cmd-shim', start({ model: 'opus[1m]' }), null).args.filter(shimRefuses)).toEqual([]);
  });

  it('adds one variable to the scope’s environment, background tasks off, and has the deadlines C88 and C89 give', () => {
    expect(CHAT_ENVIRONMENT).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
    expect(Object.isFrozen(CHAT_ENVIRONMENT)).toBe(true);
    // And how long a worker's frame is held for its pairing (M20a, C22): two seconds, as a Codex worker's closing is held.
    // And how long a side question waits for its reply (M20b, C16): ten minutes.
    // And how long a change of the permission mode waits for its reply (M22, C5): as long as the effort's.
    // And how long a context reading's request waits (decision 0033): as long as the effort's.
    expect(CHAT_TIMINGS).toEqual({ launchMs: 120_000, effortMs: 15_000, modeMs: 15_000, startedMs: 30_000, stopMs: 10_000, pairMs: 2_000, asideMs: 600_000, contextMs: 15_000 });
    // No deadline for the turn's `init`, and none for a turn: they are not here to be set.
    expect(Object.keys(CHAT_TIMINGS).sort()).toEqual(['asideMs', 'contextMs', 'effortMs', 'launchMs', 'modeMs', 'pairMs', 'startedMs', 'stopMs']);
  });
});

interface Launching {
  readonly chat: ScriptedChat;
  readonly timers: ReturnType<typeof manualTimers>;
  readonly frames: unknown[];
  /** `lines`: what was read of each line over the limit (M22, C67). */
  readonly oversized: { count: number; lines: PeekedLine[] };
  readonly abort: AbortController;
  readonly result: Promise<ChatConnection>;
  launch(): ScriptedLaunch;
}

function launching(options: { executable?: Executable; args?: readonly string[]; argsPrefix?: readonly string[]; launchMs?: number; aborted?: boolean; refuse?: boolean } = {}): Launching {
  const chat = scriptedChat();
  const timers = manualTimers();
  const frames: unknown[] = [];
  const oversized = { count: 0, lines: [] as PeekedLine[] };
  const abort = new AbortController();
  if (options.aborted === true) abort.abort();
  if (options.refuse === true) chat.failNextLaunch('spawn-failed');
  const result = launchChat({
    processes: chat.context.processes, logger: chat.context.logger, executable: options.executable ?? NATIVE, argsPrefix: options.argsPrefix ?? [],
    args: options.args ?? chatArguments('native', start(), null).args, folder: FOLDER, launchMs: options.launchMs ?? CHAT_TIMINGS.launchMs, timers, signal: abort.signal,
    onFrame: (frame) => { frames.push(frame); }, onOversized: (line, answer) => { oversized.count += 1; oversized.lines.push(line); if (line.id?.kind === 'string') void answer({ kind: 'deny', requestId: line.id.value }); },
  });
  // The failure is each test's to look at.
  result.catch(() => undefined);
  return { chat, timers, frames, oversized, abort, result, launch: () => chat.latest() };
}

describe('the launch (Design 3)', () => {
  it('opens one process in the session’s folder, with the line it was given after the launch prefix, and the one variable', async () => {
    const l = launching({ argsPrefix: ['fake.mjs', '--fixture-dir', 'X'] });
    await settled();
    expect(l.chat.launches).toHaveLength(1);
    expect(l.launch().executable).toBe(NATIVE);
    expect(l.launch().args).toEqual(['fake.mjs', '--fixture-dir', 'X', ...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low']);
    expect(l.launch().options).toEqual({ cwd: FOLDER, env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } });
    // `initialize`, with nothing in it (C8), and nothing else until it is answered.
    expect(l.launch().frames).toEqual([{ type: 'control_request', request_id: expect.any(String) as string, request: { subtype: 'initialize' } }]);
    l.launch().reply(l.launch().sent('initialize'), { current_permission_mode: 'default', models: [] });
    const connection = await l.result;
    expect(connection.reply).toEqual({ current_permission_mode: 'default', models: [] });
    expect(l.launch().closes).toBe(0);
    expect(l.timers.pending()).toEqual([]);
  });

  it('waits for the reply by its request id: whatever comes first goes to the session, a hook’s frames among them, unparsed (C89, K26)', async () => {
    const l = launching();
    await settled();
    const hooks = capture('m16-chat-hooks').frames.filter((entry) => entry.dir === 'recv' && entry.index < 3).map((entry) => entry.frame);
    expect(hooks.map((frame) => frame['subtype'])).toEqual(['hook_started', 'hook_response']);
    for (const frame of hooks) l.launch().frame(frame);
    // A reply to another id is no reply to this request.
    l.launch().frame({ type: 'control_response', response: { subtype: 'success', request_id: 'someone-else', response: {} } });
    await settled();
    expect(l.frames).toEqual([...hooks, { type: 'control_response', response: { subtype: 'success', request_id: 'someone-else', response: {} } }]);
    let opened = false;
    void l.result.then(() => { opened = true; });
    await settled();
    expect(opened).toBe(false);
    l.launch().reply(l.launch().sent('initialize'), { current_permission_mode: 'default' });
    await l.result;
    // The reply itself is the launch's, not a frame of the session's.
    expect(l.frames).toHaveLength(3);
  });

  it('opens on a reply that comes after 30 seconds and before the deadline, and fails at 120 seconds with none (C89)', async () => {
    const late = launching();
    await settled();
    late.timers.advance(31_000);
    await settled();
    expect(late.launch().closes).toBe(0);
    late.timers.advance(88_000);
    await settled();
    late.launch().reply(late.launch().sent('initialize'), {});
    await expect(late.result).resolves.toMatchObject({ reply: {} });

    const never = launching();
    await settled();
    never.timers.advance(119_999);
    await settled();
    expect(never.launch().closes).toBe(0);
    never.timers.advance(1);
    await expect(never.result).rejects.toMatchObject({ stage: 'initialize', missing: false });
    await expect(never.result).rejects.toBeInstanceOf(ChatLaunchFailure);
    // What was started is closed, and nothing more was written to it.
    expect(never.launch().closes).toBe(1);
    expect(never.launch().frames).toHaveLength(1);
  });

  it('fails when `initialize` is refused, when the process ends first, and when the launch is cancelled, closing what it started', async () => {
    const refused = launching();
    await settled();
    refused.launch().refuse(refused.launch().sent('initialize'));
    await expect(refused.result).rejects.toMatchObject({ stage: 'initialize', missing: false });
    expect(refused.launch().closes).toBe(1);

    const gone = launching();
    await settled();
    gone.launch().end(1);
    await expect(gone.result).rejects.toMatchObject({ stage: 'initialize', missing: false });

    const cancelled = launching();
    await settled();
    cancelled.abort.abort();
    await expect(cancelled.result).rejects.toMatchObject({ stage: 'initialize', missing: false });
    expect(cancelled.launch().closes).toBe(1);
    expect(cancelled.timers.pending()).toEqual([]);
  });

  it('starts nothing for a launch already cancelled, and names a launch the process layer refused as no process', async () => {
    const cancelled = launching({ aborted: true });
    await expect(cancelled.result).rejects.toMatchObject({ stage: 'spawn', missing: false });
    expect(cancelled.chat.launches).toEqual([]);

    const refused = launching({ refuse: true });
    await expect(refused.result).rejects.toMatchObject({ stage: 'spawn', missing: false });
    expect(refused.chat.launches).toEqual([]);
  });

  it('notes the sign of a session Claude no longer has: a `result` that is an error and counts no turn, before any reply (C26, K3)', async () => {
    const missing = capture('m16-resume-failures-missing').frames.find((entry) => entry.dir === 'recv')?.frame as Record<string, unknown>;
    const l = launching({ args: chatArguments('native', start(), 'gone').args });
    await settled();
    l.launch().frame(missing);
    l.launch().end(1);
    await expect(l.result).rejects.toMatchObject({ stage: 'initialize', missing: true });
    // The frame went to the session as any other, to be dropped and counted there; nothing of its text is kept here.
    expect(l.frames).toEqual([missing]);

    // Without the frame, a process that ends the same way has no such sign; nor has a `result` that counts a turn, or is no error.
    for (const frame of [undefined, { ...missing, num_turns: 1 }, { ...missing, is_error: false }, { ...missing, type: 'system' }]) {
      const other = launching({ args: chatArguments('native', start(), 'gone').args });
      await settled();
      if (frame !== undefined) other.launch().frame(frame);
      other.launch().end(1);
      await expect(other.result).rejects.toMatchObject({ stage: 'initialize', missing: false });
    }
  });
});

describe('the reader (C16)', () => {
  const opened = async (): Promise<{ l: Launching; connection: ChatConnection }> => {
    const l = launching();
    await settled();
    l.launch().reply(l.launch().sent('initialize'), {});
    return { l, connection: await l.result };
  };

  it('hands the session each frame, past 4 MiB in all, with the session up', async () => {
    const { l, connection } = await opened();
    const frame = { type: 'user', filler: 'x'.repeat(256 * 1024) };
    for (let n = 0; n < 20; n++) l.launch().frame(frame);
    expect(l.frames).toHaveLength(20);
    expect(l.launch().ended).toBe(false);
    expect(l.launch().closes).toBe(0);
    // And it still takes a request.
    const effort = connection.request({ kind: 'effort', level: 'high' }, 1_000);
    await settled();
    l.launch().reply(l.launch().sent('apply_flag_settings'));
    await expect(effort).resolves.toBeUndefined();
  });

  it('drops a line over the line limit and counts it, and reads the line after it: the limit is a session’s own, 4 MiB (M20a, C16)', async () => {
    const { l } = await opened();
    // A line a megabyte long, which the default limit would drop, is taken.
    l.launch().script.bytes(`${JSON.stringify({ type: 'system', subtype: 'status', filler: 'x'.repeat(1024 * 1024 + 16) })}
`);
    expect(l.oversized.count).toBe(0);
    expect(l.frames).toHaveLength(1);
    l.frames.length = 0;
    l.launch().script.bytes(`${JSON.stringify({ type: 'user', filler: 'x'.repeat(4 * 1024 * 1024 + 16) })}\n`);
    l.launch().frame({ type: 'result', is_error: false });
    expect(l.oversized.count).toBe(1);
    expect(l.frames).toEqual([{ type: 'result', is_error: false }]);
    expect(l.chat.diagnostics).toContainEqual({ type: 'frame-dropped', reason: 'oversized' });
    expect(l.launch().closes).toBe(0);
  });

  it('counts a line that is no JSON and goes on, and stops reading at bytes that are no text', async () => {
    const { l } = await opened();
    l.launch().script.bytes('not json at all\n');
    l.launch().frame({ type: 'system', subtype: 'status' });
    expect(l.frames).toEqual([{ type: 'system', subtype: 'status' }]);
    expect(l.chat.diagnostics).toContainEqual({ type: 'malformed-frame' });

    l.launch().script.bytes(new Uint8Array([0xff, 0xfe, 0x0a]));
    await settled();
    // The framing is broken: the session's process is ended.
    expect(l.launch().closes).toBe(1);
  });
});

describe('a request of fat-g’s (C88)', () => {
  const opened = async (): Promise<{ l: Launching; connection: ChatConnection }> => {
    const l = launching();
    await settled();
    l.launch().reply(l.launch().sent('initialize'), {});
    return { l, connection: await l.result };
  };

  it('is answered by its own reply, fails as refused on an error reply, and at its deadline with none', async () => {
    const { l, connection } = await opened();
    const stop = connection.request({ kind: 'interrupt' }, 10_000);
    const effort = connection.request({ kind: 'effort', level: 'high' }, 15_000);
    await settled();
    l.launch().reply(l.launch().sent('interrupt'), { still_queued: [] });
    await expect(stop).resolves.toEqual({ still_queued: [] });
    l.launch().refuse(l.launch().sent('apply_flag_settings'));
    await expect(effort).rejects.toMatchObject({ code: 'rpc-error' });

    const late = connection.request({ kind: 'effort', level: 'max' }, 15_000);
    await settled();
    l.timers.advance(14_999);
    await settled();
    l.timers.advance(1);
    await expect(late).rejects.toMatchObject({ code: 'timeout' });
    // A reply that comes after the deadline is no reply to anything: it goes to the session, to be counted.
    const before = l.frames.length;
    l.launch().reply(l.launch().sent('apply_flag_settings'));
    expect(l.frames).toHaveLength(before + 1);
  });

  it('fails when the process ends, and afterwards nothing is written', async () => {
    const { l, connection } = await opened();
    const stop = connection.request({ kind: 'interrupt' }, 10_000);
    await settled();
    l.launch().end(0);
    await expect(stop).rejects.toMatchObject({ code: 'transport-closed' });
    await expect(connection.done).resolves.toEqual({ ok: true });
    const written = l.launch().frames.length;
    await expect(connection.request({ kind: 'interrupt' }, 10_000)).rejects.toMatchObject({ code: 'transport-closed' });
    await expect(connection.prompt('m', 'hello')).rejects.toMatchObject({ code: 'transport-closed' });
    // An answer to a process that has ended is not written, and says so (M21, C14): a question's too.
    await expect(connection.answer({ kind: 'deny', requestId: 'r' })).resolves.toBe(false);
    await expect(connection.answer({ kind: 'allow-question', requestId: 'r', tool: 'AskUserQuestion', input: {}, answers: {} })).resolves.toBe(false);
    expect(l.launch().frames).toHaveLength(written);
    expect(l.timers.pending()).toEqual([]);
  });

  it('writes a prompt as one `user` frame under its id, and an answer under the request’s, whose promise is the write’s', async () => {
    const { l, connection } = await opened();
    await connection.prompt('message-1', '/model haiku');
    await expect(connection.answer({ kind: 'deny', requestId: 'cli-7' })).resolves.toBe(true);
    await expect(connection.answer({ kind: 'unsupported', requestId: 'cli-8' })).resolves.toBe(true);
    await settled();
    expect(l.launch().frames.slice(1)).toEqual([
      // A prompt that names a command is written as it is (C69).
      { type: 'user', uuid: 'message-1', message: { role: 'user', content: '/model haiku' }, parent_tool_use_id: null, session_id: '' },
      { type: 'control_response', response: { subtype: 'success', request_id: 'cli-7', response: { behavior: 'deny', message: 'This action is not available in this session.' } } },
      { type: 'control_response', response: { subtype: 'error', request_id: 'cli-8', error: 'unsupported' } },
    ]);
  });

  it('says false for an answer the process refused while it lives, and leaves the process as it is: its owner decides (M21, C66)', async () => {
    const { l, connection } = await opened();
    // Its queue is full: the line is refused, and the process has not ended.
    l.launch().script.failWrites('output-limit');
    const written = l.launch().frames.length;
    await expect(connection.answer({ kind: 'allow-question', requestId: 'cli-9', tool: 'AskUserQuestion', input: { questions: [] }, answers: {} })).resolves.toBe(false);
    await settled();
    expect(l.launch().frames).toHaveLength(written);
    expect(l.launch().closes).toBe(0);
    expect(l.launch().ended).toBe(false);
  });
});

// M22 (V3, V7; C67, C71): of a line over the limit its kind and its request id are read, and nothing else.
describe('a line over the limit, read for its kind and its id (M22: C67)', () => {
  const MIB = 1024 * 1024;
  const opened = async (): Promise<Launching> => {
    const l = launching();
    await settled();
    l.launch().reply(l.launch().sent('initialize'), { current_permission_mode: 'default' });
    await l.result;
    return l;
  };
  const padded = (head: string, tail = ''): string => `${head}"${'x'.repeat(4 * MIB + 64)}"${tail}\n`;

  it('tells the session of a request by its id, whatever it asks for, and hands it the way to answer by that id', async () => {
    const l = await opened();
    // The CLI's own key order: the type, the id, then the request — a file's content of over four mebibytes in it.
    l.launch().script.bytes(padded('{"type":"control_request","request_id":"cli-big-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"C:\\\\private\\\\secret.txt","content":', '}}}'));
    await settled();
    // With the request's tool, read in its own keys (M22b, C79): never its input.
    expect(l.oversized.lines).toEqual([{ request: 'yes', id: { kind: 'string', value: 'cli-big-1' }, size: expect.any(Number) as number, name: 'Write' }]);
    expect(l.oversized.lines[0]?.size).toBeGreaterThan(4 * MIB);
    // Answered by that id, on the line it came on; nothing of the line reached the session as a frame.
    expect(l.launch().frames.at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'cli-big-1', response: { behavior: 'deny', message: 'This action is not available in this session.' } } });
    expect(l.frames).toEqual([]);
    expect(l.chat.diagnostics).toContainEqual({ type: 'frame-dropped', reason: 'oversized' });
    // Nothing of it is in what was read of it but the kind, the id, the size and the tool's name (M22b, C79): no path, no content.
    expect(JSON.stringify(l.oversized.lines)).not.toMatch(/private|secret|xxx/);
    expect(JSON.stringify(l.chat.diagnostics)).not.toMatch(/Write|private|secret|xxx|cli-big-1/);
  });

  it('says a request whose id is past the line’s first bytes is one with no id, a line of no kind may be one, and any other kind is none', async () => {
    const l = await opened();
    // The id after the request: past what is looked at.
    l.launch().script.bytes(padded('{"type":"control_request","request":{"subtype":"can_use_tool","input":{"content":', '}},"request_id":"cli-late"}'));
    // No kind within the first bytes.
    l.launch().script.bytes(padded('{"request":{"content":', '},"type":"control_request","request_id":"cli-later"}'));
    // Kinds that wait for no reply: a tool's result, a reply to a request of fat-g's.
    l.launch().script.bytes(padded('{"type":"user","message":{"content":', '}}'));
    l.launch().script.bytes(padded('{"type":"control_response","response":{"request_id":"fatg_9","response":', '}}'));
    await settled();
    expect(l.oversized.lines.map((line) => [line.request, line.id])).toEqual([['yes', null], ['maybe', null], ['no', null], ['no', null]]);
    for (const line of l.oversized.lines) expect(line.size).toBeGreaterThan(4 * MIB);
    // Nothing was answered: there was no id to answer by.
    expect(l.launch().frames.filter((frame) => frame['type'] === 'control_response')).toEqual([]);
    // The session is up: the next frame is read.
    l.launch().frame({ type: 'system', subtype: 'status' });
    await settled();
    expect(l.frames).toEqual([{ type: 'system', subtype: 'status' }]);
    expect(l.launch().closes).toBe(0);
  });
});
