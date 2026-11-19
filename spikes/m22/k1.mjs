// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M22 spike K1 (docs/planning/_archive/M22-spec-sheet.md; C4, C7, C21–C24): Codex's sandbox and approval
// combinations at `thread/start` and `thread/resume`, its approval requests for a command and a
// file change answered `accept`, `acceptForSession` and `decline`, an override on `turn/start`, and
// what an execpolicy amendment writes, under production's handshake as M19 leaves it (M20a, C15).
//
// It runs in a scratch configuration folder of its own, signed in by the maintainer, with
// `CODEX_HOME` naming it (C33): the maintainer's own Codex configuration is neither read nor
// changed. The folder is in the user's profile folder, beside where `.codex` is: not under the temp
// folder, since Codex makes no helper binaries there, and not under %LOCALAPPDATA%, where Windows
// redirects what a packaged application writes — an agent's session in one saw a folder there
// that the maintainer's own terminal did not.
//
//   node spikes/m22/k1.mjs --list
//   node spikes/m22/k1.mjs --scenario <name> --confirm-turns <n> [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C33). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m22). `start`, `trust`, `resume`, `config` and `reviewer` send no prompt; `resume`
// reads the thread `override` left, and `reviewer` the one `reviewer-turn` left; `file-session-same`
// is the retry of `file-session`'s case. `reviewer-turn` and `reviewer` are the sheet's K4 cases
// for who answers a request (C70): the first sends one prompt at most. K4's remaining cases, run at
// the acceptance (C51, V26), are `berserk-turn`, `auto-review`, `ask-first-files`, `sandbox-temp`
// and `read-only-turn`: six prompts at most between them. `berserk-turn` runs one turn under full
// access with no approval, its prompt dictating two commands and one file, each in a scratch folder.
//
// The spike accepts only what its own prompt dictated: a command that holds the prompt's own
// command and no other, in a scratch folder, and a file change whose every path is in a scratch
// folder. Any other request is declined, and a request for more permissions is granted nothing.
// `windowsSandbox/setupStart` changes the machine: it is sent by the `setup` scenario alone, which
// the maintainer runs from their own terminal, naming the mode.
//
// What a run records is never a text of the model's: each reply's policy fields, each request's
// fields and what came with it, the reply the spike sent, each item's status, and which files the
// scratch folders hold afterwards.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { checkSessionStart } from '../m10/codex/driver.mjs';
import { EXIT, settlesWithin, sleep } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { forceEnd } from '../m10/lib/proctree.mjs';
import { buildScratch } from '../m10/lib/scratch.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { CliExited } from '../m10/lib/wire.mjs';
import { codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { instanceEnvironment } from '../m14b/lib/instance-env.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, received } from '../m19/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { M22_DIR, cut, inFolder, readState, typeCounts, whereIs, writeState } from './lib/common.mjs';

/** The scratch configuration folder (C33): made for this spike in the user's profile folder, signed in by the maintainer. */
export const CODEX_HOME = path.join(homedir(), '.fat-g-spike-m22', 'codex-home');

const COMMAND_REQUEST = 'item/commandExecution/requestApproval';
const FILE_REQUEST = 'item/fileChange/requestApproval';
const PERMISSIONS_REQUEST = 'item/permissions/requestApproval';
const APPROVALS = new Set([COMMAND_REQUEST, FILE_REQUEST, PERMISSIONS_REQUEST]);
const RESOLVED = 'serverRequest/resolved';
const STATUS = 'thread/status/changed';
const SETTINGS = 'thread/settings/updated';

/** M19's driver under production's handshake, every approval request going to the scenario's rule: a decision, or `hold`. */
class K1Driver extends M19CodexDriver {
  constructor(options) {
    super(options);
    this.approvalRule = null;
    this.decisions = [];
    this.held = [];
  }

  incoming(frame, index) {
    if (!frame || frame.id === undefined || !APPROVALS.has(frame.method)) { super.incoming(frame, index); return; }
    this.requestsSeen.push({ kind: frame.method, requestKind: 'approval' });
    const plan = this.approvalRule?.(frame.method, frame.params ?? {}, this.decisions.length, this) ?? { decision: 'decline', why: 'no rule' };
    const entry = { id: frame.id, index, atMs: this.tree.elapsed(), method: frame.method };
    if (plan === 'hold') { this.held.push(entry); this.requestsSeen.at(-1).answer = 'held'; return; }
    // A request for more permissions is granted nothing, whatever the rule says: an empty set for the turn.
    const result = frame.method === PERMISSIONS_REQUEST ? { permissions: {}, scope: 'turn' } : { decision: plan.decision };
    this.decisions.push({ ...entry, result, why: plan.why ?? null });
    this.requestsSeen.at(-1).answer = JSON.stringify(result).slice(0, 80);
    this.session.send({ id: frame.id, result }).catch(() => {});
  }
}

/** A one-shot command in the scratch configuration, through the launcher's confirmed teardown. */
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
  dir: M22_DIR, milestone: 'M22', Driver: K1Driver, omitted: OMITTED_CODEX, environment, ready,
  toolPermissions: (scenario) => ({ readTools: 'reads inside the sandbox', scenarioTools: scenario.tools ?? [], preApproved: [], sandbox: scenario.profile?.sandbox ?? 'per thread/start, as each scenario names it', approvalPolicy: scenario.profile?.approvalPolicy ?? 'per thread/start', reviewer: 'user', policy: "an approval request for what the prompt dictated — a command that holds the prompt's own and no other, in a scratch folder, or a file change whose paths are all in scratch folders — is answered as the scenario says; any other is declined, and a request for more permissions is granted nothing" }),
};

/** The scratch folders a path is placed in. `second` stands for a second root of the project, which Codex is not given (C4). */
function scopeOf(ctx, snippets = []) {
  const second = buildScratch('m22Second', { 'second.txt': 'The ferry to the island leaves at seven, and its bell is painted green.\n' });
  ctx.second = second;
  return { snippets, folders: { 'working folder': ctx.scratch, 'outside the folder': ctx.outside, 'second root': second.dir, 'configuration folder': CODEX_HOME, 'app-server folder': ctx.probe }, writable: [ctx.scratch, ctx.outside, second.dir] };
}

/** A CLI's text with the scratch folders named, and nothing of a path that is none of them. */
function tidy(text, scope, units = 300) {
  if (typeof text !== 'string') return null;
  let out = text;
  for (const [name, dir] of Object.entries(scope.folders).sort(([, a], [, b]) => b.length - a.length)) {
    for (const spelling of [dir, dir.split(path.sep).join('/'), dir.split(path.sep).join('\\\\')]) out = out.split(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).join(`<${name}>`);
  }
  return out.toLowerCase().includes(userInfo().username.toLowerCase()) ? `<${text.length} units, naming a path>` : cut(out, units);
}

/** The `fileChange` item a request names, from the frames received so far. */
const itemOf = (driver, itemId) => received(driver).map((f) => f.frame).filter((f) => (f?.method === 'item/started' || f?.method === 'item/completed') && f.params?.item?.id === itemId).at(-1)?.params.item ?? null;

