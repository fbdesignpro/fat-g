// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M106 spike K2 (docs/planning/_archive/M106-spec-sheet.md; C15, C37): Codex under production's handshake as M19
// leaves it, the message delta kept, in M22's scratch Codex configuration folder (`CODEX_HOME`):
// the maintainer's own Codex configuration is neither read nor changed — but for `--own-account`,
// at their word, for the one model only their account lists. Every thread is read-only with
// approvals `never`, as the app's Read only is, and the sub-agent is told to use no tool.
//
//   node spikes/m106/k2.mjs --list
//   node spikes/m106/k2.mjs --scenario spawn --confirm-turns 1 [--again] [--model gpt-5.6-luna] [--worker-model gpt-5.6-terra]
//   node spikes/m106/k2.mjs --scenario activity --confirm-turns 1 --own-account --model gpt-6-astra
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C37). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m106). Both scenarios ask one sub-agent for a reply of one word, on a model other
// than the session's where the tool allows it; `spawn` on a model that announces it by the
// `spawnAgent` collab tool (chat-protocols §12, K3), `activity` on one that announces it by
// `subAgentActivity` (turn-tracing §3). After the turn each reads the worker's thread by
// `thread/read` and lists the sub-agent threads by `thread/list`, which spend no prompt.
//
// What a run records of the sub-agent is what names its model: the collab call's and the
// activity's fields at their start and their completion, the worker thread's own frames, and what
// the two reads answer. Never a text of the model's: whether an answer holds the marker word.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkSessionStart } from '../m10/codex/driver.mjs';
import { EXIT, deadlines, settlesWithin, sleep } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { instanceEnvironment } from '../m14b/lib/instance-env.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, received } from '../m19/lib/common.mjs';
import { CODEX_HOME } from '../m22/k1.mjs';
import { tidy, typeCounts } from '../m22b/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { ASKED, M106_DIR, MARKERS, PROMPTS, holds, modelFields } from './lib/common.mjs';

const READ_ONLY = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never' });
const SCENARIO_MS = 360_000;
const BUDGET_MS = 450_000;
/** The effort a turn names: at low, gpt-5.6-luna started no sub-agent (chat-protocols §12, K3). */
const EFFORT = 'medium';

/** M19's driver: production's handshake less the opt-out of the message delta; every request declined by the runner's handler. */
class K2Driver extends M19CodexDriver {}

/** A one-shot command in the scratch configuration, through the launcher's confirmed teardown (M22's K1). Codex says its login status on stderr. */
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

/**
 * The runner's options. `ownAccount` (`--own-account`): the maintainer's own Codex configuration in
 * place of the scratch one — M10's clean environment with the default `CODEX_HOME`, and M15's
 * login check — at their word alone (C37), for the one model only their account lists. The
 * working folder is still the scratch one, and the thread read-only.
 */
const optionsFor = (ownAccount) => ({
  dir: M106_DIR, milestone: 'M106', Driver: K2Driver, omitted: OMITTED_CODEX, ...(ownAccount ? {} : { environment, ready }),
  toolPermissions: () => ({ readTools: 'reads inside the read-only sandbox', scenarioTools: [], preApproved: [], sandbox: READ_ONLY.sandbox, approvalPolicy: READ_ONLY.approvalPolicy, reviewer: null, policy: 'every request from the CLI is declined; the sub-agent is told to use no tool' }),
});

const foldersOf = (ctx) => ({ 'working folder': ctx.scratch, 'outside the folder': ctx.outside, 'configuration folder': CODEX_HOME, 'app-server folder': ctx.probe });
const errorOf = (reply, folders) => (reply.ok ? null : { code: reply.error?.code ?? null, message: tidy(String(reply.error?.message ?? ''), folders) });

/** Set from the arguments before a run: the session's model, and the model asked for the sub-agent. */
let MODEL = null;
let WORKER_MODEL = ASKED.codex;

