// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M22e spike K1 (docs/planning/_archive/M22e-spec-sheet.md; C2–C5, C10, C19): one review prompt per provider
// under its reading mode, on a scratch project of a few files, with a draft of C3's instruction, a
// plan in M22b's block and C4's schema in the prompt; then, in the same session, a second prompt
// of the same kind on the plan's version 2. Recorded for each answer: whether its final message
// closes with one fenced `json` block that checks (C5), the block's size and its findings' shape,
// the turn's time, and the units around the block.
//
//   node spikes/m22e/k1.mjs --list
//   node spikes/m22e/k1.mjs --scenario claude|codex --confirm-turns 2 [--again] [--model <id>] [--effort <level>]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C19). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m22e). `claude` runs under M16's runner with M19's driver and the app's launch with
// the reading mode's tools under `default`, in M16's scratch configuration folder; `codex` under
// M15's runner with M19's driver, a read-only thread with approvals `never`, in M22's scratch Codex
// configuration. The maintainer's own configurations are neither read nor changed.
//
// A review reads several files and thinks before it answers, so the scenario wait is raised to
// eight minutes from the first prompt and the invocation's budget to nine and a half; run it in
// the background, outside an agent shell's ten-minute limit. Every request either CLI makes is
// refused, as the app refuses one under the reading mode; a read inside the scratch project asks
// nothing.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { typeKey } from '../m10/claude/frames.mjs';
import { checkSessionStart } from '../m10/codex/driver.mjs';
import { EXIT, deadlines, settlesWithin, sleep } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { instanceEnvironment } from '../m14b/lib/instance-env.mjs';
import * as codex from '../m15/lib/common.mjs';
import { TOOLS, didNotHappen, framesOf, happened, notRun, outline, runScenario as runClaudeScenario } from '../m16/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19ClaudeDriver, M19CodexDriver, OMITTED_CLAUDE, OMITTED_CODEX, received } from '../m19/lib/common.mjs';
import { CODEX_HOME } from '../m22/k1.mjs';
import { tidy, typeCounts } from '../m22b/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { M22E_DIR, PLAN_V1, PLAN_V2, newPlanId, readAnswer, reviewPrompt } from './lib/common.mjs';

/** A review's wait, from the first prompt to the second answer, and the invocation's budget around it. */
const SCENARIO_MS = 480_000;
const BUDGET_MS = 570_000;
export const DEFAULT_EFFORT = 'medium';

// ── Claude ───────────────────────────────────────────────────────────────────────────────────────

/** The app's reading-mode tool list (src/main/providers/claude/chat-modes.ts): the four that read and the question tool, under `default`. */
export const READING = Object.freeze([...TOOLS, 'AskUserQuestion']);
const blocksOf = (frame) => (Array.isArray(frame?.message?.content) ? frame.message.content : []);
export const msAt = (driver, index) => driver.session.frames.find((f) => f.index === index)?.ms ?? null;

/** The session's own assistant frames from `from` to `to`: its last message's text, by message id, beside the result's. */
function claudeFinal(driver, from, to) {
  const own = framesOf(driver, 'assistant', from).filter((f) => f.index <= to && f.frame.parent_tool_use_id == null);
  const withText = own.filter((f) => blocksOf(f.frame).some((b) => b?.type === 'text'));
  const lastId = withText.at(-1)?.frame.message?.id ?? null;
  const lastText = withText.filter((f) => f.frame.message?.id === lastId).flatMap((f) => blocksOf(f.frame).filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''))).join('');
  const tools = {};
  for (const f of own) for (const b of blocksOf(f.frame)) if (b?.type === 'tool_use') tools[b.name] = (tools[b.name] ?? 0) + 1;
  return { lastText: withText.length ? lastText : null, textMessages: new Set(withText.map((f) => f.frame.message?.id)).size, tools };
}

