// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V5, V10, V11, V13, V30–V32, V38, V39 (docs/planning/_archive/M16.md, Design 4): one Claude chat session, on
// a scripted process and a replaced clock. What it writes and when, what each outcome reads as,
// whose end each end is, and what it counts. The same session on a real process, against the replay
// fake, is in tests/claude/chat/. Its last part is M22's (docs/planning/_archive/M22.md): the session's mode, a
// request to act and its decisions, and a line over the limit.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AgentEvent, AgentEventSchema } from '@shared/contracts/agent-events';
import type { ContextReading } from '@shared/contracts/sessions';
import { type Executable, ProcessFailure } from '@shared/provider-kit/process';
import type { SessionStart, TurnRequest } from '@shared/provider-kit/sessions';
import { CHAT_TIMINGS, chatFixedArgs } from './chat-launch';
import { CLAUDE_MODE_IDS, CLAUDE_MODES, READING_MODE } from './chat-modes';
import { createClaudeChatSession } from './chat-session';
import { manualTimers, scriptedChat, type ScriptedLaunch, settled } from './chat-test-support';
import { DENY_MESSAGE, USER_DENY_MESSAGE } from './chat-wire';

/** The fixed arguments of the reading mode's launch (M22, C45): what every session here runs under, unless its start names another mode. */
const CHAT_FIXED_ARGS = chatFixedArgs(READING_MODE);
const NATIVE: Executable = { path: 'C:\\bin\\claude.exe', kind: 'native' };
const SHIM: Executable = { path: 'C:\\npm\\claude.cmd', kind: 'cmd-shim' };
const FOLDER = 'C:\\work\\project';
const SESSION = 'session-abc';
const REPLY = { current_permission_mode: 'default', models: [], account: { email: 'private@example.test' } };
const turn = (n = 1, effort: string | null = 'low'): TurnRequest => ({ turnId: `turn-${n}`, prompt: `Prompt ${n}`, effort, speed: null, messageId: `message-${n}` });

/** `context` (decision 0033): how the script answers the session's context requests — refused at once, unless a test answers them itself. */
interface SetupOptions { readonly reference?: string | null; readonly executable?: Executable | null; readonly start?: Partial<SessionStart>; readonly context?: 'refuse' | 'manual' }

function setup(options: SetupOptions = {}) {
  const chat = scriptedChat({ context: options.context ?? 'refuse' });
  const timers = manualTimers();
  const executable = options.executable === undefined ? NATIVE : options.executable;
  const session = createClaudeChatSession({
    context: chat.context, executable: () => executable ?? undefined, argsPrefix: [], timings: CHAT_TIMINGS, timers,
    start: { folder: FOLDER, model: 'sonnet', effort: 'low', speed: null, otherFolders: [], mode: 'read-only', processKey: 'process-1', ...options.start }, reference: options.reference ?? null,
  });
  const events: AgentEvent[] = [];
  /**
   * The mode's confirmations (M22, C2), by the id each names, kept apart from `events`: the one a
   * launch's first check brings and the one a confirmed change does carry the mode alone, and
   * M16–M21's tests read the events they always did. What confirms a mode, and when, is this file's
   * last part's to show. A `steer-changed` is left out as well: chat-steer.test.ts reads those.
   */
  const confirmed: string[] = [];
  const readings: ContextReading[] = [];
  session.subscribe((event) => { if (event.type === 'in-force' && event.mode !== undefined) confirmed.push(event.mode); else if (event.type === 'context') readings.push(event.reading); else if (event.type !== 'steer-changed') events.push(event); });
  let closed: { ok: boolean } | undefined;
  void session.closed.then((result) => { closed = result; });
  const process = (): ScriptedLaunch => chat.latest();
  const frame = (value: Record<string, unknown>): void => process().frame(value);
  const helpers = {
    chat, timers, session, events, confirmed, readings, process, frame,
    closed: () => closed,
    types: () => events.map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type)),
    notices: () => events.flatMap((event) => (event.type === 'notice' ? [event] : [])),
    ends: () => events.flatMap((event) => (event.type === 'turn-ended' ? [event] : [])),
    /** What fat-g wrote, by kind: its context requests apart (decision 0033), which this file's last part reads. */
    written: () => process().frames.map((written) => String(written.request?.['subtype'] ?? written['type'])).filter((kind) => kind !== 'get_context_usage'),
    /** Up to the launch's `initialize` being answered: the prompt is then written, unless the effort differs. */
    async open(request = turn(), reply: unknown = REPLY) {
      session.send(request);
      await settled();
      process().reply(process().sent('initialize'), reply);
      await settled();
    },
    lifecycle(state: string, n = 1) { frame({ type: 'command_lifecycle', command_uuid: `message-${n}`, state, session_id: SESSION }); },
    init(patch: Record<string, unknown> = {}) { frame({ type: 'system', subtype: 'init', session_id: SESSION, model: 'claude-sonnet-5', tools: ['Task', 'Glob', 'Grep', 'Read', 'mcp__docs__read'], permissionMode: 'default', apiKeySource: 'none', ...patch }); },
    text(text: string, uuid = 'item-1', patch: Record<string, unknown> = {}) { frame({ type: 'assistant', uuid, parent_tool_use_id: null, session_id: SESSION, message: { model: 'claude-sonnet-5', id: 'msg-1', content: [{ type: 'text', text }] }, ...patch }); },
    tool(name: string, input: Record<string, unknown> = {}, uuid = 'item-t') { frame({ type: 'assistant', uuid, parent_tool_use_id: null, message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 'tool-1', name, input }] } }); },
    result(isError = false) { frame({ type: 'result', subtype: 'success', is_error: isError, num_turns: 1, result: 'private result text' }); },
    worker(id = 'task-1') { frame({ type: 'system', subtype: 'task_started', task_id: id, tool_use_id: 'tool-1', description: 'Read the notes', prompt: 'a private prompt' }); },
    /** Up to the turn's `init`: the CLI took the prompt, and the start is checked. */
    async running(request = turn()) {
      await helpers.open(request);
      const n = Number(request.turnId.split('-')[1]);
      helpers.lifecycle('queued', n);
      helpers.lifecycle('started', n);
      helpers.init();
    },
    /** A turn that runs to its completed end. */
    async complete(request = turn(), n = 1) {
      if (chat.launches.length === 0) await helpers.running(request);
      else { session.send(request); await settled(); helpers.lifecycle('queued', n); helpers.lifecycle('started', n); helpers.init(); }
      helpers.text(`Answer ${n}`, `answer-${n}`);
      helpers.result();
      helpers.lifecycle('completed', n);
      await settled();
    },
  };
  return helpers;
}

const valid = (events: readonly AgentEvent[]): void => { for (const event of events) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 120)).toBe(true); };

describe('a session’s start (V3; C10, C13, C25, C87)', () => {
  it('launches nothing until its first prompt, then one process: `initialize`, and the prompt under the message’s own id', async () => {
    const s = setup();
    await settled();
    expect(s.chat.launches).toEqual([]);
    expect(s.events).toEqual([]);

    await s.open();
    expect(s.chat.launches).toHaveLength(1);
    expect(s.process().args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low']);
    expect(s.process().options).toEqual({ cwd: FOLDER, env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } });
    // The launch's effort is the turn's: no effort is sent, and the prompt follows the reply at once —
    // after the context's request (decision 0033), which nothing waits on.
    expect(s.process().frames).toEqual([
      { type: 'control_request', request_id: expect.any(String) as string, request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: expect.any(String) as string, request: { subtype: 'get_context_usage', detail: 'summary' } },
      { type: 'user', uuid: 'message-1', message: { role: 'user', content: 'Prompt 1' }, parent_tool_use_id: null, session_id: '' },
    ]);
    // Nothing is said until the CLI says it took the prompt.
    expect(s.events).toEqual([]);
  });

  it('runs a turn to its completed end: Claude took it, the model, the reference at the first frame from a model, the text, and the answer named', async () => {
    const s = setup();
    await s.running();
    s.tool('Read', { file_path: 'C:\\work\\project\\notes\\tide.txt' });
    s.text('The tide table is by the door.', 'answer-1');
    s.result();
    s.lifecycle('completed');
    await settled();
    expect(s.events).toEqual([
      { type: 'turn-started', turnId: 'turn-1' },
      { type: 'in-force', turnId: 'turn-1', model: 'claude-sonnet-5' },
      { type: 'session-started', reference: SESSION, folder: FOLDER },
      // The read, as an activity for the chat (M20a, C17): its input as JSON text, and the file it names. Its result never came here.
      { type: 'activity-started', turnId: 'turn-1', itemId: 'tool-1', activityType: 'read', name: 'Read', summary: 'tide.txt', input: '{\n  "file_path": "C:\\\\work\\\\project\\\\notes\\\\tide.txt"\n}', files: [{ path: 'C:\\work\\project\\notes\\tide.txt', line: null }] },
      { type: 'action-changed', turnId: 'turn-1', kind: 'reading', file: 'tide.txt' },
      { type: 'message', turnId: 'turn-1', role: 'assistant', itemId: 'answer-1', phase: 'commentary', text: 'The tide table is by the door.' },
      { type: 'action-changed', turnId: 'turn-1', kind: 'reading', file: 'tide.txt', line: 'The tide table is by the door.' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'answer-1' },
    ]);
    valid(s.events);
    // The process stays up for the next prompt, and nothing of the reply's account or the result's text went anywhere.
    expect(s.process().closes).toBe(0);
    expect(s.closed()).toBeUndefined();
    expect(JSON.stringify(s.events)).not.toMatch(/private/);
  });

  it('takes the next prompt in the same process, and reports the reference once', async () => {
    const s = setup();
    await s.complete(turn(1), 1);
    await s.complete(turn(2), 2);
    expect(s.chat.launches).toHaveLength(1);
    expect(s.written()).toEqual(['initialize', 'user', 'user']);
    expect(s.events.filter((event) => event.type === 'session-started')).toHaveLength(1);
    expect(s.ends()).toEqual([
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'answer-1' },
      { type: 'turn-ended', turnId: 'turn-2', outcome: 'completed', reported: true, answerItemId: 'answer-2' },
    ]);
    expect(s.events.filter((event) => 'turnId' in event && event.turnId === 'turn-2').map((event) => event.type)).toEqual(['turn-started', 'in-force', 'message', 'turn-ended']);
  });

  it('resumes by its reference, in its folder, and reports no reference again', async () => {
    const s = setup({ reference: 'earlier-session', start: { otherFolders: ['D:\\second'] } });
    await s.complete();
    expect(s.process().args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low', '--resume', 'earlier-session', '--add-dir', 'D:\\second']);
    expect(s.events.some((event) => event.type === 'session-started')).toBe(false);
    expect(s.ends()).toHaveLength(1);
  });

  it('writes no second prompt while a turn runs (C30)', async () => {
    const s = setup();
    await s.running();
    s.session.send(turn(2));
    await settled();
    expect(s.written()).toEqual(['initialize', 'user']);
    expect(s.events.some((event) => 'turnId' in event && event.turnId === 'turn-2')).toBe(false);
  });
});

describe('a start that fails (V9, V31; C21, C26, C29, C62)', () => {
  it('with no executable found, or a launch the process layer refuses: nothing was started', async () => {
    for (const how of ['no-executable', 'refused'] as const) {
      const s = setup(how === 'no-executable' ? { executable: null } : {});
      if (how === 'refused') s.chat.failNextLaunch('spawn-failed');
      s.session.send(turn());
      await settled();
      expect(s.events).toEqual([
        { type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'launch' },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' },
      ]);
      expect(s.chat.launches).toEqual([]);
      expect(s.closed()).toEqual({ ok: true });
    }
  });

  it('when `initialize` is refused, late, or the process ends first: the conversation was not started, or not reopened', async () => {
    for (const [reference, step] of [[null, 'open'], ['earlier', 'reopen']] as const) {
      for (const how of ['refused', 'late', 'ended'] as const) {
        const s = setup({ reference });
        s.session.send(turn());
        await settled();
        if (how === 'refused') s.process().refuse(s.process().sent('initialize'));
        else if (how === 'late') s.timers.advance(CHAT_TIMINGS.launchMs);
        else s.process().end(1);
        await settled();
        expect(s.events, `${step} ${how}`).toEqual([
          { type: 'notice', kind: 'start-failed', turnId: 'turn-1', step },
          { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' },
        ]);
        // No prompt was written, and the process is closed.
        expect(s.written()).toEqual(['initialize']);
        expect(s.closed()).toEqual({ ok: true });
        expect(s.timers.pending()).toEqual([]);
      }
    }
  });

  it('offers the removal for a resume with the sign of a session Claude no longer has, and for nothing else (C26)', async () => {
    const sign = { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: 'earlier', errors: ['No conversation found with session ID: earlier'] };
    const missing = setup({ reference: 'earlier' });
    missing.session.send(turn());
    await settled();
    missing.process().frame(sign);
    missing.process().end(1);
    await settled();
    expect(missing.events).toEqual([
      { type: 'notice', kind: 'session-not-reopened', turnId: 'turn-1' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'session-not-reopened' },
    ]);
    expect(missing.written()).toEqual(['initialize']);
    // The frame is a frame of no turn: counted, and nothing of its text is anywhere.
    expect(missing.session.counts.dropped['other-turn']).toBe(1);
    expect(JSON.stringify(missing.events)).not.toContain('No conversation found');

    // The same frame at a new session's launch is no such sign: a new session has no record to remove.
    const fresh = setup();
    fresh.session.send(turn());
    await settled();
    fresh.process().frame(sign);
    fresh.process().end(1);
    await settled();
    expect(fresh.notices()).toEqual([{ type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'open' }]);
  });

  it('writes no prompt when the reply names another permission mode, and closes the process: check 1 (C21)', async () => {
    for (const reply of [{ current_permission_mode: 'acceptEdits' }, { current_permission_mode: 'bypassPermissions' }, {}, null, 'not an object']) {
      const s = setup();
      await s.open(turn(), reply);
      expect(s.events, JSON.stringify(reply)).toEqual([
        { type: 'notice', kind: 'not-read-only', turnId: 'turn-1' },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'not-read-only' },
      ]);
      expect(s.written()).toEqual(['initialize']);
      expect(s.process().closes).toBe(1);
      expect(s.closed()).toEqual({ ok: true });
    }
    // Each name the mode is reported as passes.
    for (const mode of ['default', 'manual']) {
      const s = setup();
      await s.open(turn(), { current_permission_mode: mode });
      expect(s.written()).toEqual(['initialize', 'user']);
    }
  });

  it('says once that a folder was left out of a shim launch, with no path, and nothing for a launch that passes them all (C20)', async () => {
    const shim = setup({ executable: SHIM, start: { otherFolders: ['D:\\fine', 'D:\\work (old)', 'D:\\R&D'] } });
    await shim.running();
    expect(shim.process().args.slice(CHAT_FIXED_ARGS.length + 4)).toEqual(['--add-dir', 'D:\\fine']);
    expect(shim.notices()).toEqual([{ type: 'notice', kind: 'folder-not-passed', turnId: 'turn-1' }]);
    expect(JSON.stringify(shim.events)).not.toMatch(/work \(old\)|R&D|D:/);

    const native = setup({ start: { otherFolders: ['D:\\fine', 'D:\\work (old)', 'D:\\R&D'] } });
    await native.running();
    expect(native.notices()).toEqual([]);
    expect(native.process().args.filter((arg, index) => native.process().args[index - 1] === '--add-dir')).toEqual(['D:\\fine', 'D:\\work (old)', 'D:\\R&D']);
  });

  it('holds itself for a launch whose failed start could not be confirmed gone, and looks again when asked (C71)', async () => {
    const s = setup();
    s.chat.onLaunch = (launch) => { launch.cleanup = { ok: false }; launch.recheck = { ok: false }; };
    s.session.send(turn());
    await settled();
    s.process().refuse(s.process().sent('initialize'));
    await settled();
    expect(s.closed()).toEqual({ ok: false });
    await expect(s.session.recheck()).resolves.toEqual({ ok: false });
    s.process().recheck = { ok: true };
    await expect(s.session.recheck()).resolves.toEqual({ ok: true });
  });
});

