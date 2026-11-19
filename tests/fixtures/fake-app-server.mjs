// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'rpc';
const pidFile = process.argv[3];
// Identity is the PID plus this process's start time (PIDs are recycled); a normal exit is
// recorded beside the ledger, so only processes that had to be killed need proving gone.
const started = Date.now();
if (pidFile && mode !== 'args' && mode !== 'env') {
  appendFileSync(pidFile, `${process.pid} ${started}\n`);
  process.on('exit', () => appendFileSync(`${pidFile}.exited`, `${process.pid} ${started}\n`));
}
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (mode === 'args') { output(process.argv.slice(3)); process.exit(0); }
// Report modes: say what arrived, then behave like a CLI that exits on EOF — or not.
if (mode === 'env') {
  output({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(3), env: process.env });
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
} else if (mode === 'stuck' || mode === 'stuck-tree') {
  // Ignores EOF. The descendant holds no pipe, so only a tree kill can reach it. On Windows it is
  // detached from this Node process's kill-on-close job, which would otherwise take it down with
  // the root and make a root-only kill look like a tree kill; it keeps its parent PID for taskkill /T.
  const descendant = mode === 'stuck-tree'
    ? spawn(process.execPath, [import.meta.filename, 'descendant', ...(pidFile ? [pidFile] : [])], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' })
    : undefined;
  process.stdin.resume();
  process.stdin.on('end', () => {});
  output({ pid: process.pid, descendant: descendant?.pid });
  setInterval(() => {}, 1000);
}
if (mode === 'nonzero') { output({ ok: false }); process.exit(7); }
// More than any total limit in play (5 MiB), a line of 64 KiB at a time, then alive until its input closes.
if (mode === 'stream') {
  const line = `${JSON.stringify({ filler: 'x'.repeat(64 * 1024 - 16) })}\n`;
  const total = 5 * 1024 * 1024;
  let written = 0;
  const pump = () => {
    while (written < total) {
      written += line.length;
      if (!process.stdout.write(line)) { process.stdout.once('drain', pump); return; }
    }
    output({ done: true, pid: process.pid, bytes: written });
  };
  pump();
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
}
if (mode === 'flood') { process.stdout.write('x'.repeat(2 * 1024 * 1024)); }
if (mode === 'stderr') { process.stderr.write('private-email-secret'.repeat(100000)); output({ drained: true }); }
if (mode === 'descendant') {
  process.on('SIGTERM', () => {});
  output({ method: 'descendant', params: { pid: process.pid } });
  setInterval(() => {}, 1000);
} else if (['rpc', 'tree', 'leader-exit'].includes(mode)) {
  let descendant;
  if (mode !== 'rpc') {
    descendant = spawn(process.execPath, [import.meta.filename, 'descendant', ...(pidFile ? [pidFile] : [])], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  }
  const reader = createInterface({ input: process.stdin });
  reader.on('line', (line) => {
    const message = JSON.parse(line);
    const { id, method, params } = message;
    if (id === undefined) { if (method === 'initialized') output({ method: 'ready', params: true }); return; }
    const response = { id, result: params ?? null };
    if (method === 'initialize') response.result = { pid: process.pid, descendant: descendant?.pid };
    if (method === 'hang') return;
    if (method === 'crash') { process.exit(3); }
    if (method === 'leader-exit') { process.exit(0); }
    if (method === 'error') { output({ id, error: { code: 42, message: 'private@example.test', data: 'secret' } }); return; }
    if (method === 'final' || method === 'final-no-newline') {
      process.stdout.write(JSON.stringify(response) + (method === 'final' ? '\n' : ''), () => process.exit(0)); return;
    }
    if (method === 'fragment') {
      process.stdout.write('garbage\n');
      const bytes = Buffer.from(JSON.stringify(response) + '\r\n');
      for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
      return;
    }
    if (method === 'delay') { setTimeout(() => output(response), params.delayMs); return; }
    output(response);
  });
  reader.on('close', () => process.exit(0));
} else if (mode === 'hang') { setInterval(() => {}, 1000); }
