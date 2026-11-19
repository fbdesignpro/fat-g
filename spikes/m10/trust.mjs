// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B6: projects and trust (Design 7). Nothing is written to the user's Codex configuration (C28, C29).
//
//   node spikes/m10/trust.mjs [--cli codex|claude] [--path <executable>]
//   node spikes/m10/trust.mjs --cli claude --with-turns --confirm-turns 2    (step 9, only if needed)
//
// Codex, no turn: config/read (reduced before anything is written, C53), thread/start in a folder it
// has never trusted with no sandbox, policy or reviewer, 5 s of listening, config/read again with
// the two compared in memory only.
//
// Claude, marker files: the scratch project carries a settings file with two hooks and one MCP
// server, each of which only writes a marker to a sibling folder outside the project. One run loads
// project sources (the positive control), one is isolated the way tracing is.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeDriver, tracingArgs } from './claude/driver.mjs';
import { CodexDriver } from './codex/driver.mjs';
import { buildCapture, saveRaw } from './lib/capture.mjs';
import { EXIT, sleep } from './lib/deadlines.mjs';
import { cleanEnvironment } from './lib/env.mjs';
import { resolveExecutable } from './lib/executable.mjs';
import { isMain, outputPath, writeJson } from './lib/paths.mjs';
import { buildScratch } from './lib/scratch.mjs';
import { log, runSpike, warn } from './lib/spike.mjs';
import { requireReady } from './preflight.mjs';

const LISTEN_MS = 5_000;
const IDLE_WAIT_MS = 8_000;
const MARKERS = path.join(tmpdir(), 'fat-g-spike-trust-markers');

async function codexTrust({ launcher, waits, signal, executable, cliInfo, selftest }) {
  const { dir } = buildScratch('trust', { 'README.txt': 'A folder Codex has never trusted.\n' });
  const environment = cleanEnvironment('codex');
  const driver = new CodexDriver({ launcher, executable, cwd: dir, env: environment.env, waits, signal });
  const result = { check3: null, configUnchanged: null, reply: null };
  try {
    await driver.open();
    const before = await driver.request('config/read', { includeLayers: false });
    const params = { cwd: dir, ephemeral: true };
    const from = driver.nextIndex;
    const started = await driver.startThread(params);
    await sleep(LISTEN_MS);
    const later = driver.events(from).filter((e) => e.index > started.index);
    const asked = later.filter((e) => e.kind === 'request');
    const errors = later.filter((e) => e.kind === 'error');
    result.check3 = !started.ok ? 'refuses' : asked.length ? 'asks' : errors.length ? 'refuses' : 'runs with defaults';
    result.reply = started.ok ? { sandbox: started.value?.sandbox ?? null, approvalPolicy: started.value?.approvalPolicy ?? null, approvalsReviewer: started.value?.approvalsReviewer ?? null } : { error: started.error?.message ?? 'error' };
    const after = await driver.request('config/read', { includeLayers: false });
    const [hashBefore, hashAfter] = driver.configHashes;
    result.configUnchanged = before.ok && after.ok && hashBefore !== undefined ? hashBefore === hashAfter : null;
    result.requests = asked.map((e) => e.tool);
    result.sessionStart = { request: params, replyIndex: started.index, ok: started.ok };
  } finally {
    const cleanup = await driver.close();
    const capture = buildCapture({ spike: 'trust.mjs', cli: cliInfo, scenario: { id: 'trust-codex', title: 'Session start in a never-trusted folder', successCondition: 'The thread/start reply, then 5 s of listening' }, driver, environment, waits,
      run: { outcome: result.check3 ? 'happened' : 'did-not-happen', turnsSpent: 0, cleanup: { confirmed: cleanup.confirmed, graceful: cleanup.graceful, forced: cleanup.forced }, notes: { check3: result.check3, configUnchanged: result.configUnchanged, reply: result.reply } },
      sessionStart: result.sessionStart ?? null,
      toolPermissions: { note: 'no turn; thread/start without sandbox, approval policy or reviewer, so the reply shows what Codex chooses by itself' },
    });
    if (selftest) writeJson(outputPath('selftest', 'raw', 'codex', 'trust-untrusted-folder.json'), capture);
    else saveRaw('codex', 'trust-untrusted-folder', capture);
    result.cleanupConfirmed = cleanup.confirmed;
  }
  return result;
}