describe('the effort (V10; C27) and the speed (decision 0020)', () => {
  it('sends none for a turn at the launch’s effort, and for a model with no levels', async () => {
    const s = setup();
    await s.open(turn(1, 'low'));
    expect(s.written()).toEqual(['initialize', 'user']);
    const bare = setup({ start: { effort: null } });
    await bare.open(turn(1, null));
    expect(bare.process().args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet']);
    expect(bare.written()).toEqual(['initialize', 'user']);
  });

  it('sets another effort before the prompt, with `effortLevel` alone, and holds it for the process', async () => {
    const s = setup();
    await s.open(turn(1, 'high'));
    // The prompt waits for the reply.
    expect(s.written()).toEqual(['initialize', 'apply_flag_settings']);
    expect(s.process().sent('apply_flag_settings').request).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } });
    s.process().reply(s.process().sent('apply_flag_settings'));
    await settled();
    expect(s.written()).toEqual(['initialize', 'apply_flag_settings', 'user']);
    s.lifecycle('started'); s.init(); s.text('Done.', 'a1'); s.result(); s.lifecycle('completed');
    await settled();
    // The next turn at that effort sends none; one at the launch's own sends it again.
    s.session.send(turn(2, 'high'));
    await settled();
    expect(s.written()).toEqual(['initialize', 'apply_flag_settings', 'user', 'user']);
    s.lifecycle('started', 2); s.init(); s.result(); s.lifecycle('completed', 2);
    await settled();
    s.session.send(turn(3, 'low'));
    await settled();
    expect(s.written().slice(-1)).toEqual(['apply_flag_settings']);
    expect(s.process().sent('apply_flag_settings').request).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } });
  });

  // Decision 0020: Claude's fast mode, asked with `fastMode` alone. A process launches
  // at standard speed, so a fast session asks before its first turn, and a change between turns says so first.
  it('asks for fast mode before a fast turn’s prompt, with `fastMode` alone, and sends nothing while the speed stays', async () => {
    const fast = (n: number, effort = 'low'): TurnRequest => ({ ...turn(n, effort), speed: 'fast' });
    const s = setup({ start: { speed: 'fast' } });
    await s.open(fast(1));
    // The prompt waits for the reply; the launch's arguments name no speed.
    expect(s.process().args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low']);
    expect(s.written()).toEqual(['initialize', 'apply_flag_settings']);
    expect(s.process().sent('apply_flag_settings').request).toEqual({ subtype: 'apply_flag_settings', settings: { fastMode: true } });
    s.process().reply(s.process().sent('apply_flag_settings'));
    await settled();
    expect(s.written()).toEqual(['initialize', 'apply_flag_settings', 'user']);
    s.lifecycle('started'); s.init(); s.result(); s.lifecycle('completed');
    await settled();
    // The next fast turn sends none; a standard one turns it off first.
    s.session.send(fast(2));
    await settled();
    expect(s.written()).toEqual(['initialize', 'apply_flag_settings', 'user', 'user']);
    s.lifecycle('started', 2); s.init(); s.result(); s.lifecycle('completed', 2);
    await settled();
    s.session.send(turn(3));
    await settled();
    expect(s.written().slice(-1)).toEqual(['apply_flag_settings']);
    expect(s.process().sent('apply_flag_settings').request).toEqual({ subtype: 'apply_flag_settings', settings: { fastMode: false } });
  });

  it('sends no speed for a standard turn on a new process, and the effort’s change and the speed’s each alone, the effort first', async () => {
    const s = setup();
    await s.open(turn(1, 'low'));
    expect(s.written()).toEqual(['initialize', 'user']);
    const both = setup();
    await both.open({ ...turn(1, 'high'), speed: 'fast' });
    expect(both.process().sent('apply_flag_settings').request).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } });
    both.process().reply(both.process().sent('apply_flag_settings'));
    await settled();
    expect(both.written()).toEqual(['initialize', 'apply_flag_settings', 'apply_flag_settings']);
    expect(both.process().sent('apply_flag_settings').request).toEqual({ subtype: 'apply_flag_settings', settings: { fastMode: true } });
    both.process().reply(both.process().sent('apply_flag_settings'));
    await settled();
    expect(both.written()).toEqual(['initialize', 'apply_flag_settings', 'apply_flag_settings', 'user']);
  });

  it('ends a fast turn as a failed start when fast mode is refused, and writes no prompt', async () => {
    const s = setup();
    await s.open({ ...turn(1), speed: 'fast' });
    s.process().refuse(s.process().sent('apply_flag_settings'));
    await settled();
    expect(s.events).toEqual([
      { type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'send' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' },
    ]);
    expect(s.written()).toEqual(['initialize', 'apply_flag_settings']);
  });

  it('says a fast turn’s served speed before its end — standard, with why extra usage was refused — and nothing of a standard turn’s', async () => {
    const s = setup({ start: { speed: 'fast' } });
    await s.open({ ...turn(1), speed: 'fast' });
    s.process().reply(s.process().sent('apply_flag_settings'));
    await settled();
    s.lifecycle('started'); s.init();
    s.process().frame({ type: 'rate_limit_event', session_id: SESSION, rate_limit_info: { status: 'allowed', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' } });
    s.process().frame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'private result text', fast_mode_state: 'on', usage: { speed: 'standard', service_tier: 'standard' } });
    s.lifecycle('completed');
    await settled();
    const served = s.events.filter((event) => event.type === 'in-force' && 'served' in event);
    expect(served).toEqual([{ type: 'in-force', turnId: 'turn-1', served: 'standard', servedReason: 'out_of_credits' }]);
    expect(s.events.findIndex((event) => event.type === 'in-force' && 'served' in event)).toBeLessThan(s.events.findIndex((event) => event.type === 'turn-ended'));
    const plain = setup();
    await plain.open(turn(1));
    plain.lifecycle('started'); plain.init();
    plain.process().frame({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'x', usage: { speed: 'standard' } });
    await settled();
    expect(plain.events.filter((event) => event.type === 'in-force' && 'served' in event)).toEqual([]);
  });

  it('ends the turn as a failed start when the change is refused, or not answered in 15 seconds, and writes no prompt', async () => {
    for (const how of ['refused', 'late'] as const) {
      const s = setup();
      await s.open(turn(1, 'max'));
      if (how === 'refused') s.process().refuse(s.process().sent('apply_flag_settings'));
      else { s.timers.advance(CHAT_TIMINGS.effortMs - 1); await settled(); expect(s.events).toEqual([]); s.timers.advance(1); }
      await settled();
      expect(s.events, how).toEqual([
        { type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'send' },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' },
      ]);
      expect(s.written()).toEqual(['initialize', 'apply_flag_settings']);
      expect(s.closed()).toEqual({ ok: true });
    }
  });
});

describe('the deadlines, on a replaced clock (V39; C88)', () => {
  it('fails the start when the CLI has not said it took the prompt 30 seconds after its write', async () => {
    const s = setup();
    await s.open();
    s.lifecycle('queued');
    s.timers.advance(CHAT_TIMINGS.startedMs - 1);
    await settled();
    expect(s.events).toEqual([]);
    s.timers.advance(1);
    await settled();
    expect(s.events).toEqual([
      { type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'send' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' },
    ]);
    expect(s.process().closes).toBe(1);
    expect(s.closed()).toEqual({ ok: true });
  });

  it('times nothing after `started`: an `init` held back by a hook of the user’s fails nothing, and is checked when it comes', async () => {
    const s = setup();
    await s.open();
    s.lifecycle('queued');
    s.lifecycle('started');
    // A rate limit comes between the two (K26): the `init` is the next frame read, not the next frame.
    s.frame({ type: 'rate_limit_event', rate_limit_info: {} });
    expect(s.timers.pending()).toEqual([]);
    s.timers.advance(10 * 60_000);
    await settled();
    expect(s.types()).toEqual(['turn-started']);
    expect(s.process().closes).toBe(0);
    s.init();
    s.text('Hello.', 'a1');
    s.result();
    await settled();
    expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'a1' }]);
    // And an `init` that late is still checked.
    const late = setup();
    await late.open();
    late.lifecycle('started');
    late.timers.advance(45_000);
    late.init({ permissionMode: 'acceptEdits' });
    await settled();
    expect(late.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-overruled' }]);
  });

  it('has no deadline for a turn itself', async () => {
    const s = setup();
    await s.running();
    s.timers.advance(6 * 60 * 60_000);
    await settled();
    expect(s.ends()).toEqual([]);
    expect(s.process().closes).toBe(0);
  });
});

describe('check 2, at every `init` (V31; C21, C62, C83)', () => {
  it('ends the process at once and fails the turn as overruled, for another mode or another tool: the prompt had been written', async () => {
    for (const patch of [{ permissionMode: 'acceptEdits' }, { tools: ['Task', 'Glob', 'Grep', 'Read', 'Write'] }, { tools: ['Bash'] }, { permissionMode: 'DEFAULT' }]) {
      const s = setup();
      await s.open();
      s.lifecycle('queued'); s.lifecycle('started');
      s.worker();
      s.init(patch);
      // Whatever follows is no longer read.
      s.text('Too late.', 'late');
      await settled();
      expect(s.types(), JSON.stringify(patch)).toEqual(['turn-started', 'worker-started', 'worker-ended', 'notice:start-overruled', 'turn-ended']);
      expect(s.notices()).toEqual([{ type: 'notice', kind: 'start-overruled', turnId: 'turn-1' }]);
      expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-overruled' }]);
      expect(s.process().closes).toBe(1);
      expect(s.closed()).toEqual({ ok: true });
      // No model was reported for a start that was not the launch's.
      expect(s.events.some((event) => event.type === 'in-force')).toBe(false);
    }
  });

  it('passes the names the CLI reports for the launch, `Task` for `Agent` among them, with any tools of the user’s own', async () => {
    for (const patch of [{}, { permissionMode: 'manual' }, { tools: ['Agent', 'Glob', 'Grep', 'Read'] }, { tools: ['Read'] }, { tools: ['Task', 'mcp__a__write', 'mcp__b__delete_everything'] }]) {
      const s = setup();
      await s.open();
      s.lifecycle('started');
      s.init(patch);
      await settled();
      expect(s.types(), JSON.stringify(patch)).toEqual(['turn-started', 'in-force']);
      expect(s.process().closes).toBe(0);
    }
  });

  it('is made on the `init` of a turn the CLI started by itself: the process is ended, with the notice and no turn to fail', async () => {
    const s = setup();
    await s.complete();
    const before = s.events.length;
    s.worker('task-9');
    // No `started` precedes it: a turn the CLI started by itself.
    s.init({ tools: ['Task', 'Glob', 'Grep', 'Read', 'Write'] });
    await settled();
    expect(s.events.slice(before)).toEqual([
      { type: 'worker-started', workerId: 'task-9', description: 'Read the notes' },
      { type: 'worker-ended', workerId: 'task-9', outcome: 'failed' },
      { type: 'notice', kind: 'start-overruled' },
    ]);
    expect(s.process().closes).toBe(1);
    expect(s.ends()).toHaveLength(1);
    // Unchanged, such a turn's frames are dropped and counted, and the session goes on.
    const quiet = setup();
    await quiet.complete();
    quiet.init();
    quiet.text('The background agent finished.', 'self-1');
    quiet.result();
    await settled();
    expect(quiet.session.counts.dropped['other-turn']).toBe(3);
    expect(quiet.process().closes).toBe(0);
    expect(JSON.stringify(quiet.events)).not.toContain('background agent');
  });
});

describe('Stop (V11; C28)', () => {
  it('cancels a start before the prompt is written: nothing more is written, the turn ends interrupted, the process is closed', async () => {
    const launching = setup();
    launching.session.send(turn());
    await settled();
    launching.session.stop();
    await settled();
    expect(launching.events).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(launching.written()).toEqual(['initialize']);
    expect(launching.closed()).toEqual({ ok: true });

    // While the effort is being set, too.
    const setting = setup();
    await setting.open(turn(1, 'high'));
    setting.session.stop();
    await settled();
    expect(setting.events).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(setting.written()).toEqual(['initialize', 'apply_flag_settings']);
    expect(setting.process().closes).toBe(1);
  });

  it('sends `interrupt` at once, and once, during a turn: the CLI’s `result` then ends it as interrupted, its own end', async () => {
    const s = setup();
    await s.running();
    s.tool('Read', { file_path: 'notes-1.txt' });
    s.session.stop();
    s.session.stop();
    await settled();
    expect(s.written()).toEqual(['initialize', 'user', 'interrupt']);
    s.process().reply(s.process().sent('interrupt'), { still_queued: [] });
    await settled();
    // The reply confirms nothing: the turn is still running.
    expect(s.ends()).toEqual([]);
    s.frame({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    s.result(true);
    s.lifecycle('cancelled');
    await settled();
    expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
    expect(s.notices()).toEqual([]);
    expect(JSON.stringify(s.events)).not.toContain('interrupted by user');
    // The session is ready for the next prompt, on the same process, and the Stop's clock is gone.
    expect(s.process().closes).toBe(0);
    expect(s.timers.pending()).toEqual([]);
  });

  it('sends `interrupt` at once between the prompt and its `init`, and the turn ends interrupted with no message (K22)', async () => {
    const s = setup();
    await s.open();
    s.session.stop();
    await settled();
    expect(s.written()).toEqual(['initialize', 'user', 'interrupt']);
    s.lifecycle('queued'); s.lifecycle('started');
    s.process().reply(s.process().sent('interrupt'), { still_queued: [] });
    s.init();
    s.result(true);
    s.lifecycle('cancelled');
    await settled();
    expect(s.types()).toEqual(['turn-started', 'in-force', 'turn-ended']);
    expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
  });

  it('ends the process 10 seconds after a Stop the CLI has not confirmed, its open workers first', async () => {
    const s = setup();
    await s.running();
    s.worker();
    s.session.stop();
    await settled();
    s.timers.advance(CHAT_TIMINGS.stopMs - 1);
    await settled();
    expect(s.ends()).toEqual([]);
    s.timers.advance(1);
    await settled();
    expect(s.types()).toEqual(['turn-started', 'in-force', 'worker-started', 'worker-ended', 'notice:stop-unconfirmed', 'turn-ended']);
    expect(s.events.slice(-3)).toEqual([
      { type: 'worker-ended', workerId: 'task-1', outcome: 'failed' },
      { type: 'notice', kind: 'stop-unconfirmed', turnId: 'turn-1' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false },
    ]);
    expect(s.process().closes).toBe(1);
    expect(s.closed()).toEqual({ ok: true });
  });

  it('ends the process at once for workers left running after their turn, with no interrupt: no `result` would confirm one (K11)', async () => {
    const s = setup();
    await s.running();
    s.worker();
    s.text('The worker runs in the background.', 'a1');
    s.result();
    s.lifecycle('completed');
    await settled();
    expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'a1' }]);
    s.session.stop();
    await settled();
    expect(s.events.slice(-2)).toEqual([{ type: 'worker-ended', workerId: 'task-1', outcome: 'failed' }, { type: 'notice', kind: 'workers-stopped' }]);
    expect(s.written()).toEqual(['initialize', 'user']);
    expect(s.process().closes).toBe(1);
    expect(s.closed()).toEqual({ ok: true });
  });

  it('does nothing with no turn and no worker', async () => {
    const s = setup();
    await s.complete();
    const before = s.events.length;
    s.session.stop();
    await settled();
    expect(s.events).toHaveLength(before);
    expect(s.process().closes).toBe(0);
  });

  it('ends the worker of an interrupted turn once, by the CLI’s two frames, before the turn’s own end (K11)', async () => {
    const s = setup();
    await s.running();
    s.worker();
    s.session.stop();
    s.frame({ type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'killed' } });
    s.frame({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'stopped' });
    s.result(true);
    await settled();
    expect(s.events.slice(-2)).toEqual([{ type: 'worker-ended', workerId: 'task-1', outcome: 'failed' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
    expect(s.events.filter((event) => event.type === 'worker-ended')).toHaveLength(1);
  });
});

describe('a process that ends (V11; C29, C76, C90)', () => {
  it('fails the turn it cuts, its open workers first: a turn’s end of the session’s own, and no end of the CLI’s', async () => {
    const s = setup();
    await s.running();
    s.worker();
    s.text('Halfway.', 'a1');
    s.process().end(1);
    await settled();
    expect(s.events.slice(-3)).toEqual([
      { type: 'worker-ended', workerId: 'task-1', outcome: 'failed' },
      { type: 'notice', kind: 'connection-lost', turnId: 'turn-1' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' },
    ]);
    expect(s.closed()).toEqual({ ok: true });
    // The reference had come with the text: the next prompt's session resumes it (C90).
    expect(s.events.filter((event) => event.type === 'session-started')).toEqual([{ type: 'session-started', reference: SESSION, folder: FOLDER }]);
  });

  it('ends the turn as interrupted, with no notice, when a Stop had been pressed', async () => {
    const s = setup();
    await s.running();
    s.session.stop();
    s.process().end(1);
    await settled();
    expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(s.notices()).toEqual([]);
  });

  it('is a lost turn from the prompt’s write on, before the CLI said it took it; and a failed start before that write', async () => {
    const written = setup();
    await written.open();
    written.process().end(1);
    await settled();
    expect(written.types()).toEqual(['notice:connection-lost', 'turn-ended']);
    expect(written.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' }]);

    const before = setup();
    await before.open(turn(1, 'high'));
    before.process().end(1);
    await settled();
    expect(before.events).toEqual([
      { type: 'notice', kind: 'start-failed', turnId: 'turn-1', step: 'send' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' },
    ]);
    expect(before.written()).toEqual(['initialize', 'apply_flag_settings']);
    expect(before.closed()).toEqual({ ok: true });
  });

  it('says that workers were lost when it ends with no turn and workers open, and nothing when it ends idle', async () => {
    const s = setup();
    await s.running();
    s.worker();
    s.result();
    await settled();
    s.process().end(0);
    await settled();
    expect(s.events.slice(-2)).toEqual([{ type: 'worker-ended', workerId: 'task-1', outcome: 'failed' }, { type: 'notice', kind: 'workers-lost' }]);

    const idle = setup();
    await idle.complete();
    const before = idle.events.length;
    idle.process().end(0);
    await settled();
    expect(idle.events).toHaveLength(before);
    expect(idle.closed()).toEqual({ ok: true });
  });

  it('takes no prompt once it is over, and tells of an end that could not be confirmed', async () => {
    const s = setup();
    await s.complete();
    s.process().cleanup = { ok: false };
    s.process().recheck = { ok: false };
    await expect(s.session.close()).resolves.toEqual({ ok: false });
    expect(s.closed()).toEqual({ ok: false });
    await expect(s.session.recheck()).resolves.toEqual({ ok: false });
    s.session.send(turn(2));
    await settled();
    expect(s.chat.launches).toHaveLength(1);
    expect(s.written()).toEqual(['initialize', 'user']);
  });
});

describe('close (C29, C76)', () => {
  it('ends a running turn first, as the session’s own end, then the process', async () => {
    const s = setup();
    await s.running();
    s.worker();
    await expect(s.session.close()).resolves.toEqual({ ok: true });
    expect(s.events.slice(-2)).toEqual([{ type: 'worker-ended', workerId: 'task-1', outcome: 'failed' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    // No interrupt is written: the process is ended.
    expect(s.written()).toEqual(['initialize', 'user']);
    expect(s.closed()).toEqual({ ok: true });
    await expect(s.session.recheck()).resolves.toEqual({ ok: true });
  });

  it('waits for a launch under way, and closes what it started', async () => {
    const s = setup();
    s.session.send(turn());
    await settled();
    const closing = s.session.close();
    await expect(closing).resolves.toEqual({ ok: true });
    expect(s.events).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
    expect(s.process().closes).toBe(1);
  });

  it('closes a session that never took a prompt with nothing to end', async () => {
    const s = setup();
    await expect(s.session.close()).resolves.toEqual({ ok: true });
    expect(s.chat.launches).toEqual([]);
    expect(s.events).toEqual([]);
  });
});

describe('requests from the CLI (V32; C22, C85)', () => {
  const ask = (id: string, subtype: unknown, more: Record<string, unknown> = {}) => ({ type: 'control_request', request_id: id, request: { subtype, tool_name: 'Read', input: { file_path: 'C:\\private\\second.txt' }, ...more } });

  it('denies a tool’s use with fat-g’s fixed words, refuses every other request, and counts each under a listed subtype or `other`', async () => {
    const s = setup();
    await s.running();
    s.frame(ask('cli-1', 'can_use_tool'));
    s.frame(ask('cli-2', 'hook_callback'));
    s.frame(ask('cli-3', 'mcp_message'));
    s.frame(ask('cli-4', 'set_permission_mode'));
    s.frame(ask('cli-5', 'C:\\private\\named like a path'));
    s.frame(ask('cli-6', 'can_use_tool'));
    await settled();
    const answers = s.process().frames.filter((frame) => frame['type'] === 'control_response');
    expect(answers).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'cli-1', response: { behavior: 'deny', message: DENY_MESSAGE } } },
      { type: 'control_response', response: { subtype: 'error', request_id: 'cli-2', error: 'unsupported' } },
      { type: 'control_response', response: { subtype: 'error', request_id: 'cli-3', error: 'unsupported' } },
      { type: 'control_response', response: { subtype: 'error', request_id: 'cli-4', error: 'unsupported' } },
      { type: 'control_response', response: { subtype: 'error', request_id: 'cli-5', error: 'unsupported' } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'cli-6', response: { behavior: 'deny', message: DENY_MESSAGE } } },
    ]);
    expect(JSON.stringify(answers)).not.toMatch(/allow/);
    expect(s.session.counts.refused).toEqual({ can_use_tool: 2, hook_callback: 1, mcp_message: 1, other: 2 });
    // The log holds the name from the closed list, and no string the CLI chose.
    const logged = s.chat.diagnostics.flatMap((event) => (event.type === 'request-refused' ? [event.method] : []));
    expect(logged).toEqual(['can_use_tool', 'hook_callback', 'mcp_message', 'other', 'other', 'can_use_tool']);
    expect(JSON.stringify(s.chat.diagnostics)).not.toMatch(/private|set_permission_mode/);
    // One notice for the turn, in the turn; and the turn goes on.
    expect(s.notices()).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
    expect(s.ends()).toEqual([]);
  });

  it('shows one notice a turn, and one for a request that comes with no turn', async () => {
    const s = setup();
    await s.running();
    s.frame(ask('a', 'can_use_tool'));
    s.text('Refused.', 'a1'); s.result(); s.lifecycle('completed');
    await settled();
    s.session.send(turn(2));
    await settled();
    s.lifecycle('started', 2); s.init();
    s.frame(ask('b', 'can_use_tool'));
    s.frame(ask('c', 'can_use_tool'));
    await settled();
    expect(s.notices()).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }, { type: 'notice', kind: 'request-refused', turnId: 'turn-2' }]);
  });

  it('counts a request whose id is too long to echo, and one with none, and answers neither', async () => {
    const s = setup();
    await s.running();
    s.frame(ask('x'.repeat(129), 'can_use_tool'));
    s.frame({ type: 'control_request', request: { subtype: 'can_use_tool' } });
    s.frame({ type: 'control_request', request_id: 'odd', request: 'not an object' });
    await settled();
    expect(s.process().frames.filter((frame) => frame['type'] === 'control_response')).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: 'odd', error: 'unsupported' } }]);
    expect(s.session.counts.refused).toEqual({ can_use_tool: 2, other: 1 });
  });

  it('refuses a request that comes before the launch is answered, too', async () => {
    const s = setup();
    s.session.send(turn());
    await settled();
    s.frame(ask('early', 'can_use_tool'));
    await settled();
    expect(s.process().frames.at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'early', response: { behavior: 'deny', message: DENY_MESSAGE } } });
    expect(s.session.counts.refused).toEqual({ can_use_tool: 1 });
  });
});

