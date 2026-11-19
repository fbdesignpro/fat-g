// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M22b spike K2 (docs/planning/_archive/M22b-spec-sheet.md; C5, C13–C15, C28, C53, C55): Codex's plan turns, under
// production's handshake as M19 leaves it plus the experimental API (C13), with `item/plan/delta`
// kept beside the message delta (C14), in M22's scratch Codex configuration folder (`CODEX_HOME`,
// C46): the maintainer's own Codex configuration is neither read nor changed.
//
//   node spikes/m22b/k2.mjs --list
//   node spikes/m22b/k2.mjs --scenario <name> --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C46). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m22b). `chain` starts the saved thread under Ask first and leaves its id: a plan
// turn, a second plan turn with feedback, then on the same process a plain prompt with no
// `collaborationMode` and an Execute turn naming `default` (C15, C55). `resumed` resumes it, makes
// one more plan turn, closes that process, and resumes it again in a new one for a plain prompt
// naming `default`. `skip` and `empty` are plan turns under Read only whose blocking question is
// answered "No answer" under each id, or with an empty list (C53). `modes` makes one plan turn under
// each of Sandbox ok, Auto-reviewed and Berserk (C5). `history` reads the saved thread from a process
// that never resumed it (C28), and sends no prompt.
//
// The spike accepts only a file change whose every path is in the scratch working folder, and only
// in a turn that is not a plan turn; a command is declined, a request for more permissions is
// granted nothing, and every request during a plan turn is declined.
//
// What a run records is never a text of the model's: each plan item's shape — its deltas' count and
// keys, its length and lines, and whether the deltas add up to the completed text — each request's
// fields and the reply the spike sent, the items each turn made, what `thread/settings/updated` says
// of the collaboration mode, which files the scratch folder holds, and what a history read holds.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLIENT_INFO, checkSessionStart } from '../m10/codex/driver.mjs';
import { EXIT, settlesWithin, sleep } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { TRACE_FILES } from '../m10/lib/scratch.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { instanceEnvironment } from '../m14b/lib/instance-env.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, productionDeltaMethods, received } from '../m19/lib/common.mjs';
import { CODEX_HOME } from '../m22/k1.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { EXECUTE_WORDS, FEEDBACK, M22B_DIR, NO_ANSWER, PROMPTS, inFolder, readState, shapeOf, tidy, typeCounts, whereIs, writeState } from './lib/common.mjs';

const PLAN_DELTA = 'item/plan/delta';
const KEPT = Object.freeze([CODEX_TEXT_DELTA, PLAN_DELTA]);
const QUESTION_REQUEST = 'item/tool/requestUserInput';
const COMMAND_REQUEST = 'item/commandExecution/requestApproval';
const FILE_REQUEST = 'item/fileChange/requestApproval';
const PERMISSIONS_REQUEST = 'item/permissions/requestApproval';
const APPROVALS = new Set([COMMAND_REQUEST, FILE_REQUEST, PERMISSIONS_REQUEST]);
const RESOLVED = 'serverRequest/resolved';
const SETTINGS = 'thread/settings/updated';

