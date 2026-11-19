// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M19 spike K1 (docs/planning/_archive/M19-spec-sheet.md; C7, C8, C54): Codex's installed CLI under
// production's session handshake with `item/agentMessage/delta` not opted out, and nothing
// experimental asked for. Four prompts at most, one per scenario.
//
//   node spikes/m19/k1.mjs --scenario answer|interrupt|worker|markdown [--confirm-turns 1] [--again]
//
// Without --confirm-turns 1 it prints its plan and launches nothing (S8). One invocation is one run;
// at most three runs per scenario (M10's ledger, under spikes/output/m19). Threads start in M15's
// scratch folder under the temp folder, saved as the app's are: `node spikes/m15/resume.mjs
// --cleanup` finds them by that folder and deletes them, with M15's own.
//
// What each run records, never a text: for each agent message of the session's thread, whether
// `item/started` opened it with its phase, how many deltas came and how large and how fast, whether
// their text put together is the completed item's, and the order of the three; which thread and
// turn a worker's deltas name; and what an interrupt leaves.
import { randomUUID } from 'node:crypto';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { didNotHappen, happened, notRun, outline, pickModel, runScenario } from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, M19_DIR, OMITTED_CODEX, deltaFacts, received, sizes } from './lib/common.mjs';

const OPTIONS = { dir: M19_DIR, milestone: 'M19', Driver: M19CodexDriver, omitted: OMITTED_CODEX };

/** The turn as the app starts it (session.ts): the model, the effort, an id of fat-g's own. */
const turnExtra = (model) => ({ model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID() });

/** What the frames of the session's thread, and of the others, say about each agent message. */
function messages(driver, from) {
  const frames = received(driver, from).filter((f) => typeof f.frame?.method === 'string');
  const role = (threadId) => (threadId === driver.threadId ? 'session' : 'other');
  const byItem = new Map();
  const item = (id) => { if (!byItem.has(id)) byItem.set(id, { alias: `m${byItem.size + 1}`, started: null, deltas: [], completed: null, thread: null, turns: new Set(), deltaThreads: new Set(), deltaTurns: new Set() }); return byItem.get(id); };
  let otherDeltas = 0;
  for (const entry of frames) {
    const { method, params = {} } = entry.frame;
    if (method === 'item/started' && params.item?.type === 'agentMessage') {
      const m = item(params.item.id);
      m.started = { index: entry.index, ms: entry.ms, phase: params.item.phase ?? null, hasPhase: 'phase' in params.item, textUnits: String(params.item.text ?? '').length, keys: Object.keys(params.item).sort() };
      m.thread = role(params.threadId);
      m.turns.add(params.turnId ?? null);
    } else if (method === CODEX_TEXT_DELTA) {
      if (typeof params.itemId !== 'string') { otherDeltas += 1; continue; }
      const m = item(params.itemId);
      m.deltas.push(entry);
      m.deltaThreads.add(role(params.threadId));
      m.deltaTurns.add(params.turnId ?? null);
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      const m = item(params.item.id);
      m.completed = { index: entry.index, ms: entry.ms, phase: params.item.phase ?? null, textUnits: String(params.item.text ?? '').length, sameTextAsDeltas: m.deltas.map((d) => d.frame.params.delta ?? '').join('') === String(params.item.text ?? ''), keys: Object.keys(params.item).sort() };
      m.thread ??= role(params.threadId);
      m.turns.add(params.turnId ?? null);
    }
  }
  const sessionTurn = driver.turnId;
  return {
    deltaKeys: [...new Set(frames.filter((f) => f.frame.method === CODEX_TEXT_DELTA).map((f) => Object.keys(f.frame.params ?? {}).sort().join(',')))],
    deltasWithoutItem: otherDeltas,
    items: [...byItem.values()].map((m) => ({
      alias: m.alias, thread: m.thread, turnIsTheSessions: [...m.turns].every((id) => id === sessionTurn), started: m.started, completed: m.completed,
      deltas: { ...deltaFacts(m.deltas, (frame) => frame.params?.delta), threads: [...m.deltaThreads], turnIsTheSessions: [...m.deltaTurns].every((id) => id === sessionTurn), firstIndex: m.deltas[0]?.index ?? null, lastIndex: m.deltas.at(-1)?.index ?? null },
      order: m.started && m.deltas.length ? { startedBeforeFirstDelta: m.started.index < m.deltas[0].index, completedAfterLastDelta: m.completed ? m.completed.index > m.deltas.at(-1).index : null, startedToFirstDeltaMs: Math.round(m.deltas[0].ms - m.started.ms), lastDeltaToCompletedMs: m.completed ? Math.round(m.completed.ms - m.deltas.at(-1).ms) : null } : null,
    })),
  };
}

