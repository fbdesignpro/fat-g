// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// S2 spike (M7b): can fat-g read Claude account + usage by speaking the stdio control protocol
// directly to the user's installed CLI — no Agent SDK, and no SDK identity markers?
// Plan and go/no-go table: docs/planning/_archive/phase-1/phase-1-m7b.md.
//
// Read-only, like S1: no prompt is ever sent, no login is touched, nothing affects quota. Besides
// `initialize` and `get_usage` it sends only two diagnostics on the first session: `mcp_status`
// (read-only; count only) and a deliberately unknown subtype (checks the exact rejection text).
//
// Output is types, counts, key names and booleans — never identity, plan, usage values or paths.
// The summary is written to spikes/output/ (gitignored) as well as printed.
//
//   node spikes/claude-control.mjs [--probes 10] [--path <claude executable>]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { killTree, knownDirsFor, parseArgs, resolveExecutable, saveRaw, spawnResolved } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();
const PROBES = Number(args.probes ?? 10);

/**
 * Exactly what SDK 0.3.278 sends for fat-g's M7 options, as recorded by spikes/capture-sdk-wire.mjs.
 * (The first S2 run used arguments read from the bundle: without `--permission-mode default`, with
 * `{hooks: {}}` — the capture corrected both.)
 */
const REFERENCE = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'claude', 'sdk-0.3.278-wire.json'), 'utf8'));
const CONTROL_ARGS = REFERENCE.spawn.args;
const { subtype: _initialize, ...REFERENCE_INITIALIZE } = REFERENCE.frames.find((frame) => frame.request?.subtype === 'initialize').request;
const INIT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
const EXIT_GRACE_MS = 2_000;
const TURN_TYPES = new Set(['assistant', 'result', 'user']);

