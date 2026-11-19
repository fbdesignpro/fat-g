// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M22b spike K1 (docs/planning/_archive/M22b-spec-sheet.md; C5, C7–C11): Claude's plan mode under the app's launch —
// M16's as M20b leaves it, with `--include-partial-messages` and background tasks off — with each
// mode's tool list plus `ExitPlanMode` (C8), in M16's scratch configuration folder. Each scenario
// launches under one of fat-g's five modes, sets the permission mode to `plan` by
// `set_permission_mode` (C7), sends one prompt asking for a plan of a small change, answers each
// `ExitPlanMode` request as the scenario says — feedback (`deny` with a message), Execute (a plain
// `allow`), Cancel (`deny` with `interrupt`), or held and then a Stop — and sets the mode back.
//
//   node spikes/m22b/k1.mjs --list
//   node spikes/m22b/k1.mjs --scenario <name> --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C46). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m22b). `plans-dir` is the reserve, run only where no request carries the plan's text
// (C9): it names a `plansDirectory` under a scratch folder with `--settings`.
//
// The spike allows only the plan's own: `ExitPlanMode` as the scenario says, a `Write` of the plan
// file inside the scratch configuration folder's `plans` (or the reserve's scratch folder), and a
// `Write` or an `Edit` of a file in the scratch project — the change the plan names, once Execute
// was given. Any other request is denied. No flag that bypasses permissions is passed: Berserk is
// launched by `--permission-mode bypassPermissions` alone, as M22's K5 did.
//
// What a run records is never a text of the model's: each request's shape, where the plan's text
// came (its length and lines, never its words), the reply the spike sent, the CLI's own words for a
// refusal, the tool's result's shape, the modes the frames report, the result's terminal reason, and
// which files the plan folder and the scratch project hold afterwards. A plan file the CLI wrote in
// the scratch configuration folder is removed after the run, unread.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { TRACE_FILES, buildScratch } from '../m10/lib/scratch.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { DENY_WORDS, TOOLS, didNotHappen, framesOf, happened, initOf, notRun, outline, resultOf, runScenario } from '../m16/lib/common.mjs';
import { M19ClaudeDriver, OMITTED_CLAUDE, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { CANCEL_WORDS, FEEDBACK, M22B_DIR, PROMPTS, inFolder, shapeOf, tidy, typeCounts, whereIs } from './lib/common.mjs';

const PLAN_TOOL = 'ExitPlanMode';
const EXTRA = ['--include-partial-messages'];
/** The app's two tool lists (src/main/providers/claude/chat-modes.ts), each with `ExitPlanMode` (C8). */
const READING = Object.freeze([...TOOLS, 'AskUserQuestion', PLAN_TOOL]);
const EXECUTION = Object.freeze([...TOOLS, 'AskUserQuestion', 'Bash', 'Write', 'Edit', PLAN_TOOL]);
/** fat-g's five modes as the app launches them (chat-modes.ts, CLAUDE_MODES). */
const MODES = Object.freeze({
  'read-only': { permissionMode: 'default', tools: READING },
  'ask-first': { permissionMode: 'default', tools: EXECUTION },
  'edits-ok': { permissionMode: 'acceptEdits', tools: EXECUTION },
  'auto-reviewed': { permissionMode: 'auto', tools: EXECUTION },
  berserk: { permissionMode: 'bypassPermissions', tools: EXECUTION },
});

const isToolRequest = (frame) => frame?.type === 'control_request' && frame.request?.subtype === 'can_use_tool';
const isPlanRequest = (frame) => isToolRequest(frame) && frame.request.tool_name === PLAN_TOOL;
const blocksOf = (frame) => (Array.isArray(frame?.message?.content) ? frame.message.content : []);

/** M19's driver, every `can_use_tool` request going to the scenario's rule: an answer, or `hold`. */
class K1Driver extends M19ClaudeDriver {
  constructor(options) {
    super(options);
    this.rule = null;
    this.answers = [];
    this.held = [];
  }

  incoming(frame, index) {
    if (!isToolRequest(frame)) { super.incoming(frame, index); return; }
    const request = frame.request;
    this.requestsSeen.push({ kind: 'can_use_tool', tool: request.tool_name ?? null, worker: Boolean(request.agent_id) });
    const plan = this.rule?.(request) ?? { behavior: 'deny', why: 'no rule' };
    const entry = { requestId: frame.request_id, index, atMs: this.tree.elapsed(), tool: request.tool_name ?? null };
    if (plan === 'hold') { this.held.push(entry); this.requestsSeen.at(-1).answer = 'held'; return; }
    const response = plan.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: request.input ?? {} }
      : { behavior: 'deny', message: plan.message ?? DENY_WORDS, ...(plan.interrupt ? { interrupt: true } : {}) };
    this.answers.push({ ...entry, label: plan.label ?? response.behavior, behavior: response.behavior, interrupt: response.interrupt === true, why: plan.why ?? null });
    this.requestsSeen.at(-1).answer = plan.label ?? response.behavior;
    this.session.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } }).catch(() => {});
  }
}

