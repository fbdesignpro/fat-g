// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M7b step 2: record what the Agent SDK (0.3.278, fat-g's M7 options) sends to the CLI, so fat-g's
// own client can be tested against the official client's wire behavior after the SDK is removed.
// The counterparty is tests/fixtures/fake-claude-cli.mjs — no real CLI, config or account is used —
// so the capture contains only synthetic data and is committed as a fixture.
//
//   npm install --prefix spikes      (once; the spike keeps its own SDK copy)
//   node spikes/capture-sdk-wire.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'fake-claude-cli.mjs');
const OUTPUT = path.join(ROOT, 'tests', 'fixtures', 'claude', 'sdk-0.3.278-wire.json');

// Nothing inherited from a parent Claude session or a debugging shell may shape the capture.
for (const name of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC|DEBUG)/i.test(name)) delete process.env[name];
const { query } = await import('@anthropic-ai/claude-agent-sdk');
const sdkVersion = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), 'package.json'), 'utf8')).version;
if (sdkVersion !== '0.3.278') throw new Error(`expected SDK 0.3.278, found ${sdkVersion}`);

const dir = mkdtempSync(path.join(tmpdir(), 'fatg-wire-'));
writeFileSync(path.join(dir, 'control.json'), '{}');
let spawnRequest;
let written = '';
let child;
let childExit;

const controller = new AbortController();
let release;
const released = new Promise((resolve) => { release = resolve; });
const done = { done: true, value: undefined };
const idle = { [Symbol.asyncIterator]: () => ({ next: () => released.then(() => done), return: () => { release(); return Promise.resolve(done); } }) };

const q = query({
  prompt: idle,
  options: {
    // Any absolute native executable makes the SDK pass its arguments without a script path; the
    // hook below runs the fixture instead, so what we record is exactly what a real CLI would get.
    pathToClaudeCodeExecutable: process.execPath,
    cwd: dir,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    env: {},
    abortController: controller,
    spawnClaudeCodeProcess: (request) => {
      spawnRequest = request;
      child = spawn(process.execPath, [FIXTURE, '--fixture-dir', dir, ...request.args], { cwd: dir, env: { ...process.env, ...request.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      childExit = new Promise((resolve) => child.on('close', resolve));
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => { written += String(chunk); return write(chunk, ...rest); };
      return child;
    },
  },
});
const drained = (async () => { try { for await (const message of q) void message; } catch { /* closed */ } })();
const account = await q.accountInfo();
const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
release();
q.close();
await Promise.race([childExit, new Promise((resolve) => setTimeout(resolve, 5000))]);
await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 1000))]);
rmSync(dir, { recursive: true, force: true });

// Request IDs are random per run: replace them, in order of appearance, with stable placeholders.
const ids = new Map();
const frames = written.split('\n').filter(Boolean).map((line) => {
  const frame = JSON.parse(line);
  if (typeof frame.request_id === 'string') {
    if (!ids.has(frame.request_id)) ids.set(frame.request_id, `<request-${ids.size + 1}>`);
    frame.request_id = ids.get(frame.request_id);
  }
  return frame;
});
const REVIEWED = new Set(['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION']);
const envAdded = Object.fromEntries(Object.entries(spawnRequest.env).filter(([, value]) => value !== undefined)
  .map(([name, value]) => [name, REVIEWED.has(name) ? value : '<unreviewed: value not recorded>']));

writeFileSync(OUTPUT, `${JSON.stringify({
  _fixture: {
    source: 'synthetic',
    note: 'Wire behavior of @anthropic-ai/claude-agent-sdk 0.3.278 with fat-g\'s M7 session options, captured by spikes/capture-sdk-wire.mjs against tests/fixtures/fake-claude-cli.mjs (no real CLI, config or account). The reference for M7b\'s own client: same arguments and frames, but WITHOUT the SDK\'s identity variables in envAdded. Request IDs are placeholders.',
  },
  sdkVersion,
  options: { settingSources: [], strictMcpConfig: true, mcpServers: {}, persistSession: false, env: {} },
  spawn: { commandIsConfiguredExecutable: spawnRequest.command === process.execPath, args: spawnRequest.args, envAdded },
  frames,
  sawAccount: account !== null && typeof account === 'object',
  sawUsage: usage !== null && typeof usage === 'object',
}, null, 2)}\n`);
console.log(`wrote ${path.relative(ROOT, OUTPUT)}: ${frames.length} frames, args ${JSON.stringify(spawnRequest.args)}, env ${JSON.stringify(Object.keys(envAdded))}`);
