// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { offeredInstances, presetOffer } from '@shared/contracts/presets';
import { ProcessFailure, type ProviderProcesses } from '@shared/provider-kit/process';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { ProviderEvent } from '@shared/provider-kit/provider';
import { type Frame, type ScriptedChild, scriptedChild } from './control-test-support';
import { CLAUDE_DESCRIPTOR, CLAUDE_INSTALL_HINTS } from './descriptor';
import { CLAUDE_CHILD_ENVIRONMENT } from './environment';
import { createClaudeDefinition, createClaudeProvider } from './index';
import { parseVersion } from './cli';

const exe = { path: 'C:\\bin\\claude.exe', kind: 'native' } as const;

function setup() {
  const processes: ProviderProcesses = {
    resolve: vi.fn(async () => ({ status: 'found', executable: exe, source: 'path' } as const)),
    run: vi.fn(async () => ({ code: 0, signal: null, stdout: '2.1.268 (Claude Code)\n' })),
    spawn: vi.fn(), supervise: vi.fn(), open: vi.fn(), openProcess: vi.fn(), recheck: vi.fn(async () => ({ ok: true })),
    dispose: vi.fn(async () => ({ ok: true })),
  };
  const context: ProviderContext = { processes, logger: { record: vi.fn() }, probeDirectory: 'C:\\probe' };
  return { context, processes };
}
const signal = () => new AbortController().signal;

describe('Claude definition', () => {
  it('describes Claude with its installation guide, the login command and its own child environment policy', () => {
    const definition = createClaudeDefinition();
    expect(definition.descriptor).toEqual(CLAUDE_DESCRIPTOR);
    expect(definition.descriptor).toMatchObject({ id: 'claude', displayName: 'Claude', loginCommand: 'claude auth login', minPollIntervalSec: 60, capabilities: { account: true, usage: 'poll', sessions: true, history: false, otherFolders: true, models: true } });
    expect(definition.installationGuide).toBe('https://code.claude.com/docs/en/setup');
    expect(definition.executableNames).toEqual(['claude']);
    expect(definition.installDirectoryHints).toEqual(CLAUDE_INSTALL_HINTS);
    expect(definition.environment).toBe(CLAUDE_CHILD_ENVIRONMENT);
    expect(JSON.stringify(definition.descriptor)).not.toContain('Claude Code');
  });

  it('is offered in the new-session popup: its descriptor says it has sessions (M16, C42)', () => {
    const { descriptor } = createClaudeDefinition();
    const given = presetOffer(['claude'], [{ id: 'claude', instanceId: 'default', status: { kind: 'ok' }, descriptor }]);
    expect(given.offered).toEqual(['claude']);
    expect(offeredInstances(given)).toEqual([{ providerId: 'claude', instanceId: 'default' }]);
  });

  it('declares how a second account runs: the variable, the default folder, and what an added one does not inherit (M14b, C5, C9)', () => {
    const { instances } = createClaudeDefinition();
    expect(instances).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      defaultFolder: ['.claude'],
      withhold: { names: ['CLAUDE_CODE_OAUTH_TOKEN'], prefixes: ['ANTHROPIC_', 'CLAUDE_CODE_USE_'] },
    });
    // The variable itself is never withheld: an added account's scope sets it.
    expect(instances?.withhold.names).not.toContain(instances?.variable);
    // What the first account keeps and an added one loses is the same reviewed set: the child
    // policy lets each of them through today, so withholding it is a change for an added account alone.
    expect(CLAUDE_CHILD_ENVIRONMENT.keepNames).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']));
    // Backends by name, and no prefix (M16, C81): a prefix kept whatever was named like one.
    expect(CLAUDE_CHILD_ENVIRONMENT.keepNames).toEqual(expect.arrayContaining(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']));
    expect(CLAUDE_CHILD_ENVIRONMENT.keepPrefixes).toBeUndefined();
    // Proxy and certificate settings pass to every account.
    for (const name of ['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_GIT_BASH_PATH']) {
      expect(instances?.withhold.names).not.toContain(name);
      expect(instances?.withhold.prefixes.some((prefix) => name.startsWith(prefix))).toBe(false);
    }
  });
});

