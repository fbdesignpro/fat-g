// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M22 spike K2 (docs/planning/_archive/M22-spec-sheet.md; C5, C7, C21–C24, C47): Claude's permission modes,
// its `can_use_tool` requests for `Bash`, `Write` and `Edit` answered `allow`, a session rule sent
// with the allow, and what acts with no request, under the app's launch — M16's as M20b leaves it,
// with `--include-partial-messages` and background tasks off — plus `AskUserQuestion` (M21, C16)
// and `Bash`, `Write`, `Edit` in `--tools` (C5), in M16's scratch configuration folder.
//
//   node spikes/m22/k2.mjs --list
//   node spikes/m22/k2.mjs --scenario <name> --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C33). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m22). `modes` sends no prompt. `resumed` resumes the session `session-rule` left.
// `auto-turn`, `bypass-turn` and `worker-mode` are the sheet's K5 cases, run at the acceptance
// (C51, V26): one prompt each. `bypass-turn` runs one turn in which nothing asks, its prompt
// dictating two files and two commands, each in a scratch folder.
//
// The spike allows only what its own prompt dictated: a `Bash` request whose command is the
// prompt's, word for word, and a `Write` or an `Edit` whose file is in a scratch folder. Any other
// request is denied. No flag that bypasses permissions is ever passed (C47): `bypassPermissions` is
// asked for by `set_permission_mode` and by `--permission-mode` alone, with no prompt behind it.
//
// What a run records is never a text of the model's: each request's shape and what came with it,
// the reply the spike sent, the CLI's own words for a refusal, which tool calls ran with no
// request, the modes the frames report, the rules `list_permission_rules` lists, and which files
// the scratch folders hold afterwards.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { typeKey } from '../m10/claude/frames.mjs';
import { sleep } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { scratchPath } from '../m10/lib/scratch.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { CliExited } from '../m10/lib/wire.mjs';
import { CONFIG_DIR, DENY_WORDS, TOOLS, didNotHappen, framesOf, happened, initOf, notRun, outline, resultOf, runScenario } from '../m16/lib/common.mjs';
import { M19ClaudeDriver, OMITTED_CLAUDE, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { M22_DIR, cut, inFolder, readState, typeCounts, whereIs, writeState } from './lib/common.mjs';

/** The launch as M21 plans it, plus the three tools an execution mode adds (C5). */
const EXECUTION_TOOLS = Object.freeze([...TOOLS, 'AskUserQuestion', 'Bash', 'Write', 'Edit']);
const EXTRA = ['--include-partial-messages'];
const SETTLED = Object.freeze({ launch: { extra: EXTRA, tools: EXECUTION_TOOLS }, background: false });

/** The spike's own MCP server and its one tool, as the CLI names it. */
const MCP_SERVER = 'fatgspike';
const MCP_TOOL = `mcp__${MCP_SERVER}__stamp`;

const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);
const isToolRequest = (frame) => frame?.type === 'control_request' && frame.request?.subtype === 'can_use_tool';

/** The commands the prompts dictate, word for word: the only ones a `Bash` request is allowed for. */
const COMMANDS = Object.freeze({
  once: 'touch bash-once.txt', session: 'touch bash-session.txt', destination: 'touch bash-destination.txt',
  underAcceptEdits: 'touch bash-under-accept-edits.txt', version: 'node --version',
  allowed: 'touch allowed-by-rule.txt', denied: 'touch denied-by-rule.txt', worker: 'touch worker-made.txt',
  underAuto: 'touch bash-under-auto.txt', underBypass: 'touch bash-under-bypass.txt', workerMode: 'touch worker-mode-made.txt',
});

const run = (command) => `Run exactly this command with your Bash tool, once, and nothing else: ${command}`;
const again = (command) => `Run exactly the same command again with your Bash tool, once, even though it ran before: ${command}`;
const REPORT = 'Then tell me in one short sentence whether it ran. If you are not allowed to run it, say so in one sentence and stop: do not try another way.';
const STEPS = 'Do these steps in this order, each with the tool it names and no other tool, and go on to the next step if one is refused; do not try another way for a refused step.';

/** One M22 driver: every `can_use_tool` request goes to the scenario's rule, which allows, denies or holds it. */
class K2Driver extends M19ClaudeDriver {
  constructor(options) {
    super(options);
    this.approvalRule = null;
    this.decisions = [];
    this.held = [];
  }

  incoming(frame, index) {
    if (!isToolRequest(frame)) { super.incoming(frame, index); return; }
    const request = frame.request;
    this.requestsSeen.push({ kind: 'can_use_tool', tool: request.tool_name ?? null, worker: Boolean(request.agent_id) });
    const plan = this.approvalRule?.(request, this.decisions.length) ?? { behavior: 'deny', why: 'no rule' };
    const entry = { requestId: frame.request_id, index, atMs: this.tree.elapsed(), tool: request.tool_name ?? null };
    if (plan === 'hold') { this.held.push(entry); this.requestsSeen.at(-1).answer = 'held'; return; }
    const response = plan.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: request.input ?? {}, ...(plan.updatedPermissions ? { updatedPermissions: plan.updatedPermissions } : {}) }
      : { behavior: 'deny', message: DENY_WORDS };
    this.decisions.push({ ...entry, behavior: response.behavior, updatedPermissions: plan.updatedPermissions ?? null, why: plan.why ?? null });
    this.requestsSeen.at(-1).answer = response.behavior;
    this.session.send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } }).catch(() => {});
  }
}

const OPTIONS = {
  dir: M22_DIR, milestone: 'M22', Driver: K2Driver, omitted: OMITTED_CLAUDE,
  toolPolicy: "a can_use_tool request for what the prompt dictated — its Bash command word for word, or a Write or an Edit in a scratch folder — is allowed, with the scenario's permission update where it names one; any other is denied, and a request that is no can_use_tool gets an error reply",
};

/** The folders a path is placed in, and the commands this scenario's prompts dictate. */
const scopeOf = (ctx, commands = []) => ({
  commands, base: ctx.project,
  folders: { 'working folder': ctx.project, 'added root': ctx.other, 'outside every root': ctx.outside, 'configuration folder': ctx.config },
  writable: [ctx.project, ctx.other, ctx.outside],
});

/** Whether a request is for what the scenario's prompt dictated: the only kind the spike allows. */
function dictated(toolName, input, scope) {
  if (toolName === 'Bash') return typeof input?.command === 'string' && scope.commands.includes(input.command.trim());
  if (toolName === 'Write' || toolName === 'Edit') {
    const file = typeof input?.file_path === 'string' ? (path.isAbsolute(input.file_path) ? input.file_path : path.join(scope.base, input.file_path)) : null;
    return file !== null && scope.writable.some((dir) => inFolder(file, dir));
  }
  return toolName === MCP_TOOL;
}

const DENY = Object.freeze({ behavior: 'deny', why: 'not what the prompt dictated' });
/** Allows what was dictated, with what `extra(request, n)` adds; denies the rest. */
const allowDictated = (scope, extra = () => ({})) => (request, n) => (dictated(request.tool_name, request.input, scope) ? { behavior: 'allow', ...extra(request, n) } : DENY);

