// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M16's spikes share (M16, C4, C5, C73): one frame for a scenario's run, with M10's launcher,
// deadlines, process-tree check, launch record, run ledger and capture format, and M14b's
// configuration-folder environment. Plain Node; nothing here is application code.
//
// One invocation is one run of one scenario. It prints its plan and its turn count, and launches
// only when --confirm-turns equals that count (S10). At most three runs per scenario.
//
// Every session runs in a scratch configuration folder the maintainer signed in to (M14b's login
// folder), with `CLAUDE_CONFIG_DIR` naming it: the maintainer's own configuration is neither read
// nor changed (C4). What a scenario needs there (a settings file, an agent, a skill, a hook) the
// spike writes before the launch and removes after the run.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeDriver } from '../../m10/claude/driver.mjs';
import { typeKey } from '../../m10/claude/frames.mjs';
import { buildCapture } from '../../m10/lib/capture.mjs';
import { Cancelled, DeadlineExpired, EXIT, settlesWithin } from '../../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../../m10/lib/env.mjs';
import { resolveExecutable } from '../../m10/lib/executable.mjs';
import { LaunchRecord, checkLaunchRecord, describe } from '../../m10/lib/launch-record.mjs';
import { Launcher } from '../../m10/lib/launcher.mjs';
import { Ledger } from '../../m10/lib/ledger.mjs';
import { SPIKES_DIR, writeJson } from '../../m10/lib/paths.mjs';
import { forceEnd } from '../../m10/lib/proctree.mjs';
import { TRACE_FILES, buildScratch, compareManifest } from '../../m10/lib/scratch.mjs';
import { log, warn } from '../../m10/lib/spike.mjs';
import { CliExited } from '../../m10/lib/wire.mjs';
import { claudeLoggedIn, parseVersion } from '../../m10/preflight.mjs';
import { entriesOf, folderPath, parentPath } from '../../m14b/lib/folders.mjs';
import { instanceEnvironment } from '../../m14b/lib/instance-env.mjs';

export const M16_DIR = path.join(SPIKES_DIR, 'output', 'm16');

export function m16Path(...segments) {
  const file = path.join(M16_DIR, ...segments);
  if (!file.startsWith(M16_DIR + path.sep)) throw new Error('output path escapes spikes/output/m16');
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** What one invocation leaves for the next: the model to name, the saved session's id (raw; ignored folder). */
const STATE = () => m16Path('state.json');
export const readState = () => (existsSync(STATE()) ? JSON.parse(readFileSync(STATE(), 'utf8')) : {});
export const writeState = (patch) => writeJson(STATE(), { ...readState(), ...patch });

/** The scratch configuration folder (C4): M14b's login folder, kept since its second part. */
export const CONFIG_DIR = folderPath('claude', 'login');

/** The tool list of C14, and the fixed arguments of C12, C13, C17 and C19. */
export const TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Agent']);
export const READ_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);

export function chatArgs({ model, effort, resume, sessionId, addDirs = [], tools = TOOLS, replay = false, permissionMode = 'default', extra = [] } = {}) {
  const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--setting-sources', 'user,project,local', '--permission-mode', permissionMode, '--permission-prompt-tool', 'stdio', '--tools', tools.join(',')];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--resume', resume);
  if (sessionId) args.push('--session-id', sessionId);
  for (const dir of addDirs) args.push('--add-dir', dir);
  if (replay) args.push('--replay-user-messages');
  return [...args, ...extra];
}

/** What fat-g will answer a `can_use_tool` request (C9, C22): `deny`, with fixed words of its own. */
export const DENY_WORDS = 'This action is not available in this session.';

/** The variable C40 names, set for the one scenario that traces it. */
export const BACKGROUND_VARIABLE = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS';

/** M10's clean environment, with the scratch configuration folder set on top (M14b's rule). */
export function chatEnvironment({ background = true } = {}) {
  const { env } = instanceEnvironment('claude', CONFIG_DIR);
  const { removed } = cleanEnvironment('claude');
  const set = ['CLAUDE_CONFIG_DIR'];
  if (!background) { env[BACKGROUND_VARIABLE] = '1'; set.push(BACKGROUND_VARIABLE); }
  return { env, removed, set };
}

