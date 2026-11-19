// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M21 spike K2 (docs/planning/_archive/M21-spec-sheet.md; C23–C28): Codex's blocking question,
// `item/tool/requestUserInput`, answered with `answers` in a plan turn, and its async question — an
// `agentMessage` with `questions` in default mode — answered by a later prompt in fat-g's words
// (C26), under production's handshake as M19 leaves it (M20a, C15), the thread read-only and
// `never`, saved in M15's scratch folder so that a second process can read its history, and deleted
// after (`node spikes/m15/resume.mjs --cleanup`), with M10's notes files and M19b's three files.
//
//   node spikes/m21/k2.mjs --list
//   node spikes/m21/k2.mjs --scenario plan|plan-stop|async|async-two|history --confirm-turns <n> [--again] [--experimental]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (S7). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m21). `plan` starts the thread and saves its id; the others resume it with
// `excludeTurns`, as the app does; `history` reads it from a process that never resumed it. The plan
// turn is the spike's own launch — `collaborationMode` on `turn/start` — and never the app's, which
// sends no plan turn before M22b (C2, C24). `--experimental` asks for the experimental API on the
// handshake, for the record of whether plan mode needs it; the app never does (decision 0018).
//
// What a run records is never a text of the model's: the request's fields, the reply the spike
// sent, `serverRequest/resolved`, what `thread/status/changed` carries while a request is pending,
// what an interrupt resolves, the async message's questions, and what a history read holds.
import { randomUUID } from 'node:crypto';
import { CLIENT_INFO, checkSessionStart } from '../m10/codex/driver.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, productionDeltaMethods, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { M21_DIR, PROMPTS, WORDS, asyncAnswerPrompt, optionMatching, readState, typeCounts, writeState } from './lib/common.mjs';

const QUESTION_REQUEST = 'item/tool/requestUserInput';
const RESOLVED = 'serverRequest/resolved';
const STATUS = 'thread/status/changed';

/** Set from `--experimental` before a run: the spike's handshake alone (C2). */
let EXPERIMENTAL = false;

/**
 * M19's driver, answering the question request as the app will (C23): `answers`, each question's
 * id to `{ answers: [...] }`, from the scenario's rule; `hold` leaves it unanswered. The handshake
 * is production's, plus the experimental API where the run asks for it.
 */
class K2Driver extends M19CodexDriver {
  constructor(options) {
    super(options);
    this.questionRule = null;
    this.answered = [];
    this.held = [];
    this.experimental = EXPERIMENTAL;
  }

  async open() {
    const table = this.table;
    this.session.recorderOptions.isDelta = (frame) => table.isDelta(frame) && frame?.method !== CODEX_TEXT_DELTA;
    await this.startWire();
    this.session.recorder.deltas.requested = true;
    this.session.recorder.deltas.kept = [CODEX_TEXT_DELTA];
    this.optedOut = productionDeltaMethods().filter((method) => method !== CODEX_TEXT_DELTA);
    const reply = await this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { optOutNotificationMethods: this.optedOut, ...(this.experimental ? { experimentalApi: true } : {}) } }, 'startup');
    await this.session.send({ method: 'initialized' });
    return reply;
  }

  incoming(frame, index) {
    if (!frame || frame.method !== QUESTION_REQUEST || frame.id === undefined) { super.incoming(frame, index); return; }
    this.requestsSeen.push({ kind: QUESTION_REQUEST, requestKind: 'question' });
    const plan = this.questionRule?.(frame.params ?? {}) ?? 'hold';
    if (plan === 'hold') { this.held.push({ id: frame.id, index, atMs: this.tree.elapsed() }); this.requestsSeen.at(-1).answer = 'held'; return; }
    this.answered.push({ id: frame.id, index, atMs: this.tree.elapsed(), answers: plan.answers });
    this.requestsSeen.at(-1).answer = 'answers';
    this.session.send({ id: frame.id, result: { answers: plan.answers } }).catch(() => {});
  }
}

const CODEX_OPTIONS = { dir: M21_DIR, milestone: 'M21', Driver: K2Driver, omitted: OMITTED_CODEX };

/** The second option, notes-2.txt, for each question of the request, as C23's reply has it. */
const RULE = (params) => {
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: [optionMatching(q.options, /notes-2/) ?? optionMatching(q.options, /./) ?? 'notes-2.txt'] }])) };
};

