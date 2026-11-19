// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V10, V26, V27, V31 (docs/planning/_archive/M16.md; C10–C14, C21, C27, C62, C66, C67, C69, C83): a Claude
// chat session's first prompt, on the real adapter and process layer against the replay fake — the
// process it starts and what that process is given, the two checks of its start, the effort, and a
// prompt that names one of the CLI's commands. V27 is M20b's rewrite (M20b.md, V8; C54–C60; decision
// 0023): the launch leaves the CLI's commands on, a listed command is answered by fat-g and never
// sent, and every other is written as it is, with the CLI's own answer as the turn's message.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import { CLAUDE_INSTANCES } from '../../../src/main/providers/claude/descriptor';
import { CLAUDE_KEPT_VARIABLES } from '../../../src/main/providers/claude/environment';
import { launchApp, placeRecords, S, sessionEntry, until } from '../../sessions/app';
import { CHAT_FIXED_ARGS, claudeHarness, type Harness, type HarnessOptions, PASSED_COMMANDS, processGone, promptOf, READING, watch } from './harness';

let harness: Harness | undefined;
afterEach(async () => { await harness?.dispose(); harness = undefined; });
const open = async (options?: HarnessOptions): Promise<Harness> => (harness = await claudeHarness(options));
const start = (h: Harness, facet: SessionFacet = h.facet, effort: string | null = 'low') => watch(facet.start({ folder: h.project, model: 'sonnet', effort, speed: null, otherFolders: [], ...READING }));
const signal = (): AbortSignal => new AbortController().signal;

