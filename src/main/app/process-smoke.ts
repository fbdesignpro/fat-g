// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import path from 'node:path';
import type { ProcessServices } from '../process';
/** Only called from explicit smoke mode. Leaves a live tree to exercise normal quit cleanup. */
export async function checkProcessSmoke(services: ProcessServices): Promise<void> {
  const nodePath = process.env['FATG_SMOKE_NODE'];
  const fixture = process.env['FATG_SMOKE_FIXTURE'];
  const pidFile = process.env['FATG_SMOKE_PIDS'];
  if (!nodePath || !fixture || !pidFile || ![nodePath, fixture, pidFile].every((p) => path.isAbsolute(p))) throw new Error('missing process fixture paths');
  const ctx = services.createContext();
  const resolved = await ctx.processes.resolve({ override: nodePath, names: [], knownDirs: [], cwd: ctx.probeDirectory });
  if (resolved.status !== 'found') throw new Error('fixture executable did not resolve');
  let pushes = 0;
  const supervisor = ctx.processes.supervise({ executable: resolved.executable, args: [fixture, 'rpc', pidFile], options: { cwd: ctx.probeDirectory },
    policy: { baseDelayMs: 50 }, handshake: async (rpc) => { await rpc.request('initialize'); await rpc.notify('initialized'); } });
  supervisor.onNotification('ready', () => { pushes++; });
  const original = await supervisor.connect();
  if (await original.request('fragment', 'é🐈') !== 'é🐈') throw new Error('fixture response mismatch');
  await original.request('crash').catch(() => {});
  const deadline = Date.now() + 5000;
  while (supervisor.state !== 'ready' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (await supervisor.connect() === original || await supervisor.request('echo', 9) !== 9 || pushes < 2) throw new Error('fixture recovery failed');
  // Independent tree, kept alive until before-quit. External runner checks every recorded PID.
  const tree = ctx.processes.supervise({ executable: resolved.executable, args: [fixture, 'tree', pidFile], options: { cwd: ctx.probeDirectory },
    handshake: async (rpc) => { await rpc.request('initialize'); } });
  await tree.connect();
  await tree.request('echo', 'alive');
}
