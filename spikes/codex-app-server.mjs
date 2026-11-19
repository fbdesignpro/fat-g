// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// S1 spike — Codex usage allocations via `codex app-server` (JSON-RPC over stdio, NDJSON framed).
// Usage:  node spikes/codex-app-server.mjs [--path <codex executable>] [--listen-ms 3000]
//
// Answers (see docs/planning/_archive/phase-1/phase-1.md, S1):
//   1. Does the handshake work through the Windows .cmd shim?
//   2. Shapes of account/read and account/rateLimits/read for this account.
//   3. Is the first rateLimits read after the handshake empty? (known quirk → retry once)
//   4. Does app-server exit on its own when stdin closes? (our orphan-process mitigation)
//   5. If not, does killing the tree work?
//
// Per docs/decisions/0004: we never read ~/.codex/auth.json and never set CODEX_HOME.
import { knownDirsFor, killTree, parseArgs, redact, resolveExecutable, run, saveRaw, sleep, spawnResolved, withTimeout } from './lib.mjs';

const args = parseArgs();
const report = { startedAt: new Date().toISOString(), platform: process.platform, findings: {} };

const exe = resolveExecutable('codex', { override: args.path, knownDirs: knownDirsFor('codex') });
if (!exe) {
  console.error('codex not found (PATH + known dirs). Install it or pass --path <file>.');
  process.exit(2);
}
report.executable = exe;
report.version = (await run(exe, ['--version'])).stdout;
const login = await run(exe, ['login', 'status']);
report.loginStatus = { exitCode: login.code, text: login.stdout || login.stderr };
console.log('executable :', redact(exe));
console.log('version    :', report.version);
console.log('login      :', redact(report.loginStatus));

// --- minimal NDJSON JSON-RPC client -------------------------------------------------
const child = spawnResolved(exe, ['app-server']);
const pending = new Map();
const notifications = [];
const garbage = [];
let stderrTail = '';
let nextId = 0;
let buffer = '';
const decoder = new TextDecoder('utf-8'); // streaming: safe for multibyte chars split across chunks

child.stderr.on('data', (d) => (stderrTail = (stderrTail + d).slice(-4000))); // always drain stderr
child.stdout.on('data', (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, '').replace(/^﻿/, '');
    buffer = buffer.slice(newline + 1);
    if (line.trim()) onLine(line);
  }
});

function onLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    garbage.push(line.slice(0, 200)); // a stray log line must never be fatal
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(Object.assign(new Error(message.error.message ?? 'rpc error'), { rpc: message.error }));
    else resolve(message.result);
  } else if (message.method && message.id !== undefined) {
    // Server → client request we don't implement.
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  } else if (message.method) {
    notifications.push(message);
  }
}

const send = (message) => child.stdin.write(JSON.stringify(message) + '\n'); // note: no "jsonrpc" member on the wire
const notify = (method, params = {}) => send({ method, params });
function request(method, params, timeoutMs = 10_000) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send(params === undefined ? { method, id } : { method, id, params });
  return withTimeout(promise, timeoutMs, method);
}

const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
const hasData = (r) => Boolean(r?.rateLimits?.primary || r?.rateLimits?.secondary);

try {
  // Honest client identity (decision 0004) — never impersonate codex_vscode. `capabilities` omitted:
  // nothing we need is behind experimentalApi.
  const t0 = Date.now();
  report.initialize = await request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g (S1 spike)', version: '0.0.0' } });
  notify('initialized');
  report.findings.handshakeMs = Date.now() - t0;

  report.account = await request('account/read', { refreshToken: false });

  const t1 = Date.now();
  const first = await request('account/rateLimits/read');
  report.findings.firstReadMs = Date.now() - t1;
  report.findings.firstReadHadData = hasData(first);
  report.rateLimitsFirst = first;
  if (!hasData(first)) {
    await sleep(750);
    report.rateLimitsRetry = await request('account/rateLimits/read');
    report.findings.retryHadData = hasData(report.rateLimitsRetry);
  }

  const listenMs = Number(args['listen-ms'] ?? 3000);
  await sleep(listenMs);
  report.findings.notificationMethodsSeen = [...new Set(notifications.map((n) => n.method))];
} catch (error) {
  report.error = { message: String(error.message ?? error), rpc: error.rpc };
}

// --- lifecycle: does closing stdin end the process? ----------------------------------
const tClose = Date.now();
child.stdin.end();
const onEof = await Promise.race([exited, sleep(5000).then(() => null)]);
report.findings.exitsOnStdinEof = onEof !== null;
if (onEof) {
  report.findings.exitAfterEofMs = Date.now() - tClose;
  report.findings.exit = onEof;
} else {
  killTree(child.pid);
  const killed = await Promise.race([exited, sleep(5000).then(() => null)]);
  report.findings.treeKillWorked = killed !== null;
}

report.garbageLines = garbage;
report.stderrTail = stderrTail;
report.notifications = notifications;

const file = saveRaw('codex', report);
console.log('\n=== findings ===');
console.log(JSON.stringify(redact(report.findings), null, 2));
console.log('\n=== account (redacted) ===');
console.log(JSON.stringify(redact(report.account ?? null), null, 2));
console.log('\n=== rateLimits (redacted) ===');
console.log(JSON.stringify(redact(report.rateLimitsRetry ?? report.rateLimitsFirst ?? null), null, 2));
if (report.error) console.log('\nERROR:', redact(report.error), '\nstderr tail:', redact(stderrTail));
console.log(`\nRaw UNREDACTED output (gitignored): ${file}`);
process.exit(report.error ? 1 : 0);
