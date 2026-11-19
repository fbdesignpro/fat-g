// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M15 spike (C2, C3, C97, C123, C129; Design 1): a saved thread, its resume from a second process,
// the refusals of a resume, a thread given no turn, a read outside the thread's folder, and two
// app-servers running turns at once. M10 ran every thread `ephemeral` and traced none of this.
//
//   node spikes/m15/resume.mjs --scenario saved|resume|refusals|empty|earlystop|outside|parallel [--confirm-turns <n>] [--again]
//   node spikes/m15/resume.mjs --cleanup     (C3: delete the spike's saved threads, report how many were left)
//
// Every thread starts in the spike's scratch folder, saved and never named, so the cleanup finds
// them by that folder. `thread/list` and `thread/delete` are the spike's alone: the app sends neither.
import { randomUUID } from 'node:crypto';
import { EXIT } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { resolveExecutable } from '../m10/lib/executable.mjs';
import { isMain, writeJson } from '../m10/lib/paths.mjs';
import { buildScratch, scratchPath } from '../m10/lib/scratch.mjs';
import { log, runSpike } from '../m10/lib/spike.mjs';
import { M15Driver, SANDBOX, chooseScenario, didNotHappen, happened, liveItems, m15Path, notRun, outline, pickModel, readState, runScenario, writeState } from './lib/common.mjs';
import { checkSessionStart } from '../m10/codex/driver.mjs';

/** One family: these captures are redacted together, so one id has one alias across them. */
export const FAMILY = 'm15-saved-thread';

export const SAVED_PROMPT = 'Read the file sample.txt in the current folder, then tell me in one sentence where the cat sleeps.';
export const RESUME_PROMPT = 'Now read notes-2.txt in the same folder and tell me in one sentence what it says.';

const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

/** Threads whose folder is one of `folders`, as `thread/list` gives them with `params` added. */
async function listThreads(driver, folders, params = {}) {
  const found = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const reply = await driver.requestWithin('thread/list', { limit: 100, cwd: folders, ...params, ...(cursor ? { cursor } : {}) }, 30_000);
    if (!reply.ok) return { ok: false, code: reply.error?.code ?? null, found };
    for (const thread of reply.value?.data ?? []) if (typeof thread?.id === 'string') found.push({ id: thread.id, source: typeof thread.source === 'string' ? thread.source : thread.source?.type ?? null, turns: Array.isArray(thread.turns) ? thread.turns.length : null, ephemeral: thread.ephemeral ?? null });
    cursor = reply.value?.nextCursor ?? null;
    if (!cursor) break;
  }
  return { ok: true, found };
}

const errorOf = (reply) => (reply.ok ? null : { code: reply.error?.code ?? null, hasMessage: typeof reply.error?.message === 'string', messageChars: typeof reply.error?.message === 'string' ? reply.error.message.length : 0, hasData: reply.error?.data !== undefined && reply.error?.data !== null });

const echoOf = (driver, from, sent) => {
  const echo = driver.session.frames.find((f) => f.dir === 'recv' && f.index >= from && f.frame?.method === 'item/completed' && f.frame.params?.item?.type === 'userMessage');
  const started = driver.session.frames.find((f) => f.dir === 'recv' && f.index >= from && f.frame?.method === 'item/started' && f.frame.params?.item?.type === 'userMessage');
  return { echoed: Boolean(echo), keys: echo ? Object.keys(echo.frame.params.item).sort() : null, carriesClientId: echo?.frame.params.item.clientId === sent, startedCarriesClientId: started?.frame.params.item.clientId === sent };
};

