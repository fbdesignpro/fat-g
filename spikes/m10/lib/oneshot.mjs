// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A one-shot CLI command (`--version`, `auth status`, `--help`) through the same launcher, deadline
// and confirmed teardown as a session. Output stays in memory; callers keep only what they need.
import { settlesWithin } from './deadlines.mjs';
import { cleanEnvironment } from './env.mjs';

/** Resolves `{ code, stdout, stderr, timedOut, cleanup }`. Bounded by the request wait. */
export async function runOnce(launcher, cli, executable, args, { cwd, waits, extraEnv } = {}) {
  const { env } = cleanEnvironment(cli, { extra: extraEnv });
  const tree = await launcher.launch({ executable, args, cwd, env });
  let stdout = '';
  if (tree.child) {
    tree.stdout.setEncoding('utf8');
    tree.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk; });
    tree.stdin.end();
  }
  const finished = await settlesWithin(tree.closed, waits.request);
  const code = tree.exitInfo?.code ?? null;
  const cleanup = await tree.teardown();
  return { code, stdout, stderr: tree.stderrTail ?? '', timedOut: !finished, spawnError: tree.spawnError, cleanup };
}
