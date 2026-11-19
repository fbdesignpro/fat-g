// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// External development launcher: records only sanitized lifecycle lines and process metadata.
// Stays alive after Electron is killed. Never sends prompts, probes sessions, or kills CLI trees.
import { appendFileSync, mkdirSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TRACE_PHASES, TRACE_OPERATIONS, TRACE_OUTCOMES } from '../src/shared/provider-kit/lifecycle-trace.ts';

const PREFIX = '[fatg-trace] ';
const integer = value => Number.isSafeInteger(value);
const pid = value => integer(value) && value > 0;

/** Reconstruct once more at the disk boundary. Never write raw stdout/stderr or unknown keys. */
export function traceLine(line) {
  if (!line.startsWith(PREFIX) || line.length > 2048) return null;
  let value;
  try { value = JSON.parse(line.slice(PREFIX.length)); } catch { return null; }
  if (!value || value.version !== 1 || !pid(value.appPid) || !integer(value.at) || !integer(value.elapsedMs) || !TRACE_PHASES.includes(value.phase) || !(value.pid === null || pid(value.pid))) return null;
  const safe = { source: 'app', version: 1, at: value.at, elapsedMs: value.elapsedMs, appPid: value.appPid, phase: value.phase, pid: value.pid };
  if (pid(value.request)) safe.request = value.request;
  if (TRACE_OPERATIONS.includes(value.operation)) safe.operation = value.operation;
  if (TRACE_OUTCOMES.includes(value.outcome)) safe.outcome = value.outcome;
  if (value.numericCode === null || integer(value.numericCode)) safe.numericCode = value.numericCode;
  if (value.refusal === 'active-writer' || value.refusal === 'other') safe.refusal = value.refusal;
  if (typeof value.ok === 'boolean') safe.ok = value.ok;
  return safe;
}

/** Add only descendants of an observed app PID; creation times disambiguate PID reuse. */
export function observeProcesses(rows, appPids, tracked, at) {
  const events = [];
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const owned = new Set();
  for (const root of appPids) {
    const row = byPid.get(root);
    if (row && (!tracked.has(root) || tracked.get(root).born === row.born)) owned.add(root);
  }
  for (const old of tracked.values()) if (byPid.get(old.pid)?.born === old.born) owned.add(old.pid);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  for (const row of rows) {
    if (!owned.has(row.pid)) continue;
    const old = tracked.get(row.pid);
    if (!old || old.born !== row.born) {
      tracked.set(row.pid, { ...row, lastSeenAt: at, gone: false });
      events.push({ source: 'observer', at, phase: 'observed-start', pid: row.pid, parent: row.parent, born: row.born });
    } else { old.lastSeenAt = at; }
  }
  for (const old of tracked.values()) {
    if (!old.gone && byPid.get(old.pid)?.born !== old.born) {
      old.gone = true;
      events.push({ source: 'observer', at, phase: 'observed-exit', pid: old.pid, lastSeenAt: old.lastSeenAt, born: old.born });
    }
  }
  return events;
}