describe('the first prompt (V3)', () => {
  it('starts no process at Start session, and one at the first prompt, in exactly the folder it was given, with the whole argument line', async () => {
    const h = await open();
    const s = start(h);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.pids('chat')).toEqual([]);
    expect(h.sessions()).toEqual({});
    expect(s.events).toEqual([]);

    s.send(h.prompts.t1);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    const { id, entry } = h.only();
    expect(entry.launches).toHaveLength(1);
    expect(entry.launches[0]).toMatchObject({ cwd: h.project, model: 'sonnet', effort: 'low', resume: null, addDirs: [] });
    // The fixed list, then the record's model and effort; no prompt, and nothing else.
    expect(entry.launches[0]?.args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low']);
    expect(entry.launches[0]?.args.some((arg) => arg.includes('Read the file'))).toBe(false);
    expect(h.pids('chat')).toEqual([entry.launches[0]?.pid]);
    expect(s.reference()).toBe(id);
    expect(h.markers()).toEqual([]);
  });

  it('shows what Claude says of T1: the file it read as its action, its text, and that text named as the answer', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t1);
    const end = await s.ended('turn-1');
    // Its text as it is written (M19): opened at its block's start, two deltas, and the frame that completes it.
    // And the read it ran first (M20a, C18): started at its tool use, ended at its result.
    expect(s.types()).toEqual(['turn-started', 'in-force', 'session-started', 'activity-started', 'action-changed', 'activity-ended', 'action-changed', 'message-delta', 'action-changed', 'message-delta', 'message-delta', 'message', 'action-changed', 'turn-ended']);
    const [read] = s.events.flatMap((event) => (event.type === 'activity-started' ? [event] : []));
    expect(read).toMatchObject({ turnId: 'turn-1', activityType: 'read', name: 'Read', files: [{ path: expect.stringMatching(/sample\.txt$/) as string }] });
    expect(s.events.find((event) => event.type === 'activity-ended')).toMatchObject({ itemId: read?.itemId, status: 'completed', output: expect.stringContaining('Biscuit') as string });
    const [message] = s.events.flatMap((event) => (event.type === 'message' ? [event] : []));
    expect(message).toMatchObject({ role: 'assistant', phase: 'commentary', text: 'The cat is called Biscuit.' });
    const deltas = s.events.flatMap((event) => (event.type === 'message-delta' ? [event] : []));
    expect(deltas.map((delta) => delta.itemId)).toEqual([message?.itemId, message?.itemId, message?.itemId]);
    expect(deltas.map((delta) => delta.text).join('')).toBe('The cat is called Biscuit.');
    expect(end).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: message?.itemId });
    expect(s.events.find((event) => event.type === 'action-changed')).toMatchObject({ kind: 'reading', file: 'sample.txt' });
    expect(s.events.find((event) => event.type === 'in-force')).toMatchObject({ model: 'claude-sonnet-5' });
    // The folder it ran in is in no event but the reference's own, and the read's, whose input is the
    // path the tool was given, as the CLI wrote it (M20a, C18).
    const named = new Set(['session-started', 'activity-started', 'activity-ended']);
    expect(JSON.stringify(s.events.filter((event) => !named.has(event.type)))).not.toContain(path.basename(h.dir));
  });

  it('names no effort for a model with no levels', async () => {
    const h = await open();
    const s = start(h, h.facet, null);
    s.send(h.prompts.t1, 1, null);
    await s.ended('turn-1');
    expect(h.only().entry.launches[0]?.args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet']);
    expect(h.only().entry.efforts).toEqual([]);
  });

  it('gives its process the one variable the launch adds, each exported name the review keeps, and nothing of a parent session or of the Agent SDK', async () => {
    const kept = Object.values(CLAUDE_KEPT_VARIABLES).flat().filter((name) => name !== 'CLAUDE_CONFIG_DIR');
    const exported = {
      ...Object.fromEntries(kept.map((name) => [name, '1'])),
      // What a parent session exports, the SDK's identity, a user's own word on background tasks, and a debug switch.
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.278',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', CLAUDE_CODE_DEBUG_LOGS_DIR: 'C:\\logs',
      HTTPS_PROXY: 'http://proxy.invalid:9',
    };
    const h = await open({ env: exported });
    const s = start(h);
    s.send(h.prompts.t1);
    await s.ended('turn-1');
    const [pid] = h.pids('chat');
    const env = h.env('chat', pid as number);
    const claude = env.names.filter((name) => /^CLAUDE/i.test(name)).map((name) => name.toUpperCase()).sort();
    expect(claude).toEqual([...kept, 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'].sort());
    // Set by the launch, whatever was exported.
    expect(env.values['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']).toBe('1');
    expect(env.values['HTTPS_PROXY']).toBe('http://proxy.invalid:9');
    expect(h.markers()).toEqual([]);

    // A usage read's process keeps the same names, and has no variable of the launch's.
    await h.provider.getUsage(signal());
    const usage = h.env('session', h.pids('session')[0] as number);
    expect(usage.names.filter((name) => /^CLAUDE/i.test(name)).map((name) => name.toUpperCase()).sort()).toEqual([...kept].sort());
  });

  it('gives an added account’s session the variable set to its folder, through its scope; the first account’s inherits as before', async () => {
    const inheritedFolder = path.join(process.cwd(), 'tests', 'inherited-claude-config');
    const h = await open({ env: { [CLAUDE_INSTANCES.variable]: inheritedFolder } });
    const first = start(h);
    first.send(h.prompts.t1);
    await first.ended('turn-1');
    const folder = path.join(h.dir, 'account-two');
    const added = await h.adapter({ variable: CLAUDE_INSTANCES.variable, folder, withhold: CLAUDE_INSTANCES.withhold });
    const second = start(h, added.facet);
    second.send(h.prompts.t1);
    await second.ended('turn-1');
    const launches = Object.values(h.sessions()).flatMap((entry) => entry.launches);
    expect(launches.map((launch) => launch.config).sort()).toEqual([folder, inheritedFolder].sort());
    // Two sessions, two processes, two conversations.
    expect(new Set(launches.map((launch) => launch.pid)).size).toBe(2);
    expect(Object.keys(h.sessions())).toHaveLength(2);
  });

  it('runs a usage read beside a turn, and two sessions’ turns at once, each on a process of its own (C10)', async () => {
    const h = await open();
    const a = start(h);
    const b = start(h);
    a.send(h.prompts.t4);
    b.send(h.prompts.t4);
    await Promise.all([a.until((event) => event.type === 'action-changed'), b.until((event) => event.type === 'action-changed')]);
    expect(h.running('chat')).toHaveLength(2);
    // Both turns wait for their Stop. A usage read starts, runs and ends meanwhile.
    expect(await h.provider.getUsage(signal())).toMatchObject({ kind: 'usage' });
    expect(a.events.some((event) => event.type === 'turn-ended')).toBe(false);
    expect(h.running('chat')).toHaveLength(2);
    a.session.stop();
    b.session.stop();
    expect((await Promise.all([a.ended('turn-1'), b.ended('turn-1')])).map((end) => end.outcome)).toEqual(['interrupted', 'interrupted']);
    // No usage session saw a prompt, and none overlapped another.
    expect(h.markers()).toEqual([]);
  });

  it('takes the next prompt on the same process, with no second launch and no second reference', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t1, 1);
    await s.ended('turn-1');
    s.send(h.prompts.t3, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed', reported: true });
    const { entry } = h.only();
    expect(entry.launches).toHaveLength(1);
    expect(entry.turns).toEqual(['m19-t1-basic', 'm19-t3-subagent']);
    expect(s.events.filter((event) => event.type === 'session-started')).toHaveLength(1);
    // T3's worker, opened and ended once, inside the second turn; its first frame names its model (M106, C14).
    expect(s.events.filter((event) => event.type.startsWith('worker-')).map((event) => event.type)).toEqual(['worker-started', 'worker-model', 'worker-progressed', 'worker-progressed', 'worker-ended']);
  });

  it('fails a turn with the CLI’s own message, and keeps its process for the next prompt', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t5, 1);
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: true, failure: 'turn-failed' });
    const notice = s.events.find((event) => event.type === 'notice');
    expect(notice).toMatchObject({ kind: 'turn-failed', turnId: 'turn-1' });
    expect(notice?.type === 'notice' ? notice.detail : '').toContain('There\'s an issue with the selected model');
    expect(s.events.some((event) => event.type === 'message')).toBe(false);
    s.send(h.prompts.t1, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed' });
    expect(h.only().entry.launches).toHaveLength(1);
  });
});

