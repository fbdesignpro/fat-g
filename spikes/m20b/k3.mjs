// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M20b spike K3 (docs/planning/_archive/M20b-spec-sheet.md; C19–C23, C69): Codex's `thread/fork` for an
// aside — an ephemeral, read-only child of the session's thread, told to act on nothing — under
// production's handshake as M19 leaves it (M20a, C15), the thread saved in M15's scratch folder and
// deleted after (`node spikes/m15/resume.mjs --cleanup`), with M19b's three files beside M10's.
//
//   node spikes/m20b/k3.mjs --list
//   node spikes/m20b/k3.mjs --scenario seed|fork|followup|during|two|read|again --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (S6). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m20b). `seed` starts the thread and saves its id and its first turn's; every other
// scenario resumes it with `excludeTurns`, as the app does (C10), then forks it. The fork costs no
// prompt; a turn on the child is one.
//
// What a run records is never a text: whether the fork takes each field and what its reply
// reports, the child's frames by method and item type on the one connection, whether it read when
// told to act on nothing, whether MCP servers started for it, whether its answer knows what the
// parent's history holds (a yes or no), and what `turn/interrupt` on its turn does.
import { randomUUID } from 'node:crypto';
import { checkSessionStart } from '../m10/codex/driver.mjs';
import { DeadlineExpired, sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { DEVELOPER_INSTRUCTIONS, LONG_PROMPT, M20B_DIR, QUESTIONS, README_EXCERPT, README_SOURCE, SEED_PROMPT, readState, seedQuestion, writeState } from './lib/common.mjs';

const CODEX_OPTIONS = { dir: M20B_DIR, milestone: 'M20b', Driver: M19CodexDriver, omitted: OMITTED_CODEX };
const MCP_STARTUP = 'mcpServer/startupStatus/updated';

/** C19's fields, exactly, with `lastTurnId` where there is a turn to fork through (C69). */
function forkParams(driver, ctx, model, lastTurnId) {
  return { threadId: driver.threadId, ...(lastTurnId ? { lastTurnId } : {}), ephemeral: true, excludeTurns: true, cwd: ctx.scratch, ...codex.SANDBOX, developerInstructions: DEVELOPER_INSTRUCTIONS, ...(model ? { model } : {}) };
}

/** Sends the fork and reads its reply as the app will check a start's (decision 0018, item 3). */
async function fork(driver, params) {
  const before = Date.now();
  const reply = await driver.requestWithin('thread/fork', params, 30_000);
  const value = reply.ok ? reply.value ?? {} : null;
  const childId = value?.thread?.id ?? null;
  return {
    reply, childId,
    facts: {
      ok: reply.ok, ms: Date.now() - before, withLastTurnId: 'lastTurnId' in params,
      errorCode: reply.ok ? null : reply.error?.code ?? null, errorText: reply.ok ? null : String(reply.error?.message ?? '').slice(0, 160),
      replyKeys: value ? Object.keys(value).sort() : null, threadKeys: value?.thread ? Object.keys(value.thread).sort() : null,
      turnsInReply: Array.isArray(value?.thread?.turns) ? value.thread.turns.length : null, check: value ? checkSessionStart(codex.SANDBOX, value) : null,
      cwdReported: typeof value?.cwd === 'string', modelReported: value?.model ?? null, effortReported: value?.reasoningEffort ?? null,
      childIsNew: Boolean(childId) && childId !== params.threadId,
    },
  };
}

/** A turn on the child as the app sends one (C20): the record's model and effort and a client id. Counted first. */
async function childTurn(driver, ctx, childId, text, model) {
  ctx.countTurn();
  const from = driver.nextIndex;
  const clientUserMessageId = randomUUID();
  const reply = await driver.requestWithin('turn/start', { threadId: childId, input: [{ type: 'text', text, text_elements: [] }], model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId }, 15_000);
  return { from, ok: reply.ok, turnId: reply.ok ? reply.value?.turn?.id ?? null : null, errorCode: reply.ok ? null : reply.error?.code ?? null, errorText: reply.ok ? null : String(reply.error?.message ?? '').slice(0, 160) };
}

/** Waits for a frame on the session's connection within the scenario's time; null when none came in `ms`. */
async function frameWithin(driver, predicate, from, ms) {
  try { return await driver.session.waitFor(predicate, { wait: 'scenario', ms, fromIndex: from }); } catch (error) {
    if (error instanceof DeadlineExpired) return null;
    throw error;
  }
}

const turnEndOf = (threadId) => (f) => f.method === 'turn/completed' && f.params?.threadId === threadId;

/** The text the child answered, in memory: a yes or no is noted of it. */
function answerOf(driver, threadId, from) {
  return received(driver, from).filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.threadId === threadId && f.frame.params?.item?.type === 'agentMessage').map((f) => String(f.frame.params.item.text ?? '')).join('\n');
}

