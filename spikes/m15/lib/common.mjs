// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What M15's spikes share (M15, Design 1): one frame for a scenario's run, with M10's launcher,
// deadlines, process-tree check, launch record, run ledger and capture format. Plain Node; nothing
// here is application code.
//
// One invocation is one run of one scenario. It prints its plan and its turn count, and launches
// only when --confirm-turns equals that count (S9). At most three runs per scenario (C4).
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CodexDriver, checkSessionStart } from '../../m10/codex/driver.mjs';
import { buildCapture } from '../../m10/lib/capture.mjs';
import { Cancelled, DeadlineExpired, EXIT } from '../../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../../m10/lib/env.mjs';
import { resolveExecutable } from '../../m10/lib/executable.mjs';
import { LaunchRecord, checkLaunchRecord, describe } from '../../m10/lib/launch-record.mjs';
import { Launcher } from '../../m10/lib/launcher.mjs';
import { Ledger } from '../../m10/lib/ledger.mjs';
import { SPIKES_DIR, writeJson } from '../../m10/lib/paths.mjs';
import { TRACE_FILES, buildScratch, compareManifest } from '../../m10/lib/scratch.mjs';
import { log, warn } from '../../m10/lib/spike.mjs';
import { CliExited } from '../../m10/lib/wire.mjs';
import { requireReady } from '../../m10/preflight.mjs';

export const M15_DIR = path.join(SPIKES_DIR, 'output', 'm15');

export function m15Path(...segments) {
  const file = path.join(M15_DIR, ...segments);
  if (!file.startsWith(M15_DIR + path.sep)) throw new Error('output path escapes spikes/output/m15');
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** What one invocation leaves for the next: the saved thread's id and its live items (raw; ignored folder). */
const STATE = () => m15Path('state.json');
export const readState = () => (existsSync(STATE()) ? JSON.parse(readFileSync(STATE(), 'utf8')) : {});
export const writeState = (patch) => writeJson(STATE(), { ...readState(), ...patch });

export const SANDBOX = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never' });

/** The file a turn is asked to read from a second folder, outside the thread's own (C2, C26). */
export const OUTSIDE_FILES = Object.freeze({ 'outside.txt': "The harbour master's dog is called Pepper, and it guards the east gate.\n" });

/** A strings-only copy of a frame with every string over 32 KiB cut, its length kept (C97's large output). */
const LONG = 32 * 1024;
function trimmed(value, found, key = null) {
  if (typeof value === 'string') {
    if (value.length <= LONG) return value;
    found.push({ key, chars: value.length, bytes: Buffer.byteLength(value) });
    return `${value.slice(0, 200)}<… ${value.length} characters in all, cut by the M15 spike>`;
  }
  if (Array.isArray(value)) return value.map((item) => trimmed(item, found, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimmed(v, found, k)]));
  return value;
}

/** M10's Codex driver, plus a resume, and the size of every received frame measured before it is cut. */
export class M15Driver extends CodexDriver {
  constructor(options) {
    super(options);
    this.frameBytes = [];
    this.longStrings = [];
    const inner = this.session.transform;
    this.session.transform = (raw) => {
      const frame = inner(raw);
      const found = [];
      const out = trimmed(frame, found);
      this.frameBytes.push({ method: frame?.method ?? 'response', item: frame?.params?.item?.type ?? null, bytes: Buffer.byteLength(JSON.stringify(frame)) });
      for (const entry of found) this.longStrings.push({ method: frame?.method ?? 'response', item: frame?.params?.item?.type ?? null, ...entry });
      return out;
    };
  }

  /** A request with a wait of its own length: the app gives a resume and a history page 30 s (C15). */
  async requestWithin(method, params, ms) {
    const id = ++this.counter;
    const from = this.nextIndex;
    await this.session.send({ method, id, params });
    const { frame, index } = await this.session.waitFor((f) => f.id === id && !('method' in f), { wait: 'request', ms, fromIndex: from });
    return frame.error ? { ok: false, error: frame.error, index } : { ok: true, value: frame.result, index };
  }

  async resumeThread(params) {
    const reply = await this.requestWithin('thread/resume', params, 30_000);
    if (reply.ok) this.threadId = reply.value?.thread?.id ?? params.threadId;
    return reply;
  }