describe('a prompt that names one of the CLI’s commands (V27; M20b, V8; C54–C60)', () => {
  it('is written as it is where fat-g holds no list entry for it, and the CLI’s own answer is the turn’s message: the turn completes, and nothing ran', async () => {
    const h = await open();
    const s = start(h);
    expect(h.prompts.command).toBe('/exit');
    s.send(h.prompts.command);
    const end = await s.ended('turn-1');
    const [message] = s.events.flatMap((event) => (event.type === 'message' ? [event] : []));
    expect(message).toMatchObject({ role: 'assistant', text: '/exit isn\'t available in this environment.' });
    expect(end).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'completed', reported: true, answerItemId: message?.itemId });
    // The launch leaves the CLI's commands on (C54), and the fake replayed K2's capture for that very prompt.
    expect(h.only().entry.launches[0]?.args).not.toContain('--disable-slash-commands');
    expect(h.only().entry.launches[0]?.args).toEqual([...CHAT_FIXED_ARGS, '--model', 'sonnet', '--effort', 'low']);
    expect(h.only().entry.turns).toEqual(['m20b-cmd-exit']);
    // The process is still the session's: `/exit` ended nothing.
    s.send(h.prompts.t1, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed' });
    expect(h.only().entry.launches).toHaveLength(1);
  });

  it.each(PASSED_COMMANDS)('passes %s as the user wrote it, and shows what the CLI answered (C57, C58)', async (capture) => {
    const h = await open();
    const s = start(h);
    const prompt = promptOf(capture, h.project);
    expect(prompt).toMatch(/^\/[a-z]+(\s|$)/);
    s.send(prompt);
    const end = await s.ended('turn-1');
    // Written as it is: the fake chose the capture by the prompt's own text.
    expect(h.only().entry.turns).toEqual([capture]);
    const messages = s.events.flatMap((event) => (event.type === 'message' && event.role === 'assistant' ? [event] : []));
    expect(messages.length, capture).toBeGreaterThan(0);
    for (const message of messages) expect(message.text.trim(), capture).not.toBe('');
    expect(end, capture).toMatchObject({ outcome: 'completed', reported: true });
    // fat-g says nothing of its own about what the command did: no notice, and no word of a smaller context (C57).
    expect(s.events.filter((event) => event.type === 'notice'), capture).toEqual([]);
  });

  it('never sends a listed command: fat-g answers `/model` and `/clear` itself, in a turn of its own, and no process is started for it (C55, C56)', async () => {
    const h = await open();
    expect(h.prompts.intercepted).toBe('/model haiku');
    const data = path.join(h.dir, 'records');
    placeRecords(data, h.project, 'claude', [sessionEntry(1, 'claude', { model: 'sonnet' })]);
    const app = launchApp({ dir: data, descriptor: h.provider.descriptor, facet: () => h.facet });
    try {
      for (const [n, prompt, notice] of [[1, h.prompts.intercepted, 'command-model'], [2, '/clear', 'command-clear']] as const) {
        expect(await app.runtime.send(S(1), prompt)).toEqual({ status: 'accepted' });
        await until(() => app.read(1).turns.length === n && app.read(1).turns.every((turn) => turn.state === 'ended'), `the answer to ${prompt}`);
        const read = app.read(1);
        // The prompt as it was written, then fat-g's notice by its kind: no message of a model's.
        expect(read.items.slice(-2).map((item) => [item.role, item.notice])).toEqual([['user', null], [null, notice]]);
        expect(read.items.at(-2)?.blocks).toEqual([{ type: 'text', text: prompt, cut: false }]);
        expect(read.turns.at(-1)).toMatchObject({ state: 'ended', outcome: 'completed' });
        expect(app.service.isRunning(S(1))).toBe(false);
      }
      // Nothing was sent: the fake was never started, so no session of it exists.
      expect(h.sessions()).toEqual({});
      expect(h.pids('chat')).toEqual([]);
      // The next prompt is the session's first to reach Claude, and opens its one process.
      expect(await app.runtime.send(S(1), h.prompts.t1)).toEqual({ status: 'accepted' });
      await until(() => !app.service.isRunning(S(1)) && app.read(1).turns.length === 3 && app.read(1).turns.at(-1)?.state === 'ended', 'T1 ending', 20_000);
      expect(h.only().entry.turns).toEqual(['m19-t1-basic']);
      expect(h.only().entry.launches).toHaveLength(1);
    } finally { await app.quit(); }
  });
});

