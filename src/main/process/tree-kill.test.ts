// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => mocks);
import { terminateTree, terminateTreeSync } from './tree-kill';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe.skipIf(process.platform !== 'win32')('Windows owned tree termination', () => {
  it('uses an absolute system helper, targets only the PID, includes descendants', async () => {
    vi.useFakeTimers(); const helper = Object.assign(new EventEmitter(), { kill: vi.fn() }); mocks.spawn.mockReturnValue(helper);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    const result = terminateTree({ pid: 1234, rootExited: () => false, streamsClosed: () => false, end: vi.fn() });
    expect(mocks.spawn).toHaveBeenCalledWith(expect.stringMatching(/^[A-Z]:\\.*\\System32\\taskkill\.exe$/i), ['/PID', '1234', '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    helper.emit('exit', 0); expect(await result).toEqual({ ok: true }); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a hung helper and reports failure', async () => {
    vi.useFakeTimers(); const helper = Object.assign(new EventEmitter(), { kill: vi.fn() }); mocks.spawn.mockReturnValue(helper);
    const result = terminateTree({ pid: 1234, rootExited: () => false, streamsClosed: () => false, end: vi.fn() });
    await vi.advanceTimersByTimeAsync(4000); expect(await result).toEqual({ ok: false }); expect(helper.kill).toHaveBeenCalledTimes(1);
  });
  it('accepts a cooperative exit race after its streams finish closing', async () => {
    vi.useFakeTimers();
    const helper = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mocks.spawn.mockReturnValue(helper);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    let exited = false;
    let closed = false;
    const result = terminateTree({ pid: 1234, rootExited: () => exited, streamsClosed: () => closed, end: vi.fn() });
    exited = true;
    setTimeout(() => { closed = true; }, 20);
    helper.emit('exit', 128);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toEqual({ ok: true });
  });
  it('refuses own/invalid PIDs and bounds emergency work (Windows)', async () => {
    const handle = { pid: process.pid, rootExited: () => false, streamsClosed: () => false, end: vi.fn() };
    expect(await terminateTree(handle)).toEqual({ ok: false }); expect(await terminateTree({ ...handle, pid: 0 })).toEqual({ ok: false });
    mocks.spawnSync.mockReturnValue({ status: 0 }); vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    expect(terminateTreeSync({ ...handle, pid: 1234 }, 50)).toEqual({ ok: true });
    expect(mocks.spawnSync).toHaveBeenCalledWith(expect.any(String), ['/PID', '1234', '/T', '/F'], expect.objectContaining({ timeout: 50 }));
  });
});
// The POSIX branch, driven on every platform: `process.platform` is stubbed and `process.kill`
// answers as the kernel would. XNU skips zombies when signalling a group and then reports EPERM,
// not ESRCH, if nothing live was left — the state of a child that exited on its own (stdout EOF)
// but has not been reaped yet.
describe('POSIX group termination', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }); });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); });
  const handle = () => ({ pid: 4242, rootExited: () => true, streamsClosed: () => true, end: vi.fn() });
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it('confirms a zombie-only group once it is reaped, without escalating to SIGKILL', async () => {
    vi.useFakeTimers();
    let probes = 0;
    const kill = vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      if (signal === 0 && (probes += 1) > 3) throw errno('ESRCH'); // reaped
      throw errno('EPERM');
    });
    const result = terminateTree(handle());
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toEqual({ ok: true });
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('still fails when a live member can never be signalled', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw errno('EPERM'); });
    const result = terminateTree(handle());
    await vi.advanceTimersByTimeAsync(2500);
    expect(await result).toEqual({ ok: false });
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('fails at once on any other signalling error', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw errno('EINVAL'); });
    expect(await terminateTree(handle())).toEqual({ ok: false });
  });

  it('terminates a live group and confirms it gone', async () => {
    vi.useFakeTimers();
    let alive = true;
    vi.spyOn(process, 'kill').mockImplementation((_target, signal) => {
      if (signal === 'SIGTERM') alive = false;
      else if (signal === 0 && !alive) throw errno('ESRCH');
      return true;
    });
    const result = terminateTree(handle());
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ ok: true });
  });

  it('keeps the synchronous emergency path strict about an unconfirmed group', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw errno('EPERM'); });
    expect(terminateTreeSync(handle(), 50)).toEqual({ ok: false });
    vi.spyOn(process, 'kill').mockImplementation(() => { throw errno('ESRCH'); });
    expect(terminateTreeSync(handle(), 50)).toEqual({ ok: true });
  });
});
