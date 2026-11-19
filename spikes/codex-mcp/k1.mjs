// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex MCP spike K1: Codex's leave to run an MCP tool, which it asks for as an MCP elicitation
// (`mcpServer/elicitation/request` with `_meta.codex_approval_kind: "mcp_tool_call"`), answered
// once, for the session, declined and left pending under a Stop; a server's own form request beside
// it; and a tool its server marks as safe, run under Read only with no request. Under production's
// handshake as M19 leaves it, in M22's scratch Codex configuration folder (`CODEX_HOME`): the
// maintainer's own Codex configuration is neither read nor changed.
//
//   node spikes/codex-mcp/k1.mjs --list
//   node spikes/codex-mcp/k1.mjs --scenario <name> --confirm-turns 1 [--again]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing.
// One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/codex-mcp). Each scenario writes the spike's own MCP server (fixture-server.mjs)
// into the scratch configuration's `config.toml` before the app-server starts, and puts the file
// back as it was afterwards, also when a step fails: that also takes back the trust Codex writes
// there for the working folder at a workspace-write start (M22). The server writes only into
// spikes/output/codex-mcp/server/.
//
// What a run records is never a text of the model's: each request's fields and what came with it,
// the reply the spike sent, each MCP call's status and its error's words, and which of the server's
// files were written.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkSessionStart } from '../m10/codex/driver.mjs';
import { EXIT, deadlines, settlesWithin, sleep } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { SPIKES_DIR, isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { instanceEnvironment } from '../m14b/lib/instance-env.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, received } from '../m19/lib/common.mjs';
import { CODEX_HOME } from '../m22/k1.mjs';

export const CODEX_MCP_DIR = path.join(SPIKES_DIR, 'output', 'codex-mcp');
const SERVER_OUT = path.join(CODEX_MCP_DIR, 'server');
const SERVER = path.join(import.meta.dirname, 'fixture-server.mjs');
/** The server's name in the scratch configuration: aliased by the publisher, as every configured name is. */
const SERVER_NAME = 'fatg_spike';
const ELICITATION = 'mcpServer/elicitation/request';
/** fat-g's Ask first, and its Read only (decision 0027). */
const ASK_FIRST = Object.freeze({ sandbox: 'workspace-write', approvalPolicy: 'untrusted', approvalsReviewer: 'user' });
const READ_ONLY = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never' });
const MODEL = 'gpt-6-luna';
const EFFORT = 'low';
const SCENARIO_MS = 240_000;
const BUDGET_MS = 360_000;

/**
 * M19's driver, answering an elicitation as its scenario says: `accept`, `session` (accept with
 * `_meta.persist: "session"`), `decline`, `refuse` (the error fat-g writes for a request it does not
 * answer), or `hold` (no reply). Every other request is declined by the runner's handler.
 */
class K1Driver extends M19CodexDriver {
  constructor(options) {
    super(options);
    this.plan = null;
    this.elicitations = [];
  }

  incoming(frame, index) {
    if (!frame || frame.id === undefined || frame.method !== ELICITATION) { super.incoming(frame, index); return; }
    this.requestsSeen.push({ kind: frame.method, requestKind: 'elicitation' });
    const params = frame.params ?? {};
    const answer = this.plan?.(params, this.elicitations.length) ?? 'refuse';
    const entry = { id: frame.id, index, atMs: this.tree.elapsed(), answer, ...shapeOf(params) };
    this.elicitations.push(entry);
    this.requestsSeen.at(-1).answer = answer;
    if (answer === 'hold') return;
    const reply = answer === 'refuse' ? { id: frame.id, error: { code: -32601, message: 'Method not found' } }
      : { id: frame.id, result: { action: answer === 'session' ? 'accept' : answer, content: null, _meta: answer === 'session' ? { persist: 'session' } : null } };
    entry.reply = reply.error ? { error: reply.error.code } : reply.result;
    this.session.send(reply).catch(() => {});
  }
}

/** What an elicitation holds, by field: its kind, the approval's own fields, and never a text but the request's sentence's length. */
function shapeOf(params) {
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : null;
  return {
    keys: Object.keys(params).sort(), mode: params.mode ?? null, turnIdNamed: typeof params.turnId === 'string', serverIsTheSpikes: params.serverName === SERVER_NAME,
    metaKeys: meta ? Object.keys(meta).sort() : null, approvalKind: meta?.codex_approval_kind ?? null, persist: meta?.persist ?? null,
    toolParams: meta?.tool_params ?? null, displayKeys: Array.isArray(meta?.tool_params_display) ? meta.tool_params_display.map((entry) => Object.keys(entry ?? {}).sort()) : null,
    schemaKeys: params.requestedSchema && typeof params.requestedSchema === 'object' ? Object.keys(params.requestedSchema.properties ?? {}) : null, messageLength: typeof params.message === 'string' ? params.message.length : null,
  };
}

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

const OPTIONS = {
  dir: CODEX_MCP_DIR, milestone: 'Codex MCP', Driver: K1Driver, omitted: OMITTED_CODEX, environment, ready,
  toolPermissions: (scenario) => ({ readTools: 'reads inside the sandbox', scenarioTools: ['the spike\'s own MCP server'], preApproved: [], sandbox: scenario.profile.sandbox, approvalPolicy: scenario.profile.approvalPolicy, reviewer: scenario.profile.approvalsReviewer ?? null, policy: 'an elicitation is answered as the scenario says; every other request is declined' }),
};

/** The spike's server in the scratch `config.toml`, for the length of `work`; the file put back as it was afterwards. */
async function withServer(work) {
  const config = path.join(CODEX_HOME, 'config.toml');
  const before = existsSync(config) ? readFileSync(config, 'utf8') : null;
  rmSync(SERVER_OUT, { recursive: true, force: true });
  mkdirSync(SERVER_OUT, { recursive: true });
  const literal = (value) => { if (value.includes("'")) throw new Error('a path with a quote cannot be a TOML literal'); return `'${value}'`; };
  writeFileSync(config, `${before ?? ''}\n[mcp_servers.${SERVER_NAME}]\ncommand = ${literal(process.execPath)}\nargs = [${literal(SERVER)}, ${literal(SERVER_OUT)}]\n`);
  try {
    return await work();
  } finally {
    if (before === null) rmSync(config, { force: true }); else writeFileSync(config, before);
  }
}

/** Which of the server's files were written, by tool and label. */
const writtenFiles = () => { const dir = path.join(SERVER_OUT, 'written'); return existsSync(dir) ? readdirSync(dir).sort() : []; };
/** What the client told the server of itself, and the server's own requests and their replies. */
function serverView() {
  const file = path.join(SERVER_OUT, 'messages.jsonl');
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const init = lines.find((line) => line.dir === 'in' && line.message.method === 'initialize');
  const asked = lines.filter((line) => line.dir === 'out' && line.message.method === 'elicitation/create').map((line) => line.message.id);
  return {
    initializeCount: lines.filter((line) => line.dir === 'in' && line.message.method === 'initialize').length,
    clientCapabilities: init?.message.params?.capabilities ?? null,
    calls: lines.filter((line) => line.dir === 'in' && line.message.method === 'tools/call').map((line) => line.message.params?.name ?? null),
    elicitationReplies: lines.filter((line) => line.dir === 'in' && asked.includes(line.message.id)).map((line) => line.message.result ?? { error: line.message.error?.code ?? null }),
  };
}

/** Each MCP call of the turn at its start and its end: tool, status, and its error's own words, which are Codex's. */
const mcpItems = (driver, from) => received(driver, from).filter((f) => (f.frame?.method === 'item/started' || f.frame?.method === 'item/completed') && f.frame.params?.item?.type === 'mcpToolCall').map((f) => ({ index: f.index, method: f.frame.method, tool: f.frame.params.item.tool ?? null, status: f.frame.params.item.status ?? null, arguments: f.frame.params.item.arguments ?? null, error: f.frame.params.item.error?.message ?? null }));
const resolvedFrames = (driver, from) => received(driver, from).filter((f) => f.frame?.method === 'serverRequest/resolved').map((f) => ({ index: f.index, requestId: f.frame.params?.requestId ?? null }));
const outlineOf = (driver, from) => codex.outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA && row.method !== 'thread/tokenUsage/updated' && row.method !== 'mcpServer/startupStatus/updated');
const textInput = (text) => ({ type: 'text', text, text_elements: [] });