/** What a thread's frames from `from` on say: methods, items, deltas, reads, MCP starts, its end. Never a text. */
function threadFacts(driver, threadId, from) {
  const frames = received(driver, from).filter((f) => f.frame?.params?.threadId === threadId);
  const methods = {};
  for (const f of frames) methods[f.frame.method] = (methods[f.frame.method] ?? 0) + 1;
  const items = frames.filter((f) => f.frame.method === 'item/started').map((f) => f.frame.params.item?.type ?? null);
  const completed = frames.filter((f) => f.frame.method === 'item/completed').map((f) => f.frame.params.item ?? {});
  const end = frames.find((f) => f.frame.method === 'turn/completed');
  return {
    frames: frames.length, methods, itemsStarted: items,
    commands: completed.filter((item) => item.type === 'commandExecution').map((item) => ({ actions: Array.isArray(item.commandActions) ? item.commandActions.map((a) => a.type ?? null) : null, status: item.status ?? null, outputUnits: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.length : null })),
    fileChanges: completed.filter((item) => item.type === 'fileChange').length,
    answers: completed.filter((item) => item.type === 'agentMessage').map((item) => ({ phase: item.phase ?? null, units: String(item.text ?? '').length })),
    deltas: frames.filter((f) => f.frame.method === CODEX_TEXT_DELTA).length, firstDeltaMs: frames.find((f) => f.frame.method === CODEX_TEXT_DELTA)?.ms ?? null,
    mcpStartups: frames.filter((f) => f.frame.method === MCP_STARTUP).length, threadStartedSeen: frames.some((f) => f.frame.method === 'thread/started'),
    end: end ? { ms: end.ms, index: end.index, status: end.frame.params.turn?.status ?? null, error: end.frame.params.turn?.error ? Object.keys(end.frame.params.turn.error).sort() : null } : null,
  };
}

/** Resumes the seed thread as the app does (M15's resume), and records it as the session's start. */
async function resumeSeed(driver, ctx, state) {
  const params = { threadId: state.codexThreadId, cwd: ctx.scratch, ...codex.SANDBOX, excludeTurns: true };
  const reply = await driver.resumeThread(params);
  driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(codex.SANDBOX, reply.value) : null };
  return reply;
}

/** The notes every scenario ends with: the connection's frames outlined, each named for its thread, deltas left out. */
const common = (driver, from, extra = {}) => ({ ...extra, outline: codex.outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA) });