describe('Claude detection', () => {
  it('resolves through the process layer and runs one bounded version probe without authenticating', async () => {
    const h = setup();
    const provider = createClaudeProvider(h.context, { argsPrefix: ['fixture.mjs'] });
    const probe = signal();
    expect(await provider.detect({ override: 'C:\\chosen\\claude.exe', knownDirs: ['C:\\known'] }, probe)).toEqual({ kind: 'found', installation: { source: 'path', version: '2.1.268' }, executable: exe });
    expect(h.processes.resolve).toHaveBeenCalledWith({ override: 'C:\\chosen\\claude.exe', names: ['claude'], knownDirs: ['C:\\known'], cwd: 'C:\\probe', every: true });
    expect(h.processes.run).toHaveBeenCalledOnce();
    expect(h.processes.run).toHaveBeenCalledWith(exe, ['fixture.mjs', '--version'], { cwd: 'C:\\probe', signal: probe, timeoutMs: 5000, stdoutLimit: 16 * 1024 });
    expect(h.processes.spawn).not.toHaveBeenCalled(); // no control session
  });

  it('keeps the newest of the CLIs found, whatever their order, and passes over one whose check fails', async () => {
    const h = setup();
    const older = { path: 'C:\\Users\\me\\.local\\bin\\claude.exe', kind: 'native' } as const;
    const broken = { path: 'C:\\npm\\claude.cmd', kind: 'cmd-shim' } as const;
    const desktop = { path: 'C:\\Local\\Claude-Data\\claude_pzs8sxrjxfjjc\\claude-code\\2.1.317\\a33aa5518497\\claude.exe', kind: 'native' } as const;
    vi.mocked(h.processes.resolve).mockResolvedValue({ status: 'found', executable: older, source: 'path', others: [{ executable: broken, source: 'known-dir' }, { executable: desktop, source: 'known-dir' }] });
    vi.mocked(h.processes.run).mockImplementation(async (file) => (file === broken
      ? { code: 1, signal: null, stdout: '' }
      : { code: 0, signal: null, stdout: file === desktop ? '2.1.317 (Claude Code)\n' : '2.1.309 (Claude Code)\n' }));
    expect(await createClaudeProvider(h.context).detect({ override: null, knownDirs: [] }, signal()))
      .toEqual({ kind: 'found', installation: { source: 'known-dir', version: '2.1.317' }, executable: desktop });
    expect(h.processes.run).toHaveBeenCalledTimes(3);
  });

  it('refuses an invalid override without probing or falling back', async () => {
    const h = setup();
    vi.mocked(h.processes.resolve).mockResolvedValue({ status: 'not-found', reason: 'invalid-override', overrideInvalid: true });
    expect(await createClaudeProvider(h.context).detect({ override: 'C:\\missing.exe', knownDirs: ['C:\\works'] }, signal()))
      .toEqual({ kind: 'not-installed', overrideInvalid: true });
    expect(h.processes.run).not.toHaveBeenCalled();
  });

  it('reports a missing install, a launch failure and a probe failure distinctly', async () => {
    const missing = setup();
    vi.mocked(missing.processes.resolve).mockResolvedValue({ status: 'not-found', reason: 'missing', overrideInvalid: false });
    expect(await createClaudeProvider(missing.context).detect({ override: null, knownDirs: [] }, signal())).toEqual({ kind: 'not-installed', overrideInvalid: false });
    const launch = setup();
    vi.mocked(launch.processes.run).mockRejectedValue(new ProcessFailure('spawn-failed'));
    expect(await createClaudeProvider(launch.context).detect({ override: null, knownDirs: [] }, signal())).toEqual({ kind: 'error', reason: 'launch-failed' });
    for (const failure of [new ProcessFailure('timeout'), new ProcessFailure('aborted'), new ProcessFailure('output-limit')]) {
      const probe = setup();
      vi.mocked(probe.processes.run).mockRejectedValue(failure);
      expect(await createClaudeProvider(probe.context).detect({ override: null, knownDirs: [] }, signal())).toEqual({ kind: 'error', reason: 'probe-failed' });
    }
    const nonzero = setup();
    vi.mocked(nonzero.processes.run).mockResolvedValue({ code: 1, signal: null, stdout: '' });
    expect(await createClaudeProvider(nonzero.context).detect({ override: null, knownDirs: [] }, signal())).toEqual({ kind: 'error', reason: 'probe-failed' });
  });

  it.each([
    ['2.1.211 (Claude Code)\n', '2.1.211'],
    ['2.1.268\r\n', '2.1.268'],
    ['2.1.268-fixture.1 (Claude Code)', '2.1.268-fixture.1'],
    ['Claude Code 2.1.268', null],
    [`C:\\Users\\private\\claude.exe 2.1.268`, null],
    [`2.1.268 (${'x'.repeat(600)})`, null],
    ['v24.19.0', null],
    ['', null],
  ])('reads only a bounded version token from %j', (stdout, expected) => {
    expect(parseVersion(stdout)).toBe(expected);
  });
});