const OPTIONS = {
  dir: M22B_DIR, milestone: 'M22b', Driver: K1Driver, omitted: OMITTED_CLAUDE,
  toolPolicy: "ExitPlanMode answered as the scenario says (feedback: deny with the spike's words; Execute: a plain allow; Cancel: deny with interrupt and fat-g's words; or held for a Stop); a Write of the plan file inside the scratch configuration's plans folder, and a Write or an Edit in the scratch project, allowed; any other request denied",
};

/** The folders a path is placed in. */
const foldersOf = (ctx, extra = {}) => ({ 'scratch project': ctx.project, 'plans folder': path.join(ctx.config, 'plans'), 'configuration folder': ctx.config, 'outside every root': ctx.outside, ...extra });
const absolute = (file, base) => (path.isAbsolute(file) ? file : path.join(base, file));

/** The rule a scenario's requests go to: `answers` for each `ExitPlanMode` in turn, the last repeated. */
function ruleFor(ctx, answers, plansDir) {
  let n = 0;
  return (request) => {
    const tool = request.tool_name;
    if (tool === PLAN_TOOL) {
      const answer = answers[Math.min(n, answers.length - 1)];
      n += 1;
      if (answer === 'hold') return 'hold';
      if (answer === 'feedback') return { behavior: 'deny', message: FEEDBACK, label: 'feedback' };
      if (answer === 'cancel') return { behavior: 'deny', message: CANCEL_WORDS, interrupt: true, label: 'cancel' };
      return { behavior: 'allow', label: 'execute' };
    }
    if ((tool === 'Write' || tool === 'Edit') && typeof request.input?.file_path === 'string') {
      const file = absolute(request.input.file_path, ctx.project);
      if (tool === 'Write' && inFolder(file, plansDir)) return { behavior: 'allow', label: 'plan file', why: "the plan file, in the spike's own plans folder" };
      if (inFolder(file, ctx.project)) return { behavior: 'allow', label: 'project file', why: 'a file of the scratch project' };
    }
    return { behavior: 'deny', why: 'not the plan, its file or the scratch project' };
  };
}

/** `set_permission_mode`, with no prompt: its reply, and the frames that came within a moment. */
async function setMode(driver, mode, folders) {
  const from = driver.nextIndex;
  const at = driver.tree.elapsed();
  const reply = await driver.request('set_permission_mode', { mode });
  await sleep(700);
  const replyAt = driver.session.frames.find((f) => f.index === reply.index)?.ms ?? at;
  return {
    asked: mode, ok: reply.ok, ms: Math.round(replyAt - at), replyKeys: reply.ok && reply.value && typeof reply.value === 'object' ? Object.keys(reply.value).sort() : null,
    replyMode: reply.ok ? reply.value?.mode ?? reply.value?.permissionMode ?? reply.value?.permission_mode ?? null : null, error: reply.ok ? null : tidy(reply.error, folders),
    framesAfter: received(driver, from).filter((f) => f.index !== reply.index).map((f) => ({ type: typeKey(f.frame), ...('permissionMode' in (f.frame ?? {}) ? { permissionMode: f.frame.permissionMode } : {}) })),
  };
}

const initializeFacts = (reply) => ({ currentPermissionMode: reply?.current_permission_mode ?? null, pendingPermissionRequests: Array.isArray(reply?.pending_permission_requests) ? reply.pending_permission_requests.length : 'absent' });

/** Every frame from `from` on that names a permission mode. */
const modeFrames = (driver, from) => received(driver, from).filter((f) => f.frame && typeof f.frame === 'object' && 'permissionMode' in f.frame).map((f) => ({ index: f.index, type: typeKey(f.frame), permissionMode: f.frame.permissionMode }));

