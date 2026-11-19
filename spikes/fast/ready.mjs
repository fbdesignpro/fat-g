// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Fast-mode spikes: is each scratch configuration folder signed in? Prints booleans and versions
// only (never an email, a plan or a token). No login is ever started; no prompt is spent.
//
//   node spikes/fast/ready.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveExecutable } from '../m10/lib/executable.mjs';
import { claudeLoggedIn, codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { instanceEnvironment } from '../m14b/lib/instance-env.mjs';
import { CONFIG_DIR } from '../m16/lib/common.mjs';
import { CODEX_HOME } from '../m22/k1.mjs';

function run(executable, args, env) {
  const shell = executable.kind === 'shim';
  const out = spawnSync(executable.path, args, { env, encoding: 'utf8', timeout: 30_000, shell, windowsHide: true });
  return { code: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

const claude = resolveExecutable('claude');
const codex = resolveExecutable('codex');
const claudeEnv = instanceEnvironment('claude', CONFIG_DIR).env;
const codexEnv = instanceEnvironment('codex', CODEX_HOME).env;

const report = {
  claude: {
    kind: claude.kind, folderThere: existsSync(CONFIG_DIR), markerThere: existsSync(path.join(path.dirname(CONFIG_DIR), '.fat-g-spike')),
    version: parseVersion(run(claude, ['--version'], claudeEnv).stdout),
    loggedIn: claudeLoggedIn(run(claude, ['auth', 'status'], claudeEnv)),
  },
  codex: {
    kind: codex.kind, folderThere: existsSync(CODEX_HOME), markerThere: existsSync(path.join(path.dirname(CODEX_HOME), '.fat-g-spike')),
    version: parseVersion(run(codex, ['--version'], codexEnv).stdout),
    loggedIn: codexLoggedIn(run(codex, ['login', 'status'], codexEnv)),
  },
};
console.log(JSON.stringify(report, null, 2));
