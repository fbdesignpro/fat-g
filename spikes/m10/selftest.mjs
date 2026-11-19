// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B11: every self-test of the M10 helpers. Launches no real CLI: only the stalling stand-in, through
// node.exe and through a .cmd shim (the two launch kinds of the real CLIs). Prints a pass/fail
// table, writes it under spikes/output/m10/selftest/, and exits non-zero on any failure. No real CLI
// is launched by any spike until this passes.
//
//   node spikes/m10/selftest.mjs [--only <row id prefix>]
//   node spikes/m10/selftest.mjs --ctrl-c      (the manual check: press Ctrl+C once; expect exit 130)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { CLAUDE_TABLE } from './claude/frames.mjs';
import { createCancellation } from './lib/cancel.mjs';
import { EXIT, deadlines } from './lib/deadlines.mjs';
import { APP_CLAUDE_POLICY } from './lib/env.mjs';
import { LAUNCH_RECORD, LaunchRecord, RecordedProcessRunning, checkLaunchRecord } from './lib/launch-record.mjs';
import { LaunchRefused, Launcher } from './lib/launcher.mjs';
import { leakCheck } from './lib/leak-check.mjs';
import { M10_DIR, OUTPUT_DIR, REPO_ROOT, isMain, outputPath, parseArgs, stamp, writeJson } from './lib/paths.mjs';
import { forceEnd, listProcesses } from './lib/proctree.mjs';
import { createRedactor } from './lib/redactor.mjs';
import { scratchPath } from './lib/scratch.mjs';
import { runStandIn } from './standin/line-driver.mjs';

const STANDIN = path.join(M10_DIR, 'standin', 'stall-cli.mjs');
const SELFTEST_DIR = outputPath('selftest', '.keep').replace(/\.keep$/, '');
const WAITS = deadlines({ startup: 3_000, request: 2_000, scenario: 3_000, shutdown: 12_000 });
const rows = [];

