// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// C12, C68: the sessions the spikes left in the vendors' history, asked of the CLIs themselves.
//
// Codex: thread/list, filtered in memory to threads whose folder is a spike scratch folder or whose
// name starts with "fat-g spike". Everything else is dropped unwritten.
// Claude: every session ran with --no-session-persistence. A resume attempt per session id, idle and
// without a prompt, checks it, with a made-up id as the control.
//
//   node spikes/m10/history.mjs [--cli claude|codex] [--path <executable>]
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeDriver, CONTROL_ARGS } from './claude/driver.mjs';
import { CodexDriver } from './codex/driver.mjs';
import { EXIT, sleep } from './lib/deadlines.mjs';
import { cleanEnvironment } from './lib/env.mjs';
import { resolveExecutable } from './lib/executable.mjs';
import { isMain, outputPath, writeJson } from './lib/paths.mjs';
import { SCRATCH_NAMES, buildScratch } from './lib/scratch.mjs';
import { log, runSpike } from './lib/spike.mjs';
import { CliExited } from './lib/wire.mjs';

const isSpikeFolder = (cwd) => typeof cwd === 'string' && Object.values(SCRATCH_NAMES).some((name) => path.basename(cwd).toLowerCase() === name);

async function codexHistory({ launcher, waits, signal, executable, dir }) {
  const driver = new CodexDriver({ launcher, executable, cwd: dir, env: cleanEnvironment('codex').env, waits, signal });
  const kept = [];
  let scanned = 0;
  try {
    await driver.open();
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const reply = await driver.request('thread/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!reply.ok) return { method: 'thread/list', error: reply.error?.message ?? 'error' };
      for (const thread of reply.value?.data ?? []) {
        scanned++;
        const name = typeof thread?.name === 'string' ? thread.name : null;
        if (isSpikeFolder(thread?.cwd) || name?.startsWith('fat-g spike')) kept.push({ name, folder: path.basename(thread.cwd ?? ''), createdAt: thread.createdAt ?? null });
      }
      cursor = reply.value?.nextCursor ?? null;
      if (!cursor) break;
    }
  } finally { await driver.close(); }
  return { method: 'thread/list, filtered in memory to spike scratch folders and "fat-g spike" names', scanned, left: kept };
}

function claudeSessionIds() {
  const dir = outputPath('raw', 'claude');
  const ids = new Set();
  for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []) {
    const capture = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    for (const { frame } of capture.frames ?? []) if (frame?.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string') ids.add(frame.session_id);
  }
  return [...ids];
}

async function resumeAttempt(id, { launcher, waits, signal, executable, dir }) {
  const driver = new ClaudeDriver({ launcher, executable, args: [...CONTROL_ARGS, '--resume', id], cwd: dir, env: cleanEnvironment('claude').env, waits, signal });
  const result = { found: null, stage: null };
  try {
    const init = await driver.open();
    result.stage = 'initialize';
    result.found = init.ok ? 'initialized' : 'initialize refused';
    await sleep(1_000);
  } catch (error) {
    if (!(error instanceof CliExited)) throw error;
    result.stage = 'launch';
    result.found = 'exited';
    result.exitCode = error.info?.code ?? null;
  } finally { await driver.close(); }
  return result;
}

async function claudeHistory(ctx) {
  const control = await resumeAttempt(randomUUID(), ctx);
  const ids = claudeSessionIds();
  const attempts = [];
  for (const id of ids) attempts.push({ session: `session ${attempts.length + 1}`, ...(await resumeAttempt(id, ctx)) });
  const sameAsControl = attempts.filter((a) => a.found === control.found && a.stage === control.stage).length;
  const conclusive = control.found !== 'initialized';
  return {
    method: 'resume attempt per traced session id, idle and without a prompt; a made-up id as the control',
    control,
    sessionsChecked: ids.length,
    behavedLikeControl: sameAsControl,
    left: conclusive ? attempts.filter((a) => !(a.found === control.found && a.stage === control.stage)) : null,
    conclusion: conclusive ? (sameAsControl === ids.length ? 'none left: every traced id resumed like the made-up one' : 'some ids resumed differently; see left') : 'none by construction: the control was inconclusive, and every session ran with --no-session-persistence',
  };
}

async function history({ args, launcher, signal, waits }) {
  const which = args.cli ? [args.cli] : ['codex', 'claude'];
  const { dir } = buildScratch('probe');
  const report = { date: new Date().toISOString() };
  for (const cli of which) {
    const executable = resolveExecutable(cli, which.length === 1 ? args.path : undefined);
    const ctx = { launcher, waits, signal, executable, dir };
    report[cli] = cli === 'codex' ? await codexHistory(ctx) : await claudeHistory(ctx);
  }
  writeJson(outputPath('history.json'), report);
  log(JSON.stringify(report, null, 2));
  return EXIT.happened;
}

if (isMain(import.meta.url)) await runSpike('history', history);
