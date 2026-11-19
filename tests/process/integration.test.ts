// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile, symlink, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProcessServices } from '../../src/main/process';
import { createRpcClient } from '../../src/main/process/rpc-client';
import { pidAlive } from '../../src/main/process/tree-kill';
import { type Executable, shimRefuses } from '../../src/shared/provider-kit/process';
const fixture = path.resolve('tests/fixtures/fake-app-server.mjs');
const node: Executable = { path: process.execPath, kind: 'native' };
async function withServices(work: (services: ReturnType<typeof createProcessServices>, dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fatg-process-'));
  const services = createProcessServices(dir);
  let failure: { error: unknown } | undefined;
  try { await work(services, dir); } catch (error) { failure = { error }; }
  const cleanup = await services.killAll();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // The test's own failure comes first: a cleanup assertion thrown from `finally` would replace it.
  if (failure) throw failure.error;
  expect(cleanup.ok, `fixture cleanup failed (${dir})`).toBe(true);
}
describe('real local processes', () => {
  it('bounds queued bytes, cancels unsent writes and settles blocked writes on stop', () => withServices(async (services, dir) => {
    const child = await services.createContext().processes.spawn(node, [fixture, 'hang'], { cwd: dir });
    child.consume(() => {});
    const active = child.write(new Uint8Array(700 * 1024)).catch((error: unknown) => error);
    const controller = new AbortController(); const queued = child.write(new Uint8Array(100 * 1024), controller.signal);
    await expect(child.write(new Uint8Array(400 * 1024))).rejects.toMatchObject({ code: 'output-limit' });
    controller.abort(); await expect(queued).rejects.toMatchObject({ code: 'aborted' });
    expect((await child.stop()).ok).toBe(true); expect(await active).toMatchObject({ code: 'transport-closed' });
    expect((await child.stop()).ok).toBe(true);
  }));
  it('resolves → spawns → exchanges fragmented RPC → drains final output', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const resolution = await ctx.processes.resolve({ override: process.execPath, names: [], knownDirs: [], cwd: dir }); expect(resolution.status).toBe('found');
    const child = await ctx.processes.spawn(node, [fixture], { cwd: dir }); const rpc = createRpcClient(child, ctx.logger);
    try {
      expect(await rpc.request('fragment', { text: 'é🐈' })).toEqual({ text: 'é🐈' });
      expect(await rpc.request('final-no-newline', 12)).toBe(12); await rpc.done; expect((await child.stop()).ok).toBe(true);
    } finally { rpc.dispose(); await child.stop(); }
  }));
  it('one-shot preserves nonzero exits, fast output and drains private stderr', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    expect(await ctx.processes.run(node, [fixture, 'nonzero'], { cwd: dir })).toMatchObject({ code: 7, stdout: '{"ok":false}\n' });
    expect(await ctx.processes.run(node, [fixture, 'stderr'], { cwd: dir, timeoutMs: 1500 })).toMatchObject({ code: 0, stdout: '{"drained":true}\n' });
    const events = services.diagnostics.snapshot(); expect(events.some((e) => e.type === 'stderr-observed')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private|secret|email/);
  }));
  it('maps absent executable and rejects relative cwd / NUL', () => withServices(async (services, dir) => {
    const ctx = services.createContext();
    const controller = new AbortController(); controller.abort();
    await expect(ctx.processes.run(node, [fixture], { cwd: dir, signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    await expect(ctx.processes.run({ path: path.join(dir, 'missing.exe'), kind: 'native' }, [], { cwd: dir })).rejects.toMatchObject({ code: 'spawn-failed' });
    await expect(ctx.processes.run(node, [], { cwd: '.' })).rejects.toMatchObject({ code: 'spawn-failed' });
    await expect(ctx.processes.run(node, ['\0'], { cwd: dir })).rejects.toMatchObject({ code: 'spawn-failed' });
  }));
  it.each(['timeout', 'aborted', 'output-limit'] as const)('bounds %s then confirms child cleanup', (failure) => withServices(async (services, dir) => {
    const controller = new AbortController(); const ctx = services.createContext(); const pidFile = path.join(dir, 'pids');
    const child = await ctx.processes.spawn(node, [fixture, failure === 'output-limit' ? 'flood' : 'hang', pidFile], { cwd: dir });
    const { collectRun } = await import('../../src/main/process/spawn');
    // Only the timeout case waits on the clock: under a loaded suite, a child can take longer than
    // 150 ms to print its first kilobyte, and the flood would be read as a timeout.
    const running = collectRun(child, { cwd: dir, timeoutMs: failure === 'timeout' ? 150 : 10_000, stdoutLimit: 1024, signal: controller.signal });
    if (failure === 'aborted') controller.abort();
    await expect(running).rejects.toMatchObject({ code: failure }); expect(child.pid && pidAlive(child.pid)).toBe(false);
  }));
  it('kills parent and descendant independently of registry membership', () => withServices(async (services, dir) => {
    const ctx = services.createContext(); const pidFile = path.join(dir, 'pids');
    const child = await ctx.processes.spawn(node, [fixture, 'tree', pidFile], { cwd: dir }); const rpc = createRpcClient(child, ctx.logger);
    try {
      const info = await rpc.request('initialize') as { pid: number; descendant: number };
      const cleanup = await services.killAll(); expect(cleanup.ok).toBe(true);
      expect(pidAlive(info.pid)).toBe(false); expect(pidAlive(info.descendant)).toBe(false);
    } finally { rpc.dispose(); await child.stop(); }
  }));
  it('shutdown during a spawn await closes admission before a child can escape', () => withServices(async (services, dir) => {
    const ctx = services.createContext(); const starting = ctx.processes.spawn(node, [fixture, 'hang'], { cwd: dir });
    const stopping = services.killAll(); await expect(starting).rejects.toMatchObject({ code: 'disposed' }); expect(await stopping).toEqual({ ok: true });
  }));
  it('supervisor performs handshake, push and replacement without replay', () => withServices(async (services, dir) => {
    const ctx = services.createContext(); const supervisor = ctx.processes.supervise({ executable: node, args: [fixture], options: { cwd: dir },
      handshake: async (rpc) => { await rpc.request('initialize'); await rpc.notify('initialized'); }, policy: { baseDelayMs: 10 } });
    let notification = false; supervisor.onNotification('ready', () => { notification = true; });
    const first = await supervisor.connect(); expect(await first.request('echo', 7)).toBe(7);
    await expect(first.request('crash')).rejects.toMatchObject({ code: 'transport-closed' });
    await expect.poll(() => supervisor.state, { timeout: 3000 }).toBe('ready');
    expect(await supervisor.connect()).not.toBe(first); expect(await supervisor.request('echo', 9)).toBe(9); expect(notification).toBe(true);
    expect((await supervisor.dispose()).ok).toBe(true);
  }));
  it.skipIf(process.platform !== 'win32')('runs a shim with spaces/Unicode and rejects unsafe batch expansions without side effects', () => withServices(async (services, dir) => {
    const ctx = services.createContext(); const shim = path.join(dir, 'é agent.cmd'); const marker = path.join(dir, 'unintended.txt');
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fixture}" args %*\r\n`);
    const executable: Executable = { path: shim, kind: 'cmd-shim' };
    const args = ['hello world', 'é🐈', 'trailing\\', ''];
    const result = await ctx.processes.run(executable, args, { cwd: dir }); expect(JSON.parse(result.stdout)).toEqual(args);
    for (const bad of ['"quote"', '(parentheses)', `& echo bad > ${marker}`, '%PATH%', '!var!', '|whoami', '^escape']) {
      await expect(ctx.processes.run(executable, [bad], { cwd: dir })).rejects.toMatchObject({ code: 'spawn-failed' });
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    // The kit's rule and the launch agree, a character at a time (M16, C20): what an adapter leaves
    // out by that rule is what a launch would have refused, and nothing else.
    for (const character of ['%', '!', '"', '&', '|', '<', '>', '^', '(', ')', String.fromCharCode(13), String.fromCharCode(10)]) {
      expect(shimRefuses(`a${character}b`), JSON.stringify(character)).toBe(true);
      await expect(ctx.processes.run(executable, [`a${character}b`], { cwd: dir })).rejects.toMatchObject({ code: 'spawn-failed' });
    }
    for (const passes of args) expect(shimRefuses(passes), passes).toBe(false);
    const treeShim = path.join(dir, 'tree agent.cmd'); await writeFile(treeShim, `@echo off\r\n"${process.execPath}" "${fixture}" tree\r\n`);
    const child = await ctx.processes.spawn({ path: treeShim, kind: 'cmd-shim' }, [], { cwd: dir }); const rpc = createRpcClient(child, ctx.logger);
    try {
      const info = await rpc.request('initialize') as { pid: number; descendant: number };
      expect((await child.stop()).ok).toBe(true); expect(pidAlive(info.pid)).toBe(false); expect(pidAlive(info.descendant)).toBe(false);
    } finally { rpc.dispose(); await child.stop(); }
  }));
  it.skipIf(process.platform === 'win32')('resolves POSIX executable symlinks, rejects directories, no-execute and dangling links', () => withServices(async (services, dir) => {
    const ctx = services.createContext(); const executable = path.join(dir, 'agent'); const dangling = path.join(dir, 'dangling'); const noExec = path.join(dir, 'no-exec');
    await symlink(process.execPath, executable); await symlink(path.join(dir, 'missing'), dangling); await writeFile(noExec, ''); await chmod(noExec, 0o600);
    const resolve = (override: string) => ctx.processes.resolve({ override, names: [], knownDirs: [], cwd: dir });
    expect(await resolve(executable)).toMatchObject({ status: 'found' });
    for (const bad of [dir, dangling, noExec]) expect(await resolve(bad)).toMatchObject({ status: 'not-found', overrideInvalid: true });
  }));
  it.skipIf(process.platform === 'win32')('cleans a group after its leader exits and a descendant ignores TERM', () => withServices(async (services, dir) => {
    const ctx = services.createContext(); const child = await ctx.processes.spawn(node, [fixture, 'leader-exit'], { cwd: dir }); const rpc = createRpcClient(child, ctx.logger, { drainMs: 100 });
    try {
      const info = await rpc.request('initialize') as { descendant: number };
      await expect(rpc.request('leader-exit')).rejects.toMatchObject({ code: 'transport-closed' });
      expect((await child.stop()).ok).toBe(true); expect(pidAlive(info.descendant)).toBe(false);
    } finally { rpc.dispose(); await child.stop(); }
  }));
});