/** fat-g's five modes as the app starts a thread under each (src/main/providers/codex/modes.ts). */
const MODES = Object.freeze({
  'read-only': { sandbox: 'read-only', approvalPolicy: 'never' },
  'ask-first': { sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
  'sandbox-ok': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  'auto-reviewed': { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
  berserk: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
});

/** The collaboration mode a turn names (C13, C55): the record's model and effort, null instructions. */
const collaboration = (mode, model) => ({ collaborationMode: { mode, settings: { model: model.model, reasoning_effort: model.effort ?? null, developer_instructions: null } } });

/** The item a request names, from the frames received so far. */
const itemOf = (driver, itemId) => received(driver).map((f) => f.frame).filter((f) => (f?.method === 'item/started' || f?.method === 'item/completed') && f.params?.item?.id === itemId).at(-1)?.params.item ?? null;

/**
 * M19's driver under production's handshake less the opt-out of the two deltas kept, with the
 * experimental API asked for (C13). A question request goes to the scenario's rule; an approval is
 * accepted only for a file change in the scratch folder outside a plan turn; anything else declined.
 */
class K2Driver extends M19CodexDriver {
  constructor(options) {
    super(options);
    this.questionRule = null;
    this.inPlanTurn = false;
    this.scratch = null;
    this.answered = [];
    this.decisions = [];
  }

  async open() {
    const table = this.table;
    this.session.recorderOptions.isDelta = (frame) => table.isDelta(frame) && !KEPT.includes(frame?.method);
    await this.startWire();
    this.session.recorder.deltas.requested = true;
    this.session.recorder.deltas.kept = [...KEPT];
    this.optedOut = productionDeltaMethods().filter((method) => !KEPT.includes(method));
    const reply = await this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { optOutNotificationMethods: this.optedOut, experimentalApi: true } }, 'startup');
    await this.session.send({ method: 'initialized' });
    return reply;
  }

  incoming(frame, index) {
    if (frame?.id !== undefined && frame.method === QUESTION_REQUEST) {
      this.requestsSeen.push({ kind: QUESTION_REQUEST, requestKind: 'question' });
      const reply = this.questionRule?.(frame.params ?? {}) ?? { answers: {} };
      this.answered.push({ id: frame.id, index, atMs: this.tree.elapsed(), reply });
      this.requestsSeen.at(-1).answer = 'answers';
      this.session.send({ id: frame.id, result: reply }).catch(() => {});
      return;
    }
    if (frame?.id !== undefined && APPROVALS.has(frame.method)) {
      this.requestsSeen.push({ kind: frame.method, requestKind: 'approval' });
      const changes = frame.method === FILE_REQUEST ? itemOf(this, frame.params?.itemId)?.changes : null;
      const inScratch = Array.isArray(changes) && changes.length > 0 && changes.every((change) => inFolder(change?.path, this.scratch));
      const result = frame.method === PERMISSIONS_REQUEST ? { permissions: {}, scope: 'turn' } : { decision: !this.inPlanTurn && inScratch ? 'accept' : 'decline' };
      this.decisions.push({ id: frame.id, index, atMs: this.tree.elapsed(), method: frame.method, result, inPlanTurn: this.inPlanTurn });
      this.requestsSeen.at(-1).answer = JSON.stringify(result).slice(0, 80);
      this.session.send({ id: frame.id, result }).catch(() => {});
      return;
    }
    super.incoming(frame, index);
  }
}

/** A one-shot command in the scratch configuration, through the launcher's confirmed teardown (M22's K1). */
async function once(launcher, executable, args, { cwd, waits, env }) {
  const tree = await launcher.launch({ executable, args, cwd, env });
  let stdout = '';
  if (tree.child) { tree.stdout.setEncoding('utf8'); tree.stdout.on('data', (chunk) => { if (stdout.length < 100_000) stdout += chunk; }); tree.stdin.end(); }
  await settlesWithin(tree.closed, waits.request);
  const code = tree.exitInfo?.code ?? null;
  await tree.teardown();
  return { code, stdout, stderr: tree.stderrTail ?? '' };
}

function environment() {
  const { env } = instanceEnvironment('codex', CODEX_HOME);
  return { env, removed: cleanEnvironment('codex').removed, set: ['CODEX_HOME'] };
}

/** The CLI's version, and that the scratch configuration folder is signed in. No login is ever started. */
async function ready(launcher, waits, executable, cwd) {
  const fail = (message) => Object.assign(new Error(message), { exitCode: EXIT.cliMissing });
  if (!existsSync(CODEX_HOME) || !existsSync(path.join(path.dirname(CODEX_HOME), '.fat-g-spike'))) throw fail(`the scratch Codex configuration folder, or the spikes' marker beside it, is not at ${CODEX_HOME} (spikes/README.md, M22).`);
  const { env } = environment();
  const version = parseVersion((await once(launcher, executable, ['--version'], { cwd, waits, env })).stdout);
  const status = await once(launcher, executable, ['login', 'status'], { cwd, waits, env });
  if (!version || !codexLoggedIn(status)) throw fail(`codex is ${version ? 'not logged in in the scratch configuration folder' : 'not answering --version'}. Sign in from your own terminal, with CODEX_HOME naming that folder (agents never log in).`);
  return { name: 'codex', version, kind: executable.kind };
}