const SCENARIOS = {
  saved: {
    id: 'm15-saved', name: 'm15-saved', family: FAMILY, turns: 1,
    title: 'A saved thread with one turn',
    successCondition: "A saved thread's first turn, sent with a model, an effort and a client message id, to its end",
    async run(ctx) {
      const driver = await ctx.open();
      const choice = await pickModel(driver);
      if (!choice.model) return notRun('model/list named no model');
      const started = await ctx.startThread(driver, { model: choice.model });
      if (!started.ok) return didNotHappen('thread/start was refused', { error: errorOf(started) });
      if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      const clientUserMessageId = randomUUID();
      const sent = await ctx.prompt(driver, SAVED_PROMPT, { model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}), clientUserMessageId });
      if (!sent.ok) return didNotHappen('turn/start was refused', { error: errorOf(sent) });
      const end = await ctx.turnEnd(driver, from);
      const items = liveItems(driver, from);
      writeState({ savedThreadId: driver.threadId, model: choice.model, effort: choice.effort, turns: [{ turnId: driver.turnId, clientUserMessageId, items }] });
      const reply = started.value ?? {};
      return happened({
        endStatus: end.status, startedEphemeral: reply.thread?.ephemeral ?? null, startReplyEffort: reply.reasoningEffort ?? null, sentEffort: choice.effort,
        startReplyKeys: Object.keys(reply).sort(), threadKeys: Object.keys(reply.thread ?? {}).sort(),
        echo: echoOf(driver, from, clientUserMessageId), items: items.map((i) => ({ type: i.type, phase: i.phase })), outline: outline(driver, from),
      }, end.index);
    },
  },

  resume: {
    id: 'm15-resume', name: 'm15-resume', family: FAMILY, turns: 1,
    title: 'thread/resume from a second process, then a turn',
    successCondition: "The saved thread resumed with excludeTurns in a new process, its reply checked, then a turn to its end",
    async run(ctx) {
      const state = readState();
      if (!state.savedThreadId) return notRun('no saved thread: run --scenario saved first');
      const driver = await ctx.open();
      const spawnToReady = driver.tree.elapsed();
      const params = { threadId: state.savedThreadId, cwd: ctx.scratch, ...SANDBOX, excludeTurns: true };
      const before = Date.now();
      const reply = await driver.resumeThread(params);
      const resumeMs = Date.now() - before;
      driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(SANDBOX, reply.value) : null };
      if (!reply.ok) return didNotHappen('thread/resume was refused', { error: errorOf(reply), resumeMs });
      if (!driver.sessionStart.check.passed) return notRun('the resume reply differed from the request (C21)', { rows: driver.sessionStart.check.rows });
      const value = reply.value ?? {};
      const from = driver.nextIndex;
      const clientUserMessageId = randomUUID();
      const sent = await ctx.prompt(driver, RESUME_PROMPT, { model: state.model, ...(state.effort ? { effort: state.effort } : {}), clientUserMessageId });
      if (!sent.ok) return didNotHappen('turn/start was refused after the resume', { error: errorOf(sent), resumeMs });
      const end = await ctx.turnEnd(driver, from);
      const items = liveItems(driver, from);
      writeState({ turns: [...(state.turns ?? []), { turnId: driver.turnId, clientUserMessageId, items }] });
      return happened({
        endStatus: end.status, resumeMs, spawnToHandshakeMs: spawnToReady, spawnToResumeReplyMs: driver.session.frames.find((f) => f.index === reply.index)?.ms ?? null,
        replyKeys: Object.keys(value).sort(), turnsInReply: Array.isArray(value.thread?.turns) ? value.thread.turns.length : null,
        hasTurnsCursor: typeof value.turnsBackwardsCursor === 'string', hasItemsCursor: typeof value.itemsBackwardsCursor === 'string',
        sameThreadId: value.thread?.id === state.savedThreadId, replyEffort: value.reasoningEffort ?? null, sentEffort: state.effort,
        echo: echoOf(driver, from, clientUserMessageId), items: items.map((i) => ({ type: i.type, phase: i.phase })), outline: outline(driver, from),
      }, end.index);
    },
  },

  refusals: {
    id: 'm15-refusals', name: 'm15-resume-refused', turns: 0,
    title: 'The refusals of a resume: an id that does not exist, and one that is not well formed',
    successCondition: 'Both resumes refused, each with its code, message and data kept in the raw capture (C129)',
    async run(ctx) {
      const driver = await ctx.open();
      const base = { cwd: ctx.scratch, ...SANDBOX, excludeTurns: true };
      const missing = await driver.resumeThread({ ...base, threadId: randomUUID() });
      const malformed = await driver.resumeThread({ ...base, threadId: 'not-a-thread-id' });
      // A history read of a thread that does not exist: what the read of a deleted session meets (C57).
      const missingRead = await driver.requestWithin('thread/turns/list', { threadId: randomUUID(), limit: 1 }, 30_000);
      const notes = {
        missing: errorOf(missing), malformed: errorOf(malformed), missingHistoryRead: errorOf(missingRead),
        sameCode: !missing.ok && !malformed.ok && missing.error?.code === malformed.error?.code,
        sameMessage: !missing.ok && !malformed.ok && missing.error?.message === malformed.error?.message,
      };
      driver.sessionStart = { request: base, replyIndex: missing.index, ok: false, check: null };
      if (missing.ok || malformed.ok) return didNotHappen('a resume that should have been refused was accepted', notes);
      return happened(notes, malformed.index);
    },
  },

  empty: {
    id: 'm15-empty', name: 'm15-empty-thread', turns: 0,
    title: 'A saved thread started and given no turn',
    successCondition: 'The thread started, its process ended, and a second process asked whether Codex lists it (C123)',
    async run(ctx) {
      const first = await ctx.open('first');
      const started = await ctx.startThread(first);
      if (!started.ok) return didNotHappen('thread/start was refused', { error: errorOf(started) });
      const id = first.threadId;
      const folders = [ctx.scratch];
      const whileOpen = { default: await listThreads(first, folders), everySource: await listThreads(first, folders, { sourceKinds: SOURCE_KINDS }) };
      await first.close();
      const second = await ctx.open('second');
      second.sessionIds = [id];
      const afterwards = { default: await listThreads(second, folders), everySource: await listThreads(second, folders, { sourceKinds: SOURCE_KINDS }) };
      const resumed = await second.resumeThread({ threadId: id, cwd: ctx.scratch, ...SANDBOX, excludeTurns: true });
      second.threadId = id;
      const saved = readState().savedThreadId ?? null;
      const shows = (listing, thread) => (listing.ok ? listing.found.some((t) => t.id === thread) : null);
      const count = (listing) => (listing.ok ? listing.found.length : null);
      return happened({
        ephemeral: started.value?.thread?.ephemeral ?? null,
        whileItsProcessRuns: { default: shows(whileOpen.default, id), everySource: shows(whileOpen.everySource, id) },
        afterItsProcessEnded: { default: shows(afterwards.default, id), everySource: shows(afterwards.everySource, id) },
        // For comparison: the saved thread that did have turns, in the same listings.
        threadWithTurns: saved ? { default: shows(afterwards.default, saved), everySource: shows(afterwards.everySource, saved) } : 'no saved thread to compare with',
        listed: { default: count(afterwards.default), everySource: count(afterwards.everySource) },
        resumeOfIt: resumed.ok ? { ok: true, turnsInReply: Array.isArray(resumed.value?.thread?.turns) ? resumed.value.thread.turns.length : null } : { ok: false, error: errorOf(resumed) },
      }, resumed.index);
    },
  },

  // Added during the run: the empty-thread trace showed that a thread given no turn is
  // not kept and cannot be resumed, so when a thread becomes resumable decides when the app may
  // store its reference (C20).
  earlystop: {
    id: 'm15-early-stop', name: 'm15-early-stop', turns: 1,
    title: "A first turn interrupted as soon as it is named, then a resume from a second process",
    successCondition: "The first turn interrupted at its turn/start reply, the process ended, and a second process asking to resume the thread",
    async run(ctx) {
      const { args } = ctx;
      const first = await ctx.open('first');
      const started = await ctx.startThread(first);
      if (!started.ok) return didNotHappen('thread/start was refused', { error: errorOf(started) });
      if (!first.sessionStart.check.passed) return notRun('the session-start reply differed from the request (C21)', { rows: first.sessionStart.check.rows });
      const id = first.threadId;
      const from = first.nextIndex;
      const sent = await ctx.prompt(first, 'Read notes-1.txt, notes-2.txt, notes-3.txt and notes-4.txt one at a time, in that order, and then summarise all four in one sentence.');
      if (!sent.ok) return didNotHappen('turn/start was refused', { error: errorOf(sent) });
      // The first run sent the interrupt at the turn/start reply and was refused (-32600, no active
      // turn): the turn is not active until its turn/started arrives. So the interrupt waits for it.
      const early = args.atReply ? await first.interrupt() : null;
      await ctx.wait(first, (e) => e.kind === 'turn-start', from);
      const interrupt = await first.interrupt();
      const end = await ctx.turnEnd(first, from);
      const itemsBeforeEnd = first.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && f.index < end.index && f.frame?.method?.startsWith('item/')).map((f) => `${f.frame.method} ${f.frame.params?.item?.type ?? ''}`);
      await first.close();
      const second = await ctx.open('second');
      second.sessionIds = [id];
      const resumed = await second.resumeThread({ threadId: id, cwd: ctx.scratch, ...SANDBOX, excludeTurns: true });
      second.threadId = id;
      const turns = await second.requestWithin('thread/turns/list', { threadId: id, limit: 4, itemsView: 'full' }, 30_000);
      const summary = await second.requestWithin('thread/turns/list', { threadId: id, limit: 4, itemsView: 'summary' }, 30_000);
      const describe = (reply) => (reply.ok ? (reply.value?.data ?? []).map((turn) => ({ status: turn.status ?? null, items: (turn.items ?? []).map((item) => (item.type === 'agentMessage' ? `agentMessage:${item.phase ?? '?'}` : item.type)) })) : { error: errorOf(reply) });
      return happened({
        interruptAtReply: early ? { accepted: early.ok, error: errorOf(early) } : 'not sent', interruptAtTurnStarted: { accepted: interrupt.ok, error: errorOf(interrupt) }, endStatus: end.status, msFromTurnStartReplyToEnd: (first.session.frames.find((f) => f.index === end.index)?.ms ?? 0) - (first.session.frames.find((f) => f.index === sent.index)?.ms ?? 0),
        itemsBeforeTheEnd: itemsBeforeEnd,
        resume: resumed.ok ? { ok: true } : { ok: false, error: errorOf(resumed) },
        historyFull: describe(turns), historySummary: describe(summary),
      }, resumed.index);
    },
  },

  outside: {
    id: 'm15-outside', name: 'm15-outside-read', turns: 1,
    title: "A read of a file in a second folder, outside the thread's own",
    successCondition: "The turn's end, with whether the file outside the thread's folder was read (C26)",
    async run(ctx) {
      const driver = await ctx.open();
      const started = await ctx.startThread(driver);
      if (!started.ok) return didNotHappen('thread/start was refused', { error: errorOf(started) });
      if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      await ctx.prompt(driver, `Read the file ${ctx.outside}\\outside.txt and tell me in one sentence what the dog is called. If you cannot read it, say so in one sentence.`);
      const end = await ctx.turnEnd(driver, from);
      const frames = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);
      const commands = frames.filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.item?.type === 'commandExecution').map((f) => ({ status: f.frame.params.item.status ?? null, exitCode: f.frame.params.item.exitCode ?? null, outputHasTheName: String(f.frame.params.item.aggregatedOutput ?? '').includes('Pepper'), actions: (f.frame.params.item.commandActions ?? []).map((a) => a.type) }));
      const answer = frames.filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.item?.type === 'agentMessage' && f.frame.params.item.phase === 'final_answer').map((f) => String(f.frame.params.item.text ?? '')).join('\n');
      return happened({ endStatus: end.status, readOutside: commands.some((c) => c.outputHasTheName), answerHasTheName: answer.includes('Pepper'), commands, requests: driver.requestsSeen.map((r) => r.kind), outline: outline(driver, from) }, end.index);
    },
  },

  parallel: {
    id: 'm15-parallel', name: 'm15-parallel', turns: 2,
    title: 'Two app-servers, each running a turn, at the same time',
    successCondition: 'Both turns ended, the two having run at the same time (C12, C29)',
    async run(ctx) {
      const [a, b] = await Promise.all([ctx.open('a'), ctx.open('b')]);
      const starts = await Promise.all([ctx.startThread(a), ctx.startThread(b)]);
      if (starts.some((s) => !s.ok)) return didNotHappen('a thread/start was refused', { errors: starts.map(errorOf) });
      const runTurn = async (driver, file) => {
        const from = driver.nextIndex;
        const startedAt = Date.now();
        const sent = await ctx.prompt(driver, `Read ${file} in the current folder, then tell me in one sentence what it says.`);
        if (!sent.ok) return { ok: false, error: errorOf(sent) };
        const end = await ctx.turnEnd(driver, from);
        return { ok: true, status: end.status, startedAt, endedAt: Date.now() };
      };
      const [ra, rb] = await Promise.all([runTurn(a, 'notes-1.txt'), runTurn(b, 'notes-4.txt')]);
      const overlap = ra.ok && rb.ok && ra.startedAt < rb.endedAt && rb.startedAt < ra.endedAt;
      const notes = { a: ra.ok ? { status: ra.status, ms: ra.endedAt - ra.startedAt } : ra, b: rb.ok ? { status: rb.status, ms: rb.endedAt - rb.startedAt } : rb, ranAtTheSameTime: overlap, distinctThreads: a.threadId !== b.threadId };
      if (!ra.ok || !rb.ok || !overlap) return didNotHappen('the two turns did not both run at once', notes);
      return happened(notes);
    },
  },
};

