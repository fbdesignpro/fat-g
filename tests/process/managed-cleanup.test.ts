// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Scope-level cleanup guarantees for managed children, against real local processes: a natural EOF
// close needs no forced kill, every trigger stops the whole tree, and a failed cleanup latches the
// scope until a read-only recheck proves the recorded tree gone. (Until M7b these ran through the
// Agent SDK's external spawner; the guarantees belong to the scope, whoever launches the child.)
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as ChildProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TreeKill from '../../src/main/process/tree-kill';
import { NdjsonDecoder } from '../../src/shared/provider-kit/ndjson';
import type { ManagedProcess } from '../../src/shared/provider-kit/process';
import { CONTROL_ARGS } from '../../src/main/providers/claude/session';

// Records every launch (to prove a natural close needs no taskkill) and lets a test make tree
// cleanup fail on purpose. Each test still kills its fixtures independently at the end.
const control = vi.hoisted(() => ({ failCleanup: false, launched: [] as string[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  const spawn = (...args: unknown[]) => {
    control.launched.push(String(args[0]));
    return (actual.spawn as (...values: unknown[]) => unknown)(...args);
  };
  return { ...actual, spawn };
});
vi.mock('../../src/main/process/tree-kill', async (importOriginal) => {
  const actual = await importOriginal<typeof TreeKill>();
  return { ...actual, terminateTree: (...args: Parameters<typeof actual.terminateTree>) => (control.failCleanup ? Promise.resolve({ ok: false }) : actual.terminateTree(...args)) };
});
const { createProcessServices } = await import('../../src/main/process');
const { pidAlive } = await import('../../src/main/process/tree-kill');

const fixture = path.resolve('tests/fixtures/fake-app-server.mjs');
const node = { path: process.execPath, kind: 'native' } as const;
type Services = ReturnType<typeof createProcessServices>;

const survivors = new Set<number>();
afterEach(() => {
  control.failCleanup = false;
  control.launched.length = 0;
  for (const pid of survivors) { try { process.kill(pid); } catch { /* already gone */ } }
  survivors.clear();
});

async function withServices(work: (services: Services, dir: string) => Promise<void>, inherited: Record<string, string> = {}, options: Parameters<typeof createProcessServices>[1] = {}): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fatg-managed-'));
  const saved = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  let services: Services;
  try { services = createProcessServices(dir, options); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  try { await work(services, dir); } finally {
    control.failCleanup = false;
    for (const pid of survivors) { try { process.kill(pid); } catch { /* already gone */ } }
    await services.killAll();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The child's first JSON line. Takes its only output subscription. */
function firstLine<T>(child: ManagedProcess): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const decoder = new NdjsonDecoder((value) => { if (!done) { done = true; resolve(value as T); } });
    child.consume((event) => {
      if (event.type === 'stdout') decoder.push(event.data);
      else if ((event.type === 'eof' || event.type === 'close') && !done) { done = true; reject(new Error('closed before a line')); }
    });
  });
}

/** The pid a fixture wrote to its ledger as it started. */
async function recordedPid(file: string): Promise<number> {
  return vi.waitFor(async () => {
    const pid = Number((await readFile(file, 'utf8')).split(' ')[0]);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('no pid yet');
    return pid;
  }, { timeout: 5000 });
}

const taskkills = () => control.launched.filter((file) => /taskkill\.exe$/i.test(file)).length;

describe('managed child cleanup', () => {
  it("inherits the scope's constrained environment, and EOF closes it naturally without taskkill", () => withServices(async (services, dir) => {
    const ctx = services.createContext({ removePrefixes: ['FATG_TEST_'], keepNames: ['FATG_TEST_CONFIG'], removeNames: ['FATG_DEBUG'] });
    const child = await ctx.processes.spawn(node, [fixture, 'env', '--safe-flag'], { cwd: dir });
    const report = await firstLine<{ cwd: string; args: string[]; env: Record<string, string> }>(child);
    const env = Object.fromEntries(Object.entries(report.env).map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value]));

    expect(report.args).toEqual(['--safe-flag']);
    // Real paths: macOS's temporary directory is reached through a symlink.
    expect(realpathSync(report.cwd).toLowerCase()).toBe(realpathSync(dir).toLowerCase());
    expect(env['FATG_TEST_CONFIG']).toBe('inherited-config');
    expect(env['HTTPS_PROXY']).toBe('http://proxy.invalid:9');
    for (const absent of ['FATG_TEST_SESSION_TOKEN', 'FATG_DEBUG', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) expect(env).not.toHaveProperty(absent);

    child.end();
    await child.closed;
    expect(await child.stop()).toEqual({ ok: true });
    expect(taskkills()).toBe(0); // EOF closed it naturally; no forced cleanup
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
  }, {
    FATG_TEST_CONFIG: 'inherited-config', FATG_TEST_SESSION_TOKEN: 'private-session', fatg_debug: '1',
    HTTPS_PROXY: 'http://proxy.invalid:9', NODE_OPTIONS: '--no-warnings', ELECTRON_RUN_AS_NODE: '1',
  }));

  // M14b, V3 (C8, C9, C64): what a real child of each kind of scope is handed.
  it('an added instance’s child gets the variable set to its folder and none of the withheld; the first instance’s inherits; no override sets the variable', () => withServices(async (services, dir) => {
    type Report = { env: Record<string, string> };
    const fold = (env: Record<string, string>) => Object.fromEntries(Object.entries(env).map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value]));
    const constraints = { removePrefixes: ['FATG_TEST_'], keepNames: ['FATG_TEST_HOME', 'FATG_TEST_TOKEN'], keepPrefixes: ['FATG_TEST_BACKEND_'] };
    const withhold = { names: ['FATG_TEST_TOKEN'], prefixes: ['FATG_TEST_BACKEND_'] };
    const folder = path.join(dir, 'second account');
    const report = async (ctx: ReturnType<Services['createContext']>, env?: Record<string, string>): Promise<Record<string, string>> => {
      const child = await ctx.processes.spawn(node, [fixture, 'env'], { cwd: dir, ...(env === undefined ? {} : { env }) });
      const line = await firstLine<Report>(child);
      child.end();
      await child.closed;
      return fold(line.env);
    };

    // The first instance: exactly what the provider's children get.
    const first = services.createContext(constraints);
    const inherited = await report(first);
    expect(inherited).toMatchObject({ FATG_TEST_HOME: 'inherited-home', FATG_TEST_TOKEN: 'private-token', FATG_TEST_BACKEND_URL: 'https://gateway.invalid', HTTPS_PROXY: 'http://proxy.invalid:9' });
    expect(inherited).not.toHaveProperty('FATG_TEST_SESSION');

    // An added instance: the folder in place of the inherited value, the withheld ones gone, the rest as the first's.
    const added = services.createContext(constraints, { variable: 'FATG_TEST_HOME', folder, withhold });
    const scoped = await report(added);
    expect(scoped['FATG_TEST_HOME']).toBe(folder);
    for (const absent of ['FATG_TEST_TOKEN', 'FATG_TEST_BACKEND_URL', 'FATG_TEST_SESSION', 'NODE_OPTIONS']) expect(scoped).not.toHaveProperty(absent);
    expect(scoped['HTTPS_PROXY']).toBe('http://proxy.invalid:9');
    const without = (env: Record<string, string>, names: string[]) => Object.fromEntries(Object.entries(env).filter(([key]) => !names.includes(key)));
    expect(without(scoped, ['FATG_TEST_HOME'])).toEqual(without(inherited, ['FATG_TEST_HOME', 'FATG_TEST_TOKEN', 'FATG_TEST_BACKEND_URL']));

    // A per-run override sets the variable in neither scope, in any spelling; another variable it may set.
    const redirect = { FATG_TEST_HOME: path.join(dir, 'redirect'), fatg_test_home: path.join(dir, 'redirect'), FATG_EXTRA: 'set' };
    expect(await report(added, redirect)).toMatchObject({ FATG_TEST_HOME: folder, FATG_EXTRA: 'set' });
    const firstAgain = await report(first, { FATG_TEST_HOME: redirect.FATG_TEST_HOME, FATG_EXTRA: 'set' });
    expect(firstAgain).toMatchObject({ FATG_TEST_HOME: 'inherited-home', FATG_EXTRA: 'set' });

    // What Settings names for the added instance: names only.
    expect(services.startedWithout(constraints, withhold)).toEqual(['FATG_TEST_BACKEND_URL', 'FATG_TEST_TOKEN']);
    expect(services.startedWithout(constraints, { names: ['FATG_TEST_SESSION'], prefixes: [] })).toEqual([]);

    // Nothing was made of the folder: the process layer hands the path on and never looks at it.
    await expect(stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await first.processes.dispose()).toEqual({ ok: true });
    expect(await added.processes.dispose()).toEqual({ ok: true });
  }, {
    FATG_TEST_HOME: 'inherited-home', FATG_TEST_TOKEN: 'private-token', FATG_TEST_BACKEND_URL: 'https://gateway.invalid', FATG_TEST_SESSION: 'parent',
    HTTPS_PROXY: 'http://proxy.invalid:9', NODE_OPTIONS: '--no-warnings',
  }, { protectedVariables: ['FATG_TEST_HOME'] }));

  it('refuses an added instance’s scope whose folder is not absolute or whose variable is no name', () => withServices((services, dir) => {
    const withhold = { names: [], prefixes: [] };
    expect(() => services.createContext(undefined, { variable: 'FATG_TEST_HOME', folder: 'relative\\folder', withhold })).toThrow('spawn-failed');
    expect(() => services.createContext(undefined, { variable: 'FATG TEST=HOME', folder: dir, withhold })).toThrow('spawn-failed');
    expect(() => services.createContext(undefined, { variable: 'FATG_TEST_HOME', folder: `${dir}\0x`, withhold })).toThrow('spawn-failed');
    return Promise.resolve();
  }));

  it.each(['abort', 'stop', 'scope disposal', 'app kill'] as const)('%s stops the whole tree through one shared cleanup', (trigger) => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const abort = new AbortController();
    const child = await ctx.processes.spawn(node, [fixture, 'stuck-tree'], { cwd: dir, signal: abort.signal });
    const { pid, descendant } = await firstLine<{ pid: number; descendant: number }>(child);
    survivors.add(pid); survivors.add(descendant);

    if (trigger === 'abort') abort.abort();
    else if (trigger === 'scope disposal') expect(await ctx.processes.dispose()).toEqual({ ok: true });
    else if (trigger === 'app kill') expect(await services.killAll()).toEqual({ ok: true });
    else expect(await child.stop()).toEqual({ ok: true });
    // The trigger alone must reach the descendant: a root-only kill would leave it running, and a
    // later stop would find nothing left to enumerate.
    await vi.waitFor(() => {
      expect(pidAlive(pid)).toBe(false);
      expect(pidAlive(descendant)).toBe(false);
    }, { timeout: 5000 });
    expect(await child.stop()).toEqual({ ok: true });
  }));

  it('a failed cleanup latches the scope until a recorded-handle recheck proves the tree gone', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const child = await ctx.processes.spawn(node, [fixture, 'stuck'], { cwd: dir });
    const { pid } = await firstLine<{ pid: number }>(child);
    survivors.add(pid);

    control.failCleanup = true;
    expect(await child.stop()).toEqual({ ok: false });
    await expect(ctx.processes.spawn(node, [fixture, 'env'], { cwd: dir })).rejects.toMatchObject({ code: 'cleanup-failed' });
    await expect(ctx.processes.run(node, [fixture, 'nonzero'], { cwd: dir })).rejects.toMatchObject({ code: 'cleanup-failed' });
    // Still running: no timeout, retry or new lookup may clear the latch.
    expect(await ctx.processes.recheck()).toEqual({ ok: false });
    expect(pidAlive(pid)).toBe(true);

    process.kill(pid); // the recorded root exits late, outside fat-g's cleanup
    await vi.waitFor(async () => expect(await ctx.processes.recheck()).toEqual({ ok: true }), { timeout: 5000 });
    control.failCleanup = false;
    const next = await ctx.processes.spawn(node, [fixture, 'env'], { cwd: dir });
    next.end();
    await next.closed;
    expect(await next.stop()).toEqual({ ok: true });
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
  }));

  it('disposal reports an unconfirmed tree until the same scope is rechecked', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const child = await ctx.processes.spawn(node, [fixture, 'stuck'], { cwd: dir });
    const { pid } = await firstLine<{ pid: number }>(child);
    survivors.add(pid);
    control.failCleanup = true;
    expect(await ctx.processes.dispose()).toEqual({ ok: false });
    expect(await ctx.processes.dispose()).toEqual({ ok: false });
    process.kill(pid);
    await vi.waitFor(async () => expect(await ctx.processes.recheck()).toEqual({ ok: true }), { timeout: 5000 });
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
    await expect(ctx.processes.spawn(node, [fixture, 'env'], { cwd: dir })).rejects.toMatchObject({ code: 'disposed' });
  }));

  // M15 (C84, C116): a connection opened once, on real processes.
  it('a connection opened once is one process, never started again, with its tree confirmed gone when it ends', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const connection = await ctx.processes.open({ executable: node, args: [fixture, 'rpc'], options: { cwd: dir } });
    const { pid } = await connection.request('initialize') as { pid: number };
    expect(await connection.request('echo', { text: 'é' })).toEqual({ text: 'é' });
    // The process ends by itself, in the middle of a request.
    await expect(connection.request('crash')).rejects.toMatchObject({ code: 'transport-closed' });
    expect(await connection.done).toEqual({ ok: true });
    expect(pidAlive(pid)).toBe(false);
    await expect(connection.request('echo')).rejects.toMatchObject({ code: 'transport-closed' });
    expect(control.launched.filter((file) => file === process.execPath)).toHaveLength(1);
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
  }));

  it('closing an opened connection ends its tree, and so does disposing its scope', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const first = await ctx.processes.open({ executable: node, args: [fixture, 'rpc'], options: { cwd: dir } });
    const second = await ctx.processes.open({ executable: node, args: [fixture, 'rpc'], options: { cwd: dir } });
    const a = await first.request('initialize') as { pid: number };
    const b = await second.request('initialize') as { pid: number };
    expect(await first.close()).toEqual({ ok: true });
    expect(pidAlive(a.pid)).toBe(false);
    expect(pidAlive(b.pid)).toBe(true);
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
    expect(await second.done).toEqual({ ok: true });
    expect(pidAlive(b.pid)).toBe(false);
  }));

  it('an opened connection whose end cannot be confirmed holds itself alone: its scope launches on, and still counts it (C116)', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    // A process that ignores its closed input, so only a kill ends it.
    const connection = await ctx.processes.open({ executable: node, args: [fixture, 'stuck', path.join(dir, 'pids')], options: { cwd: dir } });
    const pid = await recordedPid(path.join(dir, 'pids'));
    survivors.add(pid);

    control.failCleanup = true;
    expect(await connection.close()).toEqual({ ok: false });
    expect(await connection.done).toEqual({ ok: false });
    control.failCleanup = false;
    // Nothing else of the scope is closed: a one-shot, a spawn and another opened connection all start.
    expect(await ctx.processes.run(node, [fixture, 'nonzero'], { cwd: dir })).toMatchObject({ code: 7 });
    const other = await ctx.processes.open({ executable: node, args: [fixture, 'rpc'], options: { cwd: dir } });
    expect(await other.request('echo', 1)).toBe(1);
    expect(await other.close()).toEqual({ ok: true });
    // Still running: the look is read-only, and the scope counts the tree.
    expect(await connection.recheck()).toEqual({ ok: false });
    expect(await ctx.processes.recheck()).toEqual({ ok: false });
    expect(pidAlive(pid)).toBe(true);

    process.kill(pid); // it ends late, outside fat-g's cleanup
    await vi.waitFor(async () => expect(await connection.recheck()).toEqual({ ok: true }), { timeout: 5000 });
    expect(await ctx.processes.recheck()).toEqual({ ok: true });
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
  }));

  it('a scope answers not clean at disposal while an opened connection’s tree is unconfirmed (C116)', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const connection = await ctx.processes.open({ executable: node, args: [fixture, 'stuck', path.join(dir, 'pids')], options: { cwd: dir } });
    const pid = await recordedPid(path.join(dir, 'pids'));
    survivors.add(pid);
    control.failCleanup = true;
    expect(await ctx.processes.dispose()).toEqual({ ok: false });
    control.failCleanup = false;
    process.kill(pid);
    await vi.waitFor(async () => expect(await ctx.processes.recheck()).toEqual({ ok: true }), { timeout: 5000 });
    // The connection's own end is the cleanup that was not confirmed; its recheck is what looks again.
    expect(await connection.done).toEqual({ ok: false });
    expect(await connection.recheck()).toEqual({ ok: true });
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
    await expect(ctx.processes.open({ executable: node, args: [fixture, 'rpc'], options: { cwd: dir } })).rejects.toMatchObject({ code: 'disposed' });
  }));

  // ── A process opened once (M16, V25; C16, C71): `open`'s ownership, with the child handed over raw ──
  it('a process opened once hands its output raw to its one consumer, past 4 MiB and with the process up (C16)', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const opened = await ctx.processes.openProcess(node, [fixture, 'stream'], { cwd: dir });
    let bytes = 0;
    const last = await new Promise<{ done: boolean; pid: number; bytes: number }>((resolve, reject) => {
      const decoder = new NdjsonDecoder((value) => { if ((value as { done?: boolean }).done === true) resolve(value as { done: boolean; pid: number; bytes: number }); });
      opened.process.consume((event) => {
        if (event.type === 'stdout') { bytes += event.data.byteLength; decoder.push(event.data); }
        else if (event.type === 'error') reject(new Error(event.code));
      });
    });
    // Every byte the process wrote arrived, and nothing ended it for writing them.
    expect(last.bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(bytes).toBeGreaterThan(last.bytes);
    expect(pidAlive(last.pid)).toBe(true);
    // It ends by itself when its input closes; the tree is then confirmed gone, with no kill.
    opened.process.end();
    expect(await opened.done).toEqual({ ok: true });
    expect(pidAlive(last.pid)).toBe(false);
    expect(control.launched.filter((file) => file === process.execPath)).toHaveLength(1);
    expect(control.launched.filter((file) => /taskkill/i.test(file))).toEqual([]);
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
  }));

  it('closing an opened process ends its tree, and so does disposing its scope', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const first = await ctx.processes.openProcess(node, [fixture, 'stuck-tree', path.join(dir, 'first')], { cwd: dir });
    const second = await ctx.processes.openProcess(node, [fixture, 'stuck-tree', path.join(dir, 'second')], { cwd: dir });
    const a = await firstLine<{ pid: number; descendant: number }>(first.process);
    const b = await firstLine<{ pid: number; descendant: number }>(second.process);
    for (const pid of [a.pid, a.descendant, b.pid, b.descendant]) survivors.add(pid);
    expect(await first.close()).toEqual({ ok: true });
    expect([a.pid, a.descendant].map(pidAlive)).toEqual([false, false]);
    expect(pidAlive(b.pid)).toBe(true);
    expect(await first.recheck()).toEqual({ ok: true });
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
    expect(await second.done).toEqual({ ok: true });
    expect([b.pid, b.descendant].map(pidAlive)).toEqual([false, false]);
  }));

  it('an opened process whose end cannot be confirmed holds itself alone: its scope launches on, and still counts it (C71)', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    // A process that ignores its closed input, so only a kill ends it.
    const opened = await ctx.processes.openProcess(node, [fixture, 'stuck', path.join(dir, 'pids')], { cwd: dir });
    const pid = await recordedPid(path.join(dir, 'pids'));
    survivors.add(pid);

    control.failCleanup = true;
    expect(await opened.close()).toEqual({ ok: false });
    expect(await opened.done).toEqual({ ok: false });
    control.failCleanup = false;
    // Nothing else of the scope is closed: a one-shot, a spawn, an opened connection and another opened process all start.
    expect(await ctx.processes.run(node, [fixture, 'nonzero'], { cwd: dir })).toMatchObject({ code: 7 });
    const spawned = await ctx.processes.spawn(node, [fixture, 'env'], { cwd: dir });
    expect((await firstLine<{ pid: number }>(spawned)).pid).toBeGreaterThan(0);
    expect(await spawned.stop()).toEqual({ ok: true });
    const connection = await ctx.processes.open({ executable: node, args: [fixture, 'rpc'], options: { cwd: dir } });
    expect(await connection.request('echo', 1)).toBe(1);
    expect(await connection.close()).toEqual({ ok: true });
    const other = await ctx.processes.openProcess(node, [fixture, 'env'], { cwd: dir });
    expect((await firstLine<{ pid: number }>(other.process)).pid).toBeGreaterThan(0);
    expect(await other.close()).toEqual({ ok: true });
    // Still running: the look is read-only, and the scope counts the tree.
    expect(await opened.recheck()).toEqual({ ok: false });
    expect(await ctx.processes.recheck()).toEqual({ ok: false });
    expect(pidAlive(pid)).toBe(true);

    process.kill(pid); // it ends late, outside fat-g's cleanup
    // Its own recheck is what releases it: the scope then counts nothing.
    await vi.waitFor(async () => expect(await opened.recheck()).toEqual({ ok: true }), { timeout: 5000 });
    expect(await ctx.processes.recheck()).toEqual({ ok: true });
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
  }), 20_000);

  it('a scope answers not clean at disposal while an opened process’s tree is unconfirmed (C71)', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const opened = await ctx.processes.openProcess(node, [fixture, 'stuck', path.join(dir, 'pids')], { cwd: dir });
    const pid = await recordedPid(path.join(dir, 'pids'));
    survivors.add(pid);
    control.failCleanup = true;
    expect(await ctx.processes.dispose()).toEqual({ ok: false });
    control.failCleanup = false;
    process.kill(pid);
    await vi.waitFor(async () => expect(await ctx.processes.recheck()).toEqual({ ok: true }), { timeout: 5000 });
    // The process's own end is the cleanup that was not confirmed; its recheck is what looks again.
    expect(await opened.done).toEqual({ ok: false });
    expect(await opened.recheck()).toEqual({ ok: true });
    expect(await ctx.processes.dispose()).toEqual({ ok: true });
    await expect(ctx.processes.openProcess(node, [fixture, 'env'], { cwd: dir })).rejects.toMatchObject({ code: 'disposed' });
  }));

  it('an opened process gets its scope’s environment and launch rules, as every child of the scope does', () => withServices(async (services, dir) => {
    const home = path.join(dir, 'account');
    const instance = { variable: 'FATG_TEST_HOME', folder: home, withhold: { names: ['FATG_TEST_TOKEN'], prefixes: [] } };
    const ctx = services.createContext({ removePrefixes: ['FATG_TEST_PARENT_'] }, instance);
    const opened = await ctx.processes.openProcess(node, [fixture, 'env', 'one', 'two'], { cwd: dir, env: { FATG_TEST_PER_RUN: '1', FATG_TEST_HOME: path.join(dir, 'elsewhere') } });
    const report = await firstLine<{ cwd: string; args: string[]; env: Record<string, string> }>(opened.process);
    expect(report.args).toEqual(['one', 'two']);
    expect(realpathSync(report.cwd)).toBe(realpathSync(dir));
    // The instance's variable, whatever a per-run override says; the withheld and the provider's dropped names gone; the per-run addition there.
    expect(report.env['FATG_TEST_HOME']).toBe(home);
    expect(report.env['FATG_TEST_PER_RUN']).toBe('1');
    expect(Object.keys(report.env).filter((name) => name === 'FATG_TEST_TOKEN' || name.startsWith('FATG_TEST_PARENT_'))).toEqual([]);
    expect(await opened.close()).toEqual({ ok: true });
    // A launch the scope's rules refuse is refused here too.
    await expect(ctx.processes.openProcess({ path: 'relative-node', kind: 'native' }, [], { cwd: dir })).rejects.toMatchObject({ code: 'spawn-failed' });
  }, { FATG_TEST_TOKEN: 'secret', FATG_TEST_PARENT_SESSION: 'x' }, { protectedVariables: ['FATG_TEST_HOME'] }));

  // An npm-installed `claude` is a .cmd shim: the Claude control arguments must reach it intact.
  it.skipIf(process.platform !== 'win32')('passes the Claude control arguments through a Windows shim unchanged', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const shim = path.join(dir, 'é agent.cmd');
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fixture}" env %*\r\n`);
    const child = await ctx.processes.spawn({ path: shim, kind: 'cmd-shim' }, CONTROL_ARGS, { cwd: dir });
    expect((await firstLine<{ args: string[] }>(child)).args).toEqual([...CONTROL_ARGS]);
    child.end();
    await child.closed;
    expect(await child.stop()).toEqual({ ok: true });
    await expect(readFile(path.join(dir, 'unintended.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
});