/** One prompt through to its end: the answer's text, in memory only, and its facts, with what C5 makes of it under `version`. */
export async function claudeTurn(ctx, driver, prompt, { version } = {}) {
  const from = await ctx.prompt(driver, prompt);
  const end = await ctx.turnEnd(driver, from);
  const result = driver.session.frames.find((f) => f.index === end.index)?.frame ?? null;
  const final = claudeFinal(driver, from, end.index);
  const answer = typeof result?.result === 'string' ? result.result : final.lastText;
  return {
    text: answer,
    facts: {
      endIndex: end.index, promptUnits: prompt.length,
      ms: Math.round((msAt(driver, end.index) ?? 0) - (msAt(driver, from) ?? 0)),
      end: { status: end.status, isError: end.isError ?? null, terminal: end.terminalReason ?? null, numTurns: result?.num_turns ?? null, durationMs: result?.duration_ms ?? null, outputTokens: result?.usage?.output_tokens ?? null },
      tools: final.tools, textMessages: final.textMessages, requests: received(driver, from).filter((f) => f.index <= end.index && typeKey(f.frame).startsWith('control_request/')).map((f) => typeKey(f.frame)),
      resultMatchesLastMessage: final.lastText === null || typeof result?.result !== 'string' ? null : final.lastText.trim() === result.result.trim(),
      answer: readAnswer(answer, { version }),
    },
  };
}

/** One review prompt through to its end, and what C5 makes of its answer. */
async function claudeReview(ctx, driver, version, text, planId) {
  return (await claudeTurn(ctx, driver, reviewPrompt({ planId, version, text, folder: ctx.project }))).facts;
}

export const CLAUDE_OPTIONS = {
  dir: M22E_DIR, milestone: 'M22e', Driver: M19ClaudeDriver, omitted: OMITTED_CLAUDE,
  toolPolicy: 'every can_use_tool request is denied, as the app denies one under the reading mode; a read inside the scratch project asks nothing',
};

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────

export const READ_ONLY = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never' });

/** A one-shot command in the scratch configuration, through the launcher's confirmed teardown (M22's K1). */
async function once(launcher, executable, args, { cwd, waits, env }) {
  const tree = await launcher.launch({ executable, args, cwd, env });
  let stdout = '';
  if (tree.child) { tree.stdout.setEncoding('utf8'); tree.stdout.on('data', (chunk) => { if (stdout.length < 100_000) stdout += chunk; }); tree.stdin.end(); }
  await settlesWithin(tree.closed, waits.request);
  const code = tree.exitInfo?.code ?? null;
  await tree.teardown();
  // Codex says its login status on stderr.
  return { code, stdout, stderr: tree.stderrTail ?? '' };
}

function codexEnvironment() {
  const { env } = instanceEnvironment('codex', CODEX_HOME);
  return { env, removed: cleanEnvironment('codex').removed, set: ['CODEX_HOME'] };
}

/** The CLI's version, and that the scratch configuration folder is signed in. No login is ever started. */
async function codexReady(launcher, waits, executable, cwd) {
  const fail = (message) => Object.assign(new Error(message), { exitCode: EXIT.cliMissing });
  if (!existsSync(CODEX_HOME) || !existsSync(path.join(path.dirname(CODEX_HOME), '.fat-g-spike'))) throw fail(`the scratch Codex configuration folder, or the spikes' marker beside it, is not at ${CODEX_HOME} (spikes/README.md, M22).`);
  const { env } = codexEnvironment();
  const version = parseVersion((await once(launcher, executable, ['--version'], { cwd, waits, env })).stdout);
  const status = await once(launcher, executable, ['login', 'status'], { cwd, waits, env });
  if (!version || !codexLoggedIn(status)) throw fail(`codex is ${version ? 'not logged in in the scratch configuration folder' : 'not answering --version'}. Sign in from your own terminal, with CODEX_HOME naming that folder (agents never log in).`);
  return { name: 'codex', version, kind: executable.kind };
}

export const CODEX_OPTIONS = {
  dir: M22E_DIR, milestone: 'M22e', Driver: M19CodexDriver, omitted: OMITTED_CODEX, environment: codexEnvironment, ready: codexReady,
  toolPermissions: () => ({ readTools: 'reads inside the read-only sandbox', scenarioTools: [], preApproved: [], sandbox: READ_ONLY.sandbox, approvalPolicy: READ_ONLY.approvalPolicy, reviewer: null, policy: 'every request from the CLI is declined' }),
};

export const codexFolders = (ctx) => ({ 'working folder': ctx.scratch, 'configuration folder': CODEX_HOME, 'app-server folder': ctx.probe });
export const errorOf = (reply, folders) => (reply.ok ? null : { code: reply.error?.code ?? null, message: tidy(String(reply.error?.message ?? ''), folders) });