/** A turn as the app starts one (session.ts), plus what the scenario adds; counted once Codex took it. */
async function startTurn(driver, ctx, text, model, extra = {}) {
  const from = driver.nextIndex;
  const params = { threadId: driver.threadId, input: [{ type: 'text', text, text_elements: [] }], model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID(), ...extra };
  const reply = await driver.requestWithin('turn/start', params, 15_000);
  if (reply.ok) { ctx.countTurn(); driver.turnId = reply.value?.turn?.id ?? null; driver.turnActive = true; }
  return { from, ok: reply.ok, turnId: driver.turnId, errorCode: reply.ok ? null : reply.error?.code ?? null, errorText: reply.ok ? null : String(reply.error?.message ?? '').slice(0, 200) };
}

/** The plan mode's field, as the research harness sent it (spikes/chat/trace.mjs) and M22b's outline reads it. */
const planMode = (model) => ({ collaborationMode: { mode: 'plan', settings: { model: model.model, reasoning_effort: model.effort ?? null, developer_instructions: null } } });

const framesOf = (driver, method, from) => received(driver, from).filter((f) => f.frame?.method === method);

/** What a question request says of itself: fields and counts, never the texts. */
function requestFacts(entry, turnStartMs) {
  const params = entry.frame.params ?? {};
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return {
    index: entry.index, msAfterTheTurnStart: turnStartMs === null ? null : Math.round(entry.ms - turnStartMs), keys: Object.keys(params).sort(),
    isBlocking: params.isBlocking ?? null, autoResolutionMs: params.autoResolutionMs ?? null, itemIdNamed: typeof params.itemId === 'string', turnIdNamed: typeof params.turnId === 'string', threadIdNamed: typeof params.threadId === 'string',
    questions: questions.map((q) => ({ keys: Object.keys(q).sort(), options: Array.isArray(q.options) ? q.options.length : null, optionKeys: Object.keys(q.options?.[0] ?? {}).sort(), isOther: q.isOther ?? null, isSecret: q.isSecret ?? null, idUnits: String(q.id ?? '').length, headerUnits: String(q.header ?? '').length, questionUnits: String(q.question ?? '').length })),
  };
}

/** The frames that settle or accompany a request: `serverRequest/resolved`, and the status frames while it was pending. */
function aroundRequest(driver, entry, settledAtMs, from) {
  const resolved = framesOf(driver, RESOLVED, from).map((f) => ({ index: f.index, msAfterTheReply: settledAtMs === null ? null : Math.round(f.ms - settledAtMs), paramKeys: Object.keys(f.frame.params ?? {}).sort(), namesTheRequest: Object.values(f.frame.params ?? {}).some((value) => value === entry.frame.id || String(value) === String(entry.frame.id)) }));
  const statuses = framesOf(driver, STATUS, from).map((f) => ({ index: f.index, whilePending: f.index > entry.index && (settledAtMs === null || f.ms <= settledAtMs), keys: Object.keys(f.frame.params ?? {}).sort(), type: f.frame.params?.status?.type ?? null, activeFlags: Array.isArray(f.frame.params?.status?.activeFlags) ? f.frame.params.status.activeFlags : null }));
  return { resolved, statuses };
}

/** A thread's items and end from `from` on, by type: never a text. */
function turnFacts(driver, from) {
  const frames = received(driver, from).filter((f) => f.frame?.params?.threadId === driver.threadId);
  const methods = {};
  for (const f of frames) methods[f.frame.method] = (methods[f.frame.method] ?? 0) + 1;
  const completed = frames.filter((f) => f.frame.method === 'item/completed').map((f) => f.frame.params.item ?? {});
  const end = frames.find((f) => f.frame.method === 'turn/completed');
  return {
    methods, itemsStarted: frames.filter((f) => f.frame.method === 'item/started').map((f) => f.frame.params.item?.type ?? null),
    answers: completed.filter((item) => item.type === 'agentMessage').map((item) => ({ phase: item.phase ?? null, units: String(item.text ?? '').length, delivery: item.delivery ?? null, questions: Array.isArray(item.questions) ? item.questions.map((q) => ({ keys: Object.keys(q).sort(), options: Array.isArray(q.options) ? q.options.length : null, titleUnits: String(q.title ?? '').length })) : null })),
    planItems: completed.filter((item) => item.type === 'plan').map((item) => ({ keys: Object.keys(item).sort(), units: String(item.text ?? '').length })),
    commands: completed.filter((item) => item.type === 'commandExecution').map((item) => ({ actions: Array.isArray(item.commandActions) ? item.commandActions.map((a) => a.type ?? null) : null, status: item.status ?? null })),
    sleeps: completed.filter((item) => item.type === 'sleep').length,
    end: end ? { ms: end.ms, index: end.index, status: end.frame.params.turn?.status ?? null, error: end.frame.params.turn?.error ? Object.keys(end.frame.params.turn.error).sort() : null } : null,
  };
}

