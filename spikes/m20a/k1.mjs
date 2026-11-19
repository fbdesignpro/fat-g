// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M20a spike K1 (docs/planning/_archive/M20a-spec-sheet.md; C1, C9, C24): Codex's task checklist and its
// reasoning items under production's handshake. The installed Codex under the session handshake as
// M19 leaves it — the ten opt-outs, an agent message's deltas kept, no experimental API — read-only
// and `never`, in M15's scratch folder with M19b's three files beside M10's. One prompt per run,
// two runs at most: a default-mode task of several steps, and, where the first brought no
// `turn/plan/updated`, the same task with its steps asked to be tracked.
//
//   node spikes/m20a/k1.mjs --list
//   node spikes/m20a/k1.mjs --scenario steps|steps-tracked|steps-high|steps-tool|investigate-high|steps-tool-on [--confirm-turns 1] [--again]
//
// Without --confirm-turns 1 it prints its plan and launches nothing (S6). One invocation is one run
// of one prompt; at most three runs per scenario (M10's ledger, under spikes/output/m20a). The
// thread is saved as the app's are, so that a second process can read its history as the app's
// history check does (M18, C51); `node spikes/m15/resume.mjs --cleanup` deletes it with M15's own.
//
// What a run records (never a text of the model's: the capture holds the frames): whether
// `turn/plan/updated` arrived and in what shape — its keys, how many notifications, how many steps
// and their states — what each `reasoning` item's completed `summary` and `content` hold, by count
// and size, and whether a history read of the turn returns the checklist, on the session's own
// connection and from a second process that never resumed the thread.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sleep } from '../m10/lib/deadlines.mjs';
import { SPIKES_DIR, isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';

export const M20A_DIR = path.join(SPIKES_DIR, 'output', 'm20a');
const PLAN = 'turn/plan/updated';

const TASK = 'Do these four steps in order, in this folder, and report what each one found: 1) list the files here, including the ones in subfolders; 2) read README.md and summarise it in one sentence; 3) find where the function nextHighTide is defined in src/tides.js and say what it returns; 4) count the lines of the Markdown file in the folder called field notes.';

const INVESTIGATION = 'Investigate this project and write me a short report. Work through it step by step: what each file is for, which functions src/tides.js defines and what each returns, whether what README.md says about the code matches the code, whether the notes under field notes mention anything the code does not handle, and what you would change first. Keep the report under 200 words.';

/**
 * The prompts (the sheet's K1). The first two ran at the lightest effort and brought no
 * checklist; the maintainer then asked for more: the task at high effort, the task
 * naming the plan tool, and a larger open-ended task at high effort.
 */
const PROMPTS = {
  steps: { title: 'a task of several steps, as a user gives it', prompt: TASK },
  'steps-tracked': { title: 'the same task, its steps asked to be tracked', prompt: `${TASK} Keep a running checklist of the four steps as you work, marking each one done as you finish it.` },
  'steps-high': { title: 'the same task at high effort', prompt: TASK, effort: 'high' },
  'steps-tool': { title: 'the same task, the plan tool named', prompt: `${TASK} Use your update_plan tool to keep a plan of these four steps, and update it as each one completes.` },
  'investigate-high': { title: 'a larger open task at high effort', prompt: INVESTIGATION, effort: 'high' },
  // The spike's own launch, never the app's (decision 0018, item 4: fat-g sends no `config`): the plan
  // tool switched on by the configuration key the installed binary names under `[tools]`, so that
  // the notification's shape is seen once. In the app that switch is the user's own configuration's.
  'steps-tool-on': { title: 'the task naming the plan tool, with the tool switched on by a config override of the spike\'s own', prompt: `${TASK} Use your update_plan tool to keep a plan of these four steps, and update it as each one completes.`, start: { config: { 'tools.update_plan': { enabled: true } } } },
};

/** The default model's efforts as the CLI lists them, lightest first (model/list, as pickModel reads it). */
async function effortsOf(driver) {
  const reply = await driver.request('model/list', { limit: 100 });
  const models = reply.ok && Array.isArray(reply.value?.data) ? reply.value.data : [];
  const model = models.find((m) => m.isDefault) ?? models.find((m) => !m.hidden) ?? null;
  return (model?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((e) => typeof e === 'string');
}

const sizeOf = (value) => (typeof value === 'string' ? value.length : Array.isArray(value) ? value.reduce((sum, part) => sum + (typeof part === 'string' ? part.length : typeof part?.text === 'string' ? part.text.length : 0), 0) : value == null ? 0 : JSON.stringify(value).length);

/** The checklist notifications' shape, without their texts. */
function planFacts(entries) {
  const frames = entries.filter((f) => f.frame?.method === PLAN);
  return {
    count: frames.length,
    firstAtMs: frames[0]?.ms ?? null,
    lastAtMs: frames.at(-1)?.ms ?? null,
    paramKeys: frames[0] ? Object.keys(frames[0].frame.params ?? {}).sort() : null,
    stepKeys: frames[0] ? Object.keys((frames[0].frame.params?.plan ?? [])[0] ?? {}).sort() : null,
    perNotification: frames.map((f) => {
      const plan = Array.isArray(f.frame.params?.plan) ? f.frame.params.plan : [];
      return { ms: f.ms, steps: plan.length, states: plan.map((step) => step.status ?? step.state ?? null), explanation: typeof f.frame.params?.explanation === 'string' ? f.frame.params.explanation.length : null, threadNamed: typeof f.frame.params?.threadId === 'string', turnNamed: typeof f.frame.params?.turnId === 'string' };
    }),
  };
}

/** Each reasoning item's two frames, by what their `summary` and `content` hold. */
function reasoningFacts(entries) {
  const items = new Map();
  for (const f of entries) {
    const method = f.frame?.method;
    if (method !== 'item/started' && method !== 'item/completed') continue;
    const item = f.frame.params?.item;
    if (item?.type !== 'reasoning') continue;
    const facts = items.get(item.id) ?? { id: item.id };
    facts[method === 'item/started' ? 'started' : 'completed'] = { ms: f.ms, keys: Object.keys(item).sort(), summaryEntries: Array.isArray(item.summary) ? item.summary.length : item.summary == null ? null : 'not a list', summaryUnits: sizeOf(item.summary), contentEntries: Array.isArray(item.content) ? item.content.length : item.content == null ? null : 'not a list', contentUnits: sizeOf(item.content) };
    items.set(item.id, facts);
  }
  const all = [...items.values()];
  return { items: all.length, withSummary: all.filter((i) => (i.completed?.summaryUnits ?? 0) > 0).length, withContent: all.filter((i) => (i.completed?.contentUnits ?? 0) > 0).length, each: all };
}

/** What a history read of the turn holds, by item type (M15's history.mjs reads the same way). */
async function historyOf(driver, threadId, label) {
  const reply = await driver.requestWithin('thread/turns/list', { threadId, limit: 1, itemsView: 'full' }, 30_000);
  if (!reply.ok) return { label, ok: false, error: { code: reply.error?.code ?? null, hasMessage: typeof reply.error?.message === 'string' } };
  const data = Array.isArray(reply.value?.data) ? reply.value.data : [];
  const turn = data[0] ?? null;
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return {
    label, ok: true, turns: data.length, turnKeys: turn ? Object.keys(turn).sort() : null,
    itemTypes: items.map((item) => (item.type === 'agentMessage' ? `agentMessage:${item.phase ?? '?'}` : item.type)),
    checklistItems: items.filter((item) => /plan|todo|checklist/i.test(String(item.type ?? ''))).map((item) => ({ type: item.type, keys: Object.keys(item).sort() })),
    reasoningItems: items.filter((item) => item.type === 'reasoning').map((item) => ({ summaryUnits: sizeOf(item.summary), contentUnits: sizeOf(item.content) })),
    commandItems: items.filter((item) => item.type === 'commandExecution').map((item) => ({ keys: Object.keys(item).sort(), outputUnits: sizeOf(item.aggregatedOutput), hasDuration: typeof item.durationMs === 'number', hasStartedAt: 'startedAt' in item || 'startedAtMs' in item })),
  };
}

const CODEX_OPTIONS = { dir: M20A_DIR, milestone: 'M20a', Driver: M19CodexDriver, omitted: OMITTED_CODEX };

const scenario = (key, { title, prompt, effort: wanted = null, start = {} }) => ({
  id: `m20a-${key}`, name: `m20a-${key}`, turns: 1, files: FILES,
  title: `K1: ${title}`, successCondition: "A `turn/plan/updated` notification during the turn, and the turn's end",
  async run(ctx) {
    const driver = await ctx.open();
    const model = await codex.pickModel(driver);
    if (!model.model) return codex.notRun('the CLI listed no model');
    if (wanted) {
      // The effort asked for where the CLI lists it for the model, else the heaviest it lists.
      const efforts = await effortsOf(driver);
      model.effort = efforts.includes(wanted) ? wanted : efforts.at(-1) ?? model.effort;
      model.efforts = efforts;
    }
    const started = await ctx.startThread(driver, { model: model.model, ...start });
    if (!started.ok) return codex.didNotHappen('thread/start was refused');
    if (!driver.sessionStart.check.passed) return codex.notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
    const from = driver.nextIndex;
    // The turn as the app starts it (session.ts): the model, the effort, an id of fat-g's own.
    await ctx.prompt(driver, prompt, { model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID() });
    const end = await ctx.turnEnd(driver, from);
    await sleep(1_500);
    const entries = received(driver, from);
    const plan = planFacts(entries);
    const reasoning = reasoningFacts(entries);
    // The turn read back as the app's history check reads it: on this connection, and from a second process that never resumed the thread (M18, C51).
    const history = { live: await historyOf(driver, driver.threadId, 'the session\'s own connection, thread loaded') };
    try {
      const reader = await ctx.open('history');
      // The capture of a process that starts no thread names its session's id itself, so the redactor aliases it as the session's (M15's history read).
      reader.sessionIds = [driver.threadId];
      history.fresh = await historyOf(reader, driver.threadId, 'a second process that never resumed the thread');
    } catch (error) {
      history.fresh = { label: 'a second process that never resumed the thread', ok: false, error: { why: String(error?.message ?? error).slice(0, 120) } };
    }
    const notes = {
      model, endStatus: end.status, prompt: key,
      ...(Object.keys(start).length ? { spikeOwnThreadStart: start, launch: 'the spike\'s own: the app sends no config on thread/start (decision 0018, item 4)' } : {}),
      itemTypesStarted: entries.filter((f) => f.frame?.method === 'item/started' && f.frame.params?.threadId === driver.threadId).map((f) => f.frame.params.item?.type ?? null),
      plan, reasoning, history,
      textDeltas: entries.filter((f) => f.frame?.method === CODEX_TEXT_DELTA).length,
      outline: codex.outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA),
    };
    if (plan.count === 0) return codex.didNotHappen(`no ${PLAN} came during the turn`, notes);
    return codex.happened(notes, end.index);
  },
});

const SCENARIOS = Object.fromEntries(Object.entries(PROMPTS).map(([key, entry]) => [key, scenario(key, entry)]));

if (isMain(import.meta.url)) {
  await runSpike('m20a-k1', (frame) => {
    if (frame.args.list) {
      for (const [key, entry] of Object.entries(SCENARIOS)) log(`codex   ${key.padEnd(16)} ${entry.turns} turn  ${entry.title}`);
      log(`total: ${Object.keys(SCENARIOS).length} turns for one run of each; the first two ran first, the other three later, at the maintainer's word`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m20a/k1.mjs --list | --scenario ${Object.keys(PROMPTS).join('|')} [--confirm-turns 1] [--again] [--path <executable>]`); return 1; }
    log(`K1: production's handshake less the opt-out of ${CODEX_TEXT_DELTA}; no experimental API; the thread saved as the app's are`);
    return codex.runScenario('m20a-k1', chosen, frame, CODEX_OPTIONS);
  });
}
