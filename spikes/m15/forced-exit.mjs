// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Windows-only, opt-in real-CLI acceptance diagnostic. One model turn, in a new
// scratch conversation; kills only our disposable Node parent, never the open app.
// node spikes/m15/forced-exit.mjs --cli <absolute codex.cmd/exe> --model <key> --effort <id> --confirm-turns 1
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import crossSpawn from 'cross-spawn';
import { build } from 'esbuild';

const { values } = parseArgs({ options: { cli: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' }, 'confirm-turns': { type: 'string' }, 'delay-ms': { type: 'string', default: '0' } } });
console.log('Plan: one real model turn in a fresh scratch conversation; kill only its parent; observe descendants for up to 90 seconds and retry resume without prompts. Leaves the scratch conversation in Codex history. No user sessions are changed.');
if (values['confirm-turns'] !== '1') process.exit(0);
if (process.platform !== 'win32' || !values.cli || !path.isAbsolute(values.cli) || !values.model || !values.effort) throw Error('Windows and --cli, --model, --effort are required');
const delayMs = Number(values['delay-ms']);
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) throw Error('--delay-ms must be between 0 and 30000');

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const snapshot = async () => {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,@{Name="Created";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
  return JSON.parse(stdout);
};
const descendants = (all, pid) => {
  const ids = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of all) if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); changed = true; }
  }
  return all.filter(p => ids.has(p.ProcessId) && p.ProcessId !== pid);
};
const env = { ...process.env };
for (const k of Object.keys(env)) if (/^(ELECTRON_.*|NODE_OPTIONS)$/i.test(k)) delete env[k];
const output = path.resolve('spikes/output/m15');
mkdirSync(output, { recursive: true });
const reportFile = path.join(output, `forced-exit-${Date.now()}.json`);
const scratch = mkdtempSync(path.join(tmpdir(), 'fatg-exit-acceptance-'));
const project = path.join(scratch, 'project');
mkdirSync(project);
const bundle = path.join(output, 'forced-exit-parent.mjs');
await build({ entryPoints: ['spikes/m15/forced-exit-parent.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: bundle, tsconfig: 'tsconfig.base.json', define: { __FATG_SMOKE_HOOKS__: 'false' }, banner: { js: "import { createRequire as __fatgRequire } from 'node:module'; const require = __fatgRequire(import.meta.url);" } });

// A diagnostic probe. Error text is reduced to a fixed classification in memory;
// no provider message, transcript, or credential is saved. No turn/start here.
async function probe(reference) {
  const child = crossSpawn(values.cli, ['app-server'], { env, cwd: scratch, windowsHide: true, stdio: 'pipe' });
  const pending = new Map();
  let id = 0;
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    if (pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id); }
    else if (frame.id !== undefined && frame.method) child.stdin.write(`${JSON.stringify({ id: frame.id, error: { code: -32601, message: 'Diagnostic grants no requests' } })}\n`);
  });
  const request = (method, params) => new Promise(resolve => { const next = ++id; pending.set(next, resolve); child.stdin.write(`${JSON.stringify({ id: next, method, params })}\n`); });
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const init = await request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g', version: '0.0.0-diagnostic' } });
        if (init.error) return { kind: 'initialize-refused', code: init.error.code };
        child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
        const result = await request('thread/resume', { threadId: reference, cwd: project, sandbox: 'read-only', approvalPolicy: 'never', excludeTurns: true });
        return result.error ? { kind: /already has an active writer/.test(result.error.message ?? '') ? 'active-writer' : 'other-refusal', code: result.error.code } : { kind: result.result?.thread?.id === reference ? 'resumed' : 'unexpected-reply' };
      })(),
      new Promise(resolve => { timeout = setTimeout(() => resolve({ kind: 'timeout' }), 10000); }),
      new Promise(resolve => child.once('error', () => resolve({ kind: 'spawn-error' }))),
    ]);
  } finally {
    clearTimeout(timeout);
    child.stdin.end();
    for (let i = 0; i < 20 && alive(child.pid); i++) await sleep(100);
    if (alive(child.pid)) {
      // This still-live root was launched by this probe; never target a provider globally.
      await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    }
    lines.close();
  }
}