/** The files the other folders hold: two roots handed over with `--add-dir`, and one outside every root (C19). */
export const OTHER_FILES = Object.freeze({ 'second.txt': 'The ferry to the island leaves at seven, and its bell is painted green.\n' });
export const THIRD_FILES = Object.freeze({ 'third.txt': 'The bakery on the quay sells out of rye bread before nine.\n' });
export const OUTSIDE_FILES = Object.freeze({ 'outside.txt': "The harbour master's dog is called Pepper, and it guards the east gate.\n" });

/** A strings-only copy of a frame with every string over 32 KiB cut, its length kept (K13). */
const LONG = 32 * 1024;
function trimmed(value, found, key = null) {
  if (typeof value === 'string') {
    if (value.length <= LONG) return value;
    found.push({ key, chars: value.length });
    return `${value.slice(0, 200)}<… ${value.length} characters in all, cut by the M16 spike>`;
  }
  if (Array.isArray(value)) return value.map((item) => trimmed(item, found, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimmed(v, found, k)]));
  return value;
}

/** M10's Claude driver, with the size of every received frame measured before it is cut, and a prompt that can carry an id. */
export class M16Driver extends ClaudeDriver {
  constructor(options) {
    super(options);
    this.sizes = new WeakMap();
    this.frameBytes = [];
    this.longStrings = [];
    const inner = this.session.transform;
    this.session.transform = (raw) => {
      const frame = inner(raw);
      const found = [];
      const out = trimmed(frame, found);
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (out && typeof out === 'object') this.sizes.set(out, bytes);
      this.frameBytes.push({ type: typeKey(frame), bytes });
      for (const entry of found) this.longStrings.push({ type: typeKey(frame), ...entry });
      return out;
    };
  }