describe('what a session reads, drops and counts (V5, V13; C16, C32, C41)', () => {
  it('counts the frames it does not read without parsing them, and the frames of no turn, by reason', async () => {
    const s = setup();
    s.session.send(turn());
    await settled();
    // Before the reply: a hook's frames (K26).
    s.frame({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
    s.frame({ type: 'system', subtype: 'hook_response', output: 'private hook output' });
    s.process().reply(s.process().sent('initialize'), REPLY);
    await settled();
    s.lifecycle('queued'); s.lifecycle('started'); s.init();
    // A `user` frame with no tool result in it: an echo, an interrupt's mark. Not read, as before (M20a, C18).
    s.frame({ type: 'user', message: { content: 'a tool result' } });
    s.frame({ type: 'rate_limit_event' });
    s.frame({ type: 'command_lifecycle', command_uuid: 'someone-else', state: 'started' });
    s.frame({ type: 'command_lifecycle', state: 'started' });
    await settled();
    // Every reason the kit names is counted, also the two a message's deltas are dropped for (M19), which this session never meets until it streams.
    // And M20b's: what came for an aside after its turn ended, and how often a side question was tried again (C14, C15).
    // And M21's: what happened to questions, none of which this session was asked.
    // And M22's: what happened to requests to act and to the mode's reports, of which it met none.
    expect(s.session.counts).toEqual({ dropped: { oversized: 0, 'other-thread': 0, 'other-turn': 1, 'held-overflow': 0, invalid: 1, 'unopened-item': 0, 'completed-item': 0, 'other-worker': 0, 'ended-aside': 0 }, unread: 4, refused: {}, retried: 0, questions: { repeated: 0, unheld: 0, failed: 0 }, approvals: { repeated: 0, unheld: 0 }, plans: { repeated: 0, unheld: 0 }, changed: 0, modesReported: 0, context: { asked: 1, read: 0, failed: 1 } });
    expect(s.chat.diagnostics.filter((event) => event.type === 'frame-dropped')).toEqual([{ type: 'frame-dropped', reason: 'other-turn' }, { type: 'frame-dropped', reason: 'invalid' }]);
    expect(JSON.stringify(s.events)).not.toMatch(/private|hook/);
  });

  it('drops a line over the line limit, counts it, and lets the turn go on to its own end', async () => {
    const s = setup();
    await s.running();
    s.process().script.bytes(`${JSON.stringify({ type: 'user', filler: 'x'.repeat(4 * 1024 * 1024 + 8) })}\n`);
    s.text('Still here.', 'a1');
    s.result();
    s.lifecycle('completed');
    await settled();
    expect(s.session.counts.dropped.oversized).toBe(1);
    expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'a1' }]);
    expect(s.process().closes).toBe(0);
  });

  it('ends a turn whose `result` was lost to the line limit by the closing frame, as that frame reads, with its notice: the CLI’s own end', async () => {
    const lost = async (stop: boolean, state: 'completed' | 'cancelled') => {
      const s = setup();
      await s.running();
      s.text('The answer.', 'a1');
      if (stop) s.session.stop();
      s.process().script.bytes(`${JSON.stringify({ type: 'result', is_error: false, result: 'x'.repeat(4 * 1024 * 1024 + 8) })}\n`);
      s.lifecycle(state);
      await settled();
      return s;
    };
    const completed = await lost(false, 'completed');
    expect(completed.events.slice(-2)).toEqual([{ type: 'notice', kind: 'output-lost', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'a1' }]);
    const stopped = await lost(true, 'cancelled');
    expect(stopped.events.slice(-2)).toEqual([{ type: 'notice', kind: 'output-lost', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
    const failed = await lost(false, 'cancelled');
    expect(failed.events.slice(-2)).toEqual([{ type: 'notice', kind: 'output-lost', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: true, failure: 'end-lost' }]);
    for (const s of [completed, stopped, failed]) { expect(s.session.counts.dropped.oversized).toBe(1); expect(s.process().closes).toBe(0); valid(s.events); }
  });

  it('fails a turn with the CLI’s own text under fat-g’s words, and shows that text as no message (C37)', async () => {
    const s = setup();
    await s.running();
    s.text('There\'s an issue with the selected model.', 'err-1', { error: 'model_not_found', message: { model: '<synthetic>', content: [{ type: 'text', text: 'There\'s an issue with the selected model.' }] } });
    s.result(true);
    s.lifecycle('cancelled');
    await settled();
    expect(s.events.slice(-2)).toEqual([
      { type: 'notice', kind: 'turn-failed', turnId: 'turn-1', detail: 'There\'s an issue with the selected model.' },
      { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: true, failure: 'turn-failed' },
    ]);
    expect(s.events.some((event) => event.type === 'message')).toBe(false);
    // No model answered: the session has no reference yet (C87).
    expect(s.events.some((event) => event.type === 'session-started')).toBe(false);
    valid(s.events);
  });
});

describe('the reference (V38; C87)', () => {
  it('is reported at the session’s first frame from a model, whatever its block, and not at the `init`', async () => {
    for (const first of ['text', 'tool', 'thinking'] as const) {
      const s = setup();
      await s.running();
      expect(s.events.some((event) => event.type === 'session-started'), first).toBe(false);
      if (first === 'text') s.text('Hello.', 'a1');
      else if (first === 'tool') s.tool('Grep', { pattern: 'private' });
      else s.frame({ type: 'assistant', uuid: 'th-1', parent_tool_use_id: null, message: { model: 'claude-sonnet-5', content: [{ type: 'thinking', thinking: '' }] } });
      expect(s.events.filter((event) => event.type === 'session-started')).toEqual([{ type: 'session-started', reference: SESSION, folder: FOLDER }]);
      expect(s.types().indexOf('session-started')).toBe(2);
    }
  });

  it('is not reported for a first turn no model answered, and comes at the same process’s next turn', async () => {
    const s = setup();
    await s.running();
    // The CLI's own answer to a prompt that names a command (C69): no model said it.
    s.text('/model isn\'t available in this environment.', 'cmd-1', { message: { model: '<synthetic>', content: [{ type: 'text', text: '/model isn\'t available in this environment.' }] } });
    s.result();
    s.lifecycle('completed');
    await settled();
    expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'cmd-1' }]);
    expect(s.events.some((event) => event.type === 'session-started')).toBe(false);
    await s.complete(turn(2), 2);
    const started = s.events.filter((event) => event.type === 'session-started');
    expect(started).toEqual([{ type: 'session-started', reference: SESSION, folder: FOLDER }]);
    expect(s.events.indexOf(started[0] as AgentEvent)).toBeGreaterThan(s.events.findIndex((event) => event.type === 'turn-started' && event.turnId === 'turn-2'));
  });
});

