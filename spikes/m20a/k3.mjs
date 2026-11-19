// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M20a spike K3 (docs/planning/_archive/M20a-spec-sheet.md, round 3; found at V17): how Codex announces a
// sub-agent that a model starts through the `spawnAgent` collab tool, and how that sub-agent ends.
// Every capture so far, taken on gpt-6-astra, announces a sub-agent with a `subAgentActivity` item
// and holds no spawn-type `collabAgentToolCall` (turn-tracing §3). The maintainer's acceptance run
// on gpt-5.6-luna left a `collabAgentToolCall` whose tool is `spawnAgent` and no `subAgentActivity`,
// so fat-g knew of no worker. The installed Codex under the session handshake as M19 leaves it,
// read-only and `never`, in M15's scratch folder. One prompt per run, two runs at most.
//
//   node spikes/m20a/k3.mjs --list
//   node spikes/m20a/k3.mjs --scenario spawn|outlive [--model <key>] [--effort <level>] [--confirm-turns 1] [--again]
//
// Without --confirm-turns 1 it prints its plan and launches nothing (S6). The thread is saved as the
// app's are; `node spikes/m15/resume.mjs --cleanup` deletes it with M15's own.
//
// What a run records (never a text of the model's: the capture holds the frames): each collab tool
// call's two frames by tool, status, how many receivers it names and which, and its agents' states;
// whether any `subAgentActivity` came; the worker thread's own frames in the order they came; and
// what a history read of the turn holds.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sleep } from '../m10/lib/deadlines.mjs';
import { SPIKES_DIR, isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, received } from '../m19/lib/common.mjs';

export const M20A_DIR = path.join(SPIKES_DIR, 'output', 'm20a');
/**
 * The model and the effort of the acceptance run that showed the case, unless others are named. The
 * first run of `spawn`, at the model's lightest effort as the earlier traces ran, started no
 * sub-agent: the model answered that it could not spawn one. The acceptance run was at medium.
 */
const MODEL = 'gpt-5.6-luna';
const EFFORT = 'medium';

/**
 * The prompts. Each names a file no other capture's prompt names with these words, so that the
 * replay fake can choose its capture by its prompt (M15, C71).
 */
const PROMPTS = {
  spawn: {
    title: 'a sub-agent started and waited for',
    prompt: 'Spawn a sub-agent and give it this small task: read notes-2.txt and report its contents. Do not read the file yourself. When the sub-agent is done, tell me in one sentence what it found.',
    success: "A collab tool call that starts a sub-agent, the sub-agent's own turn ending, then the session's turn ending",
  },
  outlive: {
    title: 'a sub-agent the turn does not wait for',
    prompt: 'Spawn a sub-agent and give it this task: read notes-1.txt, notes-2.txt, notes-3.txt and notes-4.txt one at a time, in that order, and report what each one says. Do not read the files yourself, and do not wait for the sub-agent: as soon as it has started, answer me with the single word started.',
    success: "The session's turn ending while the sub-agent still runs, then the sub-agent's own turn ending",
  },
};

/** A model by its key, with the effort asked for where the CLI lists it for the model, else its lightest. */
async function modelNamed(driver, wanted, effort) {
  const reply = await driver.request('model/list', { limit: 100 });
  const models = reply.ok && Array.isArray(reply.value?.data) ? reply.value.data : [];
  const model = models.find((m) => m.model === wanted || m.id === wanted) ?? null;
  const efforts = (model?.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).filter((e) => typeof e === 'string');
  return { model: model?.model ?? null, effort: efforts.includes(effort) ? effort : efforts.includes('low') ? 'low' : efforts[0] ?? null, efforts, listed: models.map((m) => m.model).filter((m) => typeof m === 'string') };
}

/** Thread ids as roles, in the order they are first seen: never an id itself. */
function roles(driver) {
  const seen = new Map();
  return (id) => {
    if (typeof id !== 'string') return null;
    if (id === driver.threadId) return 'session';
    if (!seen.has(id)) seen.set(id, `worker-${seen.size + 1}`);
    return seen.get(id);
  };
}

