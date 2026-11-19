// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// C11: the usage reading before and after the turn-spending spikes, with the requests the app already
// uses (Claude's get_usage, Codex's account/rateLimits/read). Only the percentage per window is kept.
// Usage readings never enter a capture. The "after" reading waits 90 s first, because Claude caches
// usage for about a minute.
//
//   node spikes/m10/usage.mjs --label before|after [--cli claude|codex] [--path <executable>]
import { ClaudeDriver, CONTROL_ARGS } from './claude/driver.mjs';
import { CodexDriver } from './codex/driver.mjs';
import { EXIT, sleep } from './lib/deadlines.mjs';
import { cleanEnvironment } from './lib/env.mjs';
import { resolveExecutable } from './lib/executable.mjs';
import { isMain, outputPath, writeJson } from './lib/paths.mjs';
import { buildScratch } from './lib/scratch.mjs';
import { log, runSpike, warn } from './lib/spike.mjs';

export function claudeWindows(value) {
  const out = [];
  const limits = value?.rate_limits;
  if (limits && typeof limits === 'object') {
    for (const [name, window] of Object.entries(limits)) {
      if (window && typeof window === 'object' && typeof window.utilization === 'number') out.push({ window: name, percent: window.utilization });
    }
    if (Array.isArray(limits.limits)) for (const row of limits.limits) if (typeof row?.percent === 'number') out.push({ window: `limits:${row.kind ?? '?'}`, percent: row.percent });
  }
  return out;
}

export function codexWindows(value) {
  const out = [];
  const add = (prefix, limits) => {
    for (const key of ['primary', 'secondary']) {
      const w = limits?.[key];
      if (w && typeof w.usedPercent === 'number') out.push({ window: `${prefix}${key}${w.windowDurationMins ? ` (${w.windowDurationMins} min)` : ''}`, percent: w.usedPercent });
    }
  };
  add('', value?.rateLimits);
  for (const [id, limits] of Object.entries(value?.rateLimitsByLimitId ?? {})) add(`${id}:`, limits);
  return out;
}

async function read(cli, { launcher, waits, signal, executable, dir }) {
  const environment = cleanEnvironment(cli);
  if (cli === 'claude') {
    const driver = new ClaudeDriver({ launcher, executable, args: [...CONTROL_ARGS], cwd: dir, env: environment.env, waits, signal });
    try {
      const init = await driver.open({ systemPrompt: [''] });
      if (!init.ok) return { error: 'initialize failed' };
      const usage = await driver.request('get_usage', { skip_behaviors: true });
      return usage.ok ? { windows: claudeWindows(usage.value) } : { error: usage.error };
    } finally { await driver.close(); }
  }
  const driver = new CodexDriver({ launcher, executable, cwd: dir, env: environment.env, waits, signal });
  try {
    await driver.open();
    let reply = await driver.request('account/rateLimits/read');
    if (reply.ok && codexWindows(reply.value).length === 0) { await sleep(750); reply = await driver.request('account/rateLimits/read'); }
    return reply.ok ? { windows: codexWindows(reply.value) } : { error: reply.error?.message ?? 'error' };
  } finally { await driver.close(); }
}

async function usage({ args, launcher, signal, waits }) {
  const label = args.label;
  if (label !== 'before' && label !== 'after') { warn('usage: --label before|after'); return EXIT.error; }
  const which = args.cli ? [args.cli] : ['claude', 'codex'];
  const executables = Object.fromEntries(which.map((cli) => [cli, resolveExecutable(cli, which.length === 1 ? args.path : undefined)]));
  if (label === 'after' && !args['no-wait']) { log('waiting 90 s: Claude caches usage for about a minute'); await sleep(90_000); }
  const { dir } = buildScratch('probe');
  const report = { label, date: new Date().toISOString() };
  for (const cli of which) report[cli] = await read(cli, { launcher, waits, signal, executable: executables[cli], dir });
  writeJson(outputPath(`usage-${label}.json`), report);
  log(JSON.stringify(report, null, 2));
  return EXIT.happened;
}

if (isMain(import.meta.url)) await runSpike('usage', usage, { budgetMs: 300_000 });