/** The tool's result that answers a tool use: its shape, the CLI's words for a refusal, and what `tool_use_result` names. */
function resultFacts(driver, toolUseId, answeredAt, from, folders, planText) {
  const entry = received(driver, from).find((f) => typeKey(f.frame) === 'user' && blocksOf(f.frame).some((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId)) ?? null;
  if (!entry) return null;
  const block = blocksOf(entry.frame).find((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
  const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
  const used = entry.frame.tool_use_result;
  const usedFacts = used === undefined ? 'absent' : typeof used === 'string' ? { string: true, units: used.length } : {
    keys: Object.keys(used ?? {}).sort(),
    ...Object.fromEntries(Object.entries(used ?? {}).map(([key, value]) => [key, typeof value === 'string' ? (/path/i.test(key) ? whereIs(value, folders) : { units: value.length, isThePlan: typeof planText === 'string' && value === planText }) : value])),
  };
  return {
    index: entry.index, msAfterTheAnswer: answeredAt === null ? null : Math.round(entry.ms - answeredAt), isError: block.is_error === true, contentUnits: content.length,
    // A refusal's words are the CLI's around the spike's own; an approval's hold the plan, which is not written down.
    words: block.is_error === true ? tidy(content, folders, 500) : null, holdsThePlan: typeof planText === 'string' && planText.length > 20 && content.includes(planText.slice(0, 20)),
    toolUseResult: usedFacts,
  };
}

/** Each `ExitPlanMode` request from `from` on: its shape, where the plan's text is, the answer, and what came back. */
function planRequests(driver, from, folders) {
  return received(driver, from).filter((f) => isPlanRequest(f.frame)).map((entry) => {
    const request = entry.frame.request;
    const input = request.input ?? {};
    const answer = driver.answers.find((a) => a.requestId === entry.frame.request_id) ?? null;
    const held = driver.held.some((h) => h.requestId === entry.frame.request_id);
    return {
      index: entry.index, requestKeys: Object.keys(request).sort(), inputKeys: Object.keys(input).sort(), planInInput: shapeOf(input.plan),
      otherInput: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'plan').map(([key, value]) => [key, typeof value === 'string' ? (/path/i.test(key) ? whereIs(value, folders) : { units: value.length }) : Array.isArray(value) ? { array: value.length, itemKeys: Object.keys(value[0] ?? {}).sort() } : value])),
      suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions.map((s) => ({ type: s?.type ?? null, mode: s?.mode ?? null, destination: s?.destination ?? null })) : request.permission_suggestions ?? 'absent',
      blockedPath: whereIs(request.blocked_path, folders), decisionReason: tidy(request.decision_reason ?? null, folders), worker: Boolean(request.agent_id),
      answer: answer ? { label: answer.label, behavior: answer.behavior, interrupt: answer.interrupt } : held ? 'held' : null,
      toolResult: resultFacts(driver, request.tool_use_id, answer?.atMs ?? null, from, folders, typeof input.plan === 'string' ? input.plan : null),
    };
  });
}

/** Every other `can_use_tool` request from `from` on: the tool, where its file is, and the answer. Never a command's text. */
const otherRequests = (driver, from, folders) => received(driver, from).filter((f) => isToolRequest(f.frame) && !isPlanRequest(f.frame)).map((entry) => {
  const request = entry.frame.request;
  const answer = driver.answers.find((a) => a.requestId === entry.frame.request_id) ?? null;
  return { index: entry.index, tool: request.tool_name ?? null, file: whereIs(request.input?.file_path, folders, folders['scratch project']), suggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions.map((s) => s?.type ?? null) : 'absent', answer: answer?.label ?? (driver.held.some((h) => h.requestId === entry.frame.request_id) ? 'held' : null) };
});

/** Each tool call of the model's from `from` on, with whether a request named it and how it ended. */
function toolCalls(driver, from, folders) {
  const calls = new Map();
  for (const { frame } of framesOf(driver, 'assistant', from)) {
    for (const block of blocksOf(frame)) if (block.type === 'tool_use') calls.set(block.id, { tool: block.name, file: whereIs(block.input?.file_path, folders, folders['scratch project']), asked: false, result: null });
  }
  for (const { frame } of received(driver, from)) if (isToolRequest(frame) && calls.has(frame.request?.tool_use_id)) calls.get(frame.request.tool_use_id).asked = true;
  for (const { frame } of framesOf(driver, 'user', from)) for (const block of blocksOf(frame)) if (block.type === 'tool_result' && calls.has(block.tool_use_id)) calls.get(block.tool_use_id).result = block.is_error ? 'error' : 'ok';
  return [...calls.values()];
}

/** The names in a folder, or null where it is not there. */
const namesIn = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : null);