// ── M21: a question the model asks the user ───────────────────────────────────────────────────
// V4, V21–V23, V26, V28, V31 (docs/planning/_archive/M21.md, Design 3; C11, C14, C17–C22, C59, C60, C62,
// C63, C65, C67, C70, C72, C75): the request held under its owner, what is written for it and when,
// and what each end says of it. The same through the app's registry and store, against the replay
// fake, is in tests/claude/chat/question.integration.test.ts.
describe('a question the model asks (M21)', () => {
  type Json = Record<string, unknown>;
  const QUESTION = { question: 'Which private file?', header: 'File', options: [{ label: 'secret-a.txt', description: 'The first' }, { label: 'secret-b.txt', description: 'The second' }], multiSelect: false };
  const BOUND = { text: 'Which private file?', header: 'File', options: [{ label: 'secret-a.txt', description: 'The first' }, { label: 'secret-b.txt', description: 'The second' }], multiple: false, freeText: true, secret: false };
  /** The request, as K1 saw one: the tool's name twice, its input, the tool use it belongs to. */
  const asks = (id = 'cli-q1', patch: Json = {}, input: unknown = { questions: [QUESTION] }): Json => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: 'ask-1', requires_user_interaction: true, ...patch } });
  /** The `assistant` frame that carries the same questions, 3 to 5 ms before the request. */
  const uses = (toolUseId = 'ask-1', parent: string | null = null): Json => ({ type: 'assistant', uuid: `uuid-${toolUseId}`, parent_tool_use_id: parent, message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input: { questions: [QUESTION] } }] } });
  const results = (toolUseId = 'ask-1', isError = false, parent: string | null = null): Json => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Your questions have been answered: "Which private file?"="secret-b.txt".', ...(isError ? { is_error: true } : {}) }] } });
  const cancels = (id = 'cli-q1'): Json => ({ type: 'control_cancel_request', request_id: id });
  const allow = (id: string, answers: Record<string, string>, input: Json = { questions: [QUESTION] }): Json => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow', updatedInput: { ...input, answers } } } });
  const deny = (id: string): Json => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: DENY_MESSAGE } } });
  type S = ReturnType<typeof setup>;
  const answers = (s: S): Json[] => s.process().frames.filter((frame) => frame['type'] === 'control_response');
  const raised = (s: S) => s.events.flatMap((event) => (event.type === 'question-raised' ? [event] : []));
  const resolved = (s: S) => s.events.flatMap((event) => (event.type === 'question-resolved' ? [event] : []));
  const SECOND = [{ options: [1], text: null }];
  /** A turn in flight that has asked: the block, then the request. */
  const asking = async (id = 'cli-q1'): Promise<S> => {
    const s = setup();
    await s.running();
    s.frame(uses());
    s.frame(asks(id));
    await settled();
    return s;
  };
  /** A turn in flight with a worker open and paired with the `Agent` tool use that started it. */
  const withWorker = async (): Promise<S> => {
    const s = setup();
    await s.running();
    s.tool('Agent', { description: 'Asks, then reads' });
    s.worker();
    return s;
  };
  /** The parent's turn completes, which ends no worker. */
  const complete = async (s: S): Promise<void> => { s.text('The worker goes on.', 'a1'); s.result(); s.lifecycle('completed'); await settled(); };

  describe('the request (C11, C19, C20)', () => {
    it('raises one event for a request that names the question tool: its questions, its source, the turn, and no activity; and writes nothing until it is answered', async () => {
      const s = await asking();
      expect(raised(s)).toEqual([{ type: 'question-raised', turnId: 'turn-1', requestId: 'cli-q1', sourceId: 'ask-1', questions: [BOUND], cut: false }]);
      valid(s.events);
      expect(s.events.some((event) => event.type === 'activity-started' || event.type === 'activity-ended')).toBe(false);
      expect(answers(s)).toEqual([]);
      expect(s.notices()).toEqual([]);
      expect(s.session.counts.refused).toEqual({});
      // The turn waits: no deadline of fat-g's runs on a question.
      s.timers.advance(6 * 60 * 60_000);
      await settled();
      expect(answers(s)).toEqual([]);
      expect(s.ends()).toEqual([]);
    });

    it('takes the check of the `init` that lists the fifth tool, as K1’s did (C16)', async () => {
      const s = setup();
      await s.open();
      s.lifecycle('started');
      s.init({ tools: ['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read', 'mcp__docs__read'] });
      await settled();
      expect(s.types()).toEqual(['turn-started', 'in-force']);
      expect(s.process().closes).toBe(0);
    });

    it('refuses on the wire a request it cannot place, with the notice and a count, and no event: no turn, before the CLI took the prompt, after the `result`', async () => {
      const places: [string, (s: S) => Promise<void>][] = [
        ['before the launch is answered', async (s) => { s.session.send(turn()); await settled(); }],
        ['before the CLI took the prompt', async (s) => { await s.open(); s.lifecycle('queued'); }],
        ['after the `result`', async (s) => { await s.running(); s.frame(uses()); s.result(); }],
        ['after the turn’s closing frame', async (s) => { await s.complete(); }],
        ['in a turn the CLI started by itself', async (s) => { await s.complete(); s.init(); }],
      ];
      for (const [where, reach] of places) {
        const s = setup();
        await reach(s);
        s.frame(asks());
        await settled();
        expect(raised(s), where).toEqual([]);
        expect(answers(s), where).toEqual([deny('cli-q1')]);
        expect(s.session.counts.refused, where).toEqual({ can_use_tool: 1 });
        expect(s.notices().filter((notice) => notice.kind === 'request-refused'), where).toHaveLength(1);
        // And an answer main might still give names nothing held.
        s.session.answer('cli-q1', SECOND);
        await settled();
        expect(answers(s), where).toHaveLength(1);
        expect(s.session.counts.questions.unheld, where).toBe(1);
      }
    });

    it('refuses what a card cannot draw whole, never cut: 20 questions, none, or what is no list of questions (C60)', async () => {
      const twenty = Array.from({ length: 20 }, (_, n) => ({ ...QUESTION, question: `Question ${n + 1}?` }));
      const inputs: [string, unknown][] = [
        ['20 questions', { questions: twenty }], ['17 questions', { questions: twenty.slice(0, 17) }], ['no question', { questions: [] }],
        ['no list', { questions: 'Which file?' }], ['a question with no text', { questions: [{ header: 'File', options: [] }] }], ['an option with no label', { questions: [{ ...QUESTION, options: [{ description: 'x' }] }] }],
        ['no input', null],
      ];
      for (const [what, input] of inputs) {
        const s = setup();
        await s.running();
        s.frame(uses());
        s.frame(asks('cli-q1', {}, input));
        await settled();
        expect(raised(s), what).toEqual([]);
        expect(answers(s), what).toEqual([deny('cli-q1')]);
        expect(s.session.counts.refused, what).toEqual({ can_use_tool: 1 });
        expect(s.notices(), what).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
        // Its tool use's result, an error as a denied tool's is, says nothing and is no drop.
        s.frame(results('ask-1', true));
        await settled();
        expect(resolved(s), what).toEqual([]);
        expect(s.session.counts.dropped['unopened-item'], what).toBe(0);
      }
      // Sixteen are drawn whole.
      const s = setup();
      await s.running();
      s.frame(asks('cli-q1', {}, { questions: twenty.slice(0, 16) }));
      await settled();
      expect(raised(s)).toHaveLength(1);
      expect(raised(s)[0]?.questions).toHaveLength(16);
      expect(raised(s)[0]?.cut).toBe(false);
    });

    it('refuses a request with no tool use to stand at, or an id an event cannot carry or an answer cannot echo', async () => {
      for (const [what, frame, written] of [
        ['no tool use', asks('cli-q1', { tool_use_id: undefined }), [deny('cli-q1')]],
        ['a tool use that is no id', asks('cli-q1', { tool_use_id: 'x'.repeat(300) }), [deny('cli-q1')]],
        ['an id with a control character', asks('cli\u0007q1'), [deny('cli\u0007q1')]],
        // Over the wire's limit: counted, and not answered, as any request's is.
        ['an id too long to echo', asks('x'.repeat(129)), []],
      ] as const) {
        const s = setup();
        await s.running();
        s.frame(frame);
        await settled();
        expect(raised(s), what).toEqual([]);
        expect(answers(s), what).toEqual(written);
        expect(s.session.counts.refused, what).toEqual({ can_use_tool: 1 });
      }
    });

    it('gives an `elicitation` and a `request_user_dialog` the error reply and the notice, as before, whatever tool they name (C48)', async () => {
      const s = setup();
      await s.running();
      s.frame(asks('cli-e1', { subtype: 'elicitation' }));
      s.frame(asks('cli-d1', { subtype: 'request_user_dialog' }));
      s.frame(asks('cli-t1', { tool_name: 'Read', input: { file_path: 'C:\\private\\second.txt' } }));
      await settled();
      expect(raised(s)).toEqual([]);
      expect(answers(s)).toEqual([
        { type: 'control_response', response: { subtype: 'error', request_id: 'cli-e1', error: 'unsupported' } },
        { type: 'control_response', response: { subtype: 'error', request_id: 'cli-d1', error: 'unsupported' } },
        deny('cli-t1'),
      ]);
      expect(s.session.counts.refused).toEqual({ elicitation: 1, request_user_dialog: 1, can_use_tool: 1 });
      expect(s.notices()).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
      expect(JSON.stringify(answers(s))).not.toMatch(/allow/);
    });

    it('opens nothing for a request delivered again under an id it holds, counts it, and gives each delivery the same reply when it comes (C11)', async () => {
      const s = await asking();
      s.frame(asks());
      s.frame(asks());
      await settled();
      expect(raised(s)).toHaveLength(1);
      expect(s.session.counts.questions.repeated).toBe(2);
      expect(answers(s)).toEqual([]);
      s.session.answer('cli-q1', SECOND);
      await settled();
      const reply = allow('cli-q1', { 'Which private file?': 'secret-b.txt' });
      expect(answers(s)).toEqual([reply, reply, reply]);
      // One that comes after the reply went gets it at once, and still opens nothing.
      s.frame(asks());
      await settled();
      expect(answers(s)).toEqual([reply, reply, reply, reply]);
      expect(raised(s)).toHaveLength(1);
      expect(s.session.counts.questions).toEqual({ repeated: 3, unheld: 0, failed: 0 });
      // And where main refuses it, each delivery is denied.
      const refused = await asking();
      refused.frame(asks());
      refused.session.answer('cli-q1', null);
      await settled();
      expect(answers(refused)).toEqual([deny('cli-q1'), deny('cli-q1')]);
      expect(refused.session.counts.refused).toEqual({ can_use_tool: 1 });
    });
  });

  describe('the answer (C14, C17, C18, C59, C62, C63)', () => {
    it('is written as `allow` with the request’s input as it came and the answers by the question’s whole text, and its tool result marks it confirmed', async () => {
      const s = await asking();
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(answers(s)).toEqual([allow('cli-q1', { 'Which private file?': 'secret-b.txt' })]);
      // No event says an answer was written: every outcome of it is one, and the first is the CLI's word.
      expect(resolved(s)).toEqual([]);
      s.frame(results());
      await settled();
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'confirmed' }]);
      valid(s.events);
      // The turn goes on to its own end, and nothing was refused or dropped.
      s.text('It says one line.', 'a1'); s.result(); s.lifecycle('completed');
      await settled();
      expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'a1' }]);
      expect(s.session.counts.refused).toEqual({});
      expect(Object.values(s.session.counts.dropped).every((count) => count === 0)).toBe(true);
      expect(s.session.counts.questions).toEqual({ repeated: 0, unheld: 0, failed: 0 });
    });

    it('encodes K1’s three answers frame for frame, from the answers by their places', async () => {
      const capture = (name: string) => (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { frames: { dir: string; frame: Json }[] }).frames;
      for (const [name, given] of [
        ['m21-question-one', [{ options: [1], text: null }]],
        // Several chosen: joined by a comma and a space, in the order they were given.
        ['m21-question-multi', [{ options: [0, 2], text: null }]],
        // Free text that is no option, and an option of the second question.
        ['m21-question-two', [{ options: [], text: 'notes-3.txt' }, { options: [1], text: null }]],
      ] as const) {
        const frames = capture(name);
        const request = frames.find((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request')?.frame as Json;
        const sent = frames.find((entry) => entry.dir === 'send' && entry.frame['type'] === 'control_response')?.frame;
        const s = setup();
        await s.running();
        s.frame(request);
        await settled();
        s.session.answer(String(request['request_id']), given);
        await settled();
        expect(answers(s), name).toEqual([sent]);
      }
    });

    it('joins several options and a typed text by a comma and a space in the one string, the text last (C18)', async () => {
      for (const [given, text] of [
        [[{ options: [0], text: null }], 'secret-a.txt'],
        [[{ options: [1, 0], text: null }], 'secret-b.txt, secret-a.txt'],
        [[{ options: [], text: 'neither, thank you' }], 'neither, thank you'],
        [[{ options: [1], text: ' and the log ' }], 'secret-b.txt,  and the log '],
        [[{ options: [0, 1], text: 'both' }], 'secret-a.txt, secret-b.txt, both'],
      ] as const) {
        const s = await asking();
        s.session.answer('cli-q1', given);
        await settled();
        expect(answers(s), text).toEqual([allow('cli-q1', { 'Which private file?': text })]);
      }
    });

    it('encodes from the request as it came, never from what was cut for the card: the whole key, and the whole label of an option by its place (C59)', async () => {
      const long = `${'Which of these files do you mean? '.repeat(20)}THE END OF THE QUESTION`;
      const alike = 'x'.repeat(500);
      const options = [{ label: `${alike}-first`, description: 'd'.repeat(2_500) }, { label: `${alike}-second`, description: 'One' }, ...Array.from({ length: 7 }, (_, n) => ({ label: `option-${n + 3}`, description: 'More' }))];
      const input = { questions: [{ question: long, header: 'h'.repeat(600), options, multiSelect: true }], metadata: { source: 'kept as it came' } };
      const s = setup();
      await s.running();
      s.frame(asks('cli-q1', {}, input));
      await settled();
      // The card's view: every text within its bound, eight options of nine, and the flag.
      const [event] = raised(s);
      expect(event?.cut).toBe(true);
      expect(event?.questions[0]?.text).toHaveLength(500);
      expect(event?.questions[0]?.header).toHaveLength(500);
      expect(event?.questions[0]?.options).toHaveLength(8);
      expect(event?.questions[0]?.options.slice(0, 2).map((option) => option.label)).toEqual([alike, alike]);
      expect(event?.questions[0]?.options[0]?.description).toHaveLength(2_000);
      valid(s.events);
      // The answer: two options alike for their first 500 units each give their own, and the input goes back whole.
      s.session.answer('cli-q1', [{ options: [1, 0], text: null }]);
      await settled();
      expect(answers(s)).toEqual([allow('cli-q1', { [long]: `${alike}-second, ${alike}-first` }, input)]);
    });

    it('gives every question of a request its own key, and an empty string where nothing was chosen or typed', async () => {
      const input = { questions: [QUESTION, { question: 'In which language?', header: 'Language', options: [{ label: 'English' }, { label: 'French' }], multiSelect: false }, { question: '__proto__', options: [] }] };
      const s = setup();
      await s.running();
      s.frame(asks('cli-q1', {}, input));
      await settled();
      expect(raised(s)[0]?.questions.map((question) => [question.text, question.header, question.options.length])).toEqual([['Which private file?', 'File', 2], ['In which language?', 'Language', 2], ['__proto__', null, 0]]);
      s.session.answer('cli-q1', [{ options: [0], text: null }, { options: [], text: null }, { options: [], text: 'typed' }]);
      await settled();
      const written = (answers(s)[0] as { response: { response: { updatedInput: { answers: Record<string, string> } } } }).response.response.updatedInput.answers;
      expect(Object.entries(written)).toEqual([['Which private file?', 'secret-a.txt'], ['In which language?', ''], ['__proto__', 'typed']]);
    });

    it('fails nothing at a tool result that carries the error flag after an answer: confirmed all the same, and counted (C19)', async () => {
      const s = await asking();
      s.session.answer('cli-q1', SECOND);
      s.frame(results('ask-1', true));
      await settled();
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'confirmed' }]);
      expect(s.session.counts.questions.failed).toBe(1);
      expect(s.events.some((event) => event.type === 'activity-ended' || event.type === 'notice')).toBe(false);
      expect(s.ends()).toEqual([]);
    });

    it('counts an answer, or a refusal, that names a request it does not hold, and writes nothing for it: unknown, answered already, or refused', async () => {
      const s = await asking();
      s.session.answer('no-such-request', SECOND);
      s.session.answer('no-such-request', null);
      s.session.answer('cli-q1', SECOND);
      s.session.answer('cli-q1', [{ options: [0], text: null }]);
      s.session.answer('cli-q1', null);
      await settled();
      expect(answers(s)).toEqual([allow('cli-q1', { 'Which private file?': 'secret-b.txt' })]);
      expect(s.session.counts.questions.unheld).toBe(4);
      expect(resolved(s)).toEqual([]);
      expect(s.session.counts.refused).toEqual({});
    });

    it('sends nothing as an answer that does not fit the request: said as not taken, and the process is ended', async () => {
      for (const given of [[], [{ options: [0], text: null }, { options: [1], text: null }], [{ options: [2], text: null }], [{ options: [-1], text: null }]]) {
        const s = await asking();
        s.session.answer('cli-q1', given);
        await settled();
        expect(answers(s), JSON.stringify(given)).toEqual([]);
        expect(resolved(s), JSON.stringify(given)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'dropped' }]);
        expect(s.process().closes).toBe(1);
      }
    });
  });

  describe('a refusal main asks for (C11, C30)', () => {
    it('denies the request on the wire, with the notice and its count, and says nothing more of it', async () => {
      const s = await asking();
      s.session.answer('cli-q1', null);
      await settled();
      expect(answers(s)).toEqual([deny('cli-q1')]);
      expect(s.notices()).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
      expect(s.session.counts.refused).toEqual({ can_use_tool: 1 });
      expect(s.chat.diagnostics.filter((event) => event.type === 'request-refused')).toEqual([{ type: 'request-refused', method: 'can_use_tool' }]);
      expect(resolved(s)).toEqual([]);
      // The denied tool's result is an error: no confirmation, no drop.
      s.frame(results('ask-1', true));
      await settled();
      expect(resolved(s)).toEqual([]);
      expect(s.session.counts.dropped['unopened-item']).toBe(0);
      expect(s.ends()).toEqual([]);
    });

    it('takes one made from inside its own emission of the question: the request is held before it is said', async () => {
      const s = setup();
      await s.running();
      const order: string[] = [];
      s.session.subscribe((event) => {
        if (event.type !== 'question-raised') return;
        order.push('raised');
        s.session.answer(event.requestId, null);
        order.push(`written ${s.process().frames.filter((frame) => frame['type'] === 'control_response').length}`);
      });
      s.frame(asks());
      await settled();
      expect(order).toEqual(['raised', 'written 1']);
      expect(answers(s)).toEqual([deny('cli-q1')]);
      expect(s.session.counts.questions.unheld).toBe(0);
      // Nothing is held of it afterwards.
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(answers(s)).toHaveLength(1);
      expect(s.session.counts.questions.unheld).toBe(1);
    });
  });

  describe('the CLI takes it back (C20, C22)', () => {
    it('says `withdrawn` for a cancel that names a held request while the turn runs, and nothing more at its result', async () => {
      const s = await asking();
      s.frame(cancels());
      await settled();
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'withdrawn' }]);
      valid(s.events);
      s.frame(results('ask-1', true));
      s.frame({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
      await settled();
      expect(resolved(s)).toHaveLength(1);
      expect(answers(s)).toEqual([]);
      expect(s.session.counts.dropped['unopened-item']).toBe(0);
      // The turn went on, and an answer that still comes finds nothing held.
      expect(s.ends()).toEqual([]);
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(answers(s)).toEqual([]);
      expect(s.session.counts.questions.unheld).toBe(1);
    });

    it('says nothing for the cancel that follows a Stop: the `result` after it ends the turn interrupted, as K1’s Stop showed (C22)', async () => {
      const s = await asking();
      s.session.stop();
      await settled();
      expect(s.written()).toEqual(['initialize', 'user', 'interrupt']);
      // K1's order: the cancel, the interrupt's reply, the error result, the mark, the `result`, the closing frame.
      s.frame(cancels());
      s.process().reply(s.process().sent('interrupt'), { still_queued: [] });
      s.frame(results('ask-1', true));
      s.frame({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
      s.frame({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 3, terminal_reason: 'aborted_tools' });
      s.lifecycle('cancelled');
      await settled();
      expect(resolved(s)).toEqual([]);
      expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
      expect(s.notices()).toEqual([]);
      expect(answers(s)).toEqual([]);
      expect(s.process().closes).toBe(0);
      expect(s.timers.pending()).toEqual([]);
    });

    it('does not read a cancel that names no request it holds, as before: counted, and nothing said', async () => {
      const s = await asking();
      const before = s.session.counts.unread;
      s.frame(cancels('someone-else'));
      s.frame({ type: 'control_cancel_request' });
      await settled();
      expect(s.session.counts.unread).toBe(before + 2);
      expect(resolved(s)).toEqual([]);
      // The held one is untouched.
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(answers(s)).toHaveLength(1);
    });

    it('says `withdrawn` at a result nobody answered and no cancel preceded, since the model went on without an answer', async () => {
      const s = await asking();
      s.frame(results('ask-1', true));
      await settled();
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'withdrawn' }]);
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(answers(s)).toEqual([]);
      expect(s.session.counts.questions).toEqual({ repeated: 0, unheld: 1, failed: 0 });
    });

    it('makes no confirmation of a result that follows a cancel of a request it had answered: the answer crossed the withdrawal', async () => {
      const s = await asking();
      s.session.answer('cli-q1', SECOND);
      s.frame(cancels());
      s.frame(results('ask-1', true));
      await settled();
      // Main's registry takes the first to arrive: its own answer. The withdrawal is said, and counted there.
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'withdrawn' }]);
    });
  });

  describe('a hold goes with its owner (C12, C65)', () => {
    it('lets the session’s own go at its turn’s end, with no event: an answer after it names nothing held', async () => {
      for (const how of ['result', 'stop-unconfirmed', 'close'] as const) {
        const s = await asking();
        if (how === 'result') { s.result(); s.lifecycle('completed'); await settled(); }
        else if (how === 'stop-unconfirmed') { s.session.stop(); await settled(); s.timers.advance(CHAT_TIMINGS.stopMs); await settled(); }
        else await s.session.close();
        expect(s.ends(), how).toHaveLength(1);
        // No word of the question from the adapter: main's sweep at the turn's end settles the card.
        expect(resolved(s), how).toEqual([]);
        s.session.answer('cli-q1', SECOND);
        await settled();
        expect(answers(s), how).toEqual([]);
        expect(s.session.counts.questions.unheld, how).toBe(1);
      }
    });

    it('raises a worker’s request under the worker, in the turn that started it, before the parent’s `result` and after it (C21)', async () => {
      for (const after of [false, true]) {
        const s = await withWorker();
        if (after) await complete(s);
        s.frame(uses('w-ask-1', 'tool-1'));
        s.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-ask-1' }));
        await settled();
        expect(raised(s), String(after)).toEqual([{ type: 'question-raised', turnId: 'turn-1', workerId: 'task-1', requestId: 'cli-w1', sourceId: 'w-ask-1', questions: [BOUND], cut: false }]);
        valid(s.events);
        // No activity of the worker's for it, and nothing refused: its item's own three starts alone — the
        // tool use, the pairing, and the model the worker's first frame named (M106, C14).
        expect(s.events.filter((event) => event.type === 'activity-started').map((event) => event.itemId)).toEqual(['tool-1', 'tool-1', 'tool-1']);
        expect(answers(s)).toEqual([]);
        expect(s.session.counts.refused).toEqual({});
      }
    });

    it('keeps a worker’s hold past the parent’s `result`, answers it there, and confirms it by the worker’s own result (C65, C72)', async () => {
      for (const [asked, flagged] of [['before', false], ['after', false], ['before', true], ['after', true]] as const) {
        const s = await withWorker();
        if (asked === 'after') await complete(s);
        s.frame(uses('w-ask-1', 'tool-1'));
        s.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-ask-1' }));
        if (asked === 'before') await complete(s);
        // The parent's turn is over, and the worker runs: its question is still held.
        expect(s.ends(), asked).toHaveLength(1);
        expect(resolved(s), asked).toEqual([]);
        s.session.answer('cli-w1', SECOND);
        await settled();
        expect(answers(s), asked).toEqual([allow('cli-w1', { 'Which private file?': 'secret-b.txt' })]);
        s.frame(results('w-ask-1', flagged, 'tool-1'));
        await settled();
        expect(resolved(s), asked).toEqual([{ type: 'question-resolved', requestId: 'cli-w1', reason: 'confirmed' }]);
        expect(s.session.counts.questions.failed, asked).toBe(flagged ? 1 : 0);
        expect(s.events.some((event) => event.type === 'worker-ended'), asked).toBe(false);
        valid(s.events);
      }
    });

    it('lets a worker’s go at the worker’s end, by its frames or by a Stop, with no event; the session’s own stays', async () => {
      for (const how of ['notified', 'stopped'] as const) {
        const s = await withWorker();
        s.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-ask-1' }));
        s.frame(asks('cli-q1'));
        await settled();
        expect(raised(s).map((event) => [event.requestId, event.workerId])).toEqual([['cli-w1', 'task-1'], ['cli-q1', undefined]]);
        if (how === 'notified') {
          s.frame({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'tool-1', status: 'completed', summary: 'Done.' });
          await settled();
          expect(s.events.filter((event) => event.type === 'worker-ended')).toHaveLength(1);
          expect(resolved(s)).toEqual([]);
          s.session.answer('cli-w1', SECOND);
          s.session.answer('cli-q1', SECOND);
          await settled();
          // The worker's is gone; the session's own, whose turn runs, is answered.
          expect(answers(s)).toEqual([allow('cli-q1', { 'Which private file?': 'secret-b.txt' })]);
          expect(s.session.counts.questions.unheld).toBe(1);
        } else {
          // The parent completes, the worker runs on; a Stop then ends the worker and the process.
          await complete(s);
          s.session.stop();
          await settled();
          expect(s.events.slice(-3).map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type))).toEqual(['activity-ended', 'worker-ended', 'notice:workers-stopped']);
          expect(resolved(s)).toEqual([]);
        }
      }
    });

    it('takes a request that names an agent no worker was paired as for the session’s own, and refuses one that names a worker that has ended', async () => {
      const s = await withWorker();
      s.frame(asks('cli-q1', { agent_id: 'no-such-worker' }));
      await settled();
      expect(raised(s)).toEqual([{ type: 'question-raised', turnId: 'turn-1', requestId: 'cli-q1', sourceId: 'ask-1', questions: [BOUND], cut: false }]);
      s.frame({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'tool-1', status: 'completed', summary: 'Done.' });
      s.frame(asks('cli-w2', { agent_id: 'task-1', tool_use_id: 'w-ask-2' }));
      await settled();
      expect(raised(s)).toHaveLength(1);
      expect(answers(s)).toEqual([deny('cli-w2')]);
      // And with no turn of the session's, an unpaired agent's is placed nowhere.
      const idle = setup();
      await idle.complete();
      idle.frame(asks('cli-q9', { agent_id: 'no-such-worker' }));
      await settled();
      expect(raised(idle)).toEqual([]);
      expect(answers(idle)).toEqual([deny('cli-q9')]);
    });
  });

  describe('the process ends with a question held (C14, C67, C70)', () => {
    it('says `dropped` for each request it still held unanswered, the session’s own and a worker’s, before the ends it makes for the loss', async () => {
      const s = await withWorker();
      s.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-ask-1' }));
      s.frame(asks('cli-q1'));
      await settled();
      const before = s.events.length;
      s.process().end(1);
      await settled();
      expect(s.events.slice(before)).toEqual([
        { type: 'question-resolved', requestId: 'cli-w1', reason: 'dropped' },
        { type: 'question-resolved', requestId: 'cli-q1', reason: 'dropped' },
        { type: 'activity-ended', turnId: 'turn-1', itemId: 'tool-1', status: 'failed' },
        { type: 'worker-ended', workerId: 'task-1', outcome: 'failed' },
        { type: 'notice', kind: 'connection-lost', turnId: 'turn-1' },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' },
      ]);
      valid(s.events);
      expect(s.closed()).toEqual({ ok: true });
    });

    it('names the unanswered holds alone: one answered whose line went is let go with no word, confirmed or not (C70)', async () => {
      const s = await withWorker();
      s.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-ask-1' }));
      s.frame(asks('cli-q1'));
      await settled();
      // The write went; no tool result came to confirm it.
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(answers(s)).toHaveLength(1);
      s.process().end(1);
      await settled();
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-w1', reason: 'dropped' }]);
      expect(s.types().slice(-4)).toEqual(['activity-ended', 'worker-ended', 'notice:connection-lost', 'turn-ended']);
    });

    it('says it for a worker’s held after its parent’s turn, with the workers’ own loss after it', async () => {
      const s = await withWorker();
      await complete(s);
      s.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-ask-1' }));
      await settled();
      const before = s.events.length;
      s.process().end(0);
      await settled();
      expect(s.events.slice(before).map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type))).toEqual(['question-resolved', 'activity-ended', 'worker-ended', 'notice:workers-lost']);
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-w1', reason: 'dropped' }]);
    });

    it('counts an answer that comes once the process has ended, the hold already gone, and says nothing twice', async () => {
      const s = await asking();
      s.process().end(1);
      await settled();
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'dropped' }]);
      const written = s.process().frames.length;
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(s.process().frames).toHaveLength(written);
      expect(resolved(s)).toHaveLength(1);
      expect(s.session.counts.questions.unheld).toBe(1);
    });
  });

  describe('an answer the process does not take (C14, C66, C75)', () => {
    it('says `dropped` and ends the process when the line is refused while the process lives; the loss then ends the turn with its notice', async () => {
      for (const code of ['output-limit', 'transport-closed'] as const) {
        const s = await asking();
        s.process().script.failWrites(code);
        const before = s.events.length;
        s.session.answer('cli-q1', SECOND);
        await settled();
        expect(s.events.slice(before), code).toEqual([
          { type: 'question-resolved', requestId: 'cli-q1', reason: 'dropped' },
          { type: 'notice', kind: 'connection-lost', turnId: 'turn-1' },
          { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' },
        ]);
        valid(s.events);
        expect(s.process().closes, code).toBe(1);
        expect(s.closed(), code).toEqual({ ok: true });
        // Nothing sends the answer again, and nothing of it reached the process.
        expect(answers(s), code).toEqual([]);
        s.session.answer('cli-q1', SECOND);
        await settled();
        expect(resolved(s), code).toHaveLength(1);
      }
    });

    it('says `dropped` for the refused answer alone, and for the other unanswered holds at the loss that follows', async () => {
      const s = await withWorker();
      s.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-ask-1' }));
      s.frame(asks('cli-q1'));
      await settled();
      s.process().script.failWrites('output-limit');
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(resolved(s)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'dropped' }, { type: 'question-resolved', requestId: 'cli-w1', reason: 'dropped' }]);
      expect(s.types().slice(-4)).toEqual(['activity-ended', 'worker-ended', 'notice:connection-lost', 'turn-ended']);
    });

    it('says it for a line still queued when the process is stopped, whatever became of the session meanwhile (C75)', async () => {
      const s = await asking();
      // The process takes no line now: the write waits in its queue until the stop rejects it.
      const child = s.process().script.child as { write: (bytes: Uint8Array) => Promise<void> };
      let reject: (error: Error) => void = () => undefined;
      child.write = () => new Promise<void>((_resolve, fail) => { reject = fail; });
      s.session.answer('cli-q1', SECOND);
      await settled();
      expect(resolved(s)).toEqual([]);
      // A close: the turn ends as the session's own end, and the process is ended.
      await s.session.close();
      expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false }]);
      expect(resolved(s)).toEqual([]);
      reject(new ProcessFailure('transport-closed'));
      await settled();
      // The write's own word, after every end: main's registry kept the answered entry for it.
      expect(s.events.at(-1)).toEqual({ type: 'question-resolved', requestId: 'cli-q1', reason: 'dropped' });
      expect(resolved(s)).toHaveLength(1);
      expect(s.process().closes).toBe(1);
    });
  });

  it('logs nothing of a question, an option or an answer: counts and kinds alone (C34)', async () => {
    const s = await asking();
    s.frame(asks());
    s.session.answer('cli-q1', [{ options: [1], text: 'a private remark' }]);
    s.frame(results('ask-1', true));
    s.frame(asks('cli-q2', { tool_use_id: 'ask-2' }, { questions: Array.from({ length: 20 }, () => QUESTION) }));
    s.frame(asks('cli-q3', { tool_use_id: 'ask-3' }));
    s.session.answer('cli-q3', null);
    await settled();
    expect(JSON.stringify(s.chat.diagnostics)).not.toMatch(/private|secret-|File|remark/);
    expect(s.chat.diagnostics.map((event) => event.type).filter((type) => type !== 'request-refused')).toEqual([]);
    expect(JSON.stringify(s.session.counts)).not.toMatch(/private|secret-|remark/);
    expect(s.session.counts).toMatchObject({ refused: { can_use_tool: 2 }, questions: { repeated: 1, unheld: 0, failed: 1 } });
  });
});