/** A command line with its quotes gone and its slashes leaning one way, in lower case: how two spellings of one command are compared. */
const plain = (text) => String(text).replace(/["']/g, '').replace(/\\+/g, '\\').replace(/\//g, '\\').toLowerCase();

/** Whether a request is for what the scenario's prompt dictated: the only kind the spike accepts. */
function dictated(driver, method, params, scope) {
  if (method === COMMAND_REQUEST) {
    if (typeof params.command !== 'string' || !scope.writable.some((dir) => inFolder(params.cwd, dir))) return false;
    const command = plain(params.command);
    const snippet = scope.snippets.map(plain).find((text) => command.includes(text));
    // The prompt's own command and no other: what is left of the string once it is taken out holds no separator.
    return snippet !== undefined && !/[;&|`\n\r]|\$\(/.test(command.replace(snippet, ''));
  }
  if (method === FILE_REQUEST) {
    const changes = itemOf(driver, params.itemId)?.changes;
    return Array.isArray(changes) && changes.length > 0 && changes.every((change) => scope.writable.some((dir) => inFolder(change?.path, dir)));
  }
  return false;
}

/** Answers what was dictated with `decide(method, params, n)`'s decision, and declines the rest. */
const answerDictated = (scope, decide = () => 'accept') => (method, params, n, driver) => (dictated(driver, method, params, scope) ? { decision: decide(method, params, n) } : { decision: 'decline', why: 'not what the prompt dictated' });

const policyOf = (value) => (typeof value === 'string' ? value : value && typeof value === 'object' ? { keys: Object.keys(value).sort(), ...('granular' in value ? { granular: value.granular } : {}) } : value ?? null);
const sandboxOf = (sandbox, scope) => (sandbox && typeof sandbox === 'object' ? { type: sandbox.type ?? null, keys: Object.keys(sandbox).sort(), networkAccess: sandbox.networkAccess ?? null, writableRoots: Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots.map((root) => whereIs(root, scope.folders)) : null, excludeTmpdirEnvVar: sandbox.excludeTmpdirEnvVar ?? null, excludeSlashTmp: sandbox.excludeSlashTmp ?? null } : sandbox ?? null);

/** What a `thread/start` or `thread/resume` reply, or a settings notification, says of the policy in force. */
function policyFacts(value, scope) {
  if (!value || typeof value !== 'object') return null;
  return {
    sandbox: sandboxOf(value.sandbox ?? value.sandboxPolicy, scope), approvalPolicy: policyOf(value.approvalPolicy), approvalsReviewer: value.approvalsReviewer ?? null,
    activePermissionProfile: 'activePermissionProfile' in value ? value.activePermissionProfile : 'absent',
    runtimeWorkspaceRoots: 'runtimeWorkspaceRoots' in value ? (Array.isArray(value.runtimeWorkspaceRoots) ? value.runtimeWorkspaceRoots.map((root) => whereIs(root, scope.folders)) : value.runtimeWorkspaceRoots) : 'absent',
    cwd: whereIs(value.cwd, scope.folders),
  };
}

const errorOf = (reply, scope) => (reply.ok ? null : { code: reply.error?.code ?? null, message: tidy(String(reply.error?.message ?? ''), scope) });

/** One `thread/start` under `params`, ephemeral unless it says otherwise: taken or refused, and what the reply reports. */
async function tryStart(driver, ctx, scope, label, params) {
  const from = driver.nextIndex;
  const reply = await driver.requestWithin('thread/start', { cwd: ctx.scratch, ephemeral: true, ...params }, 30_000);
  await sleep(400);
  const notifications = received(driver, from).filter((f) => f.frame?.method && f.index !== reply.index).map((f) => f.frame.method);
  return { label, asked: Object.fromEntries(Object.entries(params).map(([key, value]) => [key, key === 'runtimeWorkspaceRoots' ? value.map((root) => whereIs(root, scope.folders)) : value])), ok: reply.ok, error: errorOf(reply, scope), reported: reply.ok ? policyFacts(reply.value, scope) : null, replyKeys: reply.ok ? Object.keys(reply.value ?? {}).sort() : null, notifications: [...new Set(notifications)] };
}

/** The combinations a mode could map to (C4), and the fields the plain handshake may not send. */
const combinations = (scope) => [
  ['restricted, as today', { sandbox: 'read-only', approvalPolicy: 'never' }],
  ['workspace-write, untrusted', { sandbox: 'workspace-write', approvalPolicy: 'untrusted' }],
  ['workspace-write, on-request', { sandbox: 'workspace-write', approvalPolicy: 'on-request' }],
  ['workspace-write, on-request, reviewer user', { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' }],
  ['workspace-write, on-request, reviewer auto_review', { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }],
  ['workspace-write, on-request, reviewer guardian_subagent', { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'guardian_subagent' }],
  ['workspace-write, never', { sandbox: 'workspace-write', approvalPolicy: 'never' }],
  ['workspace-write, granular', { sandbox: 'workspace-write', approvalPolicy: { granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } } }],
  ['read-only, on-request', { sandbox: 'read-only', approvalPolicy: 'on-request' }],
  ['read-only, untrusted', { sandbox: 'read-only', approvalPolicy: 'untrusted' }],
  ['danger-full-access, on-request', { sandbox: 'danger-full-access', approvalPolicy: 'on-request' }],
  ['danger-full-access, never', { sandbox: 'danger-full-access', approvalPolicy: 'never' }],
  ['no policy named', {}],
  ['experimental: a named profile', { permissions: ':workspace', approvalPolicy: 'on-request' }],
  ['experimental: runtime workspace roots', { sandbox: 'workspace-write', approvalPolicy: 'on-request', runtimeWorkspaceRoots: [scope.folders['working folder'], scope.folders['second root']] }],
];

/** The entries of the scratch configuration folder, by name: what a run added is read from two of these. */
const homeEntries = () => {
  const out = [];
  const walk = (dir, depth) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); const name = path.relative(CODEX_HOME, full).split(path.sep).join('/'); if (entry.isDirectory()) { if (depth < 1 && !['log', 'tmp', 'sessions'].includes(entry.name)) walk(full, depth + 1); else out.push(`${name}/`); } else out.push(name.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>')); } };
  walk(CODEX_HOME, 0);
  return out.sort();
};

/**
 * The projects the scratch configuration's own `config.toml` names, by scratch folder, with each one's
 * trust level: the one file of that folder the spike reads, for what the CLI wrote into it. Never `auth.json`.
 */
function trustEntries(scope) {
  const file = path.join(CODEX_HOME, 'config.toml');
  if (!existsSync(file)) return { exists: false, projects: [], otherTables: [] };
  const projects = [];
  const otherTables = [];
  const windows = {};
  let inWindows = false;
  let current = null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const table = /^\[(.+)\]\s*$/.exec(line.trim());
    if (table) {
      const project = /^projects\.(['"])(.*)\1$/.exec(table[1]);
      current = project ? { folder: whereIs(project[2].replace(/\\\\/g, '\\'), scope.folders), trustLevel: null } : null;
      if (current) projects.push(current); else otherTables.push(table[1].split('.')[0]);
      inWindows = table[1] === 'windows';
      continue;
    }
    const level = /^trust_level\s*=\s*"([^"]*)"/.exec(line.trim());
    if (level && current) current.trustLevel = level[1];
    const setting = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line.trim());
    if (inWindows && setting) windows[setting[1]] = setting[2].replace(/^"|"$/g, '');
  }
  return { exists: true, projects, otherTables: [...new Set(otherTables)], windows };
}


// ── Turns ──────────────────────────────────────────────────────────────────────────────────────
const say = (command) => 'Run exactly this shell command, once, and nothing else: ' + command;
const sayAgain = (command) => 'Run exactly the same shell command again, once, even though it ran before: ' + command;
const REPORT = 'Then tell me in one short sentence whether it ran. If it is refused or fails, say so in one sentence and stop: do not try another way.';

/** A turn as the app starts one (session.ts), plus what the scenario adds; counted once Codex took it. */
async function startTurn(driver, ctx, textOfPrompt, model, extra = {}) {
  const from = driver.nextIndex;
  const params = { threadId: driver.threadId, input: [{ type: 'text', text: textOfPrompt, text_elements: [] }], model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID(), ...extra };
  const reply = await driver.requestWithin('turn/start', params, 15_000);
  if (reply.ok) { ctx.countTurn(); driver.turnId = reply.value?.turn?.id ?? null; driver.turnActive = true; }
  return { from, ok: reply.ok, turnId: driver.turnId, error: reply.ok ? null : { code: reply.error?.code ?? null, message: String(reply.error?.message ?? '').slice(0, 200) } };
}

const framesOf = (driver, method, from) => received(driver, from).filter((f) => f.frame?.method === method);
const decisionName = (value) => (typeof value === 'string' ? value : value && typeof value === 'object' ? Object.keys(value)[0] ?? null : null);

/** What an approval request says of itself, the reply the spike sent, and what settled it. Never a command's or a change's text. */
function requestFacts(driver, entry, from, scope) {
  const params = entry.frame.params ?? {};
  const method = entry.frame.method;
  const own = dictated(driver, method, params, scope);
  const decision = driver.decisions.find((d) => d.id === entry.frame.id) ?? null;
  const held = driver.held.some((h) => h.id === entry.frame.id);
  const settledAt = decision?.atMs ?? null;
  const resolved = framesOf(driver, RESOLVED, from).find((f) => String(f.frame.params?.requestId) === String(entry.frame.id)) ?? null;
  const item = itemOf(driver, params.itemId);
  const facts = {
    index: entry.index, method, keys: Object.keys(params).sort(), idIsA: typeof entry.frame.id, isWhatThePromptDictated: own, worker: params.threadId !== driver.threadId,
    reasonUnits: typeof params.reason === 'string' ? params.reason.length : null,
    answer: decision ? { result: decision.result, why: decision.why, msAfterTheRequest: Math.round(decision.atMs - entry.ms) } : held ? 'held' : null,
    resolved: resolved ? { index: resolved.index, msAfterTheAnswer: settledAt === null ? null : Math.round(resolved.ms - settledAt), paramKeys: Object.keys(resolved.frame.params ?? {}).sort() } : null,
    statusWhilePending: framesOf(driver, STATUS, from).filter((f) => f.index < entry.index).slice(-1).map((f) => f.frame.params?.status?.activeFlags ?? null)[0] ?? null,
    item: item ? { type: item.type, status: item.status ?? null, ...(item.type === 'commandExecution' ? { exitCode: item.exitCode ?? null } : {}) } : null,
  };
  if (method === COMMAND_REQUEST) {
    Object.assign(facts, {
      cwd: whereIs(params.cwd, scope.folders), commandUnits: typeof params.command === 'string' ? params.command.length : null, kind: params.kind ?? null,
      commandActions: Array.isArray(params.commandActions) ? params.commandActions.map((action) => action?.type ?? null) : params.commandActions ?? null,
      availableDecisions: Array.isArray(params.availableDecisions) ? params.availableDecisions.map(decisionName) : params.availableDecisions === undefined ? 'absent' : params.availableDecisions,
      proposedExecpolicyAmendment: Array.isArray(params.proposedExecpolicyAmendment) ? (own ? params.proposedExecpolicyAmendment.map((part) => tidy(String(part), scope, 120)) : params.proposedExecpolicyAmendment.length + ' part(s)') : params.proposedExecpolicyAmendment ?? null,
      proposedNetworkPolicyAmendments: Array.isArray(params.proposedNetworkPolicyAmendments) ? params.proposedNetworkPolicyAmendments.length : params.proposedNetworkPolicyAmendments ?? null,
      approvalIdNamed: typeof params.approvalId === 'string', networkApprovalContext: params.networkApprovalContext ? true : null, additionalPermissions: params.additionalPermissions ? Object.keys(params.additionalPermissions).sort() : null,
    });
  } else if (method === FILE_REQUEST) {
    Object.assign(facts, { grantRoot: typeof params.grantRoot === 'string' ? whereIs(params.grantRoot, scope.folders) : params.grantRoot ?? null, changes: Array.isArray(item?.changes) ? item.changes.map((change) => ({ where: whereIs(change?.path, scope.folders), kind: change?.kind?.type ?? null, diffUnits: typeof change?.diff === 'string' ? change.diff.length : null })) : null });
  } else {
    Object.assign(facts, { cwd: whereIs(params.cwd, scope.folders), permissionKeys: Object.keys(params.permissions ?? {}).sort() });
  }
  return facts;
}

const requestsOf = (driver, from, scope) => received(driver, from).filter((f) => f.frame?.id !== undefined && APPROVALS.has(f.frame?.method)).map((entry) => requestFacts(driver, entry, from, scope));

/** A turn's items and end from 'from' on, by type and status: which commands and changes ran, and whether a request named each. */
function turnFacts(driver, from, scope) {
  const all = received(driver, from);
  const asked = new Set(all.filter((f) => f.frame?.id !== undefined && APPROVALS.has(f.frame?.method)).map((f) => f.frame.params?.itemId));
  const completed = all.filter((f) => f.frame?.method === 'item/completed').map((f) => ({ item: f.frame.params.item ?? {}, worker: f.frame.params.threadId !== driver.threadId }));
  const end = all.find((f) => f.frame?.method === 'turn/completed' && f.frame.params?.threadId === driver.threadId);
  const methods = {};
  for (const f of all) if (f.frame?.method && f.frame.method !== CODEX_TEXT_DELTA) methods[f.frame.method] = (methods[f.frame.method] ?? 0) + 1;
  return {
    requests: requestsOf(driver, from, scope),
    commands: completed.filter(({ item }) => item.type === 'commandExecution').map(({ item, worker }) => ({ status: item.status ?? null, exitCode: item.exitCode ?? null, asked: asked.has(item.id), worker, cwd: whereIs(item.cwd, scope.folders), isThePromptsOwn: typeof item.command === 'string' && scope.snippets.some((snippet) => item.command.includes(snippet)), actions: Array.isArray(item.commandActions) ? item.commandActions.map((action) => action?.type ?? null) : null, outputUnits: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.length : null })),
    fileChanges: completed.filter(({ item }) => item.type === 'fileChange').map(({ item, worker }) => ({ status: item.status ?? null, asked: asked.has(item.id), worker, changes: Array.isArray(item.changes) ? item.changes.map((change) => ({ where: whereIs(change?.path, scope.folders), kind: change?.kind?.type ?? null })) : null })),
    otherItems: completed.filter(({ item }) => !['commandExecution', 'fileChange', 'agentMessage', 'userMessage', 'reasoning'].includes(item.type)).map(({ item }) => item.type),
    settings: framesOf(driver, SETTINGS, from).map((f) => ({ index: f.index, ...policyFacts(f.frame.params?.threadSettings, scope) })),
    statuses: framesOf(driver, STATUS, from).map((f) => ({ index: f.index, type: f.frame.params?.status?.type ?? null, activeFlags: f.frame.params?.status?.activeFlags ?? null })),
    errors: framesOf(driver, 'error', from).map((f) => ({ willRetry: f.frame.params?.willRetry ?? null, keys: Object.keys(f.frame.params?.error ?? {}).sort() })),
    warnings: all.filter((f) => ['warning', 'configWarning', 'windows/worldWritableWarning', 'guardianWarning'].includes(f.frame?.method)).map((f) => f.frame.method),
    end: end ? { index: end.index, status: end.frame.params.turn?.status ?? null, error: end.frame.params.turn?.error ? Object.keys(end.frame.params.turn.error).sort() : null } : null,
    methods,
  };
}

const outlineOf = (driver, from) => codex.outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA && row.method !== 'thread/tokenUsage/updated' && row.method !== 'mcpServer/startupStatus/updated');

/** One prompt through to its turn's end. */
async function turn(ctx, driver, textOfPrompt, model, scope, extra = {}) {
  const started = await startTurn(driver, ctx, textOfPrompt, model, extra);
  if (!started.ok) return { ...started, refused: true, facts: null, outline: outlineOf(driver, started.from) };
  const end = await ctx.turnEnd(driver, started.from);
  await sleep(1_500);
  return { ...started, refused: false, end, facts: turnFacts(driver, started.from, scope), outline: outlineOf(driver, started.from) };
}

/** A saved thread in the working folder under 'profile', as the app would ask for it; the reply says what Codex took. */
async function openThread(ctx, driver, scope, profile, model) {
  const params = { cwd: ctx.scratch, ...profile, model: model.model };
  const reply = await driver.startThread(params);
  driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(profile, reply.value) : null };
  return { ok: reply.ok, error: errorOf(reply, scope), asked: profile, reported: reply.ok ? policyFacts(reply.value, scope) : null, matchesWhatWasAsked: reply.ok ? driver.sessionStart.check.passed : null };
}

/** Resumes a saved thread as the app does, with what 'extra' adds: the reply says what policy the thread has. */
async function resumeThread(ctx, driver, scope, threadId, extra = {}) {
  const params = { threadId, cwd: ctx.scratch, excludeTurns: true, ...extra };
  const reply = await driver.resumeThread(params);
  driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(extra, reply.value) : null };
  return { ok: reply.ok, error: errorOf(reply, scope), asked: extra, reported: reply.ok ? policyFacts(reply.value, scope) : null, matchesWhatWasAsked: reply.ok ? driver.sessionStart.check.passed : null };
}

/** A prompt that asks for one apply_patch per file, in order: [[folder, name, word], …]. */
const patchPrompt = (files) => 'Use your apply_patch tool, not a shell command, to create ' + (files.length === 1 ? 'this file' : 'these files, one patch each, in this order; if one is refused or fails, say so and go on to the next') + ':\n' + files.map(([folder, name, word], i) => (i + 1) + '. ' + path.join(folder, name) + ' containing the single word ' + word + '.').join('\n') + '\nThen tell me in one line per file whether it was created. Do not try another way for a file that is refused.';

const filesIn = (ctx, names) => ({ workingFolder: Object.fromEntries(names.map((name) => [name, existsSync(path.join(ctx.scratch, name))])), outsideTheFolder: Object.fromEntries(names.map((name) => [name, existsSync(path.join(ctx.outside, name))])), secondRoot: Object.fromEntries(names.map((name) => [name, existsSync(path.join(ctx.second.dir, name))])) });
const modelOf = () => readState().codexModel ?? null;

/** The profile these scenarios ask for: the one C4 names, with an approval policy that asks before a command that is not known to be safe. */
const ASKING = Object.freeze({ sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
const COMMANDS = Object.freeze({ once: 'echo k1 > k1-once.txt', session: 'echo k1 > k1-session.txt', onRequest: 'echo k1 > k1-on-request.txt', override: 'echo k1 > k1-override.txt', worker: 'echo k1 > k1-worker.txt', amendment: 'echo k1 > k1-amendment.txt' });


// ── A thread with a real sandbox (once Codex's setup had run on the scratch configuration) ──
/**
 * Two folders the sandbox does not hold writable: in the profile folder, beside the scratch
 * configuration and under its marker. The other scratch folders are under the temp folder, which a
 * workspace-write sandbox leaves writable ('excludeTmpdirEnvVar: false'), so they cannot stand for
 * "outside". Rebuilt per run.
 */
function beyondScope(ctx, snippets = []) {
  const parent = path.dirname(CODEX_HOME);
  if (!existsSync(path.join(parent, '.fat-g-spike'))) throw new Error('the scratch parent has no marker: not touching it');
  const make = (name) => {
    const dir = path.join(parent, name);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const outside = make('outside');
  const second = make('second');
  return { snippets, outside, second, folders: { 'working folder': ctx.scratch, 'outside the folder': outside, 'second root': second, 'configuration folder': CODEX_HOME, 'app-server folder': ctx.probe }, writable: [ctx.scratch, outside, second] };
}

const SANDBOXED = Object.freeze({ sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
const ASK_FIRST = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
const TWO_STEPS = 'Do these two steps in this order, and go on to the second whatever the first does. Do not change a command. If one is blocked you may ask, once, for approval to run that same command; if that is refused, say so and go on.';

/** Where a request's action would land: its item's first path for a file change, the folder its command names for a command. */
function landsIn(driver, method, params, scope) {
  if (method === FILE_REQUEST) return whereIs(itemOf(driver, params.itemId)?.changes?.[0]?.path, scope.folders);
  const command = plain(params.command ?? '');
  for (const [name, dir] of Object.entries(scope.folders)) if (name !== 'working folder' && command.includes(plain(dir))) return name;
  return whereIs(params.cwd, scope.folders);
}

/** A scenario of one prompt in a thread started under 'profile': its requests answered by 'decide(where)'. */
async function sandboxTurn(ctx, profile, scope, textOfPrompt, decide, { needs = null } = {}) {
  const model = modelOf();
  if (!model?.model) return { stop: codex.notRun('no model chosen: run --scenario start first') };
  const driver = await ctx.open();
  const readiness = await driver.requestWithin('windowsSandbox/readiness', undefined, 30_000);
  const thread = await openThread(ctx, driver, scope, profile, model);
  const notes = { readiness: readiness.ok ? readiness.value?.status ?? null : errorOf(readiness, scope), thread };
  if (!thread.ok) return { stop: codex.didNotHappen('thread/start was refused', notes) };
  if (needs && thread.reported?.sandbox?.type !== needs) return { stop: codex.didNotHappen('the thread did not start under ' + needs + ': no turn is sent', notes) };
  driver.approvalRule = (method, params, n, d) => {
    if (!dictated(d, method, params, scope)) return { decision: 'decline', why: 'not what the prompt dictated' };
    const where = landsIn(d, method, params, scope);
    const decision = decide(where);
    return { decision, why: decision === 'decline' ? 'the scenario declines what lands ' + where : null };
  };
  const only = await turn(ctx, driver, textOfPrompt, model, scope);
  if (only.refused) return { stop: codex.didNotHappen('turn/start was refused', { ...notes, turn: only.error }) };
  Object.assign(notes, { turn: only.facts, requestsLandIn: received(driver, only.from).filter((f) => f.frame?.id !== undefined && APPROVALS.has(f.frame?.method)).map((f) => landsIn(driver, f.frame.method, f.frame.params ?? {}, scope)), outline: only.outline });
  return { notes, end: only.end };
}

// ── K4's remaining cases (at the acceptance: C51, V26) ─────────────────────────────
const BERSERK = Object.freeze({ sandbox: 'danger-full-access', approvalPolicy: 'never' });
const READ_ONLY = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never' });
const AUTO_REVIEWED = Object.freeze({ sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
const STEPS_IN_ORDER = 'Do these steps in this order, and go on to the next whatever one does. Do not change a command. If a step is blocked you may ask, once, for approval to run that same command or make that same change; if that is refused, say so and go on.';

/** A start or resume reply's own policy as a turn names it again (C7): the reviewer only where the mode names one (C70). */
const repeatOf = (value, { reviewer }) => ({ approvalPolicy: value.approvalPolicy, sandboxPolicy: value.sandbox, ...(reviewer ? { approvalsReviewer: value.approvalsReviewer } : {}) });

/** One prompt whose turn/start is tried in each form in turn: a refused one spends nothing, and the first one taken is the run's turn. */
async function turnInForms(ctx, driver, textOfPrompt, model, scope, forms) {
  const attempts = [];
  for (const [label, extra] of forms) {
    const attempt = await turn(ctx, driver, textOfPrompt, model, scope, extra);
    attempts.push({ label, named: { ...extra, ...(extra.sandboxPolicy ? { sandboxPolicy: sandboxOf(extra.sandboxPolicy, scope) } : {}) }, taken: !attempt.refused, error: attempt.refused ? attempt.error : null });
    if (!attempt.refused) return { attempts, ran: attempt };
  }
  return { attempts, ran: null };
}

/** The frames of Codex's own reviewer from 'from' on: each one's method and keys, and its short words of state, never a text. */
function reviewFrames(driver, from) {
  const wordsOf = (value, prefix = '', depth = 0, out = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return out;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string' && entry.length <= 40 && /status|decision|risk|level|outcome|action|authorization|source|^type$|^kind$/i.test(key)) out[prefix + key] = entry;
      else wordsOf(entry, prefix + key + '.', depth + 1, out);
    }
    return out;
  };
  return received(driver, from).filter((f) => /autoApprovalReview|guardian/i.test(f.frame?.method ?? '')).map((f) => ({ index: f.index, method: f.frame.method, isARequest: f.frame.id !== undefined, keys: Object.keys(f.frame.params ?? {}).sort(), words: wordsOf(f.frame.params), worker: f.frame.params?.threadId !== undefined && f.frame.params.threadId !== driver.threadId }));
}

/** The scope with K1's second scratch folder named too: it is under the temp folder, and outside the working one (C65). */
function withTemp(scope, ctx) {
  scope.folders = { ...scope.folders, 'a temporary folder outside the working one': ctx.outside };
  scope.writable = [...scope.writable, ctx.outside];
  return scope;
}

const SCENARIOS = {
  trust: {
    id: 'm22-codex-trust', name: 'm22-codex-trust', turns: 0, files: FILES,
    title: "K1, no prompt: which `thread/start` makes Codex write a project's trust into its configuration (C4, C34)",
    successCondition: "The scratch configuration's `config.toml` after a read-only start in one folder, a workspace-write start in a second and a full-access start in a third",
    async run(ctx) {
      const scope = scopeOf(ctx);
      // The file is the CLI's own, written by the `start` scenario into the spike's scratch folder: removed, so that this run's writes are told apart.
      const before = trustEntries(scope);
      rmSync(path.join(CODEX_HOME, 'config.toml'), { force: true });
      const driver = await ctx.open();
      const notes = { configBefore: before, steps: [] };
      const step = async (label, cwd, params) => {
        const reply = await driver.requestWithin('thread/start', { cwd, ephemeral: true, ...params }, 30_000);
        await sleep(1_200);
        notes.steps.push({ label, folder: whereIs(cwd, scope.folders), asked: params, ok: reply.ok, error: errorOf(reply, scope), reported: reply.ok ? policyFacts(reply.value, scope) : null, configAfter: trustEntries(scope) });
      };
      await step('read-only and never, as the app starts a thread today', ctx.outside, { sandbox: 'read-only', approvalPolicy: 'never' });
      await step('read-only and on-request', ctx.outside, { sandbox: 'read-only', approvalPolicy: 'on-request' });
      await step('workspace-write and on-request', ctx.second.dir, { sandbox: 'workspace-write', approvalPolicy: 'on-request' });
      await step('danger-full-access and on-request', ctx.probe, { sandbox: 'danger-full-access', approvalPolicy: 'on-request' });
      await step('no policy named', ctx.scratch, {});
      notes.turnFrames = received(driver).filter((f) => /^turn\//.test(f.frame?.method ?? '')).length;
      return codex.happened(notes, null);
    },
  },

  'sandbox-state': {
    id: 'm22-codex-sandbox-state', name: 'm22-codex-sandbox-state', turns: 0, files: FILES,
    title: "K1, no prompt: whether the scratch configuration's sandbox is set up, and what a workspace-write thread reports — a read, with no setup request (C4)",
    successCondition: "The readiness, the configuration's own table, and each thread/start reply's sandbox",
    run: (ctx) => SCENARIOS.setup.run(ctx, { read: true }),
  },

  setup: {
    id: 'm22-codex-setup', name: 'm22-codex-setup', turns: 0, files: FILES,
    title: "K1, no prompt, run by the maintainer: Codex's own sandbox setup asked for on the scratch configuration, and what a workspace-write thread reports after it (C4)",
    successCondition: "The setup request's reply and its completion, the readiness before and after, and each thread/start reply's sandbox once it is done",
    async run(ctx, { read = false } = {}) {
      const mode = String(ctx.args.mode ?? '');
      const dry = read;
      if (!dry && !['elevated', 'unelevated'].includes(mode)) return codex.notRun('name the mode: --mode elevated or --mode unelevated (the sandbox-state scenario reads the state and sends no setup request)');
      const scope = scopeOf(ctx);
      const entriesBefore = homeEntries();
      const driver = await ctx.open();
      const ask = async (method, params) => { const reply = await driver.requestWithin(method, params, 30_000); return reply.ok ? reply.value : { refused: errorOf(reply, scope) }; };
      const notes = { mode: dry ? 'none: a read' : mode, readinessBefore: (await ask('windowsSandbox/readiness', undefined))?.status ?? null, configBefore: trustEntries(scope) };
      if (!dry) {
        // The one request that changes the machine: Codex's own setup, for this configuration folder. Windows asks for an administrator's approval where the mode needs one.
        const from = driver.nextIndex;
        const at = driver.tree.elapsed();
        const reply = await driver.requestWithin('windowsSandbox/setupStart', { mode, cwd: ctx.scratch }, 60_000);
        notes.setupStart = reply.ok ? { reply: reply.value } : { refused: errorOf(reply, scope) };
        if (reply.ok) {
          log('setup asked for: approve the Windows prompt if one comes. Waiting up to five minutes for Codex to say it is done.');
          let done = null;
          try { done = await driver.session.waitFor((frame) => frame?.method === 'windowsSandbox/setupCompleted', { wait: 'scenario', ms: 300_000, fromIndex: from }); } catch (error) { notes.setupCompleted = { came: false, why: error?.name ?? String(error) }; }
          if (done) notes.setupCompleted = { came: true, afterMs: Math.round((driver.session.frames.find((f) => f.index === done.index)?.ms ?? at) - at), keys: Object.keys(done.frame.params ?? {}).sort(), mode: done.frame.params?.mode ?? null, success: done.frame.params?.success ?? null, error: tidy(done.frame.params?.error ?? null, scope) };
          await sleep(1_000);
          notes.framesDuringSetup = received(driver, from).filter((f) => f.frame?.method).map((f) => (f.frame.method === 'windows/worldWritableWarning' ? { method: f.frame.method, extraCount: f.frame.params?.extraCount ?? null, failedScan: f.frame.params?.failedScan ?? null, samplePaths: (f.frame.params?.samplePaths ?? []).map((sample) => whereIs(sample, scope.folders)) } : { method: f.frame.method }));
        }
      }
      notes.readinessAfter = (await ask('windowsSandbox/readiness', undefined))?.status ?? null;
      notes.configAfterSetup = trustEntries(scope);
      notes.starts = [];
      for (const [label, params] of [['workspace-write, on-request', { sandbox: 'workspace-write', approvalPolicy: 'on-request' }], ['workspace-write, untrusted', { sandbox: 'workspace-write', approvalPolicy: 'untrusted' }], ['read-only, untrusted', { sandbox: 'read-only', approvalPolicy: 'untrusted' }], ['no policy named', {}]]) notes.starts.push(await tryStart(driver, ctx, scope, label, params));
      await sleep(1_000);
      Object.assign(notes, { configAfterTheStarts: trustEntries(scope), configurationFolderAdded: homeEntries().filter((name) => !entriesBefore.includes(name)), turnFrames: received(driver).filter((f) => /^turn\//.test(f.frame?.method ?? '')).length });
      if (!dry && notes.setupCompleted?.success !== true) return codex.didNotHappen('the setup did not report success', notes);
      return codex.happened(notes, null);
    },
  },

  start: {
    id: 'm22-codex-start', name: 'm22-codex-start', turns: 0, files: FILES,
    title: "K1, no prompt: the Windows sandbox's readiness, the permission profiles, and each sandbox and approval combination taken or refused at `thread/start` (C4)",
    successCondition: "Each combination's reply — its `sandbox`, `approvalPolicy`, `approvalsReviewer`, and whether it names a profile or workspace roots — or its refusal",
    async run(ctx) {
      const scope = scopeOf(ctx);
      const entriesBefore = homeEntries();
      const driver = await ctx.open();
      const ask = async (method, params) => { const reply = await driver.requestWithin(method, params, 30_000); return reply.ok ? { ok: true, value: reply.value } : { ok: false, error: errorOf(reply, scope) }; };
      const readiness = await ask('windowsSandbox/readiness', undefined);
      const profiles = await ask('permissionProfile/list', { cwd: ctx.scratch });
      const requirements = await ask('configRequirements/read', undefined);
      const notes = {
        windowsSandboxReadiness: readiness.ok ? readiness.value?.status ?? null : readiness.error,
        permissionProfiles: profiles.ok ? { keys: Object.keys(profiles.value ?? {}).sort(), data: (profiles.value?.data ?? []).map((profile) => ({ id: profile.id, allowed: profile.allowed, descriptionUnits: typeof profile.description === 'string' ? profile.description.length : null })) } : profiles.error,
        configRequirements: requirements.ok ? (requirements.value?.requirements ? { keys: Object.keys(requirements.value.requirements).sort() } : 'none') : requirements.error,
        model: await codex.pickModel(driver), starts: [],
      };
      for (const [label, params] of combinations(scope)) notes.starts.push(await tryStart(driver, ctx, scope, label, params));
      const entriesAfter = homeEntries();
      Object.assign(notes, { turnFrames: received(driver).filter((f) => /^turn\//.test(f.frame?.method ?? '')).length, configurationFolder: { before: entriesBefore, added: entriesAfter.filter((name) => !entriesBefore.includes(name)) }, typeCounts: typeCounts(driver, (frame) => frame?.method ?? 'response') });
      writeState({ codexModel: notes.model });
      return codex.happened(notes, null);
    },
  },
  once: {
    id: 'm22-codex-once', name: 'm22-codex-once', turns: 2, files: FILES, profile: ASKING,
    title: 'K1: a command accepted once, then asked for again in the next turn and declined (C4, C21)',
    successCondition: "The request's fields and its decisions, the 'accept' taken and the file made, whether the same command asks again, and what a 'decline' brings",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx, [COMMANDS.once]);
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, ASKING, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      driver.approvalRule = (method, params, n, d) => (n === 0 ? answerDictated(scope)(method, params, n, d) : { decision: 'decline', why: 'the second request of the scenario' });
      const first = await turn(ctx, driver, say(COMMANDS.once) + '\n' + REPORT, model, scope);
      if (first.refused) return codex.didNotHappen('turn/start was refused', { thread, first: first.error });
      const notes = { thread, first: first.facts, fileMadeByTheFirstTurn: existsSync(path.join(ctx.scratch, 'k1-once.txt')), outlineFirst: first.outline };
      if (first.facts.requests.length === 0) return codex.didNotHappen('no request came for the first command', notes);
      const second = await turn(ctx, driver, sayAgain(COMMANDS.once) + '\n' + REPORT, model, scope);
      Object.assign(notes, { second: second.facts, askedAgain: (second.facts?.requests.length ?? 0) > 0, configurationFolder: trustEntries(scope), outlineSecond: second.outline });
      writeState({ codexOnceThreadId: driver.threadId });
      return codex.happened(notes, second.end?.index ?? null);
    },
  },

  files: {
    id: 'm22-codex-files', name: 'm22-codex-files', turns: 1, files: FILES, profile: ASKING,
    title: 'K1: three file changes by apply_patch — in the working folder, outside it, and in a second root Codex is not given — each accepted (C4)',
    successCondition: "Each change's request and its fields, and each file's state afterwards",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx);
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, ASKING, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      driver.approvalRule = answerDictated(scope);
      const only = await turn(ctx, driver, patchPrompt([[ctx.scratch, 'k1-inside.txt', 'alpha'], [ctx.outside, 'k1-outside.txt', 'beta'], [ctx.second.dir, 'k1-second.txt', 'gamma']]), model, scope);
      if (only.refused) return codex.didNotHappen('turn/start was refused', { thread, turn: only.error });
      const notes = { thread, turn: only.facts, files: { inside: existsSync(path.join(ctx.scratch, 'k1-inside.txt')), outside: existsSync(path.join(ctx.outside, 'k1-outside.txt')), second: existsSync(path.join(ctx.second.dir, 'k1-second.txt')) }, outline: only.outline };
      if (only.facts.fileChanges.length === 0 && only.facts.requests.length === 0) return codex.didNotHappen('the turn made no file change and no request', notes);
      return codex.happened(notes, only.end.index);
    },
  },

  'on-request': {
    id: 'm22-codex-on-request', name: 'm22-codex-on-request', turns: 1, files: FILES, profile: { ...ASKING, approvalPolicy: 'on-request' },
    title: 'K1: the same command and one file change under on-request, where the model decides whether to ask (C4)',
    successCondition: 'Whether each asks, runs with no request, or is refused, and what the items say',
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx, [COMMANDS.onRequest]);
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, { ...ASKING, approvalPolicy: 'on-request' }, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      driver.approvalRule = answerDictated(scope);
      const only = await turn(ctx, driver, 'Do these two steps in this order, and go on to the second if the first is refused or fails; do not try another way for a step.\n1. ' + say(COMMANDS.onRequest) + '\n2. Use your apply_patch tool, not a shell command, to create the file ' + path.join(ctx.scratch, 'k1-on-request-patch.txt') + ' containing the single word alpha.\nThen tell me in one line per step whether it worked.', model, scope);
      if (only.refused) return codex.didNotHappen('turn/start was refused', { thread, turn: only.error });
      const notes = { thread, turn: only.facts, files: filesIn(ctx, ['k1-on-request.txt', 'k1-on-request-patch.txt']).workingFolder, outline: only.outline };
      return codex.happened(notes, only.end.index);
    },
  },

  amendment: {
    id: 'm22-codex-amendment', name: 'm22-codex-amendment', turns: 2, files: FILES, profile: ASKING,
    title: "K1: a command accepted with the execpolicy amendment Codex proposed, what that writes into the scratch configuration, and the same command in the next turn (C22)",
    successCondition: "The amendment's destination by the configuration folder's entries, and whether the next turn asks",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx, [COMMANDS.amendment]);
      const entriesBefore = homeEntries();
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, ASKING, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      // The first request alone carries the amendment back, and only as Codex proposed it for the prompt's own command.
      driver.approvalRule = answerDictated(scope, (method, params, n) => (n === 0 && method === COMMAND_REQUEST && Array.isArray(params.proposedExecpolicyAmendment) && (params.availableDecisions ?? []).some((d) => decisionName(d) === 'acceptWithExecpolicyAmendment') ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } } : 'accept'));
      const first = await turn(ctx, driver, say(COMMANDS.amendment) + '\n' + REPORT, model, scope);
      if (first.refused) return codex.didNotHappen('turn/start was refused', { thread, first: first.error });
      await sleep(1_000);
      const added = homeEntries().filter((name) => !entriesBefore.includes(name));
      const rules = added.filter((name) => /rules|policy/i.test(name) && !name.endsWith('/'));
      const notes = {
        thread, first: first.facts, amendmentSent: driver.decisions.some((d) => typeof d.result.decision === 'object'), fileMade: existsSync(path.join(ctx.scratch, 'k1-amendment.txt')),
        configurationFolder: { added, rulesFiles: rules.map((name) => ({ name, text: tidy(readFileSync(path.join(CODEX_HOME, name), 'utf8'), scope, 600) })), config: trustEntries(scope) }, outlineFirst: first.outline,
      };
      if (!notes.amendmentSent) return codex.didNotHappen('no request offered the amendment, so none was sent', notes);
      const second = await turn(ctx, driver, sayAgain(COMMANDS.amendment) + '\n' + REPORT, model, scope);
      Object.assign(notes, { second: second.facts, askedAgain: (second.facts?.requests.length ?? 0) > 0, outlineSecond: second.outline });
      writeState({ codexAmendmentThreadId: driver.threadId });
      return codex.happened(notes, second.end?.index ?? null);
    },
  },

  'amendment-after': {
    id: 'm22-codex-amendment-after', name: 'm22-codex-amendment-after', turns: 1, files: FILES, profile: ASKING,
    title: "K1, in reserve: a new thread in a new process, the amended command asked for (C22, C24)",
    successCondition: 'Whether the rule the amendment wrote answers for a thread that never saw the approval',
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx, [COMMANDS.amendment]);
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, ASKING, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      driver.approvalRule = () => ({ decision: 'decline', why: 'this scenario accepts nothing itself' });
      const only = await turn(ctx, driver, say(COMMANDS.amendment) + '\n' + REPORT, model, scope);
      if (only.refused) return codex.didNotHappen('turn/start was refused', { thread, turn: only.error });
      return codex.happened({ thread, turn: only.facts, asked: only.facts.requests.length > 0, fileMade: existsSync(path.join(ctx.scratch, 'k1-amendment.txt')), rulesFiles: homeEntries().filter((name) => /rules|policy/i.test(name)), outline: only.outline }, only.end.index);
    },
  },

  'file-session': {
    id: 'm22-codex-file-session', name: 'm22-codex-file-session', family: 'm22-codex-file-session', turns: 3, files: FILES, profile: ASKING,
    title: 'K1: a file change answered acceptForSession, then changes in the next turn, and one after the process was closed and the thread resumed (C21)',
    successCondition: 'Whether the later changes ask: in the folder and outside it in the same process, and after the resume',
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx);
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, ASKING, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      driver.approvalRule = answerDictated(scope, (method, params, n) => (n === 0 && method === FILE_REQUEST ? 'acceptForSession' : 'accept'));
      const first = await turn(ctx, driver, patchPrompt([[ctx.scratch, 'k1-fs-1.txt', 'alpha']]), model, scope);
      if (first.refused) return codex.didNotHappen('turn/start was refused', { thread, first: first.error });
      const notes = { thread, first: first.facts, outlineFirst: first.outline };
      if (!driver.decisions.some((d) => d.result.decision === 'acceptForSession')) return codex.didNotHappen('no file-change request came, so acceptForSession was not sent', notes);
      const second = await turn(ctx, driver, patchPrompt([[ctx.scratch, 'k1-fs-2.txt', 'beta'], [ctx.outside, 'k1-fs-outside.txt', 'gamma']]), model, scope);
      Object.assign(notes, { second: second.facts, askedInTheNextTurn: (second.facts?.requests ?? []).map((request) => request.changes?.map((change) => change.where) ?? request.method), outlineSecond: second.outline });
      const threadId = driver.threadId;
      driver.cleanupState = await driver.close();
      await sleep(1_000);
      const resumed = await ctx.open('resumed');
      notes.resume = await resumeThread(ctx, resumed, scope, threadId, ASKING);
      if (!notes.resume.ok) return codex.didNotHappen('thread/resume was refused', notes);
      resumed.approvalRule = answerDictated(scope);
      const third = await turn(ctx, resumed, patchPrompt([[ctx.scratch, 'k1-fs-3.txt', 'delta']]), model, scope);
      Object.assign(notes, { third: third.facts, askedAfterTheResume: (third.facts?.requests.length ?? 0) > 0, files: { ...filesIn(ctx, ['k1-fs-1.txt', 'k1-fs-2.txt', 'k1-fs-3.txt']).workingFolder, 'k1-fs-outside.txt (outside)': existsSync(path.join(ctx.outside, 'k1-fs-outside.txt')) }, outlineThird: third.outline });
      return codex.happened(notes, third.end?.index ?? null);
    },
  },

  override: {
    id: 'm22-codex-override', name: 'm22-codex-override', family: 'm22-codex-override', turns: 2, files: FILES, profile: { sandbox: 'read-only', approvalPolicy: 'never' },
    title: "K1: a thread started as the app starts one today, a turn with another policy on its turn/start, a Stop with its request pending, then the same again and the process ended by force (C41, C42, C53)",
    successCondition: "Whether the turn's policy is taken and reported, what an interrupt resolves, and what policy the thread has afterwards and after a resume",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx, [COMMANDS.override]);
      const today = { sandbox: 'read-only', approvalPolicy: 'never' };
      const turnPolicy = { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [ctx.scratch], networkAccess: false } };
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, today, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      driver.approvalRule = () => 'hold';
      const first = await startTurn(driver, ctx, say(COMMANDS.override) + '\n' + REPORT, model, turnPolicy);
      const notes = { thread, turnPolicyAsked: { approvalPolicy: turnPolicy.approvalPolicy, sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['working folder'], networkAccess: false } }, first: { taken: first.ok, error: first.error } };
      if (!first.ok) return codex.didNotHappen('turn/start with a policy was refused', notes);
      const hit = await ctx.wait(driver, (e) => (e.kind === 'request' && e.requestKind === 'approval') || e.kind === 'turn-end', first.from);
      if (hit.kind === 'turn-end') { Object.assign(notes.first, turnFacts(driver, first.from, scope)); notes.outlineFirst = outlineOf(driver, first.from); return codex.didNotHappen('the turn under the other policy ended with no request', notes); }
      await sleep(2_000);
      const stopAt = driver.tree.elapsed();
      const interrupt = await driver.requestWithin('turn/interrupt', { threadId: driver.threadId, turnId: driver.turnId }, 15_000);
      await ctx.turnEnd(driver, first.from);
      await sleep(2_500);
      Object.assign(notes.first, turnFacts(driver, first.from, scope), { interrupt: { ok: interrupt.ok, code: interrupt.ok ? null : interrupt.error?.code ?? null }, framesAfterTheInterrupt: received(driver, first.from).filter((f) => f.ms >= stopAt && f.frame?.method !== CODEX_TEXT_DELTA).map((f) => ({ method: f.frame?.method ?? 'response', msAfterTheInterrupt: Math.round(f.ms - stopAt) })), fileMade: existsSync(path.join(ctx.scratch, 'k1-override.txt')) });
      notes.outlineFirst = outlineOf(driver, first.from);
      // The same turn again, with no policy on its turn/start: whether the first turn's policy is still in force.
      const second = await startTurn(driver, ctx, sayAgain(COMMANDS.override) + '\n' + REPORT, model);
      notes.second = { taken: second.ok, error: second.error };
      if (!second.ok) return codex.didNotHappen('the second turn/start was refused', notes);
      const again = await ctx.wait(driver, (e) => (e.kind === 'request' && e.requestKind === 'approval') || e.kind === 'turn-end', second.from);
      await sleep(600);
      Object.assign(notes.second, { reached: again.kind === 'turn-end' ? 'the turn ended with no request' : 'a request came: the first turn\'s policy was still in force', ...turnFacts(driver, second.from, scope) });
      notes.outlineSecond = outlineOf(driver, second.from);
      const threadId = driver.threadId;
      writeState({ codexOverrideThreadId: threadId });
      // The process is ended as the app's process layer ends one on Windows, in the turn where a request is pending or just after its end.
      const tree = driver.tree;
      const killedAt = tree.elapsed();
      const taskkillOk = await forceEnd(tree.pid, { tree: true });
      const exited = await settlesWithin(tree.exited, 5_000);
      driver.forcedEnd = { how: 'taskkill /PID <pid> /T /F, with no end of input first', atMs: killedAt, taskkillOk, exited, duringATurn: again.kind !== 'turn-end' };
      driver.cleanupState = await driver.close();
      notes.forcedEnd = driver.forcedEnd;
      await sleep(1_200);
      const resumed = await ctx.open('resumed');
      notes.resumeWithNoPolicy = await resumeThread(ctx, resumed, scope, threadId, {});
      notes.resumeAsTheAppResumes = await resumeThread(ctx, resumed, scope, threadId, today);
      return codex.happened(notes, null);
    },
  },

  resume: {
    id: 'm22-codex-resume', name: 'm22-codex-resume', family: 'm22-codex-override', turns: 0, files: FILES,
    title: "K1, no prompt: the thread of 'override' resumed in a fresh process under each policy in turn (C4, C42, C53)",
    successCondition: "What each thread/resume reply reports against what it asked, each in a process that had not loaded the thread",
    async run(ctx) {
      const threadId = readState().codexOverrideThreadId;
      if (!threadId) return codex.notRun('no thread from the override scenario: run --scenario override first');
      const scope = scopeOf(ctx);
      const notes = { resumes: [] };
      const steps = [['as the app resumes a thread today', { sandbox: 'read-only', approvalPolicy: 'never' }], ['no policy named, after it', {}], ['workspace-write, untrusted, reviewer user', ASKING], ['no policy named, after it', {}], ['as the app resumes a thread today, again', { sandbox: 'read-only', approvalPolicy: 'never' }]];
      for (const [label, policy] of steps) {
        const driver = await ctx.open('p' + (notes.resumes.length + 1));
        driver.sessionIds = [threadId];
        const from = driver.nextIndex;
        const reply = await resumeThread(ctx, driver, scope, threadId, policy);
        await sleep(500);
        notes.resumes.push({ label, ...reply, settingsFrames: framesOf(driver, SETTINGS, from).length });
        driver.cleanupState = await driver.close();
        await sleep(800);
      }
      return codex.happened(notes, null);
    },
  },

  config: {
    id: 'm22-codex-config', name: 'm22-codex-config', turns: 0, files: FILES,
    title: "K1, no prompt: an approval policy written into the scratch configuration's config.toml, against the one a thread/start names (C7, C24)",
    successCondition: 'What a start reports with no policy named and with another policy named, under that configuration, and again once the line is taken out',
    async run(ctx) {
      const scope = scopeOf(ctx);
      const config = path.join(CODEX_HOME, 'config.toml');
      const before = existsSync(config) ? readFileSync(config, 'utf8') : null;
      const notes = { configBefore: trustEntries(scope), steps: [] };
      const starts = async (label) => {
        const driver = await ctx.open('p' + (notes.steps.length + 1));
        const rows = [];
        for (const [name, params] of [['no policy named', {}], ['on-request named', { sandbox: 'read-only', approvalPolicy: 'on-request' }], ['untrusted named', { sandbox: 'read-only', approvalPolicy: 'untrusted' }]]) rows.push(await tryStart(driver, ctx, scope, name, params));
        notes.steps.push({ label, warnings: received(driver).filter((f) => f.frame?.method === 'configWarning').length, starts: rows.map((row) => ({ label: row.label, ok: row.ok, error: row.error, approvalPolicy: row.reported?.approvalPolicy ?? null, sandbox: row.reported?.sandbox?.type ?? null, profile: row.reported?.activePermissionProfile ?? null })) });
        driver.cleanupState = await driver.close();
        await sleep(800);
      };
      try {
        // A top-level key goes before any table: the file is the scratch folder's own, and is put back after.
        // `never`, and not `untrusted`: 0.155.1 ends at startup on that value in the file, with "no longer supported; remove this setting" (this scenario's first run).
        writeFileSync(config, 'approval_policy = "never"\n' + (before ?? ''));
        await starts('with approval_policy = "never" in config.toml');
      } finally {
        if (before === null) rmSync(config, { force: true }); else writeFileSync(config, before);
      }
      await starts('with the line taken out again');
      notes.configAfter = trustEntries(scope);
      return codex.happened(notes, null);
    },
  },

  'file-session-same': {
    id: 'm22-codex-file-session-same', name: 'm22-codex-file-session-same', family: 'm22-codex-file-session-same', turns: 3, atMost: true, files: FILES, profile: ASKING,
    title: 'K1, a retry of the session grant: a file change answered acceptForSession, then a change to the same file in the next turn, and one after a resume if that did not ask (C21)',
    successCondition: 'Whether a second change to the same file asks in the next turn, and after the process was closed and the thread resumed',
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx);
      const target = path.join(ctx.scratch, 'k1-same.txt');
      const change = (from, to) => 'Use your apply_patch tool, not a shell command, to change the file ' + target + ': replace the word ' + from + ' with the word ' + to + '. Then tell me in one line whether it was changed. If it is refused, say so and stop: do not try another way.';
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, ASKING, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      driver.approvalRule = answerDictated(scope, (method, params, n) => (n === 0 && method === FILE_REQUEST ? 'acceptForSession' : 'accept'));
      const first = await turn(ctx, driver, patchPrompt([[ctx.scratch, 'k1-same.txt', 'alpha']]), model, scope);
      if (first.refused) return codex.didNotHappen('turn/start was refused', { thread, first: first.error });
      const notes = { thread, first: first.facts, outlineFirst: first.outline };
      if (!driver.decisions.some((d) => d.result.decision === 'acceptForSession')) return codex.didNotHappen('no file-change request came, so acceptForSession was not sent', notes);
      const second = await turn(ctx, driver, change('alpha', 'beta'), model, scope);
      Object.assign(notes, { second: second.facts, sameFileAskedInTheNextTurn: (second.facts?.requests.length ?? 0) > 0, outlineSecond: second.outline });
      // Asked again in the same process: the grant is nothing a resume could keep, and the third prompt is not spent.
      if (notes.sameFileAskedInTheNextTurn || (second.facts?.fileChanges.length ?? 0) === 0) return codex.happened({ ...notes, fileHolds: existsSync(target) ? readFileSync(target, 'utf8').trim() : null }, second.end?.index ?? null);
      const threadId = driver.threadId;
      driver.cleanupState = await driver.close();
      await sleep(1_000);
      const resumed = await ctx.open('resumed');
      notes.resume = await resumeThread(ctx, resumed, scope, threadId, ASKING);
      if (!notes.resume.ok) return codex.didNotHappen('thread/resume was refused', notes);
      resumed.approvalRule = answerDictated(scope);
      const third = await turn(ctx, resumed, change('beta', 'gamma'), model, scope);
      Object.assign(notes, { third: third.facts, sameFileAskedAfterTheResume: (third.facts?.requests.length ?? 0) > 0, fileHolds: existsSync(target) ? readFileSync(target, 'utf8').trim() : null, outlineThird: third.outline });
      return codex.happened(notes, third.end?.index ?? null);
    },
  },

  'sandbox-files': {
    id: 'm22-codex-sandbox-files', name: 'm22-codex-sandbox-files', turns: 1, files: FILES, profile: SANDBOXED,
    title: 'K1, with the sandbox set up: three file changes under workspace-write and on-request — in the working folder, outside it (declined if asked) and in a second root (accepted if asked) (C4)',
    successCondition: 'Which changes ask, and which files are made: what the sandbox holds back, and what an accepted change may do',
    async run(ctx) {
      const scope = beyondScope(ctx);
      const run = await sandboxTurn(ctx, SANDBOXED, scope, patchPrompt([[ctx.scratch, 'k1-sb-inside.txt', 'alpha'], [scope.outside, 'k1-sb-outside.txt', 'beta'], [scope.second, 'k1-sb-second.txt', 'gamma']]), (where) => (where === 'outside the folder' ? 'decline' : 'accept'));
      if (run.stop) return run.stop;
      run.notes.files = { inside: existsSync(path.join(ctx.scratch, 'k1-sb-inside.txt')), outsideDeclined: existsSync(path.join(scope.outside, 'k1-sb-outside.txt')), secondAccepted: existsSync(path.join(scope.second, 'k1-sb-second.txt')) };
      return codex.happened(run.notes, run.end.index);
    },
  },

  'sandbox-commands': {
    id: 'm22-codex-sandbox-commands', name: 'm22-codex-sandbox-commands', turns: 1, files: FILES, profile: SANDBOXED,
    title: 'K1, with the sandbox set up: two commands under workspace-write and on-request — one that writes in the working folder, one that writes outside it (declined if asked) (C4)',
    successCondition: 'Whether each runs with no request, what the one outside brings, and which files are made',
    async run(ctx) {
      const scope = beyondScope(ctx);
      const inside = 'echo k1 > k1-sbc-inside.txt';
      const outside = 'echo k1 > ' + path.join(scope.outside, 'k1-sbc-outside.txt');
      scope.snippets = [inside, outside];
      const run = await sandboxTurn(ctx, SANDBOXED, scope, TWO_STEPS + '\n1. Run exactly this shell command, once: ' + inside + '\n2. Run exactly this shell command, once: ' + outside + '\nThen tell me in one line per step whether it worked.', (where) => (where === 'outside the folder' ? 'decline' : 'accept'));
      if (run.stop) return run.stop;
      run.notes.files = { inside: existsSync(path.join(ctx.scratch, 'k1-sbc-inside.txt')), outsideDeclined: existsSync(path.join(scope.outside, 'k1-sbc-outside.txt')) };
      return codex.happened(run.notes, run.end.index);
    },
  },

  'sandbox-ask-first': {
    id: 'm22-codex-sandbox-ask-first', name: 'm22-codex-sandbox-ask-first', turns: 1, files: FILES, profile: ASK_FIRST,
    title: 'K1, with the sandbox set up: the same two commands under read-only and untrusted, each accepted (C4)',
    successCondition: 'Whether an accepted command stays in the sandbox: which of the two files is made',
    async run(ctx) {
      const scope = beyondScope(ctx);
      const inside = 'echo k1 > k1-af-inside.txt';
      const outside = 'echo k1 > ' + path.join(scope.outside, 'k1-af-outside.txt');
      scope.snippets = [inside, outside];
      const run = await sandboxTurn(ctx, ASK_FIRST, scope, TWO_STEPS + '\n1. Run exactly this shell command, once: ' + inside + '\n2. Run exactly this shell command, once: ' + outside + '\nThen tell me in one line per step whether it worked.', () => 'accept');
      if (run.stop) return run.stop;
      run.notes.files = { insideAccepted: existsSync(path.join(ctx.scratch, 'k1-af-inside.txt')), outsideAccepted: existsSync(path.join(scope.outside, 'k1-af-outside.txt')) };
      return codex.happened(run.notes, run.end.index);
    },
  },

  'sandbox-ask-write': {
    id: 'm22-codex-sandbox-ask-write', name: 'm22-codex-sandbox-ask-write', turns: 1, files: FILES, profile: { ...SANDBOXED, approvalPolicy: 'untrusted' },
    title: 'K1, with the sandbox set up: the same two commands under workspace-write and untrusted, each accepted (C4)',
    successCondition: 'Whether each asks first, and whether an accepted command then writes in the working folder and outside it',
    async run(ctx) {
      const scope = beyondScope(ctx);
      const inside = 'echo k1 > k1-aw-inside.txt';
      const outside = 'echo k1 > ' + path.join(scope.outside, 'k1-aw-outside.txt');
      scope.snippets = [inside, outside];
      const run = await sandboxTurn(ctx, { ...SANDBOXED, approvalPolicy: 'untrusted' }, scope, TWO_STEPS + '\n1. Run exactly this shell command, once: ' + inside + '\n2. Run exactly this shell command, once: ' + outside + '\nThen tell me in one line per step whether it worked.', () => 'accept');
      if (run.stop) return run.stop;
      run.notes.files = { insideAccepted: existsSync(path.join(ctx.scratch, 'k1-aw-inside.txt')), outsideAccepted: existsSync(path.join(scope.outside, 'k1-aw-outside.txt')) };
      return codex.happened(run.notes, run.end.index);
    },
  },

  'reviewer-turn': {
    id: 'm22-codex-reviewer-turn', name: 'm22-codex-reviewer-turn', family: 'm22-codex-reviewer', turns: 1, atMost: true, files: FILES, profile: SANDBOXED,
    title: "K4: a thread under workspace-write, on-request and the user as reviewer, its turn/start naming the reviewer with the policy, and one file change outside the working folder, declined (C7, C70)",
    successCondition: "Whether turn/start takes `approvalsReviewer` under production's handshake, whether the change's request still comes to the spike, and what the thread reports when resumed afterwards with no policy named",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = beyondScope(ctx);
      const driver = await ctx.open();
      const readiness = await driver.requestWithin('windowsSandbox/readiness', undefined, 30_000);
      // The start's own reply is kept: its three fields are what the turn names again.
      const params = { cwd: ctx.scratch, ...SANDBOXED, model: model.model };
      const started = await driver.startThread(params);
      driver.sessionStart = { request: params, replyIndex: started.index, ok: started.ok, check: started.ok ? checkSessionStart(SANDBOXED, started.value) : null };
      const notes = { readiness: readiness.ok ? readiness.value?.status ?? null : errorOf(readiness, scope), thread: { ok: started.ok, error: errorOf(started, scope), asked: SANDBOXED, reported: started.ok ? policyFacts(started.value, scope) : null, matchesWhatWasAsked: started.ok ? driver.sessionStart.check.passed : null }, attempts: [] };
      if (!started.ok) return codex.didNotHappen('thread/start was refused', notes);
      if (started.value?.approvalsReviewer !== 'user') return codex.didNotHappen('the thread did not start with the user as its reviewer: no turn is sent under another', notes);
      // Nothing is accepted: that the request comes to the spike, and not to a reviewer of Codex's, is the finding.
      driver.approvalRule = () => ({ decision: 'decline', why: 'this scenario accepts nothing' });
      const textOfPrompt = patchPrompt([[scope.outside, 'k1-rt-outside.txt', 'alpha']]);
      // A refused turn/start spends no prompt, so the forms are tried in turn and the first one taken is the one turn of the run.
      const forms = [
        ['the policy, the sandbox and the reviewer, each as the start reply reported it', { approvalPolicy: started.value.approvalPolicy, sandboxPolicy: started.value.sandbox, approvalsReviewer: started.value.approvalsReviewer }],
        ['the reviewer alone', { approvalsReviewer: 'user' }],
        ['nothing named: the turn as K6 sent it', {}],
      ];
      let ran = null;
      for (const [label, extra] of forms) {
        const attempt = await turn(ctx, driver, textOfPrompt, model, scope, extra);
        notes.attempts.push({ label, named: { ...extra, ...(extra.sandboxPolicy ? { sandboxPolicy: sandboxOf(extra.sandboxPolicy, scope) } : {}) }, taken: !attempt.refused, error: attempt.refused ? attempt.error : null });
        if (!attempt.refused) { ran = attempt; break; }
      }
      if (ran === null) return codex.didNotHappen('turn/start was refused in every form', notes);
      Object.assign(notes, { turn: ran.facts, requestsThatCameToTheSpike: ran.facts.requests.length, autoReviewFrames: received(driver, ran.from).filter((f) => /^item\/autoApprovalReview\//.test(f.frame?.method ?? '')).length, fileMade: existsSync(path.join(scope.outside, 'k1-rt-outside.txt')), outline: ran.outline });
      const threadId = driver.threadId;
      writeState({ codexReviewerThreadId: threadId });
      driver.cleanupState = await driver.close();
      await sleep(1_000);
      const resumed = await ctx.open('resumed');
      notes.resumeWithNoPolicy = await resumeThread(ctx, resumed, scope, threadId, {});
      if (notes.attempts.at(-1).label === forms[2][0]) return codex.didNotHappen('turn/start took no form that names the reviewer; the turn ran with nothing named', notes);
      if (ran.facts.requests.length === 0) return codex.didNotHappen('turn/start took the reviewer, and no request came for the change', notes);
      return codex.happened(notes, ran.end?.index ?? null);
    },
  },

  reviewer: {
    id: 'm22-codex-reviewer', name: 'm22-codex-reviewer', family: 'm22-codex-reviewer', turns: 0, files: FILES,
    title: "K4, no prompt: a reviewer written into the scratch configuration's config.toml against the one a thread/start or a thread/resume names, and the thread of 'reviewer-turn' moved to Codex's own reviewer and back by resumes in fresh processes (C70)",
    successCondition: "Each reply's `approvalsReviewer` against what was named: under `approvals_reviewer = \"auto_review\"` in the configuration, once the line is taken out, and from one resume to the next",
    async run(ctx) {
      const threadId = readState().codexReviewerThreadId;
      if (!threadId) return codex.notRun('no thread from the reviewer-turn scenario: run --scenario reviewer-turn first');
      const scope = scopeOf(ctx);
      const config = path.join(CODEX_HOME, 'config.toml');
      const before = existsSync(config) ? readFileSync(config, 'utf8') : null;
      const notes = { configBefore: trustEntries(scope), steps: [] };
      const row = (reply) => ({ ...(reply.label ? { label: reply.label } : {}), asked: reply.asked, ok: reply.ok, error: reply.error, sandbox: reply.reported?.sandbox?.type ?? null, approvalPolicy: reply.reported?.approvalPolicy ?? null, approvalsReviewer: reply.reported?.approvalsReviewer ?? null });
      /** One process, which had not loaded the thread: `work` in it, then its close. */
      const inProcess = async (label, work) => {
        const driver = await ctx.open('p' + (notes.steps.length + 1));
        driver.sessionIds = [threadId];
        const from = driver.nextIndex;
        const found = await work(driver);
        await sleep(500);
        notes.steps.push({ label, ...found, configWarnings: received(driver).filter((f) => f.frame?.method === 'configWarning').length, settingsFrames: framesOf(driver, SETTINGS, from).length });
        driver.cleanupState = await driver.close();
        await sleep(800);
      };
      const starts = (rows) => async (driver) => { const out = []; for (const [name, params] of rows) out.push(row(await tryStart(driver, ctx, scope, name, params))); return { starts: out }; };
      const resume = (policy) => async (driver) => ({ resume: row(await resumeThread(ctx, driver, scope, threadId, policy)) });
      const NAMED = [
        ['no policy named', {}],
        ['read-only, never, as the app starts a thread today', { sandbox: 'read-only', approvalPolicy: 'never' }],
        ['read-only, never, reviewer user', { sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user' }],
        ['workspace-write, untrusted, no reviewer named', { sandbox: 'workspace-write', approvalPolicy: 'untrusted' }],
        ['workspace-write, untrusted, reviewer user', ASKING],
        ['workspace-write, on-request, no reviewer named', { sandbox: 'workspace-write', approvalPolicy: 'on-request' }],
        ['workspace-write, on-request, reviewer user', SANDBOXED],
      ];
      try {
        // A top-level key goes before any table: the file is the scratch folder's own, and is put back after.
        writeFileSync(config, 'approvals_reviewer = "auto_review"\n' + (before ?? ''));
        await inProcess('with approvals_reviewer = "auto_review" in config.toml: starts', starts(NAMED));
        await inProcess('with it: the saved thread resumed, no policy named', resume({}));
        await inProcess('with it: the saved thread resumed, workspace-write, on-request, reviewer user', resume(SANDBOXED));
      } catch (error) {
        if (!(error instanceof CliExited)) throw error;
        return codex.didNotHappen('the app-server ended with approvals_reviewer in config.toml', notes);
      } finally {
        if (before === null) rmSync(config, { force: true }); else writeFileSync(config, before);
      }
      await inProcess('with the line taken out again: starts', starts([NAMED[0], NAMED[5]]));
      // No turn is sent under Codex's reviewer: the resume names it, and the next ones say what the thread kept.
      await inProcess('the saved thread resumed, workspace-write, on-request, reviewer auto_review', resume({ ...SANDBOXED, approvalsReviewer: 'auto_review' }));
      await inProcess('resumed after it, no policy named', resume({}));
      await inProcess('resumed, workspace-write, on-request, reviewer user', resume(SANDBOXED));
      await inProcess('resumed after it, no policy named', resume({}));
      notes.configAfter = trustEntries(scope);
      return codex.happened(notes, null);
    },
  },

  'berserk-turn': {
    id: 'm22-codex-berserk', name: 'm22-codex-berserk', family: 'm22-codex-berserk', turns: 1, files: FILES, profile: BERSERK,
    title: "K4: a thread under full access and never, its turn/start naming the policy and the sandbox again and no reviewer; two commands and one file change, in the working folder and outside it (C4, C7, C55, C93)",
    successCondition: "A turn under full access: whether anything asks, which files are made, what the start wrote into the configuration, and what the thread reports when resumed with no policy named and as Read only",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = beyondScope(ctx);
      const inside = 'echo k4 > k4-bz-inside.txt';
      const outside = 'echo k4 > ' + path.join(scope.outside, 'k4-bz-outside.txt');
      scope.snippets = [inside, outside];
      const configBefore = trustEntries(scope);
      const driver = await ctx.open();
      const params = { cwd: ctx.scratch, ...BERSERK, model: model.model };
      const started = await driver.startThread(params);
      driver.sessionStart = { request: params, replyIndex: started.index, ok: started.ok, check: started.ok ? checkSessionStart(BERSERK, started.value) : null };
      await sleep(1_200);
      const notes = { thread: { ok: started.ok, error: errorOf(started, scope), asked: BERSERK, reported: started.ok ? policyFacts(started.value, scope) : null, matchesWhatWasAsked: started.ok ? driver.sessionStart.check.passed : null }, configBefore, configAfterTheStart: trustEntries(scope) };
      if (!started.ok) return codex.didNotHappen('thread/start was refused', notes);
      if (started.value?.sandbox?.type !== 'dangerFullAccess' || started.value?.approvalPolicy !== 'never') return codex.didNotHappen('the thread did not start under full access and never: no turn is sent', notes);
      // Nothing should ask under `never`; what does is declined, and noted.
      driver.approvalRule = () => ({ decision: 'decline', why: 'this scenario accepts nothing: under never nothing should ask' });
      const textOfPrompt = STEPS_IN_ORDER + '\n1. Run exactly this shell command, once: ' + inside + '\n2. Run exactly this shell command, once: ' + outside + '\n3. Use your apply_patch tool, not a shell command, to create the file ' + path.join(scope.second, 'k4-bz-patch.txt') + ' containing the single word alpha.\nThen tell me in one line per step whether it worked.';
      const { attempts, ran } = await turnInForms(ctx, driver, textOfPrompt, model, scope, [['the policy and the sandbox, each as the start reply reported it, and no reviewer', repeatOf(started.value, { reviewer: false })], ['nothing named', {}]]);
      notes.attempts = attempts;
      if (ran === null) return codex.didNotHappen('turn/start was refused in every form', notes);
      Object.assign(notes, { turn: ran.facts, requestsThatCame: ran.facts.requests.length, reviewFrames: reviewFrames(driver, ran.from), files: { inside: existsSync(path.join(ctx.scratch, 'k4-bz-inside.txt')), outside: existsSync(path.join(scope.outside, 'k4-bz-outside.txt')), secondByPatch: existsSync(path.join(scope.second, 'k4-bz-patch.txt')) }, configAfterTheTurn: trustEntries(scope), outline: ran.outline });
      const threadId = driver.threadId;
      writeState({ codexBerserkThreadId: threadId });
      driver.cleanupState = await driver.close();
      await sleep(1_000);
      // Each resume in a process that had not loaded the thread: what it kept, a move to Read only, and what it kept of that.
      notes.resumes = [];
      for (const [label, policy] of [['no policy named', {}], ['read-only and never: out of full access', READ_ONLY], ['no policy named, after it', {}]]) {
        const next = await ctx.open('p' + (notes.resumes.length + 2));
        next.sessionIds = [threadId];
        notes.resumes.push({ label, ...(await resumeThread(ctx, next, scope, threadId, policy)) });
        next.cleanupState = await next.close();
        await sleep(800);
      }
      return codex.happened(notes, ran.end?.index ?? null);
    },
  },

  'auto-review': {
    id: 'm22-codex-auto-review', name: 'm22-codex-auto-review', family: 'm22-codex-auto-review', turns: 2, atMost: true, files: FILES, profile: AUTO_REVIEWED,
    title: "K4: a thread under workspace-write, on-request and Codex's own reviewer, a file change and a command outside the working folder; then the thread resumed in a fresh process naming the user, and one more change outside (C51, C64, C70)",
    successCondition: "Under Codex's reviewer: whether a request reaches the spike, the review's frames, and which files are made. After the resume that names the user: the reviewer the reply reports, and whether the next change's request comes to the spike",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = beyondScope(ctx);
      const command = 'echo k4 > ' + path.join(scope.outside, 'k4-ar-command.txt');
      scope.snippets = [command];
      const driver = await ctx.open();
      const readiness = await driver.requestWithin('windowsSandbox/readiness', undefined, 30_000);
      const params = { cwd: ctx.scratch, ...AUTO_REVIEWED, model: model.model };
      const started = await driver.startThread(params);
      driver.sessionStart = { request: params, replyIndex: started.index, ok: started.ok, check: started.ok ? checkSessionStart(AUTO_REVIEWED, started.value) : null };
      const notes = { readiness: readiness.ok ? readiness.value?.status ?? null : errorOf(readiness, scope), thread: { ok: started.ok, error: errorOf(started, scope), asked: AUTO_REVIEWED, reported: started.ok ? policyFacts(started.value, scope) : null, matchesWhatWasAsked: started.ok ? driver.sessionStart.check.passed : null } };
      if (!started.ok) return codex.didNotHappen('thread/start was refused', notes);
      if (started.value?.approvalsReviewer !== 'auto_review' || started.value?.sandbox?.type !== 'workspaceWrite') return codex.didNotHappen("the thread did not start in a sandbox under Codex's reviewer: no turn is sent", notes);
      // Nothing is accepted by the spike: whether a request reaches it at all under Codex's reviewer is the finding.
      const declineAll = () => ({ decision: 'decline', why: 'this scenario accepts nothing itself' });
      driver.approvalRule = declineAll;
      const first = await turnInForms(ctx, driver, STEPS_IN_ORDER + '\n1. Use your apply_patch tool, not a shell command, to create the file ' + path.join(scope.outside, 'k4-ar-patch.txt') + ' containing the single word alpha.\n2. Run exactly this shell command, once: ' + command + '\nThen tell me in one line per step whether it worked.', model, scope, [['the policy, the sandbox and the reviewer, each as the start reply reported it', repeatOf(started.value, { reviewer: true })], ['nothing named', {}]]);
      notes.attempts = first.attempts;
      if (first.ran === null) return codex.didNotHappen('turn/start was refused in every form', notes);
      Object.assign(notes, { first: first.ran.facts, requestsThatCameToTheSpike: first.ran.facts.requests.length, reviewFrames: reviewFrames(driver, first.ran.from), filesAfterTheFirst: { outsideByPatch: existsSync(path.join(scope.outside, 'k4-ar-patch.txt')), outsideByCommand: existsSync(path.join(scope.outside, 'k4-ar-command.txt')) }, outlineFirst: first.ran.outline });
      const threadId = driver.threadId;
      writeState({ codexAutoReviewThreadId: threadId });
      driver.cleanupState = await driver.close();
      await sleep(1_000);
      // Out of Auto reviewed as the app would leave it (C64, C70): a fresh process, and a resume that names the user.
      const resumed = await ctx.open('resumed');
      resumed.sessionIds = [threadId];
      const resumeParams = { threadId, cwd: ctx.scratch, excludeTurns: true, ...SANDBOXED };
      const reply = await resumed.resumeThread(resumeParams);
      resumed.sessionStart = { request: resumeParams, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(SANDBOXED, reply.value) : null };
      notes.resumeNamingTheUser = { ok: reply.ok, error: errorOf(reply, scope), asked: SANDBOXED, reported: reply.ok ? policyFacts(reply.value, scope) : null, matchesWhatWasAsked: reply.ok ? resumed.sessionStart.check.passed : null };
      if (!reply.ok) return codex.didNotHappen('thread/resume was refused', notes);
      if (reply.value?.approvalsReviewer !== 'user') return codex.happened({ ...notes, secondTurn: 'not sent: the resume that named the user did not report the user' }, first.ran.end?.index ?? null);
      resumed.approvalRule = declineAll;
      const second = await turnInForms(ctx, resumed, patchPrompt([[scope.outside, 'k4-ar-after.txt', 'beta']]), model, scope, [['the policy, the sandbox and the reviewer, each as the resume reply reported it', repeatOf(reply.value, { reviewer: true })], ['nothing named', {}]]);
      notes.attemptsAfterTheResume = second.attempts;
      if (second.ran === null) return codex.happened({ ...notes, secondTurn: 'turn/start was refused in every form' }, first.ran.end?.index ?? null);
      Object.assign(notes, { second: second.ran.facts, requestsThatCameToTheSpikeAfterTheResume: second.ran.facts.requests.length, reviewFramesAfterTheResume: reviewFrames(resumed, second.ran.from), fileMadeAfterTheResume: existsSync(path.join(scope.outside, 'k4-ar-after.txt')), outlineSecond: second.ran.outline });
      return codex.happened(notes, second.ran.end?.index ?? null);
    },
  },

  'ask-first-files': {
    id: 'm22-codex-ask-first-files', name: 'm22-codex-ask-first-files', turns: 1, files: FILES, profile: ASKING,
    title: 'K4, with the sandbox set up: three file changes under workspace-write and untrusted — in the working folder, in a temporary folder outside it, and outside both — each accepted if it asks (C4, C65)',
    successCondition: 'Which changes ask under Ask first with a real sandbox, and which files an accepted change makes',
    async run(ctx) {
      const scope = withTemp(beyondScope(ctx), ctx);
      const run = await sandboxTurn(ctx, ASKING, scope, patchPrompt([[ctx.scratch, 'k4-af-inside.txt', 'alpha'], [ctx.outside, 'k4-af-temp.txt', 'beta'], [scope.outside, 'k4-af-outside.txt', 'gamma']]), () => 'accept', { needs: 'workspaceWrite' });
      if (run.stop) return run.stop;
      run.notes.files = { inside: existsSync(path.join(ctx.scratch, 'k4-af-inside.txt')), temporaryFolder: existsSync(path.join(ctx.outside, 'k4-af-temp.txt')), outside: existsSync(path.join(scope.outside, 'k4-af-outside.txt')) };
      if (run.notes.turn.fileChanges.length === 0 && run.notes.turn.requests.length === 0) return codex.didNotHappen('the turn made no file change and no request', run.notes);
      return codex.happened(run.notes, run.end.index);
    },
  },

  'sandbox-temp': {
    id: 'm22-codex-sandbox-temp', name: 'm22-codex-sandbox-temp', turns: 1, files: FILES, profile: SANDBOXED,
    title: 'K4, with the sandbox set up: under workspace-write and on-request, a command and a file change that write in a temporary folder outside the working one, and a command that writes outside both, accepted if it asks (C4, C65)',
    successCondition: 'Whether a write to a temporary folder outside the working one runs with no request, and whether a command accepted to run outside the sandbox then writes there',
    async run(ctx) {
      const scope = withTemp(beyondScope(ctx), ctx);
      const temp = 'echo k4 > ' + path.join(ctx.outside, 'k4-st-temp.txt');
      const outside = 'echo k4 > ' + path.join(scope.outside, 'k4-st-outside.txt');
      scope.snippets = [temp, outside];
      const run = await sandboxTurn(ctx, SANDBOXED, scope, STEPS_IN_ORDER + '\n1. Run exactly this shell command, once: ' + temp + '\n2. Run exactly this shell command, once: ' + outside + '\n3. Use your apply_patch tool, not a shell command, to create the file ' + path.join(ctx.outside, 'k4-st-patch.txt') + ' containing the single word alpha.\nThen tell me in one line per step whether it worked.', () => 'accept', { needs: 'workspaceWrite' });
      if (run.stop) return run.stop;
      run.notes.files = { temporaryFolderByCommand: existsSync(path.join(ctx.outside, 'k4-st-temp.txt')), outsideByCommand: existsSync(path.join(scope.outside, 'k4-st-outside.txt')), temporaryFolderByPatch: existsSync(path.join(ctx.outside, 'k4-st-patch.txt')) };
      return codex.happened(run.notes, run.end.index);
    },
  },

  'read-only-turn': {
    id: 'm22-codex-read-only-turn', name: 'm22-codex-read-only-turn', turns: 1, atMost: true, files: FILES, profile: READ_ONLY,
    title: "K4: a thread as the app starts one today, read-only and never, its turn/start naming the policy and the read-only sandbox again; one command that would write (C7, C45)",
    successCondition: "Whether turn/start takes a `sandboxPolicy` of the read-only type, and that the command asks nothing and writes nothing",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const command = 'echo k4 > k4-ro.txt';
      const scope = scopeOf(ctx, [command]);
      const driver = await ctx.open();
      const params = { cwd: ctx.scratch, ...READ_ONLY, model: model.model };
      const started = await driver.startThread(params);
      driver.sessionStart = { request: params, replyIndex: started.index, ok: started.ok, check: started.ok ? checkSessionStart(READ_ONLY, started.value) : null };
      const notes = { thread: { ok: started.ok, error: errorOf(started, scope), asked: READ_ONLY, reported: started.ok ? policyFacts(started.value, scope) : null, matchesWhatWasAsked: started.ok ? driver.sessionStart.check.passed : null } };
      if (!started.ok) return codex.didNotHappen('thread/start was refused', notes);
      if (started.value?.sandbox?.type !== 'readOnly' || started.value?.approvalPolicy !== 'never') return codex.didNotHappen('the thread did not start read-only and never: no turn is sent', notes);
      driver.approvalRule = () => ({ decision: 'decline', why: 'this scenario accepts nothing' });
      // The form with nothing named is today's own turn, traced since M15: it is not among these.
      const { attempts, ran } = await turnInForms(ctx, driver, say(command) + '\n' + REPORT, model, scope, [['the policy and the sandbox, each as the start reply reported it, and no reviewer', repeatOf(started.value, { reviewer: false })], ['the approval policy alone', { approvalPolicy: started.value.approvalPolicy }]]);
      notes.attempts = attempts;
      if (ran === null) return codex.didNotHappen('turn/start was refused in both forms that name a policy', notes);
      Object.assign(notes, { turn: ran.facts, requestsThatCame: ran.facts.requests.length, fileMade: existsSync(path.join(ctx.scratch, 'k4-ro.txt')), outline: ran.outline });
      if (attempts.length > 1) return codex.didNotHappen('turn/start refused the read-only sandbox named again; the turn ran with the approval policy alone', notes);
      return codex.happened(notes, ran.end?.index ?? null);
    },
  },

  worker: {
    id: 'm22-codex-worker', name: 'm22-codex-worker', turns: 1, files: FILES, profile: ASKING,
    title: "K1: a sub-agent's command, its request naming the worker's thread (C11)",
    successCondition: "An approval request whose threadId is the worker's, accepted, and the file made",
    async run(ctx) {
      const model = modelOf();
      if (!model?.model) return codex.notRun('no model chosen: run --scenario start first');
      const scope = scopeOf(ctx, [COMMANDS.worker]);
      const driver = await ctx.open();
      const thread = await openThread(ctx, driver, scope, ASKING, model);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      driver.approvalRule = answerDictated(scope);
      // A sub-agent is started at a medium effort and not at a low one (M20a, K3).
      const only = await turn(ctx, driver, 'Spawn a sub-agent with your agent-spawning tool and hand it this task; do not do it yourself: it must run exactly this shell command, once, and nothing else: ' + COMMANDS.worker + '\nIt must then report in one sentence whether the command ran. Wait for it, then tell me in one sentence what it reported.', { ...model, effort: 'medium' }, scope);
      if (only.refused) return codex.didNotHappen('turn/start was refused', { thread, turn: only.error });
      const notes = { thread, turn: only.facts, workerThreads: [...new Set(received(driver, only.from).map((f) => f.frame?.params?.threadId).filter((id) => typeof id === 'string' && id !== driver.threadId))].length, fileMade: existsSync(path.join(ctx.scratch, 'k1-worker.txt')), outline: only.outline };
      if (!only.facts.requests.some((request) => request.worker)) return codex.didNotHappen(only.facts.requests.length ? "a request came, but on the session's own thread: the session ran the command, not a sub-agent" : 'no request came', notes);
      return codex.happened(notes, only.end.index);
    },
  },
};

const PLANNED = ['trust', 'start', 'once', 'files', 'on-request', 'amendment', 'file-session', 'override', 'resume', 'config', 'worker'];

if (isMain(import.meta.url)) {
  await runSpike('m22-k1', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(13)} ${String(scenario.turns).padStart(2)} prompt(s)${PLANNED.includes(key) ? '' : ' (reserve)'}  ${scenario.title}`);
      log(`total: ${PLANNED.reduce((sum, key) => sum + SCENARIOS[key].turns, 0)} prompts for one run of each planned scenario, of the twelve K1 may spend (C33)`);
      return 0;
    }
    const scenario = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!scenario) { warn(`usage: node spikes/m22/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--path <executable>]`); return 1; }
    log(`K1: production's handshake less the opt-out of ${CODEX_TEXT_DELTA}, no experimental API; the scratch configuration folder (CODEX_HOME)`);
    return codex.runScenario('m22-k1', scenario, frame, OPTIONS);
  });
}