/** Each collab tool call's frames, by what they name. */
function collabFacts(driver, entries) {
  const role = roles(driver);
  return entries.filter((f) => f.frame?.params?.item?.type === 'collabAgentToolCall').map((f) => {
    const item = f.frame.params.item;
    return {
      index: f.index, ms: f.ms, frame: f.frame.method, onThread: role(f.frame.params.threadId), id: typeof item.id === 'string' ? item.id.slice(0, 6) : null,
      tool: item.tool ?? null, status: item.status ?? null, keys: Object.keys(item).sort(),
      sender: role(item.senderThreadId), receivers: (item.receiverThreadIds ?? []).map(role),
      agentsStates: Object.fromEntries(Object.entries(item.agentsStates ?? {}).map(([id, state]) => [role(id) ?? 'other', { status: state?.status ?? null, message: typeof state?.message === 'string' ? state.message.length : null, keys: Object.keys(state ?? {}).sort() }])),
      promptUnits: typeof item.prompt === 'string' ? item.prompt.length : null, modelNamed: typeof item.model === 'string', effortNamed: item.reasoningEffort != null,
    };
  });
}

/** The worker threads' own frames, and whatever else says what became of a worker, in order. */
function workerFrames(driver, entries) {
  const role = roles(driver);
  return entries.filter((f) => typeof f.frame?.method === 'string' && f.frame.method !== CODEX_TEXT_DELTA).flatMap((f) => {
    const params = f.frame.params ?? {};
    const item = params.item ?? null;
    const thread = role(params.threadId ?? params.thread?.id);
    const mine = thread !== null && thread !== 'session';
    const about = item?.type === 'subAgentActivity' || item?.type === 'collabAgentToolCall' || /^thread\/(started|closed|archived)$/.test(f.frame.method);
    const end = f.frame.method === 'turn/completed' || f.frame.method === 'turn/started';
    if (!mine && !about && !end) return [];
    return [Object.fromEntries(Object.entries({
      index: f.index, ms: f.ms, method: f.frame.method, thread, item: item?.type ?? null, kind: item?.kind ?? null, tool: item?.tool ?? null, phase: item?.phase ?? null,
      status: params.turn?.status ?? params.status?.type ?? item?.status ?? null,
      parent: f.frame.method === 'thread/started' ? role(params.thread?.parentThreadId ?? params.thread?.forkedFromId) : null,
      threadKeys: f.frame.method === 'thread/started' ? Object.keys(params.thread ?? {}).sort().join(',') : null,
    }).filter(([, value]) => value !== null))];
  });
}

const workerTurnEnds = (driver, entries) => entries.filter((f) => f.frame?.method === 'turn/completed' && f.frame.params?.threadId && f.frame.params.threadId !== driver.threadId);

/** Waits up to `ms` for a worker's own turn to end. */
async function followWorker(driver, from, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (workerTurnEnds(driver, received(driver, from)).length > 0) return true;
    if (driver.tree?.rootExited) return false;
    await sleep(250);
  }
  return workerTurnEnds(driver, received(driver, from)).length > 0;
}

/** What a history read of the session's thread holds of the turn, by item type. */
async function historyOf(driver, threadId) {
  const reply = await driver.requestWithin('thread/turns/list', { threadId, limit: 1, itemsView: 'full' }, 30_000);
  if (!reply.ok) return { ok: false, error: { code: reply.error?.code ?? null } };
  const turn = (Array.isArray(reply.value?.data) ? reply.value.data : [])[0] ?? null;
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return { ok: true, itemTypes: items.map((item) => (item.type === 'agentMessage' ? `agentMessage:${item.phase ?? '?'}` : item.type === 'collabAgentToolCall' ? `collabAgentToolCall:${item.tool ?? '?'}:${item.status ?? '?'}` : item.type)) };
}

const CODEX_OPTIONS = { dir: M20A_DIR, milestone: 'M20a', Driver: M19CodexDriver, omitted: OMITTED_CODEX };