function writeMarkerScripts() {
  if (existsSync(MARKERS)) rmSync(MARKERS, { recursive: true, force: true });
  mkdirSync(MARKERS, { recursive: true });
  writeFileSync(path.join(MARKERS, '.fat-g-spike'), "Marker folder of fat-g's M10 trust spike. Safe to delete.\n");
  // Each script writes one marker and does nothing else.
  writeFileSync(path.join(MARKERS, 'hook.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    "const dir = path.dirname(fileURLToPath(import.meta.url));",
    "writeFileSync(path.join(dir, `marker-hook-${process.argv[2]}.txt`), new Date().toISOString());",
  ].join('\n'));
  writeFileSync(path.join(MARKERS, 'mcp.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "import { createInterface } from 'node:readline';",
    "import { fileURLToPath } from 'node:url';",
    "const dir = path.dirname(fileURLToPath(import.meta.url));",
    "writeFileSync(path.join(dir, 'marker-mcp-server.txt'), new Date().toISOString());",
    '// A minimal MCP server with no tools, so the CLI sees it start cleanly.',
    'createInterface({ input: process.stdin }).on(\'line\', (line) => {',
    '  let m; try { m = JSON.parse(line); } catch { return; }',
    "  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fatg-marker', version: '0.0.0' } } }) + '\\n');",
    "  else if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }) + '\\n');",
    "  else if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }) + '\\n');",
    '});',
  ].join('\n'));
}

function markers() {
  return existsSync(MARKERS) ? readdirSync(MARKERS).filter((name) => name.startsWith('marker-')).map((name) => name.replace(/^marker-|\.txt$/g, '')).sort() : [];
}

function clearMarkers() {
  for (const name of existsSync(MARKERS) ? readdirSync(MARKERS) : []) if (name.startsWith('marker-')) rmSync(path.join(MARKERS, name), { force: true });
}

function trustProject() {
  const node = process.execPath.replace(/\\/g, '/');
  const hook = (event) => ({ hooks: [{ type: 'command', command: `"${node}" "${path.join(MARKERS, 'hook.mjs').replace(/\\/g, '/')}" ${event}` }] });
  return {
    // The one settings file V2's search is expected to find (spikes/README.md).
    '.claude/settings.json': JSON.stringify({ enableAllProjectMcpServers: true, hooks: { SessionStart: [hook('session-start')], UserPromptSubmit: [hook('prompt-submit')] } }, null, 2),
    '.mcp.json': JSON.stringify({ mcpServers: { 'fatg-marker': { type: 'stdio', command: process.execPath, args: [path.join(MARKERS, 'mcp.mjs')] } } }, null, 2),
    'README.txt': 'A project whose settings would run commands. Used by the trust spike only.\n',
  };
}

