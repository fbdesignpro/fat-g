// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M21 spike K1 (docs/planning/_archive/M21-spec-sheet.md; C16–C22): Claude's `AskUserQuestion` answered
// `allow` with `updatedInput.answers`, under M16's launch as M20b leaves it — without
// `--disable-slash-commands`, with `--include-partial-messages` and background tasks off — plus
// `AskUserQuestion` in `--tools` (C16), in M16's scratch configuration folder, with M10's notes
// files and M19b's three files.
//
//   node spikes/m21/k1.mjs --list
//   node spikes/m21/k1.mjs --scenario one|multi|two|stop|worker|killed --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (S7). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m21). Each scenario is a session of its own, left in the scratch configuration's
// history and named in the report.
//
// What a run records is never a text of the model's: the request's shape, the answer the spike
// sent, the CLI's own words in the tool's result, the turn's bounds, the cancel frame at a Stop,
// the `agent_id` of a sub-agent's request, and what a resumed `initialize` reply lists as pending.
import { randomUUID } from 'node:crypto';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { TOOLS, didNotHappen, framesOf, happened, initOf, notRun, outline, ownText, resultOf, runScenario } from '../m16/lib/common.mjs';
import { M19ClaudeDriver, OMITTED_CLAUDE, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { M21_DIR, PROMPTS, WORDS, optionMatching, typeCounts } from './lib/common.mjs';

/** The launch as M20b leaves it, plus the question tool (C16). */
const QUESTION_TOOL = 'AskUserQuestion';
const EXTRA = ['--include-partial-messages'];
const SETTLED = Object.freeze({ launch: { extra: EXTRA, tools: [...TOOLS, QUESTION_TOOL] }, background: false });

const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);
const isQuestionRequest = (frame) => frame?.type === 'control_request' && frame.request?.subtype === 'can_use_tool' && frame.request.tool_name === QUESTION_TOOL;

/**
 * M19's driver, answering the question tool's request as the app will (C17): `allow` with the
 * request's input and `answers` keyed by each question's text, from the scenario's own rule;
 * `hold` leaves the request unanswered. Every other request gets M16's deny or the error reply.
 */
class K1Driver extends M19ClaudeDriver {
  constructor(options) {
    super(options);
    this.questionRule = null;
    this.answered = [];
    this.held = [];
  }

  incoming(frame, index) {
    if (!isQuestionRequest(frame)) { super.incoming(frame, index); return; }
    const request = frame.request;
    this.requestsSeen.push({ kind: 'can_use_tool', tool: QUESTION_TOOL, worker: Boolean(request.agent_id) });
    const plan = this.questionRule?.(request) ?? 'hold';
    if (plan === 'hold') { this.held.push({ requestId: frame.request_id, index, atMs: this.tree.elapsed() }); this.requestsSeen.at(-1).answer = 'held'; return; }
    const response = { subtype: 'success', request_id: frame.request_id, response: { behavior: 'allow', updatedInput: { ...request.input, answers: plan.answers } } };
    this.answered.push({ requestId: frame.request_id, index, atMs: this.tree.elapsed(), answers: plan.answers });
    this.requestsSeen.at(-1).answer = 'allow';
    this.session.send({ type: 'control_response', response }).catch(() => {});
  }
}

const OPTIONS = { dir: M21_DIR, milestone: 'M21', Driver: K1Driver, omitted: OMITTED_CLAUDE };

/** An answer per question, by the scenario's rule: a function of the question and its place. */
const rule = (pick) => (request) => {
  const questions = Array.isArray(request.input?.questions) ? request.input.questions : [];
  return { answers: Object.fromEntries(questions.map((q, i) => [q.question, pick(q, i)])) };
};
const anyOption = (q) => optionMatching(q.options, /./) ?? '';
const RULES = {
  /** The second option: notes-2.txt, whose word is "kettle". */
  one: rule((q) => optionMatching(q.options, /notes-2/) ?? anyOption(q)),
  /** Two of three, joined as the CLI's own UI is assumed to join them (C18). */
  multi: rule((q) => [optionMatching(q.options, /notes-1/), optionMatching(q.options, /notes-3/)].filter(Boolean).join(', ')),
  /** Free text that is no option for the first question, an option for the second. */
  two: rule((q, i) => (i === 0 ? 'notes-3.txt' : optionMatching(q.options, /fran|french/i) ?? anyOption(q))),
};