async function main() {
  if (process.platform !== 'win32') throw Error('The external process observer currently supports Windows only.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.join(root, 'spikes/output/m15');
  const file = path.join(directory, `live-trace-${Date.now()}.jsonl`);
  const exec = promisify(execFile);
  const snapshot = async () => {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object @{Name="pid";Expression={$_.ProcessId}},@{Name="parent";Expression={$_.ParentProcessId}},@{Name="born";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  await snapshot(); // Fail before launching if the observer cannot inspect processes.
  mkdirSync(directory, { recursive: true });
  let bytes = 0;
  let full = false;
  const record = event => {
    if (full) return;
    const line = `${JSON.stringify(event)}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > 8 * 1024 * 1024) { full = true; console.error('Trace reached its 8 MiB limit. Finish this run and start a new trace.'); return; }
    appendFileSync(file, line); // Each line survives killing the app; no async buffer in Electron.
  };
  record({ source: 'observer', phase: 'begin', at: Date.now(), version: 1 });
  const appPids = new Set();
  const tracked = new Map();
  let current;
  let running = true;
  let restarting = false;
  const launch = () => {
    const env = { ...process.env, FATG_TRACE_LIFECYCLE: '1' };
    for (const key of Object.keys(env)) if (/^ELECTRON_|^NODE_OPTIONS$|^FATG_SMOKE|^FATG_DEMO_SESSIONS$/.test(key)) delete env[key];
    current = spawn(process.execPath, [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    record({ source: 'observer', phase: 'launcher-start', at: Date.now(), pid: current.pid });
    for (const stream of [current.stdout, current.stderr]) {
      const lines = createInterface({ input: stream });
      lines.on('line', line => {
        // Show ordinary build output in the terminal but do not save it.
        const event = traceLine(line);
        if (event) {
          if (!appPids.has(event.appPid)) console.log(`fat-g main PID: ${event.appPid}. End only this PID for the forced-exit check.`);
          appPids.add(event.appPid); record(event);
          if (event.operation === 'resume' && event.phase === 'reply') console.log(`Resume: ${event.outcome}${event.refusal ? ` (${event.refusal})` : ''}`);
        } else console.log(line);
      });
    }
    current.on('error', () => console.error('Development launcher failed to start.'));
    current.on('exit', () => { record({ source: 'observer', phase: 'launcher-exit', at: Date.now() }); console.log('App launcher exited. Observation continues. Type r then Enter to reopen, or q to finish.'); });
  };
  console.log(`Saving sanitized trace to ${file}\nClose any existing fat-g development window first. This launcher sends no model prompts.\nAfter the crash, type r then Enter here to reopen in the same trace. Keep this terminal open.\nType q then Enter to stop recording (does not kill the app or CLI processes).`);
  launch();
  const input = createInterface({ input: process.stdin });
  const finish = async () => {
    try {
      if (appPids.size === 0 && current?.exitCode === null && current.signalCode === null) {
        console.log('The app launcher is still starting. Wait for its main PID or exit before finishing.');
        return;
      }
      const rows = await snapshot();
      if (rows.some(row => (appPids.has(row.pid) && !tracked.has(row.pid)) || tracked.get(row.pid)?.born === row.born)) {
        console.log('Close fat-g normally and wait for its tracked processes to exit before finishing the trace.');
        return;
      }
      running = false; input.close();
    } catch { console.error('Could not verify process exit; observation continues.'); }
  };
  input.on('line', async line => {
    if (line.trim() === 'q') { await finish(); return; }
    if (line.trim() !== 'r' || restarting) return;
    restarting = true;
    try {
      const rows = await snapshot();
      const appAlive = rows.some(row => appPids.has(row.pid) && (!tracked.has(row.pid) || tracked.get(row.pid).born === row.born));
      if (appAlive) { console.log('fat-g is still open. Close or end its main process before restarting.'); return; }
      if (current?.exitCode === null && current.signalCode === null) {
        const exited = new Promise(resolve => current.once('exit', resolve));
        current.kill('SIGKILL'); // Only our dev launcher, after verifying the app is already gone.
        await exited;
      }
      launch();
    } catch { console.error('Could not verify process state; did not restart.'); }
    finally { restarting = false; }
  });
  input.on('close', () => { running = false; });
  process.on('SIGINT', () => { void finish(); });
  while (running) {
    try { for (const event of observeProcesses(await snapshot(), appPids, tracked, Date.now())) record(event); }
    catch { record({ source: 'observer', phase: 'observation-failed', at: Date.now() }); console.error('Process observation failed; this interval cannot prove cleanup.'); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  record({ source: 'observer', phase: 'end', at: Date.now() });
  console.log(`Trace saved: ${file}`);
  // Leave the app and all CLI processes alone when the user ends recording.
  if (current) { current.stdout.destroy(); current.stderr.destroy(); current.unref(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Trace launcher failed. Check Windows process-enumeration permissions and workspace access.'); process.exitCode = 1; });
}