/** The text the thread answered from `from` on, in memory: a yes or no is noted of it. */
function answerOf(driver, from) {
  return received(driver, from).filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.threadId === driver.threadId && f.frame.params?.item?.type === 'agentMessage').map((f) => String(f.frame.params.item.text ?? '')).join('\n');
}

/** Resumes the saved thread as the app does (M15's resume), and records it as the session's start. */
async function resumeSaved(driver, ctx, state) {
  const params = { threadId: state.codexThreadId, cwd: ctx.scratch, ...codex.SANDBOX, excludeTurns: true };
  const reply = await driver.resumeThread(params);
  driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(codex.SANDBOX, reply.value) : null };
  return reply;
}

const common = (driver, from, extra = {}) => ({ experimentalApiAskedFor: driver.experimental, ...extra, typeCounts: typeCounts(driver, (frame) => frame?.method ?? 'response', from), outline: codex.outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA) });

/** A plan turn whose prompt invites a question: through to the turn's end, with the request's facts. */
async function planTurn(driver, ctx, model, { hold = false } = {}) {
  driver.questionRule = hold ? () => 'hold' : RULE;
  const turn = await startTurn(driver, ctx, PROMPTS.codexPlan, model, planMode(model));
  if (!turn.ok) return { turn, refused: true };
  const startedAt = received(driver, turn.from).find((f) => f.frame?.method === 'turn/started')?.ms ?? null;
  const hit = await ctx.wait(driver, (e) => (e.kind === 'request' && e.tool === QUESTION_REQUEST) || e.kind === 'turn-end', turn.from);
  return { turn, refused: false, startedAt, hit };
}

