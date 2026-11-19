// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M26 spike K2 (docs/planning/_archive/M26.md, Spike): the secretary's one-shot title request on Codex, in
// M22's scratch configuration folder (`CODEX_HOME` in the user's profile folder, signed in by the
// maintainer). One app-server, an ephemeral read-only thread with the title task's instruction as
// its developer instructions, one turn. Two prompts in all, one per scenario.
//
//   node spikes/m26/k2.mjs --list
//   node spikes/m26/k2.mjs --scenario session-model|small-model|base-instructions --confirm-turns 1 [--again]
//
// `base-instructions` (added, at the maintainer's word) sends the instruction as
// `baseInstructions`, which takes the place of Codex's own, in place of `developerInstructions`.
//
// Without --confirm-turns 1 it prints its plan and launches nothing. One invocation is one run; at
// most three runs per scenario (M10's ledger, under spikes/output/m26). `session-model` names the
// model the CLI lists as its default; `small-model` the one its description calls fast and
// affordable; each at the lowest effort it lists.
//
// Two requests here are the spike's alone and never production's: `model/list`, to choose the
// model, and `thread/list` after the turn, to see whether the ephemeral thread was saved.
//
// What a run records is never a text of the model's: the start reply's policy and `ephemeral`, the
// reply's shape, the items the turn made, the tokens used, which MCP servers started and how, and
// whether the thread is listed afterwards.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { checkSessionStart } from '../m10/codex/driver.mjs';
import { EXIT, settlesWithin } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { instanceEnvironment } from '../m14b/lib/instance-env.mjs';
import * as codex from '../m15/lib/common.mjs';
import { FIRST_PROMPT, INSTRUCTIONS, M26_DIR, input, replyFacts } from './lib/common.mjs';

/** M22's scratch Codex configuration folder (spikes/m22/k1.mjs, CODEX_HOME). */
const CODEX_HOME = path.join(homedir(), '.fat-g-spike-m22', 'codex-home');

/** Lightest first: the order the secretary takes an effort in where a model lists several. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

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
  dir: M26_DIR, milestone: 'M26', omitted: ['every delta kind (the handshake opts out of them all; counted only)', 'usage readings'], environment, ready,
  toolPermissions: () => ({ readTools: 'reads inside the read-only sandbox', scenarioTools: [], preApproved: [], sandbox: 'read-only', approvalPolicy: 'never', reviewer: null, policy: 'every request from the CLI is declined; the thread is ephemeral and told to act on nothing' }),
};

const lowest = (efforts) => EFFORT_ORDER.find((effort) => efforts.includes(effort)) ?? efforts[0] ?? null;
const frames = (driver, from) => driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);

/**
 * The overrides Codex's own IDE extension (openai.chatgpt 26.1007.21434) sends its title threads,
 * every one of which switches something off: sub-agents, hooks, plugins, the shell snapshot, tool
 * suggestions, apps and their connectors, and web search. Its override that defines a server of the
 * desktop app's own is left out: fat-g has none.
 */
const CONFIG_OFF = Object.freeze({
  'features.enable_fanout': false, 'features.hooks': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.plugins': false, 'features.shell_snapshot': false, 'features.tool_suggest': false, 'features.apps': false,
  apps: { _default: { enabled: false, destructive_enabled: false, open_world_enabled: false } },
  web_search: 'disabled',
});

