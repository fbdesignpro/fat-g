// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessFailure, type ManagedProcess, type ProviderProcesses, type RunOptions } from '@shared/provider-kit/process';
import { scriptedChild, type Frame, type ScriptedChild, type ScriptedChildOptions } from './control-test-support';
import { CONTROL_ARGS, INITIALIZE_REQUEST, runClaudeSession, SESSION_LIMITS, type ClaudeSessionOptions } from './session';

/** What Agent SDK 0.3.278 sent for the same options (spikes/capture-sdk-wire.mjs). */
const REFERENCE = JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/sdk-0.3.278-wire.json'), 'utf8')) as {
  spawn: { args: string[]; envAdded: Record<string, string> };
  frames: { type: string; request: Record<string, unknown> }[];
};
const executable = { path: 'C:\\bin\\claude.exe', kind: 'native' } as const;
const ACCOUNT = { email: 'claude-smoke@example.test', organization: 'Smoke Org', subscriptionType: 'Claude Max', apiProvider: 'firstParty' };
const USAGE = { rate_limits_available: true, rate_limits: null };
/** What the result carries for the models when the reply lists none (M13). */
const NO_MODELS = { models: undefined, fastModeState: undefined, fastModeDisabledReason: undefined };
/** The `initialize` reply of M10's idle discovery session, account and all (V6). */
const DISCOVERY = (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures/discovery-idle.json'), 'utf8')) as { frames: { frame?: { response?: { response?: Record<string, unknown> } } }[] })
  .frames.map((entry) => entry.frame?.response?.response).find((reply) => reply?.['models'] !== undefined) ?? {};
afterEach(() => vi.useRealTimers());

interface CliScript {
  /** Reply to `initialize`: an account, a rejection, or nothing at all. */
  readonly initialize?: { account: unknown } | { reject: string } | 'withhold';
  /** A usage value, `{ reject }` or 'withhold'. */
  readonly usage?: unknown;
  readonly child?: Omit<ScriptedChildOptions, 'onFrame'>;
  /** Lines the CLI writes before its first reply. */
  readonly noise?: (child: ScriptedChild) => void;
}

function cli(script: CliScript = {}): ScriptedChild {
  return scriptedChild({
    ...script.child,
    onFrame(frame: Frame, child) {
      const subtype = frame.request?.['subtype'];
      const answer = subtype === 'initialize' ? script.initialize ?? { account: ACCOUNT } : script.usage ?? USAGE;
      if (answer === 'withhold') return;
      script.noise?.(child);
      if (typeof answer === 'object' && answer !== null && 'reject' in answer) child.reject(frame, answer.reject);
      else child.reply(frame, answer);
    },
  });
}

function harness(script: CliScript = {}, spawn?: (options: RunOptions) => Promise<ManagedProcess>) {
  const child = cli(script);
  const spawned: { args: readonly string[]; options: RunOptions }[] = [];
  const processes = {
    spawn: vi.fn(async (_executable: unknown, args: readonly string[], options: RunOptions) => {
      spawned.push({ args, options });
      if (spawn) return spawn(options);
      options.signal?.addEventListener('abort', () => child.abort(), { once: true });
      return child.child;
    }),
  } as unknown as ProviderProcesses;
  const options = (extra: Partial<ClaudeSessionOptions> = {}): ClaudeSessionOptions => ({
    processes, executable, probeDirectory: 'C:\\probe', argsPrefix: ['fixture.mjs'], ...extra,
  });
  return { child, spawned, processes, options };
}

const accept = () => true;
const subtypes = (child: ScriptedChild) => child.frames.map((frame) => frame.request?.['subtype']);

describe('Claude control session', () => {
  it('launches once with the Agent SDK’s exact arguments and frames, minus its identity (decision 0006)', async () => {
    const h = harness();
    expect(await runClaudeSession(h.options(), new AbortController().signal, accept)).toEqual({ kind: 'read', account: ACCOUNT, usage: { kind: 'available', value: USAGE }, models: NO_MODELS });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.args).toEqual(['fixture.mjs', ...REFERENCE.spawn.args]);
    expect([...CONTROL_ARGS]).toEqual(REFERENCE.spawn.args);
    expect(Object.keys(h.spawned[0]!.options).sort()).toEqual(['cwd', 'signal']);
    expect(h.spawned[0]!.options.cwd).toBe('C:\\probe');
    expect(h.spawned[0]!.options.signal).toBeInstanceOf(AbortSignal);
    expect(h.spawned[0]!.options).not.toHaveProperty('env'); // nothing added: no entrypoint, no SDK version
    expect(Object.keys(REFERENCE.spawn.envAdded).sort()).toEqual(['CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT']);
    expect(h.child.frames.map(({ type, request }) => ({ type, request }))).toEqual(REFERENCE.frames.map(({ type, request }) => ({ type, request })));
    expect({ subtype: 'initialize', ...INITIALIZE_REQUEST }).toEqual(REFERENCE.frames[0]!.request);
    // EOF, a natural exit, then confirmation — never a kill on a normal read.
    expect(h.child.log).toEqual(['end', 'exit', 'stop']);
  });

  it('sends control requests only, never a prompt', async () => {
    const h = harness();
    await runClaudeSession(h.options(), new AbortController().signal, accept);
    expect(h.child.frames.every((frame) => frame['type'] === 'control_request')).toBe(true);
    expect(subtypes(h.child)).toEqual(['initialize', 'get_usage']);
  });

  // V6 (M13, C26, C27; S7): the models come from the reply the session already receives.
  it('keeps the reply’s models and fast-mode fields, and nothing else of it, with no request added', async () => {
    const reply = { ...DISCOVERY, account: ACCOUNT };
    const h = harness({ initialize: reply });
    const result = await runClaudeSession(h.options(), new AbortController().signal, accept);
    expect(result).toMatchObject({ kind: 'read', models: { models: DISCOVERY['models'], fastModeState: 'off', fastModeDisabledReason: 'sdk_opt_in_required' } });
    expect(Object.keys(result.kind === 'read' ? result.models : {}).sort()).toEqual(['fastModeDisabledReason', 'fastModeState', 'models']);
    // The reply’s commands, agents and output styles stay here.
    expect(JSON.stringify(result)).not.toMatch(/available_output_styles|"commands"|"agents"/);
    expect(subtypes(h.child)).toEqual(['initialize', 'get_usage']);
  });

  it('carries the models with an account the guard held back', async () => {
    const h = harness({ initialize: { ...DISCOVERY, account: { apiProvider: 'bedrock' } } });
    expect(await runClaudeSession(h.options(), new AbortController().signal, () => false)).toMatchObject({ kind: 'account-only', models: { fastModeState: 'off' } });
  });

  it('drops output noise without keeping it', async () => {
    const h = harness({ noise: (child) => { child.line({ type: 'system', note: 'private' }); child.bytes('private non-JSON line\n'); } });
    const result = await runClaudeSession(h.options(), new AbortController().signal, accept);
    expect(result.kind).toBe('read');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('sends no usage request when the account guard declines', async () => {
    const h = harness({ initialize: { account: { apiProvider: 'bedrock' } } });
    const guard = vi.fn(() => false);
    expect(await runClaudeSession(h.options(), new AbortController().signal, guard)).toEqual({ kind: 'account-only', account: { apiProvider: 'bedrock' }, models: NO_MODELS });
    expect(guard).toHaveBeenCalledWith({ apiProvider: 'bedrock' });
    expect(subtypes(h.child)).toEqual(['initialize']);
    expect(h.child.log).toEqual(['end', 'exit', 'stop']);
  });

  it('hands the guard an absent account when the reply has none', async () => {
    const h = harness({ initialize: { account: undefined } });
    const guard = vi.fn(() => false);
    expect(await runClaudeSession(h.options(), new AbortController().signal, guard)).toEqual({ kind: 'account-only', account: undefined, models: NO_MODELS });
  });

  it('a withheld initialize expires the startup deadline and stops the tree, without any usage request', async () => {
    vi.useFakeTimers();
    const h = harness({ initialize: 'withhold' });
    const running = runClaudeSession(h.options({ startupTimeoutMs: 1000 }), new AbortController().signal, accept);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.child.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toEqual({ kind: 'failed', reason: 'startup-timeout' });
    expect(subtypes(h.child)).toEqual(['initialize']);
    expect(h.child.log).toEqual(['killed', 'exit', 'end', 'stop']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms the startup deadline before the launch; a launch that completes late is stopped, never used', async () => {
    vi.useFakeTimers();
    let finish!: (child: ManagedProcess) => void;
    const late = scriptedChild();
    const h = harness({}, () => new Promise((resolve) => { finish = resolve; }));
    const running = runClaudeSession(h.options({ startupTimeoutMs: 1000 }), new AbortController().signal, accept);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toEqual({ kind: 'failed', reason: 'startup-timeout' });
    finish(late.child);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.log).toEqual(['stop']);
    expect(late.frames).toEqual([]);
  });

  it('bounds the usage request separately, then closes normally', async () => {
    vi.useFakeTimers();
    const h = harness({ usage: 'withhold' });
    const running = runClaudeSession(h.options({ startupTimeoutMs: 1000, usageTimeoutMs: 3000 }), new AbortController().signal, accept);
    await vi.advanceTimersByTimeAsync(2999);
    expect(h.child.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toEqual({ kind: 'read', account: ACCOUNT, usage: { kind: 'failed' }, models: NO_MODELS });
    expect(h.child.log).toEqual(['end', 'exit', 'stop']); // EOF, not a kill
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a caller abort during the usage request stops the tree at once and reports aborted', async () => {
    const h = harness({ usage: 'withhold' });
    const controller = new AbortController();
    const running = runClaudeSession(h.options(), controller.signal, accept);
    await vi.waitFor(() => expect(subtypes(h.child)).toEqual(['initialize', 'get_usage']));
    controller.abort();
    expect(await running).toEqual({ kind: 'failed', reason: 'aborted' });
    expect(h.child.log).toEqual(['killed', 'exit', 'end', 'stop']);
  });

  it('launches nothing for a caller that aborted before it started', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await runClaudeSession(h.options(), controller.signal, accept)).toEqual({ kind: 'failed', reason: 'aborted' });
    expect(h.processes.spawn).not.toHaveBeenCalled();
  });

  it('waits at most the close grace for a natural exit, then stops', async () => {
    vi.useFakeTimers();
    const h = harness({ child: { exitOnEnd: false } });
    const running = runClaudeSession(h.options(), new AbortController().signal, accept);
    await vi.advanceTimersByTimeAsync(SESSION_LIMITS.closeGraceMs - 1);
    expect(h.child.log).toEqual(['end']);
    await vi.advanceTimersByTimeAsync(1);
    expect((await running).kind).toBe('read');
    expect(h.child.log).toEqual(['end', 'stop']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets an unconfirmed cleanup take precedence over a successful reading', async () => {
    const h = harness();
    h.child.setCleanup(false);
    expect(await runClaudeSession(h.options(), new AbortController().signal, accept)).toEqual({ kind: 'cleanup-failed' });
  });

  it('reports a scope latched by an earlier cleanup failure as cleanup-failed', async () => {
    const h = harness({}, () => Promise.reject(new ProcessFailure('cleanup-failed')));
    expect(await runClaudeSession(h.options(), new AbortController().signal, accept)).toEqual({ kind: 'cleanup-failed' });
  });

  it.each([
    ['an initialize rejection', { initialize: { reject: 'Claude Code control request failed' } }],
    ['a crash before any reply', { initialize: 'withhold', noise: undefined }],
  ] as const)('maps %s to a transient failure after teardown', async (name, script) => {
    const h = harness(script);
    const running = runClaudeSession(h.options(), new AbortController().signal, accept);
    if (name === 'a crash before any reply') { await vi.waitFor(() => expect(h.child.frames).toHaveLength(1)); h.child.exit(3); }
    expect(await running).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(h.child.log.at(-1)).toBe('stop');
  });
});