async function claudeRun({ launcher, waits, signal, executable, cliInfo, name, settingSources, strictMcp, withTurn, dir }) {
  clearMarkers();
  const environment = cleanEnvironment('claude');
  const args = tracingArgs({ tools: ['Read', 'Glob', 'Grep'], settingSources, strictMcp });
  const driver = new ClaudeDriver({ launcher, executable, args, cwd: dir, env: environment.env, waits, signal });
  driver.onRequest(() => ({ decision: 'deny' }));
  const run = { name, settingSources, strictMcp, turns: 0, markers: [], mcpServers: null };
  try {
    await driver.open();
    await sleep(IDLE_WAIT_MS);
    const status = await driver.request('mcp_status', {});
    const servers = status.ok && Array.isArray(status.value?.mcpServers) ? status.value.mcpServers : [];
    run.mcpServers = { ours: servers.filter((s) => s?.name === 'fatg-marker').map((s) => s.status ?? null), others: servers.filter((s) => s?.name !== 'fatg-marker').length };
    if (withTurn) {
      const from = driver.nextIndex;
      run.turns++;
      await driver.prompt('Reply with the single word ok.');
      await driver.waitEvent((e) => e.kind === 'turn-end', { wait: 'scenario', from });
      await sleep(2_000);
    }
  } finally {
    const cleanup = await driver.close();
    run.markers = markers();
    run.cleanupConfirmed = cleanup.confirmed;
    const capture = buildCapture({ spike: 'trust.mjs', cli: cliInfo, scenario: { id: `trust-claude-${name}`, title: `Project settings, ${name}`, successCondition: 'Markers listed after an idle session' + (withTurn ? ' and one turn' : '') }, driver, environment, waits,
      run: { outcome: 'happened', turnsSpent: run.turns, cleanup: { confirmed: cleanup.confirmed, graceful: cleanup.graceful, forced: cleanup.forced }, notes: { markers: run.markers, mcpServers: run.mcpServers } },
      sessionStart: { request: { subtype: 'initialize' } },
      toolPermissions: { readTools: ['Read', 'Glob', 'Grep'], scenarioTools: [], preApproved: [], permissionMode: 'default', settingSources, strictMcpConfig: strictMcp },
    });
    saveRaw('claude', `trust-${name}${withTurn ? '.with-turn' : ''}`, capture);
  }
  return run;
}

async function claudeTrust(context, withTurns) {
  writeMarkerScripts();
  const { dir } = buildScratch('trust', trustProject());
  const positive = await claudeRun({ ...context, dir, name: 'positive-control', settingSources: 'project', strictMcp: false, withTurn: withTurns });
  const isolated = await claudeRun({ ...context, dir, name: 'isolated', settingSources: '', strictMcp: true, withTurn: withTurns });
  const expected = ['hook-session-start', 'mcp-server'];
  const controlComplete = expected.every((m) => positive.markers.includes(m));
  return {
    positive, isolated,
    controlShowedMarkers: positive.markers.length > 0,
    controlComplete,
    isolatedFinding: isolated.markers.length > 0 ? `FINDING against the app's own isolation: the isolated run wrote ${isolated.markers.join(', ')}` : positive.markers.length > 0 ? 'the isolated run wrote no marker, and the positive control shows the markers can appear' : "the isolated run wrote no marker, but neither did the positive control, so the isolated run's silence proves nothing",
    turnPartNeeded: !withTurns && !controlComplete,
  };
}

async function trust({ args, launcher, signal, waits }) {
  const which = args.cli ? [args.cli] : ['codex', 'claude'];
  const withTurns = Boolean(args['with-turns']);
  if (withTurns && (which.length !== 1 || which[0] !== 'claude')) { warn('--with-turns is for --cli claude only'); return EXIT.error; }
  if (withTurns && Number(args['confirm-turns']) !== 2) {
    log('plan: the Claude trust spike with one prompt per run, 2 turns in all. Nothing launched; re-run with --confirm-turns 2.');
    return EXIT.happened;
  }
  const report = { date: new Date().toISOString() };
  for (const cli of which) {
    const executable = resolveExecutable(cli, which.length === 1 ? args.path : undefined);
    const probe = buildScratch('probe');
    // --selftest: the stand-in of V21 answers no --version; its outputs go under selftest/.
    const cliInfo = args.selftest ? { name: cli, version: 'stand-in', kind: executable.kind } : await requireReady(launcher, waits, cli, executable, probe.dir);
    const context = { launcher, waits, signal, executable, cliInfo, selftest: Boolean(args.selftest) };
    report[cli] = { version: cliInfo.version, ...(cli === 'codex' ? await codexTrust(context) : await claudeTrust(context, withTurns)) };
  }
  writeJson(args.selftest ? outputPath('selftest', 'trust.json') : outputPath(withTurns ? 'trust-with-turns.json' : 'trust.json'), report);
  log(JSON.stringify(report, null, 2));
  return EXIT.happened;
}

if (isMain(import.meta.url)) await runSpike('trust', trust);