/** What a question request says of itself: shapes and counts, never the texts. */
function requestFacts(driver, entry, from) {
  const request = entry.frame.request;
  const questions = Array.isArray(request.input?.questions) ? request.input.questions : [];
  const toolUse = received(driver, from).find((f) => typeKey(f.frame) === 'assistant' && blocksOf(f.frame).some((b) => b.type === 'tool_use' && b.id === request.tool_use_id)) ?? null;
  return {
    index: entry.index, msAfterTheToolUse: toolUse ? Math.round(entry.ms - toolUse.ms) : null, toolUseFrameIsAWorkers: toolUse ? toolUse.frame.parent_tool_use_id != null : null,
    keys: Object.keys(request).sort(), requiresUserInteraction: request.requires_user_interaction ?? null, agentIdNamed: typeof request.agent_id === 'string', toolUseIdNamed: typeof request.tool_use_id === 'string', inputKeys: Object.keys(request.input ?? {}).sort(),
    questions: questions.map((q) => ({ keys: Object.keys(q).sort(), options: Array.isArray(q.options) ? q.options.length : null, optionKeys: Object.keys(q.options?.[0] ?? {}).sort(), multiSelect: q.multiSelect ?? null, headerUnits: String(q.header ?? '').length, questionUnits: String(q.question ?? '').length })),
  };
}

/** The tool's result that answers the request's tool use: the CLI's fixed words and the spike's own answer, never the model's. */
function resultFacts(driver, request, answeredAt, from) {
  const entry = received(driver, from).find((f) => typeKey(f.frame) === 'user' && blocksOf(f.frame).some((b) => b.type === 'tool_result' && b.tool_use_id === request.tool_use_id)) ?? null;
  if (!entry) return null;
  const block = blocksOf(entry.frame).find((b) => b.type === 'tool_result' && b.tool_use_id === request.tool_use_id);
  const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
  return { index: entry.index, msAfterTheAnswer: answeredAt === null ? null : Math.round(entry.ms - answeredAt), isError: block.is_error === true, contentIsString: typeof block.content === 'string', contentUnits: content.length, cliWords: content.slice(0, 240), isAWorkers: entry.frame.parent_tool_use_id != null, toolUseResultKeys: entry.frame.tool_use_result && typeof entry.frame.tool_use_result === 'object' ? Object.keys(entry.frame.tool_use_result).sort() : null };
}

/** The turn's bounds, as M16 reads them (C31). */
function turnFacts(driver, from, uuid) {
  const init = initOf(driver, from)?.frame ?? null;
  const result = resultOf(driver, from) ?? null;
  return {
    init: init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, tools: (init.tools ?? []).filter((tool) => !String(tool).startsWith('mcp__')), questionToolListed: (init.tools ?? []).includes(QUESTION_TOOL) } : null,
    result: result ? { index: result.index, subtype: result.frame.subtype ?? null, isError: result.frame.is_error === true, terminal: result.frame.terminal_reason ?? null, numTurns: result.frame.num_turns ?? null } : null,
    lifecycle: framesOf(driver, 'command_lifecycle', from).map((f) => ({ index: f.index, state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid })),
  };
}

/** Each question request from `from` on, with the answer the spike sent and the tool's result. */
function requestsOf(driver, from) {
  return received(driver, from).filter((f) => isQuestionRequest(f.frame)).map((entry) => {
    const answered = driver.answered.find((a) => a.requestId === entry.frame.request_id) ?? null;
    return { ...requestFacts(driver, entry, from), answer: answered?.answers ?? null, result: resultFacts(driver, entry.frame.request, answered?.atMs ?? null, from) };
  });
}

/** One prompt that invites a question, answered by a rule, through to the turn's end: `{ driver, from, end, notes }`, or a result when no question came. */
async function askAndAnswer(ctx, { prompt, rule: chosen, expectWord = null, extraNotes = () => ({}) }) {
  if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
  const driver = await ctx.open(SETTLED);
  driver.questionRule = chosen;
  const uuid = randomUUID();
  const from = await ctx.prompt(driver, PROMPTS[prompt], { uuid });
  const end = await ctx.turnEnd(driver, from);
  await sleep(1_500);
  const requests = requestsOf(driver, from);
  const text = ownText(driver, from);
  const notes = {
    endStatus: end.status, isError: end.isError ?? null, requests,
    toolCalls: driver.events(from).filter((e) => e.kind === 'tool-call').map((e) => `${e.name}${e.worker ? ':worker' : ''}`),
    workers: { started: framesOf(driver, 'system/task_started', from).length, ended: framesOf(driver, 'system/task_notification', from).length },
    answerNamesTheWord: expectWord ? expectWord.test(text) : null, ...extraNotes(text), ...turnFacts(driver, from, uuid),
    sessionId: initOf(driver, from)?.frame.session_id ?? null, typeCounts: typeCounts(driver, typeKey, from), outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event'),
  };
  if (requests.length === 0) return didNotHappen('no AskUserQuestion request came', notes);
  return { driver, from, end, notes, raw: received(driver, from).filter((f) => isQuestionRequest(f.frame)) };
}