/** The model and effort a run names: `--model` and `--effort` where the account lists them, else its default model at the default effort. */
export async function codexModel(driver, wanted, effort) {
  const reply = await driver.request('model/list', { limit: 100 });
  const models = reply.ok && Array.isArray(reply.value?.data) ? reply.value.data : [];
  const listed = wanted ? models.find((m) => m.model === wanted) : models.find((m) => m.isDefault) ?? models.find((m) => !m.hidden);
  if (!listed) return { model: null, effort: null };
  const efforts = (listed.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  return { model: listed.model, effort: efforts.includes(effort) ? effort : efforts[0] ?? null, offered: efforts };
}

const completedItems = (driver, from, to) => received(driver, from).filter((f) => f.index <= to && f.frame?.method === 'item/completed' && f.frame.params?.threadId === driver.threadId).map((f) => f.frame.params.item ?? {});

/** One review prompt as the app starts a turn (session.ts), through to its end, and what C5 makes of its answer. */
async function codexReview(ctx, driver, model, version, text, planId) {
  const turn = await codexTurn(ctx, driver, model, reviewPrompt({ planId, version, text, folder: ctx.scratch }));
  return turn.refused ? turn : turn.facts;
}

/** One prompt as the app starts a turn (session.ts), through to its end: the answer's text, in memory only, and its facts. */
export async function codexTurn(ctx, driver, model, prompt, { version } = {}) {
  const from = driver.nextIndex;
  const params = { threadId: driver.threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID() };
  const reply = await driver.requestWithin('turn/start', params, 15_000);
  if (!reply.ok) return { refused: true, error: errorOf(reply, codexFolders(ctx)) };
  ctx.countTurn();
  driver.turnId = reply.value?.turn?.id ?? null;
  driver.turnActive = true;
  const end = await ctx.turnEnd(driver, from);
  await sleep(1_000);
  const items = completedItems(driver, from, end.index);
  const messages = items.filter((item) => item.type === 'agentMessage');
  const other = {};
  for (const item of items) if (!['agentMessage', 'userMessage', 'reasoning'].includes(item.type)) other[item.type] = (other[item.type] ?? 0) + 1;
  const ended = driver.session.frames.find((f) => f.index === end.index)?.frame ?? null;
  const text = messages.length ? String(messages.at(-1).text ?? '') : null;
  return {
    refused: false,
    text,
    facts: {
      refused: false, endIndex: end.index, promptUnits: prompt.length,
      ms: Math.round((msAt(driver, end.index) ?? 0) - (msAt(driver, from) ?? 0)),
      end: { status: end.status ?? null, error: ended?.params?.turn?.error ? tidy(String(ended.params.turn.error.message ?? ''), codexFolders(ctx), 300) : null },
      agentMessages: messages.map((item) => ({ phase: item.phase ?? null, units: String(item.text ?? '').length })),
      otherItems: other, reasoningItems: items.filter((item) => item.type === 'reasoning').length,
      requests: received(driver, from).filter((f) => f.index <= end.index && f.frame?.id !== undefined && typeof f.frame?.method === 'string').map((f) => f.frame.method),
      errors: received(driver, from).filter((f) => f.index <= end.index && f.frame?.method === 'error').map((f) => tidy(String(f.frame.params?.error?.message ?? ''), codexFolders(ctx), 300)),
      answer: readAnswer(text, { version }),
    },
  };
}

export const codexOutline = (driver, from) => codex.outline(driver, from).filter((row) => ![CODEX_TEXT_DELTA, 'thread/tokenUsage/updated', 'mcpServer/startupStatus/updated', 'item/reasoning/summaryTextDelta'].includes(row.method));

// ── The two scenarios ────────────────────────────────────────────────────────────────────────────

/** Set from the arguments before a run. */
let WANTED = { model: null, effort: DEFAULT_EFFORT };

const SCENARIOS = {
  claude: {
    id: 'm22e-review', name: 'm22e-claude-review', turns: 2, files: FILES,
    title: "K1: a review prompt under the reading mode with C4's schema, then a second on version 2 in the same session (C2–C5)",
    successCondition: 'Both turns end with an answer; each answer read by C5: one fenced json block that checks, its size, the turn\'s time and the units around it',
    async run(ctx) {
      const model = WANTED.model ?? ctx.model;
      if (!model) return notRun("no model chosen: run M16's --scenario discover first, or name one with --model");
      const driver = await ctx.open({ launch: { extra: ['--include-partial-messages'], tools: READING, permissionMode: 'default', model, effort: WANTED.effort }, background: false });
      const planId = newPlanId();
      const notes = { model, effort: WANTED.effort, tools: READING };
      notes.first = await claudeReview(ctx, driver, 1, PLAN_V1, planId);
      notes.second = await claudeReview(ctx, driver, 2, PLAN_V2, planId);
      notes.typeCounts = typeCounts(driver, typeKey);
      notes.outline = outline(driver, 0).filter((row) => row.recv !== 'stream_event');
      if (notes.first.end.isError && notes.second.end.isError) return didNotHappen('both turns ended in error', notes);
      return happened(notes, notes.second.endIndex);
    },
  },

  codex: {
    id: 'm22e-review', name: 'm22e-codex-review', turns: 2, files: FILES,
    title: "K1: a review prompt in a read-only thread with C4's schema, then a second on version 2 in the same thread (C2–C5)",
    successCondition: 'Both turns end with an answer; each answer read by C5: one fenced json block that checks, its size, the turn\'s time and the units around it',
    async run(ctx) {
      const driver = await ctx.open();
      const model = await codexModel(driver, WANTED.model, WANTED.effort);
      if (!model.model) return codex.notRun(WANTED.model ? `the scratch account does not list ${WANTED.model}` : 'the CLI listed no model');
      const params = { cwd: ctx.scratch, ...READ_ONLY, model: model.model };
      const thread = await driver.startThread(params);
      driver.sessionStart = { request: params, replyIndex: thread.index, ok: thread.ok, check: thread.ok ? checkSessionStart(READ_ONLY, thread.value) : null };
      const notes = { model, thread: { ok: thread.ok, error: errorOf(thread, codexFolders(ctx)), matchesWhatWasAsked: thread.ok ? driver.sessionStart.check.passed : null } };
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', notes);
      const planId = newPlanId();
      notes.first = await codexReview(ctx, driver, model, 1, PLAN_V1, planId);
      if (notes.first.refused) return codex.didNotHappen('the first turn/start was refused', notes);
      notes.second = await codexReview(ctx, driver, model, 2, PLAN_V2, planId);
      notes.typeCounts = typeCounts(driver, (frame) => frame?.method ?? 'response');
      notes.outline = codexOutline(driver, 0);
      return codex.happened(notes, notes.second.refused ? notes.first.endIndex : notes.second.endIndex);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m22e-k1', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(7)} ${scenario.turns} prompt(s)  ${scenario.title}`);
      log('total: 4 prompts for one run of each, of the four K1 may spend with a reserve of four for retries (C19)');
      return 0;
    }
    const key = String(frame.args.scenario ?? '');
    const chosen = SCENARIOS[key];
    if (!chosen) { warn('usage: node spikes/m22e/k1.mjs --list | --scenario claude|codex --confirm-turns 2 [--again] [--model <id>] [--effort <level>] [--path <executable>]'); return 1; }
    WANTED = { model: typeof frame.args.model === 'string' ? frame.args.model : null, effort: typeof frame.args.effort === 'string' ? frame.args.effort : DEFAULT_EFFORT };
    const waits = deadlines({ scenario: SCENARIO_MS });
    log(`K1 on ${key}: ${WANTED.model ? `the model ${WANTED.model}` : 'the saved or default model'} at ${WANTED.effort} effort; the scenario wait ${SCENARIO_MS / 1000} s; ${key === 'claude' ? "the reading mode's tools under default, the scratch configuration folder" : 'a read-only thread, approvals never, the scratch Codex configuration (CODEX_HOME)'}`);
    return key === 'claude' ? runClaudeScenario('m22e-k1', chosen, { ...frame, waits }, CLAUDE_OPTIONS) : codex.runScenario('m22e-k1', chosen, { ...frame, waits }, CODEX_OPTIONS);
  }, { budgetMs: BUDGET_MS });
}