describe('the start’s two checks (V31; C21, C62, C67, C83)', () => {
  it('writes no prompt when the `initialize` reply reports another permission mode: check 1', async () => {
    const h = await open();
    h.control({ otherMode: 'reply' });
    const s = start(h);
    s.send(h.prompts.t1);
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'not-read-only' });
    expect(s.notices()).toEqual(['not-read-only']);
    await processGone(h, s.session);
    // The fake took no prompt: its session was given no turn, and is not kept.
    expect(h.only().entry).toMatchObject({ kept: false, turns: [] });
  });

  it('ends the process at once when the turn’s `init` reports another mode, or offers a tool outside the launch’s: check 2', async () => {
    for (const control of [{ otherMode: 'init' }, { otherTool: true }]) {
      const h = await open();
      h.control(control);
      const s = start(h);
      s.send(h.prompts.t1);
      expect(await s.ended('turn-1'), JSON.stringify(control)).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-overruled' });
      expect(s.notices()).toEqual(['start-overruled']);
      // The prompt had been written: Claude took it before the check could be made.
      expect(s.types().slice(0, 1)).toEqual(['turn-started']);
      expect(h.only().entry.turns).toEqual(['m19-t1-basic']);
      await processGone(h, s.session);
      // Nothing of the turn was shown: no model, no message.
      expect(s.events.some((event) => event.type === 'in-force' || event.type === 'message')).toBe(false);
      await h.dispose();
      harness = undefined;
    }
  });

  it('passes T3 unchanged, whose `init` lists `Task` for the launch’s `Agent` beside the tools of the user’s own connectors', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t3);
    expect(await s.ended('turn-1')).toMatchObject({ outcome: 'completed', reported: true });
    expect(s.notices()).toEqual([]);
    expect(h.only().entry.launches[0]?.args.slice(CHAT_FIXED_ARGS.indexOf('--tools'), CHAT_FIXED_ARGS.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Glob,Grep,Agent,AskUserQuestion']);
  });

  it('makes check 2 on the `init` of a turn the CLI starts by itself: the process is ended, with the notice and no turn to fail', async () => {
    // A slower replay, so the control is in place well before the last `init` goes out.
    const h = await open({ env: { FATG_SMOKE_CLAUDE_GAP_MS: '25' } });
    const s = start(h);
    s.send(h.prompts.self, 1);
    await s.ended('turn-1');
    s.send(h.prompts.ok, 2);
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed' });
    h.control({ otherTool: true });
    await s.until((event) => event.type === 'notice' && event.kind === 'start-overruled', 20_000);
    expect(s.events.at(-1)).toEqual({ type: 'notice', kind: 'start-overruled' });
    await processGone(h, s.session);
    expect(s.events.filter((event) => event.type === 'turn-ended')).toHaveLength(2);
  });
});