const scenario = (key, { choose, title, instructions = 'developerInstructions', config = null }) => ({
  id: `m26-codex-${key}`, name: `m26-codex-${key}`, turns: 1,
  title, successCondition: 'the ephemeral start checked read-only, one turn ended, its message the title',
  async run(ctx) {
    const driver = await ctx.open('main');
    const listed = await driver.request('model/list', { limit: 100, includeHidden: true });
    const models = listed.ok && Array.isArray(listed.value?.data) ? listed.value.data : [];
    const model = choose(models);
    if (!model) return codex.notRun('no model of that kind is listed', { listed: models.length });
    const effort = lowest((model.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort));
    const params = { cwd: ctx.probe, ...codex.SANDBOX, ephemeral: true, [instructions]: INSTRUCTIONS, model: model.model, ...(config === null ? {} : { config }) };
    const started = await driver.startThread(params);
    const check = started.ok ? checkSessionStart(codex.SANDBOX, started.value) : null;
    driver.sessionStart = { request: params, replyIndex: started.index, ok: started.ok, check };
    const base = { model: { listedDefault: model.isDefault === true, hidden: model.hidden === true, efforts: (model.supportedReasoningEfforts ?? []).length, effort }, start: { ok: started.ok, ephemeral: started.value?.thread?.ephemeral ?? null, check } };
    if (!started.ok) return codex.didNotHappen('thread/start was refused', { ...base, error: started.error?.code ?? null });
    const threadId = driver.threadId;
    const from = driver.nextIndex;
    const turn = await ctx.prompt(driver, input(FIRST_PROMPT), { model: model.model, ...(effort ? { effort } : {}) });
    if (!turn.ok) return codex.didNotHappen('turn/start was refused', { ...base, error: turn.error?.code ?? null });
    const end = await ctx.turnEnd(driver, from);
    const after = frames(driver, from);
    const completed = after.filter((f) => f.frame.method === 'item/completed').map((f) => f.frame.params?.item ?? {});
    const messages = completed.filter((item) => item.type === 'agentMessage');
    const usage = after.filter((f) => f.frame.method === 'thread/tokenUsage/updated').at(-1)?.frame.params?.tokenUsage ?? null;
    const mcp = after.concat(frames(driver, 0).filter((f) => f.index < from)).filter((f) => f.frame.method === 'mcpServer/startupStatus/updated').map((f) => f.frame.params?.status ?? null);
    const threads = await driver.request('thread/list', { limit: 50 });
    const rows = threads.ok && Array.isArray(threads.value?.data) ? threads.value.data : null;
    const notes = {
      ...base,
      reply: replyFacts(messages.at(-1)?.text), messages: messages.length,
      items: completed.reduce((counts, item) => ({ ...counts, [item.type ?? 'unknown']: (counts[item.type ?? 'unknown'] ?? 0) + 1 }), {}),
      turnStatus: after.find((f) => f.frame.method === 'turn/completed')?.frame.params?.turn?.status ?? null,
      requests: driver.requestsSeen?.length ?? 0,
      tokens: usage ? { last: usage.last ?? null, total: usage.total ?? null } : null,
      mcpServerStatuses: mcp,
      threadList: rows === null ? { ok: false } : { ok: true, rows: rows.length, holdsThisThread: rows.some((row) => row.id === threadId) },
      outline: codex.outline(driver, from),
    };
    return codex.happened(notes, end.index);
  },
});

const SCENARIOS = {
  'session-model': scenario('session-model', { choose: (models) => models.find((m) => m.isDefault) ?? models.find((m) => !m.hidden) ?? null, title: 'K2: the title request under the default model at its lowest effort' }),
  'small-model': scenario('small-model', { choose: (models) => models.find((m) => !m.hidden && /affordable|mini|small/i.test(`${m.description ?? ''} ${m.model ?? ''}`)) ?? null, title: 'K2: the title request under the model described as fast and affordable, at its lowest effort' }),
  // Added at the maintainer's word: the instruction in place of Codex's own base instructions, to see what that saves.
  // Added at the maintainer's word: the base instructions and the extension's overrides, to see what they save beside them.
  'config-off': scenario('config-off', { choose: (models) => models.find((m) => !m.hidden && /affordable|mini|small/i.test(`${m.description ?? ''} ${m.model ?? ''}`)) ?? null, title: 'K2: the title request with `baseInstructions` and the overrides Codex’s own extension sends its titles', instructions: 'baseInstructions', config: CONFIG_OFF }),
  'base-instructions': scenario('base-instructions', { choose: (models) => models.find((m) => !m.hidden && /affordable|mini|small/i.test(`${m.description ?? ''} ${m.model ?? ''}`)) ?? null, title: 'K2: the title request with the instruction as `baseInstructions`, in place of Codex’s own', instructions: 'baseInstructions' }),
};

if (isMain(import.meta.url)) {
  await runSpike('m26-k2', (frame) => {
    if (frame.args.list) {
      for (const [key, entry] of Object.entries(SCENARIOS)) log(`${key.padEnd(14)}  1 prompt  ${entry.title}`);
      log(`total: ${Object.keys(SCENARIOS).length} prompts for one run of each`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m26/k2.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns 1 [--again] [--path <executable>]`); return 1; }
    log('K2: codex app-server; thread/start ephemeral, read-only, never, developer instructions; one turn');
    return codex.runScenario('m26-k2', chosen, frame, OPTIONS);
  });
}