  /** One prompt as one text (C7). `uuid` only where a scenario follows the echo of `--replay-user-messages`. */
  async prompt(text, { uuid } = {}) {
    this.turnActive = true;
    return this.session.send({ type: 'user', ...(uuid ? { uuid } : {}), message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' });
  }

  /** The largest frames received, biggest first. */
  largest(count = 5) { return [...this.frameBytes].sort((a, b) => b.bytes - a.bytes).slice(0, count); }

  /** The largest frame of each type. */
  largestByType() {
    const out = {};
    for (const { type, bytes } of this.frameBytes) out[type] = Math.max(out[type] ?? 0, bytes);
    return out;
  }
}

const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);

/** One line per frame from `from` on: what it is and whose, never its text. */
export function outline(driver, from = 0, { sent = [] } = {}) {
  const sessions = new Map();
  const tasks = new Map();
  const aliasOf = (map, prefix, id) => {
    if (typeof id !== 'string') return null;
    if (!map.has(id)) map.set(id, `${prefix}${map.size + 1}`);
    return map.get(id);
  };
  const rows = [];
  for (const { index, dir, ms, frame } of driver.session.frames) {
    const type = typeKey(frame);
    // Aliases are numbered over the whole capture, so a row means the same whatever `from` is.
    const session = aliasOf(sessions, 's', frame?.session_id || undefined);
    const task = aliasOf(tasks, 'w', frame?.task_id);
    if (index < from) continue;
    const row = { index, ms, [dir]: type };
    if (dir === 'send') {
      if (type === 'user') row.uuid = typeof frame.uuid === 'string';
      rows.push(row);
      continue;
    }
    row.bytes = driver.sizes.get(frame) ?? null;
    if (session) row.session = session;
    if (frame.parent_tool_use_id != null) row.worker = true;
    switch (type) {
      case 'system/init':
        Object.assign(row, { model: frame.model ?? null, permissionMode: frame.permissionMode ?? null, tools: frame.tools ?? null });
        break;
      case 'assistant':
        Object.assign(row, { blocks: blocksOf(frame).map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}` : b.type)), stop: frame.message?.stop_reason ?? null });
        if (frame.error) row.error = String(frame.error);
        if (blocksOf(frame).some((b) => b.type === 'text')) row.textChars = blocksOf(frame).filter((b) => b.type === 'text').reduce((sum, b) => sum + String(b.text ?? '').length, 0);
        break;
      case 'user':
        Object.assign(row, { content: typeof frame.message?.content === 'string' ? 'text' : blocksOf(frame).map((b) => (b.type === 'tool_result' ? `tool_result${b.is_error ? ':error' : ''}` : b.type)) });
        for (const key of ['isReplay', 'isSynthetic', 'isMeta']) if (key in frame) row[key] = frame[key];
        if (typeof frame.uuid === 'string' && sent.includes(frame.uuid)) row.ours = true;
        break;
      case 'result':
        Object.assign(row, { subtype: frame.subtype ?? null, isError: frame.is_error === true, terminal: frame.terminal_reason ?? null, numTurns: frame.num_turns ?? null, resultIndex: frame.result_index ?? null, queuedTurnCount: frame.queued_turn_count ?? null, resultChars: typeof frame.result === 'string' ? frame.result.length : null });
        break;
      case 'control_response':
        Object.assign(row, { ok: frame.response?.subtype === 'success' });
        break;
      case 'rate_limit_event':
        break;
      default:
        if (type.startsWith('system/task_') || type === 'system/background_tasks_changed') {
          Object.assign(row, Object.fromEntries(Object.entries({ task, status: frame.status ?? frame.patch?.status ?? null, backgrounded: frame.is_backgrounded ?? frame.patch?.is_backgrounded ?? null, taskType: frame.task_type ?? null, agent: frame.subagent_type ?? null, lastTool: frame.last_tool_name ?? null, hasSummary: 'summary' in frame ? true : null, patchKeys: frame.patch ? Object.keys(frame.patch).sort() : null }).filter(([, value]) => value !== null)));
        } else if (type.startsWith('control_request/')) {
          Object.assign(row, { tool: frame.request?.tool_name ?? null, worker: Boolean(frame.request?.agent_id), keys: Object.keys(frame.request ?? {}).sort() });
        } else {
          row.keys = Object.keys(frame ?? {}).sort();
          for (const key of ['state', 'status', 'hook_event', 'hook_name', 'outcome']) if (typeof frame?.[key] === 'string') row[key] = frame[key];
        }
    }
    rows.push(row);
  }
  return rows;
}

/** How long each text of the session's own waited for the frame that settles it (C35, C70). */
export function textWaits(driver, from = 0) {
  const own = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && ['assistant', 'result'].includes(typeKey(f.frame)) && f.frame.parent_tool_use_id == null);
  const waits = [];
  own.forEach((entry, i) => {
    if (typeKey(entry.frame) !== 'assistant' || !blocksOf(entry.frame).some((b) => b.type === 'text')) return;
    const next = own[i + 1] ?? null;
    waits.push({ index: entry.index, settledBy: next ? (typeKey(next.frame) === 'result' ? 'result' : blocksOf(next.frame).map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}` : b.type)).join('+')) : null, waitMs: next ? next.ms - entry.ms : null });
  });
  return waits;
}

/** The text of the session's own assistant frames from `from` on, in memory only: a scenario keeps a yes or no. */
export function ownText(driver, from = 0) {
  return driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeKey(f.frame) === 'assistant' && f.frame.parent_tool_use_id == null).flatMap((f) => blocksOf(f.frame).filter((b) => b.type === 'text').map((b) => String(b.text ?? ''))).join('\n');
}

export const framesOf = (driver, type, from = 0) => driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeKey(f.frame) === type);
export const initOf = (driver, from = 0) => framesOf(driver, 'system/init', from)[0] ?? null;
export const resultOf = (driver, from = 0) => framesOf(driver, 'result', from)[0] ?? null;

/** The settings files a run could change (C23): the scratch configuration folder's and the scratch project's. */
export function settingsState(projectDir) {
  const files = { 'config/settings.json': path.join(CONFIG_DIR, 'settings.json'), 'config/settings.local.json': path.join(CONFIG_DIR, 'settings.local.json'), 'project/.claude/settings.json': path.join(projectDir, '.claude', 'settings.json'), 'project/.claude/settings.local.json': path.join(projectDir, '.claude', 'settings.local.json') };
  return Object.fromEntries(Object.entries(files).map(([name, file]) => {
    if (!existsSync(file)) return [name, { exists: false }];
    const bytes = readFileSync(file);
    let keys = null;
    try { const parsed = JSON.parse(bytes.toString('utf8')); keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : null; } catch { /* not JSON */ }
    return [name, { exists: true, bytes: statSync(file).size, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16), keys }];
  }));
}

