// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M105 K1: installed-CLI lifecycle evidence. No credentials are opened; the CLIs use
// the maintainer's existing scratch accounts. Raw captures stay in ignored output.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { deadlines, settlesWithin } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { resolveExecutable } from '../m10/lib/executable.mjs';
import { Ledger } from '../m10/lib/ledger.mjs';
import { REPO_ROOT, isMain, writeJson } from '../m10/lib/paths.mjs';
import { runSpike } from '../m10/lib/spike.mjs';
import { claudeLoggedIn, codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { M19ClaudeDriver, M19CodexDriver } from '../m19/lib/common.mjs';

const OUT = path.join(REPO_ROOT, 'spikes/output/m105');
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures/m105');
const CONFIG = {
  claude: path.join(tmpdir(), 'fat-g-spike-m14b/claude-login'),
  codex: path.join(homedir(), '.fat-g-spike-m22/codex-home'),
};
const DELAY = `node -e "setTimeout(function(){console.log('M105_TOOL_DONE')},700)"`;
const PROMPTS = {
  tools: `This is a protocol trace in a disposable folder. Read alpha.txt and beta.txt with two separate read calls, in parallel if available. Then run exactly this command once: ${DELAY}. Do not modify any file, use any network tool, or run another command. After its result, compute 2147 times 3589 mentally, without a tool, and reply in one short sentence with that product and M105_TOOLS_DONE.`,
  claudeWorkers: 'This is a protocol trace in a disposable folder. Use your Agent tool exactly twice, both calls in one reply, each with model haiku and run_in_background false. The first child must read alpha.txt using Read and reply M105_CHILD_ONE. The second must read beta.txt using Read and reply M105_CHILD_TWO. Neither child may use any other tool or modify anything. Do not do their tasks yourself. Once both have reported, read alpha.txt once yourself and reply M105_WORKERS_DONE.',
  codexWorkers: 'This is a protocol trace in a disposable folder. Spawn exactly two sub-agents. The first must read alpha.txt and reply M105_CHILD_ONE, the second must read beta.txt and reply M105_CHILD_TWO. No writes, network tools or other commands. After spawning both, send a short follow-up to the first telling it to include its marker, then read alpha.txt yourself while the children work. Explicitly wait for both sub-agents to finish, collect their markers, close both if your coordination tools offer that, and reply M105_WORKERS_DONE. Do not perform the children tasks yourself.',
};

function environment(cli) {
  const { env } = cleanEnvironment(cli);
  for (const key of Object.keys(env)) if (/^(OPENAI_|CODEX_)/i.test(key)) delete env[key];
  env[cli === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = CONFIG[cli];
  if (cli === 'claude') env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return env;
}

async function once(launcher, waits, executable, args, cwd, env) {
  const tree = await launcher.launch({ executable, args, cwd, env });
  let stdout = '';
  if (tree.child) {
    tree.stdout.setEncoding('utf8');
    tree.stdout.on('data', (chunk) => { if (stdout.length < 100_000) stdout += chunk; });
    tree.stdin.end();
  }
  try { await settlesWithin(tree.closed, waits.startup); }
  finally {
    const cleanup = await tree.teardown();
    if (!cleanup.confirmed) throw new Error('One-shot CLI cleanup not confirmed');
  }
  return { code: tree.exitInfo?.code, stdout, stderr: tree.stderrTail ?? '' };
}

async function preflight(cli, frame, cwd) {
  if (!existsSync(CONFIG[cli]) || !existsSync(path.join(path.dirname(CONFIG[cli]), '.fat-g-spike'))) throw new Error(`${cli}: prepared scratch folder or marker missing; no login attempted`);
  const executable = resolveExecutable(cli);
  const env = environment(cli);
  const version = parseVersion((await once(frame.launcher, frame.waits, executable, ['--version'], cwd, env)).stdout);
  const status = await once(frame.launcher, frame.waits, executable, cli === 'claude' ? ['auth', 'status'] : ['login', 'status'], cwd, env);
  const loggedIn = cli === 'claude' ? claudeLoggedIn(status) : codexLoggedIn(status);
  console.log(`[m105-k1] ${cli}: version ${version ?? 'unknown'}, scratch signed in ${loggedIn}`);
  if (!version || !loggedIn) throw new Error(`${cli}: scratch CLI preflight failed; no prompt sent and no login attempted`);
  return { executable, env, version };
}

// Public evidence is an allowlisted projection of wire fields, never model text,
// paths, account data, arbitrary tool input/output or raw provider prose.
export function projectFrames(cli, frames) {
  const aliases = new Map();
  const alias = (value, kind = 'id') => {
    if (typeof value !== 'string') return null;
    if (!aliases.has(value)) aliases.set(value, `${kind}-${aliases.size + 1}`);
    return aliases.get(value);
  };
  const safe = (value) => typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,100}$/.test(value) ? value : null;
  const units = (value) => typeof value === 'string' ? value.length : null;
  const rows = [];
  for (const entry of frames) {
    if (entry.dir !== 'recv') continue;
    const f = entry.frame;
    const row = { index: entry.index, ms: Math.round(entry.ms), type: safe(cli === 'codex' ? f.method ?? 'response' : f.type) };
    if (cli === 'codex') {
      if (!f.method) continue;
      const p = f.params ?? {};
      row.thread = alias(p.threadId ?? p.thread?.id, 'thread');
      row.turn = alias(p.turnId ?? p.turn?.id, 'turn');
      if (f.id !== undefined) row.request = true;
      if (p.turn?.status) row.turnStatus = safe(p.turn.status);
      if (p.willRetry !== undefined) row.willRetry = p.willRetry === true;
      if (p.status?.type) row.threadStatus = safe(p.status.type);
      const item = p.item;
      if (item) {
        row.item = { id: alias(item.id, 'item'), type: safe(item.type) };
        for (const key of ['kind', 'status', 'phase', 'model']) if (item[key] != null) row.item[key] = safe(item[key]);
        if (item.tool != null) row.item.tool = ['wait', 'spawnAgent', 'sendInput', 'resumeAgent', 'closeAgent', 'interruptAgent'].includes(item.tool) ? item.tool : 'other';
        if (item.agentThreadId) row.item.agentThread = alias(item.agentThreadId, 'thread');
        if (item.receiverThreadId) row.item.receiver = alias(item.receiverThreadId, 'thread');
        if (item.newThreadId) row.item.newThread = alias(item.newThreadId, 'thread');
        if (Array.isArray(item.receiverThreadIds)) row.item.receivers = item.receiverThreadIds.map((id) => alias(id, 'thread'));
        if (item.agentsStates) row.item.agentsStates = Object.entries(item.agentsStates).map(([id, state]) => ({ thread: alias(id, 'thread'), status: safe(state?.status) }));
        if (Array.isArray(item.commandActions)) row.item.commandActions = item.commandActions.map((action) => safe(action.type));
        row.item.outputUnits = units(item.aggregatedOutput);
      }
      if (p.delta != null) { row.deltaUnits = units(p.delta); }
    } else {
      if (f.subtype) row.subtype = safe(f.subtype);
      row.parentTool = alias(f.parent_tool_use_id, 'tool');
      if (f.task_id) row.task = alias(f.task_id, 'task');
      if (f.tool_use_id) row.toolUse = alias(f.tool_use_id, 'tool');
      if (f.is_backgrounded !== undefined) row.background = f.is_backgrounded === true;
      if (f.status || f.patch?.status) row.status = safe(f.status ?? f.patch.status);
      if (f.last_tool_name) row.lastTool = safe(f.last_tool_name);
      if (f.type === 'result') { row.error = f.is_error === true; row.terminalReason = safe(f.terminal_reason); row.numTurns = f.num_turns; }
      if (Array.isArray(f.message?.content)) row.blocks = f.message.content.map((block) => {
        const b = { type: safe(block.type) };
        if (block.type === 'tool_use') {
          b.id = alias(block.id, 'tool'); b.name = ['Read', 'Glob', 'Grep', 'Agent', 'Task', 'Bash', 'Write', 'Edit'].includes(block.name) ? block.name : 'other';
          b.inputKeys = Object.keys(block.input ?? {}).filter((key) => ['file_path', 'offset', 'limit', 'pages', 'command', 'description', 'timeout', 'prompt', 'model', 'run_in_background', 'subagent_type', 'pattern', 'path'].includes(key)).sort();
          if (block.input?.run_in_background !== undefined) b.backgroundRequested = block.input.run_in_background === true;
          if (block.input?.model) b.model = safe(block.input.model);
        }
        if (block.type === 'tool_result') { b.tool = alias(block.tool_use_id, 'tool'); b.error = block.is_error === true; }
        if (block.type === 'text') b.units = units(block.text);
        return b;
      });
      if (f.type === 'stream_event') {
        row.event = safe(f.event?.type); row.blockIndex = f.event?.index ?? null;
        if (f.event?.content_block) row.blockType = safe(f.event.content_block.type);
        if (f.event?.delta) { row.deltaType = safe(f.event.delta.type); row.deltaUnits = units(f.event.delta.text ?? f.event.delta.partial_json); }
      }
      if (f.type === 'control_request') { row.requestSubtype = safe(f.request?.subtype); row.requestTool = safe(f.request?.tool_name); }
    }
    rows.push(row);
  }
  return rows;
}

export function facts(cli, rows) {
  const starts = new Map();
  const tools = [];
  for (const row of rows) {
    if (cli === 'codex' && row.item && !['agentMessage', 'userMessage', 'reasoning', 'subAgentActivity'].includes(row.item.type)) {
      if (row.type === 'item/started') starts.set(row.item.id, row);
      if (row.type === 'item/completed' && starts.has(row.item.id)) {
        const begin = starts.get(row.item.id);
        tools.push({ id: row.item.id, kind: row.item.type, tool: row.item.tool ?? null, thread: row.thread, startMs: begin.ms, endMs: row.ms, endIndex: row.index, durationMs: row.ms - begin.ms });
      }
    }
    if (cli === 'claude') for (const b of row.blocks ?? []) {
      if (b.type === 'tool_use') starts.set(b.id, { ...row, tool: b.name });
      if (b.type === 'tool_result' && starts.has(b.tool)) {
        const begin = starts.get(b.tool);
        tools.push({ id: b.tool, kind: begin.tool, parentTool: begin.parentTool, startMs: begin.ms, endMs: row.ms, endIndex: row.index, durationMs: row.ms - begin.ms });
      }
    }
  }
  for (const tool of tools) {
    const next = rows.find((r) => r.index > tool.endIndex && (cli === 'codex' ? r.type === 'item/agentMessage/delta' && r.thread === tool.thread : r.type === 'stream_event' && r.deltaType === 'text_delta' && r.parentTool === tool.parentTool));
    tool.nextTextGapMs = next ? next.ms - tool.endMs : null;
  }
  return { tools, tasksStarted: rows.filter((r) => r.subtype === 'task_started'), tasksEnded: rows.filter((r) => r.subtype === 'task_notification' || r.subtype === 'task_updated' && ['completed', 'failed', 'killed'].includes(r.status)), retries: rows.filter((r) => r.subtype === 'api_retry' || r.type === 'error' && r.willRetry), coordination: rows.filter((r) => /collab|subAgent/.test(r.item?.type ?? '')) };
}

function scratchUnchanged(folder) {
  if (typeof folder !== 'string' || !path.resolve(folder).startsWith(path.join(tmpdir(), 'fat-g-spike-m105-'))) return null;
  return JSON.stringify(readdirSync(folder).sort()) === JSON.stringify(['alpha.txt', 'beta.txt'])
    && readFileSync(path.join(folder, 'alpha.txt'), 'utf8') === 'Synthetic alpha: the harbour bell is blue.\n'
    && readFileSync(path.join(folder, 'beta.txt'), 'utf8') === 'Synthetic beta: the ferry departs at seven.\n';
}

if (isMain(import.meta.url)) await runSpike('m105-k1', async (frame) => {
  mkdirSync(OUT, { recursive: true });
  const ledger = new Ledger(path.join(OUT, 'ledger.json'));
  const cli = String(frame.args.cli ?? '');
  const scenario = String(frame.args.scenario ?? 'tools');
  if (!['claude', 'codex'].includes(cli) || !['tools', 'workers', 'check'].includes(scenario)) throw new Error('Use --cli claude|codex --scenario check|tools|workers [--confirm-turns 1]');
  if (frame.args.reproject === true) {
    const reportPath = path.join(FIXTURES, `${cli}-${scenario}.json`);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const run = ledger.data.runs.findLast((item) => item.cli === cli && item.scenario === scenario && item.status === 'happened');
    if (!run) throw new Error('No completed capture to project');
    const raw = JSON.parse(readFileSync(path.join(OUT, 'raw', `${run.id}.json`), 'utf8'));
    const folder = raw.frames.find((r) => r.frame?.type === 'system' && r.frame.subtype === 'init')?.frame.cwd
      ?? raw.frames.find((r) => r.dir === 'send' && r.frame?.method === 'thread/start')?.frame.params.cwd;
    report.frames = projectFrames(cli, raw.frames);
    report.facts = facts(cli, report.frames);
    report.scratchUnchanged = scratchUnchanged(folder);
    writeJson(reportPath, report);
    console.log(`[m105-k1] Reprojected ${cli} ${scenario}; no CLI launched or prompt sent`);
    return 0;
  }
  if (scenario !== 'check' && frame.args['confirm-turns'] !== '1') { console.log('[m105-k1] Plan only: one prompt; add --confirm-turns 1 to run.'); return 0; }
  if (ledger.turnsSpent() >= 6) throw new Error('M105 six-prompt budget exhausted');
  const folder = path.join(tmpdir(), `fat-g-spike-m105-${cli}-${scenario}-${randomUUID()}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'alpha.txt'), 'Synthetic alpha: the harbour bell is blue.\n');
  writeFileSync(path.join(folder, 'beta.txt'), 'Synthetic beta: the ferry departs at seven.\n');
  const ready = await preflight(cli, frame, folder);
  if (scenario === 'check') { writeJson(path.join(OUT, `preflight-${cli}.json`), { at: new Date().toISOString(), cli, version: ready.version, scratchSignedIn: true }); return 0; }
  const run = ledger.open(cli, scenario, { again: frame.args.again === true });
  const waits = deadlines({ startup: 90_000, request: 30_000, scenario: 300_000 });
  let driver;
  let outcome = 'failed';
  let model = null;
  try {
    if (cli === 'claude') {
      driver = new M19ClaudeDriver({ ...frame, waits, executable: ready.executable, cwd: folder, env: ready.env,
        args: ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--setting-sources', 'user,project,local', '--permission-mode', 'default', '--permission-prompt-tool', 'stdio', '--tools', 'Read,Glob,Grep,Agent,Bash', '--include-partial-messages', '--no-session-persistence', '--model', 'sonnet', '--effort', 'low'] });
      driver.onRequest((info) => info.tool === 'Bash' && info.input.command === DELAY ? { decision: 'allow' } : { decision: 'deny', message: 'Not part of this read-only protocol trace.' });
      await driver.open();
      ledger.countTurn(run);
      console.log(`[m105-k1] Sending claude ${scenario}; prompt ${ledger.turnsSpent()}/6`);
      const from = await driver.prompt(scenario === 'tools' ? PROMPTS.tools : PROMPTS.claudeWorkers);
      await driver.session.waitFor((f) => f.type === 'result', { wait: 'scenario', ms: waits.scenario, fromIndex: from });
      model = driver.session.frames.find((r) => r.dir === 'recv' && r.frame.type === 'system' && r.frame.subtype === 'init')?.frame.model ?? 'sonnet';
    } else {
      driver = new M19CodexDriver({ ...frame, waits, executable: ready.executable, cwd: folder, env: ready.env });
      driver.onRequest(() => ({ decision: 'decline' }));
      await driver.open();
      const listed = await driver.request('model/list', { limit: 100 });
      const models = listed.value?.data ?? [];
      const selected = models.find((m) => m.isDefault) ?? models.find((m) => !m.hidden);
      if (!selected) throw new Error('Codex returned no usable model');
      model = selected.model;
      const thread = await driver.startThread({ cwd: folder, model, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true });
      if (!thread.ok || !driver.threadId) throw new Error('Read-only scratch thread was refused');
      driver.nextTurn = { model, effort: (selected.supportedReasoningEfforts ?? []).some((e) => e.reasoningEffort === 'medium') ? 'medium' : selected.defaultReasoningEffort ?? 'low' };
      const from = driver.nextIndex;
      ledger.countTurn(run);
      console.log(`[m105-k1] Sending codex ${scenario}; prompt ${ledger.turnsSpent()}/6; model ${model}`);
      const prompt = await driver.prompt(scenario === 'tools' ? PROMPTS.tools : PROMPTS.codexWorkers);
      if (!prompt.ok) throw new Error('Codex turn/start refused');
      await driver.session.waitFor((f) => f.method === 'turn/completed' && f.params?.threadId === driver.threadId && f.params?.turn?.id === driver.turnId, { wait: 'scenario', ms: waits.scenario, fromIndex: from });
    }
    outcome = 'happened';
  } finally {
    const cleanup = driver ? await driver.close() : { confirmed: true };
    const frames = driver?.session.frames ?? [];
    writeJson(path.join(OUT, 'raw', `${run.id}.json`), { cli, version: ready.version, model, frames });
    const rows = projectFrames(cli, frames);
    const report = { format: 'fat-g.m105-wire-projection/1', at: new Date().toISOString(), cli, version: ready.version, model, scenario, outcome, promptsSpent: run.turns, cleanupConfirmed: cleanup.confirmed, scratchUnchanged: scratchUnchanged(folder), source: 'Live CLI; allowlisted wire projection, text and personal data omitted; no synthetic frames', facts: facts(cli, rows), frames: rows };
    mkdirSync(FIXTURES, { recursive: true });
    writeJson(path.join(FIXTURES, `${cli}-${scenario}.json`), report);
    ledger.close(run, { status: outcome, cleanupConfirmed: cleanup.confirmed, capture: `${cli}-${scenario}.json` });
    console.log(`[m105-k1] ${cli} ${scenario}: ${outcome}; ${rows.length} projected frames, ${report.facts.tools.length} completed tool uses; cleanup ${cleanup.confirmed ? 'confirmed' : 'NOT confirmed'}; total prompts ${ledger.turnsSpent()}/6`);
    if (!cleanup.confirmed) throw new Error('CLI process cleanup not confirmed');
  }
  return 0;
}, { budgetMs: 420_000 });