/** One prompt under `profile`, its elicitations answered by `plan`; `stopOnRequest` interrupts the turn once the first one comes, unanswered. */
async function mcpTurn(ctx, { profile, plan, prompt, stopOnRequest = false }) {
  return withServer(async () => {
    const driver = await ctx.open();
    driver.plan = plan;
    const params = { cwd: ctx.scratch, ...profile, model: MODEL, serviceTier: 'default' };
    const reply = await driver.startThread(params);
    driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(profile, reply.value) : null };
    const notes = { profile, thread: reply.ok ? { approvalPolicy: reply.value?.approvalPolicy ?? null, sandbox: reply.value?.sandbox?.type ?? null, reviewer: reply.value?.approvalsReviewer ?? null } : { refused: reply.error?.code ?? null } };
    if (!reply.ok) return codex.didNotHappen('thread/start was refused', notes);
    // The server starts with the thread: a turn sent before it is ready may be given no tool of it
    // (the first `session` run, whose model said `stamp` was unavailable).
    const isReady = (f) => f.frame?.method === 'mcpServer/startupStatus/updated' && f.frame.params?.name === SERVER_NAME && f.frame.params?.status === 'ready';
    for (let i = 0; i < 60 && !received(driver, 0).some(isReady); i += 1) await sleep(250);
    notes.serverReadyBeforeTurn = received(driver, 0).some(isReady);
    const from = driver.nextIndex;
    const turn = await driver.requestWithin('turn/start', { threadId: driver.threadId, input: [textInput(prompt)], model: MODEL, effort: EFFORT, serviceTier: 'default', clientUserMessageId: randomUUID() }, 15_000);
    if (!turn.ok) return codex.didNotHappen('turn/start was refused', { ...notes, turn: turn.error?.code ?? null });
    ctx.countTurn();
    driver.turnId = turn.value?.turn?.id ?? null;
    if (stopOnRequest) {
      // Codex sends nothing more while the request waits: the driver's own list is read, not its events.
      for (let i = 0; i < 240 && driver.elicitations.length === 0; i += 1) await sleep(250);
      notes.interrupt = driver.elicitations.length > 0 ? await driver.requestWithin('turn/interrupt', { threadId: driver.threadId, turnId: driver.turnId }, 15_000).then((r) => (r.ok ? 'taken' : r.error?.code ?? 'refused')) : 'no request came';
    }
    const end = await ctx.turnEnd(driver, from);
    // `serverRequest/resolved` for a request left pending came after the turn's end (as its trace showed).
    await sleep(2_000);
    Object.assign(notes, {
      end: { index: end.index, status: end.status ?? null },
      elicitations: driver.elicitations.map(({ id, ...rest }) => rest),
      mcpItems: mcpItems(driver, from),
      resolved: resolvedFrames(driver, from),
      written: writtenFiles(),
      server: serverView(),
      outline: outlineOf(driver, from),
    });
    return codex.happened(notes, end.index);
  });
}

