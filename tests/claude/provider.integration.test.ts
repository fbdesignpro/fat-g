// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The production Claude adapter end to end: real process layer, fat-g's own control client and the
// deterministic CLI fixture. No installed CLI, account or credential is involved.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as TreeKill from '../../src/main/process/tree-kill';
import type { UsageReadEnd } from '../../src/main/services/usage-service';
import type { ProviderEvent } from '@shared/provider-kit/provider';
import { sampleProvider } from '../support/app-state';
import { afterEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ failCleanup: false }));
vi.mock('../../src/main/process/tree-kill', async (importOriginal) => {
  const actual = await importOriginal<typeof TreeKill>();
  return { ...actual, terminateTree: (...args: Parameters<typeof actual.terminateTree>) => (control.failCleanup ? Promise.resolve({ ok: false }) : actual.terminateTree(...args)) };
});
const { createProcessServices } = await import('../../src/main/process');
const { pidAlive } = await import('../../src/main/process/tree-kill');
const { createClaudeDefinition } = await import('../../src/main/providers/claude');
const { CLAUDE_CHILD_ENVIRONMENT } = await import('../../src/main/providers/claude/environment');
const { createAppStateStore } = await import('../../src/main/state/app-state-store');
const { createCatalogService } = await import('../../src/main/services/catalog-service');
const { createUsageService } = await import('../../src/main/services/usage-service');

const fixture = path.resolve('tests/fixtures/fake-claude-cli.mjs');
const constants = JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/fake-cli-constants.json'), 'utf8')) as { sentinel: string; version: string; email: string; organization: string };
// A throwaway config directory, so nothing here could ever touch a real one.
process.env['CLAUDE_CONFIG_DIR'] = path.join(os.tmpdir(), `fatg-claude-config-${process.pid}`);