const SCENARIOS = {
  plan: {
    id: 'm21-plan', name: 'm21-codex-plan', turns: 1, files: FILES,
    title: "K2: a plan turn whose prompt invites a question, the request answered with `answers` (C23)",
    successCondition: "The request's fields, the reply taken, `serverRequest/resolved`, and the turn's end with its plan",
    async run(ctx) {
      const driver = await ctx.open();
      const model = await codex.pickModel(driver);
      if (!model.model) return codex.notRun('the CLI listed no model');
      const started = await ctx.startThread(driver, { model: model.model });
      if (!started.ok) return codex.didNotHappen('thread/start was refused');
      if (!driver.sessionStart.check.passed) return codex.notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
      writeState({ codexThreadId: driver.threadId, codexModel: model, codexSeededAt: new Date().toISOString() });
      const run = await planTurn(driver, ctx, model);
      if (run.refused) return codex.didNotHappen(`turn/start with collaborationMode was refused (code ${run.turn.errorCode}): ${run.turn.errorText}${driver.experimental ? '' : ' — run again with --experimental'}`, common(driver, run.turn.from, { model, turn: run.turn }));
      const end = run.hit.kind === 'turn-end' ? run.hit : await ctx.turnEnd(driver, run.turn.from);
      await sleep(2_000);
      const requests = framesOf(driver, QUESTION_REQUEST, run.turn.from);
      const notes = common(driver, run.turn.from, {
        model, endStatus: end.status,
        requests: requests.map((entry) => { const answered = driver.answered.find((a) => a.id === entry.frame.id) ?? null; return { ...requestFacts(entry, run.startedAt), reply: answered ? { msAfterTheRequest: Math.round(answered.atMs - entry.ms), answers: answered.answers } : null, ...aroundRequest(driver, entry, answered?.atMs ?? null, run.turn.from) }; }),
        ...turnFacts(driver, run.turn.from), answerNamesTheWord: WORDS['notes-2.txt'].test(answerOf(driver, run.turn.from)),
      });
      if (requests.length === 0) return codex.didNotHappen(`no ${QUESTION_REQUEST} came in the plan turn${driver.experimental ? '' : ' — run again with --experimental'}`, notes);
      return codex.happened(notes, end.index);
    },
  },

  'plan-stop': {
    id: 'm21-plan-stop', name: 'm21-codex-plan-stop', turns: 1, files: FILES,
    title: 'K2: a plan turn with a question pending, then `turn/interrupt` (C27)',
    successCondition: 'What the interrupt resolves: `serverRequest/resolved`, the turn\'s end, or neither',
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no saved thread: run --scenario plan first');
      const driver = await ctx.open();
      const resumed = await resumeSaved(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      const run = await planTurn(driver, ctx, state.codexModel, { hold: true });
      if (run.refused) return codex.didNotHappen(`turn/start with collaborationMode was refused (code ${run.turn.errorCode})`, common(driver, run.turn.from, { turn: run.turn }));
      if (run.hit.kind === 'turn-end') return codex.didNotHappen('the turn ended before any question came', common(driver, run.turn.from, turnFacts(driver, run.turn.from)));
      const entry = framesOf(driver, QUESTION_REQUEST, run.turn.from)[0];
      await sleep(2_000);
      const stopAt = driver.tree.elapsed();
      const interrupt = await driver.requestWithin('turn/interrupt', { threadId: driver.threadId, turnId: driver.turnId }, 15_000);
      const end = await ctx.turnEnd(driver, run.turn.from);
      await sleep(3_000);
      const notes = common(driver, run.turn.from, {
        endStatus: end.status, request: requestFacts(entry, run.startedAt), heldForMs: Math.round(stopAt - entry.ms), interrupt: { ok: interrupt.ok, errorCode: interrupt.ok ? null : interrupt.error?.code ?? null },
        ...aroundRequest(driver, entry, stopAt, run.turn.from), endMsAfterTheInterrupt: Math.round((received(driver, run.turn.from).find((f) => f.frame?.method === 'turn/completed')?.ms ?? stopAt) - stopAt),
        framesAfterTheInterrupt: received(driver, run.turn.from).filter((f) => f.ms >= stopAt && f.frame?.method !== CODEX_TEXT_DELTA).map((f) => ({ method: f.frame?.method ?? 'response', msAfterTheInterrupt: Math.round(f.ms - stopAt) })),
        ...turnFacts(driver, run.turn.from),
      });
      return codex.happened(notes, end.index);
    },
  },

  async: {
    id: 'm21-async', name: 'm21-codex-async', turns: 2, files: FILES,
    title: "K2: a default-mode prompt that invites a question, the turn ending, then its answer as a prompt in fat-g's words (C26)",
    successCondition: 'The async message with its questions, and the answering turn reading the chosen file',
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no saved thread: run --scenario plan first');
      const driver = await ctx.open();
      const resumed = await resumeSaved(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      driver.questionRule = RULE;
      const first = await startTurn(driver, ctx, PROMPTS.codexAsync, state.codexModel);
      if (!first.ok) return codex.didNotHappen(`turn/start was refused (code ${first.errorCode})`, common(driver, first.from, { turn: first }));
      const firstEnd = await ctx.turnEnd(driver, first.from);
      await sleep(1_500);
      const asked = turnFacts(driver, first.from);
      const questions = received(driver, first.from).filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.threadId === driver.threadId && Array.isArray(f.frame.params?.item?.questions) && f.frame.params.item.questions.length > 0).flatMap((f) => f.frame.params.item.questions);
      const notes = { first: { endStatus: firstEnd.status, requestsDuringIt: framesOf(driver, QUESTION_REQUEST, first.from).length, ...asked } };
      if (questions.length === 0) return codex.didNotHappen('the turn ended with no questions on any agent message', common(driver, first.from, notes));
      const prompt = asyncAnswerPrompt(questions.map((q) => ({ title: String(q.title ?? ''), answer: optionMatching(q.options, /notes-2/) ?? optionMatching(q.options, /./) ?? 'notes-2.txt' })));
      const second = await startTurn(driver, ctx, prompt, state.codexModel);
      if (!second.ok) return codex.didNotHappen(`the answering turn/start was refused (code ${second.errorCode})`, common(driver, first.from, notes));
      const secondEnd = await ctx.turnEnd(driver, second.from);
      await sleep(1_500);
      notes.answer = { promptUnits: prompt.length, promptLines: prompt.split('\n').length, endStatus: secondEnd.status, ...turnFacts(driver, second.from), answerNamesTheWord: WORDS['notes-2.txt'].test(answerOf(driver, second.from)), answerNamesTheOtherWord: WORDS['notes-1.txt'].test(answerOf(driver, second.from)) };
      writeState({ codexAsyncTurnId: second.turnId });
      return codex.happened(common(driver, first.from, notes), secondEnd.index);
    },
  },

  'async-two': {
    id: 'm21-async-two', name: 'm21-codex-async-two', turns: 1, files: FILES,
    title: 'K2: a default-mode prompt that invites two questions at once',
    successCondition: 'How the two questions come: one message with two, or two messages',
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no saved thread: run --scenario plan first');
      const driver = await ctx.open();
      const resumed = await resumeSaved(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      driver.questionRule = RULE;
      const turn = await startTurn(driver, ctx, PROMPTS.codexAsyncTwo, state.codexModel);
      if (!turn.ok) return codex.didNotHappen(`turn/start was refused (code ${turn.errorCode})`, common(driver, turn.from, { turn }));
      const end = await ctx.turnEnd(driver, turn.from);
      await sleep(1_500);
      const facts = turnFacts(driver, turn.from);
      const notes = common(driver, turn.from, { endStatus: end.status, requestsDuringIt: framesOf(driver, QUESTION_REQUEST, turn.from).length, ...facts, messagesWithQuestions: facts.answers.filter((a) => (a.questions?.length ?? 0) > 0).length, questionsInAll: facts.answers.reduce((sum, a) => sum + (a.questions?.length ?? 0), 0) });
      if (notes.questionsInAll === 0) return codex.didNotHappen('the turn ended with no questions on any agent message', notes);
      return codex.happened(notes, end.index);
    },
  },

  history: {
    id: 'm21-history', name: 'm21-codex-history', turns: 0, files: FILES,
    title: "K2: the thread's turns read from a second process that never resumed it, as the app's history check reads them (C28)",
    successCondition: "Whether the async message keeps its questions, and whether anything of the blocking request is in the read",
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no saved thread: run --scenario plan first');
      const driver = await ctx.open('history');
      driver.sessionIds = [state.codexThreadId];
      const from = driver.nextIndex;
      const reply = await driver.requestWithin('thread/turns/list', { threadId: state.codexThreadId, limit: 20, itemsView: 'full' }, 30_000);
      if (!reply.ok) return codex.didNotHappen(`thread/turns/list was refused (code ${reply.error?.code ?? null})`, common(driver, from));
      const data = Array.isArray(reply.value?.data) ? reply.value.data : [];
      const turns = data.map((turn) => {
        const items = Array.isArray(turn.items) ? turn.items : [];
        return {
          keys: Object.keys(turn).sort(), status: turn.status ?? null, itemTypes: items.map((item) => (item.type === 'agentMessage' ? `agentMessage:${item.phase ?? '?'}` : item.type)),
          agentMessages: items.filter((item) => item.type === 'agentMessage').map((item) => ({ keys: Object.keys(item).sort(), questions: Array.isArray(item.questions) ? item.questions.length : item.questions === null ? 'null' : 'absent', delivery: item.delivery ?? null })),
          questionLikeItems: items.filter((item) => /userInput|question|requestUser/i.test(String(item.type ?? ''))).map((item) => ({ type: item.type, keys: Object.keys(item).sort() })),
          userMessages: items.filter((item) => item.type === 'userMessage').length,
        };
      });
      const notes = common(driver, from, { turns: data.length, replyKeys: Object.keys(reply.value ?? {}).sort(), perTurn: turns });
      return codex.happened(notes, reply.index);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m21-k2', (frame) => {
    if (frame.args.list) {
      for (const [key, entry] of Object.entries(SCENARIOS)) log(`codex   ${key.padEnd(10)} ${String(entry.turns).padStart(2)} prompt(s)  ${entry.title}`);
      log(`total: ${Object.values(SCENARIOS).reduce((sum, entry) => sum + entry.turns, 0)} prompts for one run of each; a history read costs none`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m21/k2.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--experimental] [--path <executable>]`); return 1; }
    EXPERIMENTAL = Boolean(frame.args.experimental);
    log(`K2: production's handshake less the opt-out of ${CODEX_TEXT_DELTA}; ${EXPERIMENTAL ? 'the experimental API asked for, the spike\'s own launch' : 'no experimental API'}; the thread saved as the app's are`);
    return codex.runScenario('m21-k2', chosen, frame, CODEX_OPTIONS);
  });
}