  /** The largest frames received, biggest first. */
  largest(count = 5) { return [...this.frameBytes].sort((a, b) => b.bytes - a.bytes).slice(0, count); }
}

/** One line per received frame from `from` on: what it is and whose, never its text. */
export function outline(driver, from = 0) {
  const worker = new Map();
  const role = (id) => {
    if (typeof id !== 'string') return null;
    if (id === driver.threadId) return 'session';
    if (!worker.has(id)) worker.set(id, `worker-${worker.size + 1}`);
    return worker.get(id);
  };
  return driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && f.frame?.method).map(({ index, ms, frame }) => {
    const params = frame.params ?? {};
    const item = params.item ?? null;
    return Object.fromEntries(Object.entries({
      index, ms, method: frame.method, thread: role(params.threadId), request: frame.id !== undefined ? true : null,
      item: item?.type ?? null, kind: item?.kind ?? null, phase: item?.phase ?? null, tool: item?.tool ?? null,
      agent: item?.agentThreadId ? role(item.agentThreadId) : null,
      status: params.turn?.status ?? params.status?.type ?? item?.status ?? null,
    }).filter(([, value]) => value !== null));
  });
}

/** The items a turn's frames carried, by id: what a history read is compared with (C123). */
export function liveItems(driver, from = 0) {
  const items = new Map();
  for (const { dir, index, frame } of driver.session.frames) {
    if (dir !== 'recv' || index < from || frame?.method !== 'item/completed') continue;
    const params = frame.params ?? {};
    if (params.threadId !== driver.threadId || typeof params.item?.id !== 'string') continue;
    items.set(params.item.id, { id: params.item.id, type: params.item.type, phase: params.item.phase ?? null, clientId: params.item.clientId ?? null, turnId: params.turnId ?? null });
  }
  return [...items.values()];
}