describe('Claude account gate', () => {
  it('asks the resolved CLI for auth status with the reviewed bounds, from the neutral directory', async () => {
    const h = setup();
    const provider = createClaudeProvider(h.context);
    await provider.detect({ override: null, knownDirs: [] }, signal());
    vi.mocked(h.processes.run).mockResolvedValue({ code: 0, signal: null, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) });
    const read = signal();
    expect(await provider.getAccount(read)).toEqual({ kind: 'account', account: { authKind: 'subscription', plan: 'max' } });
    expect(h.processes.run).toHaveBeenLastCalledWith(exe, ['auth', 'status'], expect.objectContaining({ cwd: 'C:\\probe', timeoutMs: 10_000, stdoutLimit: 64 * 1024 }));
    expect(h.processes.spawn).not.toHaveBeenCalled(); // no control session
  });

  it.each(['output-limit', 'timeout', 'aborted', 'spawn-failed'] as const)('treats an auth status %s as transient, never as a logout', async (code) => {
    const h = setup();
    const provider = createClaudeProvider(h.context);
    await provider.detect({ override: null, knownDirs: [] }, signal());
    vi.mocked(h.processes.run).mockRejectedValue(new ProcessFailure(code));
    expect(await provider.getAccount(signal())).toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
  });

  it('launches nothing before detection or after disposal', async () => {
    const h = setup();
    const provider = createClaudeProvider(h.context);
    expect(await provider.getAccount(signal())).toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
    expect(await provider.getUsage(signal())).toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
    await provider.detect({ override: null, knownDirs: [] }, signal());
    await provider.dispose();
    vi.mocked(h.processes.run).mockClear();
    expect(await provider.getAccount(signal())).toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
    expect(h.processes.run).not.toHaveBeenCalled();
    expect(await provider.detect({ override: null, knownDirs: [] }, signal())).toEqual({ kind: 'error', reason: 'launch-failed' });
  });

  it('latches on a scope cleanup refusal and propagates it from disposal', async () => {
    const h = setup();
    const provider = createClaudeProvider(h.context);
    await provider.detect({ override: null, knownDirs: [] }, signal());
    vi.mocked(h.processes.run).mockRejectedValue(new ProcessFailure('cleanup-failed'));
    expect(await provider.getAccount(signal())).toEqual({ kind: 'error', reason: 'cleanup-failed' });
    vi.mocked(h.processes.run).mockClear();
    expect(await provider.getAccount(signal())).toEqual({ kind: 'error', reason: 'cleanup-failed' });
    expect(await provider.getUsage(signal())).toEqual({ kind: 'error', reason: 'cleanup-failed' });
    expect(h.processes.run).not.toHaveBeenCalled();
    await expect(provider.dispose()).rejects.toMatchObject({ code: 'cleanup-failed' });
  });
});