const OPTIONS = {
  dir: M22B_DIR, milestone: 'M22b', Driver: K2Driver, omitted: OMITTED_CODEX.map((entry) => entry.replace('ten delta kinds', 'nine delta kinds')), environment, ready,
  toolPermissions: (scenario) => ({ readTools: 'reads inside the sandbox', scenarioTools: [], preApproved: [], sandbox: scenario.modes ?? 'per thread/start, as each scenario names it', approvalPolicy: 'per thread/start', reviewer: 'user', policy: 'a file change whose every path is in the scratch working folder is accepted outside a plan turn; a command is declined; every request during a plan turn is declined; a request for more permissions is granted nothing; a question is answered as the scenario says' }),
};

const foldersOf = (ctx) => ({ 'working folder': ctx.scratch, 'outside the folder': ctx.outside, 'configuration folder': CODEX_HOME, 'app-server folder': ctx.probe });
const errorOf = (reply, folders) => (reply.ok ? null : { code: reply.error?.code ?? null, message: tidy(String(reply.error?.message ?? ''), folders) });

/** A saved thread in the working folder under `profile`, as the app asks for one; the reply says what Codex took. */
async function openThread(ctx, driver, profile, model) {
  driver.scratch = ctx.scratch;
  const params = { cwd: ctx.scratch, ...profile, model: model.model };
  const reply = await driver.startThread(params);
  driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(profile, reply.value) : null };
  return { ok: reply.ok, error: errorOf(reply, foldersOf(ctx)), asked: profile, matchesWhatWasAsked: reply.ok ? driver.sessionStart.check.passed : null, collaborationMode: modeIn(reply.value) };
}

/** Resumes a saved thread as the app does, under `profile`. */
async function resumeThread(ctx, driver, threadId, profile) {
  driver.scratch = ctx.scratch;
  const params = { threadId, cwd: ctx.scratch, excludeTurns: true, ...profile };
  const reply = await driver.resumeThread(params);
  driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(profile, reply.value) : null };
  return { ok: reply.ok, error: errorOf(reply, foldersOf(ctx)), asked: profile, matchesWhatWasAsked: reply.ok ? driver.sessionStart.check.passed : null, replyKeys: reply.ok ? Object.keys(reply.value ?? {}).sort() : null, collaborationMode: modeIn(reply.value) };
}

/** Where a value names a collaboration mode, at any depth: its path and its mode. */
function modeIn(value, at = '') {
  if (!value || typeof value !== 'object') return null;
  if (value.collaborationMode && typeof value.collaborationMode === 'object') return { at: `${at}collaborationMode`, mode: value.collaborationMode.mode ?? null, settingsKeys: Object.keys(value.collaborationMode.settings ?? {}).sort() };
  for (const [key, child] of Object.entries(value)) {
    if (key === 'turns' || key === 'items') continue;
    const found = modeIn(child, `${at}${key}.`);
    if (found) return found;
  }
  return null;
}

/** A turn as the app starts one (session.ts), plus what the scenario adds; counted once Codex took it. */
async function startTurn(driver, ctx, text, model, extra = {}) {
  const from = driver.nextIndex;
  const params = { threadId: driver.threadId, input: [{ type: 'text', text, text_elements: [] }], model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID(), ...extra };
  const reply = await driver.requestWithin('turn/start', params, 15_000);
  if (reply.ok) { ctx.countTurn(); driver.turnId = reply.value?.turn?.id ?? null; driver.turnActive = true; }
  return { from, ok: reply.ok, turnId: driver.turnId, error: reply.ok ? null : { code: reply.error?.code ?? null, message: String(reply.error?.message ?? '').slice(0, 200) } };
}

const framesOf = (driver, method, from) => received(driver, from).filter((f) => f.frame?.method === method);

