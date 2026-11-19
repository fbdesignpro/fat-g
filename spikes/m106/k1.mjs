// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M106 spike K1 (docs/planning/_archive/M106-spec-sheet.md; C14, C20, C37): Claude under the app's launch — M16's as
// M20b leaves it, with the `Agent` tool among the four that read, under `default` — in M16's scratch
// configuration folder: the maintainer's own configuration is neither read nor changed. Background
// tasks are left on, as the app leaves them, so that a sub-agent may outlive its turn.
//
//   node spikes/m106/k1.mjs --list
//   node spikes/m106/k1.mjs --scenario <name> --confirm-turns 1 [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C37). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m106). `foreground` asks for one sub-agent on another model than the session's,
// in the foreground; `background` for two in the background, on two models, and waits for their
// ends and the turn the CLI then starts by itself (turn-tracing §8).
//
// What a run records of each sub-agent is what names its model: the `Agent` tool use's input, the
// `task_started` frame's fields, the `model` of the worker's own `assistant` frames against the
// session's `init` model, and the `task_progress`, `task_updated` and `task_notification` frames'
// fields. Never a text of the model's: whether an answer holds the marker word the spike dictated.
import { randomUUID } from 'node:crypto';
import { typeKey } from '../m10/claude/frames.mjs';
import { deadlines, sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { TOOLS, didNotHappen, framesOf, happened, initOf, notRun, outline, runScenario } from '../m16/lib/common.mjs';
import { received } from '../m19/lib/common.mjs';
import { tidy, typeCounts } from '../m22b/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { ASKED, M106_DIR, MARKERS, PROMPTS, holds, modelFields } from './lib/common.mjs';

/** The app's launch for a chat that may start sub-agents (M16, C14): the four tools that read and `Agent`, under `default`. */
const LAUNCH = Object.freeze({ tools: TOOLS, permissionMode: 'default' });
const SCENARIO_MS = 360_000;
const BUDGET_MS = 450_000;

const OPTIONS = {
  dir: M106_DIR, milestone: 'M106',
  toolPolicy: 'every can_use_tool request is denied, as the app denies one under the reading mode; the sub-agents are told to use no tool',
};

const blocksOf = (frame) => (Array.isArray(frame?.message?.content) ? frame.message.content : []);
const foldersOf = (ctx) => ({ 'scratch project': ctx.project, 'configuration folder': ctx.config, 'outside every root': ctx.outside });
const msOf = (driver, index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;

/** The session's own text from `from` on, joined: tested for a word, never written down. */
const ownText = (driver, from) => framesOf(driver, 'assistant', from).filter((f) => f.frame.parent_tool_use_id == null).flatMap((f) => blocksOf(f.frame).filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''))).join('\n');
/** A worker's own text: the frames whose parent is its tool use. */
const workerText = (driver, from, toolUseId) => framesOf(driver, 'assistant', from).filter((f) => f.frame.parent_tool_use_id === toolUseId).flatMap((f) => blocksOf(f.frame).filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''))).join('\n');

/** Each `Agent` tool use of the session's own from `from` on: what its input asked, by the tool use's id. */
function agentUses(driver, from) {
  const uses = new Map();
  for (const { frame } of framesOf(driver, 'assistant', from)) {
    if (frame.parent_tool_use_id != null) continue;
    for (const block of blocksOf(frame)) {
      if (block?.type !== 'tool_use' || block.name !== 'Agent') continue;
      const input = block.input ?? {};
      uses.set(block.id, { inputKeys: Object.keys(input).sort(), modelAsked: typeof input.model === 'string' ? input.model : null, subagentType: input.subagent_type ?? null, runInBackground: input.run_in_background ?? null, markerInPrompt: Object.entries(MARKERS).filter(([, word]) => holds(String(input.prompt ?? ''), word)).map(([name]) => name) });
    }
  }
  return uses;
}