// V6, V23 (M13, C26–C28, C69): each usage session reports the models of its `initialize` reply.
describe('Claude model reports', () => {
  const MODELS = JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/models.json'), 'utf8')) as Record<string, unknown>;
  const SUBSCRIBER = { apiProvider: 'firstParty' };

  function reading(account: unknown, initialize: Record<string, unknown> = MODELS, usage: unknown = { rate_limits_available: true, rate_limits: null }) {
    const h = setup();
    const child = scriptedChild({
      onFrame(frame, scripted) {
        if (frame.request?.['subtype'] === 'initialize') scripted.reply(frame, { ...initialize, commands: [{ name: 'private-command' }], account });
        else scripted.reply(frame, usage);
      },
    });
    vi.mocked(h.processes.spawn).mockImplementation(async () => child.child);
    const provider = createClaudeProvider(h.context);
    const events: ProviderEvent[] = [];
    provider.subscribe?.((event) => events.push(event));
    return { h, child, provider, events };
  }

  it('sends one report after a read, with the four models its five rows name and nothing else of the reply', async () => {
    const r = reading(SUBSCRIBER);
    await r.provider.detect({ override: null, knownDirs: [] }, signal());
    const usage = await r.provider.getUsage(signal());
    expect(usage.kind).toBe('not-applicable'); // rate limits not available: the usage result is as before
    expect(r.events).toHaveLength(1);
    const [event] = r.events;
    if (event?.type !== 'models') throw new Error('no report');
    expect(event.report.models.map((model) => model.key)).toEqual(['claude-opus-5[1m]', 'claude-fable-5-1[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(event.report.speedTierReason).toBe('sdk_opt_in_required');
    expect(JSON.stringify(r.events)).not.toMatch(/private-command|firstParty|account/);
    expect(r.child.frames.map((frame) => frame.request?.['subtype'])).toEqual(['initialize', 'get_usage']);
  });

  it('sends nothing for a reply without models, and the usage result is the same', async () => {
    const withModels = reading(SUBSCRIBER);
    await withModels.provider.detect({ override: null, knownDirs: [] }, signal());
    const without = reading(SUBSCRIBER, {});
    await without.provider.detect({ override: null, knownDirs: [] }, signal());
    expect(await without.provider.getUsage(signal())).toEqual(await withModels.provider.getUsage(signal()));
    expect(without.events).toEqual([]);
  });

  it('sends the models a usage session reveals for an API key or a cloud provider too: they are that account’s (C90)', async () => {
    const r = reading({ apiProvider: 'bedrock' });
    await r.provider.detect({ override: null, knownDirs: [] }, signal());
    expect(await r.provider.getUsage(signal())).toEqual({ kind: 'not-applicable', reason: 'cloud-provider' });
    expect(r.events.map((event) => event.type)).toEqual(['models']);
  });

  it('sends nothing when the session fails', async () => {
    const h = setup();
    vi.mocked(h.processes.spawn).mockRejectedValue(new ProcessFailure('spawn-failed'));
    const provider = createClaudeProvider(h.context);
    const events: ProviderEvent[] = [];
    provider.subscribe?.((event) => events.push(event));
    await provider.detect({ override: null, knownDirs: [] }, signal());
    expect((await provider.getUsage(signal())).kind).toBe('error');
    expect(events).toEqual([]);
  });

  it('stops reporting once disposed', async () => {
    const r = reading(SUBSCRIBER);
    await r.provider.detect({ override: null, knownDirs: [] }, signal());
    await r.provider.dispose();
    expect(r.provider.subscribe?.(() => undefined)).toBeTypeOf('function');
    await r.provider.reportModels?.(signal());
    expect(r.events).toEqual([]);
    expect(r.h.processes.spawn).not.toHaveBeenCalled();
  });
});

// V41 (M13, S10, C90): the models alone, for an account whose usage read runs no session.
describe('Claude’s models-only session', () => {
  const MODELS = JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/models.json'), 'utf8')) as Record<string, unknown>;

  /** A fresh scripted child per launch, and the order launches and stops happened in. */
  function launches(answer: (frame: Frame, child: ScriptedChild) => void = (frame, child) => child.reply(frame, { ...MODELS, account: { apiProvider: 'firstParty' } })) {
    const h = setup();
    const order: string[] = [];
    const children: ScriptedChild[] = [];
    vi.mocked(h.processes.spawn).mockImplementation(async () => {
      const child = scriptedChild({ onFrame: answer });
      children.push(child);
      order.push(`spawn ${children.length}`);
      const stop = child.child.stop.bind(child.child);
      child.child = { ...child.child, stop: async () => { order.push(`stop ${children.indexOf(child) + 1}`); return stop(); } };
      return child.child;
    });
    const provider = createClaudeProvider(h.context);
    const events: ProviderEvent[] = [];
    provider.subscribe?.((event) => events.push(event));
    return { h, provider, events, order, children };
  }

  it('sends only initialize, and sends the models it lists, for any account', async () => {
    const l = launches((frame, child) => child.reply(frame, { ...MODELS, account: { apiKeySource: 'ANTHROPIC_API_KEY' } }));
    await l.provider.detect({ override: null, knownDirs: [] }, signal());
    await l.provider.reportModels?.(signal());
    expect(l.children.flatMap((child) => child.frames.map((frame) => frame.request?.['subtype']))).toEqual(['initialize']);
    expect(l.events).toHaveLength(1);
    const [event] = l.events;
    expect(event?.type === 'models' ? event.report.models.map((model) => model.key) : []).toEqual(['claude-opus-5[1m]', 'claude-fable-5-1[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(JSON.stringify(l.events)).not.toMatch(/ANTHROPIC_API_KEY|apiKeySource/);
    expect(l.children[0]?.log).toEqual(['end', 'exit', 'stop']);
  });

  it('never overlaps a usage session: the second launch waits for the first to stop', async () => {
    const l = launches((frame, child) => child.reply(frame, frame.request?.['subtype'] === 'initialize' ? { ...MODELS, account: { apiProvider: 'firstParty' } } : { rate_limits_available: true, rate_limits: null }));
    await l.provider.detect({ override: null, knownDirs: [] }, signal());
    await Promise.all([l.provider.getUsage(signal()), l.provider.reportModels?.(signal())]);
    expect(l.order).toEqual(['spawn 1', 'stop 1', 'spawn 2', 'stop 2']);
  });

  it('sends nothing when it fails, and changes nothing', async () => {
    const h = setup();
    vi.mocked(h.processes.spawn).mockRejectedValue(new ProcessFailure('spawn-failed'));
    const provider = createClaudeProvider(h.context);
    const events: ProviderEvent[] = [];
    provider.subscribe?.((event) => events.push(event));
    await provider.detect({ override: null, knownDirs: [] }, signal());
    await expect(provider.reportModels?.(signal())).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });

  it('latches the provider when its child cannot be confirmed gone, as a usage session would', async () => {
    const l = launches();
    await l.provider.detect({ override: null, knownDirs: [] }, signal());
    vi.mocked(l.h.processes.spawn).mockImplementationOnce(async () => {
      const child = scriptedChild({ onFrame: (frame, scripted) => scripted.reply(frame, { ...MODELS, account: {} }) });
      child.setCleanup(false);
      return child.child;
    });
    await l.provider.reportModels?.(signal());
    expect(await l.provider.getUsage(signal())).toEqual({ kind: 'error', reason: 'cleanup-failed' });
    await expect(l.provider.dispose()).rejects.toMatchObject({ code: 'cleanup-failed' });
  });

  it('launches nothing before detection', async () => {
    const l = launches();
    await l.provider.reportModels?.(signal());
    expect(l.h.processes.spawn).not.toHaveBeenCalled();
  });
});