/** Each plan item of the session's thread from `from` on: its frames, its deltas' shape, and whether they add up to its completed text. */
function planItems(driver, from) {
  const mine = received(driver, from).filter((f) => f.frame?.params?.threadId === driver.threadId);
  const started = mine.filter((f) => f.frame.method === 'item/started' && f.frame.params.item?.type === 'plan');
  return started.map((entry) => {
    const id = entry.frame.params.item.id;
    const deltas = mine.filter((f) => f.frame.method === PLAN_DELTA && f.frame.params.itemId === id);
    const done = mine.find((f) => f.frame.method === 'item/completed' && f.frame.params.item?.id === id) ?? null;
    const joined = deltas.map((f) => String(f.frame.params.delta ?? '')).join('');
    const text = done ? done.frame.params.item.text : undefined;
    return {
      startedIndex: entry.index, startedKeys: Object.keys(entry.frame.params.item).sort(), textAtStart: shapeOf(entry.frame.params.item.text),
      deltas: deltas.length, deltaParamKeys: Object.keys(deltas[0]?.frame.params ?? {}).sort(), firstDeltaMs: deltas[0] ? Math.round(deltas[0].ms - entry.ms) : null,
      completed: done ? { index: done.index, keys: Object.keys(done.frame.params.item).sort(), text: shapeOf(text), msAfterTheLastDelta: deltas.length ? Math.round(done.ms - deltas.at(-1).ms) : null } : null,
      deltasEqualTheCompletedText: done ? joined === text : null, deltaUnits: joined.length,
    };
  });
}

/** A turn's requests, items and end from `from` on: kinds and counts, never a text. */
function turnFacts(driver, from, ctx) {
  const folders = foldersOf(ctx);
  const mine = received(driver, from);
  const completed = mine.filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.threadId === driver.threadId).map((f) => f.frame.params.item ?? {});
  const end = mine.find((f) => f.frame?.method === 'turn/completed' && f.frame.params?.threadId === driver.threadId);
  const methods = {};
  for (const f of mine) if (f.frame?.method && !KEPT.includes(f.frame.method)) methods[f.frame.method] = (methods[f.frame.method] ?? 0) + 1;
  return {
    planItems: planItems(driver, from),
    approvals: driver.decisions.filter((d) => d.index >= from).map((d) => ({ method: d.method, result: d.result, inPlanTurn: d.inPlanTurn })),
    questions: framesOf(driver, QUESTION_REQUEST, from).map((entry) => {
      const params = entry.frame.params ?? {};
      const reply = driver.answered.find((a) => a.id === entry.frame.id) ?? null;
      const resolved = framesOf(driver, RESOLVED, from).find((f) => String(f.frame.params?.requestId) === String(entry.frame.id)) ?? null;
      return {
        index: entry.index, keys: Object.keys(params).sort(), questions: Array.isArray(params.questions) ? params.questions.map((q) => ({ keys: Object.keys(q).sort(), options: Array.isArray(q.options) ? q.options.length : null, isOther: q.isOther ?? null })) : null,
        reply: reply ? reply.reply : null, resolved: resolved ? { index: resolved.index, msAfterTheReply: reply ? Math.round(resolved.ms - reply.atMs) : null } : null,
      };
    }),
    messages: completed.filter((item) => item.type === 'agentMessage').map((item) => ({ phase: item.phase ?? null, units: String(item.text ?? '').length, questions: Array.isArray(item.questions) ? item.questions.length : null })),
    fileChanges: completed.filter((item) => item.type === 'fileChange').map((item) => ({ status: item.status ?? null, where: Array.isArray(item.changes) ? item.changes.map((change) => whereIs(change?.path, folders)) : null })),
    commands: completed.filter((item) => item.type === 'commandExecution').map((item) => ({ status: item.status ?? null, actions: Array.isArray(item.commandActions) ? item.commandActions.map((a) => a?.type ?? null) : null })),
    otherItems: completed.filter((item) => !['agentMessage', 'userMessage', 'reasoning', 'plan', 'fileChange', 'commandExecution'].includes(item.type)).map((item) => item.type),
    settings: framesOf(driver, SETTINGS, from).map((f) => ({ index: f.index, keys: Object.keys(f.frame.params?.threadSettings ?? {}).sort(), collaborationMode: modeIn(f.frame.params) })),
    errors: framesOf(driver, 'error', from).map((f) => ({ willRetry: f.frame.params?.willRetry ?? null, message: tidy(String(f.frame.params?.error?.message ?? ''), folders, 200) })),
    end: end ? { index: end.index, status: end.frame.params.turn?.status ?? null, error: end.frame.params.turn?.error ? Object.keys(end.frame.params.turn.error).sort() : null } : null,
    methods,
  };
}