// ── M22: execution permissions (docs/planning/_archive/M22.md, Design 3–6, 8) ───────────────────────────
// V2, V20, V27, V30, V31 and the session's part of V3: the mode a process is launched and held
// under, the one change the CLI makes on a live process, a request to act and its decisions, the
// session grant, a request delivered again, and a line over the limit — on a scripted process.
describe('execution permissions (M22)', () => {
  type Json = Record<string, unknown>;
  type S = ReturnType<typeof setup>;
  /** The tools a mode that acts is launched with, as `init` lists them outside a plan turn, and one of the user's own. */
  const ACTING = ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write', 'mcp__docs__read'];
  const WORDS: Readonly<Record<string, string>> = { 'read-only': 'default', 'ask-first': 'default', 'edits-ok': 'acceptEdits', 'auto-reviewed': 'auto', berserk: 'bypassPermissions' };
  const under = (mode: string | null, options: SetupOptions = {}): S => setup({ ...options, start: { mode, ...options.start } });
  const replying = (word: unknown): Json => ({ ...REPLY, current_permission_mode: word });
  /** A turn in flight under a mode: launched, confirmed, the prompt taken, its `init` checked. */
  const running = async (mode = 'ask-first'): Promise<S> => {
    const s = under(mode);
    await s.open(turn(), replying(WORDS[mode]));
    s.lifecycle('queued');
    s.lifecycle('started');
    // The reading mode's launch offers none of those that act or reach the web.
    s.init({ tools: mode === 'read-only' ? ['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read', 'mcp__docs__read'] : ACTING, permissionMode: WORDS[mode] });
    await settled();
    return s;
  };
  /** A live process with nothing running on it: its first turn completed. */
  const idle = async (mode = 'ask-first'): Promise<S> => {
    const s = await running(mode);
    s.text('Done.', 'a1');
    s.result();
    s.lifecycle('completed');
    await settled();
    return s;
  };
  const RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch private.txt' }], behavior: 'allow', destination: 'localSettings' };
  const SESSION_RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch private.txt' }], behavior: 'allow', destination: 'session' };
  const OFFERS = [RULE, { type: 'addDirectories', directories: ['C:\\work'], destination: 'session' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
  const COMMAND = { command: 'touch private.txt', description: 'Make the private file' };
  /** A request to act, as K2 saw a command's: the tool, its input, the model's line, the CLI's offers, the path, the tool use. */
  const asks = (id = 'cli-a1', patch: Json = {}): Json => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: COMMAND, description: 'Make the private file', permission_suggestions: OFFERS, blocked_path: 'C:\\work\\private.txt', tool_use_id: 'use-1', ...patch } });
  const uses = (toolUseId = 'use-1', name = 'Bash', input: unknown = COMMAND, parent: string | null = null): Json => ({ type: 'assistant', uuid: `uuid-${toolUseId}`, parent_tool_use_id: parent, message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
  const results = (toolUseId = 'use-1', isError = false, parent: string | null = null, content = '(Bash completed with no output)'): Json => ({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] } });
  const cancels = (id = 'cli-a1'): Json => ({ type: 'control_cancel_request', request_id: id });
  const status = (word: unknown): Json => ({ type: 'system', subtype: 'status', status: null, permissionMode: word, session_id: SESSION });
  const answers = (s: S): Json[] => s.process().frames.filter((frame) => frame['type'] === 'control_response');
  const allow = (id: string, input: unknown = COMMAND, grant?: Json): Json => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow', updatedInput: input, ...(grant === undefined ? {} : { updatedPermissions: [grant] }) } } });
  const deny = (id: string, message: string = DENY_MESSAGE): Json => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message } } });
  const raised = (s: S) => s.events.flatMap((event) => (event.type === 'approval-raised' ? [event] : []));
  const resolved = (s: S) => s.events.flatMap((event) => (event.type === 'approval-resolved' ? [event] : []));
  const activityEnds = (s: S) => s.events.flatMap((event) => (event.type === 'activity-ended' ? [event] : []));
  /** The view of `asks()`, as the card shows it. */
  const VIEW = {
    kind: 'command', tool: 'Bash', summary: 'touch private.txt', folder: null, targets: ['C:\\work\\private.txt'], outside: false, reason: 'Make the private file',
    authority: [{ kind: 'saved-rule', mode: null }, { kind: 'folder', mode: null }, { kind: 'mode', mode: 'edits-ok' }],
    detail: { kind: 'command', command: 'touch private.txt' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'touch private.txt' }, modeThatWouldStop: null, cut: false,
  };
  /** A turn in flight that has asked leave: the tool's use, then the request. */
  const approving = async (mode = 'ask-first', id = 'cli-a1', patch: Json = {}): Promise<S> => {
    const s = await running(mode);
    s.frame(uses());
    s.frame(asks(id, patch));
    await settled();
    return s;
  };

  describe('the mode a process is launched and confirmed under (V2; C2, C5, C45, C46)', () => {
    it('launches each mode with its own word and tools, and confirms it from the launch’s reply, by fat-g’s id, before the prompt is written', async () => {
      for (const id of CLAUDE_MODE_IDS) {
        const s = under(id);
        s.session.send(turn());
        await settled();
        expect(s.process().args, id).toEqual([...chatFixedArgs(CLAUDE_MODES[id]), '--model', 'sonnet', '--effort', 'low']);
        // Nothing is confirmed, and no prompt goes, before the reply.
        expect([s.confirmed, s.process().prompts()], id).toEqual([[], []]);
        const order: string[] = [];
        s.session.subscribe((event) => { if (event.type === 'in-force' && event.mode !== undefined) order.push(`confirmed with ${s.process().prompts().length} prompts written`); });
        s.process().reply(s.process().sent('initialize'), replying(WORDS[id]));
        await settled();
        expect(s.confirmed, id).toEqual([id]);
        expect(order, id).toEqual(['confirmed with 0 prompts written']);
        expect(s.process().prompts(), id).toHaveLength(1);
        expect(s.notices(), id).toEqual([]);
        // Never the CLI's own word in an event.
        expect(JSON.stringify([...s.events, ...s.confirmed]), id).not.toMatch(/acceptEdits|bypassPermissions/);
      }
    });

    it('runs a start that names no mode, or one it does not know, under the reading mode, and confirms that', async () => {
      for (const mode of [null, 'sandbox-ok', 'bypassPermissions']) {
        const s = under(mode);
        await s.open();
        expect(s.process().args, String(mode)).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low']);
        expect(s.confirmed, String(mode)).toEqual(['read-only']);
      }
    });

    it('fails the start and sends nothing when the reply reports another policy than a mode that acts asked for: the notice carries the word it reported', async () => {
      const cases: [string, unknown][] = [['ask-first', 'acceptEdits'], ['ask-first', 'bypassPermissions'], ['edits-ok', 'default'], ['auto-reviewed', 'acceptEdits'], ['berserk', 'default'], ['berserk', 'auto'], ['edits-ok', undefined], ['ask-first', 7]];
      for (const [mode, word] of cases) {
        const s = under(mode);
        await s.open(turn(), replying(word));
        const what = `${mode}: ${String(word)}`;
        expect(s.events, what).toEqual([
          { type: 'notice', kind: 'policy-mismatch', turnId: 'turn-1', ...(typeof word === 'string' ? { detail: word } : {}) },
          { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'policy-mismatch' },
        ]);
        valid(s.events);
        // Not confirmed, no prompt written, the process closed.
        expect([s.confirmed, s.process().prompts(), s.process().closes], what).toEqual([[], [], 1]);
        expect(s.closed(), what).toEqual({ ok: true });
      }
    });

    it('keeps the restricted start’s own notice for the reading mode, as before', async () => {
      const s = under('read-only');
      await s.open(turn(), replying('acceptEdits'));
      expect(s.events).toEqual([{ type: 'notice', kind: 'not-read-only', turnId: 'turn-1' }, { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'not-read-only' }]);
      expect([s.confirmed, s.process().prompts()]).toEqual([[], []]);
    });

    it('tells an aside whose question launched the process of the same failure, as the aside’s own', async () => {
      const s = under('edits-ok');
      s.session.ask?.({ asideId: 'aside-1', turnId: 'aside-turn-1', text: 'Why?', messageId: 'aside-message-1', history: [], throughTurn: null, effort: 'low', speed: null });
      await settled();
      s.process().reply(s.process().sent('initialize'), replying('default'));
      await settled();
      expect(s.events).toEqual([
        { type: 'notice', kind: 'policy-mismatch', turnId: 'aside-turn-1', asideId: 'aside-1', detail: 'default' },
        { type: 'turn-ended', turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'failed', reported: false, failure: 'policy-mismatch' },
      ]);
      expect(s.written()).toEqual(['initialize']);
    });

    it('holds each turn’s `init` to the mode in force and its tools: another word, or a tool outside the mode’s launch, ends the process as overruled', async () => {
      const cases: [string, Json][] = [
        ['ask-first', { permissionMode: 'acceptEdits' }], ['edits-ok', { permissionMode: 'default' }], ['auto-reviewed', { permissionMode: 'bypassPermissions' }], ['berserk', { permissionMode: 'default' }],
        ['ask-first', { tools: [...ACTING, 'ToolSearch'] }], ['berserk', { tools: [...ACTING, 'NotebookEdit'] }], ['read-only', { tools: ['Task', 'Read', 'Bash'] }], ['read-only', { tools: ['Task', 'Read', 'WebSearch'] }],
      ];
      for (const [mode, patch] of cases) {
        const s = under(mode);
        await s.open(turn(), replying(WORDS[mode]));
        s.lifecycle('started');
        s.init({ tools: mode === 'read-only' ? ['Task', 'Read'] : ACTING, permissionMode: WORDS[mode], ...patch });
        await settled();
        const what = `${mode}: ${JSON.stringify(patch)}`;
        expect(s.types(), what).toEqual(['turn-started', 'notice:start-overruled', 'turn-ended']);
        expect(s.ends(), what).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-overruled' }]);
        expect(s.process().closes, what).toBe(1);
      }
      // And passes the mode's own: the eight, and the user's own tools beside them.
      for (const mode of ['ask-first', 'edits-ok', 'auto-reviewed', 'berserk']) {
        const s = await running(mode);
        expect(s.types(), mode).toEqual(['turn-started', 'in-force']);
        expect(s.process().closes, mode).toBe(0);
      }
    });
  });

  describe('a change of mode on the live process (V2, V20, V30; C5, C74, C90)', () => {
    const setOf = (s: S): Json => s.process().sent('set_permission_mode');
    const line = (frame: unknown): string => `${JSON.stringify(frame)}\n`;
    const replyTo = (request: Json, response: unknown): Json => ({ type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response } });
    /** A change that waits for its reply. */
    const changing = async (to = 'edits-ok', from = 'ask-first'): Promise<{ s: S; change: Promise<unknown>; set: Json }> => {
      const s = await idle(from);
      const change = s.session.setMode(to);
      await settled();
      return { s, change, set: setOf(s) };
    };

    it('writes one request that names the target’s word, and nothing else, for each of the six changes', async () => {
      for (const [from, to] of [['ask-first', 'edits-ok'], ['ask-first', 'auto-reviewed'], ['edits-ok', 'ask-first'], ['edits-ok', 'auto-reviewed'], ['auto-reviewed', 'ask-first'], ['auto-reviewed', 'edits-ok']] as const) {
        const { s, change, set } = await changing(to, from);
        expect(set, `${from} → ${to}`).toEqual({ type: 'control_request', request_id: expect.any(String) as string, request: { subtype: 'set_permission_mode', mode: WORDS[to] } });
        expect(s.written().filter((kind) => kind === 'set_permission_mode'), `${from} → ${to}`).toHaveLength(1);
        s.process().reply(set, { mode: WORDS[to] });
        await expect(change).resolves.toEqual({ confirmed: true });
        expect(s.confirmed, `${from} → ${to}`).toEqual([from, to]);
      }
    });

    it('confirms on the reply whether its status frame comes in the reply’s chunk, in another, or before it — as K2 saw the two in one millisecond — and ends nothing', async () => {
      const deliveries: [string, (s: S, set: Json) => void][] = [
        ['one chunk, the reply first', (s, set) => s.process().script.bytes(line(replyTo(set, { mode: 'acceptEdits' })) + line(status('acceptEdits')))],
        ['one chunk, the frame first', (s, set) => s.process().script.bytes(line(status('acceptEdits')) + line(replyTo(set, { mode: 'acceptEdits' })))],
        ['two chunks', (s, set) => { s.process().reply(set, { mode: 'acceptEdits' }); s.frame(status('acceptEdits')); }],
        ['the frame, and the reply only later', (s, set) => { s.frame(status('acceptEdits')); s.timers.advance(5_000); s.process().reply(set, { mode: 'acceptEdits' }); }],
        ['the reply alone', (s, set) => s.process().reply(set, { mode: 'acceptEdits' })],
      ];
      for (const [what, deliver] of deliveries) {
        const { s, change, set } = await changing();
        const before = s.events.length;
        deliver(s, set);
        await expect(change, what).resolves.toEqual({ confirmed: true });
        await settled();
        expect(s.confirmed, what).toEqual(['ask-first', 'edits-ok']);
        expect(s.events.slice(before), what).toEqual([]);
        expect([s.process().closes, s.closed()], what).toEqual([0, undefined]);
        expect(s.session.counts.modesReported, what).toBe(what === 'the reply alone' ? 0 : 1);
        // The next turn is held to the new mode: its `init` passes under the new word, and no deadline is left running.
        expect(s.timers.pending(), what).toEqual([]);
        s.session.send(turn(2));
        await settled();
        s.lifecycle('queued', 2);
        s.lifecycle('started', 2);
        s.init({ tools: ACTING, permissionMode: 'acceptEdits' });
        await settled();
        expect(s.process().closes, what).toBe(0);
        expect(s.types().slice(-2), what).toEqual(['turn-started', 'in-force']);
      }
    });

    it('holds the next `init` to the old mode where the change was never made, and to the new one once it was', async () => {
      const { s, change, set } = await changing();
      s.process().reply(set, { mode: 'acceptEdits' });
      await change;
      s.session.send(turn(2));
      await settled();
      s.lifecycle('started', 2);
      // The word the process had before the change is another policy now.
      s.init({ tools: ACTING, permissionMode: 'default' });
      await settled();
      expect(s.ends().at(-1)).toEqual({ type: 'turn-ended', turnId: 'turn-2', outcome: 'failed', reported: false, failure: 'start-overruled' });
    });

    it('ends the process for a status frame that names another mode than the one in force and the target: with a change waiting, with a turn running, and with nothing running', async () => {
      const waiting = await changing();
      waiting.s.frame(status('auto'));
      await expect(waiting.change).resolves.toEqual({ confirmed: false, detail: null });
      expect(waiting.s.events.slice(-1)).toEqual([{ type: 'notice', kind: 'policy-mismatch', detail: 'auto' }]);
      expect([waiting.s.process().closes, waiting.s.confirmed]).toEqual([1, ['ask-first']]);

      const during = await running('ask-first');
      during.frame(status('acceptEdits'));
      await settled();
      expect(during.events.slice(-2)).toEqual([
        { type: 'notice', kind: 'policy-mismatch', turnId: 'turn-1', detail: 'acceptEdits' },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'policy-mismatch' },
      ]);
      valid(during.events);
      expect(during.process().closes).toBe(1);

      for (const word of ['plan', 'bypassPermissions', 'dontAsk', 7]) {
        const quiet = await idle('edits-ok');
        quiet.frame(status(word));
        await settled();
        expect(quiet.events.slice(-1), String(word)).toEqual([{ type: 'notice', kind: 'policy-mismatch', ...(typeof word === 'string' ? { detail: word } : {}) }]);
        expect(quiet.process().closes, String(word)).toBe(1);
      }
    });

    it('takes a status frame that names the mode in force, and one that names none, as nothing: counted, and no more', async () => {
      const s = await running('edits-ok');
      s.frame(status('acceptEdits'));
      s.frame({ type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION });
      s.frame({ type: 'system', subtype: 'status', status: null, permissionMode: null });
      await settled();
      expect(s.types()).toEqual(['turn-started', 'in-force']);
      expect([s.session.counts.modesReported, s.session.counts.unread, s.process().closes]).toEqual([1, 2, 0]);
      // `manual` is the CLI's other name for its default (M16, C21).
      const reading = await running('read-only');
      reading.frame(status('manual'));
      await settled();
      expect([reading.session.counts.modesReported, reading.process().closes]).toEqual([1, 0]);
    });

    it('is not confirmed by a reply that names another mode, a refusal, or no reply in 15 seconds: the mode is as it was, and the process goes on', async () => {
      const outcomes: [string, (s: S, set: Json) => void, unknown][] = [
        ['another mode', (s, set) => s.process().reply(set, { mode: 'plan' }), { confirmed: false, detail: 'plan' }],
        ['the mode it had', (s, set) => s.process().reply(set, { mode: 'default' }), { confirmed: false, detail: 'default' }],
        ['no mode', (s, set) => s.process().reply(set, {}), { confirmed: false, detail: null }],
        ['a refusal', (s, set) => s.process().refuse(set), { confirmed: false, detail: null }],
        ['no reply', (s) => s.timers.advance(CHAT_TIMINGS.modeMs), { confirmed: false, detail: null }],
      ];
      for (const [what, deliver, outcome] of outcomes) {
        const { s, change, set } = await changing();
        const before = s.events.length;
        deliver(s, set);
        await expect(change, what).resolves.toEqual(outcome);
        await settled();
        expect([s.confirmed, s.events.slice(before), s.process().closes], what).toEqual([['ask-first'], [], 0]);
        // The next turn is held to the mode it had, and a later change may be asked.
        const again = s.session.setMode('auto-reviewed');
        await settled();
        s.process().reply(setOf(s), { mode: 'auto' });
        await expect(again, what).resolves.toEqual({ confirmed: true });
        expect(s.confirmed, what).toEqual(['ask-first', 'auto-reviewed']);
      }
      // 15 seconds, as the effort's: not a millisecond before.
      const { s, change } = await changing();
      let settledChange = false;
      void change.then(() => { settledChange = true; });
      s.timers.advance(CHAT_TIMINGS.modeMs - 1);
      await settled();
      expect(settledChange).toBe(false);
      expect(CHAT_TIMINGS.modeMs).toBe(15_000);
    });

    it('ends the process where a status frame named the target and the reply then does not confirm it: the process runs under a mode its reply denies (C90)', async () => {
      const outcomes: [string, (s: S, set: Json) => void, string | null][] = [
        ['another mode', (s, set) => s.process().reply(set, { mode: 'plan' }), 'plan'],
        ['a refusal', (s, set) => s.process().refuse(set), null],
        ['no reply', (s) => s.timers.advance(CHAT_TIMINGS.modeMs), null],
      ];
      for (const [what, deliver, word] of outcomes) {
        const { s, change, set } = await changing();
        s.frame(status('acceptEdits'));
        await settled();
        expect(s.process().closes, what).toBe(0);
        deliver(s, set);
        await expect(change, what).resolves.toEqual({ confirmed: false, detail: word });
        await settled();
        expect(s.events.slice(-1), what).toEqual([{ type: 'notice', kind: 'policy-mismatch', ...(word === null ? {} : { detail: word }) }]);
        expect([s.confirmed, s.process().closes], what).toEqual([['ask-first'], 1]);
      }
      // A status frame that names the target only after the change was given up names another mode than the one in force.
      const late = await changing();
      late.s.timers.advance(CHAT_TIMINGS.modeMs);
      await late.change;
      late.s.frame(status('acceptEdits'));
      await settled();
      expect(late.s.events.slice(-1)).toEqual([{ type: 'notice', kind: 'policy-mismatch', detail: 'acceptEdits' }]);
      expect(late.s.process().closes).toBe(1);
    });

    it('is not confirmed when the process ends while it waits', async () => {
      const { s, change } = await changing();
      s.process().end(1);
      await expect(change).resolves.toEqual({ confirmed: false, detail: null });
      expect(s.confirmed).toEqual(['ask-first']);
    });

    it('writes nothing where the gate does not stand: a turn, a worker, a request or an aside running, another change waiting, or no process', async () => {
      const refused = async (s: S, to = 'edits-ok'): Promise<void> => {
        const before = s.chat.launches.length === 0 ? 0 : s.process().frames.length;
        await expect(s.session.setMode(to)).resolves.toEqual({ confirmed: false, detail: null });
        await settled();
        if (s.chat.launches.length > 0) expect(s.process().frames.slice(before).filter((frame) => frame.request?.['subtype'] === 'set_permission_mode')).toEqual([]);
      };
      // No process yet: nothing is launched for a change.
      const unopened = under('ask-first');
      await refused(unopened);
      expect(unopened.chat.launches).toEqual([]);
      // A turn still starting, and a turn running.
      const starting = under('ask-first');
      starting.session.send(turn());
      await settled();
      await refused(starting);
      await refused(await running('ask-first'));
      // A request pending holds its turn, which runs.
      await refused(await approving('ask-first'));
      // A worker that outlived its turn.
      const worker = await running('ask-first');
      worker.tool('Agent', { description: 'Works on' });
      worker.worker();
      worker.text('The worker goes on.', 'a1');
      worker.result();
      worker.lifecycle('completed');
      await settled();
      expect(worker.ends()).toHaveLength(1);
      await refused(worker);
      // And that worker's own request, held past the turn.
      worker.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-use-1' }));
      await settled();
      expect(raised(worker)).toHaveLength(1);
      await refused(worker);
      // An aside's question that waits for its reply.
      const aside = await idle('ask-first');
      aside.session.ask?.({ asideId: 'aside-1', turnId: 'aside-turn-1', text: 'Why?', messageId: 'aside-message-1', history: [], throughTurn: null, effort: 'low', speed: null });
      await settled();
      await refused(aside);
      // Another change waiting: the second is refused, and one request was written.
      const { s, change, set } = await changing();
      await refused(s, 'auto-reviewed');
      expect(s.written().filter((kind) => kind === 'set_permission_mode')).toHaveLength(1);
      s.process().reply(set, { mode: 'acceptEdits' });
      await expect(change).resolves.toEqual({ confirmed: true });
      // A session that is over.
      const over = await idle('ask-first');
      await over.session.close();
      await expect(over.session.setMode('edits-ok')).resolves.toEqual({ confirmed: false, detail: null });
    });

    it('never changes into Berserk, out of it, into the reading mode or out of it on a live process: those are a new process’s (C74)', async () => {
      const pairs: [string, string][] = [
        ['ask-first', 'berserk'], ['edits-ok', 'berserk'], ['auto-reviewed', 'berserk'], ['berserk', 'ask-first'], ['berserk', 'edits-ok'], ['berserk', 'auto-reviewed'], ['berserk', 'read-only'],
        ['ask-first', 'read-only'], ['edits-ok', 'read-only'], ['read-only', 'ask-first'], ['read-only', 'edits-ok'], ['read-only', 'berserk'],
        // The mode it has, and what is no mode of Claude's.
        ['ask-first', 'ask-first'], ['edits-ok', 'sandbox-ok'], ['ask-first', 'acceptEdits'], ['ask-first', 'bypassPermissions'], ['ask-first', ''],
      ];
      for (const [from, to] of pairs) {
        const s = await idle(from);
        await expect(s.session.setMode(to), `${from} → ${to}`).resolves.toEqual({ confirmed: false, detail: null });
        expect(s.written(), `${from} → ${to}`).not.toContain('set_permission_mode');
        expect(JSON.stringify(s.process().frames), `${from} → ${to}`).not.toMatch(/set_permission_mode/);
        expect(s.confirmed, `${from} → ${to}`).toEqual([from]);
      }
    });
  });

  describe('a request to act (V27; C6, C8, C9, C11, C48)', () => {
    it('is denied under the reading mode, as before there were modes: fat-g’s words, the notice, no card', async () => {
      const s = await approving('read-only');
      expect(raised(s)).toEqual([]);
      expect(answers(s)).toEqual([deny('cli-a1')]);
      expect(s.notices()).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
      expect(s.session.counts.refused).toEqual({ can_use_tool: 1 });
      // Nothing is held: a decision main might still give names nothing.
      await expect(s.session.decide('cli-a1', 'approve')).resolves.toBe(false);
      expect(answers(s)).toHaveLength(1);
      expect(s.session.counts.approvals.unheld).toBe(1);
    });

    it('is held and raised with its card’s view under every other mode, Berserk included, and nothing is written until it is decided', async () => {
      for (const mode of ['ask-first', 'edits-ok', 'auto-reviewed', 'berserk']) {
        const s = await approving(mode);
        expect(raised(s), mode).toEqual([{ type: 'approval-raised', turnId: 'turn-1', requestId: 'cli-a1', sourceId: 'use-1', request: VIEW }]);
        valid(s.events);
        // The action's own activity stands beside the card, under the same tool use (C14).
        expect(s.events.filter((event) => event.type === 'activity-started').map((event) => event.itemId), mode).toEqual(['use-1']);
        expect([answers(s), s.notices(), s.session.counts.refused], mode).toEqual([[], [], {}]);
        // The turn waits: no deadline of fat-g's runs on a request.
        s.timers.advance(6 * 60 * 60_000);
        await settled();
        expect([answers(s), s.ends()], mode).toEqual([[], []]);
      }
    });

    it('raises a file change with its whole content, a worker’s under its worker, and what is offered as the request offered it', async () => {
      const s = await running('ask-first');
      s.tool('Agent', { description: 'Edits' });
      s.worker();
      const content = 'x'.repeat(300_000);
      s.frame(asks('cli-w1', { tool_name: 'Write', input: { file_path: 'C:\\work\\big.txt', content }, description: 'big.txt', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], blocked_path: undefined, tool_use_id: 'w-use-1', agent_id: 'task-1' }));
      await settled();
      expect(raised(s)).toEqual([{
        type: 'approval-raised', turnId: 'turn-1', workerId: 'task-1', requestId: 'cli-w1', sourceId: 'w-use-1',
        request: {
          kind: 'file-change', tool: 'Write', summary: 'big.txt', folder: null, targets: ['C:\\work\\big.txt'], outside: false, reason: null, authority: [{ kind: 'mode', mode: 'edits-ok' }],
          // Whole, far past what an activity keeps of a change (C48).
          detail: { kind: 'changes', changes: [{ path: 'C:\\work\\big.txt', kind: 'write', text: content, replace: null, all: null }] },
          choices: ['approve', 'deny'], grant: null, modeThatWouldStop: 'edits-ok', cut: false,
        },
      }]);
      valid(s.events);
    });

    it('refuses on the wire a request it cannot place, with the notice and no event: no turn, after the `result`, a worker that ended', async () => {
      const places: [string, (s: S) => Promise<Json>][] = [
        ['before the CLI took the prompt', async (s) => { await s.open(turn(), replying('default')); s.lifecycle('queued'); return asks(); }],
        ['after the `result`', async (s) => { await s.open(turn(), replying('default')); s.lifecycle('started'); s.init({ tools: ACTING }); s.result(); return asks(); }],
        ['a worker that has ended', async (s) => { await s.open(turn(), replying('default')); s.lifecycle('started'); s.init({ tools: ACTING }); s.tool('Agent'); s.worker(); s.frame({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: 'tool-1', status: 'completed', summary: 'done' }); s.result(); s.lifecycle('completed'); await settled(); return asks('cli-a1', { agent_id: 'task-1' }); }],
        ['a second request for a tool use that has one', async (s) => { await s.open(turn(), replying('default')); s.lifecycle('started'); s.init({ tools: ACTING }); s.frame(asks('cli-first')); await settled(); return asks(); }],
      ];
      for (const [where, reach] of places) {
        const s = under('ask-first');
        const request = await reach(s);
        const before = raised(s).length;
        s.frame(request);
        await settled();
        expect(raised(s).length - before, where).toBe(0);
        expect(answers(s).at(-1), where).toEqual(deny('cli-a1'));
        expect(s.session.counts.refused, where).toEqual({ can_use_tool: 1 });
        expect(s.notices().filter((notice) => notice.kind === 'request-refused'), where).toHaveLength(1);
      }
    });

    it('refuses a request that lacks what its action stands on, or an id it could not echo, with the plain notice once a turn', async () => {
      const s = await running('ask-first');
      const lacking: Json[] = [
        asks('cli-1', { input: { description: 'no command' } }), asks('cli-2', { tool_name: 'Write', input: { content: 'x' } }), asks('cli-3', { input: 'touch x' }), asks('cli-4', { tool_use_id: undefined }),
        asks('cli-5', { tool_name: 'Edit', input: { file_path: 'C:\\a.txt', new_string: 'b' } }), asks('x'.repeat(129)),
      ];
      for (const request of lacking) s.frame(request);
      await settled();
      expect(raised(s)).toEqual([]);
      // Each denied by its id — but the one whose id is too long to echo, which is counted and not answered.
      expect(answers(s)).toEqual(['cli-1', 'cli-2', 'cli-3', 'cli-4', 'cli-5'].map((id) => deny(id)));
      expect(s.session.counts.refused).toEqual({ can_use_tool: 6 });
      expect(s.notices()).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
    });

    it('refuses a request past a bound with a notice that names the bound and the size, each time, and shows nothing cut (C9, C48)', async () => {
      const s = await running('ask-first');
      const edits = Array.from({ length: 40 }, (_, n) => ({ old_string: `a${n}`, new_string: `b${n}` }));
      s.frame(asks('cli-1', { tool_name: 'MultiEdit', input: { file_path: 'C:\\work\\a.ts', edits } }));
      s.frame(asks('cli-2', { tool_name: 'Write', input: { file_path: 'C:\\work\\big.txt', content: 'x'.repeat(1_048_577) } }));
      s.frame(asks('cli-3', { input: { command: 'y'.repeat(65_537) } }));
      s.frame(asks('cli-4', { tool_name: 'Write', input: { file_path: `C:\\${'p'.repeat(2_048)}`, content: 'x' } }));
      await settled();
      expect(raised(s)).toEqual([]);
      expect(answers(s)).toEqual(['cli-1', 'cli-2', 'cli-3', 'cli-4'].map((id) => deny(id)));
      expect(s.notices()).toEqual([
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'targets', size: 40 },
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'detail', size: 1_048_577 },
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'detail', size: 65_537 },
        { type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'path', size: 2_051 },
      ]);
      valid(s.events);
      // A notice carries a kind and two numbers: nothing of the request.
      expect(JSON.stringify(s.events)).not.toMatch(/big\.txt|xxxx|yyyy|pppp|a\.ts/);
      // Just within each bound, the request is a card.
      s.frame(asks('cli-5', { tool_name: 'Write', input: { file_path: 'C:\\work\\big.txt', content: 'x'.repeat(1_048_576) }, tool_use_id: 'use-5' }));
      await settled();
      expect(raised(s).map((event) => event.requestId)).toEqual(['cli-5']);
    });
  });

  describe('a decision (V27; C12, C13, C21, C22, C68, C69, C76)', () => {
    it('approves once: `allow` with the request’s input as it came, and nothing beside it; the tool’s result confirms it, and the action’s activity is the CLI’s own to end', async () => {
      const s = await approving();
      const decided = s.session.decide('cli-a1', 'approve');
      await expect(decided).resolves.toBe(true);
      expect(answers(s)).toEqual([allow('cli-a1')]);
      // The request's own object, not a copy made for the card.
      expect(resolved(s)).toEqual([]);
      s.frame(results());
      await settled();
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-a1', reason: 'confirmed' }]);
      expect(activityEnds(s)).toEqual([{ type: 'activity-ended', turnId: 'turn-1', itemId: 'use-1', status: 'completed', output: '(Bash completed with no output)' }]);
      valid(s.events);
      // Over: a second decision names nothing held, and writes nothing.
      await expect(s.session.decide('cli-a1', 'deny')).resolves.toBe(false);
      expect([answers(s).length, s.session.counts.approvals.unheld]).toEqual([1, 1]);
    });

    it('approves for the session: the same `allow`, and the CLI’s own rule alone at the session’s scope — never the scope the CLI offered it at, the folder or the mode', async () => {
      const s = await approving();
      await expect(s.session.decide('cli-a1', 'approve-session')).resolves.toBe(true);
      expect(answers(s)).toEqual([allow('cli-a1', COMMAND, SESSION_RULE)]);
      const sent = JSON.stringify(answers(s));
      expect(sent).not.toMatch(/localSettings|userSettings|projectSettings|addDirectories|setMode|acceptEdits/);
      s.frame(results());
      await settled();
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-a1', reason: 'confirmed' }]);
    });

    it('sends the grant at the session’s scope whatever scope the request offered it at, and the first rule that allows where it offers several', async () => {
      for (const destination of ['userSettings', 'projectSettings', 'session', 'somewhereNew']) {
        const s = await approving('ask-first', 'cli-a1', { permission_suggestions: [{ ...RULE, behavior: 'deny' }, { ...RULE, destination }, { ...RULE, rules: [{ toolName: 'Bash' }] }, { type: 'setMode', mode: 'bypassPermissions', destination }] });
        expect(raised(s)[0]?.request.grant, destination).toEqual({ covers: 'touch private.txt' });
        await expect(s.session.decide('cli-a1', 'approve-session')).resolves.toBe(true);
        expect(answers(s), destination).toEqual([allow('cli-a1', COMMAND, SESSION_RULE)]);
      }
    });

    it('denies in the user’s name: the tool’s error result confirms it, and the action’s activity ends declined by the user, not failed (C76)', async () => {
      const s = await approving();
      await expect(s.session.decide('cli-a1', 'deny')).resolves.toBe(true);
      expect(answers(s)).toEqual([deny('cli-a1', USER_DENY_MESSAGE)]);
      s.frame(results('use-1', true, null, USER_DENY_MESSAGE));
      await settled();
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-a1', reason: 'confirmed' }]);
      expect(activityEnds(s)).toEqual([{ type: 'activity-ended', turnId: 'turn-1', itemId: 'use-1', status: 'declined', declinedBy: 'user', output: USER_DENY_MESSAGE }]);
      valid(s.events);
      // The turn goes on to its own end (C13).
      s.text('It did not run.', 'a1');
      s.result();
      s.lifecycle('completed');
      await settled();
      expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'a1' }]);
    });

    it('refuses at main’s word: denied in fat-g’s words with the notice, the write’s outcome its promise, and the result then fails the activity as any refused tool’s does', async () => {
      const s = await approving();
      await expect(s.session.decide('cli-a1', null)).resolves.toBe(true);
      expect(answers(s)).toEqual([deny('cli-a1')]);
      expect(s.notices()).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
      expect(s.session.counts.refused).toEqual({ can_use_tool: 1 });
      s.frame(results('use-1', true, null, DENY_MESSAGE));
      await settled();
      // No decision of the user's: nothing is confirmed, and nothing was declined by them.
      expect(resolved(s)).toEqual([]);
      expect(activityEnds(s)).toMatchObject([{ itemId: 'use-1', status: 'failed' }]);
    });

    it('never sends a session grant for a request that offered no rule: nothing is written as leave given once, the process took none', async () => {
      const s = await approving('ask-first', 'cli-a1', { permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
      expect(raised(s)[0]?.request).toMatchObject({ choices: ['approve', 'deny'], grant: null, modeThatWouldStop: 'edits-ok' });
      await expect(s.session.decide('cli-a1', 'approve-session')).resolves.toBe(false);
      await settled();
      expect(answers(s)).toEqual([]);
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-a1', reason: 'dropped' }]);
      expect(s.process().closes).toBe(1);
    });

    it('answers a decision that names nothing it holds with false, and writes nothing: an unknown id, a question’s, one already decided', async () => {
      const s = await approving();
      s.frame({ type: 'control_request', request_id: 'cli-q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] }, tool_use_id: 'ask-1' } });
      await settled();
      await expect(s.session.decide('cli-nothing', 'approve')).resolves.toBe(false);
      // A question is answered, never decided — and an approval is decided, never answered.
      await expect(s.session.decide('cli-q1', 'approve')).resolves.toBe(false);
      s.session.answer('cli-a1', [{ options: [0], text: null }]);
      await settled();
      expect(answers(s)).toEqual([]);
      expect([s.session.counts.approvals.unheld, s.session.counts.questions.unheld]).toEqual([2, 1]);
      await expect(s.session.decide('cli-a1', 'approve')).resolves.toBe(true);
      await expect(s.session.decide('cli-a1', 'approve')).resolves.toBe(false);
      expect(answers(s)).toEqual([allow('cli-a1')]);
    });

    it('says `dropped`, ends the process and resolves false for a decision — or a refusal — the process does not take, and never rejects', async () => {
      for (const choice of ['approve', 'approve-session', 'deny', null] as const) {
        const s = await approving();
        s.process().script.failWrites('transport-closed');
        const before = s.events.length;
        await expect(s.session.decide('cli-a1', choice), String(choice)).resolves.toBe(false);
        await settled();
        expect(s.events.slice(before).filter((event) => event.type !== 'notice' || event.kind !== 'request-refused'), String(choice)).toEqual([
          { type: 'approval-resolved', requestId: 'cli-a1', reason: 'dropped' },
          { type: 'notice', kind: 'connection-lost', turnId: 'turn-1' },
          { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' },
        ]);
        expect(s.process().closes, String(choice)).toBe(1);
        // Nothing sends it again.
        await expect(s.session.decide('cli-a1', 'approve'), String(choice)).resolves.toBe(false);
        expect(resolved(s), String(choice)).toHaveLength(1);
      }
    });

    it('decides a worker’s request after its parent turn ended, and confirms it by the worker’s own result', async () => {
      const s = await running('ask-first');
      s.tool('Agent', { description: 'Works on' });
      s.worker();
      s.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-use-1' }));
      s.frame(uses('w-use-1', 'Bash', COMMAND, 'tool-1'));
      s.text('The worker goes on.', 'a1');
      s.result();
      s.lifecycle('completed');
      await settled();
      // The turn's end takes nothing of a worker's with it.
      expect(raised(s)).toMatchObject([{ turnId: 'turn-1', workerId: 'task-1', requestId: 'cli-w1' }]);
      await expect(s.session.decide('cli-w1', 'deny')).resolves.toBe(true);
      s.frame(results('w-use-1', true, 'tool-1', USER_DENY_MESSAGE));
      await settled();
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-w1', reason: 'confirmed' }]);
      expect(activityEnds(s).filter((event) => event.itemId === 'w-use-1')).toEqual([{ type: 'activity-ended', turnId: 'turn-1', itemId: 'w-use-1', workerId: 'task-1', status: 'declined', declinedBy: 'user', output: USER_DENY_MESSAGE }]);
    });
  });

  describe('a request delivered again under an id it holds (V31; C11, C91)', () => {
    it('counts the same request, raises nothing more, and writes the decision once for each delivery', async () => {
      const s = await approving();
      s.frame(asks());
      s.frame(JSON.parse(JSON.stringify(asks())) as Json);
      await settled();
      expect(raised(s)).toHaveLength(1);
      expect([s.session.counts.approvals.repeated, s.session.counts.changed, answers(s).length]).toEqual([2, 0, 0]);
      await expect(s.session.decide('cli-a1', 'approve')).resolves.toBe(true);
      expect(answers(s)).toEqual([allow('cli-a1'), allow('cli-a1'), allow('cli-a1')]);
      // And once decided, a later delivery of the same gets the same reply at once.
      s.frame(asks());
      await settled();
      expect(answers(s)).toHaveLength(4);
      expect(resolved(s)).toEqual([]);
    });

    it('refuses another payload under that id on the wire, lets the hold go and withdraws its card as changed — with nothing of the second payload in any event', async () => {
      const others: [string, Json][] = [
        ['another command', { input: { command: 'rm -rf C:\\secrets', description: 'Make the private file' } }], ['a key more in the input', { input: { ...COMMAND, timeout: 600_000 } }],
        ['another tool', { tool_name: 'Write', input: { file_path: 'C:\\secrets\\x', content: 'stolen words' } }], ['another tool use', { tool_use_id: 'use-other-secret' }], ['a worker named', { agent_id: 'task-secret' }],
        ['no input at all', { input: undefined }],
      ];
      for (const [what, patch] of others) {
        const s = await approving();
        const before = s.events.length;
        s.frame(asks('cli-a1', patch));
        await settled();
        // Denied for the delivery that waited and for this one, in fat-g's words.
        expect(answers(s), what).toEqual([deny('cli-a1'), deny('cli-a1')]);
        expect(s.events.slice(before), what).toEqual([
          { type: 'approval-resolved', requestId: 'cli-a1', reason: 'changed' },
          { type: 'notice', kind: 'request-refused', turnId: 'turn-1' },
        ]);
        valid(s.events);
        expect(JSON.stringify(s.events), what).not.toMatch(/rm -rf|secret|stolen|600000/);
        expect([s.session.counts.changed, s.session.counts.approvals.repeated], what).toEqual([1, 0]);
        // The hold is gone: a decision names nothing, and the first payload is never allowed after all.
        await expect(s.session.decide('cli-a1', 'approve'), what).resolves.toBe(false);
        expect(answers(s), what).toHaveLength(2);
        expect(raised(s), what).toHaveLength(1);
        // The tool's result then confirms nothing, and ends its activity as it reads.
        s.frame(results('use-1', true, null, DENY_MESSAGE));
        await settled();
        expect(resolved(s), what).toHaveLength(1);
        expect(activityEnds(s).filter((event) => event.itemId === 'use-1'), what).toMatchObject([{ status: 'failed' }]);
      }
    });

    it('refuses a changed delivery once, where the first was already decided, and never answers it from the hold', async () => {
      const s = await approving();
      await s.session.decide('cli-a1', 'approve');
      s.frame(asks('cli-a1', { input: { command: 'rm -rf C:\\secrets' } }));
      await settled();
      expect(answers(s)).toEqual([allow('cli-a1'), deny('cli-a1')]);
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-a1', reason: 'changed' }]);
    });

    it('refuses a question’s changed repeat the same way, on the path both kinds share', async () => {
      const QUESTION = { question: 'Which private file?', options: [{ label: 'a.txt' }, { label: 'b.txt' }] };
      const question = (input: unknown): Json => ({ type: 'control_request', request_id: 'cli-q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 'ask-1' } });
      const s = await running('ask-first');
      s.frame(question({ questions: [QUESTION] }));
      // The same again: M21's repeat.
      s.frame(question({ questions: [QUESTION] }));
      await settled();
      expect([s.session.counts.questions.repeated, s.session.counts.changed]).toEqual([1, 0]);
      const before = s.events.length;
      s.frame(question({ questions: [{ ...QUESTION, question: 'Which secret file?' }] }));
      await settled();
      expect(s.events.slice(before)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'changed' }, { type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
      valid(s.events);
      // Once for each of the three deliveries.
      expect(answers(s)).toEqual([deny('cli-q1'), deny('cli-q1'), deny('cli-q1')]);
      s.session.answer('cli-q1', [{ options: [0], text: null }]);
      await settled();
      expect([answers(s).length, s.session.counts.questions.unheld]).toEqual([3, 1]);
      // And under the reading mode too, which has questions and no requests to act.
      const reading = await running('read-only');
      reading.frame(question({ questions: [QUESTION] }));
      reading.frame({ ...question({ questions: [QUESTION] }), request: { subtype: 'can_use_tool', tool_name: 'Bash', input: COMMAND, tool_use_id: 'ask-1' } });
      await settled();
      expect(reading.events.slice(-2)).toEqual([{ type: 'question-resolved', requestId: 'cli-q1', reason: 'changed' }, { type: 'notice', kind: 'request-refused', turnId: 'turn-1' }]);
    });
  });

  describe('a hold’s other ends (C11, C13)', () => {
    it('says `withdrawn` when the CLI takes the request back and goes on, and nothing when the cancel is a Stop’s own', async () => {
      const s = await approving();
      s.frame(cancels());
      await settled();
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-a1', reason: 'withdrawn' }]);
      await expect(s.session.decide('cli-a1', 'approve')).resolves.toBe(false);
      expect(answers(s)).toEqual([]);

      // K2's Stop with a request pending: the interrupt, the cancel, the error result, the `result`.
      const stopped = await approving();
      stopped.session.stop();
      await settled();
      expect(stopped.written()).toContain('interrupt');
      stopped.frame(cancels());
      stopped.frame(results('use-1', true, null, 'The user doesn’t want to proceed with this tool use.'));
      stopped.result(true);
      stopped.lifecycle('cancelled');
      await settled();
      expect(resolved(stopped)).toEqual([]);
      expect(answers(stopped)).toEqual([]);
      expect(stopped.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true }]);
    });

    it('says `withdrawn` for a result that comes with no decision and no cancel: the CLI went on without one', async () => {
      const s = await approving();
      s.frame(results('use-1', true));
      await settled();
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-a1', reason: 'withdrawn' }]);
      expect(activityEnds(s)).toMatchObject([{ itemId: 'use-1', status: 'failed' }]);
    });

    it('says `dropped` for each still undecided when the session is closed, before the ends the close makes, and nothing for one decided or for a question (C11, C12)', async () => {
      const s = await approving();
      s.frame(asks('cli-a2', { tool_use_id: 'use-2' }));
      s.frame({ type: 'control_request', request_id: 'cli-q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] }, tool_use_id: 'ask-1' } });
      await settled();
      await s.session.decide('cli-a2', 'approve');
      const before = s.events.length;
      await expect(s.session.close()).resolves.toEqual({ ok: true });
      // The undecided request alone, and first: the close's own end of the turn is no withdrawal of it.
      expect(s.events.slice(before)).toEqual([
        { type: 'approval-resolved', requestId: 'cli-a1', reason: 'dropped' },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: false },
      ]);
      await expect(s.session.decide('cli-a1', 'approve')).resolves.toBe(false);
      expect(answers(s)).toEqual([allow('cli-a2')]);

      // A worker's, held past its turn, the same: before the worker's own end.
      const worker = await running('ask-first');
      worker.tool('Agent', { description: 'Works on' });
      worker.worker();
      worker.frame(asks('cli-w1', { agent_id: 'task-1', tool_use_id: 'w-use-1' }));
      worker.text('The worker goes on.', 'a1');
      worker.result();
      worker.lifecycle('completed');
      await settled();
      const then = worker.events.length;
      await worker.session.close();
      expect(worker.events.slice(then).map((event) => event.type)).toEqual(['approval-resolved', 'activity-ended', 'worker-ended']);
      expect(resolved(worker)).toEqual([{ type: 'approval-resolved', requestId: 'cli-w1', reason: 'dropped' }]);
    });

    it('lets the session’s own go with its turn, with no event, and says `dropped` first for each still undecided when the process ends', async () => {
      const ended = await approving();
      ended.result();
      ended.lifecycle('completed');
      await settled();
      expect(resolved(ended)).toEqual([]);
      await expect(ended.session.decide('cli-a1', 'approve')).resolves.toBe(false);

      const lost = await approving();
      lost.frame(asks('cli-a2', { tool_use_id: 'use-2' }));
      await settled();
      await lost.session.decide('cli-a2', 'approve');
      const before = lost.events.length;
      lost.process().end(1);
      await settled();
      // The undecided one alone, before the end made for the loss: a decided one is let go with no word.
      expect(lost.events.slice(before)).toEqual([
        { type: 'approval-resolved', requestId: 'cli-a1', reason: 'dropped' },
        { type: 'notice', kind: 'connection-lost', turnId: 'turn-1' },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'connection-lost' },
      ]);
    });
  });

  describe('a line over the limit (V3; C67, C71)', () => {
    const MIB = 1024 * 1024;
    const big = (head: string, tail: string): string => `${head}"${'x'.repeat(4 * MIB + 64)}"${tail}\n`;
    /** A request padded past the limit, its keys in the CLI's own order: the type, the id, the request. */
    const withId = (id: string): string => big(`{"type":"control_request","request_id":"${id}","request":{"subtype":"can_use_tool","tool_name":"Write","tool_use_id":"use-big","input":{"file_path":"C:\\\\work\\\\private-big.txt","content":`, '}}}');
    /** The same with its id after the request: past what is read of the line. */
    const noId = (): string => big('{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"C:\\\\work\\\\private-big.txt","content":', '}},"request_id":"cli-late"}');
    const ASIDE = { asideId: 'aside-1', turnId: 'aside-turn-1', text: 'Why?', messageId: 'aside-message-1', history: [], throughTurn: null, effort: 'low', speed: null };

    it('refuses a request by the id read from the line, with a notice naming the line’s size, and the turn goes on — under any mode', async () => {
      for (const mode of ['ask-first', 'read-only']) {
        const s = await running(mode);
        s.process().script.bytes(withId('cli-big'));
        await settled();
        expect(answers(s), mode).toEqual([deny('cli-big')]);
        expect(s.notices(), mode).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'line', size: expect.any(Number) as number }]);
        expect(s.notices()[0]?.size, mode).toBeGreaterThan(4 * MIB);
        valid(s.events);
        // Counted under a name of fat-g's own, and no event of a request: its bound was never judged.
        expect(s.session.counts.refused, mode).toEqual({ 'oversized-request': 1 });
        expect(s.session.counts.dropped.oversized, mode).toBe(1);
        expect(s.chat.diagnostics.filter((event) => event.type === 'request-refused'), mode).toEqual([{ type: 'request-refused', method: 'oversized-request' }]);
        expect(raised(s), mode).toEqual([]);
        // Nothing of the line but its kind and its id was kept: not in an event, not in a log.
        expect(JSON.stringify([s.events, s.chat.diagnostics]), mode).not.toMatch(/private-big|xxxx|Write|use-big/);
        // The turn goes on to its own end.
        s.text('Still here.', 'a1');
        s.result();
        s.lifecycle('completed');
        await settled();
        expect(s.ends(), mode).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: 'a1' }]);
        expect(s.process().closes, mode).toBe(0);
      }
    });

    it('takes a change within its content bound the same way where its line passes the limit: a million control characters, each six bytes on the line (C48, C67)', async () => {
      const s = await running('ask-first');
      const content = '\u0001'.repeat(1_000_000);
      const line = `${JSON.stringify(asks('cli-ctl', { tool_name: 'Write', input: { file_path: 'C:\\work\\control.bin', content }, tool_use_id: 'use-ctl' }))}\n`;
      // Within the bound a card shows whole, and over the line a session carries: the two limits are two things.
      expect(content.length).toBeLessThanOrEqual(1_048_576);
      expect(new TextEncoder().encode(line).length).toBeGreaterThan(4 * MIB);
      s.process().script.bytes(line);
      await settled();
      expect(raised(s)).toEqual([]);
      expect(answers(s)).toEqual([deny('cli-ctl')]);
      expect(s.notices()).toEqual([{ type: 'notice', kind: 'request-refused', turnId: 'turn-1', bound: 'line', size: expect.any(Number) as number }]);
      // The same request with a content a line carries is a card.
      s.frame(asks('cli-ok', { tool_name: 'Write', input: { file_path: 'C:\\work\\control.bin', content: '\u0001'.repeat(1_000) }, tool_use_id: 'use-ok' }));
      await settled();
      expect(raised(s).map((event) => event.requestId)).toEqual(['cli-ok']);
    });

    it('lets a hold go as changed where the line came under an id it holds: what came could not be read, and is not the request it holds', async () => {
      const s = await approving();
      s.process().script.bytes(withId('cli-a1'));
      await settled();
      expect(resolved(s)).toEqual([{ type: 'approval-resolved', requestId: 'cli-a1', reason: 'changed' }]);
      expect(answers(s)).toEqual([deny('cli-a1'), deny('cli-a1')]);
      await expect(s.session.decide('cli-a1', 'approve')).resolves.toBe(false);
    });

    it('stops everything the process runs for a request whose id cannot be read: the turn and its workers by Stop, each aside by its own, each with the notice', async () => {
      const s = await running('ask-first');
      s.tool('Agent', { description: 'Works on' });
      s.worker();
      s.session.ask?.(ASIDE);
      await settled();
      const side = s.process().sent('side_question');
      const before = s.events.length;
      s.process().script.bytes(noId());
      await settled();
      expect(s.events.slice(before)).toEqual([
        { type: 'notice', kind: 'line-too-long', turnId: 'turn-1', size: expect.any(Number) as number },
        { type: 'notice', kind: 'line-too-long', turnId: 'aside-turn-1', asideId: 'aside-1', size: expect.any(Number) as number },
      ]);
      valid(s.events);
      // Each by its own verified path: the session's interrupt, and the aside's cancel by its request's id.
      expect(s.written().slice(-2)).toEqual(['interrupt', 'control_cancel_request']);
      expect(s.process().frames.at(-1)).toEqual({ type: 'control_cancel_request', request_id: side['request_id'] });
      // Nothing was answered, no process is closed for the line itself, and nothing is left waiting: the Stop's own ends follow.
      expect([answers(s), s.process().closes]).toEqual([[], 0]);
      s.process().refuse(side);
      await settled();
      s.result(true);
      s.lifecycle('cancelled');
      await settled();
      expect(s.ends()).toEqual([
        { type: 'turn-ended', turnId: 'aside-turn-1', asideId: 'aside-1', outcome: 'interrupted', reported: true },
        { type: 'turn-ended', turnId: 'turn-1', outcome: 'interrupted', reported: true },
      ]);
      expect(JSON.stringify([s.events, s.chat.diagnostics])).not.toMatch(/private-big|xxxx|cli-late/);
    });

    it('stops a line that may be a request the same way, an aside alone where only an aside runs, and workers left after their turn as Stop stops them', async () => {
      const maybe = await running('ask-first');
      maybe.process().script.bytes(big('{"request":{"content":', '},"type":"control_request","request_id":"cli-later"}'));
      await settled();
      expect(maybe.notices()).toEqual([{ type: 'notice', kind: 'line-too-long', turnId: 'turn-1', size: expect.any(Number) as number }]);
      expect(maybe.written().at(-1)).toBe('interrupt');

      const aside = await idle('ask-first');
      aside.session.ask?.(ASIDE);
      await settled();
      aside.process().script.bytes(noId());
      await settled();
      expect(aside.notices()).toEqual([{ type: 'notice', kind: 'line-too-long', turnId: 'aside-turn-1', asideId: 'aside-1', size: expect.any(Number) as number }]);
      expect(aside.written().at(-1)).toBe('control_cancel_request');
      expect(aside.written()).not.toContain('interrupt');

      const workers = await running('ask-first');
      workers.tool('Agent', { description: 'Works on' });
      workers.worker();
      workers.text('The worker goes on.', 'a1');
      workers.result();
      workers.lifecycle('completed');
      await settled();
      workers.process().script.bytes(noId());
      await settled();
      // No turn, workers open: Stop ends the process, as it does today.
      expect(workers.types().slice(-4)).toEqual(['notice:line-too-long', 'activity-ended', 'worker-ended', 'notice:workers-stopped']);
      expect(workers.process().closes).toBe(1);
    });

    it('skips and counts such a line with nothing running, and a line of a kind that waits for no reply, as before', async () => {
      const s = await idle('ask-first');
      const before = s.events.length;
      s.process().script.bytes(noId());
      s.process().script.bytes(big('{"type":"user","message":{"content":', '}}'));
      await settled();
      expect(s.events.slice(before)).toEqual([]);
      expect([s.session.counts.dropped.oversized, s.session.counts.refused, answers(s), s.process().closes]).toEqual([2, {}, [], 0]);
      // And a turn that is running goes on past a line that is no request.
      const during = await running('ask-first');
      during.process().script.bytes(big('{"type":"user","message":{"content":', '}}'));
      await settled();
      expect([during.notices(), during.written().includes('interrupt')]).toEqual([[], false]);
    });
  });
});