/** Whether notes-1.txt holds the line the plan names: the change Execute should make. */
const changed = (ctx) => {
  const file = path.join(ctx.project, 'notes-1.txt');
  return existsSync(file) ? readFileSync(file, 'utf8') !== TRACE_FILES['notes-1.txt'] && /reviewed/.test(readFileSync(file, 'utf8')) : null;
};

/**
 * One plan turn under `modeId`: launched under the mode, `set_permission_mode` `plan`, one prompt,
 * each `ExitPlanMode` answered from `answers` (or held, then a Stop), then the mode set back.
 */
async function planTurn(ctx, modeId, answers, { settings = null } = {}) {
  if (!ctx.model) return notRun("no model chosen: run M16's --scenario discover first");
  const mode = MODES[modeId];
  const plansScratch = settings ? buildScratch('m22bPlans') : null;
  const plansDir = plansScratch ? plansScratch.dir : path.join(ctx.config, 'plans');
  const folders = foldersOf(ctx, plansScratch ? { "the spike's plans folder": plansScratch.dir } : {});
  const extra = settings ? [...EXTRA, '--settings', JSON.stringify({ plansDirectory: plansScratch.dir })] : EXTRA;
  const driver = await ctx.open({ launch: { extra, tools: mode.tools, permissionMode: mode.permissionMode }, background: false });
  const notes = { mode: modeId, launchedWith: mode.permissionMode, tools: mode.tools, answersPlanned: answers, initialize: initializeFacts(driver.initializeReply) };
  if (notes.initialize.currentPermissionMode !== mode.permissionMode) return didNotHappen(`the launch did not report ${mode.permissionMode}: no prompt is sent`, notes);
  notes.setPlan = await setMode(driver, 'plan', folders);
  if (!notes.setPlan.ok) return didNotHappen('set_permission_mode plan was refused: no prompt is sent', notes);
  const plansBefore = namesIn(plansDir);
  driver.rule = ruleFor(ctx, answers, plansDir);
  const uuid = randomUUID();
  const from = await ctx.prompt(driver, PROMPTS.claudePlan, { uuid });
  let end;
  if (answers[0] === 'hold') {
    const hit = await ctx.frame(driver, (f) => isPlanRequest(f) || typeKey(f) === 'result', from);
    if (typeKey(hit.frame) === 'result') {
      Object.assign(notes, { requests: otherRequests(driver, from, folders), toolCalls: toolCalls(driver, from, folders), outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event') });
      return didNotHappen('the turn ended with no ExitPlanMode request', notes);
    }
    await sleep(2_000);
    const stopAt = driver.tree.elapsed();
    const interrupt = await driver.interrupt();
    end = await ctx.turnEnd(driver, from);
    await sleep(2_500);
    notes.stop = {
      heldForMs: Math.round(stopAt - (driver.session.frames.find((f) => f.index === hit.index)?.ms ?? stopAt)), interruptReply: { ok: interrupt.ok, keys: interrupt.ok && interrupt.value && typeof interrupt.value === 'object' ? Object.keys(interrupt.value).sort() : null },
      cancels: received(driver, from).filter((f) => typeKey(f.frame) === 'control_cancel_request').map((f) => ({ index: f.index, msAfterTheStop: Math.round(f.ms - stopAt), keys: Object.keys(f.frame).sort(), namesTheRequest: f.frame.request_id === hit.frame.request_id })),
      framesAfterTheStop: received(driver, from).filter((f) => f.ms >= stopAt && typeKey(f.frame) !== 'stream_event').map((f) => ({ type: typeKey(f.frame), msAfterTheStop: Math.round(f.ms - stopAt) })),
    };
  } else {
    end = await ctx.turnEnd(driver, from);
    await sleep(1_500);
  }
  const init = initOf(driver, from)?.frame ?? null;
  const result = resultOf(driver, from)?.frame ?? null;
  const plans = planRequests(driver, from, folders);
  const plansAfter = namesIn(plansDir);
  const added = (plansAfter ?? []).filter((name) => !(plansBefore ?? []).includes(name));
  // The plan file the CLI wrote in the scratch configuration folder goes with the run, unread.
  if (!plansScratch) for (const name of added) ctx.expectWritten(path.join('plans', name));
  Object.assign(notes, {
    endStatus: end.status, isError: end.isError ?? null, terminal: end.terminalReason ?? null,
    init: init ? { permissionMode: init.permissionMode ?? null, model: init.model ?? null, tools: (init.tools ?? []).filter((tool) => !String(tool).startsWith('mcp__')), planToolListed: (init.tools ?? []).includes(PLAN_TOOL), enterPlanToolListed: (init.tools ?? []).includes('EnterPlanMode') } : null,
    planRequests: plans, otherRequests: otherRequests(driver, from, folders), toolCalls: toolCalls(driver, from, folders), modeFrames: modeFrames(driver, from),
    permissionDenied: framesOf(driver, 'system/permission_denied', from).map((f) => ({ tool: f.frame.tool_name ?? null, reasonType: f.frame.decision_reason_type ?? null })),
    cancels: received(driver, from).filter((f) => typeKey(f.frame) === 'control_cancel_request').length,
    result: result ? { subtype: result.subtype ?? null, isError: result.is_error === true, terminal: result.terminal_reason ?? null, numTurns: result.num_turns ?? null, permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials.map((d) => d?.tool_name ?? null) : null, permissionModeNamed: result.permissionMode ?? result.permission_mode ?? 'absent' } : null,
    plansFolder: { where: plansScratch ? "the spike's own plans folder" : 'the scratch configuration folder', filesAdded: added.length, removedAfterTheRun: !plansScratch },
    theChangeMade: changed(ctx),
  });
  notes.setBack = await setMode(driver, mode.permissionMode, folders);
  Object.assign(notes, { sessionId: init?.session_id ?? null, typeCounts: typeCounts(driver, typeKey, from), outline: outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event') });
  if (plans.length === 0) return didNotHappen('the turn ended with no ExitPlanMode request', notes);
  return happened(notes, end.index);
}

const scenario = (key, modeId, answers, title, extra = {}) => ({
  id: `m22b-${key}`, name: `m22b-plan-${key}`, turns: 1, files: FILES, title, ...extra,
  successCondition: 'Whether the model calls ExitPlanMode, where the plan\'s text comes, what each answer brings, and the mode the frames report before and after',
  run: (ctx) => planTurn(ctx, modeId, answers, extra.planTurn ?? {}),
});

const SCENARIOS = {
  'read-only': scenario('read-only', 'read-only', ['feedback', 'cancel'], 'K1: a plan turn under Read only (no Write tool): feedback, then Cancel on the next request (C8, C11)'),
  'ask-first': scenario('ask-first', 'ask-first', ['execute'], "K1: a plan turn under Ask first: whether the plan file's write asks, then Execute (C8, C11)"),
  'edits-ok': scenario('edits-ok', 'edits-ok', ['execute'], 'K1: a plan turn under Edits ok: Execute, and the mode after it (C5, C11)'),
  'auto-reviewed': scenario('auto-reviewed', 'auto-reviewed', ['feedback', 'execute'], 'K1: a plan turn under Auto-reviewed: feedback, then Execute (C5, C11)'),
  berserk: scenario('berserk', 'berserk', ['hold'], 'K1: a plan turn under Berserk: the request held, then a Stop (C5, C6)'),
  'plans-dir': scenario('plans-dir', 'ask-first', ['execute'], 'K1, in reserve: --settings naming a plansDirectory under a scratch folder (C9)', { reserve: true, planTurn: { settings: true } }),
};

if (isMain(import.meta.url)) {
  await runSpike('m22b-k1', (frame) => {
    if (frame.args.list) {
      for (const [key, entry] of Object.entries(SCENARIOS)) log(`claude  ${key.padEnd(14)} ${String(entry.turns).padStart(2)} prompt(s)${entry.reserve ? ' (reserve)' : ''}  ${entry.title}`);
      log(`total: ${Object.values(SCENARIOS).filter((entry) => !entry.reserve).reduce((sum, entry) => sum + entry.turns, 0)} prompts for one run of each planned scenario, of the twelve K1 may spend (C46)`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m22b/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--path <executable>]`); return 1; }
    log(`K1: M16's launch as M20b leaves it, with ${EXTRA.join(' ')} and each mode's tools plus ${PLAN_TOOL}; background tasks off; the scratch configuration folder`);
    return runScenario('m22b-k1', chosen, frame, OPTIONS);
  });
}