function row(id, requirement, pass, detail = '') {
  rows.push({ id, requirement, result: pass ? 'PASS' : 'FAIL', detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(22)} ${requirement}${detail ? `  — ${detail}` : ''}`);
}

function ledgerFile(name) { return path.join(SELFTEST_DIR, 'ledgers', `${name}.json`); }

function shimFor(mode, ledger) {
  const file = path.join(SELFTEST_DIR, 'shims', `stall-${mode}.cmd`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `@echo off\r\n"${process.execPath}" "${STANDIN}" --mode ${mode} --ledger "${ledger}" %*\r\n`);
  return file;
}

function launchOf(kind, mode, ledger) {
  if (kind === 'shim') return { executable: { path: shimFor(mode, ledger), kind: 'shim' }, args: [] };
  return { executable: { path: process.execPath, kind: 'native' }, args: [STANDIN, '--mode', mode, '--ledger', ledger] };
}

/** V22: from the stand-in's own ledger, never the launcher's bookkeeping. */
async function standInAlive(ledger) {
  if (!existsSync(ledger)) return { known: false, alive: [] };
  const entry = JSON.parse(readFileSync(ledger, 'utf8'));
  const listing = await listProcesses();
  const alive = [];
  for (const [role, pid] of [['root', entry.rootPid], ['child', entry.childPid]]) {
    const p = listing.get(pid);
    if (p && p.name.toLowerCase() === 'node.exe' && (!p.start || p.start <= entry.at)) alive.push({ role, pid });
  }
  return { known: true, alive, entry };
}

async function killStandIn(ledger) {
  const { alive } = await standInAlive(ledger);
  for (const p of alive) await forceEnd(p.pid, { tree: true });
}

// ---------------------------------------------------------------------------------------------

function testPolicyTable() {
  const text = readFileSync(path.join(REPO_ROOT, 'src', 'main', 'providers', 'claude', 'environment.ts'), 'utf8');
  const listIn = (name) => {
    const match = new RegExp(`${name}:\\s*\\[([\\s\\S]*?)\\]`).exec(text);
    return match ? [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : null;
  };
  const debug = /DEBUG_LOGGING_VARIABLES = \[([\s\S]*?)\]/.exec(text);
  const debugNames = debug ? [...debug[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const removeNames = (listIn('removeNames') ?? []).concat(/\.\.\.DEBUG_LOGGING_VARIABLES/.test(text) ? debugNames : []);
  const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
  const checks = {
    keepNames: same(listIn('keepNames'), APP_CLAUDE_POLICY.keepNames),
    keepPrefixes: same(listIn('keepPrefixes'), APP_CLAUDE_POLICY.keepPrefixes),
    removePrefixes: same(listIn('removePrefixes'), APP_CLAUDE_POLICY.removePrefixes),
    removeNames: same(removeNames, APP_CLAUDE_POLICY.removeNames),
  };
  row('C9 policy table', 'lib/env.mjs lists equal environment.ts, read as text', Object.values(checks).every(Boolean), Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => `${k} differs`).join(', '));
}

const EXPECT = {
  'stall-startup': { outcome: 'timed-out', wait: 'startup' },
  'stall-request': { outcome: 'timed-out', wait: 'request' },
  'stall-scenario': { outcome: 'timed-out', wait: 'scenario' },
  'stall-shutdown': { outcome: 'happened', teardownWait: 'shutdown', forced: true },
  ok: { outcome: 'happened', rootGoneFirst: true },
  fail: { outcome: 'cli-exited' },
};

async function testStandInMatrix(kinds) {
  for (const kind of kinds) {
    for (const [mode, expect] of Object.entries(EXPECT)) {
      const ledger = ledgerFile(`${kind}-${mode}`);
      rmSync(ledger, { force: true });
      const launcher = new Launcher({ spike: 'selftest', waits: WAITS });
      const { executable, args } = launchOf(kind, mode, ledger);
      const result = await runStandIn({ launcher, executable, args, cwd: tmpdir(), waits: WAITS });
      const { alive, known } = await standInAlive(ledger);
      const problems = [];
      if (result.outcome !== expect.outcome) problems.push(`outcome ${result.outcome}${result.error ? ` (${result.error.split('\n')[0]})` : ''}`);
      if (expect.wait && result.expiredWait !== expect.wait) problems.push(`expired wait ${result.expiredWait}`);
      if (expect.teardownWait && result.cleanup.expiredWait !== expect.teardownWait) problems.push(`teardown wait ${result.cleanup.expiredWait}`);
      if (expect.forced && !result.cleanup.forced) problems.push('not forced');
      if (expect.rootGoneFirst && !result.rootExitedBeforeTeardown) problems.push('root still running at teardown');
      if (!result.cleanup.confirmed) problems.push('cleanup not confirmed');
      if (!known) problems.push('stand-in ledger missing');
      if (alive.length) problems.push(`still running: ${alive.map((p) => p.role).join(', ')}`);
      if (existsSync(LAUNCH_RECORD)) problems.push('launch record left behind');
      row(`V22 ${kind} ${mode}`, `${expect.wait ? `timeout names the ${expect.wait} wait` : expect.teardownWait ? 'shutdown wait expires, forced path' : mode === 'ok' ? 'cleanup after success, root already gone' : 'cleanup after failure'}; neither process left`, problems.length === 0, problems.join('; ') || `${result.cleanup.ms} ms teardown`);
      if (alive.length) await killStandIn(ledger);
    }
  }
}

async function testCancellation() {
  const ledger = ledgerFile('cancel');
  rmSync(ledger, { force: true });
  const cancellation = createCancellation({ budgetMs: 0 });
  const launcher = new Launcher({ spike: 'selftest', waits: deadlines({ ...WAITS, scenario: 30_000 }) });
  const { executable, args } = launchOf('native', 'stall-scenario', ledger);
  const timer = setTimeout(() => cancellation.cancel('cancelled in code by the self-test'), 3_500);
  const result = await runStandIn({ launcher, executable, args, cwd: tmpdir(), waits: launcher.waits, signal: cancellation.signal });
  clearTimeout(timer);
  cancellation.dispose();
  const { alive } = await standInAlive(ledger);
  row('V23 cancellation', 'the abort path cleans up and confirms the tree gone', result.outcome === 'cancelled' && result.cleanup.confirmed && alive.length === 0, `outcome ${result.outcome}, cleanup ${result.cleanup.confirmed ? 'confirmed' : 'not confirmed'}, ${alive.length} left`);
  if (alive.length) await killStandIn(ledger);
}

async function testRetryGate() {
  const ledger = ledgerFile('retry-gate');
  rmSync(ledger, { force: true });
  const recordFile = path.join(SELFTEST_DIR, 'retry-gate-launched.json');
  // Its start time is set once the root is up: a "child" older than its parent is no child.
  const ghost = { pid: 999999999, ppid: null, start: null, name: 'ghost-selftest.exe' };
  let rootPid = null;
  // A lister that keeps reporting a descendant that never goes away. Its pid is not a multiple of
  // four, so it can never be a real Windows process, and ending it is harmless.
  const lister = async () => {
    const listing = await listProcesses();
    if (rootPid) listing.set(ghost.pid, { ...ghost, ppid: rootPid });
    return listing;
  };
  const waits = deadlines({ ...WAITS, shutdown: 5_000 });
  const launcher = new Launcher({ spike: 'selftest', lister, waits, record: new LaunchRecord('selftest', recordFile) });
  const { executable, args } = launchOf('native', 'ok', ledger);
  const result = await runStandIn({ launcher, executable, args, cwd: tmpdir(), waits, onStarted: (session) => { rootPid = session.tree.pid; ghost.start = new Date().toISOString(); } });
  let refused = null;
  let second = null;
  try { second = await launcher.launch({ executable, args, cwd: tmpdir(), env: process.env }); } catch (error) { refused = error; }
  // Should the gate ever fail, the tree it let through must not outlive the self-test.
  if (second) { launcher.lister = listProcesses; await second.teardown(); }
  const named = refused instanceof LaunchRefused && refused.message.includes('ghost-selftest.exe');
  const { alive } = await standInAlive(ledger);
  row('V23 no retry', 'an unconfirmed tree refuses the next launch and names the process', !result.cleanup.confirmed && named && alive.length === 0, refused ? refused.message.slice(0, 100) : 'the launch was not refused');
  rmSync(recordFile, { force: true });
  if (alive.length) await killStandIn(ledger);
}

/** Run with --child-spike: launch the stand-in, record its tree, say READY, then wait to be killed. */
async function childSpike(args) {
  const launcher = new Launcher({ spike: 'selftest-child', record: new LaunchRecord('selftest-child', args['record-file']), waits: deadlines({ ...WAITS, scenario: 60_000 }) });
  const { executable, args: launchArgs } = launchOf('native', 'stall-scenario', args.ledger);
  runStandIn({ launcher, executable, args: launchArgs, cwd: tmpdir(), waits: launcher.waits, onStarted: (session) => {
    session.waitFor((f) => f.op === 'hello-ok', { wait: 'startup' }).then(() => session.tree.record('selftest')).then(() => console.log('READY'));
  } });
  setInterval(() => {}, 1_000);
}

async function testRecordedSurvivor() {
  const ledger = ledgerFile('survivor');
  const recordFile = path.join(SELFTEST_DIR, 'survivor-launched.json');
  rmSync(ledger, { force: true });
  rmSync(recordFile, { force: true });
  const child = spawn(process.execPath, [path.join(M10_DIR, 'selftest.mjs'), '--child-spike', '--record-file', recordFile, '--ledger', ledger], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    createInterface({ input: child.stdout }).on('line', (line) => { if (line.includes('READY')) { clearTimeout(timer); resolve(true); } });
  });
  // Ended from outside, without its tree (an agent's tool time limit, a closed terminal).
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  let caught = null;
  if (ready) { try { await checkLaunchRecord({ file: recordFile }); } catch (error) { caught = error; } }
  const { alive } = await standInAlive(ledger);
  const named = caught instanceof RecordedProcessRunning && alive.every((p) => caught.processes.some((q) => q.pid === p.pid));
  row('V23 recorded process', 'the next spike stops and names the survivor, ending nothing', ready && named && alive.length > 0, caught ? caught.message.slice(0, 110) : ready ? 'the check did not stop' : 'the child spike never became ready');
  await killStandIn(ledger);
  rmSync(recordFile, { force: true });
}

async function runScript(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(M10_DIR, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

async function testMissingExecutable() {
  const missing = path.join(tmpdir(), 'fat-g-selftest-missing', 'claude.exe');
  const cases = [
    ['preflight.mjs', ['--cli', 'claude']], ['schema.mjs', []], ['discover.mjs', ['--cli', 'claude']],
    ['trace.mjs', ['--cli', 'claude', '--scenario', 't1']], ['trust.mjs', ['--cli', 'codex']],
    ['usage.mjs', ['--label', 'before', '--cli', 'claude']], ['history.mjs', ['--cli', 'codex']], ['publish.mjs', ['--cli', 'claude']],
  ];
  for (const [script, args] of cases) {
    const before = existsSync(LAUNCH_RECORD);
    const { code, out } = await runScript(script, [...args, '--path', missing]);
    const message = /does not exist|not found/i.test(out);
    const left = !before && existsSync(LAUNCH_RECORD);
    row(`V6 ${script}`, 'a missing executable stops with a message and leaves no record', code === EXIT.cliMissing && message && !left, `exit ${code}${message ? '' : ', no message'}${left ? ', record left' : ''}`);
  }
}

function syntheticRaw() {
  const scratch = scratchPath('trace');
  const session = '5b6c7d8e-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
  const worker = 'a1b2c3d4e5';
  return {
    session, worker, scratch,
    raw: {
      _fixture: { source: 'self-test' }, format: 'fat-g.capture/1',
      cli: { name: 'claude', version: '9.9.9', launchKind: 'native' }, date: new Date().toISOString(),
      scenario: { id: 't0', title: 'synthetic', successCondition: 'none' }, run: { outcome: 'happened' },
      launch: { args: ['--output-format', 'stream-json'], cwd: scratch }, sessionStart: { request: { subtype: 'initialize' } },
      toolPermissions: { readTools: ['Read'] }, environment: { removed: [{ name: 'CLAUDECODE', appWouldHaveKept: false }], set: [] },
      deadlines: { startup: 1 }, deltas: { requested: false, dropped: 0, byType: {} },
      frames: [
        { index: 0, dir: 'send', ms: 1, frame: { type: 'control_request', request_id: 'm10-1', request: { subtype: 'initialize' } } },
        { index: 1, dir: 'recv', ms: 5, frame: { type: 'control_response', response: { subtype: 'success', request_id: 'm10-1', response: { account: { email: 'planted@example.org', organization: 'Planted Org' }, commands: [{ name: 'my-private-skill' }, { name: 'clear' }], models: [] } } } },
        { index: 2, dir: 'recv', ms: 9, frame: { type: 'system', subtype: 'init', session_id: session, cwd: scratch, tools: ['Read', 'mcp__my-private-server__lookup'], skills: ['my-private-skill'], mcp_servers: [{ name: 'my-private-server', status: 'connected' }], model: 'claude-model', permissionMode: 'default', uuid: '0f1e2d3c-4b5a-4968-8776-655443322110' } },
        { index: 3, dir: 'recv', ms: 12, frame: { type: 'system', subtype: 'task_started', task_id: worker, session_id: session, description: 'read notes', uuid: '11111111-2222-4333-8444-555555555555' } },
        { index: 4, dir: 'recv', ms: 15, frame: { type: 'assistant', session_id: session, parent_tool_use_id: null, uuid: '21111111-2222-4333-8444-555555555555', message: { id: 'msg_01ABCDEFGHJKLMNPQRST', role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU=' }, { type: 'tool_use', id: 'toolu_01ABCDEFGHJKLMNPQRS', name: 'Read', input: { file_path: `${scratch}\\sample.txt` } }, { type: 'text', text: `Home is ${homedir()} and the user is ${userInfo().username}; also /c/Users/${userInfo().username}/x and ${scratch.replace(/\\/g, '/')}/notes-1.txt` }] } } },
        { index: 5, dir: 'recv', ms: 20, frame: { type: 'result', subtype: 'success', session_id: session, result: 'The cat is Biscuit.', uuid: '31111111-2222-4333-8444-555555555555', is_error: false } },
      ],
    },
  };
}

function testLeakCheck() {
  const { raw, session, worker, scratch } = syntheticRaw();
  const thread = '0199aabb-ccdd-7eef-8011-223344556677';
  const secrets = [{ kind: 'account id', value: 'acct-5c1d9e2f7a' }, { kind: 'organization id', value: 'org-8b3e1f0a64' }];
  const rawForCheck = { ...raw, sideband: { threadId: thread } };
  const redactor = createRedactor({ cli: 'claude', table: CLAUDE_TABLE, scratchDirs: [scratch], sessionIds: [session] });
  const { capture } = redactor.redactCapture(raw);
  const clean = JSON.stringify(capture, null, 2);
  const base = leakCheck(clean, { cli: 'claude', raw: rawForCheck, secrets, scratchDirs: [scratch] });
  row('V3 clean capture', 'a redacted synthetic capture passes the leak check', base.ok, base.ok ? '' : base.failures.map((f) => `${f.kind} ${f.sample}`).join('; '));
  const plants = [
    ['email', 'someone.else@example.net'], ['account id', 'acct-5c1d9e2f7a'], ['organization id', 'org-8b3e1f0a64'],
    ['home folder', path.join(homedir(), 'Documents')], ['user name', `by ${userInfo().username} today`], ['session id', session],
    ['thread id', thread], ['worker id', worker], ['absolute path', 'D:\\Somewhere\\else.txt'], ['configured-item name', 'my-private-skill'],
    ['host name', `on ${hostname()} now`],
  ];
  for (const [kind, value] of plants) {
    const planted = clean.replace('"The cat is Biscuit."', JSON.stringify(`The cat is Biscuit. ${value}`));
    const result = leakCheck(planted, { cli: 'claude', raw: rawForCheck, secrets, scratchDirs: [scratch] });
    row(`V3 planted ${kind}`, 'the leak check fails naming that kind', !result.ok && result.failures.some((f) => f.kind === kind), result.failures.map((f) => f.kind).join(', ') || 'passed');
  }
  const aliases = [...clean.matchAll(/<(session|worker)-\d+>/g)].map((m) => m[0]);
  row('V20 aliases', 'session and worker aliases differ and are stable', new Set(aliases.filter((a) => a.startsWith('<session'))).size === 1 && new Set(aliases.filter((a) => a.startsWith('<worker'))).size === 1, [...new Set(aliases)].join(' '));
}

function testUnknownFrame() {
  const { raw, scratch } = syntheticRaw();
  raw.frames.push({ index: 6, dir: 'recv', ms: 30, frame: { type: 'made_up_type', secret_field: 'x@y.example', nested: { deep: 'C:\\private\\thing' } } });
  const { capture, report } = createRedactor({ cli: 'claude', table: CLAUDE_TABLE, scratchDirs: [scratch] }).redactCapture(raw);
  const reduced = capture.frames.at(-1).frame;
  const ok = reduced.type === 'made_up_type' && JSON.stringify(reduced.keys) === JSON.stringify(['nested', 'secret_field', 'type']) && !JSON.stringify(reduced).includes('private') && report.untabledTypes.made_up_type === 1;
  row('V26 unknown frame', 'an untabled frame keeps its type and key names only, and is reported', ok, JSON.stringify(reduced));
}

function filesSince(dir, since) {
  const out = [];
  const walk = (d) => {
    for (const entry of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).mtimeMs >= since) out.push(full);
    }
  };
  walk(dir);
  return out;
}

async function testConfigReduction() {
  const ledger = ledgerFile('codexish');
  rmSync(ledger, { force: true });
  const shim = shimFor('codexish', ledger);
  const since = Date.now() - 1_000;
  const { code, out } = await runScript('trust.mjs', ['--cli', 'codex', '--path', shim, '--selftest']);
  const planted = ['planted-user', 'Private Project', 'planted-server-name', 'planted-secret-value-4f9a'];
  const written = filesSince(OUTPUT_DIR, since).filter((f) => !f.includes(`${path.sep}shims${path.sep}`));
  const hits = written.filter((f) => { const text = readFileSync(f, 'utf8'); return planted.some((p) => text.includes(p)); });
  const rawFile = written.find((f) => f.endsWith('trust-untrusted-folder.json'));
  let levels = false;
  if (rawFile) {
    const capture = JSON.parse(readFileSync(rawFile, 'utf8'));
    const reduced = capture.frames.map((f) => f.frame?.result).filter((r) => r?._reduced && r.config);
    levels = reduced.length === 2 && reduced.every((r) => Object.keys(r).sort().join() === '_reduced,config,reply' && Object.values(r.config).every((v) => typeof v.type === 'string' && Object.keys(v).every((k) => k === 'type' || k === 'count')));
  }
  const { alive } = await standInAlive(ledger);
  row('V21 config/read', 'the trust spike writes no planted path, server name or secret', code === 0 && hits.length === 0 && written.length > 0 && alive.length === 0, `exit ${code}; ${written.length} file(s) written; ${hits.length ? `found in ${hits.map((f) => path.basename(f)).join(', ')}` : 'none found'}${code === 0 ? '' : `; ${out.split('\n').slice(-3).join(' ')}`}`);
  row('V29 reduction shape', 'reduced replies hold two levels of key names, types and counts only', levels, rawFile ? '' : 'no raw capture found');
  if (alive.length) await killStandIn(ledger);
}

function codeFiles() {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|cjs|js|html)$/.test(entry.name)) out.push(full);
    }
  };
  walk(M10_DIR);
  return out;
}

/** V2 and V27 as text searches, with the expected hits named in spikes/README.md. */
function testTextSearches() {
  const files = codeFiles();
  const self = path.join(M10_DIR, 'selftest.mjs');
  const hits = (pattern, skipSelf = true) => files.filter((f) => !(skipSelf && f === self)).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((line, i) => ({ file: path.relative(M10_DIR, f).split(path.sep).join('/'), line: i + 1, text: line })).filter((l) => pattern.test(l.text)));
  const sdk = hits(new RegExp(['@anthropic', '-ai/'].join('') + '|' + ['claude-agent', '-sdk'].join('')));
  row('V2 no SDK import', 'no Agent SDK package is imported or named', sdk.length === 0, sdk.map((h) => `${h.file}:${h.line}`).join(', '));
  const leaving = [];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!target.startsWith(M10_DIR + path.sep)) leaving.push(`${path.relative(M10_DIR, file)} → ${match[1]}`);
    }
  }
  row('V2 imports stay inside', 'no import leaves spikes/m10/', leaving.length === 0, leaving.join(', '));
  const folders = hits(new RegExp(['\\.claude', '[\\\\/]|\\.codex', '[\\\\/]|credentials\\.json|auth\\.json|\\.claude\\.json|keychain'].join(''), 'i'));
  // Expected: the trust project's own settings file, and the made-up paths the stand-in plants for V21.
  const expectedFolders = folders.every((h) => (h.file === 'trust.mjs' && h.text.includes("'.claude/settings.json'")) || (h.file === 'standin/stall-cli.mjs' && h.text.includes('planted-user')));
  row('V2 no CLI folder read', 'hits are only the trust project\'s settings file and the stand-in\'s planted paths', expectedFolders, folders.map((h) => `${h.file}:${h.line}`).join(', '));
  const identity = hits(new RegExp([['CLAUDE_CODE', 'ENTRYPOINT'].join('_'), ['CLAUDE_AGENT', 'SDK_VERSION'].join('_')].join('|')));
  row('V2 no identity variable', 'the only hit is the list lib/env.mjs asserts absent', identity.every((h) => h.file === 'lib/env.mjs' && /SDK_IDENTITY_VARIABLES/.test(h.text)), identity.map((h) => `${h.file}:${h.line}`).join(', '));
  const cmdline = hits(new RegExp([['Command', 'Line'].join(''), '/proc/[^\'"]*/cmdline', '\\bwmic\\b', "-o['\",\\s]+(args|command)\\b"].join('|'), 'i'));
  row('V27 no command line', 'no process command line is ever read', cmdline.length === 0, cmdline.map((h) => `${h.file}:${h.line}`).join(', '));
}

async function manualCtrlC() {
  const ledger = ledgerFile('ctrl-c');
  const cancellation = createCancellation({ budgetMs: 0 });
  const launcher = new Launcher({ spike: 'selftest', waits: deadlines({ ...WAITS, scenario: 120_000 }) });
  const { executable, args } = launchOf('native', 'stall-scenario', ledger);
  console.log('Stand-in running. Press Ctrl+C once; expect a clean-up line and exit code 130.');
  const result = await runStandIn({ launcher, executable, args, cwd: tmpdir(), waits: launcher.waits, signal: cancellation.signal });
  cancellation.dispose();
  const { alive } = await standInAlive(ledger);
  console.log(`outcome ${result.outcome}; cleanup ${result.cleanup.confirmed ? 'confirmed' : 'NOT confirmed'}; ${alive.length} stand-in process(es) left`);
  process.exitCode = result.outcome === 'cancelled' && result.cleanup.confirmed && alive.length === 0 ? EXIT.cancelled : EXIT.error;
}

async function main() {
  const args = parseArgs();
  if (args['child-spike']) return childSpike(args);
  if (args['ctrl-c']) return manualCtrlC();
  if (process.platform !== 'win32') { console.error('The M10 self-test runs on Windows only (spikes/README.md).'); process.exitCode = EXIT.error; return; }
  const check = await checkLaunchRecord().catch((error) => error);
  if (check instanceof Error) { console.error(`self-test: ${check.message}`); process.exitCode = EXIT.recordedRunning; return; }
  mkdirSync(path.join(SELFTEST_DIR, 'ledgers'), { recursive: true });
  const only = typeof args.only === 'string' ? args.only : null;
  const want = (prefix) => !only || prefix.startsWith(only) || only.startsWith(prefix);
  const started = Date.now();
  if (want('C9')) testPolicyTable();
  if (want('V2')) testTextSearches();
  if (want('V3')) testLeakCheck();
  if (want('V26')) testUnknownFrame();
  if (want('V22')) await testStandInMatrix(['native', 'shim']);
  if (want('V23')) { await testCancellation(); await testRetryGate(); await testRecordedSurvivor(); }
  if (want('V6')) await testMissingExecutable();
  if (want('V21')) await testConfigReduction();
  const failed = rows.filter((r) => r.result === 'FAIL');
  const summary = { date: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, seconds: Math.round((Date.now() - started) / 1000), passed: rows.length - failed.length, failed: failed.length, rows };
  writeJson(outputPath('selftest', `result-${stamp()}.json`), summary);
  writeJson(outputPath('selftest', 'latest.json'), summary);
  console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.seconds} s`);
  process.exitCode = failed.length ? EXIT.error : EXIT.happened;
}

if (isMain(import.meta.url)) await main();