/** A rule's or a reason's text with the scratch folders named, and nothing of a path that is none of them. */
function tidy(text, scope) {
  if (typeof text !== 'string') return null;
  let out = text;
  // The longest first: the working folder's path begins the other scratch folders' paths.
  for (const [name, dir] of Object.entries(scope.folders).sort(([, a], [, b]) => b.length - a.length)) {
    const forward = dir.split(path.sep).join('/');
    const posix = /^[A-Za-z]:/.test(forward) ? `/${forward[0].toLowerCase()}${forward.slice(2)}` : forward;
    for (const spelling of [dir, forward, `/${posix}`, posix, dir.split(path.sep).join('\\\\')]) out = out.split(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).join(`<${name}>`);
  }
  return out.toLowerCase().includes(userInfo().username.toLowerCase()) ? `<${text.length} units, naming a path>` : cut(out, 300);
}

/** The tool's result that answers a tool use: how it came back and, for a refusal, the words, which are the CLI's or the spike's own. */
function resultFacts(driver, toolUseId, answeredAt, from, scope) {
  const entry = received(driver, from).find((f) => typeKey(f.frame) === 'user' && blocksOf(f.frame).some((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId)) ?? null;
  if (!entry) return null;
  const block = blocksOf(entry.frame).find((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
  const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
  return { index: entry.index, msAfterTheAnswer: answeredAt === null ? null : Math.round(entry.ms - answeredAt), isError: block.is_error === true, contentUnits: content.length, words: block.is_error === true ? tidy(content, scope) : null, isAWorkers: entry.frame.parent_tool_use_id != null };
}

/** One permission update, as a suggestion carried it or as the spike sent it: its kind and where it would go. */
const updateFacts = (update, own, scope) => ({
  type: update?.type ?? null, destination: update?.destination ?? null, ...(update?.behavior ? { behavior: update.behavior } : {}), ...(update?.mode ? { mode: update.mode } : {}),
  ...(Array.isArray(update?.rules) ? { rules: update.rules.map((rule) => ({ toolName: rule?.toolName ?? null, ruleContent: typeof rule?.ruleContent !== 'string' ? null : own ? tidy(rule.ruleContent, scope) : `<${rule.ruleContent.length} units>` })) } : {}),
  ...(Array.isArray(update?.directories) ? { directories: update.directories.map((dir) => whereIs(dir, scope.folders)) } : {}),
});

/** What a `can_use_tool` request says of itself, the reply the spike sent, and the tool's result. Never its input. */
function requestFacts(driver, entry, from, scope) {
  const request = entry.frame.request;
  const input = request.input ?? {};
  const own = dictated(request.tool_name, input, scope);
  const decision = driver.decisions.find((d) => d.requestId === entry.frame.request_id) ?? null;
  const held = driver.held.some((h) => h.requestId === entry.frame.request_id);
  const toolUse = received(driver, from).find((f) => typeKey(f.frame) === 'assistant' && blocksOf(f.frame).some((b) => b.type === 'tool_use' && b.id === request.tool_use_id)) ?? null;
  return {
    index: entry.index, tool: String(request.tool_name ?? '').startsWith('mcp__') && request.tool_name !== MCP_TOOL ? 'mcp:<another>' : request.tool_name ?? null, displayName: request.display_name ?? null,
    keys: Object.keys(request).sort(), inputKeys: Object.keys(input).sort(), isWhatThePromptDictated: own,
    target: request.tool_name === 'Bash' ? null : whereIs(input.file_path, scope.folders, scope.base), msAfterTheToolUse: toolUse ? Math.round(entry.ms - toolUse.ms) : null,
    agentIdNamed: typeof request.agent_id === 'string', decisionReasonType: request.decision_reason_type ?? null, decisionReason: tidy(request.decision_reason ?? null, scope),
    blockedPath: typeof request.blocked_path === 'string' ? whereIs(request.blocked_path, scope.folders) : null,
    suggestionsKeyPresent: 'permission_suggestions' in request, suggestions: (Array.isArray(request.permission_suggestions) ? request.permission_suggestions : []).map((s) => updateFacts(s, own, scope)),
    flags: Object.fromEntries(['requires_user_interaction', 'suppress_always_allow_rule', 'default_to_no', 'classifier_approvable'].filter((key) => key in request).map((key) => [key, request[key]])),
    matchedAskRule: 'matched_ask_rule' in request, titleUnits: typeof request.title === 'string' ? request.title.length : null, descriptionUnits: typeof request.description === 'string' ? request.description.length : null,
    answer: decision ? { behavior: decision.behavior, msAfterTheRequest: Math.round(decision.atMs - entry.ms), why: decision.why, updatedPermissions: decision.updatedPermissions ? decision.updatedPermissions.map((u) => updateFacts(u, own, scope)) : null } : held ? 'held' : null,
    result: resultFacts(driver, request.tool_use_id, decision?.atMs ?? null, from, scope),
  };
}

const requestsOf = (driver, from, scope) => received(driver, from).filter((f) => isToolRequest(f.frame)).map((entry) => requestFacts(driver, entry, from, scope));

/** Each tool call from `from` on: whose it is, whether a request named it, and how its result came back. */
function toolCalls(driver, from, scope) {
  const calls = new Map();
  for (const { frame } of framesOf(driver, 'assistant', from)) {
    for (const block of blocksOf(frame)) {
      if (block.type !== 'tool_use') continue;
      const name = String(block.name ?? '');
      calls.set(block.id, { tool: name.startsWith('mcp__') && name !== MCP_TOOL ? 'mcp:<another>' : name, worker: frame.parent_tool_use_id != null, isWhatThePromptDictated: dictated(name, block.input, scope), target: name === 'Bash' ? null : whereIs(block.input?.file_path, scope.folders, scope.base), asked: false, result: null });
    }
  }
  for (const { frame } of received(driver, from)) if (isToolRequest(frame) && calls.has(frame.request?.tool_use_id)) calls.get(frame.request.tool_use_id).asked = true;
  for (const { frame } of framesOf(driver, 'user', from)) {
    for (const block of blocksOf(frame)) if (block.type === 'tool_result' && calls.has(block.tool_use_id)) calls.get(block.tool_use_id).result = block.is_error ? 'error' : 'ok';
  }
  return [...calls.values()];
}

/** Every frame from `from` on that names a permission mode. */
const modeFrames = (driver, from) => received(driver, from).filter((f) => f.frame && typeof f.frame === 'object' && 'permissionMode' in f.frame).map((f) => ({ index: f.index, type: typeKey(f.frame), permissionMode: f.frame.permissionMode }));

const deniedFrames = (driver, from, scope) => framesOf(driver, 'system/permission_denied', from).map((f) => ({ index: f.index, tool: f.frame.tool_name ?? null, keys: Object.keys(f.frame).sort(), decisionReasonType: f.frame.decision_reason_type ?? null, decisionReason: tidy(f.frame.decision_reason ?? null, scope), message: tidy(f.frame.message ?? null, scope), agentIdNamed: typeof f.frame.agent_id === 'string' }));

/** A turn's bounds and what happened in it: kinds, counts and the CLI's own words, never the model's. */
function turnFacts(driver, from, end, scope) {
  const init = initOf(driver, from)?.frame ?? null;
  const result = resultOf(driver, from)?.frame ?? null;
  const tools = Array.isArray(init?.tools) ? init.tools : [];
  return {
    endStatus: end?.status ?? null, isError: end?.isError ?? null, terminal: end?.terminalReason ?? null,
    init: init ? { permissionMode: init.permissionMode ?? null, model: init.model ?? null, tools: tools.filter((tool) => !String(tool).startsWith('mcp__')), mcpTools: tools.filter((tool) => String(tool).startsWith('mcp__')).length, ourMcpToolListed: tools.includes(MCP_TOOL), ourMcpServer: (init.mcp_servers ?? []).find((server) => server?.name === MCP_SERVER)?.status ?? null } : null,
    requests: requestsOf(driver, from, scope), toolCalls: toolCalls(driver, from, scope), permissionDenied: deniedFrames(driver, from, scope), modeFrames: modeFrames(driver, from),
    result: result ? { subtype: result.subtype ?? null, isError: result.is_error === true, terminal: result.terminal_reason ?? null, numTurns: result.num_turns ?? null, permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials.length : null } : null,
    workers: { started: framesOf(driver, 'system/task_started', from).length, ended: framesOf(driver, 'system/task_notification', from).length },
    cancels: received(driver, from).filter((f) => typeKey(f.frame) === 'control_cancel_request').length, typeCounts: typeCounts(driver, typeKey, from),
  };
}

const outlineOf = (driver, from, uuid) => outline(driver, from, { sent: [uuid] }).filter((row) => row.recv !== 'stream_event');

/** One prompt through to its turn's end. */
async function turn(ctx, driver, prompt, scope) {
  const uuid = randomUUID();
  const from = await ctx.prompt(driver, prompt, { uuid });
  const end = await ctx.turnEnd(driver, from);
  await sleep(1_200);
  return { from, end, uuid, facts: turnFacts(driver, from, end, scope), outline: outlineOf(driver, from, uuid) };
}

/** `list_permission_rules`, with no prompt: the reply's shape, each source's count, and the rules this run could have made. */
async function listRules(driver, scope, { probe = false } = {}) {
  // The `modes` scenario asks once and leaves what it found: a CLI that does not know the request is not asked again.
  if (!probe && readState().claudeListsRules === false) return { ok: false, notAsked: 'the installed CLI refused list_permission_rules as unsupported (the modes scenario)' };
  const reply = await driver.request('list_permission_rules', {});
  if (probe) writeState({ claudeListsRules: reply.ok });
  if (!reply.ok) return { ok: false, error: tidy(reply.error, scope) };
  const state = reply.value?.state ?? {};
  const rules = Array.isArray(state.rules) ? state.rules : [];
  const bySource = {};
  for (const rule of rules) { const key = `${rule?.source}/${rule?.behavior}/${rule?.editability}`; bySource[key] = (bySource[key] ?? 0) + 1; }
  // The scratch configuration holds no settings file but the spike's own, so a rule of one of these sources is this run's.
  const ours = rules.filter((rule) => ['session', 'cliArg', 'userSettings', 'projectSettings', 'localSettings'].includes(rule?.source));
  return {
    ok: true, replyKeys: Object.keys(reply.value ?? {}).sort(), stateKeys: Object.keys(state).sort(), managedOnly: state.managedOnly ?? null, errors: Array.isArray(state.errors) ? state.errors.length : null,
    originalCwd: whereIs(state.originalCwd, scope.folders), workspaceDirectories: (Array.isArray(state.workspaceDirectories) ? state.workspaceDirectories : []).map((dir) => ({ keys: Object.keys(dir ?? {}).sort(), where: whereIs(dir?.path, scope.folders), source: dir?.source ?? null })),
    count: rules.length, bySource,
    ours: ours.map((rule) => ({ keys: Object.keys(rule).sort(), behavior: rule.behavior ?? null, source: rule.source ?? null, editability: rule.editability ?? null, rule: tidy(rule.rule, scope), notInEffect: rule.notInEffect ?? null, descriptionKeys: rule.description ? Object.keys(rule.description).sort() : null })),
  };
}

/** `set_permission_mode`, with no prompt: its reply, how long it took, and what frames followed within a moment. */
async function setMode(driver, mode, scope) {
  const from = driver.nextIndex;
  const at = driver.tree.elapsed();
  const reply = await driver.request('set_permission_mode', { mode });
  await sleep(700);
  const replyAt = driver.session.frames.find((f) => f.index === reply.index)?.ms ?? at;
  return {
    asked: mode, ok: reply.ok, ms: Math.round(replyAt - at), replyKeys: reply.ok && reply.value && typeof reply.value === 'object' ? Object.keys(reply.value).sort() : null,
    replyMode: reply.ok ? reply.value?.mode ?? reply.value?.permissionMode ?? reply.value?.permission_mode ?? null : null, error: reply.ok ? null : tidy(reply.error, scope),
    framesAfter: received(driver, from).filter((f) => f.index !== reply.index).map((f) => ({ type: typeKey(f.frame), ...('permissionMode' in (f.frame ?? {}) ? { permissionMode: f.frame.permissionMode } : {}), ...(typeof f.frame?.status === 'string' ? { status: f.frame.status } : {}) })),
  };
}

/** Which of `names` each folder holds now, and what the settings files of the scratch folders hold of permissions: the spike's own rules. */
function filesNow(ctx, names) {
  const holds = (dir) => Object.fromEntries(names.map((name) => [name, existsSync(path.join(dir, name))]));
  return { workingFolder: holds(ctx.project), addedRoot: holds(ctx.other), outsideEveryRoot: holds(ctx.outside) };
}

function settingsFiles(ctx, scope) {
  const files = { 'configuration folder/settings.json': path.join(ctx.config, 'settings.json'), 'configuration folder/settings.local.json': path.join(ctx.config, 'settings.local.json'), 'working folder/.claude/settings.json': path.join(ctx.project, '.claude', 'settings.json'), 'working folder/.claude/settings.local.json': path.join(ctx.project, '.claude', 'settings.local.json') };
  return Object.fromEntries(Object.entries(files).map(([name, file]) => {
    if (!existsSync(file)) return [name, { exists: false }];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const permissions = parsed?.permissions && typeof parsed.permissions === 'object' ? Object.fromEntries(Object.entries(parsed.permissions).map(([key, value]) => [key, Array.isArray(value) ? value.map((rule) => tidy(String(rule), scope)) : value])) : null;
      return [name, { exists: true, keys: Object.keys(parsed ?? {}).sort(), permissions }];
    } catch { return [name, { exists: true, keys: null }]; }
  }));
}

const sessionIdOf = (driver, from = 0) => initOf(driver, from)?.frame.session_id ?? null;
const initializeFacts = (reply) => ({ currentPermissionMode: reply?.current_permission_mode ?? null, sessionState: reply?.session_state ?? null, pendingPermissionRequests: Array.isArray(reply?.pending_permission_requests) ? reply.pending_permission_requests.length : 'pending_permission_requests' in (reply ?? {}) ? typeof reply.pending_permission_requests : 'absent' });

/** The suggestions of a request that add an allow rule, as the CLI wrote them. */
const ruleSuggestions = (request) => (Array.isArray(request.permission_suggestions) ? request.permission_suggestions : []).filter((s) => s?.type === 'addRules' && s.behavior === 'allow');

// ── What the `inherited` scenario writes into the scratch folders ──────────────────────────────
const MCP_SCRIPT = `// Written by fat-g's M22 spike (K2), and removed after its run: an MCP server with one tool, which writes one file.
import { writeFileSync } from 'node:fs';
const target = process.argv[2];
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf('\\n'); at !== -1; at = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '${MCP_SERVER}', version: '0.0.0' } } });
    else if (message.method === 'ping') send({ id: message.id, result: {} });
    else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'stamp', description: 'Writes the file mcp-stamped.txt into the project folder. Takes no arguments.', inputSchema: { type: 'object', properties: {} } }] } });
    else if (message.method === 'tools/call') { writeFileSync(target, 'stamped\\n'); send({ id: message.id, result: { content: [{ type: 'text', text: 'stamped' }] } }); }
    else send({ id: message.id, error: { code: -32601, message: 'method not found' } });
  }
});
process.stdin.on('end', () => process.exit(0));
`;
const HOOK_SCRIPT = `// Written by fat-g's M22 spike (K2), and removed after its run: a hook that writes one file and says nothing.
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], 'hook\\n');
`;
const MCP_SCRIPT_NAME = 'fatg-spike-m22-mcp.mjs';
const HOOK_SCRIPT_NAME = 'fatg-spike-m22-hook.mjs';
const forward = (file) => file.split(path.sep).join('/');
/** The project's own `.mcp.json`, naming the server whose script the scenario writes into the scratch configuration folder. */
const MCP_JSON = `${JSON.stringify({ mcpServers: { [MCP_SERVER]: { command: process.execPath, args: [path.join(CONFIG_DIR, MCP_SCRIPT_NAME), path.join(scratchPath('m16'), 'mcp-stamped.txt')] } } }, null, 2)}\n`;

const needsModel = (ctx) => (ctx.model ? null : notRun("no model chosen: run M16's --scenario discover first"));

/** A fresh session, one command asked for, and the CLI's own rule suggestion sent back with the allow as `rewrite` leaves it. */
async function allowWithSuggestion(ctx, command, rewrite) {
  const scope = scopeOf(ctx, [command]);
  const driver = await ctx.open(SETTLED);
  driver.approvalRule = allowDictated(scope, (request, n) => (n === 0 && ruleSuggestions(request).length > 0 ? { updatedPermissions: ruleSuggestions(request).map(rewrite) } : {}));
  const first = await turn(ctx, driver, `${run(command)}\n${REPORT}`, scope);
  return { scope, driver, first };
}

// ── K5's cases (at the acceptance: C51, V26) ───────────────────────────────────────
/** A hook of the scratch settings that writes one file into the working folder at each prompt, and nothing else in them. */
function writeHook(ctx) {
  const hook = ctx.writeConfig(HOOK_SCRIPT_NAME, HOOK_SCRIPT);
  ctx.writeConfig('settings.json', `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${forward(hook)} ${forward(path.join(ctx.project, 'hook-wrote.txt'))}`, timeout: 30 }] }] } }, null, 2)}\n`);
}

/**
 * One prompt in a session launched under `mode` by its argument alone: a `Write` and two commands in
 * the working folder, and a `Write` outside every root. What asks is allowed where the prompt
 * dictated it. `keep` hands the driver back, for a scenario that goes on with no prompt.
 */
async function modeTurn(ctx, mode, { inside, outside, command, label, keep = false }) {
  const scope = scopeOf(ctx, [command, COMMANDS.version]);
  writeHook(ctx);
  const attempt = await ctx.tryOpen({ ...SETTLED, ...(label ? { label } : {}), launch: { ...SETTLED.launch, permissionMode: mode } });
  const notes = { launchedWith: mode, opened: attempt.opened, exit: attempt.exit, initialize: initializeFacts(attempt.driver.initializeReply), stderrWords: attempt.opened ? null : tidy(attempt.driver.tree?.stderrTail ?? '', scope) };
  if (!attempt.opened) return didNotHappen(`the launch under ${mode} did not open`, notes);
  if (notes.initialize.currentPermissionMode !== mode) return didNotHappen(`the launch did not report ${mode}: no prompt is sent`, notes);
  const driver = attempt.driver;
  driver.approvalRule = allowDictated(scope);
  const only = await turn(ctx, driver, `${STEPS}\n1. With the Write tool, create the file ${path.join(ctx.project, inside)} containing the single word alpha.\n2. With the Bash tool, run exactly: ${command}\n3. With the Bash tool, run exactly: ${COMMANDS.version}\n4. With the Write tool, create the file ${path.join(ctx.outside, outside)} containing the single word delta.\nThen tell me in one line per step whether it worked.`, scope);
  Object.assign(notes, {
    turn: only.facts, requestsThatCame: only.facts.requests.length, callsWithNoRequest: only.facts.toolCalls.filter((call) => !call.asked).map((call) => ({ tool: call.tool, target: call.target, result: call.result })),
    files: { ...filesNow(ctx, [inside, command.replace(/^touch /, ''), 'hook-wrote.txt']).workingFolder, [`${outside} (outside every root)`]: existsSync(path.join(ctx.outside, outside)) },
    hookFrames: received(driver, only.from).filter((f) => /^system\/hook_/.test(typeKey(f.frame))).map((f) => ({ type: typeKey(f.frame), event: f.frame.hook_event ?? null })),
    settingsFiles: settingsFiles(ctx, scope), outline: only.outline,
  });
  if (only.facts.toolCalls.length === 0) return didNotHappen('the turn ended without a tool call', notes);
  return { ...happened(notes, only.end.index), ...(keep ? { kept: { driver, sessionId: sessionIdOf(driver, only.from), successIndex: only.end.index } } : {}) };
}

const SCENARIOS = {
  modes: {
    id: 'm22-modes', name: 'm22-modes', turns: 0, files: FILES,
    title: "K2, no prompt: `initialize`'s mode, `set_permission_mode` to each mode, `list_permission_rules`, and a launch under each `--permission-mode` (C5, C47)",
    successCondition: "Each mode's reply by `set_permission_mode` and at launch, with what `bypassPermissions` is answered without a flag that bypasses permissions",
    async run(ctx) {
      const scope = scopeOf(ctx);
      const driver = await ctx.open({ ...SETTLED, label: 'set' });
      const notes = { initialize: { ...initializeFacts(driver.initializeReply), keys: Object.keys(driver.initializeReply ?? {}).sort() }, rulesAtStart: await listRules(driver, scope, { probe: true }), sets: [] };
      try {
        // Each candidate, and `default` again after it; `bypassPermissions` last, in case the CLI ends on it.
        for (const mode of ['acceptEdits', 'default', 'auto', 'default', 'dontAsk', 'default', 'plan', 'default', 'bypassPermissions', 'default']) notes.sets.push(await setMode(driver, mode, scope));
        const settings = await driver.getSettings();
        notes.getSettings = settings.ok ? { keys: Object.keys(settings.value ?? {}).sort(), appliedKeys: Object.keys(settings.value?.applied ?? {}).sort(), appliedNamesAMode: Object.keys(settings.value?.applied ?? {}).some((key) => /permission/i.test(key)) } : { ok: false };
      } catch (error) {
        if (!(error instanceof CliExited)) throw error;
        notes.cliExitedAfter = notes.sets.at(-1)?.asked ?? 'before any set';
      }
      notes.framesOfATurn = received(driver).filter((f) => ['system/init', 'assistant', 'result'].includes(typeKey(f.frame))).length;
      notes.outlineSet = outline(driver, 0).filter((row) => row.recv !== 'stream_event');
      await ctx.close(driver);
      notes.launches = [];
      for (const mode of ['acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']) {
        const attempt = await ctx.tryOpen({ ...SETTLED, label: `launch-${mode}`, launch: { ...SETTLED.launch, permissionMode: mode } });
        await sleep(500);
        notes.launches.push({ launchedWith: mode, opened: attempt.opened, initializeAnswered: attempt.initializeAnswered, exit: attempt.exit, ...initializeFacts(attempt.driver.initializeReply), stderrWords: attempt.opened ? null : tidy(attempt.driver.tree?.stderrTail ?? '', scope), framesBeforeAnyPrompt: attempt.stdoutFrames.map((f) => f.type) });
        // Launched under `bypassPermissions` with no flag: whether the mode can be left and entered again, still with no prompt.
        if (attempt.opened && mode === 'bypassPermissions') {
          notes.launches.at(-1).sets = [];
          for (const next of ['default', 'bypassPermissions', 'default']) notes.launches.at(-1).sets.push(await setMode(attempt.driver, next, scope));
        }
        await ctx.close(attempt.driver);
      }
      return happened(notes, null);
    },
  },

  once: {
    id: 'm22-once', name: 'm22-approve-once', turns: 2, files: FILES,
    title: 'K2: a `Bash` command allowed once, then asked for again in the next turn and denied (C5, C21)',
    successCondition: "The request's shape and its suggestions, the plain `allow` taken and the file made, whether the same command asks again, and what a `deny` brings",
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const scope = scopeOf(ctx, [COMMANDS.once]);
      const driver = await ctx.open(SETTLED);
      driver.approvalRule = (request, n) => (n === 0 ? allowDictated(scope)(request, n) : { behavior: 'deny', why: 'the second request of the scenario' });
      const first = await turn(ctx, driver, `${run(COMMANDS.once)}\n${REPORT}`, scope);
      const madeByTheFirst = existsSync(path.join(ctx.project, 'bash-once.txt'));
      const notes = { initialize: initializeFacts(driver.initializeReply), first: first.facts, fileMadeByTheFirstTurn: madeByTheFirst, outlineFirst: first.outline };
      if (first.facts.requests.length === 0) return didNotHappen('no request came for the first command', notes);
      notes.rulesAfterTheAllow = await listRules(driver, scope);
      const second = await turn(ctx, driver, `${again(COMMANDS.once)}\n${REPORT}`, scope);
      Object.assign(notes, { second: second.facts, askedAgain: second.facts.requests.length > 0, sessionId: sessionIdOf(driver), settingsFiles: settingsFiles(ctx, scope), outlineSecond: second.outline });
      return happened(notes, second.end.index);
    },
  },

  'session-rule': {
    id: 'm22-session-rule', name: 'm22-approve-session', turns: 2, family: 'm22-session-rule', files: FILES,
    title: "K2: `allow` with the CLI's own rule suggestion sent back at the `session` destination, then the same command in the next turn (C21)",
    successCondition: 'The suggestion as it came, the allow with `updatedPermissions` taken, the rule listed with its source, and whether the next turn asks',
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const { scope, driver, first } = await allowWithSuggestion(ctx, COMMANDS.session, (suggestion) => ({ ...suggestion, destination: 'session' }));
      const notes = { initialize: initializeFacts(driver.initializeReply), first: first.facts, fileMadeByTheFirstTurn: existsSync(path.join(ctx.project, 'bash-session.txt')), outlineFirst: first.outline };
      if (first.facts.requests.length === 0) return didNotHappen('no request came for the command', notes);
      if (!driver.decisions.some((decision) => decision.updatedPermissions)) return didNotHappen('the request carried no suggestion that adds an allow rule, so none was sent back', notes);
      notes.rulesAfterTheAllow = await listRules(driver, scope);
      const second = await turn(ctx, driver, `${again(COMMANDS.session)}\n${REPORT}`, scope);
      Object.assign(notes, { second: second.facts, askedAgain: second.facts.requests.length > 0, rulesAfterTheSecond: await listRules(driver, scope), settingsFiles: settingsFiles(ctx, scope), sessionId: sessionIdOf(driver), outlineSecond: second.outline });
      writeState({ claudeRuleSessionId: sessionIdOf(driver), claudeRuleAt: new Date().toISOString() });
      return happened(notes, second.end.index);
    },
  },

  resumed: {
    id: 'm22-resumed', name: 'm22-approve-resumed', turns: 1, family: 'm22-session-rule', files: FILES,
    title: "K2: the session of `session-rule` resumed in a new process, the same command asked for; if it asks, allowed with the CLI's suggestion at the destination it named (C21, C22)",
    successCondition: 'Whether the session rule is listed after the resume and whether the command asks; then what a suggestion at its own destination writes, by the rule list and the scratch folders',
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const state = readState();
      if (!state.claudeRuleSessionId) return notRun('no session with a session rule: run --scenario session-rule first');
      const scope = scopeOf(ctx, [COMMANDS.session]);
      const attempt = await ctx.tryOpen({ ...SETTLED, launch: { ...SETTLED.launch, resume: state.claudeRuleSessionId } });
      const notes = { opened: attempt.opened, exit: attempt.exit, initialize: initializeFacts(attempt.driver.initializeReply) };
      if (!attempt.opened) return didNotHappen('the resume did not open', notes);
      const driver = attempt.driver;
      notes.rulesAfterTheResume = await listRules(driver, scope);
      driver.approvalRule = allowDictated(scope, (request) => (ruleSuggestions(request).length > 0 ? { updatedPermissions: ruleSuggestions(request) } : {}));
      const only = await turn(ctx, driver, `${again(COMMANDS.session)}\n${REPORT}`, scope);
      Object.assign(notes, {
        turn: only.facts, askedAfterTheResume: only.facts.requests.length > 0, sameSession: sessionIdOf(driver, only.from) === state.claudeRuleSessionId,
        suggestionSentAtItsOwnDestination: driver.decisions.some((decision) => decision.updatedPermissions), rulesAfterTheTurn: await listRules(driver, scope), settingsFiles: settingsFiles(ctx, scope), outline: only.outline,
      });
      return happened(notes, only.end.index);
    },
  },

  destination: {
    id: 'm22-destination', name: 'm22-approve-destination', turns: 1, files: FILES,
    title: "K2, in reserve: a fresh session's command allowed with the CLI's suggestion at the destination it named (C22)",
    successCondition: 'What the suggestion writes, by `list_permission_rules` and the settings files of the scratch folders',
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const { scope, driver, first } = await allowWithSuggestion(ctx, COMMANDS.destination, (suggestion) => suggestion);
      const notes = { turn: first.facts, suggestionSentAtItsOwnDestination: driver.decisions.some((decision) => decision.updatedPermissions), rulesAfterTheTurn: await listRules(driver, scope), settingsFiles: settingsFiles(ctx, scope), outline: first.outline };
      if (!notes.suggestionSentAtItsOwnDestination) return didNotHappen('no request with a rule suggestion came', notes);
      return happened(notes, first.end.index);
    },
  },

  files: {
    id: 'm22-files', name: 'm22-approve-files', turns: 1, files: FILES,
    title: 'K2: a `Write` and an `Edit` in the working folder, a `Write` in a root handed over with `--add-dir`, and one outside every root, each allowed (C5)',
    successCondition: "Each request's shape and suggestions, and each file's state afterwards",
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const scope = scopeOf(ctx);
      const driver = await ctx.open({ ...SETTLED, launch: { ...SETTLED.launch, addDirs: [ctx.other] } });
      driver.approvalRule = allowDictated(scope);
      const rulesAtStart = await listRules(driver, scope);
      const prompt = `${STEPS}\n1. With the Write tool, create the file ${path.join(ctx.project, 'made-inside.txt')} containing the single word alpha.\n2. With the Edit tool, change the word alpha to beta in that file.\n3. With the Write tool, create the file ${path.join(ctx.other, 'made-in-added-root.txt')} containing the single word gamma.\n4. With the Write tool, create the file ${path.join(ctx.outside, 'made-outside.txt')} containing the single word delta.\nThen tell me in one line per step whether it worked.`;
      const only = await turn(ctx, driver, prompt, scope);
      const inside = path.join(ctx.project, 'made-inside.txt');
      const notes = {
        initialize: initializeFacts(driver.initializeReply), rulesAtStart, turn: only.facts,
        files: { insideMade: existsSync(inside), insideHoldsTheEdit: existsSync(inside) && /beta/.test(readFileSync(inside, 'utf8')), addedRootMade: existsSync(path.join(ctx.other, 'made-in-added-root.txt')), outsideMade: existsSync(path.join(ctx.outside, 'made-outside.txt')) },
        rulesAfterTheTurn: await listRules(driver, scope), settingsFiles: settingsFiles(ctx, scope), outline: only.outline,
      };
      if (only.facts.requests.length === 0) return didNotHappen('no request came for any write', notes);
      return happened(notes, only.end.index);
    },
  },

  'accept-edits': {
    id: 'm22-accept-edits', name: 'm22-mode-accept-edits', turns: 2, files: FILES,
    title: 'K2: a turn under `acceptEdits` set by `set_permission_mode`, the mode set back to `default` at its end, then a write that asks and a Stop with that request pending (C5, C41, C42)',
    successCondition: "What ran with no request under `acceptEdits`, the next turn's mode and its request after the restore, and the cancel frame at the Stop",
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const scope = scopeOf(ctx, [COMMANDS.underAcceptEdits, COMMANDS.version]);
      const driver = await ctx.open(SETTLED);
      const notes = { initialize: initializeFacts(driver.initializeReply), setAcceptEdits: await setMode(driver, 'acceptEdits', scope) };
      driver.approvalRule = allowDictated(scope);
      const under = await turn(ctx, driver, `${STEPS}\n1. With the Write tool, create the file ${path.join(ctx.project, 'made-under-accept-edits.txt')} containing the single word alpha.\n2. With the Bash tool, run exactly: ${COMMANDS.underAcceptEdits}\n3. With the Bash tool, run exactly: ${COMMANDS.version}\nThen tell me in one line per step whether it worked.`, scope);
      Object.assign(notes, { underAcceptEdits: under.facts, filesAfterIt: filesNow(ctx, ['made-under-accept-edits.txt', 'bash-under-accept-edits.txt']).workingFolder, outlineUnder: under.outline, setDefault: await setMode(driver, 'default', scope) });
      // The next turn's write is held: its request shows the mode is `default` again, and the Stop finds it pending.
      driver.approvalRule = () => 'hold';
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, `With the Write tool, create the file ${path.join(ctx.project, 'made-after-the-restore.txt')} containing the single word gamma. Then tell me in one short sentence whether it worked.`, { uuid });
      const hit = await ctx.frame(driver, (f) => isToolRequest(f) || typeKey(f) === 'result', from);
      if (typeKey(hit.frame) === 'result') {
        Object.assign(notes, { afterTheRestore: turnFacts(driver, from, null, scope), outlineAfter: outlineOf(driver, from, uuid) });
        return didNotHappen('the turn after the restore ended with no request: the write ran or was not tried', notes);
      }
      await sleep(2_000);
      const stopAt = driver.tree.elapsed();
      const interrupt = await driver.interrupt();
      const end = await ctx.turnEnd(driver, from);
      await sleep(2_500);
      const cancels = received(driver, from).filter((f) => typeKey(f.frame) === 'control_cancel_request');
      Object.assign(notes, {
        afterTheRestore: turnFacts(driver, from, end, scope),
        stop: {
          heldForMs: Math.round(stopAt - (driver.session.frames.find((f) => f.index === hit.index)?.ms ?? stopAt)), interruptReply: { ok: interrupt.ok, keys: interrupt.ok && interrupt.value && typeof interrupt.value === 'object' ? Object.keys(interrupt.value).sort() : null },
          cancels: cancels.map((f) => ({ index: f.index, msAfterTheStop: Math.round(f.ms - stopAt), keys: Object.keys(f.frame).sort(), namesTheRequest: f.frame.request_id === hit.frame.request_id })),
          framesAfterTheStop: received(driver, from).filter((f) => f.ms >= stopAt && typeKey(f.frame) !== 'stream_event').map((f) => ({ type: typeKey(f.frame), msAfterTheStop: Math.round(f.ms - stopAt) })),
          fileMade: existsSync(path.join(ctx.project, 'made-after-the-restore.txt')),
        },
        setDefaultAfterTheStop: await setMode(driver, 'default', scope), rulesAtTheEnd: await listRules(driver, scope), sessionId: sessionIdOf(driver), outlineAfter: outlineOf(driver, from, uuid),
      });
      return happened(notes, end.index);
    },
  },

  lost: {
    id: 'm22-lost', name: 'm22-mode-lost', family: 'm22-lost', turns: 1, files: FILES,
    title: 'K2: the process ended by force during a turn under `acceptEdits`, then the session resumed with no prompt (C53)',
    successCondition: "The mode the resumed `initialize` reply names, and the rules it lists",
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const scope = scopeOf(ctx, [COMMANDS.version]);
      const first = await ctx.open({ ...SETTLED, label: 'first' });
      const notes = { first: { initialize: initializeFacts(first.initializeReply), setAcceptEdits: await setMode(first, 'acceptEdits', scope) } };
      first.approvalRule = () => 'hold';
      const uuid = randomUUID();
      const from = await ctx.prompt(first, `${STEPS}\n1. With the Write tool, create the file ${path.join(ctx.project, 'made-before-the-loss.txt')} containing the single word alpha.\n2. With the Bash tool, run exactly: ${COMMANDS.version}\nThen tell me in one line per step whether it worked.`, { uuid });
      // The first tool result, or the first request, or the turn's end: the process is ended there, in the turn.
      const hit = await ctx.frame(first, (f) => isToolRequest(f) || typeKey(f) === 'result' || (typeKey(f) === 'user' && blocksOf(f).some((b) => b.type === 'tool_result')), from);
      const sessionId = sessionIdOf(first, from);
      Object.assign(notes.first, { endedAt: typeKey(hit.frame), turn: turnFacts(first, from, null, scope), fileMade: existsSync(path.join(ctx.project, 'made-before-the-loss.txt')), outline: outlineOf(first, from, uuid) });
      if (typeKey(hit.frame) === 'result') return didNotHappen('the turn ended before the process could be ended in it', notes);
      await sleep(800);
      const forced = await ctx.endByForce(first);
      notes.first.forcedEnd = forced;
      if (!forced.taskkillOk || !forced.exited) return didNotHappen('the process was not ended by the forced end', notes);
      if (!sessionId) return didNotHappen('no init named the session, so nothing can be resumed', notes);
      await sleep(1_000);
      const attempt = await ctx.tryOpen({ ...SETTLED, label: 'resumed', launch: { ...SETTLED.launch, resume: sessionId } });
      notes.resumed = { opened: attempt.opened, exit: attempt.exit, initialize: initializeFacts(attempt.driver.initializeReply) };
      if (!attempt.opened) return didNotHappen('the resume did not open', notes);
      notes.resumed.rules = await listRules(attempt.driver, scope);
      notes.resumed.framesBeforeAnyPrompt = received(attempt.driver).map((f) => ({ type: typeKey(f.frame), ...('permissionMode' in (f.frame ?? {}) ? { permissionMode: f.frame.permissionMode } : {}) }));
      return happened(notes, null);
    },
  },

  inherited: {
    id: 'm22-inherited', name: 'm22-inherited', turns: 1, files: { ...FILES, '.mcp.json': MCP_JSON }, preApproved: [`Bash(${COMMANDS.allowed})`, MCP_TOOL],
    title: "K2: scratch settings with an allow rule, a deny rule, an allowed MCP tool and a hook that writes a file; each asked for in one turn (C7, C23, C24)",
    successCondition: 'Which of the four acted with no request, what the deny rule brought, and how `list_permission_rules` lists the rules',
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const scope = scopeOf(ctx, [COMMANDS.allowed, COMMANDS.denied]);
      ctx.writeConfig(MCP_SCRIPT_NAME, MCP_SCRIPT);
      const hook = ctx.writeConfig(HOOK_SCRIPT_NAME, HOOK_SCRIPT);
      const settings = {
        permissions: { allow: [`Bash(${COMMANDS.allowed})`, MCP_TOOL], deny: [`Bash(${COMMANDS.denied})`] }, enableAllProjectMcpServers: true,
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${forward(hook)} ${forward(path.join(ctx.project, 'hook-wrote.txt'))}`, timeout: 30 }] }] },
      };
      ctx.writeConfig('settings.json', `${JSON.stringify(settings, null, 2)}\n`);
      const driver = await ctx.open(SETTLED);
      // Nothing is allowed by the spike here: what runs, runs by the settings alone.
      driver.approvalRule = () => ({ behavior: 'deny', why: 'this scenario allows nothing itself' });
      const rulesAtStart = await listRules(driver, scope);
      const only = await turn(ctx, driver, `${STEPS}\n1. With the Bash tool, run exactly: ${COMMANDS.allowed}\n2. With the Bash tool, run exactly: ${COMMANDS.denied}\n3. Call the tool named stamp of the MCP server ${MCP_SERVER}, with no arguments.\nThen tell me in one line per step whether it worked.`, scope);
      const notes = {
        initialize: initializeFacts(driver.initializeReply), settingsKeysWritten: Object.keys(settings).sort(), rulesAtStart, turn: only.facts,
        files: filesNow(ctx, ['allowed-by-rule.txt', 'denied-by-rule.txt', 'mcp-stamped.txt', 'hook-wrote.txt']).workingFolder,
        hookFrames: received(driver, only.from).filter((f) => /^system\/hook_/.test(typeKey(f.frame))).map((f) => ({ type: typeKey(f.frame), event: f.frame.hook_event ?? null })),
        rulesAfterTheTurn: await listRules(driver, scope), outline: only.outline,
      };
      if (only.facts.toolCalls.length === 0) return didNotHappen('the turn ended without a tool call', notes);
      return happened(notes, only.end.index);
    },
  },

  worker: {
    id: 'm22-worker', name: 'm22-approve-worker', turns: 1, files: FILES,
    title: "K2: a sub-agent's `Bash` command, its request naming the worker, allowed (C11)",
    successCondition: 'A `can_use_tool` request with an `agent_id`, the allow taken, and the file made',
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const scope = scopeOf(ctx, [COMMANDS.worker]);
      const driver = await ctx.open(SETTLED);
      driver.approvalRule = allowDictated(scope);
      const only = await turn(ctx, driver, `Use the Agent tool to hand this task to a sub-agent, and do not do it yourself: the sub-agent must run exactly this command with its Bash tool, once, and nothing else: ${COMMANDS.worker}\nIt must then report in one sentence whether the command ran. When the sub-agent is done, tell me in one sentence what it reported.`, scope);
      const notes = { turn: only.facts, fileMade: existsSync(path.join(ctx.project, 'worker-made.txt')), outline: only.outline };
      if (!only.facts.requests.some((request) => request.agentIdNamed)) return didNotHappen(only.facts.requests.length ? "a request came, but none named an agent_id: the session ran the command, not its sub-agent" : 'no request came', notes);
      return happened(notes, only.end.index);
    },
  },

  'auto-turn': {
    id: 'm22-auto', name: 'm22-mode-auto', turns: 1, files: FILES,
    title: 'K5: a turn under `auto`, launched by `--permission-mode auto`: a `Write` and two commands in the working folder, a `Write` outside every root, and a hook of the scratch settings that writes a file (C5, C51)',
    successCondition: 'The mode `initialize` and the `init` name, which tool calls ran with no request, what a request under the mode carries, what was refused and by what, and that the hook wrote its file',
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      return modeTurn(ctx, 'auto', { inside: 'made-under-auto.txt', outside: 'made-outside-under-auto.txt', command: COMMANDS.underAuto });
    },
  },

  'bypass-turn': {
    id: 'm22-bypass', name: 'm22-mode-bypass', family: 'm22-bypass', turns: 1, files: FILES,
    title: 'K5: a turn under `bypassPermissions`, launched by `--permission-mode bypassPermissions` and no flag that bypasses permissions: the same four steps and the hook; then the session resumed, with no prompt, under `default` and under `acceptEdits` (C5, C47, C51, C74)',
    successCondition: 'The mode `initialize` and the `init` name, that nothing asks and which files are made, and the mode each resume names: out of Bypass by a restart, and a resume under `acceptEdits`',
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const first = await modeTurn(ctx, 'bypassPermissions', { inside: 'made-under-bypass.txt', outside: 'made-outside-under-bypass.txt', command: COMMANDS.underBypass, label: 'main', keep: true });
      if (first.outcome !== 'happened') return first;
      const { driver, sessionId, successIndex } = first.kept;
      const notes = first.notes;
      await ctx.close(driver);
      await sleep(1_000);
      // No prompt from here on: each resume is a fresh process under another mode's argument, and its `initialize` reply names the mode.
      notes.resumes = [];
      if (!sessionId) return didNotHappen('no init named the session, so nothing can be resumed', notes);
      for (const mode of ['default', 'acceptEdits']) {
        const attempt = await ctx.tryOpen({ ...SETTLED, label: `resumed-${mode}`, launch: { ...SETTLED.launch, permissionMode: mode, resume: sessionId } });
        await sleep(500);
        notes.resumes.push({ launchedWith: mode, opened: attempt.opened, exit: attempt.exit, ...initializeFacts(attempt.driver.initializeReply), framesBeforeAnyPrompt: attempt.stdoutFrames.map((f) => f.type) });
        // Launched otherwise, the mode cannot be entered again by a set (K2): asked once more here, after a turn ran under it.
        if (attempt.opened && mode === 'default') notes.resumes.at(-1).setBypass = await setMode(attempt.driver, 'bypassPermissions', scopeOf(ctx));
        await ctx.close(attempt.driver);
        await sleep(800);
      }
      return happened(notes, successIndex);
    },
  },

  'worker-mode': {
    id: 'm22-worker-mode', name: 'm22-mode-worker', turns: 1, files: FILES,
    title: "K5: a sub-agent's `Write` and `Bash` command in a session launched by `--permission-mode acceptEdits` (C5, C11, C51)",
    successCondition: "Whether the worker's tool calls ask as a session's would under `default`, or run with no request as the session's own do under `acceptEdits`, and what a worker's request names",
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const scope = scopeOf(ctx, [COMMANDS.workerMode]);
      const attempt = await ctx.tryOpen({ ...SETTLED, launch: { ...SETTLED.launch, permissionMode: 'acceptEdits' } });
      const notes = { opened: attempt.opened, exit: attempt.exit, initialize: initializeFacts(attempt.driver.initializeReply) };
      if (!attempt.opened) return didNotHappen('the launch under acceptEdits did not open', notes);
      if (notes.initialize.currentPermissionMode !== 'acceptEdits') return didNotHappen('the launch did not report acceptEdits: no prompt is sent', notes);
      const driver = attempt.driver;
      driver.approvalRule = allowDictated(scope);
      const only = await turn(ctx, driver, `Use the Agent tool to hand this task to a sub-agent, and do not do it yourself. The sub-agent must do these two steps in this order, each with the tool it names and no other tool, and go on to the second if the first is refused:\n1. With the Write tool, create the file ${path.join(ctx.project, 'worker-wrote.txt')} containing the single word alpha.\n2. With the Bash tool, run exactly: ${COMMANDS.workerMode}\nIt must then report in one line per step whether it worked. When the sub-agent is done, tell me in one sentence what it reported.`, scope);
      Object.assign(notes, { turn: only.facts, workerCalls: only.facts.toolCalls.filter((call) => call.worker).map((call) => ({ tool: call.tool, asked: call.asked, result: call.result })), files: filesNow(ctx, ['worker-wrote.txt', 'worker-mode-made.txt']).workingFolder, outline: only.outline });
      if (!only.facts.toolCalls.some((call) => call.worker)) return didNotHappen('no tool call was a sub-agent\'s: the session did the task itself, or did nothing', notes);
      return happened(notes, only.end.index);
    },
  },

  permissions: {
    id: 'm22-cmd-permissions', name: 'm22-cmd-permissions', turns: 1, atMost: true, files: FILES,
    title: 'K2: `/permissions` as a prompt, under the launch without `--disable-slash-commands` (C7)',
    successCondition: "The CLI's own answer or a model's, and whether a mode or a rule changed",
    async run(ctx) {
      const stop = needsModel(ctx);
      if (stop) return stop;
      const scope = scopeOf(ctx);
      const driver = await ctx.open(SETTLED);
      const rulesBefore = await listRules(driver, scope);
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, '/permissions', { uuid });
      const result = await ctx.maybeFrame(driver, (f) => typeKey(f) === 'result', from, 120_000);
      await sleep(2_000);
      const assistants = framesOf(driver, 'assistant', from);
      const resultFrame = result?.frame ?? null;
      const init = initOf(driver, from)?.frame ?? null;
      const notes = {
        answeredByTheCliItself: assistants.some((f) => f.frame.message?.model === '<synthetic>'), answeredByTheModel: assistants.some((f) => f.frame.message?.model !== '<synthetic>'),
        resultCame: resultFrame !== null, result: resultFrame ? { subtype: resultFrame.subtype ?? null, isError: resultFrame.is_error === true, numTurns: resultFrame.num_turns ?? null, resultWords: tidy(typeof resultFrame.result === 'string' ? resultFrame.result : null, scope) } : null,
        processEnded: Boolean(driver.tree?.exitInfo), requests: requestsOf(driver, from, scope).length, modeFrames: modeFrames(driver, from),
        commandListed: Array.isArray(init?.slash_commands) ? init.slash_commands.includes('permissions') : null, lifecycle: framesOf(driver, 'command_lifecycle', from).map((f) => ({ state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid })),
        rulesBefore, rulesAfter: driver.tree?.exitInfo ? null : await listRules(driver, scope), settingsFiles: settingsFiles(ctx, scope), typeCounts: typeCounts(driver, typeKey, from), outline: outlineOf(driver, from, uuid),
      };
      return happened(notes, result?.index ?? null);
    },
  },
};

/** The scenarios of one planned run of each, in their order; `destination` is the reserve for a case `resumed` did not produce. */
const PLANNED = ['modes', 'once', 'session-rule', 'resumed', 'files', 'accept-edits', 'lost', 'inherited', 'worker', 'permissions'];

if (isMain(import.meta.url)) {
  await runSpike('m22-k2', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(13)} ${String(scenario.turns).padStart(2)} prompt(s)${scenario.atMost ? ' at most' : ''}${PLANNED.includes(key) ? '' : ' (reserve)'}  ${scenario.title}`);
      log(`total: ${PLANNED.reduce((sum, key) => sum + SCENARIOS[key].turns, 0)} prompts for one run of each planned scenario, of the twelve K2 may spend (C33)`);
      return 0;
    }
    const scenario = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m22/k2.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--path <executable>]`); return 1; }
    log(`K2: M16's launch as M20b leaves it, with ${EXTRA.join(' ')} and --tools ${EXECUTION_TOOLS.join(',')}; background tasks off; the scratch configuration folder`);
    return runScenario('m22-k2', scenario, frame, OPTIONS);
  });
}