/** A model the CLI lists as its default, and its lightest effort: what a traced turn names (C2). */
export async function pickModel(driver) {
  const reply = await driver.request('model/list', { limit: 100 });
  const models = reply.ok && Array.isArray(reply.value?.data) ? reply.value.data : [];
  const model = models.find((m) => m.isDefault) ?? models.find((m) => !m.hidden) ?? null;
  const efforts = (model?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  return { model: model?.model ?? null, effort: efforts.includes('low') ? 'low' : efforts[0] ?? null };
}

const OUTCOME_EXIT = { happened: EXIT.happened, 'did-not-happen': EXIT.didNotHappen, 'timed-out': EXIT.timedOut, 'not-run': EXIT.notRun, void: EXIT.void, cancelled: EXIT.cancelled };

export const happened = (notes = {}, successIndex = null) => ({ outcome: 'happened', successIndex, notes });
export const didNotHappen = (why, notes = {}) => ({ outcome: 'did-not-happen', successIndex: null, notes: { why, ...notes } });
export const notRun = (why, notes = {}) => ({ outcome: 'not-run', successIndex: null, notes: { why, ...notes } });

/**
 * Runs one scenario: `{ id, name, title, successCondition, turns, family?, run(ctx) }`.
 *
 * `ctx`: `open(label?)` makes and opens a driver (a second one gets a launcher of its own, since
 * M10's launcher refuses a launch while its earlier tree runs); `prompt(driver, text, extra?)`
 * counts the turn first; `wait(driver, predicate, from)` and `turnEnd(driver, from)` are bounded by
 * the scenario wait; `scratch` and `outside` are the two folders; `executable`, `waits`, `log`.
 *
 * `options`, for a later milestone's spikes that run as these do (M19's K1): `dir`, the output
 * folder in place of spikes/output/m15; `Driver`, a driver in place of M15's; `milestone`, the name
 * the plan and the capture's source say; `omitted`, what the capture says it leaves out. And for a
 * spike that runs in a configuration folder of its own (M22's K1): `environment()`, the launch's
 * environment in place of M10's clean one; `ready(launcher, waits, executable, cwd)`, the version
 * and login check made in it; `toolPermissions(scenario)`, what the capture says the thread was
 * started under and how its requests were answered.
 */
export async function runScenario(spike, scenario, { args, launcher, signal, waits }, options = {}) {
  const dir = options.dir ?? M15_DIR;
  const milestone = options.milestone ?? 'M15';
  const Driver = options.Driver ?? M15Driver;
  const at = (...segments) => {
    const file = path.join(dir, ...segments);
    if (!file.startsWith(dir + path.sep)) throw new Error('output path escapes the spike output folder');
    mkdirSync(path.dirname(file), { recursive: true });
    return file;
  };
  const ledger = new Ledger(at('ledger.json'));
  const previous = ledger.runsFor('codex', scenario.id);
  log(`plan: codex ${scenario.id} (${scenario.title})`);
  log(`  success: ${scenario.successCondition}`);
  log(`  turns this run: ${scenario.turns} (prompts sent to the model). Earlier runs: ${previous.length}; ${milestone} turns spent so far: ${ledger.turnsSpent()}`);
  if (String(args['confirm-turns']) !== String(scenario.turns)) {
    log(`nothing launched. Re-run with --confirm-turns ${scenario.turns} to spend ${scenario.turns} turn(s).`);
    return EXIT.happened;
  }
  const executable = resolveExecutable('codex', args.path);
  const run = ledger.open('codex', scenario.id, { again: Boolean(args.again) });
  log(`run ${run.id}: number ${run.number} of at most 3`);

  // A second process at the same time needs a launcher and a launch record of its own (as M14b's spike).
  const secondRecord = at('launched-second.json');
  await checkLaunchRecord({ file: secondRecord });
  const second = new Launcher({ spike, record: new LaunchRecord(spike, secondRecord), waits });
  const drivers = [];
  const result = { outcome: null, expiredWait: null, successIndex: null, notes: {} };
  let cliInfo = null;
  let scratch = null;
  let outside = null;
  let environment = null;
  let deadline = null;
  try {
    const probe = buildScratch('probe');
    cliInfo = options.ready ? await options.ready(launcher, waits, executable, probe.dir) : await requireReady(launcher, waits, 'codex', executable, probe.dir);
    scratch = buildScratch('m15', { ...TRACE_FILES, ...(scenario.files ?? {}) });
    outside = buildScratch('m15Outside', OUTSIDE_FILES);
    environment = options.environment ? options.environment() : cleanEnvironment('codex');
    const ctx = {
      args, executable, waits, scratch: scratch.dir, outside: outside.dir, probe: probe.dir, log,
      /** The app's own launch (C23): `codex app-server` in a folder that is no project's. */
      async open(label = 'main') {
        const free = (candidate) => !candidate.previous || candidate.previous.cleanup?.confirmed === true;
        const driver = new Driver({ launcher: drivers.length === 0 || (drivers.every((earlier) => earlier.cleanupState) && free(launcher)) ? launcher : second, executable, cwd: probe.dir, env: environment.env, waits, signal });
        driver.label = label;
        driver.onRequest(() => ({ decision: 'decline' }));
        drivers.push(driver);
        await driver.open();
        await driver.record('after-handshake');
        return driver;
      },
      async prompt(driver, text, extra = {}) {
        deadline ??= Date.now() + waits.scenario;
        ledger.countTurn(run);
        driver.nextTurn = { ...extra };
        return driver.prompt(text);
      },
      /** Counts a prompt that goes out by another request than the driver's own (M20b's turn on a child thread). */
      countTurn() { deadline ??= Date.now() + waits.scenario; ledger.countTurn(run); },
      wait(driver, predicate, from) {
        return driver.waitEvent(predicate, { wait: 'scenario', ms: deadline ? Math.max(1, deadline - Date.now()) : waits.scenario, from });
      },
      turnEnd(driver, from) { return this.wait(driver, (e) => e.kind === 'turn-end', from); },
      /** thread/start, saved (never `ephemeral`), with the reply checked as the app will check it (C21). */
      async startThread(driver, extra = {}) {
        const params = { cwd: scratch.dir, ...SANDBOX, ...extra };
        const reply = await driver.startThread(params);
        driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(SANDBOX, reply.value) : null };
        return reply;
      },
    };
    try {
      Object.assign(result, await scenario.run(ctx));
    } catch (error) {
      if (error instanceof CliExited) Object.assign(result, didNotHappen('the CLI exited during the scenario'));
      else throw error;
    }
  } catch (error) {
    if (error instanceof DeadlineExpired) Object.assign(result, { outcome: 'timed-out', expiredWait: error.wait });
    else if (error instanceof Cancelled) Object.assign(result, { outcome: 'cancelled', notes: { ...result.notes, why: error.reason } });
    else if (error?.exitCode === EXIT.cliMissing) { ledger.close(run, { status: 'not-run', notes: { why: error.message } }); throw error; }
    else Object.assign(result, { outcome: 'void', notes: { ...result.notes, defect: String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ') } });
  }

  const cleanups = await Promise.all(drivers.map((driver) => driver.cleanupState ?? driver.close()));
  const confirmed = cleanups.every((cleanup) => cleanup.confirmed);
  const scratchState = scratch ? compareManifest(scratch.dir, scratch.manifest) : null;
  const outsideState = outside ? compareManifest(outside.dir, outside.manifest) : null;
  const files = [];
  drivers.forEach((driver, i) => {
    if (!driver.session.recorder) return;
    const cleanup = cleanups[i];
    const capture = buildCapture({
      spike: `${spike}.mjs`, cli: cliInfo ?? { name: 'codex', version: null, kind: executable.kind }, scenario, driver, environment, waits,
      run: { id: run.id, number: run.number, attempt: run.attempt, variant: 'default', process: driver.label, outcome: result.outcome, expiredWait: result.expiredWait, successIndex: result.successIndex, turnsSpent: run.turns, cleanup: { confirmed: cleanup.confirmed, graceful: cleanup.graceful, forced: cleanup.forced, ms: cleanup.ms, recorded: cleanup.recorded }, scratchUnchanged: scratchState, outsideUnchanged: outsideState, notes: result.notes },
      sessionStart: driver.sessionStart ?? null,
      toolPermissions: options.toolPermissions ? options.toolPermissions(scenario) : { readTools: 'reads inside the read-only sandbox', scenarioTools: scenario.tools ?? [], preApproved: [], sandbox: SANDBOX.sandbox, approvalPolicy: SANDBOX.approvalPolicy, reviewer: null, policy: 'every request from the CLI is declined' },
      extra: {
        ...(scenario.family ? { family: scenario.family } : {}),
        ...(driver.sessionIds ? { sessionIds: driver.sessionIds } : {}),
        frameSizes: { largest: driver.largest(), longStringsCut: driver.longStrings },
      },
    });
    capture._fixture.source = `${milestone} spike ${spike}.mjs, run against the installed CLI on the maintainer's machine`;
    if (options.omitted) capture._fixture.omitted = options.omitted;
    const name = drivers.length > 1 ? `${scenario.name}-${driver.label}` : scenario.name;
    files.push(writeJson(at('raw', 'codex', `${name}.${run.id}.json`), capture));
  });
  run.capture = files.map((file) => path.relative(dir, file).split(path.sep).join('/')).join(', ') || null;
  ledger.close(run, { status: result.outcome, wait: result.expiredWait, defect: result.notes?.defect ?? null, notes: result.notes, scratchUnchanged: scratchState?.unchanged ?? null, cleanupConfirmed: confirmed });
  log(`outcome: ${result.outcome}${result.expiredWait ? ` (the ${result.expiredWait} wait expired)` : ''}; turns spent: ${run.turns}; scratch unchanged: ${scratchState?.unchanged ?? 'n/a'}; outside folder unchanged: ${outsideState?.unchanged ?? 'n/a'}; cleanup: ${confirmed ? 'confirmed' : 'NOT confirmed'}`);
  log(`notes: ${JSON.stringify(result.notes, null, 1)}`);
  if (second.previous && !second.previous.cleanup?.confirmed) {
    warn(`${spike}: cleanup NOT confirmed on the second process. Still recorded: ${(second.previous.cleanup?.remaining ?? []).map(describe).join(', ') || 'unknown'}. Its launch record is kept.`);
    return EXIT.cleanupUnconfirmed;
  }
  if (result.outcome === 'void') log("void: the spike's own defect. Fix it, then run again (at most two void runs per scenario).");
  return OUTCOME_EXIT[result.outcome] ?? EXIT.error;
}

/** `--scenario <id>` among `scenarios`, or the usage line. */
export function chooseScenario(spike, scenarios, args) {
  const scenario = scenarios[String(args.scenario ?? '')];
  if (!scenario) warn(`usage: node spikes/m15/${spike}.mjs --scenario ${Object.keys(scenarios).join('|')} [--confirm-turns <n>] [--again] [--path <executable>]`);
  return scenario ?? null;
}