const outlineOf = (driver, from) => codex.outline(driver, from).filter((row) => !KEPT.includes(row.method) && row.method !== 'thread/tokenUsage/updated' && row.method !== 'mcpServer/startupStatus/updated');

/** One prompt through to its turn's end: a plan turn where `mode` is `plan`, the collaboration mode named where `mode` is given. */
async function turn(ctx, driver, text, model, mode = null) {
  driver.inPlanTurn = mode === 'plan';
  const started = await startTurn(driver, ctx, text, model, mode ? collaboration(mode, model) : {});
  if (!started.ok) return { asked: mode ?? 'none', refused: true, error: started.error, outline: outlineOf(driver, started.from) };
  const end = await ctx.turnEnd(driver, started.from);
  await sleep(1_500);
  return { asked: mode ?? 'none', refused: false, endIndex: end.index, ...turnFacts(driver, started.from, ctx), outline: outlineOf(driver, started.from) };
}

/** Which of the files the prompts name the scratch folder holds now, and whether notes-1.txt took the plan's line. */
const filesNow = (ctx) => {
  const notes = path.join(ctx.scratch, 'notes-1.txt');
  return {
    'plain-after-plan.txt': existsSync(path.join(ctx.scratch, 'plain-after-plan.txt')), 'after-resume.txt': existsSync(path.join(ctx.scratch, 'after-resume.txt')),
    'notes-1.txt took the line': existsSync(notes) ? readFileSync(notes, 'utf8') !== TRACE_FILES['notes-1.txt'] && /reviewed/.test(readFileSync(notes, 'utf8')) : null,
    'notes-2.txt changed': existsSync(path.join(ctx.scratch, 'notes-2.txt')) ? readFileSync(path.join(ctx.scratch, 'notes-2.txt'), 'utf8') !== TRACE_FILES['notes-2.txt'] : null,
  };
};

const common = (driver, from, extra = {}) => ({ ...extra, typeCounts: typeCounts(driver, (frame) => frame?.method ?? 'response', from) });

/** Set from `--model` before a run: a model the scratch account lists, named in place of its default (M21's plan question came from another). */
let MODEL = null;

