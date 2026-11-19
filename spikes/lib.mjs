// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Shared helpers for the throwaway S1 spikes. Plain Node, no dependencies.
// NOT application code — the real implementations land in src/main/process (M5).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWin = process.platform === 'win32';
export const OUTPUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'output');

/** Resolve an executable: explicit override → PATH walk (PATHEXT, .exe before .cmd) → known dirs. Never searches cwd. */
export function resolveExecutable(name, { override, knownDirs = [] } = {}) {
  if (override) return existsSync(override) ? describe(override, 'override') : null;
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const [source, dirs] of [['path', pathDirs], ['known-dir', knownDirs]]) {
    for (const ext of exts) {
      for (const dir of dirs) {
        const candidate = path.join(dir, name + ext);
        if (existsSync(candidate)) return describe(candidate, source);
      }
    }
  }
  return null;
}

function describe(file, source) {
  const kind = /\.(cmd|bat)$/i.test(file) ? 'cmd-shim' : 'native';
  return { path: path.resolve(file), kind, source };
}

export function knownDirsFor(name) {
  const home = homedir();
  const dirs = [path.join(home, '.local', 'bin')];
  if (isWin) {
    dirs.push(path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'));
    // winget installs (e.g. Anthropic.ClaudeCode) land here — found during S1.
    dirs.push(path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Links'));
  }
  else dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'));
  if (name === 'codex') dirs.push(path.join(home, '.codex', 'bin'));
  return dirs;
}

/**
 * Spawn without a blanket `shell: true`. Since the CVE-2024-27980 fix Node refuses to
 * spawn .cmd/.bat directly (EINVAL), so shims go through cmd.exe explicitly — the same
 * thing cross-spawn does. The executable path is quoted; args here are fixed literals.
 */
export function spawnResolved(exe, args, options = {}) {
  const base = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options };
  if (isWin && exe.kind === 'cmd-shim') {
    const line = [`"${exe.path}"`, ...args].join(' ');
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...base,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(exe.path, args, base);
}

/** One-shot run. Resolves with {code, stdout, stderr}; never rejects on a non-zero exit. */
export function run(exe, args, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawnResolved(exe, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end();
    const timer = setTimeout(() => killTree(child.pid), timeoutMs);
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

export function killTree(pid) {
  if (!pid) return;
  if (isWin) {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Redact account identifiers so console output is safe to paste into an issue or chat. */
export function redact(value) {
  const json = JSON.stringify(value, (key, v) => {
    if (typeof v !== 'string') return v;
    if (/^(email|accountId|account_id|orgId|orgName|organization|userId)$/i.test(key)) return '<redacted>';
    return v
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<redacted-email>')
      .replaceAll(homedir(), '~');
  });
  return json === undefined ? value : JSON.parse(json);
}

/** Raw (UNREDACTED) results go to spikes/output/, which is gitignored. */
export function saveRaw(name, data) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? argv[++i] : true;
  }
  return out;
}