const report = { platform: process.platform, startedAt: new Date().toISOString(), delayMs, turnsSubmitted: 0, samples: [], probes: [], cleanup: [] };
const parent = spawn(process.execPath, [bundle, path.join(scratch, 'data'), project, values.cli, values.model, values.effort], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
parent.stderr.resume();
let tracked = [];
let completed = false;
const parentLines = createInterface({ input: parent.stdout });
try {
  const reference = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('parent-not-ready')), 60000);
    parent.once('error', () => { clearTimeout(timeout); reject(Error('parent-spawn-failed')); });
    parent.once('exit', () => { clearTimeout(timeout); reject(Error('parent-exited-early')); });
    parentLines.on('line', line => {
      let event; try { event = JSON.parse(line); } catch { return; }
      if (event.submittingTurn) report.turnsSubmitted++;
      if (event.ended) completed = true;
      if (event.error) { clearTimeout(timeout); reject(Error('parent-failed')); }
      if (event.ready) { clearTimeout(timeout); resolve(event.reference); }
    });
  });
  await sleep(delayMs);
  tracked = descendants(await snapshot(), parent.pid);
  if (!tracked.some(p => p.Name.toLowerCase() === 'codex.exe')) throw Error('no-cli-descendant-recorded');
  report.turnCompletedBeforeKill = completed;
  if (completed) throw Error('turn-completed-before-kill');
  report.descendants = tracked;
  // Private references are kept only in gitignored output for a follow-up probe.
  report.reference = reference;
  report.scratch = scratch;
  const start = performance.now();
  parent.kill('SIGKILL'); // TerminateProcess on Windows: no /T, no graceful drain.
  console.log('Parent killed while the turn was active; observing its recorded CLI tree.');
  let sampling = true;
  const sampler = (async () => {
    let previous;
    while (sampling) {
      const remaining = tracked.filter(p => alive(p.ProcessId)).map(p => p.ProcessId);
      const key = remaining.join(',');
      if (key !== previous) {
        const sample = { ms: Math.round(performance.now() - start), remaining };
        report.samples.push(sample); console.log(JSON.stringify(sample)); previous = key;
      }
      await sleep(100);
    }
  })();
  try {
    while (performance.now() - start < 90000) {
      const at = Math.round(performance.now() - start);
      const result = await probe(reference);
      const entry = { startedMs: at, finishedMs: Math.round(performance.now() - start), ...result };
      report.probes.push(entry); console.log(JSON.stringify(entry));
      if (result.kind === 'resumed') break;
      await sleep(1500);
    }
    // Keep measuring the old tree even when resume succeeds early.
    while (tracked.some(p => alive(p.ProcessId)) && performance.now() - start < 90000) await sleep(100);
  } finally { sampling = false; await sampler; }
  report.projectUnchanged = readdirSync(project).length === 0;
  report.oldTreeGone = tracked.every(p => !alive(p.ProcessId));
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  // Discover any children even if startup failed, then clean only matching PID + creation time.
  const all = await snapshot();
  tracked = [...tracked, ...descendants(all, parent.pid)].filter((p, i, list) => list.findIndex(q => q.ProcessId === p.ProcessId && q.Created === p.Created) === i);
  if (alive(parent.pid)) parent.kill('SIGKILL');
  for (const p of tracked) {
    if (all.some(q => q.ProcessId === p.ProcessId && q.Created === p.Created) && alive(p.ProcessId)) {
      process.kill(p.ProcessId, 'SIGKILL'); report.cleanup.push({ pid: p.ProcessId, name: p.Name });
    }
  }
  parentLines.close();
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.relative(process.cwd(), reportFile)}`);
}
