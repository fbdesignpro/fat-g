// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import type { CleanupResult } from '@shared/provider-kit/process';

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/**
 * `unconfirmed`: nothing in the group could be signalled. macOS (XNU) answers EPERM, not ESRCH,
 * for a group whose members are all zombies awaiting reaping — as it does for a real permission
 * denial — so only a later ESRCH from `pidAlive(-pid)` proves the group gone.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): 'sent' | 'gone' | 'unconfirmed' | 'failed' {
  try {
    process.kill(-pid, signal);
    return 'sent';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? 'gone' : code === 'EPERM' ? 'unconfirmed' : 'failed';
  }
}
function taskkillPath(): string | undefined {
  const root = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'];
  return root && path.win32.isAbsolute(root) ? path.win32.join(root, 'System32', 'taskkill.exe') : undefined;
}
export interface TreeHandle { pid: number | undefined; rootExited(): boolean; streamsClosed(): boolean; end(): void }
export async function terminateTree(handle: TreeHandle, graceMs = 1000): Promise<CleanupResult> {
  const { pid } = handle;
  if (pid === undefined) return { ok: true }; // spawn failed before acquiring a PID
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return { ok: false };
  if (process.platform === 'win32') {
    // EOF first can destroy the shim parent before taskkill enumerates its descendants.
    if (handle.rootExited()) {
      // exit precedes close; allow ordinary pipe EOF to arrive. A descendant-held pipe still
      // fails this bounded check because Windows can no longer enumerate that orphaned tree.
      const deadline = Date.now() + 1000;
      while (!handle.streamsClosed() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: handle.streamsClosed() };
    }
    const executable = taskkillPath();
    if (!executable) return { ok: false };
    return new Promise((resolve) => {
      const helper = spawn(executable, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      const timer = setTimeout(() => { helper.kill(); finish(false); }, 4000);
      let settled = false;
      function finish(ok: boolean): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok });
      }
      helper.on('error', () => finish(false));
      helper.on('exit', (code) => {
        // The helper itself completed, so its hung-helper timer no longer applies. Windows may
        // need a little longer to reap a force-terminated tree and report its PID as gone.
        clearTimeout(timer);
        void (async () => {
          const deadline = Date.now() + 1500;
          while (pidAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
          if (!pidAlive(pid) && code !== 0 && handle.rootExited()) {
            // taskkill can report "not found" when the cooperative process exits between our
            // first check and helper startup. Its close event follows exit, so allow the pipes a
            // short bounded drain before deciding cleanup was unconfirmed.
            const closeDeadline = Date.now() + 500;
            while (!handle.streamsClosed() && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
          }
          finish(!pidAlive(pid) && (code === 0 || (handle.rootExited() && handle.streamsClosed())));
        })();
      });
    });
  }
  handle.end();
  // A root that exited by itself can still be an unreaped zombie here (stdout EOF comes before
  // reaping), which macOS reports as EPERM. Neither signal result decides success: the group must
  // be seen gone within the bounded waits.
  if (signalGroup(pid, 'SIGTERM') === 'failed') return { ok: false };
  const deadline = Date.now() + graceMs;
  while (pidAlive(-pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (pidAlive(-pid) && signalGroup(pid, 'SIGKILL') === 'failed') return { ok: false };
  const killDeadline = Date.now() + 1000;
  while (pidAlive(-pid) && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return { ok: !pidAlive(-pid) };
}
/** Bounded per call by the caller's shared deadline; never enumerates unrelated processes. */
export function terminateTreeSync(handle: TreeHandle, timeoutMs: number): CleanupResult {
  const { pid } = handle;
  if (pid === undefined) return { ok: true };
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return { ok: false };
  // The synchronous emergency path cannot wait for reaping, so an unconfirmed group stays a failure.
  if (process.platform !== 'win32') {
    const result = signalGroup(pid, 'SIGKILL');
    return { ok: result === 'sent' || result === 'gone' };
  }
  if (handle.rootExited()) return { ok: handle.streamsClosed() };
  const executable = taskkillPath();
  if (!executable || timeoutMs <= 0) return { ok: false };
  const result = spawnSync(executable, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore', timeout: timeoutMs });
  return { ok: result.status === 0 && !pidAlive(pid) };
}