const SCENARIOS = {
  one: {
    id: 'm21-one', name: 'm21-question-one', turns: 1, files: FILES,
    title: "K1: a question with two options, answered from one of them, under the app's launch (C17)",
    successCondition: "The request's shape, the `allow` taken, the tool's result and the turn going on to read the chosen file",
    async run(ctx) {
      const run = await askAndAnswer(ctx, { prompt: 'one', rule: RULES.one, expectWord: WORDS['notes-2.txt'] });
      return run.outcome ? run : happened(run.notes, run.end.index);
    },
  },

  multi: {
    id: 'm21-multi', name: 'm21-question-multi', turns: 1, files: FILES,
    title: 'K1: a question that allows several answers, two of three chosen, joined by a comma and a space (C18)',
    successCondition: "The request's `multiSelect`, what the tool's result reads for the joined answer, and both files read",
    async run(ctx) {
      const run = await askAndAnswer(ctx, { prompt: 'multi', rule: RULES.multi, extraNotes: (text) => ({ answerNamesBothWords: WORDS['notes-1.txt'].test(text) && WORDS['notes-3.txt'].test(text), answerNamesTheUnchosenWord: WORDS['notes-2.txt'].test(text) }) });
      if (run.outcome) return run;
      if (!run.raw.some((entry) => (entry.frame.request.input?.questions ?? []).some((q) => q.multiSelect === true))) return didNotHappen('the request came with no multiSelect question', run.notes);
      return happened(run.notes, run.end.index);
    },
  },

  two: {
    id: 'm21-two', name: 'm21-question-two', turns: 1, files: FILES,
    title: 'K1: two questions in one request, the first answered with free text that is no option (C18)',
    successCondition: "Two questions in the request's input, the free text in the tool's result, and the file it names read",
    async run(ctx) {
      const run = await askAndAnswer(ctx, { prompt: 'two', rule: RULES.two, expectWord: WORDS['notes-3.txt'], extraNotes: (text) => ({ answerLooksFrench: /\b(le|la|les|est|dans|fichier|dit)\b/i.test(text) }) });
      if (run.outcome) return run;
      if (!run.raw.some((entry) => (entry.frame.request.input?.questions ?? []).length >= 2)) return didNotHappen('no request carried two questions', run.notes);
      return happened(run.notes, run.end.index);
    },
  },

  worker: {
    id: 'm21-worker', name: 'm21-question-worker', turns: 1, files: FILES,
    title: "K1: a sub-agent's question, its request naming the worker (C21)",
    successCondition: "A `can_use_tool` for AskUserQuestion with an `agent_id`, answered, and the worker's report",
    async run(ctx) {
      const run = await askAndAnswer(ctx, { prompt: 'worker', rule: RULES.one, expectWord: WORDS['notes-2.txt'] });
      if (run.outcome) return run;
      if (!run.raw.some((entry) => typeof entry.frame.request.agent_id === 'string')) return didNotHappen('a question came, but none named an agent_id: the session asked, not its sub-agent', run.notes);
      return happened(run.notes, run.end.index);
    },
  },

  stop: {
    id: 'm21-stop', name: 'm21-question-stop', turns: 1, files: FILES,
    title: 'K1: a question left pending, then a Stop by `interrupt` (C20, C22)',
    successCondition: 'What follows the interrupt: a `control_cancel_request` naming the request, and the `result`',
    async run(ctx) {
      if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
      const driver = await ctx.open(SETTLED);
      driver.questionRule = () => 'hold';
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, PROMPTS.stop, { uuid });
      const hit = await ctx.frame(driver, (f) => isQuestionRequest(f) || typeKey(f) === 'result', from);
      if (typeKey(hit.frame) === 'result') return didNotHappen('the turn ended before any question came', turnFacts(driver, from, uuid));
      await sleep(2_000);
      const stopAt = driver.tree.elapsed();
      const interrupt = await driver.interrupt();
      const end = await ctx.turnEnd(driver, from);
      await sleep(2_500);
      const cancels = received(driver, from).filter((f) => typeKey(f.frame) === 'control_cancel_request');
      const notes = {
        endStatus: end.status, isError: end.isError ?? null, terminal: end.terminalReason ?? null,
        request: requestFacts(driver, hit, from), heldForMs: Math.round(stopAt - hit.ms), interruptReply: { ok: interrupt.ok, keys: interrupt.ok && interrupt.value && typeof interrupt.value === 'object' ? Object.keys(interrupt.value).sort() : null },
        cancels: cancels.map((f) => ({ index: f.index, msAfterTheStop: Math.round(f.ms - stopAt), keys: Object.keys(f.frame).sort(), namesTheRequest: f.frame.request_id === hit.frame.request_id })),
        resultForTheToolUse: resultFacts(driver, hit.frame.request, null, from),
        framesAfterTheStop: received(driver, from).filter((f) => f.ms >= stopAt).map((f) => ({ type: typeKey(f.frame), msAfterTheStop: Math.round(f.ms - stopAt) })),
        ...turnFacts(driver, from, uuid), sessionId: initOf(driver, from)?.frame.session_id ?? null, typeCounts: typeCounts(driver, typeKey, from), outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event'),
      };
      return happened(notes, end.index);
    },
  },

  killed: {
    id: 'm21-killed', name: 'm21-question-killed', family: 'm21-killed', turns: 2, atMost: true, files: FILES,
    title: 'K1: a question pending while the process is killed, then the session resumed with a prompt (C13)',
    successCondition: "What the resumed `initialize` reply lists as pending, and whether the model asks again on the next prompt",
    async run(ctx) {
      if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
      const first = await ctx.open({ ...SETTLED, label: 'first' });
      first.questionRule = () => 'hold';
      const uuid = randomUUID();
      const from = await ctx.prompt(first, PROMPTS.killed, { uuid });
      const hit = await ctx.frame(first, (f) => isQuestionRequest(f) || typeKey(f) === 'result', from);
      const sessionId = initOf(first, from)?.frame.session_id ?? null;
      if (typeKey(hit.frame) === 'result') return didNotHappen('the turn ended before any question came', turnFacts(first, from, uuid));
      await sleep(1_500);
      const forced = await ctx.endByForce(first);
      const notes = { first: { sessionId, request: requestFacts(first, hit, from), forcedEnd: { ...forced, msAfterTheRequest: Math.round(forced.atMs - hit.ms) }, ...turnFacts(first, from, uuid), outline: outline(first, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event') } };
      if (!forced.taskkillOk || !forced.exited) return didNotHappen('the process was not ended by the forced end', notes);
      if (!sessionId) return didNotHappen('no init named the session, so nothing can be resumed', notes);
      await sleep(1_000);
      const attempt = await ctx.tryOpen({ ...SETTLED, label: 'resumed', launch: { ...SETTLED.launch, resume: sessionId } });
      const reply = attempt.driver.initializeReply;
      const pending = reply && typeof reply === 'object' ? reply.pending_permission_requests : undefined;
      notes.resumed = {
        opened: attempt.opened, initializeAnswered: attempt.initializeAnswered, exit: attempt.exit, replyKeys: reply && typeof reply === 'object' ? Object.keys(reply).sort() : null,
        pendingPermissionRequests: Array.isArray(pending) ? { count: pending.length, entries: pending.map((entry) => ({ keys: Object.keys(entry ?? {}).sort(), tool: entry?.tool_name ?? entry?.request?.tool_name ?? null })) } : pending === undefined ? 'absent' : typeof pending,
      };
      if (!attempt.opened) return didNotHappen('the resume did not open', notes);
      const resumed = attempt.driver;
      resumed.questionRule = RULES.one;
      const uuid2 = randomUUID();
      const from2 = await ctx.prompt(resumed, PROMPTS.resumed, { uuid: uuid2 });
      const end = await ctx.turnEnd(resumed, from2);
      await sleep(1_500);
      const requests = requestsOf(resumed, from2);
      const text = ownText(resumed, from2);
      notes.resumed.turn = {
        endStatus: end.status, isError: end.isError ?? null, askedAgain: requests.length > 0, requests,
        toolCalls: resumed.events(from2).filter((e) => e.kind === 'tool-call').map((e) => e.name), answerNamesAWord: Object.values(WORDS).some((word) => word.test(text)), initNamesTheSameSession: initOf(resumed, from2)?.frame.session_id === sessionId,
        ...turnFacts(resumed, from2, uuid2), outline: outline(resumed, from2, { sent: [uuid2] }).filter((row) => row.recv !== 'stream_event'),
      };
      return happened(notes, end.index);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m21-k1', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(8)} ${String(scenario.turns).padStart(2)} prompt(s)${scenario.atMost ? ' at most' : ''}  ${scenario.title}`);
      log(`total: ${Object.values(SCENARIOS).reduce((sum, scenario) => sum + scenario.turns, 0)} prompts at most for one run of each`);
      return 0;
    }
    const scenario = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m21/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--path <executable>]`); return 1; }
    log(`K1: M16's launch as M20b leaves it, with ${EXTRA.join(' ')} and --tools ${SETTLED.launch.tools.join(',')}; background tasks off; the scratch configuration folder`);
    return runScenario('m21-k1', scenario, frame, OPTIONS);
  });
}
