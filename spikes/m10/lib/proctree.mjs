// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Process listing and tree walking (C60, C67). A listing holds four properties per process: id,
// parent id, start time and image name. The command line is never read, and nothing about a
// process the spike did not launch is ever written down.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { LISTING_TIMEOUT } from './deadlines.mjs';

const isWin = process.platform === 'win32';

export class ListingFailed extends Error {
  constructor(reason) { super(`process listing failed: ${reason}`); this.name = 'ListingFailed'; }
}

function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Four properties, tab-separated. CreationDate goes out as a round-trip UTC string, so two
// listings compare exactly.
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object {',
  "  $s = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }",
  '  "{0}`t{1}`t{2}`t{3}" -f $_.ProcessId, $_.ParentProcessId, $s, $_.Name',
  '}',
].join('\n');

function collect(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill(); reject(new ListingFailed(`no answer within ${timeoutMs} ms`)); } }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (error) => { if (!done) { done = true; clearTimeout(timer); reject(new ListingFailed(error.code ?? 'spawn error')); } });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) reject(new ListingFailed(`exit code ${code}`));
      else resolve(out);
    });
  });
}

/** Map<pid, { pid, ppid, start, name }>. Throws ListingFailed, which callers treat as "cannot confirm". */
export async function listProcesses({ timeoutMs = LISTING_TIMEOUT } = {}) {
  const map = new Map();
  if (isWin) {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
    const text = await collect(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], timeoutMs);
    for (const line of text.split(/\r?\n/)) {
      const [pid, ppid, start, name] = line.split('\t');
      if (!pid || !/^\d+$/.test(pid)) continue;
      map.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), start: start || null, name: name ?? '' });
    }
  } else {
    // POSIX path: written, not exercised in M10 (see spikes/README.md). `lstart` is a fixed-width
    // 24-character date; `comm` is the image name only.
    const text = await collect('/bin/ps', ['-A', '-o', 'pid=,ppid=,lstart=,comm='], timeoutMs);
    for (const line of text.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
      if (!match) continue;
      map.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), start: match[3].replace(/\s+/g, ' '), name: path.basename(match[4].trim()) });
    }
  }
  if (map.size === 0) throw new ListingFailed('empty listing');
  return map;
}

/** Same process: same pid and same start time. A recorded start of null matches on pid and name. */
export function sameProcess(recorded, current) {
  if (!current || current.pid !== recorded.pid) return false;
  if (recorded.start && current.start) return recorded.start === current.start;
  return (recorded.name ?? '').toLowerCase() === (current.name ?? '').toLowerCase();
}

/** Recorded processes that still run, by pid and start time. */
export function survivors(recorded, listing) {
  return recorded.filter((entry) => sameProcess(entry, listing.get(entry.pid)));
}

/**
 * Every live process that descends from a recorded one. Windows keeps a dead parent's pid on its
 * children, so the walk works after the root is gone. A child is only followed when its parent pid
 * is either the recorded process itself or a pid nobody holds now: a reused pid belongs to someone
 * else, and so do its children. A child older than its supposed parent is not its child.
 */
export function descendants(recorded, listing) {
  const found = new Map();
  const parents = new Map(recorded.map((entry) => [entry.pid, entry]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const proc of listing.values()) {
      if (found.has(proc.pid) || parents.has(proc.pid)) continue;
      const parent = parents.get(proc.ppid);
      if (!parent) continue;
      const holder = listing.get(proc.ppid);
      if (holder && !sameProcess(parent, holder)) continue;
      if (olderThan(proc.start, parent.start)) continue;
      if (proc.pid === process.pid || proc.pid === process.ppid) continue;
      const entry = { pid: proc.pid, ppid: proc.ppid, start: proc.start, name: proc.name };
      found.set(proc.pid, entry);
      parents.set(proc.pid, entry);
      grew = true;
    }
  }
  return [...found.values()];
}

/** True only when both are ISO strings (the Windows listing) and `a` is earlier than `b`. */
function olderThan(a, b) {
  const iso = /^\d{4}-\d{2}-\d{2}T/;
  return Boolean(a && b && iso.test(a) && iso.test(b) && a < b);
}

/** Ends one process (and, with `tree`, what Windows still links to it). Resolves when taskkill exits. */
export function forceEnd(pid, { tree = false, timeoutMs = 5_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid || pid === process.ppid) return Promise.resolve(false);
  if (!isWin) {
    try { process.kill(tree ? -pid : pid, 'SIGKILL'); return Promise.resolve(true); } catch { return Promise.resolve(false); }
  }
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  const args = ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'];
  return new Promise((resolve) => {
    const child = spawn(path.join(root, 'System32', 'taskkill.exe'), args, { windowsHide: true, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