/** What the frames say of one sub-agent, by its task: what names its model, and what each frame kind carries. */
function workerFacts(driver, from, started, uses, initModel) {
  const task = started.frame;
  const toolUseId = typeof task.tool_use_id === 'string' ? task.tool_use_id : null;
  const own = framesOf(driver, 'assistant', from).filter((f) => f.frame.parent_tool_use_id === toolUseId);
  const models = [...new Set(own.map((f) => f.frame.message?.model ?? null))];
  const ofTask = (type) => received(driver, from).filter((f) => typeKey(f.frame) === type && f.frame.task_id === task.task_id);
  const progress = ofTask('system/task_progress');
  const updated = ofTask('system/task_updated');
  const notification = ofTask('system/task_notification');
  return {
    startedIndex: started.index, msAfterTheStart: null,
    asked: toolUseId === null ? null : uses.get(toolUseId) ?? 'no Agent tool use of the session’s own has this id',
    taskStarted: { keys: Object.keys(task).sort(), subagentType: task.subagent_type ?? null, taskType: task.task_type ?? null, isBackgrounded: task.is_backgrounded ?? null, spawnDepth: task.spawn_depth ?? null, descriptionUnits: typeof task.description === 'string' ? task.description.length : null, modelFields: modelFields(task) },
    assistantFrames: { count: own.length, models, differsFromTheSession: models.some((model) => model !== null && model !== initModel), topKeys: [...new Set(own.flatMap((f) => Object.keys(f.frame)))].sort(), subagentType: [...new Set(own.map((f) => f.frame.subagent_type ?? null))], taskDescriptionPresent: own.some((f) => typeof f.frame.task_description === 'string'), messageModelFields: [...new Set(own.flatMap((f) => modelFields(f.frame.message).map((entry) => entry.at)))] },
    taskProgress: { count: progress.length, keys: [...new Set(progress.flatMap((f) => Object.keys(f.frame)))].sort(), modelFields: [...new Set(progress.flatMap((f) => modelFields(f.frame).map((entry) => `${entry.at}=${entry.value}`)))] },
    taskUpdated: { count: updated.length, patchKeys: [...new Set(updated.flatMap((f) => Object.keys(f.frame.patch ?? {})))].sort(), statuses: updated.map((f) => f.frame.patch?.status ?? null), modelFields: [...new Set(updated.flatMap((f) => modelFields(f.frame).map((entry) => `${entry.at}=${entry.value}`)))] },
    taskNotification: notification.map((f) => ({ index: f.index, ms: Math.round(f.ms), keys: Object.keys(f.frame).sort(), status: f.frame.status ?? null, hasSummary: typeof f.frame.summary === 'string', usageKeys: f.frame.usage && typeof f.frame.usage === 'object' ? Object.keys(f.frame.usage).sort() : null, modelFields: modelFields(f.frame).map((entry) => `${entry.at}=${entry.value}`) })),
    markerInItsOwnText: Object.entries(MARKERS).filter(([, word]) => holds(workerText(driver, from, toolUseId), word)).map(([name]) => name),
  };
}

/** What every scenario notes of a run from `from` on. */
function common(driver, from, ctx, extra = {}) {
  const init = initOf(driver, from)?.frame ?? null;
  const initModel = init?.model ?? null;
  const uses = agentUses(driver, from);
  const started = framesOf(driver, 'system/task_started', from);
  const workers = started.map((frame) => workerFacts(driver, from, frame, uses, initModel));
  workers.forEach((worker) => { worker.msAfterTheStart = Math.round((msOf(driver, worker.startedIndex) ?? 0) - (msOf(driver, from) ?? 0)); });
  return {
    ...extra,
    sessionModel: { init: initModel, tools: Array.isArray(init?.tools) ? init.tools.filter((tool) => !String(tool).startsWith('mcp__')) : null, permissionMode: init?.permissionMode ?? null },
    agentToolUses: [...uses.values()],
    workers,
    backgroundTasksChanged: framesOf(driver, 'system/background_tasks_changed', from).map((f) => ({ index: f.index, keys: Object.keys(f.frame).sort(), tasks: Array.isArray(f.frame.tasks) ? f.frame.tasks.length : null, modelFields: modelFields(f.frame).map((entry) => `${entry.at}=${entry.value}`) })),
    requests: received(driver, from).filter((f) => typeKey(f.frame).startsWith('control_request/')).map((f) => ({ index: f.index, tool: f.frame.request?.tool_name ?? null, worker: Boolean(f.frame.request?.agent_id) })),
    results: framesOf(driver, 'result', from).map((f) => ({ index: f.index, ms: Math.round(f.ms), subtype: f.frame.subtype ?? null, isError: f.frame.is_error === true, numTurns: f.frame.num_turns ?? null })),
    failureWords: [...framesOf(driver, 'assistant', from).filter((f) => f.frame.error).map((f) => tidy(String(f.frame.error), foldersOf(ctx), 300)), ...framesOf(driver, 'result', from).filter((f) => f.frame.is_error === true && typeof f.frame.result === 'string').map((f) => tidy(f.frame.result, foldersOf(ctx), 300))],
    typeCounts: typeCounts(driver, typeKey, from), largestFrames: driver.largest(3),
    outline: outline(driver, from).filter((row) => row.recv !== 'stream_event'),
  };
}

const isResult = (f) => typeKey(f) === 'result';
const isNotification = (f) => typeKey(f) === 'system/task_notification';