describe('a plan turn (M22b, V3; C7, C8, C51)', () => {
  const NINE = ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Read', 'Write', 'mcp__docs__read'];
  type S = ReturnType<typeof setup>;
  const PLAN = { plan: '# Plan\n\n1. Append the line.', planFilePath: 'C:\\config\\plans\\a.md' };
  const uses = (toolUseId: string, name: string, input: unknown): Record<string, unknown> => ({ type: 'assistant', uuid: `uuid-${toolUseId}`, parent_tool_use_id: null, message: { model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: toolUseId, name, input }] } });
  const asksPlan = (id: string, toolUseId: string, input: unknown = PLAN): Record<string, unknown> => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', display_name: 'ExitPlanMode', input, tool_use_id: toolUseId } });
  const status = (word: string): Record<string, unknown> => ({ type: 'system', subtype: 'status', status: null, permissionMode: word, session_id: SESSION });
  const answers = (s: S): Record<string, unknown>[] => s.process().frames.filter((frame) => frame['type'] === 'control_response');
  const sets = (s: S): unknown[] => s.process().frames.filter((frame) => frame.request?.['subtype'] === 'set_permission_mode').map((frame) => frame.request?.['mode']);
  /** A plain turn in flight under Ask first: no plan mode. */
  async function plain(): Promise<S> {
    const s = setup({ start: { mode: 'ask-first' } });
    await s.open(turn());
    s.lifecycle('queued');
    s.lifecycle('started');
    s.init({ tools: NINE, permissionMode: 'default' });
    await settled();
    return s;
  }
  /** A plan turn in flight under Ask first: plan mode set and confirmed, the prompt taken, its `init` in plan mode. */
  async function planning(): Promise<S> {
    const s = setup({ start: { mode: 'ask-first' } });
    await s.open({ ...turn(), plan: true });
    s.process().reply(s.process().sent('set_permission_mode'), { mode: 'plan' });
    s.frame(status('plan'));
    await settled();
    s.lifecycle('queued');
    s.lifecycle('started');
    s.init({ tools: NINE, permissionMode: 'plan' });
    await settled();
    return s;
  }

  // M23 (V19; C88): Send now only while the chat's own mode is in force with no change of it waiting.
  it('offers no Send now while a plan turn plans, and offers it in a plain turn under the same mode', async () => {
    const CAN_CANCEL = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'];
    const s = setup({ start: { mode: 'ask-first' } });
    await s.open({ ...turn(), plan: true });
    s.process().reply(s.process().sent('set_permission_mode'), { mode: 'plan' });
    s.frame(status('plan'));
    await settled();
    s.lifecycle('queued');
    s.lifecycle('started');
    s.init({ tools: NINE, permissionMode: 'plan', capabilities: CAN_CANCEL });
    await settled();
    expect(s.session.steerState()).toBe('wait');
    expect(await s.session.steer({ turnId: 'turn-1', messageId: 'steer-1', prompt: 'Now' })).toEqual({ kind: 'turn-over' });
    expect(s.process().prompts()).toHaveLength(1);
    const p = setup({ start: { mode: 'ask-first' } });
    await p.open(turn());
    p.lifecycle('queued');
    p.lifecycle('started');
    p.init({ tools: NINE, permissionMode: 'default', capabilities: CAN_CANCEL });
    await settled();
    expect(p.session.steerState()).toBe('open');
  });

  it('takes a message from Execute’s status frame on, which a steer-changed says, so that one held while it planned goes in then', async () => {
    const s = setup({ start: { mode: 'ask-first' } });
    const said: string[] = [];
    s.session.subscribe((event) => { if (event.type === 'steer-changed') said.push(s.session.steerState()); });
    await s.open({ ...turn(), plan: true });
    s.process().reply(s.process().sent('set_permission_mode'), { mode: 'plan' });
    s.frame(status('plan'));
    await settled();
    s.lifecycle('queued');
    s.lifecycle('started');
    s.init({ tools: NINE, permissionMode: 'plan', capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'] });
    s.frame(uses('use-p', 'ExitPlanMode', PLAN));
    s.frame(asksPlan('cli-p1', 'use-p'));
    await settled();
    expect(s.session.steerState()).toBe('wait');
    expect(await s.session.decidePlan('cli-p1', { kind: 'execute' })).toBe(true);
    expect(s.session.steerState()).toBe('wait');
    s.frame(status('default'));
    expect(s.session.steerState()).toBe('open');
    expect(said).toEqual(['open']);
  });

  it('sets the plan word before the prompt, and writes the prompt only once the reply confirms it', async () => {
    const s = setup({ start: { mode: 'ask-first' } });
    await s.open({ ...turn(), plan: true });
    expect(sets(s)).toEqual(['plan']);
    expect(s.process().prompts()).toEqual([]);
    s.process().reply(s.process().sent('set_permission_mode'), { mode: 'plan' });
    await settled();
    expect(s.process().prompts()).toHaveLength(1);
    // The mode's own confirmation names the chat's mode alone: no plan is ever confirmed as one.
    expect(s.confirmed).toEqual(['ask-first']);
  });

  it('fails the start, with the word, where the reply names another than the plan’s (C7)', async () => {
    const s = setup({ start: { mode: 'ask-first' } });
    await s.open({ ...turn(), plan: true });
    s.process().reply(s.process().sent('set_permission_mode'), { mode: 'acceptEdits' });
    await settled();
    expect(s.ends()).toEqual([{ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'policy-mismatch' }]);
    expect(s.notices()).toEqual([{ type: 'notice', kind: 'policy-mismatch', turnId: 'turn-1', detail: 'acceptEdits' }]);
    expect(s.process().prompts()).toEqual([]);
  });

  it('refuses a plan’s request outside a plan turn as any unknown request, and raises nothing (C8)', async () => {
    const s = await plain();
    s.frame(uses('use-p', 'ExitPlanMode', PLAN));
    s.frame(asksPlan('cli-p1', 'use-p'));
    await settled();
    expect(answers(s)).toEqual([{ type: 'control_response', response: { subtype: 'success', request_id: 'cli-p1', response: { behavior: 'deny', message: DENY_MESSAGE } } }]);
    expect(s.events.filter((event) => event.type === 'plan-raised')).toEqual([]);
  });

  it('after its Execute the turn plans no longer: a second plan’s request is refused, the chat’s mode is in force by the status frame, and nothing is set back (C7, C8)', async () => {
    const s = await planning();
    s.frame(uses('use-p', 'ExitPlanMode', PLAN));
    s.frame(asksPlan('cli-p1', 'use-p'));
    await settled();
    const raised = s.events.find((event) => event.type === 'plan-raised');
    expect(raised).toMatchObject({ type: 'plan-raised', turnId: 'turn-1', requestId: 'cli-p1', sourceId: 'use-p', text: PLAN.plan });
    expect(await s.session.decidePlan('cli-p1', { kind: 'execute' })).toBe(true);
    expect(answers(s).at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'cli-p1', response: { behavior: 'allow', updatedInput: PLAN } } });
    // The CLI's own word that it went back, within milliseconds of the allow: the change reported, no mismatch.
    s.frame(status('default'));
    s.frame(uses('use-p2', 'ExitPlanMode', PLAN));
    s.frame(asksPlan('cli-p2', 'use-p2'));
    await settled();
    expect(answers(s).at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'cli-p2', response: { behavior: 'deny', message: DENY_MESSAGE } } });
    s.result();
    s.lifecycle('completed');
    await settled();
    expect(s.ends()).toMatchObject([{ outcome: 'completed', reported: true }]);
    expect(sets(s)).toEqual(['plan']);
    expect(s.notices().filter((notice) => notice.kind === 'policy-mismatch')).toEqual([]);
  });

  it('takes a status frame that names the chat’s mode while planning, with no Execute armed, as another policy (C7)', async () => {
    const s = await planning();
    s.frame(status('default'));
    await settled();
    expect(s.notices()).toMatchObject([{ kind: 'policy-mismatch', detail: 'default' }]);
    expect(s.ends()).toMatchObject([{ outcome: 'failed', failure: 'policy-mismatch' }]);
  });

  it('sets the chat’s word back after a Cancel, before the turn’s end is said, and ends the process where the reply names another (C7, C77)', async () => {
    const s = await planning();
    s.frame(uses('use-p', 'ExitPlanMode', PLAN));
    s.frame(asksPlan('cli-p1', 'use-p'));
    await settled();
    await s.session.decidePlan('cli-p1', { kind: 'cancel' });
    s.frame({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, terminal_reason: 'aborted_streaming' });
    await settled();
    // Read as stopped (C77): no notice of a failure.
    expect(s.ends()).toMatchObject([{ outcome: 'interrupted', reported: true }]);
    expect(sets(s)).toEqual(['plan', 'default']);
    s.process().reply(s.process().sent('set_permission_mode'), { mode: 'acceptEdits' });
    await settled();
    expect(s.notices()).toMatchObject([{ kind: 'policy-mismatch', detail: 'acceptEdits' }]);
  });

  // Decision 0029: a plan's request closed so the chat's mode can change, the change asked at once.
  it('waits out the chat’s word being set back after a Cancel before a change of mode is asked, then takes the change', async () => {
    const s = await planning();
    s.frame(uses('use-p', 'ExitPlanMode', PLAN));
    s.frame(asksPlan('cli-p1', 'use-p'));
    await settled();
    await s.session.decidePlan('cli-p1', { kind: 'cancel' });
    s.frame({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, terminal_reason: 'aborted_streaming' });
    await settled();
    expect(sets(s)).toEqual(['plan', 'default']);
    // Asked while the restore's reply is awaited: nothing more is written until it is in force.
    const change = s.session.setMode('edits-ok');
    await settled();
    expect(sets(s)).toEqual(['plan', 'default']);
    s.process().reply(s.process().sent('set_permission_mode'), { mode: 'default' });
    await settled();
    expect(sets(s)).toEqual(['plan', 'default', 'acceptEdits']);
    s.process().reply(s.process().sent('set_permission_mode'), { mode: 'acceptEdits' });
    await expect(change).resolves.toEqual({ confirmed: true });
  });
});

