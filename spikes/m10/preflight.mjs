// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B1: both CLI versions and their logged-in state, under the environment of C4, so it sees what the
// spikes will see. Anything else stops the spike; no login is ever started (C10). Only versions and
// two booleans are kept, raw output included; plus which of the flags the spikes use `--help` lists.
//
//   node spikes/m10/preflight.mjs [--cli claude|codex] [--path <executable>]
import { EXIT } from './lib/deadlines.mjs';
import { resolveExecutable } from './lib/executable.mjs';
import { runOnce } from './lib/oneshot.mjs';
import { isMain, outputPath, writeJson } from './lib/paths.mjs';
import { buildScratch } from './lib/scratch.mjs';
import { log, runSpike, warn } from './lib/spike.mjs';

/** Flags the tracing, trust and discovery spikes pass to Claude (Design 6, 7). */
const CLAUDE_FLAGS = ['--output-format', '--input-format', '--verbose', '--setting-sources', '--strict-mcp-config', '--permission-mode', '--no-session-persistence', '--permission-prompt-tool', '--tools', '--model', '--effort', '--resume', '--settings', '--include-partial-messages'];

export function parseVersion(text) {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(text ?? '')?.[1] ?? null;
}

/** `claude auth status` prints JSON with `loggedIn`. Only the boolean survives this function. */
export function claudeLoggedIn({ code, stdout }) {
  if (code !== 0) return false;
  try { return JSON.parse(stdout)?.loggedIn === true; } catch { return false; }
}

/** `codex login status` writes its line to stderr (found on 0.155.1); either stream counts. */
export function codexLoggedIn({ code, stdout, stderr = '' }) {
  return code === 0 && (/^Logged in/.test(stdout.trim()) || /^Logged in/m.test(stderr.trim()));
}

export async function preflight(launcher, waits, which, override) {
  const { dir } = buildScratch('probe');
  const result = {};
  for (const cli of which) {
    const executable = resolveExecutable(cli, which.length === 1 ? override : undefined);
    const version = await runOnce(launcher, cli, executable, ['--version'], { cwd: dir, waits });
    const status = await runOnce(launcher, cli, executable, cli === 'claude' ? ['auth', 'status'] : ['login', 'status'], { cwd: dir, waits });
    const entry = {
      version: parseVersion(version.stdout),
      launchKind: executable.kind,
      loggedIn: cli === 'claude' ? claudeLoggedIn(status) : codexLoggedIn(status),
    };
    if (cli === 'claude') {
      const help = await runOnce(launcher, cli, executable, ['--help'], { cwd: dir, waits });
      entry.flags = Object.fromEntries(CLAUDE_FLAGS.map((flag) => [flag, new RegExp(`(^|[\\s,])${flag}(?![\\w-])`, 'm').test(help.stdout)]));
    } else {
      const help = await runOnce(launcher, cli, executable, ['app-server', '--help'], { cwd: dir, waits });
      entry.appServerSubcommands = ['generate-json-schema', 'generate-ts'].filter((name) => help.stdout.includes(name));
    }
    result[cli] = entry;
  }
  return result;
}

/**
 * C10 for every other spike: the CLI's version, or a stop when it is missing or logged out.
 * Returns `{ name, version, kind }` for the capture header.
 */
export async function requireReady(launcher, waits, cli, executable, cwd) {
  const version = await runOnce(launcher, cli, executable, ['--version'], { cwd, waits });
  const status = await runOnce(launcher, cli, executable, cli === 'claude' ? ['auth', 'status'] : ['login', 'status'], { cwd, waits });
  const loggedIn = cli === 'claude' ? claudeLoggedIn(status) : codexLoggedIn(status);
  const parsed = parseVersion(version.stdout);
  if (!parsed || !loggedIn) {
    const error = new Error(`${cli} is ${parsed ? 'not logged in' : 'not answering --version'}. Log in from your own terminal (agents never do).`);
    error.exitCode = EXIT.cliMissing;
    throw error;
  }
  return { name: cli, version: parsed, kind: executable.kind };
}

if (isMain(import.meta.url)) {
  await runSpike('preflight', async ({ args, launcher, waits }) => {
    const which = args.cli ? [args.cli] : ['claude', 'codex'];
    const result = await preflight(launcher, waits, which, args.path);
    const record = { date: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, ...result };
    writeJson(outputPath('preflight.json'), record);
    log(JSON.stringify(record, null, 2));
    for (const cli of which) {
      if (!result[cli].version) { warn(`${cli}: no version reported; stopping`); return EXIT.cliMissing; }
      if (!result[cli].loggedIn) { warn(`${cli}: not logged in. Log in from your own terminal (agents never do); stopping.`); return EXIT.cliMissing; }
    }
    return EXIT.happened;
  });
}