describe('the effort (V10; C27)', () => {
  it('sends none for a turn at the launch’s effort, and sets another before the prompt, with `effortLevel` alone', async () => {
    const h = await open();
    const s = start(h);
    s.send(h.prompts.t1, 1, 'low');
    await s.ended('turn-1');
    expect(h.only().entry.efforts).toEqual([]);
    s.send(h.prompts.t1, 2, 'high');
    expect(await s.ended('turn-2')).toMatchObject({ outcome: 'completed' });
    expect(h.only().entry.efforts).toEqual([{ effortLevel: 'high' }]);
    // Held for the process: the next turn at that effort sends none.
    s.send(h.prompts.t1, 3, 'high');
    await s.ended('turn-3');
    expect(h.only().entry.efforts).toEqual([{ effortLevel: 'high' }]);
    expect(h.only().entry.turns).toHaveLength(3);
  });

  it('ends the turn as a failed start, with no prompt written, when the change gets no answer inside its deadline', async () => {
    const h = await open({ timings: { effortMs: 300 } });
    h.control({ hang: 'effort' });
    const s = start(h);
    s.send(h.prompts.t1, 1, 'max');
    expect(await s.ended('turn-1')).toEqual({ type: 'turn-ended', turnId: 'turn-1', outcome: 'failed', reported: false, failure: 'start-failed' });
    expect(s.events.find((event) => event.type === 'notice')).toMatchObject({ kind: 'start-failed', step: 'send' });
    expect(h.only().entry).toMatchObject({ turns: [], efforts: [{ effortLevel: 'max' }] });
    await processGone(h, s.session);
  });
});

describe('a start that fails before Claude took the prompt (C29, C87, C88, C89)', () => {
  it('names the step that got no answer inside its deadline, and writes nothing again', async () => {
    const launch = await open({ timings: { launchMs: 300 } });
    launch.control({ hang: 'initialize' });
    const a = start(launch);
    a.send(launch.prompts.t1);
    expect(await a.ended('turn-1')).toMatchObject({ outcome: 'failed', reported: false, failure: 'start-failed' });
    expect(a.events.find((event) => event.type === 'notice')).toMatchObject({ kind: 'start-failed', step: 'open' });
    await processGone(launch, a.session);
    await launch.dispose();

    const started = await open({ timings: { startedMs: 300 } });
    started.control({ hang: 'started' });
    const b = start(started);
    b.send(started.prompts.t1);
    expect(await b.ended('turn-1')).toMatchObject({ outcome: 'failed', reported: false, failure: 'start-failed' });
    expect(b.events.find((event) => event.type === 'notice')).toMatchObject({ kind: 'start-failed', step: 'send' });
    // No reference: no model answered, so the next prompt would start anew (C87).
    expect(b.reference()).toBeUndefined();
    await processGone(started, b.session);
  });

  it('fails the start when the process ends during the launch, or exits before it answers anything', async () => {
    for (const control of [{ exitDuringLaunch: 1 }, { launchFails: 1 }]) {
      const h = await open();
      h.control(control);
      const s = start(h);
      s.send(h.prompts.t1);
      expect(await s.ended('turn-1'), JSON.stringify(control)).toMatchObject({ outcome: 'failed', reported: false, failure: 'start-failed' });
      expect(s.events.find((event) => event.type === 'notice')).toMatchObject({ kind: 'start-failed', step: 'open' });
      await processGone(h, s.session);
      await h.dispose();
      harness = undefined;
    }
  });
});