const OUTCOME_EXIT = { happened: EXIT.happened, 'did-not-happen': EXIT.didNotHappen, 'timed-out': EXIT.timedOut, 'not-run': EXIT.notRun, void: EXIT.void, cancelled: EXIT.cancelled };

export const happened = (notes = {}, successIndex = null) => ({ outcome: 'happened', successIndex, notes });
export const didNotHappen = (why, notes = {}) => ({ outcome: 'did-not-happen', successIndex: null, notes: { why, ...notes } });
export const notRun = (why, notes = {}) => ({ outcome: 'not-run', successIndex: null, notes: { why, ...notes } });

/** A one-shot command in a given environment, through the launcher's confirmed teardown. */
async function runOnceIn(launcher, executable, args, { cwd, waits, env }) {
  const tree = await launcher.launch({ executable, args, cwd, env });
  let stdout = '';
  if (tree.child) {
    tree.stdout.setEncoding('utf8');
    tree.stdout.on('data', (chunk) => { if (stdout.length < 1_000_000) stdout += chunk; });
    tree.stdin.end();
  }
  const finished = await settlesWithin(tree.closed, waits.request);
  const code = tree.exitInfo?.code ?? null;
  const cleanup = await tree.teardown();
  return { code, stdout, timedOut: !finished, cleanup };
}

/** The CLI's version, and that the scratch configuration folder is still signed in. No login is ever started. */
async function requireReady(launcher, waits, executable, cwd) {
  if (!existsSync(CONFIG_DIR) || !existsSync(path.join(parentPath(), '.fat-g-spike'))) {
    const error = new Error(`the scratch configuration folder is not there. Sign in to one from your own terminal: run "node spikes/m14b/instances.mjs --part 1 --cli claude", then the login command it prints (agents never log in).`);
    error.exitCode = EXIT.cliMissing;
    throw error;
  }
  const environment = chatEnvironment();
  const version = await runOnceIn(launcher, executable, ['--version'], { cwd, waits, env: environment.env });
  const status = await runOnceIn(launcher, executable, ['auth', 'status'], { cwd, waits, env: environment.env });
  const parsed = parseVersion(version.stdout);
  if (!parsed || !claudeLoggedIn(status)) {
    const error = new Error(`claude is ${parsed ? 'not signed in in the scratch configuration folder' : 'not answering --version'}. Sign in from your own terminal, with CLAUDE_CONFIG_DIR naming that folder (agents never log in).`);
    error.exitCode = EXIT.cliMissing;
    throw error;
  }
  return { name: 'claude', version: parsed, kind: executable.kind };
}

/** Removes what an earlier run wrote into the scratch configuration folder, and the folders it left empty. */
function removeWritten(names) {
  for (const relative of names) {
    const file = path.join(CONFIG_DIR, relative);
    if (!file.startsWith(CONFIG_DIR + path.sep)) continue;
    rmSync(file, { force: true });
    for (let dir = path.dirname(file); dir !== CONFIG_DIR && dir.startsWith(CONFIG_DIR + path.sep); dir = path.dirname(dir)) {
      try { if (readdirSync(dir).length === 0) rmdirSync(dir); else break; } catch { break; }
    }
  }
}

/**
 * Runs one scenario: `{ id, name, title, successCondition, turns, family?, files?, tools?, run(ctx) }`.
 *
 * `ctx`: `open(options)` launches a session and sends `initialize`; `tryOpen(options)` does the same
 * for a launch that may exit; `prompt(driver, text, options?)` counts the turn first and returns the
 * index its frames start at; `wait`, `turnEnd`, `frame` and `maybeFrame` are bounded by the scenario
 * wait; `endByForce(driver)` ends a session's tree as the app's process layer does; `writeConfig(relative, text)` writes into the scratch configuration folder and is undone
 * after the run; `project`, `other`, `third` and `outside` are the folders.
 *
 * `options`, for a later milestone's spikes that run as these do (M19's K2): `dir`, the output
 * folder in place of spikes/output/m16; `Driver`, a driver in place of M16's; `milestone`, the name
 * the plan and the capture's source say; `omitted`, what the capture says it leaves out;
 * `toolPolicy`, what the capture says the spike answered a request with, where it is not M16's
 * deny (M22's K2); `argsFor(launch, state)`, a launch's arguments in place of M16's chat arguments
 * (M26's K1, whose `open` also takes `initialize`, the request's fields). The model to name and what a run wrote into the scratch configuration folder stay in M16's state file: the
 * folder is the same one.
 */