/** The model a run names: `--model` where the account lists it, else the account's default, at medium effort. */
async function modelOf(driver) {
  const reply = await driver.request('model/list', { limit: 100 });
  const models = reply.ok && Array.isArray(reply.value?.data) ? reply.value.data : [];
  const listed = MODEL === null ? models.find((m) => m.isDefault) ?? models.find((m) => !m.hidden) ?? null : models.find((m) => m.model === MODEL) ?? null;
  if (!listed) return { model: null, effort: null, workerModelListed: null };
  const efforts = (listed.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  return { model: listed.model, effort: efforts.includes(EFFORT) ? EFFORT : efforts[0] ?? null, workerModelListed: models.some((m) => m.model === WORKER_MODEL) };
}

/** A saved read-only thread in the working folder, as the app asks for one; the reply checked as the app checks it. */
async function openThread(ctx, driver, model) {
  const params = { cwd: ctx.scratch, ...READ_ONLY, model: model.model };
  const reply = await driver.startThread(params);
  driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(READ_ONLY, reply.value) : null };
  return { ok: reply.ok, error: errorOf(reply, foldersOf(ctx)), matchesWhatWasAsked: reply.ok ? driver.sessionStart.check.passed : null, threadModel: reply.ok ? reply.value?.thread?.model ?? null : null };
}

const textInput = (text) => ({ type: 'text', text, text_elements: [] });

/** A turn as the app starts one (session.ts); counted once Codex took it. */
async function startTurn(driver, ctx, text, model) {
  const from = driver.nextIndex;
  const params = { threadId: driver.threadId, input: [textInput(text)], model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID() };
  const reply = await driver.requestWithin('turn/start', params, 15_000);
  if (reply.ok) { ctx.countTurn(); driver.turnId = reply.value?.turn?.id ?? null; driver.turnActive = true; }
  return { from, ok: reply.ok, turnId: driver.turnId, error: errorOf(reply, foldersOf(ctx)) };
}

/** The items of any thread from `from` on, at their start and their completion. */
const itemFrames = (driver, from) => received(driver, from).filter((f) => (f.frame?.method === 'item/started' || f.frame?.method === 'item/completed') && f.frame.params?.item).map((f) => ({ index: f.index, ms: f.ms, method: f.frame.method, threadId: f.frame.params.threadId ?? null, item: f.frame.params.item }));
const namedFields = (value) => modelFields(value).map((entry) => `${entry.at}=${entry.value}`);

/** What the session's thread said of the sub-agent: each collab call and each activity, with the fields that name a model. */
function announcements(driver, from) {
  const own = itemFrames(driver, from).filter(({ threadId }) => threadId === driver.threadId);
  return {
    collabCalls: own.filter(({ item }) => item.type === 'collabAgentToolCall').map(({ index, method, item }) => ({
      index, method, tool: item.tool ?? null, status: item.status ?? null, keys: Object.keys(item).sort(), model: item.model ?? null, reasoningEffort: item.reasoningEffort ?? null,
      receivers: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : null, promptHoldsTheMarker: Object.entries(MARKERS).filter(([, word]) => holds(String(item.prompt ?? ''), word)).map(([name]) => name),
      agentsStates: item.agentsStates && typeof item.agentsStates === 'object' ? Object.values(item.agentsStates).map((state) => ({ keys: state && typeof state === 'object' ? Object.keys(state).sort() : typeof state, status: state?.status ?? null, named: namedFields(state) })) : null,
    })),
    activities: own.filter(({ item }) => item.type === 'subAgentActivity').map(({ index, method, item }) => ({ index, method, kind: item.kind ?? null, keys: Object.keys(item).sort(), model: item.model ?? null, reasoningEffort: item.reasoningEffort ?? null, agentPathUnits: typeof item.agentPath === 'string' ? item.agentPath.length : null })),
  };
}

/** The ids of the threads that are not the session's, in the order seen, from the frames and from what the announcements name. */
function workerThreads(driver, from) {
  const ids = [];
  const note = (id) => { if (typeof id === 'string' && id !== driver.threadId && !ids.includes(id)) ids.push(id); };
  for (const f of received(driver, from)) note(f.frame?.params?.threadId);
  for (const { item } of itemFrames(driver, from)) { note(item.agentThreadId); for (const id of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) note(id); }
  return ids;
}