const SCENARIOS = {
  seed: {
    id: 'm20b-fork-seed', name: 'm20b-fork-seed', turns: 2, atMost: true, files: FILES,
    title: "K3: a turn that gives the thread something to hold, and during it a fork with no `lastTurnId`, with an aside's turn on the child where it is taken (C69)",
    successCondition: "The seed turn's end, with the fork's reply read during it; the thread's and the turn's ids saved",
    async run(ctx) {
      const driver = await ctx.open();
      const model = await codex.pickModel(driver);
      if (!model.model) return codex.notRun('the CLI listed no model');
      const started = await ctx.startThread(driver, { model: model.model });
      if (!started.ok) return codex.didNotHappen('thread/start was refused');
      if (!driver.sessionStart.check.passed) return codex.notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      await ctx.prompt(driver, SEED_PROMPT, { model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID() });
      await driver.session.waitFor((f) => f.method === 'turn/started' && f.params?.threadId === driver.threadId, { wait: 'scenario', ms: 60_000, fromIndex: from });
      const forked = await fork(driver, forkParams(driver, ctx, model.model, null));
      let child = null;
      if (forked.ok !== false && forked.childId) {
        const turn = await childTurn(driver, ctx, forked.childId, QUESTIONS.firstTurn.text, model);
        const end = turn.ok ? await frameWithin(driver, turnEndOf(forked.childId), turn.from, 180_000) : null;
        child = { turn: { ok: turn.ok, errorCode: turn.errorCode, errorText: turn.errorText }, ended: end !== null, ...(turn.ok ? threadFacts(driver, forked.childId, turn.from) : {}), knowsTheParentsPrompt: turn.ok ? QUESTIONS.firstTurn.looksFor.test(answerOf(driver, forked.childId, turn.from)) : null };
      }
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      writeState({ codexThreadId: driver.threadId, codexLastTurnId: driver.turnId, codexModel: model, codexSeededAt: new Date().toISOString() });
      const notes = common(driver, from, { model, parentEndStatus: end.status, forkDuringTheFirstTurn: forked.facts, child, parent: threadFacts(driver, driver.threadId, from) });
      if (!forked.reply.ok) return codex.didNotHappen(`the fork without lastTurnId was refused during the first turn (code ${forked.facts.errorCode})`, notes);
      return codex.happened(notes, end.index);
    },
  },

  fork: {
    id: 'm20b-fork-only', name: 'm20b-fork-only', turns: 0, files: FILES,
    title: "K3: a fork with C19's fields and no turn, which costs nothing: its reply read",
    successCondition: 'The fork taken, its reply reporting the sandbox and the policy with no turns',
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no seed thread: run --scenario seed first');
      const driver = await ctx.open();
      const resumed = await resumeSeed(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      const from = driver.nextIndex;
      const forked = await fork(driver, forkParams(driver, ctx, state.codexModel?.model ?? null, state.codexLastTurnId));
      // The same once more, for the record of a second child beside the first.
      const again = await fork(driver, forkParams(driver, ctx, state.codexModel?.model ?? null, state.codexLastTurnId));
      await sleep(1_500);
      const notes = common(driver, from, { fork: forked.facts, secondFork: again.facts, twoChildrenDistinct: Boolean(forked.childId) && Boolean(again.childId) && forked.childId !== again.childId, framesAfterTheForks: received(driver, from).map((f) => f.frame?.method ?? 'response') });
      if (!forked.reply.ok) return codex.didNotHappen(`the fork was refused (code ${forked.facts.errorCode})`, notes);
      return codex.happened(notes, forked.reply.index);
    },
  },

  followup: {
    id: 'm20b-fork-followup', name: 'm20b-fork-followup', turns: 2, files: FILES,
    title: "K3: an aside's turn on the child while the parent is idle, with C51's template, then a follow-up on the same child",
    successCondition: "Both turns' ends on the child, the second knowing the first; whether the child read, and whether MCP servers started for it",
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no seed thread: run --scenario seed first');
      const driver = await ctx.open();
      const resumed = await resumeSeed(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      const from = driver.nextIndex;
      const forked = await fork(driver, forkParams(driver, ctx, state.codexModel.model, state.codexLastTurnId));
      if (!forked.reply.ok) return codex.didNotHappen(`the fork was refused (code ${forked.facts.errorCode})`, common(driver, from, { fork: forked.facts }));
      const question = seedQuestion(README_SOURCE, README_EXCERPT);
      const first = await childTurn(driver, ctx, forked.childId, question, state.codexModel);
      if (!first.ok) return codex.didNotHappen(`turn/start on the child was refused (code ${first.errorCode})`, common(driver, from, { fork: forked.facts, turn: first }));
      const firstEnd = await frameWithin(driver, turnEndOf(forked.childId), first.from, 180_000);
      const firstAnswer = answerOf(driver, forked.childId, first.from);
      const second = await childTurn(driver, ctx, forked.childId, QUESTIONS.codexFollowup.text, state.codexModel);
      const secondEnd = second.ok ? await frameWithin(driver, turnEndOf(forked.childId), second.from, 180_000) : null;
      await sleep(1_500);
      const secondAnswer = second.ok ? answerOf(driver, forked.childId, second.from) : '';
      writeState({ codexExchange: { question, answer: firstAnswer } });
      const notes = common(driver, from, {
        fork: forked.facts,
        first: { ...threadFacts(driver, forked.childId, first.from), ended: firstEnd !== null, answerLooksRight: QUESTIONS.idle.looksFor.test(firstAnswer) },
        second: { turn: { ok: second.ok, errorCode: second.errorCode }, ...(second.ok ? threadFacts(driver, forked.childId, second.from) : {}), ended: secondEnd !== null, knowsTheFirstQuestion: QUESTIONS.codexFollowup.looksFor.test(secondAnswer) },
        parentFramesMeanwhile: received(driver, from).filter((f) => f.frame?.params?.threadId === driver.threadId).map((f) => f.frame.method),
      });
      if (firstEnd === null || secondEnd === null) return codex.didNotHappen('a turn on the child did not end in time', notes);
      return codex.happened(notes, secondEnd.index);
    },
  },

  during: {
    id: 'm20b-fork-during', name: 'm20b-fork-during', turns: 2, files: FILES,
    title: "K3: a fork made while the parent's turn runs, and the aside's turn beside it on the one connection",
    successCondition: "The fork taken during the parent's turn, both turns' ends, each frame named for its thread",
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no seed thread: run --scenario seed first');
      const driver = await ctx.open();
      const resumed = await resumeSeed(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      const from = driver.nextIndex;
      await ctx.prompt(driver, LONG_PROMPT, { model: state.codexModel.model, ...(state.codexModel.effort ? { effort: state.codexModel.effort } : {}), clientUserMessageId: randomUUID() });
      await driver.session.waitFor((f) => f.method === 'turn/started' && f.params?.threadId === driver.threadId, { wait: 'scenario', ms: 60_000, fromIndex: from });
      const forked = await fork(driver, forkParams(driver, ctx, state.codexModel.model, state.codexLastTurnId));
      let child = null;
      if (forked.reply.ok) {
        const turn = await childTurn(driver, ctx, forked.childId, QUESTIONS.during.text, state.codexModel);
        const end = turn.ok ? await frameWithin(driver, turnEndOf(forked.childId), turn.from, 180_000) : null;
        const answer = turn.ok ? answerOf(driver, forked.childId, turn.from) : '';
        child = { turn: { ok: turn.ok, errorCode: turn.errorCode }, ended: end !== null, ...(turn.ok ? threadFacts(driver, forked.childId, turn.from) : {}), seesTheWordOfTheTurnInFlight: turn.ok ? QUESTIONS.during.looksFor.test(answer) : null, seesTheSeedFiles: turn.ok ? QUESTIONS.during.alsoLooksFor.test(answer) : null };
      }
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      const parent = threadFacts(driver, driver.threadId, from);
      const notes = common(driver, from, { fork: forked.facts, child, parent, parentEndStatus: end.status, childEndedBeforeTheParent: child?.end && parent.end ? child.end.index < parent.end.index : null, framesNamingNeither: received(driver, from).filter((f) => f.frame?.method && typeof f.frame.params?.threadId === 'string' && ![driver.threadId, forked.childId].includes(f.frame.params.threadId)).length });
      if (!forked.reply.ok) return codex.didNotHappen(`the fork was refused during the parent's turn (code ${forked.facts.errorCode})`, notes);
      return codex.happened(notes, end.index);
    },
  },

  two: {
    id: 'm20b-fork-two', name: 'm20b-fork-two', turns: 2, files: FILES,
    title: "K3: two asides at once, each on a child of its own, the second's turn interrupted at its first delta",
    successCondition: "Both children's frames apart on the one connection; the second's turn ending interrupted, the first's completing",
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no seed thread: run --scenario seed first');
      const driver = await ctx.open();
      const resumed = await resumeSeed(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      const from = driver.nextIndex;
      const a = await fork(driver, forkParams(driver, ctx, state.codexModel.model, state.codexLastTurnId));
      const b = await fork(driver, forkParams(driver, ctx, state.codexModel.model, state.codexLastTurnId));
      if (!a.reply.ok || !b.reply.ok) return codex.didNotHappen('a fork was refused', common(driver, from, { forkA: a.facts, forkB: b.facts }));
      const [ta, tb] = await Promise.all([childTurn(driver, ctx, a.childId, QUESTIONS.twoA.text, state.codexModel), childTurn(driver, ctx, b.childId, QUESTIONS.cancel.text, state.codexModel)]);
      if (!ta.ok || !tb.ok) return codex.didNotHappen('a turn on a child was refused', common(driver, from, { forkA: a.facts, forkB: b.facts, turnA: ta, turnB: tb }));
      // The second is interrupted once its answer has begun, or once the first's turn ended if no delta came.
      const delta = await frameWithin(driver, (f) => (f.method === CODEX_TEXT_DELTA && f.params?.threadId === b.childId) || turnEndOf(b.childId)(f), tb.from, 120_000);
      const interruptAt = driver.tree.elapsed();
      const interrupt = delta && delta.frame.method === CODEX_TEXT_DELTA ? await driver.requestWithin('turn/interrupt', { threadId: b.childId, turnId: tb.turnId }, 15_000) : null;
      const endA = await frameWithin(driver, turnEndOf(a.childId), ta.from, 180_000);
      const endB = await frameWithin(driver, turnEndOf(b.childId), tb.from, 180_000);
      await sleep(2_000);
      const factsB = threadFacts(driver, b.childId, tb.from);
      const notes = common(driver, from, {
        forkA: a.facts, forkB: b.facts, childrenDistinct: a.childId !== b.childId,
        first: { ...threadFacts(driver, a.childId, ta.from), ended: endA !== null, answerLooksRight: QUESTIONS.twoA.looksFor.test(answerOf(driver, a.childId, ta.from)) },
        second: { ...factsB, ended: endB !== null, interrupted: interrupt ? { sent: true, accepted: interrupt.ok, msAfterItsFirstDelta: factsB.firstDeltaMs === null ? null : Math.round(interruptAt - factsB.firstDeltaMs), endMsAfterTheInterrupt: factsB.end ? Math.round(factsB.end.ms - interruptAt) : null, framesAfterTheInterrupt: received(driver, from).filter((f) => f.frame?.params?.threadId === b.childId && f.ms > interruptAt && f.frame.method !== CODEX_TEXT_DELTA).map((f) => f.frame.method) } : { sent: false, why: 'no delta came before its turn ended' } },
        framesNamingNeither: received(driver, from).filter((f) => f.frame?.method && typeof f.frame.params?.threadId === 'string' && ![driver.threadId, a.childId, b.childId].includes(f.frame.params.threadId)).length,
      });
      if (endA === null || endB === null) return codex.didNotHappen('a turn on a child did not end in time', notes);
      return codex.happened(notes, Math.max(endA.index, endB.index));
    },
  },

  read: {
    id: 'm20b-fork-read', name: 'm20b-fork-read', turns: 1, files: FILES,
    title: 'K3: a question that invites a read, the child told to act on nothing',
    successCondition: "The child's turn ending; whether it read a file the parent never read, and how",
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no seed thread: run --scenario seed first');
      const driver = await ctx.open();
      const resumed = await resumeSeed(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      const from = driver.nextIndex;
      const forked = await fork(driver, forkParams(driver, ctx, state.codexModel.model, state.codexLastTurnId));
      if (!forked.reply.ok) return codex.didNotHappen(`the fork was refused (code ${forked.facts.errorCode})`, common(driver, from, { fork: forked.facts }));
      const turn = await childTurn(driver, ctx, forked.childId, QUESTIONS.read.text, state.codexModel);
      if (!turn.ok) return codex.didNotHappen(`turn/start on the child was refused (code ${turn.errorCode})`, common(driver, from, { fork: forked.facts, turn }));
      const end = await frameWithin(driver, turnEndOf(forked.childId), turn.from, 180_000);
      await sleep(1_500);
      const facts = threadFacts(driver, forked.childId, turn.from);
      const notes = common(driver, from, { fork: forked.facts, child: { ...facts, ended: end !== null, read: facts.commands.length > 0, answerQuotesTheFile: QUESTIONS.read.looksFor.test(answerOf(driver, forked.childId, turn.from)) } });
      if (end === null) return codex.didNotHappen('the turn on the child did not end in time', notes);
      return codex.happened(notes, end.index);
    },
  },

  again: {
    id: 'm20b-fork-again', name: 'm20b-fork-again', turns: 1, files: FILES,
    title: "K3: from a second process, a fork again with the aside's earlier exchange in its question (C22)",
    successCondition: "The child's turn ending, its answer knowing the earlier exchange from the question alone",
    async run(ctx) {
      const state = readState();
      if (!state.codexThreadId) return codex.notRun('no seed thread: run --scenario seed first');
      if (!state.codexExchange) return codex.notRun('no earlier exchange: run --scenario followup first');
      const driver = await ctx.open();
      const resumed = await resumeSeed(driver, ctx, state);
      if (!resumed.ok) return codex.didNotHappen('thread/resume was refused');
      const from = driver.nextIndex;
      const forked = await fork(driver, forkParams(driver, ctx, state.codexModel.model, state.codexLastTurnId));
      if (!forked.reply.ok) return codex.didNotHappen(`the fork was refused (code ${forked.facts.errorCode})`, common(driver, from, { fork: forked.facts }));
      // The earlier exchange before the question, in fat-g's words (C22).
      const text = `Earlier in this side conversation, I asked:\n\n${state.codexExchange.question}\n\nAnd you answered:\n\n${state.codexExchange.answer}\n\n${QUESTIONS.codexAgain.text}`;
      const turn = await childTurn(driver, ctx, forked.childId, text, state.codexModel);
      if (!turn.ok) return codex.didNotHappen(`turn/start on the child was refused (code ${turn.errorCode})`, common(driver, from, { fork: forked.facts, turn }));
      const end = await frameWithin(driver, turnEndOf(forked.childId), turn.from, 180_000);
      await sleep(1_500);
      const answer = answerOf(driver, forked.childId, turn.from);
      const notes = common(driver, from, { fork: forked.facts, questionUnits: text.length, child: { ...threadFacts(driver, forked.childId, turn.from), ended: end !== null, knowsTheEarlierExchange: QUESTIONS.codexAgain.looksFor.test(answer), knowsTheParentsHistory: QUESTIONS.codexAgain.alsoLooksFor.test(answer) } });
      if (end === null) return codex.didNotHappen('the turn on the child did not end in time', notes);
      return codex.happened(notes, end.index);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m20b-k3', (frame) => {
    if (frame.args.list) {
      for (const [key, entry] of Object.entries(SCENARIOS)) log(`codex   ${key.padEnd(10)} ${String(entry.turns).padStart(2)} prompt(s)${entry.atMost ? ' at most' : ''}  ${entry.title}`);
      log(`total: ${Object.values(SCENARIOS).reduce((sum, entry) => sum + entry.turns, 0)} prompts at most for one run of each; a fork costs none, a turn on a child one`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m20b/k3.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--path <executable>]`); return 1; }
    log(`K3: production's handshake less the opt-out of ${CODEX_TEXT_DELTA}; no experimental API; the thread saved as the app's are, its children ephemeral`);
    return codex.runScenario('m20b-k3', chosen, frame, CODEX_OPTIONS);
  });
}