const SCENARIOS = {
  foreground: {
    id: 'm106-foreground', name: 'm106-claude-foreground', turns: 1, files: FILES,
    title: `K1: one sub-agent in the foreground, asked for on "${ASKED.claudeForeground}" while the session runs its own model (C14, C20)`,
    successCondition: "A task_started, the worker's assistant frames naming a model other than the session's init model, and its task_notification before the turn's result",
    async run(ctx) {
      if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
      const driver = await ctx.open({ launch: LAUNCH });
      const from = await ctx.prompt(driver, PROMPTS.claudeForeground, { uuid: randomUUID() });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_500);
      const notes = common(driver, from, ctx, { sessionLaunchedAs: ctx.model, asked: ASKED.claudeForeground, endStatus: end.status, isError: end.isError ?? null, answerHoldsTheMarker: holds(ownText(driver, from), MARKERS.foreground) });
      if (notes.workers.length === 0) return didNotHappen('no task_started came: the session did the task itself, or did nothing', notes);
      return happened(notes, end.index);
    },
  },

  background: {
    id: 'm106-background', name: 'm106-claude-background', turns: 1, files: FILES,
    title: `K1: two sub-agents in the background, asked for on "${ASKED.claudeBackgroundOne}" and "${ASKED.claudeBackgroundTwo}", their ends and the turn the CLI starts by itself (C13, C14)`,
    successCondition: "Two task_started frames, each worker's assistant frames naming the model asked for it, two task_notification frames after the first result, and a result of the CLI's own turn",
    async run(ctx) {
      if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
      const driver = await ctx.open({ launch: LAUNCH });
      const from = await ctx.prompt(driver, PROMPTS.claudeBackground, { uuid: randomUUID() });
      const end = await ctx.turnEnd(driver, from);
      // The workers' ends, after the turn's: each a notification, up to three minutes; then the turn the CLI starts by itself.
      const firstEnd = await ctx.maybeFrame(driver, isNotification, end.index + 1, 180_000);
      const secondEnd = firstEnd === null ? null : await ctx.maybeFrame(driver, isNotification, firstEnd.index + 1, 180_000);
      const selfTurn = await ctx.maybeFrame(driver, isResult, end.index + 1, 120_000);
      await sleep(2_000);
      const notes = common(driver, from, ctx, {
        sessionLaunchedAs: ctx.model, asked: [ASKED.claudeBackgroundOne, ASKED.claudeBackgroundTwo], firstResult: { index: end.index, status: end.status, isError: end.isError ?? null },
        notificationsAfterTheResult: [firstEnd, secondEnd].filter(Boolean).map((hit) => ({ index: hit.index, msAfterTheResult: Math.round((msOf(driver, hit.index) ?? 0) - (msOf(driver, end.index) ?? 0)), status: hit.frame.status ?? null })),
        selfStartedTurn: selfTurn ? { resultIndex: selfTurn.index, msAfterTheFirstResult: Math.round((msOf(driver, selfTurn.index) ?? 0) - (msOf(driver, end.index) ?? 0)), inits: framesOf(driver, 'system/init', end.index + 1).length, answerHoldsTheMarkers: { one: holds(ownText(driver, end.index + 1), MARKERS.backgroundOne), two: holds(ownText(driver, end.index + 1), MARKERS.backgroundTwo) } } : null,
      });
      if (notes.workers.length === 0) return didNotHappen('no task_started came: the session did the task itself, or did nothing', notes);
      if (notes.workers.length < 2) return didNotHappen('one sub-agent came, not two', notes);
      return happened(notes, (selfTurn ?? secondEnd ?? firstEnd ?? end).index);
    },
  },
};

const PLANNED = ['foreground', 'background'];

if (isMain(import.meta.url)) {
  await runSpike('m106-k1', (frame) => {
    if (frame.args.list) {
      for (const key of PLANNED) log(`claude  ${key.padEnd(11)} ${String(SCENARIOS[key].turns).padStart(2)} prompt(s)  ${SCENARIOS[key].title}`);
      log(`total: ${PLANNED.reduce((sum, key) => sum + SCENARIOS[key].turns, 0)} prompts for one run of each, of the four K1 may spend (C37)`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m106/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns 1 [--again] [--path <executable>]`); return 1; }
    const waits = deadlines({ scenario: SCENARIO_MS });
    log(`K1: M16's launch as M20b leaves it, the tools ${TOOLS.join(', ')} under default; background tasks on; the scratch configuration folder; the scenario wait ${SCENARIO_MS / 1000} s`);
    return runScenario('m106-k1', chosen, { ...frame, waits }, OPTIONS);
  }, { budgetMs: BUDGET_MS });
}
