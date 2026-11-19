// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The stalling stand-in (B11, V22, V23): a fake CLI that speaks a minimal line protocol, starts one
// child that ignores termination, and stalls on purpose. It replays no capture, so the fake CLIs of
// S3 stay with M13–M16.
//
//   node stall-cli.mjs --mode <mode> [--ledger <file>]
//
// Modes: stall-startup, stall-request, stall-scenario, stall-shutdown, ok, fail, codexish.
// The ledger is the stand-in's own record of its processes, so a self-test can check them without
// trusting the launcher's bookkeeping.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const option = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const mode = option('mode') ?? 'ok';
const ledgerFile = option('ledger');

// The child ignores every polite request to stop; only a forced end removes it. A ten-minute
// self-destruct keeps a broken self-test from leaving it on the machine for good.
const CHILD = [
  "for (const s of ['SIGINT','SIGTERM','SIGBREAK','SIGHUP']) { try { process.on(s, () => {}); } catch {} }",
  'setInterval(() => {}, 1000);',
  'setTimeout(() => process.exit(0), 600000).unref?.();',
].join('\n');
// Detached: on Windows, Node puts ordinary children in a kill-on-close job object, so they would
// die with the root. A real CLI's descendants can outlive it; this one must too. It still holds
// the stdout pipe, so the spike's side sees the pipes close only when it is gone.
const child = spawn(process.execPath, ['-e', CHILD], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, detached: true });

if (ledgerFile) {
  writeFileSync(ledgerFile, JSON.stringify({ mode, rootPid: process.pid, childPid: child.pid, rootImage: 'node.exe', childImage: 'node.exe', at: new Date().toISOString() }));
}

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) { try { process.on(s, () => {}); } catch { /* unsupported */ } }
setInterval(() => {}, 1000);

const lines = createInterface({ input: process.stdin });
lines.on('close', () => {
  // Every mode but stall-shutdown leaves when stdin closes; the child stays either way.
  if (mode !== 'stall-shutdown') process.exit(0);
});

if (mode === 'codexish') {
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const reply = (result) => send({ id: message.id, result });
    switch (message.method) {
      case 'initialize': reply({ userAgent: 'stand-in/0.0.0', platformFamily: 'windows' }); break;
      case 'config/read':
        // Made up, and deliberately full of things that must never be written (V21).
        reply({
          config: {
            model: 'made-up-model',
            projects: { 'C:\\Users\\planted-user\\Private Project': { trust_level: 'trusted' } },
            mcp_servers: { 'planted-server-name': { command: 'node', env: { API_TOKEN: 'planted-secret-value-4f9a' } } },
            sandbox_mode: 'read-only',
          },
          origins: { model: { name: { type: 'user', file: 'C:\\Users\\planted-user\\.codex\\config.toml' }, version: '1' } },
          layers: [{ name: { type: 'user', file: 'C:\\Users\\planted-user\\.codex\\config.toml' }, version: '1', config: { model: 'made-up-model' } }],
        });
        break;
      case 'thread/start':
        reply({
          thread: { id: '00000000-0000-7000-8000-00000000abcd', cwd: message.params?.cwd ?? null, name: null, preview: '' },
          model: 'made-up-model', modelProvider: 'openai', cwd: message.params?.cwd ?? null,
          approvalPolicy: message.params?.approvalPolicy ?? 'on-request', approvalsReviewer: message.params?.approvalsReviewer ?? 'user',
          sandbox: { type: message.params?.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' }, reasoningEffort: null,
        });
        break;
      default: send({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
    }
  });
} else {
  let ticker;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.op === 'hello') {
      if (mode === 'stall-startup') return;
      send({ op: 'hello-ok' });
      if (mode === 'fail') {
        process.stderr.write('stand-in: failing on purpose after the handshake\n');
        setTimeout(() => process.exit(3), 50);
      }
    } else if (message.op === 'ping') {
      if (mode === 'stall-request') return;
      send({ op: 'pong', id: message.id });
    } else if (message.op === 'go') {
      let n = 0;
      ticker = setInterval(() => {
        send({ op: 'tick', n: n++ });
        if (n === 2 && mode !== 'stall-scenario') {
          clearInterval(ticker);
          send({ op: 'done' });
          if (mode === 'ok') setTimeout(() => process.exit(0), 50);
        }
      }, 150);
    }
  });
}