/** The frames of the worker's threads: their methods, a `thread/started` with the thread's fields, and every field that names a model. */
function workerFrames(driver, from, ids) {
  const frames = received(driver, from).filter((f) => ids.includes(f.frame?.params?.threadId) || ids.includes(f.frame?.params?.thread?.id));
  return {
    count: frames.length, methods: [...new Set(frames.map((f) => f.frame.method))],
    threadStarted: frames.filter((f) => f.frame.method === 'thread/started').map((f) => ({ index: f.index, threadKeys: Object.keys(f.frame.params?.thread ?? {}).sort(), named: namedFields(f.frame.params?.thread), parentIsTheSession: f.frame.params?.thread?.parentThreadId === driver.threadId, source: f.frame.params?.thread?.source ?? null, threadSource: f.frame.params?.thread?.threadSource ?? null })),
    turnStarted: frames.filter((f) => f.frame.method === 'turn/started').map((f) => ({ index: f.index, keys: Object.keys(f.frame.params ?? {}).sort(), turnKeys: Object.keys(f.frame.params?.turn ?? {}).sort(), named: namedFields(f.frame.params) })),
    namedAnywhere: [...new Set(frames.flatMap((f) => namedFields(f.frame).filter((entry) => !/tokenUsage/.test(entry)).map((entry) => `${f.frame.method}: ${entry}`)))],
    agentMessages: frames.filter((f) => f.frame.method === 'item/completed' && f.frame.params?.item?.type === 'agentMessage').map((f) => ({ index: f.index, phase: f.frame.params.item.phase ?? null, holdsTheMarker: Object.entries(MARKERS).filter(([, word]) => holds(String(f.frame.params.item.text ?? ''), word)).map(([name]) => name) })),
  };
}

/** The worker's thread read by `thread/read`, and the sub-agent threads listed by `thread/list`: what each says of the model. No prompt. */
async function readWorkers(ctx, driver, ids) {
  const folders = foldersOf(ctx);
  const reads = [];
  for (const id of ids) {
    const reply = await driver.requestWithin('thread/read', { threadId: id, includeTurns: false }, 30_000);
    const thread = reply.ok ? reply.value?.thread ?? null : null;
    reads.push(reply.ok ? { ok: true, keys: thread ? Object.keys(thread).sort() : null, model: thread?.model ?? null, reasoningEffort: thread?.reasoningEffort ?? null, agentNickname: thread?.agentNickname ?? null, agentRole: thread?.agentRole ?? null, parentIsTheSession: thread?.parentThreadId === driver.threadId, source: thread?.source ?? null, threadSource: thread?.threadSource ?? null, ephemeral: thread?.ephemeral ?? null, status: thread?.status ?? null } : { ok: false, error: errorOf(reply, folders) });
  }
  const list = await driver.requestWithin('thread/list', { limit: 20, cwd: ctx.scratch, sourceKinds: ['subAgentThreadSpawn', 'subAgent', 'subAgentOther'] }, 30_000);
  const data = list.ok && Array.isArray(list.value?.data) ? list.value.data : [];
  return {
    reads,
    list: list.ok ? { count: data.length, holdsTheWorker: data.some((thread) => ids.includes(thread?.id)), workers: data.filter((thread) => ids.includes(thread?.id)).map((thread) => ({ model: thread.model ?? null, agentNickname: thread.agentNickname ?? null, agentRole: thread.agentRole ?? null, parentIsTheSession: thread.parentThreadId === driver.threadId, source: thread.source ?? null })) } : { refused: errorOf(list, folders) },
  };
}

const outlineOf = (driver, from) => codex.outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA && row.method !== 'thread/tokenUsage/updated' && row.method !== 'mcpServer/startupStatus/updated');