const SCENARIOS = {
  once: {
    id: 'codex-mcp-once', name: 'codex-mcp-approval-once', turns: 1, profile: ASK_FIRST,
    title: 'K1: two calls of an unannotated tool under Ask first, each approved once',
    successCondition: 'Two elicitations of the approval kind, each answered accept with no _meta, and both calls completed',
    run: (ctx) => mcpTurn(ctx, { profile: ASK_FIRST, plan: () => 'accept', prompt: `Spike K1 (once). Call the ${SERVER_NAME} MCP server's stamp tool with label 'first', and after it returns call stamp again with label 'second'. Then say in one short line whether each call ran. Use no other tool.` }),
  },
  session: {
    id: 'codex-mcp-session', name: 'codex-mcp-approval-session', turns: 1, profile: ASK_FIRST,
    title: "K1: the session's grant, then the same tool again and another tool of the same server",
    successCondition: "The first elicitation answered accept with _meta.persist session; whether the second stamp asks, and whether stamp_other asks (answered accept once if it does)",
    run: (ctx) => mcpTurn(ctx, { profile: ASK_FIRST, plan: (params, n) => (n === 0 ? 'session' : 'accept'), prompt: `Spike K1 (session). Call the ${SERVER_NAME} MCP server's stamp tool with label 'alpha', then stamp again with label 'beta', then its stamp_other tool with label 'gamma', one after the other. Then say in one short line whether each call ran. Use no other tool.` }),
  },
  deny: {
    id: 'codex-mcp-deny', name: 'codex-mcp-approval-deny', turns: 1, profile: ASK_FIRST,
    title: 'K1: one call of an unannotated tool under Ask first, declined',
    successCondition: 'One elicitation answered decline; the call ends failed with Codex\'s words and nothing is written',
    run: (ctx) => mcpTurn(ctx, { profile: ASK_FIRST, plan: () => 'decline', prompt: `Spike K1 (deny). Call the ${SERVER_NAME} MCP server's stamp tool once, with label 'refused', and do not try it again if it is refused. Then say in one short line what happened. Use no other tool.` }),
  },
  stop: {
    id: 'codex-mcp-stop', name: 'codex-mcp-approval-stop', turns: 1, profile: ASK_FIRST,
    title: 'K1: a Stop while the approval is pending',
    successCondition: 'One elicitation left unanswered, turn/interrupt taken, the turn interrupted and the request resolved by Codex',
    run: (ctx) => mcpTurn(ctx, { profile: ASK_FIRST, plan: () => 'hold', stopOnRequest: true, prompt: `Spike K1 (stop). Call the ${SERVER_NAME} MCP server's stamp tool once, with label 'pending'. Then say in one short line what happened. Use no other tool.` }),
  },
  form: {
    id: 'codex-mcp-form', name: 'codex-mcp-server-form', turns: 1, profile: ASK_FIRST,
    title: "K1: a server's own form request, refused as fat-g refuses every elicitation that is not an approval",
    successCondition: 'One elicitation with no approval kind, answered with the method-not-found error; what Codex then tells the server',
    run: (ctx) => mcpTurn(ctx, { profile: ASK_FIRST, plan: () => 'refuse', prompt: `Spike K1 (form). Call the ${SERVER_NAME} MCP server's ask_color tool once. Then say in one short line what it returned. Use no other tool.` }),
  },
  annotated: {
    id: 'codex-mcp-annotated', name: 'codex-mcp-annotated-read-only', turns: 1, profile: READ_ONLY,
    title: "K1: under Read only, a tool its server marks as neither destructive nor reaching outside, and an unannotated one",
    successCondition: 'note runs with no request and writes its file; stamp is refused by Codex itself under approvals never',
    run: (ctx) => mcpTurn(ctx, { profile: READ_ONLY, plan: () => 'refuse', prompt: `Spike K1 (annotated). Call the ${SERVER_NAME} MCP server's note tool with label 'quiet', then its stamp tool with label 'loud'. Then say in one short line whether each call ran. Use no other tool.` }),
  },
};

const PLANNED = ['once', 'session', 'deny', 'stop', 'form', 'annotated'];

if (isMain(import.meta.url)) {
  await runSpike('codex-mcp-k1', (frame) => {
    if (frame.args.list) {
      for (const key of PLANNED) log(`codex   ${key.padEnd(10)} ${String(SCENARIOS[key].turns).padStart(2)} prompt(s)  ${SCENARIOS[key].title}`);
      log(`total: ${PLANNED.reduce((sum, key) => sum + SCENARIOS[key].turns, 0)} prompts for one run of each`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/codex-mcp/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns 1 [--again] [--path <executable>]`); return 1; }
    const waits = deadlines({ scenario: SCENARIO_MS });
    log(`K1: ${MODEL} at ${EFFORT} effort; production's handshake (M19); the scratch configuration folder (CODEX_HOME), the spike's MCP server written into its config.toml for the run; the scenario wait ${SCENARIO_MS / 1000} s`);
    return codex.runScenario('codex-mcp-k1', chosen, { ...frame, waits }, OPTIONS);
  }, { budgetMs: BUDGET_MS });
}
