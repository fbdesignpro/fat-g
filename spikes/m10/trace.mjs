// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B5: one run of one scenario on one CLI (Design 6). One invocation is one run; a retry is a new
// invocation, numbered from the run ledger, and a fourth is refused.
//
//   node spikes/m10/trace.mjs --cli claude|codex --scenario t1..t8 [--confirm-turns <n>]
//        [--again] [--variable-set] [--codex-policy on-request|untrusted] [--effort-b <level>]
//        [--model-b <id>] [--path <executable>]
//   node spikes/m10/trace.mjs --mark-void <run id> --defect "<what was wrong in the spike>"
//
// Without --confirm-turns matching the scenario's own count it prints its plan and launches
// nothing (C11).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeDriver, tracingArgs } from './claude/driver.mjs';
import { CodexDriver, checkSessionStart } from './codex/driver.mjs';
import { buildCapture, saveRaw } from './lib/capture.mjs';
import { Cancelled, DeadlineExpired, EXIT } from './lib/deadlines.mjs';
import { QUESTION_TOOL_VARIABLE, cleanEnvironment } from './lib/env.mjs';
import { resolveExecutable } from './lib/executable.mjs';
import { Ledger } from './lib/ledger.mjs';
import { OUTPUT_DIR, isMain, outputPath } from './lib/paths.mjs';
import { TRACE_FILES, buildScratch, compareManifest } from './lib/scratch.mjs';
import { log, runSpike, warn } from './lib/spike.mjs';
import { CliExited } from './lib/wire.mjs';
import { requireReady } from './preflight.mjs';
import { READ_TOOLS, SCENARIOS } from './scenarios/index.mjs';

const OUTCOME_EXIT = { happened: EXIT.happened, 'did-not-happen': EXIT.didNotHappen, 'timed-out': EXIT.timedOut, 'not-run': EXIT.notRun, void: EXIT.void, cancelled: EXIT.cancelled, 'cli-cannot': EXIT.didNotHappen };

/** C49 for Claude: a read tool may only read inside the scratch folder. */
export function readsInside(input, dir) {
  const inside = (p) => {
    if (typeof p !== 'string' || p.length === 0) return true;
    const resolved = path.resolve(dir, p);
    return resolved.toLowerCase() === dir.toLowerCase() || resolved.toLowerCase().startsWith(dir.toLowerCase() + path.sep);
  };
  const pattern = typeof input?.pattern === 'string' ? input.pattern : '';
  if (path.isAbsolute(pattern) || pattern.includes('..')) return false;
  return inside(input?.file_path) && inside(input?.path) && inside(input?.notebook_path);
}

/** The request policy of C49, the same for a worker's requests as for the session's own. */
export function requestPolicy(cli, scenario, dir) {
  return (info) => {
    if (cli === 'claude') {
      if (!scenario.claudeTools.includes(info.tool)) return { decision: 'deny', message: 'That tool is not available here.' };
      if (READ_TOOLS.includes(info.tool)) return readsInside(info.input, dir) ? { decision: 'allow' } : { decision: 'deny', message: 'Reading outside the working folder is not allowed.' };
      if (info.tool === 'Agent') return { decision: 'allow' };
      return scenario.decide?.(info) ?? { decision: 'deny' };
    }
    if (info.requestKind === 'question') return scenario.decide?.(info) ?? { decision: 'decline' };
    return scenario.id === 't7' ? scenario.decide(info) : { decision: 'decline' };
  };
}

function readJsonIf(file) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }

/** Effort and model choices for T2 and T8, from discovery unless given. */
export function scenarioParams(cli, args) {
  const discovery = readJsonIf(outputPath(`discovery-${cli}.json`));
  const summary = discovery?.summary ?? {};
  return {
    lowerEffort: typeof args['effort-b'] === 'string' ? args['effort-b'] : summary.lowerEffort ?? null,
    modelB: typeof args['model-b'] === 'string' ? args['model-b'] : summary.modelB ?? null,
  };
}

export function codexThreadFields() {
  return readJsonIf(outputPath('schema', 'fields-of-interest.json'));
}