const typeCounts = (driver, from) => { const counts = {}; for (const f of received(driver, from)) { const key = f.frame?.method ?? 'response'; counts[key] = (counts[key] ?? 0) + 1; } return counts; };

const SCENARIOS = {
  answer: {
    id: 'm19-answer', name: 'm19-answer', turns: 1,
    title: "K1: T1's prompt under a handshake that keeps the text deltas",
    successCondition: "An agent message opened by `item/started`, grown by deltas and completed by `item/completed`, and the turn's end",
    async run(ctx) {
      const driver = await ctx.open();
      const model = await pickModel(driver);
      if (!model.model) return notRun('the CLI listed no model');
      const started = await ctx.startThread(driver, { model: model.model });
      if (!started.ok) return didNotHappen('thread/start was refused');
      if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      // T1's words, so that the fake can answer this prompt with this capture (C54).
      await ctx.prompt(driver, 'Read the file sample.txt in the current folder, then tell me in one sentence what the cat is called.', turnExtra(model));
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      const facts = messages(driver, from);
      const notes = { model, endStatus: end.status, optedOut: driver.optedOut.length, experimentalApiAsked: false, droppedDeltas: driver.session.recorder.deltas, typeCounts: typeCounts(driver, from), ...facts, outline: outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA) };
      const grown = facts.items.filter((m) => m.deltas.count > 0 && m.completed);
      if (grown.length === 0) return didNotHappen(facts.items.length ? 'no agent message came with deltas' : 'no agent message came', notes);
      return happened(notes, end.index);
    },
  },

  interrupt: {
    id: 'm19-interrupt', name: 'm19-interrupt', turns: 1,
    title: 'K1: an interrupt while an answer is written',
    successCondition: 'Deltas of an answer, an interrupt, then the turn ending interrupted: what is left of the answer',
    async run(ctx) {
      const driver = await ctx.open();
      const model = await pickModel(driver);
      if (!model.model) return notRun('the CLI listed no model');
      const started = await ctx.startThread(driver, { model: model.model });
      if (!started.ok) return didNotHappen('thread/start was refused');
      if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      await ctx.prompt(driver, 'Without using any tool, write a numbered list of 120 distinct short facts about arithmetic, one per line.', turnExtra(model));
      // The fifth delta of an answer on the session's thread, or the turn's end before it.
      let count = 0;
      const hit = await driver.session.waitFor((f) => (f.method === CODEX_TEXT_DELTA && f.params?.threadId === driver.threadId && ++count >= 5) || (f.method === 'turn/completed' && f.params?.threadId === driver.threadId), { wait: 'scenario', ms: ctx.waits.scenario, fromIndex: from });
      if (hit.frame.method === 'turn/completed') return didNotHappen('the turn ended before five deltas came', { endStatus: hit.frame.params?.turn?.status ?? null, ...messages(driver, from) });
      const interruptAt = driver.nextIndex;
      const reply = await driver.interrupt();
      const end = await ctx.turnEnd(driver, from);
      await sleep(2_000);
      const facts = messages(driver, from);
      const after = received(driver, interruptAt).map((f) => f.frame?.method ?? 'response');
      const notes = {
        model, interruptAccepted: reply.ok, endStatus: end.status, deltasBeforeTheInterrupt: count, droppedDeltas: driver.session.recorder.deltas, typeCounts: typeCounts(driver, from),
        deltasAfterTheInterrupt: after.filter((m) => m === CODEX_TEXT_DELTA).length, completedAfterTheInterrupt: after.includes('item/completed'), framesAfterTheInterrupt: after.filter((m) => m !== CODEX_TEXT_DELTA),
        ...facts, outline: outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA),
      };
      return happened(notes, end.index);
    },
  },

  worker: {
    id: 'm19-worker', name: 'm19-worker', turns: 1, tools: ['sub-agent'],
    title: "K1: T3's prompt, a worker, under a handshake that keeps the text deltas",
    successCondition: "A worker's start and end, and which thread and turn its deltas name",
    async run(ctx) {
      const driver = await ctx.open();
      const model = await pickModel(driver);
      if (!model.model) return notRun('the CLI listed no model');
      const started = await ctx.startThread(driver, { model: model.model });
      if (!started.ok) return didNotHappen('thread/start was refused');
      if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      await ctx.prompt(driver, 'Spawn a sub-agent and give it this small task: read notes-3.txt and report its contents. Do not read the file yourself. When the sub-agent is done, tell me in one sentence what it found.', turnExtra(model));
      const end = await ctx.turnEnd(driver, from);
      await sleep(2_000);
      const events = driver.events(from).filter((e) => e.index <= end.index);
      const start = events.find((e) => e.kind === 'worker-start');
      const stop = events.find((e) => e.kind === 'worker-end' && (!start || e.index > start.index));
      const facts = messages(driver, from);
      const notes = { model, endStatus: end.status, workerEvents: events.filter((e) => e.kind.startsWith('worker')).map((e) => ({ kind: e.kind, source: e.source ?? null })), droppedDeltas: driver.session.recorder.deltas, typeCounts: typeCounts(driver, from), ...facts, outline: outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA) };
      if (!start || !stop) return didNotHappen(start ? 'a worker started but no end was seen before the turn ended' : 'no worker started', notes);
      return happened(notes, end.index);
    },
  },

  markdown: {
    id: 'm19-markdown', name: 'm19-markdown', turns: 1,
    title: 'K1: a long Markdown answer with a code block and a table',
    successCondition: "An answer of some length as deltas, completed, and the turn's end: the deltas' sizes and rate",
    async run(ctx) {
      const driver = await ctx.open();
      const model = await pickModel(driver);
      if (!model.model) return notRun('the CLI listed no model');
      const started = await ctx.startThread(driver, { model: model.model });
      if (!started.ok) return didNotHappen('thread/start was refused');
      if (!driver.sessionStart.check.passed) return notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
      const from = driver.nextIndex;
      await ctx.prompt(driver, 'Without using any tool, write about 400 words in Markdown explaining how a tide table is read: use two headings, a bulleted list, a fenced JavaScript code block of about 25 lines that computes the next high tide from a list of times, and a table with at least 10 rows of example times and heights.', turnExtra(model));
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      const facts = messages(driver, from);
      const largest = facts.items.reduce((best, m) => (m.completed && m.completed.textUnits > (best?.completed?.textUnits ?? -1) ? m : best), null);
      const notes = { model, endStatus: end.status, droppedDeltas: driver.session.recorder.deltas, typeCounts: typeCounts(driver, from), largestAnswerUnits: largest?.completed?.textUnits ?? null, frameBytes: sizes(driver.frameBytes.filter((f) => f.method === CODEX_TEXT_DELTA).map((f) => f.bytes)), ...facts, outline: outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA) };
      if (!largest || largest.deltas.count === 0) return didNotHappen('no completed answer came with deltas', notes);
      return happened(notes, end.index);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m19-k1', (frame) => {
    const scenario = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m19/k1.mjs --scenario ${Object.keys(SCENARIOS).join('|')} [--confirm-turns 1] [--again] [--path <executable>]`); return 1; }
    log(`K1: production's handshake less the opt-out of ${CODEX_TEXT_DELTA}; no experimental API`);
    return runScenario('m19-k1', scenario, frame, OPTIONS);
  });
}