/** What a parent Claude session exports, plus settings that must survive. */
const INHERITED = {
  CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.278', CLAUDE_CODE_SESSION_ID: 'parent-session',
  CLAUDE_CODE_MESSAGING_TOKEN: constants.sentinel, CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
  // A backend the review keeps by name, and two names a prefix once kept with it (M16, C81): a
  // backend the review has not read, and a switch for a tool.
  CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_FIXTURE_BACKEND: '0', CLAUDE_CODE_USE_POWERSHELL_TOOL: '1', HTTPS_PROXY: 'http://proxy.invalid:9',
};
const REMOVED = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_USE_FIXTURE_BACKEND', 'CLAUDE_CODE_USE_POWERSHELL_TOOL'];
/** The Agent SDK's identity: never on any child, even when a parent session exports it (decision 0006). */
const SDK_MARKERS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION'];
const reviewed = (name: string) => (CLAUDE_CHILD_ENVIRONMENT.keepNames ?? []).includes(name);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  control.failCleanup = false;
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(settings: { usageShape?: string; authState?: string } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fatg-claude-'));
  const fixtureDir = path.join(dir, 'fixture');
  await mkdir(fixtureDir);
  if (settings.usageShape) await writeFile(path.join(fixtureDir, 'usage-shape'), settings.usageShape);
  if (settings.authState) await writeFile(path.join(fixtureDir, 'auth-state'), settings.authState);
  const saved = Object.fromEntries(Object.keys(INHERITED).map((key) => [key, process.env[key]]));
  Object.assign(process.env, INHERITED);
  const services = createProcessServices(path.join(dir, 'user-data'));
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const definition = createClaudeDefinition({
    argsPrefix: [fixture, '--fixture-dir', fixtureDir], executableNames: [path.basename(process.execPath)],
    startupTimeoutMs: 1500, usageTimeoutMs: 1500,
  });
  const context = services.createContext(definition.environment);
  const provider = definition.factory(context);
  const pids = async () => (await readFile(path.join(fixtureDir, 'pids'), 'utf8').catch(() => '')).trim().split(/\r?\n/).filter(Boolean)
    .map((line) => { const [pid, role] = line.split(' '); return { pid: Number(pid), role: role! }; });
  cleanups.push(async () => {
    control.failCleanup = false;
    for (const { pid } of await pids()) { try { process.kill(pid); } catch { /* gone */ } }
    await provider.dispose().catch(() => {});
    await services.killAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const detection = await provider.detect({ override: process.execPath, knownDirs: [] }, new AbortController().signal);
  return {
    fixtureDir, services, context, provider, detection, pids,
    control: (values: Record<string, number>) => writeFile(path.join(fixtureDir, 'control.json'), JSON.stringify(values)),
    exists: async (name: string) => (await readdir(fixtureDir)).some((entry) => entry.startsWith(name)),
    envs: async (role: string) => Promise.all((await readdir(fixtureDir)).filter((entry) => entry.startsWith(`env-${role}-`))
      .map(async (entry) => JSON.parse(await readFile(path.join(fixtureDir, entry), 'utf8')) as { names: string[]; values: Record<string, string> })),
  };
}

const signal = () => new AbortController().signal;
const allDead = async (pids: () => Promise<{ pid: number }[]>) => (await pids()).every(({ pid }) => !pidAlive(pid));

describe('Claude adapter through the control client and fixture', () => {
  it('detects, validates the account and reads ordered, normalized meters with no private fields', async () => {
    const h = await harness();
    expect(h.detection).toEqual({ kind: 'found', installation: { source: 'override', version: constants.version }, executable: { path: process.execPath, kind: 'native' } });
    expect(await h.provider.getAccount(signal())).toEqual({
      kind: 'account', account: { authKind: 'subscription', plan: 'max', email: constants.email, organization: constants.organization },
    });
    const usage = await h.provider.getUsage(signal());
    expect(usage.kind).toBe('usage');
    const windows = usage.kind === 'usage' ? usage.usage.windows : [];
    expect(windows.map((window) => window.id)).toEqual(['five-hour', 'weekly', 'weekly-model:fable']);
    expect(windows[1]).toMatchObject({ kind: 'weekly', usedPercent: 81, severity: 'warning', isBinding: true });
    expect(windows[2]).toMatchObject({ kind: 'weekly-model', scope: 'Fable', label: 'Weekly', isBinding: false });
    expect(JSON.stringify(usage)).not.toContain(constants.sentinel);
    expect(await allDead(h.pids)).toBe(true);
    expect(await h.exists('prompts')).toBe(false); // idle: no prompt, no model turn

    for (const role of ['version', 'auth', 'session']) {
      const captured = await h.envs(role);
      expect(captured.length).toBeGreaterThan(0);
      for (const env of captured) {
        const claude = env.names.filter((name) => /^CLAUDE/i.test(name)).map((name) => name.toUpperCase());
        expect(claude.filter((name) => !reviewed(name)), role).toEqual([]);
        expect(claude).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK']));
        for (const name of [...REMOVED, ...SDK_MARKERS]) expect(claude, role).not.toContain(name);
        expect(env.values['HTTPS_PROXY']).toBe('http://proxy.invalid:9');
      }
    }
  }, 20_000);

  it('refuses a request the CLI makes of fat-g, and still completes the read', async () => {
    const h = await harness();
    await h.control({ cliRequest: 1 });
    expect(await h.provider.getUsage(signal())).toMatchObject({ kind: 'usage' });
    expect(await h.exists('cli-request-refused-')).toBe(true);
    expect(await h.exists('cli-request-accepted')).toBe(false);
  }, 20_000);

  it('launches every session with exactly the reference arguments and without the SDK identity', async () => {
    const h = await harness();
    for (let read = 0; read < 2; read += 1) expect(await h.provider.getUsage(signal())).toMatchObject({ kind: 'usage' });
    expect((await h.pids()).filter(({ role }) => role === 'session')).toHaveLength(2);
    expect(await h.exists('unexpected-args')).toBe(false);
    expect(await h.exists('sdk-markers')).toBe(false);
  }, 20_000);

  it('maps the CLI rejection of get_usage to an account-only outcome C', async () => {
    const h = await harness();
    await h.control({ unsupportedUsage: 1 });
    expect(await h.provider.getUsage(signal())).toEqual({ kind: 'not-applicable', reason: 'unsupported-cli-version' });
    expect(await h.provider.getUsage(signal())).toMatchObject({ kind: 'usage' });
  }, 20_000);

  it.each([
    ['unavailable', { kind: 'not-applicable', reason: 'usage-unavailable' }],
    ['empty-limits', { kind: 'usage', usage: { windows: [] } }],
  ] as const)('maps the %s usage shape', async (usageShape, expected) => {
    const h = await harness({ usageShape });
    expect(await h.provider.getUsage(signal())).toEqual(expected);
  }, 20_000);

  it('reads the named-window fallback when limits[] is absent', async () => {
    const h = await harness({ usageShape: 'named' });
    const usage = await h.provider.getUsage(signal());
    expect(usage.kind === 'usage' ? usage.usage.windows.map((window) => window.id) : []).toEqual(['five-hour', 'weekly', 'weekly-model:fable']);
  }, 20_000);

  it.each([
    ['logged-out', { kind: 'not-logged-in' }],
    ['api-key', { kind: 'not-applicable', reason: 'api-key' }],
    ['cloud', { kind: 'not-applicable', reason: 'cloud-provider' }],
    ['malformed', { kind: 'error', reason: 'unsupported-data' }],
    ['crash', { kind: 'error', reason: 'temporarily-unavailable' }],
  ] as const)('classifies %s authentication without opening a session', async (authState, expected) => {
    const h = await harness({ authState });
    expect(await h.provider.getAccount(signal())).toEqual(expected);
    expect((await h.pids()).some(({ role }) => role.startsWith('session'))).toBe(false);
  }, 20_000);

  it('a withheld initialization hits the startup deadline without a usage request; the next read recovers', async () => {
    const h = await harness();
    await h.control({ withholdInit: 1 });
    const started = Date.now();
    expect(await h.provider.getUsage(signal())).toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(await h.exists('withheld-')).toBe(true);
    expect(await h.exists('hung-')).toBe(false);
    expect(await allDead(h.pids)).toBe(true);
    expect(await h.provider.getUsage(signal())).toMatchObject({ kind: 'usage' });
  }, 20_000);

  it('a hung usage request hits the usage deadline; its tree is gone before the next read', async () => {
    const h = await harness();
    await h.control({ hangUsage: 1 });
    expect(await h.provider.getUsage(signal())).toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
    expect(await h.exists('hung-')).toBe(true);
    expect(await allDead(h.pids)).toBe(true);
    expect(await h.provider.getUsage(signal())).toMatchObject({ kind: 'usage' });
    expect(await h.exists('overlaps')).toBe(false);
  }, 20_000);

  it('a child that ignores EOF is tree-killed after the close grace, descendant included', async () => {
    const h = await harness();
    await h.control({ hangUsage: 1, stuck: 1 });
    expect(await h.provider.getUsage(signal())).toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
    const recorded = await h.pids();
    expect(recorded.some(({ role }) => role === 'descendant')).toBe(true);
    expect(await allDead(h.pids)).toBe(true);
  }, 20_000);

  it('never overlaps two sessions, however refreshes and aborts interleave', async () => {
    const h = await harness();
    const first = new AbortController();
    const reads = [h.provider.getUsage(first.signal), h.provider.getUsage(signal()), h.provider.getAccount(signal()), h.provider.getUsage(signal())];
    first.abort();
    const results = await Promise.all(reads);
    expect(results.at(-1)).toMatchObject({ kind: 'usage' });
    expect(await h.exists('overlaps')).toBe(false);
    expect(await allDead(h.pids)).toBe(true);
  }, 30_000);

  // M14b, V15 (C7, C54): the first account in the folder the environment names, and an added one in
  // a scope of its own, through the production adapter and the real process layer.
  it('two accounts each run a session at once, each for itself, and no overlap is recorded', async () => {
    const h = await harness();
    const own = process.env['CLAUDE_CONFIG_DIR'] ?? '';
    const added = path.join(path.dirname(h.fixtureDir), 'second account'); // a name only: never made
    await writeFile(path.join(h.fixtureDir, 'accounts.json'), JSON.stringify({
      [own]: { email: 'first@example.test', usage: { session: 11 } },
      [added]: { email: 'second@example.test', organization: 'Second Org', plan: 'pro', usage: { session: 22 }, models: ['sonnet', 'haiku'] },
    }));
    const definition = createClaudeDefinition({
      argsPrefix: [fixture, '--fixture-dir', h.fixtureDir], executableNames: [path.basename(process.execPath)], startupTimeoutMs: 1500, usageTimeoutMs: 1500,
    });
    const support = definition.instances;
    if (support === undefined) throw new Error('Claude declares no instances');
    const second = definition.factory(h.services.createContext(definition.environment, { variable: support.variable, folder: added, withhold: support.withhold }));
    const reports: string[][] = [];
    second.subscribe?.((event: ProviderEvent) => { if (event.type === 'models') reports.push(event.report.models.map((model) => model.key)); });
    expect((await second.detect({ override: process.execPath, knownDirs: [] }, signal())).kind).toBe('found');

    // Each account is its own folder's.
    const [firstAccount, secondAccount] = await Promise.all([h.provider.getAccount(signal()), second.getAccount(signal())]);
    expect(firstAccount).toMatchObject({ kind: 'account', account: { email: 'first@example.test', plan: 'max' } });
    expect(secondAccount).toEqual({ kind: 'account', account: { authKind: 'subscription', plan: 'pro', email: 'second@example.test', organization: 'Second Org' } });

    // Two sessions held open together: at least one waits out the usage deadline while the other starts.
    await h.control({ hangUsage: 2 });
    await Promise.all([h.provider.getUsage(signal()), second.getUsage(signal())]);
    expect(await h.exists('overlaps')).toBe(false);
    const sessions = (await readFile(path.join(h.fixtureDir, 'pids'), 'utf8')).trim().split(/\r?\n/).map((line) => line.split(' ')).filter(([, role]) => role?.startsWith('session'));
    expect(sessions.some(([, role]) => role === 'session-hung')).toBe(true);
    const starts = sessions.map(([, , started]) => Number(started));
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(1500);

    // And then each reads its own usage and lists its own models.
    await writeFile(path.join(h.fixtureDir, 'control.json'), '{}');
    const [firstUsage, secondUsage] = await Promise.all([h.provider.getUsage(signal()), second.getUsage(signal())]);
    expect(firstUsage.kind === 'usage' ? firstUsage.usage.windows[0]?.usedPercent : null).toBe(11);
    expect(secondUsage.kind === 'usage' ? secondUsage.usage.windows[0]?.usedPercent : null).toBe(22);
    // Its two rows, each by the exact version it names (decision 0016).
    expect(reports.at(-1)).toEqual(['claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(await h.exists('overlaps')).toBe(false);

    // The added account's children were given its folder; the first's kept the inherited one.
    const folders = new Set((await h.envs('session')).map((env) => env.values['CLAUDE_CONFIG_DIR']));
    expect([...folders].sort()).toEqual([own, added].sort());
    // Nobody made the folder: fat-g hands the path on, and the fake uses it as a key.
    await expect(readdir(added)).rejects.toMatchObject({ code: 'ENOENT' });
    await second.dispose();
    expect(await allDead(h.pids)).toBe(true);
  }, 30_000);

  it('disposal closes a hung session and confirms its tree', async () => {
    const h = await harness();
    await h.control({ hangUsage: 1 });
    const reading = h.provider.getUsage(signal());
    await vi.waitFor(async () => expect(await h.exists('hung-')).toBe(true), { timeout: 5000 });
    await expect(h.provider.dispose()).resolves.toBeUndefined();
    expect(await reading).toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
    expect(await allDead(h.pids)).toBe(true);
  }, 20_000);

  it('an unconfirmed cleanup latches the provider and scope until the recorded tree is gone', async () => {
    const h = await harness();
    await h.control({ hangUsage: 1, stuck: 1 });
    control.failCleanup = true;
    expect(await h.provider.getUsage(signal())).toEqual({ kind: 'error', reason: 'cleanup-failed' });
    // Retries launch nothing: no auth status, no session.
    const before = (await h.pids()).length;
    expect(await h.provider.getAccount(signal())).toEqual({ kind: 'error', reason: 'cleanup-failed' });
    expect(await h.provider.getUsage(signal())).toEqual({ kind: 'error', reason: 'cleanup-failed' });
    expect((await h.pids()).length).toBe(before);
    await expect(h.provider.dispose()).rejects.toMatchObject({ code: 'cleanup-failed' });
    expect(await h.context.processes.dispose()).toEqual({ ok: false });
    expect(await h.context.processes.recheck()).toEqual({ ok: false });

    control.failCleanup = false;
    for (const { pid } of await h.pids()) { try { process.kill(pid); } catch { /* gone */ } }
    await vi.waitFor(async () => expect(await h.context.processes.recheck()).toEqual({ ok: true }), { timeout: 5000 });
    expect(await h.context.processes.dispose()).toEqual({ ok: true });
  }, 30_000);
});

// V37, V41 (M13; S10, S11, C27, C90–C92): the catalog gets Claude's models from the reads the usage
// service makes — a subscription's usage session — or, for an account that runs no usage session,
// from one models-only session that sends only `initialize`.
describe('Claude models, through the usage and catalog services', () => {
  async function wired(authState?: string) {
    const h = await harness(authState === undefined ? {} : { authState });
    const store = createAppStateStore();
    store.updateProviders(() => [sampleProvider({ id: 'claude', status: { kind: 'detecting' }, account: null, usage: null, asOf: null })]);
    const catalog = createCatalogService({ definitions: [createClaudeDefinition()], store, dir: h.fixtureDir, log: { info: () => undefined, warn: () => undefined } });
    const ends: UsageReadEnd[] = [];
    const usage = createUsageService({ store, pollIntervalSec: () => 3600, onReadEnd: (id, end) => { ends.push(end); catalog.readEnded(id, end); } });
    const events: ProviderEvent[] = [];
    h.provider.subscribe?.((event) => events.push(event));
    const attachment = { id: 'claude', generation: 1, provider: h.provider };
    catalog.attach(attachment);
    usage.attach({ ...attachment, descriptor: h.provider.descriptor, installation: { source: 'override', version: constants.version } });
    cleanups.unshift(() => { usage.stop(); catalog.stop(); return Promise.resolve(); });
    await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 10_000 });
    const entry = () => store.getSnapshot().catalog?.providers[0];
    return { h, ends, events, entry };
  }

  it('lists the models a subscription’s read reports, and that fat-g can ask for fast mode, with the CLI’s own reason kept (decision 0013)', async () => {
    const w = await wired();
    expect(w.ends).toMatchObject([{ byRefresh: false, outcome: 'account' }]);
    expect(w.entry()?.source.kind).toBe('report');
    expect(w.entry()?.models.map((model) => model.key)).toEqual(['claude-opus-5[1m]', 'claude-fable-5-1[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(w.entry()?.speedTierRequest).toEqual({ possible: true, reason: 'sdk_opt_in_required' });
    // The read reported by itself: no models-only session follows it (C92).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await w.h.pids()).filter(({ role }) => role === 'session')).toHaveLength(1);
  }, 20_000);

  it.each([['api-key', 'api-key'], ['cloud', 'cloud-provider'], ['logged-out', 'signed-out']] as const)('lists the models of one models-only session for %s, with no usage request (C90)', async (authState, outcome) => {
    const w = await wired(authState);
    expect(w.ends).toMatchObject([{ byRefresh: false, outcome }]);
    await vi.waitFor(() => expect(w.entry()?.source.kind).toBe('report'), { timeout: 10_000 });
    // Five rows, `default` and `opus[1m]` naming one version.
    expect(w.entry()?.models).toHaveLength(4);
    expect((await w.h.pids()).filter(({ role }) => role.startsWith('session'))).toHaveLength(1);
    expect(await w.h.exists('unexpected-args')).toBe(false);
    expect(await w.h.exists('prompts')).toBe(false);
    expect(await allDead(w.h.pids)).toBe(true);
  }, 20_000);
});