const scenario = (key, { title, prompt, success }, wanted, effort) => ({
  id: `m20a-collab-${key}`, name: `m20a-collab-${key}`, turns: 1, tools: ['sub-agent'],
  title: `K3: ${title}, on ${wanted} at ${effort}`, successCondition: success,
  async run(ctx) {
    const driver = await ctx.open();
    const model = await modelNamed(driver, wanted, effort);
    if (!model.model) return codex.notRun(`the CLI lists no model ${wanted}`, { listed: model.listed });
    const started = await ctx.startThread(driver, { model: model.model });
    if (!started.ok) return codex.didNotHappen('thread/start was refused');
    if (!driver.sessionStart.check.passed) return codex.notRun('the session-start reply differed from the request (M15, C21)', { rows: driver.sessionStart.check.rows });
    const from = driver.nextIndex;
    // The turn as the app starts it (session.ts): the model, the effort, an id of fat-g's own.
    await ctx.prompt(driver, prompt, { model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID() });
    const end = await ctx.turnEnd(driver, from);
    // The worker's own turn, should it still run; then whatever closes it, for a few seconds more.
    const spawned = () => received(driver, from).some((f) => f.frame?.params?.item?.type === 'collabAgentToolCall' && f.frame.params.item.tool === 'spawnAgent') || received(driver, from).some((f) => f.frame?.params?.item?.type === 'subAgentActivity');
    const workerEnded = spawned() ? await followWorker(driver, from, 90_000) : false;
    await sleep(4_000);
    const entries = received(driver, from);
    const collab = collabFacts(driver, entries);
    const subAgentActivity = entries.filter((f) => f.frame?.params?.item?.type === 'subAgentActivity').map((f) => ({ index: f.index, frame: f.frame.method, kind: f.frame.params.item.kind ?? null }));
    const history = await historyOf(driver, driver.threadId);
    const sessionEnd = entries.find((f) => f.frame?.method === 'turn/completed' && f.frame.params?.threadId === driver.threadId)?.index ?? null;
    const notes = {
      model: { model: model.model, effort: model.effort, effortsListed: model.efforts }, endStatus: end.status, prompt: key,
      spawnCalls: collab.filter((c) => c.tool === 'spawnAgent' && c.frame === 'item/completed').length,
      subAgentActivity, collab,
      workerTurnEnded: workerEnded, workerTurnEndIndexes: workerTurnEnds(driver, entries).map((f) => f.index), sessionTurnEndIndex: sessionEnd,
      methodsFromWorkers: [...new Set(entries.filter((f) => f.frame?.params?.threadId && f.frame.params.threadId !== driver.threadId).map((f) => f.frame.method))].sort(),
      workerFrames: workerFrames(driver, entries),
      history,
    };
    if (notes.spawnCalls === 0 && subAgentActivity.length === 0) return codex.didNotHappen('the model started no sub-agent', notes);
    if (notes.spawnCalls === 0) return codex.didNotHappen('the sub-agent was announced by subAgentActivity, as in the earlier captures, and by no spawn call', notes);
    if (key === 'outlive' && !(workerEnded && sessionEnd !== null && notes.workerTurnEndIndexes.some((index) => index > sessionEnd))) return codex.didNotHappen('the sub-agent did not outlive its turn', notes);
    return codex.happened(notes, end.index);
  },
});

if (isMain(import.meta.url)) {
  await runSpike('m20a-k3', (frame) => {
    const wanted = typeof frame.args.model === 'string' ? frame.args.model : MODEL;
    const effort = typeof frame.args.effort === 'string' ? frame.args.effort : EFFORT;
    const scenarios = Object.fromEntries(Object.entries(PROMPTS).map(([key, entry]) => [key, scenario(key, entry, wanted, effort)]));
    if (frame.args.list) {
      for (const [key, entry] of Object.entries(scenarios)) log(`codex   ${key.padEnd(10)} ${entry.turns} turn  ${entry.title}`);
      log(`total: ${Object.keys(scenarios).length} turns for one run of each, announced to the maintainer as two at most`);
      return 0;
    }
    const chosen = scenarios[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m20a/k3.mjs --list | --scenario ${Object.keys(PROMPTS).join('|')} [--model <key>] [--effort <level>] [--confirm-turns 1] [--again] [--path <executable>]`); return 1; }
    log(`K3: production's handshake less the opt-out of ${CODEX_TEXT_DELTA}; no experimental API; the thread saved as the app's are`);
    return codex.runScenario('m20a-k3', chosen, frame, CODEX_OPTIONS);
  });
}