async function trace({ args, launcher, signal, waits }) {
  if (typeof args['mark-void'] === 'string') {
    const run = new Ledger().markVoid(args['mark-void'], String(args.defect ?? 'unspecified'));
    log(`marked ${run.id} void (${run.turns} turn(s) stay counted): ${run.defect}`);
    return EXIT.happened;
  }
  const cli = args.cli;
  const scenario = SCENARIOS[args.scenario];
  if (!['claude', 'codex'].includes(cli) || !scenario) { warn('usage: --cli claude|codex --scenario t1..t8'); return EXIT.error; }
  const variant = args['variable-set'] ? 'variable-set' : 'default';
  if (variant === 'variable-set' && !(cli === 'claude' && scenario.id === 't6')) { warn('--variable-set is for Claude T6 only (C65)'); return EXIT.error; }
  const executable = resolveExecutable(cli, args.path);
  const params = scenarioParams(cli, args);
  const ledger = new Ledger();
  const previous = ledger.runsFor(cli, scenario.id, variant);
  const tools = cli === 'claude' ? scenario.claudeTools : null;
  log(`plan: ${cli} ${scenario.id} (${scenario.title})${variant === 'default' ? '' : ` [${variant}]`}`);
  log(`  success: ${scenario.successCondition}`);
  log(`  turns this run: ${scenario.turns} (prompts sent to the model). Earlier runs: ${previous.length}, turns spent so far overall: ${ledger.turnsSpent()}`);
  if (tools) log(`  tools: ${tools.join(', ')}`);
  if (Number(args['confirm-turns']) !== scenario.turns) {
    log(`nothing launched. Re-run with --confirm-turns ${scenario.turns} to spend ${scenario.turns} turn(s).`);
    return EXIT.happened;
  }
  const run = ledger.open(cli, scenario.id, { variant, again: Boolean(args.again) });
  log(`run ${run.id}: number ${run.number} of at most 3`);
  const result = { outcome: null, expiredWait: null, successIndex: null, notes: {}, sessionStart: null, codexCheck: null };
  let driver = null;
  let cliInfo = null;
  let scratch = null;
  let environment = null;
  let requested = null;
  try {
    const probe = buildScratch('probe');
    cliInfo = await requireReady(launcher, waits, cli, executable, probe.dir);
    scratch = buildScratch('trace', TRACE_FILES);
    environment = cleanEnvironment(cli, { extra: variant === 'variable-set' ? { [QUESTION_TOOL_VARIABLE]: '1' } : {} });
    const common = { launcher, executable, cwd: scratch.dir, env: environment.env, waits, signal };
    driver = cli === 'claude'
      ? new ClaudeDriver({ ...common, args: tracingArgs({ tools, model: scenario.launchModel }) })
      : new CodexDriver(common);
    driver.onRequest(requestPolicy(cli, scenario, scratch.dir));

    // Session start. A failure here is T5's capture, and any other scenario's finding.
    let startFailure = null;
    if (cli === 'claude') {
      try {
        const init = await driver.open();
        result.sessionStart = { request: { subtype: 'initialize' }, replyIndex: init.index, ok: init.ok };
        if (!init.ok) startFailure = { stage: 'initialize', index: init.index };
      } catch (error) {
        if (!(error instanceof CliExited)) throw error;
        startFailure = { stage: 'launch', index: lastRecvIndex(driver) };
      }
    } else {
      await driver.open();
      const fields = codexThreadFields();
      if (!fields) throw new Error('run schema.mjs first: fields-of-interest.json is missing');
      requested = scenario.id === 't7'
        ? { sandbox: 'read-only', approvalPolicy: typeof args['codex-policy'] === 'string' ? args['codex-policy'] : 'on-request', approvalsReviewer: 'user' }
        : { sandbox: 'read-only', approvalPolicy: 'never' };
      const ephemeral = fields.ThreadStartParams?.includes('ephemeral');
      const threadParams = { cwd: scratch.dir, ...requested, ...(ephemeral ? { ephemeral: true } : {}), ...(scenario.launchModel ? { model: scenario.launchModel } : {}) };
      const reply = await driver.startThread(threadParams);
      result.sessionStart = { request: threadParams, replyIndex: reply.index, ok: reply.ok };
      if (!reply.ok) startFailure = { stage: 'thread/start', index: reply.index };
      else {
        result.codexCheck = checkSessionStart(requested, reply.value);
        if (!ephemeral) await driver.request('thread/name/set', { threadId: driver.threadId, name: `fat-g spike ${scenario.id} ${run.id}` });
      }
    }
    await driver.record('after-handshake');

    if (startFailure) {
      if (scenario.fromStartFailure) Object.assign(result, scenario.fromStartFailure(startFailure));
      else Object.assign(result, { outcome: 'did-not-happen', notes: { why: `the session failed at ${startFailure.stage}` } });
    } else if (result.codexCheck && !result.codexCheck.passed) {
      Object.assign(result, { outcome: 'not-run', notes: { why: 'the session-start reply differed from the request (C58)', rows: result.codexCheck.rows } });
    } else {
      let deadline = null;
      const ctx = {
        cli, driver, params,
        async prompt(text) {
          deadline ??= Date.now() + waits.scenario;
          ledger.countTurn(run);
          await driver.record('before-prompt');
          return driver.prompt(text);
        },
        wait(predicate, from) {
          const ms = deadline ? Math.max(1, deadline - Date.now()) : waits.scenario;
          return driver.waitEvent(predicate, { wait: 'scenario', ms, from });
        },
        /** Asks the CLI what is in force, without a turn: get_settings, or thread/read. */
        async reportSettings() {
          const reply = cli === 'claude' ? await driver.getSettings() : await driver.readThread();
          return reply.ok;
        },
      };
      try {
        Object.assign(result, await scenario.run(ctx));
      } catch (error) {
        if (error instanceof CliExited && scenario.fromStartFailure) Object.assign(result, scenario.fromStartFailure({ stage: 'turn', index: lastRecvIndex(driver) }));
        else if (error instanceof CliExited) Object.assign(result, { outcome: 'did-not-happen', notes: { why: 'the CLI exited during the scenario' } });
        else throw error;
      }
      if (result.outcome === 'happened') await driver.record('after-success');
    }
  } catch (error) {
    if (error instanceof DeadlineExpired) Object.assign(result, { outcome: 'timed-out', expiredWait: error.wait });
    else if (error instanceof Cancelled) Object.assign(result, { outcome: 'cancelled', notes: { why: error.reason } });
    else if (error?.exitCode === EXIT.cliMissing) { ledger.close(run, { status: 'not-run', notes: { why: error.message } }); throw error; }
    else Object.assign(result, { outcome: 'void', notes: { defect: String(error?.stack ?? error).split('\n').slice(0, 3).join(' | ') } });
  }
  const cleanup = driver ? await driver.close() : { confirmed: true, notLaunched: true };
  const scratchState = scratch ? compareManifest(scratch.dir, scratch.manifest) : null;
  if (driver?.session.recorder) {
    const capture = buildCapture({
      spike: 'trace.mjs', cli: cliInfo ?? { name: cli, version: null, kind: executable.kind }, scenario, driver, environment, waits,
      run: { id: run.id, number: run.number, attempt: run.attempt, variant, outcome: result.outcome, expiredWait: result.expiredWait, successIndex: result.successIndex, turnsSpent: run.turns, cleanup: { confirmed: cleanup.confirmed, graceful: cleanup.graceful, forced: cleanup.forced, ms: cleanup.ms, recorded: cleanup.recorded }, scratchUnchanged: scratchState, notes: result.notes },
      sessionStart: { ...result.sessionStart, check: result.codexCheck },
      toolPermissions: cli === 'claude'
        ? { readTools: READ_TOOLS, scenarioTools: tools.filter((t) => !READ_TOOLS.includes(t)), preApproved: [], permissionMode: 'default', permissionRequestsTo: 'the spike (--permission-prompt-tool stdio)', policy: 'tools outside the list are unavailable; reads outside the scratch folder are denied; every other request is answered by the scenario' }
        : { readTools: 'reads inside the read-only sandbox', scenarioTools: { t3: ['sub-agent'], t6: ['request_user_input'], t7: ['approval requests'] }[scenario.id] ?? [], preApproved: [], sandbox: requested?.sandbox ?? null, approvalPolicy: requested?.approvalPolicy ?? null, reviewer: requested?.approvalsReviewer ?? null, policy: 'every approval request outside T7 is declined' },
      extra: variant === 'variable-set' ? { variableSet: [QUESTION_TOOL_VARIABLE] } : {},
    });
    const file = saveRaw(cli, `${scenario.name}${variant === 'default' ? '' : `.${variant}`}.${run.id}`, capture);
    run.capture = path.relative(OUTPUT_DIR, file).split(path.sep).join('/');
  }
  ledger.close(run, { status: result.outcome, wait: result.expiredWait, defect: result.notes?.defect ?? null, notes: result.notes, scratchUnchanged: scratchState?.unchanged ?? null, cleanupConfirmed: cleanup.confirmed });
  log(`outcome: ${result.outcome}${result.expiredWait ? ` (the ${result.expiredWait} wait expired)` : ''}; turns spent: ${run.turns}; scratch unchanged: ${scratchState?.unchanged ?? 'n/a'}; cleanup: ${cleanup.confirmed ? 'confirmed' : 'NOT confirmed'}`);
  log(`notes: ${JSON.stringify(result.notes)}`);
  if (result.outcome === 'void') log(`void: the spike's own defect. Fix it, then run again (at most two void runs per scenario and CLI).`);
  return OUTCOME_EXIT[result.outcome] ?? EXIT.error;
}

function lastRecvIndex(driver) {
  const frames = driver?.session.frames ?? [];
  for (let i = frames.length - 1; i >= 0; i--) if (frames[i].dir === 'recv') return frames[i].index;
  return null;
}

if (isMain(import.meta.url)) await runSpike('trace', trace);