/** C3: every thread whose folder is a spike folder, whatever its source, deleted; then counted again. */
async function cleanup({ args, launcher, signal, waits }) {
  const executable = resolveExecutable('codex', args.path);
  const probe = buildScratch('probe');
  const folders = [scratchPath('m15'), scratchPath('m15Outside')];
  const driver = new M15Driver({ launcher, executable, cwd: probe.dir, env: cleanEnvironment('codex').env, waits, signal });
  const report = { date: new Date().toISOString(), folders: folders.length };
  try {
    await driver.open();
    const found = new Map();
    for (const archived of [false, true]) {
      const listing = await listThreads(driver, folders, { sourceKinds: SOURCE_KINDS, archived });
      if (!listing.ok) report.listFailed = listing.code;
      for (const thread of listing.found) found.set(thread.id, thread);
    }
    report.found = found.size;
    report.bySource = [...found.values()].reduce((counts, t) => ({ ...counts, [t.source ?? 'unknown']: (counts[t.source ?? 'unknown'] ?? 0) + 1 }), {});
    report.deleted = 0;
    report.refused = [];
    for (const id of found.keys()) {
      const reply = await driver.requestWithin('thread/delete', { threadId: id }, 30_000);
      if (reply.ok) report.deleted++;
      else report.refused.push(reply.error?.code ?? null);
    }
    let left = 0;
    for (const archived of [false, true]) left += (await listThreads(driver, folders, { sourceKinds: SOURCE_KINDS, archived })).found.length;
    report.left = left;
  } finally {
    const cleanupState = await driver.close();
    report.cleanupConfirmed = cleanupState.confirmed;
  }
  if (report.left === 0) writeState({ savedThreadId: null, turns: [], cleanedAt: report.date });
  writeJson(m15Path('cleanup.json'), report);
  log(JSON.stringify(report, null, 2));
  return report.left === 0 && !report.listFailed ? EXIT.happened : EXIT.didNotHappen;
}

if (isMain(import.meta.url)) {
  await runSpike('m15-resume', async (frame) => {
    if (frame.args.cleanup) return cleanup(frame);
    const scenario = chooseScenario('resume', SCENARIOS, frame.args);
    return scenario ? runScenario('m15-resume', scenario, frame) : EXIT.error;
  });
}