// ---- the production normalizer, bundled on the fly so the spike judges shapes the way fat-g will
const bundle = await build({
  stdin: { contents: "export { checkSessionAccount, normalizeUsage } from './src/main/providers/claude/normalize.ts';", resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  alias: { '@shared': path.join(ROOT, 'src', 'shared') },
});
const { checkSessionAccount, normalizeUsage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

// ---- executable and a normal-launch environment
const exe = resolveExecutable('claude', { override: args.path, knownDirs: knownDirsFor('claude') });
if (!exe) { console.error('claude not found'); process.exit(1); }
const version = spawnSync(exe.path, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? null;

// Remove everything a parent Claude session (this agent's own host) injects, plus debug and
// Electron/Node controls. On the maintainer's machine none of these are set persistently, so the
// result matches a Start-menu launch. Crucially: NO CLAUDE_CODE_ENTRYPOINT, NO CLAUDE_AGENT_SDK_VERSION.
const removed = [];
const env = {};
for (const [name, value] of Object.entries(process.env)) {
  if (/^(CLAUDE|ANTHROPIC|DEBUG|ELECTRON_|NODE_OPTIONS$)/i.test(name)) { removed.push(name); continue; }
  env[name] = value;
}

// A neutral, unique cwd: never a user project. Its token lets us find a transcript folder by name.
const token = `fatgs2${randomBytes(4).toString('hex')}`;
const probeCwd = mkdtempSync(path.join(tmpdir(), `${token}-`));
const projectsDir = path.join(homedir(), '.claude', 'projects');
const transcriptFolders = () => (existsSync(projectsDir) ? readdirSync(projectsDir).filter((name) => name.toLowerCase().includes(token)).length : 0);
const transcriptsBefore = transcriptFolders();

// ---- one control session
async function session(index, { initialize, diagnostics }) {
  const record = { index, initialize: 'pending', accountKeys: null, accountCheck: null, usage: null, diagnostics: null,
    messageTypes: {}, systemSubtypes: [], cliRequests: [], turnMessages: 0, malformedLines: 0, stderrBytes: 0, exit: null };
  const started = Date.now();
  const child = spawnResolved(exe, CONTROL_ARGS, { cwd: probeCwd, env });
  const pending = new Map();
  let counter = 0;
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (subtype, payload, timeoutMs) => new Promise((resolve) => {
    const id = `${token}-${index}-${counter++}`;
    const timer = setTimeout(() => { pending.delete(id); resolve({ outcome: 'timeout' }); }, timeoutMs);
    pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
    send({ type: 'control_request', request_id: id, request: { subtype, ...payload } });
  });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  child.on('error', () => { for (const settle of pending.values()) settle({ outcome: 'spawn-error' }); });
  child.stderr.on('data', (chunk) => { record.stderrBytes += chunk.length; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { record.malformedLines++; return; }
    const type = typeof message?.type === 'string' ? message.type : '<none>';
    record.messageTypes[type] = (record.messageTypes[type] ?? 0) + 1;
    if (TURN_TYPES.has(type)) record.turnMessages++;
    if (type === 'system' && typeof message.subtype === 'string' && !record.systemSubtypes.includes(message.subtype)) record.systemSubtypes.push(message.subtype);
    if (type === 'control_request') {
      // The CLI asking us something: record the subtype, refuse like the SDK does for unknown requests.
      record.cliRequests.push(String(message.request?.subtype));
      send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'unsupported' } });
    }
    if (type === 'control_response') {
      const response = message.response ?? {};
      const settle = pending.get(response.request_id);
      if (!settle) return;
      pending.delete(response.request_id);
      settle(response.subtype === 'success' ? { outcome: 'success', value: response.response } : { outcome: 'error', error: String(response.error ?? '') });
    }
  });

  let usageFingerprint = null;
  let asOf = null;
  const init = await request('initialize', initialize, INIT_TIMEOUT_MS);
  record.initialize = init.outcome;
  if (init.outcome === 'success') {
    const account = init.value?.account;
    record.accountKeys = account && typeof account === 'object' ? Object.fromEntries(Object.entries(account).map(([key, value]) => [key, value === null ? 'null' : typeof value])) : null;
    record.accountCheck = checkSessionAccount(account)?.kind ?? null;
    record.initializeReplyKeys = Object.keys(init.value ?? {});
    const usage = await request('get_usage', { skip_behaviors: true }, REQUEST_TIMEOUT_MS);
    if (usage.outcome === 'success') {
      const value = usage.value;
      const normalized = normalizeUsage(value);
      const windows = normalized.kind === 'usage' ? normalized.usage.windows : [];
      record.usage = {
        outcome: 'success',
        topLevelKeys: Object.keys(value ?? {}),
        rateLimitKeysCount: value?.rate_limits && typeof value.rate_limits === 'object' ? Object.keys(value.rate_limits).length : null,
        limitKinds: Array.isArray(value?.rate_limits?.limits) ? value.rate_limits.limits.map((row) => row?.kind) : null,
        normalized: normalized.kind,
        windowCount: windows.length,
        windowKinds: windows.map((window) => window.kind),
        uniqueIds: new Set(windows.map((window) => window.id)).size === windows.length,
        bindingCount: windows.filter((window) => window.isBinding).length,
      };
      // Kept in memory only, to answer "did anything change across probes?" as a boolean.
      usageFingerprint = JSON.stringify(windows.map((window) => [window.id, window.usedPercent]));
      asOf = typeof value?.rate_limits?.as_of === 'string' ? value.rate_limits.as_of : null;
    } else {
      record.usage = { outcome: usage.outcome, exactUnsupportedRejection: usage.error === 'Unsupported control request subtype: get_usage' };
    }
    if (diagnostics) {
      const mcp = await request('mcp_status', {}, REQUEST_TIMEOUT_MS);
      const unknown = await request('fatg_unknown_probe', {}, REQUEST_TIMEOUT_MS);
      record.diagnostics = {
        mcpStatus: mcp.outcome,
        mcpServerCount: mcp.outcome === 'success' && Array.isArray(mcp.value?.mcpServers) ? mcp.value.mcpServers.length : null,
        unknownSubtype: unknown.outcome,
        unknownRejectionExact: unknown.error === 'Unsupported control request subtype: fatg_unknown_probe',
      };
    }
  } else if (init.outcome === 'error') {
    record.initializeErrorLength = init.error.length;
  }

  // Teardown as M7b will do it: EOF, natural-exit grace, then (only if needed) tree kill.
  const eofAt = Date.now();
  child.stdin.end();
  const natural = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), EXIT_GRACE_MS))]);
  if (natural === null) killTree(child.pid);
  const exit = natural ?? await exited;
  record.exit = { natural: natural !== null, code: exit.code, msAfterEof: Date.now() - eofAt, totalMs: Date.now() - started, descendants: descendantsOf(child.pid) };
  return { record, usageFingerprint, asOf };
}