/** One prompt that asks for a sub-agent, through to its turn's end, then the reads. */
async function subAgentTurn(ctx, prompt, marker) {
  const driver = await ctx.open();
  const model = await modelOf(driver);
  if (!model.model) return codex.notRun(MODEL ? `the account does not list ${MODEL}` : 'the CLI listed no model');
  const thread = await openThread(ctx, driver, model);
  const notes = { model, workerModelAsked: WORKER_MODEL, thread };
  if (!thread.ok) return codex.didNotHappen('thread/start was refused', notes);
  const started = await startTurn(driver, ctx, prompt(WORKER_MODEL), model);
  notes.turn = { ok: started.ok, error: started.error };
  if (!started.ok) return codex.didNotHappen('turn/start was refused', notes);
  const end = await ctx.turnEnd(driver, started.from);
  await sleep(2_000);
  const ids = workerThreads(driver, started.from);
  Object.assign(notes, {
    end: { index: end.index, status: end.status ?? null },
    announcements: announcements(driver, started.from),
    workerThreads: ids.length,
    workerFrames: workerFrames(driver, started.from, ids),
    reads: await readWorkers(ctx, driver, ids),
    answerHoldsTheMarker: received(driver, started.from).some((f) => f.frame?.method === 'item/completed' && f.frame.params?.threadId === driver.threadId && f.frame.params.item?.type === 'agentMessage' && holds(String(f.frame.params.item.text ?? ''), marker)),
    typeCounts: typeCounts(driver, (frame) => frame?.method ?? 'response', started.from),
    outline: outlineOf(driver, started.from),
  });
  if (ids.length === 0 && notes.announcements.collabCalls.length === 0 && notes.announcements.activities.length === 0) return codex.didNotHappen('no sub-agent was announced: the session did the task itself, or did nothing', notes);
  return codex.happened(notes, end.index);
}

const SCENARIOS = {
  spawn: {
    id: 'm106-spawn', name: 'm106-codex-spawn', turns: 1, files: FILES,
    title: `K2: one sub-agent on a model that announces it by the spawnAgent collab tool, asked for on ${ASKED.codex} (C15)`,
    successCondition: "The collab call's model field at its start and its completion, the worker thread's frames, and what thread/read and thread/list say of the worker's model",
    run: (ctx) => subAgentTurn(ctx, PROMPTS.codexSpawn, MARKERS.spawn),
  },

  activity: {
    id: 'm106-activity', name: 'm106-codex-activity', turns: 1, files: FILES,
    title: `K2: one sub-agent on a model that announces it by subAgentActivity, asked for on ${ASKED.codex} (C15)`,
    successCondition: "The activity's model field at its start and its completion, the worker thread's frames, and what thread/read and thread/list say of the worker's model",
    run: (ctx) => subAgentTurn(ctx, PROMPTS.codexActivity, MARKERS.activity),
  },
};

const PLANNED = ['spawn', 'activity'];

if (isMain(import.meta.url)) {
  await runSpike('m106-k2', (frame) => {
    if (frame.args.list) {
      for (const key of PLANNED) log(`codex   ${key.padEnd(9)} ${String(SCENARIOS[key].turns).padStart(2)} prompt(s)  ${SCENARIOS[key].title}`);
      log(`total: ${PLANNED.reduce((sum, key) => sum + SCENARIOS[key].turns, 0)} prompts for one run of each, of the four K2 may spend (C37); thread/read and thread/list cost none`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m106/k2.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns 1 [--again] [--model <id>] [--worker-model <id>] [--own-account] [--path <executable>]`); return 1; }
    MODEL = typeof frame.args.model === 'string' ? frame.args.model : null;
    if (typeof frame.args['worker-model'] === 'string') WORKER_MODEL = frame.args['worker-model'];
    const ownAccount = frame.args['own-account'] === true;
    const waits = deadlines({ scenario: SCENARIO_MS });
    log(`K2:${MODEL ? ` the session on ${MODEL}` : " the account's default model"} at ${EFFORT} effort, the sub-agent asked for on ${WORKER_MODEL}; production's handshake with the message delta kept (M19); ${ownAccount ? "the maintainer's own Codex configuration, at their word (C37)" : 'the scratch configuration folder (CODEX_HOME)'}; the scenario wait ${SCENARIO_MS / 1000} s`);
    return codex.runScenario('m106-k2', chosen, { ...frame, waits }, optionsFor(ownAccount));
  }, { budgetMs: BUDGET_MS });
}