/** The model a run names: `--model` where the account lists it, else the saved one, else the account's default. */
async function modelOf(driver) {
  if (MODEL === null) return readState().codexModel ?? codex.pickModel(driver);
  const reply = await driver.request('model/list', { limit: 100 });
  const listed = (reply.ok && Array.isArray(reply.value?.data) ? reply.value.data : []).find((m) => m.model === MODEL);
  if (!listed) return { model: null, effort: null };
  const efforts = (listed.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  return { model: MODEL, effort: efforts.includes('low') ? 'low' : efforts[0] ?? null };
}

/** A plan turn under Read only whose prompt invites Codex's blocking question, answered by `rule`. */
async function questionTurn(ctx, rule, label) {
  const driver = await ctx.open();
  const model = await modelOf(driver);
  if (!model.model) return codex.notRun(MODEL ? `the scratch account does not list ${MODEL}` : 'the CLI listed no model');
  const thread = await openThread(ctx, driver, MODES['read-only'], model);
  if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
  driver.questionRule = rule;
  const only = await turn(ctx, driver, PROMPTS.codexPlanQuestion, model, 'plan');
  const notes = common(driver, 0, { model, reply: label, thread, turn: only });
  if (only.refused) return codex.didNotHappen('turn/start with collaborationMode was refused', notes);
  if (only.questions.length === 0) return codex.didNotHappen(`no ${QUESTION_REQUEST} came in the plan turn`, notes);
  return codex.happened(notes, only.endIndex);
}

const SCENARIOS = {
  chain: {
    id: 'm22b-chain', name: 'm22b-codex-chain', turns: 4, files: FILES, modes: 'ask-first',
    title: 'K2: under Ask first, a plan turn, feedback as a second plan turn, then on the same process a plain prompt with no collaborationMode and Execute naming default (C13–C15, C55)',
    successCondition: "Each plan item's deltas and completed text, whether the plain prompt plans or writes, and whether Execute implements",
    async run(ctx) {
      const driver = await ctx.open();
      const model = await codex.pickModel(driver);
      if (!model.model) return codex.notRun('the CLI listed no model');
      const thread = await openThread(ctx, driver, MODES['ask-first'], model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      writeState({ codexThreadId: driver.threadId, codexModel: model, codexSeededAt: new Date().toISOString() });
      const notes = { model, thread };
      const steps = [['plan', PROMPTS.codexPlan, 'plan'], ['feedback', FEEDBACK, 'plan'], ['plainAfterPlan', PROMPTS.plainAfterPlan, null], ['execute', EXECUTE_WORDS, 'default']];
      let last = null;
      for (const [key, text, mode] of steps) {
        const done = await turn(ctx, driver, text, model, mode);
        notes[key] = { ...done, filesAfter: filesNow(ctx) };
        if (done.refused) return codex.didNotHappen(`the ${key} turn/start was refused`, common(driver, 0, notes));
        last = done.endIndex;
      }
      if (notes.plan.planItems.length === 0) return codex.didNotHappen('the first plan turn made no plan item', common(driver, 0, notes));
      return codex.happened(common(driver, 0, notes), last);
    },
  },

  resumed: {
    id: 'm22b-resumed', name: 'm22b-codex-resumed', family: 'm22b-resumed', turns: 2, files: FILES, modes: 'ask-first',
    title: 'K2: the saved thread resumed for one more plan turn, its process closed, then resumed in a new one for a plain prompt naming default (C55)',
    successCondition: 'What the resume replies say of the collaboration mode, and whether the prompt naming default writes its file',
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no saved thread: run --scenario chain first');
      const first = await ctx.open('first');
      const notes = { first: { resume: await resumeThread(ctx, first, state.codexThreadId, MODES['ask-first']) } };
      if (!notes.first.resume.ok) return codex.didNotHappen('thread/resume was refused', notes);
      notes.first.plan = await turn(ctx, first, PROMPTS.codexPlanSecond, state.codexModel, 'plan');
      if (notes.first.plan.refused) return codex.didNotHappen('the plan turn/start was refused', notes);
      first.cleanupState = await first.close();
      const second = await ctx.open('resumed');
      notes.resumed = { resume: await resumeThread(ctx, second, state.codexThreadId, MODES['ask-first']) };
      if (!notes.resumed.resume.ok) return codex.didNotHappen('the second thread/resume was refused', notes);
      notes.resumed.plain = await turn(ctx, second, PROMPTS.afterResume, state.codexModel, 'default');
      notes.files = filesNow(ctx);
      if (notes.resumed.plain.refused) return codex.didNotHappen('the turn/start naming default was refused', notes);
      return codex.happened(notes, null);
    },
  },

  skip: {
    id: 'm22b-skip', name: 'm22b-codex-skip', turns: 1, files: FILES, modes: 'read-only',
    title: `K2: a plan turn under Read only whose blocking question is answered "${NO_ANSWER}" under each id (C53)`,
    successCondition: 'The reply taken, serverRequest/resolved, and whether the plan turn goes on to a plan',
    run: (ctx) => questionTurn(ctx, (params) => ({ answers: Object.fromEntries((Array.isArray(params.questions) ? params.questions : []).map((q) => [q.id, { answers: [NO_ANSWER] }])) }), `"${NO_ANSWER}" under each question's id`),
  },

  empty: {
    id: 'm22b-empty', name: 'm22b-codex-empty', turns: 1, files: FILES, modes: 'read-only',
    title: 'K2: a plan turn under Read only whose blocking question is answered with an empty list (C53)',
    successCondition: 'Whether Codex takes an empty answer list, and what the plan turn does after it',
    run: (ctx) => questionTurn(ctx, () => ({ answers: {} }), 'an empty answers object'),
  },

  modes: {
    id: 'm22b-modes', name: 'm22b-codex-modes', turns: 3, files: FILES, modes: 'sandbox-ok, auto-reviewed, berserk',
    title: 'K2: one plan turn under each of Sandbox ok, Auto-reviewed and Berserk, each in a thread of its own (C5, C14)',
    successCondition: 'A plan item under each mode, and whether a plan turn writes or asks',
    async run(ctx) {
      const driver = await ctx.open();
      const model = await modelOf(driver);
      if (!model.model) return codex.notRun('the CLI listed no model');
      const notes = { model };
      let last = null;
      for (const key of ['sandbox-ok', 'auto-reviewed', 'berserk']) {
        const thread = await openThread(ctx, driver, MODES[key], model);
        notes[key] = { thread };
        if (!thread.ok) continue;
        notes[key].plan = await turn(ctx, driver, PROMPTS.codexPlan, model, 'plan');
        notes[key].filesAfter = filesNow(ctx);
        if (!notes[key].plan.refused) last = notes[key].plan.endIndex;
      }
      if (last === null) return codex.didNotHappen('no plan turn ran', common(driver, 0, notes));
      return codex.happened(common(driver, 0, notes), last);
    },
  },

  models: {
    id: 'm22b-models', name: 'm22b-codex-models', turns: 0, files: FILES,
    title: "K2, no prompt: the models the scratch account lists, for `--model`",
    successCondition: 'Each listed model with whether it is the default or hidden',
    async run(ctx) {
      const driver = await ctx.open();
      const reply = await driver.request('model/list', { limit: 100 });
      if (!reply.ok) return codex.didNotHappen('model/list was refused');
      const data = Array.isArray(reply.value?.data) ? reply.value.data : [];
      return codex.happened({ models: data.map((m) => ({ model: m.model, isDefault: m.isDefault ?? null, hidden: m.hidden ?? null, efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort) })) }, reply.index);
    },
  },

  history: {
    id: 'm22b-history', name: 'm22b-codex-history', turns: 0, files: FILES,
    title: "K2: the saved thread's turns read from a process that never resumed it, as the app's history check reads them (C28)",
    successCondition: 'Whether the plan items are in the read, with their text, and what the user messages hold',
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no saved thread: run --scenario chain first');
      const driver = await ctx.open('history');
      driver.sessionIds = [state.codexThreadId];
      const from = driver.nextIndex;
      const reply = await driver.requestWithin('thread/turns/list', { threadId: state.codexThreadId, limit: 20, itemsView: 'full' }, 30_000);
      if (!reply.ok) return codex.didNotHappen(`thread/turns/list was refused (code ${reply.error?.code ?? null})`, common(driver, from));
      const data = Array.isArray(reply.value?.data) ? reply.value.data : [];
      const ours = [PROMPTS.codexPlan, FEEDBACK, PROMPTS.plainAfterPlan, EXECUTE_WORDS, PROMPTS.codexPlanSecond, PROMPTS.afterResume];
      const perTurn = data.map((one) => {
        const items = Array.isArray(one.items) ? one.items : [];
        return {
          keys: Object.keys(one).sort(), status: one.status ?? null, itemTypes: items.map((item) => item.type),
          plans: items.filter((item) => item.type === 'plan').map((item) => ({ keys: Object.keys(item).sort(), text: shapeOf(item.text) })),
          userMessages: items.filter((item) => item.type === 'userMessage').map((item) => {
            const text = (Array.isArray(item.content) ? item.content : []).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
            return { keys: Object.keys(item).sort(), isOneOfTheSpikesPrompts: ours.includes(text), units: text.length };
          }),
        };
      });
      return codex.happened(common(driver, from, { turns: data.length, replyKeys: Object.keys(reply.value ?? {}).sort(), perTurn }), reply.index);
    },
  },
};

/** The scenarios of one planned run of each, in their order. */
const PLANNED = ['chain', 'resumed', 'skip', 'empty', 'modes', 'history'];

if (isMain(import.meta.url)) {
  await runSpike('m22b-k2', (frame) => {
    if (frame.args.list) {
      for (const key of PLANNED) log(`codex   ${key.padEnd(8)} ${String(SCENARIOS[key].turns).padStart(2)} prompt(s)  ${SCENARIOS[key].title}`);
      log(`total: ${PLANNED.reduce((sum, key) => sum + SCENARIOS[key].turns, 0)} prompts for one run of each, of the twelve K2 may spend (C46); a history read costs none`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m22b/k2.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--model <id>] [--path <executable>]`); return 1; }
    MODEL = typeof frame.args.model === 'string' ? frame.args.model : null;
    log(`K2:${MODEL ? ` the model ${MODEL};` : ''} production's handshake less the opt-out of ${KEPT.join(' and ')}, the experimental API asked for (C13); the scratch configuration folder (CODEX_HOME)`);
    return codex.runScenario('m22b-k2', chosen, frame, OPTIONS);
  });
}