export async function runScenario(spike, scenario, { args, launcher, signal, waits }, options = {}) {
  const dir = options.dir ?? M16_DIR;
  const milestone = options.milestone ?? 'M16';
  const Driver = options.Driver ?? M16Driver;
  const at = (...segments) => {
    const file = path.join(dir, ...segments);
    if (!file.startsWith(dir + path.sep)) throw new Error('output path escapes the spike output folder');
    mkdirSync(path.dirname(file), { recursive: true });
    return file;
  };
  const ledger = new Ledger(at('ledger.json'));
  const previous = ledger.runsFor('claude', scenario.id);
  log(`plan: claude ${scenario.id} (${scenario.title})`);
  log(`  success: ${scenario.successCondition}`);
  log(`  turns this run: ${scenario.turns} (prompts sent to the model${scenario.atMost ? ', at most' : ''}). Earlier runs: ${previous.length}; ${milestone} turns spent so far: ${ledger.turnsSpent()}`);
  if (String(args['confirm-turns']) !== String(scenario.turns)) {
    log(`nothing launched. Re-run with --confirm-turns ${scenario.turns} to spend ${scenario.atMost ? 'at most ' : ''}${scenario.turns} turn(s).`);
    return EXIT.happened;
  }
  const executable = resolveExecutable('claude', args.path);
  const state = readState();
  if (Array.isArray(state.written) && state.written.length) { removeWritten(state.written); writeState({ written: [] }); }
  const run = ledger.open('claude', scenario.id, { again: Boolean(args.again) });
  log(`run ${run.id}: number ${run.number} of at most 3`);

  // A second process at the same time needs a launcher and a launch record of its own (as M14b's spike).
  const secondRecord = at('launched-second.json');
  await checkLaunchRecord({ file: secondRecord });
  const second = new Launcher({ spike, record: new LaunchRecord(spike, secondRecord), waits });
  const free = (candidate) => !candidate.previous || candidate.previous.cleanup?.confirmed === true;
  const drivers = [];
  const written = [];
  const result = { outcome: null, expiredWait: null, successIndex: null, notes: {} };
  let cliInfo = null;
  let folders = null;
  let settingsBefore = null;
  let entriesBefore = null;
  let deadline = null;
  try {
    const probe = buildScratch('probe');
    cliInfo = await requireReady(launcher, waits, executable, probe.dir);
    folders = {
      project: buildScratch('m16', { ...TRACE_FILES, ...(scenario.files ?? {}) }),
      other: buildScratch('m16Other', OTHER_FILES), third: buildScratch('m16Third', THIRD_FILES), outside: buildScratch('m16Outside', OUTSIDE_FILES),
    };
    settingsBefore = settingsState(folders.project.dir);
    if (settingsBefore['config/settings.json'].exists || settingsBefore['config/settings.local.json'].exists) {
      Object.assign(result, notRun('the scratch configuration folder holds a settings file this spike did not write', { settingsBefore }));
    } else {
      entriesBefore = entriesOf(CONFIG_DIR);
      const make = ({ label, launch = {}, cwd = folders.project.dir, background = true } = {}) => {
        const which = free(launcher) ? launcher : free(second) ? second : null;
        if (!which) throw new Error('both launchers still hold a tree: close a session before opening a third');
        const environment = chatEnvironment({ background });
        const driver = new Driver({ launcher: which, executable, args: options.argsFor ? options.argsFor(launch, state) : chatArgs({ model: state.model, effort: state.effort, ...launch }), cwd, env: environment.env, waits, signal });
        driver.label = label ?? `p${drivers.length + 1}`;
        driver.environment = environment;
        driver.exitMs = null;
        // The exit's own time, taken as it happens: the wire session notices it up to 750 ms later.
        // And the tree's first recording runs beside the handshake, not before it: M10's wire session
        // waits for that process listing (about a second) before `initialize` is written, which
        // would hide how long a launch and a resume take (K2). `claude` is a native executable here,
        // so no shim's intermediate process is missed.
        driver.session.launcher = {
          launch: async (options) => {
            const tree = await which.launch(options);
            tree.exited.then(() => { driver.exitMs = tree.elapsed(); });
            const record = tree.tryRecord.bind(tree);
            tree.tryRecord = (moment) => (moment === 'after-spawn' ? (record(moment), Promise.resolve(null)) : record(moment));
            return tree;
          },
        };
        driver.onRequest(() => ({ decision: 'deny', message: DENY_WORDS }));
        drivers.push(driver);
        return driver;
      };
      const ctx = {
        args, executable, waits, log, state,
        project: folders.project.dir, other: folders.other.dir, third: folders.third.dir, outside: folders.outside.dir, probe: probe.dir, config: CONFIG_DIR,
        model: state.model ?? null, effort: state.effort ?? null,
        /** Launch and `initialize`, as the app will before any prompt (C24). */
        async open(options = {}) {
          const driver = make(options);
          const reply = await driver.open(options.initialize);
          driver.sessionStart = { request: { subtype: 'initialize', ...(options.initialize ? { fields: Object.keys(options.initialize).sort() } : {}) }, replyIndex: reply.index, ok: reply.ok };
          driver.initializeReply = reply.ok ? reply.value : null;
          await driver.record('after-handshake');
          return driver;
        },
        /** The same for a launch that may exit: `{ driver, opened, exit, exitMs, frames }`, never throwing for an exit. */
        async tryOpen(options = {}) {
          const driver = make(options);
          let reply = null;
          try {
            await driver.startWire();
            reply = await driver.request('initialize', {}, 'startup');
          } catch (error) {
            if (!(error instanceof CliExited)) throw error;
          }
          if (reply) {
            driver.sessionStart = { request: { subtype: 'initialize' }, replyIndex: reply.index, ok: reply.ok };
            driver.initializeReply = reply.ok ? reply.value : null;
          } else {
            driver.sessionStart = { request: { subtype: 'initialize' }, replyIndex: null, ok: false };
            if (driver.tree) await settlesWithin(driver.tree.closed, 3_000);
          }
          const received = driver.session.frames.filter((f) => f.dir === 'recv');
          return {
            driver, opened: Boolean(reply?.ok), initializeAnswered: Boolean(reply),
            exit: driver.tree?.exitInfo ? { code: driver.tree.exitInfo.code ?? null, signal: driver.tree.exitInfo.signal ?? null } : null,
            exitMs: driver.exitMs, stdoutFrames: received.map((f) => ({ type: typeKey(f.frame), keys: Object.keys(f.frame ?? {}).sort() })),
            garbageLines: driver.session.recorder?.garbageLines.length ?? 0, stderrBytes: driver.tree?.stderrBytes ?? 0,
          };
        },
        /** Tears one session down before the next is launched: the launcher refuses a launch over a live tree. */
        async close(driver) { driver.cleanupState = await driver.close(); return driver.cleanupState; },
        /**
         * Ends a session's tree as the app's process layer ends one on Windows (`src/main/process/tree-kill.ts`):
         * `taskkill /PID <pid> /T /F` at once, with no end of input first (K25). The teardown that
         * follows only confirms the tree gone, and its `graceful` then says no more than that.
         */
        async endByForce(driver) {
          const tree = driver.tree;
          const atMs = tree.elapsed();
          const taskkillOk = await forceEnd(tree.pid, { tree: true });
          const exited = await settlesWithin(tree.exited, 5_000);
          driver.forcedEnd = { how: 'taskkill /PID <pid> /T /F, with no end of input first', atMs, taskkillOk, exited, exitMs: driver.exitMs, exitCode: tree.exitInfo?.code ?? null };
          driver.cleanupState = await driver.close();
          return driver.forcedEnd;
        },
        async prompt(driver, text, options = {}) {
          deadline ??= Date.now() + waits.scenario;
          ledger.countTurn(run);
          const from = driver.nextIndex;
          await driver.prompt(text, options);
          return from;
        },
        /** Counts a prompt that goes out by another frame than `user` (M20b's side question): the ledger sees it as a turn. */
        countTurn() { deadline ??= Date.now() + waits.scenario; ledger.countTurn(run); },
        left() { return deadline ? Math.max(1, deadline - Date.now()) : waits.scenario; },
        wait(driver, predicate, from) { return driver.waitEvent(predicate, { wait: 'scenario', ms: this.left(), from }); },
        turnEnd(driver, from) { return this.wait(driver, (e) => e.kind === 'turn-end', from); },
        frame(driver, predicate, from, ms) { return driver.session.waitFor(predicate, { wait: 'scenario', ms: Math.min(ms ?? this.left(), this.left()), fromIndex: from }); },
        /** A frame that may not come: null once `ms` has passed. */
        async maybeFrame(driver, predicate, from, ms) {
          try { return await driver.session.waitFor(predicate, { wait: 'scenario', ms, fromIndex: from }); } catch (error) {
            if (error instanceof DeadlineExpired || error instanceof CliExited) return null;
            throw error;
          }
        },
        writeConfig(relative, text) {
          const file = path.join(CONFIG_DIR, relative);
          if (!file.startsWith(CONFIG_DIR + path.sep)) throw new Error(`a written file escapes the scratch configuration folder: ${relative}`);
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, text);
          written.push(relative);
          writeState({ written });
          return file;
        },
        /** A file the CLI or a hook may write there, removed with the rest. */
        expectWritten(relative) { written.push(relative); writeState({ written }); return path.join(CONFIG_DIR, relative); },
        settingsNow: () => settingsState(folders.project.dir),
      };
      try {
        Object.assign(result, await scenario.run(ctx));
      } catch (error) {
        if (error instanceof CliExited) Object.assign(result, didNotHappen('the CLI exited during the scenario'));
        else throw error;
      }
    }
  } catch (error) {
    if (error instanceof DeadlineExpired) Object.assign(result, { outcome: 'timed-out', expiredWait: error.wait });
    else if (error instanceof Cancelled) Object.assign(result, { outcome: 'cancelled', notes: { ...result.notes, why: error.reason } });
    else if (error?.exitCode === EXIT.cliMissing) { ledger.close(run, { status: 'not-run', notes: { why: error.message } }); throw error; }
    else Object.assign(result, { outcome: 'void', notes: { ...result.notes, defect: String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ') } });
  }

  const cleanups = await Promise.all(drivers.map((driver) => driver.cleanupState ?? driver.close()));
  const confirmed = cleanups.every((cleanup) => cleanup.confirmed);
  const folderState = folders ? Object.fromEntries(Object.entries(folders).map(([name, folder]) => [name, compareManifest(folder.dir, folder.manifest)])) : null;
  // The settings files as the run left them, then the spike's own files out again (C4).
  const settingsAfter = folders ? settingsState(folders.project.dir) : null;
  const leftByCli = settingsAfter ? Object.entries(settingsAfter).filter(([name, file]) => name.startsWith('config/') && file.exists && !written.includes(name.slice('config/'.length))).map(([name]) => name.slice('config/'.length)) : [];
  removeWritten([...written, ...leftByCli]);
  writeState({ written: [] });
  const entriesAfter = entriesBefore ? entriesOf(CONFIG_DIR) : null;
  const names = (entries) => (entries ?? []).map((entry) => entry.name).sort();
  const configFolder = entriesBefore ? { written, settingsFilesTheCliLeft: leftByCli, entriesAdded: names(entriesAfter).filter((name) => !names(entriesBefore).includes(name)), entriesRemoved: names(entriesBefore).filter((name) => !names(entriesAfter).includes(name)) } : null;
  const files = [];
  drivers.forEach((driver, i) => {
    if (!driver.session.recorder) return;
    const cleanup = cleanups[i];
    const tools = (driver.args[driver.args.indexOf('--tools') + 1] ?? '').split(',');
    const capture = buildCapture({
      spike: `${spike}.mjs`, cli: cliInfo ?? { name: 'claude', version: null, kind: executable.kind }, scenario, driver, environment: driver.environment, waits,
      run: { id: run.id, number: run.number, attempt: run.attempt, variant: 'default', process: driver.label, outcome: result.outcome, expiredWait: result.expiredWait, successIndex: drivers.length === 1 ? result.successIndex : null, turnsSpent: run.turns, exit: driver.tree?.exitInfo ? { code: driver.tree.exitInfo.code ?? null, ms: driver.exitMs } : null, ...(driver.forcedEnd ? { endedByForce: driver.forcedEnd } : {}), cleanup: { confirmed: cleanup.confirmed, graceful: cleanup.graceful, forced: cleanup.forced, ms: cleanup.ms, recorded: cleanup.recorded }, scratchUnchanged: folderState?.project ?? null, otherFoldersUnchanged: folderState ? { other: folderState.other.unchanged, third: folderState.third.unchanged, outside: folderState.outside.unchanged } : null, notes: result.notes },
      sessionStart: driver.sessionStart ?? null,
      toolPermissions: { readTools: READ_TOOLS.filter((tool) => tools.includes(tool)), scenarioTools: tools.filter((tool) => !READ_TOOLS.includes(tool)), preApproved: scenario.preApproved ?? [], permissionMode: driver.args[driver.args.indexOf('--permission-mode') + 1] ?? 'default', permissionRequestsTo: 'the spike (--permission-prompt-tool stdio)', policy: options.toolPolicy ?? 'every can_use_tool request is denied, as the app will deny it (M16, C22); any other request gets an error reply' },
      extra: {
        ...(scenario.family ? { family: scenario.family } : {}),
        sessionIds: driver.sessionIds,
        configuration: { folder: 'a scratch configuration folder (CLAUDE_CONFIG_DIR), signed in by the maintainer', written },
        frameSizes: { largest: driver.largest(), longStringsCut: driver.longStrings },
      },
    });
    capture._fixture.source = `${milestone} spike ${spike}.mjs, run against the installed CLI on the maintainer's machine, in a scratch configuration folder`;
    if (options.omitted) capture._fixture.omitted = options.omitted;
    const name = drivers.length > 1 ? `${scenario.name}-${driver.label}` : scenario.name;
    files.push(writeJson(at('raw', 'claude', `${name}.${run.id}.json`), capture));
  });
  run.capture = files.map((file) => path.relative(dir, file).split(path.sep).join('/')).join(', ') || null;
  const unchanged = folderState ? Object.values(folderState).every((folder) => folder.unchanged) : null;
  ledger.close(run, { status: result.outcome, wait: result.expiredWait, defect: result.notes?.defect ?? null, notes: result.notes, scratchUnchanged: unchanged, folders: folderState, configFolder, settings: { before: settingsBefore, after: settingsAfter }, cleanupConfirmed: confirmed });
  log(`outcome: ${result.outcome}${result.expiredWait ? ` (the ${result.expiredWait} wait expired)` : ''}; turns spent: ${run.turns}; scratch folders unchanged: ${unchanged ?? 'n/a'}${unchanged === false ? ` ${JSON.stringify(Object.fromEntries(Object.entries(folderState).filter(([, f]) => !f.unchanged)))}` : ''}; cleanup: ${confirmed ? 'confirmed' : 'NOT confirmed'}`);
  log(`configuration folder: ${JSON.stringify(configFolder)}`);
  // The notes one entry per line, and an outline one frame per line: kinds and counts, never a text.
  for (const [key, value] of Object.entries(result.notes ?? {})) {
    if (/^outline/.test(key) && Array.isArray(value)) { log(`${key}:`); for (const row of value) log(`  ${JSON.stringify(row)}`); } else log(`${key}: ${JSON.stringify(value)}`);
  }
  for (const which of [launcher, second]) {
    if (which.previous && !which.previous.cleanup?.confirmed) {
      warn(`${spike}: cleanup NOT confirmed. Still recorded: ${(which.previous.cleanup?.remaining ?? []).map(describe).join(', ') || 'unknown'}. Its launch record is kept.`);
      return EXIT.cleanupUnconfirmed;
    }
  }
  if (result.outcome === 'void') log("void: the spike's own defect. Fix it, then run again (at most two void runs per scenario).");
  return OUTCOME_EXIT[result.outcome] ?? EXIT.error;
}