// M23, V5 (C21, C23): a prompt's images in the one frame the CLI takes, as K2 sent them.
describe('a prompt with images (M23: V5; C21, C23)', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 9]);
  const attachments = [
    { mediaType: 'image/png' as const, path: 'C:\\data\\attachments\\a.png', bytes: png },
    { mediaType: 'image/gif' as const, path: 'C:\\data\\attachments\\b.gif', bytes: gif },
  ];

  it('writes the text block and one base64 image block per image, in their order, under the message’s id', async () => {
    const s = setup();
    await s.open({ ...turn(), attachments });
    expect(s.process().prompts()).toEqual([{
      type: 'user', uuid: 'message-1', parent_tool_use_id: null, session_id: '',
      message: { role: 'user', content: [
        { type: 'text', text: 'Prompt 1' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } },
        { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: Buffer.from(gif).toString('base64') } },
      ] },
    }]);
    // No path is sent: Claude takes the image inline (C21).
    expect(JSON.stringify(s.process().prompts())).not.toContain('attachments');
  });

  it('writes images alone for a prompt with no text, and the text alone, as before, for one with none', async () => {
    const s = setup();
    await s.open({ ...turn(), prompt: '', attachments: [attachments[0] as (typeof attachments)[number]] });
    expect(s.process().prompts()[0]?.['message']).toEqual({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } }] });
    const plain = setup();
    await plain.open({ ...turn(), attachments: [] });
    expect(plain.process().prompts()[0]?.['message']).toEqual({ role: 'user', content: 'Prompt 1' });
  });
});