/** Windows: processes whose recorded parent is the (now exited) session root. Count only. */
function descendantsOf(pid) {
  if (process.platform !== 'win32' || !pid) return null;
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}').Count`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

// ---- run
const records = [];
const fingerprints = [];
const asOfs = new Set();
for (let i = 0; i < PROBES; i++) {
  // Q2: probe 0 sends the minimal payload; every other probe sends the SDK-identical frame.
  const initialize = i === 0 ? {} : REFERENCE_INITIALIZE;
  const { record, usageFingerprint, asOf } = await session(i, { initialize, diagnostics: i === 1 });
  record.initializePayload = i === 0 ? 'minimal' : 'sdk-identical';
  records.push(record);
  if (usageFingerprint !== null) fingerprints.push(usageFingerprint);
  if (asOf !== null) asOfs.add(asOf);
}
const transcriptsAfter = transcriptFolders();
rmSync(probeCwd, { recursive: true, force: true });

const ok = (value) => (value ? 'PASS' : 'FAIL');
const all = (predicate) => records.every(predicate);
const answers = {
  '1 control mode without SDK markers': ok(records.some((r) => r.initialize === 'success')),
  '2 minimal initialize accepted': records[0]?.initialize ?? null,
  '2 sdk-identical initialize accepted': records[1]?.initialize ?? null,
  '3 account in initialize reply': ok(all((r) => r.initialize !== 'success' || r.accountKeys !== null)),
  '4 usage normalizes': ok(all((r) => r.usage?.outcome === 'success' && r.usage.normalized === 'usage' && r.usage.windowCount > 0 && r.usage.uniqueIds)),
  '5 no turn messages': ok(all((r) => r.turnMessages === 0)),
  '5 readings unchanged across probes': fingerprints.length > 1 ? fingerprints.every((f) => f === fingerprints[0]) : null,
  '6 CLI-initiated requests': [...new Set(records.flatMap((r) => r.cliRequests))],
  '7 no transcript folder': ok(transcriptsAfter === transcriptsBefore),
  '7 mcp servers with strict config': records[1]?.diagnostics?.mcpServerCount ?? null,
  '8 natural exit within grace': ok(all((r) => r.exit?.natural)),
  '8 descendants after exit': [...new Set(records.map((r) => r.exit?.descendants))],
  '9 unknown subtype rejected exactly': ok(records[1]?.diagnostics?.unknownRejectionExact === true),
};
const summary = {
  spike: 'S2', date: new Date().toISOString(), node: process.version, platform: process.platform,
  cli: { version, kind: exe.kind, source: exe.source }, probes: PROBES, argv: CONTROL_ARGS,
  environment: { removedNames: removed.sort(), entrypointSet: 'CLAUDE_CODE_ENTRYPOINT' in env, sdkVersionSet: 'CLAUDE_AGENT_SDK_VERSION' in env },
  distinctAsOf: asOfs.size, answers, records,
};
console.log(JSON.stringify({ cli: summary.cli, environment: { removedCount: removed.length, entrypointSet: summary.environment.entrypointSet, sdkVersionSet: summary.environment.sdkVersionSet }, distinctAsOf: asOfs.size, answers }, null, 2));
console.log('\nper-probe (types/counts only):');
for (const r of records) {
  console.log(JSON.stringify({ i: r.index, init: `${r.initializePayload}:${r.initialize}`, usage: r.usage?.outcome, windows: r.usage?.windowKinds, types: r.messageTypes, system: r.systemSubtypes, cli: r.cliRequests, exit: r.exit }));
}
console.log(`\nfirst-probe shapes: accountKeys=${JSON.stringify(records[0]?.accountKeys)} accountCheck=${records[0]?.accountCheck} initReplyKeys=${JSON.stringify(records[0]?.initializeReplyKeys)}`);
console.log(`usage keys: top=${JSON.stringify(records[0]?.usage?.topLevelKeys)} rate_limits key count=${records[0]?.usage?.rateLimitKeysCount} limits kinds=${JSON.stringify(records[0]?.usage?.limitKinds)} binding=${records[0]?.usage?.bindingCount}`);
console.log(`\nsaved: ${path.relative(ROOT, saveRaw('claude-control', summary))}`);