// ── The context window (decision 0033) ──────────────────────────────────────────────────────────
describe('how full the context is (decision 0033)', () => {
  const discovery = (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures/discovery-idle.json'), 'utf8')) as { frames: { dir: string; frame: { type?: string; response?: { subtype?: string; response?: Record<string, unknown> } } }[] }).frames;
  /** M10's reply to the request, as the CLI gave it. */
  const REPLY_VALUE = discovery.find((entry) => entry.dir === 'recv' && entry.frame.response?.response?.['totalTokens'] !== undefined)?.frame.response?.response as Record<string, unknown>;
  const asked = (s: ReturnType<typeof setup>) => s.process().frames.filter((written) => written.request?.['subtype'] === 'get_context_usage');
  const usage = (input: number, cacheRead: number, output: number, parent: string | null = null) => ({ type: 'assistant', uuid: `usage-${input}`, parent_tool_use_id: parent, session_id: SESSION, message: { model: 'claude-sonnet-5', id: `msg-${input}`, content: [{ type: 'text', text: 'Working.' }], usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output } } });

  it('asks before the turn’s prompt, waiting on nothing, and says the reply’s reading: the count, the window, the line, the used parts', async () => {
    const s = setup({ context: 'manual' });
    await s.open();
    expect(s.process().frames.map((written) => String(written.request?.['subtype'] ?? written['type']))).toEqual(['initialize', 'get_context_usage', 'user']);
    expect(asked(s)[0]?.request).toEqual({ subtype: 'get_context_usage', detail: 'summary' });
    s.process().reply(asked(s)[0] as never, REPLY_VALUE);
    await settled();
    expect(s.readings).toEqual([{
      used: 23_605, window: 1_000_000, compactAt: 967_000,
      parts: [{ label: 'System prompt', tokens: 3_183 }, { label: 'System tools', tokens: 18_363 }, { label: 'Skills', tokens: 2_059 }],
      messages: { toolCalls: 0, toolResults: 0, answers: 0, prompts: 0, attachments: 0, other: 0 },
    }]);
    expect(s.events).toEqual([]);
    expect(s.timers.pending()).toEqual([CHAT_TIMINGS.startedMs]);
    expect(s.session.counts.context).toEqual({ asked: 1, read: 1, failed: 0 });
  });

  it('counts the session’s own calls between replies, keeping the window and the line; a sub-agent’s call and one that read nothing count for nothing', async () => {
    const s = setup({ context: 'manual' });
    await s.open();
    s.process().reply(asked(s)[0] as never, REPLY_VALUE);
    await settled();
    s.lifecycle('queued');
    s.lifecycle('started');
    s.init();
    s.frame(usage(4, 30_000, 800));
    s.frame(usage(9, 50_000, 100, 'tool-1'));
    s.frame(usage(0, 0, 40));
    await settled();
    expect(s.readings.map((reading) => [reading.used, reading.window, reading.compactAt, reading.lastCall])).toEqual([
      [23_605, 1_000_000, 967_000, undefined],
      [30_804, 1_000_000, 967_000, { input: 4, cacheRead: 30_000, cacheWrite: 0, output: 800 }],
    ]);
    // The same count again says nothing.
    s.frame(usage(4, 30_000, 800));
    await settled();
    expect(s.readings).toHaveLength(2);
  });

  it('asks again after each turn the CLI ended, one request at a time, and a usage newer than the reply is kept over its count', async () => {
    const s = setup({ context: 'manual' });
    await s.running();
    // The first request still waits as the turn ends: the second is asked once it is answered.
    s.frame(usage(4, 30_000, 800));
    s.result();
    s.lifecycle('completed');
    await settled();
    expect(asked(s)).toHaveLength(1);
    s.process().reply(asked(s)[0] as never, REPLY_VALUE);
    await settled();
    expect(asked(s)).toHaveLength(2);
    // Its usage came after the first request was written: newer than that reply's count.
    expect(s.readings.at(-1)?.used).toBe(30_804);
    s.process().reply(asked(s)[1] as never, { ...REPLY_VALUE, totalTokens: 31_000, apiUsage: { input_tokens: 4, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000 } });
    await settled();
    expect(s.readings.at(-1)).toMatchObject({ used: 31_000, lastCall: { input: 4, cacheRead: 30_000, cacheWrite: 0, output: 800 } });
    expect(s.session.counts.context).toEqual({ asked: 2, read: 2, failed: 0 });
  });

  it('asks no more on a process that refused, and asks again at the next start after one that was late; a late reply says nothing', async () => {
    const refusing = setup();
    await refusing.complete(turn(1), 1);
    await refusing.complete(turn(2), 2);
    expect(asked(refusing)).toHaveLength(1);
    expect([refusing.readings, refusing.notices()]).toEqual([[], []]);
    expect(refusing.session.counts.context).toEqual({ asked: 1, read: 0, failed: 1 });

    const late = setup({ context: 'manual' });
    await late.open();
    late.timers.advance(CHAT_TIMINGS.contextMs);
    await settled();
    expect(late.session.counts.context).toEqual({ asked: 1, read: 0, failed: 1 });
    late.process().reply(asked(late)[0] as never, REPLY_VALUE);
    await settled();
    expect(late.readings).toEqual([]);
    expect(late.notices()).toEqual([]);
  });

  it('never asks for a process an aside launched, nor while it answers', async () => {
    const s = setup({ context: 'manual' });
    s.session.ask?.({ asideId: 'aside-1', turnId: 'aside-turn-1', text: 'Why?', messageId: 'aside-message-1', history: [], throughTurn: null, effort: 'low', speed: null });
    await settled();
    s.process().reply(s.process().sent('initialize'), REPLY);
    await settled();
    expect(asked(s)).toEqual([]);
  });

  it('says nothing once its process has ended', async () => {
    const s = setup({ context: 'manual' });
    await s.open();
    s.process().end(1);
    await settled();
    expect(s.readings).toEqual([]);
    expect(s.session.counts.context.failed).toBe(1);
  });
});
